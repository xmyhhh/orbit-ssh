package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"orbitssh/src/mcp"
	"orbitssh/src/platform"
)

type App struct {
	ctx           context.Context
	store         *Store
	storeErr      error
	mu            sync.Mutex
	sessions      map[string]*remoteSession
	localSessions map[string]*localSession
	pending       map[string]context.CancelFunc
	closing       bool
	forwardMu     sync.Mutex
	forwards      map[string]*hostForwarding
	emit          func(string, ...interface{})
	transferMu    sync.Mutex
	transfers     []*transferJob
	transferRuns  map[string]bool
	fileEditMu    sync.Mutex
	dirtyEditors  map[string]bool
	tray          trayState
	desktop       bool
	// notifyDecided resolves a decision taken on a system notification
	// banner; it stays nil on starts that never wired the notify package.
	notifyDecided     func(requestID string, approved bool) error
	mcpMu             sync.Mutex
	mcpServer         *http.Server
	mcpListener       net.Listener
	mcpPort           int
	mcpToken          string
	mcpError          string
	mcpConnections    map[string]*mcpConnectionRequest
	mcpSessionMu      sync.Mutex
	mcpUnrestricted   map[string]bool
	historyMu         sync.RWMutex
	historyDir        string
	history           map[string]TerminalHistoryRecord
	historyChanges    map[string]terminalHistoryChange
	historyDeleted    map[string]bool
	historyRevision   uint64
	historyTimer      *time.Timer
	historyLoadError  string
	historyStoreError string
	historyPersistMu  sync.Mutex
}

func NewApp() *App {
	return &App{
		sessions: map[string]*remoteSession{}, pending: map[string]context.CancelFunc{},
		mcpConnections:  map[string]*mcpConnectionRequest{},
		mcpUnrestricted: map[string]bool{},
		history:         map[string]TerminalHistoryRecord{}, historyChanges: map[string]terminalHistoryChange{}, historyDeleted: map[string]bool{},
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.emit = platform.Events(ctx)
	dir, err := platform.ConfigDirectory()
	if err != nil {
		a.storeErr = err
		return
	}
	a.store, a.storeErr = openStore(filepath.Join(dir, "OrbitSSH", "workspace.json"))
	if a.storeErr != nil {
		return
	}
	dataDir := filepath.Dir(a.store.path)
	a.historyDir = filepath.Join(dataDir, "terminal-history")
	if err := a.loadTerminalHistory(); err != nil {
		a.historyLoadError = err.Error()
	}
	var tokenErr error
	a.mcpToken, tokenErr = mcp.LoadOrCreateToken(filepath.Join(dataDir, "mcp-token"))
	if tokenErr != nil {
		a.mcpError = tokenErr.Error()
	}
}

func (a *App) ready() error {
	if a.storeErr != nil {
		return a.storeErr
	}
	if a.store == nil {
		return errors.New("工作空间尚未初始化")
	}
	return nil
}

func (a *App) LoadState() (State, error) {
	if err := a.ready(); err != nil {
		return State{}, err
	}
	return a.store.snapshot(), nil
}

func (a *App) SaveHost(h Host) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.store.saveHost(h)
}

func (a *App) DeleteHost(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	old := a.store.state.Hosts
	filtered := []Host{}
	for _, h := range old {
		if h.ID == id {
			continue
		}
		// A deleted host must not leave dangling jump references behind.
		if h.JumpHostID == id {
			h.JumpHostID = ""
		}
		filtered = append(filtered, h)
	}
	a.store.state.Hosts = filtered
	if err := a.store.persistLocked(); err != nil {
		a.store.state.Hosts = old
		return err
	}
	return nil
}

func (a *App) SavePreferences(p Preferences) error {
	if err := a.ready(); err != nil {
		return err
	}
	if p.Theme != "light" && p.Theme != "dark" && p.Theme != "system" {
		return errors.New("无效的主题")
	}
	if p.HostLayout == "" {
		p.HostLayout = "grid"
	}
	if p.HostLayout != "grid" && p.HostLayout != "list" {
		return errors.New("无效的主机视图")
	}
	if p.FontSize < 11 || p.FontSize > 22 {
		return errors.New("终端字号范围为 11–22")
	}
	if p.LineHeight == 0 {
		p.LineHeight = 1.35
	}
	if p.LineHeight != 1.2 && p.LineHeight != 1.35 && p.LineHeight != 1.5 {
		return errors.New("请选择有效的终端行距")
	}
	if p.TerminalHistoryLimit == 0 {
		p.TerminalHistoryLimit = 20
	}
	if p.TerminalHistoryLimit < 1 || p.TerminalHistoryLimit > 100 {
		return errors.New("终端历史上限范围为 1–100")
	}
	if p.MCPPort < 1024 || p.MCPPort > 65535 {
		return errors.New("MCP 端口范围为 1024–65535")
	}
	if p.KeepAliveSeconds < 0 || p.KeepAliveSeconds > 300 {
		return errors.New("保活间隔范围为 0–300 秒")
	}
	normalizeWindowShortcuts(&p.Shortcuts)
	a.store.mu.Lock()
	old := a.store.state.Preferences
	a.store.state.Preferences = p
	if err := a.store.persistLocked(); err != nil {
		a.store.state.Preferences = old
		a.store.mu.Unlock()
		return err
	}
	a.store.mu.Unlock()
	if a.desktop {
		if err := a.configureMCP(p); err != nil {
			a.store.mu.Lock()
			a.store.state.Preferences = old
			persistErr := a.store.persistLocked()
			a.store.mu.Unlock()
			_ = a.configureMCP(old)
			if persistErr != nil {
				return errors.Join(err, persistErr)
			}
			return err
		}
	}
	return nil
}

