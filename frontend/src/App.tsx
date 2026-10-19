import { useEffect, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clipboard,
  Columns2,
  Ellipsis,
  FolderClosed,
  FolderOpen,
  Github,
  History,
  GripVertical,
  LoaderCircle,
  Maximize2,
  Menu,
  Minimize2,
  Moon,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Star,
  Sun,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import type {
  Host,
  LocalShell,
  Preferences,
  Session,
  TerminalHandle,
  Workspace,
  Credentials,
} from "./types";
import {
  backend,
  defaults,
  errorText,
  isDesktop,
  loadWorkspace,
  savePreview,
} from "./bridge";
import {
  CommandPalette,
  ConfirmDialog,
  ConnectDialog,
  HostDialog,
  Modal,
  PreferencesDialog,
} from "./Dialogs";
import { TerminalPane } from "./TerminalPane";
import TerminalLayoutPicker from "./TerminalLayoutPicker";
import TerminalDropTarget from "./TerminalDropTarget";
import FilesPane from "./FilesPane";
import MonitorPanel from "./MonitorPanel";
import WSLPage from "./WSLPage";
import LocalShellPage from "./LocalShellPage";
import LayoutSwitch from "./LayoutSwitch";
import { matchesShortcut, usesMacShortcuts } from "./shortcuts";
import TerminalHistoryPage from "./TerminalHistoryPage";
import {
  deleteTerminalHistory,
  saveTerminalHistory,
  trimTerminalHistory,
  trimTerminalHistoryOutput,
  type TerminalHistoryRecord,
} from "./terminalHistory";
import { BrowserOpenURL } from "../wailsjs/runtime/runtime";
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
} from "./splitLayout";

type Page = "hosts" | "local" | "wsl" | "history";
type HostFilter = "all" | "favorite" | "recent";
type LocalSessionTarget =
  | { localShell: LocalShell; wslDistribution?: never }
  | { wslDistribution: string; localShell?: never };

function isLocalSession(session?: Session) {
  return Boolean(session?.localShell || session?.wslDistribution);
}

