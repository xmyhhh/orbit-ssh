//go:build android || androidtest

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"sync"
	"time"
)

// The native host and Go communicate over private process pipes, never a TCP
// listener. The WebView can call only the same public API as the desktop app.
type mobileMessage struct {
	Type   string          `json:"type"`
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Name   string          `json:"name,omitempty"`
	Args   json.RawMessage `json:"args,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type mobileBridge struct {
	ctx     context.Context
	writer  *json.Encoder
	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  uint64
	pending map[string]chan mobileMessage
}

func marshalMobile(value interface{}) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}

func (b *mobileBridge) send(message mobileMessage) {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	_ = b.writer.Encode(message)
}

func (b *mobileBridge) native(method string, args []interface{}) (json.RawMessage, error) {
	return b.nativeWithin(method, args, 5*time.Minute)
}

// nativeWithin sends a native request and waits at most the given duration.
// Short timeouts keep the engine responsive when the host does not answer.
func (b *mobileBridge) nativeWithin(method string, args []interface{}, timeout time.Duration) (json.RawMessage, error) {
	b.mu.Lock()
	b.nextID++
	id := "native-" + strconv.FormatUint(b.nextID, 10)
	result := make(chan mobileMessage, 1)
	b.pending[id] = result
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()
	b.send(mobileMessage{Type: "native", ID: id, Method: method, Args: marshalMobile(args)})
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case reply := <-result:
		if reply.Error != "" {
			return nil, errors.New(reply.Error)
		}
		return reply.Data, nil
	case <-b.ctx.Done():
		return nil, b.ctx.Err()
	case <-timer.C:
		return nil, errors.New("Android 操作已超时，请重试")
	}
}

func runMobile(input io.Reader, output io.Writer, configDir, filesDir string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	androidConfigDir, androidFilesDir = configDir, filesDir
	bridge := &mobileBridge{ctx: ctx, writer: json.NewEncoder(output), pending: map[string]chan mobileMessage{}}
	androidBridge = bridge
	app := NewApp()
	app.startup(ctx)
	defer app.shutdown(ctx)
	if err := app.ready(); err != nil {
		bridge.send(mobileMessage{Type: "fatal", Error: err.Error()})
		return err
	}
	bridge.send(mobileMessage{Type: "ready"})
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 65536), 32*1024*1024)
	for scanner.Scan() {
		var message mobileMessage
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		if message.Type == "nativeResult" {
			bridge.mu.Lock()
			result := bridge.pending[message.ID]
			bridge.mu.Unlock()
			if result != nil {
				select {
				case result <- message:
				default:
				}
			}
			continue
		}
		if message.Type != "call" || message.ID == "" {
			continue
		}
		go func(request mobileMessage) {
			data, err := mobileCall(app, request.Method, request.Args)
			reply := mobileMessage{Type: "result", ID: request.ID, Data: marshalMobile(data)}
			if err != nil {
				reply.Error = err.Error()
			}
			bridge.send(reply)
		}(message)
	}
	cancel()
	return scanner.Err()
}
