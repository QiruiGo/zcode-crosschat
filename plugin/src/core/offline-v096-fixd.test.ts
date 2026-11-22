/**
 * v0.9.6（组 D·A8/V095-21）定向测试：离线转交面的「待回池 + 回池时刻」统一口径。
 *
 * V095-21 实测（adv4-f0）：死亡成员的任务在 stale 清扫到期前是**冻结**的（仍
 * claimed/in_progress 挂在死者名下、不在待领池），而 overview 建议重派/文案称
 * 「名下任务已回池」——四面（板面 / Offline / handoff / 文案）互相矛盾。
 *
 * 本文件锁死 core/offline.ts 的三处单源：
 * - `OfflineTaskInfo.requeueAtMs`：opts.requeueStaleMs 注入后每个命中任务带
 *   `updatedAt + stale 阈值`（graph.staleTasks 同判据的预计回池时刻）；不注入 = 旧调用方
 *   零变化（字段缺席）。
 * - `offlineMemberLine`：带 requeueAtMs 时行内列「待回池 <taskId>@<ISO>」；不带时行格式
 *   逐字节不变（v0.9.5 行格式回归）。
 * - `offlineSuggestion('process-dead')`：不再谎称「名下任务已回池」——如实写「由 stale
 *   清扫按阈值自动回池 + 板面 requeueAtMs 时刻」。
 */
import { memberLiveness } from './offline.js';
import {
  offlineMemberLine,
  offlineMembers,
  offlineSuggestion,
  type OfflineMember,
} from './offline.js';
import { localPidDomain } from './peerdir.js';
import type { PeerRecord, PeerScanResult } from './peerregistry.js';
import type { Task, TeamMember, TeamState } from './types.js';
import { describe, expect, it } from 'vitest';

const MIN = 60_000;
const NOW = 1_732_231_200_000;
const STALE_MS = 30 * MIN;
const OFFLINE_MS = 240 * MIN;
const DEAD_PID = 2_147_483_646;

function member(overrides: Partial<TeamMember> & Pick<TeamMember, 'key' | 'sessionId'>): TeamMember {
  return { role: 'peer', joinedAt: NOW - 10 * MIN, lastSeen: NOW, ...overrides };
}

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'status' | 'assignee'>): Task {
  return {
    title: `T ${overrides.id}`,
    prompt: 'P',
    dependsOn: [],
    attempt: 1,
    attemptId: 'a1',
    createdBy: 'lead',
    createdAt: NOW - 10 * MIN,
    updatedAt: NOW - 10 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [],
    ...overrides,
  } as Task;
}

function scan(rows: { dead?: { record: PeerRecord; reason?: 'pid-dead' | 'lastSeen-stale' }[] } = {}): PeerScanResult {
  return { active: [], dead: rows.dead ?? [], foreign: [], skipped: 0 };
}

function record(overrides: Partial<PeerRecord> & Pick<PeerRecord, 'pid' | 'sessionId' | 'lastSeen'>): PeerRecord {
  return {
    messagingSocketPath: '\\\\.\\pipe\\LOCAL\\xcc-offline-fixd',
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: 'bg',
    formerNames: [],
    startedAt: NOW - 60 * MIN,
    ...overrides,
  };
}

function teamOf(members: TeamMember[], tasks: Task[]): TeamState {
  return {
    teamId: 'default',
    name: 't',
    founderKey: 'lead',
    phase: 'open',
    members,
    tasks,
    seq: tasks.length,
    createdAt: NOW,
  } as TeamState;
}

/** pid-dead 硬证据形态（与 C8 一致：注册记录死分区 reason=pid-dead）。 */
function deadScan(sid: string): PeerScanResult {
  return scan({ dead: [{ record: record({ pid: DEAD_PID, sessionId: sid, lastSeen: NOW - 60 * MIN }), reason: 'pid-dead' }] });
}

// ─────────────────────── requeueAtMs（待回池时刻） ───────────────────────

