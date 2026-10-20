//go:build !android && !androidtest

package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"orbitssh/src/mcp"
)

// setMCPTestHome isolates the home directory, so the command never touches the
// configuration of the user.
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
			clients := mcp.All()
			for _, client := range clients {
				path, _ := client.ConfigPath("global")
				data, readErr := os.ReadFile(path)
				if readErr != nil {
					t.Fatal(readErr)
				}
				if failure && client.Target() == "claude" {
					if string(data) != `{"private":"secret-value"` {
						t.Fatal("invalid config was overwritten")
					}
					continue
				}
				if !bytes.Contains(data, []byte("http://127.0.0.1:8765/mcp")) || strings.Count(output.String(), "已将 Orbit SSH MCP 接入 "+client.Name()+"：") != 1 {
					t.Fatalf("client not installed exactly once: %s\n%s", client.Name(), &output)
				}
			}
			if !failure {
				output.Reset()
				_, err = runMCPInstallCommandWithConfig([]string{"install", "--target=all", "--yes"}, strings.NewReader(""), &output, configDirectory)
				if err != nil || strings.Count(output.String(), "已接入当前 Orbit SSH MCP") != len(clients) || strings.Contains(output.String(), "原配置备份") {
					t.Fatalf("repeat all install was not idempotent: %v\n%s", err, &output)
				}
			}
		})
	}
}
