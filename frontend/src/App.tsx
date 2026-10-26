import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Check,
  FolderOpen,
  History,
  LoaderCircle,
  Menu,
  Maximize2,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Star,
  TerminalSquare,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import type {
  Host,
  Credentials,
  MCPCommandRequest,
  Preferences,
  Session,
  TerminalHandle,
  Workspace,
} from "./types";
import {
  backend,
  defaults,
  errorText,
  isDesktop,
  loadWorkspace,
  listen,
  savePreview,
} from "./bridge";
import {
  AboutDialog,
  CommandPalette,
  ConfirmDialog,
  ConnectDialog,
  HelpDialog,
  HostDialog,
  MCPCommandDialog,
  Modal,
  PreferencesDialog,
  RenameSessionDialog,
  SSHConfigDialog,
} from "./dialogs";
import { isApprovalExpired } from "./mcpApproval";
import TerminalLayoutControl from "./TerminalLayoutControl";
import TerminalFocusBar from "./TerminalFocusBar";
import SessionTabs from "./SessionTabs";
import FilesPane from "./FilesPane";
import MonitorPanel from "./MonitorPanel";
import WSLPage from "./WSLPage";
import LocalShellPage from "./LocalShellPage";
import { matchesShortcut, usesMacShortcuts } from "./shortcuts";
import TerminalHistoryPage from "./TerminalHistoryPage";
import WorkflowPage from "./WorkflowPage";
import { useTerminalHistory } from "./hooks/useTerminalHistory";
import { useTerminalLayout } from "./hooks/useTerminalLayout";
import TerminalCanvas from "./TerminalCanvas";
import {
  isLocalSession,
  sessionAddress,
  sessionDefaultName,
  sessionDetailLabel,
  sessionHeading,
} from "./sessions";
import AppSidebar from "./AppSidebar";
import HostsPage from "./HostsPage";
import type { HostFilter } from "./HostsPage";
import type { Workflow as WorkflowDefinition } from "./workflows";
import { moveTabFocus, pageNames } from "./navigation";
import type { Page } from "./navigation";
import { useSessionConnections } from "./hooks/useSessionConnections";
import { useMCPConnections } from "./hooks/useMCPConnections";
import { useTerminalViewport } from "./hooks/useTerminalViewport";

interface Confirmation {
  title: string;
  message: string;
  action: string;
  danger?: boolean;
  run: () => Promise<void> | void;
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>(defaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [page, setPage] = useState<Page>("hosts");
  const [group, setGroup] = useState("");
  const pageTitle = (page === "hosts" && group) || pageNames[page];

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HostFilter>("all");
  const layout = workspace.preferences.hostLayout === "list" ? "list" : "grid";
  const [platform, setPlatform] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);

  const [active, setActive] = useState("home");

