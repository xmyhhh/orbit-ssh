//go:build windows && !android && !androidtest

package tray

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	trayWindowMessage = 0x8001 // WM_APP + 1
	trayWMClose       = 0x0010
	trayWMDestroy     = 0x0002
	trayWMCommand     = 0x0111
	trayOpenCommand   = 1
	trayHideCommand   = 2
	trayQuitCommand   = 3
)

var (
	trayUser32                   = windows.NewLazySystemDLL("user32.dll")
	trayShell32                  = windows.NewLazySystemDLL("shell32.dll")
	trayKernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	trayRegisterClassEx          = trayUser32.NewProc("RegisterClassExW")
	trayUnregisterClass          = trayUser32.NewProc("UnregisterClassW")
	trayCreateWindowEx           = trayUser32.NewProc("CreateWindowExW")
	trayDefWindowProc            = trayUser32.NewProc("DefWindowProcW")
	trayDestroyWindow            = trayUser32.NewProc("DestroyWindow")
	trayGetMessage               = trayUser32.NewProc("GetMessageW")
	trayTranslateMessage         = trayUser32.NewProc("TranslateMessage")
	trayDispatchMessage          = trayUser32.NewProc("DispatchMessageW")
	trayPostQuitMessage          = trayUser32.NewProc("PostQuitMessage")
	trayPostMessage              = trayUser32.NewProc("PostMessageW")
	trayPostThreadMessage        = trayUser32.NewProc("PostThreadMessageW")
	trayRegisterWindowMessage    = trayUser32.NewProc("RegisterWindowMessageW")
	trayChangeMessageFilter      = trayUser32.NewProc("ChangeWindowMessageFilterEx")
	trayGetSystemMetrics         = trayUser32.NewProc("GetSystemMetrics")
	trayCreateIconFromResourceEx = trayUser32.NewProc("CreateIconFromResourceEx")
	trayDestroyIcon              = trayUser32.NewProc("DestroyIcon")
	trayCreatePopupMenu          = trayUser32.NewProc("CreatePopupMenu")
	trayAppendMenu               = trayUser32.NewProc("AppendMenuW")
	trayDestroyMenu              = trayUser32.NewProc("DestroyMenu")
	trayGetCursorPos             = trayUser32.NewProc("GetCursorPos")
	traySetForegroundWindow      = trayUser32.NewProc("SetForegroundWindow")
	trayTrackPopupMenu           = trayUser32.NewProc("TrackPopupMenu")
	trayNotifyIcon               = trayShell32.NewProc("Shell_NotifyIconW")
	trayGetModuleHandle          = trayKernel32.NewProc("GetModuleHandleW")
	trayWindowProcCallback       = syscall.NewCallback(trayWindowProc)
	trayWindows                  sync.Map
	trayClassSequence            atomic.Uint32
)

// These structures follow the Windows SDK ABI, including pointer alignment.
type trayWindowClass struct {
	Size, Style          uint32
	WindowProc           uintptr
	ClassExtra, WinExtra int32
	Instance, Icon       uintptr
	Cursor, Background   uintptr
	MenuName, ClassName  *uint16
	SmallIcon            uintptr
}

type trayPoint struct{ X, Y int32 }

type trayMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          trayPoint
	Private        uint32
}

type trayNotification struct {
	Size             uint32
	Window           uintptr
	ID, Flags        uint32
	CallbackMessage  uint32
	Icon             uintptr
	Tip              [128]uint16
	State, StateMask uint32
	Info             [256]uint16
	Version          uint32
	InfoTitle        [64]uint16
	InfoFlags        uint32
	GUID             windows.GUID
	BalloonIcon      uintptr
}

type windowsTray struct {
	callbacks      Callbacks
	hwnd, instance uintptr
	icon           uintptr
	class          *uint16
	taskbarCreated uint32
	threadID       uint32
	running        bool
	done           chan struct{}
	stopOnce       sync.Once
}

func Start(callbacks Callbacks) (func(), error) {
	tray, err := newWindowsTray(callbacks)
	if err != nil {
		return nil, err
	}
	return tray.close, nil
}

func newWindowsTray(callbacks Callbacks) (*windowsTray, error) {
	tray := &windowsTray{callbacks: callbacks, done: make(chan struct{})}
	ready := make(chan error, 1)
	go tray.run(ready)
	if err := <-ready; err != nil {
		<-tray.done
		return nil, err
	}
	return tray, nil
}

