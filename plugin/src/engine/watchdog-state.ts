/**
 * v0.9.2（A2/A4-c，方案 §二 组A）：**看门狗状态真源**（`.crosschat/capacity/watchdog-state.json`）。
 *
 * 为什么必须有落盘状态：看门狗是 lead MCP server 进程内的定时器——进程死亡后内存里的
 * 「已告警过」标记随之消失，重启后的新一轮会把**同一次死亡**再告警一次（惊动 lead 的
 * 噪音）。A2 的硬口径「仅 alive→dead 迁移发一次」因此以本文件为真源：每轮扫完把成员
 * 活性快照写回，下一轮（哪怕换了进程）读到的都是「已知 dead」，不再发。
 *
 * 同文件还承担 A4-c 的 **limbo 告警节流**（(messageId, 轮次)）：per-spawn 生命周期
 * 监视器（engine/wake.ts）与看门狗清扫（engine/watchdog.ts）是两个独立进程面，都可能
 * 对同一条消息降级；轮次键 = 该消息**本次盖章**的 deliveredAt——同一 (messageId,
 * stampedAt) 只告警一次，重新盖章（新一轮投递）才重新告警。多条降级在各自面内合并成
 * 一条 urgent 告知（不按条轰炸 lead 邮箱）。
 *
 * 纪律（与 capacity/wake-deferred.json 同族）：
 * - 位置在 capacity/ 目录（方案原文指定），与容量采样缓存同目录、同写法（原子整文件）；
 * - 损坏/缺字段 → 按「无历史」处理并重写（观测面永不因状态文件坏掉而停止工作）；
 * - 一切写失败吞掉（best-effort）：看门狗与告警都不能被台账 IO 阻断。
 *
 * @module engine/watchdog-state
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { capacityCacheFile } from '../core/capacity.js';
import { writeFileAtomic } from '../core/atomic.js';

/** 状态文件版本（形状演进时的判别位；不匹配即按无历史重写）。 */
export const WATCHDOG_STATE_VERSION = 1;

/** limbo 告警记录的保留窗（ms）——超过即从台账 prune（台账只用于节流，不是历史账）。 */
export const LIMBO_ALERT_RETENTION_MS = 24 * 60 * 60_000;

/** limbo 告警台账容量上限（防状态文件无界增长；超出按 alertedAt 丢最旧）。 */
export const LIMBO_ALERT_MAX_ENTRIES = 1024;

/** 一名成员的活性快照（看门狗每轮刷新）。 */
export interface WatchdogMemberState {
  /** 上一轮判定：`alive`（live / heartbeat-stale / no-record 都算活着）∨ `dead`（pid-dead 硬证据）。 */
  state: 'alive' | 'dead';
  /** 判定时刻（epoch ms）。 */
  at: number;
  /** 上一轮的 memberLiveness 原值（审计/诊断）。 */
  liveness?: string;
  /** dead 时的证据短语（process-dead）。 */
  evidence?: string;
}

/** 一条 limbo 告警节流记录。 */
export interface LimboAlertRecord {
  /** 轮次键：该消息本次盖章的 deliveredAt（重新盖章 = 新一轮，可再告警）。 */
  stampedAt: number;
  /** 告警时刻（epoch ms）。 */
  at: number;
}

/** 一个唤醒子在途 nonce 的告警记录（A2 的「在途 nonce 生命周期」只报一次）。 */
export interface WatchdogNonceRecord {
  /** 首次告警时刻（epoch ms）。 */
  at: number;
}

/** 看门狗状态文件形状。 */
export interface WatchdogState {
  version: number;
  /** 成员键 → 活性快照。 */
  members: Record<string, WatchdogMemberState>;
  /** messageId → limbo 告警记录（A4-c 节流）。 */
  limbo: Record<string, LimboAlertRecord>;
  /** nonce 摘要 → 在途唤醒子的孤儿化告警记录（A2，只报一次）。 */
  nonces: Record<string, WatchdogNonceRecord>;
}

/** 空状态（无文件/损坏/版本不匹配时）。 */
export function emptyWatchdogState(): WatchdogState {
  return { version: WATCHDOG_STATE_VERSION, members: {}, limbo: {}, nonces: {} };
}

