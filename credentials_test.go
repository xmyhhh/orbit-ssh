package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestSavedKeyLogin(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	address, fingerprint := testSSHServer(t, signer.PublicKey())
	a := testApp(t, address)
	host, _ := a.store.host("test-host")
	host.AuthType = "key"
	host.KeyPath = filepath.Join(t.TempDir(), "id_ed25519")
	block, err := ssh.MarshalPrivateKeyWithPassphrase(private, "test", []byte("test-key-passphrase"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(host.KeyPath, pem.EncodeToMemory(block), 0600); err != nil {
		t.Fatal(err)
	}
	if err = a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	vault := map[string]string{}
	oldGet, oldSet, oldDelete := getKeyPassphrase, setKeyPassphrase, deleteKeyPassphrase
	t.Cleanup(func() { getKeyPassphrase, setKeyPassphrase, deleteKeyPassphrase = oldGet, oldSet, oldDelete })
	getKeyPassphrase = func(id string) (string, error) {
		v, ok := vault[id]
		if !ok {
			return "", errCredentialNotFound
		}
		return v, nil
	}
	setKeyPassphrase = func(id, value string) error { vault[id] = value; return nil }
	deleteKeyPassphrase = func(id string) error {
		if _, ok := vault[id]; !ok {
			return errCredentialNotFound
		}
		delete(vault, id)
		return nil
	}
	if err = a.Connect("missing", "test-host", Credentials{}, fingerprint, TerminalSize{}); err == nil || !strings.Contains(err.Error(), "KEY_PASSPHRASE_REQUIRED") {
		t.Fatalf("missing passphrase: %v", err)
	}
	if err = a.Connect("key", "test-host", Credentials{Passphrase: "test-key-passphrase"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	if err = a.SaveKeyPassphrase("test-host", "test-key-passphrase"); err != nil {
		t.Fatal(err)
	}
	if err = a.Disconnect("key"); err != nil {
		t.Fatal(err)
	}
	// Reload persisted host metadata and connect with no username/key/secret input.
	reloaded, err := openStore(a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	a.store = reloaded
	saved, _ := a.store.host("test-host")
	if saved.Username != "tester" || saved.KeyPath != host.KeyPath {
		t.Fatalf("key metadata not persisted: %+v", saved)
	}
	if err = a.Connect("saved", "test-host", Credentials{}, "", TerminalSize{}); err != nil {
		t.Fatalf("saved-key login failed: %v", err)
	}
	if err = a.ForgetKeyPassphrase("test-host"); err != nil {
		t.Fatal(err)
	}
	if err = a.ForgetKeyPassphrase("test-host"); err != nil {
		t.Fatal(err)
	}
	if err = a.Connect("forgotten", "test-host", Credentials{}, "", TerminalSize{}); err == nil {
		t.Fatal("forgotten credential still used")
	}
	data, err := os.ReadFile(a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "test-key-passphrase") {
		t.Fatal("passphrase leaked into workspace JSON")
	}
	// A changed key file that is unencrypted must ignore an old saved passphrase.
	block, err = ssh.MarshalPrivateKey(private, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(host.KeyPath, pem.EncodeToMemory(block), 0600); err != nil {
		t.Fatal(err)
	}
	vault[host.ID] = "stale-secret"
	if err = a.Connect("plain", "test-host", Credentials{}, "", TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	setKeyPassphrase = func(string, string) error { return errors.New("vault unavailable") }
	if err = a.SaveKeyPassphrase("test-host", "secret"); err == nil {
		t.Fatal("vault failure was hidden")
	}
}
