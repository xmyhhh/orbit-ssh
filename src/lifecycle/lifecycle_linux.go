//go:build linux && !android && !androidtest

package lifecycle

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	linuxLoginService = "org.freedesktop.login1"
	linuxLoginPath    = dbus.ObjectPath("/org/freedesktop/login1")
	linuxLoginIface   = "org.freedesktop.login1.Manager"
	linuxSessionName  = "org.gnome.SessionManager"
	linuxSessionPath  = dbus.ObjectPath("/org/gnome/SessionManager")
	linuxClientIface  = "org.gnome.SessionManager.ClientPrivate"
	linuxRPCLimit     = 500 * time.Millisecond
	linuxDelayLimit   = 4 * time.Second
)

// Linux has no universal desktop logout protocol. logind covers poweroff/reboot;
// GNOME's registered-client protocol covers logout. Other desktops (including
// KDE/XFCE) rely on SIGTERM/SIGINT unless they implement the GNOME interface.
// Forced kills, display-server failure, missing buses and non-logind shutdown
// cannot guarantee a cleanup opportunity. No blocking inhibitors are taken.
//
// The callback must set system-exit flags before doing bounded cleanup and must
// arrange process/window exit itself. Wails also listens for Unix signals: Go
// does not guarantee which listener runs first, so that race cannot be eliminated
// here. We invoke the callback directly on the signal worker, without bus I/O,
// and independently of Wails' possibly vetoed close request.
func startPlatform(onEndSession func()) (func(), error) {
	if onEndSession == nil {
		return nil, errors.New("lifecycle: missing end-session callback")
	}
	ctx, cancel := context.WithCancel(context.Background())
	monitor := &linuxMonitor{callback: onEndSession, done: make(chan struct{})}
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go linuxWaitForSignal(ctx, signals, monitor)
	// Bus setup/authentication is deliberately off the startup path. Failures
	// leave the independent Unix-signal fallback installed.
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); linuxWatchLogin(ctx, monitor) }()
	go func() { defer workers.Done(); linuxWatchSession(ctx, monitor) }()
	workersDone := make(chan struct{})
	go func() { workers.Wait(); close(workersDone) }()
	var stopOnce sync.Once
	return func() {
		stopOnce.Do(func() {
			monitor.mu.Lock()
			monitor.stopped = true
			monitor.mu.Unlock()
			signal.Stop(signals)
			cancel()
			// Run can return as soon as the callback requests Wails quit.
			// Give the session worker time to acknowledge before main exits.
			// Never wait indefinitely for bus connection/authentication.
			timer := time.NewTimer(2 * linuxRPCLimit)
			defer timer.Stop()
			select {
			case <-workersDone:
			case <-timer.C:
			}
		})
	}, nil
}

type linuxMonitor struct {
	mu       sync.Mutex
	callback func()
	done     chan struct{}
	ending   bool
	stopped  bool
}

// Concurrent protocols share cleanup, but each caller still sends its own
// acknowledgement/releases its own FD when cleanup finishes. No lock is held
// across the application's callback (which may itself call stop).
func (m *linuxMonitor) end() {
	m.mu.Lock()
	if m.ending {
		done := m.done
		m.mu.Unlock()
		<-done
		return
	}
	if m.stopped {
		m.mu.Unlock()
		return
	}
	m.ending = true
	m.mu.Unlock()
	defer close(m.done)
	m.callback()
}

func linuxWaitForSignal(ctx context.Context, signals <-chan os.Signal, monitor *linuxMonitor) {
	select {
	case _, ok := <-signals:
		if ok {
			monitor.end()
		}
	case <-ctx.Done():
	}
}

func linuxCall(conn *dbus.Conn, owner string, path dbus.ObjectPath, method string, args ...interface{}) *dbus.Call {
	ctx, cancel := context.WithTimeout(context.Background(), linuxRPCLimit)
	defer cancel()
	return conn.Object(owner, path).CallWithContext(ctx, method, dbus.FlagNoAutoStart, args...)
}