describe('offlineMembers 的 requeueStaleMs 注入面（V095-21 待回池时刻）', () => {
  it('【锚点】注入 stale 阈值 → pid-dead 属主的命中任务带 requeueAtMs = updatedAt + 阈值（graph.staleTasks 同判据）', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const updatedAt = NOW - 2 * MIN;
    const t1 = task({ id: 't1', status: 'in_progress', assignee: 'm1', updatedAt });
    const out = offlineMembers(teamOf([m], [t1]), deadScan('sess_m1'), NOW, OFFLINE_MS, {
      requeueStaleMs: STALE_MS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.tasks).toEqual([
      { taskId: 't1', title: 'T t1', status: 'in_progress', idleForMin: 10, requeueAtMs: updatedAt + STALE_MS },
    ]);
  });

  it('不注入（旧调用方）→ requeueAtMs 缺席（零变化回归）', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const t1 = task({ id: 't1', status: 'claimed', assignee: 'm1', updatedAt: NOW - 2 * MIN });
    const out = offlineMembers(teamOf([m], [t1]), deadScan('sess_m1'), NOW, OFFLINE_MS);
    expect(out[0]!.tasks[0]).toEqual({ taskId: 't1', title: 'T t1', status: 'claimed', idleForMin: 10 });
    expect(out[0]!.tasks[0]!.requeueAtMs).toBeUndefined();
  });

  it('多任务各带各自时刻（updatedAt 不同的任务回池时刻不同）', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const t1 = task({ id: 't1', status: 'in_progress', assignee: 'm1', updatedAt: NOW - 1 * MIN });
    const t2 = task({ id: 't2', status: 'claimed', assignee: 'm1', updatedAt: NOW - 20 * MIN });
    const out = offlineMembers(teamOf([m], [t1, t2]), deadScan('sess_m1'), NOW, OFFLINE_MS, {
      requeueStaleMs: STALE_MS,
    });
    const byId = new Map(out[0]!.tasks.map((t) => [t.taskId, t.requeueAtMs]));
    expect(byId.get('t1')).toBe(NOW - 1 * MIN + STALE_MS);
    expect(byId.get('t2')).toBe(NOW - 20 * MIN + STALE_MS);
  });

  it('memberLiveness 仍从本模块出口（判死判据不受注入面影响）', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    expect(memberLiveness(m, deadScan('sess_m1'), NOW)).toBe('pid-dead');
  });
});

// ─────────────────────── offlineMemberLine（行格式） ───────────────────────

describe('offlineMemberLine 的待回池标注（V095-21）', () => {
  const m: OfflineMember = {
    key: 'm1',
    sessionId: 'sess_m1',
    liveness: 'pid-dead',
    evidence: 'process-dead',
    idleForMin: 2,
    tasks: [{ taskId: 't1', title: 'T t1', status: 'in_progress', idleForMin: 10 }],
  };

  it('不带 requeueAtMs → 行格式逐字节不变（v0.9.5 回归）', () => {
    expect(offlineMemberLine(m)).toBe('m1(process-dead, 名下任务 1 个 → 建议 xc_dispatch 重派)');
  });

  it('【锚点】带 requeueAtMs → 行内列「待回池 <taskId>@<ISO 时刻>」', () => {
    const requeueAtMs = NOW + STALE_MS;
    const line = offlineMemberLine({
      ...m,
      tasks: [{ taskId: 't1', title: 'T t1', status: 'in_progress', idleForMin: 10, requeueAtMs }],
    });
    expect(line).toBe(
      `m1(process-dead, 名下任务 1 个：待回池 t1@${new Date(requeueAtMs).toISOString()} → 建议 xc_dispatch 重派)`,
    );
  });

  it('多任务逐条列时刻；部分任务带时刻（豁免滞留形态）→ 不标注（宁缺勿假，不混排）', () => {
    const requeueAtMs = NOW + STALE_MS;
    const both = offlineMemberLine({
      ...m,
      tasks: [
        { taskId: 't1', title: 'T t1', status: 'in_progress', idleForMin: 10, requeueAtMs },
        { taskId: 't2', title: 'T t2', status: 'claimed', idleForMin: 10, requeueAtMs: NOW + 2 * STALE_MS },
      ],
    });
    expect(both).toContain('t1@' + new Date(requeueAtMs).toISOString());
    expect(both).toContain('t2@' + new Date(NOW + 2 * STALE_MS).toISOString());
    const partial = offlineMemberLine({
      ...m,
      tasks: [
        { taskId: 't1', title: 'T t1', status: 'in_progress', idleForMin: 10, requeueAtMs },
        { taskId: 't2', title: 'T t2', status: 'claimed', idleForMin: 10 }, // 豁免滞留：无时刻
      ],
    });
    expect(partial).toBe('m1(process-dead, 名下任务 2 个 → 建议 xc_dispatch 重派)');
  });
});

// ─────────────────────── offlineSuggestion（文案单源） ───────────────────────

describe('offlineSuggestion 的诚实化（V095-21 文案面）', () => {
  it('process-dead：不再谎称「名下任务已回池」——改写自动回池机制 + requeueAtMs 指针', () => {
    const text = offlineSuggestion('process-dead');
    expect(text).not.toContain('名下任务已回池');
    expect(text).toContain('自动回池');
    expect(text).toContain('requeueAtMs');
    expect(text).toContain('xc_dispatch');
  });

  it('idle-timeout 文案不变（原口径）', () => {
    expect(offlineSuggestion('idle-timeout')).toContain('xc_team({action:"cancel"}');
  });
});
