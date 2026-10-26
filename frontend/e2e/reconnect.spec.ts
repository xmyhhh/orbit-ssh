import { expect, test, type Page } from "@playwright/test";
import { defaultShortcuts } from "../src/shortcuts";

async function prepare(page: Page) {
  await page.addInitScript(({ shortcuts }) => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (name: string, ...args: unknown[]) => {
      for (const callback of listeners.get(name) ?? []) callback(...args);
    };
    const mock = {
      calls: [] as string[],
      renames: [] as string[][],
      writes: [] as string[][],
      mode: "success",
      pending: null as null | { resolve: () => void; reject: (error: Error) => void },
      emit,
      data(id: string, text: string) {
        emit(`ssh:data:${id}`, btoa(unescape(encodeURIComponent(text))));
      },
    };
    const host = {
      id: "test-host", name: "Reconnect Test", username: "tester",
      address: "example.test", port: 22, authType: "password", keyPath: "",
      group: "Test", color: "mint", favorite: false, lastConnected: "",
    };
    const api = {
      LoadState: async () => ({ hosts: [host], knownHosts: {}, preferences: {
        theme: "light", hostLayout: "grid", fontSize: 14, lineHeight: 1.35,
        confirmClose: false, closeToTray: true, terminalHistoryEnabled: true,
        terminalHistoryLimit: 20, keepAliveSeconds: 30, mcpEnabled: false,
        mcpAllowConnections: false, mcpAllowTerminalInput: false,
        mcpAllowFileAccess: false, mcpPort: 8765, shortcuts,
      } }),
      GetPlatform: async () => "windows",
      HasSavedPassword: async () => true,
      ListMCPCommands: async () => [],
      Connect: async (id: string) => {
        mock.calls.push(id);
        if (mock.mode === "failure") throw new Error("模拟网络不可达");
        if (mock.mode === "trust") throw new Error("HOST_KEY_UNKNOWN|SHA256:abcd1234");
        if (mock.mode === "password") throw new Error("PASSWORD_REQUIRED|请输入登录密码");
        if (mock.mode === "pending") await new Promise<void>((resolve, reject) => {
          mock.pending = { resolve, reject };
        });
        mock.data(id, `\r\nshell-${mock.calls.length}\r\ntester$ `);
      },
      Disconnect: async () => {
        mock.pending?.reject(new Error("连接已取消"));
        mock.pending = null;
      },
      WriteTerminal: async (id: string, text: string) => { mock.writes.push([id, text]); },
      RenameSession: async (id: string, name: string) => { mock.renames.push([id, name]); },
    };
    Object.assign(window, {
      __sshMock: mock,
      go: { app: { App: new Proxy(api, { get: (target, key) => target[key as keyof typeof target] ?? (async () => {}) }) } },
      runtime: { EventsOnMultiple: (name: string, callback: (...args: unknown[]) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(callback);
        return () => listeners.get(name)?.delete(callback);
      }, ClipboardSetText: async (text: string) => { (mock as any).clipboard = text; return true; } },
    });
  }, { shortcuts: defaultShortcuts });
  await page.goto("/");
  await page.getByRole("button", { name: "Reconnect Test", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".terminal-session")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any).__sshMock.calls.length)).toBe(1);
  const id = (await page.locator(".terminal-session").getAttribute("data-session-id"))!;
  await page.evaluate((id) => (window as any).__sshMock.data(id, "\r\nOLD-OUTPUT-KEEP\r\n"), id);
  return id;
}

async function disconnect(page: Page, id: string) {
  await page.evaluate((id) => (window as any).__sshMock.emit(`ssh:closed:${id}`, "模拟连接断开"), id);
  await expect(page.getByRole("button", { name: "重新连接", exact: true })).toBeVisible();
}

async function buffer(page: Page) {
  // The real xterm selection/copy path verifies scrollback, not a mocked text container.
  await page.locator(".terminal-mount").click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制全部", exact: true }).click();
  return page.evaluate(() => (window as any).__sshMock.clipboard ?? "");
}

