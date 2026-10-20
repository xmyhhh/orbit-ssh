//go:build windows

package local

import (
	"fmt"
	"os"
	"sync"
	"syscall"

	"github.com/charmbracelet/x/conpty"
	"golang.org/x/sys/windows"
)

// windowsTerminal runs a program on a Windows pseudo console, the counterpart
// of the Unix pseudo terminal.
type windowsTerminal struct {
	pty     *conpty.ConPty
	process windows.Handle
	done    chan struct{}
	code    uint32
	waitErr error
	once    sync.Once
	mu      sync.Mutex
	closed  bool
}

// StartWindows starts a program on a Windows pseudo console. WSL distributions
// use it as well, so it stays available on every Windows build.
func StartWindows(executable string, args []string, dir string, cols, rows int) (Terminal, error) {
	if err := windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find(); err != nil {
		return nil, fmt.Errorf("内嵌终端需要 Windows 10 1809 或更新版本")
	}
	pty, err := conpty.New(cols, rows, 0)
	if err != nil {
		return nil, err
	}
	_, handle, err := pty.Spawn(executable, append([]string{executable}, args...), &syscall.ProcAttr{Dir: dir, Env: append(os.Environ(), "TERM=xterm-256color")})
	if err != nil {
		_ = pty.Close()
		return nil, err
	}
	s := &windowsTerminal{pty: pty, process: windows.Handle(handle), done: make(chan struct{})}
	go func() {
		_, s.waitErr = windows.WaitForSingleObject(s.process, windows.INFINITE)
		if s.waitErr == nil {
			s.waitErr = windows.GetExitCodeProcess(s.process, &s.code)
		}
		close(s.done)
	}()
	return s, nil
}

func (s *windowsTerminal) Read(p []byte) (int, error)  { return s.pty.Read(p) }
func (s *windowsTerminal) Write(p []byte) (int, error) { return s.pty.Write(p) }
func (s *windowsTerminal) Wait() (uint32, error) {
	<-s.done
	return s.code, s.waitErr
}
func (s *windowsTerminal) Resize(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("本地终端已关闭")
	}
	return s.pty.Resize(cols, rows)
}
func (s *windowsTerminal) Close() error {
	s.once.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		// Stop only this terminal's process, never an entire WSL distribution.
		_ = windows.TerminateProcess(s.process, 0)
		<-s.done
		_ = s.pty.Close()
		_ = windows.CloseHandle(s.process)
	})
	return nil
}
