//go:build darwin && !android && !androidtest

package local

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const ShellsSupported = true

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

func Inspect() ShellInfo {
	info := ShellInfo{Supported: true, Shells: []Shell{}}
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
		info.Shells = append(info.Shells, Shell{ID: id, Name: name, Path: path})
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

func Start(id string, cols, rows int) (Terminal, error) {
	for _, shell := range Inspect().Shells {
		if shell.ID != id {
			continue
		}
		dir, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		return startUnixTerminal(shell.Path, nil, dir, cols, rows)
	}
	return nil, errors.New("本地 Shell 不存在或尚未安装，请刷新列表")
}
