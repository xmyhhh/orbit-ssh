//go:build linux && !android && !androidtest

package notify

import (
	"context"
	"html"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	linuxService   = "org.freedesktop.Notifications"
	linuxPath      = dbus.ObjectPath("/org/freedesktop/Notifications")
	linuxDBusLimit = 3 * time.Second
)

type linuxNotification struct {
	requestID  string
	generation uint64
	after      dbus.Sequence
}

type linuxPost struct {
	requestID  string
	owner      string
	generation uint64
	canceled   bool
}

type linuxSession struct {
	bus *dbus.Conn
	// Serialize Notify and signal dispatch so a fast click cannot precede the
	// returned ID mapping. Closing a request never takes this (RPC-held) lock.
	dispatch sync.Mutex
	// The following fields are protected by linuxMu.
	owner      string
	ownerAfter dbus.Sequence
	generation uint64
	objects    map[uint32]linuxNotification
	posting    map[*linuxPost]struct{}
}

var (
	linuxConnectMu sync.Mutex
	linuxMu        sync.Mutex
	linuxCurrent   *linuxSession
)

// Use a private connection: the tray uses the same bus, but a notification
// listener must never consume or close its signal channel. Match rules control
// delivery, NOT authentication: directed signals bypass those rules.
func linuxConnection() *linuxSession {
	linuxConnectMu.Lock()
	defer linuxConnectMu.Unlock()
	linuxMu.Lock()
	current := linuxCurrent
	linuxMu.Unlock()
	if current != nil && current.bus.Connected() {
		return current
	}
	bus, err := dbus.ConnectSessionBus(dbus.WithSignalHandler(dbus.NewSequentialSignalHandler()))
	if err != nil {
		return nil
	}
	signals := make(chan *dbus.Signal, 32)
	bus.Signal(signals)
	ctx, cancel := context.WithTimeout(context.Background(), linuxDBusLimit)
	defer cancel()
	err = bus.AddMatchSignalContext(ctx,
		dbus.WithMatchSender("org.freedesktop.DBus"),
		dbus.WithMatchObjectPath("/org/freedesktop/DBus"),
		dbus.WithMatchInterface("org.freedesktop.DBus"),
		dbus.WithMatchMember("NameOwnerChanged"),
		dbus.WithMatchArg(0, linuxService),
	)
	if err == nil {
		err = bus.AddMatchSignalContext(ctx,
			dbus.WithMatchSender(linuxService),
			dbus.WithMatchObjectPath(linuxPath),
			dbus.WithMatchInterface(linuxService),
		)
	}
	// Preserve on-demand activation, but resolve the unique owner before sending
	// notifications. Both Notify and CloseNotification target that unique name.
	if err == nil {
		_ = bus.BusObject().CallWithContext(ctx, "org.freedesktop.DBus.StartServiceByName", 0, linuxService, uint32(0)).Err
	}
	var owner string
	var ownerAfter dbus.Sequence
	if err == nil {
		call := bus.BusObject().CallWithContext(ctx, "org.freedesktop.DBus.GetNameOwner", 0, linuxService)
		err = call.Store(&owner)
		ownerAfter = call.ResponseSequence
	}
	if err != nil || !strings.HasPrefix(owner, ":") || ownerAfter == dbus.NoSequence {
		// Drain even on setup failure: the sequential handler may have buffered
		// signals and must be able to finish while the connection closes.
		go func() {
			for range signals {
			}
		}()
		_ = bus.Close()
		return nil
	}
	current = &linuxSession{
		bus: bus, owner: owner, ownerAfter: ownerAfter, generation: 1,
		objects: map[uint32]linuxNotification{}, posting: map[*linuxPost]struct{}{},
	}
	linuxMu.Lock()
	linuxCurrent = current
	linuxMu.Unlock()
	go linuxPumpSignals(current, signals)
	return current
}

func linuxPumpSignals(session *linuxSession, signals <-chan *dbus.Signal) {
	for signal := range signals {
		linuxHandleSignal(session, signal)
	}
	linuxMu.Lock()
	if linuxCurrent == session {
		linuxCurrent = nil
	}
	linuxMu.Unlock()
}

