// Package notify sends desktop reminders for pending MCP command approvals.
// Notification delivery is best-effort: the in-app confirmation dialog remains
// the source of truth when notifications are disabled or unavailable.
package notify

import "sync"

// Handlers receive actions for one pending approval. Activate opens the app
// for full command review; notification actions may only reject via Decide(false).
// Never authorize a full command from its possibly truncated OS preview.
type Handlers struct {
	Activate func()
	Decide   func(approved bool) error
}

var (
	mu          sync.Mutex
	pending     = map[string]Handlers{}
	postNotice  func(title, body, requestID string) bool
	closeNotice func(requestID string)
)

func Register(requestID string, registered Handlers) {
	mu.Lock()
	defer mu.Unlock()
	pending[requestID] = registered
}

// Forget invalidates callbacks before withdrawing the system reminder. Late
// clicks can never approve a request that is no longer waiting.
func Forget(requestID string) {
	mu.Lock()
	delete(pending, requestID)
	close := closeNotice
	mu.Unlock()
	if close != nil {
		close(requestID)
	}
}

func pull(requestID string) Handlers {
	mu.Lock()
	defer mu.Unlock()
	return pending[requestID]
}

func isPending(requestID string) bool {
	mu.Lock()
	defer mu.Unlock()
	_, ok := pending[requestID]
	return ok
}

// Approval reports whether the backend accepted the reminder for delivery,
// not whether the OS displayed it. Call off the UI/approval-waiting goroutine:
// permission prompts and desktop services may take time or reject delivery.
func Approval(title, body, requestID string) bool {
	mu.Lock()
	post := postNotice
	_, active := pending[requestID]
	mu.Unlock()
	if post == nil || !active {
		return false
	}
	return post(title, body, requestID)
}
