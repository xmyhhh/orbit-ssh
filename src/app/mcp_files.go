package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"orbitssh/src/notify"
)

const mcpFileReadLimit = 512 * 1024

type mcpPendingCommand struct {
	id        string
	sessionID string
	command   string
	reason    string
	created   time.Time
	decided   chan bool
	app       *App
	ctx       context.Context
	cancel    context.CancelCauseFunc
	revision  uint64
}

var mcpCommandMu sync.Mutex
var mcpPendingCommands = map[string]*mcpPendingCommand{}

const (
	mcpCommandMaxBytes = 4096
	mcpInputMaxBytes   = 16 * 1024
	mcpApprovalTimeout = 2 * time.Minute
	mcpCommandSent     = "命令已发送到终端，结果请用 read_terminal 查看"
	// The optional explanation shown in the approval dialog stays short: 35
	// characters for CJK text, or 35 words for other text.
	mcpReasonMaxChars = 35
	mcpReasonMaxWords = 35
	// 35 English words rarely exceed this many characters; the cap stops one
	// absurdly long token, which would otherwise count as a single word.
	mcpReasonMaxEnglishRunes = 300
)

// normalizeMCPReason validates the optional explanation an AI attaches to a
// command that needs user approval. Text containing CJK characters is limited
// to 35 characters; other text is limited to 35 words, so an English sentence
// is not rejected for exceeding 35 characters. Whitespace-only input is valid
// and simply not displayed in the dialog.
func normalizeMCPReason(reason string) (string, error) {
	fields := strings.Fields(reason)
	if len(fields) == 0 {
		return "", nil
	}
	for _, r := range reason {
		if unicode.IsControl(r) && !unicode.IsSpace(r) {
			return "", errors.New("reason 包含无效字符，请使用普通文字")
		}
	}
	// Wrapped or multi-line explanations are collapsed so the dialog keeps one
	// readable line.
	reason = strings.Join(fields, " ")
	// Any CJK character switches the limit to characters, which matches how
	// the text is written and counted by hand.
	if usesCJK(reason) {
		if count := utf8.RuneCountInString(reason); count > mcpReasonMaxChars {
			return "", fmt.Errorf("reason 过长：必须简短于 %d 个字符（当前 %d 个），请写得更简短", mcpReasonMaxChars, count)
		}
		return reason, nil
	}
	if len(fields) > mcpReasonMaxWords {
		return "", fmt.Errorf("reason 过长：必须简短于 %d 个单词（当前 %d 个），请写得更简短", mcpReasonMaxWords, len(fields))
	}
	// A single absurd token counts as one word, so cap its length as well.
	if utf8.RuneCountInString(reason) > mcpReasonMaxEnglishRunes {
		return "", fmt.Errorf("reason 过长：必须简短于 %d 个单词，请写得更简短", mcpReasonMaxWords)
	}
	return reason, nil
}

func usesCJK(text string) bool {
	for _, r := range text {
		if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) ||
			unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r) {
			return true
		}
	}
	return false
}

func (a *App) allowMCPFiles() error {
	if err := a.ready(); err != nil {
		return err
	}
	if !a.store.snapshot().Preferences.MCPAllowFileAccess {
		return errors.New("请先在偏好设置中启用“允许 AI 访问文件”")
	}
	return nil
}

func (a *App) mcpListDirectory(sessionID, dir string) (map[string]any, error) {
	if sessionID == "" {
		return nil, errors.New("session_id 不能为空")
	}
	directory, err := a.ListDirectory(sessionID, dir)
	if err != nil {
		return nil, err
	}
	entries := make([]map[string]any, 0, len(directory.Files))
	for _, file := range directory.Files {
		entries = append(entries, map[string]any{
			"name": file.Name, "size": file.Size, "isDir": file.IsDir,
			"isSymlink": file.IsSymlink, "modified": file.Modified, "mode": file.Mode,
		})
	}
	return map[string]any{"path": directory.Path, "entries": entries}, nil
}

func (a *App) mcpReadFile(sessionID, filename string) (map[string]any, error) {
	if sessionID == "" || filename == "" {
		return nil, errors.New("session_id 和 path 不能为空")
	}
	client, err := a.sftpClient(sessionID)
	if err != nil {
		return nil, err
	}
	info, err := client.Stat(filename)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("这是一个目录，请使用 list_directory")
	}
	if info.Size() > mcpFileReadLimit {
		return nil, fmt.Errorf("文件超过 %d KB，请使用 SFTP 下载后查看", mcpFileReadLimit/1024)
	}
	file, err := client.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data := make([]byte, 0, info.Size())
	buffer := make([]byte, 32*1024)
	for len(data) < mcpFileReadLimit {
		n, readErr := file.Read(buffer)
		data = append(data, buffer[:n]...)
		if readErr != nil {
			break
		}
		if n == 0 {
			break
		}
	}
	truncated := info.Size() > int64(len(data))
	text := string(data)
	binary := !utf8.Valid(data) || strings.IndexByte(text, 0) >= 0
	if binary {
		text = base64.StdEncoding.EncodeToString(data)
	}
	return map[string]any{
		"path": filename, "size": info.Size(), "truncated": truncated,
		"encoding": map[bool]string{true: "base64", false: "utf-8"}[binary], "content": text,
	}, nil
}

