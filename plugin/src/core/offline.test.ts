/**
 * v0.7（C8，DESIGN-V0.7.md §4.1 / AC7）core/offline.ts 单测：活性四态、离线判据、
 * 阈值解析与钳制。纯函数驱动，now 全部注入（无时钟副作用、无 IO、无定时器）。
 *
 * 覆盖 AC7 硬判据：四态判定 + 阈值可配且保守（240min 缺省、钳制 ≥ stale）+
 * **heartbeat-stale / no-record 不得判离线**（成员是回合制瞬态，空闲 ≠ 离线）。
 */
import { describe, expect, it } from 'vitest';
import { localPidDomain, peerRecordFile } from './peerdir.js';
import { writePeerRecord, type PeerRecord, type PeerScanResult } from './peerregistry.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeamMember, TeamState, Task } from './types.js';
import {
  DEFAULT_OFFLINE_MINUTES,
  memberLiveness,
  offlineMemberLine,
  offlineMembers,
  offlineSuggestion,
  offlineThresholdMsFromEnv,
  offlineVerdict,
  type MemberLiveness,
} from './offline.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const STALE_MS = 30 * MIN;
const OFFLINE_MS = 240 * MIN;

// ─────────────────────────── 夹具 ───────────────────────────

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

/** 只读扫描结果的记忆夹具（不落盘：memberLiveness 只吃 PeerScanResult）。 */
function scan(rows: { active?: PeerRecord[]; dead?: { record: PeerRecord; reason?: 'pid-dead' | 'lastSeen-stale' }[] } = {}): PeerScanResult {
  return { active: rows.active ?? [], dead: rows.dead ?? [], foreign: [], skipped: 0 };
}

/** 一条本机域的 peer 注册记录（lastSeen 默认由调用方给）。 */
function record(overrides: Partial<PeerRecord> & Pick<PeerRecord, 'pid' | 'sessionId' | 'lastSeen'>): PeerRecord {
  return {
    messagingSocketPath: '\\\\.\\pipe\\LOCAL\\xcc-msg-test',
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: 'bg',
    formerNames: [],
    startedAt: NOW - 60 * MIN,
    ...overrides,
  };
}

/** 本进程 pid：pidAlive 为真 → active 分区自洽。 */
const LIVE_PID = process.pid;
/** 一个确定不存在的 pid（进程死硬证据）。 */
const DEAD_PID = 2_147_483_646;

// ─────────────────────────── memberLiveness：活性四态 ───────────────────────────

describe('memberLiveness（活性四态，§4.1）', () => {
  it('active 有同 sid 记录且心跳保鲜 → live', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const s = scan({ active: [record({ pid: LIVE_PID, sessionId: 'sess_m1', lastSeen: NOW - 5_000 })] });
    expect(memberLiveness(m, s, NOW)).toBe('live');
  });

  it('active 记录在扫描后心跳过期（调用方 now 更晚）→ heartbeat-stale（不是死）', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const s = scan({ active: [record({ pid: LIVE_PID, sessionId: 'sess_m1', lastSeen: NOW - 10 * MIN })] });
    expect(memberLiveness(m, s, NOW)).toBe('heartbeat-stale');
  });

  it('dead 记录 reason=pid-dead → pid-dead（进程死硬证据）', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const s = scan({ dead: [{ record: record({ pid: DEAD_PID, sessionId: 'sess_m1', lastSeen: NOW - 60 * MIN }), reason: 'pid-dead' }] });
    expect(memberLiveness(m, s, NOW)).toBe('pid-dead');
  });

  it('dead 记录 reason=lastSeen-stale（pid 活着、心跳过期）→ heartbeat-stale（进程活着）', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const s = scan({ dead: [{ record: record({ pid: LIVE_PID, sessionId: 'sess_m1', lastSeen: NOW - 60 * MIN }), reason: 'lastSeen-stale' }] });
    expect(memberLiveness(m, s, NOW)).toBe('heartbeat-stale');
  });

  it('同 sid 多条死记录里有一条 pid 仍活 → 保守判 heartbeat-stale（不错判进程死）', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const s = scan({
      dead: [
        { record: record({ pid: DEAD_PID, sessionId: 'sess_m1', lastSeen: NOW - 90 * MIN }), reason: 'pid-dead' },
        { record: record({ pid: LIVE_PID, sessionId: 'sess_m1', lastSeen: NOW - 90 * MIN }), reason: 'lastSeen-stale' },
      ],
    });
    expect(memberLiveness(m, s, NOW)).toBe('heartbeat-stale');
  });

  it('死记录缺 reason（无硬证据）→ 保守判 heartbeat-stale', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const s = scan({ dead: [{ record: record({ pid: DEAD_PID, sessionId: 'sess_m1', lastSeen: NOW - 90 * MIN }) }] });
    expect(memberLiveness(m, s, NOW)).toBe('heartbeat-stale');
  });

  it('无任何记录（回合间隙 / 从未 peer 注册 / 优雅退出已摘记录）→ no-record', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    expect(memberLiveness(m, scan(), NOW)).toBe('no-record');
  });

  it('别人的 sid 记录不匹配本成员（按 sid 匹配，不按 peer 花名）', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const s = scan({
      active: [record({ pid: LIVE_PID, sessionId: 'sess_other', lastSeen: NOW, name: 'm1' })],
      dead: [{ record: record({ pid: DEAD_PID, sessionId: 'sess_other2', lastSeen: NOW - MIN }), reason: 'pid-dead' }],
    });
    expect(memberLiveness(m, s, NOW)).toBe('no-record');
  });
});

