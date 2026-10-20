package app

import "sync"

// trayState mirrors the state of the system tray entry. The tray package
// itself only knows how to install the entry and how to report its actions.
type trayState struct {
	mu            sync.Mutex
	ready         bool
	stopped       bool
	quitRequested bool
	prompting     bool
	exiting       bool
	showWindow    func()
	hideWindow    func()
	quitApp       func()
	stop          func()
}

func (a *App) showFromTray() {
	a.tray.mu.Lock()
	show := a.tray.showWindow
	stopped := a.tray.stopped
	a.tray.mu.Unlock()
	if !stopped && show != nil {
		show()
	}
}

func (a *App) hideFromTray() {
	a.tray.mu.Lock()
	hide := a.tray.hideWindow
	ready := a.tray.ready && !a.tray.stopped && !a.tray.prompting && !a.tray.exiting
	a.tray.mu.Unlock()
	if ready && hide != nil {
		hide()
	}
}

func (a *App) quitFromTray() {
	a.tray.mu.Lock()
	if a.tray.stopped || a.tray.prompting || a.tray.exiting || a.tray.quitRequested || a.tray.quitApp == nil {
		a.tray.mu.Unlock()
		return
	}
	a.tray.quitRequested = true
	show, quit := a.tray.showWindow, a.tray.quitApp
	a.tray.mu.Unlock()
	// Restore the owner window before any unsaved-file or active-session dialog.
	if show != nil {
		show()
	}
	quit()
}

func (a *App) setTrayAvailable(available bool) {
	a.tray.mu.Lock()
	wasReady := a.tray.ready
	a.tray.ready = available && !a.tray.stopped
	show := a.tray.showWindow
	stopped := a.tray.stopped
	a.tray.mu.Unlock()
	// Keep the window reachable if Explorer cannot restore the notification icon.
	if wasReady && !available && !stopped && show != nil {
		go show()
	}
}

func (a *App) stopTray() {
	a.tray.mu.Lock()
	stop := a.tray.stop
	a.tray.stop = nil
	a.tray.ready = false
	a.tray.stopped = true
	a.tray.mu.Unlock()
	if stop != nil {
		stop()
	}
}
