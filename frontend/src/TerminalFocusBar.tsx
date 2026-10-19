import { Maximize2, Menu, Minimize2, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import type { Session } from "./types";
import type { TerminalLayoutController } from "./hooks/useTerminalLayout";
import { terminalTabLabel } from "./SessionTabs";
import { sessionDetailLabel } from "./sessions";

export default function TerminalFocusBar({
  sessions,
  active,
  layout,
  fullscreen,
  onFullscreen,
  onNavigate,
  toolsOpen,
  onTools,
  children,
}: {
  sessions: Session[];
  active: string;
  layout: TerminalLayoutController;
  fullscreen: boolean;
  onFullscreen: () => void;
  onNavigate: () => void;
  toolsOpen: boolean;
  onTools: () => void;
  children: ReactNode;
}) {
  return (
    <div className="terminal-focus-bar">
      {!fullscreen && (
        <button
          className="icon-button"
          aria-label="打开导航"
          onClick={onNavigate}
        >
          <Menu size={17} />
        </button>
      )}
      <select
        aria-label="切换终端"
        value={active}
        onChange={(event) => layout.activateSession(event.target.value)}
      >
        {layout.tabs.map((tab) => {
          const items = tab.sessionIds
            .map((id) => sessions.find((session) => session.id === id))
            .filter((session): session is Session => Boolean(session));
          if (!items.length) return null;
          return (
            <optgroup
              key={tab.id}
              label={`${items[0].host.name} · ${terminalTabLabel(items)}`}
            >
              {items.map((session) => (
                <option key={session.id} value={session.id}>
                  {sessionDetailLabel(session)}
                  {items.length > 1 ? " · 分屏" : ""}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      {children}
      <button
        className="icon-button"
        aria-label={fullscreen ? "退出终端全屏" : "终端全屏"}
        aria-pressed={fullscreen}
        title={fullscreen ? "退出全屏" : "全屏终端"}
        onPointerDown={(event) => event.preventDefault()}
        onClick={onFullscreen}
      >
        {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
      </button>
      <button
        className={`icon-button ${toolsOpen ? "selected" : ""}`}
        aria-label="更多终端操作"
        aria-expanded={toolsOpen}
        onClick={onTools}
      >
        <MoreHorizontal size={18} />
      </button>
    </div>
  );
}
