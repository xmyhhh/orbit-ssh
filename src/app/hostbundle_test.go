package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh"
)

func testAppWithStore(t *testing.T) *App {
	t.Helper()
	store, err := openStore(filepath.Join(t.TempDir(), "workspace.json"))
	if err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	a.ctx = context.Background()
	a.store = store
	t.Cleanup(func() { a.shutdown(context.Background()) })
	return a
}

func TestImportHostListUpdatesByNameAndKeepsJump(t *testing.T) {
	a := testAppWithStore(t)
	if err := a.SaveHost(Host{ID: "bastion", Name: "bastion", Address: "192.0.2.1", Port: 22, Username: "jump", AuthType: "password"}); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveHost(Host{ID: "app", Name: "app", Address: "192.0.2.2", Port: 22, Username: "root", AuthType: "password"}); err != nil {
		t.Fatal(err)
	}
	result, err := a.ImportHostList([]Host{
		{ID: "imported-bastion", Name: "bastion", Address: "192.0.2.9", Port: 2222, Username: "jump", AuthType: "password"},
		{ID: "imported-app", Name: "app", Address: "192.0.2.10", Port: 22, Username: "root", AuthType: "agent", JumpHostID: "imported-bastion"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Added != 0 || result.Updated != 2 {
		t.Fatalf("unexpected result: %+v", result)
	}
	hosts := a.store.snapshot().Hosts
	if len(hosts) != 2 {
		t.Fatalf("import duplicated hosts: %+v", hosts)
	}
	var app Host
	for _, host := range hosts {
		if host.Name == "app" {
			app = host
		}
	}
	if app.AuthType != "agent" || app.Address != "192.0.2.10" {
		t.Fatalf("host was not updated: %+v", app)
	}
	if app.JumpHostID != "bastion" {
		t.Fatalf("jump reference was not remapped: %+v", app)
	}
}

func TestImportHostListRejectsEmpty(t *testing.T) {
	a := testAppWithStore(t)
	if _, err := a.ImportHostList(nil); err == nil {
		t.Fatal("empty import accepted")
	}
}

func TestGenerateKeyPairWritesEd25519Files(t *testing.T) {
	a := testAppWithStore(t)
	privatePath, publicPath, err := a.GenerateKeyPair("test key/one")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(privatePath) != "test-key-one" || filepath.Ext(publicPath) != ".pub" {
		t.Fatalf("unexpected key paths: %q %q", privatePath, publicPath)
	}
	data, err := os.ReadFile(privatePath)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.ParsePrivateKey(data)
	if err != nil {
		t.Fatalf("generated key cannot be parsed: %v", err)
	}
	if signer.PublicKey().Type() != ssh.KeyAlgoED25519 {
		t.Fatalf("unexpected key type: %s", signer.PublicKey().Type())
	}
	public, err := os.ReadFile(publicPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err = ssh.ParseAuthorizedKey(public); err != nil {
		t.Fatalf("public key is invalid: %v", err)
	}
	if _, _, err = a.GenerateKeyPair("test key/one"); err == nil {
		t.Fatal("existing key was overwritten")
	}
}