func (a *App) mcpWriteFile(sessionID, filename, content string) (map[string]any, error) {
	if sessionID == "" || filename == "" {
		return nil, errors.New("session_id 和 path 不能为空")
	}
	if !a.store.snapshot().Preferences.MCPAllowTerminalInput {
		return nil, errors.New("写入文件需要同时启用“允许 AI 输入终端”，以免在未授权时修改服务器")
	}
	client, err := a.sftpClient(sessionID)
	if err != nil {
		return nil, err
	}
	if err = writeRemoteText(client, filename, content); err != nil {
		return nil, err
	}
	return map[string]any{"path": filename, "bytes": len(content), "saved": true}, nil
}

func (a *App) mcpMetrics(sessionID string) (Metrics, error) {
	if sessionID == "" {
		return Metrics{}, errors.New("session_id 不能为空")
	}
	return a.Monitor(sessionID)
}

func (a *App) mcpKillProcess(sessionID string, pid int, signal string) (map[string]any, error) {
	if !a.store.snapshot().Preferences.MCPAllowTerminalInput {
		return nil, errors.New("请先启用“允许 AI 输入终端”再结束进程")
	}
	if err := a.KillProcess(sessionID, pid, signal); err != nil {
		return nil, err
	}
	return map[string]any{"sessionId": sessionID, "pid": pid, "signal": strings.ToUpper(signal), "sent": true}, nil
}

