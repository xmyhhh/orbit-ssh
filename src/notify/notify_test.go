package notify

import "testing"

func testBackend(t *testing.T, post func(string, string, string) bool, close func(string)) {
	t.Helper()
	mu.Lock()
	oldPost, oldClose := postNotice, closeNotice
	postNotice, closeNotice = post, close
	mu.Unlock()
	t.Cleanup(func() {
		mu.Lock()
		postNotice, closeNotice = oldPost, oldClose
		mu.Unlock()
	})
}

func TestApprovalLifecycle(t *testing.T) {
	const id = "test-lifecycle"
	posts, closes := 0, 0
	testBackend(t, func(title, body, requestID string) bool {
		if title != "title" || body != "body" || requestID != id {
			t.Fatalf("incorrect payload: %q %q %q", title, body, requestID)
		}
		posts++
		return true
	}, func(requestID string) {
		if isPending(requestID) {
			t.Fatal("callbacks must be invalidated before withdrawing the notice")
		}
		closes++
	})
	activated, decided := false, false
	Register(id, Handlers{
		Activate: func() { activated = true },
		Decide: func(approved bool) error {
			decided = approved
			return nil
		},
	})
	if !Approval("title", "body", id) || posts != 1 {
		t.Fatal("registered request was not posted")
	}
	handlers := pull(id)
	handlers.Activate()
	if err := handlers.Decide(true); err != nil || !activated || !decided {
		t.Fatalf("callbacks failed: %v", err)
	}
	Forget(id)
	if isPending(id) || closes != 1 || pull(id).Decide != nil {
		t.Fatal("expired callbacks were retained")
	}
	if Approval("title", "body", id) || posts != 1 {
		t.Fatal("late asynchronous delivery posted an expired approval")
	}
}

func TestUnavailableBackendKeepsApprovalCallbacks(t *testing.T) {
	testBackend(t, nil, nil)
	Register("unavailable", Handlers{Decide: func(bool) error { return nil }})
	defer Forget("unavailable")
	if Approval("title", "body", "unavailable") {
		t.Fatal("missing backend reported delivery")
	}
	if pull("unavailable").Decide == nil {
		t.Fatal("a delivery failure must not invalidate an in-app request")
	}
}
