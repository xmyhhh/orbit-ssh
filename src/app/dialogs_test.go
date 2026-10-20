//go:build !android && !androidtest

package app

import (
	"context"
	"errors"
	goruntime "runtime"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func TestCloseConfirmation(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	a.pending["connecting"] = func() {}
	original := showMessageDialog
	t.Cleanup(func() { showMessageDialog = original })
	yes, no := "结束并退出", "取消"
	if goruntime.GOOS == "windows" {
		yes, no = "Yes", "No"
	}
	for _, tc := range []struct {
		name, reply string
		err         error
		block       bool
	}{
		{"confirmed", yes, nil, false}, {"cancelled", no, nil, true},
		{"dismissed", "", nil, true}, {"dialog failed", "", errors.New("failed"), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			showMessageDialog = func(_ context.Context, options runtime.MessageDialogOptions) (string, error) {
				if options.DefaultButton != no || options.CancelButton != no || len(options.Buttons) != 2 || options.Buttons[0] != yes {
					t.Fatalf("incorrect native button mapping: %+v", options)
				}
				return tc.reply, tc.err
			}
			if got := a.beforeClose(context.Background()); got != tc.block {
				t.Fatalf("beforeClose blocks=%v, want %v", got, tc.block)
			}
		})
	}
	showMessageDialog = func(context.Context, runtime.MessageDialogOptions) (string, error) {
		t.Fatal("unexpected dialog without active sessions")
		return "", nil
	}
	delete(a.pending, "connecting")
	if a.beforeClose(context.Background()) {
		t.Fatal("idle window cannot close")
	}
	a.pending["connecting"] = func() {}
	a.store.mu.Lock()
	a.store.state.Preferences.ConfirmClose = false
	a.store.mu.Unlock()
	if a.beforeClose(context.Background()) {
		t.Fatal("disabled confirmation still blocks exit")
	}
}

func TestDirtyEditorCloseConfirmation(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	a.store.state.Preferences.ConfirmClose = false
	original := showMessageDialog
	t.Cleanup(func() { showMessageDialog = original })
	a.SetEditorDirty("draft", true)
	for _, discard := range []bool{false, true} {
		showMessageDialog = func(_ context.Context, options runtime.MessageDialogOptions) (string, error) {
			if !strings.Contains(options.Message, "未保存") {
				t.Fatal("missing unsaved-file warning")
			}
			if discard {
				return options.Buttons[0], nil
			}
			return options.CancelButton, nil
		}
		if block := a.beforeClose(context.Background()); block == discard {
			t.Fatal("incorrect unsaved-file close result")
		}
	}
	a.SetEditorDirty("draft", false)
	showMessageDialog = func(context.Context, runtime.MessageDialogOptions) (string, error) {
		t.Fatal("unexpected dialog after clearing draft")
		return "", nil
	}
	if a.beforeClose(context.Background()) {
		t.Fatal("clean editor blocked close")
	}
}
