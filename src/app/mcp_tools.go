package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
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
		{"name": "list_hosts", "description": "列出已保存的 SSH 主机配置，可用返回的 id 调用 connect_host。仅返回配置，不包含密码、私钥内容或口令。", "inputSchema": objectSchema(nil, nil), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "create_host", "description": "添加并保存 SSH 主机配置，然后可调用 connect_host 建立连接。需启用“允许 AI 创建连接”。不覆盖已有主机，不保存登录密码或私钥口令。", "inputSchema": objectSchema(map[string]any{
			"name": stringSchema("主机名称；省略时使用 用户名@地址"), "address": stringSchema("IP 地址或域名，不含 ssh:// 或端口"),
			"port": integerSchema("SSH 端口；默认 22", 65535), "username": stringSchema("SSH 登录用户名"),
			"auth_type":    map[string]any{"type": "string", "enum": []string{"password", "key", "agent"}, "description": "认证方式；提供 key_path 时默认为 key，否则为 password"},
			"key_path":     stringSchema("本机 SSH 私钥路径；key 认证必填，不是私钥内容"),
			"jump_host_id": stringSchema("已保存的跳板机主机 id；省略时直连目标主机"),
			"group":        stringSchema("主机分组；可省略"),
		}, []string{"address", "username"}), "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false}},
		{"name": "connect_host", "description": "为已保存主机新建独立 SSH 终端，并在 Orbit SSH 窗口显示，返回 sessionId 后可读写该终端。需启用“允许 AI 创建连接”并保持应用界面运行。可选 name 为新终端命名；不提供时使用主机名称。优先使用本机保存的凭据；也可提供仅本次使用的 password 或 passphrase。首次连接若返回 HOST_KEY_UNKNOWN，核对指纹后传 accepted_fingerprint 重试；已知指纹变化始终拒绝。", "inputSchema": objectSchema(map[string]any{
			"host_id": stringSchema("list_hosts 或 create_host 返回的主机 id"), "name": stringSchema("新终端会话名称；最多 80 个字符，省略时使用主机名称"),
			"password":   stringSchema("仅本次连接使用的登录密码；省略时使用已保存密码"),
			"passphrase": stringSchema("仅本次连接使用的私钥口令；省略时使用已保存口令"), "accepted_fingerprint": stringSchema("已核对的首次连接 SHA256 指纹；已信任主机可省略"),
		}, []string{"host_id"}), "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false}},
		{"name": "list_sessions", "description": "列出 Orbit SSH 当前打开的 SSH、本地 Shell 和 WSL 终端会话，包括自定义名称和默认名称。unrestricted 为 true 表示用户对该窗口开启了完全放行，MCP 输入不再弹确认；没有特殊需求时，优先把命令发送到 unrestricted 会话。", "inputSchema": objectSchema(nil, nil), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "rename_session", "description": "重命名一个活动终端会话。名称会显示在终端标签、分屏标题和终端历史中，并与 list_sessions 同步。传空名称可恢复默认名称。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "name": stringSchema("新的会话名称；最多 80 个字符，留空恢复默认名称")}, []string{"session_id", "name"}), "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true}},
		{"name": "read_terminal", "description": "读取一个活动终端最近的输出文本。输出会去除 ANSI 控制序列；最多返回 100000 个字符。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "max_chars": integerSchema("最多返回的字符数", 100000)}, []string{"session_id"}), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "search_terminal_history", "description": "搜索已保存的终端输出历史；省略 query 时返回最近记录。", "inputSchema": objectSchema(map[string]any{"query": stringSchema("要查找的文字；可省略"), "session_id": stringSchema("仅搜索指定会话的历史；可省略"), "limit": integerSchema("最多返回的记录数", 100)}, nil), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "send_terminal_input", "description": "向一个活动终端发送原样文本。必须先启用偏好设置中的“允许 AI 输入终端”。包含换行或回车的文本等同于执行命令，需要用户在 Orbit SSH 界面确认后才会发送；用户对窗口开启完全放行后无需确认。无换行的文本（交互应答、不完整命令）直接输入，不弹确认。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "text": stringSchema("要发送的终端文本；命令执行需自行包含换行")}, []string{"session_id", "text"}), "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false}},
		{"name": "list_directory", "description": "列出远程目录内容。需启用“允许 AI 访问文件”。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "path": stringSchema("远程绝对路径；省略时使用登录目录")}, []string{"session_id"}), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "read_file", "description": "读取远程文本文件，最多 512 KB。二进制内容以 base64 返回。需启用“允许 AI 访问文件”。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "path": stringSchema("远程绝对路径")}, []string{"session_id", "path"}), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "write_file", "description": "用给定 UTF-8 内容覆盖远程文本文件。需同时启用“允许 AI 访问文件”和“允许 AI 输入终端”。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "path": stringSchema("远程绝对路径"), "content": stringSchema("完整的新文件内容，最多 2 MB")}, []string{"session_id", "path", "content"}), "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true}},
		{"name": "get_metrics", "description": "读取服务器 CPU、内存、磁盘、网络速率、磁盘 I/O、温度和前 500 个进程。只读。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID")}, []string{"session_id"}), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false}},
		{"name": "kill_process", "description": "向远程进程发送 TERM、KILL、HUP 等信号。需启用“允许 AI 输入终端”。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "pid": integerSchema("目标进程 ID", 4194304), "signal": map[string]any{"type": "string", "enum": []string{"TERM", "KILL", "HUP", "INT", "QUIT", "STOP", "CONT", "USR1", "USR2"}, "description": "信号；默认 TERM"}}, []string{"session_id", "pid"}), "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false}},
		{"name": "run_command", "description": "提议一条命令，在 Orbit SSH 界面等待用户确认后才发送到终端；用户对窗口开启完全放行后直接发送。需启用“允许 AI 输入终端”。确认后使用 read_terminal 查看结果。", "inputSchema": objectSchema(map[string]any{"session_id": stringSchema("Orbit SSH 会话 ID"), "command": stringSchema("要执行的命令，不含结尾换行")}, []string{"session_id", "command"}), "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false}},
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
	case "list_hosts", "create_host", "connect_host", "list_sessions", "rename_session", "read_terminal", "search_terminal_history", "send_terminal_input",
		"list_directory", "read_file", "write_file", "get_metrics", "kill_process", "run_command":
		return true
	default:
		return false
	}
}

