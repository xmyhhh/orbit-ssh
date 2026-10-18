import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  EyeOff,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { backend, errorText, listen } from "./bridge";
import { Modal } from "./Dialogs";
import FileContextMenu from "./FileContextMenu";
import type {
  Directory,
  LocalDirectory,
  RemoteFile,
  Session,
  Transfer,
} from "./types";

const TextFileDialog = lazy(() => import("./TextFileDialog"));

type Side = "local" | "remote";
let lastLocalPath = "";
const remotePaths = new Map<string, string>();
const finished = (job: Transfer) =>
  ["completed", "failed", "cancelled"].includes(job.status);
const statusText: Record<Transfer["status"], string> = {
  queued: "排队中",
  scanning: "统计文件…",
  running: "传输中",
  cancelling: "正在取消…",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
function size(n: number): string {
  if (n < 1024) return `${n} B`;
  const unit = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return `${(n / 1024 ** unit).toFixed(1)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
function child(dir: string, name: string, side: Side) {
  if (dir === "::drives") return name;
  const sep = side === "local" && dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]$/, "") + sep + name;
}
function demoFile(name: string, isDir: boolean, bytes = 0): RemoteFile {
  return {
    name,
    isDir,
    size: bytes,
    isSymlink: false,
    modified: "2026-10-18T10:30:00+08:00",
    mode: isDir ? "drwxr-xr-x" : "-rw-r--r--",
  };
}
function demoListing(side: Side, requested: string): LocalDirectory {
  const home = side === "local" ? "C:\\Users\\you" : "/home/explorer";
  const path = requested || home;
  let files: RemoteFile[] = [];
  if (path === home)
    files =
      side === "local"
        ? [
            demoFile("Documents", true),
            demoFile("Downloads", true),
            demoFile("deploy.sh", false, 432),
            demoFile("README.md", false, 1840),
          ]
        : [
            demoFile("projects", true),
            demoFile("documents", true),
            demoFile(".ssh", true),
            demoFile("welcome.txt", false, 128),
            demoFile("server.log", false, 20480),
          ];
  else if (path.endsWith("projects") || path.endsWith("Documents"))
    files = [
      demoFile("app", true),
      demoFile("config.json", false, 524),
      demoFile("notes.txt", false, 218),
    ];
  else if (path === "::drives")
    files = [demoFile("C:\\", true), demoFile("D:\\", true)];
  const parent =
    path === "::drives"
      ? path
      : path.replace(/[\\/]$/, "").replace(/[\\/][^\\/]*$/, "") ||
        (side === "local" ? "::drives" : "/");
  return { path, files, parent };
}

function useDirectory(session: Session, side: Side) {
  const [directory, setDirectory] = useState<LocalDirectory>({
    path: "",
    files: [],
    parent: "",
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const token = useRef(0);
  const alive = useRef(true);
  const latest = useRef(directory);
  latest.current = directory;
  async function load(requested = "") {
    const current = ++token.current;
    setBusy(true);
    setError("");
    try {
      let value: LocalDirectory;
      if (session.demo) value = demoListing(side, requested);
      else if (side === "local")
        value = await backend().ListLocalDirectory(requested);
      else {
        const remote: Directory = await backend().ListDirectory(
          session.id,
          requested,
        );
        value = {
          ...remote,
          parent: remote.path.replace(/\/$/, "").replace(/\/[^/]*$/, "") || "/",
        };
      }
      if (!alive.current || current !== token.current) return;
      setSelected((previous) =>
        latest.current.path === value.path
          ? previous.filter((name) =>
              value.files.some((file) => file.name === name),
            )
          : [],
      );
      setDirectory(value);
      setInput(value.path);
      if (!session.demo) {
        if (side === "local") lastLocalPath = value.path;
        else remotePaths.set(session.id, value.path);
      }
    } catch (e) {
      if (alive.current && current === token.current) setError(errorText(e));
    } finally {
      if (alive.current && current === token.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load(
      session.demo
        ? ""
        : side === "local"
          ? lastLocalPath
          : remotePaths.get(session.id) || "",
    );
    return () => {
      alive.current = false;
      token.current++;
    };
  }, [session.id, side]);
  return {
    directory,
    input,
    setInput,
    busy,
    error,
    setError,
    selected,
    setSelected,
    load,
    latest,
  };
}
type BrowserState = ReturnType<typeof useDirectory>;

function FileBrowser({
  side,
  state,
  session,
  onPreview,
}: {
  side: Side;
  state: BrowserState;
  session: Session;
  onPreview: (side: Side, file: RemoteFile, path: string) => void;
}) {
  const {
    directory,
    input,
    setInput,
    busy,
    error,
    setError,
    selected,
    setSelected,
    load,
  } = state;
  const label = side === "local" ? "本地" : "远程";
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState(false);
  const [sort, setSort] = useState<"name" | "size" | "modified">("name");
  const [folderName, setFolderName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [contextMenu, setContextMenu] = useState<{
    file: RemoteFile;
    x: number;
    y: number;
    trigger: HTMLElement | null;
  } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef("");
  const selectedNames = useMemo(() => new Set(selected), [selected]);
  const files = useMemo(
    () =>
      directory.files
        .filter(
          (f) =>
            (hidden || !f.name.startsWith(".")) &&
            f.name.toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          if (sort === "size")
            return b.size - a.size || a.name.localeCompare(b.name);
          if (sort === "modified")
            return (
              b.modified.localeCompare(a.modified) ||
              a.name.localeCompare(b.name)
            );
          return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
        }),
    [directory.files, query, hidden, sort],
  );
  useEffect(() => {
    setSelected([]);
    setScrollTop(0);
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [directory.path, query, hidden, sort]);
  function select(file: RemoteFile, event: MouseEvent) {
    if (busy) return;
    if (event.shiftKey && anchor.current) {
      const a = files.findIndex((f) => f.name === anchor.current),
        b = files.indexOf(file);
      if (a >= 0) {
        setSelected([
          ...new Set([
            ...selected,
            ...files
              .slice(Math.min(a, b), Math.max(a, b) + 1)
              .map((f) => f.name),
          ]),
        ]);
        return;
      }
    }
    if (event.ctrlKey || event.metaKey)
      setSelected(
        selected.includes(file.name)
          ? selected.filter((n) => n !== file.name)
          : [...selected, file.name],
      );
    else setSelected([file.name]);
    anchor.current = file.name;
  }
  function open(file: RemoteFile) {
    const path = child(directory.path, file.name, side);
    if (file.isDir) void load(path);
    else onPreview(side, file, path);
  }
  function showContextMenu(
    file: RemoteFile,
    row: HTMLElement,
    x: number,
    y: number,
  ) {
    if (disabled) return;
    setSelected([file.name]);
    anchor.current = file.name;
    const trigger = row.querySelector<HTMLButtonElement>(".browser-file-name");
    trigger?.focus({ preventScroll: true });
    setContextMenu({ file, x, y, trigger });
  }
  async function chooseFolder() {
    try {
      const path = await backend().SelectLocalDirectory();
      if (path) await load(path);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function createFolder() {
    if (!folderName?.trim()) return;
    setCreating(true);
    try {
      if (side === "local")
        await backend().MakeLocalDirectory(directory.path, folderName);
      else
        await backend().MakeDirectory(session.id, directory.path, folderName);
      setFolderName(null);
      await load(directory.path);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCreating(false);
    }
  }
  const start = Math.max(0, Math.floor((scrollTop - 32) / 36) - 8);
  const visible = files.slice(start, start + 70);
  const disabled =
    busy ||
    creating ||
    !directory.path ||
    (side === "remote" && session.status !== "connected");
  useEffect(() => {
    setContextMenu(null);
  }, [directory, query, hidden, sort, disabled]);
  return (
    <section className={`file-browser ${side}`} aria-label={`${label}文件`}>
      <div className="browser-heading">
        <div>
          {side === "local" ? (
            <HardDrive size={17} aria-hidden="true" />
          ) : (
            <Server size={17} aria-hidden="true" />
          )}
          <strong>{side === "local" ? "本地文件" : session.host.name}</strong>
          <span className="tag neutral">{label}</span>
        </div>
        <div>
          {side === "local" && (
            <button
              className="icon-button"
              title="选择本地文件夹"
              aria-label="选择本地文件夹"
              disabled={session.demo || busy}
              onClick={() => void chooseFolder()}
            >
              <FolderOpen size={16} />
            </button>
          )}
          <button
            className="icon-button"
            title={`${label}主目录`}
            aria-label={`${label}主目录`}
            disabled={busy}
            onClick={() => void load()}
          >
            <Home size={16} />
          </button>
          <button
            className="icon-button"
            title={`${label}新建文件夹`}
            aria-label={`${label}新建文件夹`}
            disabled={disabled || session.demo || directory.path === "::drives"}
            onClick={() => setFolderName("")}
          >
            <FolderPlus size={16} />
          </button>
        </div>
      </div>
      <div className="browser-path">
        <button
          className="icon-button"
          title="上一级"
          aria-label={`${label}上一级目录`}
          disabled={disabled || directory.path === directory.parent}
          onClick={() => void load(directory.parent)}
        >
          <ArrowUp size={16} />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load(input);
          }}
        >
          <input
            aria-label={`${label}路径`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            spellCheck={false}
            title={directory.path}
          />
        </form>
        <button
          className="icon-button"
          aria-label={`刷新${label}文件`}
          title="刷新"
          disabled={busy}
          onClick={() => void load(directory.path)}
        >
          <RefreshCw size={15} className={busy ? "spin" : ""} />
        </button>
      </div>
      <div className="browser-filter">
        <label>
          <Search size={14} aria-hidden="true" />
          <input
            aria-label={`筛选${label}文件`}
            placeholder="筛选文件…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className={`icon-button ${hidden ? "active" : ""}`}
          aria-pressed={hidden}
          aria-label={`显示${label}隐藏文件`}
          title="显示隐藏文件"
          onClick={() => setHidden(!hidden)}
        >
          {hidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
      </div>
      {folderName !== null && (
        <form
          className="browser-new-folder"
          onSubmit={(e) => {
            e.preventDefault();
            void createFolder();
          }}
        >
          <input
            aria-label={`${label}新文件夹名称`}
            autoFocus
            required
            maxLength={255}
            placeholder="文件夹名称"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            disabled={creating}
          />
          <button
            className="icon-button"
            title="创建"
            aria-label={`创建${label}文件夹`}
            disabled={creating || !folderName.trim()}
          >
            {creating ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="取消新建文件夹"
            onClick={() => setFolderName(null)}
            disabled={creating}
          >
            <X size={16} />
          </button>
        </form>
      )}
      {error && (
        <div role="alert" className="browser-error">
          <CircleAlert size={15} />
          <span>{error}</span>
          <button onClick={() => void load(directory.path)}>重试</button>
        </div>
      )}
      <div
        className="browser-table-scroll"
        ref={scroll}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        tabIndex={0}
        aria-label={`${label}文件列表`}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            setSelected(files.map((f) => f.name));
          }
          if (e.key === "Escape") setSelected([]);
          if (
            e.key === "Backspace" &&
            e.target === e.currentTarget &&
            !disabled
          ) {
            e.preventDefault();
            void load(directory.parent);
          }
        }}
      >
        <table
          className="browser-table"
          aria-label={`${label}目录内容`}
          aria-rowcount={files.length + 1}
        >
          <thead>
            <tr>
              <th className="file-check">
                <input
                  type="checkbox"
                  aria-label={`全选${label}文件`}
                  checked={
                    files.length > 0 &&
                    files.every((f) => selectedNames.has(f.name))
                  }
                  disabled={busy || !files.length}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? files.map((f) => f.name) : [],
                    )
                  }
                />
              </th>
              <th>
                <button onClick={() => setSort("name")}>
                  名称
                  {sort === "name" && (
                    <ChevronDown size={12} aria-hidden="true" />
                  )}
                </button>
              </th>
              <th className="file-bytes">
                <button onClick={() => setSort("size")}>
                  大小
                  {sort === "size" && (
                    <ChevronDown size={12} aria-hidden="true" />
                  )}
                </button>
              </th>
              <th className="file-modified">
                <button onClick={() => setSort("modified")}>
                  修改时间
                  {sort === "modified" && (
                    <ChevronDown size={12} aria-hidden="true" />
                  )}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {start > 0 && (
              <tr aria-hidden="true" className="file-spacer">
                <td colSpan={4} style={{ height: start * 36 }} />
              </tr>
            )}
            {visible.map((f, index) => (
              <tr
                key={f.name}
                aria-selected={selectedNames.has(f.name)}
                className={selectedNames.has(f.name) ? "selected" : ""}
                onClick={(e) => select(f, e)}
                onDoubleClick={() => {
                  if (!disabled) open(f);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showContextMenu(f, e.currentTarget, e.clientX, e.clientY);
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "ContextMenu" ||
                    (e.shiftKey && e.key === "F10")
                  ) {
                    e.preventDefault();
                    const bounds = e.currentTarget.getBoundingClientRect();
                    showContextMenu(
                      f,
                      e.currentTarget,
                      bounds.left + 40,
                      bounds.bottom,
                    );
                  }
                }}
                aria-rowindex={start + index + 2}
              >
                <td className="file-check">
                  <input
                    type="checkbox"
                    aria-label={`选择${label} ${f.name}`}
                    checked={selectedNames.has(f.name)}
                    disabled={busy}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      setSelected(
                        e.target.checked
                          ? [...selected, f.name]
                          : selected.filter((n) => n !== f.name),
                      );
                      anchor.current = f.name;
                    }}
                  />
                </td>
                <td>
                  <button
                    className={`browser-file-name ${f.isDir ? "folder" : ""}`}
                    title={`${f.name}${f.isSymlink ? " · 符号链接" : ""}\n${f.mode}\n${f.isDir ? "双击或按 Enter 打开文件夹" : "双击或按 Enter 打开文本"}`}
                    disabled={disabled}
                    onClick={(e) => {
                      if (e.detail === 0) {
                        e.stopPropagation();
                        open(f);
                      }
                    }}
                  >
                    {f.isDir ? (
                      <Folder size={17} aria-hidden="true" />
                    ) : /\.(txt|md|log|json|yml|yaml|conf|sh|go|tsx?)$/i.test(
                        f.name,
                      ) ? (
                      <FileText size={17} aria-hidden="true" />
                    ) : (
                      <File size={17} aria-hidden="true" />
                    )}
                    <span>
                      {f.name}
                      {f.isSymlink && " ↗"}
                    </span>
                    {f.isDir && (
                      <ChevronRight
                        className="file-open-hint"
                        size={13}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </td>
                <td className="file-bytes">{f.isDir ? "—" : size(f.size)}</td>
                <td
                  className="file-modified"
                  title={
                    f.modified ? new Date(f.modified).toLocaleString() : ""
                  }
                >
                  {f.modified
                    ? new Date(f.modified).toLocaleDateString("zh-CN")
                    : "—"}
                </td>
              </tr>
            ))}
            {files.length > start + visible.length && (
              <tr aria-hidden="true" className="file-spacer">
                <td
                  colSpan={4}
                  style={{
                    height: (files.length - start - visible.length) * 36,
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
        {busy && (
          <div className="browser-empty" role="status">
            <LoaderCircle size={24} className="spin" />
            正在读取…
          </div>
        )}
        {!busy && !files.length && !error && (
          <div className="browser-empty">
            <FolderOpen size={28} />
            <span>{query ? "没有匹配的文件" : "此文件夹为空"}</span>
          </div>
        )}
      </div>
      <div className="browser-footer">
        <span>
          {selected.length
            ? `已选 ${selected.length} 项`
            : `${files.length} 个项目`}
        </span>
        <span>
          {selected.length
            ? size(
                directory.files
                  .filter((f) => selectedNames.has(f.name) && !f.isDir)
                  .reduce((n, f) => n + f.size, 0),
              )
            : hidden
              ? "含隐藏文件"
              : ""}
        </span>
      </div>
      {contextMenu && (
        <FileContextMenu
          file={contextMenu.file}
          remote={side === "remote"}
          x={contextMenu.x}
          y={contextMenu.y}
          onOpen={() => open(contextMenu.file)}
          onClose={(restoreFocus) => {
            if (restoreFocus)
              contextMenu.trigger?.focus({ preventScroll: true });
            setContextMenu(null);
          }}
        />
      )}
    </section>
  );
}

export default function FilesPane({
  session,
  onClose,
  notify,
}: {
  session: Session;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const local = useDirectory(session, "local");
  const remote = useDirectory(session, "remote");
  const [conflict, setConflict] = useState<"skip" | "replace">("skip");
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [queueOpen, setQueueOpen] = useState(true);
  const [enqueueing, setEnqueueing] = useState(false);
  const [preview, setPreview] = useState<{
    name: string;
    side: Side;
    path: string;
  } | null>(null);
  const alive = useRef(true);
  const sequence = useRef(0);
  async function refreshJobs() {
    if (session.demo) return;
    const current = ++sequence.current;
    try {
      const jobs = await backend().ListTransfers(session.id);
      if (alive.current && current === sequence.current) setTransfers(jobs);
    } catch (e) {
      if (alive.current) notify(errorText(e));
    }
  }
  const refreshPaths = useRef(() => {});
  refreshPaths.current = () => {
    void local.load(local.latest.current.path);
    void remote.load(remote.latest.current.path);
  };
  useEffect(() => {
    alive.current = true;
    void refreshJobs();
    const off = session.demo
      ? () => {}
      : listen(`sftp:transfer:${session.id}`, (value) => {
          if (!alive.current) return;
          sequence.current++;
          const job = value as Transfer;
          setTransfers((items) =>
            items.some((t) => t.id === job.id)
              ? items.map((t) => (t.id === job.id ? job : t))
              : [...items, job],
          );
          if (finished(job)) refreshPaths.current();
        });
    const timer = session.demo
      ? undefined
      : setInterval(() => {
          void refreshJobs();
        }, 1500);
    return () => {
      alive.current = false;
      sequence.current++;
      off();
      clearInterval(timer);
    };
  }, [session.id]);
  async function enqueue(direction: "upload" | "download") {
    const source = direction === "upload" ? local : remote;
    const target = direction === "upload" ? remote : local;
    if (!source.selected.length) return;
    setEnqueueing(true);
    try {
      await backend().QueueTransfer({
        sessionId: session.id,
        direction,
        sources: source.selected.map((name) =>
          child(
            source.directory.path,
            name,
            direction === "upload" ? "local" : "remote",
          ),
        ),
        destination: target.directory.path,
        conflict,
      });
      source.setSelected([]);
      setQueueOpen(true);
      await refreshJobs();
    } catch (e) {
      notify(errorText(e));
    } finally {
      if (alive.current) setEnqueueing(false);
    }
  }
  function openPreview(side: Side, file: RemoteFile, filename: string) {
    setPreview({ name: file.name, side, path: filename });
  }
  const active = transfers.filter((t) => !finished(t)).length;
  const canTransfer =
    !session.demo &&
    session.status === "connected" &&
    !enqueueing &&
    !local.busy &&
    !remote.busy &&
    Boolean(local.directory.path && remote.directory.path) &&
    local.directory.path !== "::drives";
  return (
    <section className="file-workspace" aria-label="文件管理器">
      <div className="file-workspace-heading">
        <div>
          <FolderOpen size={19} aria-hidden="true" />
          <strong>文件管理</strong>
          <span className="tag neutral">SFTP</span>
          {session.demo && <span className="tag neutral">演示数据</span>}
        </div>
        <button className="button secondary compact" onClick={onClose}>
          <ArrowLeft size={14} aria-hidden="true" />
          返回终端
        </button>
      </div>
      <div className="transfer-toolbar">
        <div>
          <button
            className="button primary compact"
            disabled={!canTransfer || !local.selected.length}
            onClick={() => void enqueue("upload")}
            title="上传左侧所选项目到右侧当前目录"
          >
            <Upload size={14} aria-hidden="true" />
            上传{local.selected.length > 0 && ` (${local.selected.length})`}
            <ArrowRight size={13} aria-hidden="true" />
          </button>
          <button
            className="button secondary compact"
            disabled={!canTransfer || !remote.selected.length}
            onClick={() => void enqueue("download")}
            title="下载右侧所选项目到左侧当前目录"
          >
            <ArrowLeft size={13} aria-hidden="true" />
            <ArrowDownToLine size={14} aria-hidden="true" />
            下载{remote.selected.length > 0 && ` (${remote.selected.length})`}
          </button>
        </div>
        <label>
          同名文件
          <select
            aria-label="同名文件处理方式"
            value={conflict}
            onChange={(e) => setConflict(e.target.value as "skip" | "replace")}
          >
            <option value="skip">跳过</option>
            <option value="replace">替换</option>
          </select>
        </label>
      </div>
      {session.status !== "connected" && (
        <div role="status" className="file-connection-message">
          连接已断开，重新连接后可继续浏览和传输。
        </div>
      )}
      <div className="file-browsers">
        <FileBrowser
          side="local"
          state={local}
          session={session}
          onPreview={(...args) => void openPreview(...args)}
        />
        <FileBrowser
          side="remote"
          state={remote}
          session={session}
          onPreview={(...args) => void openPreview(...args)}
        />
      </div>
      <section
        className={`transfer-queue ${queueOpen ? "expanded" : ""}`}
        aria-label="传输队列"
      >
        <div className="transfer-queue-heading">
          <button
            aria-expanded={queueOpen}
            onClick={() => setQueueOpen(!queueOpen)}
          >
            <ChevronDown
              size={15}
              className={queueOpen ? "" : "collapsed"}
              aria-hidden="true"
            />
            <ListChecks size={16} aria-hidden="true" />
            <strong>传输队列</strong>
            <span>
              {active ? `${active} 个进行中` : `${transfers.length} 条记录`}
            </span>
          </button>
          {transfers.some(finished) && (
            <button
              className="queue-clear"
              onClick={() => {
                void backend()
                  .ClearTransfers(session.id)
                  .then(refreshJobs)
                  .catch((e) => notify(errorText(e)));
              }}
            >
              清除已结束
            </button>
          )}
        </div>
        {queueOpen &&
          (transfers.length ? (
            <div className="transfer-queue-list">
              {[...transfers].reverse().map((job) => {
                const percent =
                  job.status === "completed"
                    ? 100
                    : job.totalBytes
                      ? Math.min(
                          100,
                          Math.round((job.doneBytes / job.totalBytes) * 100),
                        )
                      : 0;
                const seconds =
                  ((job.finishedAt || Date.now()) - job.startedAt) / 1000;
                const speed =
                  job.startedAt && seconds > 0 && !finished(job)
                    ? size(Math.max(0, job.doneBytes) / Math.max(1, seconds)) +
                      "/s"
                    : "";
                return (
                  <div className={`transfer-job ${job.status}`} key={job.id}>
                    <div className="transfer-direction">
                      {job.direction === "upload" ? (
                        <Upload size={16} aria-label="上传" />
                      ) : (
                        <ArrowDownToLine size={16} aria-label="下载" />
                      )}
                    </div>
                    <div className="transfer-job-main">
                      <div>
                        <strong title={job.name}>{job.name}</strong>
                        <span className="transfer-job-state">
                          {statusText[job.status]}
                          {job.status === "running" && ` ${percent}%`}
                          {job.skipped > 0 && ` · 跳过 ${job.skipped} 项`}
                        </span>
                      </div>
                      <div className="transfer-job-detail">
                        <span
                          title={job.error || job.current || job.destination}
                        >
                          {job.error ||
                            (job.current
                              ? job.current.replace(/^.*[\\/]/, "") + " → "
                              : "") + job.destination}
                        </span>
                        <span>
                          {size(job.doneBytes)} / {size(job.totalBytes)}
                          {speed && ` · ${speed}`}
                        </span>
                      </div>
                      <progress
                        aria-label={`${job.name} 传输进度`}
                        value={percent}
                        max={100}
                      />
                    </div>
                    {!finished(job) ? (
                      <button
                        className="icon-button"
                        title="取消此传输"
                        aria-label={`取消传输 ${job.name}`}
                        disabled={job.status === "cancelling"}
                        onClick={() => {
                          void backend()
                            .CancelTransfer(job.id)
                            .then(refreshJobs)
                            .catch((e) => notify(errorText(e)));
                        }}
                      >
                        <X size={15} />
                      </button>
                    ) : job.status === "completed" ? (
                      <Check
                        className="job-complete"
                        size={17}
                        aria-hidden="true"
                      />
                    ) : job.status === "failed" ? (
                      <CircleAlert
                        className="job-failed"
                        size={17}
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="job-end" />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="transfer-queue-empty">
              暂无传输
            </div>
          ))}
      </section>
      <div className="file-workspace-status">
        <span>
          <ShieldCheck size={12} aria-hidden="true" />
          {session.demo ? "演示模式" : "SFTP"}
        </span>
        <span>双击打开 · Ctrl / Shift 多选</span>
      </div>
      {preview && (
        <Suspense
          fallback={
            <Modal title={preview.name} onClose={() => setPreview(null)}>
              <div className="browser-empty">
                <LoaderCircle className="spin" size={22} />
                正在打开…
              </div>
            </Modal>
          }
        >
          <TextFileDialog
            session={session}
            {...preview}
            onClose={() => setPreview(null)}
            onSaved={() => void remote.load(remote.latest.current.path)}
          />
        </Suspense>
      )}
    </section>
  );
}
