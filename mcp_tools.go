package main

import (
	"encoding/json"
	"errors"
)

type mcpToolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type mcpToolResult struct {
	Content           []mcpToolContent `json:"content"`
	StructuredContent any              `json:"structuredContent,omitempty"`
	IsError           bool             `json:"isError,omitempty"`
}

type mcpReadTerminalArgs struct {
	SessionID string `json:"session_id"`
	MaxChars  int    `json:"max_chars"`
}

func mcpToolDefinitions() []map[string]any {
	return []map[string]any{
		{"name": "list_sessions", "description": "列出 Orbit SSH 当前打开的 SSH、本地 Shell 和 WSL 终端会话。", "inputSchema": objectSchema(nil, nil), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "read_terminal", "description": "读取一个活动终端最近的输出文本。输出会去除 ANSI 控制序列；最多返回 100000 个字符。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "max_chars": integerSchema("最多返回的字符数", 100000)}, []string{"session_id"}), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "search_terminal_history", "description": "搜索已保存的终端输出历史；省略 query 时返回最近记录。", "inputSchema": objectSchema(map[string]any{"query": stringSchema("要查找的文字；可省略"), "session_id": stringSchema("仅搜索指定会话的历史；可省略"), "limit": integerSchema("最多返回的记录数", 100)}, nil), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "send_terminal_input", "description": "向一个活动终端发送原样文本。必须先启用偏好设置中的“允许 AI 输入终端”；文本中包含回车或换行时会执行对应命令。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "text": stringSchema("要发送的终端文本；命令执行需自行包含换行")}, []string{"session_id", "text"}), "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false}},
	}
}

func objectSchema(properties map[string]any, required []string) map[string]any {
	if properties == nil {
		properties = map[string]any{}
	}
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func stringSchema(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func integerSchema(description string, maximum int) map[string]any {
	return map[string]any{"type": "integer", "description": description, "minimum": 1, "maximum": maximum}
}

func knownMCPTool(name string) bool {
	switch name {
	case "list_sessions", "read_terminal", "search_terminal_history", "send_terminal_input":
		return true
	default:
		return false
	}
}

func (a *App) callMCPTool(name string, arguments map[string]json.RawMessage) mcpToolResult {
	var value any
	var err error
	switch name {
	case "list_sessions":
		value = map[string]any{"sessions": a.mcpSessions()}
	case "read_terminal":
		var args mcpReadTerminalArgs
		if err = decodeMCPArguments(arguments, &args); err == nil {
			var output string
			var truncated bool
			output, truncated, err = a.readMCPTerminal(args.SessionID, args.MaxChars)
			value = map[string]any{"sessionId": args.SessionID, "output": output, "truncated": truncated}
		}
	case "search_terminal_history":
		var args struct {
			Query     string `json:"query"`
			SessionID string `json:"session_id"`
			Limit     int    `json:"limit"`
		}
		if err = decodeMCPArguments(arguments, &args); err == nil {
			var matches []mcpHistoryMatch
			matches, err = a.searchMCPTerminalHistory(args.Query, args.SessionID, args.Limit)
			value = map[string]any{"results": matches}
		}
	case "send_terminal_input":
		var args struct {
			SessionID string `json:"session_id"`
			Text      string `json:"text"`
		}
		if err = decodeMCPArguments(arguments, &args); err == nil {
			if len(args.Text) == 0 || len(args.Text) > 16*1024 {
				err = errors.New("输入文本应为 1–16384 字节")
			} else if !a.store.snapshot().Preferences.MCPAllowTerminalInput {
				err = errors.New("请先在偏好设置中启用“允许 AI 输入终端”")
			} else {
				err = a.WriteTerminal(args.SessionID, args.Text)
				value = map[string]any{"sent": err == nil, "sessionId": args.SessionID}
			}
		}
	}
	if err != nil {
		return mcpToolResult{Content: []mcpToolContent{{Type: "text", Text: err.Error()}}, IsError: true}
	}
	data, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		return mcpToolResult{Content: []mcpToolContent{{Type: "text", Text: marshalErr.Error()}}, IsError: true}
	}
	return mcpToolResult{Content: []mcpToolContent{{Type: "text", Text: string(data)}}, StructuredContent: value}
}

func decodeMCPArguments(arguments map[string]json.RawMessage, target any) error {
	if arguments == nil {
		arguments = map[string]json.RawMessage{}
	}
	data, err := json.Marshal(arguments)
	if err != nil {
		return errors.New("参数格式无效")
	}
	if err = json.Unmarshal(data, target); err != nil {
		return errors.New("参数格式无效")
	}
	return nil
}
