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
	C.OrbitTrayCreate(title, image, imageLen)

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
		darwinTray.callbacks = Callbacks{}
		darwinTray.mu.Unlock()
		return nil, errors.New("无法在菜单栏创建 Orbit SSH 图标")
	}
	return func() {
		C.OrbitTrayDestroy()
		darwinTray.mu.Lock()
		darwinTray.callbacks = Callbacks{}
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
	}
}
