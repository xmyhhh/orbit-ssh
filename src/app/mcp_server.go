package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"
)

type MCPStatus struct {
	Enabled          bool   `json:"enabled"`
	Running          bool   `json:"running"`
	AllowInput       bool   `json:"allowInput"`
	AllowConnections bool   `json:"allowConnections"`
	AllowFileAccess  bool   `json:"allowFileAccess"`
	Endpoint         string `json:"endpoint"`
	Token            string `json:"token"`
	Error            string `json:"error"`
	HistoryError     string `json:"historyError"`
}

func (a *App) configureMCP(preferences Preferences) error {
	a.mcpMu.Lock()
	if !preferences.MCPEnabled {
		server := a.mcpServer
		a.mcpServer = nil
		a.mcpListener = nil
		a.mcpPort = 0
		a.mcpError = ""
		a.mcpMu.Unlock()
		shutdownMCPServer(server)
		return nil
	}
	if a.mcpToken == "" {
		message := a.mcpError
		if message == "" {
			message = "无法读取本机 MCP 令牌"
		}
		a.mcpMu.Unlock()
		return errors.New(message)
	}
	if a.mcpServer != nil && a.mcpPort == preferences.MCPPort {
		a.mcpError = ""
		a.mcpMu.Unlock()
		return nil
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(preferences.MCPPort)))
	if err != nil {
		message := fmt.Sprintf("无法监听 MCP 端口 %d：%v", preferences.MCPPort, err)
		a.mcpError = message
		a.mcpMu.Unlock()
		return errors.New(message)
	}
	server := &http.Server{
		Handler:           a.mcpHandler(a.mcpToken),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	old := a.mcpServer
	a.mcpServer = server
	a.mcpListener = listener
	a.mcpPort = preferences.MCPPort
	a.mcpError = ""
	a.mcpMu.Unlock()
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			a.mcpMu.Lock()
			if a.mcpServer == server {
				a.mcpError = serveErr.Error()
				a.mcpServer = nil
				a.mcpListener = nil
				a.mcpPort = 0
			}
			a.mcpMu.Unlock()
		}
	}()
	shutdownMCPServer(old)
	return nil
}

func shutdownMCPServer(server *http.Server) {
	if server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		_ = server.Close()
	}
}

func (a *App) stopMCP() {
	a.mcpMu.Lock()
	server := a.mcpServer
	a.mcpServer = nil
	a.mcpListener = nil
	a.mcpPort = 0
	a.mcpMu.Unlock()
	shutdownMCPServer(server)
}

func (a *App) GetMCPStatus() MCPStatus {
	status := MCPStatus{}
	if a.store != nil {
		preferences := a.store.snapshot().Preferences
		status.Enabled = preferences.MCPEnabled
		status.AllowInput = preferences.MCPAllowTerminalInput
		status.AllowConnections = preferences.MCPAllowConnections
		status.AllowFileAccess = preferences.MCPAllowFileAccess
		status.Endpoint = fmt.Sprintf("http://127.0.0.1:%d/mcp", preferences.MCPPort)
	}
	a.mcpMu.Lock()
	status.Running = a.mcpServer != nil
	if a.mcpError != "" {
		status.Error = a.mcpError
	} else if a.mcpToken == "" {
		status.Error = "无法初始化本机 MCP 令牌"
	}
	status.Token = a.mcpToken
	a.mcpMu.Unlock()
	a.historyMu.RLock()
	status.HistoryError = a.historyLoadError
	if a.historyStoreError != "" {
		status.HistoryError = a.historyStoreError
	}
	a.historyMu.RUnlock()
	return status
}
