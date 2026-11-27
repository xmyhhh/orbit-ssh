package app

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testConnectionProxy(t *testing.T, kind, destination string) (string, <-chan string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	targets := make(chan string, 10)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				var target string
				if kind == "http" {
					request, err := http.ReadRequest(bufio.NewReader(conn))
					if err != nil || request.Method != http.MethodConnect {
						return
					}
					target = request.Host
				} else {
					greeting := make([]byte, 3)
					if _, err := io.ReadFull(conn, greeting); err != nil || string(greeting) != "\x05\x01\x00" {
						return
					}
					if _, err := conn.Write([]byte{5, 0}); err != nil {
						return
					}
					head := make([]byte, 5)
					if _, err := io.ReadFull(conn, head); err != nil || head[3] != 3 {
						return
					}
					name := make([]byte, int(head[4])+2)
					if _, err := io.ReadFull(conn, name); err != nil {
						return
					}
					target = net.JoinHostPort(string(name[:len(name)-2]), strconv.Itoa(int(name[len(name)-2])<<8|int(name[len(name)-1])))
				}
				targets <- target
				upstream, err := net.Dial("tcp", destination)
				if err != nil {
					return
				}
				defer upstream.Close()
				if kind == "http" {
					_, err = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
				} else {
					_, err = conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
				}
				if err != nil {
					return
				}
				_ = conn.SetDeadline(time.Time{})
				go func() { _, _ = io.Copy(upstream, conn); upstream.Close() }()
				_, _ = io.Copy(conn, upstream)
			}()
		}
	}()
	return listener.Addr().String(), targets
}

func TestSSHViaConnectionProxy(t *testing.T) {
	for _, kind := range []string{"socks5", "http"} {
		t.Run(kind, func(t *testing.T) {
			address, fingerprint := testSSHServer(t)
			proxyAddress, targets := testConnectionProxy(t, kind, address)
			proxyHost, proxyPortText, _ := net.SplitHostPort(proxyAddress)
			proxyPort, _ := strconv.Atoi(proxyPortText)
			a := testApp(t, address)
			host, _ := a.store.host("test-host")
			host.Address = "remote-only.invalid"
			host.ProxyType, host.ProxyAddress, host.ProxyPort = kind, proxyHost, proxyPort
			if err := a.SaveHost(host); err != nil {
				t.Fatal(err)
			}
			reopened, err := openStore(a.store.path)
			if err != nil {
				t.Fatal(err)
			}
			persisted, err := reopened.host(host.ID)
			if err != nil || persisted.ProxyType != kind || persisted.ProxyAddress != proxyHost || persisted.ProxyPort != proxyPort {
				t.Fatalf("proxy settings did not persist: %+v, %v", persisted, err)
			}
			credentials := Credentials{Password: "session-only-secret"}
			err = a.Connect("unknown", host.ID, credentials, "", TerminalSize{})
			if err == nil || !strings.Contains(err.Error(), "HOST_KEY_UNKNOWN|"+fingerprint) {
				t.Fatalf("expected fingerprint check: %v", err)
			}
			if err := a.Connect("trusted", host.ID, credentials, fingerprint, TerminalSize{}); err != nil {
				t.Fatal(err)
			}
			if _, err := a.sftpClient("trusted"); err != nil {
				t.Fatalf("SFTP through proxy: %v", err)
			}
			for i := 0; i < 2; i++ {
				select {
				case target := <-targets:
					if target != net.JoinHostPort(host.Address, strconv.Itoa(host.Port)) {
						t.Fatalf("target = %q", target)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("proxy not contacted")
				}
			}
		})
	}
}

func TestProxyValidationAndJumpExclusion(t *testing.T) {
	address, _ := testSSHServer(t)
	a := testApp(t, address)
	host, _ := a.store.host("test-host")
	proxyHost := host
	proxyHost.ID, proxyHost.Name = "proxy-host", "Proxy host"
	proxyHost.ProxyType, proxyHost.ProxyAddress, proxyHost.ProxyPort = "socks5", "127.0.0.1", 7890
	if err := a.SaveHost(proxyHost); err != nil {
		t.Fatal(err)
	}
	host.JumpHostID = proxyHost.ID
	if err := a.SaveHost(host); err == nil {
		t.Fatal("proxy host accepted as jump")
	}
	host.JumpHostID = ""
	host.ProxyType, host.ProxyAddress, host.ProxyPort = "http", "127.0.0.1", 7890
	host.JumpHostID = proxyHost.ID
	if err := a.SaveHost(host); err == nil {
		t.Fatal("proxy and jump accepted together")
	}
	host.JumpHostID = ""
	host.ProxyPort = 65536
	if err := a.SaveHost(host); err == nil {
		t.Fatal("invalid port accepted")
	}
	proxyHost.ProxyType = ""
	if err := a.SaveHost(proxyHost); err != nil {
		t.Fatal(err)
	}
	host.ProxyType = ""
	host.JumpHostID = proxyHost.ID
	if err := a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	proxyHost.ProxyType = "http"
	if err := a.SaveHost(proxyHost); err == nil {
		t.Fatal("proxy enabled on a jump host")
	}
}

func TestProxyCancellationAndHTTPBufferedData(t *testing.T) {
	for _, kind := range []string{"socks5", "http"} {
		t.Run(kind, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			go func() {
				conn, err := listener.Accept()
				if err == nil {
					defer conn.Close()
					_, _ = io.Copy(io.Discard, conn)
				}
			}()
			host, portText, _ := net.SplitHostPort(listener.Addr().String())
			port, _ := strconv.Atoi(portText)
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			_, err = dialSSHProxy(ctx, Host{ProxyType: kind, ProxyAddress: host, ProxyPort: port}, "example.invalid:22")
			if err == nil {
				t.Fatal("expected cancellation")
			}
		})
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			defer conn.Close()
			_, _ = http.ReadRequest(bufio.NewReader(conn))
			_, _ = fmt.Fprint(conn, "HTTP/1.1 200 OK\r\n\r\nSSH-2.0-test\r\n")
		}
	}()
	host, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	conn, err := dialSSHProxy(context.Background(), Host{ProxyType: "http", ProxyAddress: host, ProxyPort: port}, "example.invalid:22")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || line != "SSH-2.0-test\r\n" {
		t.Fatalf("buffered banner = %q, %v", line, err)
	}
}
