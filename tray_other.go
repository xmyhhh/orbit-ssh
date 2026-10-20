//go:build (!windows && !darwin && !linux) || android || androidtest

package main

func startSystemTray(trayCallbacks) (func(), error) { return nil, nil }
