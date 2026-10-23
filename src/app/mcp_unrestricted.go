package app

import "errors"

// The 完全放行 (full consent) flag lives only in memory and is bound to one
// specific terminal window. Every new session starts locked again, and the
// MCP input gate falls back to the user approval dialog until the user
// explicitly turns the flag on from the terminal toolbar.
//
// Lock order: mcpSessionMu covers only the flag map below, so it is never
// held together with a.mu; helpers take one of the two at a time.

func (a *App) sessionMCPUnrestricted(id string) bool {
	a.mcpSessionMu.Lock()
	defer a.mcpSessionMu.Unlock()
	return a.mcpUnrestricted[id]
}

// SetSessionMCPUnrestricted toggles the flag for an active terminal window
// from the WebView toolbar. Only connected sessions can be released, so the
// flag can never linger for a window that no longer reads MCP input.
func (a *App) SetSessionMCPUnrestricted(id string, unrestricted bool) error {
	a.mu.Lock()
	_, remote := a.sessions[id]
	_, local := a.localSessions[id]
	a.mu.Unlock()
	if !remote && !local {
		return errors.New("活动终端会话不存在")
	}
	a.mcpSessionMu.Lock()
	if unrestricted {
		a.mcpUnrestricted[id] = true
	} else {
		delete(a.mcpUnrestricted, id)
	}
	a.mcpSessionMu.Unlock()
	return nil
}

func (a *App) clearSessionMCPUnrestricted(id string) {
	a.mcpSessionMu.Lock()
	delete(a.mcpUnrestricted, id)
	a.mcpSessionMu.Unlock()
}
