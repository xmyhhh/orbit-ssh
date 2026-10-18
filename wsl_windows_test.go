//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exercise the actual ConPTY used by WSL without requiring an installed distro.
func TestWindowsLocalTerminals(t *testing.T) {
	a := NewApp()
	a.ctx = context.Background()
	a.localSessions = map[string]*localSession{}
	t.Cleanup(func() { a.shutdown(context.Background()) })
	type event struct{ id, text string }
	events := make(chan event, 128)
	a.emit = func(name string, args ...interface{}) {
		if strings.HasPrefix(name, "ssh:data:") {
			data, _ := base64.StdEncoding.DecodeString(args[0].(string))
			id := strings.TrimPrefix(name, "ssh:data:")
			if strings.Contains(string(data), "\x1b[6n") {
				_ = a.WriteTerminal(id, "\x1b[1;1R")
			}
			events <- event{id, string(data)}
		}
	}
	for _, id := range []string{"local-first", "local-second"} {
		terminal, err := startWindowsTerminal(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), []string{"/D", "/Q"}, TerminalSize{Cols: 100, Rows: 30})
		if err != nil {
			t.Fatal(err)
		}
		s := &localSession{terminal: terminal}
		a.localSessions[id] = s
	}
	for id, s := range a.localSessions {
		a.streamLocalTerminal(id, s)
	}
	outputs := map[string]string{}
	readUntil := func(id, marker string) {
		t.Helper()
		timer := time.NewTimer(8 * time.Second)
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
	for _, id := range []string{"local-first", "local-second"} {
		if err := a.WriteTerminal(id, "echo marker-"+id+"\r"); err != nil {
			t.Fatal(err)
		}
		readUntil(id, "marker-"+id)
		if err := a.ResizeTerminal(id, TerminalSize{Cols: 115, Rows: 35}); err != nil {
			t.Fatal(err)
		}
	}
	if strings.Contains(outputs["local-first"], "marker-local-second") {
		t.Fatal("terminal output crossed sessions")
	}
	if err := a.Disconnect("local-first"); err != nil {
		t.Fatal(err)
	}
	if err := a.WriteTerminal("local-first", "closed"); err == nil {
		t.Fatal("closed terminal accepted input")
	}
	if err := a.WriteTerminal("local-second", "echo sibling-survives\r"); err != nil {
		t.Fatal(err)
	}
	readUntil("local-second", "sibling-survives")
	a.mu.Lock()
	s := a.localSessions["local-second"]
	a.mu.Unlock()
	if err := a.WriteTerminal("local-second", "exit\r"); err != nil {
		t.Fatal(err)
	}
	code, err := s.terminal.Wait()
	if err != nil || code != 0 {
		t.Fatalf("terminal exit = %d, %v", code, err)
	}
}