test("reconnect reuses the terminal, name and scrollback without replaying commands", async ({ page }) => {
  const id = await prepare(page);
  await page.evaluate((id) => (window as any).__sshMock.emit("session:renamed", { sessionId: id, name: "发布验收" }), id);
  await disconnect(page, id);
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__sshMock.calls)).toEqual([id, id]);
  await expect(page.locator(".reconnect-bar")).toHaveCount(0);
  await expect(page.locator(".terminal-session")).toHaveCount(1);
  await expect(page.locator(".terminal-session")).toHaveAttribute("data-session-id", id);
  await expect.poll(() => page.evaluate(() => (window as any).__sshMock.renames)).toEqual([[id, "发布验收"]]);
  const text = await buffer(page);
  expect(text).toContain("OLD-OUTPUT-KEEP");
  expect(text).toContain("shell-2");
  expect(text).toContain("新的 Shell 会话");
  expect(await page.evaluate(() => (window as any).__sshMock.writes)).toEqual([]);
});

test("failed and cancelled reconnects keep the original terminal and allow retry", async ({ page }) => {
  const id = await prepare(page);
  await disconnect(page, id);
  await page.evaluate(() => { (window as any).__sshMock.mode = "failure"; });
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("模拟网络不可达");
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".terminal-session")).toHaveCount(1);
  await page.evaluate(() => { (window as any).__sshMock.mode = "pending"; });
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.locator(".reconnect-bar button")).toBeDisabled();
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".reconnect-bar button")).toBeEnabled();
  await page.evaluate(() => { (window as any).__sshMock.mode = "success"; });
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.locator(".reconnect-bar")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__sshMock.calls)).toEqual([id, id, id, id]);
  expect(await buffer(page)).toContain("OLD-OUTPUT-KEEP");
});

test("reconnect keeps fingerprint and password verification", async ({ page }) => {
  const id = await prepare(page);
  await disconnect(page, id);
  await page.evaluate(() => { (window as any).__sshMock.mode = "trust"; });
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("SHA256:abcd1234");
  await page.evaluate(() => { (window as any).__sshMock.mode = "password"; });
  await page.getByRole("button", { name: "信任并连接" }).click();
  await expect(page.getByRole("alert")).toContainText("请输入登录密码");
  await page.getByRole("textbox", { name: "登录密码" }).fill("replacement-password");
  await page.evaluate(() => { (window as any).__sshMock.mode = "success"; });
  await page.getByRole("dialog").getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".terminal-session")).toHaveCount(1);
  expect(await buffer(page)).toContain("OLD-OUTPUT-KEEP");
});

test("reconnect preserves split geometry and leaves the sibling terminal alone", async ({ page }) => {
  const id = await prepare(page);
  await page.getByRole("button", { name: "新建终端", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".terminal-session")).toHaveCount(2);
  await page.getByRole("button", { name: "终端布局", exact: true }).click();
  await page.getByRole("button", { name: "左右分屏", exact: true }).click();
  const pane = page.locator(`.terminal-session[data-session-id="${id}"]`);
  await expect(pane).toBeVisible();
  const geometry = await pane.getAttribute("style");
  await disconnect(page, id);
  await pane.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.locator(".reconnect-bar")).toHaveCount(0);
  await expect(pane).toHaveAttribute("style", geometry!);
  await expect(page.locator(".split-session:visible")).toHaveCount(2);
  expect(await page.evaluate((id) => (window as any).__sshMock.calls.filter((value: string) => value === id).length, id)).toBe(2);
});

test("reconnect leaves a disconnected full-screen app without erasing normal scrollback", async ({ page }) => {
  const id = await prepare(page);
  await page.evaluate((id) => (window as any).__sshMock.data(id, "\x1b[?1049h\x1b[2Jfull-screen-app"), id);
  // Allow xterm's asynchronous parser to enter the alternate buffer.
  await expect.poll(() => buffer(page)).toContain("full-screen-app");
  await disconnect(page, id);
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.locator(".reconnect-bar")).toHaveCount(0);
  const text = await buffer(page);
  expect(text).toContain("OLD-OUTPUT-KEEP");
  expect(text).toContain("shell-2");
});
