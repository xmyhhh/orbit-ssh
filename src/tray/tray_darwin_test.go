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

func TestDarwinTerminationReply(t *testing.T) {
	for _, tc := range []struct {
		name     string
		callback func(bool) bool
		system   bool
		want     bool
	}{
		{"approved", func(bool) bool { return true }, false, true},
		{"cancelled", func(bool) bool { return false }, false, false},
		{"system", func(system bool) bool { return system }, true, true},
		{"missing-handler", nil, false, false},
		{"missing-handler-system", nil, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			finished, replies := false, 0
			callbacks := Callbacks{Terminate: tc.callback}
			if tc.callback != nil {
				callbacks.Terminate = func(system bool) bool {
					if system != tc.system {
						t.Error("termination reason was lost")
					}
					approved := tc.callback(system)
					finished = true
					return approved
				}
			}
			darwinReplyToTermination(callbacks, tc.system, func(approved bool) {
				replies++
				if approved != tc.want || (tc.callback != nil && !finished) {
					t.Fatalf("incorrect or premature native reply: %v", approved)
				}
			})
			if replies != 1 {
				t.Fatalf("expected exactly one reply, got %d", replies)
			}
		})
	}
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
