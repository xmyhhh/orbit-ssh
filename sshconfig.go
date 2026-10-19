package main

import (
	"bufio"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SSHConfigEntry is one concrete host parsed from an OpenSSH client config.
// Wildcard patterns and Match blocks are skipped: they describe rules rather
// than connectable hosts.
type SSHConfigEntry struct {
	Alias     string `json:"alias"`
	Name      string `json:"name"`
	Address   string `json:"address"`
	Port      int    `json:"port"`
	Username  string `json:"username"`
	AuthType  string `json:"authType"`
	KeyPath   string `json:"keyPath"`
	JumpAlias string `json:"jumpAlias"`
	Group     string `json:"group"`
	Imported  bool   `json:"imported"`
}

type SSHConfigImport struct {
	Path    string           `json:"path"`
	Entries []SSHConfigEntry `json:"entries"`
}

type SSHConfigImportResult struct {
	Added   int      `json:"added"`
	Updated int      `json:"updated"`
	Skipped int      `json:"skipped"`
	HostIDs []string `json:"hostIds"`
}

// DefaultSSHConfigPath returns the conventional user config path.
func DefaultSSHConfigPath() string {
	home, err := platformLocalDirectory()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".ssh", "config")
}

// SelectSSHConfigFile lets the user point at a non-standard config file.
func (a *App) SelectSSHConfigFile() (string, error) {
	return selectOpenFile(a.ctx, "选择 SSH 客户端配置文件")
}

// ReadSSHConfig parses the default config (or the given path) without saving.
func (a *App) ReadSSHConfig(path string) (SSHConfigImport, error) {
	if err := a.ready(); err != nil {
		return SSHConfigImport{}, err
	}
	if strings.TrimSpace(path) == "" {
		path = DefaultSSHConfigPath()
	}
	if path == "" {
		return SSHConfigImport{}, errors.New("无法确定 SSH 配置目录")
	}
	entries, err := parseSSHConfig(path)
	if err != nil {
		return SSHConfigImport{}, err
	}
	existing := map[string]bool{}
	for _, h := range a.store.snapshot().Hosts {
		existing[strings.ToLower(h.Name)] = true
	}
	for i := range entries {
		entries[i].Imported = existing[strings.ToLower(entries[i].Name)]
	}
	return SSHConfigImport{Path: path, Entries: entries}, nil
}

// ImportSSHConfig saves the selected entries. Existing hosts with the same name
// are updated in place so repeated imports do not create duplicates.
func (a *App) ImportSSHConfig(entries []SSHConfigEntry) (SSHConfigImportResult, error) {
	if err := a.ready(); err != nil {
		return SSHConfigImportResult{}, err
	}
	if len(entries) == 0 {
		return SSHConfigImportResult{}, errors.New("请选择要导入的主机")
	}
	if len(entries) > 500 {
		return SSHConfigImportResult{}, errors.New("一次最多导入 500 台主机")
	}
	result := SSHConfigImportResult{HostIDs: []string{}}
	snapshot := a.store.snapshot()
	byAlias := map[string]string{}
	byName := map[string]Host{}
	for _, h := range snapshot.Hosts {
		byName[strings.ToLower(h.Name)] = h
	}
	for _, entry := range entries {
		alias := strings.ToLower(strings.TrimSpace(entry.Alias))
		if alias == "" {
			continue
		}
		host := Host{
			ID: "sshconfig-" + rand.Text(), Name: strings.TrimSpace(entry.Name), Address: strings.TrimSpace(entry.Address),
			Port: entry.Port, Username: strings.TrimSpace(entry.Username), AuthType: entry.AuthType,
			KeyPath: strings.TrimSpace(entry.KeyPath), Group: strings.TrimSpace(entry.Group), Color: "mint",
		}
		if host.Name == "" {
			host.Name = entry.Alias
		}
		if host.Port == 0 {
			host.Port = 22
		}
		if host.Username == "" {
			host.Username = "root"
		}
		if host.AuthType != "key" && host.AuthType != "agent" {
			host.AuthType = "password"
		}
		if host.AuthType == "key" && host.KeyPath == "" {
			host.AuthType = "agent"
		}
		if host.Group == "" {
			host.Group = "SSH 配置"
		}
		if existing, ok := byName[strings.ToLower(host.Name)]; ok {
			host.ID = existing.ID
			host.Color = existing.Color
			host.Favorite = existing.Favorite
			host.PortForwards = existing.PortForwards
			host.X11 = existing.X11
			result.Updated++
		} else {
			result.Added++
		}
		byAlias[alias] = host.ID
		if err := a.SaveHost(host); err != nil {
			result.Skipped++
			continue
		}
		byName[strings.ToLower(host.Name)] = host
		result.HostIDs = append(result.HostIDs, host.ID)
	}
	// Resolve ProxyJump aliases after every host has an ID.
	for _, entry := range entries {
		id := byAlias[strings.ToLower(strings.TrimSpace(entry.Alias))]
		jump := strings.ToLower(strings.TrimSpace(entry.JumpAlias))
		if id == "" || jump == "" || byAlias[jump] == "" || byAlias[jump] == id {
			continue
		}
		host, err := a.store.host(id)
		if err != nil {
			continue
		}
		host.JumpHostID = byAlias[jump]
		if err = a.SaveHost(host); err != nil {
			result.Skipped++
		}
	}
	if a.emit != nil && len(result.HostIDs) > 0 {
		a.emit("hosts:imported", result)
	}
	return result, nil
}

