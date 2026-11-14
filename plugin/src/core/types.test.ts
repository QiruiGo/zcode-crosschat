import { describe, expect, it } from 'vitest';
import {
  MEMBER_IDENTITIES,
  MEMBER_STATES,
  OPEN_TASK_STATUSES,
  SWEEPABLE_TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_PRIORITY_RANK,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  coerceNameBindings,
  coerceTeamState,
  isTeamMessage,
  normalizeMessage,
  memberIdentity,
  memberState,
  transitionError,
  type Task,
} from './types.js';

/**
 * The DESIGN.md §2.6 transition table, transcribed verbatim for cross-check.
 * v0.6（C2，DESIGN-V0.6.md §3.2）扩为七态：claimed/in_progress 增 blocked 出边、
 * 新增 blocked 行（pending 无 blocked 入边——L-n3 死边；blocked→failed 故意无此边）。
 */
const DESIGN_TRANSITIONS: Record<string, string[]> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'blocked', 'failed', 'cancelled'],
  in_progress: ['completed', 'blocked', 'failed', 'cancelled'],
  blocked: ['pending', 'claimed', 'in_progress', 'cancelled'],
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

// ---------------------------------------------------------------------------
// v0.2 member-engine schema (DESIGN-V0.2.md §9.1 W2: state/identity/
// provisionedAt/stopReason/leadKey/issuedBy — all optional, legacy compatible)
// ---------------------------------------------------------------------------

describe('v0.2 member schema', () => {
  it('keeps every v0.1.0 state enum/identity value', () => {
    expect(MEMBER_STATES).toEqual(['provisioning', 'ready', 'failed', 'removed']);
    expect(MEMBER_IDENTITIES).toEqual(['self', 'engine']);
  });

  it('accepts the v0.1.0 member record unchanged (legacy peer, §6.5)', () => {
    const team = sampleTeam();
    const parsed = coerceTeamState(team, 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const member = parsed.state.members[0]!;
      expect(member.state).toBeUndefined();
      expect(member.identity).toBeUndefined();
      expect(memberState(member)).toBe('ready'); // legacy default
      expect(memberIdentity(member)).toBe('self'); // legacy default
      expect(parsed.state.leadKey).toBeUndefined();
    }
  });

  it('accepts engine-provisioned records with all v0.2 fields', () => {
    const team = sampleTeam() as Record<string, unknown>;
    team['leadKey'] = 'a';
    (team['members'] as unknown[]).push({
      key: 'm1', sessionId: 'sess_m1', role: 'worker', joinedAt: 3, lastSeen: 4,
      state: 'provisioning', identity: 'engine', provisionedAt: 3,
    });
    const parsed = coerceTeamState(team, 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.leadKey).toBe('a');
      const m1 = parsed.state.members[1]!;
      expect(m1.state).toBe('provisioning');
      expect(m1.identity).toBe('engine');
      expect(m1.provisionedAt).toBe(3);
    }
  });

  it('keeps failed/stopReason/error fields through the durable boundary', () => {
    const team = sampleTeam() as Record<string, unknown>;
    (team['members'] as unknown[]).push({
      key: 'm2', sessionId: '', role: 'worker', joinedAt: 5, lastSeen: 6,
      state: 'failed', identity: 'engine', error: 'create: no sessionId',
    });
    const team2 = sampleTeam() as Record<string, unknown>;
    (team2['members'] as unknown[]).push({
      key: 'm3', sessionId: 'sess_m3', role: 'worker', joinedAt: 7, lastSeen: 8,
      state: 'removed', identity: 'engine', stopReason: 'lead requested shutdown',
    });
    for (const t of [team, team2]) {
      const parsed = coerceTeamState(t, 'default');
      expect(parsed.ok).toBe(true);
    }
    const parsed = coerceTeamState(team, 'default');
    if (parsed.ok) expect(parsed.state.members[1]!.error).toBe('create: no sessionId');
  });

  it('rejects unknown state/identity values (strict enum at the boundary)', () => {
    const team = sampleTeam() as Record<string, unknown>;
    (team['members'] as unknown[]).push({
      key: 'm9', sessionId: 'x', role: 'worker', joinedAt: 1, lastSeen: 1, state: 'zombie',
    });
    const parsed = coerceTeamState(team, 'default');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.defect).toContain('member');
  });

  it('tolerates the removed member sessionId="" record (provisioning slot)', () => {
    const team = sampleTeam() as Record<string, unknown>;
    (team['members'] as unknown[]).push({
      key: 'm4', sessionId: '', role: 'worker', joinedAt: 9, lastSeen: 9, state: 'provisioning',
    });
    expect(coerceTeamState(team, 'default').ok).toBe(true);
  });
});

