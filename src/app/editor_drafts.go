package app

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// EditorDraft is a local recovery copy, never a request to upload a file. Revision
// is the original remote revision, so recovering a draft cannot bypass conflicts.
type EditorDraft struct {
	Version    int    `json:"version"`
	EditorID   string `json:"editorID"`
	HostID     string `json:"hostID"`
	Path       string `json:"path"`
	Text       string `json:"text"`
	Revision   string `json:"revision"`
	LineEnding string `json:"lineEnding"`
	BOM        bool   `json:"bom"`
	UpdatedAt  string `json:"updatedAt"`
}

// JSON may escape every byte in the 2 MB text; bound reads before decoding too.
const editorDraftReadLimit = textEditLimit*6 + 64*1024

// Local recovery must never wait for fileEditMu, which is held during remote IO.
var editorDraftMu sync.Mutex

func validateEditorDraftPath(filename string) error {
	// Remote paths are resolved by ReadRemoteTextFile. They are only used as
	// identity, never joined onto a local directory, even after validation.
	if len(filename) > 32768 || !utf8.ValidString(filename) || strings.IndexByte(filename, 0) >= 0 || !remoteAbsolute(filename) || path.Clean(filename) != filename || filename == "/" {
		return errors.New("无效的草稿文件路径")
	}
	return nil
}

func validateEditorDraft(draft EditorDraft) error {
	if err := validateEditorDraftPath(draft.Path); err != nil {
		return err
	}
	if draft.Version != 1 || strings.TrimSpace(draft.EditorID) == "" || len(draft.EditorID) > 128 || !utf8.ValidString(draft.EditorID) || strings.IndexByte(draft.EditorID, 0) >= 0 {
		return errors.New("无效的草稿编辑器标识")
	}
	if len(draft.Text) > textEditLimit || !utf8.ValidString(draft.Text) || strings.IndexByte(draft.Text, 0) >= 0 {
		return errors.New("本地草稿仅支持不超过 2 MB 的 UTF-8 文本")
	}
	if len(draft.Revision) != 64 {
		return errors.New("草稿缺少有效的远程文件版本")
	}
	if _, err := hex.DecodeString(draft.Revision); err != nil {
		return errors.New("草稿缺少有效的远程文件版本")
	}
	if draft.LineEnding != "LF" && draft.LineEnding != "CRLF" && draft.LineEnding != "mixed" {
		return errors.New("无效的草稿换行格式")
	}
	return nil
}

func (a *App) editorDraftLocation(sessionID, filename string) (hostID, dir, name string, err error) {
	if err = a.ready(); err != nil {
		return
	}
	if err = validateEditorDraftPath(filename); err != nil {
		return
	}
	a.mu.Lock()
	if session := a.sessions[sessionID]; session != nil {
		hostID = session.host.ID
		if a.editorDraftHosts == nil {
			a.editorDraftHosts = make(map[string]string)
		}
		// Capture during the initial LoadEditorDraft call, before the editor
		// accepts input. Do not delete this binding when sessions detach: late
		// shutdown writes must still resolve to the same stable host identity.
		a.editorDraftHosts[sessionID] = hostID
	} else {
		hostID = a.editorDraftHosts[sessionID]
	}
	a.mu.Unlock()
	if strings.TrimSpace(hostID) == "" || len(hostID) > 128 || !utf8.ValidString(hostID) || strings.IndexByte(hostID, 0) >= 0 {
		err = errors.New("无法确定远程主机，草稿未保存")
		return
	}
	dir = filepath.Join(filepath.Dir(a.store.path), "editor-drafts")
	name = filepath.Join(dir, textRevision([]byte(hostID+"\x00"+filename))+".json")
	return
}

func editorDraftDirectory(dir string, create bool) error {
	if create {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("草稿目录不是安全的本地目录")
	}
	return os.Chmod(dir, 0700)
}

func syncEditorDraftDirectory(dir string) error {
	// Windows does not support fsync on directory handles. Files themselves are
	// synced on every write on every platform before their atomic rename.
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (a *App) UpdateEditorDraft(editorID, sessionID string, document RemoteTextFile, text string) error {
	editorDraftMu.Lock()
	defer editorDraftMu.Unlock()
	hostID, dir, filename, err := a.editorDraftLocation(sessionID, document.Path)
	if err != nil {
		return err
	}
	draft := EditorDraft{
		Version: 1, EditorID: editorID, HostID: hostID, Path: document.Path,
		Text: text, Revision: document.Revision, LineEnding: document.LineEnding,
		BOM: document.BOM, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err = validateEditorDraft(draft); err != nil {
		return err
	}
	// The baseline also comes from the bridge; reject malformed/oversized input
	// rather than silently accepting something the remote editor cannot save.
	if len(document.Text) > textEditLimit || !utf8.ValidString(document.Text) || strings.IndexByte(document.Text, 0) >= 0 {
		return errors.New("无效的草稿原始文本")
	}
	if err = editorDraftDirectory(dir, true); err != nil {
		return fmt.Errorf("无法保存本地草稿：%w", err)
	}
	data, err := json.Marshal(draft)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".editor-draft-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), filename); err != nil {
		return err
	}
	return syncEditorDraftDirectory(dir)
}

// LoadEditorDraft returns nil, nil if there is no recovery copy for this host/path.
// It performs no remote IO and never replaces the current remote document.
func (a *App) LoadEditorDraft(sessionID, filename string) (*EditorDraft, error) {
	editorDraftMu.Lock()
	defer editorDraftMu.Unlock()
	hostID, dir, name, err := a.editorDraftLocation(sessionID, filename)
	if err != nil {
		return nil, err
	}
	if err = editorDraftDirectory(dir, false); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	info, err := os.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > editorDraftReadLimit {
		return nil, errors.New("本地草稿格式无效，原文件已保留")
	}
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err = f.Chmod(0600); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, editorDraftReadLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > editorDraftReadLimit || !utf8.Valid(data) {
		return nil, errors.New("本地草稿内容无效，原文件已保留")
	}
	var draft EditorDraft
	if err = json.Unmarshal(data, &draft); err != nil {
		return nil, fmt.Errorf("本地草稿无法读取，原文件已保留：%w", err)
	}
	if draft.HostID != hostID || draft.Path != filename {
		return nil, errors.New("本地草稿不属于此主机或文件，原文件已保留")
	}
	if err = validateEditorDraft(draft); err != nil {
		return nil, err
	}
	if _, err = time.Parse(time.RFC3339Nano, draft.UpdatedAt); err != nil {
		return nil, errors.New("无效的草稿时间")
	}
	return &draft, nil
}

func (a *App) RemoveEditorDraft(sessionID, filename string) error {
	editorDraftMu.Lock()
	defer editorDraftMu.Unlock()
	_, dir, name, err := a.editorDraftLocation(sessionID, filename)
	if err != nil {
		return err
	}
	if err = editorDraftDirectory(dir, false); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err = os.Remove(name); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return syncEditorDraftDirectory(dir)
}