func (t *windowsTray) run(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(t.done)
	defer func() {
		t.running = false
		if t.hwnd != 0 {
			data := t.notification()
			_, _, _ = trayNotifyIcon.Call(2, uintptr(unsafe.Pointer(&data))) // NIM_DELETE
			_, _, _ = trayDestroyWindow.Call(t.hwnd)
			trayWindows.Delete(t.hwnd)
		}
		if t.class != nil {
			_, _, _ = trayUnregisterClass.Call(uintptr(unsafe.Pointer(t.class)), t.instance)
		}
		if t.icon != 0 {
			_, _, _ = trayDestroyIcon.Call(t.icon)
		}
		if t.callbacks.Availability != nil {
			t.callbacks.Availability(false)
		}
	}()
	t.threadID = windows.GetCurrentThreadId()
	if err := t.initialize(); err != nil {
		ready <- err
		return
	}
	t.running = true
	ready <- nil
	var message trayMessage
	for {
		result, _, _ := trayGetMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		_, _, _ = trayTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		_, _, _ = trayDispatchMessage.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func (t *windowsTray) initialize() error {
	var err error
	t.icon, err = loadTrayIcon()
	if err != nil {
		return err
	}
	t.instance, _, _ = trayGetModuleHandle.Call(0)
	t.class, err = windows.UTF16PtrFromString(fmt.Sprintf("OrbitSSH.Tray.%d.%d", os.Getpid(), trayClassSequence.Add(1)))
	if err != nil {
		return err
	}
	class := trayWindowClass{WindowProc: trayWindowProcCallback, Instance: t.instance, ClassName: t.class}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, err := trayRegisterClassEx.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return trayCallError("RegisterClassExW", err)
	}
	// A hidden top-level tool window receives Explorer's TaskbarCreated broadcast.
	var callErr error
	t.hwnd, _, callErr = trayCreateWindowEx.Call(0x80, uintptr(unsafe.Pointer(t.class)), 0, 0x80000000, 0, 0, 0, 0, 0, 0, t.instance, 0)
	if t.hwnd == 0 {
		return trayCallError("CreateWindowExW", callErr)
	}
	trayWindows.Store(t.hwnd, t)
	taskbarName, _ := windows.UTF16PtrFromString("TaskbarCreated")
	message, _, err := trayRegisterWindowMessage.Call(uintptr(unsafe.Pointer(taskbarName)))
	if message == 0 {
		return trayCallError("RegisterWindowMessageW", err)
	}
	t.taskbarCreated = uint32(message)
	if trayChangeMessageFilter.Find() == nil {
		_, _, _ = trayChangeMessageFilter.Call(t.hwnd, message, 1, 0)
	}
	return t.addIcon()
}

func (t *windowsTray) notification() trayNotification {
	data := trayNotification{Window: t.hwnd, ID: 1, Flags: 0x87, CallbackMessage: trayWindowMessage, Icon: t.icon}
	data.Size = uint32(unsafe.Sizeof(data))
	tip, _ := windows.UTF16FromString("Orbit SSH · 点击打开窗口")
	copy(data.Tip[:], tip)
	return data
}

func (t *windowsTray) addIcon() error {
	data := t.notification()
	ok, _, err := trayNotifyIcon.Call(0, uintptr(unsafe.Pointer(&data))) // NIM_ADD
	if ok == 0 {
		// An existing icon can survive a duplicate TaskbarCreated notification.
		ok, _, err = trayNotifyIcon.Call(1, uintptr(unsafe.Pointer(&data))) // NIM_MODIFY
	}
	if ok == 0 {
		return trayCallError("Shell_NotifyIconW", err)
	}
	data.Version = 4
	_, _, _ = trayNotifyIcon.Call(4, uintptr(unsafe.Pointer(&data))) // NIM_SETVERSION
	return nil
}

func trayWindowProc(hwnd uintptr, message uint32, wparam, lparam uintptr) uintptr {
	value, found := trayWindows.Load(hwnd)
	if !found {
		result, _, _ := trayDefWindowProc.Call(hwnd, uintptr(message), wparam, lparam)
		return result
	}
	t := value.(*windowsTray)
	switch message {
	case t.taskbarCreated:
		err := t.addIcon()
		if t.callbacks.Availability != nil {
			t.callbacks.Availability(err == nil)
		}
		return 0
	case trayWindowMessage:
		switch uint32(lparam) & 0xffff {
		case 0x0202, 0x0203, 0x0400, 0x0401: // Mouse click, NIN_SELECT, NIN_KEYSELECT.
			t.dispatch(trayOpenCommand)
		case 0x0205, 0x007b: // Right click or keyboard context menu.
			t.showMenu()
		}
		return 0
	case trayWMCommand:
		t.dispatch(uint32(wparam) & 0xffff)
		return 0
	case trayWMClose:
		_, _, _ = trayDestroyWindow.Call(hwnd)
		return 0
	case trayWMDestroy:
		if t.running {
			_, _, _ = trayPostQuitMessage.Call(0)
		}
		return 0
	}
	result, _, _ := trayDefWindowProc.Call(hwnd, uintptr(message), wparam, lparam)
	return result
}

func (t *windowsTray) dispatch(command uint32) {
	var action func()
	switch command {
	case trayOpenCommand:
		action = t.callbacks.Show
	case trayHideCommand:
		action = t.callbacks.Hide
	case trayQuitCommand:
		action = t.callbacks.Quit
	}
	if action != nil {
		go action()
	}
}

func (t *windowsTray) showMenu() {
	menu, _, _ := trayCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer trayDestroyMenu.Call(menu)
	for _, item := range []struct {
		id    uintptr
		label string
	}{{trayOpenCommand, "打开 Orbit SSH"}, {trayHideCommand, "隐藏到托盘"}, {0, ""}, {trayQuitCommand, "退出 Orbit SSH"}} {
		flags := uintptr(0)
		if item.id == 0 {
			flags = 0x800 // MF_SEPARATOR
		}
		label, _ := windows.UTF16PtrFromString(item.label)
		if ok, _, _ := trayAppendMenu.Call(menu, flags, item.id, uintptr(unsafe.Pointer(label))); ok == 0 {
			return
		}
	}
	var point trayPoint
	_, _, _ = trayGetCursorPos.Call(uintptr(unsafe.Pointer(&point)))
	_, _, _ = traySetForegroundWindow.Call(t.hwnd)
	command, _, _ := trayTrackPopupMenu.Call(menu, 0x182, uintptr(point.X), uintptr(point.Y), 0, t.hwnd, 0)
	_, _, _ = trayPostMessage.Call(t.hwnd, 0, 0, 0)
	t.dispatch(uint32(command))
}

func (t *windowsTray) close() {
	t.stopOnce.Do(func() {
		select {
		case <-t.done:
			return
		default:
		}
		if ok, _, _ := trayPostMessage.Call(t.hwnd, trayWMClose, 0, 0); ok == 0 {
			_, _, _ = trayPostThreadMessage.Call(uintptr(t.threadID), 0x12, 0, 0) // WM_QUIT
		}
		<-t.done
	})
}

func loadTrayIcon() (uintptr, error) {
	if len(asset) < 6 || binary.LittleEndian.Uint16(asset[2:]) != 1 {
		return 0, errors.New("无效的托盘图标")
	}
	width, _, _ := trayGetSystemMetrics.Call(49) // SM_CXSMICON
	height, _, _ := trayGetSystemMetrics.Call(50)
	if width == 0 || height == 0 {
		width, height = 16, 16
	}
	count := int(binary.LittleEndian.Uint16(asset[4:]))
	best, score := []byte(nil), int(^uint(0)>>1)
	for i := 0; i < count && 6+(i+1)*16 <= len(asset); i++ {
		entry := asset[6+i*16 : 6+(i+1)*16]
		iconWidth, iconHeight := int(entry[0]), int(entry[1])
		if iconWidth == 0 {
			iconWidth = 256
		}
		if iconHeight == 0 {
			iconHeight = 256
		}
		size, offset := uint64(binary.LittleEndian.Uint32(entry[8:])), uint64(binary.LittleEndian.Uint32(entry[12:]))
		if size == 0 || offset+size > uint64(len(asset)) {
			continue
		}
		distance := trayIconDistance(iconWidth, int(width)) + trayIconDistance(iconHeight, int(height))
		if iconWidth < int(width) || iconHeight < int(height) {
			distance += 1024
		}
		if distance < score {
			best, score = asset[offset:offset+size], distance
		}
	}
	if len(best) == 0 {
		return 0, errors.New("托盘图标没有可用的图像")
	}
	icon, _, err := trayCreateIconFromResourceEx.Call(uintptr(unsafe.Pointer(&best[0])), uintptr(len(best)), 1, 0x30000, width, height, 0)
	if icon == 0 {
		return 0, trayCallError("CreateIconFromResourceEx", err)
	}
	return icon, nil
}

func trayCallError(operation string, err error) error {
	if err == nil || err == windows.ERROR_SUCCESS {
		return fmt.Errorf("%s failed", operation)
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func trayIconDistance(value, target int) int {
	if value < target {
		return target - value
	}
	return value - target
}
