//go:build !android && !androidtest

package app

import (
	"context"
	"log"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"orbitssh/src/tray"
)

func (a *App) desktopStartup(ctx context.Context) {
	a.desktop = true
	// Install before starting the MCP listener; callbacks remain immutable
	// after startup and do not race an immediately arriving request.
	a.notifyDecided = a.decideMCPFromNotification
	a.startup(ctx)
	if a.store != nil {
		preferences := a.store.snapshot().Preferences
		if preferences.MCPEnabled {
			if err := a.configureMCP(preferences); err != nil {
				a.mcpMu.Lock()
				a.mcpError = err.Error()
				a.mcpMu.Unlock()
			}
		}
	}
	a.tray.mu.Lock()
	a.tray.showWindow = func() {
		minimised := runtime.WindowIsMinimised(ctx)
		runtime.WindowShow(ctx)
		if minimised {
			runtime.WindowUnminimise(ctx)
		}
	}
	a.tray.hideWindow = func() { runtime.WindowHide(ctx) }
	a.tray.quitApp = func() { runtime.Quit(ctx) }
	a.tray.mu.Unlock()
	// Session shutdown handling must remain available even without a tray icon.
	a.startSessionMonitor(ctx)
	stop, err := tray.Start(tray.Callbacks{
		Show: a.showFromTray, Hide: a.hideFromTray, Quit: a.quitFromTray,
		Availability: a.setTrayAvailable, Terminate: a.terminateNative,
	})
	if err != nil {
		log.Printf("System tray unavailable: %v", err)
		return
	}
	log.Printf("System tray ready")
	a.tray.mu.Lock()
	if a.tray.stopped {
		a.tray.mu.Unlock()
		if stop != nil {
			stop()
		}
		return
	}
	a.tray.stop = stop
	a.tray.ready = stop != nil
	a.tray.mu.Unlock()
}
