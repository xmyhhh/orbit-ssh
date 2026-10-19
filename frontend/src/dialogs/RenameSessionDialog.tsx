import { useState } from "react";
import type { FormEvent } from "react";
import { errorText } from "../bridge";
import { Modal } from "./Modal";

const maxNameLength = 80;

export function RenameSessionDialog({
  title = "重命名终端",
  currentName,
  defaultName,
  onRename,
  onClose,
}: {
  title?: string;
  currentName: string;
  defaultName: string;
  onRename: (name: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if ([...value].length > maxNameLength) {
      setError("名称最长为 80 个字符。");
      return;
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      setError("名称不能包含换行或控制字符。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onRename(value);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={save}>
        <label className="field">
          <span>会话名称</span>
          <input
            value={name}
            maxLength={maxNameLength}
            placeholder={defaultName}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="field-hint">
          留空可恢复默认名称：{defaultName}。名称会同步到终端标签、分屏标题和终端历史。
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "保存中…" : "保存名称"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
