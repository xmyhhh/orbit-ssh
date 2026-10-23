//go:build linux && !android && !androidtest

package notify

import (
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

func TestLinuxSignalRouting(t *testing.T) {
	testBackend(t, nil, nil)
	decisions := make(chan bool, 4)
	Register("linux-signal-test", Handlers{Decide: func(approved bool) error {
		decisions <- approved
		return nil
	}})
	defer Forget("linux-signal-test")
	linuxMu.Lock()
	linuxObjects[123] = "linux-signal-test"
	linuxMu.Unlock()
	defer func() {
		linuxMu.Lock()
		delete(linuxObjects, 123)
		linuxMu.Unlock()
	}()

	// Malformed signals and the close signal must never be treated as actions.
	for _, signal := range []*dbus.Signal{
		nil,
		{Path: linuxPath, Name: linuxService + ".ActionInvoked"},
		{Path: linuxPath, Name: linuxService + ".ActionInvoked", Body: []any{uint32(123)}},
		{Path: linuxPath, Name: linuxService + ".ActionInvoked", Body: []any{uint32(123), uint32(3)}},
		{Path: "/other", Name: linuxService + ".ActionInvoked", Body: []any{uint32(123), "allow"}},
	} {
		linuxHandleSignal(signal)
	}
	select {
	case <-decisions:
		t.Fatal("malformed signal decided a request")
	default:
	}
	linuxHandleSignal(&dbus.Signal{
		Path: linuxPath, Name: linuxService + ".ActionInvoked", Body: []any{uint32(123), "deny"},
	})
	select {
	case approved := <-decisions:
		if approved {
			t.Fatal("deny signal approved a command")
		}
	case <-time.After(time.Second):
		t.Fatal("action was not delivered")
	}
	linuxHandleSignal(&dbus.Signal{
		Path: linuxPath, Name: linuxService + ".NotificationClosed", Body: []any{uint32(123), uint32(2)},
	})
	if !isPending("linux-signal-test") {
		t.Fatal("closing a banner must not decide the request")
	}
	linuxHandleSignal(&dbus.Signal{
		Path: linuxPath, Name: linuxService + ".ActionInvoked", Body: []any{uint32(123), "allow"},
	})
	select {
	case <-decisions:
		t.Fatal("closed banner retained an action mapping")
	default:
	}
}
