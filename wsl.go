package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"runtime"
	"strings"
	"sync"
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

type localTerminal interface {
	io.ReadWriteCloser
	Resize(int, int) error
	Wait() (uint32, error)
}

type localSession struct {
	terminal localTerminal
	writeMu  sync.Mutex
	closed   sync.Once
}

func (s *localSession) close() { s.closed.Do(func() { _ = s.terminal.Close() }) }

func (a *App) GetPlatform() string { return runtime.GOOS }

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
	if id == "" || len(id) > 128 {
		return errors.New("无效的会话 ID")
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.mu.Lock()
	if a.sessions[id] != nil || a.localSessions[id] != nil || a.pending[id] != nil {
		a.mu.Unlock()
		cancel()
		return errors.New("会话已存在")
	}
	a.pending[id] = cancel
	a.mu.Unlock()
	defer func() { cancel(); a.mu.Lock(); delete(a.pending, id); a.mu.Unlock() }()
	info := inspectWSL(ctx)
	if !info.Installed {
		return errors.New(info.Message)
	}
	found := false
	for _, item := range info.Distributions {
		if item.Name == distribution {
			found = true
			break
		}
	}
	if !found {
		return errors.New("WSL 发行版不存在，请刷新列表")
	}
	if err := ctx.Err(); err != nil {
		return errors.New("启动已取消")
	}
	terminal, err := startWSL(distribution, validSize(size))
	if err != nil {
		return fmt.Errorf("无法启动 WSL：%w", err)
	}
	a.mu.Lock()
	if ctx.Err() != nil {
		a.mu.Unlock()
		// ConPTY requires an active reader while the console is being closed.
		go func() { _, _ = io.Copy(io.Discard, terminal) }()
		_ = terminal.Close()
		return errors.New("启动已取消")
	}
	s := &localSession{terminal: terminal}
	if a.localSessions == nil {
		a.localSessions = map[string]*localSession{}
	}
	a.localSessions[id] = s
	delete(a.pending, id)
	a.mu.Unlock()
	a.streamLocalTerminal(id, s)
	return nil
}

func (a *App) streamLocalTerminal(id string, s *localSession) {
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buffer := make([]byte, 16384)
		for {
			n, err := s.terminal.Read(buffer)
			if n > 0 && a.emit != nil {
				a.emit("ssh:data:"+id, base64.StdEncoding.EncodeToString(buffer[:n]))
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		code, err := s.terminal.Wait()
		s.close()
		<-readDone
		a.mu.Lock()
		if a.localSessions[id] == s {
			delete(a.localSessions, id)
		}
		a.mu.Unlock()
		message := "WSL 终端已结束"
		if err != nil {
			message = err.Error()
		} else if code != 0 {
			message = fmt.Sprintf("WSL 已退出（%d）", code)
		}
		if a.emit != nil {
			a.emit("ssh:closed:"+id, message)
		}
	}()
}
