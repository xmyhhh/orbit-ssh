package app

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func testXSetup(order binary.ByteOrder, cookie []byte) []byte {
	setup := make([]byte, 12+paddedX11Size(len(x11AuthProtocol))+paddedX11Size(len(cookie)))
	setup[0] = 'l'
	if order == binary.BigEndian {
		setup[0] = 'B'
	}
	order.PutUint16(setup[2:4], 11)
	order.PutUint16(setup[6:8], uint16(len(x11AuthProtocol)))
	order.PutUint16(setup[8:10], uint16(len(cookie)))
	copy(setup[12:], x11AuthProtocol)
	copy(setup[12+paddedX11Size(len(x11AuthProtocol)):], cookie)
	return setup
}

func testXAuthorityRecord(family uint16, address []byte, number string, cookie []byte) []byte {
	data := binary.BigEndian.AppendUint16(nil, family)
	for _, field := range [][]byte{address, []byte(number), []byte(x11AuthProtocol), cookie} {
		data = binary.BigEndian.AppendUint16(data, uint16(len(field)))
		data = append(data, field...)
	}
	return data
}

func TestX11CookieReplacementAndValidation(t *testing.T) {
	fake := []byte("0123456789abcdef")
	real := []byte("fedcba9876543210")
	for _, order := range []binary.ByteOrder{binary.LittleEndian, binary.BigEndian} {
		t.Run(strconv.FormatBool(order == binary.BigEndian), func(t *testing.T) {
			packet := testXSetup(order, fake)
			reader := bytes.NewReader(append(packet, []byte("following-X11-data")...))
			rewritten, err := rewriteX11Setup(reader, fake, real)
			if err != nil || !bytes.Equal(rewritten, testXSetup(order, real)) || reader.Len() != len("following-X11-data") {
				t.Fatalf("cookie replacement or stream boundary incorrect: %v", err)
			}
			if bytes.Contains(rewritten, fake) {
				t.Fatal("fake cookie was forwarded to the local server")
			}
			withoutAuth, err := rewriteX11Setup(bytes.NewReader(packet), fake, nil)
			if err != nil || len(withoutAuth) != 12 || order.Uint16(withoutAuth[6:8]) != 0 || order.Uint16(withoutAuth[8:10]) != 0 {
				t.Fatal("X Server without a cookie received auth data")
			}
			for name, mutate := range map[string]func([]byte) []byte{
				"wrong-cookie":   func(p []byte) []byte { p[len(p)-1] ^= 1; return p },
				"wrong-protocol": func(p []byte) []byte { p[12] = 'x'; return p },
				"invalid-endian": func(p []byte) []byte { p[0] = 'x'; return p },
				"oversize-auth":  func(p []byte) []byte { order.PutUint16(p[8:10], 65535); return p },
				"short-header":   func(p []byte) []byte { return p[:4] },
				"short-body":     func(p []byte) []byte { return p[:len(p)-1] },
			} {
				t.Run(name, func(t *testing.T) {
					invalid := mutate(append([]byte(nil), packet...))
					if _, err := rewriteX11Setup(bytes.NewReader(invalid), fake, real); err == nil {
						t.Fatal("invalid X11 authentication accepted")
					}
				})
			}
		})
	}
}

func TestXDisplayAndAuthority(t *testing.T) {
	for _, value := range []string{"", "localhost:0.0", ":0", "unix:1.2", "[::1]:2.3", "127.0.0.1:59535.0"} {
		if _, err := parseXDisplay(value); err != nil {
			t.Fatalf("valid DISPLAY %q rejected: %v", value, err)
		}
	}
	for _, value := range []string{"localhost", "localhost:59536", "localhost:-1", "localhost:0.-1", "localhost:0.0.0", "tcp://localhost:0", "localhost:0\n"} {
		if _, err := parseXDisplay(value); err == nil {
			t.Fatalf("invalid DISPLAY %q accepted", value)
		}
	}
	display, _ := parseXDisplay("localhost:1.0")
	correct := []byte("correct-cookie!!")
	wrong := []byte("wrong-cookie!!!!")
	localName, _ := os.Hostname()
	data := testXAuthorityRecord(256, []byte(localName), "0", wrong)
	data = append(data, testXAuthorityRecord(0, []byte{10, 20, 30, 40}, "1", wrong)...)
	data = append(data, testXAuthorityRecord(65535, nil, "1", wrong)...)
	data = append(data, testXAuthorityRecord(256, []byte(localName), "1", correct)...)
	cookie, err := xAuthorityCookie(data, display)
	if err != nil || !bytes.Equal(cookie, correct) {
		t.Fatalf("wrong authority selected: %q %v", cookie, err)
	}
	if _, err := xAuthorityCookie(data[:len(data)-1], display); err == nil {
		t.Fatal("truncated authority accepted")
	}
	file := filepath.Join(t.TempDir(), ".Xauthority")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if cookie, err := readXAuthority(X11Config{AuthFile: file}, display); err != nil || !bytes.Equal(cookie, correct) {
		t.Fatalf("authority file failed: %v", err)
	}
	display.number = "99"
	if _, err := readXAuthority(X11Config{AuthFile: file}, display); err == nil {
		t.Fatal("explicit authority without matching cookie accepted")
	}
	if _, err := readXAuthority(X11Config{AuthFile: file + ".missing"}, display); err == nil {
		t.Fatal("missing explicit authority silently ignored")
	}
}