// parseSSHConfig reads the subset of client options Orbit SSH can represent.
func parseSSHConfig(path string) ([]SSHConfigEntry, error) {
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("未找到 %s，可在本机创建后再导入", path)
		}
		return nil, err
	}
	defer file.Close()
	type block struct {
		patterns []string
		values   map[string]string
	}
	blocks := []*block{}
	current := &block{values: map[string]string{}}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	skippingMatch := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value := splitConfigLine(line)
		lower := strings.ToLower(key)
		switch lower {
		case "host":
			blocks = append(blocks, current)
			current = &block{values: map[string]string{}}
			current.patterns = strings.Fields(value)
			skippingMatch = false
		case "match":
			skippingMatch = true
		default:
			if skippingMatch || len(current.patterns) == 0 {
				continue
			}
			if _, seen := current.values[lower]; !seen {
				// OpenSSH uses the first obtained value for each option.
				current.values[lower] = value
			}
		}
	}
	blocks = append(blocks, current)
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	entries := []SSHConfigEntry{}
	seen := map[string]bool{}
	for _, b := range blocks {
		for _, pattern := range b.patterns {
			if pattern == "*" || strings.ContainsAny(pattern, "*?!") || strings.HasPrefix(pattern, "!") {
				continue
			}
			key := strings.ToLower(pattern)
			if seen[key] {
				continue
			}
			seen[key] = true
			address := b.values["hostname"]
			if address == "" {
				address = pattern
			}
			port := 22
			if parsed, err := strconv.Atoi(b.values["port"]); err == nil && parsed > 0 && parsed <= 65535 {
				port = parsed
			}
			entry := SSHConfigEntry{
				Alias: pattern, Name: pattern, Address: address, Port: port,
				Username: b.values["user"], JumpAlias: b.values["proxyjump"],
				AuthType: "password",
			}
			if keyPath := b.values["identityfile"]; keyPath != "" {
				entry.AuthType = "key"
				entry.KeyPath = expandConfigPath(keyPath)
			} else {
				entry.AuthType = "agent"
			}
			if entry.JumpAlias != "" && strings.Contains(entry.JumpAlias, ",") {
				entry.JumpAlias = strings.TrimSpace(strings.Split(entry.JumpAlias, ",")[0])
			}
			if strings.Contains(entry.JumpAlias, "@") {
				entry.JumpAlias = entry.JumpAlias[strings.LastIndex(entry.JumpAlias, "@")+1:]
			}
			entries = append(entries, entry)
		}
	}
	if len(entries) == 0 {
		return nil, errors.New("配置中没有可导入的主机（通配符规则会被跳过）")
	}
	return entries, nil
}

func splitConfigLine(line string) (string, string) {
	index := strings.IndexAny(line, " \t=")
	if index < 0 {
		return line, ""
	}
	key := line[:index]
	value := strings.TrimSpace(line[index:])
	value = strings.TrimPrefix(value, "=")
	return key, strings.TrimSpace(value)
}

func expandConfigPath(value string) string {
	value = strings.Trim(value, `"'`)
	if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`) {
		if home, err := platformLocalDirectory(); err == nil {
			return filepath.Join(home, value[2:])
		}
	}
	return value
}
