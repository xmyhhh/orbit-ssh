//go:build darwin

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

const localShellsSupported = true

// Shells macOS ships with, followed by the common Homebrew installations.
var darwinShellPaths = []string{
	"/bin/zsh",
	"/bin/bash",
	"/bin/sh",
	"/opt/homebrew/bin/fish",
	"/usr/local/bin/fish",
	"/opt/homebrew/bin/bash",
	"/usr/local/bin/bash",
	"/opt/homebrew/bin/zsh",
	"/usr/local/bin/zsh",
	"/bin/tcsh",
	"/bin/csh",
	"/bin/ksh",
}

var darwinShellNames = map[string]string{
	"zsh":    "Zsh",
	"bash":   "Bash",
	"sh":     "sh",
	"fish":   "Fish",
	"tcsh":   "tcsh",
	"csh":    "csh",
	"ksh":    "ksh",
	"dash":   "dash",
	"ash":    "ash",
	"elvish": "Elvish",
}

func inspectLocalShells() LocalShellInfo {
	info := LocalShellInfo{Supported: true, Shells: []LocalShell{}}
	login := strings.TrimSpace(os.Getenv("SHELL"))
	candidates := append([]string{}, darwinShellPaths...)
	// The login shell comes first so it is the default entry.
	if login != "" {
		candidates = append([]string{login}, candidates...)
	}
	seenPaths := map[string]bool{}
	seenIDs := map[string]bool{}
	for _, path := range candidates {
		if path == "" || seenPaths[path] {
			continue
		}
		info2, err := os.Stat(path)
		if err != nil || info2.IsDir() || info2.Mode().Perm()&0o111 == 0 {
			continue
		}
		id := darwinShellID(path)
		if id == "" || seenIDs[id] {
			continue
		}
		seenPaths[path] = true
		seenIDs[id] = true
		name := darwinShellNames[id]
		if name == "" {
			name = id
		}
		if path == login {
			name += "（登录 Shell）"
		}
		info.Shells = append(info.Shells, LocalShell{ID: id, Name: name, Path: path})
	}
	if len(info.Shells) == 0 {
		info.Message = "未找到可用的 Shell，请检查系统安装后刷新。"
	}
	return info
}

func darwinShellID(path string) string {
	base := strings.ToLower(filepath.Base(path))
	base = strings.TrimSuffix(base, ".exe")
	if base == "" || strings.ContainsAny(base, " \t\r\n") {
		return ""
	}
	return base
}

func startLocalShell(id string, size TerminalSize) (localTerminal, error) {
	for _, shell := range inspectLocalShells().Shells {
		if shell.ID != id {
			continue
		}
		dir, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		return startUnixTerminal(shell.Path, nil, dir, size)
	}
	return nil, errors.New("本地 Shell 不存在或尚未安装，请刷新列表")
}

// unixTerminal runs a shell on a pseudo terminal, the macOS counterpart of the
// ConPTY console used on Windows.
type unixTerminal struct {
	pty     *os.File
	cmd     *exec.Cmd
	done    chan struct{}
	drained chan struct{}
	once    sync.Once
	drain   sync.Once
	mu      sync.Mutex
	code    uint32
	waitErr error
	closed  bool
}

// darwinTerminalEnv forces a color capable TERM. getenv returns the first
// match, so an inherited TERM has to be dropped instead of appended.
func darwinTerminalEnv(env []string) []string {
	result := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if strings.HasPrefix(entry, "TERM=") {
			continue
		}
		result = append(result, entry)
	}
	return append(result, "TERM=xterm-256color")
}

func startUnixTerminal(executable string, args []string, dir string, size TerminalSize) (*unixTerminal, error) {
	cmd := exec.Command(executable, args...)
	cmd.Dir = dir
	cmd.Env = darwinTerminalEnv(os.Environ())
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(size.Rows), Cols: uint16(size.Cols)})
	if err != nil {
		return nil, err
	}
	t := &unixTerminal{pty: master, cmd: cmd, done: make(chan struct{}), drained: make(chan struct{})}
	go func() {
		waitErr := cmd.Wait()
		code := 0
		if waitErr != nil {
			var exit *exec.ExitError
			if errors.As(waitErr, &exit) {
				// A normal exit reports through the status code, like ConPTY does.
				code = exit.ExitCode()
				waitErr = nil
			} else {
				code = 1
			}
		}
		if code < 0 {
			code = 1
		}
		t.mu.Lock()
		t.code = uint32(code)
		t.waitErr = waitErr
		t.mu.Unlock()
		close(t.done)
	}()
	return t, nil
}

func (t *unixTerminal) Read(p []byte) (int, error) {
	n, err := t.pty.Read(p)
	if err != nil {
		t.drain.Do(func() { close(t.drained) })
	}
	return n, err
}

func (t *unixTerminal) Write(p []byte) (int, error) { return t.pty.Write(p) }

func (t *unixTerminal) Wait() (uint32, error) {
	<-t.done
	// The reader owns the pty; wait until it drained the remaining output so
	// the close event is not emitted before the last bytes.
	select {
	case <-t.drained:
	case <-time.After(2 * time.Second):
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.code, t.waitErr
}

func (t *unixTerminal) Resize(cols, rows int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errors.New("本地终端已关闭")
	}
	return pty.Setsize(t.pty, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

func (t *unixTerminal) Close() error {
	t.once.Do(func() {
		t.mu.Lock()
		t.closed = true
		t.mu.Unlock()
		// Stop only this terminal's process, never the user's other shells.
		if t.cmd.Process != nil {
			_ = t.cmd.Process.Kill()
		}
		<-t.done
		_ = t.pty.Close()
	})
	return nil
}
