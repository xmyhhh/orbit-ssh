//go:build linux && !android && !androidtest

package notify

import (
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

func testLinuxSession(t *testing.T) *linuxSession {
	t.Helper()
	testBackend(t, nil, nil)
	session := &linuxSession{
		owner: ":1.42", ownerAfter: 10, generation: 1,
		objects: map[uint32]linuxNotification{}, posting: map[*linuxPost]struct{}{},
	}
	linuxMu.Lock()
	old := linuxCurrent
	linuxCurrent = session
	linuxMu.Unlock()
	t.Cleanup(func() {
		linuxMu.Lock()
		linuxCurrent = old
		linuxMu.Unlock()
	})
	return session
}

func linuxTestSignal(sender, name string, sequence dbus.Sequence, body ...any) *dbus.Signal {
	return &dbus.Signal{Sender: sender, Path: linuxPath, Name: linuxService + "." + name, Sequence: sequence, Body: body}
}

func linuxTestOwnerChange(sender, oldOwner, owner string, sequence dbus.Sequence) *dbus.Signal {
	return &dbus.Signal{
		Sender: sender, Path: "/org/freedesktop/DBus", Name: "org.freedesktop.DBus.NameOwnerChanged",
		Sequence: sequence, Body: []any{linuxService, oldOwner, owner},
	}
}

func TestLinuxSignalRouting(t *testing.T) {
	session := testLinuxSession(t)
	decisions := make(chan bool, 4)
	activated := make(chan struct{}, 4)
	Register("linux-signal-test", Handlers{
		Activate: func() { activated <- struct{}{} },
		Decide: func(approved bool) error {
			decisions <- approved
			return nil
		},
	})
	defer Forget("linux-signal-test")
	session.objects[123] = linuxNotification{requestID: "linux-signal-test", generation: 1, after: 20}

	// Even the real notification daemon must not approve execution. Directed
	// forged signals must not activate, reject, or erase a genuine mapping.
	for _, signal := range []*dbus.Signal{
		nil,
		linuxTestSignal(session.owner, "ActionInvoked", 21),
		linuxTestSignal(session.owner, "ActionInvoked", 21, uint32(123)),
		linuxTestSignal(session.owner, "ActionInvoked", 21, uint32(123), uint32(3)),
		linuxTestSignal(session.owner, "ActionInvoked", 21, uint32(123), "allow"),
		linuxTestSignal(session.owner, "ActionInvoked", 20, uint32(123), "deny"),
		linuxTestSignal(session.owner, "NotificationClosed", 21, uint32(123), "invalid reason"),
		{Sender: session.owner, Path: "/other", Name: linuxService + ".ActionInvoked", Sequence: 21, Body: []any{uint32(123), "deny"}},
	} {
		linuxHandleSignal(session, signal)
	}
	for _, sender := range []string{"", ":1.99", linuxService} {
		for _, action := range []string{"default", "allow", "deny"} {
			linuxHandleSignal(session, linuxTestSignal(sender, "ActionInvoked", 21, uint32(123), action))
		}
		linuxHandleSignal(session, linuxTestSignal(sender, "NotificationClosed", 21, uint32(123), uint32(2)))
	}
	// Real open/reject actions must still work: forged close events must not
	// have erased the mapping. Check for extra callbacks after these actions.
	linuxHandleSignal(session, linuxTestSignal(session.owner, "ActionInvoked", 22, uint32(123), "default"))
	select {
	case <-activated:
	case <-time.After(time.Second):
		t.Fatal("authenticated open action was not delivered")
	}
	linuxHandleSignal(session, linuxTestSignal(session.owner, "ActionInvoked", 23, uint32(123), "deny"))
	select {
	case approved := <-decisions:
		if approved {
			t.Fatal("notification approved a command")
		}
	case <-time.After(time.Second):
		t.Fatal("authenticated reject action was not delivered")
	}
	linuxHandleSignal(session, linuxTestSignal(session.owner, "NotificationClosed", 24, uint32(123), uint32(2)))
	if !isPending("linux-signal-test") {
		t.Fatal("closing a banner must not decide the request")
	}
	if len(session.objects) != 0 {
		t.Fatal("closed banner retained an action mapping")
	}
	linuxHandleSignal(session, linuxTestSignal(session.owner, "ActionInvoked", 25, uint32(123), "default"))
	linuxHandleSignal(session, linuxTestSignal(session.owner, "ActionInvoked", 26, uint32(123), "deny"))
	select {
	case <-decisions:
		t.Fatal("invalid/forged signal dispatched an extra decision")
	case <-activated:
		t.Fatal("invalid/forged signal dispatched an extra activation")
	case <-time.After(25 * time.Millisecond):
	}
}

func TestLinuxOwnerChangesInvalidateMappings(t *testing.T) {
	session := testLinuxSession(t)
	decisions := make(chan bool, 4)
	Register("linux-owner-test", Handlers{Decide: func(approved bool) error {
		decisions <- approved
		return nil
	}})
	defer Forget("linux-owner-test")
	session.objects[123] = linuxNotification{requestID: "linux-owner-test", generation: 1, after: 20}
	for _, signal := range []*dbus.Signal{
		linuxTestOwnerChange(":1.99", session.owner, ":1.99", 21),
		linuxTestOwnerChange("", session.owner, ":1.99", 21),
		linuxTestOwnerChange("org.freedesktop.DBus", session.owner, ":1.99", 9),
		linuxTestOwnerChange("org.freedesktop.DBus", ":1.99", ":1.100", 21),
		linuxTestOwnerChange("org.freedesktop.DBus", session.owner, linuxService, 21),
	} {
		linuxHandleSignal(session, signal)
	}
	if session.owner != ":1.42" || session.generation != 1 || len(session.objects) != 1 {
		t.Fatal("forged/stale owner change changed the authenticated owner or mappings")
	}
	linuxHandleSignal(session, linuxTestOwnerChange("org.freedesktop.DBus", ":1.42", ":1.43", 22))
	if session.owner != ":1.43" || session.generation != 2 || len(session.objects) != 0 {
		t.Fatal("owner replacement did not invalidate old notification IDs")
	}
	// New owners frequently reuse ID 1 (or 123). Neither the old daemon nor
	// the new daemon may route that ID to a request from the old generation.
	linuxHandleSignal(session, linuxTestSignal(":1.42", "ActionInvoked", 23, uint32(123), "deny"))
	linuxHandleSignal(session, linuxTestSignal(":1.43", "ActionInvoked", 24, uint32(123), "deny"))
	// Even when a daemon loses and regains its name, the generation changes.
	linuxHandleSignal(session, linuxTestOwnerChange("org.freedesktop.DBus", ":1.43", "", 25))
	linuxHandleSignal(session, linuxTestOwnerChange("org.freedesktop.DBus", "", ":1.42", 26))
	if session.generation != 4 {
		t.Fatal("owner loss/reacquisition did not advance generation")
	}
	session.objects[123] = linuxNotification{requestID: "linux-owner-test", generation: 1, after: 20}
	linuxHandleSignal(session, linuxTestSignal(":1.42", "ActionInvoked", 27, uint32(123), "deny"))
	select {
	case <-decisions:
		t.Fatal("old-generation mapping dispatched a decision")
	case <-time.After(25 * time.Millisecond):
	}
}

func TestLinuxReusedIDsRejectQueuedSignals(t *testing.T) {
	session := testLinuxSession(t)
	decisions := make(chan bool, 4)
	Register("linux-reused-id", Handlers{Decide: func(approved bool) error {
		decisions <- approved
		return nil
	}})
	defer Forget("linux-reused-id")
	session.objects[123] = linuxNotification{requestID: "linux-reused-id", generation: 1, after: 30}
	linuxHandleSignal(session, linuxTestSignal(session.owner, "ActionInvoked", 29, uint32(123), "deny"))
	linuxHandleSignal(session, linuxTestSignal(session.owner, "NotificationClosed", 29, uint32(123), uint32(2)))
	if len(session.objects) != 1 {
		t.Fatal("queued close deleted the new use of a notification ID")
	}
	select {
	case <-decisions:
		t.Fatal("queued action routed to a new use of a notification ID")
	case <-time.After(25 * time.Millisecond):
	}
	linuxHandleSignal(session, linuxTestSignal(session.owner, "ActionInvoked", 31, uint32(123), "deny"))
	select {
	case <-decisions:
	case <-time.After(time.Second):
		t.Fatal("new action was not delivered")
	}
}

func TestLinuxOldConnectionCannotDispatch(t *testing.T) {
	session := testLinuxSession(t)
	oldSession := &linuxSession{owner: session.owner, generation: 1, objects: map[uint32]linuxNotification{
		123: {requestID: "old-connection", generation: 1, after: 20},
	}}
	decisions := make(chan bool, 1)
	Register("old-connection", Handlers{Decide: func(approved bool) error {
		decisions <- approved
		return nil
	}})
	defer Forget("old-connection")
	linuxHandleSignal(oldSession, linuxTestSignal(oldSession.owner, "ActionInvoked", 21, uint32(123), "deny"))
	linuxHandleSignal(oldSession, linuxTestOwnerChange("org.freedesktop.DBus", oldSession.owner, ":1.99", 22))
	if session.owner != ":1.42" {
		t.Fatal("old connection changed the current owner")
	}
	select {
	case <-decisions:
		t.Fatal("old connection dispatched a decision")
	case <-time.After(25 * time.Millisecond):
	}
}

func TestLinuxCloseDoesNotWaitForNotify(t *testing.T) {
	session := testLinuxSession(t)
	testBackend(t, nil, linuxCloseApproval)
	const requestID = "linux-close-during-notify"
	Register(requestID, Handlers{})
	defer Forget(requestID)
	post := &linuxPost{requestID: requestID, owner: session.owner, generation: session.generation}
	session.posting[post] = struct{}{}
	// This is the only lock held across Notify. Forget must return before the
	// daemon replies and the lock can be released.
	session.dispatch.Lock()
	defer session.dispatch.Unlock()
	done := make(chan struct{})
	go func() {
		Forget(requestID)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Forget blocked behind the in-flight Notify RPC")
	}
	if !post.canceled {
		t.Fatal("in-flight reminder was not marked canceled")
	}
	// Registering the same ID again must not resurrect a canceled RPC's reply.
	Register(requestID, Handlers{})
	if linuxFinishPost(session, post, 123, 30, true) || len(session.objects) != 0 {
		t.Fatal("late Notify reply reinstalled a canceled mapping")
	}
}

func TestLinuxFinishPostChecksLifecycle(t *testing.T) {
	for _, scenario := range []string{"valid", "owner changed", "generation changed", "connection changed", "forgotten", "failed", "no sequence"} {
		t.Run(scenario, func(t *testing.T) {
			session := testLinuxSession(t)
			Register("linux-finish", Handlers{})
			defer Forget("linux-finish")
			post := &linuxPost{requestID: "linux-finish", owner: session.owner, generation: session.generation}
			session.posting[post] = struct{}{}
			sequence := dbus.Sequence(30)
			delivered := true
			switch scenario {
			case "owner changed":
				session.owner = ":1.99"
			case "generation changed":
				session.generation++
			case "connection changed":
				linuxMu.Lock()
				linuxCurrent = nil
				linuxMu.Unlock()
			case "forgotten":
				Forget("linux-finish")
			case "failed":
				delivered = false
			case "no sequence":
				sequence = dbus.NoSequence
			}
			got := linuxFinishPost(session, post, 123, sequence, delivered)
			if got != (scenario == "valid") {
				t.Fatalf("accepted = %v for %s", got, scenario)
			}
			if len(session.posting) != 0 {
				t.Fatal("completed post retained its in-flight entry")
			}
		})
	}
}
