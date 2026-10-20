//go:build !android && !androidtest

package main

import (
	"context"
	"log"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) desktopStartup(ctx context.Context) {
	a.desktop = true
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
	stop, err := startSystemTray(trayCallbacks{
		show: a.showFromTray, hide: a.hideFromTray, quit: a.quitFromTray,
		availability: a.setTrayAvailable,
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