// requestMCPCommand queues a command for the user to approve in the UI. The
// MCP call blocks until the dialog answers or the request times out. The text
// is written to the terminal verbatim once approved; callers that execute a
// command append the trailing newline themselves. Windows whose user turned on
// full consent (完全放行) skip the dialog entirely.
//
// reason is the AI's optional, already validated explanation for the dialog.
func (a *App) requestMCPCommand(ctx context.Context, sessionID, command, reason string) (string, error) {
	if len(command) == 0 || len(command) > mcpInputMaxBytes {
		return "", errors.New("输入长度应为 1–16384 字节")
	}
	if strings.ContainsRune(command, '\x00') {
		return "", errors.New("命令包含无效字符")
	}
	auth, err := a.authorizeMCPInput(ctx, sessionID)
	if err != nil {
		return "", err
	}
	if a.sessionMCPUnrestricted(sessionID) {
		if err := a.writeMCPTerminal(ctx, sessionID, command, auth, true); err != nil {
			return "", err
		}
		return mcpCommandSent, nil
	}
	if a.emit == nil {
		return "", errors.New("请先打开 Orbit SSH 应用界面")
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	request := &mcpPendingCommand{
		id: "cmd-" + rand.Text(), sessionID: sessionID, command: command,
		reason: reason, created: time.Now(), decided: make(chan bool, 1),
		app: a, ctx: ctx, cancel: cancel, revision: auth.revision,
	}
	// Store -> command is also the order used by revocation and decisions.
	// Register atomically with the revision check so revocation cannot miss
	// a request that was authorized before it but queued just afterwards.
	a.store.mu.Lock()
	if err := mcpInputPermission(a.store.state.Preferences); err != nil {
		a.store.mu.Unlock()
		return "", err
	}
	if auth.revision != a.store.mcpInputRevision || ctx.Err() != nil {
		a.store.mu.Unlock()
		return "", errors.New("命令请求已取消或授权已撤销")
	}
	mcpCommandMu.Lock()
	if len(mcpPendingCommands) >= 20 {
		mcpCommandMu.Unlock()
		a.store.mu.Unlock()
		return "", errors.New("待确认的命令过多，请稍后重试")
	}
	mcpPendingCommands[request.id] = request
	mcpCommandMu.Unlock()
	a.store.mu.Unlock()
	defer func() {
		mcpCommandMu.Lock()
		delete(mcpPendingCommands, request.id)
		mcpCommandMu.Unlock()
		if a.notifyDecided != nil {
			notify.Forget(request.id)
		}
		// Also closes stale UI dialogs on cancellation and timeout. Emit only
		// after removal so ListMCPCommands cannot return this request again.
		a.emit("mcp:command-decided", map[string]any{"id": request.id})
	}()
	if a.notifyDecided != nil {
		notify.Register(request.id, notify.Handlers{
			Activate: a.showFromTray,
			Decide: func(approved bool) error {
				return a.notifyDecided(request.id, approved)
			},
		})
	}
	a.emit("mcp:command-request", map[string]any{
		"id": request.id, "sessionId": sessionID, "command": command,
		"reason":    reason,
		"dangerous": dangerousCommand(command),
		"createdAt": request.created.UnixMilli(),
		"expiresAt": request.created.Add(mcpApprovalTimeout).UnixMilli(),
	})
	if a.notifyDecided != nil {
		name, _ := a.sessionNames(sessionID)
		// A slow/absent desktop service must never block a dialog decision
		// or prevent the approval timeout from running.
		go notify.Approval("Orbit SSH 需要你确认命令", approvalBody(name, reason, command), request.id)
	}
	select {
	case approved := <-request.decided:
		if !approved {
			return "", errors.New("用户拒绝了这条命令")
		}
	case <-time.After(time.Until(request.created.Add(mcpApprovalTimeout))):
		return "", errors.New("等待用户确认超时")
	case <-ctx.Done():
		if cause := context.Cause(ctx); cause != nil {
			return "", fmt.Errorf("命令请求已取消：%w", cause)
		}
		return "", errors.New("命令请求已取消")
	}
	if err := a.writeMCPTerminal(ctx, sessionID, command, auth, false); err != nil {
		return "", err
	}
	return mcpCommandSent, nil
}

// approvalBody keeps the notification readable: the session the command
// targets, the optional AI reason and a preview of the payload.
func approvalBody(sessionName, reason, command string) string {
	if command = strings.TrimSpace(command); command == "" {
		command = "(空文本)"
	}
	const limit = 160
	if utf8.RuneCountInString(command) > limit {
		runes := []rune(command)
		command = string(runes[:limit]) + "…"
	}
	if sessionName == "" {
		sessionName = "终端"
	}
	if reason != "" {
		return sessionName + " 请求（" + reason + "）：" + command
	}
	return sessionName + " 请求：" + command
}

// Notification decisions use exactly the same single-use gate as the dialog.
func (a *App) decideMCPFromNotification(id string, approved bool) error {
	return a.DecideMCPCommand(id, approved)
}

// DecideMCPCommand is called by the confirmation dialog in the WebView.
func (a *App) DecideMCPCommand(id string, approved bool) error {
	// Keep this order consistent with queue registration and SavePreferences.
	if a.store != nil {
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
	}
	mcpCommandMu.Lock()
	defer mcpCommandMu.Unlock()
	request := mcpPendingCommands[id]
	if request == nil || (request.app != nil && request.app != a) {
		return errors.New("命令请求不存在或已处理")
	}
	if request.ctx != nil && request.ctx.Err() != nil {
		delete(mcpPendingCommands, id)
		return errors.New("命令请求已取消")
	}
	if a.store != nil {
		err := mcpInputPermission(a.store.state.Preferences)
		if err == nil && request.revision != a.store.mcpInputRevision {
			err = errors.New("终端输入授权已撤销")
		}
		if err != nil {
			delete(mcpPendingCommands, id)
			if request.cancel != nil {
				request.cancel(err)
			}
			return err
		}
	}
	if !time.Now().Before(request.created.Add(mcpApprovalTimeout)) {
		delete(mcpPendingCommands, id)
		return errors.New("命令请求已超时")
	}
	// Remove under the same lock: a dialog click and a notification action
	// cannot both decide the same request, even after the channel is drained.
	delete(mcpPendingCommands, id)
	request.decided <- approved
	return nil
}

// invalidateMCPCommandsLocked requires a.store.mu. Queued requests are
// cancelled immediately; already-decided writes are invalidated by the
// revision check immediately before writing to the terminal.
func (a *App) invalidateMCPCommandsLocked() {
	mcpCommandMu.Lock()
	defer mcpCommandMu.Unlock()
	for id, request := range mcpPendingCommands {
		if request.app != a {
			continue
		}
		delete(mcpPendingCommands, id)
		request.cancel(errors.New("MCP 终端输入授权已撤销"))
	}
}

func (a *App) ListMCPCommands() []map[string]any {
	mcpCommandMu.Lock()
	defer mcpCommandMu.Unlock()
	ids := make([]string, 0, len(mcpPendingCommands))
	for id := range mcpPendingCommands {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	commands := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		request := mcpPendingCommands[id]
		commands = append(commands, map[string]any{
			"id": request.id, "sessionId": request.sessionID,
			"command": request.command, "reason": request.reason,
			"createdAt": request.created.UnixMilli(),
			"expiresAt": request.created.Add(mcpApprovalTimeout).UnixMilli(),
			"dangerous": dangerousCommand(request.command),
		})
	}
	return commands
}

// dangerousCommand matches patterns that should never be auto-approved by an
// AI client. The user still sees the confirmation dialog, but the UI shows a
// stronger warning for these.
func dangerousCommand(command string) bool {
	lower := strings.ToLower(strings.TrimSpace(command))
	patterns := []string{
		"rm -rf /", "rm -fr /", "mkfs", "dd if=", "> /dev/sd", "shutdown", "reboot",
		"poweroff", "halt", "init 0", "chmod -r 777 /", ":(){", "> /dev/null 2>&1 &",
		"sudo rm -rf", "mv /* ", "userdel", "passwd root",
	}
	for _, pattern := range patterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

// FilePathExists is used by the UI to keep rename targets honest.
func (a *App) RemotePathExists(sessionID, filename string) (bool, error) {
	client, err := a.sftpClient(sessionID)
	if err != nil {
		return false, err
	}
	_, err = client.Lstat(path.Clean(filename))
	if err != nil {
		return false, nil
	}
	return true, nil
}
