import { useState } from "react";
import { errorText } from "../bridge";
import { Modal } from "./Modal";

export function ConfirmDialog({
  title,
  message,
  action = "确认",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  action?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="confirm-message">{message}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          取消
        </button>
        <button
          className={`button ${danger ? "danger" : "primary"}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}
        >
          {busy ? "处理中…" : action}
        </button>
      </div>
    </Modal>
  );
}
