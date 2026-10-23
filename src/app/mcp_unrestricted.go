package app

import "errors"

// The 完全放行 (full consent) flag lives only in memory and is bound to one
// specific terminal window. Every new session starts locked again, and the
// MCP input gate falls back to the user approval dialog until the user
// explicitly turns the flag on from the terminal toolbar.
//
// Lock order: when both are needed, acquire a.mu before mcpSessionMu.
// Membership changes and flag updates must stay in the same a.mu critical
// section so a dead session cannot regain consent or clear its replacement.

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
	defer a.mu.Unlock()
	_, remote := a.sessions[id]
	_, local := a.localSessions[id]
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

// removeTerminalSession is used by delayed terminal reader cleanup. A former
// session must not delete a replacement or revoke its freshly granted consent.
func (a *App) removeTerminalSession(id string, local *localSession, remote *remoteSession) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if local != nil {
		if a.localSessions[id] != local {
			return false
		}
		delete(a.localSessions, id)
	} else {
		if a.sessions[id] != remote {
			return false
		}
		delete(a.sessions, id)
	}
	a.clearSessionMCPUnrestricted(id)
	return true
}

// Call while holding a.mu whenever changing active-session membership.
func (a *App) clearSessionMCPUnrestricted(id string) {
	a.mcpSessionMu.Lock()
	delete(a.mcpUnrestricted, id)
	a.mcpSessionMu.Unlock()
}
