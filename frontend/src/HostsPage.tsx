import { Download, Plus, Search, Server, Upload, X } from "lucide-react";
import type { Host, Preferences, Session } from "./types";
import LayoutSwitch from "./LayoutSwitch";
import HostCard from "./HostCard";

export type HostFilter = "all" | "favorite" | "recent";

export default function HostsPage({
  hosts,
  sessions,
  title,
  group,
  query,
  filter,
  layout,
  onFilterChange,
  onQueryChange,
  onLayoutChange,
  onNew,
  onConnect,
  onEdit,
  onDelete,
  onFavorite,
  onShowAll,
  onImportSSHConfig,
  onExport,
  onImport,
  onNotify,
}: {
  hosts: Host[];
  sessions: Session[];
  title: string;
  group: string;
  query: string;
  filter: HostFilter;
  layout: Preferences["hostLayout"];
  onFilterChange: (value: HostFilter) => void;
  onQueryChange: (value: string) => void;
  onLayoutChange: (value: Preferences["hostLayout"]) => void;
  onNew: () => void;
  onConnect: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDelete: (host: Host) => void;
  onFavorite: (host: Host) => void;
  onShowAll: () => void;
  onImportSSHConfig: () => void;
  onExport: () => void;
  onImport: () => void;
  onNotify?: (message: string) => void;
}) {
  let filtered = hosts.filter(
    (h) =>
      (!group || h.group === group) &&
      `${h.name} ${h.address} ${h.username} ${h.group}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  if (filter === "favorite") filtered = filtered.filter((h) => h.favorite);
  if (filter === "recent")
    filtered = filtered
      .filter((h) => h.lastConnected)
      .sort((a, b) => b.lastConnected.localeCompare(a.lastConnected));
  return (
    <div className="workspace-columns">
      <div className="hosts-section">
        <div className="section-heading hosts-heading">
          <div>
            <h1>{title}</h1>
            <span className="subtle-count">{hosts.length}</span>
          </div>
          <div className="hosts-heading-actions">
            <button
              className="button secondary compact"
              onClick={onImportSSHConfig}
              title="读取 ~/.ssh/config 并导入主机"
            >
              <Download size={15} />
              导入 SSH 配置
            </button>
            <button
              className="button secondary compact"
              onClick={onExport}
              title="导出主机配置为 JSON（不含密码和密钥）"
            >
              <Upload size={15} />
              导出
            </button>
            <button
              className="button secondary compact"
              onClick={onImport}
              title="从 JSON 文件导入主机"
            >
              <Download size={15} />
              导入
            </button>
            <button className="button primary" onClick={onNew}>
              <Plus size={16} />
              新建连接
            </button>
          </div>
        </div>
        <div className="host-filters">
          <div className="filter-buttons">
            {(
              [
                { value: "all", label: "全部" },
                { value: "favorite", label: "收藏" },
                { value: "recent", label: "最近" },
              ] as const
            ).map((f) => (
              <button
                aria-pressed={filter === f.value}
                className={filter === f.value ? "selected" : ""}
                key={f.value}
                onClick={() => onFilterChange(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="host-controls">
            <LayoutSwitch
              layout={layout}
              onChange={onLayoutChange}
              label="主机布局"
            />
            <label className="host-search">
              <Search size={14} />
              <input
                aria-label="筛选主机"
                placeholder="搜索主机…"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
              />
              {query && (
                <button
                  className="clear-search"
                  aria-label="清空搜索"
                  onClick={() => onQueryChange("")}
                >
                  <X size={12} />
                </button>
              )}
            </label>
          </div>
        </div>
        {hosts.length === 0 ? (
          <div className="hosts-empty">
            <div className="empty-illustration">
              <span />
              <span />
              <div>
                <Server size={31} strokeWidth={1.35} />
                <span className="illustration-plus">
                  <Plus size={14} />
                </span>
              </div>
            </div>
            <h3>暂无主机</h3>
            <button className="button secondary" onClick={onNew}>
              <Plus size={16} />
              添加主机
            </button>
          </div>
        ) : filtered.length ? (
          <div className={`host-cards ${layout}`}>
            {filtered.map((h) => (
              <HostCard
                key={h.id}
                host={h}
                online={sessions.some(
                  (s) => s.host.id === h.id && s.status === "connected",
                )}
                onConnect={() => onConnect(h)}
                onEdit={() => onEdit(h)}
                onDelete={() => onDelete(h)}
                onFavorite={() => onFavorite(h)}
                onNotify={onNotify}
              />
            ))}
          </div>
        ) : (
          <div className="search-empty">
            <Search size={26} />
            <h3>没有匹配的主机</h3>
            <button className="text-button" onClick={onShowAll}>
              显示全部远程主机
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
