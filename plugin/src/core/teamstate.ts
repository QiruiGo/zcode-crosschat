/**
 * M1 core-store: team.json read/write + the task state machine + attempt
 * capability tokens.
 *
 * Ports (dsh-agent-teams-0.1.29/lib/state.js):
 * - readTeam/writeTeam: state.js:203-254 (read-side coerce, ENOENT -> undefined)
 * - TASK_TRANSITIONS/transitionError live in types.ts (single definition point)
 * - activateTaskAttempt/beginTaskAttempt/clearAttemptResult: state.js:138-162
 * - unsatisfiedDependencies: state.js:107-110
 *
 * Lock discipline (DESIGN.md §2.7-4): every caller mutates team.json inside
 * withTeamLock and RE-READS from disk under the lock; this module never locks.
 *
 * @module core/teamstate
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { appendMailbox, createMessage } from './mailbox.js';
import { inboxDir, inboxFile, snapshotFile, teamBackupFile, teamCorruptFile, teamDir, teamFile } from './paths.js';
import { sanitizeKey } from './sanitize.js';
import {
  OPEN_TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_PRIORITY_RANK,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  transitionError,
  coerceTeamState,
  type EvidenceItem,
  type MemberRole,
  type Task,
  type TaskHistoryEntry,
  type TaskPriority,
  type TaskStatus,
  type TeamMember,
  type TeamMessage,
  type TeamState,
} from './types.js';
import { logEngineEvent } from './log.js';
import { withTeamLock } from './lock.js';
import { readNames } from './registry.js';

export { DEFAULT_TEAM_ID } from './types.js';

/**
 * v0.5.1（故障注-1 修复）：解析并校验一段 team.json 文本（主文件或备份共用）。
 * @returns 解析缺陷描述；undefined 表示成功且 `state` 可用。
 */
function parseTeamText(raw: string, teamId: string): { state?: TeamState; defect?: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { defect: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = coerceTeamState(value, teamId);
  if (!parsed.ok) return { defect: parsed.defect };
  return { state: parsed.state };
}

// ---------------------------------------------------------------------------
// v0.5.2（故障注-1 二番战修复）：备份恢复的进程内披露台账 + 回滚矛盾探测。
//
// 陈旧 .bak 自愈会把已 completed 的任务静默退回 pending（可被重新认领重复执行），
// 而恢复事件此前只落 engine.jsonl，工具面零提示。两层披露：
// 1. 恢复时刻：本台账记录最近一次备份恢复（writeTeam 成功落盘即清除——真源已被
//    重写治好），`lastTeamRecoveryNotice`/`teamRecoveryWarning` 供工具面披露。
// 2. 持续矛盾：回退后的任务板与邮箱里已发出的 completed 回执矛盾
//    （`completedReceiptTaskIds` 纯探测），只要矛盾存在（含 server 重启后）就
//    可被 xc_overview / xc_claim 检出，不依赖台账内存。
// 回执链只用于**检测与披露**，不改写任务状态（回执内容是协作消息，不能当真源
// 写回——伪造回执不得变成伪造完成态）。
// ---------------------------------------------------------------------------

/** 一次备份恢复的披露记录（进程内；writeTeam 落盘成功即清除）。 */
export interface TeamRecoveryNotice {
  teamId: string;
  /** 主文件缺陷描述。 */
  defect: string;
  /** 自愈使用的备份文件路径。 */
  backup: string;
  at: number;
  /**
   * 回滚矛盾探测：恢复态里非终态（pending/claimed/in_progress）但成员邮箱已持有
   * 其 completed 回执的任务 id。非空 = 这次恢复把已完成工作退回了未完成态。
   */
  rolledBackTaskIds: string[];
}

const recoveryNotices = new Map<string, TeamRecoveryNotice>();

function recoveryNoticeKey(stateRoot: string, teamId: string): string {
  return `${resolve(stateRoot)}\u0000${teamId}`;
}

/** 最近一次备份恢复记录（undefined = 无未治好的恢复残留）。 */
export function lastTeamRecoveryNotice(stateRoot: string, teamId: string): TeamRecoveryNotice | undefined {
  return recoveryNotices.get(recoveryNoticeKey(stateRoot, teamId));
}

/**
 * v0.5.2（故障注-1 修复）：备份恢复的工具面告警行（undefined = 无）。
 * 有回滚矛盾时明示「已完成工作被退回」，无矛盾时仅提示验证任务板。
 */
export function teamRecoveryWarning(stateRoot: string, teamId: string): string | undefined {
  const notice = lastTeamRecoveryNotice(stateRoot, teamId);
  if (notice === undefined) return undefined;
  if (notice.rolledBackTaskIds.length > 0) {
    return (
      `WARNING team state was recovered from backup (${notice.defect}) and that backup appears STALE: `
      + `task(s) ${notice.rolledBackTaskIds.join(", ")} have completed receipt(s) on file (already delivered to `
      + `the dispatcher) but came back as unfinished — completed work was rolled back. `
      + `xc_claim on those tasks is refused until the state is re-persisted (any dispatch/claim write heals team.json).`
    );
  }
  return (
    `WARNING team state was recovered from the last-known-good backup (${notice.defect}); `
    + 'verify the task board matches what members actually did.'
  );
}

/**
 * v0.5.2（故障注-1 修复）：回滚矛盾探测——哪些任务在恢复态里非终态，但成员邮箱
 * 已持有其 completed 回执（sourceTaskId + sourceTaskStatus=completed 的信封）。
 *
 * 本地直读邮箱 JSONL（容错：坏行跳过），**不 import mailbox.ts**（那边 import
 * 本模块，反向依赖会成环）。回执只需 from/to/字段形状判断，够用。
 */
async function completedReceiptTaskIds(
  stateRoot: string,
  teamId: string,
  memberKeys: readonly string[],
  tasks: readonly Task[],
): Promise<string[]> {
  const open = new Set(
    tasks
      .filter((task) => !TERMINAL_TASK_STATUSES.includes(task.status))
      .map((task) => task.id),
  );
  if (open.size === 0) return [];
  const found: string[] = [];
  for (const key of memberKeys) {
    let raw: string;
    try {
      raw = await readFile(inboxFile(stateRoot, teamId, sanitizeKey(key)), 'utf8');
    } catch {
      continue; // 无邮箱/读失败 → 该成员无可回执证据
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof value !== 'object' || value === null) continue;
      const record = value as Record<string, unknown>;
      const sourceTaskId = record['sourceTaskId'];
      if (typeof sourceTaskId === 'string'
        && record['sourceTaskStatus'] === 'completed'
        && open.has(sourceTaskId)
        && !found.includes(sourceTaskId)) {
        found.push(sourceTaskId);
      }
    }
  }
  return found;
}

/**
 * v0.5.1（故障注-1 修复）：把损坏真源原地保全为 `team.json.corrupt`
 * （ forensic：后续 writeTeam 会整文件替换，残损字节不留底即永久丢失）。
 * 尽力而为：保全失败不影响主流程（审计里已有 defect）。
 */
