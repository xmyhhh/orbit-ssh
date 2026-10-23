package app

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordedTerminal is a fake local terminal that records every write, so the
// approval tests can observe what actually reached the shell.
type recordedTerminal struct {
	mu     sync.Mutex
	writes []string
}

func (t *recordedTerminal) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.writes = append(t.writes, string(p))
	return len(p), nil
}

func (t *recordedTerminal) Read([]byte) (int, error) { return 0, nil }

func (t *recordedTerminal) Close() error { return nil }

func (t *recordedTerminal) Resize(_, _ int) error { return nil }

func (t *recordedTerminal) Wait() (uint32, error) { return 0, nil }

func (t *recordedTerminal) joined() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.Join(t.writes, "")
}

func unrestrictedTestApp(t *testing.T, id string) (*App, *recordedTerminal) {
	t.Helper()
	a := testApp(t, "127.0.0.1:22")
	a.store.state.Preferences.MCPEnabled = true
	a.store.state.Preferences.MCPAllowTerminalInput = true
	terminal := &recordedTerminal{}
	a.localSessions = map[string]*localSession{id: {name: "测试终端", terminal: terminal}}
	t.Cleanup(func() {
		a.mu.Lock()
		delete(a.localSessions, id)
		a.mu.Unlock()
	})
	return a, terminal
}

func decodeMCPTalk(a *App, requests chan<- string) {
	a.emit = func(name string, args ...interface{}) {
		if name != "mcp:command-request" {
			return
		}
		payload := args[0].(map[string]any)
		select {
		case requests <- payload["command"].(string):
		default:
		}
	}
}

func TestSendTerminalInputWithoutNewlineSkipsApproval(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	decodeMCPTalk(a, make(chan string, 8))
	result := a.callMCPTool("send_terminal_input", map[string]json.RawMessage{
		"session_id": json.RawMessage(`"local"`), "text": json.RawMessage(`"echo half"`),
	})
	if result.IsError {
		t.Fatalf("plain input should not wait for approval: %+v", result)
	}
	if text := terminal.joined(); text != "echo half" {
		t.Fatalf("unexpected terminal write: %q", text)
	}
	if pending := a.ListMCPCommands(); len(pending) != 0 {
		t.Fatalf("plain input queued an approval: %+v", pending)
	}
}

func TestSendTerminalInputNewlineWaitsForApproval(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	requests := make(chan string, 8)
	decodeMCPTalk(a, requests)

	done := make(chan mcpToolResult, 1)
	go func() {
		done <- a.callMCPTool("send_terminal_input", map[string]json.RawMessage{
			"session_id": json.RawMessage(`"local"`), "text": json.RawMessage(`"echo hi\n"`),
		})
	}()
	if text := <-requests; text != "echo hi\n" {
		t.Fatalf("approval payload mismatch: %q", text)
	}
	pending := a.ListMCPCommands()
	if len(pending) != 1 {
		t.Fatalf("expected one pending approval: %+v", pending)
	}
	if pending[0]["dangerous"] != false {
		t.Fatalf("plain echo marked dangerous: %+v", pending[0])
	}
	if terminal.joined() != "" {
		t.Fatalf("terminal was written before approval: %q", terminal.joined())
	}
	if err := a.DecideMCPCommand(pending[0]["id"].(string), true); err != nil {
		t.Fatalf("decide: %v", err)
	}
	result := <-done
	if result.IsError {
		t.Fatalf("approved input failed: %+v", result)
	}
	if value, ok := result.StructuredContent.(map[string]any); ok && value["sent"] != true {
		t.Fatalf("approved input not marked as sent: %#v", value)
	}
	if text := terminal.joined(); text != "echo hi\n" {
		t.Fatalf("unexpected terminal write: %q", text)
	}
}

func TestSendTerminalInputNewlineReject(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	requests := make(chan string, 8)
	decodeMCPTalk(a, requests)

	done := make(chan mcpToolResult, 1)
	go func() {
		done <- a.callMCPTool("send_terminal_input", map[string]json.RawMessage{
			"session_id": json.RawMessage(`"local"`), "text": json.RawMessage(`"sudo rm -rf /\n"`),
		})
	}()
	<-requests
	pending := a.ListMCPCommands()
	if len(pending) != 1 || pending[0]["dangerous"] != true {
		t.Fatalf("dangerous command not flagged: %+v", pending)
	}
	if err := a.DecideMCPCommand(pending[0]["id"].(string), false); err != nil {
		t.Fatalf("decide: %v", err)
	}
	result := <-done
	if !result.IsError || !strings.Contains(result.Content[0].Text, "拒绝") {
		t.Fatalf("rejected input should fail with the refusal: %+v", result)
	}
	if text := terminal.joined(); text != "" {
		t.Fatalf("rejected command reached the shell: %q", text)
	}
}

