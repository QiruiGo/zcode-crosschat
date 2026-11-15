/**
 * v0.7 C6（DESIGN-V0.7 §2.5，M2）：tool_request 台账（`.crosschat/toolrequests/<requestId>.json`）。
 *
 * 台账 = 转办请求的单一可检索状态源（E4 §7.4 建议的最小实现）：发送时建（pending），
 * 门放行/门拒/审批决定/回投终填/清扫过期各有一次写入点；读者 = 读取面审批门、
 * xc_review axis:"approval"、sweeper 过期节拍。邮箱原文 + 台账 + 审计三轨
 * （「不丢/可核对」底线，JSONL 追加真源纪律的台账对应物）。
 *
 * 状态机（§2.5/§3.1 同一套枚举，不设第二套词表）：
 *   pending → approved（门放行≥1 次或工具轨批准）
 *           → denied（审批文件 decision=denied）
 *           → refused（门拒：缺失/畸形/过期/工具不符/自批）
 *           → executed（收到 ok 回投）/ error（收到 error 回投）
 *           → expired（sweeper 判 ttl 超期）
 * approved 亦可由 refused/denied 经显式批准动作转入（后者写者胜，§10.3-4）。
 *
 * 锁纪律：写路径的调用方（relay 核心/xc_review/门/sweeper）各自持团队锁或接受
 * 无锁读改写（O_APPEND/原子 rename 的单文件语义；单人内部场景竞态有界）。
 *
 * @module core/toolledger
 */
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { writeFileAtomic } from './atomic.js';
import { logEngineEvent } from './log.js';
import { approvalsDir, approvalsFile, toolRequestFile, toolRequestsDir } from './paths.js';

/** 台账状态枚举（§2.5；approval 文件侧只有 approved/denied 两词——denied=显式拒绝，
 *  refused=门自动拒，executed/error=回投终态，expired=ttl 超期）。 */
export type ToolRequestState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'refused'
  | 'executed'
  | 'error'
  | 'expired';

/** 终态集合（§3.3 清理域；error 与 executed 同为回投终态——设计 §3.3 列举四项时
 *  未含 error，实现按状态机语义并入，避免 error 台账永驻）。 */
export const TERMINAL_TOOL_STATES: readonly ToolRequestState[] = ['executed', 'error', 'refused', 'denied', 'expired'];

export function isTerminalToolState(state: ToolRequestState): boolean {
  return TERMINAL_TOOL_STATES.includes(state);
}

/** 门放行态（§2.7：state ∈ approved/executed/error 出全文）。 */
export function isGatePassState(state: ToolRequestState): boolean {
  return state === 'approved' || state === 'executed' || state === 'error';
}

export interface ToolRequestLedger {
  requestId: string;
  /** 请求方（B）。 */
  from: string;
  /** 执行方（A；= relay 的 to）。 */
  to: string;
  tool: string;
  reason: string;
  ttlMs: number;
  maxResultChars: number;
  /** 生效审批文件路径（缺省 <stateRoot>/approvals/<requestId>.json）。 */
  approvalFile?: string;
  state: ToolRequestState;
  createdAt: number;
  /** 请求过期时刻 = createdAt + ttlMs（§2.5）。 */
  expiresAt: number;
  /** 最近一次裁决/终态时刻（批准/拒绝/回投/过期）；清理年龄锚点。 */
  decidedAt?: number;
  decidedBy?: string;
  decisionReason?: string;
  /** lead 待批通知（approval_request 帧）已发送时刻——防每次读箱重复通知。 */
  approvalNotifiedAt?: number;
  /** 回投结果字符数（tool-executed 审计同值）。 */
  resultChars?: number;
  /** 回投帧落箱后的 messageId（可按 id 检索）。 */
  resultMessageId?: string;
}

function isLedgerShape(value: unknown): value is ToolRequestLedger {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v['requestId'] === 'string'
    && typeof v['from'] === 'string'
    && typeof v['to'] === 'string'
    && typeof v['tool'] === 'string'
    && typeof v['reason'] === 'string'
    && typeof v['ttlMs'] === 'number'
    && typeof v['maxResultChars'] === 'number'
    && typeof v['state'] === 'string'
    && typeof v['createdAt'] === 'number'
    && typeof v['expiresAt'] === 'number';
}

/**
 * 读一条台账。文件缺失 → undefined；不可解析/形状不符 → undefined + 审计
 * （门侧 fail-closed 遮蔽；「台账丢了」不等于「请求没了」——邮箱原文仍在）。
 */
export async function readToolRequest(stateRoot: string, requestId: string): Promise<ToolRequestLedger | undefined> {
  let text: string;
  try {
    text = await readFile(toolRequestFile(stateRoot, requestId), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isLedgerShape(value) || value.requestId !== requestId) {
      await logEngineEvent(stateRoot, { event: 'tool-ledger-unreadable', requestId, reason: 'shape-mismatch' });
      return undefined;
    }
    return value;
  } catch {
    await logEngineEvent(stateRoot, { event: 'tool-ledger-unreadable', requestId, reason: 'unparseable-json' });
    return undefined;
  }
}

