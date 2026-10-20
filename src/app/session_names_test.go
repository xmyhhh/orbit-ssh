package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeSessionName(t *testing.T) {
	name, err := normalizeSessionName("  Build server  ")
	if err != nil || name != "Build server" {
		t.Fatalf("name was not trimmed: %q, err=%v", name, err)
	}
	if name, err = normalizeSessionName(strings.Repeat("你", sessionNameMaxCharacters)); err != nil || name == "" {
		t.Fatalf("unicode name at the limit was rejected: %v", err)
	}
	for _, invalid := range []string{
		strings.Repeat("a", sessionNameMaxCharacters+1),
		"line\nbreak",
		"tab\tname",
		"delete\x7fname",
	} {
		if _, err = normalizeSessionName(invalid); err == nil {
			t.Fatalf("invalid name was accepted: %q", invalid)
		}
	}
	if name, err = normalizeSessionName("   "); err != nil || name != "" {
		t.Fatalf("blank name did not reset: %q, err=%v", name, err)
	}
}

func TestRenameSessionUpdatesSessionHistoryAndMCP(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	a.localSessions = map[string]*localSession{"local": {name: "PowerShell"}}
	defer delete(a.localSessions, "local")
	a.historyDir = t.TempDir()
	a.history["local"] = TerminalHistoryRecord{ID: "local", Title: "PowerShell", Subtitle: "本地", TerminalNumber: 3, UpdatedAt: 1}

	var events []string
	a.emit = func(name string, args ...interface{}) {
		if name == "session:renamed" {
			data, _ := json.Marshal(args[0])
			events = append(events, string(data))
		}
	}

	if err := a.RenameSession("local", "  Build server  "); err != nil {
		t.Fatal(err)
	}
	sessions := a.mcpSessions()
	if len(sessions) != 1 || sessions[0].Name != "Build server" || sessions[0].DefaultName != "PowerShell" {
		t.Fatalf("custom name missing from MCP sessions: %+v", sessions)
	}
	if record := a.history["local"]; record.Name != "Build server" || record.Title != "PowerShell" {
		t.Fatalf("history record was not renamed: %+v", record)
	}
	matches, err := a.searchMCPTerminalHistory("build", "", 10)
	if err != nil || len(matches) != 1 || matches[0].Name != "Build server" {
		t.Fatalf("history could not be searched by custom name: %+v, err=%v", matches, err)
	}
	if len(events) != 1 || !strings.Contains(events[0], `"name":"Build server"`) || !strings.Contains(events[0], `"defaultName":"PowerShell"`) {
		t.Fatalf("rename event missing from UI stream: %v", events)
	}

	if err = a.RenameSession("local", ""); err != nil {
		t.Fatal(err)
	}
	if sessions = a.mcpSessions(); sessions[0].Name != "PowerShell" {
		t.Fatalf("empty name did not restore the default: %+v", sessions)
	}
	if record := a.history["local"]; record.Name != "" {
		t.Fatalf("history name did not reset: %+v", record)
	}
	if len(events) != 2 || !strings.Contains(events[1], `"name":""`) {
		t.Fatalf("reset was not announced to the UI: %v", events)
	}

	if err = a.RenameSession("missing", "name"); err == nil {
		t.Fatal("renaming a missing session succeeded")
	}
	if err = a.RenameSession("local", strings.Repeat("x", sessionNameMaxCharacters+1)); err == nil {
		t.Fatal("overlong name was accepted")
	}
	if err = a.RenameSession("local", "bad\x00name"); err == nil {
		t.Fatal("control character was accepted")
	}
}

func TestRenameSessionMCPTool(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	a.localSessions = map[string]*localSession{"local": {name: "WSL Ubuntu"}}
	defer delete(a.localSessions, "local")

	result := a.callMCPTool("rename_session", mcpTestArguments(t, map[string]any{
		"session_id": "local",
		"name":       "开发环境",
	}))
	if result.IsError {
		t.Fatal(result.Content)
	}
	var renamed struct {
		SessionID   string `json:"sessionId"`
		Name        string `json:"name"`
		DefaultName string `json:"defaultName"`
	}
	if err := json.Unmarshal([]byte(result.Content[0].Text), &renamed); err != nil {
		t.Fatal(err)
	}
	if renamed.SessionID != "local" || renamed.Name != "开发环境" || renamed.DefaultName != "WSL Ubuntu" {
		t.Fatalf("unexpected rename response: %+v", renamed)
	}

	result = a.callMCPTool("list_sessions", nil)
	if result.IsError || !strings.Contains(result.Content[0].Text, `"name":"开发环境"`) {
		t.Fatalf("list_sessions did not expose the custom name: %+v", result)
	}

	result = a.callMCPTool("rename_session", mcpTestArguments(t, map[string]any{
		"session_id": "local",
		"name":       strings.Repeat("x", sessionNameMaxCharacters+1),
	}))
	if !result.IsError {
		t.Fatal("overlong name accepted through MCP")
	}
}
