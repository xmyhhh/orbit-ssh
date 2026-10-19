//go:build android || androidtest

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
)

// Only APIs used by the mobile frontend may be invoked over its process pipe.
var mobileMethods = map[string]bool{}

func init() {
	for _, name := range []string{
		"GetPlatform", "GetWSLInfo", "LoadState", "SaveHost", "DeleteHost",
		"SavePreferences", "SelectKeyFile", "DataDirectory",
		"SaveKeyPassphrase", "ForgetKeyPassphrase", "HasSavedPassword", "SavePassword", "ForgetPassword",
		"Connect", "Disconnect", "WriteTerminal", "ResizeTerminal", "Monitor",
		"SyncTerminalHistory", "UpsertTerminalHistory", "AppendTerminalHistory", "DeleteTerminalHistory",
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
