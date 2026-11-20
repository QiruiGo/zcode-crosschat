/**
 * v0.9.3（A4，方案 §一 组A）：**needs-continuation 台账**（`.crosschat/capacity/continuation-state.json`）。
 *
 * 为什么必须有落盘状态：A4 的判据是「成员有开放 in_progress 任务 ∧ 其 liveness=idle
 * 持续 ≥T」——「持续」与「一条」两个语义都需要跨轮记忆：
 * - **持续**：判据输入是每轮现算的投影（会话记录 + 任务板），单轮看不到「idle 了多久」，
 *   必须把「本轮首次观察到该状态」的时刻落盘（会话记录缺 livenessTs 时的兜底起点）；
 * - **一条**：同一 episode 只通知 lead 一次——与 v0.9.2 看门狗的「同一死亡只发一次」
 *   同款口径，内存标记随 MCP server 进程死亡消失，重启后会重复惊动 lead。
 *
 * 状态变化重置：成员恢复 running（或任务离开 in_progress）⇒ 台账条目删除，下一次
 * idle episode 从零计时、可再通知一次（方案原文「状态变化才重置」）。
 *
 * 纪律与 engine/watchdog-state.ts 完全同族：
 * - 位置在 capacity/ 目录（与 watchdog-state.json / wake-deferred.json 同目录同写法）；
 * - 损坏/缺字段/版本不匹配 → 按「无历史」处理并重写（观测面永不因状态文件坏掉而停）；
 * - 一切写失败吞掉（best-effort）：告警链不能被台账 IO 阻断；
 * - 台账只用于节流，不是历史账——按保留窗 prune（条目有界）。
 *
 * 为什么新开一本而不并进 watchdog-state.json：本文件是 v0.9.3 组A 的新增真源，
 * 与看门狗台账（成员活性/limbo/nonce 三类节流）字段形状与生命周期都不同；分开后
 * 任一本损坏/演进互不影响（watchdog-state 的 version 判别位同款思路）。
 *
 * @module engine/continuation-state
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { capacityCacheFile } from '../core/capacity.js';
import { writeFileAtomic } from '../core/atomic.js';

/** 状态文件版本（形状演进时的判别位；不匹配即按无历史重写）。 */
export const CONTINUATION_STATE_VERSION = 1;

/** 台账条目保留窗（ms）——超过即 prune（只用于节流，不是历史账）。 */
export const CONTINUATION_RETENTION_MS = 24 * 60 * 60_000;

/** 台账容量上限（防状态文件无界增长；超出按 since 丢最旧）。 */
export const CONTINUATION_MAX_ENTRIES = 256;

/** 一名成员的待续跑 episode 记录。 */
export interface ContinuationMemberRecord {
  /** 本轮 idle episode 的起点（epoch ms）：可信的会话记录 livenessTs，缺省看门狗首见时刻。 */
  since: number;
  /** 本 episode 已通知 lead 的时刻（undefined = 尚未通知——「一条」的闸）。 */
  notifiedAt?: number;
  /** 触发判据的开放 in_progress 任务 id（审计/文案用）。 */
  taskId?: string;
}

/** 状态文件形状。 */
export interface ContinuationState {
  version: number;
  /** 成员键 → 待续跑 episode 记录。 */
  members: Record<string, ContinuationMemberRecord>;
}

/** 空状态（无文件/损坏/版本不匹配时）。 */
export function emptyContinuationState(): ContinuationState {
  return { version: CONTINUATION_STATE_VERSION, members: {} };
}

/**
 * 状态文件路径：`<stateRoot>/capacity/continuation-state.json`。
 * 与 capacityCacheFile / watchdog-state.ts 同一构造法（capacity/ 目录的既有锚点派生，
 * 不新增 paths.ts 构建器——paths.ts 是路径单一真源）。
 */
export function continuationStateFile(stateRoot: string): string {
  return join(dirname(capacityCacheFile(stateRoot)), 'continuation-state.json');
}

/**
 * 读状态（损坏/缺字段/版本不匹配 → 空状态）。
 * 永不抛：台账读失败只影响「是否重复通知」的保守方向（按无历史重来），不阻断扫描。
 */
export async function readContinuationState(stateRoot: string): Promise<ContinuationState> {
  try {
    const parsed = JSON.parse(await readFile(continuationStateFile(stateRoot), 'utf8')) as Record<string, unknown>;
    if (parsed['version'] !== CONTINUATION_STATE_VERSION) return emptyContinuationState();
    const members = parsed['members'];
    if (typeof members !== 'object' || members === null || Array.isArray(members)) return emptyContinuationState();
    return { version: CONTINUATION_STATE_VERSION, members: members as Record<string, ContinuationMemberRecord> };
  } catch {
    return emptyContinuationState();
  }
}

/**
 * 写状态（原子整文件；失败吞掉——best-effort 台账）。
 * 顺手 prune：保留窗外 + 超容量最旧者先丢（节流台账不是历史账）。
 */
export async function writeContinuationState(stateRoot: string, state: ContinuationState): Promise<void> {
  pruneContinuationState(state);
  const file = continuationStateFile(stateRoot);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* best-effort：状态写失败不阻断告警本身（最坏后果是同一 episode 可能再通知一次） */
  }
}

/** 台账 prune（保留窗外 + 超容量最旧者先丢）。 */
export function pruneContinuationState(state: ContinuationState, now: number = Date.now()): void {
  const entries = Object.entries(state.members)
    .filter(([, record]) => typeof record?.since === 'number' && now - record.since < CONTINUATION_RETENTION_MS)
    .sort((a, b) => b[1].since - a[1].since)
    .slice(0, CONTINUATION_MAX_ENTRIES);
  state.members = Object.fromEntries(entries);
}
