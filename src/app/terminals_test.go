package app

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSSHReconnectReusesIDAfterExitAndFailure(t *testing.T) {
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	credentials := Credentials{Password: "session-only-secret"}
	closed := make(chan string, 8)
	data := make(chan string, 32)
	a.emit = func(name string, args ...interface{}) {
		if name == "ssh:closed:original" {
			closed <- args[0].(string)
		}
		if name == "ssh:data:original" {
			bytes, _ := base64.StdEncoding.DecodeString(args[0].(string))
			data <- string(bytes)
		}
	}
	connect := func() *remoteSession {
		t.Helper()
		if err := a.Connect("original", "test-host", credentials, fingerprint, TerminalSize{}); err != nil {
			t.Fatal(err)
		}
		s, err := a.session("original")
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	readMarker := func(marker string) {
		t.Helper()
		if err := a.WriteTerminal("original", marker); err != nil {
			t.Fatal(err)
		}
		select {
		case value := <-data:
			if value != marker {
				t.Fatalf("output = %q, want %q", value, marker)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("reconnected terminal did not accept input")
		}
	}
	first := connect()
	readMarker("before-disconnect")
	// Simulate a lost transport, not the UI's explicit Disconnect action.
	first.client.Close()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("transport loss was not reported")
	}
	if err := a.Connect("original", "test-host", Credentials{Password: "wrong"}, "", TerminalSize{}); err == nil {
		t.Fatal("reconnect bypassed authentication")
	}
	second := connect()
	if first == second {
		t.Fatal("reconnect reused the dead SSH transport")
	}
	readMarker("after-reconnect")
	if err := a.ResizeTerminal("original", TerminalSize{Cols: 120, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	if err := a.RenameSession("original", "发布验收"); err != nil {
		t.Fatal(err)
	}
	if name, _ := a.sessionNames("original"); name != "发布验收" {
		t.Fatalf("restored name = %q", name)
	}
	if _, err := a.ListDirectory("original", ""); err != nil {
		t.Fatalf("SFTP did not recover: %v", err)
	}
	// Immediate reuse after explicit cancellation must not receive late close events.
	for i := 0; i < 3; i++ {
		if err := a.Disconnect("original"); err != nil {
			t.Fatal(err)
		}
		select {
		case <-closed:
		default:
			t.Fatal("Disconnect returned before the old close event was drained")
		}
		connect()
		readMarker(fmt.Sprintf("retry-%d", i))
		select {
		case message := <-closed:
			t.Fatalf("old connection closed its replacement: %s", message)
		default:
		}
	}
}

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
