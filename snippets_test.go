package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSnippetCatalogUpgradePreservesWorkspace(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "workspace.json")
	original := defaultState()
	original.SnippetCatalogVersion = 0
	original.Hosts = []Host{{ID: "keep-host", Name: "My host", Address: "192.0.2.1", Port: 2222, Username: "operator"}}
	original.KnownHosts = map[string]string{"keep-host": "trusted-fingerprint"}
	original.Preferences.Theme = "dark"
	original.Snippets = []Snippet{
		{ID: "system", Name: "已修改的内置命令", Command: "hostname", Description: "保留我的改动"},
		{ID: "custom-docker", Name: "我的容器列表", Command: "docker ps -a", Description: "保留名称和说明"},
		{ID: "custom-command", Name: "自定义片段", Command: "printf hello", Category: "我的工具"},
	}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	// Model an existing configuration with no catalog version field at all.
	var legacy map[string]json.RawMessage
	if err = json.Unmarshal(data, &legacy); err != nil {
		t.Fatal(err)
	}
	delete(legacy, "snippetCatalogVersion")
	data, _ = json.Marshal(legacy)
	if err = os.WriteFile(filename, data, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := openStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	got := store.snapshot()
	if got.SnippetCatalogVersion != builtinSnippets.Version || len(got.Snippets) <= len(original.Snippets) {
		t.Fatal("catalog not upgraded")
	}
	if !reflect.DeepEqual(got.Hosts, original.Hosts) || !reflect.DeepEqual(got.KnownHosts, original.KnownHosts) || got.Preferences != original.Preferences {
		t.Fatal("upgrade changed host, trust or preferences")
	}
	if !reflect.DeepEqual(got.Snippets[:3], original.Snippets) {
		t.Fatal("customized snippets changed")
	}
	ids := map[string]bool{}
	commands := map[string]bool{}
	for _, snippet := range got.Snippets {
		if ids[snippet.ID] || commands[snippet.Command] {
			t.Fatalf("duplicate snippet: %+v", snippet)
		}
		ids[snippet.ID], commands[snippet.Command] = true, true
	}
	if ids["disk"] || ids["process"] || ids["orbit-docker-containers"] {
		t.Fatal("deleted or equivalent commands restored")
	}
	reopened, err := openStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reopened.snapshot(), got) {
		t.Fatal("catalog upgrade was not persisted")
	}
}

func TestSnippetCatalogDoesNotRestoreDeletedPresets(t *testing.T) {
	store, err := openStore(filepath.Join(t.TempDir(), "workspace.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(store.state.Snippets) != len(builtinSnippets.Snippets) {
		t.Fatal("new workspace missing presets")
	}
	store.state.Snippets = []Snippet{}
	if err = store.persistLocked(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(store.path)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.state.Snippets) != 0 {
		t.Fatal("deleted presets came back after restarting")
	}
}
