package app

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/proxy"
	"orbitssh/src/platform"
)

func validateProxy(h Host) error {
	if h.ProxyType == "" {
		return nil
	}
	if h.ProxyType != "socks5" && h.ProxyType != "http" {
		return errors.New("不支持的连接代理类型")
	}
	if h.JumpHostID != "" {
		return errors.New("连接代理不能与跳板机同时使用")
	}
	if strings.TrimSpace(h.ProxyAddress) != h.ProxyAddress || h.ProxyAddress == "" || strings.ContainsAny(h.ProxyAddress, " \t\r\n/\\[]") {
		return errors.New("请输入有效的代理 IP 地址或域名")
	}
	if h.ProxyPort < 1 || h.ProxyPort > 65535 {
		return errors.New("代理端口应在 1–65535 之间")
	}
	return nil
}

type platformProxyDialer struct{}

func (platformProxyDialer) Dial(_, address string) (net.Conn, error) {
	return platform.DialSSH(context.Background(), address)
}
func (platformProxyDialer) DialContext(ctx context.Context, _, address string) (net.Conn, error) {
	return platform.DialSSH(ctx, address)
}

func dialSSHProxy(ctx context.Context, host Host, target string) (net.Conn, error) {
	if err := validateProxy(host); err != nil {
		return nil, err
	}
	proxyAddress := net.JoinHostPort(host.ProxyAddress, strconv.Itoa(host.ProxyPort))
	if host.ProxyType == "socks5" {
		dialer, err := proxy.SOCKS5("tcp", proxyAddress, nil, platformProxyDialer{})
		if err != nil {
			return nil, fmt.Errorf("SOCKS5 代理配置失败：%w", err)
		}
		conn, err := dialer.(proxy.ContextDialer).DialContext(ctx, "tcp", target)
		if err != nil {
			return nil, fmt.Errorf("SOCKS5 代理 %s 连接失败：%w", proxyAddress, err)
		}
		return conn, nil
	}
	conn, err := platform.DialSSH(ctx, proxyAddress)
	if err != nil {
		return nil, fmt.Errorf("无法连接 HTTP 代理 %s：%w", proxyAddress, err)
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if _, err = fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target); err != nil {
		conn.Close()
		return nil, fmt.Errorf("HTTP 代理请求失败：%w", err)
	}
	reader := bufio.NewReader(io.LimitReader(conn, 64*1024))
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("HTTP 代理响应无效：%w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		conn.Close()
		return nil, fmt.Errorf("HTTP 代理拒绝连接：%s", response.Status)
	}
	if ctx.Err() != nil {
		conn.Close()
		return nil, ctx.Err()
	}
	_ = conn.SetDeadline(time.Time{})
	return &proxyBufferedConn{Conn: conn, reader: reader}, nil
}

// A proxy can send the start of the SSH banner with its CONNECT response.
type proxyBufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *proxyBufferedConn) Read(p []byte) (int, error) {
	if c.reader.Buffered() > 0 {
		return c.reader.Read(p)
	}
	return c.Conn.Read(p)
}
