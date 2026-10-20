//go:build windows

package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows"

	"orbitssh/src/local"
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

func startWSL(distribution string, cols, rows int) (local.Terminal, error) {
	return local.StartWindows(wslExecutable(), []string{"--distribution", distribution, "--cd", "~"}, "", cols, rows)
}
