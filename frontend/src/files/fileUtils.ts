import type { Transfer } from "../types";

export type Side = "local" | "remote";

export const finished = (job: Transfer) =>
  ["completed", "failed", "cancelled"].includes(job.status);
export const statusText: Record<Transfer["status"], string> = {
  queued: "排队中",
  scanning: "统计文件…",
  running: "传输中",
  cancelling: "正在取消…",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  const unit = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return `${(n / 1024 ** unit).toFixed(1)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
export function child(dir: string, name: string, side: Side) {
  if (dir === "::drives") return name;
  const sep = side === "local" && dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]$/, "") + sep + name;
}
