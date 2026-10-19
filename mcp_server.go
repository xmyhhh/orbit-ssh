package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const mcpProtocolVersion = "2025-06-18"
const mcpRequestLimit = 1024 * 1024

type MCPStatus struct {
	Enabled      bool   `json:"enabled"`
	Running      bool   `json:"running"`
	AllowInput   bool   `json:"allowInput"`
	Endpoint     string `json:"endpoint"`
	Token        string `json:"token"`
	Error        string `json:"error"`
	HistoryError string `json:"historyError"`
}

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type mcpResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  any    `json:"result,omitempty"`
	Error   any    `json:"error,omitempty"`
}

type mcpToolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type mcpToolResult struct {
	Content           []mcpToolContent `json:"content"`
	StructuredContent any              `json:"structuredContent,omitempty"`
	IsError           bool             `json:"isError,omitempty"`
}

type mcpSessionInfo struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Address  string `json:"address,omitempty"`
	Username string `json:"username,omitempty"`
	Status   string `json:"status"`
}

type mcpHistoryMatch struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Subtitle       string `json:"subtitle"`
	TerminalNumber int    `json:"terminalNumber"`
	UpdatedAt      int64  `json:"updatedAt"`
	Pinned         bool   `json:"pinned"`
	Truncated      bool   `json:"truncated"`
	Snippet        string `json:"snippet"`
}

type mcpHistoryAppendArgs struct {
	SessionID string `json:"session_id"`
	MaxChars  int    `json:"max_chars"`
}

var (
	ansiOSC  = regexp.MustCompile(`\x1b\][^\x07]*(?:\x07|\x1b\\)`)
	ansiCSI  = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	ansiChar = regexp.MustCompile(`\x1b[()][0-2A-Za-z]`)
	ansiEsc  = regexp.MustCompile(`\x1b.`)
)

func loadOrCreateMCPToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		token := strings.TrimSpace(string(data))
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(token)
		if decodeErr != nil || len(decoded) != 32 {
			return "", errors.New("本机 MCP 令牌文件格式无效")
		}
		return token, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return loadOrCreateMCPToken(path)
	}
	if err != nil {
		return "", err
	}
	if _, err = file.WriteString(token + "\n"); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		_ = os.Remove(path)
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	return token, nil
}

func (a *App) configureMCP(preferences Preferences) error {
	a.mcpMu.Lock()
	if !preferences.MCPEnabled {
		server := a.mcpServer
		a.mcpServer = nil
		a.mcpListener = nil
		a.mcpPort = 0
		a.mcpError = ""
		a.mcpMu.Unlock()
		shutdownMCPServer(server)
		return nil
	}
	if a.mcpToken == "" {
		message := a.mcpError
		if message == "" {
			message = "无法读取本机 MCP 令牌"
		}
		a.mcpMu.Unlock()
		return errors.New(message)
	}
	if a.mcpServer != nil && a.mcpPort == preferences.MCPPort {
		a.mcpError = ""
		a.mcpMu.Unlock()
		return nil
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(preferences.MCPPort)))
	if err != nil {
		message := fmt.Sprintf("无法监听 MCP 端口 %d：%v", preferences.MCPPort, err)
		a.mcpError = message
		a.mcpMu.Unlock()
		return errors.New(message)
	}
	server := &http.Server{
		Handler:           a.mcpHandler(a.mcpToken),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	old := a.mcpServer
	a.mcpServer = server
	a.mcpListener = listener
	a.mcpPort = preferences.MCPPort
	a.mcpError = ""
	a.mcpMu.Unlock()
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			a.mcpMu.Lock()
			if a.mcpServer == server {
				a.mcpError = serveErr.Error()
				a.mcpServer = nil
				a.mcpListener = nil
				a.mcpPort = 0
			}
			a.mcpMu.Unlock()
		}
	}()
	shutdownMCPServer(old)
	return nil
}

func shutdownMCPServer(server *http.Server) {
	if server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		_ = server.Close()
	}
}

func (a *App) stopMCP() {
	a.mcpMu.Lock()
	server := a.mcpServer
	a.mcpServer = nil
	a.mcpListener = nil
	a.mcpPort = 0
	a.mcpMu.Unlock()
	shutdownMCPServer(server)
}

