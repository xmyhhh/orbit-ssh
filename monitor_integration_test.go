package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt in to read-only sampling on a host already trusted in the local app.
// Authentication stays inside the backend; the real workspace is never written.
func TestMonitorLiveHost(t *testing.T) {
	target := os.Getenv("ORBIT_TEST_MONITOR_HOST")
	if target == "" {
		t.Skip("set ORBIT_TEST_MONITOR_HOST to a saved host name or ID")
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	stored, err := openStore(filepath.Join(dir, "OrbitSSH", "workspace.json"))
	if err != nil {
		t.Fatal(err)
	}
	state := stored.snapshot()
	var host Host
	for _, candidate := range state.Hosts {
		if candidate.ID == target || candidate.Name == target {
			host = candidate
			break
		}
	}
	if host.ID == "" {
		t.Fatal("test host is not configured")
	}
	if host.AuthType == "password" {
		password, err := savedPassword(host)
		if err != nil {
			t.Fatal(err)
		}
		if password == "" {
			t.Skip("test host has no saved password; log in once with remember password enabled")
		}
	}
	store, err := openStore(filepath.Join(t.TempDir(), "workspace.json"))
	if err != nil {
		t.Fatal(err)
	}
	store.state = state
	a := NewApp()
	a.ctx = context.Background()
	a.store = store
	t.Cleanup(func() { a.shutdown(context.Background()) })
	if err = a.Connect("monitor-live-test", host.ID, Credentials{}, "", TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	first, err := a.Monitor("monitor-live-test")
	if err != nil {
		t.Fatalf("first live sample: %v", err)
	}
	if first.MemoryTotal == 0 || len(first.Disks) == 0 || len(first.Processes) == 0 {
		t.Fatal("live sample is missing memory, disk or process data")
	}
	time.Sleep(100 * time.Millisecond)
	second, err := a.Monitor("monitor-live-test")
	if err != nil || second.CPUPercent == nil {
		t.Fatalf("second live CPU sample: %v", err)
	}
	t.Logf("live samples OK: %d CPU cores, %d disks, %d processes, CPU %.1f%%", second.Cores, len(second.Disks), len(second.Processes), *second.CPUPercent)
}
