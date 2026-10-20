//go:build android || androidtest

package app

import (
	"context"
	"encoding/json"
	"io"

	"orbitssh/src/mobile"
	"orbitssh/src/platform"
)

// RunMobile serves the backend over the private process pipes of the Android
// host. The module root calls it instead of the Wails runtime.
func RunMobile(input io.Reader, output io.Writer, configDir, filesDir string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	platform.SetDirectories(configDir, filesDir)
	bridge := mobile.NewBridge(ctx, output)
	platform.SetBridge(bridge)
	app := NewApp()
	app.startup(ctx)
	defer app.shutdown(ctx)
	if err := app.ready(); err != nil {
		bridge.Send(mobile.Message{Type: "fatal", Error: err.Error()})
		return err
	}
	bridge.Send(mobile.Message{Type: "ready"})
	return mobile.Serve(bridge, input, func(method string, args json.RawMessage) (interface{}, error) {
		return mobileCall(app, method, args)
	})
}
