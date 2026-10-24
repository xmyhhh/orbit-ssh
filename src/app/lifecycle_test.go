package app

import (
	"context"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"orbitssh/src/local"
)

func TestCleanupDeadlineDoesNotWaitForHungTransport(t *testing.T) {
	release := make(chan struct{})
	finished := make(chan struct{})
	start := time.Now()
	if waitForCleanup(20*time.Millisecond, func() { <-release; close(finished) }) {
		t.Fatal("hung cleanup reported completion")
	}
	if time.Since(start) > time.Second {
		t.Fatal("cleanup ignored its deadline")
	}
	// The worker may finish later; it must not block on reporting completion.
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("late cleanup worker was stranded")
	}
}

func TestCleanupCompletesBeforeDeadline(t *testing.T) {
	if !waitForCleanup(time.Second, func() {}) {
		t.Fatal("completed cleanup exceeded deadline")
	}
}

func TestShutdownRejectsNewConnections(t *testing.T) {
	a := testApp(t, "127.0.0.1:22")
	a.shutdown(a.ctx)
	if err := a.Connect("late", "test-host", Credentials{}, "", TerminalSize{}); err == nil {
		t.Fatal("SSH connection accepted during shutdown")
	}
	started := false
	err := a.connectLocalTerminal("late", "shell", TerminalSize{}, func(context.Context, int, int) (local.Terminal, error) {
		started = true
		return nil, io.EOF
	})
	if err == nil || started {
		t.Fatal("local shell started during shutdown")
	}
}

func TestConcurrentShutdownRunsCleanupOnce(t *testing.T) {
	a := NewApp()
	var calls atomic.Int32
	a.tray.stop = func() { calls.Add(1) }
	done := make(chan struct{}, 8)
	for i := 0; i < cap(done); i++ {
		go func() { a.shutdown(context.Background()); done <- struct{}{} }()
	}
	for i := 0; i < cap(done); i++ {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("concurrent shutdown blocked")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("cleanup called %d times", calls.Load())
	}
}
