//go:build linux && !android && !androidtest

package lifecycle

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

func TestLinuxSignalRouting(t *testing.T) {
	const owner = ":1.42"
	client := dbus.ObjectPath("/org/gnome/SessionManager/Client1")
	for _, tc := range []struct {
		name  string
		iface string
		path  dbus.ObjectPath
		body  []interface{}
		want  linuxEvent
	}{
		{"PrepareForShutdown", linuxLoginIface, linuxLoginPath, []interface{}{true}, linuxShutdown},
		{"PrepareForShutdown", linuxLoginIface, linuxLoginPath, []interface{}{false}, linuxCanceled},
		{"PrepareForSleep", linuxLoginIface, linuxLoginPath, []interface{}{true}, linuxIgnore},
		{"QueryEndSession", linuxClientIface, client, []interface{}{uint32(0)}, linuxQuery},
		{"QueryEndSession", linuxClientIface, client, []interface{}{uint32(1)}, linuxQuery},
		{"EndSession", linuxClientIface, client, []interface{}{uint32(0)}, linuxEnd},
		{"EndSession", linuxClientIface, client, []interface{}{uint32(1)}, linuxEnd},
		{"Stop", linuxClientIface, client, nil, linuxStop},
		{"CancelEndSession", linuxClientIface, client, nil, linuxCanceled},
		{"SessionOver", linuxClientIface, client, nil, linuxIgnore},
	} {
		t.Run(tc.iface+"."+tc.name, func(t *testing.T) {
			event := &dbus.Signal{Sender: owner, Path: tc.path, Name: tc.iface + "." + tc.name, Body: tc.body}
			if got := linuxRoute(event, owner, tc.path, tc.iface); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for _, sender := range []string{"", ":1.99", linuxLoginService, linuxSessionName} {
				forged := *event
				forged.Sender = sender
				if got := linuxRoute(&forged, owner, tc.path, tc.iface); got != linuxIgnore {
					t.Fatalf("accepted forged sender %q", sender)
				}
			}
			wrongPath := *event
			wrongPath.Path = "/other"
			if linuxRoute(&wrongPath, owner, tc.path, tc.iface) != linuxIgnore {
				t.Fatal("accepted another client's signal")
			}
		})
	}
	for _, event := range []*dbus.Signal{
		nil,
		{Sender: owner, Path: linuxLoginPath, Name: linuxLoginIface + ".PrepareForShutdown"},
		{Sender: owner, Path: linuxLoginPath, Name: linuxLoginIface + ".PrepareForShutdown", Body: []interface{}{uint32(1)}},
		{Sender: owner, Path: linuxLoginPath, Name: linuxLoginIface + ".PrepareForShutdown", Body: []interface{}{true, false}},
		{Sender: owner, Path: client, Name: linuxClientIface + ".EndSession", Body: []interface{}{true}},
		{Sender: owner, Path: client, Name: linuxClientIface + ".QueryEndSession", Body: []interface{}{0}},
		{Sender: owner, Path: client, Name: linuxClientIface + ".Stop", Body: []interface{}{uint32(0)}},
		{Sender: owner, Path: client, Name: linuxClientIface + ".CancelEndSession", Body: []interface{}{false}},
	} {
		path, iface := client, linuxClientIface
		if event != nil && event.Path == linuxLoginPath {
			path, iface = linuxLoginPath, linuxLoginIface
		}
		if got := linuxRoute(event, owner, path, iface); got != linuxIgnore {
			t.Fatalf("accepted malformed signal: %+v", event)
		}
	}
}

func TestLinuxSessionQueryCancelAndEnd(t *testing.T) {
	var order []string
	monitor := &linuxMonitor{done: make(chan struct{}), callback: func() { order = append(order, "cleanup") }}
	respond := func() { order = append(order, "response") }
	if linuxHandleSession(linuxQuery, monitor, respond) {
		t.Fatal("query ended the session")
	}
	if linuxHandleSession(linuxCanceled, monitor, respond) || monitor.ending {
		t.Fatal("cancelled query committed termination")
	}
	if !reflect.DeepEqual(order, []string{"response"}) {
		t.Fatalf("query/cancel did shutdown work: %v", order)
	}
	if !linuxHandleSession(linuxEnd, monitor, respond) {
		t.Fatal("EndSession did not terminate")
	}
	if !reflect.DeepEqual(order, []string{"response", "cleanup", "response"}) {
		t.Fatalf("EndSession was not acknowledged after cleanup: %v", order)
	}
	// Another protocol can have completed cleanup already; its completion does
	// not remove the obligation to acknowledge this client's EndSession.
	linuxHandleSession(linuxEnd, monitor, respond)
	if !reflect.DeepEqual(order, []string{"response", "cleanup", "response", "response"}) {
		t.Fatalf("duplicate end lost acknowledgement or repeated cleanup: %v", order)
	}
}

