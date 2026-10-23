package app

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func mcpTestArguments(t *testing.T, value any) map[string]json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var args map[string]json.RawMessage
	if err = json.Unmarshal(data, &args); err != nil {
		t.Fatal(err)
	}
	return args
}

func mcpTestHTTPCall(t *testing.T, a *App, name string, args map[string]any) mcpToolResult {
	t.Helper()
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(string(body)))
	request.Header.Set("Authorization", "Bearer test-token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	a.mcpHandler("test-token").ServeHTTP(recorder, request)
	var response struct {
		Result mcpToolResult `json:"result"`
	}
	if recorder.Code != http.StatusOK || json.Unmarshal(recorder.Body.Bytes(), &response) != nil || len(response.Result.Content) == 0 {
		t.Fatalf("unexpected MCP response: %d %s", recorder.Code, recorder.Body.String())
	}
	return response.Result
}

func TestMCPHostConfigurationAndPermissions(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	result := mcpTestHTTPCall(t, a, "list_hosts", nil)
	if result.IsError || !strings.Contains(result.Content[0].Text, "test-host") {
		t.Fatalf("saved hosts unavailable in read-only mode: %+v", result)
	}
	a.store.state.Preferences.MCPAllowTerminalInput = true
	for _, tool := range []string{"create_host", "connect_host"} {
		result = mcpTestHTTPCall(t, a, tool, map[string]any{"address": "example.com", "username": "root", "host_id": "test-host"})
		if !result.IsError || !strings.Contains(result.Content[0].Text, "允许 AI 创建连接") {
			t.Fatalf("%s bypassed connection permission: %+v", tool, result)
		}
	}
	if len(a.store.snapshot().Hosts) != 1 {
		t.Fatal("disabled tool changed saved hosts")
	}
	a.store.state.Preferences.MCPAllowConnections = true
	for _, args := range []map[string]any{
		{"address": "ssh://example.com", "username": "root"},
		{"address": "example.com", "username": "root", "port": 0},
		{"address": "example.com", "username": "root", "port": 65536},
		{"address": "example.com", "username": "root", "auth_type": "key"},
		{"address": "example.com", "username": "root", "auth_type": "other"},
		{"address": "example.com"},
	} {
		if result = mcpTestHTTPCall(t, a, "create_host", args); !result.IsError {
			t.Fatalf("invalid host accepted: %+v", args)
		}
	}
	var emitted Host
	a.emit = func(name string, args ...interface{}) {
		if name == "mcp:host-created" {
			emitted = args[0].(Host)
		}
	}
	result = mcpTestHTTPCall(t, a, "create_host", map[string]any{"address": " example.com ", "username": " root ", "group": "AI"})
	if result.IsError || emitted.ID == "" || emitted.Name != "root@example.com" || emitted.Port != 22 || emitted.AuthType != "password" || emitted.Group != "AI" {
		t.Fatalf("host defaults or UI update missing: %+v %+v", result, emitted)
	}
	result = mcpTestHTTPCall(t, a, "create_host", map[string]any{"name": "Key host", "address": "key.example.com", "username": "tester", "key_path": "C:/keys/id_ed25519"})
	if result.IsError || emitted.AuthType != "key" || emitted.KeyPath != "C:/keys/id_ed25519" {
		t.Fatalf("key authentication was not inferred: %+v %+v", result, emitted)
	}
	reopened, err := openStore(a.store.path)
	if err != nil || len(reopened.snapshot().Hosts) != 3 || reopened.snapshot().Hosts[0].ID != "test-host" {
		t.Fatalf("created hosts were not saved without replacing existing hosts: %v", err)
	}
}