function sessionAddress(session: Session) {
  if (session.localShell) return `本地 · ${session.localShell.name}`;
  if (session.wslDistribution) return `WSL · ${session.wslDistribution}`;
  return `${session.host.username}@${session.host.address}:${session.host.port}`;
}
interface Confirmation {
  title: string;
  message: string;
  action: string;
  danger?: boolean;
  run: () => Promise<void> | void;
}
const pageNames: Record<Page, string> = {
  hosts: "远程主机",
  local: "本地 Shell",
  wsl: "WSL",
  history: "终端历史",
};
const appVersion = "1.0";
const projectURL = "https://github.com/xmyhhh/orbit-ssh";
function moveTabFocus(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (
    e.altKey ||
    e.ctrlKey ||
    e.metaKey ||
    (e.target as HTMLElement).getAttribute("role") !== "tab" ||
    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  )
    return;
  e.preventDefault();
  const tabs = [
    ...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  const index = tabs.indexOf(e.target as HTMLButtonElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? tabs.length - 1
        : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next]?.focus();
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>(defaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [page, setPage] = useState<Page>("hosts");
  const [group, setGroup] = useState("");
  const pageTitle = (page === "hosts" && group) || pageNames[page];
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HostFilter>("all");
  const layout = workspace.preferences.hostLayout === "list" ? "list" : "grid";
  const [platform, setPlatform] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [terminalHistory, setTerminalHistory] = useState<
    TerminalHistoryRecord[]
  >([]);
  const [active, setActive] = useState("home");
  const [splitLayout, setSplitLayout] = useState<SplitLayout | null>(null);
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
  const [hostEditor, setHostEditor] = useState<{
    host?: Host;
    isNew?: boolean;
  } | null>(null);
  const [connectHost, setConnectHost] = useState<Host | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [toast, setToast] = useState("");
  const [systemDark, setSystemDark] = useState(
    matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [filesOpen, setFilesOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [monitorExpanded, setMonitorExpanded] = useState(false);
  const [terminalSearch, setTerminalSearch] = useState<string | null>(null);
  const [searchFound, setSearchFound] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("orbit-ssh-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const handles = useRef(new Map<string, TerminalHandle>());
  const historyOutputCache = useRef(
    new Map<string, TerminalHistoryRecord>(),
  );
  const historySuppressed = useRef(new Set<string>());
  const historyFailureNotified = useRef(false);
  const splitControlRef = useRef<HTMLDivElement>(null);
  const pendingSplitRef = useRef<{
    targetId: string;
    direction: SplitDirection;
  } | null>(null);
  const terminalAreaRef = useRef<HTMLDivElement>(null);
  const preferenceWrites = useRef<Promise<void>>(Promise.resolve());
  const connectingID = useRef<string | null>(null);
  const terminalNumbers = useRef(new Map<string, number>());
  const lastActiveSessions = useRef(new Map<string, string>());
  const tabbarRef = useRef<HTMLDivElement>(null);
  const sessionbarRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef(active);
  activeSessionIdRef.current = active;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const stateRef = useRef(workspace);
  stateRef.current = workspace;
  const activeSession = sessions.find((s) => s.id === active);
  const splitSessionIds = splitLayoutIds(splitLayout);
  const splitMode = splitSessionIds.length > 1;
  const maximized = splitMode && paneMaximized;
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
  const sessionGroups = new Map<string, Session[]>();
  for (const session of sessions) {
    const items = sessionGroups.get(session.host.id);
    if (items) items.push(session);
    else sessionGroups.set(session.host.id, [session]);
  }
  const hostSessions = activeSession
    ? (sessionGroups.get(activeSession.host.id) ?? [])
    : [];
  const dark =
    workspace.preferences.theme === "dark" ||
    (workspace.preferences.theme === "system" && systemDark);
  const groups = [
    ...new Set(workspace.hosts.map((h) => h.group || "默认分组")),
  ];
  const modalOpen = Boolean(
    hostEditor ||
    connectHost ||
    preferencesOpen ||
    aboutOpen ||
    paletteOpen ||
    helpOpen ||
    confirmation,
  );

  function notify(message: string) {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }
  async function load() {
    setLoading(true);
    setLoadError("");
    try {
      setWorkspace(await loadWorkspace());
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    if (isDesktop())
      void backend()
        .GetPlatform()
        .then(setPlatform)
        .catch(() => {});
    return () => clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    void trimTerminalHistory(workspace.preferences.terminalHistoryLimit)
      .then((records) => {
        if (cancelled) return;
        for (const record of records)
          if (!historyOutputCache.current.has(record.id))
            historyOutputCache.current.set(record.id, record);
        setTerminalHistory(records);
        if (isDesktop())
          void backend().SyncTerminalHistory(records).catch(reportHistoryFailure);
      })
      .catch((error) => {
        if (cancelled || historyFailureNotified.current) return;
        historyFailureNotified.current = true;
        notify(`读取终端历史失败：${errorText(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [loading, workspace.preferences.terminalHistoryLimit]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "orbit-ssh-sidebar-collapsed",
        String(sidebarCollapsed),
      );
    } catch {
      // The sidebar remains usable when browser storage is unavailable.
    }
  }, [sidebarCollapsed]);
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
    if (!splitLayout) return;
    const splitSessionIds = splitLayoutIds(splitLayout);
    const openIds = new Set(sessions.map((session) => session.id));
    const remaining = splitSessionIds.filter((id) => openIds.has(id));
    if (remaining.length === splitSessionIds.length) return;
    let nextLayout: SplitLayout | null = splitLayout;
    for (const id of splitSessionIds)
      if (!openIds.has(id) && nextLayout)
        nextLayout = removeSplitPane(nextLayout, id);
    const nextIds = splitLayoutIds(nextLayout);
    if (nextIds.length > 1) setSplitLayout(nextLayout);
    else {
      setSplitLayout(null);
      if (nextIds.length === 1) setActive(nextIds[0]);
    }
  }, [sessions, splitLayout]);
  useEffect(() => {
    if (!splitMode) setPaneMaximized(false);
  }, [splitMode]);
  useEffect(() => {
    if (!compactSplit || !splitMode || maximized || filesOpen) return;
    const frame = requestAnimationFrame(() => {
      const area = terminalAreaRef.current;
      const pane = area?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(active)}"]`);
      if (!area || !pane) return;
      if (pane.offsetTop < area.scrollTop)
        area.scrollTop = pane.offsetTop;
      else if (pane.offsetTop + pane.offsetHeight > area.scrollTop + area.clientHeight)
        area.scrollTop = pane.offsetTop + pane.offsetHeight - area.clientHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, compactSplit, splitMode, maximized, filesOpen]);
  useEffect(() => {
    if (!draggedSessionId) return;
    function finish() { setDraggedSessionId(null); }
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
    document.body.style.cursor = resizeState.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    function resize(event: PointerEvent) {
      const position = resizeState.axis === "x" ? event.clientX : event.clientY;
      const ratio =
        resizeState.ratio +
        (position - resizeState.start) / resizeState.span;
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
        splitControlRef.current?.querySelector<HTMLButtonElement>(".split-toggle")?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [splitPickerOpen]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    if (isLocalSession(activeSession)) {
      setFilesOpen(false);
      setMonitorOpen(false);
      setMonitorExpanded(false);
    }
    if (activeSession)
      lastActiveSessions.current.set(activeSession.host.id, active);
    const bars = [tabbarRef.current, sessionbarRef.current];
    function revealSelected() {
      for (const bar of bars)
        bar
          ?.querySelector(".selected")
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    revealSelected();
    const observer = new ResizeObserver(revealSelected);
    for (const bar of bars) if (bar) observer.observe(bar);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (
        modalOpen ||
        document.querySelector('.file-workspace [role="dialog"]')
      )
        return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".terminal-context-menu")) return;
      const shortcuts = workspace.preferences.shortcuts;
      if (matchesShortcut(e, shortcuts.closeSession, platform) && activeSession) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) closeSession(activeSession);
        return;
      }
      if (matchesShortcut(e, shortcuts.newTerminal, platform)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) newTerminal();
        return;
      }
      if (
        (matchesShortcut(e, shortcuts.nextSession, platform) ||
          matchesShortcut(e, shortcuts.previousSession, platform)) &&
        sessions.length
      ) {
        e.preventDefault();
        e.stopPropagation();
        const direction = matchesShortcut(
          e,
          shortcuts.previousSession,
          platform,
        )
          ? -1
          : 1;
        const currentIndex = sessions.findIndex(
          (session) => session.id === active,
        );
        const nextIndex =
          currentIndex < 0
            ? direction > 0
              ? 0
              : sessions.length - 1
            : (currentIndex + direction + sessions.length) % sessions.length;
        activateSession(sessions[nextIndex].id);
        return;
      }
      if (matchesShortcut(e, shortcuts.switchSession, platform)) {
        e.preventDefault();
        e.stopPropagation();
        const number = Number(e.code.slice(-1));
        const index = number === 9 ? sessions.length - 1 : number - 1;
        if (sessions[index]) {
          activateSession(sessions[index].id);
        }
        return;
      }
      const primaryModifier = usesMacShortcuts(platform)
        ? e.metaKey
        : e.ctrlKey;
      if (!primaryModifier || e.altKey) return;
      const editing =
        target?.closest('input, textarea, select, [contenteditable="true"]') &&
        !target.closest(".xterm");
      if (
        activeSession &&
        !filesOpen &&
        !editing &&
        primaryModifier &&
        [
          "Equal",
          "Minus",
          "Digit0",
          "NumpadAdd",
          "NumpadSubtract",
          "Numpad0",
        ].includes(e.code)
      ) {
        e.preventDefault();
        e.stopPropagation();
        zoomTerminal(
          ["Digit0", "Numpad0"].includes(e.code)
            ? 0
            : ["Minus", "NumpadSubtract"].includes(e.code)
              ? -1
              : 1,
        );
        return;
      }
      if (primaryModifier && !e.shiftKey && e.code === "KeyK") {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (primaryModifier && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        newHost();
      }
      if (
        primaryModifier &&
        e.shiftKey &&
        e.code === "KeyF" &&
        activeSession &&
        !filesOpen
      ) {
        e.preventDefault();
        setTerminalSearch("");
      }
      if (
        primaryModifier &&
        e.shiftKey &&
        e.code === "KeyV" &&
        activeSession &&
        !filesOpen &&
        !editing
      ) {
        e.preventDefault();
        e.stopPropagation();
        handles.current.get(active)?.pasteFromClipboard();
      }
    }
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  function update(next: Workspace) {
    savePreview(next);
    stateRef.current = next;
    setWorkspace(next);
  }
  async function saveHost(host: Host) {
    if (isDesktop()) await backend().SaveHost(host);
    const previous = stateRef.current;
    const exists = previous.hosts.some((h) => h.id === host.id);
    update({
      ...previous,
      hosts: exists
        ? previous.hosts.map((h) => (h.id === host.id ? host : h))
        : [...previous.hosts, host],
    });
    notify(exists ? "主机设置已更新" : "主机已添加");
  }
  async function savePreferences(preferences: Preferences) {
    const previous = stateRef.current.preferences;
    update({ ...stateRef.current, preferences });
    const request = preferenceWrites.current
      .catch(() => {})
      .then(async () => {
        if (isDesktop()) await backend().SavePreferences(preferences);
      });
    preferenceWrites.current = request;
    try {
      await request;
    } catch (e) {
      if (stateRef.current.preferences === preferences)
        update({ ...stateRef.current, preferences: previous });
      throw e;
    }
  }
  function reportHistoryFailure(error: unknown) {
    if (historyFailureNotified.current) return;
    historyFailureNotified.current = true;
    notify(`保存终端历史失败：${errorText(error)}`);
  }
  function persistTerminalHistory(
    record: TerminalHistoryRecord,
    outputDelta?: string,
  ) {
    historyOutputCache.current.set(record.id, record);
    setTerminalHistory((records) =>
      [record, ...records.filter((item) => item.id !== record.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    );
    void saveTerminalHistory(
      record,
      stateRef.current.preferences.terminalHistoryLimit,
    )
      .then((records) => {
        historyFailureNotified.current = false;
        setTerminalHistory(records);
        if (isDesktop()) {
          const retainedIDs = records.map((item) => item.id);
          const sync = outputDelta === undefined
            ? backend().UpsertTerminalHistory(record, retainedIDs)
            : backend().AppendTerminalHistory(
                record,
                outputDelta,
                retainedIDs,
              );
          void sync.catch(reportHistoryFailure);
        }
      })
      .catch(reportHistoryFailure);
  }
  function recordTerminalOutput(session: Session, output: string) {
    if (
      !stateRef.current.preferences.terminalHistoryEnabled ||
      historySuppressed.current.has(session.id)
    )
      return;
    const previous = historyOutputCache.current.get(session.id);
    const now = Date.now();
    const bounded = trimTerminalHistoryOutput(
      `${previous?.output ?? ""}${output}`,
    );
    persistTerminalHistory({
      id: session.id,
      title:
        session.localShell?.name ||
        (session.wslDistribution
          ? `WSL · ${session.wslDistribution}`
          : session.host.name),
      subtitle: sessionAddress(session),
      terminalNumber: session.terminalNumber,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      output: bounded.output,
      pinned: previous?.pinned ?? false,
      truncated: (previous?.truncated ?? false) || bounded.truncated,
    }, output);
  }
  function setHistoryPinned(record: TerminalHistoryRecord, pinned: boolean) {
    historySuppressed.current.delete(record.id);
    const current = historyOutputCache.current.get(record.id) ?? record;
    persistTerminalHistory({ ...current, pinned });
  }
  function toggleSessionHistory(session: Session) {
    const terminal = handles.current.get(session.id);
    terminal?.flushHistory();
    const previous = historyOutputCache.current.get(session.id);
    const current = previous ??
      terminalHistory.find((record) => record.id === session.id);
    const now = Date.now();
    const liveBuffer = terminal?.readBuffer() ?? "";
    const buffer = stateRef.current.preferences.terminalHistoryEnabled
      ? current?.output ?? liveBuffer
      : liveBuffer || current?.output || "";
    const bounded = trimTerminalHistoryOutput(buffer);
    historySuppressed.current.delete(session.id);
    persistTerminalHistory({
      id: session.id,
      title:
        session.localShell?.name ||
        (session.wslDistribution
          ? `WSL · ${session.wslDistribution}`
          : session.host.name),
      subtitle: sessionAddress(session),
      terminalNumber: session.terminalNumber,
      createdAt: current?.createdAt ?? now,
      updatedAt: current?.updatedAt ?? now,
      output: bounded.output,
      pinned: !(current?.pinned ?? false),
      truncated: (current?.truncated ?? false) || bounded.truncated,
    });
  }
  function removeTerminalHistory(record: TerminalHistoryRecord) {
    if (sessionsRef.current.some((session) => session.id === record.id))
      historySuppressed.current.add(record.id);
    historyOutputCache.current.delete(record.id);
    setTerminalHistory((records) => records.filter((item) => item.id !== record.id));
    void deleteTerminalHistory(record.id).catch(reportHistoryFailure);
    if (isDesktop()) void backend().DeleteTerminalHistory(record.id).catch(reportHistoryFailure);
  }
  function zoomTerminal(direction: -1 | 0 | 1) {
    const preferences = stateRef.current.preferences;
    const fontSize =
      direction === 0
        ? 14
        : Math.max(11, Math.min(22, preferences.fontSize + direction));
    if (fontSize !== preferences.fontSize)
      void savePreferences({ ...preferences, fontSize }).catch((e) =>
        notify(errorText(e)),
      );
  }
  function setHostLayout(hostLayout: Preferences["hostLayout"]) {
    if (hostLayout === layout) return;
    void savePreferences({ ...stateRef.current.preferences, hostLayout }).catch(
      (e) => notify(`视图保存失败：${errorText(e)}`),
    );
  }
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
      setSplitLayout(typeof next === "string" ? null : next);
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
    setSplitLayout(next);
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
    setActive(id);
    setSplitLayout((current) => {
      if (!current) return current;
      const ids = splitLayoutIds(current);
      if (ids.length < 2 || ids.includes(id)) return current;
      return replaceSplitPane(
        current,
        ids.includes(active) ? active : ids[0],
        id,
      );
    });
    if (!modalOpen && !filesOpen) {
      if (active === id) handles.current.get(id)?.focus();
      else {
        requestAnimationFrame(() => {
          if (activeSessionIdRef.current === id) handles.current.get(id)?.focus();
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
    setSplitLayout((current) => {
      const base = current ?? pending.targetId;
      if (
        !splitLayoutIds(base).includes(pending.targetId) ||
        splitLayoutIds(base).length >= 4
      )
        return current;
      return insertSplitPane(base, pending.targetId, id, pending.direction);
    });
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
      ...hostSessions.map((session) => session.id),
      ...sessions.map((session) => session.id),
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
      newTerminal();
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
      const remaining = current.filter((sessionId) => sessionId !== id);
      if (remaining.length < 2) {
        setSplitLayout(null);
        if (remaining.length === 1) setActive(remaining[0]);
      } else {
        if (splitLayout) setSplitLayout(removeSplitPane(splitLayout, id));
        if (active === id) setActive(remaining[0]);
      }
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
  function navigate(next: Page, nextGroup = "") {
    setPage(next);
    setGroup(nextGroup);
    setActive("home");
    setSidebarOpen(false);
    setQuery("");
    setFilter("all");
  }
  function newHost() {
    setHostEditor({ isNew: true });
  }
  function chooseHost(host: Host) {
    if (!isDesktop()) {
      notify("请使用桌面版连接 SSH。");
      return;
    }
    setConnectHost(host);
  }
  function allocateSession(host: Host): Session {
    const terminalNumber = (terminalNumbers.current.get(host.id) ?? 0) + 1;
    terminalNumbers.current.set(host.id, terminalNumber);
    return {
      id: crypto.randomUUID(),
      host,
      terminalNumber,
      demo: false,
      status: "connecting",
    };
  }
  function newTerminal() {
    if (activeSession?.status === "connecting") return;
    setFilesOpen(false);
    setMonitorExpanded(false);
    setTerminalSearch(null);
    if (activeSession?.localShell)
      void openLocalShell(activeSession.localShell);
    else if (activeSession?.wslDistribution)
      void openWSLTerminal(activeSession.wslDistribution);
    else if (activeSession)
      chooseHost(
        workspace.hosts.find((h) => h.id === activeSession.host.id) ??
          activeSession.host,
      );
    else if (workspace.hosts.length) setPaletteOpen(true);
    else newHost();
  }
  async function connect(
    host: Host,
    credentials: Credentials,
    fingerprint: string,
  ) {
    const session = allocateSession(host);
    const id = session.id;
    const previousActive = active;
    connectingID.current = id;
    setSessions((s) => [...s, session]);
    activateNewSession(id);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    try {
      if (connectingID.current !== id) throw new Error("连接已取消");
      await backend().Connect(
        id,
        host.id,
        credentials,
        fingerprint,
        handles.current.get(id)?.size() ?? { cols: 100, rows: 30 },
      );
      if (connectingID.current !== id) {
        await backend().Disconnect(id);
        throw new Error("连接已取消");
      }
      // A remote exit can arrive before the Connect promise resolves.
      setSessions((s) =>
        s.map((item) =>
          item.id === id && item.status !== "closed"
            ? { ...item, status: "connected" }
            : item,
        ),
      );
      pendingSplitRef.current = null;
      update({
        ...stateRef.current,
        hosts: stateRef.current.hosts.map((h) =>
          h.id === host.id
            ? { ...h, lastConnected: new Date().toISOString() }
            : h,
        ),
      });
      if (host.authType === "password") {
        try {
          if (credentials.rememberPassword && credentials.password) {
            await backend().SavePassword(host.id, credentials.password);
          } else if (credentials.rememberPassword === false) {
            await backend().ForgetPassword(host.id);
          }
        } catch (e) {
          notify(
            `已连接，密码${credentials.rememberPassword === false ? "清除" : "保存"}失败：${errorText(e)}`,
          );
          return;
        }
      }
      if (
        host.authType === "key" &&
        credentials.rememberKey &&
        credentials.passphrase
      ) {
        try {
          await backend().SaveKeyPassphrase(host.id, credentials.passphrase);
        } catch (e) {
          notify(`已连接，口令保存失败：${errorText(e)}`);
          return;
        }
      }
      notify(`已连接 ${host.name}`);
    } catch (e) {
      await backend()
        .Disconnect(id)
        .catch(() => {});
      if (terminalNumbers.current.get(host.id) === session.terminalNumber)
        terminalNumbers.current.set(host.id, session.terminalNumber - 1);
      setSessions((s) => s.filter((item) => item.id !== id));
      setActive((current) =>
        current === id
          ? sessionsRef.current.some((s) => s.id === previousActive)
            ? previousActive
            : "home"
          : current,
      );
      throw e;
    } finally {
      if (connectingID.current === id) connectingID.current = null;
    }
  }
  async function openWSLTerminal(distribution: string) {
    await openLocalSession({ wslDistribution: distribution });
  }
  async function openLocalShell(shell: LocalShell) {
    await openLocalSession({ localShell: shell });
  }
  async function openLocalSession(target: LocalSessionTarget) {
    const name = target.localShell
      ? target.localShell.name
      : target.wslDistribution;
    const host: Host = {
      id: target.localShell
        ? `local:${target.localShell.id}`
        : `wsl:${target.wslDistribution}`,
      name,
      address: name,
      port: 0,
      username: "",
      group: target.localShell ? "本地 Shell" : "WSL",
      authType: "password",
      keyPath: "",
      color: "mint",
      favorite: false,
      lastConnected: "",
    };
    const session = { ...allocateSession(host), ...target };
    const previousActive = active;
    setSessions((items) => [...items, session]);
    activateNewSession(session.id);
    setSidebarOpen(false);
    setFilesOpen(false);
    setMonitorOpen(false);
    setMonitorExpanded(false);
    setTerminalSearch(null);
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      if (!sessionsRef.current.some((item) => item.id === session.id)) return;
      const size = handles.current.get(session.id)?.size() ?? {
        cols: 100,
        rows: 30,
      };
      if (target.localShell)
        await backend().ConnectLocalShell(
          session.id,
          target.localShell.id,
          size,
        );
      else await backend().ConnectWSL(session.id, target.wslDistribution, size);
      if (!sessionsRef.current.some((item) => item.id === session.id)) {
        await backend().Disconnect(session.id);
        return;
      }
      setSessions((items) =>
        items.map((item) =>
          item.id === session.id && item.status !== "closed"
            ? { ...item, status: "connected" }
            : item,
        ),
      );
    } catch (e) {
      await backend()
        .Disconnect(session.id)
        .catch(() => {});
      if (terminalNumbers.current.get(host.id) === session.terminalNumber)
        terminalNumbers.current.set(host.id, session.terminalNumber - 1);
      setSessions((items) => items.filter((item) => item.id !== session.id));
      setActive((current) =>
        current === session.id
          ? sessionsRef.current.some((item) => item.id === previousActive)
            ? previousActive
            : "home"
          : current,
      );
      notify(errorText(e));
    } finally {
      pendingSplitRef.current = null;
    }
  }
  async function removeSession(id: string) {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session) await removeSessions([session]);
  }
  async function removeSessions(closing: Session[]) {
    const results = await Promise.allSettled(
      closing.map((s) =>
        isDesktop() && !s.demo ? backend().Disconnect(s.id) : Promise.resolve(),
      ),
    );
    const removed = new Set(
      closing
        .filter((_, i) => results[i].status === "fulfilled")
        .map((s) => s.id),
    );
    const items = sessionsRef.current;
    const remaining = items.filter((s) => !removed.has(s.id));
    setSessions((s) => s.filter((item) => !removed.has(item.id)));
    setActive((current) => {
      if (!removed.has(current)) return current;
      const visibleRemaining = splitSessionIds.filter((id) => !removed.has(id));
      if (splitSessionIds.includes(current) && visibleRemaining.length)
        return visibleRemaining[0];
      const session = items.find((s) => s.id === current);
      const siblings = items.filter((s) => s.host.id === session?.host.id);
      const survivingSiblings = remaining.filter(
        (s) => s.host.id === session?.host.id,
      );
      return (
        survivingSiblings[
          Math.min(
            siblings.findIndex((s) => s.id === current),
            survivingSiblings.length - 1,
          )
        ]?.id ??
        remaining[
          Math.min(
            items.findIndex((s) => s.id === current),
            remaining.length - 1,
          )
        ]?.id ??
        "home"
      );
    });
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  function selectHostSessions(items: Session[]) {
    const remembered = lastActiveSessions.current.get(items[0].host.id);
    activateSession(items.find((s) => s.id === remembered)?.id ?? items[0].id);
  }
  function closeHostSessions(items: Session[]) {
    if (items.length === 1) {
      closeSession(items[0]);
      return;
    }
    setConfirmation({
      title: isLocalSession(items[0])
        ? "结束这组终端的全部会话？"
        : "关闭这台主机的全部会话？",
      message: isLocalSession(items[0])
        ? `将结束 ${items[0].host.name} 的 ${items.length} 个本地终端，前台任务会中断。`
        : `将关闭 ${items[0].host.name} 的 ${items.length} 个终端，这些终端的文件传输和前台任务会中断。`,
      action: "关闭全部会话",
      run: () => removeSessions(items),
    });
  }
  function closeSession(session: Session) {
    if (
      !session.demo &&
      session.status !== "closed" &&
      workspace.preferences.confirmClose
    )
      setConfirmation({
        title: isLocalSession(session)
          ? "结束这个本地终端？"
          : "断开这次连接？",
        message: isLocalSession(session)
          ? `将结束 ${session.host.name} 的终端 #${session.terminalNumber}，前台任务会中断。`
          : `将关闭 ${session.host.name} 的终端 #${session.terminalNumber}，此终端的文件传输和前台任务会中断。`,
        action: isLocalSession(session) ? "结束终端" : "断开连接",
        run: () => removeSession(session.id),
      });
    else void removeSession(session.id).catch((e) => notify(errorText(e)));
  }
  function pasteToTerminal(sessionId: string, text: string) {
    const target = sessionsRef.current.find((s) => s.id === sessionId);
    if (!target || target.status !== "connected" || !text) return;
    const paste = () => {
      handles.current.get(sessionId)?.paste(text);
      if (sessionId === active) handles.current.get(sessionId)?.focus();
    };
    if (/[\r\n\x1b]/.test(text)) {
      setConfirmation({
        title: "粘贴多行内容？",
        message: `剪贴板包含换行或控制字符，可能立即执行命令。请先核对内容：\n\n${text.slice(0, 800)}${text.length > 800 ? "\n…" : ""}`,
        action: "确认粘贴",
        run: paste,
      });
    } else {
      paste();
    }
  }
  function deleteHost(host: Host) {
    setConfirmation({
      title: "移除这台主机？",
      message: `移除“${host.name}”的主机配置。`,
      action: "移除主机",
      danger: true,
      run: async () => {
        if (isDesktop()) await backend().DeleteHost(host.id);
        update({
          ...stateRef.current,
          hosts: stateRef.current.hosts.filter((h) => h.id !== host.id),
        });
        notify("主机已移除");
      },
    });
  }
  let filtered = workspace.hosts.filter(
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
    <div
      className={`app ${sidebarOpen ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
    >
      <a className="skip-link" href="#main-content">
        跳转到工作区
      </a>
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="收起导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
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
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? "展开导航栏" : "收窄导航栏"}
            aria-label={sidebarCollapsed ? "展开导航栏" : "收窄导航栏"}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={17} />
            ) : (
              <PanelLeftClose size={17} />
            )}
          </button>
        </div>
        <button
          className="sidebar-search"
          onClick={() => setPaletteOpen(true)}
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
            <span className="count">{workspace.hosts.length}</span>
          </button>
          {platform === "windows" && (
            <>
              <button
                className={
                  page === "local" && active === "home" ? "active" : ""
                }
                onClick={() => navigate("local")}
                title="本地 Shell"
                aria-label="本地 Shell"
              >
                <TerminalSquare size={18} />
                <span>本地 Shell</span>
              </button>
              <button
                className={
                  page === "wsl" && active === "home" ? "active" : ""
                }
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
            <span className="count">{terminalHistory.length}</span>
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
            onClick={newHost}
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
                    {workspace.hosts.filter((h) => h.group === g).length}
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
          <button
            onClick={() => setPreferencesOpen(true)}
            title="偏好设置"
            aria-label="偏好设置"
          >
            <Settings2 size={18} />
            <span>偏好设置</span>
          </button>
          <button
            className="icon-button"
            title="使用帮助"
            aria-label="使用帮助"
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp size={18} />
          </button>
        </div>
        <button
          className="sidebar-version"
          type="button"
          aria-label={`关于 Orbit SSH，版本 ${appVersion}`}
          aria-haspopup="dialog"
          onClick={() => setAboutOpen(true)}
        >
          <span>ORBIT SSH</span>
          <span>v{appVersion}</span>
        </button>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <Menu size={19} />
            </button>
            <strong>{activeSession ? "终端会话" : pageTitle}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              aria-label={dark ? "切换浅色模式" : "切换深色模式"}
              title={dark ? "切换浅色模式" : "切换深色模式"}
              onClick={() =>
                void savePreferences({
                  ...workspace.preferences,
                  theme: dark ? "light" : "dark",
                }).catch((e) => notify(errorText(e)))
              }
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>
        <div
          ref={tabbarRef}
          className="tabbar"
          role="tablist"
          aria-label="工作区标签"
          onKeyDown={moveTabFocus}
        >
          <button
            role="tab"
            aria-selected={active === "home"}
            className={`workspace-tab ${active === "home" ? "selected" : ""}`}
            onClick={() => setActive("home")}
          >
            {page === "hosts" ? (
              <Server size={15} />
            ) : page === "local" || page === "wsl" ? (
              <TerminalSquare size={15} />
            ) : (
              <History size={15} />
            )}
            {pageTitle}
          </button>
          {[...sessionGroups].map(([hostID, items]) => {
            const host = items[0].host;
            const selected = activeSession?.host.id === hostID;
            return (
              <div
                key={hostID}
                className={`session-tab host-tab ${selected ? "selected" : ""}`}
              >
                <button
                  role="tab"
                  aria-selected={selected}
                  aria-label={`${host.name} · ${items.length} 个会话`}
                  title={`${sessionAddress(items[0])} · ${items.length} 个会话`}
                  draggable
                  onClick={() => selectHostSessions(items)}
                  onDragStart={(event) => {
                    const remembered = lastActiveSessions.current.get(hostID);
                    startSessionDrag(
                      event,
                      items.find((session) => session.id === remembered)?.id ??
                        items[0].id,
                    );
                  }}
                  onDragEnd={() => setDraggedSessionId(null)}
                >
                  {items.some((s) => s.status === "connecting") ? (
                    <LoaderCircle
                      size={13}
                      className="spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      className={`status-dot ${items.some((s) => s.status === "connected") ? "" : "offline"}`}
                      aria-hidden="true"
                    />
                  )}
                  <span>{host.name}</span>
                  <span className="tab-number" aria-hidden="true">
                    {items.length}
                  </span>
                  {items[0].demo && <span className="tab-demo">体验</span>}
                </button>
                <button
                  className="tab-close"
                  aria-label={`关闭 ${host.name} 的全部会话`}
                  title="关闭这组终端的全部会话"
                  onClick={() => closeHostSessions(items)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <button
            className="tab-add"
            aria-label="选择主机新建终端"
            title="选择主机连接"
            onClick={() =>
              workspace.hosts.length ? setPaletteOpen(true) : newHost()
            }
          >
            <Plus size={17} />
          </button>
          <span className="tabbar-space" />
          <span className="tabbar-end">
            {sessions.length
              ? `${sessionGroups.size} 个终端组 · ${sessions.length} 个会话`
              : "无活动会话"}
          </span>
        </div>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {loading ? (
            <div className="full-state">
              <LoaderCircle className="spin" size={24} />
              <p>加载中…</p>
            </div>
          ) : loadError ? (
            <div className="full-state">
              <ShieldCheck size={30} />
              <h2>配置暂时无法读取</h2>
              <p>{loadError}</p>
              <button className="button primary" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : (
            <>
              <div className="dashboard-scroll" hidden={active !== "home"}>
                <div className="dashboard">
                  {page === "local" ? (
                    <LocalShellPage
                      layout={layout}
                      onLayoutChange={setHostLayout}
                      onOpen={(shell) => void openLocalShell(shell)}
                      sessions={sessions}
                    />
                  ) : page === "wsl" ? (
                    <WSLPage
                      layout={layout}
                      onLayoutChange={setHostLayout}
                      onOpen={(name) => void openWSLTerminal(name)}
                      sessions={sessions}
                    />
                  ) : page === "history" ? (
                    <TerminalHistoryPage
                      records={terminalHistory}
                      recordingEnabled={workspace.preferences.terminalHistoryEnabled}
                      onOpenSettings={() => setPreferencesOpen(true)}
                      onTogglePin={(record) =>
                        setHistoryPinned(record, !record.pinned)
                      }
                      onDelete={removeTerminalHistory}
                    />
                  ) : (
                    <div className="workspace-columns">
                      <div className="hosts-section">
                        <div className="section-heading hosts-heading">
                          <div>
                            <h1>{pageTitle}</h1>
                            <span className="subtle-count">
                              {workspace.hosts.length}
                            </span>
                          </div>
                          <button className="button primary" onClick={newHost}>
                            <Plus size={16} />
                            新建连接
                          </button>
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
                                onClick={() => setFilter(f.value)}
                              >
                                {f.label}
                              </button>
                            ))}
                          </div>
                          <div className="host-controls">
                            <LayoutSwitch
                              layout={layout}
                              onChange={setHostLayout}
                              label="主机布局"
                            />
                            <label className="host-search">
                              <Search size={14} />
                              <input
                                aria-label="筛选主机"
                                placeholder="搜索主机…"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                              />
                              {query && (
                                <button
                                  className="clear-search"
                                  aria-label="清空搜索"
                                  onClick={() => setQuery("")}
                                >
                                  <X size={12} />
                                </button>
                              )}
                            </label>
                          </div>
                        </div>
                        {workspace.hosts.length === 0 ? (
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
                            <button
                              className="button secondary"
                              onClick={newHost}
                            >
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
                                  (s) =>
                                    s.host.id === h.id &&
                                    s.status === "connected",
                                )}
                                onConnect={() => chooseHost(h)}
                                onEdit={() => setHostEditor({ host: h })}
                                onDelete={() => deleteHost(h)}
                                onFavorite={() =>
                                  void saveHost({
                                    ...h,
                                    favorite: !h.favorite,
                                  }).catch((e) => notify(errorText(e)))
                                }
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="search-empty">
                            <Search size={26} />
                            <h3>没有匹配的主机</h3>
                            <button
                              className="text-button"
                              onClick={() => {
                                setQuery("");
                                setFilter("all");
                                setGroup("");
                              }}
                            >
                              显示全部远程主机
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {!isDesktop() && (
                    <footer className="dashboard-footer">
                      <span>网页预览</span>
                    </footer>
                  )}
                </div>
              </div>
              <div
                className={`terminal-workspace ${filesOpen ? "file-mode" : ""}`}
                hidden={!activeSession}
              >
                {activeSession && (
                  <div
                    ref={sessionbarRef}
                    className="session-switcher"
                    role="tablist"
                    aria-label={`${activeSession.host.name} 的终端会话`}
                    onKeyDown={moveTabFocus}
                  >
                    {hostSessions.map((s) => (
                      <div
                        key={s.id}
                        className={`session-tab ${s.id === active ? "selected" : ""} ${splitMode && splitSessionIds.includes(s.id) ? "in-split" : ""} ${draggedSessionId === s.id ? "dragging-tab" : ""}`}
                      >
                        <button
                          role="tab"
                          aria-selected={s.id === active}
                          aria-label={`${s.host.name} · 终端 #${s.terminalNumber}`}
                          title={`终端 #${s.terminalNumber} · ${s.status === "connected" ? "已连接" : s.status === "connecting" ? "连接中" : "已断开"}`}
                          draggable
                          onClick={() => activateSession(s.id)}
                          onDragStart={(event) => startSessionDrag(event, s.id)}
                          onDragEnd={() => setDraggedSessionId(null)}
                        >
                          {s.status === "connecting" ? (
                            <LoaderCircle
                              size={13}
                              className="spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <span
                              className={`status-dot ${s.status === "closed" ? "offline" : ""}`}
                              aria-hidden="true"
                            />
                          )}
                          <span>终端 #{s.terminalNumber}</span>
                        </button>
                        <button
                          className="tab-close"
                          aria-label={`关闭 ${s.host.name} 终端 #${s.terminalNumber}`}
                          title={`关闭终端 #${s.terminalNumber}`}
                          onClick={() => closeSession(s)}
                        >
                          <X size={13} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                    <button
                      className="tab-add"
                      aria-label="为当前主机或 Shell 新建终端"
                      title="新建终端"
                      disabled={activeSession.status === "connecting"}
                      onClick={newTerminal}
                    >
                      <Plus size={16} aria-hidden="true" />
                    </button>
                  </div>
                )}
                <div className="terminal-toolbar">
                  <div>
                    <span
                      className={`status-dot ${activeSession?.status === "closed" ? "offline" : ""}`}
                    />
                    <code>
                      {activeSession?.localShell?.name ||
                        activeSession?.wslDistribution ||
                        `${activeSession?.host.username}@${activeSession?.host.address}`}
                    </code>
                    <span className="tag neutral">
                      {isLocalSession(activeSession)
                        ? `${activeSession?.wslDistribution ? "WSL" : "本地 Shell"} · ${activeSession?.status === "connected" ? "运行中" : activeSession?.status === "connecting" ? "启动中" : "已结束"}`
                        : activeSession?.demo
                          ? "本地演示"
                          : activeSession?.status === "connected"
                            ? "SSH · 已连接"
                            : activeSession?.status === "connecting"
                              ? "连接中"
                              : "已断开"}
                    </span>
                  </div>
                  <div>
                    <button
                      className="button toolbar-button new-terminal-button"
                      title="为当前主机或 Shell 新建终端"
                      disabled={activeSession?.status === "connecting"}
                      onClick={newTerminal}
                    >
                      <Plus size={16} aria-hidden="true" />
                      新建终端
                    </button>
                    <div className="split-control" ref={splitControlRef}>
                      <button
                        className={`button toolbar-button split-toggle ${splitMode ? "selected" : ""}`}
                        aria-label="终端布局"
                        aria-pressed={splitMode}
                        aria-expanded={splitPickerOpen}
                        aria-haspopup="dialog"
                        aria-controls="terminal-layout-picker"
                        title="终端布局与分屏"
                        disabled={!activeSession || activeSession.status === "connecting"}
                        onClick={() => setSplitPickerOpen((open) => !open)}
                      >
                        <Columns2 size={16} aria-hidden="true" />
                        <span>分屏</span>
                        {splitMode && <span className="split-count">{splitSessionIds.length}</span>}
                        <ChevronDown size={12} aria-hidden="true" />
                      </button>
                      {splitPickerOpen && (
                        <TerminalLayoutPicker
                          sessions={sessions}
                          activeId={active}
                          selectedIds={splitSelection}
                          layout={splitLayout}
                          compact={compactSplit}
                          onPreset={applySplitPreset}
                          onToggle={toggleSplitSession}
                          onEqualize={equalizePanes}
                          onNewTerminal={() => {
                            setSplitPickerOpen(false);
                            newTerminal();
                          }}
                        />
                      )}
                    </div>
                    <span className="toolbar-divider" />
                    <button
                      className="icon-button"
                      title="搜索终端 · Ctrl Shift F"
                      aria-label="搜索终端"
                      onClick={() =>
                        setTerminalSearch(terminalSearch === null ? "" : null)
                      }
                    >
                      <Search size={16} />
                    </button>
                    <button
                      className="icon-button"
                      title="粘贴剪贴板"
                      aria-label="粘贴剪贴板"
                      disabled={activeSession?.status !== "connected"}
                      onClick={() =>
                        handles.current.get(active)?.pasteFromClipboard()
                      }
                    >
                      <Clipboard size={16} />
                    </button>
                    <button
                      className={`icon-button ${terminalHistory.find((record) => record.id === activeSession?.id)?.pinned ? "selected" : ""}`}
                      title={terminalHistory.find((record) => record.id === activeSession?.id)?.pinned ? "取消精选历史" : "加入精选历史"}
                      aria-label={terminalHistory.find((record) => record.id === activeSession?.id)?.pinned ? "取消精选历史" : "加入精选历史"}
                      aria-pressed={Boolean(terminalHistory.find((record) => record.id === activeSession?.id)?.pinned)}
                      onClick={() => activeSession && toggleSessionHistory(activeSession)}
                    >
                      <Star
                        size={16}
                        fill={terminalHistory.find((record) => record.id === activeSession?.id)?.pinned ? "currentColor" : "none"}
                      />
                    </button>
                    <button
                      className="icon-button"
                      title="清空终端显示"
                      aria-label="清空终端显示"
                      onClick={() => handles.current.get(active)?.clear()}
                    >
                      <Trash2 size={16} />
                    </button>
                    <button
                      className="icon-button"
                      title="终端显示设置"
                      aria-label="终端显示设置"
                      onClick={() => setPreferencesOpen(true)}
                    >
                      <Settings2 size={16} />
                    </button>
                    {!isLocalSession(activeSession) && (
                      <>
                        <span className="toolbar-divider" />
                        <button
                          className={`button toolbar-button ${monitorOpen ? "selected" : ""}`}
                          aria-pressed={monitorOpen}
                          onClick={() => {
                            setMonitorOpen(!monitorOpen);
                            setFilesOpen(false);
                          }}
                        >
                          <Activity size={16} />
                          监控
                        </button>
                        <button
                          className={`button toolbar-button ${filesOpen ? "selected" : ""}`}
                          aria-pressed={filesOpen}
                          disabled={activeSession?.status !== "connected"}
                          onClick={() => {
                            setFilesOpen(!filesOpen);
                            setMonitorOpen(false);
                          }}
                        >
                          <FolderOpen size={16} />
                          文件
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div
                  className={`terminal-layout ${monitorOpen && monitorExpanded ? "monitor-expanded" : ""} ${filesOpen ? "files-expanded" : ""}`}
                >
                  <div
                    ref={terminalAreaRef}
                    className={`terminals ${splitMode ? `is-split ${compactSplit && !maximized ? "is-compact" : ""} ${maximized ? "is-maximized" : ""}` : ""}`}
                    inert={filesOpen || (monitorOpen && monitorExpanded)}
                  >
                    {terminalSearch !== null && activeSession && !filesOpen && (
                      <form
                        className="terminal-search"
                        onSubmit={(e) => {
                          e.preventDefault();
                          setSearchFound(
                            handles.current
                              .get(active)
                              ?.search(terminalSearch) ?? false,
                          );
                        }}
                      >
                        <Search size={15} />
                        <input
                          autoFocus
                          aria-label="终端搜索文本"
                          value={terminalSearch}
                          onChange={(e) => {
                            setTerminalSearch(e.target.value);
                            setSearchFound(
                              e.target.value
                                ? (handles.current
                                    .get(active)
                                    ?.search(e.target.value) ?? false)
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
                          onClick={() => setTerminalSearch(null)}
                        >
                          <X size={15} />
                        </button>
                      </form>
                    )}
                    <div
                      className="terminal-canvas"
                      style={{
                        minHeight: splitMode && compactSplit && !maximized
                          ? `${paneSessions.length * 240}px`
                          : undefined,
                      }}
                    >
                      {sessions.map((s) => {
                        const pane = paneGeometryById.get(s.id);
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
                            onPointerDown={
                              splitMode ? () => setActive(s.id) : undefined
                            }
                            onFocusCapture={
                              splitMode
                                ? (event) => {
                                    if ((event.target as HTMLElement).closest(".terminal-mount"))
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
                                  title={`${s.host.name} · 终端 #${s.terminalNumber} · 拖动调整位置，双击${maximized ? "还原" : "放大"}`}
                                  aria-label={`激活 ${s.host.name} 终端 #${s.terminalNumber}`}
                                  onClick={() => activateSession(s.id)}
                                  onDoubleClick={() => togglePaneMaximize(s.id)}
                                  onDragStart={(event) => startSessionDrag(event, s.id)}
                                  onDragEnd={() => setDraggedSessionId(null)}
                                >
                                  <GripVertical className="pane-drag-grip" size={13} aria-hidden="true" />
                                  <span className={`status-dot ${s.status === "closed" ? "offline" : ""}`} aria-hidden="true" />
                                  <strong>{s.host.name}</strong>
                                  <span className="pane-terminal-number">#{s.terminalNumber}</span>
                                </button>
                                <button
                                  className={`icon-button split-history-star ${terminalHistory.find((record) => record.id === s.id)?.pinned ? "selected" : ""}`}
                                  aria-label={terminalHistory.find((record) => record.id === s.id)?.pinned ? "取消精选历史" : "加入精选历史"}
                                  title={terminalHistory.find((record) => record.id === s.id)?.pinned ? "取消精选历史" : "加入精选历史"}
                                  aria-pressed={Boolean(terminalHistory.find((record) => record.id === s.id)?.pinned)}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleSessionHistory(s);
                                  }}
                                >
                                  <Star
                                    size={14}
                                    fill={terminalHistory.find((record) => record.id === s.id)?.pinned ? "currentColor" : "none"}
                                    aria-hidden="true"
                                  />
                                </button>
                                <button
                                  className="icon-button"
                                  aria-label={maximized ? "还原分屏布局" : `放大 ${s.host.name} 终端 #${s.terminalNumber}`}
                                  title={maximized ? "还原分屏布局" : "放大窗格 · 也可双击标题"}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    togglePaneMaximize(s.id);
                                  }}
                                >
                                  {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                                </button>
                                <button
                                  className="icon-button"
                                  aria-label={`收起 ${s.host.name} 终端 #${s.terminalNumber}`}
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
                                  canSplit={splitSessionIds.includes(draggedSessionId) || splitSessionIds.length < 4}
                                  compact={compactSplit}
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
                              active={
                                active === s.id &&
                                !modalOpen &&
                                !splitPickerOpen &&
                                !draggedSessionId &&
                                !filesOpen &&
                                !(monitorOpen && monitorExpanded)
                              }
                              dark={dark}
                              fontSize={workspace.preferences.fontSize}
                              lineHeight={workspace.preferences.lineHeight}
                              historyEnabled={workspace.preferences.terminalHistoryEnabled}
                              onHistoryOutput={recordTerminalOutput}
                              onZoom={zoomTerminal}
                              onClosed={(id, message) =>
                                setSessions((items) =>
                                  items.map((item) =>
                                    item.id === id
                                      ? {
                                          ...item,
                                          status: "closed",
                                          error: message,
                                        }
                                      : item,
                                  ),
                                )
                              }
                              onError={notify}
                              onPaste={(text) => pasteToTerminal(s.id, text)}
                              onSearch={() => {
                                setTerminalSearch("");
                                requestAnimationFrame(() =>
                                  document
                                    .querySelector<HTMLInputElement>(
                                      ".terminal-search input",
                                    )
                                    ?.focus(),
                                );
                              }}
                            />
                            {s.status === "closed" && (
                              <div className="reconnect-bar">
                                <span>
                                  {isLocalSession(s)
                                    ? "终端已结束"
                                    : "连接已结束"}
                                  {s.error ? ` · ${s.error}` : ""}
                                </span>
                                <button
                                  className="button secondary compact"
                                  onClick={() =>
                                    s.localShell
                                      ? void openLocalShell(s.localShell)
                                      : s.wslDistribution
                                        ? void openWSLTerminal(s.wslDistribution)
                                        : chooseHost(s.host)
                                  }
                                >
                                  {isLocalSession(s) ? "重新打开" : "重新连接"}
                                  <ArrowRight size={13} />
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {splitMode && !maximized &&
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
                              width:
                                divider.axis === "x"
                                  ? "7px"
                                  : `${divider.width * 100}%`,
                              height:
                                divider.axis === "x"
                                  ? `${divider.height * 100}%`
                                  : "7px",
                            }}
                            onPointerDown={(event) => {
                              if (divider.resizable !== false)
                                startSplitResize(event, divider);
                            }}
                            onDoubleClick={() => {
                              if (divider.resizable !== false)
                                setSplitLayout((current) => current ? updateSplitRatio(current, divider.path, 0.5) : current);
                            }}
                            onKeyDown={(event) => {
                              if (divider.resizable === false) return;
                              const negative =
                                (divider.axis === "x" &&
                                  event.key === "ArrowLeft") ||
                                (divider.axis === "y" &&
                                  event.key === "ArrowUp");
                              const positive =
                                (divider.axis === "x" &&
                                  event.key === "ArrowRight") ||
                                (divider.axis === "y" &&
                                  event.key === "ArrowDown");
                              if (event.key === "Home") {
                                event.preventDefault();
                                setSplitLayout((current) => current ? updateSplitRatio(current, divider.path, 0.5) : current);
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
                        {splitSessionIds.length >= 4 && !splitSessionIds.includes(draggedSessionId)
                          ? "已显示 4 个窗格，拖入窗格可替换终端"
                          : `拖到边缘分屏，拖到中间${splitSessionIds.includes(draggedSessionId) ? "交换" : "替换"}`}
                        <kbd>Esc</kbd><span>取消</span>
                      </div>
                    )}
                  </div>
                  {monitorOpen &&
                    activeSession &&
                    !isLocalSession(activeSession) && (
                      <MonitorPanel
                        key={activeSession.id}
                        session={activeSession}
                        expanded={monitorExpanded}
                        onExpand={() => setMonitorExpanded((v) => !v)}
                        onClose={() => setMonitorOpen(false)}
                      />
                    )}
                  {filesOpen &&
                    activeSession &&
                    !isLocalSession(activeSession) && (
                      <FilesPane
                        key={activeSession.id}
                        session={activeSession}
                        onClose={() => setFilesOpen(false)}
                        notify={notify}
                      />
                    )}
                </div>
                <div className="terminal-status">
                  <span>
                    {isLocalSession(activeSession) ? (
                      <TerminalSquare size={12} />
                    ) : (
                      <ShieldCheck size={12} />
                    )}
                    {activeSession?.localShell
                      ? `${activeSession.localShell.name} · 本地终端`
                      : activeSession?.wslDistribution
                        ? "WSL 本地终端"
                        : activeSession?.demo
                          ? "本地体验终端"
                          : "SSH 加密通道"}
                  </span>
                  <span>
                    UTF-8<span>·</span>xterm-256color<span>·</span>
                    <span
                      className="terminal-zoom"
                      role="group"
                      aria-label="终端缩放"
                    >
                      <button
                        aria-label="缩小终端字号"
                        title="缩小 · Ctrl −"
                        disabled={workspace.preferences.fontSize <= 11}
                        onClick={() => zoomTerminal(-1)}
                      >
                        −
                      </button>
                      <button
                        aria-label="恢复默认终端字号"
                        title="恢复默认字号 · Ctrl 0"
                        onClick={() => zoomTerminal(0)}
                      >
                        {workspace.preferences.fontSize} px
                      </button>
                      <button
                        aria-label="放大终端字号"
                        title="放大 · Ctrl +"
                        disabled={workspace.preferences.fontSize >= 22}
                        onClick={() => zoomTerminal(1)}
                      >
                        +
                      </button>
                    </span>
                  </span>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
      {hostEditor && (
        <HostDialog
          host={hostEditor.host}
          isNew={hostEditor.isNew}
          groups={groups}
          onSave={saveHost}
          onClose={() => setHostEditor(null)}
        />
      )}
      {connectHost && (
        <ConnectDialog
          key={connectHost.id}
          host={connectHost}
          onConnect={connect}
          onClose={() => {
            pendingSplitRef.current = null;
            const id = connectingID.current;
            connectingID.current = null;
            if (id)
              void backend()
                .Disconnect(id)
                .catch(() => {});
            setConnectHost(null);
            requestAnimationFrame(() => handles.current.get(active)?.focus());
          }}
        />
      )}
      {preferencesOpen && (
        <PreferencesDialog
          preferences={workspace.preferences}
          platform={platform}
          onChange={savePreferences}
          onClose={() => setPreferencesOpen(false)}
        />
      )}
      {aboutOpen && (
        <Modal
          title="关于 Orbit SSH"
          onClose={() => setAboutOpen(false)}
          className="about-dialog"
        >
          <div className="about-info">
            <div className="about-version-row">
              <span>版本</span>
              <strong>v{appVersion}</strong>
            </div>
            <a
              className="about-repository-link"
              href={projectURL}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (isDesktop()) {
                  event.preventDefault();
                  BrowserOpenURL(projectURL);
                }
              }}
            >
              <Github size={17} aria-hidden="true" />
              <span>{projectURL.replace("https://", "")}</span>
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <p className="about-license">许可协议：The Unlicense</p>
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              onClick={() => setAboutOpen(false)}
            >
              关闭
            </button>
          </div>
        </Modal>
      )}
      {paletteOpen && (
        <CommandPalette
          hosts={workspace.hosts}
          onSelect={chooseHost}
          onNew={newHost}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {helpOpen && (
        <Modal title="快捷键" onClose={() => setHelpOpen(false)}>
          <div className="help-shortcuts">
            <div>
              <span>快速切换</span>
              <kbd>Ctrl / ⌘ K</kbd>
            </div>
            <div>
              <span>新建连接</span>
              <kbd>Ctrl / ⌘ T</kbd>
            </div>
            <div>
              <span>搜索终端</span>
              <kbd>Ctrl / ⌘ Shift F</kbd>
            </div>
            <div>
              <span>复制选中 / 粘贴</span>
              <kbd>Ctrl / ⌘ C / V</kbd>
            </div>
            <div>
              <span>复制 / 粘贴（终端）</span>
              <kbd>Ctrl Shift C / V</kbd>
            </div>
            <div>
              <span>全选终端</span>
              <kbd>Ctrl Shift A / ⌘ A</kbd>
            </div>
            <div>
              <span>保存文件</span>
              <kbd>Ctrl / ⌘ S</kbd>
            </div>
            <div>
              <span>终端缩放 / 复原</span>
              <kbd>Ctrl + / − / 0</kbd>
            </div>
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              onClick={() => setHelpOpen(false)}
            >
              关闭
            </button>
          </div>
        </Modal>
      )}
      {confirmation && (
        <ConfirmDialog
          title={confirmation.title}
          message={confirmation.message}
          action={confirmation.action}
          danger={confirmation.danger}
          onConfirm={confirmation.run}
          onClose={() => setConfirmation(null)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={15} />
          </span>
          <p>{toast}</p>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function HostCard({
  host,
  online,
  onConnect,
  onEdit,
  onDelete,
  onFavorite,
}: {
  host: Host;
  online: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onFavorite: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function outside(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <article
      className="host-card"
      title={online ? "双击新建终端" : "双击连接"}
      onDoubleClick={(e) => {
        if (
          e.target instanceof Element &&
          e.target.closest("button, .card-menu-wrap")
        )
          return;
        onConnect();
      }}
    >
      <div className="host-card-top">
        <span className={`host-icon ${host.color}`}>
          <Server size={22} strokeWidth={1.6} />
        </span>
        <div className="host-card-title">
          <button onClick={(e) => e.detail < 2 && onConnect()}>
            <h3>{host.name}</h3>
          </button>
          {host.group && host.group !== "默认分组" && <span>{host.group}</span>}
        </div>
        <button
          className={`icon-button favorite ${host.favorite ? "is-favorite" : ""}`}
          aria-label={`${host.favorite ? "取消收藏" : "收藏"} ${host.name}`}
          aria-pressed={host.favorite}
          title={host.favorite ? "取消收藏" : "收藏主机"}
          onClick={onFavorite}
        >
          <Star size={16} fill={host.favorite ? "currentColor" : "none"} />
        </button>
        <div className="card-menu-wrap" ref={ref}>
          <button
            className="icon-button"
            aria-label={`${host.name} 的更多操作`}
            aria-expanded={menuOpen}
            title="更多操作"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Ellipsis size={18} />
          </button>
          {menuOpen && (
            <div className="card-menu">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
              >
                <Pencil size={14} />
                编辑主机
              </button>
              <button
                className="delete"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              >
                <Trash2 size={14} />
                移除主机
              </button>
            </div>
          )}
        </div>
      </div>
      <code className="host-card-address">
        {host.username}@{host.address}:{host.port}
      </code>
      <div className="host-card-bottom">
        <span>
          <span className={`status-dot ${online ? "" : "offline"}`} />
          {online
            ? "已连接"
            : host.authType === "key"
              ? "密钥认证"
              : "密码认证"}
        </span>
        <button onClick={(e) => e.detail < 2 && onConnect()}>
          {online ? "新建终端" : "连接"}
          <ArrowUpRight size={14} />
        </button>
      </div>
    </article>
  );
}