/**
 * 状态文件路径：`<stateRoot>/capacity/watchdog-state.json`。
 *
 * 与 capacity/wake-deferred.json（engine/wake.ts wakeDeferralFile）同一构造法——
 * capacityCacheFile 是 capacity/ 目录的既有锚点，此处不新增 paths.ts 构建器
 * （paths.ts 是路径单一真源，本模块只做目录内派生）。
 */
export function watchdogStateFile(stateRoot: string): string {
  return join(dirname(capacityCacheFile(stateRoot)), 'watchdog-state.json');
}

/**
 * 读状态（损坏/缺字段/版本不匹配 → 空状态）。
 * 永不抛：台账读失败只影响「是否重复告警」的保守方向（按无历史重来），不阻断扫描。
 */
export async function readWatchdogState(stateRoot: string): Promise<WatchdogState> {
  try {
    const parsed = JSON.parse(await readFile(watchdogStateFile(stateRoot), 'utf8')) as Record<string, unknown>;
    if (parsed['version'] !== WATCHDOG_STATE_VERSION) return emptyWatchdogState();
    const members = isRecordOf(parsed['members']) ? parsed['members'] as Record<string, WatchdogMemberState> : {};
    const limbo = isRecordOf(parsed['limbo']) ? parsed['limbo'] as Record<string, LimboAlertRecord> : {};
    const nonces = isRecordOf(parsed['nonces']) ? parsed['nonces'] as Record<string, WatchdogNonceRecord> : {};
    return { version: WATCHDOG_STATE_VERSION, members, limbo, nonces };
  } catch {
    return emptyWatchdogState();
  }
}

function isRecordOf(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 写状态（原子整文件；失败吞掉——best-effort 台账）。
 * 顺手 prune：limbo 台账按保留窗与容量上限丢旧（节流台账不是历史账）。
 */
export async function writeWatchdogState(stateRoot: string, state: WatchdogState): Promise<void> {
  pruneLimboAlerts(state);
  const file = watchdogStateFile(stateRoot);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* best-effort：状态写失败不阻断告警本身（最坏后果是同一次死亡可能再告警一次） */
  }
}

/** limbo 台账 prune（保留窗外 + 超容量最旧者先丢）。 */
export function pruneLimboAlerts(state: WatchdogState, now: number = Date.now()): void {
  const entries = Object.entries(state.limbo)
    .filter(([, record]) => typeof record?.at === 'number' && now - record.at < LIMBO_ALERT_RETENTION_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, LIMBO_ALERT_MAX_ENTRIES);
  state.limbo = Object.fromEntries(entries);
}

/**
 * A4-c：该 (messageId, 轮次) 是否**已告警过**（true = 本次不得再告警）。
 *
 * 轮次键 = stampedAt（消息本次盖章的 deliveredAt）：同一轮次里 per-spawn 监视器与看门狗
 * （或两把锁竞态的两个扫描面）只允许一条告警；消息被重新盖章（新一轮投递）后
 * stampedAt 变了 → 视为新一轮，允许再告警（那是新的失效，不是重复惊动）。
 *
 * `stampedAt` 取不到（锁外预读失败）→ 返回 false：**抑制需要正向证据**（"这一轮已经
 * 报过了"），没有轮次键就无从证明，此时宁可多发一条也不漏报（降级本身自销，重复告警
 * 的实际概率极低）。
 */
export function limboAlertAlreadySent(
  state: WatchdogState,
  messageId: string,
  stampedAt: number | undefined,
): boolean {
  if (stampedAt === undefined || !Number.isFinite(stampedAt)) return false;
  const record = state.limbo[messageId];
  if (record === undefined) return false;
  return record.stampedAt === stampedAt;
}

/** A4-c：登记一次 limbo 告警（(messageId, 轮次) → 时刻）。 */
export function markLimboAlertSent(
  state: WatchdogState,
  messageId: string,
  stampedAt: number | undefined,
  now: number = Date.now(),
): void {
  state.limbo[messageId] = { stampedAt: stampedAt ?? 0, at: now };
}

/** A2：该 nonce（摘要）的孤儿化告警是否已发过（只报一次）。 */
export function nonceOrphanAlreadySent(state: WatchdogState, nonceDigest: string): boolean {
  return state.nonces[nonceDigest] !== undefined;
}

/** A2：登记一次在途 nonce 孤儿化告警。 */
export function markNonceOrphanSent(state: WatchdogState, nonceDigest: string, now: number = Date.now()): void {
  state.nonces[nonceDigest] = { at: now };
}
