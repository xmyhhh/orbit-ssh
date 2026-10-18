package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx           context.Context
	store         *Store
	storeErr      error
	mu            sync.Mutex
	sessions      map[string]*remoteSession
	localSessions map[string]*localSession
	pending       map[string]context.CancelFunc
	emit          func(string, ...interface{})
	transferMu    sync.Mutex
	transfers     []*transferJob
	transferRuns  map[string]bool
	fileEditMu    sync.Mutex
	dirtyEditors  map[string]bool
}

func NewApp() *App {
	return &App{sessions: map[string]*remoteSession{}, pending: map[string]context.CancelFunc{}}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.emit = func(name string, args ...interface{}) { runtime.EventsEmit(ctx, name, args...) }
	dir, err := os.UserConfigDir()
	if err != nil {
		a.storeErr = err
		return
	}
	a.store, a.storeErr = openStore(filepath.Join(dir, "OrbitSSH", "workspace.json"))
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
		if h.ID != id {
			filtered = append(filtered, h)
		}
	}
	a.store.state.Hosts = filtered
	if err := a.store.persistLocked(); err != nil {
		a.store.state.Hosts = old
		return err
	}
	return nil
}

func (a *App) SaveSnippets(snippets []Snippet) error {
	if err := a.ready(); err != nil {
		return err
	}
	for _, s := range snippets {
		if s.ID == "" || s.Name == "" || s.Command == "" {
			return errors.New("请填写片段名称和命令")
		}
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	old := a.store.state.Snippets
	a.store.state.Snippets = snippets
	if err := a.store.persistLocked(); err != nil {
		a.store.state.Snippets = old
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
	if p.FontSize < 11 || p.FontSize > 22 {
		return errors.New("终端字号范围为 11–22")
	}
	if p.LineHeight == 0 {
		p.LineHeight = 1.35
	}
	if p.LineHeight != 1.2 && p.LineHeight != 1.35 && p.LineHeight != 1.5 {
		return errors.New("请选择有效的终端行距")
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	old := a.store.state.Preferences
	a.store.state.Preferences = p
	if err := a.store.persistLocked(); err != nil {
		a.store.state.Preferences = old
		return err
	}
	return nil
}

func (a *App) SelectKeyFile() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: "选择 SSH 私钥文件", ShowHiddenFiles: true})
}

func (a *App) DataDirectory() (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	return filepath.Dir(a.store.path), nil
}

func (a *App) beforeClose(ctx context.Context) bool {
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
	confirmed, err := confirmAction(ctx, "关闭 Orbit SSH？", "仍有终端会话，关闭窗口将结束这些会话。", "结束并退出")
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
	a.transferMu.Lock()
	for _, job := range a.transfers {
		job.cancel()
	}
	a.transferMu.Unlock()
	a.mu.Lock()
	sessions := a.sessions
	locals := a.localSessions
	pending := a.pending
	a.sessions = map[string]*remoteSession{}
	a.localSessions = map[string]*localSession{}
	a.pending = map[string]context.CancelFunc{}
	a.mu.Unlock()
	for _, cancel := range pending {
		cancel()
	}
	for _, s := range sessions {
		s.close()
	}
	for _, s := range locals {
		s.close()
	}
}
