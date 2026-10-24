import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Exercise the actual TSX without adding a DOM/test-runner dependency. The hook
// adapter retains component state and lets tests drive the sampling timers.
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/MonitorPanel.tsx", import.meta.url), "utf8"),
  {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function sample(overrides = {}) {
  return {
    sampledAt: 1700000000000,
    hostname: "healthy-host",
    system: "Linux healthy",
    uptime: 86400,
    load: [0.5, 0.3, 0.1],
    cores: 4,
    cpuPercent: 12.5,
    memoryTotal: 1024,
    memoryUsed: 512,
    memoryAvailable: 512,
    swapTotal: 0,
    swapUsed: 0,
    disks: [
      {
        filesystem: "/dev/vda",
        mount: "/",
        total: 1024,
        used: 512,
        available: 512,
        usedPercent: 50,
      },
    ],
    networks: [],
    diskIo: [],
    thermals: [],
    processes: [
      {
        pid: 42,
        user: "tester",
        state: "R",
        cpu: 1,
        memoryPercent: 1,
        memory: 100,
        elapsed: 10,
        command: "/bin/worker",
      },
    ],
    processTotal: 1,
    warnings: [],
    issues: {},
    ...overrides,
  };
}
function harness(responses) {
  const state = [],
    effects = [],
    timers = [];
  let cursor = 0,
    mounted = false;
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [
        state[index],
        (value) => {
          state[index] =
            typeof value === "function" ? value(state[index]) : value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return state[index] ?? (state[index] = { current: initial });
    },
    useMemo: (fn) => fn(),
    useEffect: (effect) => {
      if (!mounted) effects.push(effect);
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "react") return hooks;
      if (name === "./bridge")
        return {
          backend: () => ({
            Monitor: async () => {
              const response = responses.shift();
              if (response instanceof Error) throw response;
              assert.ok(response, "unexpected sampling request");
              return response;
            },
          }),
          errorText: (error) => error.message,
        };
      if (name === "./ui/Select") return { Select: () => null };
      return require(name);
    },
    document: {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
    },
    setTimeout: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeout() {},
  });
  function render() {
    cursor = 0;
    return exports.default({
      session: { id: "test", status: "connected", demo: false },
      expanded: false,
      onExpand() {},
      onClose() {},
    });
  }
  const initial = render();
  mounted = true;
  for (const effect of effects) effect();
  return {
    initial: renderToStaticMarkup(initial),
    render,
    html: () => renderToStaticMarkup(render()),
    async tick() {
      assert.ok(timers.length, "sampling timer is scheduled");
      timers.shift()();
      await new Promise(setImmediate);
    },
    click(text) {
      function visit(node) {
        if (!React.isValidElement(node)) return false;
        if (
          node.type === "button" &&
          renderToStaticMarkup(node).includes(text)
        ) {
          node.props.onClick();
          return true;
        }
        return React.Children.toArray(node.props.children).some(visit);
      }
      assert.ok(visit(render()), `button ${text} exists`);
    },
  };
}

function section(html, heading) {
  return [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)]
    .map((match) => match[1])
    .find((content) => content.includes(heading));
}

test("successful metrics and normal CPU warm-up remain available; no sensors is not a warning", async () => {
  const panel = harness([sample({ cpuPercent: null })]);
  await panel.tick();
  const html = panel.html();
  assert.match(section(html, "CPU"), /采样中[\s\S]*等待下一次采样/);
  assert.match(section(html, "内存"), /50\.0/);
  assert.match(html, /healthy-host/);
  assert.doesNotMatch(html, /部分指标不可用|未获取|温度|NaN|Infinity/);
});

test("CPU failure is unavailable, not warm-up, while memory and disks still render", async () => {
  const panel = harness([
    sample({
      cores: 0,
      cpuPercent: null,
      issues: { CPU: "权限不足：请检查 /proc/stat" },
    }),
  ]);
  await panel.tick();
  const html = panel.html(),
    cpu = section(html, "CPU");
  assert.match(html, /部分指标不可用/);
  assert.match(cpu, /未获取：权限不足：请检查 \/proc\/stat/);
  assert.doesNotMatch(cpu, /0 核|采样中|等待下一次采样/);
  assert.match(section(html, "内存"), /50\.0/);
  assert.match(section(html, "磁盘"), /50%/);
});

test("zero cores and zero total memory fail safely even with legacy missing issues", async () => {
  const panel = harness([
    sample({
      issues: undefined,
      cores: 0,
      cpuPercent: null,
      memoryTotal: 0,
      memoryUsed: 0,
      memoryAvailable: 0,
    }),
  ]);
  await panel.tick();
  const html = panel.html();
  assert.match(section(html, "CPU"), /未获取/);
  assert.match(section(html, "内存"), /未获取/);
  assert.doesNotMatch(html, /NaN|Infinity|0 B|0\.0<small>%/);
  assert.match(
    html,
    /交换空间<\/dt><dd><span class="monitor-unavailable">未获取/,
  );
  assert.match(
    html,
    /可用内存<\/dt><dd><span class="monitor-unavailable">未获取/,
  );
});

