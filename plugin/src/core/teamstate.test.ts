import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  appendTaskHistory,
  applyReport,
  beginTaskAttempt,
  bootstrapTimeoutFromEnv,
  canTransition,
  getTask,
  makeTask,
  memberOpenTasks,
  newTeamState,
  nextTaskId,
  priorityRank,
  provisionStaleAfterMs,
  provisionTimeoutError,
  readTeam,
  reportTransitionError,
  sortTasksForBoard,
  sweepStaleProvisioningLocked,
  unblockTask,
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
    // v0.6（C2）：claimed 增 blocked 出边（认领者显式申报暂停）。
    expect(allowedTransitions(task)).toEqual(['in_progress', 'blocked', 'failed', 'cancelled']);
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

// ---------------------------------------------------------------------------
// v0.6（C2，DESIGN-V0.6.md §3.2/§4.2-M2）：blocked 生命周期 + 优先级排序。
// ---------------------------------------------------------------------------

describe('v0.6 C2 blocked：进入（report blocked，reason 必填）', () => {
  it('blocked 无 error/reason → reportTransitionError 拒绝（谁卡住谁申报）', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    expect(reportTransitionError(task, { status: 'blocked', attemptId: attempt }, 'b'))
      .toMatch(/requires a non-blank reason/);
    expect(reportTransitionError(task, { status: 'blocked', attemptId: attempt, error: '   ' }, 'b'))
      .toMatch(/requires a non-blank reason/);
    expect(reportTransitionError(task, { status: 'blocked', attemptId: attempt, error: '等待依赖输入' }, 'b'))
      .toBeUndefined();
  });

  it('pending 任务不能 report blocked（L-n3 死边：pending 无 attempt）', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    expect(reportTransitionError(task, { status: 'blocked', error: 'x' }, 'a'))
      .toMatch(/cannot move from "pending" to "blocked"/);
    expect(() => applyReport(task, { status: 'blocked', error: 'x' }, 'a')).toThrow(/illegal transition/);
  });

  it('claimed→blocked：preBlockedStatus/blockedReason/blockedAt 落位，attempt 保留，history 记 blocked', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    const now = 1_700_000_000_000;
    applyReport(task, { status: 'blocked', attemptId: attempt, error: '等待外网恢复' }, 'b', now);
    expect(task.status).toBe('blocked');
    expect(task.preBlockedStatus).toBe('claimed');
    expect(task.blockedReason).toBe('等待外网恢复');
    expect(task.blockedAt).toBe(now);
    expect(task.error).toBeNull(); // 设计分离：error=attempt 失败痕迹；阻塞原因走 blockedReason
    expect(task.attemptId).toBe(attempt); // 暂停而非作废
    expect(task.assignee).toBe('b');
    expect(task.history.at(-1)).toMatchObject({ event: 'blocked', by: 'b', attemptId: attempt });
  });

  it('blocked 占用成员单开槽位（OPEN 含 blocked；不可他领——status 非 pending）', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'blocked', attemptId: attempt, error: 'x' }, 'b');
    expect(memberOpenTasks(team.tasks, 'b').map((t) => t.id)).toEqual([task.id]);
    // 解除回 claimed 后槽位仍被占，完成后释放。
    expect(unblockTask(task, Date.now(), { by: 'lead' })).toBeUndefined();
    expect(memberOpenTasks(team.tasks, 'b')).toHaveLength(1);
  });
});

