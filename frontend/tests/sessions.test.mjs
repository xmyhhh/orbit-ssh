import assert from "node:assert/strict";
import test from "node:test";
import {
  localSessionHost,
  sessionAfterRemoval,
  sessionAddress,
  sessionDefaultName,
  sessionDetailLabel,
  sessionHeading,
  sessionName,
  sessionTitle,
} from "../src/sessions.ts";

const session = (id, hostId = "server") => ({
  id,
  host: {
    id: hostId,
    name: hostId,
    username: "root",
    address: "example.com",
    port: 22,
  },
  terminalNumber: 1,
  status: "connected",
  demo: false,
});

test("closing a split pane keeps another visible terminal selected across hosts", () => {
  const sessions = [session("a"), session("b"), session("c", "other")];
  assert.equal(
    sessionAfterRemoval(sessions, new Set(["a"]), "a", ["a", "c"]),
    "c",
  );
  assert.equal(
    sessionAfterRemoval(sessions, new Set(["a"]), "b", ["a", "c"]),
    "b",
  );
});

test("closing terminals prefers a sibling, falls back to another host, then returns home", () => {
  const sessions = [session("a"), session("b"), session("c", "other")];
  assert.equal(sessionAfterRemoval(sessions, new Set(["b"]), "b", []), "a");
  assert.equal(
    sessionAfterRemoval(sessions, new Set(["a", "b"]), "b", []),
    "c",
  );
  assert.equal(
    sessionAfterRemoval(sessions, new Set(["a", "b", "c"]), "c", []),
    "home",
  );
  assert.equal(
    sessionAfterRemoval(sessions, new Set(["a"]), "home", []),
    "home",
  );
});

test("local shells and WSL have separate group identities and readable history labels", () => {
  const shell = { id: "pwsh", name: "PowerShell 7", path: "C:\\pwsh.exe" };
  const local = {
    ...session("local"),
    host: localSessionHost({ localShell: shell }),
    localShell: shell,
  };
  const wsl = {
    ...session("wsl"),
    host: localSessionHost({ wslDistribution: "PowerShell 7" }),
    wslDistribution: "PowerShell 7",
  };
  assert.notEqual(local.host.id, wsl.host.id);
  assert.equal(sessionAddress(local), "本地 · PowerShell 7");
  assert.equal(sessionTitle(local), "PowerShell 7");
  assert.equal(sessionTitle(wsl), "WSL · PowerShell 7");
  assert.equal(sessionAddress(session("ssh")), "root@example.com:22");
});

test("custom names replace the generic terminal label while keeping defaults", () => {
  const defaultSession = session("ssh");
  assert.equal(sessionDefaultName(defaultSession), "终端 #1");
  assert.equal(sessionName(defaultSession), "终端 #1");
  assert.equal(sessionHeading(defaultSession), "server");
  assert.equal(sessionDetailLabel(defaultSession), "server · 终端 #1");

  const named = { ...defaultSession, name: "  构建服务器  " };
  assert.equal(sessionName(named), "构建服务器");
  assert.equal(sessionHeading(named), "构建服务器");
  assert.equal(sessionDetailLabel(named), "构建服务器 · server");
});
