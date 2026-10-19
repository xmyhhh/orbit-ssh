//go:build !windows || android || androidtest

package main

func startSystemTray(trayCallbacks) (func(), error) { return nil, nil }
