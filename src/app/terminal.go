package app

import (
	"context"
	"errors"
	"io"
)

type TerminalSize struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

func validSize(size TerminalSize) TerminalSize {
	if size.Cols < 2 || size.Cols > 1000 {
		size.Cols = 100
	}
	if size.Rows < 2 || size.Rows > 500 {
		size.Rows = 30
	}
	return size
}

func (a *App) WriteTerminal(id, data string) error {
	return a.writeTerminal(id, data, nil)
}

// validate runs after writeMu is acquired, not before potentially waiting for
// another terminal writer. MCP uses it to recheck live authorization.
func (a *App) writeTerminal(id, data string, validate func(*localSession, *remoteSession) error) error {
	if len(data) > 1024*1024 {
		return errors.New("单次输入过大")
	}
	a.mu.Lock()
	local := a.localSessions[id]
	a.mu.Unlock()
	if local != nil {
		local.writeMu.Lock()
		defer local.writeMu.Unlock()
		if validate != nil {
			if err := validate(local, nil); err != nil {
				return err
			}
		}
		_, err := io.WriteString(local.terminal, data)
		return err
	}
	s, e := a.session(id)
	if e != nil {
		return e
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if validate != nil {
		if err := validate(nil, s); err != nil {
			return err
		}
	}
	_, e = io.WriteString(s.stdin, data)
	return e
}

// MCP authorization is bound to the actual session, not a reusable tab ID.
// Revocation revisions prevent a disable/re-enable cycle from resurrecting
// an approval or a write that was already waiting for the terminal lock.
type mcpTerminalAuthorization struct {
	revision uint64
	local    *localSession
	remote   *remoteSession
}

func mcpInputPermission(p Preferences) error {
	if !p.MCPEnabled {
		return errors.New("MCP 已停用")
	}
	if !p.MCPAllowTerminalInput {
		return errors.New("请先在偏好设置中启用“允许 AI 输入终端”")
	}
	return nil
}

func (a *App) authorizeMCPInput(ctx context.Context, id string) (mcpTerminalAuthorization, error) {
	var auth mcpTerminalAuthorization
	if err := ctx.Err(); err != nil {
		return auth, errors.New("命令请求已取消")
	}
	if err := a.ready(); err != nil {
		return auth, err
	}
	a.store.mu.Lock()
	err := mcpInputPermission(a.store.state.Preferences)
	auth.revision = a.store.mcpInputRevision
	a.store.mu.Unlock()
	if err != nil {
		return auth, err
	}
	a.mu.Lock()
	auth.local, auth.remote = a.localSessions[id], a.sessions[id]
	a.mu.Unlock()
	if auth.local == nil && auth.remote == nil {
		return auth, errors.New("活动终端会话不存在")
	}
	return auth, nil
}

func (a *App) writeMCPTerminal(ctx context.Context, id, data string, auth mcpTerminalAuthorization, requireUnrestricted bool) error {
	return a.writeTerminal(id, data, func(local *localSession, remote *remoteSession) error {
		a.mu.Lock()
		current := local == auth.local && remote == auth.remote &&
			a.localSessions[id] == auth.local && a.sessions[id] == auth.remote
		unrestricted := !requireUnrestricted || a.sessionMCPUnrestricted(id)
		a.mu.Unlock()
		if !current {
			return errors.New("终端会话已结束或已替换")
		}
		if !unrestricted {
			return errors.New("终端完全放行已撤销，请重新请求确认")
		}
		a.store.mu.Lock()
		err := mcpInputPermission(a.store.state.Preferences)
		if err == nil && auth.revision != a.store.mcpInputRevision {
			err = errors.New("终端输入授权已撤销，请重新请求确认")
		}
		a.store.mu.Unlock()
		if err != nil {
			return err
		}
		// An approved channel and ctx.Done may both be ready; cancellation
		// must win even when select chose the approved result.
		if ctx.Err() != nil {
			return errors.New("命令请求已取消")
		}
		return nil
	})
}

func (a *App) ResizeTerminal(id string, size TerminalSize) error {
	a.mu.Lock()
	local := a.localSessions[id]
	a.mu.Unlock()
	if local != nil {
		size = validSize(size)
		return local.terminal.Resize(size.Cols, size.Rows)
	}
	s, e := a.session(id)
	if e != nil {
		return e
	}
	size = validSize(size)
	return s.shell.WindowChange(size.Rows, size.Cols)
}
func (a *App) Disconnect(id string) error {
	a.mu.Lock()
	s := a.sessions[id]
	local := a.localSessions[id]
	delete(a.sessions, id)
	delete(a.localSessions, id)
	cancel := a.pending[id]
	mcpRequest := a.mcpConnections[id]
	delete(a.pending, id)
	a.clearSessionMCPUnrestricted(id)
	a.mu.Unlock()
	if mcpRequest != nil {
		mcpRequest.cancel()
	}
	if cancel != nil {
		cancel()
	}
	if s != nil {
		s.close()
	}
	if local != nil {
		local.close()
	}
	a.syncBackgroundState()
	return nil
}
