//go:build !android && !androidtest

package app

import (
	"context"
	"log"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"orbitssh/src/lifecycle"
)

func (a *App) startSessionMonitor(ctx context.Context) {
	stop, err := lifecycle.Start(func() {
		a.terminateNative(true)
		// This is not a window close: systemEnding makes OnBeforeClose pass
		// through even if another close confirmation is still pending.
		// Never let Wails/UI marshalling extend the native receiver's deadline.
		go runtime.Quit(ctx)
	})
	if err != nil {
		log.Printf("Session shutdown monitor: %v", err)
	}
	a.lifecycleMu.Lock()
	if a.lifecycleDone {
		a.lifecycleMu.Unlock()
		if stop != nil {
			stop()
		}
		return
	}
	a.lifecycleStop = stop
	a.lifecycleMu.Unlock()
}

// Keep the native receiver alive until its end-session handler has replied.
// Calling stop from shutdownResources could deadlock the Windows receiver.
func (a *App) stopSessionMonitor() {
	a.lifecycleMu.Lock()
	a.lifecycleDone = true
	stop := a.lifecycleStop
	a.lifecycleStop = nil
	a.lifecycleMu.Unlock()
	if stop != nil {
		stop()
	}
}
