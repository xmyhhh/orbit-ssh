package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNormalizeMCPReason(t *testing.T) {
	cases := []struct {
		name    string
		reason  string
		want    string
		wantErr string
	}{
		{name: "empty", reason: "", want: ""},
		{name: "spaces only", reason: " \n\t ", want: ""},
		{name: "trimmed", reason: "  检查磁盘用量  ", want: "检查磁盘用量"},
		{name: "collapses whitespace", reason: "查看\n磁盘  用量", want: "查看 磁盘 用量"},
		{name: "Chinese at the limit", reason: strings.Repeat("文", mcpReasonMaxChars), want: strings.Repeat("文", mcpReasonMaxChars)},
		{name: "Chinese over the limit", reason: strings.Repeat("文", mcpReasonMaxChars+1), wantErr: "当前 36 个"},
		{name: "English at the word limit", reason: strings.Repeat("word ", mcpReasonMaxWords), want: strings.TrimSpace(strings.Repeat("word ", mcpReasonMaxWords))},
		{name: "English over the word limit", reason: strings.Repeat("word ", mcpReasonMaxWords+1), wantErr: "当前 36 个"},
		{name: "control character", reason: "查看\x00磁盘", wantErr: "无效字符"},
		{name: "mixed text counts as Chinese", reason: "inspect " + strings.Repeat("文", mcpReasonMaxChars), wantErr: "当前 43 个"},
		{name: "single long token", reason: strings.Repeat("x", mcpReasonMaxEnglishRunes+1), wantErr: "必须简短于 35 个单词"},
		{name: "long English sentence is too long", reason: "Because the database replica is lagging behind and the user reported slow responses during the morning peak, please restart the replica service now and then wait for it to catch up before checking the queue depth and the replication status one more time after the restart completes.", wantErr: "当前 47 个"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeMCPReason(tc.reason)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("expected %q, got %q (err %v)", tc.wantErr, got, err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("normalizeMCPReason(%q) = %q, %v; want %q", tc.reason, got, err, tc.want)
			}
		})
	}
}

func TestMCPReasonRejectsOverlongReasonBeforeQueueing(t *testing.T) {
	for _, tool := range []string{"run_command", "send_terminal_input"} {
		t.Run(tool, func(t *testing.T) {
			a, terminal := unrestrictedTestApp(t, "local")
			queued := make(chan map[string]any, 8)
			a.emit = func(name string, args ...interface{}) {
				if name == "mcp:command-request" {
					queued <- args[0].(map[string]any)
				}
			}
			arguments := map[string]json.RawMessage{
				"session_id": json.RawMessage(`"local"`),
				"reason":     json.RawMessage(`"` + strings.Repeat("文", mcpReasonMaxChars+1) + `"`),
			}
			if tool == "run_command" {
				arguments["command"] = json.RawMessage(`"ls"`)
			} else {
				arguments["text"] = json.RawMessage(`"ls\n"`)
			}
			result := a.callMCPTool(tool, arguments)
			if !result.IsError || !strings.Contains(result.Content[0].Text, "简短于 35") {
				t.Fatalf("overlong reason was accepted: %+v", result)
			}
			if len(queued) != 0 || len(a.ListMCPCommands()) != 0 {
				t.Fatal("rejected reason queued an approval")
			}
			if terminal.joined() != "" {
				t.Fatalf("rejected reason wrote to the terminal: %q", terminal.joined())
			}
		})
	}
}

func TestMCPReasonReachesApprovalPayloadAndDialog(t *testing.T) {
	for _, tool := range []string{"run_command", "send_terminal_input"} {
		t.Run(tool, func(t *testing.T) {
			a, terminal := unrestrictedTestApp(t, "local")
			// requestMCPCommand refuses to queue without an UI bridge, so
			// install a no-op emitter just as the real app does.
			a.emit = func(string, ...interface{}) {}
			done := make(chan mcpToolResult, 1)
			arguments := map[string]json.RawMessage{
				"session_id": json.RawMessage(`"local"`), "reason": json.RawMessage(`"更新软件包索引"`),
			}
			if tool == "run_command" {
				arguments["command"] = json.RawMessage(`"ls"`)
			} else {
				arguments["text"] = json.RawMessage(`"ls\n"`)
			}
			go func() { done <- a.callMCPTool(tool, arguments) }()
			var pending map[string]any
			for deadline := time.Now().Add(2 * time.Second); ; {
				if commands := a.ListMCPCommands(); len(commands) == 1 {
					pending = commands[0]
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("approval was not queued")
				}
				time.Sleep(10 * time.Millisecond)
			}
			reason, _ := pending["reason"].(string)
			if reason != "更新软件包索引" {
				t.Fatalf("reason missing from ListMCPCommands: %+v", pending)
			}
			if err := a.DecideMCPCommand(pending["id"].(string), true); err != nil {
				t.Fatal(err)
			}
			if result := <-done; result.IsError {
				t.Fatal(result.Content)
			}
			if terminal.joined() != "ls\n" {
				t.Fatalf("unexpected terminal write: %q", terminal.joined())
			}
		})
	}
}

