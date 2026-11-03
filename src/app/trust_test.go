package app

import "testing"

func TestTrustedFingerprintAndForgetHostKey(t *testing.T) {
	a := testApp(t, "192.0.2.10:2222")
	const address = "192.0.2.10:2222"

	fingerprint, err := a.TrustedFingerprint("test-host")
	if err != nil || fingerprint != "" {
		t.Fatalf("untrusted host returned %q, %v", fingerprint, err)
	}

	a.store.mu.Lock()
	a.store.state.KnownHosts[address] = "SHA256:old-key"
	a.store.state.KnownHosts["198.51.100.7:22"] = "SHA256:unrelated"
	err = a.store.persistLocked()
	a.store.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}

	fingerprint, err = a.TrustedFingerprint("test-host")
	if err != nil || fingerprint != "SHA256:old-key" {
		t.Fatalf("trusted fingerprint = %q, %v", fingerprint, err)
	}

	if err = a.ForgetHostKey("test-host"); err != nil {
		t.Fatal(err)
	}
	fingerprint, err = a.TrustedFingerprint("test-host")
	if err != nil || fingerprint != "" {
		t.Fatalf("fingerprint was not cleared: %q, %v", fingerprint, err)
	}
	state := a.store.snapshot()
	if _, ok := state.KnownHosts[address]; ok {
		t.Fatal("cleared fingerprint is still in the workspace state")
	}
	if state.KnownHosts["198.51.100.7:22"] != "SHA256:unrelated" {
		t.Fatal("clearing one host removed another host's trust")
	}
	if err = a.ForgetHostKey("test-host"); err != nil {
		t.Fatalf("clearing an already untrusted host should be a no-op: %v", err)
	}
	if err = a.ForgetHostKey("missing-host"); err == nil {
		t.Fatal("clearing a missing host should fail")
	}

	reopened, err := openStore(a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reopened.snapshot().KnownHosts[address]; ok {
		t.Fatal("cleared fingerprint was written back to the workspace file")
	}
}
