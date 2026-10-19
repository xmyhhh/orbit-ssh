import { useState } from "react";
import { ChevronRight, KeyRound, Search, TerminalSquare } from "lucide-react";
import type { Host } from "../types";
import { Modal } from "./Modal";

export function CommandPalette({
  hosts,
  onSelect,
  onNew,
  onClose,
}: {
  hosts: Host[];
  onSelect: (host: Host) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = hosts.filter((h) =>
    `${h.name} ${h.address} ${h.group}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Modal title="快速切换" onClose={onClose}>
      <div className="palette-search">
        <Search size={18} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称、IP 地址或分组…"
          aria-label="搜索主机"
        />
      </div>
      <div className="palette-results">
        {filtered.map((h) => (
          <button
            key={h.id}
            onClick={() => {
              onClose();
              onSelect(h);
            }}
          >
            <span className={`host-icon small ${h.color}`}>
              <TerminalSquare size={18} />
            </span>
            <span>
              <strong>{h.name}</strong>
              <code>
                {h.username}@{h.address}
              </code>
            </span>
            <ChevronRight size={15} />
          </button>
        ))}
        {!filtered.length && (
          <p className="palette-empty">
            {hosts.length
              ? "没有找到匹配的主机"
              : "你的主机列表还是空的，从第一台开始。"}
          </p>
        )}
        <button
          onClick={() => {
            onClose();
            onNew();
          }}
        >
          <KeyRound size={18} />
          <strong>添加新主机</strong>
          <kbd>Ctrl T</kbd>
        </button>
      </div>
    </Modal>
  );
}
