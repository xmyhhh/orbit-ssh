//go:build !android && !androidtest

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func TestCloseToTrayKeepsWorkspace(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	hidden, cancelled := 0, 0
	a.tray.ready = true
	a.tray.hideWindow = func() { hidden++ }
	a.pending["terminal"] = func() { cancelled++ }
	a.SetEditorDirty("draft", true)
	original := showMessageDialog
	t.Cleanup(func() { showMessageDialog = original })
	showMessageDialog = func(context.Context, runtime.MessageDialogOptions) (string, error) {
		t.Fatal("hiding a window must not discard drafts or confirm disconnects")
		return "", nil
	}
	if !a.beforeClose(context.Background()) || hidden != 1 {
		t.Fatal("window was not hidden to the tray")
	}
	if cancelled != 0 || len(a.pending) != 1 || !a.dirtyEditors["draft"] {
		t.Fatal("hiding the window changed the active workspace")
	}
}

func TestTrayQuitCancellation(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	a.ctx = context.Background()
	a.SetEditorDirty("draft", true)
	a.tray.ready = true
	hidden, shown, quitCalls, prompts := 0, 0, 0, 0
	a.tray.hideWindow = func() { hidden++ }
	a.tray.showWindow = func() { shown++ }
	blocked := false
	a.tray.quitApp = func() { quitCalls++; blocked = a.beforeClose(a.ctx) }
	original := showMessageDialog
	t.Cleanup(func() { showMessageDialog = original })
	approve := false
	showMessageDialog = func(_ context.Context, options runtime.MessageDialogOptions) (string, error) {
		prompts++
		// Another close or tray click during this dialog must not hide it or open another.
		if !a.beforeClose(a.ctx) {
			t.Fatal("a second close bypassed the active confirmation")
		}
		a.quitFromTray()
		if approve {
			return options.Buttons[0], nil
		}
		return options.CancelButton, nil
	}
	a.quitFromTray()
	if !blocked || shown != 1 || quitCalls != 1 || prompts != 1 || hidden != 0 {
		t.Fatal("tray exit did not preserve the cancelled confirmation")
	}
	if !a.beforeClose(a.ctx) || hidden != 1 || prompts != 1 {
		t.Fatal("cancelled exit changed subsequent close-to-tray behavior")
	}
	approve = true
	a.quitFromTray()
	if blocked || shown != 2 || quitCalls != 2 || prompts != 2 || !a.tray.exiting {
		t.Fatal("explicit tray exit did not bypass hiding after approval")
	}
}

func TestCloseWithoutAvailableTrayExits(t *testing.T) {
	for _, tc := range []struct {
		name               string
		ready, closeToTray bool
	}{{"disabled", true, false}, {"unavailable", false, true}} {
		t.Run(tc.name, func(t *testing.T) {
			a := testApp(t, "127.0.0.1:22")
			a.tray.ready = tc.ready
			a.tray.hideWindow = func() { t.Fatal("window hidden without a usable tray preference") }
			a.store.state.Preferences.CloseToTray = tc.closeToTray
			if a.beforeClose(context.Background()) {
				t.Fatal("idle window cannot exit")
			}
		})
	}
}

func TestTrayFailureRestoresWindowAndStopsOnce(t *testing.T) {
	a := NewApp()
	restored := make(chan struct{}, 1)
	a.tray.ready = true
	a.tray.showWindow = func() { restored <- struct{}{} }
	stopped := 0
	a.tray.stop = func() { stopped++; a.setTrayAvailable(false) }
	a.setTrayAvailable(false)
	select {
	case <-restored:
	case <-time.After(time.Second):
		t.Fatal("losing the tray left the application unreachable")
	}
	a.stopTray()
	a.stopTray()
	a.setTrayAvailable(true)
	if stopped != 1 || a.tray.ready {
		t.Fatal("tray was stopped twice or became available after shutdown")
	}
}

func TestCloseToTrayPreferenceMigration(t *testing.T) {
	state := defaultState()
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var legacy map[string]interface{}
	if err := json.Unmarshal(data, &legacy); err != nil {
		t.Fatal(err)
	}
	delete(legacy["preferences"].(map[string]interface{}), "closeToTray")
	data, _ = json.Marshal(legacy)
	filename := filepath.Join(t.TempDir(), "workspace.json")
	if err := os.WriteFile(filename, data, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := openStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	if !store.snapshot().Preferences.CloseToTray {
		t.Fatal("existing workspaces did not get the default tray behavior")
	}
	a := NewApp()
	a.store = store
	p := store.snapshot().Preferences
	p.CloseToTray = false
	if err := a.SavePreferences(p); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.snapshot().Preferences.CloseToTray {
		t.Fatal("disabled tray preference was lost on restart")
	}
}
