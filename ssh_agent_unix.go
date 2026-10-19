//go:build !windows && !android && !androidtest

package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"strings"
)

func openAgent() (io.ReadWriter, func(), error) {
	socket := strings.TrimSpace(os.Getenv("SSH_AUTH_SOCK"))
	if socket == "" {
		return nil, func() {}, fmt.Errorf("未设置 SSH_AUTH_SOCK，请先启动 SSH Agent")
	}
	conn, err := net.Dial("unix", socket)
	if err != nil {
		return nil, func() {}, fmt.Errorf("无法连接 SSH Agent：%w", err)
	}
	return conn, func() { _ = conn.Close() }, nil
}
