import { useEffect, useState } from "react";
import {
  ArrowRight,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { backend, errorText } from "./bridge";
import { Modal } from "./Dialogs";
import type { LocalShell, LocalShellInfo } from "./types";

export default function LocalShellDialog({
  onSelect,
  onClose,
}: {
  onSelect: (shell: LocalShell) => void;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<LocalShellInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void backend()
      .GetLocalShellInfo()
      .then((value) => {
        if (current) setInfo(value);
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [refresh]);
  return (
    <Modal title="本地 Shell" onClose={onClose}>
      <p className="field-hint">选择 Shell，在当前电脑的用户目录中打开终端。</p>
      {loading ? (
        <div className="wsl-empty">
          <LoaderCircle className="spin" size={20} />
          读取本地 Shell…
        </div>
      ) : error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : info?.shells.length ? (
        <div className="shell-options">
          {info.shells.map((shell) => (
            <button
              key={shell.id}
              title={shell.path}
              onClick={() => onSelect(shell)}
            >
              <TerminalSquare size={20} aria-hidden="true" />
              <strong>{shell.name}</strong>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <p className="wsl-empty">{info?.message || "没有可用的本地 Shell"}</p>
      )}
      <div className="modal-footer">
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} aria-hidden="true" />
          刷新
        </button>
      </div>
    </Modal>
  );
}
