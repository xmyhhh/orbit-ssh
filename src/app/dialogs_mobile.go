//go:build android || androidtest

package app

import (
	"context"

	"orbitssh/src/platform"
)

// confirmAction asks the Android host to show the question to the user.
func confirmAction(ctx context.Context, title, message, action string) (bool, error) {
	return platform.ConfirmAction(ctx, title, message, action)
}
