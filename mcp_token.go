package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func loadOrCreateMCPToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		token := strings.TrimSpace(string(data))
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(token)
		if decodeErr != nil || len(decoded) != 32 {
			return "", errors.New("本机 MCP 令牌文件格式无效")
		}
		return token, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return loadOrCreateMCPToken(path)
	}
	if err != nil {
		return "", err
	}
	if _, err = file.WriteString(token + "\n"); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		_ = os.Remove(path)
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	return token, nil
}
