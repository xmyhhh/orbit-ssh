//go:build !android && !androidtest

package app

import (
	"errors"

	"orbitssh/src/mcp"
)

// InstallMCP connects the MCP client with the given target to the local
// server of this application.
func (a *App) InstallMCP(target string) (mcp.Result, error) {
	client, err := mcp.Find(target)
	if err != nil {
		return mcp.Result{}, err
	}
	if err := a.ready(); err != nil {
		return mcp.Result{}, err
	}
	status := a.GetMCPStatus()
	if !status.Enabled || !status.Running || status.Token == "" {
		return mcp.Result{}, errors.New("请先启用本机 MCP 服务，并确认服务运行中")
	}
	path, err := client.ConfigPath("global")
	if err != nil {
		return mcp.Result{}, err
	}
	return client.Install(path, status.Endpoint, status.Token)
}

// InstallCodexMCP connects Codex to the local server of this application.
func (a *App) InstallCodexMCP() (mcp.Result, error) {
	return a.InstallMCP("codex")
}

// MCPConfigSnippet returns the configuration of the client with the given
// target, so the user can add it by hand.
func (a *App) MCPConfigSnippet(target string) (string, error) {
	client, err := mcp.Find(target)
	if err != nil {
		return "", err
	}
	if err := a.ready(); err != nil {
		return "", err
	}
	status := a.GetMCPStatus()
	if !status.Running || status.Token == "" {
		return "", errors.New("请先启用本机 MCP 服务，并确认服务运行中")
	}
	data, err := client.UpdateConfig(nil, status.Endpoint, status.Token)
	return string(data), err
}
