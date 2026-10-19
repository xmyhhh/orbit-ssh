//go:build !android && !androidtest

package main

import (
	"context"
	"net"
	"os"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/zalando/go-keyring"
)

func platformConfigDirectory() (string, error) { return os.UserConfigDir() }
func platformLocalDirectory() (string, error)  { return os.UserHomeDir() }

var errCredentialNotFound = keyring.ErrNotFound
var getKeyPassphrase = func(id string) (string, error) { return keyring.Get(credentialService, "key:"+id) }
var setKeyPassphrase = func(id, value string) error { return keyring.Set(credentialService, "key:"+id, value) }
var deleteKeyPassphrase = func(id string) error { return keyring.Delete(credentialService, "key:"+id) }
var getLoginPassword = func(id string) (string, error) { return keyring.Get(credentialService, "password:"+id) }
var setLoginPassword = func(id, value string) error { return keyring.Set(credentialService, "password:"+id, value) }
var deleteLoginPassword = func(id string) error { return keyring.Delete(credentialService, "password:"+id) }

func platformEvents(ctx context.Context) func(string, ...interface{}) {
	return func(name string, args ...interface{}) { runtime.EventsEmit(ctx, name, args...) }
}

func selectOpenFile(ctx context.Context, title string) (string, error) {
	return runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{Title: title, ShowHiddenFiles: true})
}

func selectDirectory(ctx context.Context) (string, error) {
	return runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{Title: "选择本地文件夹", ShowHiddenFiles: true})
}

func selectSaveFile(ctx context.Context, name string) (string, error) {
	return runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{Title: "保存下载文件", DefaultFilename: name})
}

func dialSSH(ctx context.Context, address string) (net.Conn, error) {
	return (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", address)
}
