package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const updateRepository = "https://github.com/xmyhhh/orbit-ssh"
const updateEndpoint = "https://api.github.com/repos/xmyhhh/orbit-ssh/releases/latest"
const updateCacheDuration = 5 * time.Minute

type UpdateDownload struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	URL   string `json:"url"`
}

type UpdateInfo struct {
	CurrentVersion string           `json:"currentVersion"`
	LatestVersion  string           `json:"latestVersion"`
	Status         string           `json:"status"` // available, current, ahead
	ReleaseURL     string           `json:"releaseUrl"`
	Notes          string           `json:"notes"`
	PublishedAt    string           `json:"publishedAt"`
	CheckedAt      string           `json:"checkedAt"`
	Downloads      []UpdateDownload `json:"downloads"`
}

type githubRelease struct {
	Tag         string `json:"tag_name"`
	Body        string `json:"body"`
	PublishedAt string `json:"published_at"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
	Assets      []struct {
		Name  string `json:"name"`
		URL   string `json:"browser_download_url"`
		State string `json:"state"`
	} `json:"assets"`
}

type updateState struct {
	mu        sync.Mutex
	release   githubRelease
	checkedAt time.Time
}

// CheckForUpdates is invoked only by the manual About dialog action. It uses
// the public Releases API: no credentials or workspace information are sent.
func (a *App) CheckForUpdates(currentVersion string) (UpdateInfo, error) {
	if _, err := parseReleaseVersion(currentVersion); err != nil {
		return UpdateInfo{}, errors.New("当前版本号无效，无法检查更新")
	}
	if runtime.GOOS == "android" {
		return UpdateInfo{}, errors.New("Android 版本单独发布，请查看 GitHub 发布页")
	}
	a.updates.mu.Lock()
	defer a.updates.mu.Unlock()
	if a.updates.checkedAt.IsZero() || time.Since(a.updates.checkedAt) >= updateCacheDuration {
		ctx := a.ctx
		if ctx == nil {
			ctx = context.Background()
		}
		client := &http.Client{Timeout: 15 * time.Second}
		release, err := fetchLatestRelease(ctx, client, updateEndpoint)
		if err != nil {
			return UpdateInfo{}, err
		}
		a.updates.release = release
		a.updates.checkedAt = time.Now()
	}
	return releaseUpdateInfo(a.updates.release, currentVersion, runtime.GOOS, runtime.GOARCH, a.updates.checkedAt)
}

func fetchLatestRelease(ctx context.Context, client *http.Client, endpoint string) (githubRelease, error) {
	var release githubRelease
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return release, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "OrbitSSH-UpdateChecker")
	response, err := client.Do(req)
	if err != nil {
		return release, errors.New("无法连接 GitHub，请检查网络或代理后重试，也可直接打开发布页")
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return release, errors.New("GitHub 上还没有可用的正式版本")
	case http.StatusForbidden, http.StatusTooManyRequests:
		return release, errors.New("GitHub 暂时限制了更新检查，请稍后重试或直接打开发布页")
	default:
		return release, fmt.Errorf("GitHub 更新检查失败（HTTP %d），请稍后重试", response.StatusCode)
	}
	const maxResponseBytes = 2 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(data) > maxResponseBytes || json.Unmarshal(data, &release) != nil {
		return githubRelease{}, errors.New("GitHub 返回的版本信息无效，请稍后重试")
	}
	if _, err = parseReleaseVersion(release.Tag); err != nil || release.Draft || release.Prerelease {
		return githubRelease{}, errors.New("GitHub 最新发布不是受支持的正式版本，请直接查看发布页")
	}
	return release, nil
}

// Historical tags include v2.0 and v3.2 as well as three-part patch versions.
func parseReleaseVersion(value string) ([3]uint64, error) {
	var version [3]uint64
	parts := strings.Split(strings.TrimPrefix(value, "v"), ".")
	if len(parts) < 2 || len(parts) > 3 {
		return version, errors.New("无效的版本号")
	}
	for i, part := range parts {
		if part == "" {
			return version, errors.New("无效的版本号")
		}
		for _, digit := range part {
			if digit < '0' || digit > '9' {
				return version, errors.New("无效的版本号")
			}
		}
		n, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return version, err
		}
		version[i] = n
	}
	return version, nil
}

func releaseUpdateInfo(release githubRelease, current, platform, arch string, checkedAt time.Time) (UpdateInfo, error) {
	installed, err := parseReleaseVersion(current)
	if err != nil {
		return UpdateInfo{}, err
	}
	latest, err := parseReleaseVersion(release.Tag)
	if err != nil {
		return UpdateInfo{}, err
	}
	result := UpdateInfo{
		CurrentVersion: current, LatestVersion: strings.TrimPrefix(release.Tag, "v"),
		Status: "current", ReleaseURL: updateRepository + "/releases/tag/" + url.PathEscape(release.Tag),
		Notes: release.Body, PublishedAt: release.PublishedAt,
		CheckedAt: checkedAt.UTC().Format(time.RFC3339), Downloads: []UpdateDownload{},
	}
	for i := range installed {
		if latest[i] > installed[i] {
			result.Status = "available"
			break
		}
		if latest[i] < installed[i] {
			result.Status = "ahead"
			break
		}
	}
	assetArch := arch
	if arch == "amd64" {
		assetArch = "x64"
	}
	type downloadFormat struct{ suffix, label string }
	var formats []downloadFormat
	switch platform {
	case "windows":
		formats = []downloadFormat{{"windows-" + assetArch + "-setup.exe", "Windows 安装版"}, {"windows-" + assetArch + "-portable.zip", "Windows 便携版"}}
	case "darwin":
		formats = []downloadFormat{{"macos-" + assetArch + ".dmg", "macOS DMG"}, {"macos-" + assetArch + ".zip", "macOS ZIP"}}
	case "linux":
		formats = []downloadFormat{{"linux-" + assetArch + ".tar.gz", "Linux 压缩包"}}
	}
	for _, format := range formats {
		name := "OrbitSSH-" + release.Tag + "-" + format.suffix
		expectedURL := updateRepository + "/releases/download/" + url.PathEscape(release.Tag) + "/" + url.PathEscape(name)
		for _, asset := range release.Assets {
			if asset.Name == name && asset.State == "uploaded" && asset.URL == expectedURL {
				result.Downloads = append(result.Downloads, UpdateDownload{Name: name, Label: format.label, URL: expectedURL})
				break
			}
		}
	}
	return result, nil
}
