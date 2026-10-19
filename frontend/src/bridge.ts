import "./android";
import type {
  Credentials,
  Directory,
  LocalDirectory,
  LocalShellInfo,
  FilePreview,
  RemoteTextFile,
  Transfer,
  TransferRequest,
  Host,
  Metrics,
  MCPStatus,
  MCPClient,
  MCPInstallResult,
  Preferences,
  TerminalSize,
  Workspace,
  WSLInfo,
  SSHConfigEntry,
  SSHConfigImport,
  SSHConfigImportResult,
  HostImportResult,
  MCPCommandRequest,
} from "./types";
import { defaultShortcuts } from "./shortcuts";
import type { TerminalHistoryRecord } from "./terminalHistory";

interface Backend {
  GetPlatform(): Promise<string>;
  GetLocalShellInfo(): Promise<LocalShellInfo>;
  ConnectLocalShell(
    id: string,
    shellID: string,
    size: TerminalSize,
  ): Promise<void>;
  GetWSLInfo(): Promise<WSLInfo>;
  ConnectWSL(
    id: string,
    distribution: string,
    size: TerminalSize,
  ): Promise<void>;
  LoadState(): Promise<Workspace>;
  SaveHost(host: Host): Promise<void>;
  DeleteHost(id: string): Promise<void>;
  SavePreferences(preferences: Preferences): Promise<void>;
  SelectKeyFile(): Promise<string>;
  SelectXAuthorityFile(): Promise<string>;
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
  ConnectMCPHost(id: string, size: TerminalSize): Promise<void>;
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
  RenameRemote(id: string, dir: string, from: string, to: string): Promise<void>;
  MoveRemote(id: string, from: string, toDir: string): Promise<void>;
  RemoveRemote(id: string, filename: string): Promise<void>;
  ChmodRemote(id: string, filename: string, mode: string): Promise<void>;
  KillProcess(id: string, pid: number, signal: string): Promise<void>;
  ReadSSHConfig(path: string): Promise<SSHConfigImport>;
  SelectSSHConfigFile(): Promise<string>;
  ImportSSHConfig(entries: SSHConfigEntry[]): Promise<SSHConfigImportResult>;
  ExportHosts(): Promise<string>;
  ImportHosts(): Promise<HostImportResult>;
  GenerateKeyPair(name: string): Promise<[string, string]>;
  DecideMCPCommand(id: string, approved: boolean): Promise<void>;
  ListMCPCommands(): Promise<MCPCommandRequest[]>;
  DataDirectory(): Promise<string>;
  GetMCPStatus(): Promise<MCPStatus>;
  InstallMCP(target: MCPClient): Promise<MCPInstallResult>;
  MCPConfigSnippet(target: MCPClient): Promise<string>;
  SyncTerminalHistory(records: TerminalHistoryRecord[]): Promise<void>;
  UpsertTerminalHistory(
    record: TerminalHistoryRecord,
    retainedIDs: string[],
  ): Promise<void>;
  AppendTerminalHistory(
    record: TerminalHistoryRecord,
    outputDelta: string,
    retainedIDs: string[],
  ): Promise<void>;
  DeleteTerminalHistory(id: string): Promise<void>;
}
declare global {
  interface Window {
    go?: { main: { App: Backend } };
    runtime?: {
      ClipboardGetText?: () => Promise<string>;
      ClipboardSetText?: (text: string) => Promise<boolean>;
      EventsOnMultiple: (
        name: string,
        callback: (...data: unknown[]) => void,
        count: number,
      ) => () => void;
    };
  }
}
export const isDesktop = () => Boolean(window.go?.main?.App);
export async function readClipboard(): Promise<string> {
  if (window.runtime?.ClipboardGetText)
    return window.runtime.ClipboardGetText();
  return navigator.clipboard.readText();
}
export async function writeClipboard(text: string): Promise<void> {
  if (window.runtime?.ClipboardSetText) {
    if (!(await window.runtime.ClipboardSetText(text)))
      throw new Error("无法写入剪贴板");
  } else await navigator.clipboard.writeText(text);
}
export const backend = () => {
  if (!window.go?.main?.App)
    throw new Error("真实 SSH 连接需要在 Orbit SSH 应用中使用");
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
  preferences: {
    theme: "light",
    hostLayout: "grid",
    fontSize: 14,
    lineHeight: 1.35,
    confirmClose: true,
    closeToTray: true,
    terminalHistoryEnabled: true,
    terminalHistoryLimit: 20,
    keepAliveSeconds: 30,
    mcpEnabled: false,
    mcpAllowConnections: false,
    mcpAllowTerminalInput: false,
    mcpAllowFileAccess: false,
    mcpPort: 8765,
    shortcuts: defaultShortcuts,
  },
  knownHosts: {},
};
export async function loadWorkspace(): Promise<Workspace> {
  if (isDesktop()) return backend().LoadState();
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const value = JSON.parse(stored) as Workspace & {
        snippets?: unknown;
        snippetCatalogVersion?: unknown;
      };
      if (!Array.isArray(value.hosts)) throw new Error("invalid");
      delete value.snippets;
      delete value.snippetCatalogVersion;
      const restored: Workspace = {
        ...defaults,
        ...value,
        preferences: {
          ...defaults.preferences,
          ...value.preferences,
          shortcuts: {
            ...defaultShortcuts,
            ...value.preferences?.shortcuts,
          },
        },
      };
      try {
        localStorage.setItem(storageKey, JSON.stringify(restored));
      } catch {
        /* Keep this session usable if storage is unavailable. */
      }
      return restored;
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
