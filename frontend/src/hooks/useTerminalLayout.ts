import { useEffect, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { Session, TerminalHandle } from "../types";
import { isDesktop } from "../bridge";
import {
  createSplitLayout,
  equalizeSplitLayout,
  insertSplitPane,
  removeSplitPane,
  replaceSplitPane,
  splitLayoutGeometry,
  splitLayoutIds,
  splitLayoutPreset,
  updateSplitRatio,
  type DividerGeometry,
  type PanePlacement,
  type SplitDirection,
  type SplitLayout,
  type SplitPreset,
} from "../splitLayout";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  pruneWorkspaces,
  saveWorkspaceLayout,
  terminalTabs,
  workspaceForSession,
  type TerminalWorkspace,
} from "../terminalWorkspaces";
import { useTerminalDrag } from "./useTerminalDrag";

export function useTerminalLayout({
  sessions,
  active,
  setActive,
  handles,
  canFocus,
  filesOpen,
  notify,
  onNewTerminal,
  focusPane = false,
}: {
  sessions: Session[];
  active: string;
  setActive: Dispatch<SetStateAction<string>>;
  handles: RefObject<Map<string, TerminalHandle>>;
  canFocus: boolean;
  filesOpen: boolean;
  notify: (message: string) => void;
  onNewTerminal: () => void;
  focusPane?: boolean;
}) {
  const [workspaces, setWorkspaces] = useState<TerminalWorkspace[]>([]);
  const activeWorkspace = workspaceForSession(workspaces, active);
  const splitLayout = activeWorkspace?.layout ?? null;
  const tabs = terminalTabs(
    sessions.map((session) => session.id),
    workspaces,
  );
  function setSplitLayout(
    next: SetStateAction<SplitLayout | null>,
    anchorId = active,
    focusId = active,
  ) {
    const newWorkspaceId = crypto.randomUUID();
    setWorkspaces((current) => {
      const workspace = workspaceForSession(current, anchorId);
      const layout =
        typeof next === "function" ? next(workspace?.layout ?? null) : next;
      return saveWorkspaceLayout(
        current,
        layout,
        focusId,
        workspace?.id ?? newWorkspaceId,
      );
    });
  }
  function dissolveWorkspace(id: string) {
    setWorkspaces((current) =>
      current.filter((workspace) => workspace.id !== id),
    );
  }
  const [paneMaximized, setPaneMaximized] = useState(false);
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);
  const [compactSplit, setCompactSplit] = useState(
    () => window.innerWidth <= 720,
  );
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [splitResize, setSplitResize] = useState<{
    path: string;
    axis: "x" | "y";
    start: number;
    span: number;
    ratio: number;
  } | null>(null);
  const splitControlRef = useRef<HTMLDivElement>(null);
  const pendingSplitRef = useRef<{
    targetId: string;
    direction: SplitDirection;
  } | null>(null);
  const terminalAreaRef = useRef<HTMLDivElement>(null);
  const activeSessionIdRef = useRef(active);
  activeSessionIdRef.current = active;
  const activeSession = sessions.find((session) => session.id === active);
  const hostSessions = sessions.filter(
    (session) => session.host.id === activeSession?.host.id,
  );
  const splitSessionIds = splitLayoutIds(splitLayout);
  const splitMode = splitSessionIds.length > 1;
  const autoFocusPane = splitMode && focusPane && !draggedSessionId;
  const maximized = splitMode && (paneMaximized || autoFocusPane);
  const splitSelection = splitMode
    ? splitSessionIds
    : activeSession
      ? [activeSession.id]
      : [];
  const paneSessions = splitMode
    ? splitSessionIds
        .map((id) => sessions.find((session) => session.id === id))
        .filter((session): session is Session => Boolean(session))
    : activeSession
      ? [activeSession]
      : [];
  const splitGeometry = splitLayoutGeometry(splitLayout, compactSplit);
  const paneGeometryById = new Map(
    splitGeometry.panes.map((pane) => [pane.id, pane]),
  );
  useEffect(() => {
    const terminalArea = terminalAreaRef.current;
    if (!terminalArea) return;
    function updateCompactLayout() {
      setCompactSplit((terminalAreaRef.current?.clientWidth ?? 0) < 720);
    }
    updateCompactLayout();
    const observer = new ResizeObserver(updateCompactLayout);
    observer.observe(terminalArea);
    return () => observer.disconnect();
  }, [Boolean(activeSession)]);
  useEffect(() => {
    const openIds = new Set(sessions.map((session) => session.id));
    setWorkspaces((current) => pruneWorkspaces(current, openIds));
  }, [sessions]);
  useEffect(() => {
    setWorkspaces((current) =>
      current.map((workspace) =>
        splitLayoutIds(workspace.layout).includes(active) &&
        workspace.activeId !== active
          ? { ...workspace, activeId: active }
          : workspace,
      ),
    );
  }, [active]);
  useEffect(() => {
    setPaneMaximized(false);
    setSplitResize(null);
  }, [activeWorkspace?.id]);
  useEffect(() => {
    if (!splitMode) setPaneMaximized(false);
  }, [splitMode]);
  useEffect(() => {
    if (!compactSplit || !splitMode || maximized || filesOpen) return;
    const frame = requestAnimationFrame(() => {
      const area = terminalAreaRef.current;
      const pane = area?.querySelector<HTMLElement>(
        `[data-session-id="${CSS.escape(active)}"]`,
      );
      if (!area || !pane) return;
      if (pane.offsetTop < area.scrollTop) area.scrollTop = pane.offsetTop;
      else if (
        pane.offsetTop + pane.offsetHeight >
        area.scrollTop + area.clientHeight
      )
        area.scrollTop = pane.offsetTop + pane.offsetHeight - area.clientHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, compactSplit, splitMode, maximized, filesOpen]);
  useEffect(() => {
    if (!draggedSessionId) return;
    function finish() {
      setDraggedSessionId(null);
    }
    function cancel(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      }
    }
    window.addEventListener("dragend", finish);
    window.addEventListener("drop", finish);
    window.addEventListener("blur", finish);
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("dragend", finish);
      window.removeEventListener("drop", finish);
      window.removeEventListener("blur", finish);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [draggedSessionId]);
  useEffect(() => {
    if (!splitResize) return;
    const resizeState = splitResize;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor =
      resizeState.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    function resize(event: PointerEvent) {
      const position = resizeState.axis === "x" ? event.clientX : event.clientY;
      const ratio =
        resizeState.ratio + (position - resizeState.start) / resizeState.span;
      setSplitLayout((current) =>
        current ? updateSplitRatio(current, resizeState.path, ratio) : current,
      );
    }
    function finish() {
      setSplitResize(null);
    }
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [splitResize]);
  useEffect(() => {
    if (!splitPickerOpen) return;
    function closeOutside(event: PointerEvent) {
      if (!splitControlRef.current?.contains(event.target as Node))
        setSplitPickerOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSplitPickerOpen(false);
        splitControlRef.current
          ?.querySelector<HTMLButtonElement>(".split-toggle")
          ?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [splitPickerOpen]);
  function startSessionDrag(event: ReactDragEvent<HTMLElement>, id: string) {
    event.dataTransfer.setData("application/x-orbit-terminal-session", id);
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
    setSplitPickerOpen(false);
    setPaneMaximized(false);
    setDraggedSessionId(id);
  }
  function placeSessionInSplit(
    id: string,
    targetId: string,
    direction: PanePlacement,
  ) {
    if (id === targetId) return;
    if (!sessions.some((session) => session.id === id)) return;
    const baseLayout = splitLayout ?? activeSession?.id ?? null;
    if (!baseLayout) return;
    if (direction === "center") {
      const next = replaceSplitPane(baseLayout, targetId, id);
      setSplitLayout(typeof next === "string" ? null : next, targetId, id);
      setActive(id);
      return;
    }
    const placementDirection =
      compactSplit && (direction === "left" || direction === "right")
        ? direction === "left"
          ? "top"
          : "bottom"
        : direction;
    const ids = splitLayoutIds(baseLayout);
    const movingPane = ids.includes(id);
    if (!movingPane && ids.length >= 4) {
      notify("并列终端最多显示 4 个");
      return;
    }
    const withoutMovingPane = movingPane
      ? removeSplitPane(baseLayout, id)
      : baseLayout;
    if (
      !withoutMovingPane ||
      !splitLayoutIds(withoutMovingPane).includes(targetId)
    )
      return;
    const next = insertSplitPane(
      withoutMovingPane,
      targetId,
      id,
      placementDirection,
    );
    if (next === withoutMovingPane) return;
    setSplitLayout(next, targetId, id);
    setPaneMaximized(false);
    setActive(id);
  }
  function startSplitResize(
    event: ReactPointerEvent<HTMLDivElement>,
    divider: DividerGeometry,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = terminalAreaRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const span =
      (divider.axis === "x" ? bounds.width : bounds.height) *
      (divider.axis === "x" ? divider.parentWidth : divider.parentHeight);
    if (span < 1) return;
    setSplitResize({
      path: divider.path,
      axis: divider.axis,
      start: divider.axis === "x" ? event.clientX : event.clientY,
      span,
      ratio: divider.ratio,
    });
  }
  function adjustSplitResize(divider: DividerGeometry, delta: number) {
    setSplitLayout((current) =>
      current
        ? updateSplitRatio(current, divider.path, divider.ratio + delta)
        : current,
    );
  }
  function activateSession(id: string) {
    setSplitPickerOpen(false);
    setActive(id);
    if (canFocus) {
      if (active === id) handles.current.get(id)?.focus();
      else {
        requestAnimationFrame(() => {
          if (activeSessionIdRef.current === id)
            handles.current.get(id)?.focus();
        });
      }
    }
  }
  function activateNewSession(id: string) {
    const pending = pendingSplitRef.current;
    if (
      !pending ||
      !sessions.some((session) => session.id === pending.targetId)
    ) {
      activateSession(id);
      return;
    }
    setSplitLayout(
      (current) => {
        const base = current ?? pending.targetId;
        if (
          !splitLayoutIds(base).includes(pending.targetId) ||
          splitLayoutIds(base).length >= 4
        )
          return current;
        return insertSplitPane(base, pending.targetId, id, pending.direction);
      },
      pending.targetId,
      id,
    );
    setPaneMaximized(false);
    setActive(id);
  }
  function applySplitPreset(preset: SplitPreset | "single") {
    if (!activeSession) return;
    setSplitPickerOpen(false);
    setPaneMaximized(false);
    if (preset === "single") {
      setSplitLayout(null);
      return;
    }
    const candidates = [
      ...splitSelection,
      ...hostSessions
        .filter((session) => !workspaceForSession(workspaces, session.id))
        .map((session) => session.id),
      ...sessions
        .filter((session) => !workspaceForSession(workspaces, session.id))
        .map((session) => session.id),
    ].filter((id, index, ids) => ids.indexOf(id) === index);
    const count = preset === "grid" ? 4 : Math.max(2, splitSelection.length);
    const selected = candidates.slice(0, count);
    if (selected.length === 1) {
      if (!isDesktop()) {
        notify("请先打开另一个终端");
        return;
      }
      pendingSplitRef.current = {
        targetId: activeSession.id,
        direction: preset === "rows" ? "bottom" : "right",
      };
      onNewTerminal();
      return;
    }
    setSplitLayout(createSplitLayout(selected, preset));
  }
  function equalizePanes() {
    setSplitLayout((current) =>
      current ? equalizeSplitLayout(current) : current,
    );
  }
  function togglePaneMaximize(id: string) {
    setActive(id);
    setPaneMaximized((current) => !current);
    requestAnimationFrame(() => handles.current.get(id)?.focus());
  }
  function toggleSplitSession(id: string) {
    const current = splitMode ? splitSessionIds : splitSelection;
    if (current.includes(id)) {
      removeSplitSession(id);
      return;
    }

    if (current.length >= 4) return;
    const baseLayout = splitLayout ?? activeSession?.id;
    if (!baseLayout) return;
    const preset = compactSplit
      ? "rows"
      : (splitLayoutPreset(baseLayout) ?? "grid");
    setPaneMaximized(false);
    setSplitLayout(createSplitLayout([...current, id], preset));
  }
  function removeSplitSession(id: string) {
    const remaining = splitSessionIds.filter((sessionId) => sessionId !== id);
    if (remaining.length < 2) {
      setSplitLayout(null);
      if (remaining.length === 1) setActive(remaining[0]);
    } else {
      if (splitLayout) setSplitLayout(removeSplitPane(splitLayout, id));
      if (active === id) setActive(remaining[0]);
    }
  }
  function resetSplitResize(divider: DividerGeometry) {
    setSplitLayout((current) =>
      current ? updateSplitRatio(current, divider.path, 0.5) : current,
    );
  }
  const touchDrag = useTerminalDrag({
    compact: compactSplit,
    splitSessionIds,
    onPlace: placeSessionInSplit,
    onStart: (id) => {
      setSplitPickerOpen(false);
      setPaneMaximized(false);
      setDraggedSessionId(id);
    },
    onFinish: () => setDraggedSessionId(null),
  });
  return {
    tabs,
    dissolveWorkspace,
    ...touchDrag,
    splitLayout,
    splitSessionIds,
    splitMode,
    maximized,
    autoFocusPane,
    splitSelection,
    paneSessions,
    splitGeometry,
    paneGeometryById,
    compactSplit,
    splitPickerOpen,
    setSplitPickerOpen,
    draggedSessionId,
    setDraggedSessionId,
    splitResize,
    splitControlRef,
    terminalAreaRef,
    pendingSplitRef,
    startSessionDrag,
    placeSessionInSplit,
    startSplitResize,
    adjustSplitResize,
    resetSplitResize,
    activateSession,
    activateNewSession,
    applySplitPreset,
    equalizePanes,
    togglePaneMaximize,
    toggleSplitSession,
    removeSplitSession,
  };
}

export type TerminalLayoutController = ReturnType<typeof useTerminalLayout>;
