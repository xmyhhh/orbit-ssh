package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func testSSHServer(t *testing.T, keys ...ssh.PublicKey) (string, string) {
	return testSSHServerWithMonitor(t, nil, keys...)
}

type testMonitorResponse func(sample uint64) (stdout, stderr string, status uint32)

func testSSHServerWithMonitor(t *testing.T, monitor testMonitorResponse, keys ...ssh.PublicKey) (string, string) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{PasswordCallback: func(metadata ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		if metadata.User() == "tester" && string(password) == "session-only-secret" {
			return nil, nil
		}
		return nil, os.ErrPermission
	}}
	config.AddHostKey(signer)
	config.PublicKeyCallback = func(metadata ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		for _, accepted := range keys {
			if metadata.User() == "tester" && string(accepted.Marshal()) == string(key.Marshal()) {
				return nil, nil
			}
		}
		return nil, os.ErrPermission
	}
	var sampleCount atomic.Uint64
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	connections := []net.Conn{}
	t.Cleanup(func() {
		listener.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range connections {
			c.Close()
		}
	})
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			connections = append(connections, raw)
			mu.Unlock()
			go func() {
				_, channels, requests, err := ssh.NewServerConn(raw, config)
				if err != nil {
					raw.Close()
					return
				}
				go ssh.DiscardRequests(requests)
				for incoming := range channels {
					if incoming.ChannelType() != "session" {
						incoming.Reject(ssh.UnknownChannelType, "session only")
						continue
					}
					ch, reqs, err := incoming.Accept()
					if err != nil {
						continue
					}
					go func() {
						defer ch.Close()
						for req := range reqs {
							switch req.Type {
							case "pty-req", "window-change":
								req.Reply(true, nil)
							case "shell":
								req.Reply(true, nil)
								go func() { _, _ = io.Copy(ch, ch) }()
							case "exec":
								var payload struct{ Command string }
								if ssh.Unmarshal(req.Payload, &payload) != nil || payload.Command != monitorCommand {
									req.Reply(false, nil)
									continue
								}
								req.Reply(true, nil)
								value := sampleCount.Add(10)
								stdout := strings.Replace(monitorFixture, "cpu 100 0 50 800 50 0 0 0 10 0", "cpu "+strconv.FormatUint(100+value, 10)+" 0 50 800 50 0 0 0 10 0", 1)
								// Linux ps also reports the sampler's own shell command.
								stdout += "2500 tester Ss 0.0 0.1 1024 0 sh -c " + strings.ReplaceAll(monitorCommand, "\n", " ") + "\n"
								stderr, status := "", uint32(0)
								if monitor != nil {
									stdout, stderr, status = monitor(value)
								}
								_, _ = io.WriteString(ch, stdout)
								_, _ = io.WriteString(ch.Stderr(), stderr)
								ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
								return
							case "subsystem":
								var payload struct{ Name string }
								if ssh.Unmarshal(req.Payload, &payload) != nil || payload.Name != "sftp" {
									req.Reply(false, nil)
									continue
								}
								req.Reply(true, nil)
								server, e := sftp.NewServer(ch)
								if e == nil {
									_ = server.Serve()
									server.Close()
								}
								return
							default:
								req.Reply(false, nil)
							}
						}
					}()
				}
			}()
		}
	}()
	return listener.Addr().String(), ssh.FingerprintSHA256(signer.PublicKey())
}