func TestMCPCreateConnectAndShareTerminal(t *testing.T) {
	vault := mockPasswordVault(t)
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	a.store.state.Preferences.MCPEnabled = true
	a.store.state.Preferences.MCPAllowConnections = true
	var eventsMu sync.Mutex
	var publicEvents []string
	a.emit = func(name string, args ...interface{}) {
		data, _ := json.Marshal(args)
		eventsMu.Lock()
		publicEvents = append(publicEvents, name+string(data))
		eventsMu.Unlock()
		if name == "mcp:connect" {
			event := args[0].(mcpConnectionEvent)
			go func() { _ = a.ConnectMCPHost(event.SessionID, TerminalSize{Cols: 80, Rows: 24}) }()
		}
	}
	hostAddress, portText, _ := net.SplitHostPort(address)
	port, _ := strconv.Atoi(portText)
	result := mcpTestHTTPCall(t, a, "create_host", map[string]any{"name": "AI server", "address": hostAddress, "port": port, "username": "tester"})
	if result.IsError {
		t.Fatal(result.Content)
	}
	var created struct{ Host Host }
	if err := json.Unmarshal([]byte(result.Content[0].Text), &created); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"host_id": created.Host.ID, "password": "session-only-secret", "name": "AI build"}
	result = mcpTestHTTPCall(t, a, "connect_host", args)
	if !result.IsError || !strings.Contains(result.Content[0].Text, "HOST_KEY_UNKNOWN|"+fingerprint) || len(a.store.snapshot().KnownHosts) != 0 {
		t.Fatalf("first connection did not enforce host trust: %+v", result)
	}
	args["accepted_fingerprint"] = fingerprint
	result = mcpTestHTTPCall(t, a, "connect_host", args)
	if result.IsError {
		t.Fatal(result.Content)
	}
	var connected struct {
		SessionID   string `json:"sessionId"`
		Name        string `json:"name"`
		DefaultName string `json:"defaultName"`
	}
	if err := json.Unmarshal([]byte(result.Content[0].Text), &connected); err != nil || connected.SessionID == "" {
		t.Fatalf("missing session ID: %+v %v", result, err)
	}
	id := connected.SessionID
	if connected.Name != "AI build" || connected.DefaultName != "AI server" || len(a.mcpSessions()) != 1 || a.mcpSessions()[0].ID != id || a.mcpSessions()[0].Name != "AI build" {
		t.Fatalf("AI-provided name was not applied: %+v %+v", connected, a.mcpSessions())
	}
	input := mcpTestArguments(t, map[string]any{"session_id": id, "text": "AI input\n"})
	if result = a.callMCPTool("send_terminal_input", input); !result.IsError {
		t.Fatal("connection permission implicitly enabled terminal input")
	}
	a.store.mu.Lock()
	a.store.state.Preferences.MCPAllowTerminalInput = true
	a.store.mu.Unlock()
	// Executing text (a newline present) waits for the user dialog now. Answer
	// the request the way the confirmation dialog does.
	approved := make(chan mcpToolResult, 1)
	go func() { approved <- a.callMCPTool("send_terminal_input", input) }()
	var requests []map[string]any
	for deadline := time.Now().Add(2 * time.Second); ; {
		requests = a.ListMCPCommands()
		if len(requests) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("executing input did not wait for approval: %+v", requests)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if requests[0]["command"] != "AI input\n" {
		t.Fatalf("approval payload mismatch: %+v", requests[0])
	}
	if err := a.DecideMCPCommand(requests[0]["id"].(string), true); err != nil {
		t.Fatal(err)
	}
	if result = <-approved; result.IsError {
		t.Fatal(result.Content)
	}
	if err := a.WriteTerminal(id, "human input\n"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		output, _, err := a.readMCPTerminal(id, 1000)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(output, "AI input") && strings.Contains(output, "human input") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("human and AI input did not reach the same terminal: %q", output)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(vault) != 0 {
		t.Fatal("session-only credentials were saved")
	}
	if err := a.SavePassword(created.Host.ID, "session-only-secret"); err != nil {
		t.Fatal(err)
	}
	// A saved host can open another independent terminal using its saved password.
	result = mcpTestHTTPCall(t, a, "connect_host", map[string]any{"host_id": created.Host.ID})
	if result.IsError || len(a.mcpSessions()) != 2 {
		t.Fatalf("saved host did not open a second terminal: %+v", result)
	}
	if err := a.ConnectMCPHost(id, TerminalSize{}); err == nil {
		t.Fatal("completed connection request could be replayed")
	}
	workspace, err := os.ReadFile(a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	eventsMu.Lock()
	defer eventsMu.Unlock()
	if strings.Contains(string(workspace), "session-only-secret") || strings.Contains(strings.Join(publicEvents, "\n"), "session-only-secret") || strings.Contains(result.Content[0].Text, "session-only-secret") {
		t.Fatal("credentials leaked into configuration, UI events or tool response")
	}
}

func TestMCPConnectionCancellationAndRevocation(t *testing.T) {
	for _, action := range []string{"cancel_client", "close_terminal", "revoke_permission"} {
		t.Run(action, func(t *testing.T) {
			mockPasswordVault(t)
			a := testApp(t, "127.0.0.1:22")
			a.store.state.Preferences.MCPAllowConnections = true
			events := make(chan mcpConnectionEvent, 1)
			a.emit = func(name string, args ...interface{}) {
				if name == "mcp:connect" {
					events <- args[0].(mcpConnectionEvent)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := a.connectMCPHost(ctx, mcpConnectHostArgs{HostID: "test-host"})
				done <- err
			}()
			event := <-events
			switch action {
			case "revoke_permission":
				// Permission can be withdrawn after an event, before the UI claims it.
				a.store.mu.Lock()
				a.store.state.Preferences.MCPAllowConnections = false
				a.store.mu.Unlock()
				if err := a.ConnectMCPHost(event.SessionID, TerminalSize{}); err == nil {
					t.Fatal("queued connection ignored revoked permission")
				}
			case "close_terminal":
				if err := a.Disconnect(event.SessionID); err != nil {
					t.Fatal(err)
				}
			default:
				cancel()
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("cancelled connection succeeded")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("cancelled connection did not finish")
			}
			if err := a.ConnectMCPHost(event.SessionID, TerminalSize{}); err == nil {
				t.Fatal("cancelled request could be started later")
			}
			a.mu.Lock()
			defer a.mu.Unlock()
			if len(a.mcpConnections) != 0 || len(a.pending) != 0 || len(a.sessions) != 0 {
				t.Fatal("cancelled request left a pending connection or terminal")
			}
		})
	}
}

func TestMCPCancelSSHHandshake(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	a := testApp(t, listener.Addr().String())
	a.store.state.Preferences.MCPAllowConnections = true
	events := make(chan mcpConnectionEvent, 1)
	started := make(chan error, 1)
	a.emit = func(name string, args ...interface{}) {
		if name == "mcp:connect" {
			event := args[0].(mcpConnectionEvent)
			events <- event
			go func() { started <- a.ConnectMCPHost(event.SessionID, TerminalSize{}) }()
		}
	}
	done := make(chan error, 1)
	go func() {
		_, err := a.connectMCPHost(context.Background(), mcpConnectHostArgs{HostID: "test-host", Password: "session-only-secret"})
		done <- err
	}()
	event := <-events
	select {
	case conn := <-accepted:
		defer conn.Close()
	case <-time.After(3 * time.Second):
		t.Fatal("SSH handshake did not start")
	}
	if err := a.Disconnect(event.SessionID); err != nil {
		t.Fatal(err)
	}
	for _, result := range []<-chan error{done, started} {
		select {
		case err := <-result:
			if err == nil {
				t.Fatal("cancelled SSH handshake succeeded")
			}
		case <-time.After(3 * time.Second):
			t.Fatal("cancelled SSH handshake remained blocked")
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.sessions) != 0 || len(a.pending) != 0 || len(a.mcpConnections) != 0 {
		t.Fatal("cancelled SSH handshake left a connection behind")
	}
}
