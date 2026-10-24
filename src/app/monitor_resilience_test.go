package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func replaceMonitorSection(fixture, key, replacement string) string {
	marker := "__ORBIT_" + key + "__\n"
	before, after, ok := strings.Cut(fixture, marker)
	if !ok {
		return fixture
	}
	end := strings.Index(after, "\n__ORBIT_")
	if end < 0 {
		return before + replacement
	}
	return before + replacement + after[end+1:]
}

func TestMonitorPartialFailures(t *testing.T) {
	cases := []struct{ key, detail, hint string }{
		{"CPU", "cat: /proc/stat: Permission denied", "权限不足"},
		{"MEMORY", "cat: /proc/meminfo: Permission denied", "权限不足"},
		{"NETWORK", "cat: /proc/net/dev: Permission denied", "权限不足"},
		{"DISKS", "exit=124", "超时"},
		{"DISKIO", "cat: /proc/diskstats: No such file or directory", "No such file"},
		{"THERMAL", "cat: /sys/class/thermal/thermal_zone0/temp: Permission denied", "权限不足"},
		{"PROCESSES", "ps: unrecognized option: sort", "procps"},
	}
	for _, tt := range cases {
		t.Run(tt.key, func(t *testing.T) {
			output := replaceMonitorSection(monitorFixture, tt.key, "__ORBIT_ERROR_"+tt.key+"__\n"+tt.detail+"\n")
			m, sample, err := parseMetrics(output)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(m.Issues[tt.key], tt.hint) {
				t.Fatalf("missing diagnostic: %+v", m.Issues)
			}
			if len(m.Issues) != 1 {
				t.Fatalf("unrelated metrics failed: %+v", m.Issues)
			}
			if tt.key != "MEMORY" && m.MemoryTotal == 0 {
				t.Fatal("healthy memory discarded")
			}
			if tt.key != "CPU" && sample.total == 0 {
				t.Fatal("healthy CPU discarded")
			}
			if tt.key == "CPU" && (sample.total != 0 || m.Cores != 0) {
				t.Fatal("invalid CPU retained")
			}
			if tt.key == "NETWORK" && len(m.Networks) != 0 {
				t.Fatal("failed network reported as valid")
			}
		})
	}
}

func TestMonitorMetadataIndependent(t *testing.T) {
	output := strings.Replace(monitorFixture, strings.Split(monitorFixture, "__ORBIT_CPU__")[0], `__ORBIT_ERROR_HOSTNAME__
exit=127
hostname: not found
__ORBIT_SYSTEM__
Linux 6.8.0
__ORBIT_ERROR_UPTIME__
cat: /proc/uptime: Permission denied
__ORBIT_LOAD__
0.11 0.22 0.33 1/250 1900
__ORBIT_PROCESS_TOTAL__
42
`, 1)
	m, _, err := parseMetrics(output)
	if err != nil || m.System != "Linux 6.8.0" || len(m.Load) != 3 || m.ProcessTotal != 42 || m.Cores != 2 {
		t.Fatalf("metadata failure shifted fields: %+v %v", m, err)
	}
	if !strings.Contains(m.Issues["HOSTNAME"], "PATH") || !strings.Contains(m.Issues["UPTIME"], "权限不足") {
		t.Fatalf("missing metadata diagnostics: %+v", m.Issues)
	}
}

