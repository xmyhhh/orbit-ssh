//go:build darwin && !android && !androidtest

package tray

import "testing"

// The menu bar items reach the Go side through darwinTrayCallback.
func TestDarwinTrayCallbackRouting(t *testing.T) {
	shown, hidden, quit := 0, 0, 0
	available := -1
	darwinTray.mu.Lock()
	darwinTray.callbacks = Callbacks{
		Show:         func() { shown++ },
		Hide:         func() { hidden++ },
		Quit:         func() { quit++ },
		Availability: func(ok bool) { available = boolToInt(ok) },
	}
	darwinTray.ready = nil
	darwinTray.mu.Unlock()
	t.Cleanup(func() {
		darwinTray.mu.Lock()
		darwinTray.callbacks = Callbacks{}
		darwinTray.mu.Unlock()
	})

	darwinTrayCallback(1, 0)
	darwinTrayCallback(2, 0)
	darwinTrayCallback(3, 0)
	darwinTrayCallback(0, 1)
	if shown != 1 || hidden != 1 || quit != 1 {
		t.Fatalf("menu actions not routed: show=%d hide=%d quit=%d", shown, hidden, quit)
	}
	if available != 1 {
		t.Fatalf("availability not reported: %d", available)
	}

	// A missing callback must not panic.
	darwinTray.mu.Lock()
	darwinTray.callbacks = Callbacks{}
	darwinTray.mu.Unlock()
	darwinTrayCallback(1, 0)
	darwinTrayCallback(2, 0)
	darwinTrayCallback(3, 0)
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
