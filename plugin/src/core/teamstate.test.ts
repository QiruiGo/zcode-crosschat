import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  applyReport,
  beginTaskAttempt,
  canTransition,
  getTask,
  makeTask,
  memberOpenTasks,
  newTeamState,
  nextTaskId,
  readTeam,
  reportTransitionError,
  unsatisfiedDependencies,
  writeTeam,
} from './teamstate.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-teamstate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const team = newTeamState({ teamId: 'default', founderKey: 'a' });
  return team;
}

describe('task allocation', () => {
  it('allocates t1, t2, ... from the seq counter', () => {
    const team = setup();
    const t1 = makeTask(team, { title: 'one', prompt: 'p', createdBy: 'a' });
    const t2 = makeTask(team, { title: 'two', prompt: 'p', createdBy: 'a' });
    expect(t1.id).toBe('t1');
    expect(t2.id).toBe('t2');
    expect(nextTaskId(team)).toBe('t3');
    expect(team.seq).toBe(2);
    expect(t1.status).toBe('pending');
    expect(t1.assignee).toBeNull();
    expect(t1.attemptId).toBeNull();
  });
});

describe('unsatisfiedDependencies / memberOpenTasks', () => {
  it('reports dependencies that are missing or not completed', () => {
    const team = setup();
    const t1 = makeTask(team, { title: 'one', prompt: 'p', createdBy: 'a' });
    const t2 = makeTask(team, { title: 'two', prompt: 'p', createdBy: 'a', dependsOn: ['t1', 'ghost'] });
    // t1 pending (and ghost nonexistent) -> both unsatisfied:
    expect(unsatisfiedDependencies(team.tasks, t2.dependsOn)).toEqual(['t1', 'ghost']);
    t1.status = 'completed'; // direct test-only mutation of the dependency gate
    expect(unsatisfiedDependencies(team.tasks, t2.dependsOn)).toEqual(['ghost']);
  });

  it('counts only claimed/in_progress as open (one-open-task rule input)', () => {
    const team = setup();
    const t1 = makeTask(team, { title: 'one', prompt: 'p', createdBy: 'a' });
    expect(memberOpenTasks(team.tasks, 'b')).toEqual([]);
    const attempt = beginTaskAttempt(t1, 'b'); // pending -> claimed
    expect(memberOpenTasks(team.tasks, 'b').map((t) => t.id)).toEqual(['t1']);
    applyReport(t1, { status: 'in_progress', attemptId: attempt }, 'b');
    expect(memberOpenTasks(team.tasks, 'b')).toHaveLength(1);
    applyReport(t1, {
      status: 'completed', attemptId: attempt, result: 'r',
      evidence: [{ path: 'p', sha256: null, note: '' }],
    }, 'b');
    expect(memberOpenTasks(team.tasks, 'b')).toEqual([]);
  });
});

describe('attempt tokens (attempt 令牌机制, dsh state.js:138-187 port)', () => {
  it('beginTaskAttempt bumps attempt and mints a fresh capability id', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt1 = beginTaskAttempt(task, 'b');
    expect(task.status).toBe('claimed');
    expect(task.assignee).toBe('b');
    expect(task.attempt).toBe(1);
    expect(task.attemptId).toBe(attempt1);
    expect(task.history.some((h) => h.event === 'claimed' && h.attemptId === attempt1)).toBe(true);
  });

  it('a stale attemptId is hard-rejected (attempt 令牌过期)', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const stale = beginTaskAttempt(task, 'b');
    // Reassignment/v2 retry path: a new generation revokes the old capability.
    const fresh = beginTaskAttempt(task, 'c');
    expect(fresh).not.toBe(stale);
    expect(task.attempt).toBe(2);
    // Old holder reporting with the revoked token:
    expect(reportTransitionError(task, { status: 'completed', attemptId: stale, result: 'r', evidence: [{ path: 'p', sha256: null, note: '' }] }, 'b'))
      .toMatch(/stale attempt/);
    // Current holder with the live token passes:
    expect(reportTransitionError(task, { status: 'in_progress', attemptId: fresh }, 'c')).toBeUndefined();
  });

  it('a missing attemptId on an attempt-held task is a parameter error, not stale', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    const error = reportTransitionError(task, { status: 'in_progress' }, 'b');
    expect(error).toContain(`attemptId="${attempt}"`);
  });

  it('clears previous attempt results when a new generation begins', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'failed', attemptId: attempt, error: 'boom' }, 'b');
    expect(task.error).toBe('boom');
    const retry = beginTaskAttempt(task, 'c');
    expect(task.result).toBeNull();
    expect(task.error).toBeNull();
    expect(task.evidence).toEqual([]);
    expect(task.attemptId).toBe(retry);
  });
});