func TestMonitorEmptyAndMalformedSections(t *testing.T) {
	for _, output := range []string{"", "access restricted\n", "__ORBIT_ERROR_CPU__\nexit=1\nPermission denied\n"} {
		if _, _, err := parseMetrics(output); err == nil {
			t.Fatalf("unusable response accepted: %q", output)
		}
	}
	for _, output := range []string{
		strings.Replace(monitorFixture, "cpu 100", "cpu invalid", 1),
		strings.Replace(monitorFixture, "MemTotal: 8192000", "MemTotal: invalid", 1),
		strings.Replace(monitorFixture, "0.11 0.22 0.33", "NaN 0.22 0.33", 1),
	} {
		m, _, err := parseMetrics(output)
		if err != nil || len(m.Issues) != 1 || len(m.Processes) != 2 {
			t.Fatalf("invalid item destroyed other data: %+v %v", m, err)
		}
	}
	m, _, err := parseMetrics(replaceMonitorSection(monitorFixture, "THERMAL", "__ORBIT_THERMAL__\n"))
	if err != nil || len(m.Warnings) != 0 {
		t.Fatalf("VM without sensors warned: %+v %v", m.Warnings, err)
	}
}

func TestMonitorReturnsRemoteStderr(t *testing.T) {
	address, fingerprint := testSSHServerWithMonitor(t, func(uint64) (string, string, uint32) {
		return "", "restricted-shell: command execution denied\n", 126
	})
	a := testApp(t, address)
	if err := a.Connect("stderr", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Monitor("stderr"); err == nil || !strings.Contains(err.Error(), "command execution denied") {
		t.Fatalf("remote cause discarded: %v", err)
	}
	if err := a.WriteTerminal("stderr", "still connected\r"); err != nil {
		t.Fatal(err)
	}
}

func TestMonitorPartialSampleResetsCPUBaseline(t *testing.T) {
	calls := 0
	address, fingerprint := testSSHServerWithMonitor(t, func(uint64) (string, string, uint32) {
		calls++
		if calls == 2 {
			return replaceMonitorSection(monitorFixture, "CPU", "__ORBIT_ERROR_CPU__\nPermission denied\n"), "", 0
		}
		return strings.Replace(monitorFixture, "cpu 100", "cpu 200", 1), "", 0
	})
	a := testApp(t, address)
	if err := a.Connect("partial", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		m, err := a.Monitor("partial")
		if err != nil || m.MemoryTotal == 0 || m.CPUPercent != nil {
			t.Fatalf("sample %d: %+v %v", i, m, err)
		}
		if i == 1 && m.Issues["CPU"] == "" {
			t.Fatal("missing CPU issue")
		}
	}
}

// Execute the actual POSIX shell collector with fake remote utilities. This
// catches lost exit statuses in pipelines and proves later collectors continue.
func TestMonitorShellCollectorIsolation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX collector test requires /bin/sh; parser and SSH tests run on all platforms")
	}
	dir := t.TempDir()
	scripts := map[string]string{
		"uname":    "echo Linux",
		"hostname": "echo test-server",
		"cat": `case "$1" in
/proc/stat) printf 'cpu 100 0 50 800 50 0 0 0\ncpu0 100 0 50 800 50 0 0 0\n';;
/proc/meminfo) printf 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n';;
/proc/uptime) echo '123 0';;
/proc/loadavg) echo '0.1 0.2 0.3';;
/proc/net/dev) echo 'cat: /proc/net/dev: Permission denied' >&2; exit 1;;
*) exit 0;;
esac`,
		"df":      "echo 'df: Permission denied' >&2; exit 1",
		"ps":      "echo 'ps: unrecognized option' >&2; exit 1",
		"timeout": `limit=$1; shift; "$@"`,
	}
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command("/bin/sh", "-c", monitorCommand)
	cmd.Env = append(os.Environ(), "PATH="+dir+":/usr/bin:/bin")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("collector aborted: %v %s", err, output)
	}
	m, _, err := parseMetrics(string(output))
	if err != nil || m.MemoryTotal != 1000*1024 || m.Cores != 1 {
		t.Fatalf("healthy sections lost: %+v %v\n%s", m, err, output)
	}
	for _, key := range []string{"NETWORK", "DISKS", "PROCESSES", "PROCESS_TOTAL"} {
		if m.Issues[key] == "" {
			t.Fatalf("missing isolated failure %s: %s", key, output)
		}
	}
}
