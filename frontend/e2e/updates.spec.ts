import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { defaultShortcuts } from "../src/shortcuts";

const version: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const repository = "https://github.com/xmyhhh/orbit-ssh";

async function prepare(page: Page) {
  await page.addInitScript(
    ({ shortcuts, version, repository }) => {
      const mock = {
        calls: [] as string[],
        urls: [] as string[],
        error: "",
        release: null as null | (() => void),
        result: {
          currentVersion: version,
          latestVersion: "9.0.0",
          status: "available",
          releaseUrl: `${repository}/releases/tag/v9.0.0`,
          notes: "## 改进\n支持检查更新\n<img src=x onerror=alert(1)>",
          publishedAt: "2026-10-28T08:00:00Z",
          checkedAt: "2026-10-28T09:00:00Z",
          downloads: [
            {
              name: "OrbitSSH-v9.0.0-windows-x64-setup.exe",
              label: "Windows 安装版",
              url: `${repository}/releases/download/v9.0.0/OrbitSSH-v9.0.0-windows-x64-setup.exe`,
            },
          ],
        },
      };
      const api = {
        LoadState: async () => ({
          hosts: [],
          knownHosts: {},
          preferences: {
            theme: "light",
            hostLayout: "grid",
            fontSize: 14,
            lineHeight: 1.35,
            confirmClose: false,
            closeToTray: true,
            terminalHistoryEnabled: false,
            terminalHistoryLimit: 20,
            keepAliveSeconds: 30,
            mcpEnabled: false,
            mcpAllowConnections: false,
            mcpAllowTerminalInput: false,
            mcpAllowFileAccess: false,
            mcpPort: 8765,
            shortcuts,
          },
        }),
        GetPlatform: async () => "windows",
        ListMCPCommands: async () => [],
        CheckForUpdates: async (current: string) => {
          mock.calls.push(current);
          await new Promise<void>((resolve) => {
            mock.release = resolve;
          });
          mock.release = null;
          if (mock.error) throw new Error(mock.error);
          return structuredClone(mock.result);
        },
      };
      Object.assign(window, {
        __updateMock: mock,
        go: {
          app: {
            App: new Proxy(api, {
              get: (target, key) =>
                target[key as keyof typeof target] ?? (async () => {}),
            }),
          },
        },
        runtime: {
          EventsOnMultiple: () => () => {},
          BrowserOpenURL: (url: string) => mock.urls.push(url),
        },
      });
    },
    { shortcuts: defaultShortcuts, version, repository },
  );
  await page.goto("/");
  await page
    .getByRole("button", {
      name: `关于 Orbit SSH，版本 ${version}`,
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText(`v${version}`);
}

async function finishCheck(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).__updateMock.release)),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).__updateMock.release());
}

test("updates are checked manually with the full version, display notes and open downloads externally", async ({
  page,
}) => {
  await prepare(page);
  expect(await page.evaluate(() => (window as any).__updateMock.calls)).toEqual(
    [],
  );
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "正在检查…", exact: true }),
  ).toBeDisabled();
  await finishCheck(page);
  expect(await page.evaluate(() => (window as any).__updateMock.calls)).toEqual(
    [version],
  );
  await expect(page.getByRole("status")).toContainText("发现新版本 v9.0.0");
  await expect(page.locator(".about-release-notes pre")).toContainText(
    "支持检查更新",
  );
  await expect(page.locator(".about-release-notes img")).toHaveCount(0);
  const download = page.getByRole("link", {
    name: "Windows 安装版",
    exact: true,
  });
  await download.click();
  await page
    .getByRole("link", { name: "打开 GitHub 发布页", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__updateMock.urls)).toEqual([
    `${repository}/releases/download/v9.0.0/OrbitSSH-v9.0.0-windows-x64-setup.exe`,
    `${repository}/releases/tag/v9.0.0`,
  ]);
  await expect(page.getByRole("dialog")).toBeVisible();
  // Tab order must include both the download and release links inside the modal.
  await download.focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "打开 GitHub 发布页", exact: true }),
  ).toBeFocused();
});

test("failed checks offer the release page and can be retried", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() => {
    (window as any).__updateMock.error = "无法连接 GitHub，请检查网络";
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await finishCheck(page);
  await expect(page.getByRole("alert")).toContainText("无法连接 GitHub");
  await expect(
    page.getByRole("link", { name: "打开 GitHub 发布页", exact: true }),
  ).toHaveAttribute("href", `${repository}/releases`);
  await page.evaluate(() => {
    const mock = (window as any).__updateMock;
    mock.error = "";
    mock.result.downloads = [];
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await finishCheck(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("此版本暂无匹配当前系统与架构的安装包，请在发布页查看。", {
      exact: true,
    }),
  ).toBeVisible();
});

for (const status of ["current", "ahead"]) {
  test(`the ${status} state does not suggest installing an older version`, async ({
    page,
  }) => {
    await prepare(page);
    await page.evaluate(
      ({ status, version }) => {
        const mock = (window as any).__updateMock;
        mock.result.status = status;
        mock.result.latestVersion = status === "current" ? version : "1.0.0";
      },
      { status, version },
    );
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await finishCheck(page);
    await expect(page.getByRole("status")).toContainText(
      status === "current" ? "当前已是最新正式版" : "当前版本高于最新正式版",
    );
    await expect(
      page.getByRole("link", { name: "Windows 安装版", exact: true }),
    ).toHaveCount(0);
  });
}
