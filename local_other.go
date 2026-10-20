//go:build !windows && !darwin

package main

import "errors"

const localShellsSupported = false

func inspectLocalShells() LocalShellInfo {
	return LocalShellInfo{Shells: []LocalShell{}, Message: "本地 Shell 目前仅支持 Windows 和 macOS"}
}

func startLocalShell(string, TerminalSize) (localTerminal, error) {
	return nil, errors.New("本地 Shell 目前仅支持 Windows 和 macOS")
}
