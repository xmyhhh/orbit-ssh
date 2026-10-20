package app

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"orbitssh/src/platform"
)

type LocalDirectory struct {
	Directory
	Parent string `json:"parent"`
}

// The empty path is the user's home; "::drives" is a virtual Windows drive list.
func (a *App) ListLocalDirectory(dir string) (LocalDirectory, error) {
	if runtime.GOOS == "windows" && dir == "::drives" {
		files := []RemoteFile{}
		for letter := 'A'; letter <= 'Z'; letter++ {
			name := string(letter) + ":\\"
			if info, err := os.Stat(name); err == nil && info.IsDir() {
				files = append(files, RemoteFile{Name: name, IsDir: true})
			}
		}
		return LocalDirectory{Directory: Directory{Path: dir, Files: files}, Parent: dir}, nil
	}
	if dir == "" {
		var err error
		dir, err = platform.LocalDirectory()
		if err != nil {
			return LocalDirectory{}, err
		}
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return LocalDirectory{}, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return LocalDirectory{}, err
	}
	files := []RemoteFile{}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		isDir := info.IsDir()
		link := info.Mode()&os.ModeSymlink != 0
		if link {
			if target, e := os.Stat(filepath.Join(abs, entry.Name())); e == nil {
				isDir = target.IsDir()
			}
		}
		files = append(files, RemoteFile{Name: entry.Name(), Size: info.Size(), IsDir: isDir, IsSymlink: link, Modified: info.ModTime().Format(time.RFC3339), Mode: info.Mode().String()})
	}
	sortFiles(files)
	parent := filepath.Dir(abs)
	if runtime.GOOS == "windows" && parent == abs {
		parent = "::drives"
	}
	return LocalDirectory{Directory: Directory{Path: abs, Files: files}, Parent: parent}, nil
}

func (a *App) SelectLocalDirectory() (string, error) {
	return platform.SelectDirectory(a.ctx)
}

func (a *App) MakeLocalDirectory(dir, name string) error {
	if err := validFileName(name); err != nil {
		return err
	}
	if !filepath.IsAbs(dir) {
		return errors.New("请选择本地文件夹")
	}
	return os.Mkdir(filepath.Join(dir, name), 0755)
}

func validFileName(name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return errors.New("无效的文件或文件夹名称")
	}
	if runtime.GOOS == "windows" {
		for _, char := range name {
			if char < 32 {
				return errors.New("文件名称包含无效字符")
			}
		}
		base := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
		if strings.ContainsAny(name, ":<>\"|?*") || strings.TrimRight(name, " .") != name ||
			base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
			(len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9') {
			return errors.New("文件名称不受 Windows 支持：" + name)
		}
	}
	return nil
}
