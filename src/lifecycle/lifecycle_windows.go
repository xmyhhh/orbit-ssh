//go:build windows && !android && !androidtest

package lifecycle

import (
	"fmt"
	"log"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmClose           = 0x0010
	wmDestroy         = 0x0002
	wmNCDestroy       = 0x0082
	wmQueryEndSession = 0x0011
	wmEndSession      = 0x0016
	wmQuit            = 0x0012
)

var (
	user32                    = windows.NewLazySystemDLL("user32.dll")
	registerClassEx           = user32.NewProc("RegisterClassExW")
	unregisterClass           = user32.NewProc("UnregisterClassW")
	createWindowEx            = user32.NewProc("CreateWindowExW")
	defWindowProc             = user32.NewProc("DefWindowProcW")
	destroyWindow             = user32.NewProc("DestroyWindow")
	peekMessage               = user32.NewProc("PeekMessageW")
	translateMessage          = user32.NewProc("TranslateMessage")
	dispatchMessage           = user32.NewProc("DispatchMessageW")
	msgWaitForMultipleObjects = user32.NewProc("MsgWaitForMultipleObjectsEx")
	getModuleHandle           = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")
	windowProcCallback        = syscall.NewCallback(sessionWindowProc)
	sessionWindows            sync.Map
	sessionClassSequence      atomic.Uint64
)

// Native structures include Windows SDK pointer alignment on both 32- and
// 64-bit Windows; do not pack them or substitute Go int for a Windows LONG.
type windowClass struct {
	Size, Style          uint32
	WindowProc           uintptr
	ClassExtra, WinExtra int32
	Instance, Icon       uintptr
	Cursor, Background   uintptr
	MenuName, ClassName  *uint16
	SmallIcon            uintptr
}

type windowMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          struct{ X, Y int32 }
	Private        uint32
}

type windowsMonitor struct {
	onEndSession func()
	// Published by ready and immutable after startup.
	hwnd, instance uintptr
	class          *uint16
	threadID       uint32
	done           chan struct{}
	// Only the receiver thread accesses registered and ended.
	registered bool
	ended      bool
	// Protect the event handle against concurrent stop and final CloseHandle.
	stopMu    sync.Mutex
	stopEvent windows.Handle
}

func startPlatform(onEndSession func()) (func(), error) {
	monitor, err := newWindowsMonitor(onEndSession)
	if err != nil {
		return nil, err
	}
	return monitor.stop, nil
}

func newWindowsMonitor(onEndSession func()) (*windowsMonitor, error) {
	return launchWindowsMonitor(onEndSession, (*windowsMonitor).initialize)
}

func launchWindowsMonitor(onEndSession func(), initialize func(*windowsMonitor) error) (*windowsMonitor, error) {
	monitor := &windowsMonitor{onEndSession: onEndSession, done: make(chan struct{})}
	ready := make(chan error, 1)
	go monitor.run(ready, initialize)
	if err := <-ready; err != nil {
		// Do not return a failed Start while its native resources still exist.
		<-monitor.done
		return nil, err
	}
	return monitor, nil
}

func (m *windowsMonitor) run(ready chan<- error, initialize func(*windowsMonitor) error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(m.done)
	defer m.release()
	m.threadID = windows.GetCurrentThreadId()
	if err := initialize(m); err != nil {
		ready <- err
		return
	}
	ready <- nil

	// An event, rather than PostMessage alone, makes stop reliable even when
	// the native message queue is full. No helper goroutine or polling timer is
	// needed. MWMO_INPUTAVAILABLE also wakes for previously observed messages.
	for {
		result, _, err := msgWaitForMultipleObjects.Call(
			1, uintptr(unsafe.Pointer(&m.stopEvent)), windows.INFINITE,
			0x04ff, 0x0004, // QS_ALLINPUT, MWMO_INPUTAVAILABLE
		)
		switch uint32(result) {
		case windows.WAIT_OBJECT_0:
			return
		case windows.WAIT_OBJECT_0 + 1:
			var message windowMessage
			for {
				// PeekMessage also dispatches incoming synchronous messages.
				haveMessage, _, _ := peekMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0, 1) // PM_REMOVE
				if m.stopRequested() || (haveMessage != 0 && message.Message == wmQuit) {
					return
				}
				if haveMessage == 0 {
					break
				}
				_, _, _ = translateMessage.Call(uintptr(unsafe.Pointer(&message)))
				_, _, _ = dispatchMessage.Call(uintptr(unsafe.Pointer(&message)))
			}
		default:
			log.Printf("Session monitor stopped: %v", nativeCallError("MsgWaitForMultipleObjectsEx", err))
			return
		}
	}
}

