//go:build !android && !androidtest

package main

import (
	"embed"
	"log"

	"orbitssh/src/app"
)

// The frontend assets live outside the Go packages, so the embed stays in the
// module root. Everything else belongs to the packages under src.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	if err := app.Run(assets, trayAsset); err != nil {
		log.Fatal(err)
	}
}
