/**
 * v0.7 C6（DESIGN-V0.7 §2.2/§2.4，M1）：tool_request/tool_result 帧的编解码与
 * 发送侧校验纯函数（无 I/O、无时钟副作用——now 由调用方注入）。
 *
 * 载体纪律（§1 设计决策）：C6 帧骑在 xc_relay 的 msg 里（JSON 字符串，`type` 键，
 * 与既有 7 个协议帧一致；E4 原型用 `kind` 键是绕过白名单的权宜，落地必须 `type`）
 * ——不新增工具（工具面维持恰 10）。
 *
 * 本模块只做「帧长什么样、合不合法」的纯判断；台账/审批文件/门的 I/O 在
 * toolledger.ts / toolapproval.ts / toolgate.ts；发送侧编排在 mcp/tools-relay.ts。
 *
 * @module core/toolrelay
 */

/** v0.7 新增帧型（mailbox.ts FRAME_TYPES 同步扩 4 值；E4 §7.1：不加白=静默剔除）。 */
export const TOOL_FRAME_TYPES = ['tool_request', 'tool_result', 'approval_request', 'approval_result'] as const;
export type ToolFrameType = (typeof TOOL_FRAME_TYPES)[number];

const TOOL_FRAME_TYPE_SET: ReadonlySet<string> = new Set<string>(TOOL_FRAME_TYPES);

/** 本模块的 4 个帧型是否机器帧（uservoice 盖章豁免 + 入站策略豁免的判据）。 */
export function isToolFrameType(frameType: string): boolean {
  return TOOL_FRAME_TYPE_SET.has(frameType);
}

// ---------------------------------------------------------------------------
// 预算常量（§2.4；env 只改缺省，不进 userConfig——与 v0.6 XC_MEM_* 同款先例）
// ---------------------------------------------------------------------------

/** args 序列化长度上限（64KB）。超限发送侧即拒（E4 §6.1 实测无闸是缺口）。 */
export const TOOL_REQUEST_MAX_ARGS_CHARS = 64_000;
/** 回投结果缺省上限（= budget.ts READ_PAGE_MAX_CHARS，mail 分页单页同值）。 */
export const DEFAULT_MAX_RESULT_CHARS = 64_000;
/** ttl 缺省 1h（请求有效期）。 */
export const DEFAULT_TOOL_REQUEST_TTL_MS = 3_600_000;
/** ttl 硬上限 24h（请求窗不得更长）。 */
export const MAX_TOOL_REQUEST_TTL_MS = 86_400_000;
/** reason 字段长度上限（进审计，防无界）。 */
export const MAX_REASON_CHARS = 2_048;
/** tool 名字长度上限（完整 MCP 工具名 `mcp__…__…`；自由字符串不枚举）。 */
export const MAX_TOOL_NAME_CHARS = 512;

/**
 * requestId 形态：单个安全路径段（字母数字开头，字母数字._-，≤128）。
 * requestId 同时是台账/审批文件名（toolrequests/<id>.json、approvals/<id>.json）
 * ——路径穿越（`..`/分隔符/盘符）必须在帧入口结构性排除（与 paths.ts
 * isValidTeamId 同款先例，v0.5.1 BND-1）。
 */
export const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** wake 投递禁令的 payload 标注（§2.2：tool_request 一律不唤醒投递）。 */
export const TOOL_REQUEST_WAKE_SUPPRESSION_NOTE = 'suppressed (approval-gate bypass guard)';

// ---------------------------------------------------------------------------
// 帧类型（type 键，与既有协议帧一致）
// ---------------------------------------------------------------------------

export interface ToolRequestApproval {
  required: true;
  /** 审批文件路径（缺省 <stateRoot>/approvals/<requestId>.json；同状态根内可指定）。 */
  file?: string;
  /** 请求有效期（缺省 toolRequestTtlMsFromEnv；硬上限 MAX_TOOL_REQUEST_TTL_MS）。 */
  ttlMs?: number;
}

