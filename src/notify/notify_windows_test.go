//go:build windows && !android && !androidtest

package notify

import (
	"sync"
	"testing"
	"time"
)

func TestWindowsPostSkipsResolvedRequest(t *testing.T) {
	original := windowsRunEncodedCommand
	windowsRunEncodedCommand = func(string) bool {
		t.Fatal("resolved requests must not start PowerShell")
		return false
	}
	defer func() { windowsRunEncodedCommand = original }()
	if windowsPostApproval("title", "body", "windows-test-not-registered") {
		t.Fatal("resolved request was reported as posted")
	}
}

func TestWindowsForgetDoesNotWaitForWithdrawal(t *testing.T) {
	const requestID = "windows-test-withdraw"
	original := windowsRunEncodedCommand
	started := make(chan string, 1)
	release := make(chan struct{})
	done := make(chan struct{})
	windowsRunEncodedCommand = func(command string) bool {
		defer close(done)
		started <- command
		<-release
		return true
	}
	t.Cleanup(func() {
		close(release)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("withdrawal helper did not finish")
		}
		windowsRunEncodedCommand = original
	})
	Register(requestID, Handlers{})
	forgotten := make(chan struct{})
	go func() {
		Forget(requestID)
		close(forgotten)
	}()
	select {
	case command := <-started:
		if command != windowsToastRemoveEncodedCommand(requestID) {
			t.Fatal("Forget did not withdraw the request's toast")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("withdrawal never started")
	}
	select {
	case <-forgotten:
	case <-time.After(2 * time.Second):
		t.Fatal("Forget waited for the PowerShell withdrawal")
	}
	if isPending(requestID) {
		t.Fatal("Forget left request callbacks registered")
	}
}

func TestWindowsPostWithdrawsWhenResolvedDuringSend(t *testing.T) {
	const requestID = "windows-test-resolved-during-send"
	original := windowsRunEncodedCommand
	postCommand := windowsToastEncodedCommand("title", "body", requestID)
	removeCommand := windowsToastRemoveEncodedCommand(requestID)
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	withdrawn := make(chan string, 2)
	finished := make(chan bool, 1)
	windowsRunEncodedCommand = func(command string) bool {
		if command == postCommand {
			close(started)
			<-release
		} else {
			withdrawn <- command
		}
		return true
	}
	Register(requestID, Handlers{})
	postDone := make(chan struct{})
	go func() {
		defer close(postDone)
		finished <- windowsPostApproval("title", "body", requestID)
	}()
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		<-postDone
		// Withdrawal captures its runner before starting the goroutine, so
		// restoring the stub cannot race with queued cleanup.
		windowsRunEncodedCommand = original
		mu.Lock()
		delete(pending, requestID)
		mu.Unlock()
	})
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("posting never started")
	}
	Forget(requestID)
	select {
	case command := <-withdrawn:
		if command != removeCommand {
			t.Fatal("Forget withdrew the wrong toast")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Forget never withdrew the toast")
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case accepted := <-finished:
		if accepted {
			t.Fatal("a request resolved during posting must not report success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("posting never finished")
	}
	select {
	case command := <-withdrawn:
		if command != removeCommand {
			t.Fatal("post-completion cleanup withdrew the wrong toast")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("posting failed to withdraw again after the stale Show completed")
	}
}
