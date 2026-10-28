package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestReleaseVersionComparison(t *testing.T) {
	for _, tc := range []struct{ current, latest, status string }{
		{"3.3.8", "v3.3.9", "available"},
		{"3.9.9", "v3.10.0", "available"},
		{"3.3.9", "v3.3.10", "available"},
		{"3.3.8", "v3.3.8", "current"},
		{"3.2.0", "v3.2", "current"},
		{"3.4.0", "v3.3.8", "ahead"},
		{"4.0.0", "v3.99.99", "ahead"},
	} {
		t.Run(tc.current+"/"+tc.latest, func(t *testing.T) {
			info, err := releaseUpdateInfo(githubRelease{Tag: tc.latest}, tc.current, "windows", "amd64", time.Now())
			if err != nil || info.Status != tc.status {
				t.Fatalf("comparison: %+v %v", info, err)
			}
		})
	}
	for _, value := range []string{"", "3", "3.3.8.0", "3..8", "v3.4.0-beta.1", "v3.4.0+dev", "ci-123", "3.3.-1", "3.3.+1", "3.3.8/other", "3.3.18446744073709551616"} {
		if _, err := parseReleaseVersion(value); err == nil {
			t.Errorf("accepted unsupported version %q", value)
		}
	}
}

func testUpdateRelease(t *testing.T) githubRelease {
	t.Helper()
	var assets []map[string]string
	for _, suffix := range []string{"windows-x64-setup.exe", "windows-x64-portable.zip", "macos-arm64.dmg", "macos-arm64.zip", "macos-x64.dmg", "linux-x64.tar.gz"} {
		name := "OrbitSSH-v3.3.9-" + suffix
		assets = append(assets, map[string]string{"name": name, "browser_download_url": updateRepository + "/releases/download/v3.3.9/" + name, "state": "uploaded"})
	}
	data, err := json.Marshal(map[string]interface{}{
		"tag_name": "v3.3.9", "body": "## 更新说明\n修复连接问题", "published_at": "2026-10-28T08:00:00Z", "assets": assets,
	})
	if err != nil {
		t.Fatal(err)
	}
	var release githubRelease
	if err = json.Unmarshal(data, &release); err != nil {
		t.Fatal(err)
	}
	return release
}

func TestReleaseDownloadSelection(t *testing.T) {
	release := testUpdateRelease(t)
	checked := time.Date(2026, 10, 28, 9, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		platform, arch string
		names          []string
	}{
		{"windows", "amd64", []string{"OrbitSSH-v3.3.9-windows-x64-setup.exe", "OrbitSSH-v3.3.9-windows-x64-portable.zip"}},
		{"darwin", "arm64", []string{"OrbitSSH-v3.3.9-macos-arm64.dmg", "OrbitSSH-v3.3.9-macos-arm64.zip"}},
		{"darwin", "amd64", []string{"OrbitSSH-v3.3.9-macos-x64.dmg"}},
		{"linux", "amd64", []string{"OrbitSSH-v3.3.9-linux-x64.tar.gz"}},
		{"windows", "arm64", []string{}},
		{"android", "arm64", []string{}},
	} {
		t.Run(tc.platform+"/"+tc.arch, func(t *testing.T) {
			info, err := releaseUpdateInfo(release, "3.3.8", tc.platform, tc.arch, checked)
			if err != nil {
				t.Fatal(err)
			}
			names := []string{}
			for _, download := range info.Downloads {
				names = append(names, download.Name)
			}
			if !reflect.DeepEqual(names, tc.names) {
				t.Fatalf("downloads: %v; want %v", names, tc.names)
			}
			if info.Notes != release.Body || info.PublishedAt != release.PublishedAt || info.CheckedAt != "2026-10-28T09:00:00Z" || info.ReleaseURL != updateRepository+"/releases/tag/v3.3.9" {
				t.Fatalf("lost release metadata: %+v", info)
			}
		})
	}
	// A lookalike host or an unfinished upload must never become a download link.
	release.Assets[0].URL = "https://github.com.example.test/installer.exe"
	release.Assets[1].State = "new"
	info, err := releaseUpdateInfo(release, "3.3.8", "windows", "amd64", checked)
	if err != nil || len(info.Downloads) != 0 {
		t.Fatalf("accepted invalid download: %+v %v", info, err)
	}
}

func TestFetchLatestRelease(t *testing.T) {
	release := testUpdateRelease(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "" || r.Header.Get("User-Agent") != "OrbitSSH-UpdateChecker" || r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
			t.Errorf("unexpected request: %s %s %v", r.Method, r.URL, r.Header)
		}
		_ = json.NewEncoder(w).Encode(release)
	}))
	defer server.Close()
	got, err := fetchLatestRelease(context.Background(), server.Client(), server.URL)
	if err != nil || !reflect.DeepEqual(got, release) {
		t.Fatalf("fetch: %+v %v", got, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fetchLatestRelease(ctx, server.Client(), server.URL); err == nil {
		t.Fatal("cancelled request succeeded")
	}
}

func TestFetchLatestReleaseFailures(t *testing.T) {
	for _, tc := range []struct {
		name, body, message string
		status              int
	}{
		{"not-found", `{}`, "还没有", 404},
		{"forbidden", `{}`, "暂时限制", 403},
		{"rate-limit", `{}`, "暂时限制", 429},
		{"server-error", `{}`, "HTTP 503", 503},
		{"invalid-json", `<html>proxy</html>`, "信息无效", 200},
		{"too-large", strings.Repeat(" ", 2*1024*1024+1), "信息无效", 200},
		{"missing-version", `{}`, "正式版本", 200},
		{"prerelease", `{"tag_name":"v3.4.0","prerelease":true}`, "正式版本", 200},
		{"draft", `{"tag_name":"v3.4.0","draft":true}`, "正式版本", 200},
		{"ci-tag", `{"tag_name":"ci-test"}`, "正式版本", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			_, err := fetchLatestRelease(context.Background(), server.Client(), server.URL)
			if err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("expected %q, got %v", tc.message, err)
			}
		})
	}
}

func TestCheckForUpdatesUsesCachedRelease(t *testing.T) {
	a := NewApp()
	a.updates.release = testUpdateRelease(t)
	a.updates.checkedAt = time.Now()
	// A cancelled context ensures the check cannot succeed by making an HTTP request.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	a.ctx = ctx
	for current, status := range map[string]string{"3.3.8": "available", "3.3.9": "current", "3.4.0": "ahead"} {
		info, err := a.CheckForUpdates(current)
		if err != nil || info.Status != status {
			t.Fatalf("cached check: %+v %v", info, err)
		}
	}
	a.updates.checkedAt = time.Now().Add(-updateCacheDuration - time.Second)
	if _, err := a.CheckForUpdates("3.3.8"); err == nil {
		t.Fatal("expired cache reported a fresh check without a successful request")
	}
}
