import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { approvalDeadline, isApprovalExpired, isApprovalGone } from "../src/mcpApproval.ts";

const styles = readFileSync(new URL("../src/styles/dialogs.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../src/styles/foundation.css", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../src/dialogs/MCPCommandDialog.tsx", import.meta.url), "utf8");

function luminance(hex) {
  const rgb = hex.match(/[a-f0-9]{2}/gi).map((value) => parseInt(value, 16) / 255);
  return rgb
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
}

test("MCP approval preview uses readable theme-paired colors", () => {
  const commandRule = styles.match(/\.mcp-command-text\s*\{([^}]+)\}/)[1];
  assert.match(commandRule, /background:\s*var\(--terminal-bg\)/);
  assert.match(commandRule, /color:\s*var\(--text\)/);
  assert.match(commandRule, /overflow:\s*auto/);
  assert.match(commandRule, /max-height:/);
  const themes = tokens.match(/:root(?:\[data-theme="dark"\])?\s*\{[^}]+\}/g);
  for (const theme of themes) {
    const background = theme.match(/--terminal-bg:\s*(#[a-f0-9]+)/i)[1];
    const foreground = theme.match(/--text:\s*(#[a-f0-9]+)/i)[1];
    const a = luminance(background), b = luminance(foreground);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(contrast >= 7, `command contrast ${contrast.toFixed(2)} is too low`);
  }
});

test("expired and already-decided approvals are dismissed", () => {
  const request = { id: "test", sessionId: "local", command: "echo test", createdAt: 1000 };
  assert.equal(approvalDeadline(request), 121000);
  assert.equal(isApprovalExpired(request, 120999), false);
  assert.equal(isApprovalExpired(request, 121000), true);
  assert.equal(isApprovalExpired({ ...request, expiresAt: 1100 }, 1100), true);
  assert.equal(isApprovalGone("命令请求不存在或已处理"), true);
  assert.equal(isApprovalGone("命令请求已超时"), true);
  assert.equal(isApprovalGone("暂时无法连接后端"), false);
  assert.match(dialog, /clearInterval\(interval\)/);
  assert.match(dialog, /window\.setTimeout/);
  assert.match(dialog, /ListMCPCommands/);
});

test("MCP approval keeps only the target, command, and actions", () => {
  assert.match(dialog, /控制台/);
  assert.match(dialog, /<code>\{request.command\}<\/code>/);
  assert.doesNotMatch(dialog, /此命令由 MCP|请仔细核对|可能破坏系统的操作/);
  assert.match(dialog, /aria-label="允许执行命令"/);
  assert.match(dialog, /aria-label="拒绝执行命令"/);
});