async function preserveCorruptTeamFile(stateRoot: string, teamId: string, raw: string): Promise<void> {
  try {
    await writeFile(teamCorruptFile(stateRoot, teamId), raw, 'utf8');
  } catch {
    // best-effort
  }
}

/**
 * Read one team record; `undefined` when the team does not exist yet.
 *
 * v0.5.1（故障注-1 修复）：真源不可解析时不再裸抛 JSON 错误使全队工具持续
 * internal——先尝试从 last-known-good 镜像 `team.json.bak` 自愈（内存恢复 +
 * 审计 + 残损字节保全），无可用备份则抛带文件路径与修复指引的显式诊断
 * （fail-closed 语义不变，恢复手段从「人工读 JSON 报错猜」变成「照指引修文件」）。
 * 本函数从不写主文件：持锁的变更路径随后 writeTeam 自然把磁盘治好。
 */
export async function readTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  const file = teamFile(stateRoot, teamId);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const primary = parseTeamText(raw, teamId);
  if (primary.state !== undefined) return primary.state;

  // 真源损坏：尝试 last-known-good 镜像自愈。
  const backupPath = teamBackupFile(stateRoot, teamId);
  let backupRaw: string | undefined;
  try {
    backupRaw = await readFile(backupPath, 'utf8');
  } catch {
    backupRaw = undefined; // 无备份（旧版本从未写过 / 备份同样丢失）
  }
  if (backupRaw !== undefined) {
    const backup = parseTeamText(backupRaw, teamId);
    if (backup.state !== undefined) {
      await preserveCorruptTeamFile(stateRoot, teamId, raw);
      // v0.5.2（故障注-1 二番战修复）：恢复态与邮箱回执链对账——已完成任务的
      // completed 回执已在派发方邮箱落盘，而恢复态把任务退回未完成 = 静默状态
      // 回归。记录进披露台账（工具面经 teamRecoveryWarning 披露），审计附回滚
      // 明细；台账由下一次 writeTeam（任意变更工具落盘治好真源）清除。
      const rolledBackTaskIds = await completedReceiptTaskIds(
        stateRoot,
        teamId,
        backup.state.members.map((member) => member.key),
        backup.state.tasks,
      );
      recoveryNotices.set(recoveryNoticeKey(stateRoot, teamId), {
        teamId,
        defect: primary.defect ?? 'unparseable',
        backup: backupPath,
        at: Date.now(),
        rolledBackTaskIds,
      });
      await logEngineEvent(stateRoot, {
        event: 'team-state-recovered',
        teamId,
        defect: primary.defect,
        backup: backupPath,
        ...(rolledBackTaskIds.length > 0
          ? { rolledBackTaskIds, rollbackConflict: true }
          : {}),
      });
      return backup.state;
    }
  }
  await logEngineEvent(stateRoot, {
    event: 'team-state-corrupt',
    teamId,
    defect: primary.defect,
    backupUsable: false,
  });
  throw new Error(
    `team state file "${file}" is corrupt (${primary.defect}); ` +
    `no usable backup at "${backupPath}" — restore it manually or delete the team directory to reset` +
    (primary.defect === 'duplicate member keys'
      ? `, or run xc_doctor({action:"repair-team"}) to dedupe the member keys in place`
      : ''),
  );
}

// ---------------------------------------------------------------------------
// v0.8.1（29-v080 M01 修复）：中毒 team.json 的工具面自愈（双重复员键）。
//
// M01 的持久伤害：xc_identify 改名把 roster 成员键换成**他人已占**的花名 →
// team.json 出现 duplicate member keys（readTeam 拒读）→ .bak 被同一份坏内容
// 镜像中毒 → 全队 team-axis 工具（identify/overview/handoff/claim/…）持续
// internal，人工修复只能删/改文件。v0.8.1 起改名路径不再能制造这个形态
// （两轴前置校验，tools-identify.ts）；本函数兜住**已经中毒**的存量状态：
//
// 修复判据（确定性，不猜）：
// - 只修 `duplicate member keys` 这一种缺陷——JSON 本身合法，仅是 members
//   数组同键多行；其余缺陷（非 JSON/缺字段/坏任务记录）一律不猜，交还原人工
//   恢复路径（fail-closed 不变）。
// - 同键多行保留哪行：names.json（name→sid 权威索引）绑定的那行；无绑定或无
//   匹配时保留首行并在披露里注明用了兜底规则。M01 的残留行正是「改名方那行」
//   （其 sid 在 names.json 里没有该花名的绑定——改名路径的冲突保护就是不覆盖
//   别人的索引行），故权威索引恰好指向原持有者。
// - 残损字节先保全到 `team.json.corrupt`（与 v0.5.1 备份恢复同纪律），再
//   writeTeam 整文件替换——真源与 .bak 一并治好。
// - 全程 team 锁内 + 锁内重读重判（并发安全；别的进程可能刚修好）。
// ---------------------------------------------------------------------------

/** 一次 team.json 自愈的结果（工具面原样披露）。 */
export interface TeamRepairResult {
  /** true = 真源已被本调用修好并落盘。 */
  repaired: boolean;
  /** not-corrupt = 真源本来就健康（幂等调用）；duplicate-member-keys = 已修；unrepairable = 缺陷不在可修范围。 */
  reason: 'repaired' | 'not-corrupt' | 'unrepairable';
  /** unrepairable 时的缺陷描述（parseTeamText 口径）。 */
  defect?: string;
  /** 每个重复键保留/丢弃的行（审计与披露用）。 */
  kept: Array<{ key: string; sessionId: string }>;
  dropped: Array<{ key: string; sessionId: string }>;
  /** 兜底规则（names.json 无权威绑定）命中的键——披露用。 */
  fallbackKeys: string[];
  /** 残损字节保全路径（team.json.corrupt）。 */
  preserved?: string;
}

/**
 * 自愈 duplicate member keys 中毒的 team.json（工具面入口：xc_doctor 的
 * `action:"repair-team"`）。幂等：健康状态调用 = no-op（reason:'not-corrupt'）。
 * 缺陷不在可修范围时不写任何字节，返回 reason:'unrepairable' + defect。
 */
