package app

import (
	"bytes"
	"errors"
	"io"
	"os"
	"unicode/utf8"
)

type FilePreview struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

func (a *App) ReadFilePreview(sessionID, side, filename string) (FilePreview, error) {
	var source io.ReadCloser
	var info os.FileInfo
	var err error
	if side == "local" {
		info, err = os.Stat(filename)
		if err != nil {
			return FilePreview{}, err
		}
		if !info.Mode().IsRegular() {
			return FilePreview{}, errors.New("只能预览普通文件")
		}
		file, e := os.Open(filename)
		if e != nil {
			return FilePreview{}, e
		}
		source = file
		info, err = file.Stat()
	} else if side == "remote" {
		client, e := a.sftpClient(sessionID)
		if e != nil {
			return FilePreview{}, e
		}
		info, err = client.Stat(filename)
		if err != nil {
			return FilePreview{}, err
		}
		if !info.Mode().IsRegular() {
			return FilePreview{}, errors.New("只能预览普通文件")
		}
		file, e := client.Open(filename)
		if e != nil {
			return FilePreview{}, e
		}
		source = file
		info, err = file.Stat()
	} else {
		return FilePreview{}, errors.New("无效的文件来源")
	}
	defer source.Close()
	if err != nil {
		return FilePreview{}, err
	}
	if !info.Mode().IsRegular() {
		return FilePreview{}, errors.New("只能预览普通文件")
	}
	const limit = 256 * 1024
	data, err := io.ReadAll(io.LimitReader(source, limit+1))
	if err != nil {
		return FilePreview{}, err
	}
	truncated := len(data) > limit
	if truncated {
		data = data[:limit]
		// The cap may split a UTF-8 rune; remove only that incomplete tail.
		for i := 0; i < 3 && !utf8.Valid(data) && len(data) > 0; i++ {
			data = data[:len(data)-1]
		}
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return FilePreview{}, errors.New("此文件不是 UTF-8 文本，请下载后使用本地应用查看")
	}
	return FilePreview{Text: string(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})), Truncated: truncated}, nil
}