// ─────────────────────────── offlineVerdict：判据 ───────────────────────────

describe('offlineVerdict（离线判据，§4.1 判定规则）', () => {
  const m = member({ key: 'm1', sessionId: 'sess_m1' });

  it('pid-dead → 免空闲阈值：fresh 任务（无进展 1min）也判离线（进程死硬证据）', () => {
    const t = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - MIN, updatedAt: NOW - MIN });
    expect(offlineVerdict(t, m, 'pid-dead', NOW, OFFLINE_MS)).toEqual({ offline: true, evidence: 'process-dead' });
  });

  it('heartbeat-stale（活着但空闲）+ 任务未超阈 → 不判离线（空闲 ≠ 离线）', () => {
    const t = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - 10 * MIN, updatedAt: NOW - 10 * MIN });
    expect(offlineVerdict(t, m, 'heartbeat-stale', NOW, OFFLINE_MS)).toEqual({ offline: false, evidence: null });
  });

  it('no-record + 任务未超阈 → 不判离线（回合间隙不可检出，保守）', () => {
    const t = task({ id: 't1', status: 'claimed', assignee: 'm1', createdAt: NOW - 30 * MIN, updatedAt: NOW - 30 * MIN });
    expect(offlineVerdict(t, m, 'no-record', NOW, OFFLINE_MS)).toEqual({ offline: false, evidence: null });
  });

  it('live + 任务未超阈 → 不判离线', () => {
    const t = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - 200 * MIN, updatedAt: NOW - 200 * MIN });
    expect(offlineVerdict(t, m, 'live', NOW, OFFLINE_MS)).toEqual({ offline: false, evidence: null });
  });

  it('非硬证据态 + 任务无进展严格大于阈值 → idle-timeout 兜底', () => {
    const t = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - OFFLINE_MS - 1, updatedAt: NOW - OFFLINE_MS - 1 });
    expect(offlineVerdict(t, m, 'no-record', NOW, OFFLINE_MS)).toEqual({ offline: true, evidence: 'idle-timeout' });
  });

  it('恰在阈值上（= 240min）不算超时（严格大于，避免分钟取整 off-by-one）', () => {
    const t = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - OFFLINE_MS, updatedAt: NOW - OFFLINE_MS });
    expect(offlineVerdict(t, m, 'heartbeat-stale', NOW, OFFLINE_MS).offline).toBe(false);
  });

  it('无进展时刻取 history 末条（stall.lastProgressTs 语义复用：心跳刷新即不超时）', () => {
    const t = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - 300 * MIN, updatedAt: NOW - 300 * MIN });
    t.history.push({ ts: NOW - 5 * MIN, event: 'in_progress', by: 'm1' });
    expect(offlineVerdict(t, m, 'no-record', NOW, OFFLINE_MS).offline).toBe(false);
  });

  it('removed 成员（xc_member_stop 已回池留档）→ 永不判离线（「不在册」不是「离线」）', () => {
    const t = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - 600 * MIN, updatedAt: NOW - 600 * MIN });
    const removed = member({ key: 'm1', sessionId: 'sess_m1', state: 'removed' });
    expect(offlineVerdict(t, removed, 'pid-dead', NOW, OFFLINE_MS)).toEqual({ offline: false, evidence: null });
  });
});