export interface ToolRequestFrame {
  type: 'tool_request';
  requestId: string;
  /** 请求方（必须 === 发送连接身份；与信封 from 双写）。 */
  from: string;
  /** 完整 MCP 工具名；自由字符串，不枚举（E4 §2：协议与工具无关）。 */
  tool: string;
  /** 工具参数（对象；序列化 ≤ TOOL_REQUEST_MAX_ARGS_CHARS）。 */
  args: unknown;
  /** 转办理由（必填，进审计）。 */
  reason: string;
  approval: ToolRequestApproval;
  /** 回投上限（缺省 DEFAULT_MAX_RESULT_CHARS；上限同值）。 */
  maxResultChars?: number;
}

export type ToolResultStatus = 'ok' | 'refused' | 'error';

export interface ToolResultFrame {
  type: 'tool_result';
  requestId: string;
  /** 执行方（必须 === 台账.to；伪造回投在 relay 核心拒收）。 */
  from: string;
  status: ToolResultStatus;
  tool: string;
  /** status=ok 的结果载荷（可为任意 JSON 值）。 */
  result?: unknown;
  /** status=error 的平台错误原文（不伪造结果，E4 §6.4）。 */
  error?: string;
  /** status=refused 的拒绝原因。 */
  reason?: string;
  /** 回投时刻（R7：resumed 会话记忆污染，接收方以邮箱原文+requestId+ts 自判新旧）。 */
  ts?: number;
}

export interface ApprovalRequestFrame {
  type: 'approval_request';
  requestId: string;
  from: string;
  tool: string;
  reason: string;
  expiresAt: number;
  /** 批准方式文案（文件轨路径或 xc_review 工具轨调用形态）。 */
  approveHow: string;
}

export interface ApprovalResultFrame {
  type: 'approval_result';
  requestId: string;
  decision: 'approved' | 'denied' | 'expired';
  decidedBy: string;
  decidedAt: number;
  expiresAt?: number;
}

/** 解析 content 的 C6/C7 帧型；非本族帧（chat/其他协议帧）返回 undefined。 */
export function parseToolFrameType(content: string): ToolFrameType | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)['type'];
  return typeof raw === 'string' && TOOL_FRAME_TYPE_SET.has(raw) ? (raw as ToolFrameType) : undefined;
}

// ---------------------------------------------------------------------------
// 校验结果形态（core 不抛 mcp 的 ToolError；由调用面映射为结构化错误信封）
// ---------------------------------------------------------------------------

export interface FrameCheckOk<T> { ok: true; frame: T }
export interface FrameCheckErr { ok: false; error: string; message: string }
export type FrameCheck<T> = FrameCheckOk<T> | FrameCheckErr;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// tool_request 发送侧校验（§2.2/§2.4）
// ---------------------------------------------------------------------------

export interface ToolRequestCheck {
  frame: ToolRequestFrame;
  /** 生效 ttl（帧值或 env 缺省；已钳制 ≤ 硬上限）。 */
  ttlMs: number;
  /** 生效回投上限（帧值或缺省；已钳制 ≤ READ_PAGE_MAX_CHARS 同值）。 */
  maxResultChars: number;
  /** 生效审批文件路径（帧值；缺省由调用面按 <stateRoot>/approvals/<id>.json 解析）。 */
  approvalFile?: string;
}

/**
 * tool_request 帧校验（发送侧；调用方持发送者身份 senderKey）。
 *
 * 判据（§2.2/§2.4 + E4 §5 字段草案）：
 * - 形状：type/requestId/from/tool/args/reason/approval.required 必填，approval.required===true；
 * - requestId 路径安全（REQUEST_ID_RE）——同时是台账/审批文件名；
 * - from === 发送者（防冒充请求方；信封 from 另有渲染面核对）；
 * - args 序列化 ≤ 64KB（超限 args_too_large，§2.4「发送侧即拒」）；
 * - ttlMs ≤ 24h 硬上限；maxResultChars ≤ 64K 上限；
 * - approval.file 若在场必须是字符串（同状态根内的路径 containment 由 mcp 面校验，
 *   需要 stateRoot——纯函数不持路径上下文）。
 */
