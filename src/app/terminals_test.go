package app

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestSameHostIndependentTerminals(t *testing.T) {
	mockPasswordVault(t)
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	type terminalEvent struct{ id, text string }
	events := make(chan terminalEvent, 32)
	a.emit = func(name string, args ...interface{}) {
		if strings.HasPrefix(name, "ssh:data:") {
			data, _ := base64.StdEncoding.DecodeString(args[0].(string))
			events <- terminalEvent{strings.TrimPrefix(name, "ssh:data:"), string(data)}
		}
	}
	if err := a.Connect("first", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	if err := a.SavePassword("test-host", "session-only-secret"); err != nil {
		t.Fatal(err)
	}
	// Additional terminals use the same host and saved credential, with unique IDs.
	results := make(chan error, 2)
	for _, id := range []string{"second", "third"} {
		go func() { results <- a.Connect(id, "test-host", Credentials{}, "", TerminalSize{}) }()
	}
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	outputs := map[string]string{}
	readUntil := func(id, marker string) {
		t.Helper()
		timer := time.NewTimer(3 * time.Second)
		defer timer.Stop()
		for !strings.Contains(outputs[id], marker) {
			select {
			case event := <-events:
				outputs[event.id] += event.text
			case <-timer.C:
				t.Fatalf("terminal %s did not receive its own output", id)
			}
		}
	}
	for _, id := range []string{"first", "second", "third"} {
		marker := "only-" + id
		if err := a.WriteTerminal(id, marker+"\r"); err != nil {
			t.Fatal(err)
		}
		readUntil(id, marker)
	}
	for id, output := range outputs {
		for _, other := range []string{"first", "second", "third"} {
			if id != other && strings.Contains(output, "only-"+other) {
				t.Fatalf("output from %s reached %s", other, id)
			}
		}
	}
	if err := a.Disconnect("second"); err != nil {
		t.Fatal(err)
	}
	if err := a.WriteTerminal("second", "closed"); err == nil {
		t.Fatal("closed terminal still accepted input")
	}
	for _, id := range []string{"first", "third"} {
		if err := a.WriteTerminal(id, "survives-"+id+"\r"); err != nil {
			t.Fatal(err)
		}
		readUntil(id, "survives-"+id)
		if err := a.ResizeTerminal(id, TerminalSize{Cols: 120, Rows: 32}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.Monitor("third"); err != nil {
		t.Fatalf("closing a sibling interrupted monitoring: %v", err)
	}
	if _, err := a.ListDirectory("first", ""); err != nil {
		t.Fatalf("closing a sibling interrupted SFTP: %v", err)
	}
	if err := a.Disconnect("first"); err != nil {
		t.Fatal(err)
	}
	if err := a.WriteTerminal("third", "last-terminal\r"); err != nil {
		t.Fatal(err)
	}
	readUntil("third", "last-terminal")
}