func TestLinuxQueryDoesNotWaitForConcurrentCleanup(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	monitor := &linuxMonitor{done: make(chan struct{}), callback: func() {
		close(entered)
		<-release
	}}
	go monitor.end()
	<-entered
	defer func() { close(release); <-monitor.done }()
	replied := make(chan struct{})
	go linuxHandleSession(linuxQuery, monitor, func() { close(replied) })
	select {
	case <-replied:
	case <-time.After(time.Second):
		t.Fatal("query waited for cleanup instead of acknowledging immediately")
	}
}

func TestLinuxStartRejectsMissingCallback(t *testing.T) {
	if stop, err := startPlatform(nil); err == nil || stop != nil {
		t.Fatal("missing callback was accepted")
	}
}

func TestLinuxSessionStopDoesNotReply(t *testing.T) {
	calls := 0
	monitor := &linuxMonitor{done: make(chan struct{}), callback: func() { calls++ }}
	if !linuxHandleSession(linuxStop, monitor, func() { t.Error("Stop must not send EndSessionResponse") }) || calls != 1 {
		t.Fatal("Stop did not terminate")
	}
}

func TestLinuxMonitorConcurrentEnd(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	monitor := &linuxMonitor{done: make(chan struct{}), callback: func() {
		calls.Add(1)
		close(entered)
		<-release
	}}
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() { defer workers.Done(); monitor.end() }()
	}
	<-entered
	select {
	case <-monitor.done:
		t.Fatal("cleanup completed before callback returned")
	default:
	}
	close(release)
	workers.Wait()
	if calls.Load() != 1 {
		t.Fatalf("cleanup ran %d times", calls.Load())
	}
}

func TestLinuxStoppedMonitorDoesNotExit(t *testing.T) {
	monitor := &linuxMonitor{done: make(chan struct{}), stopped: true, callback: func() { t.Error("exit after stop") }}
	monitor.end()
}

func TestLinuxUnixSignalFallback(t *testing.T) {
	for _, received := range []os.Signal{syscall.SIGTERM, syscall.SIGINT} {
		t.Run(received.String(), func(t *testing.T) {
			calls := 0
			monitor := &linuxMonitor{done: make(chan struct{}), callback: func() { calls++ }}
			signals := make(chan os.Signal, 1)
			signals <- received
			linuxWaitForSignal(context.Background(), signals, monitor)
			if calls != 1 {
				t.Fatal("Unix signal did not independently invoke system exit")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	linuxWaitForSignal(ctx, make(chan os.Signal), &linuxMonitor{callback: func() { t.Error("cancellation exited app") }})
}

func TestLinuxOwnerLossAuthentication(t *testing.T) {
	event := &dbus.Signal{
		Sender: "org.freedesktop.DBus", Path: "/org/freedesktop/DBus", Name: "org.freedesktop.DBus.NameOwnerChanged",
		Body: []interface{}{linuxSessionName, ":1.42", ""},
	}
	if !linuxOwnerGone(event, linuxSessionName, ":1.42") {
		t.Fatal("owner loss not detected")
	}
	for _, sender := range []string{":1.99", linuxSessionName, ""} {
		forged := *event
		forged.Sender = sender
		if linuxOwnerGone(&forged, linuxSessionName, ":1.42") {
			t.Fatal("forged owner change accepted")
		}
	}
	if linuxOwnerGone(event, linuxLoginService, ":1.42") || linuxOwnerGone(event, linuxSessionName, ":1.99") {
		t.Fatal("unrelated owner change accepted")
	}
}

func TestLinuxDelayReleaseAndDeadline(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "explicit", true: "deadline"}[deadline], func(t *testing.T) {
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			defer writer.Close()
			var delay linuxDelay
			delay.set(writer)
			defer delay.release()
			if deadline {
				delay.expireAfter(5 * time.Millisecond)
			} else {
				delay.release()
				delay.release() // Closing an inhibitor is idempotent.
			}
			if err := reader.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			var buffer [1]byte
			if n, err := reader.Read(buffer[:]); n != 0 || err == nil || os.IsTimeout(err) {
				t.Fatalf("delay FD remained open: n=%d err=%v", n, err)
			}
		})
	}
}

// Private-bus integration exercises real wire messages and Unix FD passing.
// It never connects to the user's buses or requests any OS shutdown. These tests
// can also run on macOS with the owned Linux source copied without build tags;
// that is a protocol simulation, not validation of Linux GTK/logind integration.
func linuxTestBus(t *testing.T) (string, *dbus.Conn) {
	t.Helper()
	binary, err := exec.LookPath("dbus-daemon")
	if err != nil {
		if _, err = os.Stat("/opt/homebrew/bin/dbus-daemon"); err != nil {
			t.Skip("private D-Bus test requires dbus-daemon")
		}
		binary = "/opt/homebrew/bin/dbus-daemon"
	}
	// Keep the socket path below Unix sockaddr_un limits (t.TempDir's test
	// name can make the pathname too long, particularly on macOS).
	dir, err := os.MkdirTemp("", "ol-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	address := "unix:path=" + filepath.Join(dir, "bus")
	command := exec.Command(binary, "--session", "--nofork", "--nopidfile", "--address="+address, "--print-address=1")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	ready := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		ready <- strings.TrimSpace(line)
	}()
	select {
	case address = <-ready:
		if address == "" {
			t.Fatal("private dbus-daemon did not print its address")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("private dbus-daemon did not start")
	}
	// Scope all watcher connections to this private daemon, including godbus's
	// Darwin-specific system-bus lookup when running the portable simulation.
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", address)
	t.Setenv("DBUS_SYSTEM_BUS_ADDRESS", address)
	if runtime.GOOS == "darwin" {
		value := strings.TrimPrefix(strings.Split(address, ",")[0], "unix:path=")
		t.Setenv("DBUS_LAUNCHD_SESSION_BUS_SOCKET", value)
	}
	service, err := dbus.Connect(address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close() })
	return address, service
}

func linuxTestOwn(t *testing.T, service *dbus.Conn, name string) {
	t.Helper()
	reply, err := service.RequestName(name, dbus.NameFlagDoNotQueue)
	if err != nil || reply != dbus.RequestNameReplyPrimaryOwner {
		t.Fatalf("own %s: reply=%v err=%v", name, reply, err)
	}
}

func linuxTestReceive[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for private D-Bus event")
		var zero T
		return zero
	}
}

