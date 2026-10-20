//go:build !android && !androidtest

package platform

import (
	"context"
	"net"
	"os"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/zalando/go-keyring"
)

// ConfigDirectory returns the directory that holds the workspace.
func ConfigDirectory() (string, error) { return os.UserConfigDir() }

// LocalDirectory returns the directory of the current user.
func LocalDirectory() (string, error) { return os.UserHomeDir() }

// ErrCredentialNotFound reports a missing entry in the credential vault.
var ErrCredentialNotFound = keyring.ErrNotFound

// The credential vault is a variable so the tests can replace it.
var (
	GetKeyPassphrase    = func(id string) (string, error) { return keyring.Get(Service, "key:"+id) }
	SetKeyPassphrase    = func(id, value string) error { return keyring.Set(Service, "key:"+id, value) }
	DeleteKeyPassphrase = func(id string) error { return keyring.Delete(Service, "key:"+id) }
	GetLoginPassword    = func(id string) (string, error) { return keyring.Get(Service, "password:"+id) }
	SetLoginPassword    = func(id, value string) error { return keyring.Set(Service, "password:"+id, value) }
	DeleteLoginPassword = func(id string) error { return keyring.Delete(Service, "password:"+id) }
)

// Events returns the function that sends an event to the user interface.
func Events(ctx context.Context) func(string, ...interface{}) {
	return func(name string, args ...interface{}) { runtime.EventsEmit(ctx, name, args...) }
}

// NotifyBackgroundState does nothing on the desktop, where the window keeps
// the process alive on its own.
func NotifyBackgroundState(int) {}

// SelectOpenFile asks the user for a file.
func SelectOpenFile(ctx context.Context, title string) (string, error) {
	return runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{Title: title, ShowHiddenFiles: true})
}

// SelectDirectory asks the user for a folder.
func SelectDirectory(ctx context.Context) (string, error) {
	return runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{Title: "选择本地文件夹", ShowHiddenFiles: true})
}

// SelectSaveFile asks the user where a file should be written.
func SelectSaveFile(ctx context.Context, name string) (string, error) {
	return runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{Title: "保存下载文件", DefaultFilename: name})
}

// DialSSH opens a connection to the given address.
func DialSSH(ctx context.Context, address string) (net.Conn, error) {
	return (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", address)
}
