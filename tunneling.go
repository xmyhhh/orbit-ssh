package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

type PortForward struct {
	ID              string `json:"id"`
	Type            string `json:"type"`
	Enabled         bool   `json:"enabled"`
	BindAddress     string `json:"bindAddress"`
	BindPort        int    `json:"bindPort"`
	DestinationHost string `json:"destinationHost"`
	DestinationPort int    `json:"destinationPort"`
	Description     string `json:"description"`
}

type X11Config struct {
	Enabled  bool   `json:"enabled"`
	Display  string `json:"display"`
	AuthFile string `json:"authFile"`
}

func validForwardHost(host string) bool {
	return host != "" && strings.TrimSpace(host) == host && !strings.ContainsAny(host, " \t\r\n/\\\x00[]") && (net.ParseIP(host) != nil || !strings.Contains(host, ":"))
}

func forwardBindAddress(rule PortForward) string {
	if rule.BindAddress == "" {
		return "127.0.0.1"
	}
	return rule.BindAddress
}

func validateTunneling(rules []PortForward, x11 X11Config) error {
	if len(rules) > 64 {
		return errors.New("每台主机最多保存 64 条端口转发规则")
	}
	ids := map[string]bool{}
	bindings := map[string]bool{}
	for i, rule := range rules {
		invalid := func(message string) error { return fmt.Errorf("端口转发规则 %d：%s", i+1, message) }
		if rule.ID == "" || len(rule.ID) > 128 || ids[rule.ID] {
			return invalid("无效或重复的规则 ID")
		}
		ids[rule.ID] = true
		if rule.Type != "local" && rule.Type != "remote" && rule.Type != "dynamic" {
			return invalid("请选择本地、远程或动态转发")
		}
		bind := forwardBindAddress(rule)
		if !validForwardHost(bind) {
			return invalid("监听地址应为 IP 或域名，不包含协议、方括号或端口")
		}
		// ssh.Client.Listen resolves remote bind names locally; require an IP so
		// the address sent to sshd is exactly the address the user configured.
		if rule.Type == "remote" && net.ParseIP(bind) == nil {
			return invalid("远程监听地址请填写 IP，例如 127.0.0.1、0.0.0.0 或 ::1")
		}
		if rule.BindPort < 1 || rule.BindPort > 65535 {
			return invalid("监听端口应在 1–65535 之间")
		}
		if rule.Type != "dynamic" {
			if !validForwardHost(rule.DestinationHost) {
				return invalid("目标地址应为 IP 或域名，不包含协议或端口")
			}
			if rule.DestinationPort < 1 || rule.DestinationPort > 65535 {
				return invalid("目标端口应在 1–65535 之间")
			}
		}
		if len(rule.Description) > 240 {
			return invalid("描述最多 240 字节")
		}
		if !rule.Enabled {
			continue
		}
		side := "local"
		if rule.Type == "remote" {
			side = "remote"
		}
		key := side + ":" + net.JoinHostPort(strings.ToLower(bind), strconv.Itoa(rule.BindPort))
		if bindings[key] {
			return invalid("同一监听地址和端口只能启用一条规则")
		}
		bindings[key] = true
	}
	if x11.Enabled {
		if _, err := parseXDisplay(x11.Display); err != nil {
			return err
		}
		if strings.ContainsAny(x11.AuthFile, "\x00\r\n") {
			return errors.New("无效的 Xauthority 文件路径")
		}
	}
	return nil
}

// A separate SSH transport owns each host's forwarding rules. This keeps a
// listener alive when its first terminal closes and avoids binding it again
// for every terminal. The final terminal releases the forwarding transport.
type hostForwarding struct {
	ready   chan struct{}
	refs    int // guarded by App.forwardMu
	host    Host
	rules   []PortForward
	client  *ssh.Client
	runtime *forwardingRuntime
	err     error // published by closing ready
}

type forwardingRuntime struct {
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	closed    bool
	listeners []net.Listener
	streams   map[io.Closer]bool
	notice    func(string)
	lastError time.Time
}

func newForwardingRuntime(notice func(string)) *forwardingRuntime {
	ctx, cancel := context.WithCancel(context.Background())
	return &forwardingRuntime{ctx: ctx, cancel: cancel, streams: map[io.Closer]bool{}, notice: notice}
}

func (r *forwardingRuntime) track(stream io.Closer) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		stream.Close()
		return false
	}
	r.streams[stream] = true
	return true
}

func (r *forwardingRuntime) release(stream io.Closer) {
	stream.Close()
	r.mu.Lock()
	delete(r.streams, stream)
	r.mu.Unlock()
}

func (r *forwardingRuntime) report(message string) {
	r.mu.Lock()
	emit := !r.closed && r.ctx.Err() == nil && time.Since(r.lastError) > 2*time.Second
	if emit {
		r.lastError = time.Now()
	}
	r.mu.Unlock()
	if emit && r.notice != nil {
		r.notice(message)
	}
}