func TestLinuxPrivateBusSessionLifecycle(t *testing.T) {
	for _, stopSignal := range []bool{false, true} {
		t.Run(map[bool]string{false: "EndSession", true: "Stop"}[stopSignal], func(t *testing.T) {
			_, service := linuxTestBus(t)
			linuxTestOwn(t, service, linuxSessionName)
			client := dbus.ObjectPath("/org/gnome/SessionManager/Client1")
			registered := make(chan struct{}, 1)
			responses := make(chan bool, 4)
			entered, finish := make(chan struct{}), make(chan struct{})
			var cleanupFinished atomic.Bool
			if err := service.ExportMethodTable(map[string]interface{}{
				"RegisterClient": func(appID, startupID string) (dbus.ObjectPath, *dbus.Error) {
					if appID != "io.orbitssh" || startupID != "" {
						return "", dbus.NewError("org.test.InvalidClient", nil)
					}
					// Emit before the registration reply to test the setup race.
					_ = service.Emit(client, linuxClientIface+".QueryEndSession", uint32(0))
					registered <- struct{}{}
					return client, nil
				},
			}, linuxSessionPath, linuxSessionName); err != nil {
				t.Fatal(err)
			}
			if err := service.ExportMethodTable(map[string]interface{}{
				"EndSessionResponse": func(ok bool, reason string) *dbus.Error {
					responses <- ok && reason == ""
					return nil
				},
			}, client, linuxClientIface); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			monitor := &linuxMonitor{done: make(chan struct{}), callback: func() {
				close(entered)
				<-finish
				cleanupFinished.Store(true)
			}}
			done := make(chan struct{})
			go func() { defer close(done); linuxWatchSession(ctx, monitor) }()
			linuxTestReceive(t, registered)
			if !linuxTestReceive(t, responses) {
				t.Fatal("query was not acknowledged positively")
			}
			if err := service.Emit(client, linuxClientIface+".CancelEndSession"); err != nil {
				t.Fatal(err)
			}
			// A second query/response is an ordered barrier after cancellation.
			_ = service.Emit(client, linuxClientIface+".QueryEndSession", uint32(1))
			linuxTestReceive(t, responses)
			select {
			case <-entered:
				t.Fatal("query/cancellation triggered cleanup")
			default:
			}
			if stopSignal {
				_ = service.Emit(client, linuxClientIface+".Stop")
			} else {
				_ = service.Emit(client, linuxClientIface+".EndSession", uint32(0))
			}
			linuxTestReceive(t, entered)
			select {
			case <-responses:
				t.Fatal("EndSession response preceded cleanup")
			default:
			}
			// Run's deferred stop can cancel just as callback asks Wails to
			// quit. Cancellation must not suppress the pending acknowledgement.
			cancel()
			close(finish)
			if !stopSignal && !linuxTestReceive(t, responses) {
				t.Fatal("EndSession was not acknowledged positively")
			}
			linuxTestReceive(t, done)
			if !cleanupFinished.Load() {
				t.Fatal("watcher exited without cleanup")
			}
		})
	}
}

