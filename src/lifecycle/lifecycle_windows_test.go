//go:build windows && !android && !androidtest

package lifecycle

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var sendMessageTimeout = user32.NewProc("SendMessageTimeoutW")

// Only address windows created by these tests. Never broadcast a session message
// or invoke ExitWindowsEx: the tests must not affect the user's desktop session.
func sendSessionMessage(hwnd uintptr, message uint32, wparam, lparam uintptr) (uintptr, error) {
	var reply uintptr
	ok, _, err := sendMessageTimeout.Call(hwnd, uintptr(message), wparam, lparam,
		0x0002, 5000, uintptr(unsafe.Pointer(&reply))) // SMTO_ABORTIFHUNG
	if ok == 0 {
		return 0, nativeCallError("SendMessageTimeoutW", err)
	}
	return reply, nil
}

func mustSendSessionMessage(t *testing.T, monitor *windowsMonitor, message uint32, wparam, lparam uintptr) uintptr {
	t.Helper()
	reply, err := sendSessionMessage(monitor.hwnd, message, wparam, lparam)
	if err != nil {
		t.Fatal(err)
	}
	return reply
}

func testWindowsMonitor(t *testing.T, callback func()) *windowsMonitor {
	t.Helper()
	monitor, err := newWindowsMonitor(callback)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(monitor.stop)
	return monitor
}

func waitMonitorDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("session receiver did not stop")
	}
}

func TestWindowsSessionNativeStructureSizes(t *testing.T) {
	wantClass, wantMessage := uintptr(48), uintptr(32)
	if unsafe.Sizeof(uintptr(0)) == 8 {
		wantClass, wantMessage = 80, 48
	}
	if got := unsafe.Sizeof(windowClass{}); got != wantClass {
		t.Fatalf("WNDCLASSEX size = %d, want %d", got, wantClass)
	}
	if got := unsafe.Sizeof(windowMessage{}); got != wantMessage {
		t.Fatalf("MSG size = %d, want %d", got, wantMessage)
	}
}

func TestWindowsSessionMonitorHiddenTopLevelWindow(t *testing.T) {
	monitor := testWindowsMonitor(t, nil)
	var pid uint32
	threadID, err := windows.GetWindowThreadProcessId(windows.HWND(monitor.hwnd), &pid)
	if err != nil || pid != windows.GetCurrentProcessId() || threadID != monitor.threadID {
		t.Fatalf("receiver owner: PID=%d thread=%d err=%v", pid, threadID, err)
	}
	if visible, _, _ := user32.NewProc("IsWindowVisible").Call(monitor.hwnd); visible != 0 {
		t.Fatal("session receiver should never be visible")
	}
	// GA_PARENT returns the desktop for a top-level window; a message-only
	// window would instead have HWND_MESSAGE as its parent.
	parent, _, _ := user32.NewProc("GetAncestor").Call(monitor.hwnd, 1)
	desktop, _, _ := user32.NewProc("GetDesktopWindow").Call()
	if parent != desktop {
		t.Fatalf("receiver parent = %#x, want desktop %#x", parent, desktop)
	}
	if reply := mustSendSessionMessage(t, monitor, wmQueryEndSession, 0, 0); reply != 1 {
		t.Fatalf("query reply = %d, want TRUE", reply)
	}
}

func TestWindowsSessionQueryAndCancellationHaveNoSideEffects(t *testing.T) {
	var calls atomic.Int32
	monitor := testWindowsMonitor(t, func() { calls.Add(1) })
	for _, flags := range []uintptr{0, 1, 0x40000000, 0x80000000, 0xc0000001} {
		if reply := mustSendSessionMessage(t, monitor, wmQueryEndSession, 0, flags); reply != 1 {
			t.Fatalf("flags %#x: query reply = %d, want TRUE", flags, reply)
		}
		if reply := mustSendSessionMessage(t, monitor, wmEndSession, 0, flags); reply != 0 {
			t.Fatalf("flags %#x: cancellation reply = %d, want zero", flags, reply)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("query or cancelled shutdown invoked the callback")
	}
	// Cancellation must not consume the next committed termination request.
	mustSendSessionMessage(t, monitor, wmEndSession, 1, 0x80000000)
	if calls.Load() != 1 {
		t.Fatal("termination could not be retried after cancellation")
	}
}

func TestWindowsSessionCommitFlagsAndDuplicateSuppression(t *testing.T) {
	for _, tc := range []struct {
		name  string
		flags uintptr
	}{{"shutdown", 0}, {"close-app", 1}, {"critical", 0x40000000}, {"logoff", 0x80000000}, {"combined", 0xc0000001}} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			monitor := testWindowsMonitor(t, func() { calls.Add(1) })
			// WM_ENDSESSION(TRUE) is sufficient even without an observed query.
			for range 3 {
				if reply := mustSendSessionMessage(t, monitor, wmEndSession, 1, tc.flags); reply != 0 {
					t.Fatalf("end-session reply = %d, want zero", reply)
				}
			}
			mustSendSessionMessage(t, monitor, wmEndSession, 0, tc.flags)
			mustSendSessionMessage(t, monitor, wmEndSession, 1, tc.flags)
			if calls.Load() != 1 {
				t.Fatalf("callback calls = %d, want 1", calls.Load())
			}
		})
	}
}

func TestWindowsSessionReentrantCommit(t *testing.T) {
	var receiver atomic.Pointer[windowsMonitor]
	var calls atomic.Int32
	callbackResult := make(chan error, 1)
	monitor := testWindowsMonitor(t, func() {
		calls.Add(1)
		// Same-thread SendMessage reenters the receiver's native procedure.
		_, err := sendSessionMessage(receiver.Load().hwnd, wmEndSession, 1, 0)
		callbackResult <- err
	})
	receiver.Store(monitor)
	mustSendSessionMessage(t, monitor, wmEndSession, 1, 0)
	if err := <-callbackResult; err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("reentrant commit invoked callback %d times", calls.Load())
	}
}

