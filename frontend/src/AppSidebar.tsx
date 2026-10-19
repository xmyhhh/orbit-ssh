import { useState } from "react";
import {
  ChevronDown,
  CircleHelp,
  FolderClosed,
  History,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Server,
  Settings2,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import type { Host } from "./types";
import type { Page } from "./navigation";
import { appVersion } from "./appInfo";

export default function AppSidebar({
  hosts,
  page,
  group,
  active,
  platform,
  historyCount,
  collapsed,
  onToggleCollapsed,
  navigate,
  onNewHost,
  onPalette,
  onPreferences,
  onHelp,
  onAbout,
}: {
  hosts: Host[];
  page: Page;
  group: string;
  active: string;
  platform: string;
  historyCount: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  navigate: (page: Page, group?: string) => void;
  onNewHost: () => void;
  onPalette: () => void;
  onPreferences: () => void;
  onHelp: () => void;
  onAbout: () => void;
}) {
  const [groupsOpen, setGroupsOpen] = useState(true);
  const groups = [...new Set(hosts.map((host) => host.group || "默认分组"))];
  return (
    <aside className="sidebar">
      <div className="sidebar-brand-row">
        <button
          className="brand"
          onClick={() => navigate("hosts")}
          aria-label="Orbit SSH 首页"
        >
          <span className="brand-symbol">
            <Orbit size={27} strokeWidth={1.6} />
          </span>
          <span>
            orbit<span className="brand-ssh">SSH</span>
          </span>
        </button>
        <button
          className="icon-button sidebar-collapse"
          onClick={onToggleCollapsed}
          title={collapsed ? "展开导航栏" : "收窄导航栏"}
          aria-label={collapsed ? "展开导航栏" : "收窄导航栏"}
        >
          {collapsed ? (
            <PanelLeftOpen size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
        </button>
      </div>
      <button
        className="sidebar-search"
        onClick={onPalette}
        title="搜索或快速切换"
        aria-label="搜索或快速切换"
      >
        <Search size={16} />
        <span>搜索或快速切换</span>
        <kbd>⌃ K</kbd>
      </button>
      <span className="nav-label">工作台</span>
      <nav aria-label="主导航">
        <button
          className={
            page === "hosts" && !group && active === "home" ? "active" : ""
          }
          onClick={() => navigate("hosts")}
          title="远程主机"
          aria-label="远程主机"
        >
          <Server size={18} />
          <span>远程主机</span>
          <span className="count">{hosts.length}</span>
        </button>
        {platform === "windows" && (
          <>
            <button
              className={page === "local" && active === "home" ? "active" : ""}
              onClick={() => navigate("local")}
              title="本地 Shell"
              aria-label="本地 Shell"
            >
              <TerminalSquare size={18} />
              <span>本地 Shell</span>
            </button>
            <button
              className={page === "wsl" && active === "home" ? "active" : ""}
              onClick={() => navigate("wsl")}
              title="WSL"
              aria-label="WSL"
            >
              <TerminalSquare size={18} />
              <span>WSL</span>
            </button>
          </>
        )}
        <button
          className={page === "history" && active === "home" ? "active" : ""}
          onClick={() => navigate("history")}
          title="终端历史"
          aria-label="终端历史"
        >
          <History size={18} />
          <span>终端历史</span>
          <span className="count">{historyCount}</span>
        </button>
        <button
          className={page === "workflows" && active === "home" ? "active" : ""}
          onClick={() => navigate("workflows")}
          title="工作流"
          aria-label="工作流"
        >
          <Workflow size={18} />
          <span>工作流</span>
        </button>
      </nav>
      <div className="group-heading">
        <button
          onClick={() => setGroupsOpen(!groupsOpen)}
          aria-expanded={groupsOpen}
          aria-label={groupsOpen ? "收起主机分组" : "展开主机分组"}
          title="主机分组"
        >
          <FolderClosed size={15} />
          <span>主机分组</span>
          <ChevronDown className={!groupsOpen ? "collapsed" : ""} size={14} />
        </button>
        <button
          className="icon-button"
          title="添加主机和分组"
          aria-label="添加主机和分组"
          onClick={onNewHost}
        >
          <Plus size={15} />
        </button>
      </div>
      {groupsOpen && (
        <div className="group-list">
          {groups.length ? (
            groups.map((g) => (
              <button
                key={g}
                className={group === g && active === "home" ? "selected" : ""}
                onClick={() => navigate("hosts", g)}
                title={g}
                aria-label={g}
              >
                <FolderClosed size={16} />
                <span>{g}</span>
                <span className="count">
                  {hosts.filter((h) => h.group === g).length}
                </span>
              </button>
            ))
          ) : (
            <div className="group-empty">
              <span className="group-line" />
              添加主机后，在这里整理
            </div>
          )}
        </div>
      )}
      <div className="sidebar-spacer" />
      <div className="sidebar-bottom">
        <button onClick={onPreferences} title="偏好设置" aria-label="偏好设置">
          <Settings2 size={18} />
          <span>偏好设置</span>
        </button>
        <button
          className="icon-button"
          title="使用帮助"
          aria-label="使用帮助"
          onClick={onHelp}
        >
          <CircleHelp size={18} />
        </button>
      </div>
      <button
        className="sidebar-version"
        type="button"
        aria-label={`关于 Orbit SSH，版本 ${appVersion}`}
        aria-haspopup="dialog"
        onClick={onAbout}
      >
        <span>ORBIT SSH</span>
        <span>v{appVersion}</span>
      </button>
    </aside>
  );
}
