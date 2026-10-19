import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Clipboard,
  Eye,
  EyeOff,
  FileKey2,
  Fingerprint,
  FolderOpen,
  KeyRound,
  LockKeyhole,
  Monitor,
  Moon,
  RotateCcw,
  Search,
  ShieldCheck,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react";
import type {
  Credentials,
  Host,
  MCPStatus,
  Preferences,
  WindowShortcuts,
} from "./types";
import { backend, errorText, isDesktop, writeClipboard } from "./bridge";
import {
  captureShortcut,
  defaultShortcuts,
  formatShortcut,
  reservedShortcuts,
  sameShortcut,
} from "./shortcuts";

export function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = requestAnimationFrame(() =>
      (
        (ref.current?.querySelector("input, textarea, select") ??
          ref.current?.querySelector("button")) as HTMLElement | null
      )?.focus(),
    );
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Let CodeMirror dismiss its search panel or completion popup first.
        if (
          (event.target as Element).closest?.(".cm-editor") &&
          ref.current?.querySelector(".cm-panel, .cm-tooltip")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key !== "Tab") return;
      const nodes = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ].filter((n) => n.offsetParent !== null);
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(timer);
      document.removeEventListener("keydown", key, true);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        // A second press can land here after the first click opens the dialog.
        if (e.target === e.currentTarget && e.detail < 2) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? "wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-heading"
      >
        <div className="modal-heading">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id="modal-heading">{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭对话框"
            title="关闭"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const colors = [
  { id: "mint", label: "薄荷绿" },
  { id: "blue", label: "天空蓝" },
  { id: "amber", label: "琥珀黄" },
  { id: "violet", label: "淡紫色" },
];
const preferenceSections = [
  { id: "appearance", label: "外观" },
  { id: "terminal", label: "终端" },
  { id: "shortcuts", label: "快捷键" },
  { id: "integrations", label: "集成" },
  { id: "behavior", label: "行为" },
] as const;
type PreferenceSection = (typeof preferenceSections)[number]["id"];

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

export function PreferencesDialog({
  preferences,
  platform,
  onChange,
  onClose,
}: {
  preferences: Preferences;
  platform: string;
  onChange: (value: Preferences) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dir, setDir] = useState("");
  const [historyLimitDraft, setHistoryLimitDraft] = useState(
    String(preferences.terminalHistoryLimit),
  );
  const [activeSection, setActiveSection] =
    useState<PreferenceSection>("appearance");
  const [mcpPortDraft, setMcpPortDraft] = useState(String(preferences.mcpPort));
  const [mcpStatus, setMcpStatus] = useState<MCPStatus | null>(null);
  const [mcpCopied, setMcpCopied] = useState<"json" | "codex" | "">("");
  const [recordingShortcut, setRecordingShortcut] = useState<
    keyof WindowShortcuts | null
  >(null);
  const [shortcutError, setShortcutError] = useState("");
  useEffect(() => {
    setHistoryLimitDraft(String(preferences.terminalHistoryLimit));
  }, [preferences.terminalHistoryLimit]);
  useEffect(() => {
    setMcpPortDraft(String(preferences.mcpPort));
  }, [preferences.mcpPort]);
  useEffect(() => {
    if (isDesktop())
      void backend()
        .DataDirectory()
        .then(setDir)
        .catch(() => {});
  }, []);
  useEffect(() => {
    if (!recordingShortcut) return;
    const shortcutName = recordingShortcut;
    function capture(event: KeyboardEvent) {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        setRecordingShortcut(null);
        setShortcutError("");
        return;
      }
      if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        shortcutName === "switchSession" &&
        !/^Digit[1-9]$/.test(event.code)
      ) {
        setShortcutError("请按下 1-9 中的一个数字。");
        return;
      }
      const shortcut = captureShortcut(
        event,
        platform,
        shortcutName === "switchSession" ? "Digit" : undefined,
      );
      if (!shortcut) {
        setShortcutError("快捷键需要包含一个修饰键。");
        return;
      }
      const labels: Record<keyof WindowShortcuts, string> = {
        closeSession: "关闭当前终端",
        newTerminal: "新建终端",
        nextSession: "下一个会话",
        previousSession: "上一个会话",
        switchSession: "跳转会话",
      };
      const duplicate = Object.entries(preferences.shortcuts).find(
        ([name, other]) =>
          name !== shortcutName && sameShortcut(shortcut, other, platform),
      );
      const reserved = reservedShortcuts.some((other) =>
        sameShortcut(shortcut, other, platform),
      );
      if (reserved) {
        setShortcutError("此快捷键已用于其他操作。");
        return;
      }
      if (duplicate) {
        setShortcutError(
          `此快捷键已分配给${labels[duplicate[0] as keyof WindowShortcuts]}。`,
        );
        return;
      }
      setRecordingShortcut(null);
      setShortcutError("");
      void change({
        shortcuts: {
          ...preferences.shortcuts,
          [shortcutName]: shortcut,
        },
      });
    }
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [platform, preferences.shortcuts, recordingShortcut]);
  useEffect(() => {
    if (!isDesktop()) return;
    void backend()
      .GetMCPStatus()
      .then(setMcpStatus)
      .catch(() => {});
  }, [preferences.mcpEnabled, preferences.mcpPort]);
  async function change(p: Partial<Preferences>) {
    setBusy(true);
    setError("");
    try {
      await onChange({ ...preferences, ...p });
      if (isDesktop() && ("mcpEnabled" in p || "mcpPort" in p))
        setMcpStatus(await backend().GetMCPStatus());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const availableSections = preferenceSections.filter(
    (section) => section.id !== "integrations" || isDesktop(),
  );
  return (
    <Modal title="偏好设置" onClose={onClose} className="preferences-dialog">
      <div className="preferences-tabs" role="tablist" aria-label="设置分类">
        {availableSections.map((section, index) => (
          <button
            key={section.id}
            id={`preferences-tab-${section.id}`}
            type="button"
            role="tab"
            aria-selected={activeSection === section.id}
            aria-controls="preferences-panel"
            tabIndex={activeSection === section.id ? 0 : -1}
            className={activeSection === section.id ? "active" : ""}
            onClick={() => setActiveSection(section.id)}
            onKeyDown={(event) => {
              let nextIndex = index;
              if (event.key === "ArrowRight")
                nextIndex = (index + 1) % availableSections.length;
              else if (event.key === "ArrowLeft")
                nextIndex =
                  (index - 1 + availableSections.length) %
                  availableSections.length;
              else if (event.key === "Home") nextIndex = 0;
              else if (event.key === "End")
                nextIndex = availableSections.length - 1;
              else return;
              event.preventDefault();
              setActiveSection(availableSections[nextIndex].id);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [nextIndex]?.focus();
            }}
          >
            {section.label}
          </button>
        ))}
      </div>
      <div
        id="preferences-panel"
        className="preferences-panel"
        role="tabpanel"
        aria-labelledby={`preferences-tab-${activeSection}`}
        tabIndex={0}
      >
        {activeSection === "appearance" && (
          <section className="preferences-section">
            <div className="settings-label">界面主题</div>
            <div className="theme-options">
              {(
                [
                  { value: "light", label: "浅色", icon: Sun },
                  { value: "dark", label: "深色", icon: Moon },
                  { value: "system", label: "跟随系统", icon: Monitor },
                ] as const
              ).map((t) => (
                <button
                  disabled={busy}
                  key={t.value}
                  aria-pressed={preferences.theme === t.value}
                  onClick={() => void change({ theme: t.value })}
                  className={preferences.theme === t.value ? "selected" : ""}
                >
                  <t.icon size={21} />
                  <span>{t.label}</span>
                  {preferences.theme === t.value && <Check size={14} />}
                </button>
              ))}
            </div>
          </section>
        )}
        {activeSection === "terminal" && (
          <section className="preferences-section">
            <div className="settings-label">终端显示与历史</div>
            <div className="setting-row">
              <div>
                <strong>终端字号</strong>
              </div>
              <label className="font-control">
                <button
                  aria-label="减小字号"
                  disabled={busy || preferences.fontSize <= 11}
                  onClick={() =>
                    void change({ fontSize: preferences.fontSize - 1 })
                  }
                >
                  −
                </button>
                <span>{preferences.fontSize} px</span>
                <button
                  aria-label="增大字号"
                  disabled={busy || preferences.fontSize >= 22}
                  onClick={() =>
                    void change({ fontSize: preferences.fontSize + 1 })
                  }
                >
                  +
                </button>
              </label>
            </div>
            <div className="setting-row">
              <div>
                <strong>终端行距</strong>
              </div>
              <select
                aria-label="终端行距"
                className="terminal-density-select"
                disabled={busy}
                value={preferences.lineHeight}
                onChange={(e) =>
                  void change({ lineHeight: Number(e.target.value) })
                }
              >
                <option value={1.2}>紧凑</option>
                <option value={1.35}>标准</option>
                <option value={1.5}>宽松</option>
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>记录终端历史</strong>
                <p className="field-hint">
                  在此设备保存终端输出；精选记录不会自动清理。
                </p>
              </div>
              <button
                className={`switch ${preferences.terminalHistoryEnabled ? "on" : ""}`}
                role="switch"
                aria-label="记录终端历史"
                aria-checked={preferences.terminalHistoryEnabled}
                disabled={busy}
                onClick={() =>
                  void change({
                    terminalHistoryEnabled: !preferences.terminalHistoryEnabled,
                  })
                }
              >
                <span />
              </button>
            </div>
            <div className="setting-row">
              <div>
                <strong>最近历史上限</strong>
                <p className="field-hint">
                  默认 20 条，最多 100 条；精选记录不计入上限。
                </p>
              </div>
              <label className="terminal-history-limit-control">
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={historyLimitDraft}
                  aria-label="最近历史上限"
                  disabled={busy}
                  onChange={(event) =>
                    setHistoryLimitDraft(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  onBlur={() => {
                    const value = Number(historyLimitDraft);
                    if (
                      Number.isInteger(value) &&
                      value >= 1 &&
                      value <= 100 &&
                      value !== preferences.terminalHistoryLimit
                    )
                      void change({ terminalHistoryLimit: value });
                    else if (
                      !Number.isInteger(value) ||
                      value < 1 ||
                      value > 100
                    )
                      setHistoryLimitDraft(
                        String(preferences.terminalHistoryLimit),
                      );
                  }}
                />
                <span>条</span>
              </label>
            </div>
          </section>
        )}
        {activeSection === "integrations" && isDesktop() && (
          <section className="preferences-section">
            <div className="settings-label">AI 连接（MCP）</div>
            <div className="setting-row">
              <div>
                <strong>启用本机 MCP 服务</strong>
                <p className="field-hint">监听本机地址，并使用访问令牌鉴权。</p>
              </div>
              <button
                className={`switch ${preferences.mcpEnabled ? "on" : ""}`}
                role="switch"
                aria-label="启用本机 MCP 服务"
                aria-checked={preferences.mcpEnabled}
                disabled={busy}
                onClick={() =>
                  void change(
                    preferences.mcpEnabled
                      ? { mcpEnabled: false, mcpAllowTerminalInput: false }
                      : { mcpEnabled: true },
                  )
                }
              >
                <span />
              </button>
            </div>
            <div className="setting-row">
              <div>
                <strong>MCP 端口</strong>
              </div>
              <label className="terminal-history-limit-control">
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  step={1}
                  value={mcpPortDraft}
                  aria-label="MCP 端口"
                  disabled={busy}
                  onChange={(event) =>
                    setMcpPortDraft(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  onBlur={() => {
                    const value = Number(mcpPortDraft);
                    if (
                      Number.isInteger(value) &&
                      value >= 1024 &&
                      value <= 65535 &&
                      value !== preferences.mcpPort
                    )
                      void change({ mcpPort: value });
                    else if (
                      !Number.isInteger(value) ||
                      value < 1024 ||
                      value > 65535
                    )
                      setMcpPortDraft(String(preferences.mcpPort));
                  }}
                />
              </label>
            </div>
            {preferences.mcpEnabled && (
              <>
                <div className="setting-row">
                  <div>
                    <strong>允许 AI 输入终端</strong>
                    <p className="field-hint">
                      开启后，AI 可向活动终端发送文本；包含换行时会执行命令。
                    </p>
                  </div>
                  <button
                    className={`switch ${preferences.mcpAllowTerminalInput ? "on" : ""}`}
                    role="switch"
                    aria-label="允许 AI 输入终端"
                    aria-checked={preferences.mcpAllowTerminalInput}
                    disabled={busy}
                    onClick={() =>
                      void change({
                        mcpAllowTerminalInput:
                          !preferences.mcpAllowTerminalInput,
                      })
                    }
                  >
                    <span />
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>
                      {mcpStatus?.running ? "服务运行中" : "服务未运行"}
                    </strong>
                    <p className="field-hint">
                      {mcpStatus?.error ||
                        mcpStatus?.endpoint ||
                        "正在读取 MCP 服务状态"}
                    </p>
                    {mcpStatus?.historyError && (
                      <p className="field-hint">
                        历史镜像：{mcpStatus.historyError}
                      </p>
                    )}
                  </div>
                </div>
                {mcpStatus?.endpoint && mcpStatus.token && (
                  <details className="data-directory mcp-connection-details">
                    <summary>连接信息与令牌</summary>
                    <code>{mcpStatus.endpoint}</code>
                    <code>Bearer {mcpStatus.token}</code>
                    <p className="field-hint">
                      Codex：复制 TOML 并追加到 %USERPROFILE%\.codex\config.toml，保存后重启 Codex。
                    </p>
                    <button
                      className="text-button"
                      type="button"
                      disabled={!mcpStatus.running}
                      onClick={() => {
                        const config = JSON.stringify(
                          {
                            mcpServers: {
                              "orbit-ssh": {
                                url: mcpStatus.endpoint,
                                headers: {
                                  Authorization: `Bearer ${mcpStatus.token}`,
                                },
                              },
                            },
                          },
                          null,
                          2,
                        );
                        void writeClipboard(config)
                          .then(() => {
                            setMcpCopied("json");
                            window.setTimeout(() => setMcpCopied(""), 1500);
                          })
                          .catch((copyError) => setError(errorText(copyError)));
                      }}
                    >
                      <Clipboard size={14} aria-hidden="true" />
                      {mcpCopied === "json" ? "已复制" : "复制通用 JSON"}
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      disabled={!mcpStatus.running}
                      onClick={() => {
                        const config = [
                          "[mcp_servers.orbit-ssh]",
                          `url = "${mcpStatus.endpoint}"`,
                          `http_headers = { Authorization = "Bearer ${mcpStatus.token}" }`,
                        ].join("\n");
                        void writeClipboard(config)
                          .then(() => {
                            setMcpCopied("codex");
                            window.setTimeout(() => setMcpCopied(""), 1500);
                          })
                          .catch((copyError) => setError(errorText(copyError)));
                      }}
                    >
                      <Clipboard size={14} aria-hidden="true" />
                      {mcpCopied === "codex" ? "已复制" : "复制 Codex TOML"}
                    </button>
                  </details>
                )}
              </>
            )}
          </section>
        )}
        {activeSection === "shortcuts" && (
          <section className="preferences-section">
            <div className="settings-label shortcut-settings-label">
              窗口快捷键
            </div>
            <div className="shortcut-settings">
              {(
                [
                  ["closeSession", "关闭当前终端"],
                  ["newTerminal", "新建终端"],
                  ["nextSession", "切换到下一个会话"],
                  ["previousSession", "切换到上一个会话"],
                  ["switchSession", "跳转到第 1-9 个会话"],
                ] as const
              ).map(([name, label]) => (
                <div className="shortcut-setting-row" key={name}>
                  <strong>{label}</strong>
                  <button
                    className="shortcut-capture"
                    type="button"
                    aria-label={`${label}快捷键`}
                    aria-pressed={recordingShortcut === name}
                    disabled={busy}
                    onClick={() => {
                      setShortcutError("");
                      setRecordingShortcut(name);
                    }}
                  >
                    {recordingShortcut === name
                      ? "按下快捷键"
                      : formatShortcut(preferences.shortcuts[name], platform)}
                  </button>
                </div>
              ))}
              <div className="shortcut-settings-footer">
                {shortcutError && (
                  <span role="alert" className="form-error">
                    {shortcutError}
                  </span>
                )}
                <button
                  className="text-button shortcut-reset"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setShortcutError("");
                    setRecordingShortcut(null);
                    void change({ shortcuts: defaultShortcuts });
                  }}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  恢复默认
                </button>
              </div>
            </div>
          </section>
        )}
        {activeSection === "behavior" && (
          <section className="preferences-section">
            <div className="settings-label">窗口与应用行为</div>
            {platform === "windows" && (
              <div className="setting-row">
                <div>
                  <strong>关闭窗口后常驻后台</strong>
                  <p className="field-hint">
                    隐藏到系统托盘，保持终端和文件传输运行。
                  </p>
                </div>
                <button
                  className={`switch ${preferences.closeToTray ? "on" : ""}`}
                  role="switch"
                  aria-label="关闭窗口后常驻后台"
                  aria-checked={preferences.closeToTray}
                  disabled={busy}
                  onClick={() =>
                    void change({ closeToTray: !preferences.closeToTray })
                  }
                >
                  <span />
                </button>
              </div>
            )}
            <div className="setting-row">
              <div>
                <strong>退出前确认</strong>
              </div>
              <button
                className={`switch ${preferences.confirmClose ? "on" : ""}`}
                role="switch"
                aria-label="退出前确认"
                aria-checked={preferences.confirmClose}
                disabled={busy}
                onClick={() =>
                  void change({ confirmClose: !preferences.confirmClose })
                }
              >
                <span />
              </button>
            </div>
            {dir && (
              <details className="data-directory">
                <summary>配置目录</summary>
                <code>{dir}</code>
              </details>
            )}
          </section>
        )}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <span className="version-label">Orbit SSH · v1.0</span>
        <button className="button primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}

export function CommandPalette({
  hosts,
  onSelect,
  onNew,
  onClose,
}: {
  hosts: Host[];
  onSelect: (host: Host) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = hosts.filter((h) =>
    `${h.name} ${h.address} ${h.group}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Modal title="快速切换" onClose={onClose}>
      <div className="palette-search">
        <Search size={18} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称、IP 地址或分组…"
          aria-label="搜索主机"
        />
      </div>
      <div className="palette-results">
        {filtered.map((h) => (
          <button
            key={h.id}
            onClick={() => {
              onClose();
              onSelect(h);
            }}
          >
            <span className={`host-icon small ${h.color}`}>
              <TerminalSquare size={18} />
            </span>
            <span>
              <strong>{h.name}</strong>
              <code>
                {h.username}@{h.address}
              </code>
            </span>
            <ChevronRight size={15} />
          </button>
        ))}
        {!filtered.length && (
          <p className="palette-empty">
            {hosts.length
              ? "没有找到匹配的主机"
              : "你的主机列表还是空的，从第一台开始。"}
          </p>
        )}
        <button
          onClick={() => {
            onClose();
            onNew();
          }}
        >
          <KeyRound size={18} />
          <strong>添加新主机</strong>
          <kbd>Ctrl T</kbd>
        </button>
      </div>
    </Modal>
  );
}

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
