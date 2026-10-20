package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateHostRejectsPublicKeyFile(t *testing.T) {
	base := Host{
		ID: "host", Name: "Server", Address: "192.0.2.10", Port: 22,
		Username: "root", AuthType: "key", Group: "默认分组", Color: "mint",
	}
	if err := validateHost(base); err == nil {
		t.Fatal("a key host without a private key path should be rejected")
	}

	withPrivate := base
	withPrivate.KeyPath = filepath.Join("keys", "id_ed25519")
	if err := validateHost(withPrivate); err != nil {
		t.Fatalf("a private key path should be accepted: %v", err)
	}

	withPublic := base
	withPublic.KeyPath = filepath.Join("keys", "id_ed25519.pub")
	err := validateHost(withPublic)
	if err == nil {
		t.Fatal("a .pub path should be rejected")
	}
	if !strings.Contains(err.Error(), ".pub") {
		t.Fatalf("the error should mention the public key file: %v", err)
	}

	upper := base
	upper.KeyPath = filepath.Join("keys", "ID_ED25519.PUB")
	if err := validateHost(upper); err == nil {
		t.Fatal("the .pub check should ignore case")
	}
}

func TestValidateHostAllowsPublicKeyPathForOtherAuthTypes(t *testing.T) {
	host := Host{
		ID: "host", Name: "Server", Address: "192.0.2.10", Port: 22,
		Username: "root", AuthType: "password", Group: "默认分组", Color: "mint",
	}
	if err := validateHost(host); err != nil {
		t.Fatalf("a password host should be accepted: %v", err)
	}
}
