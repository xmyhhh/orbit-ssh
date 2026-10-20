//go:build !windows && !android && !androidtest

package main

import _ "embed"

// The Linux tray draws the icon from the Wails build assets. macOS uses a
// menu bar template icon and ignores the file.
//
//go:embed build/linux/tray.png
var trayAsset []byte
