//go:build windows && !android && !androidtest

package notify

import (
	"context"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// Windows shows a plain reminder toast. The script borrows the Windows
// PowerShell AppUserModelID; no custom toast identity or decision buttons are
// registered. Approval still happens inside the Orbit SSH dialog.
func init() {
	postNotice = windowsPostApproval
	closeNotice = windowsCloseApproval
}

// Keep process execution separate so backend lifecycle tests need not launch
// PowerShell or display notifications.
var windowsRunEncodedCommand = runWindowsEncodedCommand

func windowsPostApproval(title, body, requestID string) bool {
	if !isPending(requestID) {
		return false
	}
	accepted := windowsRunEncodedCommand(windowsToastEncodedCommand(title, body, requestID))
	// Forget may race the PowerShell process. Its first withdrawal may have
	// completed before Show, so withdraw again once that process has finished.
	if !isPending(requestID) {
		windowsCloseApproval(requestID)
		return false
	}
	return accepted
}

func windowsCloseApproval(requestID string) {
	// Forget must never wait for a helper process. Each best-effort withdrawal
	// uses the same ten-second process deadline as posting.
	run := windowsRunEncodedCommand
	go func() {
		run(windowsToastRemoveEncodedCommand(requestID))
	}()
}

func runWindowsEncodedCommand(encodedCommand string) bool {
	// Resolve the trusted system directory through Windows, not PATH or the
	// current directory (nor a caller-controlled SystemRoot environment value).
	// This is normally %SystemRoot%\System32\WindowsPowerShell\v1.0.
	systemDirectory, err := windows.GetSystemDirectory()
	if err != nil {
		return false
	}
	runner := filepath.Join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, runner, "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodedCommand)
	// CREATE_NO_WINDOW keeps the helper fully invisible; HideWindow avoids a
	// console flash. CommandContext kills PowerShell when the timeout expires.
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	// Missing PowerShell, unsupported WinRT, and script failures all leave the
	// in-app approval dialog available. A successful process exit only means
	// the toast API accepted the request, not that Windows displayed a banner.
	return command.Run() == nil
}
