import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  ArrowDownToLine,
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
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  X,
} from "lucide-react";
import { backend, errorText } from "../bridge";
import { androidCall, isAndroid } from "../android";
import FileContextMenu from "../FileContextMenu";
import type { RemoteFile, Session } from "../types";
import { child, size } from "./fileUtils";
import type { Side } from "./fileUtils";
import type { BrowserState } from "./useDirectory";

export default function FileBrowser({
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
              title={isAndroid() ? "从手机导入文件" : "选择本地文件夹"}
              aria-label={isAndroid() ? "从手机导入文件" : "选择本地文件夹"}
              disabled={session.demo || busy}
              onClick={() => void chooseFolder()}
            >
              <FolderOpen size={16} />
            </button>
          )}
          {isAndroid() &&
            side === "local" &&
            selected.length === 1 &&
            !files.find((file) => file.name === selected[0])?.isDir && (
              <button
                className="icon-button"
                title="导出到手机"
                aria-label="导出到手机"
                onClick={() =>
                  void androidCall(
                    "ExportLocalFile",
                    child(directory.path, selected[0], side),
                  ).catch((error) => setError(errorText(error)))
                }
              >
                <ArrowDownToLine size={16} />
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
                      if (e.detail === 0 || isAndroid()) {
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