func (a *App) callMCPTool(name string, arguments map[string]json.RawMessage) mcpToolResult {
	return a.callMCPToolContext(context.Background(), name, arguments)
}

func (a *App) callMCPToolContext(ctx context.Context, name string, arguments map[string]json.RawMessage) mcpToolResult {
	var value any
	var err error
	switch name {
	case "list_hosts":
		if err = a.ready(); err == nil {
			value = map[string]any{"hosts": a.store.snapshot().Hosts}
		}
	case "create_host":
		var args mcpCreateHostArgs
		if err = decodeMCPArguments(arguments, &args); err == nil {
			var host Host
			host, err = a.createMCPHost(args)
			value = map[string]any{"host": host}
		}
	case "connect_host":
		var args mcpConnectHostArgs
		if err = decodeMCPArguments(arguments, &args); err == nil {
			var id string
			id, err = a.connectMCPHost(ctx, args)
			name, defaultName := a.sessionNames(id)
			value = map[string]any{"sessionId": id, "hostId": args.HostID, "name": name, "defaultName": defaultName, "status": "connected"}
		}
	case "list_sessions":
		value = map[string]any{"sessions": a.mcpSessions()}
	case "rename_session":
		var args struct {
			SessionID string `json:"session_id"`
			Name      string `json:"name"`
		}
		if err = decodeMCPArguments(arguments, &args); err == nil {
			if err = a.RenameSession(args.SessionID, args.Name); err == nil {
				name, defaultName := a.sessionNames(args.SessionID)
				value = map[string]any{"sessionId": args.SessionID, "name": name, "defaultName": defaultName}
			}
		}
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
			} else if strings.ContainsAny(args.Text, "\r\n") {
				// Text with a newline is executed, so it goes through the
				// same approval dialog (or full consent) as run_command. The
				// text is sent verbatim; no newline is appended.
				var message string
				message, err = a.requestMCPCommand(ctx, args.SessionID, args.Text)
				value = map[string]any{"sent": err == nil, "sessionId": args.SessionID, "message": message}
			} else {
				var auth mcpTerminalAuthorization
				auth, err = a.authorizeMCPInput(ctx, args.SessionID)
				if err == nil {
					err = a.writeMCPTerminal(ctx, args.SessionID, args.Text, auth, false)
				}
				value = map[string]any{"sent": err == nil, "sessionId": args.SessionID}
			}
		}
	case "list_directory":
		var args struct {
			SessionID string `json:"session_id"`
			Path      string `json:"path"`
		}
		if err = decodeMCPArguments(arguments, &args); err == nil {
			if err = a.allowMCPFiles(); err == nil {
				value, err = a.mcpListDirectory(args.SessionID, args.Path)
			}
		}
	case "read_file":
		var args struct {
			SessionID string `json:"session_id"`
			Path      string `json:"path"`
		}
		if err = decodeMCPArguments(arguments, &args); err == nil {
			if err = a.allowMCPFiles(); err == nil {
				value, err = a.mcpReadFile(args.SessionID, args.Path)
			}
		}
	case "write_file":
		var args struct {
			SessionID string `json:"session_id"`
			Path      string `json:"path"`
			Content   string `json:"content"`
		}
		if err = decodeMCPArguments(arguments, &args); err == nil {
			if err = a.allowMCPFiles(); err == nil {
				value, err = a.mcpWriteFile(args.SessionID, args.Path, args.Content)
			}
		}
	case "get_metrics":
		var args struct {
			SessionID string `json:"session_id"`
		}
		if err = decodeMCPArguments(arguments, &args); err == nil {
			var metrics Metrics
			metrics, err = a.mcpMetrics(args.SessionID)
			value = map[string]any{"metrics": metrics}
		}
	case "kill_process":
		var args struct {
			SessionID string `json:"session_id"`
			PID       int    `json:"pid"`
			Signal    string `json:"signal"`
		}
		if err = decodeMCPArguments(arguments, &args); err == nil {
			value, err = a.mcpKillProcess(args.SessionID, args.PID, args.Signal)
		}
	case "run_command":
		var args struct {
			SessionID string `json:"session_id"`
			Command   string `json:"command"`
		}
		if err = decodeMCPArguments(arguments, &args); err == nil {
			if len(args.Command) == 0 || len(args.Command) > mcpCommandMaxBytes {
				err = errors.New("命令长度应为 1–4096 字节")
			} else if !a.store.snapshot().Preferences.MCPAllowTerminalInput {
				err = errors.New("请先在偏好设置中启用“允许 AI 输入终端”")
			} else {
				var message string
				// The trailing newline is added here, while the approval
				// payload shows the plain command.
				message, err = a.requestMCPCommand(ctx, args.SessionID, args.Command+"\n")
				value = map[string]any{"approved": err == nil, "message": message, "sessionId": args.SessionID}
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
