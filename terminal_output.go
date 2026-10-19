package main

import (
	"encoding/base64"
	"io"
	"sync"
)

const terminalOutputLimit = 1024 * 1024

type terminalOutputBuffer struct {
	mu   sync.RWMutex
	data []byte
}

func (b *terminalOutputBuffer) append(data []byte) {
	if len(data) == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(data) >= terminalOutputLimit {
		b.data = append(b.data[:0], data[len(data)-terminalOutputLimit:]...)
		return
	}
	if overflow := len(b.data) + len(data) - terminalOutputLimit; overflow > 0 {
		copy(b.data, b.data[overflow:])
		b.data = b.data[:len(b.data)-overflow]
	}
	b.data = append(b.data, data...)
}

func (b *terminalOutputBuffer) read() []byte {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return append([]byte(nil), b.data...)
}

// Both SSH streams and local consoles retain and emit the exact bytes they read.
func (a *App) copyTerminalOutput(id string, output *terminalOutputBuffer, reader io.Reader) {
	buffer := make([]byte, 16384)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			output.append(buffer[:n])
			if a.emit != nil {
				a.emit("ssh:data:"+id, base64.StdEncoding.EncodeToString(buffer[:n]))
			}
		}
		if err != nil {
			return
		}
	}
}
