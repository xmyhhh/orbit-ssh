package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Host struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Address       string `json:"address"`
	Port          int    `json:"port"`
	Username      string `json:"username"`
	Group         string `json:"group"`
	AuthType      string `json:"authType"`
	KeyPath       string `json:"keyPath"`
	Color         string `json:"color"`
	Favorite      bool   `json:"favorite"`
	LastConnected string `json:"lastConnected"`
}

type Snippet struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Command     string `json:"command"`
	Description string `json:"description"`
	Category    string `json:"category,omitempty"`
}

type Preferences struct {
	Theme        string  `json:"theme"`
	HostLayout   string  `json:"hostLayout"`
	FontSize     int     `json:"fontSize"`
	LineHeight   float64 `json:"lineHeight"`
	ConfirmClose bool    `json:"confirmClose"`
}

type State struct {
	Hosts                 []Host            `json:"hosts"`
	Snippets              []Snippet         `json:"snippets"`
	Preferences           Preferences       `json:"preferences"`
	KnownHosts            map[string]string `json:"knownHosts"`
	SnippetCatalogVersion int               `json:"snippetCatalogVersion"`
}

type Store struct {
	mu    sync.Mutex
	path  string
	state State
}

func defaultState() State {
	return State{Hosts: []Host{}, Snippets: append([]Snippet{}, builtinSnippets.Snippets...),
		SnippetCatalogVersion: builtinSnippets.Version,
		Preferences:           Preferences{Theme: "light", HostLayout: "grid", FontSize: 14, LineHeight: 1.35, ConfirmClose: true}, KnownHosts: map[string]string{}}
}

func openStore(path string) (*Store, error) {
	s := &Store{path: path, state: defaultState()}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	// A missing version belongs to the original three-snippet catalog.
	s.state.SnippetCatalogVersion = 0
	// Decode into a fresh slice so omitted fields cannot inherit preset values.
	s.state.Snippets = nil
	if err = json.Unmarshal(data, &s.state); err != nil {
		return nil, fmt.Errorf("配置文件无法读取，原文件已保留：%w", err)
	}
	if s.state.Hosts == nil {
		s.state.Hosts = []Host{}
	}
	if s.state.Snippets == nil {
		s.state.Snippets = []Snippet{}
	}
	if s.state.KnownHosts == nil {
		s.state.KnownHosts = map[string]string{}
	}
	if s.state.Preferences.HostLayout != "grid" && s.state.Preferences.HostLayout != "list" {
		s.state.Preferences.HostLayout = "grid"
	}
	if upgradeSnippetCatalog(&s.state) {
		if err = s.persistLocked(); err != nil {
			return nil, fmt.Errorf("常用片段无法保存，原配置已保留：%w", err)
		}
	}
	return s, nil
}

func (s *Store) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".orbit-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), s.path)
}

func validateHost(h Host) error {
	if strings.TrimSpace(h.ID) == "" || len(h.ID) > 128 {
		return errors.New("无效的主机 ID")
	}
	if strings.TrimSpace(h.Name) == "" || len(h.Name) > 120 {
		return errors.New("请填写主机名称（最多 120 字节）")
	}
	if strings.TrimSpace(h.Address) == "" || strings.ContainsAny(h.Address, " \t\r\n/\\") {
		return errors.New("请输入有效的 IP 地址或域名")
	}
	if strings.TrimSpace(h.Username) == "" || strings.ContainsAny(h.Username, "\r\n") {
		return errors.New("请填写用户名")
	}
	if h.Port < 1 || h.Port > 65535 {
		return errors.New("端口应在 1–65535 之间")
	}
	if h.AuthType != "password" && h.AuthType != "key" {
		return errors.New("不支持的认证方式")
	}
	if h.AuthType == "key" && h.KeyPath == "" {
		return errors.New("请选择私钥文件")
	}
	return nil
}

func (s *Store) snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, _ := json.Marshal(s.state)
	var copy State
	_ = json.Unmarshal(data, &copy)
	return copy
}

func (s *Store) host(id string) (Host, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, h := range s.state.Hosts {
		if h.ID == id {
			return h, nil
		}
	}
	return Host{}, errors.New("主机不存在，请刷新后重试")
}

func (s *Store) saveHost(h Host) error {
	if err := validateHost(h); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := append([]Host{}, s.state.Hosts...)
	found := false
	for i, old := range s.state.Hosts {
		if old.ID == h.ID {
			h.LastConnected = old.LastConnected
			s.state.Hosts[i] = h
			found = true
			break
		}
	}
	if !found {
		s.state.Hosts = append(s.state.Hosts, h)
	}
	if err := s.persistLocked(); err != nil {
		s.state.Hosts = previous
		return err
	}
	return nil
}