func linuxOwner(conn *dbus.Conn, name string) (string, error) {
	var owner string
	err := linuxCall(conn, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetNameOwner", name).Store(&owner)
	if err == nil && (len(owner) < 2 || owner[0] != ':') {
		err = errors.New("lifecycle: invalid D-Bus service owner")
	}
	return owner, err
}

// Use owned connections, never the tray's shared SessionBus. Match rules are
// routing filters, not authentication; directed signals can bypass them.
func linuxSubscribe(ctx context.Context, conn *dbus.Conn, owner, service, iface string) (chan *dbus.Signal, error) {
	signals := make(chan *dbus.Signal, 16)
	conn.Signal(signals)
	rpcCtx, cancel := context.WithTimeout(ctx, linuxRPCLimit)
	defer cancel()
	err := conn.AddMatchSignalContext(rpcCtx,
		dbus.WithMatchSender(owner), dbus.WithMatchInterface(iface))
	if err == nil {
		err = conn.AddMatchSignalContext(rpcCtx,
			dbus.WithMatchSender("org.freedesktop.DBus"), dbus.WithMatchObjectPath("/org/freedesktop/DBus"),
			dbus.WithMatchInterface("org.freedesktop.DBus"), dbus.WithMatchMember("NameOwnerChanged"), dbus.WithMatchArg(0, service))
	}
	if err == nil {
		// Close the lookup/subscription race: if ownership changed before
		// the NameOwnerChanged match was installed, do not trust the old peer.
		current, lookupErr := linuxOwner(conn, service)
		if lookupErr != nil {
			err = lookupErr
		} else if current != owner {
			err = errors.New("lifecycle: D-Bus service owner changed during setup")
		}
	}
	return signals, err
}

func linuxWatchLogin(ctx context.Context, monitor *linuxMonitor) {
	conn, err := dbus.ConnectSystemBus(dbus.WithSignalHandler(dbus.NewSequentialSignalHandler()))
	if err != nil {
		log.Printf("Linux shutdown notifications unavailable: %v", err)
		return
	}
	defer conn.Close()
	owner, err := linuxOwner(conn, linuxLoginService)
	if err != nil {
		return
	}
	signals, err := linuxSubscribe(ctx, conn, owner, linuxLoginService, linuxLoginIface)
	if err != nil {
		return
	}
	var delay linuxDelay
	defer delay.release()
	budget := linuxDelayLimit
	var maximum dbus.Variant
	if linuxCall(conn, owner, linuxLoginPath, "org.freedesktop.DBus.Properties.Get", linuxLoginIface, "InhibitDelayMaxUSec").Store(&maximum) == nil {
		if usec, ok := maximum.Value().(uint64); ok && usec < uint64(linuxDelayLimit/time.Microsecond) {
			budget = time.Duration(usec) * time.Microsecond
		}
	}
	// Leave time to close the FD before logind's own maximum expires.
	if budget > 100*time.Millisecond {
		budget -= 100 * time.Millisecond
	}
	acquire := func() {
		if ctx.Err() != nil || !conn.SupportsUnixFDs() {
			return
		}
		var fd dbus.UnixFD
		if err := linuxCall(conn, owner, linuxLoginPath, linuxLoginIface+".Inhibit",
			"shutdown", "Orbit SSH", "Persist local recovery data", "delay").Store(&fd); err != nil {
			// Policy denial is nonfatal and never opens an authentication dialog.
			log.Printf("Linux shutdown delay unavailable; cleanup is best-effort: %v", err)
			return
		}
		// godbus v5.1 decodes SCM_RIGHTS without setting FD_CLOEXEC.
		// A subsequently spawned local shell must not inherit this inhibitor.
		syscall.CloseOnExec(int(fd))
		delay.set(os.NewFile(uintptr(fd), "orbit-shutdown-delay"))
	}
	// Acquire BEFORE receiving PrepareForShutdown. A notification without an
	// existing delay inhibitor is racy and provides only best-effort cleanup.
	acquire()
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-signals:
			if !ok {
				return
			}
			if linuxOwnerGone(event, linuxLoginService, owner) {
				// Release the old daemon's lock. Reconnection/re-registration
				// after a service restart is intentionally left to a new run;
				// the Unix-signal fallback remains available.
				return
			}
			switch linuxRoute(event, owner, linuxLoginPath, linuxLoginIface) {
			case linuxShutdown:
				delay.expireAfter(budget)
				monitor.end()
				delay.release()
				return
			case linuxCanceled:
				// A false preparation signal is not an instruction to quit.
				delay.release()
				acquire()
			}
		}
	}
}

