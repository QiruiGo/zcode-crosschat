/**
 * M1 core-store 扩展（v0.5.3，安全对-5 三番战 a10 修复）：邮箱行完整性——
 * 哈希链 sidecar + 读取面校验（篡改检测 + 告警）。
 *
 * adj052 实测（a10）：worker 完成任务 → 回执入 lead 邮箱；直接编辑
 * `inbox/<agent>.jsonl` 改写回执 content 后 `xc_mail_read` 原样提供被篡改文本，
 * 无任何告警——对照：任务板被回滚时 xc_claim 有 rollback_conflict 硬拒
 * （mailbox.ts staleCompletedReceiptTaskIds / tools.ts 回滚矛盾闸），邮箱侧
 * 此前完全没有对应的检测面。
 *
 * 机制（与既有写入口径对齐的最小侵入设计）：
 * - 每封邮件落箱（appendMailbox）时同步追加一条链记录到 sidecar
 *   `<agent>.jsonl.int`：`{v, id, seq, prev, h}`（后缀避开 `.jsonl`：teamstate
 *   的邮箱残迹探测按 `*.jsonl` 计数，sidecar 不得混入——FI-5 回归口径）；
 * - `h = sha256(prev + "\n" + 固定字段白名单 JSON)`——白名单只含**不可变字段**
 *   （id/from/to/ts/content/taskId/attemptId/sourceTask 系/origin 系）；readAt/
 *   deliveredAt/discardedAt/deliveryClaimedAt 等原地变异字段不参与（合法的
 *   acknowledge/discard 变异不会误报）；
 * - 链：首条 prev=GENESIS，其后 prev=上一条 h。sidecar 行删除/重排 → 后继记录
 *   chain-broken；正文篡改 → content-hash-mismatch；同 id 双记录 → duplicate-record；
 * - 校验面：xc_mail_read / xc_check_inbox（两个模型可见的读取口）。判定为
 *   tampered 的消息照常返回但携带显著 WARNING + 机器可读载荷 + engine.jsonl
 *   审计 `{event:"mailbox-integrity-violation"}`（检测+告警口径，与
 *   rollback_conflict 同级暴露、不阻断只读分页）；sidecar 无记录的旧件
 *   （v0.5.2 及之前的存量邮箱）→ unverified，静默兼容、不告警（升级不回溯）。
 *
 * 威胁模型声明（README 限制 5/12 口径）：同机进程本就可以改盘上任意文件
 * （含 sidecar 与密钥），哈希链不承诺对抗全权攻击者——承诺的是：磁盘篡改
 * （手工编辑、陈旧备份回写、部分还原）在读取面**必然留下机器可见的告警与
 * 审计**，攻击者必须同步伪造整条链才能隐身，显著高于 rollback_conflict 前
 * 的「零检测」基线。
 *
 * 锁纪律：链头读取+双追加（邮箱行 + 链记录）必须原子，否则两个并发 append
 * 拿到同一 prev 会分叉链（每读必报 chain-broken 假警）。专用完整性锁
 * （进程内 + 跨进程文件锁）串行化；锁序恒为「registry → team → mail-integrity」
 * ——本锁内部不再取任何其他锁，无死锁环。
 *
 * @module core/mailintegrity
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { appendJsonl, readJsonl } from './jsonl.js';
import { withFileLock, withProcessLock } from './lock.js';
import { inboxFile, inboxIntegrityFile } from './paths.js';
import { sanitizeKey } from './sanitize.js';
import type { TeamMessage } from './types.js';

/** 链 genesis 值（64×"0"，与 sha256 hex 等宽便于目检）。 */
export const MAIL_CHAIN_GENESIS = '0'.repeat(64);

/** 参与完整性哈希的不可变字段白名单（易变字段见模块头注释）。 */
const HASHED_FIELDS = [
  'id',
  'from',
  'to',
  'ts',
  'content',
  'taskId',
  'attemptId',
  'sourceTaskId',
  'sourceAttemptId',
  'sourceTaskStatus',
  'origin',
  'originSessionId',
] as const;

/** One sidecar chain record. */
export interface MailIntegrityRecord {
  v: 1;
  id: string;
  seq: number;
  prev: string;
  h: string;
}

/** One detected integrity violation (message id + machine-readable reason). */
export interface MailIntegrityViolation {
  id: string;
  reason: 'content-hash-mismatch' | 'chain-broken' | 'duplicate-record';
}

/** Verify result: violations (tamper) + legacy/missing-record ids (no alarm). */
export interface MailIntegrityReport {
  violations: MailIntegrityViolation[];
  unverifiedIds: string[];
  recordCount: number;
}

function isMailIntegrityRecord(value: unknown): value is MailIntegrityRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record['v'] === 1
    && typeof record['id'] === 'string' && record['id'] !== ''
    && typeof record['seq'] === 'number' && Number.isFinite(record['seq'])
    && typeof record['prev'] === 'string'
    && typeof record['h'] === 'string';
}

/** Canonical hash input: fixed field whitelist in fixed order (module header). */
export function mailLineHashInput(message: TeamMessage): string {
  const picked: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) {
    const value = (message as unknown as Record<string, unknown>)[field];
    if (value !== undefined) picked[field] = value;
  }
  return JSON.stringify(picked);
}