func (a *App) SelectKeyFile() (string, error) {
	return platform.SelectOpenFile(a.ctx, "选择 SSH 私钥文件")
}

func (a *App) SelectXAuthorityFile() (string, error) {
	return platform.SelectOpenFile(a.ctx, "选择 Xauthority 文件")
}

func (a *App) DataDirectory() (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	return filepath.Dir(a.store.path), nil
}

func (a *App) beforeClose(ctx context.Context) bool {
	closeToTray := a.store != nil && a.store.snapshot().Preferences.CloseToTray
	a.tray.mu.Lock()
	if a.tray.exiting {
		a.tray.mu.Unlock()
		return false
	}
	if a.tray.prompting {
		a.tray.mu.Unlock()
		return true
	}
	requested := a.tray.quitRequested
	a.tray.quitRequested = false
	if !requested && closeToTray && a.tray.ready && !a.tray.stopped && a.tray.hideWindow != nil {
		hide := a.tray.hideWindow
		a.tray.mu.Unlock()
		hide()
		return true
	}
	a.tray.prompting = true
	a.tray.mu.Unlock()
	blocked := a.confirmExit(ctx)
	a.tray.mu.Lock()
	a.tray.prompting = false
	if requested && !blocked {
		a.tray.exiting = true
	}
	a.tray.mu.Unlock()
	return blocked
}

func (a *App) confirmExit(ctx context.Context) bool {
	a.mu.Lock()
	count := len(a.sessions) + len(a.localSessions) + len(a.pending)
	dirty := len(a.dirtyEditors) > 0
	a.mu.Unlock()
	if dirty {
		confirmed, err := confirmAction(ctx, "仍有未保存的文件", "退出将丢失未保存的修改，并断开所有连接。", "放弃修改并退出")
		return err != nil || !confirmed
	}
	if a.store == nil || count == 0 || !a.store.snapshot().Preferences.ConfirmClose {
		return false
	}
	confirmed, err := confirmAction(ctx, "退出 Orbit SSH？", "仍有终端会话，退出应用将结束这些会话。", "结束并退出")
	return err != nil || !confirmed
}

func (a *App) SetEditorDirty(id string, dirty bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.dirtyEditors == nil {
		a.dirtyEditors = map[string]bool{}
	}
	if dirty {
		a.dirtyEditors[id] = true
	} else {
		delete(a.dirtyEditors, id)
	}
}

func (a *App) shutdown(_ context.Context) {
	a.stopTray()
	a.stopMCP()
	a.flushTerminalHistory()
	a.transferMu.Lock()
	for _, job := range a.transfers {
		job.cancel()
	}
	a.transferMu.Unlock()
	a.mu.Lock()
	a.closing = true
	sessions := a.sessions
	locals := a.localSessions
	pending := a.pending
	mcpConnections := a.mcpConnections
	a.sessions = map[string]*remoteSession{}
	a.localSessions = map[string]*localSession{}
	a.pending = map[string]context.CancelFunc{}
	a.mcpConnections = map[string]*mcpConnectionRequest{}
	a.mu.Unlock()
	for _, request := range mcpConnections {
		request.cancel()
	}
	for _, cancel := range pending {
		cancel()
	}
	for _, s := range sessions {
		s.close()
	}
	for _, s := range locals {
		s.close()
	}
	a.syncBackgroundState()
}

// syncBackgroundState reports the number of live sessions to the host so a
// mobile build can keep the engine alive in the background.
func (a *App) syncBackgroundState() {
	a.mu.Lock()
	count := len(a.sessions) + len(a.localSessions)
	closing := a.closing
	a.mu.Unlock()
	if closing {
		// The engine is going away, the host stops the service on its own.
		return
	}
	platform.NotifyBackgroundState(count)
}
