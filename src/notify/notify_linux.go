//go:build linux && !android && !androidtest

package notify

import (
	"context"
	"html"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	linuxService   = "org.freedesktop.Notifications"
	linuxPath      = dbus.ObjectPath("/org/freedesktop/Notifications")
	linuxDBusLimit = 3 * time.Second
)

var (
	linuxMu      sync.Mutex
	linuxBus     *dbus.Conn
	linuxObjects = map[uint32]string{}
)

// Use a private connection: the tray uses the same bus, but a notification
// listener must never consume or close its signal channel. Install the match
// before Notify so an immediately clicked banner is not lost.
func linuxConnection() *dbus.Conn {
	linuxMu.Lock()
	defer linuxMu.Unlock()
	if linuxBus != nil && linuxBus.Connected() {
		return linuxBus
	}
	bus, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil
	}
	signals := make(chan *dbus.Signal, 32)
	bus.Signal(signals)
	if err := bus.AddMatchSignal(
		dbus.WithMatchSender(linuxService),
		dbus.WithMatchObjectPath(linuxPath),
		dbus.WithMatchInterface(linuxService),
	); err != nil {
		bus.RemoveSignal(signals)
		_ = bus.Close()
		return nil
	}
	linuxBus = bus
	linuxObjects = map[uint32]string{}
	go linuxPumpSignals(signals)
	return bus
}

func linuxPumpSignals(signals <-chan *dbus.Signal) {
	for signal := range signals {
		linuxHandleSignal(signal)
	}
}

func linuxHandleSignal(signal *dbus.Signal) {
	if signal == nil || signal.Path != linuxPath || len(signal.Body) == 0 {
		return
	}
	notificationID, ok := signal.Body[0].(uint32)
	if !ok {
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
		linuxMu.Lock()
		requestID := linuxObjects[notificationID]
		linuxMu.Unlock()
		handlers := pull(requestID)
		switch action {
		case "default":
			if handlers.Activate != nil {
				go handlers.Activate()
			}
		case "allow", "deny":
			if handlers.Decide != nil {
				go func() { _ = handlers.Decide(action == "allow") }()
			}
		}
	case linuxService + ".NotificationClosed":
		// Dismissing a reminder is not a refusal; the in-app request remains.
		linuxMu.Lock()
		delete(linuxObjects, notificationID)
		linuxMu.Unlock()
	}
}

func init() {
	postNotice = linuxPostApproval
	closeNotice = linuxCloseApproval
}

func linuxPostApproval(title, body, requestID string) bool {
	bus := linuxConnection()
	if bus == nil {
		return false
	}
	// Holding this lock through the reply installs the id mapping before
	// action signals can observe it. Forget invalidates its callback first.
	linuxMu.Lock()
	defer linuxMu.Unlock()
	if !isPending(requestID) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), linuxDBusLimit)
	defer cancel()
	var notificationID uint32
	err := bus.Object(linuxService, linuxPath).CallWithContext(
		ctx, linuxService+".Notify", 0,
		"Orbit SSH", uint32(0), "", title, html.EscapeString(body),
		[]string{"default", "打开应用", "allow", "允许执行", "deny", "拒绝"},
		map[string]dbus.Variant{
			"urgency": dbus.MakeVariant(byte(2)),
		},
		int32((2 * time.Minute).Milliseconds()),
	).Store(&notificationID)
	if err != nil {
		return false
	}
	linuxObjects[notificationID] = requestID
	return true
}

func linuxCloseApproval(requestID string) {
	linuxMu.Lock()
	bus := linuxBus
	var ids []uint32
	for id, request := range linuxObjects {
		if request == requestID {
			delete(linuxObjects, id)
			ids = append(ids, id)
		}
	}
	linuxMu.Unlock()
	if bus == nil || len(ids) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), linuxDBusLimit)
		defer cancel()
		for _, id := range ids {
			_ = bus.Object(linuxService, linuxPath).CallWithContext(
				ctx, linuxService+".CloseNotification", 0, id,
			).Err
		}
	}()
}
