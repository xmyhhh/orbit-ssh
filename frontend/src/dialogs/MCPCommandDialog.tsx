import { useEffect, useRef, useState } from "react";
import { backend, errorText } from "../bridge";
import type { MCPCommandRequest } from "../types";
import { approvalDeadline, isApprovalExpired, isApprovalGone } from "../mcpApproval";
import { Modal } from "./Modal";

export function MCPCommandDialog({
  request,
  onClose,
}: {
  request: MCPCommandRequest;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const danger = request.dangerous ?? dangerous(request.command);
  const close = useRef(onClose);
  close.current = onClose;
  const processing = useRef(false);
  useEffect(() => {
    const deadline = approvalDeadline(request);
    const timer = deadline === undefined ? undefined : window.setTimeout(
      () => close.current(), Math.max(0, deadline - Date.now()),
    );
    // Reconcile missed events (hidden/minimized windows can suspend WebView
    // delivery). A rejected/expired request must not trap the user in a modal.
    let cancelled = false;
    const check = async () => {
      if (isApprovalExpired(request)) {
        close.current();
        return;
      }
      try {
        const pending = await backend().ListMCPCommands();
        if (!cancelled && !pending.some((item) => item.id === request.id))
          close.current();
      } catch {
        // A transient bridge failure is not approval or rejection.
      }
    };
    const interval = window.setInterval(() => void check(), 1000);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("focus", check);
    };
  }, [request.id, request.createdAt, request.expiresAt]);

  async function decide(approved: boolean) {
    if (isApprovalExpired(request)) {
      onClose();
      return;
    }
    // Closing or rejecting always dismisses immediately, even when the
    // backend has already expired the request or the bridge is unavailable.
    if (!approved) {
      onClose();
      if (!processing.current)
        void backend().DecideMCPCommand(request.id, false).catch(() => {});
      return;
    }
    if (processing.current) return;
    processing.current = true;
    setBusy(true);
    setError("");
    try {
      await backend().DecideMCPCommand(request.id, true);
      onClose();
    } catch (e) {
      const message = errorText(e);
      if (isApprovalGone(message)) onClose();
      else setError(message);
      setBusy(false);
    } finally {
      processing.current = false;
    }
  }
  return (
    <Modal
      title="执行命令？"
      onClose={() => void decide(false)}
    >
      <div className="mcp-command-target">
        <span>控制台</span>
        <strong>{request.sessionName || request.sessionId}</strong>
        {danger && <span className="mcp-command-risk">高风险</span>}
      </div>
      <pre className="mcp-command-text" aria-label="待执行命令" tabIndex={0}>
        <code>{request.command}</code>
      </pre>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button
          className="button secondary"
          aria-label="拒绝执行命令"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          拒绝
        </button>
        <button
          className={`button ${danger ? "danger" : "primary"}`}
          aria-label="允许执行命令"
          disabled={busy}
          onClick={() => void decide(true)}
        >
          {busy ? "处理中…" : "允许执行"}
        </button>
      </div>
    </Modal>
  );
}

const riskyPatterns = [
  "rm -rf /",
  "rm -fr /",
  "mkfs",
  "dd if=",
  "> /dev/sd",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "init 0",
  "chmod -r 777 /",
  ":(){",
  "sudo rm -rf",
  "mv /* ",
  "userdel",
  "passwd root",
];

export function dangerous(command: string): boolean {
  const value = command.trim().toLowerCase();
  return riskyPatterns.some((pattern) => value.includes(pattern));
}
