//go:build !android && !androidtest

package mcp

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"

	"github.com/pelletier/go-toml/v2"
	"github.com/pelletier/go-toml/v2/unstable"
)

// Result describes the outcome of a client configuration change.
type Result struct {
	ConfigPath string `json:"configPath"`
	BackupPath string `json:"backupPath"`
	Changed    bool   `json:"changed"`
}

var installMu sync.Mutex

// Only Orbit SSH's entry is re-encoded. Other tables, comments and formatting
// stay byte-for-byte intact, including table-like text inside multiline strings.
func updateCodexMCPConfig(data []byte, endpoint, token string) ([]byte, error) {
	if endpoint == "" || token == "" {
		return nil, errors.New("MCP 地址和访问令牌不能为空")
	}
	return updateCodexMCPEntry(data, func(entry map[string]any) {
		// Replace transport/authentication settings while retaining tool policies,
		// timeouts and other user options on this server.
		for _, key := range []string{"command", "args", "env", "env_vars", "bearer_token_env_var", "http_headers_helper"} {
			delete(entry, key)
		}
		headers := map[string]any{}
		if previous, ok := entry["http_headers"].(map[string]any); ok {
			for key, value := range previous {
				if !strings.EqualFold(key, "Authorization") {
					headers[key] = value
				}
			}
		}
		headers["Authorization"] = "Bearer " + token
		entry["http_headers"] = headers
		if previous, ok := entry["env_http_headers"].(map[string]any); ok {
			envHeaders := map[string]any{}
			for key, value := range previous {
				if !strings.EqualFold(key, "Authorization") {
					envHeaders[key] = value
				}
			}
			if len(envHeaders) == 0 {
				delete(entry, "env_http_headers")
			} else {
				entry["env_http_headers"] = envHeaders
			}
		}
		entry["url"] = endpoint
		entry["enabled"] = true
	})
}

// UpdateCodexMCPStdioConfig configures Codex to launch this executable as a
// stdio bridge. The bridge connects directly to Orbit SSH's loopback server,
// avoiding proxy handling in Codex's HTTP transport.
func UpdateCodexMCPStdioConfig(data []byte, command string) ([]byte, error) {
	if command == "" {
		return nil, errors.New("Codex MCP 启动程序路径不能为空")
	}
	return updateCodexMCPEntry(data, func(entry map[string]any) {
		for _, key := range []string{
			"url", "bearer_token", "bearer_token_env_var", "http_headers",
			"env_http_headers", "http_headers_helper", "oauth", "type", "headers",
		} {
			delete(entry, key)
		}
		entry["command"] = command
		entry["args"] = []any{"mcp-stdio"}
		entry["enabled"] = true
	})
}

func updateCodexMCPEntry(data []byte, update func(map[string]any)) ([]byte, error) {
	var config map[string]any
	if err := toml.Unmarshal(data, &config); err != nil {
		// Parser diagnostics may contain credentials from the source document.
		return nil, errors.New("Codex 配置不是有效的 TOML，请先修复后重试；原文件已保留")
	}
	servers, ok := config["mcp_servers"].(map[string]any)
	if config["mcp_servers"] != nil && !ok {
		return nil, errors.New("Codex 配置中的 mcp_servers 必须是一个表；原文件已保留")
	}
	existing, ok := servers["orbit-ssh"].(map[string]any)
	if servers["orbit-ssh"] != nil && !ok {
		return nil, errors.New("Codex 配置中的 orbit-ssh 必须是一个表；原文件已保留")
	}
	entry := make(map[string]any, len(existing)+3)
	for key, value := range existing {
		entry[key] = value
	}
	update(entry)
	if reflect.DeepEqual(existing, entry) {
		return data, nil
	}

	block, err := toml.Marshal(map[string]any{"mcp_servers": map[string]any{"orbit-ssh": entry}})
	if err != nil {
		return nil, errors.New("无法生成 Codex MCP 配置；原文件已保留")
	}
	// The parent table may already be declared elsewhere in the document.
	block = bytes.TrimPrefix(block, []byte("[mcp_servers]\n"))
	newline := []byte("\n")
	if bytes.Contains(data, []byte("\r\n")) {
		newline = []byte("\r\n")
		block = bytes.ReplaceAll(block, []byte("\n"), newline)
	}

	var parser unstable.Parser
	parser.Reset(data)
	var table []string
	var output bytes.Buffer
	cursor := 0
	for parser.NextExpression() {
		node := parser.Expression()
		if node.Kind != unstable.Table && node.Kind != unstable.ArrayTable && node.Kind != unstable.KeyValue {
			continue
		}
		var key []string
		firstOffset := 0
		keys := node.Key()
		for keys.Next() {
			if len(key) == 0 {
				firstOffset = int(keys.Node().Raw.Offset)
			}
			key = append(key, string(keys.Node().Data))
		}
		path := key
		end := firstOffset
		if node.Kind == unstable.KeyValue {
			path = append(append([]string{}, table...), key...)
			end = int(node.Raw.Offset + node.Raw.Length)
		} else {
			table = key
		}
		if len(path) < 2 || path[0] != "mcp_servers" || path[1] != "orbit-ssh" {
			continue
		}
		start := bytes.LastIndexByte(data[:firstOffset], '\n') + 1
		if next := bytes.IndexByte(data[end:], '\n'); next >= 0 {
			end += next + 1
		} else {
			end = len(data)
		}
		output.Write(data[cursor:start])
		cursor = end
	}
	if parser.Error() != nil {
		return nil, errors.New("无法解析 Codex 配置；原文件已保留")
	}
	output.Write(data[cursor:])
	if output.Len() > 0 && !bytes.HasSuffix(output.Bytes(), []byte("\n")) {
		output.Write(newline)
	}
	if output.Len() > 0 {
		output.Write(newline)
	}
	output.Write(block)
	updated := output.Bytes()
	var validated map[string]any
	if err = toml.Unmarshal(updated, &validated); err != nil {
		return nil, errors.New("无法合并当前 Codex 配置，请通过“复制 Codex TOML”手动接入；原文件已保留")
	}
	return updated, nil
}