func TestWindowsSessionCallbackFinishesBeforeReply(t *testing.T) {
	entered, finish := make(chan struct{}), make(chan struct{})
	var release sync.Once
	releaseCallback := func() { release.Do(func() { close(finish) }) }
	var callbackThread atomic.Uint32
	monitor := testWindowsMonitor(t, func() {
		callbackThread.Store(windows.GetCurrentThreadId())
		close(entered)
		<-finish
	})
	// Release before the cleanup registered by testWindowsMonitor waits for stop.
	t.Cleanup(releaseCallback)
	type result struct {
		reply uintptr
		err   error
	}
	replied := make(chan result, 1)
	go func() {
		reply, err := sendSessionMessage(monitor.hwnd, wmEndSession, 1, 0)
		replied <- result{reply, err}
	}()
	waitMonitorDone(t, entered)
	if callbackThread.Load() != monitor.threadID {
		t.Fatal("callback did not run on the receiver thread")
	}
	select {
	case <-replied:
		t.Fatal("WM_ENDSESSION returned before its callback completed")
	default:
	}
	releaseCallback()
	select {
	case result := <-replied:
		if result.err != nil || result.reply != 0 {
			t.Fatalf("end-session reply = %d, err=%v", result.reply, result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("end-session reply did not arrive after cleanup")
	}
}

func TestWindowsSessionStopOnReceiverThread(t *testing.T) {
	var receiver atomic.Pointer[windowsMonitor]
	var callbackFinished atomic.Bool
	monitor := testWindowsMonitor(t, func() {
		receiver.Load().stop()
		callbackFinished.Store(true)
	})
	receiver.Store(monitor)
	mustSendSessionMessage(t, monitor, wmEndSession, 1, 0)
	waitMonitorDone(t, monitor.done)
	if !callbackFinished.Load() {
		t.Fatal("stop blocked its own receiver thread")
	}
	monitor.stop()
}

func TestWindowsSessionConcurrentStopDuringCallback(t *testing.T) {
	entered, finish := make(chan struct{}), make(chan struct{})
	var release sync.Once
	releaseCallback := func() { release.Do(func() { close(finish) }) }
	var receiver atomic.Pointer[windowsMonitor]
	monitor := testWindowsMonitor(t, func() {
		close(entered)
		<-finish
		// An external stop may already be joining us. A receiver-thread stop
		// must still return without waiting for that caller or for itself.
		receiver.Load().stop()
	})
	receiver.Store(monitor)
	t.Cleanup(releaseCallback)
	sendDone := make(chan error, 1)
	go func() {
		_, err := sendSessionMessage(monitor.hwnd, wmEndSession, 1, 0)
		sendDone <- err
	}()
	waitMonitorDone(t, entered)
	var stops sync.WaitGroup
	for range 16 {
		stops.Add(1)
		go func() { defer stops.Done(); monitor.stop() }()
	}
	select {
	case <-monitor.done:
		t.Fatal("receiver stopped before the callback finished")
	default:
	}
	releaseCallback()
	waitMonitorDone(t, monitor.done)
	stopsDone := make(chan struct{})
	go func() { stops.Wait(); close(stopsDone) }()
	waitMonitorDone(t, stopsDone)
	if err := <-sendDone; err != nil {
		t.Fatal(err)
	}
	monitor.stop()
}

func TestWindowsSessionStopReleasesNativeResources(t *testing.T) {
	monitor := testWindowsMonitor(t, nil)
	monitor.stop()
	waitMonitorDone(t, monitor.done)
	if _, found := sessionWindows.Load(monitor.hwnd); found {
		t.Fatal("receiver remained in the native-window registry")
	}
	if exists, _, _ := user32.NewProc("IsWindow").Call(monitor.hwnd); exists != 0 {
		t.Fatal("receiver window survived stop")
	}
	var class windowClass
	class.Size = uint32(unsafe.Sizeof(class))
	if exists, _, _ := user32.NewProc("GetClassInfoExW").Call(monitor.instance,
		uintptr(unsafe.Pointer(monitor.class)), uintptr(unsafe.Pointer(&class))); exists != 0 {
		t.Fatal("receiver window class survived stop")
	}
	monitor.stop()
}

func TestWindowsSessionStartupErrorJoinsAndReleases(t *testing.T) {
	failure := errors.New("injected failure after native initialization")
	var initialized *windowsMonitor
	monitor, err := launchWindowsMonitor(nil, func(m *windowsMonitor) error {
		initialized = m
		if err := m.initialize(); err != nil {
			return err
		}
		return failure
	})
	if monitor != nil || !errors.Is(err, failure) {
		t.Fatalf("failed startup returned monitor=%v err=%v", monitor, err)
	}
	select {
	case <-initialized.done:
	default:
		t.Fatal("failed startup returned before its receiver stopped")
	}
	if _, found := sessionWindows.Load(initialized.hwnd); found {
		t.Fatal("failed startup leaked its native-window registry entry")
	}
	if exists, _, _ := user32.NewProc("IsWindow").Call(initialized.hwnd); exists != 0 {
		t.Fatal("failed startup leaked its native window")
	}
	initialized.stop()
}

func TestWindowsLifecycleStartStop(t *testing.T) {
	for range 3 {
		stop, err := Start(nil)
		if err != nil || stop == nil {
			t.Fatalf("Start(nil): stop available=%v err=%v", stop != nil, err)
		}
		stop()
		stop()
	}
}
