//go:build !android && !androidtest

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/tailscale/hujson"
)

func decodeMCPJSON(t *testing.T, data []byte) map[string]any {
	t.Helper()
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	standard, err := hujson.Standardize(bytes.Clone(data))
	if err != nil {
		t.Fatalf("invalid JSONC: %v\n%s", err, data)
	}
	var config map[string]any
	if err := json.Unmarshal(standard, &config); err != nil {
		t.Fatal(err)
	}
	return config
}

func TestMCPJSONClientTransportsAndMerge(t *testing.T) {
	const endpoint = "http://127.0.0.1:9876/mcp"
	const token = "token-with-\"quotes\"\\and-newline\n"
	for _, client := range mcpClients[1:] {
		t.Run(client.target, func(t *testing.T) {
			for _, fixture := range []struct{ name, data string }{
				{"empty", ""},
				{"new namespace", "{\r\n  // keep login settings\r\n  \"apiKey\": \"keep-private\",\r\n  \"hugeNumber\": 9007199254740993,\r\n}\r\n"},
				{"empty namespace with comments", "{\n  \"" + client.namespace + "\": { /* keep comment */ }\n}\n"},
				{"existing servers without trailing comma", "{\n  \"" + client.namespace + "\": {\n    \"other\": { \"command\" : \"keep\" } // keep trailing comment\n  }\n}\n"},
				{"existing servers with trailing comma", "{\r\n  \"" + client.namespace + "\": {\r\n    \"other\": { \"command\" : \"keep\" }, // keep trailing comment\r\n  },\r\n}\r\n"},
				{"replace Orbit only", "{\n  \"" + client.namespace + "\": {\n    \"other\": { \"command\" : \"keep\" },\n    // keep Orbit comment\n    \"orbit-ssh\": {\"command\":\"old\",\"args\":[\"serve\"],\"env\":{\"OLD\":\"secret\"},\"environment\":{},\"disabled\":true,\"url\":\"old\",\"httpUrl\":\"old\",\"type\":\"stdio\",\"oauth\":{},\"timeout\":30000,\"trust\":false,\"includeTools\":[\"list_sessions\"],\"headers\":{\"AUTHORIZATION\":\"old\",\"X-Custom\":\"keep\"}},\n  },\n  \"last\": true // keep final setting\n}\n"},
				{"BOM", "\xef\xbb\xbf{\"" + client.namespace + "\":{}}\r\n"},
			} {
				t.Run(fixture.name, func(t *testing.T) {
					original := []byte(fixture.data)
					updated, err := client.updateConfig(original, endpoint, token)
					if err != nil {
						t.Fatal(err)
					}
					if string(original) != fixture.data {
						t.Fatal("update mutated the original buffer needed for backup")
					}
					config := decodeMCPJSON(t, updated)
					entry := config[client.namespace].(map[string]any)["orbit-ssh"].(map[string]any)
					urlField := "url"
					if client.target == "gemini" {
						urlField = "httpUrl"
						if _, exists := entry["url"]; exists {
							t.Fatal("Gemini would use SSE instead of Streamable HTTP")
						}
					}
					if entry[urlField] != endpoint || entry["headers"].(map[string]any)["Authorization"] != "Bearer "+token {
						t.Fatalf("wrong HTTP configuration: %#v", entry)
					}
					if client.target == "claude" || client.target == "vscode" {
						if entry["type"] != "http" {
							t.Fatalf("missing HTTP type: %#v", entry)
						}
					}
					if client.target == "opencode" && (entry["type"] != "remote" || entry["enabled"] != true || entry["oauth"] != false) {
						t.Fatalf("wrong OpenCode remote configuration: %#v", entry)
					}
					for _, key := range []string{"command", "args", "env", "environment"} {
						if _, exists := entry[key]; exists {
							t.Fatalf("obsolete local transport remains: %s", key)
						}
					}
					for _, keep := range []string{"// keep login settings", `"apiKey": "keep-private"`, `9007199254740993`, "/* keep comment */", `"other": { "command" : "keep" }`, "// keep trailing comment", "// keep Orbit comment", `"last": true // keep final setting`} {
						if strings.Contains(fixture.data, keep) && !bytes.Contains(updated, []byte(keep)) {
							t.Fatalf("unrelated content lost: %s\n%s", keep, updated)
						}
					}
					if fixture.name == "replace Orbit only" {
						if entry["timeout"] != float64(30000) || entry["trust"] != false || entry["disabled"] != false || !reflect.DeepEqual(entry["includeTools"], []any{"list_sessions"}) {
							t.Fatalf("tool policy or timeout changed: %#v", entry)
						}
						if !reflect.DeepEqual(entry["headers"], map[string]any{"Authorization": "Bearer " + token, "X-Custom": "keep"}) {
							t.Fatalf("incorrect headers: %#v", entry["headers"])
						}
					}
					if strings.HasPrefix(fixture.data, "\xef\xbb\xbf") && !bytes.HasPrefix(updated, []byte{0xef, 0xbb, 0xbf}) {
						t.Fatal("BOM was lost")
					}
					if strings.Contains(fixture.data, "\r\n") && bytes.Contains(bytes.ReplaceAll(updated, []byte("\r\n"), nil), []byte("\n")) {
						t.Fatal("CRLF format was lost")
					}
					again, err := client.updateConfig(updated, endpoint, token)
					if err != nil || !bytes.Equal(updated, again) {
						t.Fatalf("repeat install changed configuration: %v", err)
					}
				})
			}
		})
	}
}

