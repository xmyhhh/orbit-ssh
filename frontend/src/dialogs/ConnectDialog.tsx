import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ChevronRight,
  Eye,
  EyeOff,
  Fingerprint,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import type { Credentials, Host } from "../types";
import { backend, errorText, isDesktop } from "../bridge";
import { Modal } from "./Modal";

export function ConnectDialog({
  host,
  onConnect,
  onClose,
}: {
  host: Host;
  onConnect: (
    host: Host,
    credentials: Credentials,
    fingerprint: string,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [credentials, setCredentials] = useState<Credentials>({
    password: "",
    passphrase: "",
    rememberKey: true,
    rememberPassword: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [checkingPassword, setCheckingPassword] = useState(
    host.authType === "password" && isDesktop(),
  );
  const [showPassword, setShowPassword] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let current = true;
    if (host.authType === "password" && isDesktop()) {
      void backend()
        .HasSavedPassword(host.id)
        .then((saved) => {
          if (!current) return;
          setHasSavedPassword(saved);
          setCheckingPassword(false);
          if (saved) void connect();
        })
        .catch((e) => {
          if (!current) return;
          setCheckingPassword(false);
          setError(errorText(e));
        });
    }
    const timer =
      host.authType === "key"
        ? requestAnimationFrame(() => void connect())
        : undefined;
    return () => {
      mounted.current = false;
      current = false;
      if (timer !== undefined) cancelAnimationFrame(timer);
    };
  }, []);
  async function connect(e?: FormEvent, accepted = "") {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onConnect(host, credentials, accepted);
      if (!mounted.current) return;
      setCredentials({ password: "", passphrase: "" });
      onClose();
    } catch (e) {
      if (!mounted.current) return;
      const message = errorText(e);
      const unknown = message.match(
        /HOST_KEY_UNKNOWN\|(SHA256:[A-Za-z0-9+/=]+)/,
      );
      if (unknown) setFingerprint(unknown[1]);
      else {
        setFingerprint("");
        setError(
          message.includes("HOST_KEY_CHANGED")
            ? `服务器指纹与之前保存的记录不同，连接已拒绝。请先与服务器管理员核实。\n${message}`
            : message
                .replace("KEY_PASSPHRASE_REQUIRED|", "")
                .replace("PASSWORD_REQUIRED|", ""),
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={fingerprint ? "确认服务器身份" : `连接 ${host.name}`}
      onClose={onClose}
    >
      <div className="connection-destination">
        <span className={`host-icon ${host.color}`}>
          <TerminalSquare size={23} />
        </span>
        <div>
          <strong>{host.name}</strong>
          <code>
            {host.username}@{host.address}:{host.port}
          </code>
        </div>
        <ShieldCheck size={20} />
      </div>
      {fingerprint ? (
        <>
          <div className="trust-copy">
            <Fingerprint size={28} />
            <p>请通过云控制台或管理员核对服务器指纹。</p>
          </div>
          <code className="fingerprint">{fingerprint}</code>
          <div className="modal-footer">
            <button className="button secondary" onClick={onClose}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void connect(undefined, fingerprint)}
            >
              {busy ? "正在连接…" : "信任并连接"}
              <ShieldCheck size={16} />
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => void connect(e)}>
          <label className="field">
            {host.authType === "key" ? "私钥口令（未加密可留空）" : "登录密码"}
            <div className="input-action">
              <input
                autoFocus
                type={showPassword ? "text" : "password"}
                name="password"
                required={host.authType === "password" && !hasSavedPassword}
                disabled={busy || checkingPassword}
                placeholder={hasSavedPassword ? "留空使用已保存密码" : ""}
                autoComplete="current-password"
                value={
                  host.authType === "password"
                    ? credentials.password
                    : credentials.passphrase
                }
                onChange={(e) =>
                  setCredentials((c) =>
                    host.authType === "password"
                      ? { ...c, password: e.target.value }
                      : { ...c, passphrase: e.target.value },
                  )
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                aria-pressed={showPassword}
                disabled={busy || checkingPassword}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </label>
          <input
            type="hidden"
            name="username"
            autoComplete="username"
            value={host.username}
          />
          {host.authType === "password" && (
            <div className="password-options">
              <label className="key-remember">
                <input
                  type="checkbox"
                  checked={credentials.rememberPassword ?? true}
                  disabled={busy || checkingPassword}
                  onChange={(e) =>
                    setCredentials((c) => ({
                      ...c,
                      rememberPassword: e.target.checked,
                    }))
                  }
                />
                记住密码（本机加密）
              </label>
              {hasSavedPassword && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || checkingPassword}
                  onClick={() => {
                    void backend()
                      .ForgetPassword(host.id)
                      .then(() => {
                        if (mounted.current) {
                          setHasSavedPassword(false);
                          setError("");
                        }
                      })
                      .catch((e) => {
                        if (mounted.current) setError(errorText(e));
                      });
                  }}
                >
                  清除已保存密码
                </button>
              )}
            </div>
          )}
          {host.authType === "key" && (
            <label className="key-remember">
              <input
                type="checkbox"
                checked={credentials.rememberKey ?? true}
                onChange={(e) =>
                  setCredentials((c) => ({
                    ...c,
                    rememberKey: e.target.checked,
                  }))
                }
              />
              记住私钥口令（本机加密）
            </label>
          )}
          {host.authType === "password" &&
            hasSavedPassword &&
            credentials.rememberPassword === false && (
              <p className="field-hint">连接成功后清除已保存密码。</p>
            )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={busy || checkingPassword}
            >
              {checkingPassword
                ? "检查已保存密码…"
                : busy
                  ? "正在连接…"
                  : "建立连接"}
              <ChevronRight size={16} />
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