describe('report hard validation + state machine (状态机非法转移拒绝)', () => {
  it('rejects claimed -> completed (must go through in_progress)', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b'); // claimed
    expect(reportTransitionError(task, {
      status: 'completed', attemptId: attempt, result: '391',
      evidence: [{ path: 'x', sha256: null, note: '' }],
    }, 'b')).toMatch(/cannot move from "claimed" to "completed"/);
    expect(canTransition(task, 'completed')).toBe(false);
    expect(allowedTransitions(task)).toEqual(['in_progress', 'failed', 'cancelled']);
    // And applyReport refuses to apply it either:
    expect(() => applyReport(task, { status: 'completed', attemptId: attempt }, 'b')).toThrow(/illegal transition/);
  });

  it('completing requires result and at least one evidence entry', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'in_progress', attemptId: attempt }, 'b');
    expect(reportTransitionError(task, { status: 'completed', attemptId: attempt }, 'b')).toMatch(/requires a result/);
    expect(reportTransitionError(task, { status: 'completed', attemptId: attempt, result: '391' }, 'b'))
      .toMatch(/requires at least one evidence/);
    expect(reportTransitionError(task, {
      status: 'completed', attemptId: attempt, result: '391',
      evidence: [{ path: 'result-a2b.txt', sha256: null, note: '' }],
    }, 'b')).toBeUndefined();
  });

  it('a non-assignee cannot report', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    expect(reportTransitionError(task, { status: 'failed', attemptId: attempt, error: 'x' }, 'c'))
      .toMatch(/assigned to "b", not you/);
  });

  it('terminal tasks accept no further reports', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'in_progress', attemptId: attempt }, 'b');
    applyReport(task, { status: 'completed', attemptId: attempt, result: 'r', evidence: [{ path: 'p', sha256: null, note: '' }] }, 'b');
    // attemptId is preserved on terminal (dsh parity): the completion receipt's
    // isCurrentMail source check needs task.attemptId === sourceAttemptId.
    expect(task.attemptId).toBe(attempt);
    expect(reportTransitionError(task, { status: 'failed', attemptId: attempt, error: 'late' }, 'b'))
      .toMatch(/already completed/);
    expect(task.history.at(-1)?.event).toBe('completed');
  });
});

describe('readTeam/writeTeam roundtrip + corrupt diagnostics', () => {
  it('roundtrips a team through disk', async () => {
    const team = setup();
    const task = makeTask(team, { title: '计算 17*23', prompt: '只写数字', acceptance: '内容 391', createdBy: 'a' });
    beginTaskAttempt(task, 'b');
    await writeTeam(dir, team);
    const loaded = await readTeam(dir, 'default');
    expect(loaded).toBeDefined();
    expect(loaded!.tasks[0]!.title).toBe('计算 17*23');
    expect(loaded!.tasks[0]!.attempt).toBe(1);
    expect(loaded!.seq).toBe(1);
  });

  it('reads a missing team as undefined', async () => {
    expect(await readTeam(dir, 'default')).toBeUndefined();
  });

  it('throws a diagnostic (not a silent coerce) for corrupt team.json', async () => {
    await writeTeam(dir, setup());
    const file = join(dir, 'teams', 'default', 'team.json');
    writeFileSync(file, JSON.stringify({ teamId: 'default', tasks: 'not-an-array' }), 'utf8');
    await expect(readTeam(dir, 'default')).rejects.toThrow(/invalid team state/);
    writeFileSync(file, '{broken json', 'utf8');
    await expect(readTeam(dir, 'default')).rejects.toThrow();
  });
});

describe('getTask', () => {
  it('finds tasks by id', () => {
    const team = setup();
    makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    expect(getTask(team, 't1')?.id).toBe('t1');
    expect(getTask(team, 't9')).toBeUndefined();
  });
});
