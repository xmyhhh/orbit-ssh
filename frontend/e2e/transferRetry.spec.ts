import { expect, test, type Page } from "@playwright/test";
import { defaultShortcuts } from "../src/shortcuts";

async function prepare(page: Page) {
  await page.addInitScript(
    ({ shortcuts }) => {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const emit = (name: string, ...args: unknown[]) => {
        for (const callback of listeners.get(name) ?? []) callback(...args);
      };
      const host = {
        id: "files-host",
        name: "Transfer Test",
        username: "tester",
        address: "example.test",
        port: 22,
        authType: "password",
        keyPath: "",
        group: "Test",
        color: "mint",
        favorite: false,
        lastConnected: "",
      };
      const jobs = ["failed", "cancelled", "completed", "running"].map(
        (status) => ({
          id: status,
          sessionId: "",
          name: `${status}.txt`,
          direction: "upload",
          destination: "/original-target",
          status,
          current: "",
          totalBytes: 12,
          doneBytes: 0,
          totalFiles: 1,
          completedFiles: 0,
          skipped: 0,
          error: status === "failed" ? "模拟传输失败" : "",
          startedAt: Date.now(),
          finishedAt: status === "running" ? 0 : Date.now(),
        }),
      );
      const mock = {
        sessionID: "",
        calls: [] as string[],
        reject: false,
        release: null as null | (() => void),
        emit,
      };
      const api = {
        LoadState: async () => ({
          hosts: [host],
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
        HasSavedPassword: async () => true,
        ListMCPCommands: async () => [],
        Connect: async (id: string) => {
          mock.sessionID = id;
          for (const job of jobs) job.sessionId = id;
          emit(`ssh:connected:${id}`);
        },
        ListLocalDirectory: async (path: string) => ({
          path: path || "C:\\files",
          parent: "C:\\",
          files: [],
        }),
        ListDirectory: async (_id: string, path: string) => ({
          path: path || "/original-target",
          files: [],
        }),
        ListTransfers: async () => structuredClone(jobs),
        RetryTransfer: async (id: string) => {
          mock.calls.push(id);
          await new Promise<void>((resolve) => {
            mock.release = resolve;
          });
          mock.release = null;
          if (mock.reject) throw new Error("模拟重试失败");
          const original = jobs.find((job) => job.id === id)!;
          const retry = {
            ...original,
            id: `retry-${mock.calls.length}`,
            status: "queued",
            error: "",
            startedAt: 0,
            finishedAt: 0,
          };
          jobs.push(retry);
          emit(`sftp:transfer:${mock.sessionID}`, retry);
          return retry.id;
        },
      };
      Object.assign(window, {
        __transferMock: mock,
        go: {
          app: {
            App: new Proxy(api, {
              get: (target, key) =>
                target[key as keyof typeof target] ?? (async () => {}),
            }),
          },
        },
        runtime: {
          EventsOnMultiple: (
            name: string,
            callback: (...args: unknown[]) => void,
          ) => {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name)!.add(callback);
            return () => listeners.get(name)?.delete(callback);
          },
        },
      });
    },
    { shortcuts: defaultShortcuts },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Transfer Test", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect(page.locator(".transfer-job")).toHaveCount(4);
}

test("retry keeps the original target and history, and blocks duplicate clicks while pending", async ({
  page,
}) => {
  await prepare(page);
  const retry = page.getByRole("button", {
    name: "重试传输 failed.txt",
    exact: true,
  });
  await expect(page.getByRole("button", { name: /^重试传输 / })).toHaveCount(2);
  const path = page.getByRole("textbox", { name: "远程路径", exact: true });
  await path.fill("/another-directory");
  await path.press("Enter");
  await expect(path).toBeEnabled();
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "重试传输 cancelled.txt", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => (window as any).__transferMock.calls))
    .toEqual(["failed"]);
  await page.evaluate(() => (window as any).__transferMock.release());
  await expect(page.locator(".transfer-job")).toHaveCount(5);
  await expect(page.locator(".transfer-job.queued")).toContainText(
    "/original-target",
  );
  await expect(page.locator(".transfer-job.failed")).toContainText(
    "模拟传输失败",
  );
  await expect(retry).toBeEnabled();
  await page
    .getByRole("button", { name: "重试传输 cancelled.txt", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__transferMock.calls))
    .toEqual(["failed", "cancelled"]);
  await page.evaluate(() => (window as any).__transferMock.release());
  await expect(page.locator(".transfer-job")).toHaveCount(6);
});

test("retry reports errors, remains retryable, and is disabled until reconnection", async ({
  page,
}) => {
  await prepare(page);
  const retry = page.getByRole("button", {
    name: "重试传输 failed.txt",
    exact: true,
  });
  await page.evaluate(() => {
    (window as any).__transferMock.reject = true;
  });
  await retry.click();
  await expect(retry).toBeDisabled();
  await page.evaluate(() => (window as any).__transferMock.release());
  await expect(page.getByText("模拟重试失败", { exact: true })).toBeVisible();
  await expect(retry).toBeEnabled();
  await expect(page.locator(".transfer-job")).toHaveCount(4);
  await page.evaluate(() => {
    const mock = (window as any).__transferMock;
    mock.emit(`ssh:closed:${mock.sessionID}`, "模拟断线");
  });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAttribute("title", "连接后可重试传输");
  await page.getByRole("button", { name: "返回终端", exact: true }).click();
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect(retry).toBeEnabled();
});
