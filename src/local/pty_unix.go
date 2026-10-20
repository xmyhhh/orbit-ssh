//go:build (darwin || linux) && !android && !androidtest

package local

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

// unixTerminal runs a shell on a pseudo terminal, the Unix counterpart of the
// ConPTY console used on Windows.
type unixTerminal struct {
	pty     *os.File
	cmd     *exec.Cmd
	done    chan struct{}
	drained chan struct{}
	once    sync.Once
	drain   sync.Once
	mu      sync.Mutex
	code    uint32
	waitErr error
	closed  bool
}

// unixTerminalEnv forces a color capable TERM. getenv returns the first
// match, so an inherited TERM has to be dropped instead of appended.
func unixTerminalEnv(env []string) []string {
	result := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if strings.HasPrefix(entry, "TERM=") {
			continue
		}
		result = append(result, entry)
	}
	return append(result, "TERM=xterm-256color")
}

func startUnixTerminal(executable string, args []string, dir string, cols, rows int) (*unixTerminal, error) {
	cmd := exec.Command(executable, args...)
	cmd.Dir = dir
	cmd.Env = unixTerminalEnv(os.Environ())
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		return nil, err
	}
	t := &unixTerminal{pty: master, cmd: cmd, done: make(chan struct{}), drained: make(chan struct{})}
	go func() {
		waitErr := cmd.Wait()
		code := 0
		if waitErr != nil {
			var exit *exec.ExitError
			if errors.As(waitErr, &exit) {
				// A normal exit reports through the status code, like ConPTY does.
				code = exit.ExitCode()
				waitErr = nil
			} else {
				code = 1
			}
		}
		if code < 0 {
			code = 1
		}
		t.mu.Lock()
		t.code = uint32(code)
		t.waitErr = waitErr
		t.mu.Unlock()
		close(t.done)
	}()
	return t, nil
}

func (t *unixTerminal) Read(p []byte) (int, error) {
	n, err := t.pty.Read(p)
	if err != nil {
		t.drain.Do(func() { close(t.drained) })
	}
	return n, err
}

func (t *unixTerminal) Write(p []byte) (int, error) { return t.pty.Write(p) }

func (t *unixTerminal) Wait() (uint32, error) {
	<-t.done
	// The reader owns the pty; wait until it drained the remaining output so
	// the close event is not emitted before the last bytes.
	select {
	case <-t.drained:
	case <-time.After(2 * time.Second):
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.code, t.waitErr
}

func (t *unixTerminal) Resize(cols, rows int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errors.New("本地终端已关闭")
	}
	return pty.Setsize(t.pty, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

func (t *unixTerminal) Close() error {
	t.once.Do(func() {
		t.mu.Lock()
		t.closed = true
		t.mu.Unlock()
		// Stop only this terminal's process, never the user's other shells.
		if t.cmd.Process != nil {
			_ = t.cmd.Process.Kill()
		}
		<-t.done
		_ = t.pty.Close()
	})
	return nil
}
