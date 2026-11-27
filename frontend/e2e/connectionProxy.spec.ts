import { expect, test } from "@playwright/test";
import { defaultShortcuts } from "../src/shortcuts";

test("connection proxy is saved and cannot be combined with a jump host", async ({
  page,
}) => {
  await page.addInitScript(
    ({ shortcuts }) => {
      const hosts = [
        {
          id: "jump",
          name: "Jump",
          address: "jump.example",
          port: 22,
          username: "root",
          group: "默认分组",
          authType: "password",
          keyPath: "",
          color: "mint",
          favorite: false,
          lastConnected: "",
        },
      ];
      const api = {
        LoadState: async () => ({
          hosts,
          knownHosts: {},
          preferences: {
            theme: "light",
            hostLayout: "grid",
            fontSize: 14,
            lineHeight: 1.35,
            confirmClose: false,
            closeToTray: true,
            terminalHistoryEnabled: true,
            terminalHistoryLimit: 20,
            keepAliveSeconds: 30,
            mcpEnabled: false,
            mcpPort: 8765,
            shortcuts,
          },
        }),
        GetPlatform: async () => "windows",
        SaveHost: async (host: unknown) => {
          (window as any).__savedHost = host;
        },
      };
      Object.assign(window, {
        go: {
          app: {
            App: new Proxy(api, {
              get: (target, key) =>
                target[key as keyof typeof target] ?? (async () => {}),
            }),
          },
        },
        runtime: { EventsOnMultiple: () => () => {} },
      });
    },
    { shortcuts: defaultShortcuts },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "新建连接" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("主机名称").fill("Proxy test");
  await dialog.getByLabel("主机地址").fill("example.test");
  await dialog
    .getByRole("combobox", { name: "跳板机（ProxyJump，可选）" })
    .click();
  await page.getByRole("option", { name: /Jump（root@jump.example）/ }).click();
  await expect(
    dialog.getByRole("combobox", { name: "连接代理" }),
  ).toBeDisabled();
  await dialog
    .getByRole("combobox", { name: "跳板机（ProxyJump，可选）" })
    .click();
  await page.getByRole("option", { name: "直连目标主机" }).click();
  await dialog.getByRole("combobox", { name: "连接代理" }).click();
  await page.getByRole("option", { name: "SOCKS5" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "跳板机（ProxyJump，可选）" }),
  ).toBeDisabled();
  await expect(dialog.getByLabel("代理地址")).toHaveValue("127.0.0.1");
  await dialog.getByLabel("代理端口").fill("7891");
  await dialog.getByRole("button", { name: /保存/ }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__savedHost))
    .toMatchObject({
      proxyType: "socks5",
      proxyAddress: "127.0.0.1",
      proxyPort: 7891,
    });
});
