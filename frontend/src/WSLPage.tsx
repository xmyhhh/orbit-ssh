import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { backend, errorText } from "./bridge";
import LayoutSwitch from "./LayoutSwitch";
import type { Preferences, Session, WSLInfo } from "./types";

export default function WSLPage({
  layout,
  onLayoutChange,
  onOpen,
  sessions,
}: {
  layout: Preferences["hostLayout"];
  onLayoutChange: (layout: Preferences["hostLayout"]) => void;
  onOpen: (distribution: string) => void;
  sessions: Session[];
}) {
  const [info, setInfo] = useState<WSLInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void backend()
      .GetWSLInfo()
      .then((value) => {
        if (current) setInfo(value);
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [refresh]);

  return (
    <section className="hosts-section local-shell-page" aria-busy={loading}>
      <div className="section-heading hosts-heading">
        <div>
          <h1>WSL</h1>
          {!loading && !error && info && (
            <span className="subtle-count">{info.distributions.length}</span>
          )}
        </div>
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} aria-hidden="true" />
          刷新
        </button>
      </div>
      <div className="host-filters local-shell-controls">
        <p>选择已安装的 Linux 发行版，直接打开本地终端。</p>
        <LayoutSwitch
          layout={layout}
          onChange={onLayoutChange}
          label="WSL 布局"
        />
      </div>
      {loading ? (
        <div className="search-empty local-shell-state" role="status">
          <LoaderCircle className="spin" size={24} aria-hidden="true" />
          <p>正在检测 WSL 发行版…</p>
        </div>
      ) : error ? (
        <div className="search-empty local-shell-state" role="alert">
          <TerminalSquare size={28} aria-hidden="true" />
          <h3>无法读取 WSL 发行版</h3>
          <p>{error}</p>
          <button
            className="text-button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            重试
          </button>
        </div>
      ) : info?.distributions.length ? (
        <div className={`host-cards local-shell-cards ${layout}`}>
          {info.distributions.map((distribution) => {
            const activeCount = sessions.filter(
              (session) =>
                session.wslDistribution === distribution.name &&
                session.status !== "closed",
            ).length;
            const running = distribution.running || activeCount > 0;
            return (
              <button
                className="host-card local-shell-card"
                key={distribution.name}
                aria-label={`打开 ${distribution.name}`}
                title={`打开 ${distribution.name}`}
                onClick={(e) => e.detail < 2 && onOpen(distribution.name)}
              >
                <span className="host-card-top">
                  <span className={`host-icon ${running ? "mint" : "blue"}`}>
                    <TerminalSquare size={22} strokeWidth={1.6} />
                  </span>
                  <span className="host-card-title">
                    <strong className="local-shell-name">
                      {distribution.name}
                    </strong>
                    <span>Linux 发行版</span>
                  </span>
                </span>
                <code className="host-card-address">
                  WSL · {distribution.name}
                </code>
                <span className="host-card-bottom">
                  <span>
                    <span
                      className={`status-dot ${running ? "" : "offline"}`}
                      aria-hidden="true"
                    />
                    {activeCount
                      ? `${activeCount} 个活动会话`
                      : distribution.running
                        ? "运行中"
                        : "未运行"}
                  </span>
                  <span className="local-shell-action">
                    {activeCount ? "新建终端" : "打开终端"}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="search-empty local-shell-state">
          <TerminalSquare size={28} aria-hidden="true" />
          <h3>{info?.installed ? "没有可用的发行版" : "尚未安装 WSL"}</h3>
          <p>
            {info?.message ||
              "在 PowerShell 中运行 wsl --install，安装后点击刷新。"}
          </p>
        </div>
      )}
    </section>
  );
}
