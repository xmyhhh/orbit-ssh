//go:build android || androidtest

package platform

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"

	"orbitssh/src/mobile"
)

var bridge *mobile.Bridge
var configDir, filesDir string

// SetDirectories provides the directories the Android host offers.
func SetDirectories(config, files string) {
	configDir, filesDir = config, files
}

// SetBridge provides the pipe to the Android host.
func SetBridge(b *mobile.Bridge) { bridge = b }

// ConfigDirectory returns the directory that holds the workspace.
func ConfigDirectory() (string, error) { return configDir, nil }

// LocalDirectory returns the directory the Android host offers for files.
func LocalDirectory() (string, error) { return filesDir, nil }

// ErrCredentialNotFound reports a missing entry in the credential vault.
var ErrCredentialNotFound = errors.New("credential not found")

// The credential vault is a variable so the tests can replace it.
var (
	GetKeyPassphrase    = func(id string) (string, error) { return readMobileCredential("key:" + id) }
	SetKeyPassphrase    = func(id, value string) error { return writeMobileCredential("key:"+id, value) }
	DeleteKeyPassphrase = func(id string) error { return deleteMobileCredential("key:" + id) }
	GetLoginPassword    = func(id string) (string, error) { return readMobileCredential("password:" + id) }
	SetLoginPassword    = func(id, value string) error { return writeMobileCredential("password:"+id, value) }
	DeleteLoginPassword = func(id string) error { return deleteMobileCredential("password:" + id) }
)

// Events returns the function that sends an event to the user interface.
func Events(context.Context) func(string, ...interface{}) {
	return func(name string, args ...interface{}) {
		bridge.Send(mobile.Message{Type: "event", Name: name, Args: mobile.Marshal(args)})
	}
}

// NotifyBackgroundState tells the host how many sessions are running so it
// can keep the engine alive while the app sits in the background.
func NotifyBackgroundState(count int) {
	if bridge == nil {
		return
	}
	// The host only needs the count, so a slow answer must not stall the
	// engine while a session is starting.
	_, _ = bridge.NativeWithin("setBackground", []interface{}{count}, 3*time.Second)
}

// SelectOpenFile asks the host for a file.
func SelectOpenFile(_ context.Context, title string) (string, error) {
	return nativeValue("pickFile", title)
}

// SelectDirectory asks the host for a folder.
func SelectDirectory(context.Context) (string, error) {
	return nativeValue("importFiles")
}

// SelectSaveFile asks the host where a file should be written.
func SelectSaveFile(_ context.Context, name string) (string, error) {
	return nativeValue("downloadPath", name)
}

// ConfirmAction asks the host to show a question to the user.
func ConfirmAction(_ context.Context, title, message, action string) (bool, error) {
	data, err := bridge.Native("confirm", []interface{}{title, message, action})
	if err != nil {
		return false, err
	}
	var confirmed bool
	err = json.Unmarshal(data, &confirmed)
	return confirmed, err
}

func nativeValue(method string, args ...interface{}) (string, error) {
	data, err := bridge.Native(method, args)
	if err != nil {
		return "", err
	}
	var value string
	err = json.Unmarshal(data, &value)
	return value, err
}

func readMobileCredential(key string) (string, error) {
	value, err := nativeValue("vaultGet", key)
	if err != nil && err.Error() == "CREDENTIAL_NOT_FOUND" {
		return "", ErrCredentialNotFound
	}
	return value, err
}

func writeMobileCredential(key, value string) error {
	_, err := nativeValue("vaultSet", key, value)
	return err
}

func deleteMobileCredential(key string) error {
	_, err := nativeValue("vaultDelete", key)
	return err
}

// Android's resolver respects VPNs, private DNS and network changes. The pure-Go
// resolver cannot obtain these settings from /etc/resolv.conf on Android.
func DialSSH(ctx context.Context, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses := []string{host}
	if net.ParseIP(host) == nil {
		data, resolveErr := bridge.Native("resolve", []interface{}{host})
		if resolveErr != nil {
			return nil, resolveErr
		}
		if err = json.Unmarshal(data, &addresses); err != nil {
			return nil, err
		}
	}
	if len(addresses) == 0 {
		return nil, errors.New("域名没有可用的 IP 地址")
	}
	for _, ip := range addresses {
		if net.ParseIP(ip) == nil {
			continue
		}
		attempt, cancel := context.WithTimeout(ctx, 5*time.Second)
		conn, dialErr := (&net.Dialer{}).DialContext(attempt, "tcp", net.JoinHostPort(ip, port))
		cancel()
		if dialErr == nil {
			return conn, nil
		}
		err = dialErr
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	if err == nil {
		err = errors.New("域名解析结果无效")
	}
	return nil, err
}