func TestMCPReasonEventMatchesListMCPCommands(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	type payloads struct {
		event map[string]any
	}
	seen := make(chan payloads, 1)
	a.emit = func(name string, args ...interface{}) {
		if name == "mcp:command-request" {
			seen <- payloads{event: args[0].(map[string]any)}
		}
	}
	done := make(chan mcpToolResult, 1)
	go func() {
		done <- a.callMCPTool("run_command", map[string]json.RawMessage{
			"session_id": json.RawMessage(`"local"`), "command": json.RawMessage(`"ls"`),
			"reason": json.RawMessage(`"  inspect   the disk  "`),
		})
	}()
	payload := <-seen
	if payload.event["reason"] != "inspect the disk" {
		t.Fatalf("event reason was not normalized: %+v", payload.event)
	}
	commands := a.ListMCPCommands()
	if len(commands) != 1 || commands[0]["reason"] != payload.event["reason"] {
		t.Fatalf("event and listing disagree: %+v %+v", payload.event, commands)
	}
	if err := a.DecideMCPCommand(commands[0]["id"].(string), true); err != nil {
		t.Fatal(err)
	}
	if result := <-done; result.IsError || terminal.joined() != "ls\n" {
		t.Fatalf("approved command failed: %+v %q", result, terminal.joined())
	}
}

func TestMCPReasonIsOptional(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	a.emit = func(string, ...interface{}) {}
	done := make(chan mcpToolResult, 1)
	go func() {
		done <- a.callMCPTool("run_command", map[string]json.RawMessage{
			"session_id": json.RawMessage(`"local"`), "command": json.RawMessage(`"ls"`),
		})
	}()
	var pending map[string]any
	for deadline := time.Now().Add(2 * time.Second); ; {
		if commands := a.ListMCPCommands(); len(commands) == 1 {
			pending = commands[0]
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("approval was not queued")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if reason, ok := pending["reason"]; ok && reason != "" {
		t.Fatalf("missing reason should stay empty: %+v", pending)
	}
	if err := a.DecideMCPCommand(pending["id"].(string), true); err != nil {
		t.Fatal(err)
	}
	if result := <-done; result.IsError || terminal.joined() != "ls\n" {
		t.Fatalf("command without a reason failed: %+v %q", result, terminal.joined())
	}
}

func TestMCPUnrestrictedConsumesReasonWithoutDialog(t *testing.T) {
	a, terminal := unrestrictedTestApp(t, "local")
	if err := a.SetSessionMCPUnrestricted("local", true); err != nil {
		t.Fatal(err)
	}
	result := a.callMCPTool("run_command", map[string]json.RawMessage{
		"session_id": json.RawMessage(`"local"`), "command": json.RawMessage(`"ls"`),
		"reason": json.RawMessage(`"` + strings.Repeat("文", mcpReasonMaxChars) + `"`),
	})
	if result.IsError || terminal.joined() != "ls\n" {
		t.Fatalf("full consent rejected a valid reason: %+v %q", result, terminal.joined())
	}
}

func TestMCPReasonLimitsAreDocumented(t *testing.T) {
	for _, tool := range mcpToolDefinitions() {
		name := tool["name"].(string)
		properties := tool["inputSchema"].(map[string]any)["properties"].(map[string]any)
		reason, ok := properties["reason"].(map[string]any)
		if name != "run_command" && name != "send_terminal_input" {
			if ok {
				t.Fatalf("%s unexpectedly accepts a reason", name)
			}
			continue
		}
		if !ok || reason["type"] != "string" {
			t.Fatalf("%s has no reason schema: %+v", name, tool)
		}
		description, _ := reason["description"].(string)
		// The schema is what the AI client reads, so the limit and the
		// "optional" nature must be spelled out there.
		for _, want := range []string{"35 个字符", "35 个单词", "可选", "留空"} {
			if !strings.Contains(description, want) {
				t.Fatalf("%s reason schema missing %q: %q", name, want, description)
			}
		}
		toolDescription, _ := tool["description"].(string)
		if !strings.Contains(toolDescription, "reason") {
			t.Fatalf("%s description does not mention the reason: %q", name, toolDescription)
		}
	}
}
