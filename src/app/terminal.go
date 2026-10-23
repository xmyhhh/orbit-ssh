package app

import (
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
	if len(data) > 1024*1024 {
		return errors.New("单次输入过大")
	}
	a.mu.Lock()
	local := a.localSessions[id]
	a.mu.Unlock()
	if local != nil {
		local.writeMu.Lock()
		defer local.writeMu.Unlock()
		_, err := io.WriteString(local.terminal, data)
		return err
	}
	s, e := a.session(id)
	if e != nil {
		return e
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, e = io.WriteString(s.stdin, data)
	return e
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
	a.mu.Unlock()
	a.clearSessionMCPUnrestricted(id)
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
