//go:build !windows

package app

import (
	"context"
	"errors"

	"orbitssh/src/local"
)

func inspectWSL(context.Context) WSLInfo {
	return WSLInfo{Distributions: []WSLDistribution{}, Message: "WSL 仅支持 Windows"}
}

func startWSL(string, int, int) (local.Terminal, error) {
	return nil, errors.New("WSL 仅支持 Windows")
}
