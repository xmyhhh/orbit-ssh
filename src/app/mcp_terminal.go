package app

import (
	"errors"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type mcpSessionInfo struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	DefaultName string `json:"defaultName,omitempty"`
	Address     string `json:"address,omitempty"`
	Username    string `json:"username,omitempty"`
	Status      string `json:"status"`
}

type mcpHistoryMatch struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Name           string `json:"name,omitempty"`
	Subtitle       string `json:"subtitle"`
	TerminalNumber int    `json:"terminalNumber"`
	UpdatedAt      int64  `json:"updatedAt"`
	Pinned         bool   `json:"pinned"`
	Truncated      bool   `json:"truncated"`
	Snippet        string `json:"snippet"`
}

var (
	ansiOSC  = regexp.MustCompile(`\x1b\][^\x07]*(?:\x07|\x1b\\)`)
	ansiCSI  = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	ansiChar = regexp.MustCompile(`\x1b[()][0-2A-Za-z]`)
	ansiEsc  = regexp.MustCompile(`\x1b.`)
)

func (a *App) mcpSessions() []mcpSessionInfo {
	a.mu.Lock()
	defer a.mu.Unlock()
	sessions := make([]mcpSessionInfo, 0, len(a.sessions)+len(a.localSessions))
	for id, session := range a.sessions {
		host := session.host
		sessions = append(sessions, mcpSessionInfo{
			ID: id, Kind: "ssh", Name: effectiveSessionName(session.customName, host.Name), DefaultName: host.Name,
			Address: net.JoinHostPort(host.Address, strconv.Itoa(host.Port)), Username: host.Username, Status: "connected",
		})
	}
	for id, session := range a.localSessions {
		kind := "local_shell"
		if strings.HasPrefix(session.name, "WSL") {
			kind = "wsl"
		}
		sessions = append(sessions, mcpSessionInfo{
			ID: id, Kind: kind, Name: effectiveSessionName(session.customName, session.name), DefaultName: session.name,
			Status: "connected",
		})
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].ID < sessions[j].ID })
	return sessions
}

func (a *App) readMCPTerminal(id string, maxChars int) (string, bool, error) {
	if id == "" {
		return "", false, errors.New("session_id 不能为空")
	}
	if maxChars < 1 {
		maxChars = 20000
	}
	if maxChars > 100000 {
		maxChars = 100000
	}
	a.mu.Lock()
	remote := a.sessions[id]
	local := a.localSessions[id]
	a.mu.Unlock()
	var output []byte
	if remote != nil && remote.output != nil {
		output = remote.output.read()
	} else if local != nil && local.output != nil {
		output = local.output.read()
	} else {
		return "", false, errors.New("活动终端会话不存在")
	}
	text := cleanTerminalOutput(string(output))
	runes := []rune(text)
	truncated := len(runes) > maxChars
	if truncated {
		text = string(runes[len(runes)-maxChars:])
	}
	return text, truncated, nil
}

func cleanTerminalOutput(output string) string {
	output = strings.ToValidUTF8(output, "�")
	output = ansiOSC.ReplaceAllString(output, "")
	output = ansiCSI.ReplaceAllString(output, "")
	output = ansiChar.ReplaceAllString(output, "")
	output = ansiEsc.ReplaceAllString(output, "")
	output = strings.ReplaceAll(output, "\r\n", "\n")
	output = strings.ReplaceAll(output, "\r", "\n")
	return strings.Map(func(r rune) rune {
		if r == 0 || (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return -1
		}
		return r
	}, output)
}

func (a *App) searchMCPTerminalHistory(query, sessionID string, limit int) ([]mcpHistoryMatch, error) {
	if limit <= 0 {
		limit = 10
	}
	if limit > 100 {
		limit = 100
	}
	if len(query) > 256 {
		return nil, errors.New("query 最长为 256 字节")
	}
	needle := strings.ToLower(strings.TrimSpace(query))
	records := a.terminalHistorySnapshot()
	matches := make([]mcpHistoryMatch, 0, limit)
	for _, record := range records {
		if sessionID != "" && record.ID != sessionID {
			continue
		}
		output := cleanTerminalOutput(record.Output)
		searchable := strings.ToLower(record.Title + "\n" + record.Name + "\n" + record.Subtitle + "\n" + output)
		index := strings.Index(searchable, needle)
		if needle != "" && index < 0 {
			continue
		}
		snippet := output
		if needle != "" {
			runes := []rune(output)
			needleRunes := []rune(needle)
			plainIndex := strings.Index(strings.ToLower(output), needle)
			if plainIndex >= 0 {
				start := len([]rune(output[:plainIndex])) - 120
				if start < 0 {
					start = 0
				}
				end := len([]rune(output[:plainIndex])) + len(needleRunes) + 180
				if end > len(runes) {
					end = len(runes)
				}
				snippet = string(runes[start:end])
			}
		}
		snippetRunes := []rune(snippet)
		if len(snippetRunes) > 500 {
			snippet = string(snippetRunes[len(snippetRunes)-500:])
		}
		matches = append(matches, mcpHistoryMatch{
			ID: record.ID, Title: record.Title, Name: record.Name, Subtitle: record.Subtitle,
			TerminalNumber: record.TerminalNumber, UpdatedAt: record.UpdatedAt,
			Pinned: record.Pinned, Truncated: record.Truncated, Snippet: snippet,
		})
		if len(matches) == limit {
			break
		}
	}
	return matches, nil
}
