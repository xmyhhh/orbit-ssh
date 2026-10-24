package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"runtime"
	"sync"

	"orbitssh/src/local"
)

type localSession struct {
	terminal   local.Terminal
	name       string
	customName string
	output     *terminalOutputBuffer
	writeMu    sync.Mutex
	closed     sync.Once
}

func (s *localSession) close() { s.closed.Do(func() { _ = s.terminal.Close() }) }

func (a *App) GetPlatform() string { return runtime.GOOS }

func (a *App) GetLocalShellInfo() local.ShellInfo { return local.Inspect() }

func (a *App) ConnectLocalShell(id, shellID string, size TerminalSize) error {
	if !local.ShellsSupported {
		return errors.New("本地 Shell 目前仅支持 Windows、macOS 和 Linux")
	}
	return a.connectLocalTerminal(id, "本地 Shell", size, func(ctx context.Context, cols, rows int) (local.Terminal, error) {
		return local.Start(shellID, cols, rows)
	})
}

func (a *App) connectLocalTerminal(id, name string, size TerminalSize, start func(context.Context, int, int) (local.Terminal, error)) error {
	if id == "" || len(id) > 128 {
		return errors.New("无效的会话 ID")
	}
	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		cancel()
		return errors.New("应用正在退出，不能启动终端")
	}
	if a.sessions[id] != nil || a.localSessions[id] != nil || a.pending[id] != nil {
		a.mu.Unlock()
		cancel()
		return errors.New("会话已存在")
	}
	if a.pending == nil {
		a.pending = map[string]context.CancelFunc{}
	}
	a.pending[id] = cancel
	a.mu.Unlock()
	defer func() { cancel(); a.mu.Lock(); delete(a.pending, id); a.mu.Unlock() }()
	if err := ctx.Err(); err != nil {
		return errors.New("启动已取消")
	}
	size = validSize(size)
	terminal, err := start(ctx, size.Cols, size.Rows)
	if err != nil {
		return fmt.Errorf("无法启动 %s：%w", name, err)
	}
	a.mu.Lock()
	if a.closing || ctx.Err() != nil {
		a.mu.Unlock()
		// ConPTY needs a reader to drain output while the console closes.
		go func() { _, _ = io.Copy(io.Discard, terminal) }()
		_ = terminal.Close()
		return errors.New("启动已取消")
	}
	s := &localSession{terminal: terminal, name: name, output: &terminalOutputBuffer{}}
	if a.localSessions == nil {
		a.localSessions = map[string]*localSession{}
	}
	a.localSessions[id] = s
	delete(a.pending, id)
	// Start the reader before Disconnect can close this terminal.
	a.streamLocalTerminal(id, s)
	a.mu.Unlock()
	a.syncBackgroundState()
	return nil
}

func (a *App) streamLocalTerminal(id string, s *localSession) {
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		a.copyTerminalOutput(id, s.output, s.terminal)
	}()
	go func() {
		code, err := s.terminal.Wait()
		s.close()
		<-readDone
		current := a.removeTerminalSession(id, s, nil)
		a.syncBackgroundState()
		name := s.name
		if name == "" {
			name = "本地"
		}
		message := name + " 终端已结束"
		if err != nil {
			message = err.Error()
		} else if code != 0 {
			message = fmt.Sprintf("%s 已退出（%d）", name, code)
		}
		if current && a.emit != nil {
			a.emit("ssh:closed:"+id, message)
		}
	}()
}
