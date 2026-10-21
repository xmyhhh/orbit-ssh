import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Copy,
  Ellipsis,
  Pencil,
  Server,
  Star,
  Trash2,
} from "lucide-react";
import { errorText, writeClipboard } from "./bridge";
import HostContextMenu from "./HostContextMenu";
import type { Host } from "./types";

export default function HostCard({
  host,
  online,
  onConnect,
  onEdit,
  onDelete,
  onFavorite,
  onNotify,
}: {
  host: Host;
  online: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onFavorite: () => void;
  onNotify?: (message: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
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
  function copy(text: string, message: string) {
    void writeClipboard(text)
      .then(() => onNotify?.(message))
      .catch((error) => onNotify?.(`复制失败：${errorText(error)}`));
  }
  return (
    <article
      className="host-card"
      title={online ? "双击新建终端" : "双击连接"}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(false);
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
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
                onClick={() => {
                  setMenuOpen(false);
                  copy(host.address, `已复制 ${host.name} 的 IP 地址`);
                }}
              >
                <Copy size={14} />
                复制 IP 地址
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  copy(
                    `${host.username}@${host.address}`,
                    `已复制 ${host.name} 的 用户@IP`,
                  );
                }}
              >
                <Copy size={14} />
                复制 用户@IP
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
      {contextMenu && (
        <HostContextMenu
          host={host}
          online={online}
          x={contextMenu.x}
          y={contextMenu.y}
          onConnect={onConnect}
          onEdit={onEdit}
          onFavorite={onFavorite}
          onCopy={copy}
          onDelete={onDelete}
          onClose={() => setContextMenu(null)}
        />
      )}
    </article>
  );
}
