import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { backend, errorText } from "./bridge";
import LayoutSwitch from "./LayoutSwitch";
import type { LocalShell, LocalShellInfo, Preferences, Session } from "./types";

export default function LocalShellPage({
  layout,
  onLayoutChange,
  onOpen,
  sessions,
}: {
  layout: Preferences["hostLayout"];
  onLayoutChange: (layout: Preferences["hostLayout"]) => void;
  onOpen: (shell: LocalShell) => void;
  sessions: Session[];
}) {
  const [info, setInfo] = useState<LocalShellInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void backend()
      .GetLocalShellInfo()
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
          <h1>本地 Shell</h1>
          {!loading && !error && info && (
            <span className="subtle-count">{info.shells.length}</span>
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
        <p>选择 Shell，在当前电脑的用户目录中打开终端。</p>
        <LayoutSwitch
          layout={layout}
          onChange={onLayoutChange}
          label="本地 Shell 布局"
        />
      </div>
      {loading ? (
        <div className="search-empty local-shell-state" role="status">
          <LoaderCircle className="spin" size={24} aria-hidden="true" />
          <p>正在检测本地 Shell…</p>
        </div>
      ) : error ? (
        <div className="search-empty local-shell-state" role="alert">
          <TerminalSquare size={28} aria-hidden="true" />
          <h3>无法读取本地 Shell</h3>
          <p>{error}</p>
          <button
            className="text-button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            重试
          </button>
        </div>
      ) : info?.shells.length ? (
        <div className={`host-cards local-shell-cards ${layout}`}>
          {info.shells.map((shell) => {
            const activeCount = sessions.filter(
              (session) =>
                session.localShell?.id === shell.id &&
                session.status !== "closed",
            ).length;
            return (
              <button
                className="host-card local-shell-card"
                key={shell.id}
                aria-label={`打开 ${shell.name}`}
                title={`打开 ${shell.name}`}
                onClick={(e) => e.detail < 2 && onOpen(shell)}
              >
                <span className="host-card-top">
                  <span
                    className={`host-icon ${shell.id === "cmd" ? "mint" : shell.id === "pwsh" ? "violet" : "blue"}`}
                  >
                    <TerminalSquare size={22} strokeWidth={1.6} />
                  </span>
                  <span className="host-card-title">
                    <strong className="local-shell-name">{shell.name}</strong>
                    <span>
                      {shell.id === "cmd"
                        ? "Windows 命令提示符"
                        : "PowerShell 终端"}
                    </span>
                  </span>
                </span>
                <code className="host-card-address" title={shell.path}>
                  {shell.path}
                </code>
                <span className="host-card-bottom">
                  <span>
                    <span className="status-dot" aria-hidden="true" />
                    {activeCount ? `${activeCount} 个活动会话` : "可用"}
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
          <h3>没有可用的本地 Shell</h3>
          <p>
            {info?.message || "安装 PowerShell 或 CMD 后，点击刷新重新检测。"}
          </p>
        </div>
      )}
    </section>
  );
}
