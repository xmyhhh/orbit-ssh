import { useEffect, useMemo, useState } from "react";
import { FileInput, FolderSearch, LoaderCircle } from "lucide-react";
import { backend, errorText } from "../bridge";
import type { SSHConfigEntry, SSHConfigImport } from "../types";
import { Modal } from "./Modal";

export function SSHConfigDialog({
  onImported,
  onClose,
}: {
  onImported: (result: { added: number; updated: number; skipped: number }) => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<SSHConfigImport | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");

  async function load(path = "") {
    setBusy(true);
    setError("");
    try {
      const value = await backend().ReadSSHConfig(path);
      setPreview(value);
      setSelected(new Set(value.entries.map((entry) => entry.alias)));
    } catch (e) {
      setPreview(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const entries = preview?.entries ?? [];
  const groups = useMemo(
    () => [...new Set(entries.map((entry) => entry.group))],
    [entries],
  );

  async function chooseFile() {
    try {
      const path = await backend().SelectSSHConfigFile();
      if (path) await load(path);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function submit() {
    const chosen: SSHConfigEntry[] = entries.filter((entry) =>
      selected.has(entry.alias),
    );
    if (!chosen.length) {
      setError("请至少选择一台主机");
      return;
    }
    setImporting(true);
    setError("");
    try {
      const result = await backend().ImportSSHConfig(chosen);
      onImported(result);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal
      title="从 SSH 配置导入"
      onClose={() => {
        if (!importing) onClose();
      }}
      className="ssh-config-dialog"
    >
      <div className="ssh-config-heading">
        <div>
          <strong>{preview?.path || "~/.ssh/config"}</strong>
          <span>
            {busy ? "正在解析…" : `发现 ${entries.length} 台主机`}
            {groups.length > 0 && ` · ${groups.join("、")}`}
          </span>
        </div>
        <button
          className="button secondary compact"
          type="button"
          disabled={busy || importing}
          onClick={() => void chooseFile()}
        >
          <FolderSearch size={14} />
          选择文件
        </button>
      </div>
      {busy ? (
        <div className="browser-empty">
          <LoaderCircle className="spin" size={22} />
          正在读取 SSH 配置…
        </div>
      ) : entries.length ? (
        <>
          <div className="ssh-config-actions">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={selected.size === entries.length}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? new Set(entries.map((entry) => entry.alias))
                      : new Set(),
                  )
                }
              />
              全选
            </label>
            <span>{selected.size} 项已选择</span>
          </div>
          <div className="ssh-config-list" role="list">
            {entries.map((entry) => (
              <label
                key={entry.alias}
                className="ssh-config-entry"
                role="listitem"
              >
                <input
                  type="checkbox"
                  checked={selected.has(entry.alias)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(entry.alias);
                    else next.delete(entry.alias);
                    setSelected(next);
                  }}
                />
                <span className="ssh-config-alias">
                  <strong>{entry.alias}</strong>
                  <code>
                    {entry.username || "root"}@{entry.address}:{entry.port}
                  </code>
                </span>
                <span className="tag neutral">
                  {entry.authType === "key"
                    ? "私钥"
                    : entry.authType === "agent"
                      ? "Agent"
                      : "密码"}
                </span>
                {entry.jumpAlias && (
                  <span className="tag neutral">跳板 {entry.jumpAlias}</span>
                )}
                {entry.imported && <span className="tag neutral">将更新</span>}
              </label>
            ))}
          </div>
        </>
      ) : (
        !error && <p className="field-hint">配置中没有可导入的具体主机。</p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button
          className="button secondary"
          type="button"
          onClick={onClose}
          disabled={importing}
        >
          取消
        </button>
        <button
          className="button primary"
          type="button"
          disabled={importing || busy || !entries.length}
          onClick={() => void submit()}
        >
          <FileInput size={15} />
          {importing ? "正在导入…" : `导入 ${selected.size} 台主机`}
        </button>
      </div>
    </Modal>
  );
}
