package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

type TransferRequest struct {
	SessionID   string   `json:"sessionId"`
	Direction   string   `json:"direction"`
	Sources     []string `json:"sources"`
	Destination string   `json:"destination"`
	Conflict    string   `json:"conflict"`
}

type Transfer struct {
	ID             string `json:"id"`
	SessionID      string `json:"sessionId"`
	Direction      string `json:"direction"`
	Name           string `json:"name"`
	Destination    string `json:"destination"`
	Status         string `json:"status"`
	Current        string `json:"current"`
	TotalBytes     int64  `json:"totalBytes"`
	DoneBytes      int64  `json:"doneBytes"`
	TotalFiles     int    `json:"totalFiles"`
	CompletedFiles int    `json:"completedFiles"`
	Skipped        int    `json:"skipped"`
	Error          string `json:"error"`
	StartedAt      int64  `json:"startedAt"`
	FinishedAt     int64  `json:"finishedAt"`
}

type transferJob struct {
	view     Transfer // All access to view is protected by App.transferMu.
	request  TransferRequest
	ctx      context.Context
	cancel   context.CancelFunc
	lastEmit time.Time
}

func transferFinished(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

func (a *App) QueueTransfer(req TransferRequest) (string, error) {
	if req.Direction != "upload" && req.Direction != "download" {
		return "", errors.New("无效的传输方向")
	}
	if req.Conflict != "skip" && req.Conflict != "replace" {
		return "", errors.New("请选择同名文件的处理方式")
	}
	if len(req.Sources) == 0 || len(req.Sources) > 10000 {
		return "", errors.New("请选择要传输的文件或文件夹（最多 10000 项）")
	}
	if _, err := a.session(req.SessionID); err != nil {
		return "", err
	}
	if req.Direction == "download" && !filepath.IsAbs(req.Destination) || req.Direction == "upload" && !remoteAbsolute(req.Destination) {
		return "", errors.New("请先打开目标文件夹")
	}
	for _, source := range req.Sources {
		if req.Direction == "upload" && !filepath.IsAbs(source) || req.Direction == "download" && !remoteAbsolute(source) {
			return "", errors.New("源路径必须是绝对路径")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	name := path.Base(req.Sources[0])
	if req.Direction == "upload" {
		name = filepath.Base(req.Sources[0])
	}
	if len(req.Sources) > 1 {
		name = fmt.Sprintf("%s 等 %d 项", name, len(req.Sources))
	}
	a.transferMu.Lock()
	// Limit retained history; active jobs are never evicted.
	kept := []*transferJob{}
	active := 0
	for i, old := range a.transfers {
		if !transferFinished(old.view.Status) {
			active++
		}
		if !transferFinished(old.view.Status) || i >= len(a.transfers)-100 {
			kept = append(kept, old)
		}
	}
	if active >= 100 {
		a.transferMu.Unlock()
		cancel()
		return "", errors.New("传输队列已满，请等待当前任务完成")
	}
	id := fmt.Sprintf("transfer-%d", time.Now().UnixNano())
	job := &transferJob{ctx: ctx, cancel: cancel, request: req, view: Transfer{ID: id, SessionID: req.SessionID, Direction: req.Direction, Name: name, Destination: req.Destination, Status: "queued"}}
	a.transfers = append(kept, job)
	if a.transferRuns == nil {
		a.transferRuns = map[string]bool{}
	}
	start := !a.transferRuns[req.SessionID]
	a.transferRuns[req.SessionID] = true
	a.transferMu.Unlock()
	if start {
		go a.runTransferQueue(req.SessionID)
	}
	return id, nil
}

func remoteAbsolute(p string) bool {
	return path.IsAbs(p) || len(p) >= 3 && p[1] == ':' && p[2] == '/' && (p[0] >= 'A' && p[0] <= 'Z' || p[0] >= 'a' && p[0] <= 'z')
}

func (a *App) ListTransfers(sessionID string) []Transfer {
	a.transferMu.Lock()
	defer a.transferMu.Unlock()
	result := []Transfer{}
	for _, job := range a.transfers {
		if job.view.SessionID == sessionID {
			result = append(result, job.view)
		}
	}
	return result
}

func (a *App) CancelTransfer(id string) error {
	a.transferMu.Lock()
	defer a.transferMu.Unlock()
	for _, job := range a.transfers {
		if job.view.ID == id {
			if !transferFinished(job.view.Status) {
				job.cancel()
				if job.view.Status == "queued" {
					job.view.Status = "cancelled"
					job.view.FinishedAt = time.Now().UnixMilli()
				} else {
					job.view.Status = "cancelling"
				}
			}
			return nil
		}
	}
	return errors.New("传输任务不存在")
}

func (a *App) ClearTransfers(sessionID string) {
	a.transferMu.Lock()
	defer a.transferMu.Unlock()
	kept := []*transferJob{}
	for _, job := range a.transfers {
		if job.view.SessionID != sessionID || !transferFinished(job.view.Status) {
			kept = append(kept, job)
		}
	}
	a.transfers = kept
}

func (a *App) updateTransfer(job *transferJob, update func(*Transfer)) {
	a.transferMu.Lock()
	previous := job.view.Status
	previousBytes := job.view.DoneBytes
	update(&job.view)
	view := job.view
	shouldEmit := previous != view.Status || previousBytes == 0 && view.DoneBytes > 0 || time.Since(job.lastEmit) > 150*time.Millisecond
	if shouldEmit {
		job.lastEmit = time.Now()
	}
	a.transferMu.Unlock()
	if shouldEmit && a.emit != nil {
		a.emit("sftp:transfer:"+view.SessionID, view)
	}
}

func (a *App) runTransferQueue(sessionID string) {
	for {
		a.transferMu.Lock()
		var next *transferJob
		for _, job := range a.transfers {
			if job.view.SessionID == sessionID && job.view.Status == "queued" {
				next = job
				job.view.Status = "scanning"
				job.view.StartedAt = time.Now().UnixMilli()
				break
			}
		}
		if next == nil {
			delete(a.transferRuns, sessionID)
			a.transferMu.Unlock()
			return
		}
		a.transferMu.Unlock()
		err := a.executeTransfer(next)
		a.updateTransfer(next, func(v *Transfer) {
			v.FinishedAt = time.Now().UnixMilli()
			v.Status = "completed"
			if err != nil {
				v.Status, v.Error = "failed", err.Error()
				if next.ctx.Err() != nil {
					v.Status, v.Error = "cancelled", ""
				}
			}
		})
		next.cancel()
	}
}

type transferEntry struct {
	source, dest string
	size         int64
	directory    bool
}

func (a *App) executeTransfer(job *transferJob) error {
	s, err := a.session(job.request.SessionID)
	if err != nil {
		return err
	}
	// A separate SFTP channel keeps terminal and directory browsing responsive.
	c, err := sftp.NewClient(s.client)
	if err != nil {
		return err
	}
	defer c.Close()
	go func() {
		select {
		case <-s.done:
			job.cancel()
		case <-job.ctx.Done():
		}
	}()
	plan, skipped, err := planTransfer(job.ctx, c, job.request)
	if err != nil {
		return err
	}
	var total int64
	files := 0
	for _, entry := range plan {
		if !entry.directory {
			total += entry.size
			files++
		}
	}
	a.updateTransfer(job, func(v *Transfer) {
		if job.ctx.Err() == nil {
			v.Status = "running"
		}
		v.TotalBytes = total
		v.TotalFiles = files
		v.Skipped = skipped
	})
	var done int64
	for _, entry := range plan {
		if err = job.ctx.Err(); err != nil {
			return err
		}
		a.updateTransfer(job, func(v *Transfer) { v.Current = entry.source })
		var existing os.FileInfo
		if job.request.Direction == "upload" {
			existing, err = c.Lstat(entry.dest)
		} else {
			existing, err = os.Lstat(entry.dest)
		}
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("%s：%w", entry.dest, err)
		}
		if existing != nil {
			if existing.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("目标是符号链接，无法写入：%s", entry.dest)
			}
			if existing.IsDir() != entry.directory || !entry.directory && !existing.Mode().IsRegular() {
				return fmt.Errorf("目标类型与源不一致：%s", entry.dest)
			}
		}
		if entry.directory {
			if existing == nil {
				if job.request.Direction == "upload" {
					err = c.Mkdir(entry.dest)
				} else {
					err = os.Mkdir(entry.dest, 0755)
				}
				if err != nil {
					return fmt.Errorf("%s：%w", entry.dest, err)
				}
			}
			continue
		}
		if existing != nil && job.request.Conflict == "skip" {
			done += entry.size
			a.updateTransfer(job, func(v *Transfer) { v.Skipped++; v.DoneBytes = done })
			continue
		}
		progress := func(n, _ int64) { a.updateTransfer(job, func(v *Transfer) { v.DoneBytes = done + n }) }
		if job.request.Direction == "upload" {
			err = uploadAtomic(job.ctx, c, entry.source, entry.dest, progress)
		} else {
			err = downloadAtomic(job.ctx, c, entry.source, entry.dest, progress)
		}
		if err != nil {
			return fmt.Errorf("%s：%w", entry.source, err)
		}
		done += entry.size
		a.updateTransfer(job, func(v *Transfer) { v.CompletedFiles++; v.DoneBytes = done })
	}
	return nil
}

func planTransfer(ctx context.Context, c *sftp.Client, req TransferRequest) ([]transferEntry, int, error) {
	plan := []transferEntry{}
	skipped := 0
	upload := req.Direction == "upload"
	destRoot := req.Destination
	var info os.FileInfo
	var err error
	if upload {
		destRoot, err = c.RealPath(destRoot)
		if err == nil {
			info, err = c.Stat(destRoot)
		}
	} else {
		destRoot, err = filepath.EvalSymlinks(destRoot)
		if err == nil {
			info, err = os.Stat(destRoot)
		}
	}
	if err != nil {
		return nil, 0, err
	}
	if !info.IsDir() {
		return nil, 0, errors.New("目标路径不是文件夹")
	}
	seen := map[string]bool{}
	var walk func(string, string, int) error
	walk = func(source, dest string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > 128 || len(plan) >= 100000 {
			return errors.New("目录过深或项目过多，请分批传输")
		}
		var item os.FileInfo
		var err error
		if upload {
			item, err = os.Lstat(source)
		} else {
			item, err = c.Lstat(source)
		}
		if err != nil {
			return err
		}
		// Do not traverse links or special files, which may escape the selected tree.
		if item.Mode()&os.ModeSymlink != 0 || !item.IsDir() && !item.Mode().IsRegular() {
			skipped++
			return nil
		}
		plan = append(plan, transferEntry{source: source, dest: dest, size: item.Size(), directory: item.IsDir()})
		if !item.IsDir() {
			return nil
		}
		var children []os.FileInfo
		if upload {
			entries, e := os.ReadDir(source)
			if e != nil {
				return e
			}
			for _, entry := range entries {
				child, e := entry.Info()
				if e != nil {
					return e
				}
				children = append(children, child)
			}
		} else {
			children, err = c.ReadDir(source)
			if err != nil {
				return err
			}
		}
		for _, child := range children {
			name := child.Name()
			if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00") {
				return errors.New("无效的远程文件名称")
			}
			if upload {
				err = walk(filepath.Join(source, name), path.Join(dest, name), depth+1)
			} else {
				if err = validFileName(name); err != nil {
					return err
				}
				err = walk(path.Join(source, name), filepath.Join(dest, name), depth+1)
			}
			if err != nil {
				return err
			}
		}
		return nil
	}
	for _, source := range req.Sources {
		var dest string
		if upload {
			source = filepath.Clean(source)
			name := filepath.Base(source)
			if strings.ContainsAny(name, "/\\\x00") || name == "." {
				return nil, 0, errors.New("请选择文件或文件夹")
			}
			dest = path.Join(destRoot, name)
		} else {
			source = path.Clean(source)
			name := path.Base(source)
			if err = validFileName(name); err != nil {
				return nil, 0, err
			}
			dest = filepath.Join(destRoot, name)
		}
		if seen[source] {
			continue
		}
		seen[source] = true
		if err = walk(source, dest, 0); err != nil {
			return nil, 0, err
		}
	}
	return plan, skipped, nil
}
