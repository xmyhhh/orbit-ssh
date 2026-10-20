import { useEffect, useState } from "react";
import {
  Check,
  Clipboard,
  Monitor,
  Moon,
  PlugZap,
  RotateCcw,
  Sun,
} from "lucide-react";
import type {
  MCPClient,
  MCPInstallResult,
  MCPStatus,
  Preferences,
  WindowShortcuts,
} from "../types";
import { backend, errorText, isDesktop, writeClipboard } from "../bridge";
import {
  captureShortcut,
  defaultShortcuts,
  formatShortcut,
  reservedShortcuts,
  sameShortcut,
} from "../shortcuts";
import { Modal } from "./Modal";
import { isAndroid } from "../android";
import { appVersion } from "../appInfo";
import { Select } from "../ui/Select";

const preferenceSections = [
  { id: "appearance", label: "外观" },
  { id: "terminal", label: "终端" },
  { id: "shortcuts", label: "快捷键" },
  { id: "integrations", label: "集成" },
  { id: "behavior", label: "行为" },
] as const;
type PreferenceSection = (typeof preferenceSections)[number]["id"];
const mcpClients: { target: MCPClient; name: string }[] = [
  { target: "codex", name: "Codex" },
  { target: "claude", name: "Claude Code" },
  { target: "cursor", name: "Cursor" },
  { target: "opencode", name: "OpenCode" },
  { target: "gemini", name: "Gemini CLI" },
  { target: "vscode", name: "VS Code Copilot" },
];

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
  const [mcpClient, setMcpClient] = useState<MCPClient>("codex");
  const [mcpCopied, setMcpCopied] = useState<MCPClient | "">("");
  const [installingMCP, setInstallingMCP] = useState(false);
  const [mcpInstall, setMcpInstall] = useState<MCPInstallResult | null>(null);
  const mcpClientName = mcpClients.find(
    (client) => client.target === mcpClient,
  )!.name;
  const [recordingShortcut, setRecordingShortcut] = useState<
    keyof WindowShortcuts | null
  >(null);
  const [shortcutError, setShortcutError] = useState("");
  const supportsMCP = isDesktop() && !isAndroid();
  useEffect(() => {
    setHistoryLimitDraft(String(preferences.terminalHistoryLimit));
  }, [preferences.terminalHistoryLimit]);
  useEffect(() => {
    setMcpPortDraft(String(preferences.mcpPort));
    setMcpInstall(null);
    setMcpCopied("");
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
    if (!supportsMCP) return;
    void backend()
      .GetMCPStatus()
      .then(setMcpStatus)
      .catch(() => {});
  }, [supportsMCP, preferences.mcpEnabled, preferences.mcpPort]);
  async function change(p: Partial<Preferences>) {
    setBusy(true);
    setError("");
    try {
      await onChange({ ...preferences, ...p });
      if (supportsMCP && ("mcpEnabled" in p || "mcpPort" in p))
        setMcpStatus(await backend().GetMCPStatus());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function installMCP() {
    setBusy(true);
    setInstallingMCP(true);
    setError("");
    setMcpInstall(null);
    try {
      setMcpInstall(await backend().InstallMCP(mcpClient));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setInstallingMCP(false);
      setBusy(false);
    }
  }
  const availableSections = preferenceSections.filter(
    (section) => section.id !== "integrations" || supportsMCP,
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
              <Select
                ariaLabel="终端行距"
                className="terminal-density-select"
                size="md"
                disabled={busy}
                value={String(preferences.lineHeight)}
                onChange={(value) =>
                  void change({ lineHeight: Number(value) })
                }
                options={[
                  { value: "1.2", label: "紧凑" },
                  { value: "1.35", label: "标准" },
                  { value: "1.5", label: "宽松" },
                ]}
              />
            </div>
            <div className="setting-row">
              <div>
                <strong>连接保活间隔</strong>
                <p className="field-hint">
                  定期发送 keepalive 探测；0 表示关闭。网络中断时更快发现掉线。
                </p>
              </div>
              <Select
                ariaLabel="连接保活间隔"
                className="terminal-density-select"
                size="md"
                disabled={busy}
                value={String(preferences.keepAliveSeconds)}
                onChange={(value) =>
                  void change({ keepAliveSeconds: Number(value) })
                }
                options={[
                  { value: "0", label: "关闭" },
                  { value: "15", label: "15 秒" },
                  { value: "30", label: "30 秒" },
                  { value: "60", label: "60 秒" },
                  { value: "120", label: "120 秒" },
                ]}
              />
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
        {activeSection === "integrations" && supportsMCP && (
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
                      ? {
                          mcpEnabled: false,
                          mcpAllowConnections: false,
                          mcpAllowTerminalInput: false,
                          mcpAllowFileAccess: false,
                        }
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
                    <strong>允许 AI 创建连接</strong>
                    <p className="field-hint">
                      AI 可添加主机配置、连接已有主机；新终端会显示在当前窗口。
                    </p>
                  </div>
                  <button
                    className={`switch ${preferences.mcpAllowConnections ? "on" : ""}`}
                    role="switch"
                    aria-label="允许 AI 创建连接"
                    aria-checked={preferences.mcpAllowConnections}
                    disabled={busy}
                    onClick={() =>
                      void change({
                        mcpAllowConnections: !preferences.mcpAllowConnections,
                      })
                    }
                  >
                    <span />
                  </button>
                </div>
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
                    <strong>允许 AI 访问文件</strong>
                    <p className="field-hint">
                      允许列出和读取远程文件；写入文件还需同时开启“允许 AI
                      输入终端”。
                    </p>
                  </div>
                  <button
                    className={`switch ${preferences.mcpAllowFileAccess ? "on" : ""}`}
                    role="switch"
                    aria-label="允许 AI 访问文件"
                    aria-checked={preferences.mcpAllowFileAccess}
                    disabled={busy}
                    onClick={() =>
                      void change({
                        mcpAllowFileAccess: !preferences.mcpAllowFileAccess,
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
                <div className="setting-row">
                  <div>
                    <strong>接入 AI 客户端</strong>
                    <p className="field-hint">
                      自动配置当前用户，接入后重启客户端。修改端口后请再次接入。
                    </p>
                  </div>
                  <div className="mcp-install-actions">
                    <Select
                      ariaLabel="MCP 客户端"
                      size="sm"
                      disabled={busy}
                      value={mcpClient}
                      onChange={(value) => {
                        setMcpClient(value as MCPClient);
                        setMcpInstall(null);
                        setMcpCopied("");
                        setError("");
                      }}
                      options={mcpClients.map((client) => ({
                        value: client.target,
                        label: client.name,
                      }))}
                    />
                    <button
                      className="text-button mcp-install-button"
                      type="button"
                      disabled={busy || !mcpStatus?.running}
                      onClick={() => void installMCP()}
                    >
                      <PlugZap size={14} aria-hidden="true" />
                      {installingMCP
                        ? "正在接入…"
                        : `一键接入 ${mcpClientName}`}
                    </button>
                  </div>
                </div>
                {mcpInstall && (
                  <div className="mcp-install-result" role="status">
                    <p>
                      <Check size={14} aria-hidden="true" />
                      {mcpInstall.changed
                        ? `已接入 ${mcpClientName}`
                        : `${mcpClientName} 配置已是最新`}
                      ，请重启客户端。
                    </p>
                    <code>{mcpInstall.configPath}</code>
                    {mcpInstall.backupPath && (
                      <details>
                        <summary>查看原配置备份</summary>
                        <code>{mcpInstall.backupPath}</code>
                      </details>
                    )}
                  </div>
                )}
                {mcpStatus?.endpoint && mcpStatus.token && (
                  <details className="data-directory mcp-connection-details">
                    <summary>连接信息与令牌</summary>
                    <code>{mcpStatus.endpoint}</code>
                    <code>Bearer {mcpStatus.token}</code>
                    <p className="field-hint">
                      也可复制 {mcpClientName}{" "}
                      配置并手动合并，保存后重启客户端。
                    </p>
                    <button
                      className="text-button"
                      type="button"
                      disabled={!mcpStatus.running}
                      onClick={() => {
                        void backend()
                          .MCPConfigSnippet(mcpClient)
                          .then(writeClipboard)
                          .then(() => {
                            setMcpCopied(mcpClient);
                            window.setTimeout(() => setMcpCopied(""), 1500);
                          })
                          .catch((copyError) => setError(errorText(copyError)));
                      }}
                    >
                      <Clipboard size={14} aria-hidden="true" />
                      {mcpCopied === mcpClient
                        ? "已复制"
                        : `复制 ${mcpClientName} ${mcpClient === "codex" ? "TOML" : "JSON"}`}
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
        <span className="version-label">Orbit SSH · v{appVersion}</span>
        <button className="button primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}