test("every failed section has a reason, including empty network, disk I/O and thermal arrays", async () => {
  const keys = [
    "CPU",
    "MEMORY",
    "DISKS",
    "NETWORK",
    "DISKIO",
    "THERMAL",
    "PROCESSES",
    "HOSTNAME",
    "SYSTEM",
    "UPTIME",
    "LOAD",
    "PROCESS_TOTAL",
  ];
  const issues = Object.fromEntries(
    keys.map((key) => [key, `${key}读取失败，请修复权限`]),
  );
  const panel = harness([
    sample({
      issues,
      cores: 0,
      cpuPercent: null,
      memoryTotal: 0,
      memoryUsed: 0,
      disks: [],
      processes: [],
      processTotal: 0,
      uptime: 0,
      load: [],
      hostname: "",
      system: "",
    }),
  ]);
  await panel.tick();
  const html = panel.html();
  for (const key of keys) assert.ok(html.includes(issues[key]), key);
  for (const [label, key] of [
    ["网络", "NETWORK"],
    ["磁盘 I/O", "DISKIO"],
    ["温度", "THERMAL"],
    ["磁盘", "DISKS"],
  ]) {
    assert.ok(section(html, label).includes(`未获取：${issues[key]}`));
  }
  assert.match(html, /进程 <span[^>]*>—<\/span>/);
  assert.match(html, /无法读取进程/);
  assert.doesNotMatch(html, /查看 0 个进程|NaN|Infinity/);
  panel.click("进程 <span");
  const processHtml = panel.html();
  assert.match(processHtml, /无法读取进程：PROCESSES读取失败，请修复权限/);
  assert.doesNotMatch(processHtml, /没有匹配的进程|worker/);
});

test("failed process count does not hide successfully read processes", async () => {
  const panel = harness([
    sample({ processTotal: 0, issues: { PROCESS_TOTAL: "无法统计进程总数" } }),
  ]);
  await panel.tick();
  panel.click("进程 <span");
  const html = panel.html();
  assert.match(html, /worker/);
  assert.match(html, /进程 <span[^>]*>—<\/span>/);
  assert.doesNotMatch(html, /没有匹配的进程|无法读取进程：/);
});

test("warnings precede metrics, keep stderr and suggestions, and escape remote text", async () => {
  const panel = harness([
    sample({
      warnings: ["远端 stderr: <script>alert(1)</script>\n建议安装 procps"],
    }),
  ]);
  await panel.tick();
  const html = panel.html();
  assert.ok(html.indexOf("远端 stderr") < html.indexOf("healthy-host"));
  assert.match(html, /建议安装 procps/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("front warnings deduplicate exact issue reasons while retaining extra timeout warnings", async () => {
  const issues = {
    CPU: "CPU：读取失败，请检查 /proc/stat 权限",
    NETWORK: "网络：读取失败，请检查 /proc/net/dev 权限",
  };
  const timeout = "整体采样超时，已保留采集完成的指标";
  const extra = `${issues.CPU}（额外诊断）`;
  const panel = harness([
    sample({ issues, warnings: [...Object.values(issues), timeout, extra] }),
  ]);
  await panel.tick();
  const html = panel.html();
  const alert = html.match(
    /<div class="monitor-alert" role="status">([\s\S]*?)<\/div>/,
  )?.[1];
  assert.ok(alert, "front warning box exists");
  const entries = [...alert.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(entries, [
    `CPU未获取：${issues.CPU}`,
    `网络未获取：${issues.NETWORK}`,
    timeout,
    extra,
  ]);
  assert.match(section(html, "CPU"), /未获取：CPU：读取失败/);
  assert.match(section(html, "网络"), /未获取：网络：读取失败/);
});

test("a timeout warning alone marks partial status without hiding successful metrics", async () => {
  const timeout = "整体采样超时，已保留采集完成的指标";
  const panel = harness([sample({ warnings: [timeout] })]);
  await panel.tick();
  const html = panel.html();
  assert.match(html, /class="monitor-error-status"[\s\S]*?部分指标不可用/);
  assert.match(html, /<strong>部分指标不可用<\/strong>/);
  assert.equal(html.split(timeout).length - 1, 1);
  assert.match(section(html, "CPU"), /12\.5/);
  assert.match(section(html, "内存"), /50\.0/);
  assert.match(html, /healthy-host/);
  assert.doesNotMatch(html, /自动刷新|未获取/);
});

test("missing memory is a history gap rather than zero; trend lines do not cross gaps", async () => {
  const panel = harness([
    sample(),
    sample({
      sampledAt: 1700000005000,
      memoryTotal: 0,
      memoryUsed: 0,
      issues: { MEMORY: "读取内存失败" },
    }),
    sample({ sampledAt: 1700000010000, memoryUsed: 768 }),
  ]);
  for (let i = 0; i < 3; i++) await panel.tick();
  const html = panel.html(),
    memory = section(html, "内存"),
    cpu = section(html, "CPU");
  const lines = [...memory.matchAll(/<polyline[^>]*points="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(lines, ["0,35", "300,20"]);
  assert.equal((cpu.match(/<polyline/g) ?? []).length, 1);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("total failure retains and timestamps old data and inserts a trend gap before recovery", async () => {
  const first = sample();
  const panel = harness([
    first,
    new Error("SSH 已断开"),
    sample({ sampledAt: first.sampledAt + 10000 }),
  ]);
  await panel.tick();
  await panel.tick();
  const failed = panel.html();
  assert.match(failed, /采样失败/);
  assert.match(failed, /SSH 已断开/);
  assert.match(failed, /保留上次采样数据（[^）]+），非当前数据/);
  assert.match(failed, /上次成功采样/);
  assert.match(failed, /healthy-host/);
  assert.match(section(failed, "内存"), /50\.0/);
  await panel.tick();
  const recovered = panel.html();
  assert.doesNotMatch(recovered, /SSH 已断开|非当前数据|上次成功采样/);
  assert.equal((section(recovered, "CPU").match(/<polyline/g) ?? []).length, 2);
  assert.equal(
    (section(recovered, "内存").match(/<polyline/g) ?? []).length,
    2,
  );
});
