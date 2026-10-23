import type { MCPCommandRequest } from "./types";

export function approvalDeadline(request: MCPCommandRequest): number | undefined {
  return request.expiresAt ??
    (request.createdAt ? request.createdAt + 120_000 : undefined);
}

export function isApprovalExpired(request: MCPCommandRequest, now = Date.now()): boolean {
  const deadline = approvalDeadline(request);
  return deadline !== undefined && now >= deadline;
}

export function isApprovalGone(error: string): boolean {
  return /命令请求.*(不存在|已处理|超时|过期|取消)/.test(error);
}
