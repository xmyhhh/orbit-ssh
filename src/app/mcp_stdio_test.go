//go:build !android && !androidtest

package app

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProxyMCPStdio(t *testing.T) {
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected forwarded request: %s %#v", r.Method, r.Header)
		}
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode forwarded request: %v", err)
			return
		}
		methods = append(methods, request.Method)
		if len(request.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"method\":%q}}\n", request.ID, request.Method)
	}))
	defer server.Close()

	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize"}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
	}, "\n")
	var output strings.Builder
	client := newMCPStdioHTTPClient()
	if client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("stdio bridge must bypass proxy configuration")
	}
	if err := proxyMCPStdio(strings.NewReader(input), &output, server.URL, "test-token", client); err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(strings.Join(methods, ","), "initialize,notifications/initialized,tools/list") {
		t.Fatalf("wrong forwarded methods: %v", methods)
	}
	reader := bufio.NewReader(strings.NewReader(output.String()))
	for _, method := range []string{"initialize", "tools/list"} {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read %s response: %v", method, err)
		}
		var response struct {
			Result map[string]string `json:"result"`
		}
		if err = json.Unmarshal([]byte(line), &response); err != nil || response.Result["method"] != method {
			t.Fatalf("wrong %s response: %q (%v)", method, line, err)
		}
	}
	if _, err := reader.ReadString('\n'); err != io.EOF {
		t.Fatalf("notification unexpectedly produced stdio output: %v", err)
	}
}

func TestReadMCPStdioMessageLimit(t *testing.T) {
	reader := bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", mcpRequestLimit+1)+"\n"), 32*1024)
	if _, err := readMCPStdioMessage(reader); err == nil {
		t.Fatal("oversized MCP message was accepted")
	}
}
