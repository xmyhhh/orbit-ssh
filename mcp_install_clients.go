//go:build !android && !androidtest

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type mcpClient struct {
	target, name, namespace string
}

var mcpClients = []mcpClient{
	{"codex", "Codex", "mcp_servers"},
	{"claude", "Claude Code", "mcpServers"},
	{"cursor", "Cursor", "mcpServers"},
	{"opencode", "OpenCode", "mcp"},
	{"gemini", "Gemini CLI", "mcpServers"},
	{"vscode", "VS Code Copilot", "servers"},
}

func findMCPClient(target string) (mcpClient, error) {
	target = strings.ToLower(strings.TrimSpace(target))
	switch target {
	case "claude-code":
		target = "claude"
	case "gemini-cli":
		target = "gemini"
	case "copilot-vscode":
		target = "vscode"
	}
	for _, client := range mcpClients {
		if client.target == target {
			return client, nil
		}
	}
	return mcpClient{}, errors.New("MCP 客户端只支持 codex、claude、cursor、opencode、gemini 或 vscode")
}

func selectMCPClients(targets string) ([]mcpClient, error) {
	var selected []mcpClient
	seen := map[string]bool{}
	for _, target := range strings.Split(targets, ",") {
		var clients []mcpClient
		if strings.EqualFold(strings.TrimSpace(target), "all") {
			clients = mcpClients
		} else {
			client, err := findMCPClient(target)
			if err != nil {
				return nil, err
			}
			clients = []mcpClient{client}
		}
		for _, client := range clients {
			if !seen[client.target] {
				selected = append(selected, client)
				seen[client.target] = true
			}
		}
	}
	return selected, nil
}

func codexMCPConfigPath(location string) (string, error) {
	return mcpClients[0].configPath(location)
}

func (client mcpClient) configPath(location string) (string, error) {
	if location != "global" && location != "local" {
		return "", errors.New("安装位置只支持 global 或 local")
	}
	if location == "local" {
		var path string
		switch client.target {
		case "codex":
			path = filepath.Join(".codex", "config.toml")
		case "claude":
			path = ".mcp.json"
		case "cursor":
			path = filepath.Join(".cursor", "mcp.json")
		case "opencode":
			return preferredMCPJSONPath(".", "opencode")
		case "gemini":
			path = filepath.Join(".gemini", "settings.json")
		case "vscode":
			path = filepath.Join(".vscode", "mcp.json")
		}
		return filepath.Abs(path)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	var path string
	switch client.target {
	case "codex":
		root := os.Getenv("CODEX_HOME")
		if root == "" {
			root = filepath.Join(home, ".codex")
		}
		path = filepath.Join(root, "config.toml")
	case "claude":
		if root := os.Getenv("CLAUDE_CONFIG_DIR"); root != "" {
			path = filepath.Join(root, ".claude.json")
		} else {
			path = filepath.Join(home, ".claude.json")
		}
	case "cursor":
		path = filepath.Join(home, ".cursor", "mcp.json")
	case "opencode":
		if override := os.Getenv("OPENCODE_CONFIG"); override != "" {
			return filepath.Abs(override)
		}
		root := os.Getenv("OPENCODE_CONFIG_DIR")
		if root == "" {
			root = os.Getenv("XDG_CONFIG_HOME")
			if root == "" {
				root = filepath.Join(home, ".config")
			}
			root = filepath.Join(root, "opencode")
		}
		return preferredMCPJSONPath(root, "opencode")
	case "gemini":
		path = filepath.Join(home, ".gemini", "settings.json")
	case "vscode":
		root, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		if runtime.GOOS == "darwin" {
			root = filepath.Join(home, "Library", "Application Support")
		}
		path = filepath.Join(root, "Code", "User", "mcp.json")
	}
	return filepath.Abs(path)
}

// OpenCode loads JSONC after JSON, so update the effective file if both exist.
func preferredMCPJSONPath(directory, name string) (string, error) {
	jsonc := filepath.Join(directory, name+".jsonc")
	if _, err := os.Stat(jsonc); err == nil {
		return filepath.Abs(jsonc)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return filepath.Abs(filepath.Join(directory, name+".json"))
}

func (client mcpClient) updateConfig(data []byte, endpoint, token string) ([]byte, error) {
	if client.target == "codex" {
		return updateCodexMCPConfig(data, endpoint, token)
	}
	return client.updateJSONConfig(data, endpoint, token)
}

func (client mcpClient) install(path, endpoint, token string) (MCPInstallResult, error) {
	result, err := installMCPConfig(path, client.name, func(data []byte) ([]byte, error) {
		return client.updateConfig(data, endpoint, token)
	})
	if err != nil {
		return result, fmt.Errorf("%s 接入失败：%w", client.name, err)
	}
	return result, nil
}
