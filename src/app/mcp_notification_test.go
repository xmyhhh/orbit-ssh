package app

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func TestMCPDecisionOnlyAcceptedOnce(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	requests := make(chan string, 1)
	a.emit = func(name string, args ...interface{}) {
		if name == "mcp:command-request" {
			requests <- args[0].(map[string]any)["id"].(string)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := a.requestMCPCommand(ctx, "local", "echo once\n")
		done <- err
	}()
	var id string
	select {
	case id = <-requests:
	case <-time.After(2 * time.Second):
		t.Fatal("approval was not queued")
	}
	// Simulate the banner and the dialog deciding simultaneously.
	results := make(chan error, 16)
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- a.decideMCPFromNotification(id, true)
		}()
	}
	wg.Wait()
	close(results)
	accepted := 0
	for err := range results {
		if err == nil {
			accepted++
		}
	}
	if accepted != 1 {
		t.Fatalf("accepted %d decisions for one request", accepted)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("approved request did not finish")
	}
	if terminal.joined() != "echo once\n" {
		t.Fatalf("unexpected terminal contents: %q", terminal.joined())
	}
	if len(a.ListMCPCommands()) != 0 {
		t.Fatal("decided request is still listed")
	}
	if err := a.decideMCPFromNotification(id, true); err == nil {
		t.Fatal("late notification action accepted")
	}
}

func TestMCPCancellationClosesDialog(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	requests, ended := make(chan string, 1), make(chan string, 1)
	a.emit = func(name string, args ...interface{}) {
		switch name {
		case "mcp:command-request":
			requests <- args[0].(map[string]any)["id"].(string)
		case "mcp:command-decided":
			id := args[0].(map[string]any)["id"].(string)
			if len(a.ListMCPCommands()) != 0 {
				t.Error("dialog close event emitted before removing the request")
			}
			ended <- id
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := a.requestMCPCommand(ctx, "local", "must not execute\n")
		done <- err
	}()
	var id string
	select {
	case id = <-requests:
	case <-time.After(2 * time.Second):
		t.Fatal("approval was not queued")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "取消") {
			t.Fatalf("unexpected cancellation: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation blocked")
	}
	if closed := <-ended; closed != id {
		t.Fatalf("closed wrong dialog: %q", closed)
	}
	if err := a.DecideMCPCommand(id, true); err == nil || terminal.joined() != "" {
		t.Fatal("cancelled request executed via a stale action")
	}
}

func TestExpiredMCPDecisionIsRejected(t *testing.T) {
	a := NewApp()
	request := &mcpPendingCommand{
		id: "expired-notification-test", created: time.Now().Add(-mcpApprovalTimeout),
		decided: make(chan bool, 1),
	}
	mcpCommandMu.Lock()
	mcpPendingCommands[request.id] = request
	mcpCommandMu.Unlock()
	t.Cleanup(func() {
		mcpCommandMu.Lock()
		delete(mcpPendingCommands, request.id)
		mcpCommandMu.Unlock()
	})
	if err := a.DecideMCPCommand(request.id, true); err == nil || !strings.Contains(err.Error(), "超时") {
		t.Fatalf("expired approval accepted: %v", err)
	}
	select {
	case <-request.decided:
		t.Fatal("expired decision reached the terminal waiter")
	default:
	}
}

func TestMCPRevocationInvalidatesPendingApproval(t *testing.T) {
	for _, permission := range []string{"enabled", "input"} {
		t.Run(permission, func(t *testing.T) {
			a, terminal := unrestrictedTestApp(t, "local")
			requests := make(chan string, 1)
			a.emit = func(name string, args ...interface{}) {
				if name == "mcp:command-request" {
					requests <- args[0].(map[string]any)["id"].(string)
				}
			}
			done := make(chan error, 1)
			go func() {
				_, err := a.requestMCPCommand(context.Background(), "local", "never run\n")
				done <- err
			}()
			var id string
			select {
			case id = <-requests:
			case <-time.After(2 * time.Second):
				t.Fatal("approval was not queued")
			}
			p := a.store.snapshot().Preferences
			if permission == "enabled" {
				p.MCPEnabled = false
			} else {
				p.MCPAllowTerminalInput = false
			}
			if err := a.SavePreferences(p); err != nil {
				t.Fatal(err)
			}
			// Re-enabling must not resurrect an earlier approval.
			p.MCPEnabled, p.MCPAllowTerminalInput = true, true
			if err := a.SavePreferences(p); err != nil {
				t.Fatal(err)
			}
			if len(a.ListMCPCommands()) != 0 {
				t.Fatal("revoked approval remains pending")
			}
			if err := a.DecideMCPCommand(id, true); err == nil {
				t.Fatal("revoked approval accepted")
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("revoked command succeeded")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("revocation did not wake pending approval")
			}
			if terminal.joined() != "" {
				t.Fatal("revoked input reached the shell")
			}
		})
	}
}

func TestMCPDecisionRejectsCancelledAndRevokedRequests(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled", true: "revoked"}[revoke], func(t *testing.T) {
			a, terminal := unrestrictedTestApp(t, "local")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a.emit = func(name string, args ...interface{}) {
				if name != "mcp:command-request" {
					return
				}
				id := args[0].(map[string]any)["id"].(string)
				if revoke {
					// Also guard a live permission change independently of the
					// SavePreferences invalidation hook.
					a.store.mu.Lock()
					a.store.state.Preferences.MCPAllowTerminalInput = false
					a.store.mu.Unlock()
				} else {
					cancel()
				}
				// The waiter is still in emit: cancellation has not had a
				// chance to remove its request from the pending map.
				if err := a.DecideMCPCommand(id, true); err == nil {
					t.Error("invalidated decision was accepted")
				}
			}
			if _, err := a.requestMCPCommand(ctx, "local", "never run\n"); err == nil {
				t.Fatal("invalidated command succeeded")
			}
			if terminal.joined() != "" {
				t.Fatal("invalidated input reached the shell")
			}
		})
	}
}

func TestMCPApprovalReadyAlongsideCancellationOrRevocation(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled", true: "revoked"}[revoke], func(t *testing.T) {
			a, terminal := unrestrictedTestApp(t, "local")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a.emit = func(name string, args ...interface{}) {
				if name != "mcp:command-request" {
					return
				}
				id := args[0].(map[string]any)["id"].(string)
				if err := a.DecideMCPCommand(id, true); err != nil {
					t.Fatal(err)
				}
				if revoke {
					p := a.store.snapshot().Preferences
					p.MCPAllowTerminalInput = false
					if err := a.SavePreferences(p); err != nil {
						t.Fatal(err)
					}
					p.MCPAllowTerminalInput = true
					if err := a.SavePreferences(p); err != nil {
						t.Fatal(err)
					}
				} else {
					cancel()
				}
			}
			if _, err := a.requestMCPCommand(ctx, "local", "never run\n"); err == nil {
				t.Fatal("approval won over cancellation/revocation")
			}
			if terminal.joined() != "" {
				t.Fatal("invalidated input reached the shell")
			}
		})
	}
}

func TestApprovalPreview(t *testing.T) {
	body := approvalBody("终端 A", "  "+strings.Repeat("文", 200)+"\n")
	if !utf8.ValidString(body) || !strings.HasPrefix(body, "终端 A 请求：") ||
		!strings.HasSuffix(body, "…") || utf8.RuneCountInString(body) > 175 {
		t.Fatalf("invalid preview: %q", body)
	}
}
