package main

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
)

type Credentials struct {
	Password   string `json:"password"`
	Passphrase string `json:"passphrase"`
}

type remoteSession struct {
	client            *ssh.Client
	shell             *ssh.Session
	stdin             io.WriteCloser
	files             *sftp.Client
	host              Host
	output            *terminalOutputBuffer
	mu                sync.Mutex
	writeMu           sync.Mutex
	once              sync.Once
	closed            bool
	done              chan struct{}
	monitorMu         sync.Mutex
	previousCPU       *cpuSample
	x11               *x11Forwarding
	releaseForwarding func()
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
	var auth ssh.AuthMethod
	if host.AuthType == "key" {
		data, readErr := os.ReadFile(host.KeyPath)
		if readErr != nil {
			return fmt.Errorf("无法读取私钥：%w", readErr)
		}
		signer, parseErr := ssh.ParsePrivateKey(data)
		err = parseErr
		var encrypted *ssh.PassphraseMissingError
		if errors.As(parseErr, &encrypted) {
			if credentials.Passphrase == "" {
				if saved, e := getKeyPassphrase(host.ID); e == nil {
					credentials.Passphrase = saved
				}
			}
			if credentials.Passphrase != "" {
				signer, err = ssh.ParsePrivateKeyWithPassphrase(data, []byte(credentials.Passphrase))
			}
		}
		if err != nil {
			var missing *ssh.PassphraseMissingError
			if errors.As(err, &missing) {
				return errors.New("KEY_PASSPHRASE_REQUIRED|此私钥已加密，请输入口令")
			}
			return fmt.Errorf("无法解析私钥，请检查格式或口令：%w", err)
		}
		auth = ssh.PublicKeys(signer)
	} else {
		if credentials.Password == "" {
			credentials.Password, err = savedPassword(host)
			if err != nil {
				return err
			}
			if credentials.Password == "" {
				return errors.New("PASSWORD_REQUIRED|请输入登录密码")
			}
		}
		auth = ssh.Password(credentials.Password)
	}
	address := net.JoinHostPort(host.Address, strconv.Itoa(host.Port))
	a.store.mu.Lock()
	known := a.store.state.KnownHosts[address]
	a.store.mu.Unlock()
	config := &ssh.ClientConfig{User: host.Username, Auth: []ssh.AuthMethod{auth}, HostKeyCallback: hostKeyVerifier(known, acceptedFingerprint), Timeout: 15 * time.Second}
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	a.mu.Lock()
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
	conn, err := dialSSH(ctx, address)
	if err != nil {
		return fmt.Errorf("无法连接 %s：%w", address, err)
	}
	keepConn := false
	defer func() {
		if !keepConn {
			conn.Close()
		}
	}()
	stopCancel := context.AfterFunc(ctx, func() { conn.Close() })
	defer stopCancel()
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	c, chans, reqs, err := ssh.NewClientConn(conn, address, config)
	if err != nil {
		return fmt.Errorf("SSH 握手失败：%w", err)
	}
	client := ssh.NewClient(c, chans, reqs)
	keepClient := false
	var x11 *x11Forwarding
	defer func() {
		if !keepClient {
			client.Close()
			if x11 != nil {
				x11.runtime.close()
			}
		}
	}()
	shell, err := client.NewSession()
	if err != nil {
		return err
	}
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
	if !stopCancel() {
		shell.Close()
		return errors.New("连接已取消")
	}
	_ = conn.SetDeadline(time.Time{})
	a.store.mu.Lock()
	oldKnown := a.store.state.KnownHosts[address]
	// A concurrent connection may have trusted a different key while this dial ran.
	if oldKnown != "" && oldKnown != known && oldKnown != acceptedFingerprint {
		a.store.mu.Unlock()
		shell.Close()
		return errors.New("主机指纹在连接期间发生变化，请重试")
	}
	if known == "" {
		a.store.state.KnownHosts[address] = acceptedFingerprint
	}
	for i, h := range a.store.state.Hosts {
		if h.ID == hostID {
			a.store.state.Hosts[i].LastConnected = time.Now().Format(time.RFC3339)
		}
	}
	err = a.store.persistLocked()
	if err != nil {
		if oldKnown == "" {
			delete(a.store.state.KnownHosts, address)
		} else {
			a.store.state.KnownHosts[address] = oldKnown
		}
	}
	a.store.mu.Unlock()
	if err != nil {
		shell.Close()
		return fmt.Errorf("无法保存主机信任信息：%w", err)
	}
	forwarding, err := a.acquireForwarding(ctx, host, config)
	if err != nil {
		shell.Close()
		return err
	}
	defer func() {
		if !keepClient {
			a.releaseForwarding(forwarding)
		}
	}()
	s := &remoteSession{client: client, shell: shell, stdin: stdin, host: host, output: &terminalOutputBuffer{}, done: make(chan struct{}), x11: x11,
		releaseForwarding: func() { a.releaseForwarding(forwarding) }}
	a.mu.Lock()
	if ctx.Err() != nil {
		a.mu.Unlock()
		shell.Close()
		return errors.New("连接已取消")
	}
	a.sessions[id] = s
	delete(a.pending, id)
	a.mu.Unlock()
	keepClient = true
	// The client owns conn after a successful handshake; prevent the deferred close.
	keepConn = true
	var readers sync.WaitGroup
	readers.Add(2)
	for _, reader := range []io.Reader{stdout, stderr} {
		go func(r io.Reader) {
			defer readers.Done()
			a.copyTerminalOutput(id, s.output, r)
		}(reader)
	}
	go func() {
		waitErr := shell.Wait()
		readers.Wait()
		a.mu.Lock()
		if a.sessions[id] == s {
			delete(a.sessions, id)
		}
		a.mu.Unlock()
		s.close()
		message := "会话已结束"
		if waitErr != nil {
			message = waitErr.Error()
		}
		if a.emit != nil {
			a.emit("ssh:closed:"+id, message)
		}
	}()
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.done:
				return
			case <-ticker.C:
			}
			result := make(chan error, 1)
			go func() { _, _, e := client.SendRequest("keepalive@openssh.com", true, nil); result <- e }()
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
	}()
	return nil
}
