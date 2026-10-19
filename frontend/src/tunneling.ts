import type { PortForward, X11Config } from "./types";

export const defaultX11: X11Config = {
  enabled: false,
  display: "localhost:0.0",
  authFile: "",
};

export const forwardTypeNames = {
  local: "本地转发",
  remote: "远程转发",
  dynamic: "动态 SOCKS5",
};

export function forwardSummary(rule: PortForward): string {
  const endpoint = (host: string, port: number) =>
    `${host.includes(":") ? `[${host}]` : host}:${port || "…"}`;
  const bind = endpoint(rule.bindAddress || "127.0.0.1", rule.bindPort);
  return rule.type === "dynamic"
    ? `${bind} → SOCKS5 代理`
    : `${bind} → ${endpoint(rule.destinationHost, rule.destinationPort)}`;
}

export function validateTunnelSettings(
  rules: PortForward[],
  x11: X11Config,
): string {
  if (rules.length > 64) return "每台主机最多保存 64 条端口转发规则。";
  const validHost = (value: string) => {
    if (!value || /[\s/\\\[\]\0]/.test(value)) return false;
    if (!value.includes(":")) return true;
    try {
      return new URL(`http://[${value}]`).hostname.startsWith("[");
    } catch {
      return false;
    }
  };
  const validPort = (value: number) =>
    Number.isInteger(value) && value >= 1 && value <= 65535;
  const bindings = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    const prefix = `端口转发规则 ${index + 1}：`;
    const bind = rule.bindAddress || "127.0.0.1";
    if (!validHost(bind)) return prefix + "请填写有效的监听地址。";
    if (!validPort(rule.bindPort))
      return prefix + "监听端口应在 1–65535 之间。";
    if (rule.type !== "dynamic") {
      if (!validHost(rule.destinationHost))
        return prefix + "请填写有效的目标地址。";
      if (!validPort(rule.destinationPort))
        return prefix + "目标端口应在 1–65535 之间。";
    }
    if (!rule.enabled) continue;
    const key = `${rule.type === "remote" ? "remote" : "local"}/${bind.toLowerCase()}/${rule.bindPort}`;
    if (bindings.has(key)) return prefix + "监听地址和端口与其他规则重复。";
    bindings.add(key);
  }
  const display = x11.display || defaultX11.display;
  if (
    x11.enabled &&
    (!/^(?:[^\s:/\\\[\]]*|\[[0-9a-fA-F:]+\]):\d+(?:\.\d+)?$/.test(display) ||
      Number(display.split(":").at(-1)?.split(".")[0]) > 59535)
  )
    return "X DISPLAY 格式应为 localhost:0.0、:0 或 [::1]:0.0。";
  return "";
}
