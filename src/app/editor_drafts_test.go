package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func editorDraftTestApp(t *testing.T) (*App, RemoteTextFile) {
	t.Helper()
	a := NewApp()
	a.store = &Store{path: filepath.Join(t.TempDir(), "workspace.json")}
	a.sessions["session-one"] = &remoteSession{host: Host{ID: "stable-host"}}
	a.sessions["session-two"] = &remoteSession{host: Host{ID: "other-host"}}
	document, err := decodeRemoteText("/etc/config.json", []byte("\ufeff{\r\n}\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	return a, document
}

func TestEditorDraftRecoveryIsolationAndDelete(t *testing.T) {
	a, document := editorDraftTestApp(t)
	if draft, err := a.LoadEditorDraft("session-one", document.Path); err != nil || draft != nil {
		t.Fatalf("missing draft: %+v %v", draft, err)
	}
	const edited = "{\n  \"修改\": true\n}\n"
	if err := a.UpdateEditorDraft("editor-one", "session-one", document, edited); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(filepath.Dir(a.store.path), "editor-drafts")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("draft directory: %v %v", entries, err)
	}
	if len(entries[0].Name()) != 69 || !strings.HasSuffix(entries[0].Name(), ".json") {
		t.Fatalf("filename is not a hash: %s", entries[0].Name())
	}
	if runtime.GOOS != "windows" {
		for name, want := range map[string]os.FileMode{dir: 0700, filepath.Join(dir, entries[0].Name()): 0600} {
			info, err := os.Stat(name)
			if err != nil || info.Mode().Perm() != want {
				t.Fatalf("permissions %s: %v %v", name, info, err)
			}
		}
	}
	for _, tc := range []struct{ session, path string }{
		{"session-two", document.Path}, {"session-one", "/etc/another.json"},
	} {
		if draft, err := a.LoadEditorDraft(tc.session, tc.path); err != nil || draft != nil {
			t.Fatalf("draft crossed host/path boundary: %+v %v", draft, err)
		}
	}
	// A fresh process and a differently named session still recover the same
	// host/path. No remote server or real user configuration is involved.
	b := NewApp()
	b.store = &Store{path: a.store.path}
	b.sessions["reconnected"] = &remoteSession{host: Host{ID: "stable-host"}}
	draft, err := b.LoadEditorDraft("reconnected", document.Path)
	if err != nil || draft == nil {
		t.Fatalf("reload: %+v %v", draft, err)
	}
	if draft.Text != edited || draft.Revision != document.Revision || draft.HostID != "stable-host" || !draft.BOM || draft.LineEnding != "CRLF" || draft.EditorID != "editor-one" {
		t.Fatalf("metadata was not retained: %+v", draft)
	}
	if _, err := time.Parse(time.RFC3339Nano, draft.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	if err := b.UpdateEditorDraft("new-editor", "reconnected", document, ""); err != nil {
		t.Fatal(err)
	}
	if draft, err := b.LoadEditorDraft("reconnected", document.Path); err != nil || draft == nil || draft.Text != "" {
		t.Fatalf("empty edit was lost: %+v %v", draft, err)
	}
	if err := b.RemoveEditorDraft("reconnected", document.Path); err != nil {
		t.Fatal(err)
	}
	if err := b.RemoveEditorDraft("reconnected", document.Path); err != nil {
		t.Fatalf("delete must be idempotent: %v", err)
	}
	if draft, err := a.LoadEditorDraft("session-one", document.Path); err != nil || draft != nil {
		t.Fatalf("deleted draft reappeared: %+v %v", draft, err)
	}
}

func TestEditorDraftShutdownIdentityAndIndependentLock(t *testing.T) {
	a, document := editorDraftTestApp(t)
	// Capture before any keystrokes, then simulate session detachment during
	// shutdown while a network save holds fileEditMu.
	if _, err := a.LoadEditorDraft("session-one", document.Path); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	delete(a.sessions, "session-one")
	a.mu.Unlock()
	a.fileEditMu.Lock()
	defer a.fileEditMu.Unlock()
	done := make(chan error, 1)
	go func() { done <- a.UpdateEditorDraft("editor", "session-one", document, "late shutdown edit") }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("local recovery blocked on a remote save")
	}
	draft, err := a.LoadEditorDraft("session-one", document.Path)
	if err != nil || draft == nil || draft.Text != "late shutdown edit" {
		t.Fatalf("detached recovery: %+v %v", draft, err)
	}
	if err := a.RemoveEditorDraft("session-one", document.Path); err != nil {
		t.Fatal(err)
	}
}

func TestEditorDraftValidationAndStorageFailures(t *testing.T) {
	a, document := editorDraftTestApp(t)
	for _, filename := range []string{"", "../escape", "/etc/../escape", "/etc//config", "/", "/etc/\x00bad", "/etc/\xff"} {
		bad := document
		bad.Path = filename
		if err := a.UpdateEditorDraft("editor", "session-one", bad, "edit"); err == nil {
			t.Errorf("accepted path %q", filename)
		}
		if _, err := a.LoadEditorDraft("session-one", filename); err == nil {
			t.Errorf("loaded invalid path %q", filename)
		}
		if err := a.RemoveEditorDraft("session-one", filename); err == nil {
			t.Errorf("deleted invalid path %q", filename)
		}
	}
	for _, text := range []string{strings.Repeat("a", textEditLimit+1), "bad\x00text", "\xff"} {
		if err := a.UpdateEditorDraft("editor", "session-one", document, text); err == nil {
			t.Fatal("invalid text accepted")
		}
	}
	for _, revision := range []string{"", "demo", strings.Repeat("z", 64)} {
		bad := document
		bad.Revision = revision
		if err := a.UpdateEditorDraft("editor", "session-one", bad, "edit"); err == nil {
			t.Fatal("invalid revision accepted")
		}
	}
	if err := a.UpdateEditorDraft("", "session-one", document, "edit"); err == nil {
		t.Fatal("empty editor accepted")
	}
	if err := a.UpdateEditorDraft("editor", "unknown-session", document, "edit"); err == nil {
		t.Fatal("unknown session accepted")
	}
	dir := filepath.Join(filepath.Dir(a.store.path), "editor-drafts")
	if err := os.WriteFile(dir, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.UpdateEditorDraft("editor", "session-one", document, "edit"); err == nil {
		t.Fatal("storage failure not surfaced")
	}
	if _, err := a.LoadEditorDraft("session-one", document.Path); err == nil {
		t.Fatal("read failure not surfaced")
	}
}

func TestEditorDraftRejectsCorruptOrMisidentifiedFiles(t *testing.T) {
	a, document := editorDraftTestApp(t)
	if err := a.UpdateEditorDraft("editor", "session-one", document, "keep me"); err != nil {
		t.Fatal(err)
	}
	draft, err := a.LoadEditorDraft("session-one", document.Path)
	if err != nil {
		t.Fatal(err)
	}
	_, _, filename, err := a.editorDraftLocation("session-one", document.Path)
	if err != nil {
		t.Fatal(err)
	}
	draft.HostID = "another-host"
	data, _ := json.Marshal(draft)
	for _, invalid := range [][]byte{data, []byte("{broken"), []byte("\xff"), []byte(strings.Repeat("x", editorDraftReadLimit+1))} {
		if err := os.WriteFile(filename, invalid, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := a.LoadEditorDraft("session-one", document.Path); err == nil {
			t.Fatal("invalid draft accepted")
		}
		if _, err := os.Stat(filename); err != nil {
			t.Fatal("unreadable draft was deleted")
		}
	}
}

func TestEditorDraftSupportsWindowsRemotePaths(t *testing.T) {
	a, document := editorDraftTestApp(t)
	document.Path = "C:/Users/name/config.txt"
	if err := a.UpdateEditorDraft("editor", "session-one", document, "windows server edit"); err != nil {
		t.Fatal(err)
	}
	draft, err := a.LoadEditorDraft("session-one", document.Path)
	if err != nil || draft == nil || draft.Text != "windows server edit" {
		t.Fatalf("Windows remote draft: %+v %v", draft, err)
	}
	if err := a.RemoveEditorDraft("session-one", document.Path); err != nil {
		t.Fatal(err)
	}
}

func TestEditorDraftRejectsSymlinkDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks requires privileges")
	}
	a, document := editorDraftTestApp(t)
	target := t.TempDir()
	dir := filepath.Join(filepath.Dir(a.store.path), "editor-drafts")
	if err := os.Symlink(target, dir); err != nil {
		t.Fatal(err)
	}
	if err := a.UpdateEditorDraft("editor", "session-one", document, "edit"); err == nil {
		t.Fatal("symlink draft directory accepted")
	}
	entries, err := os.ReadDir(target)
	if err != nil || len(entries) != 0 {
		t.Fatalf("wrote through symlink: %v %v", entries, err)
	}
}
