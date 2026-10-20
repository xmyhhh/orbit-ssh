//go:build !android && !androidtest

package mcp

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestUpdateCodexMCPConfig(t *testing.T) {
	for _, tc := range []struct {
		name, original string
		preserved      []string
	}{
		{name: "new config"},
		{
			name:      "other MCP servers and CRLF",
			original:  "# user's settings\r\nmodel = 'example'\r\n\r\n[mcp_servers]\r\n[mcp_servers.node_repl]\r\ncommand = 'C:\\tools\\node.exe' # keep this\r\nargs = []\r\n\r\n[projects.'F:\\work']\r\ntrust_level = 'trusted'\r\n",
			preserved: []string{"# user's settings\r\nmodel = 'example'\r\n", "[mcp_servers]\r\n[mcp_servers.node_repl]\r\ncommand = 'C:\\tools\\node.exe' # keep this\r\nargs = []\r\n", "[projects.'F:\\work']\r\ntrust_level = 'trusted'\r\n"},
		},
		{
			name:      "header inside multiline string",
			original:  "instructions = '''\n[mcp_servers.orbit-ssh]\nurl = 'this is text, not a server'\n'''\n[mcp_servers.orbit-ssh]\nurl = 'http://127.0.0.1:1111/mcp'\nhttp_headers = { Authorization = 'Bearer old' }\n[features]\nkeep = true\n",
			preserved: []string{"instructions = '''\n[mcp_servers.orbit-ssh]\nurl = 'this is text, not a server'\n'''\n", "[features]\nkeep = true\n"},
		},
		{
			name:      "quoted table and separate headers",
			original:  "[mcp_servers.\"orbit-ssh\"]\nurl = 'old'\nenabled = false\n[mcp_servers.other]\nurl = 'https://example.com/mcp'\n[mcp_servers.\"orbit-ssh\".http_headers]\nAuthorization = 'old'\n",
			preserved: []string{"[mcp_servers.other]\nurl = 'https://example.com/mcp'\n"},
		},
		{
			name:      "inline server under parent",
			original:  "[mcp_servers]\norbit-ssh = { url = 'old', http_headers = { Authorization = 'old' } }\nother = { command = 'other' }\n",
			preserved: []string{"[mcp_servers]\n", "other = { command = 'other' }\n"},
		},
		{
			name:      "dotted keys",
			original:  "mcp_servers.orbit-ssh.url = 'old'\nmcp_servers.orbit-ssh.http_headers.Authorization = 'old'\nmcp_servers.other.command = 'other'\n",
			preserved: []string{"mcp_servers.other.command = 'other'\n"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			original := []byte(tc.original)
			const endpoint = "http://127.0.0.1:9876/mcp"
			const token = "token-with-\"quotes\"\\and-newline\n"
			updated, err := updateCodexMCPConfig(original, endpoint, token)
			if err != nil {
				t.Fatal(err)
			}
			for _, text := range tc.preserved {
				if !bytes.Contains(updated, []byte(text)) {
					t.Fatalf("unrelated content changed: %q\n%s", text, updated)
				}
			}
			var config map[string]any
			if err = toml.Unmarshal(updated, &config); err != nil {
				t.Fatal(err)
			}
			entry := config["mcp_servers"].(map[string]any)["orbit-ssh"].(map[string]any)
			if entry["url"] != endpoint || entry["enabled"] != true || entry["http_headers"].(map[string]any)["Authorization"] != "Bearer "+token {
				t.Fatalf("wrong installed entry: %#v", entry)
			}
			again, err := updateCodexMCPConfig(updated, endpoint, token)
			if err != nil || !bytes.Equal(updated, again) {
				t.Fatalf("second install changed the configuration: %v", err)
			}
		})
	}
}

