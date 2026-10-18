import { useEffect, useState } from "react";
import {
  ArrowRight,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { backend, errorText } from "./bridge";
import { Modal } from "./Dialogs";
import type { WSLInfo } from "./types";

export default function WSLDialog({
  onSelect,
  onClose,
}: {
  onSelect: (distribution: string) => void;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<WSLInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void backend()
      .GetWSLInfo()
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
    <Modal title="WSL" onClose={onClose}>
      {loading ? (
        <div className="wsl-empty">
          <LoaderCircle className="spin" size={20} />
          读取发行版…
        </div>
      ) : error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : info?.distributions.length ? (
        <div className="wsl-distributions">
          {info.distributions.map((distribution) => (
            <button
              key={distribution.name}
              onClick={() => onSelect(distribution.name)}
            >
              <TerminalSquare size={20} aria-hidden="true" />
              <strong>{distribution.name}</strong>
              <span>{distribution.running ? "运行中" : "未运行"}</span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <p className="wsl-empty">{info?.message || "没有可用的发行版"}</p>
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
