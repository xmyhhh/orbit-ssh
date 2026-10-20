//go:build !android && !androidtest

package app

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"orbitssh/src/mcp"
	"orbitssh/src/tray"
)

// Run starts the desktop application. The frontend assets and the tray artwork
// are embedded by the module root, because they live next to the Go packages.
func Run(assets embed.FS, trayAsset []byte) error {
	tray.SetAsset(trayAsset)
	if len(os.Args) > 1 && os.Args[1] == "install" {
		mcp.PrepareConsole()
	}
	if handled, err := runMCPInstallCommand(os.Args[1:], os.Stdin, os.Stdout); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return nil
	}
	application := NewApp()
	return wails.Run(&options.App{
		Title: "Orbit SSH", Width: 1440, Height: 900, MinWidth: 900, MinHeight: 600,
		BackgroundColour: &options.RGBA{R: 247, G: 248, B: 250, A: 255},
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        application.desktopStartup, OnShutdown: application.shutdown, OnBeforeClose: application.beforeClose,
		Bind: []interface{}{application},
	})
}
