import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Cpu,
  HardDrive,
  Maximize2,
  MemoryStick,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Thermometer,
  Wifi,
  X,
} from "lucide-react";
import { backend, errorText } from "./bridge";
import type { Metrics, ProcessMetric, Session } from "./types";

export function bytes(value: number) {
  if (value === 0) return "0 B";
  const unit = Math.min(
    4,
    Math.max(0, Math.floor(Math.log(value) / Math.log(1024))),
  );
  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}
function duration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days
    ? `${days} 天 ${hours} 时`
    : hours
      ? `${hours} 时 ${minutes} 分`
      : `${minutes} 分`;
}
export function rate(value: number) {
  return `${bytes(value)}/s`;
}
function Sparkline({
  values,
  label,
}: {
  values: (number | null)[];
  label: string;
}) {
  const points = values
    .map((v, i) =>
      v === null
        ? null
        : `${(i * 300) / Math.max(1, values.length - 1)},${65 - Math.min(100, Math.max(0, v)) * 0.6}`,
    )
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      className="metric-chart"
      viewBox="0 0 300 70"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path d="M0 5H300 M0 35H300 M0 65H300" className="chart-grid" />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
function demoMetrics(): Metrics {
  const wave = Math.sin(Date.now() / 6000);
  const processes: ProcessMetric[] = [
    {
      pid: 1842,
      user: "www-data",
      state: "S",
      cpu: 12.4,
      memoryPercent: 8.1,
      memory: 695 * 1024 ** 2,
      elapsed: 52544,
      command: "node /opt/app/server.js",
    },
    {
      pid: 906,
      user: "postgres",
      state: "Ss",
      cpu: 3.2,
      memoryPercent: 4.6,
      memory: 395 * 1024 ** 2,
      elapsed: 86610,
      command: "postgres -D /var/lib/postgresql/data",
    },
    {
      pid: 1024,
      user: "root",
      state: "R",
      cpu: 1.7,
      memoryPercent: 0.4,
      memory: 34 * 1024 ** 2,
      elapsed: 502,
      command: "python3 /opt/tasks/worker.py --queue default",
    },
    {
      pid: 1,
      user: "root",
      state: "Ss",
      cpu: 0.1,
      memoryPercent: 0.1,
      memory: 8 * 1024 ** 2,
      elapsed: 864000,
      command: "/sbin/init",
    },
    {
      pid: 722,
      user: "root",
      state: "S",
      cpu: 0,
      memoryPercent: 0.2,
      memory: 16 * 1024 ** 2,
      elapsed: 86400,
      command: "sshd: explorer@pts/0",
    },
  ];
  return {
    sampledAt: Date.now(),
    hostname: "sandbox",
    system: "Linux 6.8.0",
    uptime: 864000,
    load: [0.48, 0.32, 0.21],
    cores: 4,
    cpuPercent: 24 + wave * 8,
    memoryTotal: 8 * 1024 ** 3,
    memoryUsed: (3.2 + wave * 0.15) * 1024 ** 3,
    memoryAvailable: 4.8 * 1024 ** 3,
    swapTotal: 2 * 1024 ** 3,
    swapUsed: 0,
    disks: [
      {
        filesystem: "/dev/vda1",
        mount: "/",
        total: 80 * 1024 ** 3,
        used: 29.6 * 1024 ** 3,
        available: 46.4 * 1024 ** 3,
        usedPercent: 39,
      },
    ],
    networks: [
      {
        interface: "eth0",
        rxBytes: 12.4 * 1024 ** 3,
        txBytes: 3.1 * 1024 ** 3,
        rxRate: (1.8 + wave * 0.6) * 1024 ** 2,
        txRate: (420 + wave * 120) * 1024,
      },
    ],
    diskIo: [
      {
        device: "vda",
        readBytes: 9.2 * 1024 ** 3,
        writeBytes: 4.6 * 1024 ** 3,
        readOps: 184320,
        writeOps: 92160,
        readRate: (2.4 + wave) * 1024 ** 2,
        writeRate: (860 + wave * 300) * 1024,
      },
    ],
    thermals: [{ zone: "thermal_zone0", type: "x86_pkg_temp", celsius: 47 + wave * 4 }],
    processes,
    processTotal: 5,
    warnings: [],
  };
}
const states: Record<string, string> = {
  R: "运行",
  S: "睡眠",
  D: "等待 I/O",
  Z: "僵尸",
  T: "停止",
  t: "调试",
  I: "空闲",
  X: "退出",
};

export default function MonitorPanel({
  session,
  expanded,
  onExpand,
  onClose,
}: {
  session: Session;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
}) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [history, setHistory] = useState<
    { at: number; cpu: number | null; memory: number }[]
  >([]);
  const [tab, setTab] = useState<"overview" | "processes">("overview");
  const [interval, setIntervalSeconds] = useState(5);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"cpu" | "memory" | "pid">("cpu");
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<number | null>(null);
  const [signal, setSignal] = useState("TERM");
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inFlight = useRef<Promise<Metrics> | null>(null);
  const manual = useRef(0);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requested = refresh !== manual.current;
    manual.current = refresh;
    async function sample() {
      if (cancelled) return;
      setLoading(true);
      try {
        if (!inFlight.current) {
          const request = session.demo
            ? Promise.resolve(demoMetrics())
            : backend().Monitor(session.id);
          inFlight.current = request;
          void request
            .finally(() => {
              if (inFlight.current === request) inFlight.current = null;
            })
            .catch(() => {});
        }
        const data = await inFlight.current;
        if (cancelled) return;
        setMetrics(data);
        setError("");
        setHistory((items) =>
          items.at(-1)?.at === data.sampledAt
            ? items
            : [
                ...items,
                {
                  at: data.sampledAt,
                  cpu: data.cpuPercent,
                  memory: (data.memoryUsed / data.memoryTotal) * 100,
                },
              ].slice(-60),
        );
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (!paused) timer = setTimeout(() => void sample(), interval * 1000);
        }
      }
    }
    setLoading(false);
    if (visible && session.status === "connected" && (!paused || requested))
      timer = setTimeout(() => void sample(), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    session.id,
    session.demo,
    session.status,
    paused,
    visible,
    interval,
    refresh,
  ]);
  const processes = useMemo(() => {
    const value = query.trim().toLowerCase();
    return (metrics?.processes ?? [])
      .filter((p) =>
        `${p.pid} ${p.user} ${p.command} ${p.state}`
          .toLowerCase()
          .includes(value),
      )
      .sort((a, b) =>
        sort === "pid" ? a.pid - b.pid : b[sort] - a[sort] || a.pid - b.pid,
      );
  }, [metrics, query, sort]);
  const detail = metrics?.processes.find((p) => p.pid === selected);
  async function sendSignal(process: ProcessMetric) {
    const label = process.command.split(" ")[0].split("/").pop();
    const warning =
      signal === "KILL"
        ? `强制结束进程 ${label}（PID ${process.pid}）？未保存的数据会丢失。`
        : signal === "STOP"
          ? `暂停进程 ${label}（PID ${process.pid}）？`
          : `向进程 ${label}（PID ${process.pid}）发送 SIG${signal}？`;
    if (!window.confirm(warning)) return;
    setActionBusy(true);
    setNotice("");
    try {
      await backend().KillProcess(session.id, process.pid, signal);
      setNotice(`已向 PID ${process.pid} 发送 SIG${signal}`);
      setRefresh((n) => n + 1);
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setActionBusy(false);
    }
  }
  const memoryPercent = metrics
    ? (metrics.memoryUsed / metrics.memoryTotal) * 100
    : 0;
  const status =
    session.status !== "connected"
      ? "已断开"
      : !visible
        ? "窗口隐藏 · 已暂停"
        : paused
          ? "已暂停"
          : error
            ? "采样失败"
            : loading
              ? "采样中"
              : "自动刷新";

  return (
    <aside
      className={`monitor-panel ${expanded ? "expanded" : ""}`}
      aria-label="服务器监控"
    >
      <header className="monitor-heading">
        <div>
          <Activity size={18} />
          <strong>服务器监控</strong>
          {session.demo && <span className="tag neutral">演示数据</span>}
        </div>
        <div>
          <button
            className="icon-button"
            onClick={onExpand}
            title={expanded ? "还原面板" : "展开监控"}
            aria-label={expanded ? "还原面板" : "展开监控"}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭监控"
            title="关闭监控"
          >
            <X size={17} />
          </button>
        </div>
      </header>
      <div className="monitor-controls">
        <span className={error ? "monitor-error-status" : ""}>
          <i
            className={`status-dot ${paused || error || session.status !== "connected" ? "offline" : ""}`}
          />
          {status}
        </span>
        <div>
          <select
            aria-label="监控刷新间隔"
            value={interval}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}
          >
            <option value={3}>3 秒</option>
            <option value={5}>5 秒</option>
            <option value={10}>10 秒</option>
          </select>
          <button
            className="icon-button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "继续监控" : "暂停监控"}
            title={paused ? "继续监控" : "暂停监控"}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button
            className="icon-button"
            disabled={loading || session.status !== "connected"}
            onClick={() => setRefresh((n) => n + 1)}
            aria-label="刷新监控"
            title="刷新监控"
          >
            <RefreshCw size={15} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>
      {error && (
        <div className="monitor-alert" role="alert">
          {error}
          {metrics && <span>保留上次采样数据</span>}
        </div>
      )}
      <div className="monitor-tabs" role="tablist" aria-label="监控视图">
        <button
          role="tab"
          aria-selected={tab === "overview"}
          onClick={() => setTab("overview")}
        >
          概览
        </button>
        <button
          role="tab"
          aria-selected={tab === "processes"}
          onClick={() => setTab("processes")}
        >
          进程 <span>{metrics?.processTotal ?? "—"}</span>
        </button>
      </div>
      {!metrics ? (
        <div className="monitor-empty">
          <Activity size={26} />
          <p>
            {error
              ? "暂时无法读取监控"
              : session.status !== "connected"
                ? "连接后查看监控"
                : "正在读取服务器数据…"}
          </p>
        </div>
      ) : (
        <div className="monitor-body">
          {tab === "overview" ? (
            <>
              <div className="monitor-system">
                <strong>{metrics.hostname}</strong>
                <span>{metrics.system}</span>
              </div>
              <div className="monitor-metrics">
                <section className="monitor-metric">
                  <div>
                    <span>
                      <Cpu size={15} />
                      CPU
                    </span>
                    <small>{metrics.cores} 核</small>
                  </div>
                  <strong>
                    {metrics.cpuPercent === null
                      ? "采样中"
                      : metrics.cpuPercent.toFixed(1)}
                    {metrics.cpuPercent !== null && <small>%</small>}
                  </strong>
                  <Sparkline
                    values={history.map((h) => h.cpu)}
                    label="最近 60 次 CPU 使用率趋势，范围 0–100%"
                  />
                  <footer>
                    <span>
                      {metrics.cpuPercent === null
                        ? "等待下一次采样"
                        : "使用率"}
                    </span>
                    <span>0–100%</span>
                  </footer>
                </section>
                <section className="monitor-metric">
                  <div>
                    <span>
                      <MemoryStick size={15} />
                      内存
                    </span>
                    <small>{bytes(metrics.memoryTotal)}</small>
                  </div>
                  <strong>
                    {memoryPercent.toFixed(1)}
                    <small>%</small>
                  </strong>
                  <Sparkline
                    values={history.map((h) => h.memory)}
                    label="最近 60 次内存使用率趋势，范围 0–100%"
                  />
                  <footer>
                    <span>{bytes(metrics.memoryUsed)} 已用</span>
                    <span>0–100%</span>
                  </footer>
                </section>
              </div>
              <dl className="monitor-facts">
                <div>
                  <dt>运行时间</dt>
                  <dd>{duration(metrics.uptime)}</dd>
                </div>
                <div>
                  <dt title="1 / 5 / 15 分钟系统负载">系统负载</dt>
                  <dd>{metrics.load.map((n) => n.toFixed(2)).join(" / ")}</dd>
                </div>
                <div>
                  <dt>交换空间</dt>
                  <dd>
                    {bytes(metrics.swapUsed)} / {bytes(metrics.swapTotal)}
                  </dd>
                </div>
                <div>
                  <dt>可用内存</dt>
                  <dd>{bytes(metrics.memoryAvailable)}</dd>
                </div>
              </dl>
              <section className="monitor-disks">
                <h3>
                  <HardDrive size={16} />
                  磁盘 <span>{metrics.disks.length}</span>
                </h3>
                {metrics.disks.map((d) => (
                  <div
                    className="monitor-disk"
                    key={`${d.filesystem}:${d.mount}`}
                  >
                    <div>
                      <strong title={d.filesystem}>{d.mount}</strong>
                      <span>{d.usedPercent.toFixed(0)}%</span>
                    </div>
                    <div
                      className={`disk-bar ${d.usedPercent >= 90 ? "high" : ""}`}
                      role="meter"
                      aria-label={`${d.mount} 磁盘用量`}
                      aria-valuenow={d.usedPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <i style={{ width: `${d.usedPercent}%` }} />
                    </div>
                    <small>
                      {bytes(d.used)} / {bytes(d.total)}
                      <span>可用 {bytes(d.available)}</span>
                    </small>
                  </div>
                ))}
              </section>
              {!!metrics.networks?.length && (
                <section className="monitor-disks">
                  <h3>
                    <Wifi size={16} />
                    网络 <span>{metrics.networks.length}</span>
                  </h3>
                  {metrics.networks.map((n) => (
                    <div className="monitor-io" key={n.interface}>
                      <div>
                        <strong title={n.interface}>{n.interface}</strong>
                        <span>
                          累计 ↓{bytes(n.rxBytes)} ↑{bytes(n.txBytes)}
                        </span>
                      </div>
                      <small>
                        <span>下载 {rate(n.rxRate)}</span>
                        <span>上传 {rate(n.txRate)}</span>
                      </small>
                    </div>
                  ))}
                </section>
              )}
              {!!metrics.diskIo?.length && (
                <section className="monitor-disks">
                  <h3>
                    <Activity size={16} />
                    磁盘 I/O <span>{metrics.diskIo.length}</span>
                  </h3>
                  {metrics.diskIo.map((d) => (
                    <div className="monitor-io" key={d.device}>
                      <div>
                        <strong title={d.device}>{d.device}</strong>
                        <span>
                          {d.readOps + d.writeOps} 次操作
                        </span>
                      </div>
                      <small>
                        <span>读取 {rate(d.readRate)}</span>
                        <span>写入 {rate(d.writeRate)}</span>
                      </small>
                    </div>
                  ))}
                </section>
              )}
              {!!metrics.thermals?.length && (
                <section className="monitor-disks">
                  <h3>
                    <Thermometer size={16} />
                    温度 <span>{metrics.thermals.length}</span>
                  </h3>
                  <div className="monitor-thermal-grid">
                    {metrics.thermals.map((t) => (
                      <div
                        className={`monitor-thermal ${t.celsius >= 85 ? "high" : ""}`}
                        key={`${t.zone}:${t.type}`}
                      >
                        <strong>{t.celsius.toFixed(1)}°C</strong>
                        <span title={t.type || t.zone}>
                          {t.type || t.zone}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <button
                className="monitor-process-link"
                onClick={() => setTab("processes")}
              >
                查看 {metrics.processTotal} 个进程 <span>→</span>
              </button>
            </>
          ) : (
            <>
              <div className="process-tools">
                <label>
                  <Search size={14} />
                  <input
                    aria-label="搜索进程"
                    placeholder="进程、PID、用户…"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setLimit(50);
                    }}
                  />
                </label>
                <select
                  aria-label="进程排序"
                  value={sort}
                  onChange={(e) => {
                    setSort(e.target.value as typeof sort);
                    setLimit(50);
                  }}
                >
                  <option value="cpu">CPU ↓</option>
                  <option value="memory">内存 ↓</option>
                  <option value="pid">PID ↑</option>
                </select>
              </div>
              <div className="process-table-wrap">
                <table className="process-table">
                  <thead>
                    <tr>
                      <th>进程 / PID</th>
                      <th>状态</th>
                      <th title="ps 报告的进程生命周期平均 CPU 使用率；多核可超过 100%">
                        CPU %
                      </th>
                      <th>内存</th>
                      <th>用户</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processes.slice(0, limit).map((p) => (
                      <tr
                        key={p.pid}
                        className={selected === p.pid ? "selected" : ""}
                      >
                        <td>
                          <button
                            onClick={() =>
                              setSelected(selected === p.pid ? null : p.pid)
                            }
                            title={p.command}
                          >
                            <strong>
                              {p.command.split(" ")[0].split("/").pop()}
                            </strong>
                            <small>{p.pid}</small>
                          </button>
                        </td>
                        <td>
                          <span
                            className={`process-state state-${p.state[0]}`}
                            title={p.state}
                          >
                            {states[p.state[0]] ?? p.state}
                          </span>
                        </td>
                        <td>{p.cpu.toFixed(1)}</td>
                        <td title={`${p.memoryPercent.toFixed(1)}%`}>
                          {bytes(p.memory)}
                        </td>
                        <td>{p.user}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!processes.length && (
                <p className="process-no-results">没有匹配的进程</p>
              )}
              {processes.length > limit && (
                <button
                  className="monitor-process-link"
                  onClick={() => setLimit((n) => n + 50)}
                >
                  显示更多（{limit} / {processes.length}）
                </button>
              )}
              {detail && (
                <section className="process-detail">
                  <div>
                    <strong>PID {detail.pid}</strong>
                    <button
                      className="icon-button"
                      onClick={() => setSelected(null)}
                      aria-label="关闭进程详情"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <code>{detail.command}</code>
                  <small>
                    运行 {duration(detail.elapsed)} · {detail.user} ·{" "}
                    {detail.state}
                  </small>
                  <div className="process-actions">
                    <select
                      aria-label="发送信号"
                      value={signal}
                      disabled={actionBusy || session.demo}
                      onChange={(e) => setSignal(e.target.value)}
                    >
                      <option value="TERM">SIGTERM · 正常结束</option>
                      <option value="KILL">SIGKILL · 强制结束</option>
                      <option value="HUP">SIGHUP · 重载配置</option>
                      <option value="INT">SIGINT · 中断</option>
                      <option value="QUIT">SIGQUIT · 退出并转储</option>
                      <option value="STOP">SIGSTOP · 暂停</option>
                      <option value="CONT">SIGCONT · 继续</option>
                      <option value="USR1">SIGUSR1</option>
                      <option value="USR2">SIGUSR2</option>
                    </select>
                    <button
                      className={`button compact ${signal === "KILL" ? "danger" : "secondary"}`}
                      disabled={actionBusy || session.demo}
                      onClick={() => void sendSignal(detail)}
                    >
                      发送信号
                    </button>
                  </div>
                  {session.demo && (
                    <small>演示会话不会真正发送信号。</small>
                  )}
                </section>
              )}
              {notice && (
                <p className="monitor-alert" role="status">
                  {notice}
                </p>
              )}
              <p className="monitor-footnote">
                CPU 为 ps 报告的进程生命周期平均值。最多读取 CPU 排名前 500
                个进程，当前显示 {Math.min(limit, processes.length)} 个。
              </p>
            </>
          )}
          {metrics.warnings.map((w) => (
            <p className="monitor-alert" key={w}>
              {w}
            </p>
          ))}
        </div>
      )}
      <footer className="monitor-updated">
        <span>{session.demo ? "演示数据" : "只读采样"}</span>
        <span>
          {metrics
            ? `更新于 ${new Date(metrics.sampledAt).toLocaleTimeString("zh-CN", { hour12: false })}`
            : "尚未采样"}
        </span>
      </footer>
    </aside>
  );
}