func TestMCPJSONRejectsAmbiguousConfigWithoutWriting(t *testing.T) {
	client, _ := findMCPClient("opencode")
	for _, original := range []string{
		`{"secret":"private-value",`,
		`[]`, `null`,
		`{"mcp":null}`, `{"mcp":[]}`,
		`{"mcp":{"orbit-ssh":false}}`,
		`{"mcp":{"orbit-ssh":{"headers":[]}}}`,
		`{"mcp":{},"mcp":{"other":{}}}`,
		`{"mcp":{"orbit-ssh":{},"orbit\u002dssh":{}}}`,
		`{"mcp":{"orbit-ssh":{"headers":{"Authorization":"old","Authorization":"duplicate"}}}}`,
	} {
		t.Run(original, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "opencode.jsonc")
			if err := os.WriteFile(path, []byte(original), 0600); err != nil {
				t.Fatal(err)
			}
			result, err := client.install(path, "http://127.0.0.1:8765/mcp", "new-token")
			if err == nil || result.Changed || strings.Contains(err.Error(), "private-value") {
				t.Fatalf("unsafe merge accepted or credentials exposed: %+v, %v", result, err)
			}
			data, readErr := os.ReadFile(path)
			files, dirErr := os.ReadDir(dir)
			if readErr != nil || dirErr != nil || string(data) != original || len(files) != 1 {
				t.Fatalf("rejected merge touched original: %v, %v", readErr, dirErr)
			}
		})
	}
}

func setMCPTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	for _, key := range []string{"CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"} {
		t.Setenv(key, "")
	}
	return home
}

