package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const terminalHistoryMaxCharacters = 512 * 1024
const terminalHistoryMaxBytes = 2 * 1024 * 1024

type TerminalHistoryRecord struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Name           string `json:"name,omitempty"`
	Subtitle       string `json:"subtitle"`
	TerminalNumber int    `json:"terminalNumber"`
	CreatedAt      int64  `json:"createdAt"`
	UpdatedAt      int64  `json:"updatedAt"`
	Output         string `json:"output"`
	Pinned         bool   `json:"pinned"`
	Truncated      bool   `json:"truncated"`
}

type terminalHistoryChange struct {
	revision uint64
	record   *TerminalHistoryRecord
}

func historyFilename(id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(id)) + ".json"
}

func validTerminalHistoryRecord(record TerminalHistoryRecord) error {
	if strings.TrimSpace(record.ID) == "" || len(record.ID) > 128 {
		return errors.New("无效的终端历史 ID")
	}
	if len(record.Title) > 512 || len(record.Name) > 512 || len(record.Subtitle) > 2048 {
		return errors.New("终端历史标题过长")
	}
	if len(record.Output) > terminalHistoryMaxBytes {
		return errors.New("终端历史输出超过限制")
	}
	return nil
}

func (a *App) loadTerminalHistory() error {
	entries, err := os.ReadDir(a.historyDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	loaded := make(map[string]TerminalHistoryRecord)
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(a.historyDir, entry.Name()))
		if readErr != nil {
			return readErr
		}
		var record TerminalHistoryRecord
		if jsonErr := json.Unmarshal(data, &record); jsonErr != nil {
			return fmt.Errorf("终端历史记录无法读取：%w", jsonErr)
		}
		if err = validTerminalHistoryRecord(record); err != nil {
			return err
		}
		loaded[record.ID] = record
	}
	a.historyMu.Lock()
	a.history = loaded
	a.historyMu.Unlock()
	return nil
}

func (a *App) SyncTerminalHistory(records []TerminalHistoryRecord) error {
	if len(records) > 10000 {
		return errors.New("终端历史记录过多")
	}
	updated := make(map[string]TerminalHistoryRecord, len(records))
	for _, record := range records {
		if err := validTerminalHistoryRecord(record); err != nil {
			return err
		}
		record.Output, record.Truncated = boundedTerminalHistoryOutput(record.Output, record.Truncated)
		updated[record.ID] = record
	}
	a.historyMu.Lock()
	for id := range a.history {
		if _, ok := updated[id]; !ok {
			a.tombstoneTerminalHistoryLocked(id)
			a.markTerminalHistoryChangedLocked(id, nil)
		}
	}
	for id, record := range updated {
		copy := record
		a.markTerminalHistoryChangedLocked(id, &copy)
	}
	a.history = updated
	a.historyMu.Unlock()
	return nil
}

func (a *App) UpsertTerminalHistory(record TerminalHistoryRecord, retainedIDs []string) error {
	if err := validTerminalHistoryRecord(record); err != nil {
		return err
	}
	record.Output, record.Truncated = boundedTerminalHistoryOutput(record.Output, record.Truncated)
	a.historyMu.Lock()
	delete(a.historyDeleted, record.ID)
	copy := record
	a.history[record.ID] = record
	a.markTerminalHistoryChangedLocked(record.ID, &copy)
	a.pruneTerminalHistoryLocked(retainedIDs)
	a.historyMu.Unlock()
	return nil
}

func (a *App) AppendTerminalHistory(record TerminalHistoryRecord, outputDelta string, retainedIDs []string) error {
	if strings.TrimSpace(record.ID) == "" || len(record.ID) > 128 {
		return errors.New("无效的终端历史 ID")
	}
	if len(outputDelta) > 256*1024 {
		return errors.New("终端历史增量过大")
	}
	a.historyMu.Lock()
	if a.historyDeleted[record.ID] {
		a.historyMu.Unlock()
		return nil
	}
	current := a.history[record.ID]
	if current.ID == "" {
		current = record
		current.Output = ""
	} else {
		current.Title = record.Title
		if record.Name != "" {
			current.Name = record.Name
		}
		current.Subtitle = record.Subtitle
		current.TerminalNumber = record.TerminalNumber
		current.CreatedAt = record.CreatedAt
		current.UpdatedAt = record.UpdatedAt
		current.Truncated = current.Truncated || record.Truncated
	}
	current.Output += outputDelta
	current.Output, current.Truncated = boundedTerminalHistoryOutput(current.Output, current.Truncated)
	a.history[record.ID] = current
	copy := current
	a.markTerminalHistoryChangedLocked(record.ID, &copy)
	a.pruneTerminalHistoryLocked(retainedIDs)
	a.historyMu.Unlock()
	return nil
}