describe('v0.6 C2 blocked：解除（xc_team unblock 的 core 半边）', () => {
  it('unblock 回 preBlockedStatus（claimed），markers 清空、原因保留为历史痕迹', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'blocked', attemptId: attempt, error: 'x' }, 'b');
    const now = 1_800_000_000_000;
    expect(unblockTask(task, now, { by: 'lead' })).toBeUndefined();
    expect(task.status).toBe('claimed'); // 复位到进入前的 claimed
    expect(task.preBlockedStatus).toBeUndefined(); // clearBlockedMarkers
    expect(task.blockedReason).toBe('x'); // 历史痕迹保留
    expect(task.blockedAt).toBeDefined();
    expect(task.attemptId).toBe(attempt); // attempt 仍保留（认领者继续持有）
    expect(task.history.at(-1)).toMatchObject({ event: 'unblocked->claimed', by: 'lead' });
  });

  it('in_progress 进入的 blocked 解除后回 in_progress；by 缺省 lead-or-creator', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'in_progress', attemptId: attempt }, 'b');
    applyReport(task, { status: 'blocked', attemptId: attempt, error: 'x' }, 'b');
    expect(unblockTask(task, Date.now())).toBeUndefined();
    expect(task.status).toBe('in_progress');
    expect(task.history.at(-1)).toMatchObject({ event: 'unblocked->in_progress', by: 'lead-or-creator' });
  });

  it('非 blocked 任务 unblock → task_not_blocked；二次 unblock 被清理挡住', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    expect(unblockTask(task, Date.now())).toBe('task_not_blocked');
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'blocked', attemptId: attempt, error: 'x' }, 'b');
    expect(unblockTask(task, Date.now())).toBeUndefined();
    expect(unblockTask(task, Date.now())).toBe('task_not_blocked');
  });

  it('preBlockedStatus 缺失（手工编辑/宽容丢弃）兜底回 pending（防御边）', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'blocked', attemptId: attempt, error: 'x' }, 'b');
    delete (task as { preBlockedStatus?: string }).preBlockedStatus;
    expect(unblockTask(task, Date.now())).toBeUndefined();
    expect(task.status).toBe('pending');
    expect(task.history.at(-1)?.event).toBe('unblocked->pending');
  });

  it('认领者自解 report(in_progress)：status 复位、markers 清理、history 追加 unblocked-self', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'blocked', attemptId: attempt, error: 'x' }, 'b');
    applyReport(task, { status: 'in_progress', attemptId: attempt }, 'b');
    expect(task.status).toBe('in_progress');
    expect(task.preBlockedStatus).toBeUndefined(); // 二次 unblock 已被挡
    expect(unblockTask(task, Date.now())).toBe('task_not_blocked');
    const events = task.history.map((h) => h.event);
    expect(events).toContain('unblocked-self');
    expect(events[events.length - 1]).toBe('unblocked-self');
    expect(task.blockedReason).toBe('x'); // 历史痕迹
  });

  it('自解后可继续走完闭环（blocked→in_progress→completed）', () => {
    const team = setup();
    const task = makeTask(team, { title: 't', prompt: 'p', createdBy: 'a' });
    const attempt = beginTaskAttempt(task, 'b');
    applyReport(task, { status: 'blocked', attemptId: attempt, error: 'x' }, 'b');
    applyReport(task, { status: 'in_progress', attemptId: attempt }, 'b');
    applyReport(task, {
      status: 'completed', attemptId: attempt, result: 'r',
      evidence: [{ path: 'p', sha256: null, note: '' }],
    }, 'b');
    expect(task.status).toBe('completed');
  });
});

