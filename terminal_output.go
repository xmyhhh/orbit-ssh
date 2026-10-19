package main

import "sync"

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