func boundedTerminalHistoryOutput(output string, truncated bool) (string, bool) {
	characters := 0
	for _, character := range output {
		characters += utf16.RuneLen(character)
	}
	if characters <= terminalHistoryMaxCharacters {
		return output, truncated
	}
	drop := characters - terminalHistoryMaxCharacters
	removed := 0
	start := len(output)
	for offset, character := range output {
		removed += utf16.RuneLen(character)
		if removed >= drop {
			start = offset + utf8.RuneLen(character)
			break
		}
	}
	if lineBreak := strings.IndexByte(output[start:], '\n'); lineBreak >= 0 {
		start += lineBreak + 1
	}
	return output[start:], true
}

func (a *App) DeleteTerminalHistory(id string) {
	a.historyMu.Lock()
	delete(a.history, id)
	a.tombstoneTerminalHistoryLocked(id)
	a.markTerminalHistoryChangedLocked(id, nil)
	a.historyMu.Unlock()
}

func (a *App) pruneTerminalHistoryLocked(retainedIDs []string) {
	if len(retainedIDs) == 0 {
		return
	}
	retained := make(map[string]bool, len(retainedIDs))
	for _, id := range retainedIDs {
		retained[id] = true
	}
	for id := range a.history {
		if !retained[id] {
			delete(a.history, id)
			a.tombstoneTerminalHistoryLocked(id)
			a.markTerminalHistoryChangedLocked(id, nil)
		}
	}
}

func (a *App) tombstoneTerminalHistoryLocked(id string) {
	if a.historyDeleted == nil {
		a.historyDeleted = map[string]bool{}
	}
	a.historyDeleted[id] = true
}

func (a *App) markTerminalHistoryChangedLocked(id string, record *TerminalHistoryRecord) {
	if a.historyChanges == nil {
		a.historyChanges = map[string]terminalHistoryChange{}
	}
	a.historyRevision++
	a.historyChanges[id] = terminalHistoryChange{revision: a.historyRevision, record: record}
	if a.historyTimer == nil {
		a.historyTimer = time.AfterFunc(time.Second, a.persistTerminalHistoryChanges)
	}
}

func (a *App) terminalHistorySnapshot() []TerminalHistoryRecord {
	a.historyMu.RLock()
	defer a.historyMu.RUnlock()
	records := make([]TerminalHistoryRecord, 0, len(a.history))
	for _, record := range a.history {
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].UpdatedAt > records[j].UpdatedAt })
	return records
}

func (a *App) persistTerminalHistoryChanges() {
	a.historyPersistMu.Lock()
	defer a.historyPersistMu.Unlock()
	a.historyMu.Lock()
	a.historyTimer = nil
	changes := make(map[string]terminalHistoryChange, len(a.historyChanges))
	for id, change := range a.historyChanges {
		changes[id] = change
	}
	a.historyMu.Unlock()
	if len(changes) == 0 {
		return
	}

	if err := os.MkdirAll(a.historyDir, 0700); err != nil {
		a.setHistoryStoreError(err)
		a.scheduleHistoryRetry()
		return
	}
	failed := false
	for id, change := range changes {
		path := filepath.Join(a.historyDir, historyFilename(id))
		var err error
		if change.record == nil {
			err = os.Remove(path)
			if errors.Is(err, os.ErrNotExist) {
				err = nil
			}
		} else {
			err = writeTerminalHistoryRecord(path, *change.record)
		}
		if err != nil {
			failed = true
			a.setHistoryStoreError(err)
			a.scheduleHistoryRetry()
			continue
		}
		a.historyMu.Lock()
		if current, ok := a.historyChanges[id]; ok && current.revision == change.revision {
			delete(a.historyChanges, id)
		}
		a.historyMu.Unlock()
	}
	if !failed {
		a.setHistoryStoreError(nil)
	}
	if a.hasHistoryChanges() {
		a.scheduleHistoryRetry()
	}
}

func writeTerminalHistoryRecord(path string, record TerminalHistoryRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	temp, err := os.CreateTemp(directory, ".history-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(data)
	}
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
	return os.Rename(temp.Name(), path)
}

func (a *App) scheduleHistoryRetry() {
	a.historyMu.Lock()
	if a.historyTimer == nil && len(a.historyChanges) > 0 {
		a.historyTimer = time.AfterFunc(5*time.Second, a.persistTerminalHistoryChanges)
	}
	a.historyMu.Unlock()
}

func (a *App) hasHistoryChanges() bool {
	a.historyMu.RLock()
	defer a.historyMu.RUnlock()
	return len(a.historyChanges) > 0
}

func (a *App) setHistoryStoreError(err error) {
	a.historyMu.Lock()
	defer a.historyMu.Unlock()
	if err == nil {
		a.historyStoreError = ""
	} else {
		a.historyStoreError = err.Error()
	}
}

func (a *App) flushTerminalHistory() {
	a.historyMu.Lock()
	if a.historyTimer != nil {
		a.historyTimer.Stop()
		a.historyTimer = nil
	}
	a.historyMu.Unlock()
	a.persistTerminalHistoryChanges()
}
