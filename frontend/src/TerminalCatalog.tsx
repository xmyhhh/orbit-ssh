import type { ReactNode } from "react";
import {
  ArrowUpRight,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import LayoutSwitch from "./LayoutSwitch";
import type { Preferences } from "./types";

export interface TerminalCatalogLayoutProps {
  layout: Preferences["hostLayout"];
  onLayoutChange: (layout: Preferences["hostLayout"]) => void;
}

export function TerminalCatalog({
  title,
  description,
  layout,
  onLayoutChange,
  loading,
  error,
  onRefresh,
  count,
  loadingMessage,
  errorTitle,
  emptyTitle,
  emptyMessage,
  children,
}: TerminalCatalogLayoutProps & {
  title: string;
  description: string;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  count?: number;
  loadingMessage: string;
  errorTitle: string;
  emptyTitle: string;
  emptyMessage: string;
  children: ReactNode;
}) {
  return (
    <section className="hosts-section local-shell-page" aria-busy={loading}>
      <div className="section-heading hosts-heading">
        <div>
          <h1>{title}</h1>
          {!loading && !error && count !== undefined && (
            <span className="subtle-count">{count}</span>
          )}
        </div>
        <button
          className="button secondary"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={15} aria-hidden="true" />
          刷新
        </button>
      </div>
      <div className="host-filters local-shell-controls">
        <p>{description}</p>
        <LayoutSwitch
          layout={layout}
          onChange={onLayoutChange}
          label={`${title} 布局`}
        />
      </div>
      {loading ? (
        <div className="search-empty local-shell-state" role="status">
          <LoaderCircle className="spin" size={24} aria-hidden="true" />
          <p>{loadingMessage}</p>
        </div>
      ) : error ? (
        <div className="search-empty local-shell-state" role="alert">
          <TerminalSquare size={28} aria-hidden="true" />
          <h3>{errorTitle}</h3>
          <p>{error}</p>
          <button className="text-button" onClick={onRefresh}>
            重试
          </button>
        </div>
      ) : count ? (
        <div className={`host-cards local-shell-cards ${layout}`}>
          {children}
        </div>
      ) : (
        <div className="search-empty local-shell-state">
          <TerminalSquare size={28} aria-hidden="true" />
          <h3>{emptyTitle}</h3>
          <p>{emptyMessage}</p>
        </div>
      )}
    </section>
  );
}

export function TerminalCatalogCard({
  name,
  description,
  address,
  color,
  activeCount,
  running,
  status,
  onOpen,
}: {
  name: string;
  description: string;
  address: string;
  color: string;
  activeCount: number;
  running: boolean;
  status: string;
  onOpen: () => void;
}) {
  return (
    <button
      className="host-card local-shell-card"
      aria-label={`打开 ${name}`}
      title={`打开 ${name}`}
      onClick={(event) => event.detail < 2 && onOpen()}
    >
      <span className="host-card-top">
        <span className={`host-icon ${color}`}>
          <TerminalSquare size={22} strokeWidth={1.6} />
        </span>
        <span className="host-card-title">
          <strong className="local-shell-name">{name}</strong>
          <span>{description}</span>
        </span>
      </span>
      <code className="host-card-address" title={address}>
        {address}
      </code>
      <span className="host-card-bottom">
        <span>
          <span
            className={`status-dot ${running ? "" : "offline"}`}
            aria-hidden="true"
          />
          {activeCount ? `${activeCount} 个活动会话` : status}
        </span>
        <span className="local-shell-action">
          {activeCount ? "新建终端" : "打开终端"}
          <ArrowUpRight size={14} aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}
