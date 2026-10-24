//go:build darwin && !android && !androidtest

package lifecycle

import (
	"os"
	"syscall"
	"testing"
	"time"
)

func TestDarwinTerminationSignalRouting(t *testing.T) {
	incoming := make(chan os.Signal, 2)
	calls := make(chan struct{}, 2)
	stop := observeTerminationSignals(incoming, func() { calls <- struct{}{} })
	defer stop()
	incoming <- syscall.SIGTERM
	incoming <- os.Interrupt
	select {
	case <-calls:
	case <-time.After(time.Second):
		t.Fatal("termination signal was not handled")
	}
	select {
	case <-calls:
		t.Fatal("termination callback ran twice")
	case <-time.After(10 * time.Millisecond):
	}
}

func TestDarwinTerminationMonitorStop(t *testing.T) {
	incoming := make(chan os.Signal)
	stop := observeTerminationSignals(incoming, func() { t.Error("stopped monitor handled a signal") })
	stop()
	stop()
	// No real process signal or AppKit termination is sent by these tests.
}
