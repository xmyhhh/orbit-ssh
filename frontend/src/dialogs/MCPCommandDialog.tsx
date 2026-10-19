import { useState } from "react";
import { ShieldAlert, TerminalSquare } from "lucide-react";
import { backend, errorText } from "../bridge";
import type { MCPCommandRequest } from "../types";
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
  async function decide(approved: boolean) {
    setBusy(true);
    setError("");
    try {
      await backend().DecideMCPCommand(request.id, approved);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal title="AI 请求执行命令" onClose={() => void decide(false)}>
      <div className={`mcp-command ${danger ? "danger" : ""}`}>
        <ShieldAlert size={22} aria-hidden="true" />
        <div>
          <strong>
            {request.sessionName
              ? `会话：${request.sessionName}`
              : `会话 ${request.sessionId}`}
          </strong>
          <p>
            此命令由 MCP 客户端提交，只有在你确认后才会发送到终端。请仔细核对。
          </p>
        </div>
      </div>
      <pre className="mcp-command-text" aria-label="待执行命令">
        <TerminalSquare size={14} aria-hidden="true" />
        <code>{request.command}</code>
      </pre>
      {danger && (
        <p role="alert" className="form-error">
          这条命令包含可能破坏系统的操作，请确认目标主机和参数。
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          拒绝
        </button>
        <button
          className={`button ${danger ? "danger" : "primary"}`}
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
