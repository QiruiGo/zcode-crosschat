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
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileAtomic } from './atomic.js';
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
  type TeamState,
} from './types.js';
import { logEngineEvent } from './log.js';

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
//    可被 xc_status / xc_claim 检出，不依赖台账内存。
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
    `no usable backup at "${backupPath}" — restore it manually or delete the team directory to reset`,
  );
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
  // 清除该团队的恢复披露台账（xc_status 的恢复告警随之消失）。
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
    result: null,
    error: null,
    evidence: [],
    history: [],
    ...(priority === undefined ? {} : { priority }),
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

/** Append one history entry and bump updatedAt. */
export function appendTaskHistory(task: Task, event: string, by: string, attemptId?: string, now: number = Date.now()): void {
  const entry: TaskHistoryEntry = { ts: now, event, by, ...(attemptId === undefined ? {} : { attemptId }) };
  task.history.push(entry);
  task.updatedAt = now;
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

/**
 * Create the team directory structure and the initial team record, and return
 * it. Throws when the team already exists (callers are expected to have found
 * it absent under the team lock first).
 */
export async function createTeam(
  stateRoot: string,
  input: { teamId: string; name?: string; founderKey: string; now?: number },
): Promise<TeamState> {
  const existing = await readTeam(stateRoot, input.teamId);
  if (existing !== undefined) {
    throw new Error(`team "${input.teamId}" already exists`);
  }
  const team = newTeamState({
    teamId: input.teamId,
    name: input.name ?? input.teamId,
    founderKey: input.founderKey,
    now: input.now,
  });
  await writeTeam(stateRoot, team);
  return team;
}

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
    + '(orphan warnings appear in xc_status)'
  );
}

export type { MemberRole };
