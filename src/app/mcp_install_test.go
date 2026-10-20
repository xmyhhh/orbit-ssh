//go:build !android && !androidtest

package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPInstallCLI(t *testing.T) {
	for _, tc := range []struct {
		name, answer string
		args         []string
		wantError    bool
		wantInstall  bool
	}{
		{name: "unattended", args: []string{"install", "--target=codex", "--location=global", "--yes"}, wantInstall: true},
		{name: "confirmed", args: []string{"install"}, answer: "yes\n", wantInstall: true},
		{name: "cancelled", args: []string{"install"}, answer: "n\n"},
		{name: "no input", args: []string{"install"}},
		{name: "help", args: []string{"install", "--help"}},
		{name: "unsupported target", args: []string{"install", "--target=other", "--yes"}, wantError: true},
		{name: "unsupported location", args: []string{"install", "--location=other", "--yes"}, wantError: true},
		{name: "positional arguments", args: []string{"install", "--yes", "extra"}, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			codexRoot := filepath.Join(root, "codex")
			t.Setenv("CODEX_HOME", codexRoot)
			var output bytes.Buffer
			handled, err := runMCPInstallCommandWithConfig(tc.args, strings.NewReader(tc.answer), &output, func() (string, error) { return root, nil })
			if !handled || (err != nil) != tc.wantError {
				t.Fatalf("command result: handled=%v, err=%v\n%s", handled, err, &output)
			}
			path := filepath.Join(codexRoot, "config.toml")
			data, readErr := os.ReadFile(path)
			if tc.wantInstall {
				if readErr != nil || !bytes.Contains(data, []byte("http://127.0.0.1:8765/mcp")) {
					t.Fatalf("command did not install: %v", readErr)
				}
				token, tokenErr := os.ReadFile(filepath.Join(root, "OrbitSSH", "mcp-token"))
				if tokenErr != nil || !bytes.Contains(data, bytes.TrimSpace(token)) || strings.Contains(output.String(), string(bytes.TrimSpace(token))) {
					t.Fatalf("token was not installed or was printed to the terminal: %v", tokenErr)
				}
				if !strings.Contains(output.String(), "重启 Codex") {
					t.Fatal("missing restart guidance")
				}
			} else {
				files, dirErr := os.ReadDir(root)
				if !os.IsNotExist(readErr) || dirErr != nil || len(files) != 0 {
					t.Fatalf("cancel/help/rejected command wrote files: %v, %v", files, readErr)
				}
			}
		})
	}
	var output bytes.Buffer
	if handled, err := runMCPInstallCommand(nil, strings.NewReader(""), &output); handled || err != nil || output.Len() != 0 {
		t.Fatal("normal GUI launch was intercepted")
	}
}