/** 列全部台账（xc_review axis:"approval" 与 sweeper 用；坏行跳过）。 */
export async function listToolRequests(stateRoot: string): Promise<ToolRequestLedger[]> {
  let names: string[];
  try {
    names = await readdir(toolRequestsDir(stateRoot));
  } catch {
    return [];
  }
  const out: ToolRequestLedger[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const requestId = name.slice(0, -'.json'.length);
    const ledger = await readToolRequest(stateRoot, requestId);
    if (ledger !== undefined) out.push(ledger);
  }
  return out;
}

/**
 * 建台账（pending）。requestId 占用即拒（Error: requestId-in-use）——用 OS 级
 * 独占创建（flag wx）做查建原子化，防并发同 id 双写。
 */
export async function createToolRequest(stateRoot: string, entry: ToolRequestLedger): Promise<void> {
  await mkdir(toolRequestsDir(stateRoot), { recursive: true });
  try {
    await writeFile(toolRequestFile(stateRoot, entry.requestId), JSON.stringify(entry, null, 2), { flag: 'wx' });
  } catch (err) {
    if (err !== null && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`requestId-in-use: ${entry.requestId}`);
    }
    throw err;
  }
}

/**
 * 读改写一条台账（mutate 返回 undefined = 放弃本次写入）。
 * 返回写入后的台账；文件缺失 → undefined。
 */
export async function updateToolRequest(
  stateRoot: string,
  requestId: string,
  mutate: (ledger: ToolRequestLedger) => ToolRequestLedger | undefined,
): Promise<ToolRequestLedger | undefined> {
  const current = await readToolRequest(stateRoot, requestId);
  if (current === undefined) return undefined;
  const next = mutate(current);
  if (next === undefined) return current;
  await writeFileAtomic(toolRequestFile(stateRoot, requestId), JSON.stringify(next, null, 2));
  return next;
}

/** 待批清单（§3.2 list axis:"approval" 的数据源；审批文件存在性由调用面判）。 */
export async function listPendingToolRequests(stateRoot: string): Promise<ToolRequestLedger[]> {
  return (await listToolRequests(stateRoot)).filter((l) => l.state === 'pending');
}

/**
 * 过期节拍（§2.5/§2.6：sweeper 扫台账标 expired）。
 * 只动 pending（approved 未执行的请求也允许过期——执行窗随请求窗关闭）。
 * 返回本次被标 expired 的台账（调用方负责回投请求方）。
 */
export async function expireToolRequests(stateRoot: string, now: number): Promise<ToolRequestLedger[]> {
  const expired: ToolRequestLedger[] = [];
  for (const ledger of await listToolRequests(stateRoot)) {
    if (ledger.state !== 'pending' && ledger.state !== 'approved') continue;
    if (now < ledger.expiresAt) continue;
    const next = await updateToolRequest(stateRoot, ledger.requestId, (l) =>
      l.state === 'pending' || l.state === 'approved'
        ? { ...l, state: 'expired', decidedAt: now, decidedBy: 'engine', decisionReason: 'request expired' }
        : undefined,
    );
    if (next !== undefined && next.state === 'expired') expired.push(next);
  }
  return expired;
}

/**
 * 终态清理（§3.3）：终态台账与审批文件保留 TOOL_APPROVAL_KEEP_MS（7 天，常量不新增
 * env）后删除。年龄锚点 = decidedAt ?? expiresAt（回投/裁决时刻，缺省落请求过期时刻）。
 * 邮箱帧不预清理（JSONL 追加真源纪律，v0.6 起不做 TTL）。
 */
export const TOOL_APPROVAL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface ToolArtifactCleanupResult {
  ledgers: string[];
  approvals: string[];
}

export async function cleanupToolArtifacts(
  stateRoot: string,
  now: number,
  keepMs: number = TOOL_APPROVAL_KEEP_MS,
): Promise<ToolArtifactCleanupResult> {
  const result: ToolArtifactCleanupResult = { ledgers: [], approvals: [] };
  for (const ledger of await listToolRequests(stateRoot)) {
    if (!isTerminalToolState(ledger.state)) continue;
    const anchor = ledger.decidedAt ?? ledger.expiresAt;
    if (now - anchor < keepMs) continue;
    try {
      await unlink(toolRequestFile(stateRoot, ledger.requestId));
      result.ledgers.push(ledger.requestId);
    } catch {
      // 已删/不可删：下轮重试（best-effort，不影响回池）。
    }
  }
  // 审批文件：无对应台账的孤儿（台账已清）或台账终态且同锚点超期的，一并清。
  const liveLedgers = new Map((await listToolRequests(stateRoot)).map((l) => [l.requestId, l]));
  for (const name of await listApprovalNames(stateRoot)) {
    if (!name.endsWith('.json')) continue;
    const requestId = name.slice(0, -'.json'.length);
    const ledger = liveLedgers.get(requestId);
    if (ledger !== undefined && !isTerminalToolState(ledger.state)) continue; // 在途请求的审批文件不动
    if (ledger !== undefined) {
      const anchor = ledger.decidedAt ?? ledger.expiresAt;
      if (now - anchor < keepMs) continue;
    }
    try {
      await unlink(approvalsFile(stateRoot, requestId));
      result.approvals.push(requestId);
    } catch {
      // best-effort。
    }
  }
  return result;
}

async function listApprovalNames(stateRoot: string): Promise<string[]> {
  try {
    return await readdir(approvalsDir(stateRoot));
  } catch {
    return [];
  }
}
