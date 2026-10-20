//go:build darwin

package main

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"
)

// Exercise the public local-shell API on the macOS pseudo terminal.
func TestDarwinLocalTerminals(t *testing.T) {
	info := NewApp().GetLocalShellInfo()
	if !info.Supported || len(info.Shells) == 0 {
		t.Fatalf("no macOS shells discovered: %+v", info)
	}
	for _, shell := range info.Shells {
		t.Run(shell.ID, func(t *testing.T) { testDarwinLocalShell(t, shell) })
	}
}

func testDarwinLocalShell(t *testing.T, shell LocalShell) {
	a := NewApp()
	a.ctx = context.Background()
	t.Cleanup(func() { a.shutdown(context.Background()) })
	type event struct{ id, text string }
	events := make(chan event, 1024)
	closed := make(chan string, 8)
	a.emit = func(name string, args ...interface{}) {
		if strings.HasPrefix(name, "ssh:closed:") {
			closed <- strings.TrimPrefix(name, "ssh:closed:")
		}
		if strings.HasPrefix(name, "ssh:data:") {
			data, _ := base64.StdEncoding.DecodeString(args[0].(string))
			id := strings.TrimPrefix(name, "ssh:data:")
			// Shells query the cursor position on startup; answer so they do not block.
			if strings.Contains(string(data), "\x1b[6n") {
				_ = a.WriteTerminal(id, "\x1b[1;1R")
			}
			events <- event{id, string(data)}
		}
	}
	for _, id := range []string{"local-first", "local-second"} {
		if err := a.ConnectLocalShell(id, shell.ID, TerminalSize{Cols: 100, Rows: 30}); err != nil {
			t.Fatal(err)
		}
	}
	outputs := map[string]string{}
	readUntil := func(id, marker string) {
		t.Helper()
		timer := time.NewTimer(20 * time.Second)
		defer timer.Stop()
		for !strings.Contains(outputs[id], marker) {
			select {
			case item := <-events:
				outputs[item.id] += item.text
			case <-timer.C:
				t.Fatalf("terminal %s missing %s: %q", id, marker, outputs[id])
			}
		}
	}
	sendMarker := func(id, suffix string) {
		t.Helper()
		// Assemble the marker in the shell so echoed input cannot satisfy the check.
		if err := a.WriteTerminal(id, "printf 'marker-%s\\n' '"+suffix+"'\n"); err != nil {
			t.Fatal(err)
		}
		readUntil(id, "marker-"+suffix)
	}
	for _, id := range []string{"local-first", "local-second"} {
		sendMarker(id, id)
		if err := a.ResizeTerminal(id, TerminalSize{Cols: 115, Rows: 35}); err != nil {
			t.Fatal(err)
		}
	}
	if strings.Contains(outputs["local-first"], "marker-local-second") || strings.Contains(outputs["local-second"], "marker-local-first") {
		t.Fatal("terminal output crossed sessions")
	}
	sendMarker("local-second", "中文输出")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := a.WriteTerminal("local-second", "printf 'home-%s\\n' \"$HOME\"\n"); err != nil {
		t.Fatal(err)
	}
	readUntil("local-second", "home-"+home)
	if err := a.ConnectLocalShell("local-second", shell.ID, TerminalSize{}); err == nil {
		t.Fatal("duplicate session ID accepted")
	}
	if err := a.Disconnect("local-first"); err != nil {
		t.Fatal(err)
	}
	if err := a.WriteTerminal("local-first", "closed"); err == nil {
		t.Fatal("closed terminal accepted input")
	}
	sendMarker("local-second", "sibling-survives")
	a.mu.Lock()
	s := a.localSessions["local-second"]
	a.mu.Unlock()
	if err := a.WriteTerminal("local-second", "exit\n"); err != nil {
		t.Fatal(err)
	}
	code, err := s.terminal.Wait()
	if err != nil || code != 0 {
		t.Fatalf("terminal exit = %d, %v", code, err)
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case id := <-closed:
			if id == "local-second" {
				if err := a.WriteTerminal(id, "closed"); err == nil {
					t.Fatal("exited terminal still accepted input")
				}
				return
			}
		case <-timer.C:
			t.Fatal("terminal exit was not reported")
		}
	}
}

func TestDarwinLocalShellValidation(t *testing.T) {
	a := NewApp()
	for _, id := range []string{"", strings.Repeat("x", 129)} {
		if err := a.ConnectLocalShell(id, "zsh", TerminalSize{}); err == nil {
			t.Fatalf("invalid session ID %q accepted", id)
		}
	}
	if err := a.ConnectLocalShell("invalid-shell", "/bin/zsh -c 'echo unexpected'", TerminalSize{}); err == nil {
		t.Fatal("arbitrary shell command accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	a.ctx = ctx
	if err := a.ConnectLocalShell("cancelled", "zsh", TerminalSize{}); err == nil {
		t.Fatal("cancelled session started")
	}
	if len(a.pending) != 0 || len(a.localSessions) != 0 {
		t.Fatal("failed connection leaked session state")
	}
}
