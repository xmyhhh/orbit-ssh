// Package mobile implements the pipe protocol between the Android host and the
// Go backend.
//
// The native host and Go communicate over private process pipes, never a TCP
// listener. The WebView can call only the same public API as the desktop app.
package mobile

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

// Message is one frame of the protocol.
type Message struct {
	Type   string          `json:"type"`
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Name   string          `json:"name,omitempty"`
	Args   json.RawMessage `json:"args,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// Marshal encodes a value for the protocol.
func Marshal(value interface{}) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}

// Bridge talks to the native host over the private process pipes.
type Bridge struct {
	ctx     context.Context
	writer  *json.Encoder
	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  uint64
	pending map[string]chan Message
}

// NewBridge creates a bridge that writes its replies to the host.
func NewBridge(ctx context.Context, writer io.Writer) *Bridge {
	return &Bridge{ctx: ctx, writer: json.NewEncoder(writer), pending: map[string]chan Message{}}
}

// Send writes a message to the host.
func (b *Bridge) Send(message Message) {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	_ = b.writer.Encode(message)
}

// Native asks the host for a value.
func (b *Bridge) Native(method string, args []interface{}) (json.RawMessage, error) {
	return b.NativeWithin(method, args, 5*time.Minute)
}

// NativeWithin sends a native request and waits at most the given duration.
// Short timeouts keep the engine responsive when the host does not answer.
func (b *Bridge) NativeWithin(method string, args []interface{}, timeout time.Duration) (json.RawMessage, error) {
	b.mu.Lock()
	b.nextID++
	id := "native-" + strconv.FormatUint(b.nextID, 10)
	result := make(chan Message, 1)
	b.pending[id] = result
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()
	b.Send(Message{Type: "native", ID: id, Method: method, Args: Marshal(args)})
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

// Deliver hands the reply of the host to the request that is waiting for it.
func (b *Bridge) Deliver(message Message) {
	b.mu.Lock()
	result := b.pending[message.ID]
	b.mu.Unlock()
	if result == nil {
		return
	}
	select {
	case result <- message:
	default:
	}
}

// Serve reads the requests of the host until the input ends. Every call is
// answered through the handler, which runs in its own goroutine.
func Serve(bridge *Bridge, input io.Reader, handler func(method string, args json.RawMessage) (interface{}, error)) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 65536), 32*1024*1024)
	for scanner.Scan() {
		var message Message
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		if message.Type == "nativeResult" {
			bridge.Deliver(message)
			continue
		}
		if message.Type != "call" || message.ID == "" {
			continue
		}
		go func(request Message) {
			data, err := handler(request.Method, request.Args)
			reply := Message{Type: "result", ID: request.ID, Data: Marshal(data)}
			if err != nil {
				reply.Error = err.Error()
			}
			bridge.Send(reply)
		}(message)
	}
	return scanner.Err()
}