  const [hostEditor, setHostEditor] = useState<{
    host?: Host;
    isNew?: boolean;
  } | null>(null);
  const [connectHost, setConnectHost] = useState<Host | null>(null);
  const [reconnectSession, setReconnectSession] = useState<Session | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workflowFocusID, setWorkflowFocusID] = useState("");
  const [historyFocusID, setHistoryFocusID] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [sshConfigOpen, setSSHConfigOpen] = useState(false);
  const [mcpCommand, setMCPCommand] = useState<MCPCommandRequest | null>(null);
  const [mcpServiceOn, setMcpServiceOn] = useState(false);
  const [mcpUnrestricted, setMcpUnrestricted] = useState<
    Record<string, boolean>
  >({});
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    name: string;
    defaultName: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [toast, setToast] = useState("");
  const [systemDark, setSystemDark] = useState(
    matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [filesOpen, setFilesOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [monitorExpanded, setMonitorExpanded] = useState(false);
  const [workflowPanelOpen, setWorkflowPanelOpen] = useState(false);
  const [workflowHostPicker, setWorkflowHostPicker] =
    useState<WorkflowDefinition | null>(null);
  const [pendingWorkflowLaunch, setPendingWorkflowLaunch] = useState<{
    workflowID: string;
    hostID: string;
  } | null>(null);
  const [workflowLoadRequest, setWorkflowLoadRequest] = useState<{
    workflowID: string;
    token: number;
  } | null>(null);
  const workflowLoadToken = useRef(0);
  const workflowConnectSucceeded = useRef(false);
  const [terminalSearch, setTerminalSearch] = useState<string | null>(null);
  const [terminalToolsOpen, setTerminalToolsOpen] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("orbit-ssh-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const handles = useRef(new Map<string, TerminalHandle>());

  const preferenceWrites = useRef<Promise<void>>(Promise.resolve());

  const lastActiveSessions = useRef(new Map<string, string>());
  const tabbarRef = useRef<HTMLDivElement>(null);
  const sessionbarRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const stateRef = useRef(workspace);
  stateRef.current = workspace;
  const activeSession = sessions.find((s) => s.id === active);

  const sessionGroups = new Map<string, Session[]>();
  for (const session of sessions) {
    const items = sessionGroups.get(session.host.id);
    if (items) items.push(session);
    else sessionGroups.set(session.host.id, [session]);
  }
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
    sshConfigOpen ||
    mcpCommand ||
    renameTarget ||
    confirmation ||
    workflowHostPicker,
  );
  const viewport = useTerminalViewport(
    Boolean(activeSession) && !filesOpen,
    modalOpen,
  );
  const focusToolbar = viewport.mobile || viewport.fullscreen;
  useEffect(() => {
    setTerminalToolsOpen(false);
  }, [active, viewport.fullscreen, filesOpen, modalOpen]);
  useEffect(() => {
    if (!terminalToolsOpen) return;
    function close(event: PointerEvent) {
      if (
        !(event.target as HTMLElement).closest(
          ".terminal-toolbar, .terminal-focus-bar",
        )
      )
        setTerminalToolsOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setTerminalToolsOpen(false);
      }
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [terminalToolsOpen]);

  const {
    terminalHistory,
    recordTerminalOutput,
    setHistoryPinned,
    toggleSessionHistory,
    renameTerminalHistory,
    removeTerminalHistory,
  } = useTerminalHistory({
    loading,
    preferences: workspace.preferences,
    sessionsRef,
    handles,
    notify,
  });
  const renameTerminalHistoryRef = useRef(renameTerminalHistory);
  renameTerminalHistoryRef.current = renameTerminalHistory;
  const terminalLayout = useTerminalLayout({
    sessions,
    active,
    setActive,
    handles,
    canFocus: !modalOpen && !filesOpen,
    filesOpen,
    notify,
    onNewTerminal: newTerminal,
    focusPane:
      viewport.mobile && (viewport.fullscreen || viewport.keyboardVisible),
  });
  const {
    setDraggedSessionId,
    pendingSplitRef,
    startSessionDrag,
    activateSession,
  } = terminalLayout;

  const {
    connect,
    reconnect,
    openWSLTerminal,
    openLocalShell,
    removeSession,
    removeSessions,
    cancelConnection,
    onSessionClosed,
  } = useSessionConnections({
    sessionsRef,
    setSessions,
    active,
    setActive,
    handles,
    layout: terminalLayout,
    stateRef,
    update,
    notify,
    onOpenLocal: () => {
      setSidebarOpen(false);
      setFilesOpen(false);
      setMonitorOpen(false);
      setMonitorExpanded(false);
      setTerminalSearch(null);
    },
  });

  useMCPConnections({
    enabled: !loading,
    connect,
    onHost: (host) => {
      const previous = stateRef.current;
      update({
        ...previous,
        hosts: previous.hosts.some((item) => item.id === host.id)
          ? previous.hosts.map((item) => (item.id === host.id ? host : item))
          : [...previous.hosts, host],
      });
    },
    onOpen: () => {
      setSidebarOpen(false);
      setFilesOpen(false);
      setMonitorExpanded(false);
      setTerminalSearch(null);
    },
    notify,
  });

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
    const offNotice = listen("ssh:notice", (message) =>
      notify(String(message)),
    );
    const offMCPCommand = listen("mcp:command-request", (value) => {
      const request = value as MCPCommandRequest;
      if (request?.id && !isApprovalExpired(request))
        setMCPCommand((prev) => prev ?? request);
    });
    const offMCPDecided = listen("mcp:command-decided", (value) => {
      const event = value as { id?: string };
      if (!event?.id) return;
      setMCPCommand((prev) => (prev && prev.id === event.id ? null : prev));
      if (isDesktop())
        void backend()
          .ListMCPCommands()
          .then((items) => {
            const next = items?.find(
              (item) => item.id !== event.id && !isApprovalExpired(item),
            );
            if (next?.id)
              setMCPCommand((prev) =>
                !prev || prev.id === event.id ? next : prev,
              );
          })
          .catch(() => {});
    });
    const offRenamed = listen("session:renamed", (value) => {
      const event = value as { sessionId?: string; name?: string };
      if (!event?.sessionId) return;
      const name = event.name?.trim() || undefined;
      setSessions((items) =>
        items.map((item) =>
          item.id === event.sessionId ? { ...item, name } : item,
        ),
      );
      renameTerminalHistoryRef.current(event.sessionId, name ?? "");
    });
    if (isDesktop())
      void backend()
        .GetPlatform()
        .then(setPlatform)
        .catch(() => {});
    if (isDesktop())
      void backend()
        .ListMCPCommands()
        .then((items) => {
          const first = items?.find((item) => !isApprovalExpired(item));
          if (first?.id) setMCPCommand((prev) => prev ?? first);
        })
        .catch(() => {});
    return () => {
      offNotice();
      offMCPCommand();
      offMCPDecided();
      offRenamed();
      clearTimeout(toastTimer.current);
    };
  }, []);

  // MCP 服务在运行时，终端工具栏才提供"完全放行"，使得当前窗口的命令
  // 不再排队等待用户确认。偏好关闭或服务停止时选项随之隐藏，新窗口
  // 永远回到默认的逐条审核状态。
  useEffect(() => {
    if (!isDesktop() || !workspace.preferences.mcpEnabled) {
      setMcpServiceOn(false);
      return;
    }
    let cancelled = false;
    const check = () =>
      backend()
        .GetMCPStatus()
        .then((status) => {
          if (!cancelled)
            setMcpServiceOn(Boolean(status.running && status.allowInput));
        })
        .catch(() => {
          if (!cancelled) setMcpServiceOn(false);
        });
    check();
    // The server starts asynchronously at app launch; re-check shortly after.
    const timer = setInterval(check, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    workspace.preferences.mcpEnabled,
    workspace.preferences.mcpAllowTerminalInput,
    workspace.preferences.mcpPort,
  ]);

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
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    if (!activeSession || activeSession.demo || isLocalSession(activeSession)) {
      setFilesOpen(false);
      setMonitorOpen(false);
      setMonitorExpanded(false);
      setWorkflowPanelOpen(false);
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
    if (!pendingWorkflowLaunch) return;
    const session = [...sessions]
      .reverse()
      .find(
        (item) =>
          item.host.id === pendingWorkflowLaunch.hostID &&
          item.status === "connected" &&
          !item.demo &&
          !isLocalSession(item),
      );
    if (!session) return;
    setPendingWorkflowLaunch(null);
    loadWorkflowInSession(pendingWorkflowLaunch.workflowID, session.id);
  }, [pendingWorkflowLaunch, sessions]);
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
      if (
        matchesShortcut(e, shortcuts.closeSession, platform) &&
        activeSession
      ) {
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
    setReconnectSession(null);
    setConnectHost(host);
  }

  function loadWorkflowInSession(workflowID: string, sessionID: string) {
    setActive(sessionID);
    setFilesOpen(false);
    setMonitorOpen(false);
    setMonitorExpanded(false);
    setWorkflowLoadRequest({ workflowID, token: ++workflowLoadToken.current });
    setWorkflowPanelOpen(true);
    setWorkflowHostPicker(null);
  }

  function chooseWorkflowHost(host: Host) {
    const workflow = workflowHostPicker;
    if (!workflow) return;
    if (!isDesktop()) {
      setWorkflowHostPicker(null);
      notify("请使用桌面版连接 SSH 并执行工作流。");
      return;
    }
    const connected = sessionsRef.current.filter(
      (session) =>
        session.host.id === host.id &&
        session.status === "connected" &&
        !session.demo &&
        !isLocalSession(session),
    );
    const remembered = lastActiveSessions.current.get(host.id);
    const session =
      connected.find((item) => item.id === remembered) ?? connected.at(-1);
    if (session) {
      loadWorkflowInSession(workflow.id, session.id);
      return;
    }
    workflowConnectSucceeded.current = false;
    setPendingWorkflowLaunch({ workflowID: workflow.id, hostID: host.id });
    setWorkflowHostPicker(null);
    chooseHost(host);
  }

  async function connectFromDialog(
    host: Host,
    credentials: Credentials,
    fingerprint: string,
  ) {
    if (reconnectSession)
      await reconnect(reconnectSession, host, credentials, fingerprint);
    else await connect(host, credentials, fingerprint);
    if (pendingWorkflowLaunch?.hostID === host.id)
      workflowConnectSucceeded.current = true;
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
  function openRenameSession(session: Session) {
    setRenameTarget({
      id: session.id,
      name: session.name ?? "",
      defaultName: sessionDefaultName(session),
    });
  }
  async function toggleSessionMCPUnrestricted(session: Session) {
    const unrestricted = !mcpUnrestricted[session.id];
    try {
      await backend().SetSessionMCPUnrestricted(session.id, unrestricted);
      setMcpUnrestricted((prev) => ({ ...prev, [session.id]: unrestricted }));
      notify(
        unrestricted
          ? "已对该终端完全放行：AI 在此窗口执行命令不再需要确认"
          : "已恢复该终端的 MCP 命令审核",
      );
    } catch (e) {
      notify(`无法更新完全放行状态：${errorText(e)}`);
    }
  }
  async function saveSessionName(id: string, name: string) {
    const session = sessionsRef.current.find((item) => item.id === id);
    if (session) {
      if (isDesktop()) await backend().RenameSession(id, name);
      setSessions((items) =>
        items.map((item) =>
          item.id === id ? { ...item, name: name || undefined } : item,
        ),
      );
      renameTerminalHistory(id, name);
      notify(name ? `终端已重命名为 ${name}` : "已恢复默认名称");
      return;
    }
    renameTerminalHistory(id, name);
    notify(name ? `历史记录已重命名为 ${name}` : "已恢复历史记录默认名称");
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
          ? `将结束 ${sessionDetailLabel(session)}，前台任务会中断。`
          : `将关闭 ${sessionDetailLabel(session)}，此终端的文件传输和前台任务会中断。`,
        action: isLocalSession(session) ? "结束终端" : "断开连接",
        run: () => removeSession(session.id),
      });
    else void removeSession(session.id).catch((e) => notify(errorText(e)));
  }
  function closeTerminalTab(items: Session[]) {
    if (items.length === 1) {
      closeSession(items[0]);
      return;
    }
    const run = () => removeSessions(items);
    if (
      workspace.preferences.confirmClose &&
      items.some((session) => !session.demo && session.status !== "closed")
    ) {
      setConfirmation({
        title: "关闭这组分屏？",
        message: `将关闭此组合的 ${items.length} 个终端，前台任务和文件传输会中断。`,
        action: "关闭分屏会话",
        run,
      });
    } else void run().catch((error) => notify(errorText(error)));
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
  function runWorkflowCommand(sessionId: string, command: string) {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (
      !session ||
      session.status !== "connected" ||
      session.demo ||
      isLocalSession(session)
    )
      throw new Error("所选 SSH 终端已断开，请重新选择");
    const handle = handles.current.get(sessionId);
    if (!handle?.ready()) throw new Error("终端尚未准备好，请稍后重试");
    handle.send(`${command}\r`);
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
          hosts: stateRef.current.hosts
            .filter((h) => h.id !== host.id)
            .map((h) =>
              h.jumpHostId === host.id ? { ...h, jumpHostId: undefined } : h,
            ),
        });
        notify("主机已移除");
      },
    });
  }

  return (
    <div
      className={`app ${sidebarOpen ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${viewport.mobile && activeSession ? "is-mobile-terminal" : ""} ${viewport.fullscreen ? "terminal-fullscreen" : ""} ${viewport.keyboardVisible ? "terminal-keyboard-visible" : ""}`}
      style={{ height: viewport.viewportHeight }}
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
      <AppSidebar
        hosts={workspace.hosts}
        page={page}
        group={group}
        active={active}
        platform={platform}
        historyCount={terminalHistory.length}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
        navigate={navigate}
        onNewHost={newHost}
        onPalette={() => setPaletteOpen(true)}
        dark={dark}
        onToggleTheme={() =>
          void savePreferences({
            ...workspace.preferences,
            theme: dark ? "light" : "dark",
          }).catch((e) => notify(errorText(e)))
        }
        onPreferences={() => setPreferencesOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onAbout={() => setAboutOpen(true)}
      />

      <div className="app-body">
        <div className="workspace-bar">
          <button
            className="icon-button mobile-menu"
            aria-label="打开导航"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Menu size={19} />
          </button>
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
              ) : page === "workflows" ? (
                <Workflow size={15} />
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
                        items.find((session) => session.id === remembered)
                          ?.id ?? items[0].id,
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
                  <div
                    className="workflow-page-slot"
                    hidden={page !== "workflows"}
                  >
                    <WorkflowPage
                      sessions={sessions}
                      activeSessionId={activeSession?.id ?? ""}
                      initialWorkflowID={workflowFocusID}
                      onRunCommand={runWorkflowCommand}
                      onViewTerminal={setActive}
                      onExecuteWorkflow={setWorkflowHostPicker}
                    />
                  </div>
                  <div hidden={page === "workflows"}>
                    {page === "local" ? (
                      <LocalShellPage
                        layout={layout}
                        onLayoutChange={setHostLayout}
                        onOpen={(shell) => void openLocalShell(shell)}
                        sessions={sessions}
                        platform={platform}
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
                        recordingEnabled={
                          workspace.preferences.terminalHistoryEnabled
                        }
                        focusID={historyFocusID}
                        onOpenSettings={() => setPreferencesOpen(true)}
                        onTogglePin={(record) =>
                          setHistoryPinned(record, !record.pinned)
                        }
                        onRename={(record) =>
                          setRenameTarget({
                            id: record.id,
                            name: record.name ?? "",
                            defaultName: `${record.title} · 终端 #${record.terminalNumber}`,
                          })
                        }
                        onDelete={removeTerminalHistory}
                      />
                    ) : (
                      <HostsPage
                        hosts={workspace.hosts}
                        sessions={sessions}
                        title={pageTitle}
                        group={group}
                        query={query}
                        filter={filter}
                        layout={layout}
                        onFilterChange={setFilter}
                        onQueryChange={setQuery}
                        onLayoutChange={setHostLayout}
                        onNew={newHost}
                        onConnect={chooseHost}
                        onEdit={(host) => setHostEditor({ host })}
                        onDelete={deleteHost}
                        onFavorite={(host) =>
                          void saveHost({
                            ...host,
                            favorite: !host.favorite,
                          }).catch((error) => notify(errorText(error)))
                        }
                        onShowAll={() => {
                          setQuery("");
                          setFilter("all");
                          setGroup("");
                        }}
                        onImportSSHConfig={() => {
                          if (!isDesktop()) {
                            notify("请在桌面版中导入 ~/.ssh/config");
                            return;
                          }
                          setSSHConfigOpen(true);
                        }}
                        onExport={() => {
                          if (!isDesktop()) {
                            notify("请在桌面版中导出主机配置");
                            return;
                          }
                          void backend()
                            .ExportHosts()
                            .then((path) => path && notify(`已导出到 ${path}`))
                            .catch((error) => notify(errorText(error)));
                        }}
                        onNotify={notify}
                        onImport={() => {
                          if (!isDesktop()) {
                            notify("请在桌面版中导入主机配置");
                            return;
                          }
                          void backend()
                            .ImportHosts()
                            .then(async (result) => {
                              await load();
                              notify(
                                `已导入 ${result.added} 台主机${result.updated ? `，更新 ${result.updated} 台` : ""}${result.skipped ? `，跳过 ${result.skipped} 台` : ""}`,
                              );
                            })
                            .catch((error) => notify(errorText(error)));
                        }}
                      />
                    )}

                    {!isDesktop() && (
                      <footer className="dashboard-footer">
                        <span>网页预览</span>
                      </footer>
                    )}
                  </div>
                </div>
              </div>
              <div
                className={`terminal-workspace ${filesOpen ? "file-mode" : ""}`}
                hidden={!activeSession}
              >
                {activeSession && focusToolbar && (
                  <TerminalFocusBar
                    sessions={sessions}
                    active={active}
                    layout={terminalLayout}
                    fullscreen={viewport.fullscreen}
                    onFullscreen={viewport.toggleFullscreen}
                    onNavigate={() => setSidebarOpen(true)}
                    toolsOpen={terminalToolsOpen}
                    onTools={() => setTerminalToolsOpen((open) => !open)}
                  >
                    <TerminalLayoutControl
                      sessions={sessions}
                      active={active}
                      layout={terminalLayout}
                      onNewTerminal={newTerminal}
                    />
                  </TerminalFocusBar>
                )}
                {activeSession && (
                  <div
                    ref={sessionbarRef}
                    className="session-switcher"
                    role="tablist"
                    aria-label={`${activeSession.host.name} 的终端会话`}
                    onKeyDown={moveTabFocus}
                  >
                    <SessionTabs
                      sessions={sessions}
                      hostId={activeSession.host.id}
                      active={active}
                      layout={terminalLayout}
                      onClose={closeTerminalTab}
                      onRename={openRenameSession}
                    />
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
                <div
                  className={`terminal-toolbar ${terminalToolsOpen ? "mobile-tools-open" : ""}`}
                >
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
                    {!focusToolbar && (
                      <TerminalLayoutControl
                        sessions={sessions}
                        active={active}
                        layout={terminalLayout}
                        onNewTerminal={newTerminal}
                      />
                    )}
                    {!focusToolbar && (
                      <button
                        className="icon-button"
                        aria-label="终端全屏"
                        title="全屏终端"
                        onClick={viewport.toggleFullscreen}
                      >
                        <Maximize2 size={16} />
                      </button>
                    )}
                    <span className="toolbar-divider" />
                    <button
                      className="icon-button"
                      title="重命名终端"
                      aria-label="重命名终端"
                      disabled={!activeSession}
                      onClick={() =>
                        activeSession && openRenameSession(activeSession)
                      }
                    >
                      <Pencil size={16} />
                    </button>
                    {mcpServiceOn && (
                      <button
                        className={`icon-button ${activeSession && mcpUnrestricted[activeSession.id] ? "selected" : ""}`}
                        title={
                          activeSession && mcpUnrestricted[activeSession.id]
                            ? "完全放行已开启：AI 在此终端执行命令不再需要确认"
                            : "对当前终端完全放行（AI 执行命令免确认）"
                        }
                        aria-label="MCP 完全放行"
                        aria-pressed={Boolean(
                          activeSession && mcpUnrestricted[activeSession.id],
                        )}
                        disabled={activeSession?.status !== "connected"}
                        onClick={() =>
                          activeSession &&
                          void toggleSessionMCPUnrestricted(activeSession)
                        }
                      >
                        <ShieldCheck size={16} />
                      </button>
                    )}
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
                      className={`icon-button ${terminalHistory.find((record) => record.id === activeSession?.id)?.pinned ? "selected" : ""}`}
                      title={
                        terminalHistory.find(
                          (record) => record.id === activeSession?.id,
                        )?.pinned
                          ? "取消精选历史"
                          : "加入精选历史"
                      }
                      aria-label={
                        terminalHistory.find(
                          (record) => record.id === activeSession?.id,
                        )?.pinned
                          ? "取消精选历史"
                          : "加入精选历史"
                      }
                      aria-pressed={Boolean(
                        terminalHistory.find(
                          (record) => record.id === activeSession?.id,
                        )?.pinned,
                      )}
                      onClick={() =>
                        activeSession && toggleSessionHistory(activeSession)
                      }
                    >
                      <Star
                        size={16}
                        fill={
                          terminalHistory.find(
                            (record) => record.id === activeSession?.id,
                          )?.pinned
                            ? "currentColor"
                            : "none"
                        }
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
                    {!isLocalSession(activeSession) && (
                      <>
                        <span className="toolbar-divider" />
                        <button
                          className={`button toolbar-button ${monitorOpen ? "selected" : ""}`}
                          aria-pressed={monitorOpen}
                          onClick={() => {
                            setMonitorOpen(!monitorOpen);
                            setFilesOpen(false);
                            setWorkflowPanelOpen(false);
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
                            setWorkflowPanelOpen(false);
                          }}
                        >
                          <FolderOpen size={16} />
                          文件
                        </button>
                        <button
                          className={`button toolbar-button ${workflowPanelOpen ? "selected" : ""}`}
                          aria-pressed={workflowPanelOpen}
                          disabled={Boolean(activeSession?.demo)}
                          onClick={() => {
                            const open = !workflowPanelOpen;
                            setWorkflowPanelOpen(open);
                            setFilesOpen(false);
                            setMonitorOpen(false);
                            setMonitorExpanded(false);
                          }}
                        >
                          <Workflow size={16} />
                          工作流
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div
                  className={`terminal-layout ${monitorOpen && monitorExpanded ? "monitor-expanded" : ""} ${filesOpen ? "files-expanded" : ""} ${workflowPanelOpen ? "workflow-panel-open" : ""}`}
                >
                  <TerminalCanvas
                    sessions={sessions}
                    active={active}
                    setActive={setActive}
                    layout={terminalLayout}
                    handles={handles}
                    preferences={workspace.preferences}
                    dark={dark}
                    suspended={modalOpen || terminalToolsOpen}
                    inert={filesOpen || (monitorOpen && monitorExpanded)}
                    filesOpen={filesOpen}
                    search={terminalSearch}
                    onSearchChange={setTerminalSearch}
                    pinnedIds={
                      new Set(
                        terminalHistory
                          .filter((record) => record.pinned)
                          .map((record) => record.id),
                      )
                    }
                    onToggleHistory={toggleSessionHistory}
                    onHistoryOutput={recordTerminalOutput}
                    onZoom={zoomTerminal}
                    onClosed={(id, message) => {
                      setMcpUnrestricted((previous) => {
                        const next = { ...previous };
                        delete next[id];
                        return next;
                      });
                      onSessionClosed(id, message);
                    }}
                    onError={notify}
                    onPaste={pasteToTerminal}
                    onReconnect={(session) => {
                      if (session.localShell)
                        void openLocalShell(session.localShell);
                      else if (session.wslDistribution)
                        void openWSLTerminal(session.wslDistribution);
                      else {
                        setReconnectSession(session);
                        setConnectHost(
                          workspace.hosts.find(
                            (host) => host.id === session.host.id,
                          ) ?? session.host,
                        );
                      }
                    }}
                  />
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
                  <WorkflowPage
                    key={`${activeSession?.host.id ?? "none"}-${workflowLoadRequest?.token ?? "workflow-panel"}`}
                    sessions={sessions}
                    activeSessionId={activeSession?.id ?? ""}
                    targetHostID={
                      activeSession && !isLocalSession(activeSession)
                        ? activeSession.host.id
                        : undefined
                    }
                    mode="panel"
                    hidden={
                      !workflowPanelOpen ||
                      !activeSession ||
                      activeSession.demo ||
                      isLocalSession(activeSession)
                    }
                    initialWorkflowID={workflowLoadRequest?.workflowID}
                    onRunCommand={runWorkflowCommand}
                    onViewTerminal={setActive}
                    onClosePanel={() => setWorkflowPanelOpen(false)}
                  />
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
          hosts={workspace.hosts}
          onSave={saveHost}
          onClose={() => setHostEditor(null)}
        />
      )}
      {workflowHostPicker && (
        <Modal
          title={`选择主机执行“${workflowHostPicker.title}”`}
          onClose={() => setWorkflowHostPicker(null)}
          className="workflow-host-picker-modal"
        >
          <p className="modal-intro">选择一个 SSH 主机。</p>
          <div className="workflow-host-options">
            {workspace.hosts.map((host) => {
              const count = sessions.filter(
                (session) =>
                  session.host.id === host.id &&
                  session.status === "connected" &&
                  !session.demo &&
                  !isLocalSession(session),
              ).length;
              return (
                <button
                  className="workflow-host-option"
                  key={host.id}
                  onClick={() => chooseWorkflowHost(host)}
                >
                  <span className={`host-icon ${host.color}`}>
                    <Server size={20} />
                  </span>
                  <span>
                    <strong>{host.name}</strong>
                    <small>
                      {host.username}@{host.address}
                      {count ? ` · ${count} 个已连接终端` : " · 连接后继续"}
                    </small>
                  </span>
                  <Play size={15} />
                </button>
              );
            })}
            {!workspace.hosts.length && (
              <div className="workflow-library-empty">
                还没有已保存的 SSH 主机
              </div>
            )}
          </div>
          <div className="modal-footer">
            {!workspace.hosts.length && (
              <button
                className="button primary"
                onClick={() => {
                  setWorkflowHostPicker(null);
                  newHost();
                }}
              >
                新建主机
              </button>
            )}
            <button
              className="button secondary"
              onClick={() => setWorkflowHostPicker(null)}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
      {connectHost && (
        <ConnectDialog
          key={reconnectSession?.id ?? connectHost.id}
          host={connectHost}
          reconnecting={Boolean(reconnectSession)}
          jumpHost={workspace.hosts.find(
            (h) => h.id === connectHost.jumpHostId,
          )}
          onConnect={connectFromDialog}
          onClose={() => {
            pendingSplitRef.current = null;
            cancelConnection();

            setConnectHost(null);
            setReconnectSession(null);
            if (!workflowConnectSucceeded.current)
              setPendingWorkflowLaunch(null);
            workflowConnectSucceeded.current = false;
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
      {sshConfigOpen && (
        <SSHConfigDialog
          onImported={(result) => {
            void load().then(() =>
              notify(
                `已导入 ${result.added} 台主机${result.updated ? `，更新 ${result.updated} 台` : ""}${result.skipped ? `，跳过 ${result.skipped} 台` : ""}`,
              ),
            );
          }}
          onClose={() => setSSHConfigOpen(false)}
        />
      )}
      {mcpCommand && (
        <MCPCommandDialog
          key={mcpCommand.id}
          request={{
            ...mcpCommand,
            sessionName: (() => {
              const session = sessions.find(
                (item) => item.id === mcpCommand.sessionId,
              );
              return session ? sessionHeading(session) : undefined;
            })(),
          }}
          onClose={() => {
            const closedID = mcpCommand.id;
            setMCPCommand((prev) => (prev?.id === closedID ? null : prev));
            if (isDesktop())
              void backend()
                .ListMCPCommands()
                .then((items) => {
                  const next = items?.find(
                    (item) => item.id !== closedID && !isApprovalExpired(item),
                  );
                  if (next?.id) setMCPCommand((prev) => prev ?? next);
                })
                .catch(() => {});
          }}
        />
      )}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}

      {paletteOpen && (
        <CommandPalette
          hosts={workspace.hosts}
          history={terminalHistory}
          onSelectHost={chooseHost}
          onSelectWorkflow={(workflow) => {
            setWorkflowFocusID(workflow.id);
            navigate("workflows");
          }}
          onSelectHistory={(record) => {
            setHistoryFocusID(record.id);
            navigate("history");
          }}
          onNew={newHost}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}

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
      {renameTarget && (
        <RenameSessionDialog
          currentName={renameTarget.name}
          defaultName={renameTarget.defaultName}
          onRename={(name) => saveSessionName(renameTarget.id, name)}
          onClose={() => setRenameTarget(null)}
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
