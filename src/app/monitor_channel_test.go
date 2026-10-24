package app

import (
	"io"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestMonitorChannelRejected(t *testing.T) {
	var sessions atomic.Int32
	address, fingerprint := testSSHServerWithFeatures(t, nil, &testSSHFeatures{
		channel: func(_ *ssh.ServerConn, incoming ssh.NewChannel) bool {
			if incoming.ChannelType() == "session" && sessions.Add(1) > 1 {
				_ = incoming.Reject(ssh.ResourceShortage, "session limit exceeded")
				return true
			}
			return false
		},
	})
	a := testApp(t, address)
	if err := a.Connect("limited", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	_, err := a.Monitor("limited")
	if err == nil || !strings.Contains(err.Error(), "MaxSessions") || !strings.Contains(err.Error(), "session limit exceeded") {
		t.Fatalf("unhelpful channel error: %v", err)
	}
	if err := a.WriteTerminal("limited", "still connected\r"); err != nil {
		t.Fatal(err)
	}
}

func TestMonitorTimeoutKeepsCompletedSections(t *testing.T) {
	address, fingerprint := testSSHServerWithFeatures(t, nil, &testSSHFeatures{
		session: func(_ *ssh.ServerConn, ch ssh.Channel, req *ssh.Request) bool {
			if req.Type != "exec" {
				return false
			}
			req.Reply(true, nil)
			// Simulate a completed memory collection followed by a blocked network read.
			_, _ = io.WriteString(ch, "__ORBIT_MEMORY__\nMemTotal: 1000 kB\nMemAvailable: 500 kB\n__ORBIT_DONE_MEMORY__\n__ORBIT_NETWORK__\neth0: 12")
			return true
		},
	})
	a := testApp(t, address)
	if err := a.Connect("timeout", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	m, err := a.Monitor("timeout")
	if err != nil || m.MemoryTotal != 1000*1024 || len(m.Networks) != 0 || m.Issues["NETWORK"] == "" {
		t.Fatalf("partial timeout discarded good data: %+v %v", m, err)
	}
	if !strings.Contains(strings.Join(m.Warnings, " "), "超过 8 秒") {
		t.Fatalf("timeout not reported: %+v", m.Warnings)
	}
	if err := a.WriteTerminal("timeout", "still connected\r"); err != nil {
		t.Fatal(err)
	}
}

func TestCompletedMonitorOutput(t *testing.T) {
	completed := "__ORBIT_CPU__\ncpu 10 0 1 100\n__ORBIT_DONE_CPU__\n"
	output := completed + "__ORBIT_NETWORK__\neth0: 12"
	if got := completedMonitorOutput(output); got != completed {
		t.Fatalf("incomplete section retained: %q", got)
	}
	if got := completedMonitorOutput("__ORBIT_CPU__\ncpu 10"); got != "" {
		t.Fatalf("incomplete first section retained: %q", got)
	}
}
