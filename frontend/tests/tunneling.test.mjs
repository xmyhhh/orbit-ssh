import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultX11,
  forwardSummary,
  validateTunnelSettings,
} from "../src/tunneling.ts";

const local = {
  id: "local",
  type: "local",
  enabled: true,
  bindAddress: "127.0.0.1",
  bindPort: 8080,
  destinationHost: "::1",
  destinationPort: 3000,
  description: "",
};

test("tunnel validation distinguishes listeners on the local and remote machines", () => {
  assert.equal(validateTunnelSettings([local], defaultX11), "");
  assert.match(
    validateTunnelSettings(
      [local, { ...local, id: "socks", type: "dynamic" }],
      defaultX11,
    ),
    /重复/,
  );
  assert.equal(
    validateTunnelSettings(
      [local, { ...local, id: "remote", type: "remote" }],
      defaultX11,
    ),
    "",
  );
  assert.equal(
    validateTunnelSettings(
      [local, { ...local, id: "disabled", enabled: false }],
      defaultX11,
    ),
    "",
  );
  assert.match(
    validateTunnelSettings([{ ...local, bindPort: 65536 }], defaultX11),
    /监听端口/,
  );
  assert.match(
    validateTunnelSettings(
      [{ ...local, destinationHost: "localhost:3000" }],
      defaultX11,
    ),
    /目标地址/,
  );
  assert.match(
    validateTunnelSettings(
      [{ ...local, destinationHost: "https://example.com" }],
      defaultX11,
    ),
    /目标地址/,
  );
});

test("X11 validation supports old host defaults and common display formats", () => {
  for (const display of ["", ":0", "localhost:0.0", "[::1]:1.2"]) {
    assert.equal(
      validateTunnelSettings([], { ...defaultX11, enabled: true, display }),
      "",
      display,
    );
  }
  for (const display of [
    "localhost",
    "localhost:59536",
    "localhost:0.-1",
    "localhost:0.0.0",
  ]) {
    assert.match(
      validateTunnelSettings([], { ...defaultX11, enabled: true, display }),
      /X DISPLAY/,
      display,
    );
  }
});

test("rule summaries make IPv6 endpoints and SOCKS destinations readable", () => {
  assert.equal(forwardSummary(local), "127.0.0.1:8080 → [::1]:3000");
  assert.equal(
    forwardSummary({ ...local, type: "dynamic" }),
    "127.0.0.1:8080 → SOCKS5 代理",
  );
});
