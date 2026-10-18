import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Code2,
  Copy,
  Ellipsis,
  ExternalLink,
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
  TerminalSquare,
  Trash2,
  Wifi,
  X,
  Zap,
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
import { demoHost } from "./types";
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
  const [quick, setQuick] = useState("");
  const [quickError, setQuickError] = useState("");
  const handles = useRef(new Map<string, TerminalHandle>());
  const preferenceWrites = useRef<Promise<void>>(Promise.resolve());
  const connectingID = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const stateRef = useRef(workspace);
  stateRef.current = workspace;
  const activeSession = sessions.find((s) => s.id === active);
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
        setHostEditor({ isNew: true });
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
      notify("当前是网页预览。真实 SSH 连接请使用 Orbit SSH 桌面应用。");
      return;
    }
    setConnectHost(host);
  }
  function openDemo() {
    const existing = sessions.find((s) => s.demo);
    if (existing) {
      setActive(existing.id);
      return;
    }
    const id = crypto.randomUUID();
    setSessions((s) => [
      ...s,
      { id, host: demoHost, demo: true, status: "connected" },
    ]);
    setActive(id);
    setSidebarOpen(false);
  }
  async function connect(
    host: Host,
    credentials: Credentials,
    fingerprint: string,
  ) {
    const id = crypto.randomUUID();
    connectingID.current = id;
    setSessions((s) => [...s, { id, host, demo: false, status: "connecting" }]);
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
      setSessions((s) => s.filter((item) => item.id !== id));
      setActive((current) => (current === id ? "workspace" : current));
      throw e;
    } finally {
      if (connectingID.current === id) connectingID.current = null;
    }
  }
  async function removeSession(id: string) {
    if (isDesktop()) await backend().Disconnect(id);
    setSessions((s) => s.filter((item) => item.id !== id));
    if (active === id) setActive("workspace");
  }
  function closeSession(session: Session) {
    if (
      !session.demo &&
      session.status !== "closed" &&
      workspace.preferences.confirmClose
    )
      setConfirmation({
        title: "断开这次连接？",
        message: `将关闭 ${session.host.name} 的终端会话，未完成的文件传输和前台任务会中断。`,
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
        .then(() => notify("命令已复制。连接主机后可粘贴使用。"))
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
      message: `将从工作空间移除“${host.name}”的配置。你可以随时重新添加。`,
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
  function quickConnect() {
    const value = quick.trim().replace(/^ssh\s+/, "");
    const match = value.match(
      /^(?:([^\s@]+)@)?(\[[^\]]+\]|[^\s:]+)(?::(\d+)|\s+-p\s+(\d+))?$/,
    );
    if (!match) {
      setQuickError("试试 root@192.168.1.10 或 ssh root@example.com -p 22");
      return;
    }
    const port = Number(match[3] || match[4] || 22);
    if (port < 1 || port > 65535) {
      setQuickError("端口应在 1–65535 之间");
      return;
    }
    setQuickError("");
    const address = match[2].replace(/^\[|\]$/g, "");
    setHostEditor({
      isNew: true,
      host: {
        ...demoHost,
        id: crypto.randomUUID(),
        name: address,
        address,
        port,
        username: match[1] || "root",
        group: "默认分组",
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
  const connectedCount = sessions.filter(
    (s) => !s.demo && s.status === "connected",
  ).length;

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
        <div className="workspace-id">
          <div className="avatar">
            ME
            <span />
          </div>
          <div>
            <strong>我的个人空间</strong>
            <span>本地配置</span>
          </div>
          <ShieldCheck size={16} />
        </div>
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
          <span>v0.3.0</span>
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
            <span>个人空间</span>
            <ChevronRight size={13} />
            <strong>{activeSession ? "终端会话" : pageNames[page]}</strong>
          </div>
          <div className="topbar-actions">
            <span className="local-badge">
              <ShieldCheck size={14} />
              本地优先
            </span>
            <span className="topbar-divider" />
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
            <button
              className="profile-button"
              onClick={() => setPreferencesOpen(true)}
              aria-label="个人空间偏好设置"
            >
              M
            </button>
          </div>
        </header>
        <div className="tabbar" role="tablist" aria-label="工作区标签">
          <button
            role="tab"
            aria-selected={active === "workspace"}
            className={`workspace-tab ${active === "workspace" ? "selected" : ""}`}
            onClick={() => setActive("workspace")}
          >
            <LayoutList size={15} />
            工作空间
          </button>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-tab ${s.id === active ? "selected" : ""}`}
            >
              <button
                role="tab"
                aria-selected={s.id === active}
                onClick={() => setActive(s.id)}
              >
                {s.status === "connecting" ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <span
                    className={`status-dot ${s.status === "closed" ? "offline" : ""}`}
                  />
                )}
                <span>{s.host.name}</span>
                {s.demo && <span className="tab-demo">体验</span>}
              </button>
              <button
                className="tab-close"
                aria-label={`关闭 ${s.host.name} 标签`}
                title="关闭标签"
                onClick={() => closeSession(s)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            className="tab-add"
            aria-label="新建连接"
            title="新建连接 · Ctrl T"
            onClick={newHost}
          >
            <Plus size={17} />
          </button>
          <span className="tabbar-space" />
          <span className="tabbar-end">
            {sessions.length ? `${sessions.length} 个会话` : "无活动会话"}
          </span>
        </div>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {loading ? (
            <div className="full-state">
              <LoaderCircle className="spin" size={24} />
              <p>正在打开你的工作空间…</p>
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
                  {page === "workspace" && (
                    <>
                      <div className="overview-strip">
                        <div>
                          <span className="metric-icon">
                            <Server size={19} />
                          </span>
                          <div>
                            <span>已保存主机</span>
                            <strong>
                              {workspace.hosts.length
                                .toString()
                                .padStart(2, "0")}
                              <small>台</small>
                            </strong>
                          </div>
                        </div>
                        <span className="metric-divider" />
                        <div>
                          <span className="metric-icon mint">
                            <Wifi size={19} />
                          </span>
                          <div>
                            <span>正在连接</span>
                            <strong>
                              {connectedCount.toString().padStart(2, "0")}
                              <small>个会话</small>
                            </strong>
                          </div>
                          <span
                            className={`status-pill ${connectedCount ? "online" : ""}`}
                          >
                            {connectedCount ? "连接中" : "未连接"}
                          </span>
                        </div>
                        <span className="metric-divider" />
                        <div>
                          <span className="metric-icon violet">
                            <Code2 size={19} />
                          </span>
                          <div>
                            <span>命令片段</span>
                            <strong>
                              {workspace.snippets.length
                                .toString()
                                .padStart(2, "0")}
                              <small>个</small>
                            </strong>
                          </div>
                          <button
                            className="metric-link"
                            aria-label="管理命令片段"
                            title="管理片段"
                            onClick={() => navigate("snippets")}
                          >
                            <ArrowUpRight size={17} />
                          </button>
                        </div>
                      </div>
                      <form
                        className="quick-connect"
                        onSubmit={(e) => {
                          e.preventDefault();
                          quickConnect();
                        }}
                      >
                        <span className="quick-icon">
                          <TerminalSquare size={19} />
                        </span>
                        <span className="quick-label">快速连接</span>
                        <span className="quick-separator" />
                        <input
                          aria-label="快速连接地址"
                          value={quick}
                          onChange={(e) => {
                            setQuick(e.target.value);
                            setQuickError("");
                          }}
                          placeholder="ssh root@192.168.1.10"
                          spellCheck={false}
                        />
                        <button
                          type="submit"
                          title="填写主机连接信息"
                          aria-label="填写主机连接信息"
                        >
                          <ArrowRight size={18} />
                        </button>
                      </form>
                      {quickError && (
                        <p className="form-error quick-error" role="alert">
                          {quickError}
                        </p>
                      )}
                    </>
                  )}

                  {page === "snippets" ? (
                    <section className="snippets-grid">
                      {workspace.snippets.map((s) => (
                        <article className="snippet-card" key={s.id}>
                          <div className="snippet-card-heading">
                            <span className="snippet-icon">
                              <Code2 size={20} />
                            </span>
                            <div>
                              <h2>{s.name}</h2>
                              <p>{s.description || "自定义命令片段"}</p>
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
                        <strong>保存你的常用命令</strong>
                        <span>少敲几次，多一点专注</span>
                      </button>
                    </section>
                  ) : (
                    <div
                      className={`workspace-columns ${page === "hosts" ? "hosts-only" : ""}`}
                    >
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
                            <h3>下一站，连接你的服务器</h3>
                            <p>添加第一台主机，把远程变成触手可及。</p>
                            <button
                              className="button secondary"
                              onClick={newHost}
                            >
                              <Plus size={16} />
                              添加主机
                            </button>
                            <span className="empty-formats">
                              支持密码与 SSH 密钥认证
                            </span>
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
                            <p>换个关键词，或试试其他筛选条件。</p>
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
                        {page === "workspace" && (
                          <div className="demo-launch">
                            <span>
                              <TerminalSquare size={18} />
                              本地演示
                            </span>
                            <button className="text-button" onClick={openDemo}>
                              体验终端 <ArrowUpRight size={15} />
                            </button>
                          </div>
                        )}
                      </div>
                      {page === "workspace" && (
                        <aside className="dashboard-rail">
                          <div className="section-heading">
                            <div>
                              <Zap size={16} />
                              <h2>随手可用</h2>
                            </div>
                            <button
                              className="icon-button"
                              aria-label="添加命令片段"
                              title="添加命令片段"
                              onClick={() => setSnippetEditor({})}
                            >
                              <Plus size={16} />
                            </button>
                          </div>
                          <div className="quick-snippets">
                            {workspace.snippets.slice(0, 3).map((s) => (
                              <button
                                key={s.id}
                                onClick={() => insertSnippet(s)}
                                title={`${s.command} · ${sessions.some((t) => t.status === "connected") ? "插入终端" : "复制命令"}`}
                              >
                                <span className="quick-snippet-icon">
                                  <Code2 size={15} />
                                </span>
                                <span>
                                  <strong>{s.name}</strong>
                                  <code>{s.command}</code>
                                </span>
                                <Copy size={13} />
                              </button>
                            ))}
                            {!workspace.snippets.length && (
                              <button onClick={() => setSnippetEditor({})}>
                                <Plus size={16} />
                                <span>创建第一个命令片段</span>
                              </button>
                            )}
                          </div>
                          <button
                            className="view-snippets"
                            onClick={() => navigate("snippets")}
                          >
                            管理全部片段
                            <ArrowRight size={13} />
                          </button>
                          <div className="shortcut-card">
                            <h3>快捷键</h3>
                            <div>
                              <span>搜索与切换</span>
                              <kbd>Ctrl K</kbd>
                            </div>
                            <div>
                              <span>新建连接</span>
                              <kbd>Ctrl T</kbd>
                            </div>
                            <div>
                              <span>终端内搜索</span>
                              <kbd>Ctrl ⇧ F</kbd>
                            </div>
                            <button
                              className="text-button"
                              onClick={() => setHelpOpen(true)}
                            >
                              了解更多
                              <ArrowUpRight size={12} />
                            </button>
                          </div>
                        </aside>
                      )}
                    </div>
                  )}
                  <footer className="dashboard-footer">
                    <span>
                      <span className="status-dot" />
                      {isDesktop()
                        ? "所有配置保存在本机"
                        : "网页预览 · 真实连接请使用桌面版"}
                    </span>
                  </footer>
                </div>
              </div>
              <div
                className={`terminal-workspace ${filesOpen ? "file-mode" : ""}`}
                hidden={!activeSession}
              >
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
                {terminalSearch !== null && activeSession && !filesOpen && (
                  <form
                    className="terminal-search"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setSearchFound(
                        handles.current.get(active)?.search(terminalSearch) ??
                          false,
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
                  className={`terminal-layout ${monitorOpen && monitorExpanded ? "monitor-expanded" : ""} ${filesOpen ? "files-expanded" : ""}`}
                >
                  <div
                    className="terminals"
                    inert={filesOpen || (monitorOpen && monitorExpanded)}
                  >
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
          onDemo={openDemo}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {helpOpen && (
        <Modal title="使用帮助" onClose={() => setHelpOpen(false)}>
          <div className="help-steps">
            <div>
              <span>01</span>
              <div>
                <h3>添加你的主机</h3>
                <p>填写 IP、端口与用户名，选择密码或私钥认证。</p>
              </div>
            </div>
            <div>
              <span>02</span>
              <div>
                <h3>核对指纹，安心连接</h3>
                <p>
                  首次连接核对服务器指纹，之后自动验证。私钥口令可保存在系统凭据库。
                </p>
              </div>
            </div>
            <div>
              <span>03</span>
              <div>
                <h3>终端与文件，在同一空间</h3>
                <p>
                  打开多个终端标签，通过 SFTP 上传、下载文件，或插入命令片段。
                </p>
              </div>
            </div>
          </div>
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
              <span>复制 / 粘贴</span>
              <kbd>Ctrl Shift C / V</kbd>
            </div>
          </div>
          <p className="field-hint">
            片段只插入命令，按 Enter 才会执行。多行粘贴会先提醒确认。
          </p>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => {
                setHelpOpen(false);
                openDemo();
              }}
            >
              先试试体验终端
              <ExternalLink size={14} />
            </button>
            <button
              className="button primary"
              onClick={() => setHelpOpen(false)}
            >
              知道了
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
    <article className="host-card">
      <div className="host-card-top">
        <span className={`host-icon ${host.color}`}>
          <Server size={22} strokeWidth={1.6} />
        </span>
        <div className="host-card-title">
          <button onClick={onConnect}>
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
        <button onClick={onConnect}>
          连接
          <ArrowUpRight size={14} />
        </button>
      </div>
    </article>
  );
}
