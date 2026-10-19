import { GripVertical, LoaderCircle, Ungroup, X } from "lucide-react";
import type { Session } from "./types";
import type { TerminalLayoutController } from "./hooks/useTerminalLayout";
import { LayoutPreview } from "./TerminalLayoutPicker";
import { splitLayoutPreset } from "./splitLayout";

export function terminalTabLabel(items: Session[]) {
  const sameHost = items.every(
    (session) => session.host.id === items[0].host.id,
  );
  return items.length === 1
    ? `终端 #${items[0].terminalNumber}`
    : `分屏 ${items.map((session) => `${sameHost ? "" : session.host.name + " "}#${session.terminalNumber}`).join(" + ")}`;
}

export default function SessionTabs({
  sessions,
  hostId,
  active,
  layout,
  onClose,
}: {
  sessions: Session[];
  hostId: string;
  active: string;
  layout: TerminalLayoutController;
  onClose: (items: Session[]) => void;
}) {
  return layout.tabs.map((tab) => {
    const items = tab.sessionIds
      .map((id) => sessions.find((session) => session.id === id))
      .filter((session): session is Session => Boolean(session));
    if (!items.length || !items.some((session) => session.host.id === hostId))
      return null;
    const grouped = items.length > 1;
    const label = terminalTabLabel(items);
    const selected = tab.sessionIds.includes(active);
    return (
      <div
        className={`session-tab ${selected ? "selected" : ""} ${grouped ? "grouped-tab" : ""} ${layout.draggedSessionId === tab.activeId ? "dragging-tab" : ""}`}
        key={tab.id}
      >
        {!grouped && (
          <button
            className="tab-drag-handle"
            aria-label={`拖动${label}分屏`}
            title="按住拖动到终端边缘分屏"
            onPointerDown={(event) =>
              layout.startTouchDrag(event, tab.activeId)
            }
          >
            <GripVertical size={14} />
          </button>
        )}
        <button
          role="tab"
          aria-selected={selected}
          aria-label={`${items[0].host.name} · ${label}`}
          title={
            grouped
              ? `${label} · 布局单独保存在此标签中`
              : `${label} · 拖到终端边缘分屏`
          }
          draggable={!grouped}
          onClick={() => {
            if (!layout.consumeDragClick(tab.activeId))
              layout.activateSession(tab.activeId);
          }}
          onDragStart={(event) => layout.startSessionDrag(event, tab.activeId)}
          onDragEnd={() => layout.setDraggedSessionId(null)}
        >
          {grouped ? (
            <LayoutPreview
              preset={splitLayoutPreset(tab.layout) ?? "grid"}
              count={items.length}
            />
          ) : items[0].status === "connecting" ? (
            <LoaderCircle size={13} className="spin" aria-hidden="true" />
          ) : (
            <span
              className={`status-dot ${items[0].status === "closed" ? "offline" : ""}`}
              aria-hidden="true"
            />
          )}
          <span>{label}</span>
        </button>
        {grouped && (
          <button
            className="tab-close tab-ungroup"
            aria-label={`解除${label}`}
            title="解除分屏，恢复独立标签"
            onClick={() => layout.dissolveWorkspace(tab.id)}
          >
            <Ungroup size={13} />
          </button>
        )}
        <button
          className="tab-close"
          aria-label={`关闭${label}`}
          title={grouped ? "关闭这组分屏的全部会话" : `关闭${label}`}
          onClick={() => onClose(items)}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    );
  });
}
