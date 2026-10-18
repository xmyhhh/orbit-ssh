import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clipboard,
  Code2,
  Ellipsis,
  FolderClosed,
  FolderOpen,
  Grid2X2,
  Home,
  LayoutList,
  LoaderCircle,
  Menu,
  Moon,
  Orbit,
  Pencil,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Star,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import type {
  Host,
  Preferences,
  Session,
  Snippet,
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
  SnippetDialog,
} from "./Dialogs";
import { TerminalPane } from "./TerminalPane";
import FilesPane from "./FilesPane";
import MonitorPanel from "./MonitorPanel";
import { snippetCategories, snippetCategory } from "./snippets";

type Page = "workspace" | "hosts" | "snippets";
type HostFilter = "all" | "favorite" | "recent";
interface Confirmation {
  title: string;
  message: string;
  action: string;
  danger?: boolean;
  run: () => Promise<void> | void;
}
const pageNames = {
  workspace: "工作空间",
  hosts: "全部主机",
  snippets: "命令片段",
};

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
  const [page, setPage] = useState<Page>("workspace");
  const [group, setGroup] = useState("");
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HostFilter>("all");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState("workspace");
  const [hostEditor, setHostEditor] = useState<{
    host?: Host;
    isNew?: boolean;
  } | null>(null);
  const [connectHost, setConnectHost] = useState<Host | null>(null);
  const [snippetEditor, setSnippetEditor] = useState<{
    snippet?: Snippet;
  } | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
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
  const [snippetQuery, setSnippetQuery] = useState("");
  const [snippetFilter, setSnippetFilter] = useState("全部");
  const handles = useRef(new Map<string, TerminalHandle>());
  const preferenceWrites = useRef<Promise<void>>(Promise.resolve());
  const connectingID = useRef<string | null>(null);
  const terminalNumbers = useRef(new Map<string, number>());
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
    snippetEditor ||
    preferencesOpen ||
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
    return () => clearTimeout(toastTimer.current);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
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
        !(e.metaKey || e.ctrlKey) ||
        e.altKey ||
        modalOpen ||
        document.querySelector('.file-workspace [role="dialog"]')
      )
        return;
      const target = e.target as HTMLElement | null;
      const editing =
        target?.closest('input, textarea, select, [contenteditable="true"]') &&
        !target.closest(".xterm");
      if (
        activeSession &&
        !filesOpen &&
        !editing &&
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
      if (e.code === "KeyK") {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (e.code === "KeyT") {
        e.preventDefault();
        if (e.shiftKey) newTerminal();
        else newHost();
      }
      if (e.shiftKey && e.code === "KeyF" && activeSession && !filesOpen) {
        e.preventDefault();
        setTerminalSearch("");
      }
      if (e.shiftKey && e.code === "KeyV" && activeSession && !filesOpen) {
        e.preventDefault();
        void navigator.clipboard
          .readText()
          .then(pasteToTerminal)
          .catch(() => notify("无法读取剪贴板，请使用终端中的粘贴操作。"));
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
  async function saveSnippets(snippets: Snippet[]) {
    if (isDesktop()) await backend().SaveSnippets(snippets);
    update({ ...stateRef.current, snippets });
  }
  function navigate(next: Page, nextGroup = "") {
    setPage(next);
    setGroup(nextGroup);
    setActive("workspace");
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
    if (activeSession)
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
    setActive(id);
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
            : "workspace"
          : current,
      );
      throw e;
    } finally {
      if (connectingID.current === id) connectingID.current = null;
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
        "workspace"
      );
    });
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  function selectHostSessions(items: Session[]) {
    const remembered = lastActiveSessions.current.get(items[0].host.id);
    setActive(items.find((s) => s.id === remembered)?.id ?? items[0].id);
  }
  function closeHostSessions(items: Session[]) {
    if (items.length === 1) {
      closeSession(items[0]);
      return;
    }
    setConfirmation({
      title: "关闭这台主机的全部会话？",
      message: `将关闭 ${items[0].host.name} 的 ${items.length} 个终端，这些终端的文件传输和前台任务会中断。`,
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
        title: "断开这次连接？",
        message: `将关闭 ${session.host.name} 的终端 #${session.terminalNumber}，此终端的文件传输和前台任务会中断。`,
        action: "断开连接",
        run: () => removeSession(session.id),
      });
    else void removeSession(session.id).catch((e) => notify(errorText(e)));
  }
  function insertSnippet(snippet: Snippet) {
    const current =
      activeSession?.status === "connected"
        ? activeSession
        : sessions.find((s) => s.status === "connected");
    if (!current) {
      void navigator.clipboard
        .writeText(snippet.command)
        .then(() => notify("命令已复制"))
        .catch(() => notify("复制失败，请在片段详情中手动复制。"));
      return;
    }
    setActive(current.id);
    const text = snippet.command
      .replace(/[\r\n]+/g, " ")
      .replace(/[\x00-\x1f\x7f]/g, "");
    handles.current.get(current.id)?.send(text);
    handles.current.get(current.id)?.focus();
    notify("命令已插入终端，按 Enter 执行");
  }
  function pasteToTerminal(text: string) {
    if (!activeSession || activeSession.status !== "connected" || !text) return;
    if (/[\r\n\x1b]/.test(text)) {
      setConfirmation({
        title: "粘贴多行内容？",
        message: `剪贴板包含换行或控制字符，可能立即执行命令。请先核对内容：\n\n${text.slice(0, 800)}${text.length > 800 ? "\n…" : ""}`,
        action: "确认粘贴",
        run: () => {
          handles.current.get(active)?.send(text);
          handles.current.get(active)?.focus();
        },
      });
    } else {
      handles.current.get(active)?.send(text);
      handles.current.get(active)?.focus();
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
  const filteredSnippets = workspace.snippets.filter(
    (snippet) =>
      (snippetFilter === "全部" ||
        snippetCategory(snippet) === snippetFilter) &&
      `${snippet.name} ${snippet.command} ${snippet.description} ${snippetCategory(snippet)}`
        .toLowerCase()
        .includes(snippetQuery.trim().toLowerCase()),
  );
  const availableSnippetCategories = [
    ...new Set([
      ...snippetCategories,
      ...workspace.snippets.map(snippetCategory),
    ]),
  ];

  return (
    <div className={`app ${sidebarOpen ? "sidebar-open" : ""}`}>
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
        <button
          className="brand"
          onClick={() => navigate("workspace")}
          aria-label="Orbit SSH 首页"
        >
          <span className="brand-symbol">
            <Orbit size={27} strokeWidth={1.6} />
          </span>
          <span>
            orbit<span className="brand-ssh">SSH</span>
          </span>
        </button>
        <button className="sidebar-search" onClick={() => setPaletteOpen(true)}>
          <Search size={16} />
          <span>搜索或快速切换</span>
          <kbd>⌃ K</kbd>
        </button>
        <span className="nav-label">工作台</span>
        <nav aria-label="主导航">
          <button
            className={
              page === "workspace" && active === "workspace" ? "active" : ""
            }
            onClick={() => navigate("workspace")}
          >
            <Home size={18} />
            <span>工作空间</span>
            <span className="nav-active-dot" />
          </button>
          <button
            className={
              page === "hosts" && !group && active === "workspace"
                ? "active"
                : ""
            }
            onClick={() => navigate("hosts")}
          >
            <Server size={18} />
            <span>全部主机</span>
            <span className="count">{workspace.hosts.length}</span>
          </button>
          <button
            className={
              page === "snippets" && active === "workspace" ? "active" : ""
            }
            onClick={() => navigate("snippets")}
          >
            <Code2 size={18} />
            <span>命令片段</span>
            <span className="count">{workspace.snippets.length}</span>
          </button>
        </nav>
        <div className="group-heading">
          <button
            onClick={() => setGroupsOpen(!groupsOpen)}
            aria-expanded={groupsOpen}
          >
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
                  className={
                    group === g && active === "workspace" ? "selected" : ""
                  }
                  onClick={() => navigate("hosts", g)}
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
          <button onClick={() => setPreferencesOpen(true)}>
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
        <div className="sidebar-version">
          <span>ORBIT SSH</span>
          <span>v0.3.13</span>
        </div>
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
            <strong>{activeSession ? "终端会话" : pageNames[page]}</strong>
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
            aria-selected={active === "workspace"}
            className={`workspace-tab ${active === "workspace" ? "selected" : ""}`}
            onClick={() => setActive("workspace")}
          >
            <LayoutList size={15} />
            工作空间
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
                  title={`${host.username}@${host.address}:${host.port} · ${items.length} 个会话`}
                  onClick={() => selectHostSessions(items)}
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
                  title="关闭这台主机的全部会话"
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
              ? `${sessionGroups.size} 台主机 · ${sessions.length} 个会话`
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
              <h2>工作空间暂时无法读取</h2>
              <p>{loadError}</p>
              <button className="button primary" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : (
            <>
              <div className="dashboard-scroll" hidden={active !== "workspace"}>
                <div className="dashboard">
                  <section className="page-heading">
                    <div>
                      <h1>
                        {page === "hosts"
                          ? group || "全部主机"
                          : pageNames[page]}
                      </h1>
                    </div>
                    <button
                      className="button primary"
                      onClick={
                        page === "snippets"
                          ? () => setSnippetEditor({})
                          : newHost
                      }
                    >
                      <Plus size={17} />
                      {page === "snippets" ? "新建片段" : "新建连接"}
                      <kbd>{page === "snippets" ? "+" : "⌃ T"}</kbd>
                    </button>
                  </section>
                  {page === "snippets" ? (
                    <section
                      className="snippets-library"
                      aria-label="命令片段库"
                    >
                      <div className="snippet-filters">
                        <label className="snippet-search">
                          <Search size={16} aria-hidden="true" />
                          <input
                            aria-label="搜索命令片段"
                            placeholder="搜索名称、命令或说明…"
                            value={snippetQuery}
                            onChange={(e) => setSnippetQuery(e.target.value)}
                          />
                        </label>
                        <select
                          aria-label="片段分类"
                          value={snippetFilter}
                          onChange={(e) => setSnippetFilter(e.target.value)}
                        >
                          <option value="全部">全部分类</option>
                          {availableSnippetCategories.map((category) => (
                            <option key={category} value={category}>
                              {category}
                            </option>
                          ))}
                        </select>
                        <span role="status">
                          {filteredSnippets.length} /{" "}
                          {workspace.snippets.length} 条
                        </span>
                      </div>
                      {!filteredSnippets.length && (
                        <div className="snippet-empty">
                          <Search size={24} aria-hidden="true" />
                          <strong>
                            {workspace.snippets.length
                              ? "没有匹配的片段"
                              : "暂无命令片段"}
                          </strong>
                          {(snippetQuery || snippetFilter !== "全部") && (
                            <button
                              className="button secondary compact"
                              onClick={() => {
                                setSnippetQuery("");
                                setSnippetFilter("全部");
                              }}
                            >
                              清除筛选
                            </button>
                          )}
                        </div>
                      )}
                      <div className="snippets-grid">
                        {filteredSnippets.map((s) => (
                          <article className="snippet-card" key={s.id}>
                            <div className="snippet-card-heading">
                              <span className="snippet-icon">
                                <Code2 size={20} />
                              </span>
                              <div>
                                <h2>{s.name}</h2>
                                <span className="snippet-category">
                                  {snippetCategory(s)}
                                </span>
                                {s.description && <p>{s.description}</p>}
                              </div>
                              <button
                                className="icon-button"
                                aria-label={`编辑 ${s.name}`}
                                title="编辑片段"
                                onClick={() => setSnippetEditor({ snippet: s })}
                              >
                                <Pencil size={16} />
                              </button>
                            </div>
                            <pre>{s.command}</pre>
                            <div className="snippet-card-footer">
                              <button
                                className="text-button"
                                onClick={() => insertSnippet(s)}
                              >
                                <Clipboard size={14} />
                                {sessions.some((t) => t.status === "connected")
                                  ? "插入终端"
                                  : "复制命令"}
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`删除 ${s.name}`}
                                title="删除片段"
                                onClick={() =>
                                  setConfirmation({
                                    title: "删除这条片段？",
                                    message: `“${s.name}”将从命令片段中移除。`,
                                    action: "删除片段",
                                    danger: true,
                                    run: () =>
                                      saveSnippets(
                                        stateRef.current.snippets.filter(
                                          (item) => item.id !== s.id,
                                        ),
                                      ),
                                  })
                                }
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </article>
                        ))}
                        <button
                          className="add-snippet-card"
                          onClick={() => setSnippetEditor({})}
                        >
                          <Plus size={24} />
                          <strong>新建片段</strong>
                        </button>
                      </div>
                    </section>
                  ) : (
                    <div className="workspace-columns">
                      <div className="hosts-section">
                        <div className="section-heading">
                          <div>
                            <h2>
                              {page === "hosts" ? "主机列表" : "我的主机"}
                            </h2>
                            <span className="subtle-count">
                              {workspace.hosts.length}
                            </span>
                          </div>
                          <div className="layout-switch" aria-label="主机布局">
                            <button
                              className={layout === "grid" ? "selected" : ""}
                              aria-label="卡片视图"
                              aria-pressed={layout === "grid"}
                              title="卡片视图"
                              onClick={() => setLayout("grid")}
                            >
                              <Grid2X2 size={15} />
                            </button>
                            <button
                              className={layout === "list" ? "selected" : ""}
                              aria-label="列表视图"
                              aria-pressed={layout === "list"}
                              title="列表视图"
                              onClick={() => setLayout("list")}
                            >
                              <LayoutList size={16} />
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
                                onClick={() => setFilter(f.value)}
                              >
                                {f.value === "favorite" && <Star size={12} />}
                                {f.label}
                              </button>
                            ))}
                          </div>
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
                              显示全部主机
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
                        className={`session-tab ${s.id === active ? "selected" : ""}`}
                      >
                        <button
                          role="tab"
                          aria-selected={s.id === active}
                          aria-label={`${s.host.name} · 终端 #${s.terminalNumber}`}
                          title={`终端 #${s.terminalNumber} · ${s.status === "connected" ? "已连接" : s.status === "connecting" ? "连接中" : "已断开"}`}
                          onClick={() => setActive(s.id)}
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
                      aria-label="为当前主机新建终端"
                      title="新建终端 · Ctrl Shift T"
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
                      {activeSession?.host.username}@
                      {activeSession?.host.address}
                    </code>
                    <span className="tag neutral">
                      {activeSession?.demo
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
                      title="为当前主机新建终端 · Ctrl Shift T"
                      disabled={activeSession?.status === "connecting"}
                      onClick={newTerminal}
                    >
                      <Plus size={16} aria-hidden="true" />
                      新建终端
                    </button>
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
                        void navigator.clipboard
                          .readText()
                          .then(pasteToTerminal)
                          .catch(() =>
                            notify(
                              "无法读取剪贴板。请使用 Ctrl Shift V 粘贴。",
                            ),
                          )
                      }
                    >
                      <Clipboard size={16} />
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
                  </div>
                </div>
                <div
                  className={`terminal-layout ${monitorOpen && monitorExpanded ? "monitor-expanded" : ""} ${filesOpen ? "files-expanded" : ""}`}
                >
                  <div
                    className="terminals"
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
                    {sessions.map((s) => (
                      <div
                        className="terminal-session"
                        key={s.id}
                        hidden={active !== s.id}
                      >
                        <TerminalPane
                          ref={(h) => {
                            if (h) handles.current.set(s.id, h);
                            else handles.current.delete(s.id);
                          }}
                          session={s}
                          active={
                            active === s.id &&
                            !filesOpen &&
                            !(monitorOpen && monitorExpanded)
                          }
                          dark={dark}
                          fontSize={workspace.preferences.fontSize}
                          lineHeight={workspace.preferences.lineHeight}
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
                          onPaste={pasteToTerminal}
                        />
                        {s.status === "closed" && (
                          <div className="reconnect-bar">
                            <span>
                              连接已结束{s.error ? ` · ${s.error}` : ""}
                            </span>
                            <button
                              className="button secondary compact"
                              onClick={() => chooseHost(s.host)}
                            >
                              重新连接
                              <ArrowRight size={13} />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {monitorOpen && activeSession && (
                    <MonitorPanel
                      key={activeSession.id}
                      session={activeSession}
                      expanded={monitorExpanded}
                      onExpand={() => setMonitorExpanded((v) => !v)}
                      onClose={() => setMonitorOpen(false)}
                    />
                  )}
                  {filesOpen && activeSession && (
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
                    <ShieldCheck size={12} />
                    {activeSession?.demo ? "本地体验终端" : "SSH 加密通道"}
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
      {snippetEditor && (
        <SnippetDialog
          snippet={snippetEditor.snippet}
          onSave={async (snippet) => {
            const list = stateRef.current.snippets;
            await saveSnippets(
              list.some((s) => s.id === snippet.id)
                ? list.map((s) => (s.id === snippet.id ? snippet : s))
                : [...list, snippet],
            );
            notify("命令片段已保存");
          }}
          onClose={() => setSnippetEditor(null)}
        />
      )}
      {preferencesOpen && (
        <PreferencesDialog
          preferences={workspace.preferences}
          onChange={savePreferences}
          onClose={() => setPreferencesOpen(false)}
        />
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
              <span>同主机新建终端</span>
              <kbd>Ctrl / ⌘ Shift T</kbd>
            </div>
            <div>
              <span>复制 / 粘贴</span>
              <kbd>Ctrl Shift C / V</kbd>
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
          <span>{host.group}</span>
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
