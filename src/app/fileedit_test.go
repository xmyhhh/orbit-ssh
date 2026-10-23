package app

import (
	"bytes"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestRemoteTextRoundTrip(t *testing.T) {
	a, dir := transferTestApp(t)
	for _, tc := range []struct {
		name, original, edited, expected, ending string
		bom                                      bool
	}{
		{"unicode.sh", "#!/bin/sh\necho '你好'\n", "#!/bin/sh\necho '已修改'\n", "#!/bin/sh\necho '已修改'\n", "LF", false},
		{"windows.json", "\ufeff{\r\n  \"port\": 22\r\n}\r\n", "{\n  \"port\": 2200\n}\n", "\ufeff{\r\n  \"port\": 2200\r\n}\r\n", "CRLF", true},
		{"empty.txt", "", "第一行", "第一行", "LF", false},
		{"clear.txt", "clear me\n", "", "", "LF", false},
		{"mixed.txt", "a\r\nb\n", "a\nb\n", "a\r\nb\n", "mixed", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filename := path.Join(dir, tc.name)
			if err := os.WriteFile(localTextTestPath(filename), []byte(tc.original), 0640); err != nil {
				t.Fatal(err)
			}
			before, _ := os.Stat(localTextTestPath(filename))
			value, err := a.ReadRemoteTextFile("files", filename)
			if err != nil || value.BOM != tc.bom || value.LineEnding != tc.ending || value.Text != strings.ReplaceAll(strings.TrimPrefix(tc.original, "\ufeff"), "\r\n", "\n") {
				t.Fatalf("read: %+v %v", value, err)
			}
			saved, err := a.SaveRemoteTextFile("files", value.Path, tc.edited, value.Revision)
			if err != nil {
				t.Fatal(err)
			}
			actual, err := os.ReadFile(localTextTestPath(filename))
			if err != nil || string(actual) != tc.expected {
				t.Fatalf("saved %q, want %q: %v", actual, tc.expected, err)
			}
			reread, err := a.ReadRemoteTextFile("files", filename)
			if err != nil || saved != reread {
				t.Fatalf("inconsistent saved revision: %+v %+v %v", saved, reread, err)
			}
			after, _ := os.Stat(localTextTestPath(filename))
			if before.Mode().Perm() != after.Mode().Perm() {
				t.Fatalf("mode changed: %v -> %v", before.Mode(), after.Mode())
			}
		})
	}
	entries, _ := os.ReadDir(localTextTestPath(dir))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".orbit-edit-") {
			t.Fatal("temporary file leaked")
		}
	}
}

func TestRemoteTextConflictsAndValidation(t *testing.T) {
	a, dir := transferTestApp(t)
	filename := path.Join(dir, "config.yaml")
	if err := os.WriteFile(localTextTestPath(filename), []byte("port: 22\n"), 0600); err != nil {
		t.Fatal(err)
	}
	original, err := a.ReadRemoteTextFile("files", filename)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(localTextTestPath(filename), []byte("port: 80\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = a.SaveRemoteTextFile("files", filename, "port: 443\n", original.Revision); err == nil || !strings.Contains(err.Error(), "FILE_CHANGED|") {
		t.Fatalf("external change not detected: %v", err)
	}
	data, _ := os.ReadFile(localTextTestPath(filename))
	if string(data) != "port: 80\n" {
		t.Fatal("conflict overwrote external data")
	}
	for _, revision := range []string{"", "invalid", strings.Repeat("a", 64)} {
		if _, err = a.SaveRemoteTextFile("files", filename, "overwrite", revision); err == nil {
			t.Fatal("invalid revision accepted")
		}
	}
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"binary", []byte{0, 1, 2}}, {"non-utf8", []byte{0xff, 0xfe}},
		{"too-large", bytes.Repeat([]byte("a"), textEditLimit+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := path.Join(dir, tc.name)
			if err := os.WriteFile(localTextTestPath(bad), tc.data, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := a.ReadRemoteTextFile("files", bad); err == nil {
				t.Fatal("invalid file accepted")
			}
			if _, err := a.SaveRemoteTextFile("files", filename, string(tc.data), original.Revision); err == nil {
				t.Fatal("invalid content accepted")
			}
		})
	}
	if _, err = a.ReadRemoteTextFile("files", dir); err == nil {
		t.Fatal("directory accepted")
	}
	if err = os.Remove(localTextTestPath(filename)); err != nil {
		t.Fatal(err)
	}
	if _, err = a.SaveRemoteTextFile("files", filename, "recreate", original.Revision); err == nil {
		t.Fatal("deleted file recreated")
	}
	if _, err = a.ReadRemoteTextFile("missing-session", filename); err == nil {
		t.Fatal("disconnected session accepted")
	}
}

func TestRemoteTextConcurrentSaves(t *testing.T) {
	a, dir := transferTestApp(t)
	filename := path.Join(dir, "competing.txt")
	if err := os.WriteFile(localTextTestPath(filename), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	value, err := a.ReadRemoteTextFile("files", filename)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, text := range []string{"one", "two"} {
		wg.Add(1)
		go func(text string) {
			defer wg.Done()
			_, err := a.SaveRemoteTextFile("files", filename, text, value.Revision)
			results <- err
		}(text)
	}
	wg.Wait()
	close(results)
	ok, conflicts := 0, 0
	for err := range results {
		if err == nil {
			ok++
		} else if strings.Contains(err.Error(), "FILE_CHANGED|") {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if ok != 1 || conflicts != 1 {
		t.Fatalf("successful=%d conflicts=%d", ok, conflicts)
	}
}

func TestRemoteTextSymlinkTarget(t *testing.T) {
	t.Run("relative", func(t *testing.T) { testRemoteTextSymlinkTarget(t, false) })
	if runtime.GOOS != "windows" {
		t.Run("absolute", func(t *testing.T) { testRemoteTextSymlinkTarget(t, true) })
	}
}

func testRemoteTextSymlinkTarget(t *testing.T, absolute bool) {
	a, dir := transferTestApp(t)
	target := path.Join(dir, "target.txt")
	link := path.Join(dir, "link.txt")
	if err := os.WriteFile(localTextTestPath(target), []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	// The in-process Windows SFTP server exposes POSIX paths, so native
	// drive-qualified absolute targets cannot model a remote POSIX symlink.
	// Exercise relative targets on all hosts and absolute ones on Unix.
	linkTarget := path.Base(target)
	if absolute {
		linkTarget = target
	}
	if err := os.Symlink(linkTarget, localTextTestPath(link)); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("Windows symlink privilege unavailable")
		}
		t.Fatal(err)
	}
	value, err := a.ReadRemoteTextFile("files", link)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.SaveRemoteTextFile("files", value.Path, "after", value.Revision); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(localTextTestPath(link))
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("symbolic link replaced")
	}
	data, _ := os.ReadFile(localTextTestPath(target))
	if string(data) != "after" {
		t.Fatal("link target not updated")
	}
}

func localTextTestPath(remote string) string {
	if runtime.GOOS == "windows" {
		return filepath.FromSlash(strings.TrimPrefix(remote, "/"))
	}
	return remote
}
