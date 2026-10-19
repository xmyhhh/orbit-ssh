//go:build android || androidtest

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
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
	b.mu.Lock()
	b.nextID++
	id := "native-" + strconv.FormatUint(b.nextID, 10)
	result := make(chan mobileMessage, 1)
	b.pending[id] = result
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()
	b.send(mobileMessage{Type: "native", ID: id, Method: method, Args: marshalMobile(args)})
	timer := time.NewTimer(5 * time.Minute)
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

var mobileMethods = map[string]bool{}

func init() {
	for _, name := range []string{
		"GetPlatform", "GetWSLInfo", "LoadState", "SaveHost", "DeleteHost",
		"SavePreferences", "SelectKeyFile", "DataDirectory",
		"SaveKeyPassphrase", "ForgetKeyPassphrase", "HasSavedPassword", "SavePassword", "ForgetPassword",
		"Connect", "Disconnect", "WriteTerminal", "ResizeTerminal", "Monitor",
		"ListDirectory", "ListLocalDirectory", "SelectLocalDirectory", "MakeLocalDirectory", "MakeDirectory",
		"QueueTransfer", "ListTransfers", "CancelTransfer", "ClearTransfers",
		"ReadFilePreview", "ReadRemoteTextFile", "SaveRemoteTextFile", "SetEditorDirty", "UploadFile", "DownloadFile",
	} {
		mobileMethods[name] = true
	}
}

func mobileCall(app *App, method string, args json.RawMessage) (data interface{}, err error) {
	defer func() {
		if recover() != nil {
			data, err = nil, errors.New("Android 后端无法完成此操作")
		}
	}()
	if !mobileMethods[method] {
		return nil, errors.New("不支持的 Android 操作")
	}
	fn := reflect.ValueOf(app).MethodByName(method)
	if !fn.IsValid() {
		return nil, errors.New("Android 操作不存在")
	}
	var raw []json.RawMessage
	if len(args) > 0 {
		if err = json.Unmarshal(args, &raw); err != nil {
			return nil, errors.New("无效的操作参数")
		}
	}
	if len(raw) != fn.Type().NumIn() {
		return nil, errors.New("操作参数数量不匹配")
	}
	values := make([]reflect.Value, len(raw))
	for i, arg := range raw {
		value := reflect.New(fn.Type().In(i))
		if err = json.Unmarshal(arg, value.Interface()); err != nil {
			return nil, fmt.Errorf("操作参数 %d 格式错误", i+1)
		}
		values[i] = value.Elem()
	}
	for _, value := range fn.Call(values) {
		if value.Type().Implements(reflect.TypeFor[error]()) {
			if !value.IsNil() {
				return nil, value.Interface().(error)
			}
		} else {
			data = value.Interface()
		}
	}
	return data, nil
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