func TestRunCommandStillNeedsApproval(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	requests := make(chan string, 8)
	decodeMCPTalk(a, requests)

	done := make(chan mcpToolResult, 1)
	go func() {
		done <- a.callMCPTool("run_command", map[string]json.RawMessage{
			"session_id": json.RawMessage(`"local"`), "command": json.RawMessage(`"ls"`),
		})
	}()
	if text := <-requests; text != "ls\n" {
		t.Fatalf("run_command payload should carry the command: %q", text)
	}
	pending := a.ListMCPCommands()
	if len(pending) != 1 {
		t.Fatalf("expected one pending approval: %+v", pending)
	}
	if err := a.DecideMCPCommand(pending[0]["id"].(string), true); err != nil {
		t.Fatalf("decide: %v", err)
	}
	result := <-done
	if result.IsError {
		t.Fatalf("approved run_command failed: %+v", result)
	}
	if text := terminal.joined(); text != "ls\n" {
		t.Fatalf("unexpected terminal write: %q", text)
	}
	if value, ok := result.StructuredContent.(map[string]any); ok && value["approved"] != true {
		t.Fatalf("run_command not marked approved: %#v", value)
	}
	if value := result.StructuredContent.(map[string]any); value["message"].(string) != mcpCommandSent {
		t.Fatalf("unexpected message: %#v", value["message"])
	}
}

func TestSessionMCPUnrestrictedBypassesApproval(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	decodeMCPTalk(a, make(chan string, 8))

	if infos := a.mcpSessions(); len(infos) != 1 || infos[0].Unrestricted {
		t.Fatalf("new sessions must start restricted: %+v", a.mcpSessions())
	}
	if err := a.SetSessionMCPUnrestricted("local", true); err != nil {
		t.Fatalf("unrestrict: %v", err)
	}
	if infos := a.mcpSessions(); len(infos) != 1 || !infos[0].Unrestricted {
		t.Fatalf("unrestricted flag not reported: %+v", a.mcpSessions())
	}

	// Both executing paths now write without any dialog.
	result := a.callMCPTool("send_terminal_input", map[string]json.RawMessage{
		"session_id": json.RawMessage(`"local"`), "text": json.RawMessage(`"echo direct\n"`),
	})
	if result.IsError {
		t.Fatalf("unrestricted send_terminal_input failed: %+v", result)
	}
	result = a.callMCPTool("run_command", map[string]json.RawMessage{
		"session_id": json.RawMessage(`"local"`), "command": json.RawMessage(`"whoami"`),
	})
	if result.IsError {
		t.Fatalf("unrestricted run_command failed: %+v", result)
	}
	if pending := a.ListMCPCommands(); len(pending) != 0 {
		t.Fatalf("unrestricted session still queued approvals: %+v", pending)
	}
	if text := terminal.joined(); !strings.Contains(text, "echo direct\n") || !strings.Contains(text, "whoami\n") {
		t.Fatalf("unrestricted writes missing: %q", text)
	}

	// Turning the flag back on restores the approval gate.
	if err := a.SetSessionMCPUnrestricted("local", false); err != nil {
		t.Fatalf("restrict again: %v", err)
	}
	if infos := a.mcpSessions(); len(infos) != 1 || infos[0].Unrestricted {
		t.Fatalf("flag not cleared: %+v", a.mcpSessions())
	}
}

func TestMCPUnrestrictedRejectsCancelledContext(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	if err := a.SetSessionMCPUnrestricted("local", true); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.requestMCPCommand(ctx, "local", "never run\n"); err == nil {
		t.Fatal("unrestricted input accepted a cancelled request")
	}
	result := a.callMCPToolContext(ctx, "send_terminal_input", map[string]json.RawMessage{
		"session_id": json.RawMessage(`"local"`), "text": json.RawMessage(`"partial"`),
	})
	if !result.IsError || terminal.joined() != "" {
		t.Fatal("cancelled plain input reached the terminal")
	}
}

