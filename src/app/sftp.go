package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"

	"orbitssh/src/platform"
)

type RemoteFile struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	IsDir     bool   `json:"isDir"`
	IsSymlink bool   `json:"isSymlink"`
	Modified  string `json:"modified"`
	Mode      string `json:"mode"`
}
type Directory struct {
	Path  string       `json:"path"`
	Files []RemoteFile `json:"files"`
}

func (a *App) sftpClient(id string) (*sftp.Client, error) {
	s, err := a.session(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("连接已断开")
	}
	if s.files == nil {
		s.files, err = sftp.NewClient(s.client)
		if err != nil {
			return nil, fmt.Errorf("服务器未能打开 SFTP：%w", err)
		}
	}
	return s.files, nil
}

func (a *App) ListDirectory(id, dir string) (Directory, error) {
	c, err := a.sftpClient(id)
	if err != nil {
		return Directory{}, err
	}
	if dir == "" {
		dir, err = c.Getwd()
		if err != nil {
			return Directory{}, err
		}
	}
	dir, err = c.RealPath(dir)
	if err != nil {
		return Directory{}, err
	}
	entries, err := c.ReadDir(dir)
	if err != nil {
		return Directory{}, err
	}
	files := []RemoteFile{}
	for _, f := range entries {
		isDir := f.IsDir()
		isLink := f.Mode()&os.ModeSymlink != 0
		if isLink {
			if target, e := c.Stat(path.Join(dir, f.Name())); e == nil {
				isDir = target.IsDir()
			}
		}
		files = append(files, RemoteFile{Name: f.Name(), Size: f.Size(), IsDir: isDir, IsSymlink: isLink, Modified: f.ModTime().Format(time.RFC3339), Mode: f.Mode().String()})
	}
	sortFiles(files)
	return Directory{Path: dir, Files: files}, nil
}

func sortFiles(files []RemoteFile) {
	sort.Slice(files, func(i, j int) bool {
		if files[i].IsDir != files[j].IsDir {
			return files[i].IsDir
		}
		return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
	})
}

func (a *App) MakeDirectory(id, dir, name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return errors.New("请输入有效的文件夹名称")
	}
	c, err := a.sftpClient(id)
	if err != nil {
		return err
	}
	return c.Mkdir(path.Join(dir, name))
}

// validateRemoteName rejects names that would escape the containing directory.
func validateRemoteName(name string) error {
	if name == "" || name == "." || name == ".." || len(name) > 255 {
		return errors.New("请输入有效的名称")
	}
	if strings.ContainsAny(name, "/\\\x00") {
		return errors.New("名称不能包含路径分隔符")
	}
	return nil
}

// RenameRemote renames or moves an entry inside the remote filesystem.
func (a *App) RenameRemote(id, dir, from, to string) error {
	if err := validateRemoteName(from); err != nil {
		return err
	}
	if err := validateRemoteName(to); err != nil {
		return err
	}
	c, err := a.sftpClient(id)
	if err != nil {
		return err
	}
	source := path.Join(dir, from)
	target := path.Join(dir, to)
	if source == target {
		return nil
	}
	if _, err = c.Lstat(target); err == nil {
		return fmt.Errorf("“%s”已存在", to)
	}
	return c.Rename(source, target)
}

// MoveRemote moves an entry to another directory on the same server.
func (a *App) MoveRemote(id, from, toDir string) error {
	if !remoteAbsolute(from) || !remoteAbsolute(toDir) {
		return errors.New("请使用绝对路径")
	}
	c, err := a.sftpClient(id)
	if err != nil {
		return err
	}
	target := path.Join(toDir, path.Base(from))
	if from == target {
		return nil
	}
	if _, err = c.Lstat(target); err == nil {
		return fmt.Errorf("目标目录已存在同名项目：%s", path.Base(from))
	}
	return c.Rename(from, target)
}

// RemoveRemote deletes one file, or a directory only when it is empty.
func (a *App) RemoveRemote(id, filename string) error {
	if !remoteAbsolute(filename) {
		return errors.New("请使用绝对路径")
	}
	c, err := a.sftpClient(id)
	if err != nil {
		return err
	}
	info, err := c.Lstat(filename)
	if err != nil {
		return err
	}
	if info.IsDir() {
		entries, readErr := c.ReadDir(filename)
		if readErr != nil {
			return readErr
		}
		if len(entries) > 0 {
			return errors.New("文件夹不为空，请先删除其中的内容")
		}
		return c.RemoveDirectory(filename)
	}
	return c.Remove(filename)
}

