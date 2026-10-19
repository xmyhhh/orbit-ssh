package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMCPFileToolsRequirePermission(t *testing.T) {
	a := testAppWithStore(t)
	args := map[string]json.RawMessage{
		"session_id": json.RawMessage(`"missing"`),
		"path":       json.RawMessage(`"/tmp/file"`),
	}
	result := a.callMCPTool("list_directory", args)
	if !result.IsError || !strings.Contains(result.Content[0].Text, "允许 AI 访问文件") {
		t.Fatalf("file access was not gated: %+v", result)
	}
	preferences := a.store.snapshot().Preferences
	preferences.MCPAllowFileAccess = true
	if err := a.SavePreferences(preferences); err != nil {
		t.Fatal(err)
	}
	result = a.callMCPTool("list_directory", args)
	if !result.IsError || strings.Contains(result.Content[0].Text, "允许 AI 访问文件") {
		t.Fatalf("file access stayed gated after enabling: %+v", result)
	}
}

func TestMCPWriteFileAlsoRequiresTerminalInput(t *testing.T) {
	a := testAppWithStore(t)
	preferences := a.store.snapshot().Preferences
	preferences.MCPAllowFileAccess = true
	if err := a.SavePreferences(preferences); err != nil {
		t.Fatal(err)
	}
	_, err := a.mcpWriteFile("missing", "/tmp/file", "content")
	if err == nil || !strings.Contains(err.Error(), "允许 AI 输入终端") {
		t.Fatalf("write_file did not require terminal input: %v", err)
	}
}

func TestValidateRemoteName(t *testing.T) {
	for _, name := range []string{"", ".", "..", "a/b", `a\b`, "with\x00nul", strings.Repeat("x", 256)} {
		if err := validateRemoteName(name); err == nil {
			t.Fatalf("invalid name accepted: %q", name)
		}
	}
	for _, name := range []string{"file.txt", "我的文档", ".hidden"} {
		if err := validateRemoteName(name); err != nil {
			t.Fatalf("valid name rejected: %q: %v", name, err)
		}
	}
}
