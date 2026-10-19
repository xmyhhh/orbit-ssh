import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Eye,
  FolderOpen,
  KeyRound,
  Pencil,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import type { RemoteFile } from "./types";

export default function FileContextMenu({
  file,
  remote,
  x,
  y,
  onOpen,
  onRename,
  onMove,
  onChmod,
  onDelete,
  onClose,
}: {
  file: RemoteFile;
  remote: boolean;
  x: number;
  y: number;
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onChmod: () => void;
  onDelete: () => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }, [x, y]);
  useEffect(() => {
    function outside(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      } else if (e.key === "Tab") onClose(true);
    }
    function dismiss() {
      onClose();
    }
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [onClose]);
  function run(action: () => void) {
    onClose(true);
    action();
  }
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`${file.name} 的文件操作`}
      className="file-context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <div className="file-context-name" aria-hidden="true">
        {file.name}
      </div>
      <button role="menuitem" onClick={() => run(onOpen)}>
        {file.isDir ? (
          <FolderOpen size={15} aria-hidden="true" />
        ) : remote ? (
          <Pencil size={15} aria-hidden="true" />
        ) : (
          <Eye size={15} aria-hidden="true" />
        )}
        {file.isDir ? "打开文件夹" : remote ? "编辑" : "预览"}
      </button>
      {remote && (
        <>
          <button role="menuitem" onClick={() => run(onRename)}>
            <TextCursorInput size={15} aria-hidden="true" />
            重命名
          </button>
          <button role="menuitem" onClick={() => run(onMove)}>
            <FolderOpen size={15} aria-hidden="true" />
            移动到…
          </button>
          <button role="menuitem" onClick={() => run(onChmod)}>
            <KeyRound size={15} aria-hidden="true" />
            修改权限
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={() => run(onDelete)}
          >
            <Trash2 size={15} aria-hidden="true" />
            删除
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
