package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

func mockPasswordVault(t *testing.T) map[string]string {
	t.Helper()
	vault := map[string]string{}
	oldGet, oldSet, oldDelete := getLoginPassword, setLoginPassword, deleteLoginPassword
	t.Cleanup(func() { getLoginPassword, setLoginPassword, deleteLoginPassword = oldGet, oldSet, oldDelete })
	getLoginPassword = func(id string) (string, error) {
		value, ok := vault[id]
		if !ok {
			return "", keyring.ErrNotFound
		}
		return value, nil
	}
	setLoginPassword = func(id, value string) error { vault[id] = value; return nil }
	deleteLoginPassword = func(id string) error {
		if _, ok := vault[id]; !ok {
			return keyring.ErrNotFound
		}
		delete(vault, id)
		return nil
	}
	return vault
}

func TestSavedPasswordLoginAndForget(t *testing.T) {
	vault := mockPasswordVault(t)
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	if saved, err := a.HasSavedPassword("test-host"); err != nil || saved {
		t.Fatalf("unexpected saved password: %v %v", saved, err)
	}
	if err := a.Connect("missing", "test-host", Credentials{}, fingerprint, TerminalSize{}); err == nil || !strings.Contains(err.Error(), "PASSWORD_REQUIRED|") {
		t.Fatalf("missing password: %v", err)
	}
	if err := a.Connect("manual", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	if len(vault) != 0 {
		t.Fatal("manual login saved password without request")
	}
	if err := a.SavePassword("test-host", "session-only-secret"); err != nil {
		t.Fatal(err)
	}
	if err := a.Disconnect("manual"); err != nil {
		t.Fatal(err)
	}
	// Simulate restarting the application. Only the vault retains the password.
	reopened, err := openStore(a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	a.store = reopened
	if saved, err := a.HasSavedPassword("test-host"); err != nil || !saved {
		t.Fatalf("saved status missing: %v %v", saved, err)
	}
	if err := a.Connect("saved", "test-host", Credentials{}, "", TerminalSize{}); err != nil {
		t.Fatalf("saved login: %v", err)
	}
	previous := vault["test-host"]
	if err := a.Connect("wrong", "test-host", Credentials{Password: "wrong-password"}, "", TerminalSize{}); err == nil {
		t.Fatal("wrong manual password accepted")
	}
	if vault["test-host"] != previous {
		t.Fatal("failed authentication changed saved password")
	}
	if err := a.SavePassword("test-host", ""); err == nil {
		t.Fatal("empty password replaced saved password")
	}
	workspace, err := os.ReadFile(a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	state, err := a.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	publicState, _ := json.Marshal(state)
	if strings.Contains(string(workspace), "session-only-secret") || strings.Contains(string(publicState), "session-only-secret") {
		t.Fatal("password leaked into workspace metadata")
	}
	if err := a.ForgetPassword("test-host"); err != nil {
		t.Fatal(err)
	}
	if err := a.ForgetPassword("test-host"); err != nil {
		t.Fatal("forget must be idempotent", err)
	}
	if saved, err := a.HasSavedPassword("test-host"); err != nil || saved {
		t.Fatal("forgotten credential still present", err)
	}
	if err := a.Connect("forgotten", "test-host", Credentials{}, "", TerminalSize{}); err == nil || !strings.Contains(err.Error(), "PASSWORD_REQUIRED|") {
		t.Fatalf("forgotten password used: %v", err)
	}
}

func TestSavedPasswordIsBoundToLogin(t *testing.T) {
	mockPasswordVault(t)
	address, _ := testSSHServer(t)
	a := testApp(t, address)
	original, _ := a.store.host("test-host")
	if err := a.SavePassword(original.ID, "session-only-secret"); err != nil {
		t.Fatal(err)
	}
	for _, change := range []struct {
		name string
		edit func(*Host)
	}{
		{"address", func(h *Host) { h.Address = "other.example.com" }},
		{"port", func(h *Host) { h.Port++ }},
		{"username", func(h *Host) { h.Username = "other-user" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			host := original
			change.edit(&host)
			if err := a.SaveHost(host); err != nil {
				t.Fatal(err)
			}
			if saved, err := a.HasSavedPassword(host.ID); err != nil || saved {
				t.Fatalf("credential reused after changing %s: %v", change.name, err)
			}
			if err := a.Connect("changed", host.ID, Credentials{}, "", TerminalSize{}); err == nil || !strings.Contains(err.Error(), "PASSWORD_REQUIRED|") {
				t.Fatalf("old credential could be sent to changed login: %v", err)
			}
		})
	}
	if err := a.SaveHost(original); err != nil {
		t.Fatal(err)
	}
	if saved, err := a.HasSavedPassword(original.ID); err != nil || !saved {
		t.Fatal("original binding lost", err)
	}
}

func TestPasswordVaultFailuresAndManualFallback(t *testing.T) {
	vault := mockPasswordVault(t)
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	getLoginPassword = func(string) (string, error) { return "", errors.New("vault locked") }
	if _, err := a.HasSavedPassword("test-host"); err == nil {
		t.Fatal("vault read error hidden")
	}
	if err := a.Connect("locked", "test-host", Credentials{}, fingerprint, TerminalSize{}); err == nil || !strings.Contains(err.Error(), "凭据库") {
		t.Fatalf("vault error missing: %v", err)
	}
	if err := a.Connect("manual", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal("manual password should bypass unavailable vault", err)
	}
	setLoginPassword = func(string, string) error { return errors.New("vault unavailable") }
	if err := a.SavePassword("test-host", "session-only-secret"); err == nil {
		t.Fatal("vault write failure hidden")
	}
	if len(vault) != 0 {
		t.Fatal("failed save created a record")
	}
	deleteLoginPassword = func(string) error { return errors.New("vault locked") }
	if err := a.ForgetPassword("test-host"); err == nil {
		t.Fatal("vault delete failure hidden")
	}
}
