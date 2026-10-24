// Package tray installs the system tray or menu bar entry of the application.
//
// Every platform provides its own implementation, so the rest of the code only
// deals with the callbacks below.
package tray

// Callbacks are the actions the tray entry triggers in the application.
type Callbacks struct {
	// Show brings the main window back to the front.
	Show func()
	// Hide moves the main window out of sight.
	Hide func()
	// Quit asks the application to exit.
	Quit func()
	// Terminate handles native application/session termination. system is true
	// for OS shutdown, restart or logout: never prompt or hide to the tray.
	// Cleanup has a bounded deadline and finishes before replying to the OS.
	// A user-initiated native Quit (system=false) may be cancelled.
	Terminate func(system bool) bool
	// Availability reports whether the tray entry could be installed.
	Availability func(bool)
}
