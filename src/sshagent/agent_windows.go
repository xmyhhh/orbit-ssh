//go:build windows && !android && !androidtest

package sshagent

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// Windows OpenSSH keeps its agent on a named pipe. SSH_AUTH_SOCK may point at
// either a named pipe or an AF_UNIX socket depending on the client that set it.
const windowsOpenSSHAgentPipe = `\\.\pipe\openssh-ssh-agent`

func Open() (io.ReadWriter, func(), error) {
	candidates := []string{}
	if socket := strings.TrimSpace(os.Getenv("SSH_AUTH_SOCK")); socket != "" {
		candidates = append(candidates, socket)
	}
	candidates = append(candidates, windowsOpenSSHAgentPipe)
	var lastErr error
	for _, path := range candidates {
		file, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			lastErr = err
			continue
		}
		return file, func() { _ = file.Close() }, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("未找到 SSH Agent")
	}
	return nil, func() {}, fmt.Errorf("无法连接本机 SSH Agent（请启动 Windows OpenSSH Authentication Agent 服务）：%w", lastErr)
}