func TestMCPClientConfigLocations(t *testing.T) {
	home := setMCPTestHome(t)
	project := t.TempDir()
	t.Chdir(project)
	globalVSCode := filepath.Join(home, ".config", "Code", "User", "mcp.json")
	if runtime.GOOS == "windows" {
		globalVSCode = filepath.Join(home, "AppData", "Roaming", "Code", "User", "mcp.json")
	} else if runtime.GOOS == "darwin" {
		globalVSCode = filepath.Join(home, "Library", "Application Support", "Code", "User", "mcp.json")
	}
	for _, tc := range []struct{ target, global, local string }{
		{"codex", filepath.Join(home, ".codex", "config.toml"), filepath.Join(project, ".codex", "config.toml")},
		{"claude", filepath.Join(home, ".claude.json"), filepath.Join(project, ".mcp.json")},
		{"cursor", filepath.Join(home, ".cursor", "mcp.json"), filepath.Join(project, ".cursor", "mcp.json")},
		{"opencode", filepath.Join(home, ".config", "opencode", "opencode.json"), filepath.Join(project, "opencode.json")},
		{"gemini", filepath.Join(home, ".gemini", "settings.json"), filepath.Join(project, ".gemini", "settings.json")},
		{"vscode", globalVSCode, filepath.Join(project, ".vscode", "mcp.json")},
	} {
		client, _ := findMCPClient(tc.target)
		for location, expected := range map[string]string{"global": tc.global, "local": tc.local} {
			path, err := client.configPath(location)
			if err != nil || path != expected {
				t.Fatalf("%s %s path = %q, want %q (%v)", tc.target, location, path, expected, err)
			}
		}
	}
	for _, tc := range []struct{ target, env, relative string }{
		{"codex", "CODEX_HOME", "config.toml"},
		{"claude", "CLAUDE_CONFIG_DIR", ".claude.json"},
		{"opencode", "XDG_CONFIG_HOME", filepath.Join("opencode", "opencode.json")},
		{"opencode", "OPENCODE_CONFIG_DIR", "opencode.json"},
		{"opencode", "OPENCODE_CONFIG", ""},
	} {
		t.Run(tc.env, func(t *testing.T) {
			root := filepath.Join(home, tc.env)
			t.Setenv(tc.env, root)
			client, _ := findMCPClient(tc.target)
			path, err := client.configPath("global")
			if err != nil || path != filepath.Join(root, tc.relative) {
				t.Fatalf("override ignored: %q, %v", path, err)
			}
		})
	}
	if err := os.WriteFile(filepath.Join(project, "opencode.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "opencode.jsonc"), []byte(`{/* preferred */}`), 0600); err != nil {
		t.Fatal(err)
	}
	client, _ := findMCPClient("opencode")
	path, err := client.configPath("local")
	if err != nil || path != filepath.Join(project, "opencode.jsonc") {
		t.Fatalf("higher priority JSONC file ignored: %q, %v", path, err)
	}
}

func TestMCPInstallCLIAllAndPartialFailure(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(map[bool]string{false: "all", true: "partial failure"}[failure], func(t *testing.T) {
			home := setMCPTestHome(t)
			t.Chdir(t.TempDir())
			if failure {
				if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"private":"secret-value"`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			var output bytes.Buffer
			configDirectory := func() (string, error) { return filepath.Join(home, "orbit-config"), nil }
			handled, err := runMCPInstallCommandWithConfig([]string{"install", "--target=all,codex,claude-code", "--yes"}, strings.NewReader(""), &output, configDirectory)
			if !handled || (err != nil) != failure {
				t.Fatalf("wrong command result: %v, %v", handled, err)
			}
			if failure && (!strings.Contains(err.Error(), "Claude Code") || strings.Contains(err.Error(), "secret-value")) {
				t.Fatalf("failure missing client name or exposed credentials: %v", err)
			}
			for _, client := range mcpClients {
				path, _ := client.configPath("global")
				data, readErr := os.ReadFile(path)
				if readErr != nil {
					t.Fatal(readErr)
				}
				if failure && client.target == "claude" {
					if string(data) != `{"private":"secret-value"` {
						t.Fatal("invalid config was overwritten")
					}
					continue
				}
				if !bytes.Contains(data, []byte("http://127.0.0.1:8765/mcp")) || strings.Count(output.String(), "已将 Orbit SSH MCP 接入 "+client.name+"：") != 1 {
					t.Fatalf("client not installed exactly once: %s\n%s", client.name, &output)
				}
			}
			if !failure {
				output.Reset()
				_, err = runMCPInstallCommandWithConfig([]string{"install", "--target=all", "--yes"}, strings.NewReader(""), &output, configDirectory)
				if err != nil || strings.Count(output.String(), "已接入当前 Orbit SSH MCP") != len(mcpClients) || strings.Contains(output.String(), "原配置备份") {
					t.Fatalf("repeat all install was not idempotent: %v\n%s", err, &output)
				}
			}
		})
	}
}

func TestMCPClientSelection(t *testing.T) {
	clients, err := selectMCPClients("claude-code, OpenCode,gemini-cli,copilot-vscode,claude")
	if err != nil || len(clients) != 4 || clients[0].target != "claude" || clients[1].target != "opencode" || clients[2].target != "gemini" || clients[3].target != "vscode" {
		t.Fatalf("wrong client selection: %v, %v", clients, err)
	}
	for _, targets := range []string{"", "codex,", "opencode,unknown"} {
		if _, err := selectMCPClients(targets); err == nil {
			t.Fatalf("invalid targets accepted: %q", targets)
		}
	}
}
