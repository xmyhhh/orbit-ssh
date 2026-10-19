package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"runtime"
	"strings"
	"unicode/utf16"
)

type WSLDistribution struct {
	Name    string `json:"name"`
	Running bool   `json:"running"`
}

type WSLInfo struct {
	Supported     bool              `json:"supported"`
	Installed     bool              `json:"installed"`
	Distributions []WSLDistribution `json:"distributions"`
	Message       string            `json:"message"`
}

func (a *App) GetWSLInfo() WSLInfo {
	return inspectWSL(a.ctx)
}

func decodeWSLOutput(data []byte) string {
	if len(data) >= 2 && ((data[0] == 0xff && data[1] == 0xfe) || bytes.IndexByte(data, 0) >= 0) {
		units := make([]uint16, len(data)/2)
		for i := range units {
			units[i] = binary.LittleEndian.Uint16(data[i*2:])
		}
		return strings.TrimPrefix(string(utf16.Decode(units)), "\ufeff")
	}
	return strings.TrimPrefix(string(data), "\ufeff")
}

func wslNames(data []byte) []string {
	names := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(decodeWSLOutput(data), "\n") {
		name := strings.TrimSpace(line)
		if name != "" && !seen[name] && !strings.ContainsRune(name, '\x00') {
			names = append(names, name)
			seen[name] = true
		}
	}
	return names
}

func (a *App) ConnectWSL(id, distribution string, size TerminalSize) error {
	if runtime.GOOS != "windows" {
		return errors.New("WSL 仅支持 Windows")
	}
	return a.connectLocalTerminal(id, "WSL · "+distribution, size, func(ctx context.Context, size TerminalSize) (localTerminal, error) {
		info := inspectWSL(ctx)
		if !info.Installed {
			return nil, errors.New(info.Message)
		}
		for _, item := range info.Distributions {
			if item.Name == distribution {
				if err := ctx.Err(); err != nil {
					return nil, errors.New("启动已取消")
				}
				return startWSL(distribution, size)
			}
		}
		return nil, errors.New("WSL 发行版不存在，请刷新列表")
	})
}