describe('v0.6 C2 优先级（makeTask 落盘 + 任务板排序）', () => {
  it('makeTask 携带 priority；非法值不落盘（absent = normal）', () => {
    const team = setup();
    const high = makeTask(team, { title: 'h', prompt: 'p', createdBy: 'a', priority: 'high' });
    const bad = makeTask(team, {
      title: 'b', prompt: 'p', createdBy: 'a',
      priority: 'urgent' as unknown as 'high',
    });
    expect(high.priority).toBe('high');
    expect(bad.priority).toBeUndefined();
  });

  it('sortTasksForBoard：high→normal→low，同秩按 createdAt，absent 归 normal，不改入参', () => {
    const team = setup();
    const lowOld = makeTask(team, { title: 'lo', prompt: 'p', createdBy: 'a', priority: 'low' });
    const normalNew = makeTask(team, { title: 'nn', prompt: 'p', createdBy: 'a' });
    const highNew = makeTask(team, { title: 'hn', prompt: 'p', createdBy: 'a', priority: 'high' });
    const highOld = makeTask(team, { title: 'ho', prompt: 'p', createdBy: 'a', priority: 'high' });
    // makeTask 用同一 now？——显式改 createdAt 构造同秩次序：
    lowOld.createdAt = 100; normalNew.createdAt = 200; highNew.createdAt = 300; highOld.createdAt = 100;
    const board = [lowOld, normalNew, highNew, highOld];
    const sorted = sortTasksForBoard(board);
    expect(sorted.map((t) => t.title)).toEqual(['ho', 'hn', 'nn', 'lo']);
    expect(board.map((t) => t.title)).toEqual(['lo', 'nn', 'hn', 'ho']); // 入参不动
  });

  it('priorityRank：absent 归 normal（旧记录兼容）', () => {
    expect(priorityRank(undefined)).toBe(priorityRank('normal'));
    expect(priorityRank('high')).toBeLessThan(priorityRank(undefined));
    expect(priorityRank('low')).toBeGreaterThan(priorityRank('normal'));
  });
});

describe('v0.7.1 provisioning deadline 清扫（红队四番战 故障注-1）', () => {
  function member(overrides: Partial<import('./types.js').TeamMember>): import('./types.js').TeamMember {
    return { key: 'm', sessionId: '', role: 'worker', joinedAt: 1, lastSeen: 1, ...overrides };
  }

  it('provisionStaleAfterMs = 超时 + 60s 宽限（与 resolveReprovision 同口径）', () => {
    expect(provisionStaleAfterMs(1000)).toBe(61_000);
    expect(provisionStaleAfterMs(300_000)).toBe(360_000);
  });

  it('bootstrapTimeoutFromEnv：缺省/空/非有限正数 → 内置默认（V18 防御保留）', () => {
    expect(bootstrapTimeoutFromEnv({})).toBe(300_000);
    expect(bootstrapTimeoutFromEnv({ XC_MEMBER_BOOTSTRAP_TIMEOUT_MS: '' })).toBe(300_000);
    expect(bootstrapTimeoutFromEnv({ XC_MEMBER_BOOTSTRAP_TIMEOUT_MS: '0' })).toBe(300_000);
    expect(bootstrapTimeoutFromEnv({ XC_MEMBER_BOOTSTRAP_TIMEOUT_MS: 'abc' })).toBe(300_000);
    expect(bootstrapTimeoutFromEnv({ XC_MEMBER_BOOTSTRAP_TIMEOUT_MS: '45000' })).toBe(45_000);
  });

  it('过期 provisioning → failed + error + deadline 保留；未过期/其他态不动', () => {
    const team = setup();
    team.members.push(
      member({ key: 'stuck', state: 'provisioning', provisionedAt: 1000, provisionDeadlineAt: 61_000 }),
      member({ key: 'live', state: 'provisioning', provisionedAt: 1000, provisionDeadlineAt: 100_000 }),
      member({ key: 'ready', state: 'ready' }),
      member({ key: 'done', state: 'failed' }),
    );
    const swept = sweepStaleProvisioningLocked(team, 61_001, 61_000);
    expect(swept.map((s) => s.key)).toEqual(['stuck']);
    const byKey = Object.fromEntries(team.members.map((m) => [m.key, m]));
    expect(byKey['stuck'].state).toBe('failed');
    expect(byKey['stuck'].error).toMatch(/provisioning deadline exceeded/);
    expect(byKey['stuck'].provisionDeadlineAt).toBe(61_000);   // 判定依据保留（审计/复诊）
    expect(byKey['live'].state).toBe('provisioning');          // 未过期不动
    expect(byKey['ready'].state).toBe('ready');
    expect(byKey['done'].state).toBe('failed');
  });

  it('存量记录（无 deadline 字段）按 provisionedAt/joinedAt + 口径现算兜底', () => {
    const team = setup();
    team.members.push(
      member({ key: 'legacy-p', state: 'provisioning', provisionedAt: 1000 }),
      member({ key: 'legacy-j', state: 'provisioning', joinedAt: 5000 }),
    );
    expect(sweepStaleProvisioningLocked(team, 5000 + 60_000, 61_000).map((s) => s.key)).toEqual(['legacy-p']);
    expect(sweepStaleProvisioningLocked(team, 5000 + 61_001, 61_000).map((s) => s.key)).toEqual(['legacy-j']);
  });

  it('error 文案带重试指引且 ≤500 字符（与既有失败文案同族）', () => {
    const text = provisionTimeoutError(1000, 61_000, 60_000);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toMatch(/member-add/);
    expect(text).toMatch(/idempotent reprovision/);
  });
});