export async function repairTeamState(
  stateRoot: string,
  teamId: string,
  now: number = Date.now(),
): Promise<TeamRepairResult> {
  const file = teamFile(stateRoot, teamId);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { repaired: false, reason: 'not-corrupt', kept: [], dropped: [], fallbackKeys: [] };
    }
    throw error;
  }
  const primary = parseTeamText(raw, teamId);
  if (primary.state !== undefined) {
    return { repaired: false, reason: 'not-corrupt', kept: [], dropped: [], fallbackKeys: [] };
  }
  if (primary.defect !== 'duplicate member keys') {
    await logEngineEvent(stateRoot, { event: 'team-state-repair-refused', teamId, defect: primary.defect });
    return { repaired: false, reason: 'unrepairable', defect: primary.defect, kept: [], dropped: [], fallbackKeys: [] };
  }

  return await withTeamLock(stateRoot, teamId, async (): Promise<TeamRepairResult> => {
    // 锁内重读重判：等锁期间别的进程可能已修好（或写入了新缺陷）。
    let current: string;
    try {
      current = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { repaired: false, reason: 'not-corrupt', kept: [], dropped: [], fallbackKeys: [] };
      }
      throw error;
    }
    const parsed = parseTeamText(current, teamId);
    if (parsed.state !== undefined) {
      return { repaired: false, reason: 'not-corrupt', kept: [], dropped: [], fallbackKeys: [] };
    }
    if (parsed.defect !== 'duplicate member keys') {
      await logEngineEvent(stateRoot, { event: 'team-state-repair-refused', teamId, defect: parsed.defect });
      return { repaired: false, reason: 'unrepairable', defect: parsed.defect, kept: [], dropped: [], fallbackKeys: [] };
    }
    let value: unknown;
    try {
      value = JSON.parse(current);
    } catch {
      // parseTeamText 已判定缺陷是 duplicate member keys，JSON 必然可解析；防御分支。
      await logEngineEvent(stateRoot, { event: 'team-state-repair-refused', teamId, defect: 'unparseable' });
      return { repaired: false, reason: 'unrepairable', defect: 'unparseable', kept: [], dropped: [], fallbackKeys: [] };
    }
    const membersRaw = (value as { members?: unknown }).members;
    if (!Array.isArray(membersRaw)) {
      await logEngineEvent(stateRoot, { event: 'team-state-repair-refused', teamId, defect: 'members not an array' });
      return { repaired: false, reason: 'unrepairable', defect: 'members not an array', kept: [], dropped: [], fallbackKeys: [] };
    }
    // names.json 权威索引：同键多行时保留它绑定的那行（M01 残留行没有绑定）。
    const names = await readNames(stateRoot);
    const kept: Array<{ key: string; sessionId: string }> = [];
    const dropped: Array<{ key: string; sessionId: string }> = [];
    const fallbackKeys: string[] = [];
    const seen = new Set<string>();
    const deduped: unknown[] = [];
    for (const entry of membersRaw) {
      const key = typeof (entry as { key?: unknown })?.key === 'string' ? (entry as { key: string }).key : undefined;
      const sessionId = typeof (entry as { sessionId?: unknown })?.sessionId === 'string'
        ? (entry as { sessionId: string }).sessionId
        : '';
      if (key === undefined || !seen.has(key)) {
        if (key !== undefined) seen.add(key);
        deduped.push(entry);
        if (key !== undefined) kept.push({ key, sessionId });
        continue;
      }
      // 重复键三选一（确定性，不猜）：
      // ① names.json 绑定指向**先到行** → 丢弃后到行（M01 主形态：改名残留行在索引里
      //    没有绑定——改名路径的冲突保护不覆盖别人的索引行）；
      // ② 绑定指向**后到行** → 保留后到行、丢弃先到行（索引是权威）；
      // ③ 无绑定/绑定指向第三方 → 兜底保留**先到行**（残留行是失败操作的产物，后写），
      //    记 fallbackKeys 披露。
      const bound = names[key]?.sessionId;
      const firstIdx = deduped.findIndex((e) => (e as { key?: unknown }).key === key);
      const first = deduped[firstIdx] as { sessionId?: unknown } | undefined;
      const firstSessionId = typeof first?.sessionId === 'string' ? first.sessionId : '';
      if (bound !== undefined && bound === firstSessionId) {
        dropped.push({ key, sessionId });
        continue;
      }
      if (bound !== undefined && bound === sessionId) {
        dropped.push({ key, sessionId: firstSessionId });
        deduped[firstIdx] = entry;
        const keptIdx = kept.findIndex((k) => k.key === key && k.sessionId === firstSessionId);
        if (keptIdx >= 0) kept[keptIdx] = { key, sessionId };
        continue;
      }
      fallbackKeys.push(key);
      dropped.push({ key, sessionId });
    }
    const repairedValue = { ...(value as Record<string, unknown>), members: deduped };
    const check = coerceTeamState(repairedValue, teamId);
    if (!check.ok) {
      await logEngineEvent(stateRoot, { event: 'team-state-repair-refused', teamId, defect: check.defect });
      return { repaired: false, reason: 'unrepairable', defect: check.defect, kept: [], dropped: [], fallbackKeys: [] };
    }
    await preserveCorruptTeamFile(stateRoot, teamId, current);
    await writeTeam(stateRoot, check.state);
    await logEngineEvent(stateRoot, {
      event: 'team-state-repaired',
      teamId,
      defect: 'duplicate member keys',
      kept,
      dropped,
      ...(fallbackKeys.length > 0 ? { fallbackKeys } : {}),
    });
    return { repaired: true, reason: 'repaired', kept, dropped, fallbackKeys, preserved: teamCorruptFile(stateRoot, teamId) };
  });
}

/**
 * Persist one team record (whole-file atomic write; caller holds the lock).
 * v0.5.1（故障注-1 修复）：成功落盘后把同一内容原子镜像到 `team.json.bak`
 * （last-known-good，真源下次损坏时的自愈源）。镜像失败不影响主写入，
 * 仅尽力记审计。
 */