export function checkToolRequestFrame(
  content: string,
  senderKey: string,
  ttlDefaultMs: number,
): FrameCheck<ToolRequestCheck> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { ok: false, error: 'invalid_frame', message: 'tool_request frame is not parseable JSON' };
  }
  if (!isRecord(value)) return { ok: false, error: 'invalid_frame', message: 'tool_request frame must be a JSON object' };
  if (value['type'] !== 'tool_request') {
    return { ok: false, error: 'invalid_frame', message: `expected type "tool_request", got ${JSON.stringify(value['type'])}` };
  }
  const requestId = value['requestId'];
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return {
      ok: false,
      error: 'invalid_request_id',
      message: 'tool_request.requestId must be a single safe path segment (letters/digits/._-, <=128 chars); '
        + 'it doubles as the ledger/approval file name',
    };
  }
  const from = value['from'];
  if (from !== senderKey) {
    return {
      ok: false,
      error: 'tool_request_from_mismatch',
      message: `tool_request.from must be your own member key ("${senderKey}"); got ${JSON.stringify(from)}`,
    };
  }
  if (!nonEmptyString(value['tool'], MAX_TOOL_NAME_CHARS)) {
    return { ok: false, error: 'invalid_frame', message: 'tool_request.tool must be a non-empty string (full MCP tool name)' };
  }
  const args = value['args'];
  if (!isRecord(args)) {
    return { ok: false, error: 'invalid_frame', message: 'tool_request.args must be a JSON object' };
  }
  let argsChars: number;
  try {
    argsChars = JSON.stringify(args).length;
  } catch {
    return { ok: false, error: 'invalid_frame', message: 'tool_request.args is not JSON-serializable' };
  }
  if (argsChars > TOOL_REQUEST_MAX_ARGS_CHARS) {
    return {
      ok: false,
      error: 'args_too_large',
      message: `tool_request.args serializes to ${argsChars} chars (limit ${TOOL_REQUEST_MAX_ARGS_CHARS}); `
        + 'shrink the payload or pass a file pointer instead',
    };
  }
  if (!nonEmptyString(value['reason'], MAX_REASON_CHARS)) {
    return { ok: false, error: 'invalid_frame', message: 'tool_request.reason is required (goes to the audit trail)' };
  }
  const approval = value['approval'];
  if (!isRecord(approval) || approval['required'] !== true) {
    return {
      ok: false,
      error: 'invalid_frame',
      message: 'tool_request.approval must be {required:true, file?, ttlMs?} — approval-gated transfer only',
    };
  }
  const approvalFile = approval['file'];
  if (approvalFile !== undefined && typeof approvalFile !== 'string') {
    return { ok: false, error: 'invalid_frame', message: 'tool_request.approval.file must be a string path when present' };
  }
  const rawTtl = approval['ttlMs'];
  let ttlMs = ttlDefaultMs;
  if (rawTtl !== undefined) {
    if (!positiveInt(rawTtl)) {
      return { ok: false, error: 'invalid_frame', message: 'tool_request.approval.ttlMs must be a positive integer (ms)' };
    }
    ttlMs = rawTtl;
  }
  if (ttlMs > MAX_TOOL_REQUEST_TTL_MS) {
    return {
      ok: false,
      error: 'ttl_exceeds_cap',
      message: `tool_request ttl ${ttlMs}ms exceeds the hard cap ${MAX_TOOL_REQUEST_TTL_MS}ms (24h)`,
    };
  }
  const rawMax = value['maxResultChars'];
  let maxResultChars = DEFAULT_MAX_RESULT_CHARS;
  if (rawMax !== undefined) {
    if (!positiveInt(rawMax)) {
      return { ok: false, error: 'invalid_frame', message: 'tool_request.maxResultChars must be a positive integer' };
    }
    maxResultChars = rawMax;
  }
  if (maxResultChars > DEFAULT_MAX_RESULT_CHARS) {
    return {
      ok: false,
      error: 'result_cap_exceeded',
      message: `tool_request.maxResultChars ${maxResultChars} exceeds the cap ${DEFAULT_MAX_RESULT_CHARS} (= READ_PAGE_MAX_CHARS)`,
    };
  }
  const frame: ToolRequestFrame = {
    type: 'tool_request',
    requestId,
    from: senderKey,
    tool: value['tool'] as string,
    args,
    reason: value['reason'] as string,
    approval: { required: true, ...(approvalFile !== undefined ? { file: approvalFile } : {}) },
    ...(rawTtl !== undefined ? { maxResultChars } : {}),
  };
  // maxResultChars 显式落帧（缺省时台账仍记生效值，回投侧以台账为准）。
  const check: ToolRequestCheck = {
    frame: { ...frame, maxResultChars },
    ttlMs,
    maxResultChars,
    ...(approvalFile !== undefined ? { approvalFile } : {}),
  };
  return { ok: true, frame: check };
}

