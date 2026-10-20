package app

import (
	"bytes"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func waitTransfer(t *testing.T, a *App, session, id string) Transfer {
	t.Helper()
	deadline := time.After(10 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		for _, job := range a.ListTransfers(session) {
			if job.ID == id && transferFinished(job.Status) {
				return job
			}
		}
		select {
		case <-ticker.C:
		case <-deadline:
			t.Fatalf("transfer did not finish: %+v", a.ListTransfers(session))
			return Transfer{}
		}
	}
}

func transferTestApp(t *testing.T) (*App, string) {
	t.Helper()
	address, fingerprint := testSSHServer(t)
	a := testApp(t, address)
	if err := a.Connect("files", "test-host", Credentials{Password: "session-only-secret"}, fingerprint, TerminalSize{}); err != nil {
		t.Fatal(err)
	}
	listing, err := a.ListDirectory("files", filepath.ToSlash(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	return a, listing.Path
}

func TestRecursiveTransfersAndConflicts(t *testing.T) {
	a, remote := transferTestApp(t)
	local := t.TempDir()
	source := filepath.Join(local, "项目资料")
	if err := os.MkdirAll(filepath.Join(source, "nested", "empty"), 0755); err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("你好 Orbit\n"), 20000)
	if err := os.WriteFile(filepath.Join(source, "nested", "data.bin"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "readme.txt"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(local, "extra.txt")
	if err := os.WriteFile(extra, []byte("separate item"), 0600); err != nil {
		t.Fatal(err)
	}
	req := TransferRequest{SessionID: "files", Direction: "upload", Sources: []string{source, extra}, Destination: remote, Conflict: "skip"}
	id, err := a.QueueTransfer(req)
	if err != nil {
		t.Fatal(err)
	}
	job := waitTransfer(t, a, "files", id)
	if job.Status != "completed" || job.CompletedFiles != 3 || job.DoneBytes != int64(len(payload)+len("original")+len("separate item")) {
		t.Fatalf("upload: %+v", job)
	}

	if err = os.WriteFile(filepath.Join(source, "readme.txt"), []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	id, err = a.QueueTransfer(req)
	if err != nil {
		t.Fatal(err)
	}
	job = waitTransfer(t, a, "files", id)
	if job.Status != "completed" || job.Skipped != 3 || job.CompletedFiles != 0 {
		t.Fatalf("skip: %+v", job)
	}
	preview, err := a.ReadFilePreview("files", "remote", path.Join(remote, "项目资料", "readme.txt"))
	if err != nil || preview.Text != "original" {
		t.Fatalf("skip changed original: %+v %v", preview, err)
	}

	req.Conflict = "replace"
	id, err = a.QueueTransfer(req)
	if err != nil {
		t.Fatal(err)
	}
	if job = waitTransfer(t, a, "files", id); job.Status != "completed" || job.CompletedFiles != 3 {
		t.Fatalf("replace: %+v", job)
	}
	preview, err = a.ReadFilePreview("files", "remote", path.Join(remote, "项目资料", "readme.txt"))
	if err != nil || preview.Text != "replacement" {
		t.Fatalf("replace not applied: %+v %v", preview, err)
	}

	downloads := t.TempDir()
	download := TransferRequest{SessionID: "files", Direction: "download", Sources: []string{path.Join(remote, "项目资料"), path.Join(remote, "extra.txt")}, Destination: downloads, Conflict: "skip"}
	id, err = a.QueueTransfer(download)
	if err != nil {
		t.Fatal(err)
	}
	if job = waitTransfer(t, a, "files", id); job.Status != "completed" || job.CompletedFiles != 3 {
		t.Fatalf("download: %+v", job)
	}
	data, err := os.ReadFile(filepath.Join(downloads, "项目资料", "nested", "data.bin"))
	if err != nil || !bytes.Equal(data, payload) {
		t.Fatal("recursive roundtrip changed binary content", err)
	}
	if info, err := os.Stat(filepath.Join(downloads, "项目资料", "nested", "empty")); err != nil || !info.IsDir() {
		t.Fatal("empty directory was not copied", err)
	}
	if err = os.WriteFile(filepath.Join(downloads, "extra.txt"), []byte("local change"), 0600); err != nil {
		t.Fatal(err)
	}
	id, err = a.QueueTransfer(download)
	if err != nil {
		t.Fatal(err)
	}
	if job = waitTransfer(t, a, "files", id); job.Status != "completed" || job.Skipped != 3 {
		t.Fatalf("download skip: %+v", job)
	}
	download.Conflict = "replace"
	id, err = a.QueueTransfer(download)
	if err != nil {
		t.Fatal(err)
	}
	if job = waitTransfer(t, a, "files", id); job.Status != "completed" {
		t.Fatalf("download replace: %+v", job)
	}
	data, _ = os.ReadFile(filepath.Join(downloads, "extra.txt"))
	if string(data) != "separate item" {
		t.Fatal("local replacement did not apply")
	}
	a.ClearTransfers("files")
	if len(a.ListTransfers("files")) != 0 {
		t.Fatal("completed history not cleared")
	}
}

func TestTransferCancellationAndFailurePreserveFiles(t *testing.T) {
	a, remote := transferTestApp(t)
	source := filepath.Join(t.TempDir(), "large.bin")
	if err := os.WriteFile(source, bytes.Repeat([]byte{42}, 2*1024*1024), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := a.sftpClient("files")
	if err != nil {
		t.Fatal(err)
	}
	target := path.Join(remote, "large.bin")
	f, err := client.Create(target)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write([]byte("keep original"))
	_ = f.Close()
	progress := make(chan string, 1)
	release := make(chan struct{})
	var once sync.Once
	a.emit = func(name string, args ...interface{}) {
		if name != "sftp:transfer:files" {
			return
		}
		job := args[0].(Transfer)
		if job.Status == "running" && job.DoneBytes > 0 {
			once.Do(func() { progress <- job.ID; <-release })
		}
	}
	req := TransferRequest{SessionID: "files", Direction: "upload", Sources: []string{source}, Destination: remote, Conflict: "replace"}
	id, err := a.QueueTransfer(req)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-progress:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("no transfer progress")
	}
	queued, err := a.QueueTransfer(req)
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	if err = a.CancelTransfer(queued); err != nil {
		close(release)
		t.Fatal(err)
	}
	if err = a.CancelTransfer(id); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	if job := waitTransfer(t, a, "files", id); job.Status != "cancelled" {
		t.Fatalf("running cancellation: %+v", job)
	}
	if job := waitTransfer(t, a, "files", queued); job.Status != "cancelled" {
		t.Fatalf("queued cancellation: %+v", job)
	}
	preview, err := a.ReadFilePreview("files", "remote", target)
	if err != nil || preview.Text != "keep original" {
		t.Fatalf("cancel replaced original: %+v %v", preview, err)
	}
	listing, err := a.ListDirectory("files", remote)
	if err != nil {
		t.Fatal("cancellation closed browsing connection", err)
	}
	for _, file := range listing.Files {
		if strings.HasPrefix(file.Name, ".orbit-upload-") {
			t.Fatal("cancel leaked partial remote file")
		}
	}
	req.Sources = []string{filepath.Join(t.TempDir(), "missing.txt")}
	bad, err := a.QueueTransfer(req)
	if err != nil {
		t.Fatal(err)
	}
	if job := waitTransfer(t, a, "files", bad); job.Status != "failed" || job.Error == "" {
		t.Fatalf("missing file: %+v", job)
	}
	req.Sources = []string{source}
	id, err = a.QueueTransfer(req)
	if err != nil {
		t.Fatal(err)
	}
	if job := waitTransfer(t, a, "files", id); job.Status != "completed" {
		t.Fatalf("queue did not recover: %+v", job)
	}
}

func TestLocalBrowserAndBoundedPreview(t *testing.T) {
	a := NewApp()
	dir := t.TempDir()
	if err := a.MakeLocalDirectory(dir, "folder"); err != nil {
		t.Fatal(err)
	}
	if err := a.MakeLocalDirectory(dir, "../escape"); err == nil {
		t.Fatal("accepted invalid folder name")
	}
	for name, data := range map[string][]byte{"hello.txt": []byte("\xef\xbb\xbf你好"), "binary.bin": {0, 255, 1}, "large.txt": []byte(strings.Repeat("你", 100000))} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	listing, err := a.ListLocalDirectory(dir)
	if err != nil || len(listing.Files) != 4 || listing.Files[0].Name != "folder" || listing.Parent != filepath.Dir(dir) {
		t.Fatalf("listing: %+v %v", listing, err)
	}
	preview, err := a.ReadFilePreview("", "local", filepath.Join(dir, "hello.txt"))
	if err != nil || preview.Text != "你好" || preview.Truncated {
		t.Fatalf("text preview: %+v %v", preview, err)
	}
	preview, err = a.ReadFilePreview("", "local", filepath.Join(dir, "large.txt"))
	if err != nil || !preview.Truncated || len(preview.Text) > 256*1024 {
		t.Fatalf("bounded preview: %d %v", len(preview.Text), err)
	}
	if _, err = a.ReadFilePreview("", "local", filepath.Join(dir, "binary.bin")); err == nil {
		t.Fatal("binary preview was accepted")
	}
}

func TestDownloadCancellationPreservesLocalFile(t *testing.T) {
	a, remote := transferTestApp(t)
	local := t.TempDir()
	source := filepath.Join(local, "download.bin")
	if err := os.WriteFile(source, bytes.Repeat([]byte{13}, 2*1024*1024), 0600); err != nil {
		t.Fatal(err)
	}
	progress, release := make(chan string, 1), make(chan struct{})
	var once sync.Once
	a.emit = func(name string, args ...interface{}) {
		if name != "sftp:transfer:files" {
			return
		}
		job := args[0].(Transfer)
		if job.Direction == "download" && job.Status == "running" && job.DoneBytes > 0 {
			once.Do(func() { progress <- job.ID; <-release })
		}
	}
	upload := TransferRequest{SessionID: "files", Direction: "upload", Sources: []string{source}, Destination: remote, Conflict: "skip"}
	id, err := a.QueueTransfer(upload)
	if err != nil {
		t.Fatal(err)
	}
	if job := waitTransfer(t, a, "files", id); job.Status != "completed" {
		t.Fatalf("upload: %+v", job)
	}
	dest := t.TempDir()
	target := filepath.Join(dest, "download.bin")
	if err = os.WriteFile(target, []byte("keep local"), 0600); err != nil {
		t.Fatal(err)
	}
	id, err = a.QueueTransfer(TransferRequest{SessionID: "files", Direction: "download", Sources: []string{path.Join(remote, "download.bin")}, Destination: dest, Conflict: "replace"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-progress:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("no download progress")
	}
	if err = a.CancelTransfer(id); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	if job := waitTransfer(t, a, "files", id); job.Status != "cancelled" {
		t.Fatalf("cancel download: %+v", job)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "keep local" {
		t.Fatal("cancel replaced existing local file", err)
	}
	entries, err := os.ReadDir(dest)
	if err != nil || len(entries) != 1 {
		t.Fatal("cancel leaked partial local file", err)
	}
}
