/**
 * v0.9.5（A3/V094-14）：C8 离线转交面接 **pid 证据**定向测试（41-v095 方案 §一 组A A3）。
 *
 * 背景（40-v094验收.md §7.3.4 V094-14）：pid 证据只接进了 liveness 展示面与看门狗
 * 判死面，offlineMembers / task-edges 未接线——同一 payload 成员行 state:dead、
 * 任务行 claimed、members.offline:null 且无 Offline: 行（三面自相矛盾）。
 * 修法：offlineMembers 增 opts.sessionPidFor 注入面（与 liveness 同源：
 * deriveSessionPidEvidence 单一派生点 + pidAlive 探测），pid-dead 成员名下的 fresh
 * 任务免 240min 阈值直接命中 process-dead → 清单列出 + 转交建议。
 *
 * 方案验收原文：「dead 成员的 fresh 任务 → offlineMembers 列出 + 回池通知」。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveSessionPidEvidence, memberLiveness, offlineMemberLine, offlineMembers, offlineVerdict } from './offline.js';
import { readSession, writeSession } from './registry.js';
import { newTeamState, writeTeam } from './teamstate.js';
import { pidAlive } from './lock.js';
import type { Task, TeamState } from './types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-offline-v095a3-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 一个确定不存在的 pid（pidAlive → ESRCH → false）。 */
const DEAD_PID = 2_147_483_645;

const emptyScan = { active: [], dead: [], foreign: [], skipped: 0 } as Parameters<typeof memberLiveness>[1];

async function seedScenario(): Promise<{ team: TeamState; member: TeamState["members"][number] }> {
  const team = newTeamState({
    teamId: 'default',
    founderKey: 'a',
    now: 1,
    founder: { key: 'a', sessionId: 'sess_a', role: 'worker', joinedAt: 1, lastSeen: 1 },
  });
  const member: TeamState["members"][number] = { key: 'm1', sessionId: 'sess_m1', role: 'worker', joinedAt: 1, lastSeen: 1 };
  team.members.push(member);
  // fresh 任务（刚派 1 分钟，远未到 stale 30min / offline 240min 阈值）
  const freshTask: Task = {
    id: 't-fresh', title: 'T', prompt: 'P', dependsOn: [], status: 'in_progress',
    assignee: 'm1', attempt: 1, attemptId: 'atm-1', createdBy: 'a',
    createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000, lastProgressTs: Date.now() - 30_000,
    result: null, error: null, evidence: [], history: [],
  };
  team.tasks.push(freshTask);
  await writeTeam(dir, team);
  // 成员会话记录：崩溃形态（pid 已亡 + running 自述悬停）——SessionStart 钩子输出形状。
  await writeSession(dir, {
    sessionId: 'sess_m1', cwd: 'D:\\ws', startedAt: Date.now() - 3_600_000,
    lastSeen: Date.now() - 60_000, pid: DEAD_PID,
    liveness: 'running', livenessTs: Date.now() - 120_000,
  });
  return { team, member };
}

describe('v0.9.5 A3：offlineMembers 接 pid 证据（与 liveness 展示面同判据）', () => {
  it('【锚点】不注入 pid 证据（v0.9.4 旧接线）→ pid-dead 成员不进清单（复现 V094-14 矛盾面）', async () => {
    const { team } = await seedScenario();
    const liveness = memberLiveness(team.members[1]!, emptyScan, Date.now());
    expect(liveness).toBe('no-record'); // 无 pid 证据：判据不参与
    const listed = offlineMembers(team, emptyScan, Date.now(), 240 * 60_000);
    expect(listed).toEqual([]); // fresh 任务 + no-record → 不命中
  });

  it('【方案验收】注入 pid 证据 → dead 成员的 fresh 任务列出（process-dead 免 240min 阈值）+ 转交建议行', async () => {
    const { team } = await seedScenario();
    const member = team.members[1]!;
    const evidence = deriveSessionPidEvidence(await readSession(dir, 'sess_m1'), Date.now(), pidAlive);
    expect(evidence).toBeDefined();
    expect(evidence!.turnInProgress).toBe(true);
    expect(evidence!.alive).toBe(false);
    // liveness 与展示面同判据 → pid-dead
    expect(memberLiveness(member, emptyScan, Date.now(), { sessionPid: evidence })).toBe('pid-dead');
    // offlineMembers（overview 挂载用的同一入口）接 sessionPidFor → 列出
    const listed = offlineMembers(team, emptyScan, Date.now(), 240 * 60_000, {
      sessionPidFor: (m) => (m.key === 'm1' ? evidence : undefined),
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      key: 'm1',
      sessionId: 'sess_m1',
      liveness: 'pid-dead',
      evidence: 'process-dead',
    });
    expect(listed[0]!.tasks).toHaveLength(1);
    expect(listed[0]!.tasks[0]).toMatchObject({ taskId: 't-fresh', status: 'in_progress' });
    // 回池通知行（offlineMemberLine 单源文案）
    expect(offlineMemberLine(listed[0]!)).toContain('m1(process-dead');
    expect(offlineMemberLine(listed[0]!)).toContain('建议 xc_dispatch 重派');
  });

  it('offlineVerdict：pid-dead 免 240min 阈值（fresh 任务直接命中 process-dead）', async () => {
    const { team } = await seedScenario();
    const task: Task = team.tasks[0]!;
    const verdict = offlineVerdict(task, team.members[1]!, 'pid-dead', Date.now(), 240 * 60_000);
    expect(verdict).toEqual({ offline: true, evidence: 'process-dead' });
  });
});
