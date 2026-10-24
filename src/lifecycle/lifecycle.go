// Package lifecycle observes native operating-system session termination without
// treating it as a window close or depending on a system tray entry.
package lifecycle

// Start installs the platform's session-ending notification handler. The callback
// is for committed system termination, not ordinary window closes or explicit
// application quit requests. It must not prompt the user and must return within
// three seconds; persist recovery data continuously rather than waiting for exit.
//
// On Windows the callback runs synchronously on a dedicated native receiver
// thread, so Windows does not receive the end-session reply before it finishes.
// The handler deliberately does not impose a timeout by abandoning a callback
// goroutine: the caller owns the callback's time bound.
//
// Retain stop until the application's run function returns, then call it to
// release the monitor. Stop is idempotent and may be called concurrently. On
// Windows it waits for the receiver to finish, except when called on the receiver
// thread itself, where teardown is deferred until the callback returns. A callback
// must not wait for another goroutine that is synchronously stopping the monitor.
func Start(onEndSession func()) (stop func(), err error) {
	return startPlatform(onEndSession)
}