func TestX11ForwardingEndToEnd(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	if port < 6000 {
		t.Skip("ephemeral port cannot be represented by DISPLAY")
	}
	number := strconv.Itoa(port - 6000)
	real := []byte("local-X11-cookie")
	filename := filepath.Join(t.TempDir(), ".Xauthority")
	if err = os.WriteFile(filename, testXAuthorityRecord(0, []byte{127, 0, 0, 1}, number, real), 0600); err != nil {
		t.Fatal(err)
	}
	var accepted atomic.Int32
	localResult := make(chan error, 1)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
				setup := make([]byte, len(testXSetup(binary.LittleEndian, real)))
				_, err := io.ReadFull(conn, setup)
				if err == nil && !bytes.Equal(setup, testXSetup(binary.LittleEndian, real)) {
					err = os.ErrPermission
				}
				payload := make([]byte, len("draw-window"))
				if err == nil {
					_, err = io.ReadFull(conn, payload)
				}
				if err == nil && string(payload) != "draw-window" {
					err = io.ErrUnexpectedEOF
				}
				if err == nil {
					_, err = io.WriteString(conn, "X11-response")
				}
				localResult <- err
			}()
		}
	}()
	type xRequest struct {
		Single   bool
		Protocol string
		Cookie   string
		Screen   uint32
	}
	type observed struct {
		request xRequest
		conn    *ssh.ServerConn
	}
	requests := make(chan observed, 1)
	features := &testSSHFeatures{session: func(conn *ssh.ServerConn, _ ssh.Channel, req *ssh.Request) bool {
		if req.Type != "x11-req" {
			return false
		}
		var payload xRequest
		if ssh.Unmarshal(req.Payload, &payload) != nil {
			req.Reply(false, nil)
			return true
		}
		requests <- observed{payload, conn}
		req.Reply(true, nil)
		return true
	}}
	address, fingerprint := testSSHServerWithFeatures(t, nil, features)
	a := testApp(t, address)
	host, _ := a.store.host("test-host")
	host.X11 = X11Config{Enabled: true, Display: "127.0.0.1:" + number + ".2", AuthFile: filename}
	if err = a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	if err = a.Connect("x11", host.ID, Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	observedRequest := <-requests
	fake, err := hex.DecodeString(observedRequest.request.Cookie)
	if err != nil || len(fake) != 16 || bytes.Equal(fake, real) || observedRequest.request.Protocol != x11AuthProtocol || observedRequest.request.Screen != 2 || observedRequest.request.Single {
		t.Fatalf("invalid or leaked X11 request: %+v", observedRequest.request)
	}
	openChannel := func() ssh.Channel {
		payload := struct {
			Address string
			Port    uint32
		}{"127.0.0.1", 12345}
		channel, reqs, err := observedRequest.conn.OpenChannel("x11", ssh.Marshal(payload))
		if err != nil {
			t.Fatal(err)
		}
		go ssh.DiscardRequests(reqs)
		t.Cleanup(func() { channel.Close() })
		return channel
	}
	channel := openChannel()
	_, _ = channel.Write(append(testXSetup(binary.LittleEndian, fake), []byte("draw-window")...))
	response := make([]byte, len("X11-response"))
	result := make(chan error, 1)
	go func() { _, err := io.ReadFull(channel, response); result <- err }()
	select {
	case err := <-result:
		if err != nil || string(response) != "X11-response" {
			t.Fatalf("X11 roundtrip failed: %q %v", response, err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("X11 forwarding stalled")
	}
	if err := <-localResult; err != nil {
		t.Fatalf("local X Server received invalid auth/data: %v", err)
	}
	badChannel := openChannel()
	fake[0] ^= 1
	_, _ = badChannel.Write(testXSetup(binary.LittleEndian, fake))
	go func() { _, err := io.Copy(io.Discard, badChannel); result <- err }()
	select {
	case <-result:
	case <-time.After(2 * time.Second):
		t.Fatal("X11 channel with a wrong cookie was not closed")
	}
	if accepted.Load() != 1 {
		t.Fatal("unauthenticated X11 connection reached the local X Server")
	}
	stored, _ := os.ReadFile(a.store.path)
	if bytes.Contains(stored, real) || bytes.Contains(stored, []byte(hex.EncodeToString(real))) || bytes.Contains(stored, []byte(observedRequest.request.Cookie)) {
		t.Fatal("X11 cookie leaked into workspace settings")
	}
}

func TestX11ServerRejectionIsClear(t *testing.T) {
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	filename := filepath.Join(t.TempDir(), ".Xauthority")
	if err := os.WriteFile(filename, testXAuthorityRecord(65535, nil, "0", []byte("local-X11-cookie")), 0600); err != nil {
		t.Fatal(err)
	}
	host, _ := a.store.host("test-host")
	host.X11 = X11Config{Enabled: true, Display: "localhost:0.0", AuthFile: filename}
	if err := a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	err := a.Connect("denied-x11", host.ID, Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{})
	if err == nil || !strings.Contains(err.Error(), "服务器拒绝 X11 转发") {
		t.Fatalf("X11 rejection not reported: %v", err)
	}
}