// ---------------------------------------------------------------------------
// tool_result 发送侧校验（§2.6 伪造回投拒收 + §2.4 结果上限）
// ---------------------------------------------------------------------------

export interface ToolResultLedgerView {
  requestId: string;
  from: string;
  to: string;
  tool: string;
  state: 'pending' | 'approved' | 'denied' | 'refused' | 'executed' | 'error' | 'expired';
  maxResultChars: number;
}

/**
 * v0.7.2（B-03 修复）：tool_result.result 的**有效载荷**字符数。
 *
 * 旧实现一律取 `JSON.stringify(result).length`——字符串结果被算上外层引号，
 * 有效载荷恒等于 `maxResultChars − 2`，「正好等于限值」的合法结果被拒
 * （裁决日志 b03.jsonl：1000 vs 1000 → 拒，报文 "serializes to 1002 chars"）。
 * 口径改为与 maxResultChars 的语义一致：**字符串取自身长度**（模型真正产出的
 * 字符数），非字符串（对象/数组/数字/null）仍取序列化长度（无别的自然度量）。
 * `resultTruncated{shown,total}` 的 shown 亦按同一口径自洽。
 */
export function toolResultPayloadChars(result: unknown): number {
  if (typeof result === 'string') return result.length;
  try {
    return JSON.stringify(result ?? null).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * tool_result 帧校验（发送侧；调用方持发送者身份 senderKey 与台账视图）。
 *
 * 判据（§2.6/§2.7）：
 * - 形状 + status ∈ {ok,refused,error} + 对应载荷键（result/error/reason）；
 * - from === 台账.to（执行方身份；伪造回投 tool-result-rejected，不落箱不终填）；
 * - tool === 台账.tool（逐字节，与请求侧绑定同口径）；
 * - 台账状态必须已放行（approved）——未过门的回投拒收；
 * - 结果有效载荷 ≤ 台账.maxResultChars（超限 result_too_large，模型改投摘要+指针；
 *   字符串按自身长度计，v0.7.2 B-03 修复——不再把 JSON 引号算进载荷）。
 */
export function checkToolResultFrame(
  content: string,
  senderKey: string,
  ledger: ToolResultLedgerView,
): FrameCheck<ToolResultFrame> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { ok: false, error: 'invalid_frame', message: 'tool_result frame is not parseable JSON' };
  }
  if (!isRecord(value)) return { ok: false, error: 'invalid_frame', message: 'tool_result frame must be a JSON object' };
  if (value['type'] !== 'tool_result') {
    return { ok: false, error: 'invalid_frame', message: `expected type "tool_result", got ${JSON.stringify(value['type'])}` };
  }
  const requestId = value['requestId'];
  if (typeof requestId !== 'string' || requestId === '') {
    return { ok: false, error: 'invalid_frame', message: 'tool_result.requestId is required' };
  }
  if (requestId !== ledger.requestId) {
    return {
      ok: false,
      error: 'requestId_mismatch',
      message: `tool_result.requestId "${requestId}" does not match the request being answered ("${ledger.requestId}")`,
    };
  }
  if (value['from'] !== ledger.to || senderKey !== ledger.to) {
    return {
      ok: false,
      error: 'tool_result_from_mismatch',
      message: `tool_result.from must be the request's executor ("${ledger.to}"); forged result receipts are refused`,
    };
  }
  const status = value['status'];
  if (status !== 'ok' && status !== 'refused' && status !== 'error') {
    return { ok: false, error: 'invalid_frame', message: 'tool_result.status must be "ok" | "refused" | "error"' };
  }
  if (!nonEmptyString(value['tool'], MAX_TOOL_NAME_CHARS)) {
    return { ok: false, error: 'invalid_frame', message: 'tool_result.tool must be a non-empty string' };
  }
  if (value['tool'] !== ledger.tool) {
    return {
      ok: false,
      error: 'tool_mismatch',
      message: `tool_result.tool "${value['tool']}" does not match the requested tool ("${ledger.tool}")`,
    };
  }
  if (ledger.state === 'executed' || ledger.state === 'error') {
    return {
      ok: false,
      error: 'request_already_finalized',
      message: `request ${ledger.requestId} already finalized (state=${ledger.state}); one request takes one result`,
    };
  }
  if (ledger.state !== 'approved') {
    return {
      ok: false,
      error: 'request_not_approved',
      message: `request ${ledger.requestId} is not approved (state=${ledger.state}); the approval gate must pass before executing`,
    };
  }
  if (status === 'ok' && !('result' in value)) {
    return { ok: false, error: 'invalid_frame', message: 'tool_result with status "ok" must carry a "result" field' };
  }
  if (status === 'error' && !nonEmptyString(value['error'], MAX_REASON_CHARS)) {
    return { ok: false, error: 'invalid_frame', message: 'tool_result with status "error" must carry an "error" string' };
  }
  if (status === 'refused' && !nonEmptyString(value['reason'], MAX_REASON_CHARS)) {
    return { ok: false, error: 'invalid_frame', message: 'tool_result with status "refused" must carry a "reason" string' };
  }
  let resultChars = 0;
  if (status === 'ok') {
    try {
      resultChars = toolResultPayloadChars(value['result'] ?? null);
    } catch {
      return { ok: false, error: 'invalid_frame', message: 'tool_result.result is not JSON-serializable' };
    }
    if (resultChars > ledger.maxResultChars) {
      return {
        ok: false,
        error: 'result_too_large',
        message: `tool_result.result payload is ${resultChars} chars (limit ${ledger.maxResultChars}); `
          + 'send a summary plus a file pointer instead',
      };
    }
  }
  const frame: ToolResultFrame = {
    type: 'tool_result',
    requestId,
    from: ledger.to,
    status,
    tool: value['tool'] as string,
    ...(status === 'ok' ? { result: value['result'] } : {}),
    ...(status === 'error' ? { error: value['error'] as string } : {}),
    ...(status === 'refused' ? { reason: value['reason'] as string } : {}),
  };
  return { ok: true, frame };
}

