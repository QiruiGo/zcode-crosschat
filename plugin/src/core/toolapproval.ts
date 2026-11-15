/**
 * v0.7 C7（DESIGN-V0.7 §2.3/§3.1，M3）：审批授权文件的读写与校验纯函数。
 *
 * 授权锚点纪律（v0.2 起立意，mailbox.ts 头注）：白名单帧永不代表授权
 * （"permission rules are never accepted from messages"）——C6/C7 的 4 个新帧型
 * 只做通知/回执，**授权只认审批文件**。审批文件由用户/lead 落盘（文件轨）或
 * `xc_review approve` 代写（工具轨，同一格式），插件侧确定性校验。
 *
 * 威胁模型口径（§10.4）：门防流程缺失与误操作（无审批执行/过期执行/畸形执行/自批），
 * 不防恶意模型或同机进程直接伪造审批文件——与 v0.5 uservoice 同边界，README 披露。
 *
 * @module core/toolapproval
 */
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { approvalsDir, approvalsFile } from './paths.js';
import { sanitizeKey } from './sanitize.js';

/** 审批文件格式（E4 §5 原型形态，v0.7 落地同款）。 */
export interface ApprovalFile {
  requestId: string;
  decision: 'approved' | 'denied';
  /** 批准者（用户/lead 的成员键；≠ 请求方与执行方，§2.3）。 */
  approvedBy: string;
  decidedAt: number;
  /** 批准窗截止（必须 > now 且 ≤ 请求 expiresAt，§2.3）。 */
  expiresAt: number;
  /** 与请求 tool 逐字节相等（逐请求绑定，§2.3）。 */
  tool: string;
  note?: string;
}

/** 审批文件读取结果（missing/malformed/ok 三态；malformed 含不可解析与形状不符）。 */
export type ApprovalRead =
  | { status: 'missing' }
  | { status: 'malformed'; reason: string }
  | { status: 'ok'; approval: ApprovalFile };

/**
 * 门拒原因词表（§2.6 全表；approval window/tool 绑定为 §2.3 增量）。
 *
 * v0.7.2（C7-B3 修复）：畸形审批文件的理由分流——真·不可解析 JSON 与「JSON 可解析但
 * 字段非法/不是对象/requestId 与文件名不符」共用同一句 `unparseable JSON` 会让运维
 * 按错误方向排查（9/9 变体同理由，裁决日志 c7b3.jsonl）。词表保留家族前缀
 * `approval file malformed (...)`（PROTOCOL §11.2 失败表按家族列示），括号内按
 * 实际形态分流：`unparseable JSON` / `not a JSON object` / `invalid fields: <清单>` /
 * `requestId mismatch`。
 */
export type ApprovalRefuseReason =
  | 'approval missing'
  | 'approval denied'
  | 'approval expired'
  | 'approval tool mismatch'
  | 'self-approval refused'
  | 'approval window exceeds request ttl'
  | 'approval file outside state root'
  | `approval file malformed (${string})`;

/** 请求侧视图（门/校验只需要这几个字段）。 */
export interface ApprovalRequestView {
  requestId: string;
  tool: string;
  from: string;
  to: string;
  /** 请求过期时刻（批准窗不得超出，§2.3）。 */
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 审批文件字段清单（缺字段/类型不符逐项列出，供诊断分流；顺序固定便于测试断言）。
 * `decision` 只接受 'approved'|'denied'；`requestId` 与文件名的一致性在调用方判。
 */
const APPROVAL_FIELDS: ReadonlyArray<{ key: string; ok: (v: unknown) => boolean; want: string }> = [
  { key: 'requestId', ok: (v) => typeof v === 'string' && v !== '', want: 'non-empty string' },
  { key: 'decision', ok: (v) => v === 'approved' || v === 'denied', want: '"approved" | "denied"' },
  { key: 'approvedBy', ok: (v) => typeof v === 'string' && v !== '', want: 'non-empty string' },
  { key: 'decidedAt', ok: (v) => typeof v === 'number' && Number.isFinite(v), want: 'number' },
  { key: 'expiresAt', ok: (v) => typeof v === 'number' && Number.isFinite(v), want: 'number' },
  { key: 'tool', ok: (v) => typeof v === 'string' && v !== '', want: 'non-empty string' },
];

function invalidApprovalFields(value: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const f of APPROVAL_FIELDS) {
    const v = value[f.key];
    if (v === undefined) bad.push(`${f.key} missing`);
    else if (!f.ok(v)) bad.push(`${f.key} must be ${f.want}`);
  }
  return bad;
}

/**
 * 读审批文件。路径 = 显式 override（同状态根内，发送侧已校验）或缺省
 * `<stateRoot>/approvals/<requestId>.json`。override 逃出状态根 → malformed
 * （fail-closed；授予理由见 ApprovalRefuseReason）。
 */
