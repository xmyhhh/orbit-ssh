//go:build (!windows && !darwin && !linux) || android || androidtest

package main

import "errors"

const localShellsSupported = false

func inspectLocalShells() LocalShellInfo {
	return LocalShellInfo{Shells: []LocalShell{}, Message: "本地 Shell 目前仅支持 Windows、macOS 和 Linux"}
}

func startLocalShell(string, TerminalSize) (localTerminal, error) {
	return nil, errors.New("本地 Shell 目前仅支持 Windows、macOS 和 Linux")
}
