package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"orbitssh/src/platform"
	"orbitssh/src/sshagent"
)

type Credentials struct {
	Password     string `json:"password"`
	Passphrase   string `json:"passphrase"`
	JumpPassword string `json:"jumpPassword"`
	JumpPass     string `json:"jumpPassphrase"`
}

type remoteSession struct {
	client            *ssh.Client
	shell             *ssh.Session
	stdin             io.WriteCloser
	files             *sftp.Client
	host              Host
	customName        string
	output            *terminalOutputBuffer
	mu                sync.Mutex
	writeMu           sync.Mutex
	once              sync.Once
	closed            bool
	done              chan struct{}
	finished          chan struct{}
	monitorMu         sync.Mutex
	previousCPU       *cpuSample
	previousNet       map[string]netSample
	previousNetAt     time.Time
	previousDiskIO    map[string]netSample
	previousDiskAt    time.Time
	x11               *x11Forwarding
	releaseForwarding func()
	releaseTransport  func()
}

func (s *remoteSession) close() {
	s.once.Do(func() {
		close(s.done)
		// Close the transport first so blocked SFTP and X11 requests release.
		s.client.Close()
		if s.x11 != nil {
			s.x11.runtime.close()
		}
		if s.releaseForwarding != nil {
			s.releaseForwarding()
		}
		s.mu.Lock()
		s.closed = true
		if s.files != nil {
			s.files.Close()
		}
		s.mu.Unlock()
		s.shell.Close()
		if s.releaseTransport != nil {
			s.releaseTransport()
		}
	})
}

func (a *App) session(id string) (*remoteSession, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[id]
	if !ok {
		return nil, errors.New("连接已断开，请重新连接")
	}
	return s, nil
}

// Unknown keys must be explicitly approved by their SHA-256 fingerprint. A changed
// known key is always rejected; a new approval never silently replaces a known key.
func hostKeyVerifier(known, accepted string) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		actual := ssh.FingerprintSHA256(key)
		if known != "" {
			if known != actual {
				return fmt.Errorf("HOST_KEY_CHANGED|%s|%s", known, actual)
			}
			return nil
		}
		if accepted == actual {
			return nil
		}
		return fmt.Errorf("HOST_KEY_UNKNOWN|%s", actual)
	}
}

// hopTrust records which fingerprint was approved for a host that was not yet
// trusted, so trust can be persisted only after the whole chain connects.
type hopTrust struct {
	address  string
	known    string
	approved string
}

// hostChain returns the jump hosts from the outermost bastion to the target.
func (a *App) hostChain(host Host) ([]Host, error) {
	chain := []Host{}
	seen := map[string]bool{host.ID: true}
	current := host
	for current.JumpHostID != "" {
		jump, err := a.store.host(current.JumpHostID)
		if err != nil {
			return nil, fmt.Errorf("跳板机配置不存在，请检查主机设置：%w", err)
		}
		if seen[jump.ID] {
			return nil, errors.New("跳板机配置存在循环引用")
		}
		seen[jump.ID] = true
		chain = append([]Host{jump}, chain...)
		current = jump
		if len(chain) >= 5 {
			return nil, errors.New("跳板机最多支持 5 级")
		}
	}
	return append(chain, host), nil
}

