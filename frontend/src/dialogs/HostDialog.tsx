import { useState } from "react";
import type { FormEvent } from "react";
import {
  Check,
  ChevronRight,
  FileKey2,
  FolderOpen,
  LockKeyhole,
} from "lucide-react";
import type { Host } from "../types";
import { backend, errorText, isDesktop } from "../bridge";
import { Modal } from "./Modal";

const colors = [
  { id: "mint", label: "薄荷绿" },
  { id: "blue", label: "天空蓝" },
  { id: "amber", label: "琥珀黄" },
  { id: "violet", label: "淡紫色" },
];

export function HostDialog({
  host,
  isNew = false,
  groups,
  onSave,
  onClose,
}: {
  host?: Host;
  isNew?: boolean;
  groups: string[];
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
  const field = <K extends keyof Host>(key: K, value: Host[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.address.trim() || /[\s/\\]/.test(form.address)) {
      setError("主机地址应为 IP 或域名，不包含协议、空格或路径。");
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
    >
      <form onSubmit={save}>
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
          <label className="field">
            所属分组
            <input
              list="host-groups"
              value={form.group}
              onChange={(e) => field("group", e.target.value)}
            />
            <datalist id="host-groups">
              {groups.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </datalist>
          </label>
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
        </fieldset>
        {form.authType === "key" && (
          <label className="field">
            私钥文件
            <div className="input-action">
              <input
                required
                value={form.keyPath}
                placeholder="选择 PEM 或 OpenSSH 私钥"
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
                      if (p) field("keyPath", p);
                    })
                    .catch((e) => setError(errorText(e)));
                }}
              >
                <FolderOpen size={18} />
              </button>
            </div>
          </label>
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
