import { describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  coerceTeamState,
  isTeamMessage,
  transitionError,
  type Task,
} from './types.js';

/** The DESIGN.md §2.6 transition table, transcribed verbatim for cross-check. */
const DESIGN_TRANSITIONS: Record<string, string[]> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

describe('TASK_TRANSITIONS', () => {
  it('matches the DESIGN §2.6 table edge by edge (dsh state.js:115-122 port)', () => {
    expect(TASK_TRANSITIONS).toEqual(DESIGN_TRANSITIONS);
  });

  it('allows every documented edge', () => {
    expect(transitionError('pending', 'claimed')).toBeUndefined();
    expect(transitionError('pending', 'cancelled')).toBeUndefined();
    expect(transitionError('claimed', 'in_progress')).toBeUndefined();
    expect(transitionError('claimed', 'failed')).toBeUndefined();
    expect(transitionError('in_progress', 'completed')).toBeUndefined();
    expect(transitionError('in_progress', 'failed')).toBeUndefined();
  });

  it('rejects illegal transitions (状态机非法转移拒绝)', () => {
    // dsh semantics: claimed must go through in_progress before completed.
    expect(transitionError('claimed', 'completed')).toBeDefined();
    expect(transitionError('pending', 'completed')).toBeDefined();
    expect(transitionError('pending', 'in_progress')).toBeDefined();
    expect(transitionError('pending', 'failed')).toBeDefined();
    expect(transitionError('claimed', 'pending')).toBeDefined();
    expect(transitionError('in_progress', 'claimed')).toBeDefined();
    expect(transitionError('in_progress', 'pending')).toBeDefined();
  });

  it('terminal states have no outgoing transitions', () => {
    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      expect(TASK_TRANSITIONS[terminal]).toEqual([]);
      for (const next of TASK_STATUSES) {
        if (next !== terminal) expect(transitionError(terminal, next)).toBeDefined();
      }
    }
  });

  it('same-status is not an error (dsh transitionError semantics)', () => {
    expect(transitionError('claimed', 'claimed')).toBeUndefined();
  });
});

describe('isTeamMessage', () => {
  const base = {
    id: 'm1', from: 'a', to: 'b', content: 'hi', ts: 1762660000000,
  };

  it('accepts the DESIGN §2.4 example shape (with null lifecycle fields)', () => {
    expect(isTeamMessage({
      ...base,
      taskId: 't1', attemptId: 'att-2', sourceTaskId: 't1', sourceAttemptId: 'att-1',
      sourceTaskStatus: 'in_progress',
      deliveryClaimedAt: 1762660000000, deliveredAt: 1762660001000,
      readAt: null, discardedAt: null,
    })).toBe(true);
  });

  it('accepts the minimal shape', () => {
    expect(isTeamMessage(base)).toBe(true);
  });

  it('rejects broken shapes', () => {
    expect(isTeamMessage(null)).toBe(false);
    expect(isTeamMessage('nope')).toBe(false);
    expect(isTeamMessage({ ...base, ts: 'x' })).toBe(false);
    expect(isTeamMessage({ ...base, id: '' })).toBe(false);
    expect(isTeamMessage({ ...base, readAt: 'soon' })).toBe(false);
    expect(isTeamMessage({ ...base, sourceTaskStatus: 'wat' })).toBe(false);
    expect(isTeamMessage({ ...base, deliveredAt: Infinity })).toBe(false);
  });
});

function sampleTeam(): unknown {
  return {
    teamId: 'default', name: 'default', founderKey: 'a', phase: 'open',
    members: [{ key: 'a', sessionId: 'sess_a', role: 'peer', joinedAt: 1, lastSeen: 2 }],
    tasks: [{
      id: 't1', title: '计算 17*23', prompt: 'p', acceptance: '文件内容 391', dependsOn: [],
      status: 'pending', assignee: null, attempt: 0, attemptId: null,
      createdBy: 'a', createdAt: 1, updatedAt: 1, result: null, error: null,
      evidence: [], history: [],
    }],
    seq: 1, createdAt: 1,
  };
}

describe('coerceTeamState', () => {
  it('accepts the DESIGN §2.6 team.json shape', () => {
    const parsed = coerceTeamState(sampleTeam(), 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.tasks[0]!.id).toBe('t1');
      expect(parsed.state.tasks[0]!.assignee).toBeNull();
      expect(parsed.state.members[0]!.role).toBe('peer');
    }
  });

  it('normalizes missing optional fields', () => {
    const team = sampleTeam() as Record<string, unknown>;
    delete team['phase'];
    const parsed = coerceTeamState(team, 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.state.phase).toBe('open');
  });

  it('rejects a teamId mismatch with a diagnostic', () => {
    const parsed = coerceTeamState(sampleTeam(), 'other');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.defect).toContain('teamId');
  });

  it('rejects broken members/tasks with a diagnostic (坏数据抛诊断不进内存)', () => {
    const team = sampleTeam() as Record<string, unknown>;
    (team['members'] as unknown[]).push({ key: '' });
    const parsed = coerceTeamState(team, 'default');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.defect).toContain('member');
  });

  it('rejects duplicate member keys and task ids', () => {
    const team = sampleTeam() as Record<string, unknown>;
    (team['members'] as unknown[]).push({ key: 'a', sessionId: 'x', role: 'peer', joinedAt: 1, lastSeen: 1 });
    expect(coerceTeamState(team, 'default').ok).toBe(false);
    const team2 = sampleTeam() as Record<string, unknown>;
    const firstTask = (team2['tasks'] as Record<string, unknown>[])[0]!;
    (team2['tasks'] as unknown[]).push({ ...firstTask });
    expect(coerceTeamState(team2, 'default').ok).toBe(false);
  });

  it('rejects invalid evidence entries', () => {
    const team = sampleTeam() as Record<string, unknown>;
    const task = (team['tasks'] as Record<string, unknown>[])[0]!;
    task['evidence'] = [{ sha256: 'aa' }]; // missing path
    expect(coerceTeamState(team, 'default').ok).toBe(false);
  });

  it('coerces a legacy task without attempt/history/dependsOn', () => {
    const team = sampleTeam() as Record<string, unknown>;
    const task = (team['tasks'] as Record<string, unknown>[])[0]! as Record<string, unknown>;
    delete task['dependsOn'];
    delete task['history'];
    const parsed = coerceTeamState(team, 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.state.tasks[0] as Task).dependsOn).toEqual([]);
      expect((parsed.state.tasks[0] as Task).history).toEqual([]);
      expect(parsed.state.seq).toBe(1); // seq present in the sample: kept as-is
    }
  });
});
