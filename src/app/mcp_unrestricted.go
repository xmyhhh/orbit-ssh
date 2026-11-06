package app

import "errors"

// The 完全放行 (full consent) flag lives only in memory and is bound to one
// specific terminal window. New sessions start locked unless the integration
// preference explicitly opts into granting consent to newly opened terminals.
//
// Lock order: when all are needed, acquire store.mu, then a.mu, then
// mcpSessionMu. Membership changes and flag updates must stay in the same
// a.mu critical section so a dead session cannot regain consent or clear its
// replacement.

func defaultSessionMCPUnrestricted(p Preferences) bool {
	return p.MCPEnabled && p.MCPAllowTerminalInput && p.MCPAllowDirectCommands
}

// Call while holding a.mu whenever changing active-session membership.
func (a *App) setSessionMCPUnrestrictedLocked(id string, unrestricted bool) {
	a.mcpSessionMu.Lock()
	defer a.mcpSessionMu.Unlock()
	if unrestricted {
		if a.mcpUnrestricted == nil {
			a.mcpUnrestricted = map[string]bool{}
		}
		a.mcpUnrestricted[id] = true
	} else {
		delete(a.mcpUnrestricted, id)
	}
}

func (a *App) sessionMCPUnrestricted(id string) bool {
	a.mcpSessionMu.Lock()
	defer a.mcpSessionMu.Unlock()
	return a.mcpUnrestricted[id]
}

// SetSessionMCPUnrestricted toggles the flag for an active terminal window
// from the WebView toolbar. Only connected sessions can be released, so the
// flag can never linger for a window that no longer reads MCP input.
func (a *App) SetSessionMCPUnrestricted(id string, unrestricted bool) error {
	if err := a.ready(); err != nil {
		return err
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	if unrestricted && (!a.store.state.Preferences.MCPEnabled || !a.store.state.Preferences.MCPAllowTerminalInput) {
		return errors.New("请先在偏好设置中启用 MCP 和终端输入权限")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, remote := a.sessions[id]
	_, local := a.localSessions[id]
	if !remote && !local {
		return errors.New("活动终端会话不存在")
	}
	a.setSessionMCPUnrestrictedLocked(id, unrestricted)
	return nil
}

// GetSessionMCPUnrestricted reports the current in-memory consent for a
// connected terminal. The frontend uses it after connecting to reflect
// automatic consent granted to newly opened sessions.
func (a *App) GetSessionMCPUnrestricted(id string) bool {
	return a.sessionMCPUnrestricted(id)
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
	a.setSessionMCPUnrestrictedLocked(id, false)
}
