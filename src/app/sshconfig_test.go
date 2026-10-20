package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseSSHConfig(t *testing.T) {
	dir := t.TempDir()
	home := dir
	t.Setenv("HOME", home)
	path := filepath.Join(dir, "config")
	content := `# global defaults
Host *
  ServerAliveInterval 30

Host dev
  HostName 192.0.2.10
  User ubuntu
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host db prod
  HostName db.internal
  User root
  ProxyJump bastion

Host bastion
  HostName bastion.example.com
  User jump

Match host example.com
  User ignored
`
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	entries, err := parseSSHConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	byAlias := map[string]SSHConfigEntry{}
	for _, entry := range entries {
		byAlias[entry.Alias] = entry
	}
	if len(entries) != 4 {
		t.Fatalf("expected 4 concrete hosts, got %d: %+v", len(entries), entries)
	}
	if _, ok := byAlias["*"]; ok {
		t.Fatal("wildcard host was imported")
	}
	dev := byAlias["dev"]
	if dev.Address != "192.0.2.10" || dev.Port != 2222 || dev.Username != "ubuntu" || dev.AuthType != "key" {
		t.Fatalf("unexpected dev entry: %+v", dev)
	}
	if !strings.HasSuffix(dev.KeyPath, filepath.Join(".ssh", "id_ed25519")) {
		t.Fatalf("identity path was not expanded: %q", dev.KeyPath)
	}
	if byAlias["db"].JumpAlias != "bastion" || byAlias["db"].Username != "root" {
		t.Fatalf("proxy jump was not parsed: %+v", byAlias["db"])
	}
	if byAlias["bastion"].AuthType != "agent" {
		t.Fatalf("host without IdentityFile should use agent: %+v", byAlias["bastion"])
	}
}

func TestImportSSHConfigLinksJumpHost(t *testing.T) {
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	entries := []SSHConfigEntry{
		{Alias: "bastion", Name: "bastion", Address: "127.0.0.1", Port: 1, Username: "tester", AuthType: "password"},
		{Alias: "app", Name: "app", Address: "127.0.0.1", Port: 2, Username: "tester", AuthType: "password", JumpAlias: "bastion"},
	}
	result, err := a.ImportSSHConfig(entries)
	if err != nil {
		t.Fatal(err)
	}
	if result.Added != 2 || len(result.HostIDs) != 2 {
		t.Fatalf("unexpected import result: %+v", result)
	}
	snapshot := a.store.snapshot()
	var app Host
	for _, host := range snapshot.Hosts {
		if host.Name == "app" {
			app = host
		}
	}
	if app.JumpHostID == "" {
		t.Fatal("jump host reference was not resolved")
	}
	// Re-importing must update instead of duplicating.
	again, err := a.ImportSSHConfig(entries)
	if err != nil {
		t.Fatal(err)
	}
	if again.Added != 0 || again.Updated != 2 {
		t.Fatalf("repeat import duplicated hosts: %+v", again)
	}
	if len(a.store.snapshot().Hosts) != len(snapshot.Hosts) {
		t.Fatal("repeat import changed host count")
	}
	_ = fingerprint
}

func TestValidateJumpChainRejectsCycle(t *testing.T) {
	cyclic := []Host{
		{ID: "a", JumpHostID: "b"},
		{ID: "b", JumpHostID: "a"},
	}
	if err := validateJumpChain(cyclic, Host{ID: "a", JumpHostID: "b"}); err == nil {
		t.Fatal("cycle accepted")
	}
	if err := validateJumpChain(cyclic, Host{ID: "c", JumpHostID: "missing"}); err == nil {
		t.Fatal("missing jump host accepted")
	}
	valid := []Host{
		{ID: "bastion"},
		{ID: "app", JumpHostID: "bastion"},
	}
	if err := validateJumpChain(valid, Host{ID: "app", JumpHostID: "bastion"}); err != nil {
		t.Fatal(err)
	}
	if err := validateJumpChain(valid, Host{ID: "web", JumpHostID: "app"}); err != nil {
		t.Fatal(err)
	}
}