export async function writeTeam(stateRoot: string, team: TeamState): Promise<void> {
  await mkdir(inboxDir(stateRoot, team.teamId), { recursive: true });
  const content = JSON.stringify(team, null, 2);
  await writeFileAtomic(teamFile(stateRoot, team.teamId), content);
  // v0.5.2（故障注-1 二番战修复）：真源成功落盘 = 备份恢复残留已被治好，
  // 清除该团队的恢复披露台账（xc_overview 的恢复告警随之消失）。
  recoveryNotices.delete(recoveryNoticeKey(stateRoot, team.teamId));
  try {
    await writeFileAtomic(teamBackupFile(stateRoot, team.teamId), content);
  } catch (error) {
    await logEngineEvent(stateRoot, {
      event: 'team-state-backup-failed',
      teamId: team.teamId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Build a fresh initial team record (founder becomes the first member if given).
 *  v0.5.1（故障注-5 修复）：每个新时代生成独立纪元令牌，任务 id 带纪元前缀。 */
export function newTeamState(options: {
  teamId: string;
  name?: string;
  founderKey: string;
  founder?: TeamMember;
  now?: number;
}): TeamState {
  const now = options.now ?? Date.now();
  return {
    teamId: options.teamId,
    name: options.name ?? options.teamId,
    founderKey: options.founderKey,
    phase: 'open',
    // 纪元令牌：8 hex（randomUUID 去连字符取前 8）。新时代的任务 id `<era>-t<n>`
    // 与旧时代残存邮箱信封里的任务 id 结构性不同名，重建后不再撞号。
    era: randomUUID().replaceAll('-', '').slice(0, 8),
    members: options.founder === undefined ? [] : [options.founder],
    tasks: [],
    seq: 0,
    createdAt: now,
  };
}

export interface NewTaskInput {
  title: string;
  prompt: string;
  acceptance?: string;
  dependsOn?: string[];
  /**
   * v0.6.1（红队四番战 安全对-3 修复）：派发时指定的受领成员（sanitized key）。
   * xc_claim 据此校验「只有受领人可认领」（与 xc_report 的 not_assignee 对齐）；
   * 引擎特权重置回池（graph.revokeAttempt）会清除它——回池即共享待领池。
   */
  to?: string;
  /**
   * v0.6（C2）：排序建议优先级；缺省/非法值不落盘（absent = normal，读侧归一）。
   * 影响展示/取单顺序，不做抢占（DESIGN-V0.6.md §3.2）。
   */
  priority?: TaskPriority;
  createdBy: string;
}

/**
 * Allocate the next task id from the team's seq counter.
 * v0.5.1（故障注-5 修复）：带纪元的新时代为 `<era>-t<seq+1>`；旧记录（无 era）
 * 保持 legacy `t<seq+1>` 形态不变。
 */
export function nextTaskId(team: TeamState): string {
  return team.era === undefined ? `t${team.seq + 1}` : `${team.era}-t${team.seq + 1}`;
}

/**
 * Build one new pending task, append it to team.tasks and advance the team
 * seq. Mutates `team` — callers persist via writeTeam afterwards.
 */
export function makeTask(team: TeamState, input: NewTaskInput, now: number = Date.now()): Task {
  // v0.6（C2）：priority 防御性收敛——枚举外值不落盘（absent = normal），与读侧
  // coerceTask 的宽容纪律一致（非法值丢弃，不炸派发）。
  const priority = input.priority !== undefined && TASK_PRIORITIES.includes(input.priority)
    ? input.priority
    : undefined;
  const task: Task = {
    id: nextTaskId(team),
    title: input.title,
    prompt: input.prompt,
    ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
    dependsOn: [...(input.dependsOn ?? [])],
    status: 'pending',
    assignee: null,
    attempt: 0,
    attemptId: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    // v0.7.2（C8-B2 修复）：最后进展时刻落盘（建单即首个进展点；此后每次
    // appendTaskHistory 同步刷新——与 history 末条 ts 保持同值的冗余镜像）。
    lastProgressTs: now,
    result: null,
    error: null,
    evidence: [],
    history: [],
    ...(priority === undefined ? {} : { priority }),
    // v0.6.1（安全对-3 修复）：受领人落盘（claim 侧硬闸的依据；旧记录无此字段）。
    ...(input.to === undefined ? {} : { to: input.to }),
  };
  team.seq += 1;
  team.tasks.push(task);
  return task;
}

export function getTask(team: TeamState, taskId: string): Task | undefined {
  return team.tasks.find((task) => task.id === taskId);
}

/** Ids in `dependencies` that are missing or not completed (port state.js:107-110). */
export function unsatisfiedDependencies(tasks: readonly Task[], dependencies: readonly string[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return dependencies.filter((id) => byId.get(id)?.status !== 'completed');
}

/** Open (claimed/in_progress/blocked——v0.6 C2 起含 blocked 单开槽位) tasks owned by one member. */
export function memberOpenTasks(tasks: readonly Task[], assignee: string): Task[] {
  return tasks.filter((task) => task.assignee === assignee && OPEN_TASK_STATUSES.includes(task.status));
}

// ---------------------------------------------------------------------------
// v0.9.8（D2/V097-07）：**未认领单的回池判据**（assignee 空时按 to 匹配）。
//
// 缺陷形态：xc_dispatch 带 `to` 建单时任务只有受领人预留（task.to）、assignee 仍为
// null（认领才落 assignee）。成员供给失败（state=failed）或停机（removed）后，旧回池
// 判据只看 `task.assignee === key`（memberOpenTasks）——这些**未认领单**不在域内：
// 他人 claim 得 not_assignee（to 硬闸）、失败/停机成员自己无法认领、pending 又不在
// stale 清扫域 → 任务永久搁浅，创建者收不到任何回执（49-v098 方案 D2）。
//
// 修法：回池判据在 assignee 为空时改用 `to` 命中；命中单删除受领人预留（回共享
// 待领池，与 revokeAttempt 的「引擎回池 = shared pending pool」同语义）并通知创建者。
// ---------------------------------------------------------------------------

/**
 * 一名成员名下的**未认领单**（pending ∧ assignee===null ∧ to===key；纯函数）。
 *
 * 与 {@link memberOpenTasks} 正交：后者管「已认领在途」（assignee 命中），本函数管
 * 「派了没人领」（to 命中）。blocked/claimed/in_progress 必然已有 assignee，不在此域。
 */
export function memberUnclaimedTasks(tasks: readonly Task[], key: string): Task[] {
  return tasks.filter(
    (task) => task.status === 'pending' && task.assignee === null && task.to === key,
  );
}

/**
 * 把一张未认领单**释放回共享待领池**（纯函数，锁内调用）：删除受领人预留 `to`
 * （任何成员可认领，与 revokeAttempt 的安全对-3 口径一致）、记 history、刷新
 * updatedAt/lastProgressTs。
 *
 * 状态机豁免同 revokeAttempt 家族：pending→pending 不是 xc_report 可走转移，这是
 * **引擎特权**回池（原受领人供给失败/停机/超时，不可能再认领）。
 * 幂等：非「pending ∧ 无 assignee ∧ to 命中」的单一律 no-op 返回 false。
 */
export function releaseUnclaimedTask(
  task: Task,
  options: { by?: string; now?: number; event?: string } = {},
): boolean {
  if (task.status !== 'pending' || task.assignee !== null || task.to === undefined) return false;
  const now = options.now ?? Date.now();
  delete task.to; // 引擎回池 = 共享待领池（与 graph.revokeAttempt 同口径）
  appendTaskHistory(task, options.event ?? 'released-unclaimed', options.by ?? 'engine', undefined, now);
  return true;
}

/**
 * v0.9.9（V098-06/V098-07）：回池的**锁内半边**（调用方已持团队锁；member-stop 的
 * 停机面与供给失败/看门狗判死面共用同一份释放+回执实现）。
 *
 * 一步到位（调用方的临界段内）：
 * 1. {@link memberUnclaimedTasks} 取该成员未认领单（pending ∧ assignee 空 ∧ to 命中）；
 * 2. {@link releaseUnclaimedTask} 逐张删 to 回共享待领池 + writeTeam；
 * 3. 逐张给 **createdBy** 投一条 task-receipt（status=failed，error 说明成员不可用、
 *    任务已回池——与 member-stop 对已认领单的回执帧同形同族）；
 * 4. 返回释放清单；**审计由调用方落**（`member-unclaimed-repooled`）——锁内不写
 *    engine.jsonl，与全模块纪律一致（供给失败/判死面在锁外随
 *    {@link repoolUnclaimedTasksForFailedMember}，停机面随 member-stopped 之后）。
 *
 * 为什么停机面必须走锁内半边而不是锁外包装（V098-06）：member-stop 的临界段里还有
 * 「已认领单收回（revokeAttempt）+ 成员置 removed」要一起落盘——未认领单若等锁外
 * 二次回池，进程崩在两者之间即留下「removed 成员名下的一张 to 预留单」永久搁浅
 * （removed 成员不被看门狗扫、pending 不在 stale 清扫域、他人 claim 得 not_assignee）。
 *
 * 幂等安全：无未认领单 = 零写零邮件，返回空数组。
 */
export async function repoolUnclaimedTasksLocked(
  stateRoot: string,
  team: TeamState,
  key: string,
  input: { reason: string; detail?: string; by?: string; now?: number },
): Promise<{ taskId: string; title: string; createdBy: string }[]> {
  const released: { taskId: string; title: string; createdBy: string }[] = [];
  const now = input.now ?? Date.now();
  for (const task of memberUnclaimedTasks(team.tasks, key)) {
    if (!releaseUnclaimedTask(task, { by: input.by ?? 'engine', now, event: 'released-member-unavailable' })) continue;
    released.push({ taskId: task.id, title: task.title, createdBy: task.createdBy });
  }
  if (released.length === 0) return released;
  await writeTeam(stateRoot, team);
  const detail = input.detail !== undefined && input.detail.trim() !== '' ? `: ${input.detail.trim().slice(0, 300)}` : '';
  for (const entry of released) {
    await appendMailbox(stateRoot, team.teamId, entry.createdBy, createMessage(
      key,
      entry.createdBy,
      JSON.stringify({
        type: 'task-receipt',
        teamId: team.teamId,
        taskId: entry.taskId,
        status: 'failed',
        error: `revoked: member "${key}" became unavailable (${input.reason})${detail}; task returned to the pending pool`,
        title: entry.title,
      }),
      {
        taskId: entry.taskId,
        sourceTaskId: entry.taskId,
        sourceTaskStatus: 'pending',
        deliveryClaimedAt: now,
      },
    ));
  }
  return released;
}

/**
 * v0.9.8（D2/V097-07）：把一名**供给失败/停机**成员名下的未认领单回池 + 通知创建者
 * （锁外包装：自持团队锁读-改-写；repairTeamState 同款的「状态自愈」入口）。
 *
 * v0.9.9（V098-06/V098-07）接线面：供给失败面 engine/provision.ts 的 catch、看门狗
 * 判死面 engine/watchdog.ts 的死亡路径（V098-07）。member-stop 面（V098-06）不走本
 * 包装而走锁内半边 {@link repoolUnclaimedTasksLocked}——停止的临界段里未认领单回池
 * 必须与「开放任务收回 + 成员置 removed」同一次落盘（崩在中间 = 永久搁浅，见该函数
 * 声明）；审计 `member-unclaimed-repooled` 由停机面在锁外补落（同键同值）。
 *
 * 幂等安全：无未认领单 = 零写零审计，返回空数组。
 */
export async function repoolUnclaimedTasksForFailedMember(
  stateRoot: string,
  teamId: string,
  key: string,
  input: { reason: string; detail?: string; by?: string },
): Promise<{ taskId: string; title: string; createdBy: string }[]> {
  const released = await withTeamLock(stateRoot, teamId, async () => {
    const team = await readTeam(stateRoot, teamId);
    if (team === undefined) return [];
    return repoolUnclaimedTasksLocked(stateRoot, team, key, input);
  });
  if (released.length > 0) {
    await logEngineEvent(stateRoot, {
      event: 'member-unclaimed-repooled',
      teamId,
      name: key,
      taskIds: released.map((entry) => entry.taskId),
      reason: input.reason,
    });
  }
  return released;
}

// ---------------------------------------------------------------------------
// v0.9.1（G-13）：派单查重硬闸的纯判据（调用方 = mcp/tools-tasks.ts 的 xc_dispatch，
// 持团队锁调用；本模块只出判据不持锁——与全模块纪律一致）。
//
// 与既有「未读信封幂等」（tools-tasks.ts 的 dispatchDedupKey：邮箱里是否已有一条
// 同票、未读、仍现行的派发信封）是**两层**，不是替代：信封层看投递面，本层看
// **任务板**——信封被消费掉之后（读过的信封不再参与幂等），同一张票仍会借任务板
// 上的活任务被拦住。生产事故形态（G-13）：58 秒内对同一成员连派三张
// 重复票，信封层只挡「还没被读」的那一张。
// ---------------------------------------------------------------------------

/**
 * 查重硬闸的「活任务」域：pending/claimed/in_progress（G-13 任务书原文口径）。
 *
 * 与 OPEN_TASK_STATUSES（含 blocked）刻意不同：blocked 是合法暂停（有属主、
 * attempt 保留、unblock 可续），同一张票 blocked 后再派是**恢复手段**而非重复
 * 派单，放进查重域会把「解除阻塞的正常改派」一起拦死。终态（completed/failed/
 * cancelled）同理不在域内——历史单不挡新派。
 */
export const ACTIVE_DUPLICATE_TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'claimed',
  'in_progress',
];

/**
 * v0.9.1（G-13）：派单票面指纹（标题 + 内容 + 验收标准）。
 *
 * 不含发送方、受领人、taskId、attempt：查重要判的是「同一张票」，不是「同一次
 * 派发动作」（dispatchDedupKey 的口径）。acceptance 缺省归一为空串——省略与显式
 * 空串视为同一张票。title 去首尾空白（与建单侧 makeTask 同款 trim），prompt 原样
 * （内容差异必须可分辨，不做任何归一）。
 */
export function taskTicketFingerprint(input: {
  title: string;
  prompt: string;
  acceptance?: string;
}): string {
  const canonical = JSON.stringify([
    'v091-g13-ticket',
    input.title.trim(),
    input.prompt,
    (input.acceptance ?? '').trim(),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * v0.9.1（G-13）：任务板上的同票**活任务**（纯函数；锁内调用）。
 *
 * 判据三件齐：① 受领人相同（task.to 命中 toKey；回池任务 to 已清 = 共享待领池，
 * 不算「派给同一人」）② 票面指纹相同 ③ 状态 ∈ ACTIVE_DUPLICATE_TASK_STATUSES。
 * 命中多个时返回**最早创建**的那一单（createdAt 升序，同值按 id 字典序保确定）——
 * 回执要指向「既有那一单」，多个候选时指向最早者最稳定。
 *
 * 指纹由任务记录自身字段现算（不新增落盘字段）：存量记录与手写 team.json 同样
 * 参与判定，无 schema 变更、无迁移。
 */
export function findActiveDuplicateTask(
  team: TeamState,
  input: { to: string; title: string; prompt: string; acceptance?: string },
): Task | undefined {
  const fingerprint = taskTicketFingerprint(input);
  const hits = team.tasks
    .filter(
      (task) =>
        task.to === input.to
        && ACTIVE_DUPLICATE_TASK_STATUSES.includes(task.status)
        && taskTicketFingerprint(task) === fingerprint,
    )
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt));
  return hits[0];
}

// ---------------------------------------------------------------------------
// v0.9.1（G-14）：回合开始强提醒的「已完成未接力」判据（纯函数；钩子锁外读取用）。
//
// 口径：派发方邮箱里躺着某任务的 **completed 回执且未读**，且任务板上该任务
// 仍是 completed = 活已干完、回执没人取（G-14「任务板有 completed 未接力
// 项」）。回执被读（readAt 落下）即视为已接力——提醒随之停止，与「重复注入直到
// 消费」的收口条件同源。回执只作**判据**，不改写任务状态（伪造回执不得变成伪造
// 完成态，与 v0.5.2 回执链检测同一纪律）。
// ---------------------------------------------------------------------------

/**
 * v0.9.1（G-14）：给定某成员的未读消息，返回其中「已完成但尚未被接力」的任务
 * （按 createdAt 升序、去重）。`unread` 传该成员的未读邮件（ urgentFirst 排序的
 * 全量未读即可，本函数自行按 sourceTaskStatus 过滤）。
 */
export function unrelayedCompletedTasks(team: TeamState, unread: readonly TeamMessage[]): Task[] {
  const found: Task[] = [];
  for (const message of unread) {
    if (message.sourceTaskStatus !== 'completed') continue;
    const taskId = message.sourceTaskId;
    if (taskId === undefined) continue;
    const task = team.tasks.find((candidate) => candidate.id === taskId);
    // 回执在而任务已不在板上（孤儿引用）不属「未接力」——那是 orphanTaskIds 的域。
    if (task === undefined || task.status !== 'completed') continue;
    if (!found.includes(task)) found.push(task);
  }
  return found.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt));
}

/**
 * v0.7（C7，DESIGN-V0.7 §3.2）：lead 判定（team.leadKey，未设置时 founder 视为 lead）——
 * core 侧（审批门/台账清扫）需要它而 core 不能 import mcp，故在 core 提供单一事实源；
 * mcp/tools-team.ts 的原有第二份实现已改为转出本函数（v0.7 集成收口去重），
 * 两处不再各写一份。
 */
export function leadKeyOf(team: TeamState): string {
  return team.leadKey ?? team.founderKey;
}

/**
 * Append one history entry and bump updatedAt.
 *
 * v0.7.2（红队五番战 C8-B2 修复）：同时刷新**落盘**的 `lastProgressTs`
 * （PROTOCOL §12.1 的 `task.lastProgressTs`）。C8 的 idle-timeout 判据
 * （`now - task.lastProgressTs > XC_OFFLINE_MINUTES`）此前只存在于纯函数
 * 推导里、任务记录无该字段——离线判定的空闲源在观测面不可见，且按「回拨
 * updatedAt + 末条 history.ts」的既定时间加速手段模拟时被 createdAt 下限
 * 吞掉（见 core/stall.ts lastProgressTs 的口径修正）。本函数是全部状态
 * 转移的唯一收口点（claim/report/blocked/unblock/revoke/deadlock 都经它），
 * 在此刷新即覆盖所有进展点。
 */
export function appendTaskHistory(task: Task, event: string, by: string, attemptId?: string, now: number = Date.now()): void {
  const entry: TaskHistoryEntry = { ts: now, event, by, ...(attemptId === undefined ? {} : { attemptId }) };
  task.history.push(entry);
  task.updatedAt = now;
  task.lastProgressTs = now;
}

/**
 * Execution results belong to one attempt; a retry must produce its own
 * evidence (port of state.js:138-145 clearAttemptResult, our schema).
 */
export function clearAttemptResult(task: Task): void {
  task.result = null;
  task.error = null;
  task.evidence = [];
}

/**
 * Start a fresh task generation for one owner: attempt+1, new capability id,
 * status pending -> claimed. Returns the attemptId.
 * Port of state.js:159-162 beginTaskAttempt (activateTaskAttempt inlined).
 */
export function beginTaskAttempt(task: Task, assignee: string, now: number = Date.now()): string {
  const attemptId = randomUUID();
  task.attempt = (task.attempt ?? 0) + 1;
  task.status = 'claimed';
  task.assignee = assignee;
  task.attemptId = attemptId;
  clearAttemptResult(task);
  appendTaskHistory(task, 'claimed', assignee, attemptId, now);
  return attemptId;
}

export interface ReportInput {
  status: TaskStatus;
  attemptId?: string;
  result?: string;
  error?: string;
  evidence?: EvidenceItem[];
}

/**
 * The full xc_report hard-validation, as pure logic (DESIGN.md §2.6 table):
 * attemptId must equal the task's current capability (stale = hard reject,
 * port of tools.js:1839-1841), the transition must be legal, and a completion
 * must carry a result plus at least one evidence entry.
 *
 * @returns the error message, or undefined when the report may be applied.
 */
export function reportTransitionError(task: Task, input: ReportInput, reporter: string): string | undefined {
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    return `task ${task.id} is already ${task.status}`;
  }
  if (task.attemptId !== null && (input.attemptId === undefined || input.attemptId === '')) {
    return `missing attemptId for task ${task.id}; retry with attemptId="${task.attemptId}"`;
  }
  if (task.attemptId !== null && input.attemptId !== task.attemptId) {
    return `stale attempt for task ${task.id}: expected the current attemptId, stop work and request fresh assignment`;
  }
  if (task.assignee !== null && task.assignee !== reporter) {
    return `task ${task.id} is assigned to "${task.assignee}", not you`;
  }
  const transition = transitionError(task.status, input.status);
  if (transition !== undefined) return transition;
  if (input.status === 'completed') {
    if (input.result === undefined || input.result.trim() === '') {
      return `completing task ${task.id} requires a result`;
    }
    if (input.evidence === undefined || input.evidence.length < 1) {
      return `completing task ${task.id} requires at least one evidence entry`;
    }
  }
  // v0.6（C2，DESIGN-V0.6.md §3.2）：blocked 必填阻塞原因（error=阻塞原因，非空）。
  // 谁卡住谁申报——无 reason 的 blocked 与「暂停」语义无差，拒绝空申报。
  if (input.status === 'blocked' && (input.error === undefined || input.error.trim() === '')) {
    return `reporting blocked for task ${task.id} requires a non-blank reason in "error"`;
  }
  return undefined;
}

/** Apply one validated report to the task (caller validated via reportTransitionError). */
export function applyReport(task: Task, input: ReportInput, reporter: string, now: number = Date.now()): void {
  const previous = task.status;
  if (transitionError(previous, input.status) !== undefined) {
    throw new Error(`applyReport called with illegal transition ${previous} -> ${input.status}`);
  }
  // v0.6（C2，DESIGN-V0.6.md §3.2/M2）：blocked 独立分支——attempt 保留（暂停而非
  // 作废），标记 preBlockedStatus/blockedReason/blockedAt，history 记 'blocked'。
  if (input.status === 'blocked') {
    applyReportBlocked(task, input.error ?? '', now);
    return;
  }
  task.status = input.status;
  if (input.result !== undefined) task.result = input.result;
  if (input.error !== undefined) task.error = input.error;
  if (input.evidence !== undefined) task.evidence = input.evidence;
  // attemptId is NOT cleared on terminal (dsh parity): isCurrentMail judges a
  // completion receipt by `task.attemptId === message.sourceAttemptId` plus a
  // matching terminal status snapshot; clearing the token would make the
  // receipt stale and the dispatcher would never learn the result.
  appendTaskHistory(task, input.status, reporter, task.attemptId ?? undefined, now);
  // v0.6（C2）：认领者自解路径（blocked → in_progress，唯一经 report 的解除边）——
  // 与 xc_team unblock 共用 clearBlockedMarkers（防二次 unblock 误回跳），history
  // 追加 'unblocked-self'（与 lead 侧 'unblocked-><status>' 区分，M2 共享块注记）。
  if (previous === 'blocked') {
    clearBlockedMarkers(task);
    appendTaskHistory(task, 'unblocked-self', reporter, task.attemptId ?? undefined, now);
  }
}

// ---------------------------------------------------------------------------
// v0.6（C2）blocked 态：进入 / 解除（DESIGN-V0.6.md §3.2 / §4.2-M2 共享块）
// ---------------------------------------------------------------------------

/**
 * 进入 blocked（调用方已过 transitionError：claimed|in_progress → blocked 合法，
 * 且 reportTransitionError 已确保 reason 非空）。attempt 保留——暂停而非作废。
 * 解除目标态记入 preBlockedStatus（∈ {claimed, in_progress}），unblock 据此复位。
 */
export function applyReportBlocked(task: Task, reason: string, now: number): void {
  task.preBlockedStatus = task.status;
  task.status = 'blocked';
  task.blockedReason = reason;
  task.blockedAt = now;
  task.updatedAt = now;
  // 调用路径上 assignee === reporter（reportTransitionError 的 assigned-to 校验）。
  appendTaskHistory(task, 'blocked', task.assignee ?? 'unknown', task.attemptId ?? undefined, now);
}

/**
 * 解除 blocked（xc_team unblock 的 core 半边；回投 unblock-notice + wake 在工具层）。
 * 复位目标 = preBlockedStatus；缺失（手工编辑/宽容读取丢弃）时兜底回 pending
 * （TASK_TRANSITIONS.blocked 的防御边）。
 *
 * @returns 错误消息，undefined = 已解除。非 blocked 任务 → 'task_not_blocked'。
 */
export function unblockTask(
  task: Task,
  now: number,
  options: { by?: string } = {},
): string | undefined {
  if (task.status !== 'blocked') return 'task_not_blocked';
  const back = task.preBlockedStatus ?? 'pending';
  const err = transitionError('blocked', back);
  if (err) return err;
  task.status = back;
  task.updatedAt = now;
  clearBlockedMarkers(task);
  appendTaskHistory(task, `unblocked->${back}`, options.by ?? 'lead-or-creator', task.attemptId ?? undefined, now);
  return undefined;
}

/**
 * L5：两条解除路径（xc_team unblock / 认领者自解 report(in_progress)）共用的清理——
 * 解除目标标记必须清，防二次 unblock 误回跳；blockedReason/blockedAt 保留作历史
 * 痕迹（journal 之外的磁盘痕迹）。
 */
export function clearBlockedMarkers(task: Task): void {
  task.preBlockedStatus = undefined;
}

/** v0.6（C2）：priority 展示/取单秩——absent 归一为 normal（旧记录兼容）。 */
export function priorityRank(priority?: TaskPriority): number {
  return TASK_PRIORITY_RANK[priority ?? 'normal'];
}

/**
 * v0.6（C2）：任务板统一排序（priority → createdAt，stable；DESIGN-V0.6.md §3.2）。
 * xc_overview 任务板 / 未领池呈现 / 唤醒建议序共用此序；不改传入数组。
 * 同秩同刻按 id 全序化，保证跨调用呈现稳定。
 */
export function sortTasksForBoard(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority)
      || a.createdAt - b.createdAt
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Whether `next` is a legal transition from `task.status` (thin wrapper used
 * by tools that only probe, e.g. claim feasibility checks).
 */
export function canTransition(task: Task, next: TaskStatus): boolean {
  return transitionError(task.status, next) === undefined;
}

/** Allowed transitions of the current status (exposed for tool error text). */
export function allowedTransitions(task: Task): readonly TaskStatus[] {
  return TASK_TRANSITIONS[task.status];
}

// ---------------------------------------------------------------------------
// Compatibility layer for the module-3 tool face (imported from src/mcp/*).
// Same semantics as the primitives above, shaped the way tools.ts/identity.ts
// consume them (their header comments document this contract).
// ---------------------------------------------------------------------------

/** The member's single open (claimed/in_progress/blocked——v0.6 C2 起含 blocked) task, if any (dsh 同名约束). */
export function memberOpenTask(team: TeamState, agentKey: string): Task | undefined {
  return memberOpenTasks(team.tasks, agentKey)[0];
}

/**
 * Apply one already-validated status transition to a task inside `team`
 * (history entry + updatedAt included; no persistence — callers writeTeam).
 * Defensive: throws on an illegal transition instead of corrupting state.
 */
export function transitionTask(
  team: TeamState,
  taskId: string,
  to: TaskStatus,
  by: string,
  options: { attemptId?: string; now?: number } = {},
): Task {
  const task = getTask(team, taskId);
  if (task === undefined) throw new Error(`task "${taskId}" not found in team "${team.teamId}"`);
  const illegal = transitionError(task.status, to);
  if (illegal !== undefined) throw new Error(illegal);
  task.status = to;
  appendTaskHistory(task, to, by, options.attemptId, options.now);
  return task;
}

/**
 * v0.5.1（故障注-5 修复）：建队前的残迹检测——team.json 缺失但团队目录仍有
 * 上一时代的邮箱/快照残留时，「静默整队重置」不再无声：返回给注册/建队路径
 * 的告警文案（undefined = 无残迹，正常首建），并落审计 `team-reset-detected`。
 * 探测尽力而为：残迹探测自身失败按无残迹处理（不阻塞建队）。
 */
export async function noteTeamReset(stateRoot: string, teamId: string): Promise<string | undefined> {
  let inboxEntries: string[] = [];
  let hasSnapshot = false;
  try {
    inboxEntries = (await readdir(inboxDir(stateRoot, teamId))).filter((name) => name.endsWith('.jsonl'));
  } catch {
    // 邮箱目录不存在 = 无邮箱残迹
  }
  try {
    hasSnapshot = await stat(snapshotFile(stateRoot, teamId)).then(
      () => true,
      () => false,
    );
  } catch {
    // 探测失败按无残迹处理
  }
  if (inboxEntries.length === 0 && !hasSnapshot) return undefined;
  await logEngineEvent(stateRoot, {
    event: 'team-reset-detected',
    teamId,
    inboxFiles: inboxEntries.length,
    snapshot: hasSnapshot,
  });
  return (
    `team.json was missing while previous-era state still exists in teams/${teamId}/ `
    + `(${inboxEntries.length} inbox file(s)${hasSnapshot ? ' + snapshot.json' : ''}); `
    + 'a new team era was created — old envelopes may reference tasks that no longer exist '
    + '(orphan warnings appear in xc_overview)'
  );
}

export type { MemberRole };

// ---------------------------------------------------------------------------
// v0.7.1（红队四番战 故障注-1 修复）：provisioning 超时的**落盘 deadline + 清扫**。
//
// 旧形态：建员欢迎回合的超时只存在于 lead MCP server 进程的内存里
// （provisionMember 的 for(;;) 轮询 deadline）。lead server 中途死亡 →
// 成员 roster 永久卡 provisioning：无回执、无审计、还占成员名额
// （红队 fi1：kill 后 75s 仍 provisioning，engine.jsonl 仅 member-add-started）。
//
// 新形态（三段）：
// ① 落盘 deadline：member-add Phase 1 写 provisioning 记录时一并写
//    `provisionDeadlineAt = provisionedAt + bootstrapTimeoutMs + 宽限`；
// ② 清扫：任一后续工具调用（member-add Phase 1，团队锁内）或钩子
//    （UserPromptSubmit，团队锁 2s 预算内 best-effort）对过期记录置
//    state=failed + error（释放名额）；
// ③ 回执/审计：engine.jsonl 落 `member-provision-timeout`；同名重试
//    member-add 干净接管（§6.4 幂等重供给）并在成功载荷披露 recovered。
// ---------------------------------------------------------------------------

/** provisioning 超时宽限（与 resolveReprovision 的停滞口径同值：超时 + 60s）。 */
export const PROVISION_STALE_GRACE_MS = 60_000;

/**
 * 成员供给超时默认值（§6.2 步骤④；userConfig member_bootstrap_timeout_ms 同默认）。
 *
 * v0.7.1（故障注-1 修复）：从 engine/provision.ts 迁入 core——provisioning
 * deadline 的清扫方（member-add 工具路径 + UserPromptSubmit 钩子）都要读它，
 * 而钩子按 DESIGN §8.1 规则 1 只能 import M1（core）。engine/provision.ts
 * 原路径转出，既有导入方不变。
 */
export const DEFAULT_MEMBER_BOOTSTRAP_TIMEOUT_MS = 300_000;

/**
 * XC_MEMBER_BOOTSTRAP_TIMEOUT_MS 解析（V18 同款防御：非有限正数的一律取默认值）。
 */
export function bootstrapTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["XC_MEMBER_BOOTSTRAP_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MEMBER_BOOTSTRAP_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MEMBER_BOOTSTRAP_TIMEOUT_MS;
}

/**
 * provisioning 记录的停滞判定口径（ms）：建员欢迎回合还可能在实际超时后
 * 短暂在途（收尾/落库），故清扫阈值 =  bootstrap 超时 + 宽限。
 * 单一事实源：resolveReprovision（tools-team.ts）与清扫方共用。
 */
export function provisionStaleAfterMs(bootstrapTimeoutMs: number): number {
  return bootstrapTimeoutMs + PROVISION_STALE_GRACE_MS;
}

/** env 版的停滞口径（钩子进程无 userConfig env 时回落内置默认——保守方向）。 */
export function provisionStaleAfterMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return provisionStaleAfterMs(bootstrapTimeoutFromEnv(env));
}

/** 一条被清扫的 provisioning 记录（回执/审计用）。 */
export interface SweptProvision {
  key: string;
  /** 记录里的供给开始时刻（缺省时 undefined）。 */
  provisionedAt: number | undefined;
  /** 本次清扫使用的 deadline（记录自带或现算兜底）。 */
  deadline: number;
  /**
   * v0.9.8（D2/V097-07）：本次清扫**连带释放回池**的未认领单 id（该成员名下
   * pending ∧ assignee 空 ∧ to 命中的派单）。absent = 无未认领单（旧行为）。
   * 调用方（member-add 锁内 / UserPromptSubmit 钩子）writeTeam 即落盘；创建者
   * 通知由供给失败面（engine/provision.ts）与派发面承担，纯函数不触达邮箱。
   */
  releasedTaskIds?: string[];
}

/** provisioning 超时写入 roster 的 error 文案（≤500 字符，与既有失败文案同族）。 */
export function provisionTimeoutError(startedAt: number | undefined, deadline: number, staleAfterMs: number): string {
  const waited = startedAt === undefined ? staleAfterMs : Math.max(0, deadline - startedAt);
  return (
    `provisioning deadline exceeded (~${waited} ms after start; XC_MEMBER_BOOTSTRAP_TIMEOUT_MS + `
    + `${PROVISION_STALE_GRACE_MS} ms grace) — the lead MCP server that started this supply is gone or the `
    + 'welcome turn never completed; state=failed frees the member slot; retry xc_team '
    + '{action:"member-add"} with the same name (idempotent reprovision, §6.4)'
  ).slice(0, 500);
}

/**
 * 清扫（纯函数，锁内调用）：把超过 deadline 的 provisioning 记录就地置
 * state=failed + error，返回被清扫的条目。调用方负责 writeTeam 与审计。
 *
 * deadline 取值：记录自带 `provisionDeadlineAt`（v0.7.1 起 Phase 1 落盘，
 * 用的是**当时** lead server 的超时配置）优先；缺失（存量记录）按
 * `provisionedAt ?? joinedAt + staleAfterMs` 现算兜底。
 *
 * v0.9.8（D2/V097-07）：被置 failed 的成员，其名下**未认领单**连带释放回共享待领池
 * （{@link releaseUnclaimedTask}：删 to + history）。没有这一步，供给超时（lead
 * server 中途死亡）后派给该成员的单同样永久搁浅——他人 not_assignee、失败成员无法
 * 认领、pending 不在清扫域。释放随本函数的调用方 writeTeam 一并落盘。
 */
export function sweepStaleProvisioningLocked(
  team: TeamState,
  now: number,
  staleAfterMs: number,
): SweptProvision[] {
  const swept: SweptProvision[] = [];
  for (const member of team.members) {
    if ((member.state ?? 'ready') !== 'provisioning') continue;
    const startedAt = member.provisionedAt ?? member.joinedAt;
    const deadline = member.provisionDeadlineAt ?? startedAt + staleAfterMs;
    if (now <= deadline) continue;
    member.state = 'failed';
    member.error = provisionTimeoutError(member.provisionedAt, deadline, staleAfterMs);
    member.lastSeen = now;
    member.provisionDeadlineAt = deadline; // 保留现场：审计/复诊可见本次判定依据
    // v0.9.8（D2/V097-07）：未认领单回池（见上方声明）。
    const releasedTaskIds = memberUnclaimedTasks(team.tasks, member.key)
      .filter((task) => releaseUnclaimedTask(task, { by: 'engine', now, event: 'released-provision-timeout' }))
      .map((task) => task.id);
    swept.push({
      key: member.key,
      provisionedAt: member.provisionedAt,
      deadline,
      ...(releasedTaskIds.length > 0 ? { releasedTaskIds } : {}),
    });
  }
  return swept;
}