func TestLinuxPrivateBusRunStopWaitsForEndResponse(t *testing.T) {
	_, service := linuxTestBus(t)
	linuxTestOwn(t, service, linuxSessionName)
	client := dbus.ObjectPath("/org/gnome/SessionManager/Client1")
	responses := make(chan struct{}, 2)
	if err := service.ExportMethodTable(map[string]interface{}{
		"RegisterClient": func(_, _ string) (dbus.ObjectPath, *dbus.Error) {
			_ = service.Emit(client, linuxClientIface+".QueryEndSession", uint32(0))
			return client, nil
		},
	}, linuxSessionPath, linuxSessionName); err != nil {
		t.Fatal(err)
	}
	if err := service.ExportMethodTable(map[string]interface{}{
		"EndSessionResponse": func(_ bool, _ string) *dbus.Error {
			responses <- struct{}{}
			return nil
		},
	}, client, linuxClientIface); err != nil {
		t.Fatal(err)
	}
	runReturned := make(chan struct{})
	stop, err := startPlatform(func() {
		// runtime.Quit may let Run return just before this callback returns.
		close(runReturned)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	linuxTestReceive(t, responses) // Registration and query completed.
	_ = service.Emit(client, linuxClientIface+".EndSession", uint32(0))
	linuxTestReceive(t, runReturned)
	stopDone := make(chan struct{})
	go func() { stop(); close(stopDone) }()
	linuxTestReceive(t, stopDone)
	select {
	case <-responses:
	default:
		t.Fatal("Run's stop returned before the final EndSessionResponse")
	}
	stop() // Idempotent after concurrent Run termination.
}

type linuxTestInhibitor struct{ reader, writer *os.File }

func TestLinuxPrivateBusLogindDelay(t *testing.T) {
	_, service := linuxTestBus(t)
	if !service.SupportsUnixFDs() {
		t.Skip("private bus does not support Unix FD passing")
	}
	linuxTestOwn(t, service, linuxLoginService)
	inhibitors := make(chan linuxTestInhibitor, 3)
	var originalsMu sync.Mutex
	var originals []*os.File
	t.Cleanup(func() {
		originalsMu.Lock()
		defer originalsMu.Unlock()
		for _, file := range originals {
			_ = file.Close()
		}
	})
	if err := service.ExportMethodTable(map[string]interface{}{
		"Inhibit": func(what, who, why, mode string) (dbus.UnixFD, *dbus.Error) {
			if what != "shutdown" || who == "" || why == "" || mode != "delay" {
				return 0, dbus.NewError("org.test.InvalidInhibitor", nil)
			}
			reader, writer, err := os.Pipe()
			if err != nil {
				return 0, dbus.MakeFailedError(err)
			}
			originalsMu.Lock()
			originals = append(originals, reader, writer)
			originalsMu.Unlock()
			inhibitors <- linuxTestInhibitor{reader, writer}
			return dbus.UnixFD(writer.Fd()), nil
		},
	}, linuxLoginPath, linuxLoginIface); err != nil {
		t.Fatal(err)
	}
	if err := service.ExportMethodTable(map[string]interface{}{
		"Get": func(iface, property string) (dbus.Variant, *dbus.Error) {
			return dbus.MakeVariant(uint64(5000000)), nil
		},
	}, linuxLoginPath, "org.freedesktop.DBus.Properties"); err != nil {
		t.Fatal(err)
	}
	entered, finish := make(chan struct{}), make(chan struct{})
	monitor := &linuxMonitor{done: make(chan struct{}), callback: func() { close(entered); <-finish }}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); linuxWatchLogin(ctx, monitor) }()
	first := linuxTestReceive(t, inhibitors)
	_ = service.Emit(linuxLoginPath, linuxLoginIface+".PrepareForShutdown", false)
	second := linuxTestReceive(t, inhibitors)
	// A second Inhibit request means the first FD response was processed and
	// released. The server's original must close too before observing EOF.
	_ = first.writer.Close()
	if err := first.reader.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	var buffer [1]byte
	if _, err := first.reader.Read(buffer[:]); err != io.EOF {
		t.Fatalf("false signal leaked the previous delay FD: %v", err)
	}
	select {
	case <-entered:
		t.Fatal("false preparation signal exited application")
	default:
	}
	_ = service.Emit(linuxLoginPath, linuxLoginIface+".PrepareForShutdown", true)
	linuxTestReceive(t, entered)
	_ = second.writer.Close()
	close(finish)
	linuxTestReceive(t, done)
	if err := second.reader.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := second.reader.Read(buffer[:]); err != io.EOF {
		t.Fatalf("cleanup leaked received delay FD: %v", err)
	}
}

func TestLinuxDelayReplacementReleasesOldFD(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	var delay linuxDelay
	delay.set(writer)
	delay.set(nil)
	if _, err := writer.Write([]byte("x")); err == nil {
		t.Fatal("old inhibitor FD leaked")
	}
}
