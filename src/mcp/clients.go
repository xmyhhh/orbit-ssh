//go:build !android && !androidtest

package mcp

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Client is one of the MCP clients the application can connect to.
type Client struct {
	target, name, namespace string
}

var supported = []Client{
	{"codex", "Codex", "mcp_servers"},
	{"claude", "Claude Code", "mcpServers"},
	{"cursor", "Cursor", "mcpServers"},
	{"opencode", "OpenCode", "mcp"},
	{"gemini", "Gemini CLI", "mcpServers"},
	{"vscode", "VS Code Copilot", "servers"},
}

// All returns every supported MCP client.
func All() []Client { return supported }

// Target returns the short name of the client, such as "codex".
func (client Client) Target() string { return client.target }

// Name returns the display name of the client.
func (client Client) Name() string { return client.name }

func Find(target string) (Client, error) {
	target = strings.ToLower(strings.TrimSpace(target))
	switch target {
	case "claude-code":
		target = "claude"
	case "gemini-cli":
		target = "gemini"
	case "copilot-vscode":
		target = "vscode"
	}
	for _, client := range supported {
		if client.target == target {
			return client, nil
		}
	}
	return Client{}, errors.New("MCP 客户端只支持 codex、claude、cursor、opencode、gemini 或 vscode")
}

func Clients(targets string) ([]Client, error) {
	var selected []Client
	seen := map[string]bool{}
	for _, target := range strings.Split(targets, ",") {
		var matched []Client
		if strings.EqualFold(strings.TrimSpace(target), "all") {
			matched = supported
		} else {
			client, err := Find(target)
			if err != nil {
				return nil, err
			}
			matched = []Client{client}
		}
		for _, client := range matched {
			if !seen[client.target] {
				selected = append(selected, client)
				seen[client.target] = true
			}
		}
	}
	return selected, nil
}

func CodexConfigPath(location string) (string, error) {
	return supported[0].ConfigPath(location)
}

func (client Client) ConfigPath(location string) (string, error) {
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

func (client Client) UpdateConfig(data []byte, endpoint, token string) ([]byte, error) {
	if client.target == "codex" {
		return updateCodexMCPConfig(data, endpoint, token)
	}
	return client.updateJSONConfig(data, endpoint, token)
}

func (client Client) Install(path, endpoint, token string) (Result, error) {
	result, err := installMCPConfig(path, client.name, func(data []byte) ([]byte, error) {
		return client.UpdateConfig(data, endpoint, token)
	})
	if err != nil {
		return result, fmt.Errorf("%s 接入失败：%w", client.name, err)
	}
	return result, nil
}
