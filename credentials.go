package main

import (
	"encoding/json"
	"errors"
	"fmt"
)

const credentialService = "OrbitSSH"

// Keep the endpoint binding inside the encrypted vault record. Editing a host's
// address, port or username must never send its old password to another login.
type passwordCredential struct {
	Address  string `json:"address"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func savedPassword(host Host) (string, error) {
	value, err := getLoginPassword(host.ID)
	if errors.Is(err, errCredentialNotFound) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("无法读取保存的密码，请解锁系统凭据库或手动输入密码：%w", err)
	}
	var saved passwordCredential
	if json.Unmarshal([]byte(value), &saved) != nil {
		return "", errors.New("保存的密码记录无法读取，请重新输入密码")
	}
	if saved.Address != host.Address || saved.Port != host.Port || saved.Username != host.Username {
		return "", nil
	}
	return saved.Password, nil
}

// Expose only presence to the WebView; saved passwords stay in the Go backend.
func (a *App) HasSavedPassword(hostID string) (bool, error) {
	if err := a.ready(); err != nil {
		return false, err
	}
	host, err := a.store.host(hostID)
	if err != nil {
		return false, err
	}
	if host.AuthType != "password" {
		return false, nil
	}
	password, err := savedPassword(host)
	return password != "", err
}

func (a *App) SavePassword(hostID, password string) error {
	if err := a.ready(); err != nil {
		return err
	}
	host, err := a.store.host(hostID)
	if err != nil {
		return err
	}
	if host.AuthType != "password" {
		return errors.New("只有密码登录可以保存登录密码")
	}
	if password == "" {
		return errors.New("不能保存空密码")
	}
	value, err := json.Marshal(passwordCredential{Address: host.Address, Port: host.Port, Username: host.Username, Password: password})
	if err != nil {
		return err
	}
	if err = setLoginPassword(hostID, string(value)); err != nil {
		return fmt.Errorf("系统凭据库保存失败：%w", err)
	}
	return nil
}

func (a *App) ForgetPassword(hostID string) error {
	if err := a.ready(); err != nil {
		return err
	}
	err := deleteLoginPassword(hostID)
	if errors.Is(err, errCredentialNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("清除保存的密码失败：%w", err)
	}
	return nil
}

// The OS credential store holds secrets. Workspace JSON contains only metadata.
func (a *App) SaveKeyPassphrase(hostID, passphrase string) error {
	if err := a.ready(); err != nil {
		return err
	}
	host, err := a.store.host(hostID)
	if err != nil {
		return err
	}
	if host.AuthType != "key" {
		return errors.New("只有私钥登录可以保存私钥口令")
	}
	if passphrase == "" {
		return nil
	}
	if err = setKeyPassphrase(hostID, passphrase); err != nil {
		return fmt.Errorf("系统凭据库保存失败：%w", err)
	}
	return nil
}

func (a *App) ForgetKeyPassphrase(hostID string) error {
	if err := a.ready(); err != nil {
		return err
	}
	err := deleteKeyPassphrase(hostID)
	if errors.Is(err, errCredentialNotFound) {
		return nil
	}
	return err
}
