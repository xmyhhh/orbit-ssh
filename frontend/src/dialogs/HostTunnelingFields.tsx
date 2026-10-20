import { useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  Monitor,
  Network,
  Plus,
  Trash2,
} from "lucide-react";
import type { PortForward, X11Config } from "../types";
import { backend, errorText, isDesktop } from "../bridge";
import { forwardSummary, forwardTypeNames } from "../tunneling";
import { Select } from "../ui/Select";

export function HostTunnelingFields({
  rules,
  x11,
  onRules,
  onX11,
  onError,
}: {
  rules: PortForward[];
  x11: X11Config;
  onRules: (rules: PortForward[]) => void;
  onX11: (config: X11Config) => void;
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  function change(id: string, patch: Partial<PortForward>) {
    onRules(
      rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    );
  }
  function add() {
    const id = crypto.randomUUID();
    onRules([
      ...rules,
      {
        id,
        type: "local",
        enabled: true,
        bindAddress: "127.0.0.1",
        bindPort: 8080,
        destinationHost: "127.0.0.1",
        destinationPort: 3000,
        description: "",
      },
    ]);
    setExpanded(id);
  }
  return (
    <div className="host-tunneling">
      <section aria-labelledby="port-forward-heading">
        <div className="tunneling-heading">
          <h3 id="port-forward-heading">
            <Network size={16} />
            TCP/IP 端口转发
          </h3>
          <button
            type="button"
            className="text-button"
            onClick={add}
            disabled={rules.length >= 64}
          >
            <Plus size={15} />
            添加规则
          </button>
        </div>
        <p className="field-hint tunneling-intro">
          连接时自动启动，最后一个终端关闭时停止。修改规则后，请断开此主机的全部终端再重连。
        </p>
        {rules.length === 0 && (
          <div className="tunneling-empty">
            还没有转发规则。添加后，即可通过 SSH 访问远程服务或转发本机服务。
          </div>
        )}
        <div className="forward-rules">
          {rules.map((rule, index) => (
            <div className="forward-rule" key={rule.id}>
              <div className="forward-rule-heading">
                <input
                  type="checkbox"
                  aria-label={`启用规则 ${index + 1}`}
                  checked={rule.enabled}
                  onChange={(e) =>
                    change(rule.id, { enabled: e.target.checked })
                  }
                />
                <button
                  className="forward-rule-toggle"
                  type="button"
                  aria-label={`${expanded === rule.id ? "收起" : "编辑"}${forwardTypeNames[rule.type]}规则 ${index + 1}${rule.description ? `：${rule.description}` : ""}`}
                  aria-expanded={expanded === rule.id}
                  aria-controls={`forward-${rule.id}`}
                  onClick={() =>
                    setExpanded(expanded === rule.id ? null : rule.id)
                  }
                >
                  <span>
                    <strong>
                      {forwardTypeNames[rule.type]}
                      {rule.description ? ` · ${rule.description}` : ""}
                    </strong>
                    <code>{forwardSummary(rule)}</code>
                  </span>
                  <ChevronDown
                    size={15}
                    className={expanded === rule.id ? "expanded" : ""}
                  />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`删除规则 ${index + 1}`}
                  title="删除规则"
                  onClick={() =>
                    onRules(rules.filter((item) => item.id !== rule.id))
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div
                id={`forward-${rule.id}`}
                className="forward-rule-fields"
                hidden={expanded !== rule.id}
              >
                <div className="field">
                  <span>转发类型</span>
                  <Select
                    ariaLabel="转发类型"
                    size="lg"
                    value={rule.type}
                    onChange={(value) =>
                      change(rule.id, {
                        type: value as PortForward["type"],
                      })
                    }
                    options={[
                      { value: "local", label: "本地转发 — 在本机访问远程服务" },
                      { value: "remote", label: "远程转发 — 在服务器访问本机服务" },
                      { value: "dynamic", label: "动态转发 — 本机 SOCKS5 代理" },
                    ]}
                  />
                </div>
                <div className="form-row tunnel-endpoint">
                  <label className="field">
                    {rule.type === "remote" ? "服务器监听地址" : "本机监听地址"}
                    <input
                      value={rule.bindAddress}
                      placeholder="127.0.0.1"
                      spellCheck={false}
                      autoCapitalize="none"
                      onChange={(e) =>
                        change(rule.id, { bindAddress: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    监听端口
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={rule.bindPort || ""}
                      onChange={(e) =>
                        change(rule.id, { bindPort: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
                {rule.type !== "dynamic" && (
                  <div className="form-row tunnel-endpoint">
                    <label className="field">
                      {rule.type === "remote"
                        ? "本机侧目标地址"
                        : "服务器侧目标地址"}
                      <input
                        value={rule.destinationHost}
                        placeholder="127.0.0.1"
                        spellCheck={false}
                        autoCapitalize="none"
                        onChange={(e) =>
                          change(rule.id, { destinationHost: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      目标端口
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={rule.destinationPort || ""}
                        onChange={(e) =>
                          change(rule.id, {
                            destinationPort: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                <label className="field">
                  描述（可选）
                  <input
                    value={rule.description}
                    maxLength={80}
                    placeholder="例如：远程开发服务"
                    onChange={(e) =>
                      change(rule.id, { description: e.target.value })
                    }
                  />
                </label>
                <p className="field-hint">
                  {rule.type === "remote"
                    ? "目标地址从本机访问。远程监听是否对外开放由服务器的 GatewayPorts 设置决定。"
                    : rule.type === "dynamic"
                      ? "将浏览器或应用的 SOCKS5 代理设为此监听地址和端口。支持 TCP，域名由服务器解析。"
                      : "目标地址从 SSH 服务器访问。例如：本机 8080 → 服务器 127.0.0.1:3000。"}
                  {rule.bindAddress === "0.0.0.0" || rule.bindAddress === "::"
                    ? " 当前监听所有网卡，网络中的其他设备也可能访问此端口。"
                    : ""}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="x11-settings" aria-labelledby="x11-heading">
        <div className="tunneling-heading">
          <h3 id="x11-heading">
            <Monitor size={16} />
            X11 图形界面转发
          </h3>
        </div>
        <label className="tunneling-checkbox">
          <input
            type="checkbox"
            checked={x11.enabled}
            onChange={(e) => onX11({ ...x11, enabled: e.target.checked })}
          />
          启用 X11 转发
        </label>
        <p className="field-hint">
          在本机运行 Xmanager、VcXsrv 或其他 X Server 后，可显示远程 Linux
          图形程序。服务器需启用 X11Forwarding 并安装 xauth。
        </p>
        {x11.enabled && (
          <>
            <label className="field">
              本机 X DISPLAY
              <input
                value={x11.display}
                placeholder="localhost:0.0"
                spellCheck={false}
                autoCapitalize="none"
                onChange={(e) => onX11({ ...x11, display: e.target.value })}
              />
            </label>
            <label className="field">
              Xauthority 文件（可选）
              <div className="input-action">
                <input
                  value={x11.authFile}
                  placeholder="留空自动查找 XAUTHORITY 或 .Xauthority"
                  onChange={(e) => onX11({ ...x11, authFile: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="选择 Xauthority 文件"
                  disabled={!isDesktop()}
                  onClick={() =>
                    void backend()
                      .SelectXAuthorityFile()
                      .then((filename) => {
                        if (filename) onX11({ ...x11, authFile: filename });
                      })
                      .catch((error) => onError(errorText(error)))
                  }
                >
                  <FolderOpen size={18} />
                </button>
              </div>
            </label>
            <p className="field-hint">
              X Server 启用 cookie 认证时，请提供对应文件。远程 DISPLAY 由 SSH
              服务器自动设置，无需手动 export。
            </p>
          </>
        )}
      </section>
    </div>
  );
}
