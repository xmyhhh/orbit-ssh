package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/ssh"
)

// HostBundle is the portable part of a workspace. Credentials, key material and
// trusted fingerprints are never included.
type HostBundle struct {
	Version int    `json:"version"`
	Hosts   []Host `json:"hosts"`
}

type HostImportResult struct {
	Added   int      `json:"added"`
	Updated int      `json:"updated"`
	Skipped int      `json:"skipped"`
	HostIDs []string `json:"hostIds"`
}

func (a *App) ExportHosts() (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	path, err := selectSaveFile(a.ctx, "orbit-ssh-hosts.json")
	if err != nil || path == "" {
		return "", err
	}
	hosts := a.store.snapshot().Hosts
	// Group and jump references are only meaningful inside this workspace.
	for i := range hosts {
		hosts[i].LastConnected = ""
	}
	data, err := json.MarshalIndent(HostBundle{Version: 1, Hosts: hosts}, "", "  ")
	if err != nil {
		return "", err
	}
	if err = os.WriteFile(path, data, 0600); err != nil {
		return "", fmt.Errorf("无法写入导出文件：%w", err)
	}
	return path, nil
}

func (a *App) ImportHosts() (HostImportResult, error) {
	if err := a.ready(); err != nil {
		return HostImportResult{}, err
	}
	path, err := selectOpenFile(a.ctx, "选择主机导出文件")
	if err != nil || path == "" {
		return HostImportResult{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return HostImportResult{}, fmt.Errorf("无法读取导入文件：%w", err)
	}
	if len(data) > 8*1024*1024 {
		return HostImportResult{}, errors.New("导入文件过大")
	}
	var bundle HostBundle
	if err = json.Unmarshal(data, &bundle); err != nil {
		return HostImportResult{}, errors.New("导入文件格式无效，请选择 Orbit SSH 导出的 JSON 文件")
	}
	return a.ImportHostList(bundle.Hosts)
}

// ImportHostList saves hosts while keeping existing IDs and jump references.
func (a *App) ImportHostList(hosts []Host) (HostImportResult, error) {
	if err := a.ready(); err != nil {
		return HostImportResult{}, err
	}
	if len(hosts) == 0 {
		return HostImportResult{}, errors.New("导入文件中没有主机")
	}
	if len(hosts) > 500 {
		return HostImportResult{}, errors.New("一次最多导入 500 台主机")
	}
	result := HostImportResult{HostIDs: []string{}}
	existing := map[string]Host{}
	byName := map[string]Host{}
	idMap := map[string]string{}
	for _, host := range a.store.snapshot().Hosts {
		existing[host.ID] = host
		byName[strings.ToLower(host.Name)] = host
	}
	// Pass one saves hosts without jump references; pass two restores them.
	for i := range hosts {
		host := hosts[i]
		originalID := host.ID
		if strings.TrimSpace(host.ID) == "" || len(host.ID) > 128 {
			host.ID = "import-" + rand.Text()
		}
		if old, ok := existing[host.ID]; ok {
			host.Color = old.Color
			host.Favorite = old.Favorite
			host.PortForwards = old.PortForwards
			host.X11 = old.X11
			result.Updated++
		} else if old, ok := byName[strings.ToLower(host.Name)]; ok {
			host.ID = old.ID
			host.Color = old.Color
			host.Favorite = old.Favorite
			host.PortForwards = old.PortForwards
			host.X11 = old.X11
			result.Updated++
		} else {
			result.Added++
		}
		if host.Port == 0 {
			host.Port = 22
		}
		if host.Group == "" {
			host.Group = "默认分组"
		}
		if host.Color == "" {
			host.Color = "mint"
		}
		jump := host.JumpHostID
		host.JumpHostID = ""
		if err := a.SaveHost(host); err != nil {
			result.Skipped++
			continue
		}
		hosts[i].ID = host.ID
		hosts[i].JumpHostID = jump
		if originalID != "" {
			idMap[originalID] = host.ID
		}
		result.HostIDs = append(result.HostIDs, host.ID)
		existing[host.ID] = host
	}
	for _, host := range hosts {
		jumpID := host.JumpHostID
		if mapped, ok := idMap[jumpID]; ok {
			jumpID = mapped
		}
		if jumpID == "" || jumpID == host.ID {
			continue
		}
		if _, ok := existing[jumpID]; !ok {
			continue
		}
		current, err := a.store.host(host.ID)
		if err != nil {
			continue
		}
		current.JumpHostID = jumpID
		if err = a.SaveHost(current); err != nil {
			result.Skipped++
		}
	}
	return result, nil
}

// GenerateKeyPair writes a new unencrypted Ed25519 key and returns its paths.
// An existing file is never overwritten.
func (a *App) GenerateKeyPair(name string) (string, string, error) {
	dir := filepath.Join(mustDataDir(a), "keys")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", "", fmt.Errorf("无法创建密钥目录：%w", err)
	}
	clean := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '-'
	}, strings.TrimSpace(name))
	if clean == "" {
		clean = "orbit_ed25519"
	}
	if len(clean) > 64 {
		clean = clean[:64]
	}
	privatePath := filepath.Join(dir, clean)
	if _, err := os.Stat(privatePath); err == nil {
		return "", "", errors.New("同名密钥已存在，请换一个名称")
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	block, err := ssh.MarshalPrivateKey(private, "")
	if err != nil {
		return "", "", err
	}
	if err = os.WriteFile(privatePath, pem.EncodeToMemory(block), 0600); err != nil {
		return "", "", fmt.Errorf("无法写入私钥：%w", err)
	}
	publicKey, err := ssh.NewPublicKey(public)
	if err != nil {
		return "", "", err
	}
	publicPath := privatePath + ".pub"
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(publicKey))) + " orbit-ssh\n"
	if err = os.WriteFile(publicPath, []byte(line), 0644); err != nil {
		_ = os.Remove(privatePath)
		return "", "", fmt.Errorf("无法写入公钥：%w", err)
	}
	return privatePath, publicPath, nil
}

func mustDataDir(a *App) string {
	if a.store != nil {
		return filepath.Dir(a.store.path)
	}
	return "."
}
