//go:build darwin && !android && !androidtest

package tray

/*
#include <stdlib.h>
#include "tray_darwin.h"
*/
import "C"

// OrbitTrayAction is called by menu bar items and application delegate hooks.
// It runs on the main thread, so confirmations and cleanup move to a goroutine
// to keep AppKit responsive while it waits for a termination reply.
//
//export OrbitTrayAction
func OrbitTrayAction(action C.int, value C.int) {
	go darwinTrayCallback(int(action), int(value))
}
