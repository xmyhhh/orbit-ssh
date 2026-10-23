//go:build windows && !android && !androidtest

package local

import (
	"reflect"
	"testing"
)

func TestWindowsShellArgs(t *testing.T) {
	// Both PowerShell editions need explicit console encodings: UTF-8 on the
	// ConPTY pipes alone cannot recover characters already replaced by .NET.
	// Keep profiles enabled and remain interactive after the setup command.
	powershell := []string{
		"-NoLogo", "-NoExit", "-Command",
		"$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
	}
	for _, tt := range []struct {
		id   string
		want []string
	}{
		{id: "powershell", want: powershell},
		{id: "pwsh", want: powershell},
		// CMD must not receive PowerShell syntax or a switch that exits it.
		{id: "cmd", want: []string{"/D"}},
	} {
		t.Run(tt.id, func(t *testing.T) {
			if got := windowsShellArgs(tt.id); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("windowsShellArgs(%q) = %q, want %q", tt.id, got, tt.want)
			}
		})
	}
}
