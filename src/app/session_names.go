package app

import (
	"errors"
	"strings"
	"unicode/utf8"
)

const sessionNameMaxCharacters = 80

func normalizeSessionName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > sessionNameMaxCharacters {
		return "", errors.New("会话名称最长为 80 个字符")
	}
	for _, character := range name {
		if character < 0x20 || character == 0x7f {
			return "", errors.New("会话名称不能包含控制字符")
		}
	}
	return name, nil
}

func effectiveSessionName(customName, defaultName string) string {
	if customName != "" {
		return customName
	}
	return defaultName
}

// RenameSession sets a custom name for a live terminal. An empty name restores
// the default host or local-shell label. The name is shared with MCP clients and
// the matching terminal history record.
func (a *App) RenameSession(id, name string) error {
	name, err := normalizeSessionName(name)
	if err != nil {
		return err
	}
	a.mu.Lock()
	remote := a.sessions[id]
	local := a.localSessions[id]
	if remote == nil && local == nil {
		a.mu.Unlock()
		return errors.New("活动终端会话不存在")
	}
	if remote != nil {
		remote.customName = name
	} else {
		local.customName = name
	}
	a.mu.Unlock()

	a.historyMu.Lock()
	if record, ok := a.history[id]; ok {
		record.Name = name
		a.history[id] = record
		copy := record
		a.markTerminalHistoryChangedLocked(id, &copy)
	}
	a.historyMu.Unlock()

	if a.emit != nil {
		defaultName := a.sessionDefaultName(id)
		a.emit("session:renamed", map[string]string{
			"sessionId": id, "name": name, "defaultName": defaultName,
		})
	}
	return nil
}

func (a *App) sessionDefaultName(id string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if session := a.sessions[id]; session != nil {
		return session.host.Name
	}
	if session := a.localSessions[id]; session != nil {
		return session.name
	}
	return ""
}

func (a *App) sessionNames(id string) (string, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if session := a.sessions[id]; session != nil {
		return effectiveSessionName(session.customName, session.host.Name), session.host.Name
	}
	if session := a.localSessions[id]; session != nil {
		return effectiveSessionName(session.customName, session.name), session.name
	}
	return "", ""
}
