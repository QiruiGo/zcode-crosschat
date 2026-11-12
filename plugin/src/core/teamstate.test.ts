import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { teamBackupFile, teamCorruptFile, teamFile } from './paths.js';

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
  // v0.5.1（故障注-5 修复）：新时代任务 id 带纪元前缀，重建后不与旧时代撞号。
  it('allocates era-prefixed t1, t2, ... from the seq counter', () => {
    const team = setup();
    expect(team.era).toMatch(/^[0-9a-f]{8}$/);
    const t1 = makeTask(team, { title: 'one', prompt: 'p', createdBy: 'a' });
    const t2 = makeTask(team, { title: 'two', prompt: 'p', createdBy: 'a' });
    expect(t1.id).toBe(`${team.era}-t1`);
    expect(t2.id).toBe(`${team.era}-t2`);
    expect(nextTaskId(team)).toBe(`${team.era}-t3`);
    expect(team.seq).toBe(2);
    expect(t1.status).toBe('pending');
    expect(t1.assignee).toBeNull();
    expect(t1.attemptId).toBeNull();
  });

  // 旧记录（无 era 字段）宽容兼容：任务 id 保持 legacy `t<n>` 形态。
  it('legacy teams without an era keep the bare t<n> id shape', () => {
    const legacy = newTeamState({ teamId: 'default', founderKey: 'a' });
    delete (legacy as { era?: string }).era;
    const task = makeTask(legacy, { title: 'one', prompt: 'p', createdBy: 'a' });
    expect(task.id).toBe('t1');
    expect(nextTaskId(legacy)).toBe('t2');
  });
});

describe('unsatisfiedDependencies / memberOpenTasks', () => {
  it('reports dependencies that are missing or not completed', () => {
    const team = setup();
    const t1 = makeTask(team, { title: 'one', prompt: 'p', createdBy: 'a' });
    const t2 = makeTask(team, { title: 'two', prompt: 'p', createdBy: 'a', dependsOn: [t1.id, 'ghost'] });
    // t1 pending (and ghost nonexistent) -> both unsatisfied:
    expect(unsatisfiedDependencies(team.tasks, t2.dependsOn)).toEqual([t1.id, 'ghost']);
    t1.status = 'completed'; // direct test-only mutation of the dependency gate
    expect(unsatisfiedDependencies(team.tasks, t2.dependsOn)).toEqual(['ghost']);
  });

  it('counts only claimed/in_progress as open (one-open-task rule input)', () => {
    const team = setup();
    const t1 = makeTask(team, { title: 'one', prompt: 'p', createdBy: 'a' });
    expect(memberOpenTasks(team.tasks, 'b')).toEqual([]);
    const attempt = beginTaskAttempt(t1, 'b'); // pending -> claimed
    expect(memberOpenTasks(team.tasks, 'b').map((t) => t.id)).toEqual([t1.id]);
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

  it('throws a diagnostic (not a silent coerce) for corrupt team.json without a usable backup', async () => {
    await writeTeam(dir, setup());
    const file = join(dir, 'teams', 'default', 'team.json');
    // 无备份（v0.5.1 之前从未写过 .bak / 备份同样丢失）：fail-closed，但错误信息
    // 从裸 JSON/裸 defect 升级为「路径 + 缺陷 + 修复指引」的显式降级诊断。
    unlinkSync(teamBackupFile(dir, 'default'));
    writeFileSync(file, JSON.stringify({ teamId: 'default', tasks: 'not-an-array' }), 'utf8');
    await expect(readTeam(dir, 'default')).rejects.toThrow(/is corrupt \(field "founderKey" missing or blank\)/);
    await expect(readTeam(dir, 'default')).rejects.toThrow(/restore it manually or delete the team directory/);
    writeFileSync(file, '{broken json', 'utf8');
    await expect(readTeam(dir, 'default')).rejects.toThrow(/not valid JSON/);
  });

  // v0.5.1（故障注-1 修复）：真源损坏时从 last-known-good 镜像自愈，
  // 残损字节保全为 team.json.corrupt，审计落 team-state-recovered。
  it('recovers from the last-known-good backup when team.json is corrupt', async () => {
    const team = setup();
    makeTask(team, { title: 'before corruption', prompt: 'p', createdBy: 'a' });
    await writeTeam(dir, team); // team.json + team.json.bak 同内容
    const file = join(dir, 'teams', 'default', 'team.json');
    writeFileSync(file, '{half-written truncation', 'utf8');
    const recovered = await readTeam(dir, 'default');
    expect(recovered).toBeDefined();
    expect(recovered!.tasks[0]!.title).toBe('before corruption');
    expect(existsSync(teamCorruptFile(dir, 'default'))).toBe(true);
    expect(readFileSync(teamCorruptFile(dir, 'default'), 'utf8')).toBe('{half-written truncation');
  });

  it('writeTeam mirrors the same content to team.json.bak', async () => {
    const team = setup();
    makeTask(team, { title: 'mirrored', prompt: 'p', createdBy: 'a' });
    await writeTeam(dir, team);
    const backup = JSON.parse(readFileSync(teamBackupFile(dir, 'default'), 'utf8'));
    expect(backup.tasks).toHaveLength(1);
    expect(backup.tasks[0].title).toBe('mirrored');
    expect(backup.era).toBe(team.era);
  });
});

describe('getTask', () => {
  it('finds tasks by id', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    expect(getTask(team, task.id)?.id).toBe(task.id);
    expect(getTask(team, `${team.era}-t9`)).toBeUndefined();
  });
});