func TestMCPWriteRechecksAuthorizationAfterTerminalLock(t *testing.T) {
	for _, revoke := range []string{"cancel", "input", "enabled", "consent", "session"} {
		t.Run(revoke, func(t *testing.T) {
			a, terminal := unrestrictedTestApp(t, "local")
			if err := a.SetSessionMCPUnrestricted("local", true); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			auth, err := a.authorizeMCPInput(ctx, "local")
			if err != nil {
				t.Fatal(err)
			}
			auth.local.writeMu.Lock()
			done := make(chan error, 1)
			go func() { done <- a.writeMCPTerminal(ctx, "local", "never run\n", auth, true) }()
			switch revoke {
			case "cancel":
				cancel()
			case "input", "enabled":
				p := a.store.snapshot().Preferences
				if revoke == "input" {
					p.MCPAllowTerminalInput = false
				} else {
					p.MCPEnabled = false
				}
				if err := a.SavePreferences(p); err != nil {
					t.Fatal(err)
				}
				p.MCPAllowTerminalInput, p.MCPEnabled = true, true
				if err := a.SavePreferences(p); err != nil {
					t.Fatal(err)
				}
			case "consent":
				if err := a.SetSessionMCPUnrestricted("local", false); err != nil {
					t.Fatal(err)
				}
			case "session":
				a.mu.Lock()
				a.localSessions["local"] = &localSession{terminal: terminal}
				a.mu.Unlock()
			}
			auth.local.writeMu.Unlock()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("write did not recheck authorization")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("write blocked")
			}
			if terminal.joined() != "" {
				t.Fatal("revoked input reached the terminal")
			}
		})
	}
}

func TestSessionMCPUnrestrictedSetterAndCleanup(t *testing.T) {
	for _, kind := range []string{"local", "remote"} {
		t.Run(kind, func(t *testing.T) {
			a, terminal := unrestrictedTestApp(t, "session")
			t.Cleanup(func() {
				a.mu.Lock()
				delete(a.sessions, "session")
				a.mu.Unlock()
			})
			var oldLocal *localSession
			var oldRemote *remoteSession
			if kind == "local" {
				oldLocal = a.localSessions["session"]
			} else {
				delete(a.localSessions, "session")
				oldRemote = &remoteSession{}
				a.sessions["session"] = oldRemote
			}
			if err := a.SetSessionMCPUnrestricted("session", true); err != nil {
				t.Fatal(err)
			}
			if !a.removeTerminalSession("session", oldLocal, oldRemote) || a.sessionMCPUnrestricted("session") {
				t.Fatal("current session cleanup did not clear consent")
			}
			if err := a.SetSessionMCPUnrestricted("session", true); err == nil || a.sessionMCPUnrestricted("session") {
				t.Fatal("dead session regained consent")
			}
			a.mu.Lock()
			if kind == "local" {
				a.localSessions["session"] = &localSession{terminal: terminal}
			} else {
				a.sessions["session"] = &remoteSession{}
			}
			a.mu.Unlock()
			if err := a.SetSessionMCPUnrestricted("session", true); err != nil {
				t.Fatal(err)
			}
			if a.removeTerminalSession("session", oldLocal, oldRemote) || !a.sessionMCPUnrestricted("session") {
				t.Fatal("stale cleanup cleared replacement session consent")
			}
		})
	}
}

func TestSessionMCPUnrestrictedConcurrentSetterCleanup(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "session")
	for range 200 {
		s := &localSession{terminal: terminal}
		a.mu.Lock()
		a.localSessions["session"] = s
		a.mu.Unlock()
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _ = a.SetSessionMCPUnrestricted("session", true) }()
		go func() { defer wg.Done(); a.removeTerminalSession("session", s, nil) }()
		wg.Wait()
		if a.sessionMCPUnrestricted("session") {
			t.Fatal("setter restored consent after session cleanup")
		}
	}
}

func TestSessionMCPUnrestrictedShutdown(t *testing.T) {
	a, _ := unrestrictedTestApp(t, "local")
	if err := a.SetSessionMCPUnrestricted("local", true); err != nil {
		t.Fatal(err)
	}
	a.shutdown(context.Background())
	if a.sessionMCPUnrestricted("local") {
		t.Fatal("shutdown retained consent for a dead session")
	}
	if err := a.SetSessionMCPUnrestricted("local", true); err == nil {
		t.Fatal("shutdown session regained consent")
	}
}

func TestSessionMCPUnrestrictedLifecycle(t *testing.T) {
	a, _ := unrestrictedTestApp(t, "local")
	SetSession := func(id string, unrestricted bool) error { return a.SetSessionMCPUnrestricted(id, unrestricted) }
	if err := SetSession("local", true); err != nil {
		t.Fatal(err)
	}
	if err := SetSession("missing", true); err == nil {
		t.Fatal("missing sessions must not be unrestrictable")
	}
	if err := a.Disconnect("local"); err != nil {
		t.Fatal(err)
	}
	if a.sessionMCPUnrestricted("local") {
		t.Fatal("disconnect must clear the unrestricted flag")
	}
	if infos := a.mcpSessions(); len(infos) != 0 {
		t.Fatal("disconnected session still listed")
	}
}
