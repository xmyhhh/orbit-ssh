//go:build (!windows && !darwin && !linux) || android || androidtest

package tray

func Start(Callbacks) (func(), error) { return nil, nil }
