//go:build !android && !androidtest

package app

import (
	"context"
	goruntime "runtime"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

var showMessageDialog = runtime.MessageDialog

func confirmAction(ctx context.Context, title, message, action string) (bool, error) {
	yes, no := action, "取消"
	// Wails uses MessageBox on Windows: its labels are localized by the OS,
	// but its return values and default-button identifiers are always Yes/No.
	if goruntime.GOOS == "windows" {
		yes, no = "Yes", "No"
	}
	result, err := showMessageDialog(ctx, runtime.MessageDialogOptions{
		Type: runtime.QuestionDialog, Title: title, Message: message,
		Buttons: []string{yes, no}, DefaultButton: no, CancelButton: no,
	})
	return err == nil && result == yes, err
}
