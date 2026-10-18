package main

import (
	"io"
	"math"
	"strings"
	"testing"
)

const monitorFixture = `__ORBIT_META__
test-server
Linux 6.8.0
90061.50 12000.00
0.11 0.22 0.33 1/250 1900
42
__ORBIT_CPU__
cpu 100 0 50 800 50 0 0 0 10 0
cpu0 50 0 25 400 25 0 0 0 5 0
cpu1 50 0 25 400 25 0 0 0 5 0
intr 999
__ORBIT_MEMORY__
MemTotal: 8192000 kB
MemFree: 2048000 kB
MemAvailable: 4096000 kB
Buffers: 512000 kB
Cached: 1024000 kB
SReclaimable: 512000 kB
Shmem: 256000 kB
SwapTotal: 1024000 kB
SwapFree: 512000 kB
__ORBIT_DISKS__
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 102400 25600 71680 27% /
/dev/vdb1 204800 102400 102400 50% /media/my data
__ORBIT_PROCESSES__
1900 root R 12.5 1.2 98304 120 node /opt/app/server.js --label hello world
1 root Ss 0.1 0.2 16384 90061 /sbin/init
`

func TestParseMonitor(t *testing.T) {
	m, s, err := parseMetrics(monitorFixture)
	if err != nil {
		t.Fatal(err)
	}
	if m.Hostname != "test-server" || m.Cores != 2 || s.total != 1000 || s.idle != 850 || m.CPUPercent != nil {
		t.Fatalf("bad CPU/meta: %+v %+v", m, s)
	}
	if m.MemoryTotal != 8192000*1024 || m.MemoryUsed != 4096000*1024 || m.SwapUsed != 512000*1024 {
		t.Fatalf("bad memory: %+v", m)
	}
	if len(m.Disks) != 2 || m.Disks[1].Mount != "/media/my data" || m.Disks[0].UsedPercent != 27 {
		t.Fatalf("bad disks: %+v", m.Disks)
	}
	if m.ProcessTotal != 42 || len(m.Processes) != 2 || m.Processes[0].Command != "node /opt/app/server.js --label hello world" || m.Processes[0].Memory != 98304*1024 {
		t.Fatalf("bad processes: %+v", m.Processes)
	}
	fallback, _, err := parseMetrics(strings.Replace(monitorFixture, "MemAvailable: 4096000 kB\n", "", 1))
	if err != nil || fallback.MemoryAvailable != 3840000*1024 {
		t.Fatalf("old kernel fallback: %+v %v", fallback, err)
	}
	for _, fixture := range []string{"", strings.Replace(monitorFixture, "cpu 100", "cpu invalid", 1), strings.Replace(monitorFixture, "MemTotal: 8192000", "MemTotal: 0", 1)} {
		if _, _, err := parseMetrics(fixture); err == nil {
			t.Fatal("malformed required data accepted")
		}
	}
	partial, _, err := parseMetrics(strings.Split(monitorFixture, "__ORBIT_DISKS__")[0])
	if err != nil || len(partial.Warnings) != 2 {
		t.Fatalf("missing optional commands not reported: %+v %v", partial.Warnings, err)
	}
}

func TestMonitorExecKeepsTerminal(t *testing.T) {
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	if err := a.Connect("monitor", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	first, err := a.Monitor("monitor")
	if err != nil || first.CPUPercent != nil {
		t.Fatalf("first sample: %+v %v", first, err)
	}
	second, err := a.Monitor("monitor")
	if err != nil || second.CPUPercent == nil || math.Abs(*second.CPUPercent-100) > .01 {
		t.Fatalf("delta sample: %+v %v", second, err)
	}
	if err = a.WriteTerminal("monitor", "still connected\r"); err != nil {
		t.Fatalf("monitor closed terminal: %v", err)
	}
	if err = a.Disconnect("monitor"); err != nil {
		t.Fatal(err)
	}
	if _, err = a.Monitor("monitor"); err == nil {
		t.Fatal("disconnected monitor accepted")
	}
}

func TestMonitorOutputBound(t *testing.T) {
	b := &boundedBuffer{limit: 5}
	// Hide WriterTo to exercise io.Copy's ReaderFrom detection as SSH does.
	reader := struct{ io.Reader }{strings.NewReader("oversized output")}
	if _, err := io.Copy(b, reader); err == nil {
		t.Fatal("output limit was bypassed")
	}
	if len(b.String()) > 5 {
		t.Fatal("buffer grew beyond limit")
	}
}
