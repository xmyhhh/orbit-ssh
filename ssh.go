package main

import (
	"context"
	"encoding/base64"
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
type TerminalSize struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}
type remoteSession struct {
	client      *ssh.Client
	shell       *ssh.Session
	stdin       io.WriteCloser
	files       *sftp.Client
	mu          sync.Mutex
	writeMu     sync.Mutex
	once        sync.Once
	closed      bool
	done        chan struct{}
	monitorMu   sync.Mutex
	previousCPU *cpuSample
}

func (s *remoteSession) close() {
	s.once.Do(func() {
		close(s.done)
		// Close the transport first so blocked SFTP requests can release s.mu.
		s.client.Close()
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

func validSize(size TerminalSize) TerminalSize {
	if size.Cols < 2 || size.Cols > 1000 {
		size.Cols = 100
	}
	if size.Rows < 2 || size.Rows > 500 {
		size.Rows = 30
	}
	return size
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
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
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
	defer func() {
		if !keepClient {
			client.Close()
		}
	}()
	shell, err := client.NewSession()
	if err != nil {
		return err
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
	s := &remoteSession{client: client, shell: shell, stdin: stdin, done: make(chan struct{})}
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
			buffer := make([]byte, 16384)
			for {
				n, e := r.Read(buffer)
				if n > 0 && a.emit != nil {
					a.emit("ssh:data:"+id, base64.StdEncoding.EncodeToString(buffer[:n]))
				}
				if e != nil {
					return
				}
			}
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

func (a *App) WriteTerminal(id, data string) error {
	if len(data) > 1024*1024 {
		return errors.New("单次输入过大")
	}
	a.mu.Lock()
	local := a.localSessions[id]
	a.mu.Unlock()
	if local != nil {
		local.writeMu.Lock()
		defer local.writeMu.Unlock()
		_, err := io.WriteString(local.terminal, data)
		return err
	}
	s, e := a.session(id)
	if e != nil {
		return e
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, e = io.WriteString(s.stdin, data)
	return e
}
func (a *App) ResizeTerminal(id string, size TerminalSize) error {
	a.mu.Lock()
	local := a.localSessions[id]
	a.mu.Unlock()
	if local != nil {
		size = validSize(size)
		return local.terminal.Resize(size.Cols, size.Rows)
	}
	s, e := a.session(id)
	if e != nil {
		return e
	}
	size = validSize(size)
	return s.shell.WindowChange(size.Rows, size.Cols)
}
func (a *App) Disconnect(id string) error {
	a.mu.Lock()
	s := a.sessions[id]
	local := a.localSessions[id]
	delete(a.sessions, id)
	delete(a.localSessions, id)
	cancel := a.pending[id]
	delete(a.pending, id)
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if s != nil {
		s.close()
	}
	if local != nil {
		local.close()
	}
	return nil
}
