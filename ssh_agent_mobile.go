//go:build android || androidtest

package main

import (
	"fmt"
	"io"
)

// Android has no local SSH agent; key and password authentication are used.
func openAgent() (io.ReadWriter, func(), error) {
	return nil, func() {}, fmt.Errorf("Android 版不支持 SSH Agent，请使用密码或私钥登录")
}
