import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Copy,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import type { Host } from "./types";

export default function HostContextMenu({
  host,
  online,
  x,
  y,
  onConnect,
  onEdit,
  onFavorite,
  onCopy,
  onDelete,
  onClose,
}: {
  host: Host;
  online: boolean;
  x: number;
  y: number;
  onConnect: () => void;
  onEdit: () => void;
  onFavorite: () => void;
  onCopy: (text: string, message: string) => void;
  onDelete: () => void;
  onClose: () => void;
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
        onClose();
      } else if (e.key === "Tab") onClose();
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
    onClose();
    action();
  }
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`${host.name} 的主机操作`}
      className="host-context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <div className="host-context-name" aria-hidden="true">
        {host.name}
      </div>
      <button role="menuitem" onClick={() => run(onConnect)}>
        <ArrowUpRight size={15} aria-hidden="true" />
        {online ? "新建终端" : "连接"}
      </button>
      <button role="menuitem" onClick={() => run(onEdit)}>
        <Pencil size={15} aria-hidden="true" />
        编辑主机
      </button>
      <button role="menuitem" onClick={() => run(onFavorite)}>
        <Star size={15} aria-hidden="true" />
        {host.favorite ? "取消收藏" : "收藏主机"}
      </button>
      <button
        role="menuitem"
        onClick={() => run(() => onCopy(host.address, `已复制 ${host.name} 的 IP 地址`))}
      >
        <Copy size={15} aria-hidden="true" />
        复制 IP 地址
      </button>
      <button
        role="menuitem"
        onClick={() =>
          run(() =>
            onCopy(
              `${host.username}@${host.address}`,
              `已复制 ${host.name} 的 用户@IP`,
            ),
          )
        }
      >
        <Copy size={15} aria-hidden="true" />
        复制 用户@IP
      </button>
      <button role="menuitem" className="danger" onClick={() => run(onDelete)}>
        <Trash2 size={15} aria-hidden="true" />
        移除主机
      </button>
    </div>,
    document.body,
  );
}