func installCodexMCPConfig(path, endpoint, token string) (Result, error) {
	return installMCPConfig(path, "Codex", func(data []byte) ([]byte, error) {
		return updateCodexMCPConfig(data, endpoint, token)
	})
}

// InstallCodexMCPStdio connects Codex to the local stdio bridge executable.
func InstallCodexMCPStdio(path, command string) (Result, error) {
	result, err := installMCPConfig(path, "Codex", func(data []byte) ([]byte, error) {
		return UpdateCodexMCPStdioConfig(data, command)
	})
	if err != nil {
		return result, fmt.Errorf("Codex 接入失败：%w", err)
	}
	return result, nil
}

func installMCPConfig(path, clientName string, update func([]byte) ([]byte, error)) (Result, error) {
	installMu.Lock()
	defer installMu.Unlock()
	result := Result{ConfigPath: path}
	actualPath := path
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		actualPath, err = filepath.EvalSymlinks(path)
		if err != nil {
			return result, err
		}
	}
	original, err := os.ReadFile(actualPath)
	exists := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return result, fmt.Errorf("无法读取 %s 配置：%w", clientName, err)
	}
	updated, err := update(original)
	if err != nil {
		return result, err
	}
	if bytes.Equal(original, updated) {
		return result, nil
	}
	directory := filepath.Dir(actualPath)
	if err = os.MkdirAll(directory, 0700); err != nil {
		return result, err
	}
	temp, err := os.CreateTemp(directory, ".orbit-ssh-*.tmp")
	if err != nil {
		return result, err
	}
	defer os.Remove(temp.Name())
	if err = writeMCPInstallFile(temp, updated); err != nil {
		return result, err
	}
	if exists {
		backup, createErr := os.CreateTemp(directory, filepath.Base(actualPath)+".orbit-ssh-*.bak")
		if createErr != nil {
			return result, fmt.Errorf("无法备份 %s 配置：%w", clientName, createErr)
		}
		if err = writeMCPInstallFile(backup, original); err != nil {
			os.Remove(backup.Name())
			return result, fmt.Errorf("无法备份 %s 配置：%w", clientName, err)
		}
		result.BackupPath = backup.Name()
	}
	current, readErr := os.ReadFile(actualPath)
	if (exists && readErr != nil) || (!exists && !errors.Is(readErr, os.ErrNotExist)) || !bytes.Equal(current, original) {
		return result, fmt.Errorf("%s 配置在接入期间发生变化，请重试；未覆盖新配置", clientName)
	}
	if err = os.Rename(temp.Name(), actualPath); err != nil {
		return result, fmt.Errorf("无法保存 %s 配置：%w", clientName, err)
	}
	result.Changed = true
	return result, nil
}

func writeMCPInstallFile(file *os.File, data []byte) error {
	_, err := file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	return errors.Join(err, file.Close())
}