func (a *App) GetMCPStatus() MCPStatus {
	status := MCPStatus{}
	if a.store != nil {
		preferences := a.store.snapshot().Preferences
		status.Enabled = preferences.MCPEnabled
		status.AllowInput = preferences.MCPAllowTerminalInput
		status.Endpoint = fmt.Sprintf("http://127.0.0.1:%d/mcp", preferences.MCPPort)
	}
	a.mcpMu.Lock()
	status.Running = a.mcpServer != nil
	if a.mcpError != "" {
		status.Error = a.mcpError
	} else if a.mcpToken == "" {
		status.Error = "无法初始化本机 MCP 令牌"
	}
	status.Token = a.mcpToken
	a.mcpMu.Unlock()
	a.historyMu.RLock()
	status.HistoryError = a.historyLoadError
	if a.historyStoreError != "" {
		status.HistoryError = a.historyStoreError
	}
	a.historyMu.RUnlock()
	return status
}

func (a *App) mcpHandler(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if !isLocalMCPOrigin(origin) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST, OPTIONS")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !validMCPAuthorization(r.Header.Get("Authorization"), token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if mediaErr != nil || mediaType != "application/json" {
			http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		if !acceptsMCPResponse(r.Header.Get("Accept")) {
			http.Error(w, "accept must include application/json or text/event-stream", http.StatusNotAcceptable)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, mcpRequestLimit+1))
		if err != nil {
			http.Error(w, "could not read request", http.StatusBadRequest)
			return
		}
		if len(body) > mcpRequestLimit {
			http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			return
		}
		var request mcpRequest
		if err = json.Unmarshal(body, &request); err != nil {
			writeMCPJSON(w, http.StatusOK, mcpResponse{JSONRPC: "2.0", ID: nil, Error: map[string]any{"code": -32700, "message": "Parse error"}})
			return
		}
		if request.JSONRPC != "2.0" || request.Method == "" || (len(request.ID) > 0 && string(request.ID) == "null") {
			writeMCPJSON(w, http.StatusOK, mcpErrorResponse(request.ID, -32600, "Invalid Request"))
			return
		}
		if len(request.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		result, rpcErr := a.handleMCPRequest(request)
		if rpcErr != nil {
			writeMCPJSON(w, http.StatusOK, mcpErrorResponse(request.ID, rpcErr.code, rpcErr.message))
			return
		}
		writeMCPJSON(w, http.StatusOK, mcpResponse{JSONRPC: "2.0", ID: request.ID, Result: result})
	})
	return mux
}

type mcpRPCError struct {
	code    int
	message string
}

func (a *App) handleMCPRequest(request mcpRequest) (any, *mcpRPCError) {
	switch request.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil {
			return nil, &mcpRPCError{code: -32602, message: "Invalid params"}
		}
		version := mcpProtocolVersion
		if params.ProtocolVersion == "2025-03-26" || params.ProtocolVersion == mcpProtocolVersion {
			version = params.ProtocolVersion
		}
		return map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "orbit-ssh", "version": "1.0.0"},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": mcpToolDefinitions()}, nil
	case "tools/call":
		var params struct {
			Name      string                     `json:"name"`
			Arguments map[string]json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil || params.Name == "" {
			return nil, &mcpRPCError{code: -32602, message: "Invalid params"}
		}
		if !knownMCPTool(params.Name) {
			return nil, &mcpRPCError{code: -32602, message: "Unknown tool"}
		}
		return a.callMCPTool(params.Name, params.Arguments), nil
	default:
		return nil, &mcpRPCError{code: -32601, message: "Method not found"}
	}
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
		var args mcpHistoryAppendArgs
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

func (a *App) mcpSessions() []mcpSessionInfo {
	a.mu.Lock()
	defer a.mu.Unlock()
	sessions := make([]mcpSessionInfo, 0, len(a.sessions)+len(a.localSessions))
	for id, session := range a.sessions {
		host := session.host
		sessions = append(sessions, mcpSessionInfo{
			ID: id, Kind: "ssh", Name: host.Name,
			Address: net.JoinHostPort(host.Address, strconv.Itoa(host.Port)), Username: host.Username, Status: "connected",
		})
	}
	for id, session := range a.localSessions {
		kind := "local_shell"
		if strings.HasPrefix(session.name, "WSL") {
			kind = "wsl"
		}
		sessions = append(sessions, mcpSessionInfo{ID: id, Kind: kind, Name: session.name, Status: "connected"})
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].ID < sessions[j].ID })
	return sessions
}

