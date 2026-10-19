//go:build windows && !android && !androidtest

package main

import (
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsSystemTray(t *testing.T) {
	className, _ := windows.UTF16PtrFromString("Shell_TrayWnd")
	if hwnd, _, _ := trayUser32.NewProc("FindWindowW").Call(uintptr(unsafe.Pointer(className)), 0); hwnd == 0 {
		t.Skip("Windows notification area is not available in this session")
	}
	events := make(chan string, 8)
	available := make(chan bool, 8)
	tray, err := newWindowsTray(trayCallbacks{
		show: func() { events <- "show" }, hide: func() { events <- "hide" }, quit: func() { events <- "quit" },
		availability: func(value bool) { available <- value },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tray.close)
	getIconRect := trayShell32.NewProc("Shell_NotifyIconGetRect")
	identifier := struct {
		Size   uint32
		Window uintptr
		ID     uint32
		GUID   windows.GUID
	}{Window: tray.hwnd, ID: 1}
	identifier.Size = uint32(unsafe.Sizeof(identifier))
	var rect struct{ Left, Top, Right, Bottom int32 }
	if result, _, err := getIconRect.Call(uintptr(unsafe.Pointer(&identifier)), uintptr(unsafe.Pointer(&rect))); int32(result) < 0 {
		t.Fatalf("tray icon was not registered with Explorer: HRESULT %#x, %v", result, err)
	}
	for _, tc := range []struct {
		message        uint32
		wparam, lparam uintptr
		event          string
	}{
		{trayWindowMessage, 0, 0x400, "show"},
		{trayWMCommand, trayHideCommand, 0, "hide"},
		{trayWMCommand, trayQuitCommand, 0, "quit"},
	} {
		if ok, _, err := trayPostMessage.Call(tray.hwnd, uintptr(tc.message), tc.wparam, tc.lparam); ok == 0 {
			t.Fatal(err)
		}
		select {
		case event := <-events:
			if event != tc.event {
				t.Fatalf("tray action = %q, want %q", event, tc.event)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("tray did not dispatch %s", tc.event)
		}
	}
	// Re-register after the same broadcast Explorer emits when the taskbar restarts.
	_, _, _ = trayPostMessage.Call(tray.hwnd, uintptr(tray.taskbarCreated), 0, 0)
	select {
	case ok := <-available:
		if !ok {
			t.Fatal("tray icon could not be restored")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("taskbar restart was not handled")
	}
	tray.close()
	if result, _, _ := getIconRect.Call(uintptr(unsafe.Pointer(&identifier)), uintptr(unsafe.Pointer(&rect))); int32(result) >= 0 {
		t.Fatal("tray icon remained after shutdown")
	}
}
