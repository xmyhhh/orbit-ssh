package app

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"orbitssh/src/platform"
)

func TestWindowsPasswordVaultRoundTrip(t *testing.T) {
	if os.Getenv("ORBIT_TEST_OS_VAULT") != "1" {
		t.Skip("set ORBIT_TEST_OS_VAULT=1 to exercise an isolated Windows test credential")
	}
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	host, _ := a.store.host("test-host")
	host.ID = fmt.Sprintf("orbit-vault-test-%d", time.Now().UnixNano())
	if err := a.SaveHost(host); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = keyring.Delete(platform.Service, "password:"+host.ID) })
	if err := a.SavePassword(host.ID, "session-only-secret"); err != nil {
		t.Fatal(err)
	}
	if saved, err := a.HasSavedPassword(host.ID); err != nil || !saved {
		t.Fatal("credential not available in Windows vault", err)
	}
	if err := a.Connect("windows-vault", host.ID, Credentials{}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal("Windows vault login failed", err)
	}
	if err := a.ForgetPassword(host.ID); err != nil {
		t.Fatal(err)
	}
	if saved, err := a.HasSavedPassword(host.ID); err != nil || saved {
		t.Fatal("Windows vault credential not removed", err)
	}
}
