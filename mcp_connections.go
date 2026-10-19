package main

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"time"
)

type mcpCreateHostArgs struct {
	Name       string `json:"name"`
	Address    string `json:"address"`
	Port       *int   `json:"port"`
	Username   string `json:"username"`
	AuthType   string `json:"auth_type"`
	KeyPath    string `json:"key_path"`
	JumpHostID string `json:"jump_host_id"`
	Group      string `json:"group"`
}

type mcpConnectHostArgs struct {
	HostID              string `json:"host_id"`
	Name                string `json:"name"`
	Password            string `json:"password"`
	Passphrase          string `json:"passphrase"`
	AcceptedFingerprint string `json:"accepted_fingerprint"`
}

type mcpConnectionEvent struct {
	SessionID string `json:"sessionId"`
	Host      Host   `json:"host"`
	Name      string `json:"name,omitempty"`
}

type mcpConnectionRequest struct {
	ctx         context.Context
	cancel      context.CancelFunc
	hostID      string
	name        string
	credentials Credentials
	fingerprint string
	started     bool
	done        chan error
}

func (a *App) allowMCPConnections() error {
	if err := a.ready(); err != nil {
		return err
	}
	if !a.store.snapshot().Preferences.MCPAllowConnections {
		return errors.New("请先在偏好设置中启用“允许 AI 创建连接”")
	}
	return nil
}

func (a *App) createMCPHost(args mcpCreateHostArgs) (Host, error) {
	if err := a.allowMCPConnections(); err != nil {
		return Host{}, err
	}
	host := Host{
		ID: "mcp-" + rand.Text(), Name: strings.TrimSpace(args.Name), Address: strings.TrimSpace(args.Address),
		Port: 22, Username: strings.TrimSpace(args.Username), AuthType: args.AuthType,
		KeyPath: strings.TrimSpace(args.KeyPath), Group: strings.TrimSpace(args.Group), Color: "mint",
		JumpHostID: strings.TrimSpace(args.JumpHostID),
	}
	if args.Port != nil {
		host.Port = *args.Port
	}
	if host.Name == "" {
		host.Name = host.Username + "@" + host.Address
	}
	if host.AuthType == "" {
		host.AuthType = "password"
		if host.KeyPath != "" {
			host.AuthType = "key"
		}
	}
	if err := a.SaveHost(host); err != nil {
		return Host{}, err
	}
	if a.emit != nil {
		a.emit("mcp:host-created", host)
	}
	return host, nil
}

func (a *App) connectMCPHost(parent context.Context, args mcpConnectHostArgs) (string, error) {
	if err := a.allowMCPConnections(); err != nil {
		return "", err
	}
	if len(args.Password) > 16*1024 || len(args.Passphrase) > 16*1024 {
		return "", errors.New("登录凭据过长")
	}
	name, err := normalizeSessionName(args.Name)
	if err != nil {
		return "", err
	}
	host, err := a.store.host(args.HostID)
	if err != nil {
		return "", err
	}
	if a.emit == nil {
		return "", errors.New("请先打开 Orbit SSH 应用界面")
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	stop := context.AfterFunc(a.ctx, cancel)
	defer stop()
	id := "mcp-" + rand.Text()
	request := &mcpConnectionRequest{
		ctx: ctx, cancel: cancel, hostID: host.ID, name: name,
		credentials: Credentials{Password: args.Password, Passphrase: args.Passphrase},
		fingerprint: args.AcceptedFingerprint, done: make(chan error, 1),
	}
	a.mu.Lock()
	if len(a.mcpConnections) >= 20 {
		a.mu.Unlock()
		return "", errors.New("正在建立的 AI 连接过多，请稍后重试")
	}
	a.mcpConnections[id] = request
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.mcpConnections, id)
		a.mu.Unlock()
	}()
	// The WebView mounts the normal terminal and its output listeners before
	// calling ConnectMCPHost. Credentials stay in Go and never enter the event.
	a.emit("mcp:connect", mcpConnectionEvent{SessionID: id, Host: host, Name: name})
	select {
	case err := <-request.done:
		if err != nil {
			return "", err
		}
		return id, nil
	case <-ctx.Done():
		// The UI may close a failed terminal immediately after receiving its
		// error. Preserve that error (especially HOST_KEY_UNKNOWN) over cancel.
		select {
		case err := <-request.done:
			if err != nil {
				return "", err
			}
		default:
		}
		_ = a.Disconnect(id)
		if errors.Is(ctx.Err(), context.Canceled) {
			return "", errors.New("连接请求已取消")
		}
		return "", errors.New("创建连接超时，请确认 Orbit SSH 应用界面可用后重试")
	}
}

// ConnectMCPHost is called by the mounted terminal, not exposed as an MCP tool.
// Each request can be claimed once and can only connect its original host.
func (a *App) ConnectMCPHost(id string, size TerminalSize) error {
	a.mu.Lock()
	request := a.mcpConnections[id]
	if request == nil || request.started || request.ctx.Err() != nil {
		a.mu.Unlock()
		return errors.New("AI 连接请求不存在、已取消或已开始")
	}
	request.started = true
	a.mu.Unlock()
	err := a.allowMCPConnections()
	if err == nil {
		err = a.connectSSH(request.ctx, id, request.hostID, request.credentials, request.fingerprint, size)
	}
	if err == nil && request.name != "" {
		a.mu.Lock()
		if session := a.sessions[id]; session != nil {
			session.customName = request.name
		}
		a.mu.Unlock()
	}
	request.done <- err
	return err
}
