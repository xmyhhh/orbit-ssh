package app

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
	ID            string        `json:"id"`
	Name          string        `json:"name"`
	Address       string        `json:"address"`
	Port          int           `json:"port"`
	Username      string        `json:"username"`
	Group         string        `json:"group"`
	AuthType      string        `json:"authType"`
	KeyPath       string        `json:"keyPath"`
	JumpHostID    string        `json:"jumpHostId,omitempty"`
	Color         string        `json:"color"`
	Favorite      bool          `json:"favorite"`
	LastConnected string        `json:"lastConnected"`
	PortForwards  []PortForward `json:"portForwards,omitempty"`
	X11           X11Config     `json:"x11"`
}

type ShortcutBinding struct {
	Code    string `json:"code"`
	Primary bool   `json:"primary"`
	Ctrl    bool   `json:"ctrl"`
	Meta    bool   `json:"meta"`
	Alt     bool   `json:"alt"`
	Shift   bool   `json:"shift"`
}

type WindowShortcuts struct {
	CloseSession    ShortcutBinding `json:"closeSession"`
	NewTerminal     ShortcutBinding `json:"newTerminal"`
	NextSession     ShortcutBinding `json:"nextSession"`
	PreviousSession ShortcutBinding `json:"previousSession"`
	SwitchSession   ShortcutBinding `json:"switchSession"`
}

type Preferences struct {
	Theme                  string          `json:"theme"`
	HostLayout             string          `json:"hostLayout"`
	FontSize               int             `json:"fontSize"`
	LineHeight             float64         `json:"lineHeight"`
	ConfirmClose           bool            `json:"confirmClose"`
	CloseToTray            bool            `json:"closeToTray"`
	TerminalHistoryEnabled bool            `json:"terminalHistoryEnabled"`
	TerminalHistoryLimit   int             `json:"terminalHistoryLimit"`
	KeepAliveSeconds       int             `json:"keepAliveSeconds"`
	MCPEnabled             bool            `json:"mcpEnabled"`
	MCPAllowConnections    bool            `json:"mcpAllowConnections"`
	MCPAllowTerminalInput  bool            `json:"mcpAllowTerminalInput"`
	MCPAllowFileAccess     bool            `json:"mcpAllowFileAccess"`
	MCPPort                int             `json:"mcpPort"`
	Shortcuts              WindowShortcuts `json:"shortcuts"`
}

type State struct {
	Hosts       []Host            `json:"hosts"`
	Preferences Preferences       `json:"preferences"`
	KnownHosts  map[string]string `json:"knownHosts"`
}

type Store struct {
	mu    sync.Mutex
	path  string
	state State
}

func defaultState() State {
	return State{Hosts: []Host{},
		Preferences: Preferences{Theme: "light", HostLayout: "grid", FontSize: 14, LineHeight: 1.35, ConfirmClose: true, CloseToTray: true, TerminalHistoryEnabled: true, TerminalHistoryLimit: 20, KeepAliveSeconds: 30, MCPPort: 8765, Shortcuts: defaultWindowShortcuts()}, KnownHosts: map[string]string{}}
}

func defaultWindowShortcuts() WindowShortcuts {
	return WindowShortcuts{
		CloseSession:    ShortcutBinding{Code: "KeyW", Primary: true},
		NewTerminal:     ShortcutBinding{Code: "KeyT", Primary: true, Shift: true},
		NextSession:     ShortcutBinding{Code: "Tab", Ctrl: true},
		PreviousSession: ShortcutBinding{Code: "Tab", Ctrl: true, Shift: true},
		SwitchSession:   ShortcutBinding{Code: "Digit", Primary: true},
	}
}

func normalizeWindowShortcuts(shortcuts *WindowShortcuts) {
	defaults := defaultWindowShortcuts()
	if shortcuts.CloseSession.Code == "" {
		shortcuts.CloseSession = defaults.CloseSession
	}
	if shortcuts.NewTerminal.Code == "" {
		shortcuts.NewTerminal = defaults.NewTerminal
	}
	if shortcuts.NextSession.Code == "" {
		shortcuts.NextSession = defaults.NextSession
	}
	if shortcuts.PreviousSession.Code == "" {
		shortcuts.PreviousSession = defaults.PreviousSession
	}
	if shortcuts.SwitchSession.Code == "" {
		shortcuts.SwitchSession = defaults.SwitchSession
	}
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
	if err = json.Unmarshal(data, &s.state); err != nil {
		return nil, fmt.Errorf("配置文件无法读取，原文件已保留：%w", err)
	}
	if s.state.Hosts == nil {
		s.state.Hosts = []Host{}
	}
	if s.state.KnownHosts == nil {
		s.state.KnownHosts = map[string]string{}
	}
	if s.state.Preferences.HostLayout != "grid" && s.state.Preferences.HostLayout != "list" {
		s.state.Preferences.HostLayout = "grid"
	}
	if s.state.Preferences.TerminalHistoryLimit < 1 || s.state.Preferences.TerminalHistoryLimit > 100 {
		s.state.Preferences.TerminalHistoryLimit = 20
	}
	if s.state.Preferences.MCPPort < 1024 || s.state.Preferences.MCPPort > 65535 {
		s.state.Preferences.MCPPort = 8765
	}
	if s.state.Preferences.KeepAliveSeconds < 0 || s.state.Preferences.KeepAliveSeconds > 300 {
		s.state.Preferences.KeepAliveSeconds = 30
	}
	normalizeWindowShortcuts(&s.state.Preferences.Shortcuts)
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
	if h.AuthType != "password" && h.AuthType != "key" && h.AuthType != "agent" {
		return errors.New("不支持的认证方式")
	}
	if h.AuthType == "key" {
		if h.KeyPath == "" {
			return errors.New("请选择私钥文件")
		}
		// The public half of a key pair cannot be parsed as a private key.
		if strings.EqualFold(filepath.Ext(h.KeyPath), ".pub") {
			return errors.New("这是公钥文件（.pub），私钥登录需要选择不带 .pub 后缀的私钥文件")
		}
	}
	if h.JumpHostID != "" {
		if h.JumpHostID == h.ID {
			return errors.New("主机不能以自身作为跳板机")
		}
	}
	return validateTunneling(h.PortForwards, h.X11)
}

func (s *Store) snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, _ := json.Marshal(s.state)
	var copy State
	_ = json.Unmarshal(data, &copy)
	return copy
}

func validateJumpChain(hosts []Host, next Host) error {
	byID := map[string]Host{}
	for _, h := range hosts {
		byID[h.ID] = h
	}
	byID[next.ID] = next
	seen := map[string]bool{next.ID: true}
	current := next
	for current.JumpHostID != "" {
		jump, ok := byID[current.JumpHostID]
		if !ok {
			return errors.New("跳板机不存在，请重新选择")
		}
		if seen[jump.ID] {
			return errors.New("跳板机配置存在循环引用")
		}
		seen[jump.ID] = true
		current = jump
		if len(seen) > 5 {
			return errors.New("跳板机最多支持 5 级")
		}
	}
	return nil
}

func (s *Store) host(id string) (Host, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, h := range s.state.Hosts {
		if h.ID == id {
			h.PortForwards = append([]PortForward(nil), h.PortForwards...)
			return h, nil
		}
	}
	return Host{}, errors.New("主机不存在，请刷新后重试")
}

func (s *Store) saveHost(h Host) error {
	if err := validateHost(h); err != nil {
		return err
	}
	h.PortForwards = append([]PortForward(nil), h.PortForwards...)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateJumpChain(s.state.Hosts, h); err != nil {
		return err
	}
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