func (r *forwardingRuntime) close() {
	r.cancel()
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	listeners, streams := r.listeners, r.streams
	r.listeners = nil
	r.streams = map[io.Closer]bool{}
	r.mu.Unlock()
	for stream := range streams {
		stream.Close()
	}
	for _, listener := range listeners {
		listener.Close()
	}
}

func (a *App) forwardingNotice(host Host) func(string) {
	return func(message string) {
		if a.emit != nil {
			a.emit("ssh:notice", host.Name+" · "+message)
		}
	}
}

func (a *App) acquireForwarding(ctx context.Context, host Host, config *ssh.ClientConfig) (*hostForwarding, error) {
	rules := []PortForward{}
	for _, rule := range host.PortForwards {
		if rule.Enabled {
			rules = append(rules, rule)
		}
	}
	// A host that was connected before rules were enabled must also restart;
	// otherwise its older terminals would not hold a forwarding reference.
	a.mu.Lock()
	for _, session := range a.sessions {
		if session.host.ID != host.ID {
			continue
		}
		previous := []PortForward{}
		for _, rule := range session.host.PortForwards {
			if rule.Enabled {
				previous = append(previous, rule)
			}
		}
		if !reflect.DeepEqual(previous, rules) {
			a.mu.Unlock()
			return nil, errors.New("端口转发设置已修改，请先断开此主机的全部终端，再重新连接")
		}
	}
	a.mu.Unlock()
	a.forwardMu.Lock()
	if a.forwards == nil {
		a.forwards = map[string]*hostForwarding{}
	}
	group := a.forwards[host.ID]
	if group != nil && (group.host.Address != host.Address || group.host.Port != host.Port || group.host.Username != host.Username || !reflect.DeepEqual(group.rules, rules)) {
		a.forwardMu.Unlock()
		return nil, errors.New("端口转发设置已修改，请先断开此主机的全部终端，再重新连接")
	}
	if group == nil && len(rules) == 0 {
		a.forwardMu.Unlock()
		return nil, nil
	}
	creator := group == nil
	if creator {
		group = &hostForwarding{ready: make(chan struct{}), host: host, rules: rules}
		a.forwards[host.ID] = group
	}
	group.refs++
	a.forwardMu.Unlock()
	if creator {
		group.err = group.start(ctx, config, a.forwardingNotice(host))
		close(group.ready)
	}
	select {
	case <-ctx.Done():
		a.releaseForwarding(group)
		return nil, ctx.Err()
	case <-group.ready:
	}
	if group.err != nil {
		a.releaseForwarding(group)
		return nil, group.err
	}
	if group.runtime.ctx.Err() != nil {
		a.releaseForwarding(group)
		return nil, errors.New("端口转发连接已断开，请断开此主机的全部终端后重连")
	}
	return group, nil
}

func (a *App) releaseForwarding(group *hostForwarding) {
	if group == nil {
		return
	}
	a.forwardMu.Lock()
	defer a.forwardMu.Unlock()
	group.refs--
	last := group.refs == 0
	if last {
		<-group.ready
		if group.runtime != nil {
			group.runtime.cancel()
		}
		if group.client != nil {
			// Close the transport before remote listeners, whose Close sends a
			// global request and must not wait on an unresponsive SSH server.
			group.client.Close()
		}
		if group.runtime != nil {
			group.runtime.close()
		}
		delete(a.forwards, group.host.ID)
	}
}

func (g *hostForwarding) start(ctx context.Context, config *ssh.ClientConfig, notice func(string)) error {
	address := net.JoinHostPort(g.host.Address, strconv.Itoa(g.host.Port))
	raw, err := dialSSH(ctx, address)
	if err != nil {
		return fmt.Errorf("无法建立端口转发连接：%w", err)
	}
	stop := context.AfterFunc(ctx, func() { raw.Close() })
	defer stop()
	_ = raw.SetDeadline(time.Now().Add(20 * time.Second))
	conn, chans, reqs, err := ssh.NewClientConn(raw, address, config)
	if err != nil {
		raw.Close()
		return fmt.Errorf("端口转发 SSH 握手失败：%w", err)
	}
	g.client = ssh.NewClient(conn, chans, reqs)
	g.runtime = newForwardingRuntime(notice)
	for _, rule := range g.rules {
		bind := net.JoinHostPort(forwardBindAddress(rule), strconv.Itoa(rule.BindPort))
		var listener net.Listener
		if rule.Type == "remote" {
			listener, err = g.client.Listen("tcp", bind)
		} else {
			listener, err = (&net.ListenConfig{}).Listen(ctx, "tcp", bind)
		}
		if err != nil {
			g.runtime.cancel()
			g.client.Close()
			g.runtime.close()
			return fmt.Errorf("无法启动%s转发 %s（请检查端口占用和 SSH 转发权限）：%w", forwardTypeName(rule.Type), bind, err)
		}
		g.runtime.listeners = append(g.runtime.listeners, listener)
	}
	if !stop() || ctx.Err() != nil {
		g.runtime.cancel()
		g.client.Close()
		g.runtime.close()
		return errors.New("端口转发连接已取消")
	}
	_ = raw.SetDeadline(time.Time{})
	for i, listener := range g.runtime.listeners {
		go g.runtime.serve(listener, g.client, g.rules[i])
	}
	go func() {
		_ = g.client.Wait()
		g.runtime.report("端口转发连接已断开，请断开此主机的全部终端后重连")
		g.runtime.close()
	}()
	go keepForwardingAlive(g.client, g.runtime)
	return nil
}

