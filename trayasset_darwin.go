//go:build darwin && !android && !androidtest

package main

import _ "embed"

// The macOS menu bar draws the application logo as a template icon, see
// scripts/generate-mac-tray-icon.py for the artwork.
//
//go:embed build/darwin/menubar.png
var trayAsset []byte