// ---------------------------------------------------------------------------
// 插件侧帧构造（门拒回投 / 审批通知与回执——模型不撰写这些帧）
// ---------------------------------------------------------------------------

/** 门拒/过期时插件侧回投给请求方的 tool_result（§2.6/§2.7）。 */
export function buildRefusedToolResult(requestId: string, tool: string, from: string, reason: string, now: number): ToolResultFrame {
  return { type: 'tool_result', requestId, from, status: 'refused', tool, reason, ts: now };
}

/** 门在「无审批」时向 lead 发的待批通知（§3.1；只通知，不带授权语义）。 */
export function buildApprovalRequest(
  requestId: string,
  from: string,
  tool: string,
  reason: string,
  expiresAt: number,
  approveHow: string,
): ApprovalRequestFrame {
  return { type: 'approval_request', requestId, from, tool, reason, expiresAt, approveHow };
}

/** xc_review approve/deny 或 sweeper 过期收尾时写给请求方的回执（§3.1/§3.3）。 */
export function buildApprovalResult(
  requestId: string,
  decision: ApprovalResultFrame['decision'],
  decidedBy: string,
  decidedAt: number,
  expiresAt?: number,
): ApprovalResultFrame {
  return {
    type: 'approval_result',
    requestId,
    decision,
    decidedBy,
    decidedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// env 阈值（只走 env，不进 userConfig——与 v0.6 XC_MEM_* 同款先例）
// ---------------------------------------------------------------------------

/**
 * XC_TOOL_REQUEST_TTL_MS：tool_request 缺省有效期（ms）。
 * 非有限正数取缺省 1h；超硬上限按硬上限钳制（env 只能改缺省，不能放大请求窗上限）。
 */
export function toolRequestTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = Number(env['XC_TOOL_REQUEST_TTL_MS']);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_REQUEST_TTL_MS;
  return Math.min(ms, MAX_TOOL_REQUEST_TTL_MS);
}