func forwardTypeName(kind string) string {
	switch kind {
	case "remote":
		return "远程"
	case "dynamic":
		return "动态 SOCKS5"
	default:
		return "本地"
	}
}

func keepForwardingAlive(client *ssh.Client, r *forwardingRuntime) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
		}
		result := make(chan error, 1)
		go func() { _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); result <- err }()
		timer := time.NewTimer(10 * time.Second)
		select {
		case <-r.ctx.Done():
			timer.Stop()
			return
		case err := <-result:
			timer.Stop()
			if err == nil {
				continue
			}
		case <-timer.C:
		}
		client.Close()
		return
	}
}

func (r *forwardingRuntime) serve(listener net.Listener, client *ssh.Client, rule PortForward) {
	for {
		incoming, err := listener.Accept()
		if err != nil {
			if r.ctx.Err() == nil {
				r.report(fmt.Sprintf("%s转发监听已停止：%v", forwardTypeName(rule.Type), err))
			}
			return
		}
		if !r.track(incoming) {
			return
		}
		go func() {
			defer r.release(incoming)
			ctx, cancel := context.WithTimeout(r.ctx, 15*time.Second)
			defer cancel()
			if rule.Type == "dynamic" {
				r.serveSOCKS(ctx, client, incoming)
				return
			}
			address := net.JoinHostPort(rule.DestinationHost, strconv.Itoa(rule.DestinationPort))
			var outgoing net.Conn
			var err error
			if rule.Type == "remote" {
				outgoing, err = dialSSH(ctx, address)
			} else {
				outgoing, err = client.DialContext(ctx, "tcp", address)
			}
			if err != nil {
				r.report(fmt.Sprintf("%s转发无法连接目标 %s：%v", forwardTypeName(rule.Type), address, err))
				return
			}
			if !r.track(outgoing) {
				return
			}
			defer r.release(outgoing)
			relayStreams(incoming, outgoing)
		}()
	}
}

// Preserve TCP half-closes: a client can finish its request and still read the
// complete response (databases and HTTP clients use this behavior).
func relayStreams(left, right io.ReadWriteCloser) {
	var wg sync.WaitGroup
	copyStream := func(dst, src io.ReadWriteCloser) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if half, ok := dst.(interface{ CloseWrite() error }); ok {
			half.CloseWrite()
		} else {
			dst.Close()
		}
	}
	wg.Add(2)
	go copyStream(left, right)
	go copyStream(right, left)
	wg.Wait()
}

func socksReply(conn net.Conn, code byte) {
	_, _ = conn.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
}

func (r *forwardingRuntime) serveSOCKS(ctx context.Context, client *ssh.Client, conn net.Conn) {
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:2]); err != nil || header[0] != 5 || header[1] == 0 {
		return
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return
	}
	noAuth := false
	for _, method := range methods {
		noAuth = noAuth || method == 0
	}
	if !noAuth {
		_, _ = conn.Write([]byte{5, 255})
		return
	}
	if _, err := conn.Write([]byte{5, 0}); err != nil {
		return
	}
	if _, err := io.ReadFull(conn, header[:]); err != nil || header[0] != 5 || header[2] != 0 {
		return
	}
	if header[1] != 1 {
		socksReply(conn, 7) // CONNECT only; BIND and UDP ASSOCIATE are unsupported.
		return
	}
	var host string
	switch header[3] {
	case 1, 4:
		size := 4
		if header[3] == 4 {
			size = 16
		}
		ip := make([]byte, size)
		if _, err := io.ReadFull(conn, ip); err != nil {
			return
		}
		host = net.IP(ip).String()
	case 3:
		if _, err := io.ReadFull(conn, header[:1]); err != nil || header[0] == 0 {
			return
		}
		name := make([]byte, int(header[0]))
		if _, err := io.ReadFull(conn, name); err != nil {
			return
		}
		host = string(name)
	default:
		socksReply(conn, 8)
		return
	}
	if _, err := io.ReadFull(conn, header[:2]); err != nil {
		return
	}
	port := int(header[0])<<8 | int(header[1])
	if !validForwardHost(host) || port == 0 {
		socksReply(conn, 4)
		return
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	outgoing, err := client.DialContext(ctx, "tcp", address)
	if err != nil {
		socksReply(conn, 5)
		r.report(fmt.Sprintf("SOCKS5 无法连接目标 %s：%v", address, err))
		return
	}
	if !r.track(outgoing) {
		return
	}
	defer r.release(outgoing)
	socksReply(conn, 0)
	_ = conn.SetDeadline(time.Time{})
	relayStreams(conn, outgoing)
}