func linuxHandleSignal(session *linuxSession, signal *dbus.Signal) {
	if signal == nil {
		return
	}
	session.dispatch.Lock()
	defer session.dispatch.Unlock()
	linuxMu.Lock()
	defer linuxMu.Unlock()
	if linuxCurrent != session {
		return
	}
	if signal.Name == "org.freedesktop.DBus.NameOwnerChanged" {
		if signal.Sender != "org.freedesktop.DBus" || signal.Path != "/org/freedesktop/DBus" ||
			len(signal.Body) != 3 || signal.Sequence <= session.ownerAfter {
			return
		}
		name, nameOK := signal.Body[0].(string)
		oldOwner, oldOK := signal.Body[1].(string)
		owner, ownerOK := signal.Body[2].(string)
		if !nameOK || !oldOK || !ownerOK || name != linuxService || oldOwner != session.owner ||
			(owner != "" && !strings.HasPrefix(owner, ":")) {
			return
		}
		session.owner = owner
		session.ownerAfter = signal.Sequence
		session.generation++
		session.objects = map[uint32]linuxNotification{}
		return
	}
	if session.owner == "" || signal.Sender != session.owner || signal.Path != linuxPath || len(signal.Body) == 0 {
		return
	}
	notificationID, ok := signal.Body[0].(uint32)
	if !ok {
		return
	}
	object, ok := session.objects[notificationID]
	if !ok || object.generation != session.generation || signal.Sequence <= object.after {
		return
	}
	switch signal.Name {
	case linuxService + ".ActionInvoked":
		if len(signal.Body) != 2 {
			return
		}
		action, ok := signal.Body[1].(string)
		if !ok {
			return
		}
		handlers := pull(object.requestID)
		switch action {
		case "default":
			if handlers.Activate != nil {
				go handlers.Activate()
			}
		case "deny":
			if handlers.Decide != nil {
				go func() { _ = handlers.Decide(false) }()
			}
		}
	case linuxService + ".NotificationClosed":
		// Dismissing a reminder is not a refusal; the in-app request remains.
		if len(signal.Body) == 2 {
			if _, ok := signal.Body[1].(uint32); ok {
				delete(session.objects, notificationID)
			}
		}
	}
}

func init() {
	postNotice = linuxPostApproval
	closeNotice = linuxCloseApproval
}

func linuxPostApproval(title, body, requestID string) bool {
	session := linuxConnection()
	if session == nil {
		return false
	}
	session.dispatch.Lock()
	defer session.dispatch.Unlock()
	linuxMu.Lock()
	if linuxCurrent != session || session.owner == "" || !isPending(requestID) {
		linuxMu.Unlock()
		return false
	}
	post := &linuxPost{requestID: requestID, owner: session.owner, generation: session.generation}
	session.posting[post] = struct{}{}
	linuxMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), linuxDBusLimit)
	defer cancel()
	var notificationID uint32
	call := session.bus.Object(post.owner, linuxPath).CallWithContext(
		ctx, linuxService+".Notify", 0,
		"Orbit SSH", uint32(0), "", title, html.EscapeString(body),
		[]string{"default", "打开应用", "deny", "拒绝"},
		map[string]dbus.Variant{
			"urgency": dbus.MakeVariant(byte(2)),
		},
		int32((2 * time.Minute).Milliseconds()),
	)
	err := call.Store(&notificationID)
	if !linuxFinishPost(session, post, notificationID, call.ResponseSequence, err == nil) {
		if err == nil {
			linuxWithdraw(session.bus, post.owner, []uint32{notificationID})
		}
		return false
	}
	return true
}

func linuxFinishPost(session *linuxSession, post *linuxPost, id uint32, after dbus.Sequence, delivered bool) bool {
	linuxMu.Lock()
	defer linuxMu.Unlock()
	delete(session.posting, post)
	if !delivered || after == dbus.NoSequence || post.canceled || linuxCurrent != session ||
		session.owner != post.owner || session.generation != post.generation || !isPending(post.requestID) {
		return false
	}
	// Reject queued actions/close events from an earlier use of the same ID.
	session.objects[id] = linuxNotification{requestID: post.requestID, generation: post.generation, after: after}
	return true
}

func linuxCloseApproval(requestID string) {
	linuxMu.Lock()
	session := linuxCurrent
	if session == nil {
		linuxMu.Unlock()
		return
	}
	owner := session.owner
	var ids []uint32
	for id, object := range session.objects {
		if object.requestID == requestID {
			delete(session.objects, id)
			ids = append(ids, id)
		}
	}
	for post := range session.posting {
		if post.requestID == requestID {
			post.canceled = true
		}
	}
	linuxMu.Unlock()
	linuxWithdraw(session.bus, owner, ids)
}

func linuxWithdraw(bus *dbus.Conn, owner string, ids []uint32) {
	if bus == nil || owner == "" || len(ids) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), linuxDBusLimit)
		defer cancel()
		for _, id := range ids {
			_ = bus.Object(owner, linuxPath).CallWithContext(
				ctx, linuxService+".CloseNotification", 0, id,
			).Err
		}
	}()
}
