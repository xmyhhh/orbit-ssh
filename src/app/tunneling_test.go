package app

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func unusedTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return port
}

func testTCPService(t *testing.T, afterEOF bool) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
				if afterEOF {
					request, _ := io.ReadAll(conn)
					_, _ = conn.Write(append([]byte("response:"), request...))
				} else {
					_, _ = io.Copy(conn, conn)
				}
			}()
		}
	}()
	return listener.Addr().String()
}

// A real SSH server implementing RFC 4254 direct/forwarded TCP channels. The
// special domain deliberately resolves only here, to verify remote SOCKS DNS.
func testForwardFeatures(t *testing.T, remoteOnlyTarget string) (*testSSHFeatures, <-chan string) {
	t.Helper()
	var mu sync.Mutex
	listeners := map[*ssh.ServerConn]map[string]net.Listener{}
	destinations := make(chan string, 100)
	features := &testSSHFeatures{}
	features.channel = func(_ *ssh.ServerConn, incoming ssh.NewChannel) bool {
		if incoming.ChannelType() != "direct-tcpip" {
			return false
		}
		var payload struct {
			Host       string
			Port       uint32
			OriginHost string
			OriginPort uint32
		}
		if ssh.Unmarshal(incoming.ExtraData(), &payload) != nil {
			incoming.Reject(ssh.ConnectionFailed, "bad request")
			return true
		}
		address := net.JoinHostPort(payload.Host, strconv.Itoa(int(payload.Port)))
		destinations <- address
		if payload.Host == "remote-only.invalid" {
			address = remoteOnlyTarget
		}
		destination, err := net.DialTimeout("tcp", address, 2*time.Second)
		if err != nil {
			incoming.Reject(ssh.ConnectionFailed, err.Error())
			return true
		}
		channel, requests, err := incoming.Accept()
		if err != nil {
			destination.Close()
			return true
		}
		go ssh.DiscardRequests(requests)
		go testForwardPipe(channel, destination)
		return true
	}
	features.request = func(conn *ssh.ServerConn, request *ssh.Request) bool {
		if request.Type != "tcpip-forward" && request.Type != "cancel-tcpip-forward" {
			return false
		}
		var payload struct {
			Host string
			Port uint32
		}
		if ssh.Unmarshal(request.Payload, &payload) != nil {
			request.Reply(false, nil)
			return true
		}
		address := net.JoinHostPort(payload.Host, strconv.Itoa(int(payload.Port)))
		if request.Type == "cancel-tcpip-forward" {
			mu.Lock()
			listener := listeners[conn][address]
			delete(listeners[conn], address)
			mu.Unlock()
			if listener != nil {
				listener.Close()
			}
			request.Reply(true, nil)
			return true
		}
		listener, err := net.Listen("tcp", address)
		if err != nil {
			request.Reply(false, nil)
			return true
		}
		mu.Lock()
		if listeners[conn] == nil {
			listeners[conn] = map[string]net.Listener{}
		}
		listeners[conn][address] = listener
		mu.Unlock()
		go func() { conn.Wait(); listener.Close() }()
		request.Reply(true, nil)
		go func() {
			for {
				incoming, err := listener.Accept()
				if err != nil {
					return
				}
				go func() {
					origin := incoming.RemoteAddr().(*net.TCPAddr)
					forwarded := struct {
						Host       string
						Port       uint32
						OriginHost string
						OriginPort uint32
					}{payload.Host, payload.Port, origin.IP.String(), uint32(origin.Port)}
					channel, requests, err := conn.OpenChannel("forwarded-tcpip", ssh.Marshal(forwarded))
					if err != nil {
						incoming.Close()
						return
					}
					go ssh.DiscardRequests(requests)
					testForwardPipe(channel, incoming)
				}()
			}
		}()
		return true
	}
	return features, destinations
}