describe('coerceNameBindings v0.2 issuedBy', () => {
  it('accepts the v0.1.0 binding shape unchanged', () => {
    const parsed = coerceNameBindings({ m1: { sessionId: 'sess_1', role: 'worker', registeredAt: 1 } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bindings['m1']!.issuedBy).toBeUndefined();
  });

  it('accepts the engine pre-binding with issuedBy (§6.1 step 6)', () => {
    const parsed = coerceNameBindings({
      m1: { sessionId: 'sess_1', role: 'worker', registeredAt: 1, issuedBy: 'engine' },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bindings['m1']!.issuedBy).toBe('engine');
  });

  it('rejects an unknown issuedBy value', () => {
    const parsed = coerceNameBindings({
      m1: { sessionId: 'sess_1', role: 'worker', registeredAt: 1, issuedBy: 'ghost' },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.defect).toContain('issuedBy');
  });
});

// ---------------------------------------------------------------------------
// v0.5 M1 schema（DESIGN-V0.5.md §6.3-2）：leadSince/leadHistory/contextChars/
// TeamMessage origin 三字段——宽容解析，旧记录零破坏（验收 A1e/A2f 单测化）。
// ---------------------------------------------------------------------------

describe('v0.5 TeamState leadSince/leadHistory（R-6）', () => {
  it('旧文件（无 leadSince/leadHistory）照常解析（宽容读取）', () => {
    const parsed = coerceTeamState(sampleTeam(), 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.leadSince).toBeUndefined();
      expect(parsed.state.leadHistory).toBeUndefined();
    }
  });

  it('合法 leadSince/leadHistory 读取进 state', () => {
    const team = { ...(sampleTeam() as Record<string, unknown>), leadKey: 'm1', leadSince: 42, leadHistory: [
      { event: 'set', from: null, to: 'm1', ts: 42 },
    ] };
    const parsed = coerceTeamState(team, 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.leadSince).toBe(42);
      expect(parsed.state.leadHistory).toEqual([{ event: 'set', from: null, to: 'm1', ts: 42 }]);
    }
  });

  it('坏条目（event 枚举外/ts 非数字/缺 from 或 to）整条丢弃不拒文件', () => {
    const team = { ...(sampleTeam() as Record<string, unknown>), leadHistory: [
      { event: 'set', from: null, to: 'm1', ts: 1 },
      { event: 'explode', from: null, to: 'm1', ts: 2 },   // 枚举外
      { event: 'transfer', from: 'm1', to: 'm2' },          // 缺 ts
      { event: 'release', from: 'm1', to: null, ts: 'x' },  // ts 非数字
      { event: 'set', to: 'm1', ts: 3 },                     // 缺 from
      'garbage',                                             // 非对象
      { event: 'transfer', from: 'm1', to: 'm2', ts: 4, reason: '验收' },
    ] };
    const parsed = coerceTeamState(team, 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.leadHistory).toEqual([
        { event: 'set', from: null, to: 'm1', ts: 1 },
        { event: 'transfer', from: 'm1', to: 'm2', ts: 4, reason: '验收' },
      ]);
    }
  });

  it('超 32 条取尾部 32（MAX_LEAD_HISTORY FIFO）', () => {
    const leadHistory = Array.from({ length: 40 }, (_, i) => ({
      event: 'transfer' as const, from: `m${i}`, to: `m${i + 1}`, ts: i,
    }));
    const parsed = coerceTeamState({ ...(sampleTeam() as Record<string, unknown>), leadHistory }, 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.leadHistory).toHaveLength(32);
      expect(parsed.state.leadHistory![0]).toEqual({ event: 'transfer', from: 'm8', to: 'm9', ts: 8 });
      expect(parsed.state.leadHistory![31]).toEqual({ event: 'transfer', from: 'm39', to: 'm40', ts: 39 });
    }
  });

  it('leadHistory 非数组 → undefined（不拒文件）', () => {
    const parsed = coerceTeamState({ ...(sampleTeam() as Record<string, unknown>), leadHistory: 'nope' }, 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.state.leadHistory).toBeUndefined();
  });
});