// authMethods builds the authentication methods for one hop. Agent signing is
// only needed during user authentication, so the returned close function is
// safe to call once the handshake completes.
func (a *App) authMethods(host Host, credentials Credentials, jump bool) ([]ssh.AuthMethod, func(), error) {
	noop := func() {}
	switch host.AuthType {
	case "agent":
		conn, closeAgent, err := sshagent.Open()
		if err != nil {
			return nil, noop, err
		}
		return []ssh.AuthMethod{ssh.PublicKeysCallback(agent.NewClient(conn).Signers)}, closeAgent, nil
	case "key":
		data, err := os.ReadFile(host.KeyPath)
		if err != nil {
			return nil, noop, fmt.Errorf("无法读取私钥：%w", err)
		}
		passphrase := credentials.Passphrase
		if jump {
			passphrase = credentials.JumpPass
		}
		signer, parseErr := ssh.ParsePrivateKey(data)
		err = parseErr
		var encrypted *ssh.PassphraseMissingError
		if errors.As(parseErr, &encrypted) {
			if passphrase == "" {
				if saved, e := platform.GetKeyPassphrase(host.ID); e == nil {
					passphrase = saved
				}
			}
			if passphrase != "" {
				signer, err = ssh.ParsePrivateKeyWithPassphrase(data, []byte(passphrase))
			}
		}
		if err != nil {
			var missing *ssh.PassphraseMissingError
			if errors.As(err, &missing) {
				if jump {
					return nil, noop, fmt.Errorf("KEY_PASSPHRASE_REQUIRED|跳板机 %s 的私钥已加密，请输入口令", host.Name)
				}
				return nil, noop, errors.New("KEY_PASSPHRASE_REQUIRED|此私钥已加密，请输入口令")
			}
			return nil, noop, fmt.Errorf("无法解析私钥，请检查格式或口令：%w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, noop, nil
	default:
		password := credentials.Password
		if jump {
			password = credentials.JumpPassword
		}
		if password == "" {
			saved, err := savedPassword(host)
			if err != nil {
				return nil, noop, err
			}
			password = saved
			if password == "" {
				return nil, noop, errors.New("PASSWORD_REQUIRED|请输入登录密码")
			}
		}
		return []ssh.AuthMethod{ssh.Password(password), ssh.KeyboardInteractive(keyboardInteractive(password))}, noop, nil
	}
}

// keyboardInteractive answers one-time-code style prompts with the login
// password, and echoes an empty answer for prompts that ask for a code we do
// not have. Password authentication still runs first for plain servers.
func keyboardInteractive(password string) func(string, string, []string, []bool) ([]string, error) {
	return func(_, _ string, questions []string, echos []bool) ([]string, error) {
		answers := make([]string, len(questions))
		for i := range questions {
			if !echos[i] && len(questions) == 1 {
				answers[i] = password
			}
		}
		return answers, nil
	}
}

func (a *App) sshConfig(host Host, credentials Credentials, jump bool, acceptedFingerprint string) (*ssh.ClientConfig, *hopTrust, func(), error) {
	methods, closeAuth, err := a.authMethods(host, credentials, jump)
	if err != nil {
		return nil, nil, func() {}, err
	}
	address := net.JoinHostPort(host.Address, strconv.Itoa(host.Port))
	a.store.mu.Lock()
	known := a.store.state.KnownHosts[address]
	a.store.mu.Unlock()
	label := ""
	if jump {
		label = "跳板机 " + host.Name
	}
	trust := &hopTrust{address: address, known: known}
	verifier := func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		actual := ssh.FingerprintSHA256(key)
		if known != "" {
			if known != actual {
				return fmt.Errorf("HOST_KEY_CHANGED|%s|%s%s", known, actual, jumpSuffix(label))
			}
			return nil
		}
		if jump {
			// The approval dialog only covers the target host, so a jump host
			// must be trusted by connecting to it directly at least once.
			return fmt.Errorf("JUMP_HOST_UNTRUSTED|%s|%s", actual, host.Name)
		}
		if acceptedFingerprint == actual {
			trust.approved = actual
			return nil
		}
		return fmt.Errorf("HOST_KEY_UNKNOWN|%s", actual)
	}
	return &ssh.ClientConfig{
		User: host.Username, Auth: methods, HostKeyCallback: verifier, Timeout: 15 * time.Second,
	}, trust, closeAuth, nil
}

func jumpSuffix(label string) string {
	if label == "" {
		return ""
	}
	return "|" + label
}

// openSSHClient dials through the configured jump hosts and returns a client for
// the target host. The returned release function closes every hop.
func (a *App) openSSHClient(parent context.Context, host Host, credentials Credentials, acceptedFingerprint string) (*ssh.Client, []hopTrust, func(), error) {
	chain, err := a.hostChain(host)
	if err != nil {
		return nil, nil, func() {}, err
	}
	var (
		client   *ssh.Client
		trusts   []hopTrust
		closers  []func()
		cleanups []func()
	)
	release := func() {
		for i := len(closers) - 1; i >= 0; i-- {
			closers[i]()
		}
		for i := len(cleanups) - 1; i >= 0; i-- {
			cleanups[i]()
		}
	}
	for index, hop := range chain {
		isJump := index < len(chain)-1
		config, trust, closeAuth, configErr := a.sshConfig(hop, credentials, isJump, acceptedFingerprint)
		if configErr != nil {
			release()
			return nil, nil, func() {}, configErr
		}
		address := net.JoinHostPort(hop.Address, strconv.Itoa(hop.Port))
		ctx, cancel := context.WithTimeout(parent, 20*time.Second)
		var raw net.Conn
		if client == nil {
			raw, err = platform.DialSSH(ctx, address)
		} else {
			raw, err = client.DialContext(ctx, "tcp", address)
		}
		if err != nil {
			cancel()
			closeAuth()
			release()
			if isJump {
				return nil, nil, func() {}, fmt.Errorf("无法连接跳板机 %s：%w", hop.Name, err)
			}
			return nil, nil, func() {}, fmt.Errorf("无法连接 %s：%w", address, err)
		}
		stopCancel := context.AfterFunc(ctx, func() { raw.Close() })
		_ = raw.SetDeadline(time.Now().Add(20 * time.Second))
		conn, chans, reqs, handshakeErr := ssh.NewClientConn(raw, address, config)
		stopCancel()
		cancel()
		closeAuth()
		if handshakeErr != nil {
			raw.Close()
			release()
			if isJump {
				return nil, nil, func() {}, fmt.Errorf("跳板机 %s 的 SSH 握手失败：%w", hop.Name, handshakeErr)
			}
			return nil, nil, func() {}, fmt.Errorf("SSH 握手失败：%w", handshakeErr)
		}
		_ = raw.SetDeadline(time.Time{})
		next := ssh.NewClient(conn, chans, reqs)
		if client != nil {
			previous := client
			closers = append(closers, func() { previous.Close() })
		}
		client = next
		trusts = append(trusts, *trust)
	}
	return client, trusts, release, nil
}

func (a *App) Connect(id, hostID string, credentials Credentials, acceptedFingerprint string, size TerminalSize) error {
	return a.connectSSH(a.ctx, id, hostID, credentials, acceptedFingerprint, size)
}

func (a *App) connectSSH(parent context.Context, id, hostID string, credentials Credentials, acceptedFingerprint string, size TerminalSize) error {
	if err := a.ready(); err != nil {
		return err
	}
	if id == "" || len(id) > 128 {
		return errors.New("无效的会话 ID")
	}
	host, err := a.store.host(hostID)
	if err != nil {
		return err
	}
	if err = validateTunneling(host.PortForwards, host.X11); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		cancel()
		return errors.New("应用正在退出，不能创建连接")
	}
	_, exists := a.sessions[id]
	_, connecting := a.pending[id]
	if exists || connecting || a.localSessions[id] != nil {
		a.mu.Unlock()
		cancel()
		return errors.New("会话已存在")
	}
	a.pending[id] = cancel
	a.mu.Unlock()
	defer func() { cancel(); a.mu.Lock(); delete(a.pending, id); a.mu.Unlock() }()

	client, trusts, releaseTransport, err := a.openSSHClient(ctx, host, credentials, acceptedFingerprint)
	if err != nil {
		return err
	}
	keepClient := false
	defer func() {
		if !keepClient {
			client.Close()
			releaseTransport()
		}
	}()
	shell, err := client.NewSession()
	if err != nil {
		return err
	}
	var x11 *x11Forwarding
	if host.X11.Enabled {
		x11, err = prepareX11(client, host.X11, a.forwardingNotice(host))
		if err == nil {
			err = x11.request(shell)
		}
		if err != nil {
			shell.Close()
			return err
		}
	}
	stdin, err := shell.StdinPipe()
	if err != nil {
		shell.Close()
		return err
	}
	stdout, err := shell.StdoutPipe()
	if err != nil {
		shell.Close()
		return err
	}
	stderr, err := shell.StderrPipe()
	if err != nil {
		shell.Close()
		return err
	}
	size = validSize(size)
	if err = shell.RequestPty("xterm-256color", size.Rows, size.Cols, ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}); err != nil {
		shell.Close()
		return fmt.Errorf("无法创建终端：%w", err)
	}
	if err = shell.Shell(); err != nil {
		shell.Close()
		return err
	}
	if err = ctx.Err(); err != nil {
		shell.Close()
		return err
	}
	if err = a.persistTrust(hostID, trusts, acceptedFingerprint); err != nil {
		shell.Close()
		return err
	}
	forwarding, err := a.acquireForwarding(ctx, host, func(dialCtx context.Context) (*ssh.Client, func(), error) {
		c, _, release, dialErr := a.openSSHClient(dialCtx, host, credentials, acceptedFingerprint)
		if dialErr != nil {
			return nil, nil, dialErr
		}
		// The forwarding group owns this connection and every jump hop for its
		// lifetime.
		return c, release, nil
	})
	if err != nil {
		shell.Close()
		return err
	}
	defer func() {
		if !keepClient {
			a.releaseForwarding(forwarding)
		}
	}()
	s := &remoteSession{client: client, shell: shell, stdin: stdin, host: host, output: &terminalOutputBuffer{}, done: make(chan struct{}), finished: make(chan struct{}), x11: x11,
		releaseForwarding: func() { a.releaseForwarding(forwarding) },
		releaseTransport:  releaseTransport}
	a.mu.Lock()
	if a.closing || ctx.Err() != nil {
		a.mu.Unlock()
		shell.Close()
		return errors.New("连接已取消")
	}
	a.sessions[id] = s
	delete(a.pending, id)
	a.mu.Unlock()
	keepClient = true
	a.syncBackgroundState()
	// Announce the new shell before streaming its banner/prompt, so a client
	// reconnect separator never hides the prompt or interrupts shell output.
	if a.emit != nil {
		a.emit("ssh:connected:" + id)
	}
	var readers sync.WaitGroup
	readers.Add(2)
	for _, reader := range []io.Reader{stdout, stderr} {
		go func(r io.Reader) {
			defer readers.Done()
			a.copyTerminalOutput(id, s.output, r)
		}(reader)
	}
	go func() {
		defer close(s.finished)
		waitErr := shell.Wait()
		readers.Wait()
		current := a.removeTerminalSession(id, nil, s)
		a.syncBackgroundState()
		s.close()
		message := "会话已结束"
		if waitErr != nil {
			message = waitErr.Error()
		}
		if current && a.emit != nil {
			a.emit("ssh:closed:"+id, message)
		}
	}()
	// Read the interval here so the goroutine never touches a.store.
	go a.keepAlive(s, a.store.snapshot().Preferences.KeepAliveSeconds)
	return nil
}

