import type {
  Credentials,
  Directory,
  LocalDirectory,
  FilePreview,
  RemoteTextFile,
  Transfer,
  TransferRequest,
  Host,
  Metrics,
  Preferences,
  Snippet,
  TerminalSize,
  Workspace,
} from "./types";

interface Backend {
  LoadState(): Promise<Workspace>;
  SaveHost(host: Host): Promise<void>;
  DeleteHost(id: string): Promise<void>;
  SaveSnippets(snippets: Snippet[]): Promise<void>;
  SavePreferences(preferences: Preferences): Promise<void>;
  SelectKeyFile(): Promise<string>;
  SaveKeyPassphrase(hostID: string, passphrase: string): Promise<void>;
  ForgetKeyPassphrase(hostID: string): Promise<void>;
  HasSavedPassword(hostID: string): Promise<boolean>;
  SavePassword(hostID: string, password: string): Promise<void>;
  ForgetPassword(hostID: string): Promise<void>;
  Monitor(id: string): Promise<Metrics>;
  Connect(
    id: string,
    hostID: string,
    credentials: Credentials,
    fingerprint: string,
    size: TerminalSize,
  ): Promise<void>;
  Disconnect(id: string): Promise<void>;
  WriteTerminal(id: string, text: string): Promise<void>;
  ResizeTerminal(id: string, size: TerminalSize): Promise<void>;
  ListDirectory(id: string, dir: string): Promise<Directory>;
  ListLocalDirectory(dir: string): Promise<LocalDirectory>;
  SelectLocalDirectory(): Promise<string>;
  MakeLocalDirectory(dir: string, name: string): Promise<void>;
  QueueTransfer(request: TransferRequest): Promise<string>;
  ListTransfers(sessionId: string): Promise<Transfer[]>;
  CancelTransfer(id: string): Promise<void>;
  ClearTransfers(sessionId: string): Promise<void>;
  ReadFilePreview(
    sessionId: string,
    side: string,
    filename: string,
  ): Promise<FilePreview>;
  ReadRemoteTextFile(
    sessionId: string,
    filename: string,
  ): Promise<RemoteTextFile>;
  SaveRemoteTextFile(
    sessionId: string,
    filename: string,
    text: string,
    revision: string,
  ): Promise<RemoteTextFile>;
  SetEditorDirty(id: string, dirty: boolean): Promise<void>;
  UploadFile(id: string, dir: string): Promise<boolean>;
  DownloadFile(id: string, path: string): Promise<boolean>;
  MakeDirectory(id: string, dir: string, name: string): Promise<void>;
  DataDirectory(): Promise<string>;
}
declare global {
  interface Window {
    go?: { main: { App: Backend } };
    runtime?: {
      EventsOnMultiple: (
        name: string,
        callback: (...data: unknown[]) => void,
        count: number,
      ) => () => void;
    };
  }
}
export const isDesktop = () => Boolean(window.go?.main?.App);
export const backend = () => {
  if (!window.go?.main?.App)
    throw new Error("真实 SSH 连接需要在桌面应用中使用");
  return window.go.main.App;
};
export function listen(
  name: string,
  callback: (...data: unknown[]) => void,
): () => void {
  return window.runtime?.EventsOnMultiple(name, callback, -1) ?? (() => {});
}
const storageKey = "orbit-ssh-preview-v1";
export const defaults: Workspace = {
  hosts: [],
  snippets: [
    {
      id: "system",
      name: "系统概览",
      command: "uname -a",
      description: "查看系统与内核信息",
    },
    {
      id: "disk",
      name: "磁盘用量",
      command: "df -h",
      description: "以易读格式查看磁盘空间",
    },
    {
      id: "process",
      name: "进程快照",
      command: "ps aux | head -20",
      description: "查看前 20 个进程",
    },
  ],
  preferences: {
    theme: "light",
    fontSize: 14,
    lineHeight: 1.35,
    confirmClose: true,
  },
  knownHosts: {},
};
export async function loadWorkspace(): Promise<Workspace> {
  if (isDesktop()) return backend().LoadState();
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const value = JSON.parse(stored) as Workspace;
      if (!Array.isArray(value.hosts) || !Array.isArray(value.snippets))
        throw new Error("invalid");
      return {
        ...defaults,
        ...value,
        preferences: { ...defaults.preferences, ...value.preferences },
      };
    }
  } catch {
    /* An invalid preview cache may be reset without touching desktop data. */
  }
  return structuredClone(defaults);
}
export function savePreview(state: Workspace) {
  if (!isDesktop()) localStorage.setItem(storageKey, JSON.stringify(state));
}
export function errorText(error: unknown): string {
  const text = String(error);
  if (text.includes("unable to authenticate"))
    return "认证失败，请检查用户名、密码或私钥。";
  if (text.includes("actively refused"))
    return "服务器拒绝连接，请检查地址、端口和 SSH 服务。";
  if (text.includes("deadline exceeded") || text.includes("i/o timeout"))
    return "连接超时，请检查网络、地址和防火墙。";
  return text.replace(/^Error: /, "");
}
