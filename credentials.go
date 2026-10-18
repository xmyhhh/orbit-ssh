package main

import (
	"errors"
	"fmt"

	"github.com/zalando/go-keyring"
)

const credentialService = "OrbitSSH"

var getKeyPassphrase = func(id string) (string, error) { return keyring.Get(credentialService, "key:"+id) }
var setKeyPassphrase = func(id, value string) error { return keyring.Set(credentialService, "key:"+id, value) }
var deleteKeyPassphrase = func(id string) error { return keyring.Delete(credentialService, "key:"+id) }

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
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
