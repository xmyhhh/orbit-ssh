//go:build windows && !android && !androidtest

package main

import _ "embed"

// The Windows tray draws the application icon from the Wails build assets.
//
//go:embed build/windows/icon.ico
var trayAsset []byte
