//go:build (!windows && !darwin && !linux) || android || androidtest

package local

import "errors"

const ShellsSupported = false

func Inspect() ShellInfo {
	return ShellInfo{Shells: []Shell{}, Message: "本地 Shell 目前仅支持 Windows、macOS 和 Linux"}
}

func Start(string, int, int) (Terminal, error) {
	return nil, errors.New("本地 Shell 目前仅支持 Windows、macOS 和 Linux")
}