describe('v0.5 TeamMember.contextChars（R-18 声明值）', () => {
  it('正整数读取；旧记录缺省照读', () => {
    const team = sampleTeam() as Record<string, unknown>;
    (team['members'] as unknown[]).push(
      { key: 'm2', sessionId: 's2', role: 'worker', joinedAt: 1, lastSeen: 1, contextChars: 50000 },
    );
    const parsed = coerceTeamState(team, 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.members[1]!.contextChars).toBe(50000);
      expect(parsed.state.members[0]!.contextChars).toBeUndefined();
    }
  });

  it('非正整数（0/负数/小数/字符串）按 absent 处理（宽容）', () => {
    for (const bad of [0, -1, 1.5, '50000', Number.NaN]) {
      const team = sampleTeam() as Record<string, unknown>;
      (team['members'] as unknown[]).push(
        { key: 'm2', sessionId: 's2', role: 'worker', joinedAt: 1, lastSeen: 1, contextChars: bad },
      );
      const parsed = coerceTeamState(team, 'default');
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.state.members[1]!.contextChars).toBeUndefined();
    }
  });
});

describe('v0.5 TeamMessage origin 三字段（R-11）', () => {
  it('旧记录（无 origin 字段）isTeamMessage 照读', () => {
    const message = { id: 'x1', from: 'a', to: 'b', content: 'hi', ts: 1 };
    expect(isTeamMessage(message)).toBe(true);
    expect(normalizeMessage(message).origin).toBeUndefined();
  });

  it('origin=user/agent、originSessionId、forged 宽容拷贝', () => {
    const message = {
      id: 'x1', from: 'a', to: 'b', content: 'hi', ts: 1,
      origin: 'user' as const, originSessionId: 'sess-a', forged: true,
    };
    expect(isTeamMessage(message)).toBe(true);
    const normalized = normalizeMessage(message);
    expect(normalized.origin).toBe('user');
    expect(normalized.originSessionId).toBe('sess-a');
    expect(normalized.forged).toBe(true);
  });

  it('origin 非法取值整行拒绝（sourceTaskStatus 枚举同款纪律）', () => {
    const message = { id: 'x1', from: 'a', to: 'b', content: 'hi', ts: 1, origin: 'banana' };
    expect(isTeamMessage(message)).toBe(false);
  });

  it('originSessionId 非字符串 / forged 非布尔拒绝', () => {
    expect(isTeamMessage({ id: 'x', from: 'a', to: 'b', content: '', ts: 1, originSessionId: 5 })).toBe(false);
    expect(isTeamMessage({ id: 'x', from: 'a', to: 'b', content: '', ts: 1, forged: 'yes' })).toBe(false);
  });

  it('normalizeMessage 把非法 origin 归 absent（宽容归一）', () => {
    const raw = { id: 'x', from: 'a', to: 'b', content: '', ts: 1, origin: 'user' as const, forged: false };
    const normalized = normalizeMessage(raw);
    expect(normalized.origin).toBe('user');
    expect(normalized.forged).toBe(false);
    expect(normalized.originSessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// v0.6 C2/C1 schema（DESIGN-V0.6.md §3.2/§4.2-M2）：七态状态机、SWEEPABLE 口径、
// 优先级枚举、Task blocked/priority 字段与 TeamMessage.urgent——宽容读取，旧六态
// 记录零破坏（§6-4 迁移兼容）。
// ---------------------------------------------------------------------------

describe('v0.6 C2 七态状态机（blocked）', () => {
  it('TASK_STATUSES 恰为七态且 blocked 在 claimed/in_progress 之后', () => {
    expect(TASK_STATUSES).toEqual([
      'pending', 'claimed', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled',
    ]);
  });

  it('blocked 的全部合法出边（回 preBlockedStatus / 防御回池 / cancel）', () => {
    expect(transitionError('blocked', 'claimed')).toBeUndefined();
    expect(transitionError('blocked', 'in_progress')).toBeUndefined();
    expect(transitionError('blocked', 'pending')).toBeUndefined(); // 防御兜底边
    expect(transitionError('blocked', 'cancelled')).toBeUndefined();
  });

  it('pending→blocked 是死边（L-n3：blocked 唯一入口=认领者 report，pending 无 attempt）', () => {
    expect(transitionError('pending', 'blocked')).toBeDefined();
  });

  it('blocked→failed/completed 拒绝（阻塞中放弃先自解再 failed，或走 cancel）', () => {
    expect(transitionError('blocked', 'failed')).toBeDefined();
    expect(transitionError('blocked', 'completed')).toBeDefined();
  });

  it('claimed/in_progress → blocked 合法（认领者显式申报的唯一入口）', () => {
    expect(transitionError('claimed', 'blocked')).toBeUndefined();
    expect(transitionError('in_progress', 'blocked')).toBeUndefined();
  });

  it('OPEN 含 blocked（单开槽位/可撤销域）；SWEEPABLE 不含（清扫豁免）且窄于 OPEN', () => {
    expect(OPEN_TASK_STATUSES).toEqual(['claimed', 'in_progress', 'blocked']);
    expect(SWEEPABLE_TASK_STATUSES).toEqual(['claimed', 'in_progress']);
    for (const s of SWEEPABLE_TASK_STATUSES) expect(OPEN_TASK_STATUSES).toContain(s);
    expect(OPEN_TASK_STATUSES.length).toBeGreaterThan(SWEEPABLE_TASK_STATUSES.length);
  });
});

describe('v0.6 C2 优先级枚举（排序建议，非抢占）', () => {
  it('TASK_PRIORITIES 恰为 high/normal/low；秩 high<normal<low', () => {
    expect(TASK_PRIORITIES).toEqual(['high', 'normal', 'low']);
    expect(TASK_PRIORITY_RANK['high']).toBeLessThan(TASK_PRIORITY_RANK['normal']);
    expect(TASK_PRIORITY_RANK['normal']).toBeLessThan(TASK_PRIORITY_RANK['low']);
  });
});

describe('v0.6 C2 Task 新字段宽容读取（§6-4 迁移垫片）', () => {
  function taskWith(extra: Record<string, unknown>): Record<string, unknown> {
    const team = sampleTeam() as Record<string, unknown>;
    const task = (team['tasks'] as Record<string, unknown>[])[0]!;
    Object.assign(task, extra);
    return team;
  }

  it('v0.5.3 六态旧记录（无新字段）照常解析，新字段全 absent', () => {
    const parsed = coerceTeamState(sampleTeam(), 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const task = parsed.state.tasks[0]!;
      expect(task.priority).toBeUndefined();
      expect(task.blockedReason).toBeUndefined();
      expect(task.blockedAt).toBeUndefined();
      expect(task.preBlockedStatus).toBeUndefined();
    }
  });

  it('合法新字段（priority/blockedReason/blockedAt/preBlockedStatus）读写无损', () => {
    const parsed = coerceTeamState(taskWith({
      status: 'blocked', priority: 'high', blockedReason: '等待输入',
      blockedAt: 42, preBlockedStatus: 'in_progress',
    }), 'default');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const task = parsed.state.tasks[0]!;
      expect(task.status).toBe('blocked');
      expect(task.priority).toBe('high');
      expect(task.blockedReason).toBe('等待输入');
      expect(task.blockedAt).toBe(42);
      expect(task.preBlockedStatus).toBe('in_progress');
    }
  });

  it('非法新字段值丢弃、不拒文件（宽容纪律，不丢/不崩）', () => {
    for (const extra of [
      { priority: 'banana' },
      { priority: 3 },
      { blockedReason: 42 },
      { blockedAt: 'x' },
      { preBlockedStatus: 'banana' },
      { preBlockedStatus: null },
    ]) {
      const parsed = coerceTeamState(taskWith(extra), 'default');
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const task = parsed.state.tasks[0]! as unknown as Record<string, unknown>;
        for (const key of ['priority', 'blockedReason', 'blockedAt', 'preBlockedStatus']) {
          expect(task[key]).toBeUndefined();
        }
      }
    }
  });
});

describe('v0.6 C1 TeamMessage.urgent（读取面 urgent-first 的排序键）', () => {
  const base = { id: 'x1', from: 'a', to: 'b', content: 'hi', ts: 1 };

  it('urgent=true/false 读入并经 normalizeMessage 保留；缺省照读', () => {
    expect(isTeamMessage({ ...base, urgent: true })).toBe(true);
    expect(normalizeMessage({ ...base, urgent: true }).urgent).toBe(true);
    expect(normalizeMessage({ ...base, urgent: false }).urgent).toBe(false);
    expect(isTeamMessage(base)).toBe(true);
    expect(normalizeMessage(base).urgent).toBeUndefined();
  });

  it('urgent 非布尔整行拒绝（forged 同款纪律）', () => {
    expect(isTeamMessage({ ...base, urgent: 'yes' })).toBe(false);
    expect(isTeamMessage({ ...base, urgent: 1 })).toBe(false);
  });
});
