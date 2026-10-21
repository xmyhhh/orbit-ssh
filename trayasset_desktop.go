//go:build !windows && !darwin && !android && !androidtest

package main

import _ "embed"

// The Linux tray draws the icon from the Wails build assets.
//
//go:embed build/linux/tray.png
var trayAsset []byte
