//go:build linux && !android && !androidtest

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const localShellsSupported = true

// Shells the common distributions ship, followed by the usual local builds.
var linuxShellPaths = []string{
	"/bin/bash",
	"/bin/sh",
	"/bin/dash",
	"/bin/zsh",
	"/bin/fish",
	"/bin/ksh",
	"/bin/mksh",
	"/bin/tcsh",
	"/bin/csh",
	"/usr/bin/bash",
	"/usr/bin/sh",
	"/usr/bin/dash",
	"/usr/bin/zsh",
	"/usr/bin/fish",
	"/usr/bin/ksh",
	"/usr/bin/mksh",
	"/usr/bin/tcsh",
	"/usr/bin/csh",
	"/usr/local/bin/bash",
	"/usr/local/bin/zsh",
	"/usr/local/bin/fish",
	"/usr/local/bin/ksh",
	"/usr/local/bin/tcsh",
	"/usr/local/bin/csh",
}

var linuxShellNames = map[string]string{
	"bash":  "Bash",
	"sh":    "sh",
	"dash":  "dash",
	"zsh":   "Zsh",
	"fish":  "Fish",
	"ksh":   "ksh",
	"mksh":  "mksh",
	"tcsh":  "tcsh",
	"csh":   "csh",
	"elvish": "Elvish",
}

func inspectLocalShells() LocalShellInfo {
	info := LocalShellInfo{Supported: true, Shells: []LocalShell{}}
	login := strings.TrimSpace(os.Getenv("SHELL"))
	candidates := append([]string{}, linuxShellPaths...)
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
		stat, err := os.Stat(path)
		if err != nil || stat.IsDir() || stat.Mode().Perm()&0o111 == 0 {
			continue
		}
		id := linuxShellID(path)
		if id == "" || seenIDs[id] {
			continue
		}
		seenPaths[path] = true
		seenIDs[id] = true
		name := linuxShellNames[id]
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

func linuxShellID(path string) string {
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