func (m *windowsMonitor) initialize() error {
	var err error
	m.stopEvent, err = windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return fmt.Errorf("create session monitor stop event: %w", err)
	}
	var callErr error
	m.instance, _, callErr = getModuleHandle.Call(0)
	if m.instance == 0 {
		return nativeCallError("GetModuleHandleW", callErr)
	}
	m.class, err = windows.UTF16PtrFromString(fmt.Sprintf("OrbitSSH.Session.%d.%d", os.Getpid(), sessionClassSequence.Add(1)))
	if err != nil {
		return err
	}
	class := windowClass{WindowProc: windowProcCallback, Instance: m.instance, ClassName: m.class}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, err := registerClassEx.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return nativeCallError("RegisterClassExW", err)
	}
	m.registered = true
	// Hidden, parentless top-level tool window: unlike HWND_MESSAGE, this
	// receives session broadcasts. No Explorer, tray icon, or Wails HWND needed.
	m.hwnd, _, callErr = createWindowEx.Call(0x80, uintptr(unsafe.Pointer(m.class)), 0, 0x80000000, 0, 0, 0, 0, 0, 0, m.instance, 0)
	if m.hwnd == 0 {
		return nativeCallError("CreateWindowExW", callErr)
	}
	sessionWindows.Store(m.hwnd, m)
	return nil
}

func sessionWindowProc(hwnd uintptr, message uint32, wparam, lparam uintptr) uintptr {
	if value, found := sessionWindows.Load(hwnd); found {
		monitor := value.(*windowsMonitor)
		switch message {
		case wmQueryEndSession:
			// A query is not a commitment: another application may cancel it.
			// Never prompt, flush, disconnect, or hide the main window here.
			return 1
		case wmEndSession:
			if wparam != 0 && !monitor.ended {
				// Mark first to suppress duplicate or reentrant notifications.
				monitor.ended = true
				if monitor.onEndSession != nil {
					// Caller guarantees <= 3 seconds. Returning before local
					// recovery finishes would let Windows kill the saving work.
					monitor.onEndSession()
				}
			}
			return 0
		case wmClose, wmDestroy:
			monitor.signalStop()
			return 0
		case wmNCDestroy:
			sessionWindows.Delete(hwnd)
		}
	}
	result, _, _ := defWindowProc.Call(hwnd, uintptr(message), wparam, lparam)
	return result
}

func (m *windowsMonitor) signalStop() {
	m.stopMu.Lock()
	defer m.stopMu.Unlock()
	if m.stopEvent != 0 {
		_ = windows.SetEvent(m.stopEvent)
	}
}

func (m *windowsMonitor) stopRequested() bool {
	result, _ := windows.WaitForSingleObject(m.stopEvent, 0)
	return result == windows.WAIT_OBJECT_0
}

func (m *windowsMonitor) stop() {
	m.signalStop()
	// Never wait for ourselves, including when another goroutine is already
	// waiting in stop. Avoid sync.Once around a blocking join for this reason.
	runtime.LockOSThread()
	onReceiverThread := windows.GetCurrentThreadId() == m.threadID
	runtime.UnlockOSThread()
	if !onReceiverThread {
		<-m.done
	}
}

func (m *windowsMonitor) release() {
	if m.hwnd != 0 {
		_, _, _ = destroyWindow.Call(m.hwnd)
		sessionWindows.Delete(m.hwnd)
	}
	if m.registered {
		_, _, _ = unregisterClass.Call(uintptr(unsafe.Pointer(m.class)), m.instance)
	}
	m.stopMu.Lock()
	defer m.stopMu.Unlock()
	if m.stopEvent != 0 {
		_ = windows.CloseHandle(m.stopEvent)
		m.stopEvent = 0
	}
}

func nativeCallError(operation string, err error) error {
	if err == nil || err == windows.ERROR_SUCCESS {
		return fmt.Errorf("%s failed", operation)
	}
	return fmt.Errorf("%s: %w", operation, err)
}
