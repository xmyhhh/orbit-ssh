//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/charmbracelet/x/conpty"
	"golang.org/x/sys/windows"
)

func wslExecutable() string {
	return filepath.Join(os.Getenv("SystemRoot"), "System32", "wsl.exe")
}

func inspectWSL(parent context.Context) WSLInfo {
	info := WSLInfo{Supported: true, Distributions: []WSLDistribution{}}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	run := func(args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, wslExecutable(), args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
		return cmd.Output()
	}
	names, err := run("--list", "--quiet")
	if err != nil {
		info.Message = "尚未安装 WSL，请在 PowerShell 运行 wsl --install，安装后刷新。"
		if ctx.Err() != nil {
			info.Message = "读取 WSL 列表超时或已取消，请重试。"
		}
		return info
	}
	info.Installed = true
	running := map[string]bool{}
	if data, err := run("--list", "--running", "--quiet"); err == nil {
		for _, name := range wslNames(data) {
			running[name] = true
		}
	}
	for _, name := range wslNames(names) {
		info.Distributions = append(info.Distributions, WSLDistribution{Name: name, Running: running[name]})
	}
	if len(info.Distributions) == 0 {
		info.Message = "没有已安装的发行版，请先在 PowerShell 运行 wsl --install。"
	}
	return info
}

type windowsTerminal struct {
	pty     *conpty.ConPty
	process windows.Handle
	done    chan struct{}
	code    uint32
	waitErr error
	once    sync.Once
	mu      sync.Mutex
	closed  bool
}

func startWindowsTerminal(executable string, args []string, size TerminalSize) (*windowsTerminal, error) {
	if err := windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find(); err != nil {
		return nil, fmt.Errorf("WSL 内嵌终端需要 Windows 10 1809 或更新版本")
	}
	pty, err := conpty.New(size.Cols, size.Rows, 0)
	if err != nil {
		return nil, err
	}
	_, handle, err := pty.Spawn(executable, append([]string{executable}, args...), &syscall.ProcAttr{Env: append(os.Environ(), "TERM=xterm-256color")})
	if err != nil {
		_ = pty.Close()
		return nil, err
	}
	s := &windowsTerminal{pty: pty, process: windows.Handle(handle), done: make(chan struct{})}
	go func() {
		_, s.waitErr = windows.WaitForSingleObject(s.process, windows.INFINITE)
		if s.waitErr == nil {
			s.waitErr = windows.GetExitCodeProcess(s.process, &s.code)
		}
		close(s.done)
	}()
	return s, nil
}

func startWSL(distribution string, size TerminalSize) (localTerminal, error) {
	return startWindowsTerminal(wslExecutable(), []string{"--distribution", distribution, "--cd", "~"}, size)
}

func (s *windowsTerminal) Read(p []byte) (int, error)  { return s.pty.Read(p) }
func (s *windowsTerminal) Write(p []byte) (int, error) { return s.pty.Write(p) }
func (s *windowsTerminal) Wait() (uint32, error) {
	<-s.done
	return s.code, s.waitErr
}
func (s *windowsTerminal) Resize(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("WSL 终端已关闭")
	}
	return s.pty.Resize(cols, rows)
}
func (s *windowsTerminal) Close() error {
	s.once.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		// Stop only this terminal's wsl.exe, never terminate the distribution.
		_ = windows.TerminateProcess(s.process, 0)
		<-s.done
		_ = s.pty.Close()
		_ = windows.CloseHandle(s.process)
	})
	return nil
}
