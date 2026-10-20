//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

const localShellsSupported = true

func inspectLocalShells() LocalShellInfo {
	info := LocalShellInfo{Supported: true, Shells: []LocalShell{}}
	add := func(id, name, path string) {
		if path == "" {
			return
		}
		if stat, err := os.Stat(path); err == nil && !stat.IsDir() {
			info.Shells = append(info.Shells, LocalShell{ID: id, Name: name, Path: path})
		}
	}
	add("powershell", "Windows PowerShell", filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
	add("cmd", "CMD", filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"))
	pwsh, err := exec.LookPath("pwsh.exe")
	if err != nil {
		pwsh = filepath.Join(os.Getenv("ProgramFiles"), "PowerShell", "7", "pwsh.exe")
	}
	add("pwsh", "PowerShell 7", pwsh)
	if len(info.Shells) == 0 {
		info.Message = "未找到可用的 PowerShell 或 CMD，请检查系统安装后刷新。"
	}
	return info
}

func startLocalShell(id string, size TerminalSize) (localTerminal, error) {
	for _, shell := range inspectLocalShells().Shells {
		if shell.ID != id {
			continue
		}
		args := []string{"-NoLogo"}
		if id == "cmd" {
			args = []string{"/D"}
		}
		dir, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		return startWindowsTerminalInDirectory(shell.Path, args, dir, size)
	}
	return nil, errors.New("本地 Shell 不存在或尚未安装，请刷新列表")
}