// ─────────────────── v0.7.2 C8-B2 修复：lastProgressTs 落盘与刷新 ───────────────────

describe('v0.7.2 C8-B2：lastProgressTs 落盘与更新点', () => {
  let dir: string;
  let root: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xc-teamstate-lpt-'));
    root = join(dir, '.crosschat');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('makeTask 建单即落 lastProgressTs（= createdAt/updatedAt）', () => {
    const team = newTeamState({ teamId: 'default', name: 'default', founderKey: 'lead', now: 5_000 });
    const t = makeTask(team, { title: 'x', prompt: 'p', createdBy: 'lead' }, 5_000);
    expect(t.lastProgressTs).toBe(5_000);
    expect(t.lastProgressTs).toBe(t.createdAt);
  });

  it('appendTaskHistory（唯一收口点）逐转移刷新 lastProgressTs，与 history 末条同值', () => {
    const team = newTeamState({ teamId: 'default', name: 'default', founderKey: 'lead', now: 5_000 });
    const t = makeTask(team, { title: 'x', prompt: 'p', createdBy: 'lead' }, 5_000);
    appendTaskHistory(t, 'created', 'lead', undefined, 6_000);
    expect(t.lastProgressTs).toBe(6_000);
    const attemptId = beginTaskAttempt(t, 'm1', 7_000);
    expect(t.lastProgressTs).toBe(7_000);
    expect(t.lastProgressTs).toBe(t.history[t.history.length - 1]!.ts);
    expect(attemptId).toBeTruthy();
    applyReport(t, { status: 'in_progress', attemptId }, 'm1', 8_000);
    expect(t.lastProgressTs).toBe(8_000);
    applyReport(t, { status: 'blocked', error: 'waiting', attemptId }, 'm1', 9_000);
    expect(t.lastProgressTs).toBe(9_000);
    expect(unblockTask(t, 10_000)).toBeUndefined();
    expect(t.lastProgressTs).toBe(10_000);
  });

  it('落盘 roundtrip：字段经 coerceTeamState 保留；非法值被宽容丢弃（不整文件拒绝）', async () => {
    const team = newTeamState({ teamId: 'default', name: 'default', founderKey: 'lead', now: 5_000 });
    const t = makeTask(team, { title: 'x', prompt: 'p', createdBy: 'lead' }, 5_000);
    appendTaskHistory(t, 'created', 'lead', undefined, 6_000);
    await writeTeam(root, team);
    const back = await readTeam(root, 'default');
    expect(back?.tasks[0]?.lastProgressTs).toBe(6_000);
    // 非法值（字符串/0/负数）→ 字段丢弃，记录仍可读（§11.1 宽容纪律）。
    const raw = JSON.parse(readFileSync(teamFile(root, 'default'), 'utf8'));
    raw.tasks[0].lastProgressTs = 'nope';
    writeFileSync(teamFile(root, 'default'), JSON.stringify(raw));
    const coerced = await readTeam(root, 'default');
    expect(coerced?.tasks[0]?.lastProgressTs).toBeUndefined();
    expect(coerced?.tasks[0]?.id).toBe(t.id);
  });
});
