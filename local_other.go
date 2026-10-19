//go:build !windows

package main

import "errors"

func inspectLocalShells() LocalShellInfo {
	return LocalShellInfo{Shells: []LocalShell{}, Message: "本地 Shell 目前仅支持 Windows"}
}

func startLocalShell(string, TerminalSize) (localTerminal, error) {
	return nil, errors.New("本地 Shell 目前仅支持 Windows")
}
