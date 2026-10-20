package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
)

const textEditLimit = 2 * 1024 * 1024
const fileChanged = "FILE_CHANGED|文件已在远程发生变化，请重新载入后再编辑。当前修改仍保留。"

type RemoteTextFile struct {
	Path       string `json:"path"`
	Text       string `json:"text"`
	Revision   string `json:"revision"`
	LineEnding string `json:"lineEnding"`
	BOM        bool   `json:"bom"`
}

func textRevision(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func decodeRemoteText(filename string, data []byte) (RemoteTextFile, error) {
	if len(data) > textEditLimit {
		return RemoteTextFile{}, errors.New("在线编辑支持不超过 2 MB 的文本，请下载后编辑较大文件")
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return RemoteTextFile{}, errors.New("此文件不是 UTF-8 文本，请下载后使用本地应用编辑")
	}
	bom := bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf})
	text := string(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}))
	ending := "LF"
	if strings.Contains(text, "\r\n") {
		ending = "CRLF"
		if strings.Contains(strings.ReplaceAll(text, "\r\n", ""), "\n") {
			ending = "mixed"
		}
	}
	return RemoteTextFile{Path: filename, Text: strings.ReplaceAll(text, "\r\n", "\n"), Revision: textRevision(data), LineEnding: ending, BOM: bom}, nil
}

// Resolve links once and edit their target, never replace the link itself.
func resolveTextPath(c *sftp.Client, filename string) (string, error) {
	resolved, err := c.RealPath(filename)
	if err != nil {
		return "", err
	}
	for hops := 0; hops < 32; hops++ {
		info, e := c.Lstat(resolved)
		if e != nil {
			return "", e
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return resolved, nil
		}
		target, e := c.ReadLink(resolved)
		if e != nil {
			return "", e
		}
		if !path.IsAbs(target) {
			target = path.Join(path.Dir(resolved), target)
		}
		resolved, err = c.RealPath(target)
		if err != nil {
			return "", err
		}
	}
	return "", errors.New("符号链接层数过多")
}

func readRemoteText(c *sftp.Client, filename string) (RemoteTextFile, os.FileInfo, error) {
	info, err := c.Lstat(filename)
	if err != nil {
		return RemoteTextFile{}, nil, err
	}
	if !info.Mode().IsRegular() {
		return RemoteTextFile{}, nil, errors.New("只能编辑普通文本文件，请重新打开文件")
	}
	if info.Size() > textEditLimit {
		return RemoteTextFile{}, nil, errors.New("在线编辑支持不超过 2 MB 的文本，请下载后编辑较大文件")
	}
	f, err := c.Open(filename)
	if err != nil {
		return RemoteTextFile{}, nil, err
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil {
		return RemoteTextFile{}, nil, err
	}
	if !info.Mode().IsRegular() {
		return RemoteTextFile{}, nil, errors.New("只能编辑普通文本文件")
	}
	data, err := io.ReadAll(io.LimitReader(f, textEditLimit+1))
	if err != nil {
		return RemoteTextFile{}, nil, err
	}
	value, err := decodeRemoteText(filename, data)
	return value, info, err
}

func (a *App) ReadRemoteTextFile(sessionID, filename string) (RemoteTextFile, error) {
	c, err := a.sftpClient(sessionID)
	if err != nil {
		return RemoteTextFile{}, err
	}
	resolved, err := resolveTextPath(c, filename)
	if err != nil {
		return RemoteTextFile{}, err
	}
	value, _, err := readRemoteText(c, resolved)
	return value, err
}

func (a *App) SaveRemoteTextFile(sessionID, filename, text, revision string) (RemoteTextFile, error) {
	a.fileEditMu.Lock()
	defer a.fileEditMu.Unlock()
	if len(revision) != sha256.Size*2 {
		return RemoteTextFile{}, errors.New("缺少文件版本，请重新打开文件")
	}
	if len(text) > textEditLimit || !utf8.ValidString(text) || strings.IndexByte(text, 0) >= 0 {
		return RemoteTextFile{}, errors.New("只能保存不超过 2 MB 的 UTF-8 文本")
	}
	c, err := a.sftpClient(sessionID)
	if err != nil {
		return RemoteTextFile{}, err
	}
	current, info, err := readRemoteText(c, filename)
	if err != nil {
		return RemoteTextFile{}, err
	}
	if current.Revision != revision {
		return RemoteTextFile{}, errors.New(fileChanged)
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if text == current.Text {
		return current, nil
	}
	encoded := text
	if current.LineEnding == "CRLF" {
		encoded = strings.ReplaceAll(encoded, "\n", "\r\n")
	}
	if current.BOM {
		encoded = "\ufeff" + encoded
	}
	result, err := decodeRemoteText(filename, []byte(encoded))
	if err != nil {
		return RemoteTextFile{}, err
	}
	temp := path.Join(path.Dir(filename), fmt.Sprintf(".orbit-edit-%d.tmp", time.Now().UnixNano()))
	f, err := c.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY)
	if err != nil {
		return RemoteTextFile{}, fmt.Errorf("无法在此目录保存文件：%w", err)
	}
	defer c.Remove(temp)
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return RemoteTextFile{}, err
	}
	_, err = io.Copy(f, strings.NewReader(encoded))
	closeErr := f.Close()
	if err != nil {
		return RemoteTextFile{}, err
	}
	if closeErr != nil {
		return RemoteTextFile{}, closeErr
	}
	if owner, ok := info.Sys().(*sftp.FileStat); ok {
		tempInfo, e := c.Stat(temp)
		if e != nil {
			return RemoteTextFile{}, e
		}
		if created, ok := tempInfo.Sys().(*sftp.FileStat); ok && (created.UID != owner.UID || created.GID != owner.GID) {
			if err = c.Chown(temp, int(owner.UID), int(owner.GID)); err != nil {
				return RemoteTextFile{}, fmt.Errorf("无法保留文件所有者，原文件未修改：%w", err)
			}
		}
	}
	if err = c.Chmod(temp, info.Mode()); err != nil {
		return RemoteTextFile{}, err
	}
	// Check again after uploading; an external writer may have changed the file.
	latest, _, err := readRemoteText(c, filename)
	if err != nil {
		return RemoteTextFile{}, err
	}
	if latest.Revision != revision {
		return RemoteTextFile{}, errors.New(fileChanged)
	}
	if _, supported := c.HasExtension("posix-rename@openssh.com"); supported {
		err = c.PosixRename(temp, filename)
	} else {
		err = c.Rename(temp, filename)
	}
	if err != nil {
		return RemoteTextFile{}, fmt.Errorf("保存时重命名失败：%w", err)
	}
	return result, nil
}