func testForwardPipe(channel ssh.Channel, conn net.Conn) {
	defer channel.Close()
	defer conn.Close()
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(conn, channel)
		if tcp, ok := conn.(*net.TCPConn); ok {
			tcp.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(channel, conn)
	channel.CloseWrite()
	<-done
}

func testForwardRule(t *testing.T, kind, target string) PortForward {
	t.Helper()
	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(portText)
	return PortForward{ID: kind, Type: kind, Enabled: true, BindAddress: "127.0.0.1", BindPort: unusedTCPPort(t), DestinationHost: host, DestinationPort: port}
}

func TestForwardingReleasesJumpTransport(t *testing.T) {
	address, _ := testSSHServer(t)
	client, err := ssh.Dial("tcp", address, &ssh.ClientConfig{
		User: "tester", Auth: []ssh.AuthMethod{ssh.Password("session-only-secret")},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	a := testAppWithStore(t)
	rule := testForwardRule(t, "local", "127.0.0.1:1234")
	host := Host{ID: "jump-forward", Name: "jump-forward", PortForwards: []PortForward{rule}}
	released := 0
	group, err := a.acquireForwarding(context.Background(), host, func(context.Context) (*ssh.Client, func(), error) {
		return client, func() { released++ }, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if group == nil {
		t.Fatal("forwarding group was not created")
	}
	if released != 0 {
		t.Fatal("transport was released before the last terminal closed")
	}
	a.releaseForwarding(group)
	if released != 1 {
		t.Fatalf("jump transport release calls = %d, want 1", released)
	}
	if len(a.forwards) != 0 {
		t.Fatal("forwarding group was not removed")
	}
}

func testDialForward(t *testing.T, rule PortForward) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(rule.BindPort)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
	t.Cleanup(func() { conn.Close() })
	return conn
}

func testForwardEcho(t *testing.T, conn net.Conn) {
	t.Helper()
	payload := []byte(strings.Repeat("SSH 隧道 \x00\xff\n", 8192))
	written := make(chan error, 1)
	go func() { _, err := conn.Write(payload); written <- err }()
	actual := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, actual); err != nil {
		t.Fatal(err)
	}
	if err := <-written; err != nil || string(actual) != string(payload) {
		t.Fatalf("forwarded data changed: %v", err)
	}
}

func testSOCKSConnect(t *testing.T, rule PortForward, atyp byte, target string) net.Conn {
	t.Helper()
	conn := testDialForward(t, rule)
	_, _ = conn.Write([]byte{5, 2, 2, 0})
	var response [10]byte
	if _, err := io.ReadFull(conn, response[:2]); err != nil || response[0] != 5 || response[1] != 0 {
		t.Fatalf("SOCKS method selection failed: %v %v", response[:2], err)
	}
	host, portText, _ := net.SplitHostPort(target)
	port, _ := strconv.Atoi(portText)
	request := []byte{5, 1, 0, atyp}
	switch atyp {
	case 1:
		request = append(request, net.ParseIP(host).To4()...)
	case 4:
		request = append(request, net.ParseIP(host).To16()...)
	case 3:
		request = append(request, byte(len(host)))
		request = append(request, host...)
	}
	request = binary.BigEndian.AppendUint16(request, uint16(port))
	_, _ = conn.Write(request)
	if _, err := io.ReadFull(conn, response[:]); err != nil || response[1] != 0 {
		t.Fatalf("SOCKS connect failed: %v %v", response, err)
	}
	return conn
}

func TestPortForwardsEndToEndAndSharedLifetime(t *testing.T) {
	target := testTCPService(t, false)
	features, destinations := testForwardFeatures(t, target)
	address, fingerprint := testSSHServerWithFeatures(t, nil, features)
	a := testApp(t, address)
	host, _ := a.store.host("test-host")
	local := testForwardRule(t, "local", target)
	remote := testForwardRule(t, "remote", target)
	dynamic := testForwardRule(t, "dynamic", target)
	host.PortForwards = []PortForward{local, remote, dynamic}
	if err := a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	credentials := Credentials{Password: "session-only-secret"}
	if err := a.Connect("first", host.ID, credentials, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	if err := a.Connect("second", host.ID, credentials, fingerprint, TerminalSize{}); err != nil {
		t.Fatalf("additional terminal must share listeners: %v", err)
	}
	for _, rule := range []PortForward{local, remote} {
		t.Run(rule.Type, func(t *testing.T) {
			conn := testDialForward(t, rule)
			testForwardEcho(t, conn)
		})
	}
	for _, kind := range []byte{1, 3, 4} {
		t.Run(fmt.Sprintf("socks-address-%d", kind), func(t *testing.T) {
			destination := target
			if kind == 3 {
				destination = "remote-only.invalid:4321"
			}
			conn := testSOCKSConnect(t, dynamic, kind, destination)
			testForwardEcho(t, conn)
		})
	}
	foundRemoteDNS := false
	for len(destinations) > 0 {
		destination := <-destinations
		foundRemoteDNS = foundRemoteDNS || destination == "remote-only.invalid:4321"
	}
	if !foundRemoteDNS {
		t.Fatal("SOCKS domain was not forwarded to the SSH server")
	}
	if err := a.Disconnect("first"); err != nil {
		t.Fatal(err)
	}
	for _, rule := range []PortForward{local, remote} {
		testForwardEcho(t, testDialForward(t, rule))
	}
	live := testDialForward(t, local)
	testForwardEcho(t, live)
	if err := a.Disconnect("second"); err != nil {
		t.Fatal(err)
	}
	_ = live.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := live.Read(make([]byte, 1)); err == nil {
		t.Fatal("closing the final terminal left an active forwarding stream open")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("closing the final terminal did not close the active socket")
	}
	for _, rule := range []PortForward{local, remote, dynamic} {
		deadline := time.Now().Add(2 * time.Second)
		for {
			conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(rule.BindPort)), 100*time.Millisecond)
			if err != nil {
				break
			}
			conn.Close()
			if time.Now().After(deadline) {
				t.Fatalf("%s listener survived final disconnect", rule.Type)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
}

func TestPortForwardPreservesHalfClose(t *testing.T) {
	target := testTCPService(t, true)
	features, _ := testForwardFeatures(t, target)
	address, fingerprint := testSSHServerWithFeatures(t, nil, features)
	a := testApp(t, address)
	host, _ := a.store.host("test-host")
	for _, kind := range []string{"local", "remote", "dynamic"} {
		host.PortForwards = append(host.PortForwards, testForwardRule(t, kind, target))
	}
	if err := a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	if err := a.Connect("half-close", host.ID, Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	for _, rule := range host.PortForwards {
		t.Run(rule.Type, func(t *testing.T) {
			var conn net.Conn
			if rule.Type == "dynamic" {
				conn = testSOCKSConnect(t, rule, 1, target)
			} else {
				conn = testDialForward(t, rule)
			}
			_, _ = io.WriteString(conn, "request-complete")
			if err := conn.(*net.TCPConn).CloseWrite(); err != nil {
				t.Fatal(err)
			}
			response, err := io.ReadAll(conn)
			if err != nil || string(response) != "response:request-complete" {
				t.Fatalf("response after half-close: %q %v", response, err)
			}
		})
	}
}

func TestPortForwardStartFailureRollsBack(t *testing.T) {
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	host, _ := a.store.host("test-host")
	first := testForwardRule(t, "local", "127.0.0.1:1234")
	second := testForwardRule(t, "dynamic", "127.0.0.1:1234")
	second.BindPort = occupied.Addr().(*net.TCPAddr).Port
	host.PortForwards = []PortForward{first, second}
	if err = a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	if err = a.Connect("failure", host.ID, Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err == nil || !strings.Contains(err.Error(), "无法启动动态 SOCKS5转发") {
		t.Fatalf("expected occupied-port error: %v", err)
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(first.BindPort)))
	if err != nil {
		t.Fatalf("earlier rule leaked after startup failed: %v", err)
	}
	listener.Close()
	if len(a.forwards) != 0 || len(a.sessions) != 0 || len(a.pending) != 0 {
		t.Fatal("failed forwarding startup left an active connection")
	}
	host.PortForwards = []PortForward{testForwardRule(t, "remote", "127.0.0.1:1234")}
	if err = a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	if err = a.Connect("denied", host.ID, Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err == nil || !strings.Contains(err.Error(), "远程转发") {
		t.Fatalf("expected server forwarding rejection: %v", err)
	}
}

func TestPortForwardConcurrentTerminals(t *testing.T) {
	target := testTCPService(t, false)
	features, _ := testForwardFeatures(t, target)
	address, fingerprint := testSSHServerWithFeatures(t, nil, features)
	a := testApp(t, address)
	host, _ := a.store.host("test-host")
	credentials := Credentials{Password: "session-only-secret"}
	if err := a.Connect("before-enabled", host.ID, credentials, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	rule := testForwardRule(t, "local", target)
	host.PortForwards = []PortForward{rule}
	if err := a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	if err := a.Connect("must-restart", host.ID, credentials, fingerprint, TerminalSize{}); err == nil || !strings.Contains(err.Error(), "全部终端") {
		t.Fatalf("enabling rules while older terminals run must request a reconnect: %v", err)
	}
	_ = a.Disconnect("before-enabled")
	var wg sync.WaitGroup
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errors <- a.Connect(fmt.Sprintf("concurrent-%d", i), host.ID, Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{})
		}()
	}
	wg.Wait()
	for i := 0; i < 8; i++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	a.forwardMu.Lock()
	group := a.forwards[host.ID]
	refs := group.refs
	a.forwardMu.Unlock()
	if refs != 8 {
		t.Fatalf("forwarding references = %d, want 8", refs)
	}
	testForwardEcho(t, testDialForward(t, rule))
	host.PortForwards[0].BindPort = unusedTCPPort(t)
	if err := a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	if err := a.Connect("changed", host.ID, Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err == nil || !strings.Contains(err.Error(), "全部终端") {
		t.Fatalf("edited active rules did not request a reconnect: %v", err)
	}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = a.Disconnect(fmt.Sprintf("concurrent-%d", i)) }()
	}
	wg.Wait()
	// Rebinding the same port is unreliable on Windows because an earlier echo
	// connection may keep it in TIME_WAIT. Check the runtime itself instead:
	// every listener must have been closed and the group must be gone.
	a.forwardMu.Lock()
	leakedGroup := a.forwards[host.ID]
	a.forwardMu.Unlock()
	if leakedGroup != nil {
		t.Fatal("concurrent disconnect left an active forwarding group")
	}
	group.runtime.mu.Lock()
	closed := group.runtime.closed
	listeners := len(group.runtime.listeners)
	group.runtime.mu.Unlock()
	if !closed || listeners != 0 {
		t.Fatalf("concurrent disconnect leaked listener: closed=%v listeners=%d", closed, listeners)
	}
}

func TestPortForwardCancellationDuringStartup(t *testing.T) {
	requested := make(chan struct{}, 1)
	features := &testSSHFeatures{request: func(_ *ssh.ServerConn, request *ssh.Request) bool {
		if request.Type != "tcpip-forward" {
			return false
		}
		requested <- struct{}{}
		return true // Intentionally do not reply; cancellation must release Listen.
	}}
	address, fingerprint := testSSHServerWithFeatures(t, nil, features)
	a := testApp(t, address)
	host, _ := a.store.host("test-host")
	local := testForwardRule(t, "local", "127.0.0.1:1234")
	host.PortForwards = []PortForward{local, testForwardRule(t, "remote", "127.0.0.1:1234")}
	if err := a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		result <- a.Connect("cancel-forward", host.ID, Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{})
	}()
	select {
	case <-requested:
	case <-time.After(3 * time.Second):
		t.Fatal("forwarding request never started")
	}
	_ = a.Disconnect("cancel-forward")
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancelled startup succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation left SSH Listen blocked")
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(local.BindPort)))
	if err != nil {
		t.Fatalf("cancelled startup leaked listener: %v", err)
	}
	listener.Close()
}

func TestSOCKSRejectsUnsupportedRequests(t *testing.T) {
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	host, _ := a.store.host("test-host")
	rule := testForwardRule(t, "dynamic", "127.0.0.1:1234")
	host.PortForwards = []PortForward{rule}
	if err := a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	if err := a.Connect("socks", host.ID, Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	t.Run("no-compatible-auth", func(t *testing.T) {
		conn := testDialForward(t, rule)
		_, _ = conn.Write([]byte{5, 1, 2})
		var response [2]byte
		if _, err := io.ReadFull(conn, response[:]); err != nil || response != [2]byte{5, 255} {
			t.Fatalf("authentication negotiation accepted unsupported method: %v %v", response, err)
		}
	})
	for _, command := range []byte{2, 3} {
		t.Run(fmt.Sprintf("command-%d", command), func(t *testing.T) {
			conn := testDialForward(t, rule)
			_, _ = conn.Write([]byte{5, 1, 0})
			var response [10]byte
			if _, err := io.ReadFull(conn, response[:2]); err != nil {
				t.Fatal(err)
			}
			_, _ = conn.Write([]byte{5, command, 0, 1})
			if _, err := io.ReadFull(conn, response[:]); err != nil || response[1] != 7 {
				t.Fatalf("unsupported SOCKS command accepted: %v %v", response, err)
			}
		})
	}
}

func TestTunnelingValidationAndPersistence(t *testing.T) {
	store, err := openStore(filepath.Join(t.TempDir(), "workspace.json"))
	if err != nil {
		t.Fatal(err)
	}
	host := Host{ID: "host", Name: "Server", Address: "::1", Port: 22, Username: "user", AuthType: "password",
		PortForwards: []PortForward{{ID: "rule", Type: "local", Enabled: true, BindPort: 8080, DestinationHost: "::1", DestinationPort: 3000}},
		X11:          X11Config{Enabled: true, Display: "[::1]:0.2", AuthFile: "local-cookie-file"}}
	if err = store.saveHost(host); err != nil {
		t.Fatal(err)
	}
	host.PortForwards[0].BindPort = 9999
	reopened, err := openStore(store.path)
	if err != nil {
		t.Fatal(err)
	}
	restored, _ := reopened.host(host.ID)
	if restored.PortForwards[0].BindPort != 8080 || restored.X11.Display != "[::1]:0.2" || !restored.X11.Enabled {
		t.Fatalf("settings did not round trip: %+v", restored)
	}
	clone, _ := reopened.host(host.ID)
	clone.PortForwards[0].BindPort = 7777
	if reopened.snapshot().Hosts[0].PortForwards[0].BindPort != 8080 {
		t.Fatal("mutating a host changed the stored forwarding rules")
	}
	rule := restored.PortForwards[0]
	for name, alter := range map[string]func(*PortForward){
		"type":                 func(r *PortForward) { r.Type = "invalid" },
		"listen-port":          func(r *PortForward) { r.BindPort = 65536 },
		"destination-port":     func(r *PortForward) { r.DestinationPort = 0 },
		"destination-protocol": func(r *PortForward) { r.DestinationHost = "https://example.com" },
		"listen-host":          func(r *PortForward) { r.BindAddress = "[::1]" },
		"remote-hostname":      func(r *PortForward) { r.Type = "remote"; r.BindAddress = "example.com" },
	} {
		t.Run(name, func(t *testing.T) {
			invalid := rule
			alter(&invalid)
			if err := validateTunneling([]PortForward{invalid}, X11Config{}); err == nil {
				t.Fatal("invalid rule accepted")
			}
		})
	}
	duplicate := rule
	duplicate.ID, duplicate.Type = "other", "dynamic"
	if err := validateTunneling([]PortForward{rule, duplicate}, X11Config{}); err == nil {
		t.Fatal("local and SOCKS listeners bound the same port")
	}
	duplicate.Type = "remote"
	if err := validateTunneling([]PortForward{rule, duplicate}, X11Config{}); err != nil {
		t.Fatalf("same numeric port on opposite hosts should be valid: %v", err)
	}
	if _, err := (&App{}).acquireForwarding(context.Background(), Host{ID: "none"}, nil); err != nil {
		t.Fatal(err)
	}
}