/** Chain step: sha256 over `prev + "\n" + canonical input`. */
export function mailLineHash(prevHash: string, message: TeamMessage): string {
  return createHash('sha256').update(`${prevHash}\n${mailLineHashInput(message)}`, 'utf8').digest('hex');
}

/** Sidecar path for one mailbox. */
export function mailboxIntegrityPath(stateRoot: string, teamId: string, agentKey: string): string {
  return inboxIntegrityFile(stateRoot, teamId, sanitizeKey(agentKey));
}

/** Mailbox path (re-exported here so callers need one import for the pair). */
export function mailboxLinePath(stateRoot: string, teamId: string, agentKey: string): string {
  return inboxFile(stateRoot, teamId, sanitizeKey(agentKey));
}

/** 专用完整性锁（进程内 + 跨进程）：同一邮箱的所有 append 串行（模块头锁纪律）。 */
function mailIntegrityLockNames(stateRoot: string, teamId: string, agentKey: string): { processKey: string; file: string } {
  const abs = resolve(stateRoot);
  const key = sanitizeKey(agentKey);
  // 进程内键沿用 teamLockNames 的拼写纪律（team:<abs>:<teamId>）；
  // 文件锁名为裸名（withFileLock 自己拼 locks/<name>.lock），同款 digest 纪律不需要——
  // agentKey 已是 sanitizeKey 产物（文件名安全）。
  return {
    processKey: `mail-integrity:${abs}:${teamId}:${key}`,
    file: `mail-int-${teamId}-${key}`,
  };
}

/**
 * Append one chain record for `message` (caller: appendMailbox). The whole
 * head-read + mailbox-append + record-append critical section is serialized by
 * the dedicated integrity lock — a forked chain would false-alarm every read.
 */
export async function appendMailIntegrityRecord(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  message: TeamMessage,
  appendLine: () => Promise<void>,
): Promise<void> {
  const names = mailIntegrityLockNames(stateRoot, teamId, agentKey);
  await withProcessLock(names.processKey, () =>
    withFileLock(stateRoot, names.file, async () => {
      const sidecar = mailboxIntegrityPath(stateRoot, teamId, agentKey);
      const records = await readJsonl<MailIntegrityRecord>(sidecar, isMailIntegrityRecord);
      const last = records.at(-1);
      const prev = last === undefined ? MAIL_CHAIN_GENESIS : last.h;
      const seq = last === undefined ? 0 : last.seq + 1;
      const record: MailIntegrityRecord = { v: 1, id: message.id, seq, prev, h: mailLineHash(prev, message) };
      await appendLine();
      await appendJsonl(sidecar, [JSON.stringify(record)]);
    }));
}

/** Read one mailbox's sidecar records (tolerant: guard-failing lines skipped). */
export async function readMailIntegrityRecords(stateRoot: string, teamId: string, agentKey: string): Promise<MailIntegrityRecord[]> {
  return readJsonl<MailIntegrityRecord>(mailboxIntegrityPath(stateRoot, teamId, agentKey), isMailIntegrityRecord);
}

/**
 * Verify a set of mailbox messages against the sidecar chain (pure-ish read;
 * no locks — tolerant jsonl read, atomic appends keep records whole-line).
 * - content tamper → `content-hash-mismatch`（哈希按记录里锁定的 prev 重算）；
 * - sidecar 行删除/重排 → 后继记录 `chain-broken`；
 * - 同一消息双记录 → `duplicate-record`（后到的那条）；
 * - 无记录的存量/落链失败的邮件 → unverifiedIds（升级兼容，不告警）。
 * 邮箱行被整行删除（记录仍在）→ 记录成孤儿、不告警（邮箱无合法删行路径，
 * 该形态属盘面重建而非回执篡改——orphanTaskIds/回执矛盾闸另有检测面）。
 */
export async function verifyMailboxIntegrity(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messages: readonly TeamMessage[],
): Promise<MailIntegrityReport> {
  const records = await readMailIntegrityRecords(stateRoot, teamId, agentKey);
  const violations: MailIntegrityViolation[] = [];
  const unverifiedIds: string[] = [];
  if (records.length === 0) {
    return { violations, unverifiedIds: messages.map((message) => message.id), recordCount: 0 };
  }
  const byId = new Map(messages.map((message) => [message.id, message]));
  const covered = new Set<string>();
  let prevHash = MAIL_CHAIN_GENESIS;
  for (const record of records) {
    if (covered.has(record.id)) {
      violations.push({ id: record.id, reason: 'duplicate-record' });
      continue;
    }
    covered.add(record.id);
    if (record.prev !== prevHash) violations.push({ id: record.id, reason: 'chain-broken' });
    const message = byId.get(record.id);
    if (message !== undefined && mailLineHash(record.prev, message) !== record.h) {
      violations.push({ id: record.id, reason: 'content-hash-mismatch' });
    }
    prevHash = record.h;
  }
  for (const message of messages) {
    if (!covered.has(message.id)) unverifiedIds.push(message.id);
  }
  return { violations, unverifiedIds, recordCount: records.length };
}
