package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const x11AuthProtocol = "MIT-MAGIC-COOKIE-1"

type xDisplay struct {
	network string
	address string
	host    string
	number  string
	screen  uint32
}

func parseXDisplay(value string) (xDisplay, error) {
	if value == "" {
		value = "localhost:0.0"
	}
	invalid := errors.New("X DISPLAY 格式应为 localhost:0.0、:0 或 [::1]:0.0")
	separator := strings.LastIndex(value, ":")
	if separator < 0 || strings.ContainsAny(value, " \t\r\n\x00") {
		return xDisplay{}, invalid
	}
	host, suffix := value[:separator], value[separator+1:]
	parts := strings.Split(suffix, ".")
	if len(parts) > 2 || len(parts) == 0 {
		return xDisplay{}, invalid
	}
	number, err := strconv.Atoi(parts[0])
	if err != nil || number < 0 || number > 59535 {
		return xDisplay{}, invalid
	}
	var screen uint64
	if len(parts) == 2 {
		screen, err = strconv.ParseUint(parts[1], 10, 32)
		if err != nil {
			return xDisplay{}, invalid
		}
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	if host != "" && host != "unix" && !validForwardHost(host) {
		return xDisplay{}, invalid
	}
	display := xDisplay{network: "tcp", host: host, number: strconv.Itoa(number), screen: uint32(screen)}
	if host == "" || host == "unix" {
		if runtime.GOOS != "windows" {
			display.network = "unix"
			display.address = "/tmp/.X11-unix/X" + display.number
			return display, nil
		}
		host = "127.0.0.1"
	}
	display.address = net.JoinHostPort(host, strconv.Itoa(6000+number))
	return display, nil
}

func readXAuthority(config X11Config, display xDisplay) ([]byte, error) {
	filename := config.AuthFile
	explicit := filename != ""
	if filename == "" {
		filename = os.Getenv("XAUTHORITY")
		explicit = filename != ""
	}
	if filename == "" {
		homeDir, err := os.UserHomeDir()
		if err == nil {
			filename = filepath.Join(homeDir, ".Xauthority")
		}
	}
	if filename == "" {
		return nil, nil
	}
	file, err := os.Open(filename)
	if errors.Is(err, os.ErrNotExist) && !explicit {
		return nil, nil // Some Windows X Servers use access control without a cookie.
	}
	if err != nil {
		return nil, fmt.Errorf("无法读取 Xauthority：%w", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 {
		return nil, errors.New("Xauthority 文件无法读取或超过 1 MB")
	}
	cookie, err := xAuthorityCookie(data, display)
	if err != nil {
		return nil, err
	}
	if len(cookie) == 0 && explicit {
		return nil, errors.New("Xauthority 中没有与此 DISPLAY 匹配的 MIT-MAGIC-COOKIE-1 记录")
	}
	return cookie, nil
}

func xAuthorityCookie(data []byte, display xDisplay) ([]byte, error) {
	reader := bytes.NewReader(data)
	readField := func() ([]byte, error) {
		var size uint16
		if err := binary.Read(reader, binary.BigEndian, &size); err != nil {
			return nil, err
		}
		value := make([]byte, int(size))
		_, err := io.ReadFull(reader, value)
		return value, err
	}
	localName, _ := os.Hostname()
	local := display.host == "" || display.host == "unix" || strings.EqualFold(display.host, "localhost") || strings.EqualFold(display.host, localName)
	if ip := net.ParseIP(display.host); ip != nil && ip.IsLoopback() {
		local = true
	}
	var addresses []net.IP
	if display.network == "tcp" && !local {
		addresses, _ = net.LookupIP(display.host)
	}
	var cookie []byte
	bestScore := -1
	for reader.Len() > 0 {
		var family uint16
		if err := binary.Read(reader, binary.BigEndian, &family); err != nil {
			return nil, errors.New("Xauthority 文件格式不完整")
		}
		fields := make([][]byte, 4)
		for i := range fields {
			var err error
			fields[i], err = readField()
			if err != nil {
				return nil, errors.New("Xauthority 文件格式不完整")
			}
		}
		address, number, protocol, auth := fields[0], fields[1], fields[2], fields[3]
		if string(number) != display.number || string(protocol) != x11AuthProtocol || len(auth) != 16 {
			continue
		}
		score := -1
		switch family {
		case 65535: // FamilyWild
			score = 0
		case 256: // FamilyLocal
			if local && (len(address) == 0 || strings.EqualFold(string(address), localName) || strings.EqualFold(string(address), "localhost")) {
				score = 2
			}
		case 0, 6: // FamilyInternet / FamilyInternet6
			ip := net.IP(address)
			if (family == 0 && len(ip) != net.IPv4len) || (family == 6 && len(ip) != net.IPv6len) {
				continue
			}
			if local && ip.IsLoopback() {
				score = 1
			}
			for _, candidate := range addresses {
				if candidate.Equal(ip) {
					score = 2
				}
			}
		}
		if score > bestScore {
			bestScore, cookie = score, append([]byte(nil), auth...)
		}
	}
	return cookie, nil
}

type x11Forwarding struct {
	runtime *forwardingRuntime
	display xDisplay
	fake    []byte
	real    []byte
}

func prepareX11(client *ssh.Client, config X11Config, notice func(string)) (*x11Forwarding, error) {
	display, err := parseXDisplay(config.Display)
	if err != nil {
		return nil, err
	}
	real, err := readXAuthority(config, display)
	if err != nil {
		return nil, err
	}
	fake := make([]byte, 16)
	if _, err = rand.Read(fake); err != nil {
		return nil, fmt.Errorf("无法生成 X11 认证信息：%w", err)
	}
	x := &x11Forwarding{runtime: newForwardingRuntime(notice), display: display, fake: fake, real: real}
	channels := client.HandleChannelOpen("x11")
	if channels == nil {
		x.runtime.close()
		return nil, errors.New("此 SSH 连接已启用 X11 转发")
	}
	go func() {
		for {
			select {
			case <-x.runtime.ctx.Done():
				return
			case incoming, ok := <-channels:
				if !ok {
					return
				}
				var origin struct {
					Address string
					Port    uint32
				}
				if ssh.Unmarshal(incoming.ExtraData(), &origin) != nil || x.runtime.ctx.Err() != nil {
					incoming.Reject(ssh.Prohibited, "invalid X11 channel")
					continue
				}
				channel, requests, err := incoming.Accept()
				if err != nil {
					continue
				}
				go ssh.DiscardRequests(requests)
				if x.runtime.track(channel) {
					go x.serve(channel)
				}
			}
		}
	}()
	return x, nil
}

func (x *x11Forwarding) request(shell *ssh.Session) error {
	payload := struct {
		SingleConnection bool
		AuthProtocol     string
		AuthCookie       string
		ScreenNumber     uint32
	}{false, x11AuthProtocol, hex.EncodeToString(x.fake), x.display.screen}
	accepted, err := shell.SendRequest("x11-req", true, ssh.Marshal(payload))
	if err != nil {
		return fmt.Errorf("无法请求 X11 转发：%w", err)
	}
	if !accepted {
		return errors.New("服务器拒绝 X11 转发，请检查 sshd 的 X11Forwarding 配置以及远程 xauth 是否已安装")
	}
	return nil
}

func (x *x11Forwarding) serve(channel ssh.Channel) {
	defer x.runtime.release(channel)
	timer := time.AfterFunc(15*time.Second, func() { channel.Close() })
	defer timer.Stop()
	setup, err := rewriteX11Setup(channel, x.fake, x.real)
	if err != nil {
		x.runtime.report("X11 连接认证失败：" + err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(x.runtime.ctx, 15*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, x.display.network, x.display.address)
	if err != nil {
		x.runtime.report(fmt.Sprintf("无法连接本机 X Server %s，请确认 X Server 已启动：%v", x.display.address, err))
		return
	}
	if !x.runtime.track(conn) {
		return
	}
	defer x.runtime.release(conn)
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err = conn.Write(setup); err != nil {
		x.runtime.report("无法发送 X11 认证请求：" + err.Error())
		return
	}
	if !timer.Stop() {
		return
	}
	_ = conn.SetDeadline(time.Time{})
	relayStreams(channel, conn)
}

func paddedX11Size(size int) int { return (size + 3) &^ 3 }

// The server sees a random, per-connection cookie. Verify it before dialing the
// local X Server, then replace it with that server's actual cookie locally.
func rewriteX11Setup(reader io.Reader, fake, real []byte) ([]byte, error) {
	header := make([]byte, 12)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, errors.New("X11 握手不完整")
	}
	var order binary.ByteOrder
	switch header[0] {
	case 'l':
		order = binary.LittleEndian
	case 'B':
		order = binary.BigEndian
	default:
		return nil, errors.New("无效的 X11 字节序")
	}
	nameSize, authSize := int(order.Uint16(header[6:8])), int(order.Uint16(header[8:10]))
	if order.Uint16(header[2:4]) != 11 || nameSize != len(x11AuthProtocol) || authSize != len(fake) || len(fake) != 16 {
		return nil, errors.New("无效的 X11 认证请求")
	}
	body := make([]byte, paddedX11Size(nameSize)+paddedX11Size(authSize))
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil, errors.New("X11 认证数据不完整")
	}
	if string(body[:nameSize]) != x11AuthProtocol || subtle.ConstantTimeCompare(body[paddedX11Size(nameSize):paddedX11Size(nameSize)+authSize], fake) != 1 {
		return nil, errors.New("X11 认证 cookie 不匹配")
	}
	protocol := ""
	if len(real) != 0 {
		protocol = x11AuthProtocol
	}
	order.PutUint16(header[6:8], uint16(len(protocol)))
	order.PutUint16(header[8:10], uint16(len(real)))
	setup := make([]byte, 12+paddedX11Size(len(protocol))+paddedX11Size(len(real)))
	copy(setup, header)
	copy(setup[12:], protocol)
	copy(setup[12+paddedX11Size(len(protocol)):], real)
	return setup, nil
}
