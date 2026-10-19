package main

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
	"unicode/utf8"
)

const mcpFileReadLimit = 512 * 1024

type mcpPendingCommand struct {
	id        string
	sessionID string
	command   string
	created   time.Time
	decided   chan bool
}

var mcpCommandMu sync.Mutex
var mcpPendingCommands = map[string]*mcpPendingCommand{}

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
// MCP call blocks until the dialog answers or the request times out.
func (a *App) requestMCPCommand(ctx context.Context, sessionID, command string) (string, error) {
	if len(command) == 0 || len(command) > 4096 {
		return "", errors.New("命令长度应为 1–4096 字节")
	}
	if strings.ContainsAny(command, "\x00") {
		return "", errors.New("命令包含无效字符")
	}
	if a.emit == nil {
		return "", errors.New("请先打开 Orbit SSH 应用界面")
	}
	request := &mcpPendingCommand{
		id: "cmd-" + rand.Text(), sessionID: sessionID, command: command,
		created: time.Now(), decided: make(chan bool, 1),
	}
	mcpCommandMu.Lock()
	if len(mcpPendingCommands) >= 20 {
		mcpCommandMu.Unlock()
		return "", errors.New("待确认的命令过多，请稍后重试")
	}
	mcpPendingCommands[request.id] = request
	mcpCommandMu.Unlock()
	defer func() {
		mcpCommandMu.Lock()
		delete(mcpPendingCommands, request.id)
		mcpCommandMu.Unlock()
	}()
	a.emit("mcp:command-request", map[string]any{
		"id": request.id, "sessionId": sessionID, "command": command,
		"dangerous": dangerousCommand(command),
	})
	select {
	case approved := <-request.decided:
		if !approved {
			return "", errors.New("用户拒绝了这条命令")
		}
	case <-time.After(2 * time.Minute):
		return "", errors.New("等待用户确认超时")
	case <-ctx.Done():
		return "", errors.New("命令请求已取消")
	}
	if err := a.WriteTerminal(sessionID, command+"\n"); err != nil {
		return "", err
	}
	return "命令已发送到终端，结果请用 read_terminal 查看", nil
}

// DecideMCPCommand is called by the confirmation dialog in the WebView.
func (a *App) DecideMCPCommand(id string, approved bool) error {
	mcpCommandMu.Lock()
	request := mcpPendingCommands[id]
	mcpCommandMu.Unlock()
	if request == nil {
		return errors.New("命令请求不存在或已处理")
	}
	select {
	case request.decided <- approved:
	default:
		return errors.New("命令请求已处理")
	}
	return nil
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
			"command": request.command, "createdAt": request.created.UnixMilli(),
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
