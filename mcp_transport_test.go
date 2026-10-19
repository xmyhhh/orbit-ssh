package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMCPHTTPTransport(t *testing.T) {
	handler := NewApp().mcpHandler("test-token")
	for _, tc := range []struct {
		name, method, body, auth, origin, contentType, accept string
		status, rpcCode                                       int
	}{
		{name: "ping", status: http.StatusOK},
		{name: "missing token", auth: "none", status: http.StatusUnauthorized},
		{name: "wrong token", auth: "Bearer wrong", status: http.StatusUnauthorized},
		{name: "foreign origin", origin: "https://example.com", status: http.StatusForbidden},
		{name: "local origin", origin: "http://localhost:5180", status: http.StatusOK},
		{name: "wrong content type", contentType: "text/plain", status: http.StatusUnsupportedMediaType},
		{name: "wrong response type", accept: "text/html", status: http.StatusNotAcceptable},
		{name: "get", method: http.MethodGet, status: http.StatusMethodNotAllowed},
		{name: "preflight", method: http.MethodOptions, origin: "http://127.0.0.1:5180", auth: "none", status: http.StatusNoContent},
		{name: "too large", body: strings.Repeat("x", mcpRequestLimit+1), status: http.StatusRequestEntityTooLarge},
		{name: "malformed JSON", body: "{", status: http.StatusOK, rpcCode: -32700},
		{name: "invalid request", body: `{"jsonrpc":"2.0","id":null,"method":"ping"}`, status: http.StatusOK, rpcCode: -32600},
		{name: "unknown method", body: `{"jsonrpc":"2.0","id":1,"method":"unknown"}`, status: http.StatusOK, rpcCode: -32601},
		{name: "unknown tool", body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"unknown"}}`, status: http.StatusOK, rpcCode: -32602},
		{name: "notification", body: `{"jsonrpc":"2.0","method":"notifications/initialized"}`, status: http.StatusAccepted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			method, body := tc.method, tc.body
			if method == "" {
				method = http.MethodPost
			}
			if body == "" {
				body = `{"jsonrpc":"2.0","id":1,"method":"ping"}`
			}
			req := httptest.NewRequest(method, "/mcp", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer test-token")
			req.Header.Set("Content-Type", "application/json")
			if tc.auth == "none" {
				req.Header.Del("Authorization")
			} else if tc.auth != "" {
				req.Header.Set("Authorization", tc.auth)
			}
			if tc.contentType != "" {
				req.Header.Set("Content-Type", tc.contentType)
			}
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("Accept", tc.accept)
			reply := httptest.NewRecorder()
			handler.ServeHTTP(reply, req)
			if reply.Code != tc.status {
				t.Fatalf("HTTP %d: %s", reply.Code, reply.Body.String())
			}
			if tc.status == http.StatusOK {
				var result struct {
					ID    json.RawMessage     `json:"id"`
					Error *struct{ Code int } `json:"error"`
				}
				if err := json.Unmarshal(reply.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if tc.rpcCode != 0 {
					if result.Error == nil || result.Error.Code != tc.rpcCode {
						t.Fatalf("wrong RPC error: %s", reply.Body.String())
					}
				} else if result.Error != nil || string(result.ID) != "1" {
					t.Fatalf("unexpected RPC reply: %s", reply.Body.String())
				}
			}
		})
	}
}

func TestMCPTerminalReadAndHistory(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	buffer := &terminalOutputBuffer{}
	buffer.append([]byte("\x1b[32mhello\x1b[0m\r\n\x1b]0;title\a你好🙂x"))
	a.localSessions = map[string]*localSession{"local": {name: "PowerShell", output: buffer}}
	defer delete(a.localSessions, "local")
	output, truncated, err := a.readMCPTerminal("local", 4)
	if err != nil || !truncated || output != "你好🙂x" {
		t.Fatalf("terminal read: %q, truncated=%v, err=%v", output, truncated, err)
	}
	if _, _, err = a.readMCPTerminal("missing", 4); err == nil {
		t.Fatal("reading a missing session succeeded")
	}
	a.history["old"] = TerminalHistoryRecord{ID: "old", Title: "build", UpdatedAt: 1, Output: "old result"}
	a.history["local"] = TerminalHistoryRecord{ID: "local", Title: "本地 Shell", UpdatedAt: 2, Pinned: true, Output: "\x1b[31m错误：连接失败\x1b[0m"}
	matches, err := a.searchMCPTerminalHistory("错误", "", 10)
	if err != nil || len(matches) != 1 || matches[0].ID != "local" || !matches[0].Pinned || strings.Contains(matches[0].Snippet, "\x1b") {
		t.Fatalf("history search: %+v, err=%v", matches, err)
	}
	result := a.callMCPTool("send_terminal_input", map[string]json.RawMessage{"session_id": json.RawMessage(`"local"`), "text": json.RawMessage(`"echo test\n"`)})
	if !result.IsError || !strings.Contains(result.Content[0].Text, "允许 AI 输入终端") {
		t.Fatalf("terminal input bypassed its preference: %+v", result)
	}
}