func (a *App) readMCPTerminal(id string, maxChars int) (string, bool, error) {
	if id == "" {
		return "", false, errors.New("session_id 不能为空")
	}
	if maxChars < 1 {
		maxChars = 20000
	}
	if maxChars > 100000 {
		maxChars = 100000
	}
	a.mu.Lock()
	remote := a.sessions[id]
	local := a.localSessions[id]
	a.mu.Unlock()
	var output []byte
	if remote != nil && remote.output != nil {
		output = remote.output.read()
	} else if local != nil && local.output != nil {
		output = local.output.read()
	} else {
		return "", false, errors.New("活动终端会话不存在")
	}
	text := cleanTerminalOutput(string(output))
	runes := []rune(text)
	truncated := len(runes) > maxChars
	if truncated {
		text = string(runes[len(runes)-maxChars:])
	}
	return text, truncated, nil
}

func cleanTerminalOutput(output string) string {
	output = strings.ToValidUTF8(output, "�")
	output = ansiOSC.ReplaceAllString(output, "")
	output = ansiCSI.ReplaceAllString(output, "")
	output = ansiChar.ReplaceAllString(output, "")
	output = ansiEsc.ReplaceAllString(output, "")
	output = strings.ReplaceAll(output, "\r\n", "\n")
	output = strings.ReplaceAll(output, "\r", "\n")
	return strings.Map(func(r rune) rune {
		if r == 0 || (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return -1
		}
		return r
	}, output)
}

func (a *App) searchMCPTerminalHistory(query, sessionID string, limit int) ([]mcpHistoryMatch, error) {
	if limit <= 0 {
		limit = 10
	}
	if limit > 100 {
		limit = 100
	}
	if len(query) > 256 {
		return nil, errors.New("query 最长为 256 字节")
	}
	needle := strings.ToLower(strings.TrimSpace(query))
	records := a.terminalHistorySnapshot()
	matches := make([]mcpHistoryMatch, 0, limit)
	for _, record := range records {
		if sessionID != "" && record.ID != sessionID {
			continue
		}
		output := cleanTerminalOutput(record.Output)
		searchable := strings.ToLower(record.Title + "\n" + record.Subtitle + "\n" + output)
		index := strings.Index(searchable, needle)
		if needle != "" && index < 0 {
			continue
		}
		snippet := output
		if needle != "" {
			runes := []rune(output)
			needleRunes := []rune(needle)
			plainIndex := strings.Index(strings.ToLower(output), needle)
			if plainIndex >= 0 {
				start := len([]rune(output[:plainIndex])) - 120
				if start < 0 {
					start = 0
				}
				end := len([]rune(output[:plainIndex])) + len(needleRunes) + 180
				if end > len(runes) {
					end = len(runes)
				}
				snippet = string(runes[start:end])
			}
		}
		snippetRunes := []rune(snippet)
		if len(snippetRunes) > 500 {
			snippet = string(snippetRunes[len(snippetRunes)-500:])
		}
		matches = append(matches, mcpHistoryMatch{
			ID: record.ID, Title: record.Title, Subtitle: record.Subtitle,
			TerminalNumber: record.TerminalNumber, UpdatedAt: record.UpdatedAt,
			Pinned: record.Pinned, Truncated: record.Truncated, Snippet: snippet,
		})
		if len(matches) == limit {
			break
		}
	}
	return matches, nil
}

func isLocalMCPOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" {
		return false
	}
	host := parsed.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validMCPAuthorization(header, token string) bool {
	if !strings.HasPrefix(header, "Bearer ") || token == "" {
		return false
	}
	presented := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if len(presented) != len(token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(token)) == 1
}

func acceptsMCPResponse(header string) bool {
	header = strings.ToLower(strings.TrimSpace(header))
	if header == "" || header == "*/*" {
		return true
	}
	return strings.Contains(header, "application/json") || strings.Contains(header, "text/event-stream") || strings.Contains(header, "*/*")
}

func writeMCPJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func mcpErrorResponse(id json.RawMessage, code int, message string) mcpResponse {
	return mcpResponse{JSONRPC: "2.0", ID: id, Error: map[string]any{"code": code, "message": message}}
}
