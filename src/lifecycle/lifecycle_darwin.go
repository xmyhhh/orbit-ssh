//go:build darwin && !android && !androidtest

package lifecycle

import (
	"os"
	"os/signal"
	"sync"
	"syscall"
)

// AppKit end-session is handled by the delegate. SIGTERM/SIGINT have no AppKit
// handshake; treat them as committed noninteractive exit, never close-to-tray.
func startPlatform(onEndSession func()) (func(), error) {
	incoming := make(chan os.Signal, 2)
	signal.Notify(incoming, os.Interrupt, syscall.SIGTERM)
	stopWorker := observeTerminationSignals(incoming, onEndSession)
	var once sync.Once
	return func() {
		once.Do(func() {
			signal.Stop(incoming)
			stopWorker()
		})
	}, nil
}

func observeTerminationSignals(incoming <-chan os.Signal, onEndSession func()) func() {
	cancel := make(chan struct{})
	var once sync.Once
	go func() {
		select {
		case <-cancel:
			return
		case <-incoming:
			if onEndSession != nil {
				onEndSession()
			}
		}
	}()
	// Do not synchronously join a callback which may itself exit the app.
	return func() { once.Do(func() { close(cancel) }) }
}