func TestCodexMCPUpdatePreservesPolicies(t *testing.T) {
	original := []byte(`[mcp_servers.orbit-ssh]
command = "old-transport"
args = ["serve"]
bearer_token_env_var = "OLD_TOKEN"
http_headers_helper = "old-helper"
enabled = false
startup_timeout_sec = 30
enabled_tools = ["list_sessions", "read_terminal"]
http_headers = { authorization = "old", "X-Custom" = "keep" }
env_http_headers = { AUTHORIZATION = "OLD_TOKEN", "X-Env" = "KEEP_ENV" }
[mcp_servers.orbit-ssh.tools.read_terminal]
approval_mode = "prompt"
`)
	updated, err := updateCodexMCPConfig(original, "http://127.0.0.1:8765/mcp", "new-token")
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err = toml.Unmarshal(updated, &config); err != nil {
		t.Fatal(err)
	}
	entry := config["mcp_servers"].(map[string]any)["orbit-ssh"].(map[string]any)
	for _, key := range []string{"command", "args", "bearer_token_env_var", "http_headers_helper"} {
		if _, exists := entry[key]; exists {
			t.Fatalf("obsolete authentication/transport setting remains: %s", key)
		}
	}
	if entry["startup_timeout_sec"] != int64(30) || !reflect.DeepEqual(entry["enabled_tools"], []any{"list_sessions", "read_terminal"}) {
		t.Fatalf("user tool policies were lost: %#v", entry)
	}
	if got := entry["http_headers"]; !reflect.DeepEqual(got, map[string]any{"Authorization": "Bearer new-token", "X-Custom": "keep"}) {
		t.Fatalf("incorrect static headers: %#v", got)
	}
	if got := entry["env_http_headers"]; !reflect.DeepEqual(got, map[string]any{"X-Env": "KEEP_ENV"}) {
		t.Fatalf("incorrect environment headers: %#v", got)
	}
	tool := entry["tools"].(map[string]any)["read_terminal"].(map[string]any)
	if tool["approval_mode"] != "prompt" {
		t.Fatalf("tool approval policy changed: %#v", tool)
	}
}

func TestCodexMCPInstallBackupAndRepeat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "codex", "config.toml")
	first, err := installCodexMCPConfig(path, "http://127.0.0.1:8765/mcp", "first-token")
	if err != nil || !first.Changed || first.BackupPath != "" {
		t.Fatalf("new config: %+v, %v", first, err)
	}
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := installCodexMCPConfig(path, "http://127.0.0.1:9876/mcp", "second-token")
	if err != nil || !second.Changed || second.BackupPath == "" {
		t.Fatalf("update: %+v, %v", second, err)
	}
	backup, err := os.ReadFile(second.BackupPath)
	if err != nil || !bytes.Equal(backup, original) {
		t.Fatalf("backup did not preserve original file: %v", err)
	}
	updated, err := os.ReadFile(path)
	if err != nil || bytes.Contains(updated, []byte("first-token")) || !bytes.Contains(updated, []byte("second-token")) {
		t.Fatalf("credentials were not updated: %v", err)
	}
	third, err := installCodexMCPConfig(path, "http://127.0.0.1:9876/mcp", "second-token")
	if err != nil || third.Changed || third.BackupPath != "" {
		t.Fatalf("idempotent install: %+v, %v", third, err)
	}
	files, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(files) != 2 {
		t.Fatalf("unexpected backup or temporary files: %v, %v", files, err)
	}
}

func TestCodexMCPInstallRejectsUnsafeMerge(t *testing.T) {
	for _, original := range []string{
		"invalid = \"secret-value\n",
		"[mcp_servers]\norbit-ssh = false\n",
		"mcp_servers = { other = { command = 'keep' } }\n",
		"[mcp_servers.orbit-ssh]\nurl = 'old'\n[mcp_servers.orbit-ssh]\nurl = 'duplicate'\n",
	} {
		t.Run(original, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "config.toml")
			if err := os.WriteFile(path, []byte(original), 0600); err != nil {
				t.Fatal(err)
			}
			result, err := installCodexMCPConfig(path, "http://127.0.0.1:8765/mcp", "new-token")
			if err == nil || result.Changed || strings.Contains(err.Error(), "secret-value") {
				t.Fatalf("unsafe merge was accepted or exposed credentials: %+v, %v", result, err)
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil || string(data) != original {
				t.Fatalf("rejected merge changed the file: %v", readErr)
			}
			files, readErr := os.ReadDir(dir)
			if readErr != nil || len(files) != 1 {
				t.Fatalf("rejected merge wrote files: %v, %v", files, readErr)
			}
		})
	}
}

func TestCodexMCPConfigLocations(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CODEX_HOME", root)
	global, err := CodexConfigPath("global")
	if err != nil || global != filepath.Join(root, "config.toml") {
		t.Fatalf("CODEX_HOME was not respected: %q, %v", global, err)
	}
	local, err := CodexConfigPath("local")
	wantLocal, _ := filepath.Abs(filepath.Join(".codex", "config.toml"))
	if err != nil || local != wantLocal || local == global {
		t.Fatalf("wrong project config: %q, %v", local, err)
	}
}
