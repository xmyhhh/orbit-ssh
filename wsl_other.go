//go:build !windows

package main

import (
	"context"
	"errors"
)

func inspectWSL(context.Context) WSLInfo {
	return WSLInfo{Distributions: []WSLDistribution{}, Message: "WSL 仅支持 Windows"}
}

func startWSL(string, TerminalSize) (localTerminal, error) {
	return nil, errors.New("WSL 仅支持 Windows")
}