// ─────────────────────────── offlineMembers：清单 ───────────────────────────

function teamOf(members: TeamMember[], tasks: Task[]): TeamState {
  return {
    teamId: 'default',
    name: 'default',
    founderKey: 'lead',
    phase: 'open',
    members,
    tasks,
    seq: tasks.length,
    createdAt: NOW - 60 * MIN,
  } as TeamState;
}

describe('offlineMembers（离线成员清单，§4.2 转交面）', () => {
  it('pid-dead 成员的全部非终态任务进清单（含 blocked：属主没了同样搁浅）', () => {
    const t1 = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - 2 * MIN, updatedAt: NOW - 2 * MIN });
    const t2 = task({ id: 't2', status: 'blocked', assignee: 'm1', createdAt: NOW - 4 * MIN, updatedAt: NOW - 4 * MIN });
    const done = task({ id: 't3', status: 'completed', assignee: 'm1', createdAt: NOW - 9 * MIN, updatedAt: NOW - 9 * MIN });
    const team = teamOf([member({ key: 'm1', sessionId: 'sess_m1' })], [t1, t2, done]);
    const s = scan({ dead: [{ record: record({ pid: DEAD_PID, sessionId: 'sess_m1', lastSeen: NOW - 60 * MIN }), reason: 'pid-dead' }] });
    const out = offlineMembers(team, s, NOW, OFFLINE_MS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'm1', liveness: 'pid-dead', evidence: 'process-dead', idleForMin: 4 });
    expect(out[0]!.tasks.map((x) => x.taskId)).toEqual(['t1', 't2']);
  });

  it('alive-idle 成员（heartbeat-stale，任务未超 240min）→ 不进清单（AC8 不误标）', () => {
    const t1 = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - 200 * MIN, updatedAt: NOW - 200 * MIN });
    const team = teamOf([member({ key: 'm1', sessionId: 'sess_m1' })], [t1]);
    const s = scan({ dead: [{ record: record({ pid: LIVE_PID, sessionId: 'sess_m1', lastSeen: NOW - 60 * MIN }), reason: 'lastSeen-stale' }] });
    expect(offlineMembers(team, s, NOW, OFFLINE_MS)).toEqual([]);
  });

  it('名下无任务的成员不进清单（没有可转交物）', () => {
    const team = teamOf([member({ key: 'm1', sessionId: 'sess_m1' })], []);
    const s = scan({ dead: [{ record: record({ pid: DEAD_PID, sessionId: 'sess_m1', lastSeen: NOW - 60 * MIN }), reason: 'pid-dead' }] });
    expect(offlineMembers(team, s, NOW, OFFLINE_MS)).toEqual([]);
  });

  it('idle-timeout 只列命中的任务：同成员的 fresh 任务不被建议重派', () => {
    const old = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - OFFLINE_MS - MIN, updatedAt: NOW - OFFLINE_MS - MIN });
    const fresh = task({ id: 't2', status: 'in_progress', assignee: 'm1', createdAt: NOW - MIN, updatedAt: NOW - MIN });
    const team = teamOf([member({ key: 'm1', sessionId: 'sess_m1' })], [old, fresh]);
    const out = offlineMembers(team, scan(), NOW, OFFLINE_MS);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toBe('idle-timeout');
    expect(out[0]!.tasks.map((x) => x.taskId)).toEqual(['t1']);
    expect(out[0]!.idleForMin).toBe(241);
  });

  it('任务认领人 = null（已回池）不挂到任何成员头上', () => {
    const t1 = task({ id: 't1', status: 'pending', assignee: null, createdAt: NOW - 600 * MIN, updatedAt: NOW - 600 * MIN });
    const team = teamOf([member({ key: 'm1', sessionId: 'sess_m1' })], [t1]);
    expect(offlineMembers(team, scan(), NOW, OFFLINE_MS)).toEqual([]);
  });
});

// ─────────────────────────── 阈值解析与钳制 ───────────────────────────

