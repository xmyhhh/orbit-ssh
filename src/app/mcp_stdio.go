//go:build !android && !androidtest

package app

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"orbitssh/src/mcp"
	"orbitssh/src/platform"
)

func runMCPStdioCommand(args []string, input io.Reader, output io.Writer) (bool, error) {
	if len(args) == 0 || args[0] != "mcp-stdio" {
		return false, nil
	}
	if len(args) != 1 {
		return true, errors.New("mcp-stdio 不接受位置参数")
	}
	directory, err := platform.ConfigDirectory()
	if err != nil {
		return true, err
	}
	directory = filepath.Join(directory, "OrbitSSH")
	store, err := openStore(filepath.Join(directory, "workspace.json"))
	if err != nil {
		return true, err
	}
	preferences := store.snapshot().Preferences
	if !preferences.MCPEnabled {
		return true, errors.New("请先在 Orbit SSH 中启用本机 MCP 服务")
	}
	token, err := mcp.LoadOrCreateToken(filepath.Join(directory, "mcp-token"))
	if err != nil {
		return true, err
	}
	endpoint := "http://127.0.0.1:" + strconv.Itoa(preferences.MCPPort) + "/mcp"
	return true, proxyMCPStdio(input, output, endpoint, token, newMCPStdioHTTPClient())
}

func newMCPStdioHTTPClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:       nil,
			DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		},
		Timeout: 3 * time.Minute,
	}
}

func proxyMCPStdio(input io.Reader, output io.Writer, endpoint, token string, client *http.Client) error {
	reader := bufio.NewReaderSize(input, 32*1024)
	for {
		message, err := readMCPStdioMessage(reader)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if len(message) == 0 {
			continue
		}
		request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(message))
		if err != nil {
			return err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		response, err := client.Do(request)
		if err != nil {
			return fmt.Errorf("无法连接 Orbit SSH MCP 服务：%w", err)
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, mcpRequestLimit+1))
		closeErr := response.Body.Close()
		if readErr != nil {
			return fmt.Errorf("无法读取 Orbit SSH MCP 响应：%w", readErr)
		}
		if closeErr != nil {
			return fmt.Errorf("无法关闭 Orbit SSH MCP 响应：%w", closeErr)
		}
		if len(body) > mcpRequestLimit {
			return errors.New("Orbit SSH MCP 响应超过大小限制")
		}
		if response.StatusCode == http.StatusAccepted {
			continue
		}
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("Orbit SSH MCP 服务返回 HTTP %d", response.StatusCode)
		}
		if len(body) == 0 || body[len(body)-1] != '\n' {
			body = append(body, '\n')
		}
		if _, err = output.Write(body); err != nil {
			return fmt.Errorf("无法写入 MCP 响应：%w", err)
		}
	}
}

func readMCPStdioMessage(reader *bufio.Reader) ([]byte, error) {
	message := make([]byte, 0, 1024)
	for {
		part, err := reader.ReadSlice('\n')
		if len(message)+len(part) > mcpRequestLimit {
			return nil, errors.New("MCP 请求超过大小限制")
		}
		message = append(message, part...)
		if err == nil {
			return bytes.TrimSpace(message), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) && len(message) > 0 {
			return bytes.TrimSpace(message), nil
		}
		return nil, err
	}
}