func linuxWatchSession(ctx context.Context, monitor *linuxMonitor) {
	conn, err := dbus.ConnectSessionBus(dbus.WithSignalHandler(dbus.NewSequentialSignalHandler()))
	if err != nil {
		log.Printf("Linux session notifications unavailable: %v", err)
		return
	}
	defer conn.Close()
	owner, err := linuxOwner(conn, linuxSessionName)
	if err != nil {
		return // Do not activate a GNOME session manager on another desktop.
	}
	signals, err := linuxSubscribe(ctx, conn, owner, linuxSessionName, linuxClientIface)
	if err != nil || ctx.Err() != nil {
		return
	}
	var client dbus.ObjectPath
	if err := linuxCall(conn, owner, linuxSessionPath, linuxSessionName+".RegisterClient", "io.orbitssh", "").Store(&client); err != nil {
		return
	}
	if !client.IsValid() || client == "/" {
		return
	}
	// Closing this private connection implicitly unregisters the client. Avoid
	// a second shutdown RPC after the final EndSessionResponse.
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-signals:
			if !ok {
				return
			}
			if linuxOwnerGone(event, linuxSessionName, owner) {
				return
			}
			respond := func() {
				// Deliberately independent of ctx: Run may already have
				// returned and called stop, but the manager needs a response.
				_ = linuxCall(conn, owner, client, linuxClientIface+".EndSessionResponse", true, "").Err
			}
			if linuxHandleSession(linuxRoute(event, owner, client, linuxClientIface), monitor, respond) {
				return
			}
		}
	}
}

func linuxHandleSession(event linuxEvent, monitor *linuxMonitor, respond func()) bool {
	switch event {
	case linuxQuery:
		// Query is reversible, has a one-second response deadline, and must
		// not show UI or perform destructive shutdown work.
		respond()
	case linuxEnd:
		monitor.end() // Application guarantees a bounded three-second wait.
		respond()
		return true
	case linuxStop:
		monitor.end()
		return true
	case linuxCanceled:
		// Query never commits exit, so cancellation needs no rollback.
	}
	return false
}

type linuxEvent uint8

const (
	linuxIgnore linuxEvent = iota
	linuxQuery
	linuxEnd
	linuxStop
	linuxShutdown
	linuxCanceled
)

func linuxOwnerGone(event *dbus.Signal, service, owner string) bool {
	if event == nil || event.Sender != "org.freedesktop.DBus" || event.Path != "/org/freedesktop/DBus" ||
		event.Name != "org.freedesktop.DBus.NameOwnerChanged" || len(event.Body) != 3 {
		return false
	}
	name, nameOK := event.Body[0].(string)
	old, oldOK := event.Body[1].(string)
	current, currentOK := event.Body[2].(string)
	return nameOK && oldOK && currentOK && name == service && old == owner && current != owner
}

func linuxRoute(event *dbus.Signal, owner string, path dbus.ObjectPath, iface string) linuxEvent {
	if event == nil || owner == "" || owner[0] != ':' || event.Sender != owner || event.Path != path {
		return linuxIgnore
	}
	if iface == linuxLoginIface && event.Name == iface+".PrepareForShutdown" && len(event.Body) == 1 {
		if start, ok := event.Body[0].(bool); ok {
			if start {
				return linuxShutdown
			}
			return linuxCanceled
		}
	}
	if iface != linuxClientIface {
		return linuxIgnore
	}
	switch event.Name {
	case iface + ".QueryEndSession", iface + ".EndSession":
		if len(event.Body) == 1 {
			if _, ok := event.Body[0].(uint32); ok {
				if event.Name == iface+".QueryEndSession" {
					return linuxQuery
				}
				return linuxEnd
			}
		}
	case iface + ".Stop":
		if len(event.Body) == 0 {
			return linuxStop
		}
	case iface + ".CancelEndSession":
		if len(event.Body) == 0 {
			return linuxCanceled
		}
	}
	return linuxIgnore
}

// The FD, not the D-Bus connection, owns a delay inhibitor. A safety timer
// releases it even if application cleanup violates its promised time budget.
// The timer is armed only when shutdown begins, not during ordinary operation.
type linuxDelay struct {
	mu    sync.Mutex
	file  *os.File
	timer *time.Timer
}

func (d *linuxDelay) set(file *os.File) {
	d.release()
	d.mu.Lock()
	d.file = file
	d.mu.Unlock()
}

func (d *linuxDelay) expireAfter(budget time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.file != nil && d.timer == nil {
		d.timer = time.AfterFunc(budget, d.release)
	}
}

func (d *linuxDelay) release() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.timer != nil {
		d.timer.Stop()
		d.timer = nil
	}
	if d.file != nil {
		_ = d.file.Close()
		d.file = nil
	}
}
