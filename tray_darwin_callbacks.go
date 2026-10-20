//go:build darwin && !android && !androidtest

package main

/*
#include <stdlib.h>
#include "tray_darwin.h"
*/
import "C"

// OrbitTrayAction is called by the menu bar items. It runs on the main thread,
// so the work is moved to a goroutine to keep the menu responsive.
//
//export OrbitTrayAction
func OrbitTrayAction(action C.int, value C.int) {
	go darwinTrayCallback(int(action), int(value))
}
