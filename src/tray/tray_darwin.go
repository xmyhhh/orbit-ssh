//go:build darwin && !android && !androidtest

package tray

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation -framework Cocoa
#include <stdlib.h>
#include "tray_darwin.h"
*/
import "C"

import (
	"errors"
	"sync"
	"time"
	"unsafe"
)

// darwinTray holds the callbacks the menu bar item invokes.
var darwinTray struct {
	mu        sync.Mutex
	callbacks Callbacks
	ready     chan bool
}

// startSystemTray installs the menu bar item and returns a function that
// removes it again.
func Start(callbacks Callbacks) (func(), error) {
	ready := make(chan bool, 1)
	darwinTray.mu.Lock()
	darwinTray.callbacks = callbacks
	darwinTray.ready = ready
	darwinTray.mu.Unlock()

	title := C.CString("Orbit SSH")
	defer C.free(unsafe.Pointer(title))
	var image *C.uchar
	imageLen := C.int(len(asset))
	if len(asset) > 0 {
		image = (*C.uchar)(C.CBytes(asset))
		defer C.free(unsafe.Pointer(image))
	}
	var handleTermination C.int
	if callbacks.Terminate != nil {
		handleTermination = 1
	}
	C.OrbitTrayCreate(title, image, imageLen, handleTermination)

	// The item is installed on the main thread, so wait for the result before
	// reporting the tray as ready.
	var available bool
	select {
	case available = <-ready:
	case <-time.After(5 * time.Second):
	}
	darwinTray.mu.Lock()
	darwinTray.ready = nil
	darwinTray.mu.Unlock()
	if !available {
		darwinTray.mu.Lock()
		// The delegate hook is independent of status item availability. Keep
		// termination working even when the menu bar item cannot be created.
		darwinTray.callbacks = Callbacks{Terminate: callbacks.Terminate}
		darwinTray.mu.Unlock()
		return nil, errors.New("无法在菜单栏创建 Orbit SSH 图标")
	}
	return func() {
		C.OrbitTrayDestroy()
		darwinTray.mu.Lock()
		// Removing the status item does not remove the application delegate
		// hook. Keep lifecycle ownership until process teardown, including an
		// OS shutdown that supersedes a pending user-Quit cleanup.
		darwinTray.callbacks = Callbacks{Terminate: callbacks.Terminate}
		darwinTray.mu.Unlock()
	}, nil
}

func darwinTrayCallback(action, value int) {
	darwinTray.mu.Lock()
	callbacks := darwinTray.callbacks
	ready := darwinTray.ready
	darwinTray.mu.Unlock()
	switch action {
	case 0:
		// The menu bar item was installed, or could not be created.
		if ready != nil {
			ready <- value != 0
		}
		if callbacks.Availability != nil {
			callbacks.Availability(value != 0)
		}
	case 1:
		if callbacks.Show != nil {
			callbacks.Show()
		}
	case 2:
		if callbacks.Hide != nil {
			callbacks.Hide()
		}
	case 3:
		if callbacks.Quit != nil {
			callbacks.Quit()
		}
	case 4:
		darwinReplyToTermination(callbacks, value != 0, func(approved bool) {
			var reply C.int
			if approved {
				reply = 1
			}
			C.OrbitTrayReplyToTermination(reply, C.int(value))
		})
	}
}

func darwinReplyToTermination(callbacks Callbacks, system bool, reply func(bool)) {
	// A missing handler must not turn an OS shutdown into a permanent blocker.
	approved := system
	if callbacks.Terminate != nil {
		approved = callbacks.Terminate(system)
	}
	reply(approved)
}
