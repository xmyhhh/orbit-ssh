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
__ORBIT_NETWORK__
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    1000       1    0    0    0     0          0         0     1000       1    0    0    0     0       0          0
  eth0:   20480      10    0    0    0     0          0         0     4096       5    0    0    0     0       0          0
__ORBIT_DISKIO__
   8       0 sda 1000 0 2048 0 500 0 4096 0 0 0 0
   8       1 sda1 900 0 2000 0 400 0 4000 0 0 0 0
   7       0 loop0 1 0 8 0 1 0 8 0 0 0 0
__ORBIT_THERMAL__
thermal_zone0 47000 x86_pkg_temp
thermal_zone1 45 acpitz
thermal_zone2 -1000 bogus
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
	if len(m.Networks) != 2 || m.Networks[1].Interface != "eth0" || m.Networks[1].RxBytes != 20480 || m.Networks[1].TxBytes != 4096 {
		t.Fatalf("bad network counters: %+v", m.Networks)
	}
	if len(m.DiskIO) != 2 || m.DiskIO[0].Device != "sda" || m.DiskIO[0].ReadBytes != 2048*512 || m.DiskIO[0].WriteOps != 500 {
		t.Fatalf("bad disk I/O counters: %+v", m.DiskIO)
	}
	for _, disk := range m.DiskIO {
		if disk.Device == "loop0" {
			t.Fatal("loop device was reported as real disk I/O")
		}
	}
	if len(m.Thermals) != 2 || m.Thermals[0].Celsius != 47 || m.Thermals[1].Celsius != 45 {
		t.Fatalf("bad thermal readings: %+v", m.Thermals)
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
	if len(first.Processes) != 3 || !strings.Contains(first.Processes[2].Command, "ORBIT_UNSUPPORTED") {
		t.Fatal("sampler shell was not included in the process list")
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

func TestMonitorUnsupportedSystem(t *testing.T) {
	address, fingerprint := testSSHServerWithMonitor(t, func(uint64) (string, string, uint32) {
		return "ORBIT_UNSUPPORTED\n", "", 42
	})
	a := testApp(t, address)
	if err := a.Connect("unsupported", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Monitor("unsupported"); err == nil || !strings.Contains(err.Error(), "当前监控支持 Linux") {
		t.Fatalf("unsupported system was not reported: %v", err)
	}
	if err := a.WriteTerminal("unsupported", "still connected\r"); err != nil {
		t.Fatalf("unsupported monitor closed terminal: %v", err)
	}
}

func TestMonitorDoesNotInferUnsupportedFromProcessOutput(t *testing.T) {
	address, fingerprint := testSSHServerWithMonitor(t, func(uint64) (string, string, uint32) {
		return monitorFixture + "2500 tester Ss 0 0 1024 0 echo ORBIT_UNSUPPORTED\n", "", 42
	})
	a := testApp(t, address)
	if err := a.Connect("exec-error", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Monitor("exec-error"); err == nil || !strings.Contains(err.Error(), "监控读取失败") {
		t.Fatalf("non-protocol exit was misclassified: %v", err)
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

func TestKillProcessRejectsInvalidInput(t *testing.T) {
	a := NewApp()
	if err := a.KillProcess("missing", 0, "TERM"); err == nil {
		t.Fatal("pid 0 accepted")
	}
	if err := a.KillProcess("missing", 1<<23, "TERM"); err == nil {
		t.Fatal("oversized pid accepted")
	}
	if err := a.KillProcess("missing", 42, "SEGV"); err == nil || !strings.Contains(err.Error(), "不支持该信号") {
		t.Fatalf("unsupported signal was not rejected: %v", err)
	}
}

func TestDangerousCommandPatterns(t *testing.T) {
	for _, command := range []string{
		"rm -rf /", "sudo rm -rf /var", "mkfs.ext4 /dev/sda1", "shutdown -h now",
		"dd if=/dev/zero of=/dev/sda", "chmod -R 777 /",
	} {
		if !dangerousCommand(command) {
			t.Fatalf("command was not flagged: %q", command)
		}
	}
	for _, command := range []string{"ls -la", "systemctl restart nginx", "rm -rf ./build"} {
		if dangerousCommand(command) {
			t.Fatalf("safe command was flagged: %q", command)
		}
	}
}
