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
import { mkdir, readFile } from 'node:fs/promises';
import { writeFileAtomic } from './atomic.js';
import { inboxDir, teamFile } from './paths.js';
import {
  OPEN_TASK_STATUSES,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  transitionError,
  coerceTeamState,
  type EvidenceItem,
  type MemberRole,
  type Task,
  type TaskHistoryEntry,
  type TaskStatus,
  type TeamMember,
  type TeamState,
} from './types.js';

export { DEFAULT_TEAM_ID } from './types.js';

/**
 * Read one team record; `undefined` when the team does not exist yet.
 * Corrupt data throws a diagnostic (strict whole-file validation, §2.7-5).
 */
export async function readTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  let raw: string;
  try {
    raw = await readFile(teamFile(stateRoot, teamId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = coerceTeamState(JSON.parse(raw), teamId);
  if (!parsed.ok) {
    throw new Error(`invalid team state in team "${teamId}": ${parsed.defect}`);
  }
  return parsed.state;
}

/**
 * Persist one team record (whole-file atomic write; caller holds the lock).
 */
export async function writeTeam(stateRoot: string, team: TeamState): Promise<void> {
  await mkdir(inboxDir(stateRoot, team.teamId), { recursive: true });
  await writeFileAtomic(teamFile(stateRoot, team.teamId), JSON.stringify(team, null, 2));
}

/** Build a fresh initial team record (founder becomes the first member if given). */
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
  createdBy: string;
}

/** Allocate the next task id from the team's seq counter (`t<seq+1>`). */
export function nextTaskId(team: TeamState): string {
  return `t${team.seq + 1}`;
}

/**
 * Build one new pending task, append it to team.tasks and advance the team
 * seq. Mutates `team` — callers persist via writeTeam afterwards.
 */
export function makeTask(team: TeamState, input: NewTaskInput, now: number = Date.now()): Task {
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

/** Open (claimed/in_progress) tasks currently owned by one member. */
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
  return undefined;
}

/** Apply one validated report to the task (caller validated via reportTransitionError). */
export function applyReport(task: Task, input: ReportInput, reporter: string, now: number = Date.now()): void {
  const previous = task.status;
  if (transitionError(previous, input.status) !== undefined) {
    throw new Error(`applyReport called with illegal transition ${previous} -> ${input.status}`);
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

/** The member's single open (claimed/in_progress) task, if any (dsh 同名约束). */
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

export type { MemberRole };