// persistTrust saves approved fingerprints only after every hop has connected.
func (a *App) persistTrust(hostID string, trusts []hopTrust, acceptedFingerprint string) error {
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	previous := map[string]string{}
	for _, trust := range trusts {
		if trust.approved == "" {
			continue
		}
		previous[trust.address] = a.store.state.KnownHosts[trust.address]
		a.store.state.KnownHosts[trust.address] = trust.approved
	}
	for _, trust := range trusts {
		if trust.approved != "" || trust.known == "" {
			continue
		}
		// Another connection may have changed trust while this one dialed.
		if known := a.store.state.KnownHosts[trust.address]; known != trust.known {
			for address, value := range previous {
				if value == "" {
					delete(a.store.state.KnownHosts, address)
				} else {
					a.store.state.KnownHosts[address] = value
				}
			}
			return errors.New("主机指纹在连接期间发生变化，请重试")
		}
	}
	if len(previous) == 0 {
		return nil
	}
	for i, h := range a.store.state.Hosts {
		if h.ID == hostID {
			a.store.state.Hosts[i].LastConnected = time.Now().Format(time.RFC3339)
		}
	}
	if err := a.store.persistLocked(); err != nil {
		for address, value := range previous {
			if value == "" {
				delete(a.store.state.KnownHosts, address)
			} else {
				a.store.state.KnownHosts[address] = value
			}
		}
		return fmt.Errorf("无法保存主机信任信息：%w", err)
	}
	return nil
}

func (a *App) keepAlive(s *remoteSession, interval int) {
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
		}
		result := make(chan error, 1)
		go func() { _, _, e := s.client.SendRequest("keepalive@openssh.com", true, nil); result <- e }()
		timer := time.NewTimer(10 * time.Second)
		select {
		case <-s.done:
			timer.Stop()
			return
		case e := <-result:
			timer.Stop()
			if e != nil {
				s.close()
				return
			}
		case <-timer.C:
			s.close()
			return
		}
	}
}
