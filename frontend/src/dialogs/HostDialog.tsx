import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Check,
  ChevronRight,
  FileKey2,
  Fingerprint,
  FolderOpen,
  LockKeyhole,
  Network,
  ShieldOff,
} from "lucide-react";
import type { Host } from "../types";
import { backend, errorText, isDesktop } from "../bridge";
import { Modal } from "./Modal";
import { HostTunnelingFields } from "./HostTunnelingFields";
import { defaultX11, validateTunnelSettings } from "../tunneling";
import { Select } from "../ui/Select";

const colors = [
  { id: "mint", label: "薄荷绿" },
  { id: "blue", label: "天空蓝" },
  { id: "amber", label: "琥珀黄" },
  { id: "violet", label: "淡紫色" },
];

// A key pair ships as "<name>" and "<name>.pub"; only the first one can be
// parsed as a private key, so a public key is rejected before it is saved.
const publicKeyWarning =
  "这是公钥文件（.pub），私钥登录需要选择不带 .pub 后缀的私钥文件。";

function isPublicKeyPath(path: string) {
  return /\.pub$/i.test(path.trim());
}

export function HostDialog({
  host,
  isNew = false,
  groups,
  hosts = [],
  onSave,
  onClose,
}: {
  host?: Host;
  isNew?: boolean;
  groups: string[];
  hosts?: Host[];
  onSave: (host: Host) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Host>(
    host ?? {
      id: crypto.randomUUID(),
      name: "",
      address: "",
      port: 22,
      username: "root",
      group: "默认分组",
      authType: "password",
      keyPath: "",
      color: "mint",
      favorite: false,
      lastConnected: "",
    },
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [credentialNotice, setCredentialNotice] = useState("");
  const [trustedFingerprint, setTrustedFingerprint] = useState<string | null>(
    null,
  );
  const [trustNotice, setTrustNotice] = useState("");
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [tab, setTab] = useState<"connection" | "tunneling">("connection");
  useEffect(() => {
    if (!host || isNew || !isDesktop()) return;
    let active = true;
    setTrustedFingerprint(null);
    setTrustNotice("");
    setConfirmingForget(false);
    backend()
      .TrustedFingerprint(host.id)
      .then((value) => {
        if (active) setTrustedFingerprint(value || "");
      })
      .catch(() => {
        if (active) setTrustedFingerprint(null);
      });
    return () => {
      active = false;
    };
  }, [host, isNew]);
  function forgetFingerprint() {
    if (!host) return;
    setError("");
    setTrustNotice("");
    void backend()
      .ForgetHostKey(host.id)
      .then(() => {
        setTrustedFingerprint("");
        setConfirmingForget(false);
        setTrustNotice("已清除已信任的服务器指纹，下次连接需重新核对。");
      })
      .catch((e) => setError(errorText(e)));
  }
  const keyPathWarning =
    form.authType === "key" && isPublicKeyPath(form.keyPath)
      ? publicKeyWarning
      : "";
  const field = <K extends keyof Host>(key: K, value: Host[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (form.authType === "key" && isPublicKeyPath(form.keyPath)) {
      setTab("connection");
      setError("请先修正上面标红的字段。");
      return;
    }
    if (
      !form.name.trim() ||
      !form.username.trim() ||
      !Number.isInteger(form.port) ||
      form.port < 1 ||
      form.port > 65535 ||
      (form.authType === "key" && !form.keyPath.trim())
    ) {
      setTab("connection");
      setError("请填写主机名称、用户名和有效端口；私钥登录需选择私钥文件。");
      return;
    }
    if (!form.address.trim() || /[\s/\\]/.test(form.address)) {
      setTab("connection");
      setError("主机地址应为 IP 或域名，不包含协议、空格或路径。");
      return;
    }
    const tunnelError = validateTunnelSettings(
      form.portForwards ?? [],
      form.x11 ?? defaultX11,
    );
    if (tunnelError) {
      setTab("tunneling");
      setError(tunnelError);
      return;
    }
    setSaving(true);
    try {
      await onSave({
        ...form,
        name: form.name.trim(),
        address: form.address.trim(),
        username: form.username.trim(),
        group: form.group.trim() || "默认分组",
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={host && !isNew ? "编辑主机" : "新建主机"}
      onClose={() => {
        if (!saving) onClose();
      }}
      className="host-dialog"
    >
      <form onSubmit={save} noValidate>
        <div
          className="host-settings-tabs"
          role="tablist"
          aria-label="主机设置"
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
              return;
            e.preventDefault();
            const next =
              e.key === "Home"
                ? "connection"
                : e.key === "End"
                  ? "tunneling"
                  : tab === "connection"
                    ? "tunneling"
                    : "connection";
            setTab(next);
            document.getElementById(`host-tab-${next}`)?.focus();
          }}
        >
          <button
            type="button"
            id="host-tab-connection"
            role="tab"
            aria-selected={tab === "connection"}
            aria-controls="host-panel-connection"
            tabIndex={tab === "connection" ? 0 : -1}
            onClick={() => setTab("connection")}
          >
            连接设置
          </button>
          <button
            type="button"
            id="host-tab-tunneling"
            role="tab"
            aria-selected={tab === "tunneling"}
            aria-controls="host-panel-tunneling"
            tabIndex={tab === "tunneling" ? 0 : -1}
            onClick={() => setTab("tunneling")}
          >
            SSH 隧道
          </button>
        </div>
        <fieldset
          className="host-settings-panel"
          id="host-panel-connection"
          role="tabpanel"
          aria-labelledby="host-tab-connection"
          hidden={tab !== "connection"}
          disabled={saving}
        >
          <label className="field">
            主机名称
            <input
              autoFocus
              required
              maxLength={80}
              value={form.name}
              placeholder="例如：我的云服务器"
              onChange={(e) => field("name", e.target.value)}
            />
          </label>
          <div className="form-row host-address">
            <label className="field">
              主机地址
              <input
                required
                value={form.address}
                placeholder="192.168.1.10 或 example.com"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => field("address", e.target.value)}
              />
            </label>
            <label className="field">
              端口
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={form.port || ""}
                onChange={(e) => field("port", Number(e.target.value))}
              />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              用户名
              <input
                required
                value={form.username}
                autoCapitalize="none"
                autoComplete="username"
                onChange={(e) => field("username", e.target.value)}
              />
            </label>
            <div className="field">
              <span>所属分组</span>
              <Select
                ariaLabel="所属分组"
                size="lg"
                creatable
                createLabel="新建分组"
                value={form.group}
                onChange={(value) => field("group", value)}
                options={groups.map((group) => ({
                  value: group,
                  label: group,
                }))}
              />
            </div>
          </div>
          <fieldset className="auth-options">
            <legend>认证方式</legend>
            <button
              type="button"
              aria-pressed={form.authType === "password"}
              className={form.authType === "password" ? "selected" : ""}
              onClick={() => field("authType", "password")}
            >
              <LockKeyhole size={16} />
              密码登录{form.authType === "password" && <Check size={15} />}
            </button>
            <button
              type="button"
              aria-pressed={form.authType === "key"}
              className={form.authType === "key" ? "selected" : ""}
              onClick={() => field("authType", "key")}
            >
              <FileKey2 size={16} />
              私钥登录{form.authType === "key" && <Check size={15} />}
            </button>
            <button
              type="button"
              aria-pressed={form.authType === "agent"}
              className={form.authType === "agent" ? "selected" : ""}
              onClick={() => field("authType", "agent")}
            >
              <Network size={16} />
              SSH Agent{form.authType === "agent" && <Check size={15} />}
            </button>
          </fieldset>
          {form.authType === "key" && (
            <label className="field">
              私钥文件
              <div className="input-action">
                <input
                  required
                  value={form.keyPath}
                  placeholder="选择私钥文件，例如 id_ed25519"
                  onChange={(e) => field("keyPath", e.target.value)}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="选择私钥文件"
                  disabled={!isDesktop()}
                  onClick={() => {
                    void backend()
                      .SelectKeyFile()
                      .then((p) => {
                        if (!p) return;
                        field("keyPath", p);
                        if (isPublicKeyPath(p)) setError(publicKeyWarning);
                      })
                      .catch((e) => setError(errorText(e)));
                  }}
                >
                  <FolderOpen size={18} />
                </button>
              </div>
              {keyPathWarning ? (
                <p className="form-error" role="alert">
                  {keyPathWarning}
                </p>
              ) : (
                <span className="field-hint">
                  填写私钥文件路径，不要选同名 .pub 公钥文件。
                </span>
              )}
              {isDesktop() && (
                <button
                  className="text-button"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    void backend()
                      .GenerateKeyPair(
                        `${form.name || "orbit"}-ed25519`.replace(/\s+/g, "-"),
                      )
                      .then(([privatePath]) => {
                        field("keyPath", privatePath);
                        setCredentialNotice(
                          "已生成 Ed25519 密钥，公钥保存在同名 .pub 文件。",
                        );
                      })
                      .catch((e) => setError(errorText(e)));
                  }}
                >
                  生成新的 Ed25519 密钥
                </button>
              )}
            </label>
          )}
          <div className="field">
            <span>跳板机（ProxyJump，可选）</span>
            <Select
              ariaLabel="跳板机（ProxyJump，可选）"
              size="lg"
              value={form.jumpHostId ?? ""}
              onChange={(value) => field("jumpHostId", value)}
              options={[
                { value: "", label: "直连目标主机" },
                ...hosts
                  .filter((item) => item.id !== form.id)
                  .map((item) => ({
                    value: item.id,
                    label: `${item.name}（${item.username}@${item.address}）`,
                  })),
              ]}
            />
            <span className="field-hint">
              通过另一台已保存主机转发连接；跳板机需已信任其服务器指纹。
            </span>
          </div>
          {host && !isNew && isDesktop() && trustedFingerprint !== null && (
            <div className="field trusted-fingerprint-field">
              <span>
                <Fingerprint size={14} />
                已信任的服务器指纹
              </span>
              {trustedFingerprint ? (
                <>
                  <code className="trusted-fingerprint">
                    {trustedFingerprint}
                  </code>
                  <p className="field-hint">
                    服务器重装系统或更换 SSH 主机密钥后，可清除指纹并在下次连接时重新核对。
                  </p>
                  {confirmingForget ? (
                    <>
                      <p className="field-hint" role="alert">
                        清除后，下次连接会重新显示服务器指纹并要求核对。仅在确认服务器已重装系统或密钥已更换时继续。
                      </p>
                      <div className="trust-confirm-actions">
                        <button
                          className="text-button danger"
                          type="button"
                          disabled={saving}
                          onClick={forgetFingerprint}
                        >
                          <ShieldOff size={15} />
                          确认清除
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setConfirmingForget(false)}
                        >
                          取消
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      className="text-button"
                      type="button"
                      disabled={saving}
                      onClick={() => setConfirmingForget(true)}
                    >
                      <ShieldOff size={15} />
                      清除已信任指纹
                    </button>
                  )}
                </>
              ) : (
                <p className="field-hint" role="status">
                  {trustNotice ||
                    "此主机尚未信任服务器指纹，首次连接时会要求核对。"}
                </p>
              )}
            </div>
          )}
          <div className="color-field">
            <span>主机颜色</span>
            <div>
              {colors.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`color-swatch ${c.id} ${form.color === c.id ? "checked" : ""}`}
                  aria-label={c.label}
                  aria-pressed={form.color === c.id}
                  onClick={() => field("color", c.id)}
                >
                  {form.color === c.id && <Check size={13} />}
                </button>
              ))}
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.favorite}
                onChange={(e) => field("favorite", e.target.checked)}
              />
              收藏主机
            </label>
          </div>
          {host && !isNew && form.authType === "key" && isDesktop() && (
            <button
              className="text-button forget-key"
              type="button"
              onClick={() =>
                void backend()
                  .ForgetKeyPassphrase(host.id)
                  .then(() => setError("已清除保存的私钥口令"))
                  .catch((e) => setError(errorText(e)))
              }
            >
              清除已保存的私钥口令
            </button>
          )}
          {host && !isNew && form.authType === "password" && isDesktop() && (
            <button
              className="text-button forget-key"
              type="button"
              disabled={saving}
              onClick={() => {
                setCredentialNotice("");
                void backend()
                  .ForgetPassword(host.id)
                  .then(() => setCredentialNotice("已清除保存的密码"))
                  .catch((e) => setError(errorText(e)));
              }}
            >
              清除已保存的密码
            </button>
          )}
        </fieldset>
        <fieldset
          className="host-settings-panel"
          id="host-panel-tunneling"
          role="tabpanel"
          aria-labelledby="host-tab-tunneling"
          hidden={tab !== "tunneling"}
          disabled={saving}
        >
          <HostTunnelingFields
            rules={form.portForwards ?? []}
            x11={form.x11 ?? defaultX11}
            onRules={(rules) => field("portForwards", rules)}
            onX11={(config) => field("x11", config)}
            onError={setError}
          />
        </fieldset>
        {credentialNotice && (
          <p role="status" className="field-hint">
            {credentialNotice}
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? "正在保存…" : "保存主机"}
            <ChevronRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
