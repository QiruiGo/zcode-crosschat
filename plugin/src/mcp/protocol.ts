/**
 * M3 protocol：xc_* 工具面的请求结果/错误映射（DESIGN.md §2.8、§2.7-2）。
 *
 * 约定：
 * - 成功结果 = 两个 text 块：第一个是 render.ts 产出的人可读一行摘要，
 *   第二个是机器可解析 JSON（模型与测试都消费后者）。
 * - 结构化错误 = isError:true + 单个 text 块（JSON），至少含 `error` 码。
 *   变更类工具在锁超时时返回 `{error:"busy", lock:<name>}`（DESIGN §2.7-2），
 *   协议指示：稍后重试一次，仍忙则上报用户。
 * - 本文件零内部依赖（不 import core/engine），可独立单测。
 */

/** 机器可解析的工具结果负载（成功与错误共用形状）。 */
export type ToolPayload = Record<string, unknown>;

/** 携带结构化负载的工具错误；wrap 边界把它映射成 isError 结果。 */
export class ToolError extends Error {
  readonly payload: ToolPayload;

  constructor(payload: ToolPayload, message?: string) {
    super(message ?? String(payload.message ?? payload.error ?? "tool error"));
    this.name = "ToolError";
    this.payload = payload;
  }
}

/** 跨进程锁 15 秒等待超时（DESIGN §2.7-2：返回 {error:"busy", lock}，不产生半状态）。 */
export function busyError(lock: string): ToolError {
  return new ToolError(
    { error: "busy", lock },
    `state is busy (lock "${lock}"); the protocol says: retry once shortly, then report to the user`,
  );
}

/** 未注册连接调用身份类工具（DESIGN §2.3-2、§2.8）。 */
export function notRegisteredError(): ToolError {
  return new ToolError(
    { error: "not_registered", message: "not registered: call xc_register first" },
    "not registered: call xc_register first",
  );
}

export function invalidParamsError(message: string, extra?: ToolPayload): ToolError {
  return new ToolError({ error: "invalid_params", message, ...extra }, message);
}

/** attempt 令牌不匹配的硬拒绝（DESIGN §2.6：stale 即拒，移植 dsh tools.js:1839-1841）。 */
export function staleAttemptError(taskId: string, expectedAttemptId: string): ToolError {
  const message =
    `stale attempt for task ${taskId}: expected the current attempt_id "${expectedAttemptId}"; ` +
    "stop work and request fresh assignment";
  return new ToolError(
    { error: "stale_attempt", taskId, attemptId: expectedAttemptId, message },
    message,
  );
}

export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * MCP CallToolResult 的最小结构面（与 SDK 结构兼容，避免在本模块 import SDK）。
 * 索引签名是 SDK registerTool/tool 回调返回类型的要求。
 */
export interface ToolResult {
  [key: string]: unknown;
  content: TextBlock[];
  isError?: boolean;
}

/** 成功信封：[人可读一行摘要, 机器 JSON]。 */
export function okResult(renderLine: string, payload: ToolPayload): ToolResult {
  return {
    content: [
      { type: "text", text: renderLine },
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/** 错误信封：isError:true + 单 JSON text 块。 */
export function errorResult(payload: ToolPayload): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/** 工具边界的统一错误映射：ToolError → 结构化负载；其他异常 → {error:"internal"}。 */
export function mapToolError(err: unknown): ToolResult {
  if (err instanceof ToolError) return errorResult(err.payload);
  const message = err instanceof Error ? err.message : String(err);
  return errorResult({ error: "internal", message });
}

/** core 层统一执行入口：捕获一切异常并映射成信封，工具处理器与单测共用。 */
export async function runTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return mapToolError(err);
  }
}

/** 从成功信封的第二个 text 块取回负载（测试/调试用）。 */
export function payloadOf(result: ToolResult): ToolPayload {
  const block = result.content[result.isError ? 0 : 1];
  try {
    return JSON.parse(block.text) as ToolPayload;
  } catch {
    return { error: "unparsable", text: block.text };
  }
}
