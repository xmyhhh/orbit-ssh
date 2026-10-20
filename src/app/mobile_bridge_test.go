//go:build androidtest

package app

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"orbitssh/src/mobile"
)

func TestMobileCallValidation(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	for _, tc := range []struct{ method, args string }{
		{"shutdown", "[]"}, {"native", "[]"}, {"SaveHost", "[]"},
		{"SaveHost", `["bad"]`}, {"LoadState", "{}"}, {"Connect", "[null]"},
	} {
		if _, err := mobileCall(a, tc.method, json.RawMessage(tc.args)); err == nil {
			t.Fatalf("accepted invalid request: %+v", tc)
		}
	}
	if _, err := mobileCall(a, "LoadState", json.RawMessage("[]")); err != nil {
		t.Fatal(err)
	}
}

func TestMobileTerminalHistoryAPI(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	a.historyDir = t.TempDir()
	call := func(method string, args ...interface{}) {
		t.Helper()
		if _, err := mobileCall(a, method, mobile.Marshal(args)); err != nil {
			t.Fatalf("%s: %v", method, err)
		}
	}
	record := TerminalHistoryRecord{ID: "mobile-history", Title: "Android terminal", Output: "hello", UpdatedAt: 1}
	call("SyncTerminalHistory", []TerminalHistoryRecord{record})
	call("AppendTerminalHistory", record, " world", []string{record.ID})
	records := a.terminalHistorySnapshot()
	if len(records) != 1 || records[0].Output != "hello world" {
		t.Fatalf("history append did not reach the shared backend: %+v", records)
	}
	record = records[0]
	record.Name = "手机终端"
	call("UpsertTerminalHistory", record, []string{record.ID})
	record.Pinned = true
	call("UpsertTerminalHistory", record, []string{record.ID})
	if !a.terminalHistorySnapshot()[0].Pinned {
		t.Fatal("mobile history pin was not saved")
	}
	a.flushTerminalHistory()
	reloaded := NewApp()
	reloaded.historyDir = a.historyDir
	if err := reloaded.loadTerminalHistory(); err != nil {
		t.Fatal(err)
	}
	if saved := reloaded.terminalHistorySnapshot(); len(saved) != 1 || saved[0].Output != "hello world" || !saved[0].Pinned || saved[0].Name != "手机终端" {
		t.Fatalf("mobile history was not persisted across a backend restart: %+v", saved)
	}
	call("DeleteTerminalHistory", record.ID)
	call("AppendTerminalHistory", record, "late output", []string{record.ID})
	if len(a.terminalHistorySnapshot()) != 0 {
		t.Fatal("late output recreated deleted mobile history")
	}
	a.flushTerminalHistory()
	if err := reloaded.loadTerminalHistory(); err != nil {
		t.Fatal(err)
	}
	if len(reloaded.terminalHistorySnapshot()) != 0 {
		t.Fatal("deleted mobile history remained on disk")
	}
}