func testApp(t *testing.T, address string) *App {
	t.Helper()
	store, err := openStore(filepath.Join(t.TempDir(), "workspace.json"))
	if err != nil {
		t.Fatal(err)
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := strconv.Atoi(port)
	if err = store.saveHost(Host{ID: "test-host", Name: "Test server", Address: host, Port: p, Username: "tester", AuthType: "password", Group: "Test", Color: "mint"}); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	a.ctx = context.Background()
	a.store = store
	t.Cleanup(func() { a.shutdown(context.Background()) })
	return a
}

func TestSSHTrustTerminalAndSFTP(t *testing.T) {
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	credentials := Credentials{Password: "session-only-secret"}
	err := a.Connect("untrusted", "test-host", credentials, "", TerminalSize{Cols: 80, Rows: 24})
	if err == nil || !strings.Contains(err.Error(), "HOST_KEY_UNKNOWN|"+fingerprint) {
		t.Fatalf("first connection must require trust: %v", err)
	}
	if len(a.store.snapshot().KnownHosts) != 0 {
		t.Fatal("unknown key was persisted without approval")
	}
	err = a.Connect("wrong-password", "test-host", Credentials{Password: "wrong"}, fingerprint, TerminalSize{})
	if err == nil {
		t.Fatal("invalid password was accepted")
	}
	if len(a.store.snapshot().KnownHosts) != 0 {
		t.Fatal("failed authentication persisted trust")
	}
	dataEvents := make(chan string, 20)
	a.emit = func(name string, args ...interface{}) {
		if name == "ssh:data:trusted" {
			dataEvents <- args[0].(string)
		}
	}
	if err = a.Connect("trusted", "test-host", credentials, fingerprint, TerminalSize{Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	if a.store.snapshot().KnownHosts[address] != fingerprint {
		t.Fatal("approved key was not persisted")
	}
	if err = a.ResizeTerminal("trusted", TerminalSize{Cols: 120, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	if err = a.WriteTerminal("trusted", "你好 orbit\r"); err != nil {
		t.Fatal(err)
	}
	output := ""
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for !strings.Contains(output, "你好 orbit") {
		select {
		case encoded := <-dataEvents:
			bytes, e := base64.StdEncoding.DecodeString(encoded)
			if e != nil {
				t.Fatal(e)
			}
			output += string(bytes)
		case <-timer.C:
			t.Fatalf("terminal output missing: %q", output)
		}
	}
	dir := t.TempDir()
	if err = os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	listing, err := a.ListDirectory("trusted", filepath.ToSlash(dir))
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Files) != 1 || listing.Files[0].Name != "hello.txt" || listing.Files[0].Size != 5 {
		t.Fatalf("unexpected SFTP listing: %+v", listing)
	}
	if err = a.MakeDirectory("trusted", listing.Path, "new-folder"); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(dir, "new-folder")); err != nil {
		t.Fatal(err)
	}
	client, err := a.sftpClient("trusted")
	if err != nil {
		t.Fatal(err)
	}
	localDir := t.TempDir()
	localSource := filepath.Join(localDir, "upload.bin")
	payload := []byte(strings.Repeat("你好 Orbit\n", 10000))
	if err = os.WriteFile(localSource, payload, 0600); err != nil {
		t.Fatal(err)
	}
	remoteTarget := listing.Path + "/upload.bin"
	if ok, e := a.uploadTo("trusted", client, localSource, remoteTarget); !ok || e != nil {
		t.Fatalf("upload failed: %v", e)
	}
	localTarget := filepath.Join(localDir, "download.bin")
	if ok, e := a.downloadTo("trusted", client, remoteTarget, localTarget); !ok || e != nil {
		t.Fatalf("download failed: %v", e)
	}
	downloaded, e := os.ReadFile(localTarget)
	if e != nil || string(downloaded) != string(payload) {
		t.Fatal("SFTP round trip changed file content")
	}
	if ok, e := a.uploadTo("trusted", client, localSource, remoteTarget); !ok || e != nil {
		t.Fatalf("confirmed overwrite failed: %v", e)
	}
	if err = a.MakeDirectory("trusted", listing.Path, "../escape"); err == nil {
		t.Fatal("directory traversal accepted")
	}
	data, err := os.ReadFile(a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), credentials.Password) {
		t.Fatal("password leaked into configuration")
	}
	if err = a.Disconnect("trusted"); err != nil {
		t.Fatal(err)
	}
	if err = a.WriteTerminal("trusted", "x"); err == nil {
		t.Fatal("disconnected terminal accepted input")
	}
}

func TestChangedHostKeyIsRejected(t *testing.T) {
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(private)
	actual := ssh.FingerprintSHA256(signer.PublicKey())
	err := hostKeyVerifier("SHA256:previous", actual)("localhost", &net.TCPAddr{}, signer.PublicKey())
	if err == nil || !strings.Contains(err.Error(), "HOST_KEY_CHANGED") {
		t.Fatal("changed known key must never be replaced by a new approval")
	}
}

func TestCancelPendingHandshake(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		c, e := listener.Accept()
		if e == nil {
			defer c.Close()
			_, _ = io.Copy(io.Discard, c)
		}
	}()
	a := testApp(t, listener.Addr().String())
	done := make(chan error, 1)
	go func() { done <- a.Connect("pending", "test-host", Credentials{Password: "unused"}, "", TerminalSize{}) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		a.mu.Lock()
		_, pending := a.pending["pending"]
		a.mu.Unlock()
		if pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("connection did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	_ = a.Disconnect("pending")
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("cancelled connection succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation did not release stalled SSH handshake")
	}
}

func TestStoreRoundTripAndValidation(t *testing.T) {
	file := filepath.Join(t.TempDir(), "config", "workspace.json")
	s, err := openStore(file)
	if err != nil {
		t.Fatal(err)
	}
	h := Host{ID: "id", Name: "Server", Address: "::1", Port: 22, Username: "root", AuthType: "key", KeyPath: "/test/key", Group: "Home"}
	if err = s.saveHost(h); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(file)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.snapshot().Hosts) != 1 {
		t.Fatal("host did not persist")
	}
	h.Port = 70000
	if err = s.saveHost(h); err == nil {
		t.Fatal("invalid port accepted")
	}
	copy := s.snapshot()
	copy.Hosts[0].Name = "changed"
	if s.snapshot().Hosts[0].Name == "changed" {
		t.Fatal("snapshot changed stored state")
	}
	if err = os.WriteFile(file, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = openStore(file); err == nil {
		t.Fatal("corrupt configuration was silently overwritten")
	}
	data, _ := os.ReadFile(file)
	if string(data) != "{broken" {
		t.Fatal("corrupt original was modified")
	}
}