describe('offlineThresholdMsFromEnv（阈值可配且保守，AC7）', () => {
  it('缺省 240min（长于 stall 120 与 stale 30）', () => {
    expect(offlineThresholdMsFromEnv({}, STALE_MS)).toEqual({ ms: 240 * MIN, clamped: false });
    expect(DEFAULT_OFFLINE_MINUTES).toBe(240);
  });

  it('XC_OFFLINE_MINUTES 合法正值 → 采用', () => {
    expect(offlineThresholdMsFromEnv({ XC_OFFLINE_MINUTES: '360' }, STALE_MS)).toEqual({ ms: 360 * MIN, clamped: false });
  });

  it('非有限/非正/空白值 → 缺省 240min', () => {
    for (const raw of ['abc', '0', '-5', '   ', '']) {
      expect(offlineThresholdMsFromEnv({ XC_OFFLINE_MINUTES: raw }, STALE_MS)).toEqual({ ms: 240 * MIN, clamped: false });
    }
  });

  it('低于 stale 阈值 → 按 stale 钳制并返回 clamped（挂载面附 WARNING）', () => {
    expect(offlineThresholdMsFromEnv({ XC_OFFLINE_MINUTES: '5' }, STALE_MS)).toEqual({ ms: STALE_MS, clamped: true });
    expect(offlineThresholdMsFromEnv({ XC_OFFLINE_MINUTES: '30' }, STALE_MS)).toEqual({ ms: STALE_MS, clamped: false });
  });

  it('自定义大 stale 阈值（200min）+ 离线阈值 100min → 钳到 200min（30 < 阈值边界不被破坏）', () => {
    const bigStale = 200 * MIN;
    expect(offlineThresholdMsFromEnv({ XC_OFFLINE_MINUTES: '100' }, bigStale)).toEqual({ ms: bigStale, clamped: true });
  });
});

// ─────────────────────────── 文案（单源） ───────────────────────────

describe('offlineSuggestion / offlineMemberLine（转交建议与 overview 行）', () => {
  it('process-dead 建议重派；idle-timeout 建议重派或取消', () => {
    expect(offlineSuggestion('process-dead')).toContain('xc_dispatch');
    expect(offlineSuggestion('idle-timeout')).toContain('xc_team({action:"cancel"}');
  });

  it('overview 行格式：<名>(证据, 名下任务 n 个 → 建议 xc_dispatch 重派)', () => {
    const m = member({ key: 'm1', sessionId: 'sess_m1' });
    const t1 = task({ id: 't1', status: 'in_progress', assignee: 'm1', createdAt: NOW - MIN, updatedAt: NOW - MIN });
    const team = teamOf([m], [t1]);
    const s = scan({ dead: [{ record: record({ pid: DEAD_PID, sessionId: 'sess_m1', lastSeen: NOW - 60 * MIN }), reason: 'pid-dead' }] });
    const [only] = offlineMembers(team, s, NOW, OFFLINE_MS);
    expect(offlineMemberLine(only!)).toBe('m1(process-dead, 名下任务 1 个 → 建议 xc_dispatch 重派)');
  });
});

// ─────────────────────────── 与真 peer 注册表的接缝（扫描只读） ───────────────────────────

describe('memberLiveness × 真注册表扫描（scanPeers 只读，无清扫副作用）', () => {
  const dirs: string[] = [];
  function peerRoot(): string {
    const d = mkdtempSync(join(tmpdir(), 'xc-offline-'));
    dirs.push(d);
    mkdirSync(join(d, 'sessions'), { recursive: true });
    return d;
  }
  it('落一条 pid-dead 死记录 → 扫描后判 pid-dead；记录文件仍在（只读扫描不删）', async () => {
    const root = peerRoot();
    await writePeerRecord(root, record({ pid: DEAD_PID, sessionId: 'sess_m1', lastSeen: NOW - 60 * MIN, name: 'm1' }));
    const { scanPeers } = await import('./peerregistry.js');
    const scanned = await scanPeers(root, NOW, { sweep: false });
    expect(scanned.dead).toHaveLength(1);
    expect(scanned.dead[0]!.reason).toBe('pid-dead');
    expect(memberLiveness(member({ key: 'm1', sessionId: 'sess_m1' }), scanned, NOW)).toBe('pid-dead');
    // 只读扫描：死记录文件不得被删（查询路径无副作用）。
    const { existsSync } = await import('node:fs');
    expect(existsSync(peerRecordFile(root, DEAD_PID))).toBe(true);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
});

/** liveness 取值集合自检（防类型漂移后漏态）。 */
describe('MemberLiveness 取值集合', () => {
  it('四态齐全', () => {
    const all: MemberLiveness[] = ['live', 'pid-dead', 'heartbeat-stale', 'no-record'];
    expect(new Set(all).size).toBe(4);
  });
});
