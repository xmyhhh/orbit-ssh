//go:build windows && !android && !androidtest

package mcp

import (
	"os"

	"golang.org/x/sys/windows"
)

// Release builds use the Windows GUI subsystem. Attach install commands to the
// caller's console so prompts remain usable, preserving any redirected streams.
func PrepareConsole() {
	attach := windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")
	if ok, _, _ := attach.Call(0xffffffff); ok == 0 {
		return
	}
	for _, stream := range []struct {
		file   **os.File
		handle uint32
		name   string
	}{
		{&os.Stdin, windows.STD_INPUT_HANDLE, "stdin"},
		{&os.Stdout, windows.STD_OUTPUT_HANDLE, "stdout"},
		{&os.Stderr, windows.STD_ERROR_HANDLE, "stderr"},
	} {
		if _, err := windows.GetFileType(windows.Handle((*stream.file).Fd())); err == nil {
			continue
		}
		if handle, err := windows.GetStdHandle(stream.handle); err == nil {
			*stream.file = os.NewFile(uintptr(handle), stream.name)
		}
	}
}
