//go:build android || androidtest

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"
)

var androidBridge *mobileBridge
var androidConfigDir, androidFilesDir string
var errCredentialNotFound = errors.New("credential not found")

func platformConfigDirectory() (string, error) { return androidConfigDir, nil }
func platformLocalDirectory() (string, error)  { return androidFilesDir, nil }

func platformEvents(context.Context) func(string, ...interface{}) {
	return func(name string, args ...interface{}) {
		androidBridge.send(mobileMessage{Type: "event", Name: name, Args: marshalMobile(args)})
	}
}

func nativeValue(method string, args ...interface{}) (string, error) {
	data, err := androidBridge.native(method, args)
	if err != nil {
		return "", err
	}
	var value string
	err = json.Unmarshal(data, &value)
	return value, err
}

func selectOpenFile(_ context.Context, title string) (string, error) {
	return nativeValue("pickFile", title)
}

func selectDirectory(context.Context) (string, error) {
	return nativeValue("importFiles")
}

func selectSaveFile(_ context.Context, name string) (string, error) {
	return nativeValue("downloadPath", name)
}

func confirmAction(_ context.Context, title, message, action string) (bool, error) {
	data, err := androidBridge.native("confirm", []interface{}{title, message, action})
	if err != nil {
		return false, err
	}
	var confirmed bool
	err = json.Unmarshal(data, &confirmed)
	return confirmed, err
}

func readMobileCredential(key string) (string, error) {
	value, err := nativeValue("vaultGet", key)
	if err != nil && err.Error() == "CREDENTIAL_NOT_FOUND" {
		return "", errCredentialNotFound
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

var getKeyPassphrase = func(id string) (string, error) { return readMobileCredential("key:" + id) }
var setKeyPassphrase = func(id, value string) error { return writeMobileCredential("key:"+id, value) }
var deleteKeyPassphrase = func(id string) error { return deleteMobileCredential("key:" + id) }
var getLoginPassword = func(id string) (string, error) { return readMobileCredential("password:" + id) }
var setLoginPassword = func(id, value string) error { return writeMobileCredential("password:"+id, value) }
var deleteLoginPassword = func(id string) error { return deleteMobileCredential("password:" + id) }

// Android's resolver respects VPNs, private DNS and network changes. The pure-Go
// resolver cannot obtain these settings from /etc/resolv.conf on Android.
func dialSSH(ctx context.Context, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses := []string{host}
	if net.ParseIP(host) == nil {
		data, resolveErr := androidBridge.native("resolve", []interface{}{host})
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
