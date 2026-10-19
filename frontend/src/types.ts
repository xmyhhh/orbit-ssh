export type Theme = "light" | "dark" | "system";
export interface PortForward {
  id: string;
  type: "local" | "remote" | "dynamic";
  enabled: boolean;
  bindAddress: string;
  bindPort: number;
  destinationHost: string;
  destinationPort: number;
  description: string;
}
export interface X11Config {
  enabled: boolean;
  display: string;
  authFile: string;
}
export interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  group: string;
  authType: "password" | "key";
  keyPath: string;
  color: string;
  favorite: boolean;
  lastConnected: string;
  portForwards?: PortForward[];
  x11?: X11Config;
}
export interface ShortcutBinding {
  code: string;
  primary: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}
export interface WindowShortcuts {
  closeSession: ShortcutBinding;
  newTerminal: ShortcutBinding;
  nextSession: ShortcutBinding;
  previousSession: ShortcutBinding;
  switchSession: ShortcutBinding;
}
export interface Preferences {
  theme: Theme;
  hostLayout: "grid" | "list";
  fontSize: number;
  lineHeight: number;
  confirmClose: boolean;
  closeToTray: boolean;
  terminalHistoryEnabled: boolean;
  terminalHistoryLimit: number;
  mcpEnabled: boolean;
  mcpAllowConnections: boolean;
  mcpAllowTerminalInput: boolean;
  mcpPort: number;
  shortcuts: WindowShortcuts;
}
export interface MCPStatus {
  enabled: boolean;
  running: boolean;
  allowInput: boolean;
  allowConnections: boolean;
  endpoint: string;
  token: string;
  error: string;
  historyError: string;
}
export type MCPClient =
  "codex" | "claude" | "cursor" | "opencode" | "gemini" | "vscode";
export interface MCPInstallResult {
  configPath: string;
  backupPath: string;
  changed: boolean;
}
export interface Workspace {
  hosts: Host[];
  preferences: Preferences;
  knownHosts: Record<string, string>;
}
export interface Credentials {
  password: string;
  passphrase: string;
  rememberKey?: boolean;
  rememberPassword?: boolean;
}
export interface DiskMetric {
  filesystem: string;
  mount: string;
  total: number;
  used: number;
  available: number;
  usedPercent: number;
}
export interface ProcessMetric {
  pid: number;
  user: string;
  state: string;
  cpu: number;
  memoryPercent: number;
  memory: number;
  elapsed: number;
  command: string;
}
export interface Metrics {
  sampledAt: number;
  hostname: string;
  system: string;
  uptime: number;
  load: number[];
  cores: number;
  cpuPercent: number | null;
  memoryTotal: number;
  memoryUsed: number;
  memoryAvailable: number;
  swapTotal: number;
  swapUsed: number;
  disks: DiskMetric[];
  processes: ProcessMetric[];
  processTotal: number;
  warnings: string[];
}
export interface TerminalSize {
  cols: number;
  rows: number;
}
export interface RemoteFile {
  name: string;
  size: number;
  isDir: boolean;
  isSymlink: boolean;
  modified: string;
  mode: string;
}
export interface Directory {
  path: string;
  files: RemoteFile[];
}
export interface LocalDirectory extends Directory {
  parent: string;
}
export interface FilePreview {
  text: string;
  truncated: boolean;
}
export interface RemoteTextFile {
  path: string;
  text: string;
  revision: string;
  lineEnding: "LF" | "CRLF" | "mixed";
  bom: boolean;
}
export interface TransferRequest {
  sessionId: string;
  direction: "upload" | "download";
  sources: string[];
  destination: string;
  conflict: "skip" | "replace";
}
export interface Transfer {
  id: string;
  sessionId: string;
  direction: "upload" | "download";
  name: string;
  destination: string;
  status:
    | "queued"
    | "scanning"
    | "running"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";
  current: string;
  totalBytes: number;
  doneBytes: number;
  totalFiles: number;
  completedFiles: number;
  skipped: number;
  error: string;
  startedAt: number;
  finishedAt: number;
}
export interface Session {
  id: string;
  host: Host;
  terminalNumber: number;
  demo: boolean;
  wslDistribution?: string;
  localShell?: LocalShell;
  status: "connecting" | "connected" | "closed";
  error?: string;
}
export interface WSLInfo {
  supported: boolean;
  installed: boolean;
  distributions: { name: string; running: boolean }[];
  message: string;
}
export interface LocalShell {
  id: string;
  name: string;
  path: string;
}
export interface LocalShellInfo {
  supported: boolean;
  shells: LocalShell[];
  message: string;
}
export interface TerminalHandle {
  ready: () => boolean;
  send: (text: string) => void;
  paste: (text: string) => void;
  pasteFromClipboard: () => void;
  clear: () => void;
  focus: () => void;
  readBuffer: () => string;
  flushHistory: () => void;
  search: (text: string) => boolean;
  size: () => TerminalSize;
}