export async function readApprovalFile(
  stateRoot: string,
  requestId: string,
  overridePath?: string,
): Promise<ApprovalRead> {
  const file = overridePath !== undefined ? overridePath : approvalsFile(stateRoot, requestId);
  if (overridePath !== undefined && !isWithinStateRoot(stateRoot, overridePath)) {
    return { status: 'malformed', reason: 'approval file outside state root' };
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { status: 'missing' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: 'malformed', reason: 'approval file malformed (unparseable JSON)' };
  }
  if (!isRecord(value)) {
    // 可解析但不是对象（顶层数组/字符串/数字/null）——与不可解析分流，排查方向不同。
    return { status: 'malformed', reason: 'approval file malformed (not a JSON object)' };
  }
  const bad = invalidApprovalFields(value);
  if (bad.length > 0) {
    return { status: 'malformed', reason: `approval file malformed (invalid fields: ${bad.join('; ')})` };
  }
  if (value.requestId !== requestId) {
    return {
      status: 'malformed',
      reason: `approval file malformed (requestId mismatch: file says ${JSON.stringify(value.requestId)}, expected ${JSON.stringify(requestId)})`,
    };
  }
  return { status: 'ok', approval: value as unknown as ApprovalFile };
}

/** 写审批文件（工具轨 xc_review approve/deny；原子写，返回落地路径）。 */
export async function writeApprovalFile(stateRoot: string, approval: ApprovalFile, overridePath?: string): Promise<string> {
  const file = overridePath !== undefined ? overridePath : approvalsFile(stateRoot, approval.requestId);
  await mkdir(approvalsDir(stateRoot), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(approval, null, 2));
  return file;
}

/** 审批文件是否存在（xc_review axis:"approval" 待批清单判据；不解析内容）。 */
export async function approvalFileExists(stateRoot: string, requestId: string, overridePath?: string): Promise<boolean> {
  const file = overridePath !== undefined ? overridePath : approvalsFile(stateRoot, requestId);
  try {
    await readFile(file, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 审批校验纯函数（§2.3 全矩阵；E4 §6.4 实测三种形态的正确拒绝在此确定性化）。
 *
 * 顺序：缺失 → 畸形 → denied → 自批 → 工具不符 → 过期 → 窗口越界。
 * 自批判据：approvedBy === 请求方或执行方均拒（「A 的模型自己写审批」的 naive
 * 路径与误操作同防——内部威胁模型声明：不防恶意同机进程伪造文件）。
 *
 * v0.7.2（C7-B2 修复）：自批守卫按**成员键归一化**后比较。旧实现是字面串比较，
 * `approvedBy:"REQB"`（请求方键 reqb）能绕过 self-approval refused 直接放行
 * （裁决日志 c7b2b.jsonl：`"REQB"`/`"ExecA"`/`"LEAD1"` 均放行）。成员键本身由
 * sanitizeKey 生成（小写折叠 + 非字母数字折 `-`），故审批文件里的 approvedBy
 * 也过同一条清洗链再比对——同一把键的不同写法不再构成绕过面。
 */
export function checkApproval(read: ApprovalRead, request: ApprovalRequestView, now: number): { ok: true } | { ok: false; reason: ApprovalRefuseReason } {
  if (read.status === 'missing') return { ok: false, reason: 'approval missing' };
  if (read.status === 'malformed') return { ok: false, reason: read.reason as ApprovalRefuseReason };
  const approval = read.approval;
  if (approval.decision === 'denied') return { ok: false, reason: 'approval denied' };
  const approver = sanitizeKey(approval.approvedBy);
  const requester = sanitizeKey(request.from);
  const executor = sanitizeKey(request.to);
  if (approver !== '' && (approver === requester || approver === executor)) {
    return { ok: false, reason: 'self-approval refused' };
  }
  if (approval.tool !== request.tool) return { ok: false, reason: 'approval tool mismatch' };
  if (approval.expiresAt <= now) return { ok: false, reason: 'approval expired' };
  if (approval.expiresAt > request.expiresAt) return { ok: false, reason: 'approval window exceeds request ttl' };
  return { ok: true };
}

/** 路径 containment：p 解析后必须位于 stateRoot 内（§2.2 approval.file 约束）。 */
export function isWithinStateRoot(stateRoot: string, p: string): boolean {
  if (!isAbsolute(p)) return false;
  const root = resolve(stateRoot);
  const abs = resolve(p);
  if (abs === root) return true;
  const withSep = root.endsWith(sep) ? root : root + sep;
  return abs.startsWith(withSep);
}

/** 构造审批文件（工具轨；approvedBy=现任 lead 的连接身份，由调用方传入）。 */
export function buildApprovalFile(params: {
  requestId: string;
  decision: 'approved' | 'denied';
  approvedBy: string;
  decidedAt: number;
  expiresAt: number;
  tool: string;
  note?: string;
}): ApprovalFile {
  return {
    requestId: params.requestId,
    decision: params.decision,
    approvedBy: params.approvedBy,
    decidedAt: params.decidedAt,
    expiresAt: params.expiresAt,
    tool: params.tool,
    ...(params.note !== undefined ? { note: params.note } : {}),
  };
}