// ChmodRemote changes the permission bits of one entry.
func (a *App) ChmodRemote(id, filename, mode string) error {
	if !remoteAbsolute(filename) {
		return errors.New("请使用绝对路径")
	}
	parsed, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimSpace(mode), "0o"), 8, 32)
	if err != nil || parsed > 0o7777 {
		return errors.New("请输入 0–7777 之间的八进制权限，例如 644")
	}
	c, err := a.sftpClient(id)
	if err != nil {
		return err
	}
	return c.Chmod(filename, os.FileMode(parsed))
}

// WriteRemoteFile replaces a text file with the given UTF-8 content. It is used
// by the MCP file tool; the editor keeps its own revision-checked save path.
func writeRemoteText(c *sftp.Client, filename, text string) error {
	if !remoteAbsolute(filename) {
		return errors.New("请使用绝对路径")
	}
	if len(text) > textEditLimit {
		return errors.New("写入内容不能超过 2 MB")
	}
	if !utf8.ValidString(text) {
		return errors.New("写入内容必须是 UTF-8 文本")
	}
	file, err := c.Create(filename)
	if err != nil {
		return err
	}
	if _, err = io.WriteString(file, text); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

type progressWriter struct {
	target io.Writer
	done   int64
	total  int64
	last   time.Time
	notify func(int64, int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, e := p.target.Write(b)
	p.done += int64(n)
	if time.Since(p.last) > 150*time.Millisecond {
		p.notify(p.done, p.total)
		p.last = time.Now()
	}
	return n, e
}

func (a *App) UploadFile(id, dir string) (bool, error) {
	c, err := a.sftpClient(id)
	if err != nil {
		return false, err
	}
	local, err := platform.SelectOpenFile(a.ctx, "选择要上传的文件")
	if err != nil || local == "" {
		return false, err
	}
	dest := path.Join(dir, filepath.Base(local))
	if existing, e := c.Stat(dest); e == nil {
		if !existing.Mode().IsRegular() {
			return false, errors.New("目标不是普通文件，无法替换")
		}
		confirmed, e := confirmAction(a.ctx, "替换远程文件？", dest+" 已存在，是否替换？", "替换")
		if e != nil || !confirmed {
			return false, e
		}
	} else if !os.IsNotExist(e) {
		return false, e
	}
	return a.uploadTo(id, c, local, dest)
}

func (a *App) uploadTo(id string, c *sftp.Client, local, dest string) (bool, error) {
	err := uploadAtomic(context.Background(), c, local, dest, func(n, total int64) {
		if a.emit != nil {
			a.emit("sftp:progress:"+id, n, total)
		}
	})
	return err == nil, err
}

func uploadAtomic(ctx context.Context, c *sftp.Client, local, dest string, progress func(int64, int64)) error {
	source, err := os.Open(local)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("请选择普通文件")
	}
	permissions := info.Mode().Perm() & 0755
	if existing, e := c.Stat(dest); e == nil {
		permissions = existing.Mode().Perm()
	}
	temp := path.Join(path.Dir(dest), fmt.Sprintf(".orbit-upload-%d.tmp", time.Now().UnixNano()))
	target, err := c.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY)
	if err != nil {
		return err
	}
	defer c.Remove(temp)
	_ = c.Chmod(temp, 0600)
	_, err = io.Copy(&progressWriter{target: target, total: info.Size(), notify: progress}, &cancelReader{ctx: ctx, reader: source})
	closeErr := target.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = c.Chmod(temp, permissions); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if _, ok := c.HasExtension("posix-rename@openssh.com"); ok {
		err = c.PosixRename(temp, dest)
	} else {
		err = c.Rename(temp, dest)
	}
	if err != nil {
		return fmt.Errorf("上传后重命名失败：%w", err)
	}
	progress(info.Size(), info.Size())
	return nil
}

func (a *App) DownloadFile(id, remote string) (bool, error) {
	c, err := a.sftpClient(id)
	if err != nil {
		return false, err
	}
	dest, err := platform.SelectSaveFile(a.ctx, path.Base(remote))
	if err != nil || dest == "" {
		return false, err
	}
	return a.downloadTo(id, c, remote, dest)
}

func (a *App) downloadTo(id string, c *sftp.Client, remote, dest string) (bool, error) {
	err := downloadAtomic(context.Background(), c, remote, dest, func(n, total int64) {
		if a.emit != nil {
			a.emit("sftp:progress:"+id, n, total)
		}
	})
	return err == nil, err
}

func downloadAtomic(ctx context.Context, c *sftp.Client, remote, dest string, progress func(int64, int64)) error {
	source, err := c.Open(remote)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("当前支持下载普通文件")
	}
	temp, err := os.CreateTemp(filepath.Dir(dest), ".orbit-download-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	_, err = io.Copy(&progressWriter{target: temp, total: info.Size(), notify: progress}, &cancelReader{ctx: ctx, reader: source})
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = os.Rename(temp.Name(), dest); err != nil {
		return err
	}
	progress(info.Size(), info.Size())
	return nil
}

type cancelReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *cancelReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