// Exercise the actual Android pipe protocol against a local SSH/SFTP server,
// including asynchronous output, DNS callbacks and the native credential vault.
func TestMobilePipeSSHAndCredentials(t *testing.T) {
	address, fingerprint := testSSHServer(t)
	_, portText, _ := net.SplitHostPort(address)
	port, _ := strconv.Atoi(portText)
	configDir, filesDir := t.TempDir(), t.TempDir()
	input, requests := io.Pipe()
	responses, output := io.Pipe()
	finished := make(chan error, 1)
	go func() {
		finished <- RunMobile(input, output, configDir, filesDir)
		output.Close()
	}()
	t.Cleanup(func() {
		requests.Close()
		responses.Close()
		select {
		case err := <-finished:
			if err != nil {
				t.Errorf("backend shutdown: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("backend did not stop after pipe EOF")
		}
	})
	messages := make(chan mobile.Message, 64)
	go func() {
		defer close(messages)
		scanner := bufio.NewScanner(responses)
		for scanner.Scan() {
			var message mobile.Message
			if json.Unmarshal(scanner.Bytes(), &message) == nil {
				messages <- message
			}
		}
	}()
	encoder := json.NewEncoder(requests)
	vault := map[string]string{}
	var events []mobile.Message
	read := func() mobile.Message {
		t.Helper()
		for {
			var message mobile.Message
			select {
			case value, ok := <-messages:
				if !ok {
					t.Fatal("backend pipe closed unexpectedly")
				}
				message = value
			case <-time.After(10 * time.Second):
				t.Fatal("backend request timed out")
			}
			if message.Type != "native" {
				return message
			}
			// The arguments differ per native operation, so decode them lazily.
			var args []json.RawMessage
			if err := json.Unmarshal(message.Args, &args); err != nil {
				t.Fatal(err)
			}
			text := func(index int) string {
				t.Helper()
				var value string
				if err := json.Unmarshal(args[index], &value); err != nil {
					t.Fatal(err)
				}
				return value
			}
			reply := mobile.Message{Type: "nativeResult", ID: message.ID}
			var value interface{} = ""
			switch message.Method {
			case "resolve":
				value = []string{"127.0.0.1"}
			case "setBackground":
				// The backend reports how many sessions keep the host alive.
				var count int
				if err := json.Unmarshal(args[0], &count); err != nil {
					t.Fatal(err)
				}
			case "vaultGet":
				var ok bool
				value, ok = vault[text(0)]
				if !ok {
					reply.Error = "CREDENTIAL_NOT_FOUND"
				}
			case "vaultSet":
				vault[text(0)] = text(1)
			case "vaultDelete":
				delete(vault, text(0))
			default:
				t.Fatalf("unexpected native operation: %s", message.Method)
			}
			reply.Data = mobile.Marshal(value)
			if err := encoder.Encode(reply); err != nil {
				t.Fatal(err)
			}
		}
	}
	if message := read(); message.Type != "ready" {
		t.Fatalf("startup: %+v", message)
	}
	sequence := 0
	call := func(method string, args ...interface{}) mobile.Message {
		t.Helper()
		sequence++
		id := strconv.Itoa(sequence)
		if err := encoder.Encode(mobile.Message{Type: "call", ID: id, Method: method, Args: mobile.Marshal(args)}); err != nil {
			t.Fatal(err)
		}
		for {
			message := read()
			if message.Type == "event" {
				events = append(events, message)
				continue
			}
			if message.Type != "result" || message.ID != id {
				t.Fatalf("unexpected reply: %+v", message)
			}
			return message
		}
	}
	ok := func(method string, args ...interface{}) mobile.Message {
		t.Helper()
		reply := call(method, args...)
		if reply.Error != "" {
			t.Fatalf("%s: %s", method, reply.Error)
		}
		return reply
	}
	ok("SaveHost", Host{ID: "mobile", Name: "Mobile test", Address: "ssh-test.invalid", Port: port, Username: "tester", AuthType: "password"})
	if reply := call("Connect", "terminal", "mobile", Credentials{Password: "session-only-secret"}, "", TerminalSize{}); !strings.Contains(reply.Error, "HOST_KEY_UNKNOWN|"+fingerprint) {
		t.Fatalf("untrusted host accepted: %+v", reply)
	}
	ok("Connect", "terminal", "mobile", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{})
	ok("SavePassword", "mobile", "session-only-secret")
	if reply := ok("HasSavedPassword", "mobile"); string(reply.Data) != "true" {
		t.Fatalf("saved password missing: %+v", reply)
	}
	ok("WriteTerminal", "terminal", "mobile-echo-你好")
	var echoed strings.Builder
	for !strings.Contains(echoed.String(), "mobile-echo-你好") {
		if len(events) == 0 {
			events = append(events, read())
		}
		event := events[0]
		events = events[1:]
		if event.Name != "ssh:data:terminal" {
			continue
		}
		var args []string
		json.Unmarshal(event.Args, &args)
		data, _ := base64.StdEncoding.DecodeString(args[0])
		echoed.Write(data)
	}
	var directory Directory
	if err := json.Unmarshal(ok("ListDirectory", "terminal", "").Data, &directory); err != nil || directory.Path == "" {
		t.Fatalf("SFTP directory: %+v %v", directory, err)
	}
	ok("Disconnect", "terminal")
	ok("Connect", "saved-login", "mobile", Credentials{}, "", TerminalSize{})
	ok("Disconnect", "saved-login")
	workspace, err := os.ReadFile(filepath.Join(configDir, "OrbitSSH", "workspace.json"))
	if err != nil || bytes.Contains(workspace, []byte("session-only-secret")) {
		t.Fatalf("workspace contains credentials or cannot be read: %v", err)
	}
	ok("ForgetPassword", "mobile")
	if reply := ok("HasSavedPassword", "mobile"); string(reply.Data) != "false" {
		t.Fatalf("credential not cleared: %+v", reply)
	}
}
