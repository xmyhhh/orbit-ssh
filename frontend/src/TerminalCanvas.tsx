import { useState } from "react";
import {
  ArrowRight,
  GripVertical,
  Maximize2,
  Minimize2,
  Search,
  Star,
  X,
} from "lucide-react";
import type { Preferences, Session, TerminalHandle } from "./types";
import { TerminalPane } from "./TerminalPane";
import TerminalDropTarget from "./TerminalDropTarget";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { TerminalLayoutController } from "./hooks/useTerminalLayout";
import {
  isLocalSession,
  sessionDetailLabel,
  sessionHeading,
} from "./sessions";

export default function TerminalCanvas({
  sessions,
  active,
  setActive,
  layout,
  handles,
  preferences,
  dark,
  suspended,
  inert,
  filesOpen,
  search,
  onSearchChange,
  pinnedIds,
  onToggleHistory,
  onHistoryOutput,
  onZoom,
  onClosed,
  onError,
  onPaste,
  onReconnect,
}: {
  sessions: Session[];
  active: string;
  setActive: Dispatch<SetStateAction<string>>;
  layout: TerminalLayoutController;
  handles: RefObject<Map<string, TerminalHandle>>;
  preferences: Preferences;
  dark: boolean;
  suspended: boolean;
  inert: boolean;
  filesOpen: boolean;
  search: string | null;
  onSearchChange: (value: string | null) => void;
  pinnedIds: Set<string>;
  onToggleHistory: (session: Session) => void;
  onHistoryOutput: (session: Session, output: string) => void;
  onZoom: (direction: -1 | 0 | 1) => void;
  onClosed: (id: string, message: string) => void;
  onError: (message: string) => void;
  onPaste: (id: string, text: string) => void;
  onReconnect: (session: Session) => void;
}) {
  const [searchFound, setSearchFound] = useState(true);
  const activeSession = sessions.find((session) => session.id === active);
  const {
    terminalAreaRef,
    splitMode,
    compactSplit,
    maximized,
    paneSessions,
    paneGeometryById,
    splitSessionIds,
    draggedSessionId,
    splitPickerOpen,
    splitGeometry,
    splitResize,
    startSessionDrag,
    setDraggedSessionId,
    activateSession,
    togglePaneMaximize,
    removeSplitSession,
    placeSessionInSplit,
    startSplitResize,
    adjustSplitResize,
    resetSplitResize,
    startTouchDrag,
    consumeDragClick,
    touchDrop,
    autoFocusPane,
  } = layout;
  return (
    <div
      ref={terminalAreaRef}
      className={`terminals ${autoFocusPane ? "is-focused-pane" : ""} ${splitMode ? `is-split ${compactSplit && !maximized ? "is-compact" : ""} ${maximized ? "is-maximized" : ""}` : ""}`}
      inert={inert}
    >
      {search !== null && activeSession && !filesOpen && (
        <form
          className="terminal-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearchFound(
              handles.current.get(active)?.search(search) ?? false,
            );
          }}
        >
          <Search size={15} />
          <input
            autoFocus
            aria-label="终端搜索文本"
            value={search}
            onChange={(e) => {
              onSearchChange(e.target.value);
              setSearchFound(
                e.target.value
                  ? (handles.current.get(active)?.search(e.target.value) ??
                      false)
                  : true,
              );
            }}
            placeholder="在终端中查找…"
          />
          {!searchFound && <span>未找到</span>}
          <button
            type="submit"
            className="icon-button"
            aria-label="下一个匹配"
            title="下一个匹配"
          >
            <ArrowRight size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭终端搜索"
            onClick={() => onSearchChange(null)}
          >
            <X size={15} />
          </button>
        </form>
      )}
      <div
        className="terminal-canvas"
        style={{
          minHeight:
            splitMode && compactSplit && !maximized
              ? `${paneSessions.length * 240}px`
              : undefined,
        }}
      >
        {sessions.map((s) => {
          const pane = paneGeometryById.get(s.id);
          const pinned = pinnedIds.has(s.id);
          const visible = splitMode
            ? Boolean(pane) && (!maximized || active === s.id)
            : active === s.id;
          return (
            <div
              className={`terminal-session ${splitMode ? "split-session" : ""} ${active === s.id ? "focused" : ""}`}
              data-session-id={s.id}
              key={s.id}
              hidden={!visible}
              style={
                splitMode && pane && !maximized
                  ? {
                      left: `${pane.left * 100}%`,
                      top: `${pane.top * 100}%`,
                      width: `${pane.width * 100}%`,
                      height: `${pane.height * 100}%`,
                    }
                  : undefined
              }
              onPointerDown={splitMode ? () => setActive(s.id) : undefined}
              onFocusCapture={
                splitMode
                  ? (event) => {
                      if (
                        (event.target as HTMLElement).closest(".terminal-mount")
                      )
                        setActive(s.id);
                    }
                  : undefined
              }
            >
              {splitMode && (
                <div className="split-session-heading">
                  <button
                    className="split-session-drag"
                    draggable={!maximized}
                    title={`${sessionDetailLabel(s)} · 拖动调整位置，双击${maximized ? "还原" : "放大"}`}
                    aria-label={`激活 ${sessionDetailLabel(s)}`}
                    onClick={() => {
                      if (!consumeDragClick(s.id)) activateSession(s.id);
                    }}
                    onPointerDown={(event) => startTouchDrag(event, s.id)}
                    onDoubleClick={() => togglePaneMaximize(s.id)}
                    onDragStart={(event) => startSessionDrag(event, s.id)}
                    onDragEnd={() => setDraggedSessionId(null)}
                  >
                    <GripVertical
                      className="pane-drag-grip"
                      size={13}
                      aria-hidden="true"
                    />
                    <span
                      className={`status-dot ${s.status === "closed" ? "offline" : ""}`}
                      aria-hidden="true"
                    />
                    <strong>{sessionHeading(s)}</strong>
                    <span className="pane-terminal-number">
                      #{s.terminalNumber}
                    </span>
                  </button>
                  <button
                    className={`icon-button split-history-star ${pinned ? "selected" : ""}`}
                    aria-label={pinned ? "取消精选历史" : "加入精选历史"}
                    title={pinned ? "取消精选历史" : "加入精选历史"}
                    aria-pressed={Boolean(pinned)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleHistory(s);
                    }}
                  >
                    <Star
                      size={14}
                      fill={pinned ? "currentColor" : "none"}
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={
                      maximized
                        ? "还原分屏布局"
                        : `放大 ${sessionDetailLabel(s)}`
                    }
                    title={
                      maximized ? "还原分屏布局" : "放大窗格 · 也可双击标题"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      togglePaneMaximize(s.id);
                    }}
                  >
                    {maximized ? (
                      <Minimize2 size={13} />
                    ) : (
                      <Maximize2 size={13} />
                    )}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`收起 ${sessionDetailLabel(s)}`}
                    title="收起窗格，终端继续运行"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeSplitSession(s.id);
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
              {draggedSessionId &&
                draggedSessionId !== s.id &&
                !maximized &&
                (splitMode ? Boolean(pane) : active === s.id) && (
                  <TerminalDropTarget
                    sourceId={draggedSessionId}
                    targetId={s.id}
                    swapping={splitSessionIds.includes(draggedSessionId)}
                    canSplit={
                      splitSessionIds.includes(draggedSessionId) ||
                      splitSessionIds.length < 4
                    }
                    compact={compactSplit}
                    touchPlacement={
                      touchDrop?.targetId === s.id ? touchDrop.placement : null
                    }
                    onPlace={placeSessionInSplit}
                    onFinish={() => setDraggedSessionId(null)}
                  />
                )}
              <TerminalPane
                ref={(h) => {
                  if (h) handles.current.set(s.id, h);
                  else handles.current.delete(s.id);
                }}
                session={s}
                visible={visible}
                active={
                  active === s.id &&
                  !suspended &&
                  !splitPickerOpen &&
                  !draggedSessionId &&
                  !inert
                }
                dark={dark}
                fontSize={preferences.fontSize}
                lineHeight={preferences.lineHeight}
                historyEnabled={preferences.terminalHistoryEnabled}
                onHistoryOutput={onHistoryOutput}
                onZoom={onZoom}
                onClosed={onClosed}
                onError={onError}
                onPaste={(text) => onPaste(s.id, text)}
                onSearch={() => {
                  onSearchChange("");
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLInputElement>(".terminal-search input")
                      ?.focus(),
                  );
                }}
              />
              {(s.status === "closed" || s.reconnecting) && (
                <div className="reconnect-bar">
                  <span>
                    {s.reconnecting
                      ? "正在重新连接…"
                      : isLocalSession(s) ? "终端已结束" : "连接已结束"}
                    {s.error ? ` · ${s.error}` : ""}
                  </span>
                  <button
                    className="button secondary compact"
                    disabled={s.status === "connecting"}
                    onClick={() => onReconnect(s)}
                  >
                    {s.reconnecting
                      ? "正在重新连接…"
                      : isLocalSession(s) ? "重新打开" : "重新连接"}
                    <ArrowRight size={13} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {splitMode &&
          !maximized &&
          splitGeometry.dividers.map((divider) => (
            <div
              key={divider.path || "root"}
              className={`split-divider ${divider.axis === "x" ? "vertical" : "horizontal"} ${divider.resizable === false ? "fixed" : ""} ${splitResize?.path === divider.path ? "dragging" : ""}`}
              role="separator"
              aria-orientation={
                divider.axis === "x" ? "vertical" : "horizontal"
              }
              aria-label={
                divider.resizable === false
                  ? "终端分屏边界"
                  : "调整终端分屏大小"
              }
              aria-disabled={divider.resizable === false}
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={Math.round(divider.ratio * 100)}
              title={
                divider.resizable === false
                  ? "终端分屏边界"
                  : "拖动调整大小 · 双击均分"
              }
              tabIndex={divider.resizable === false ? -1 : 0}
              style={{
                left: `${divider.left * 100}%`,
                top: `${divider.top * 100}%`,
                width: divider.axis === "x" ? "7px" : `${divider.width * 100}%`,
                height:
                  divider.axis === "x" ? `${divider.height * 100}%` : "7px",
              }}
              onPointerDown={(event) => {
                if (divider.resizable !== false)
                  startSplitResize(event, divider);
              }}
              onDoubleClick={() => {
                if (divider.resizable !== false) resetSplitResize(divider);
              }}
              onKeyDown={(event) => {
                if (divider.resizable === false) return;
                const negative =
                  (divider.axis === "x" && event.key === "ArrowLeft") ||
                  (divider.axis === "y" && event.key === "ArrowUp");
                const positive =
                  (divider.axis === "x" && event.key === "ArrowRight") ||
                  (divider.axis === "y" && event.key === "ArrowDown");
                if (event.key === "Home") {
                  event.preventDefault();
                  resetSplitResize(divider);
                } else if (negative || positive) {
                  event.preventDefault();
                  adjustSplitResize(divider, negative ? -0.03 : 0.03);
                }
              }}
            />
          ))}
      </div>
      {draggedSessionId && !maximized && (
        <div className="terminal-drag-hint" aria-live="polite">
          <GripVertical size={14} />
          {splitSessionIds.length >= 4 &&
          !splitSessionIds.includes(draggedSessionId)
            ? "已显示 4 个窗格，拖入窗格可替换终端"
            : `拖到边缘分屏，拖到中间${splitSessionIds.includes(draggedSessionId) ? "交换" : "替换"}`}
          <kbd>Esc</kbd>
          <span>取消</span>
        </div>
      )}
    </div>
  );
}
