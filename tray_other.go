//go:build (!windows && !darwin) || android || androidtest

package main

func startSystemTray(trayCallbacks) (func(), error) { return nil, nil }
