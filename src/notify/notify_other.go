//go:build (!darwin && !windows && !linux) || android || androidtest

package notify

// The desktop notification backends cover macOS, Windows (toast via the
// PowerShell WinRT bridge) and Linux (freedesktop notifications). All other
// targets have no banner backend yet; the in-app dialog keeps working on its
// own and Android never starts the desktop MCP server.
func init() {
	postNotice = nil
}
