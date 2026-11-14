/**
 * v0.6 C5 stall 单测（DESIGN-V0.6.md §3.5 / §4.2-M5）：停滞旗标、blocked-long 单列、
 * 阈值解析与钳制。纯函数驱动，now 全部注入（无时钟副作用）。
 */
import { describe, expect, it } from 'vitest';
import type { Task } from './types.js';
import { DEFAULT_STALL_MINUTES, lastProgressTs, stalledTasks, stallSuggestion, stallThresholdMs } from './stall.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'status'>): Task {
  return {
    title: `T ${overrides.id}`,
    prompt: 'P',
    dependsOn: [],
    assignee: null,
    attempt: 0,
    attemptId: null,
    createdBy: 'a',
    createdAt: NOW - 10 * MIN,
    updatedAt: NOW - 10 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [],
    ...overrides,
  } as Task;
}

describe('lastProgressTs（最后进展时刻）', () => {
  it('history 末条 ts 晚于 createdAt → 取末条', () => {
    const t = task({ id: 't1', status: 'in_progress' });
    t.history.push({ ts: NOW - 3 * MIN, event: 'in_progress', by: 'b' });
    expect(lastProgressTs(t)).toBe(NOW - 3 * MIN);
  });

  it('history 为空（旧记录）→ 退回 createdAt', () => {
    expect(lastProgressTs(task({ id: 't1', status: 'claimed' }))).toBe(NOW - 10 * MIN);
  });

  it('history 末条早于 createdAt（异常数据）→ 仍取 max（createdAt）', () => {
    const t = task({ id: 't1', status: 'pending', createdAt: NOW - 2 * MIN });
    t.history.push({ ts: NOW - 9 * MIN, event: 'weird', by: 'b' });
    expect(lastProgressTs(t)).toBe(NOW - 2 * MIN);
  });
});

describe('stalledTasks（停滞旗标，§3.5）', () => {
  it('非终态且 idle 严格大于阈值 → stalled（恰在阈值上不算）', () => {
    const threshold = 120 * MIN;
    const tasks = [
      task({ id: 't1', status: 'in_progress', createdAt: NOW - threshold - 1, updatedAt: NOW - threshold - 1 }),
      task({ id: 't2', status: 'in_progress', createdAt: NOW - threshold, updatedAt: NOW - threshold }), // 边界：不标
      task({ id: 't3', status: 'in_progress', createdAt: NOW - 30 * MIN, updatedAt: NOW - 30 * MIN }),
    ];
    expect(stalledTasks(tasks, NOW, threshold).map((f) => f.taskId)).toEqual(['t1']);
  });

  it('history 逐转移落 ts：末条刷新即不算停滞（无需新埋点）', () => {
    const t = task({ id: 't1', status: 'in_progress', createdAt: NOW - 200 * MIN, updatedAt: NOW - 200 * MIN });
    t.history.push({ ts: NOW - 200 * MIN, event: 'claimed', by: 'b' });
    t.history.push({ ts: NOW - 10 * MIN, event: 'in_progress', by: 'b' });
    expect(stalledTasks([t], NOW, 120 * MIN)).toEqual([]);
  });

  it('终态（completed/failed/cancelled）永不进旗标', () => {
    const tasks = [
      task({ id: 't1', status: 'completed', createdAt: NOW - 999 * MIN, updatedAt: NOW - 999 * MIN }),
      task({ id: 't2', status: 'failed', createdAt: NOW - 999 * MIN, updatedAt: NOW - 999 * MIN }),
      task({ id: 't3', status: 'cancelled', createdAt: NOW - 999 * MIN, updatedAt: NOW - 999 * MIN }),
    ];
    expect(stalledTasks(tasks, NOW, 120 * MIN)).toEqual([]);
  });

  it('blocked 未超阈不算 stalled（阻塞是显式状态）', () => {
    const t = task({
      id: 'tb', status: 'blocked', assignee: 'm1', blockedAt: NOW - 30 * MIN,
      createdAt: NOW - 200 * MIN, updatedAt: NOW - 30 * MIN,
    });
    expect(stalledTasks([t], NOW, 120 * MIN)).toEqual([]);
  });

  it('blocked 超阈 → blocked-long 单列，idleForMin 按 blockedAt 起算（建议行不同）', () => {
    const t = task({
      id: 'tb', status: 'blocked', assignee: 'm1', blockedAt: NOW - 130 * MIN,
      createdAt: NOW - 500 * MIN, updatedAt: NOW - 130 * MIN,
    });
    const flags = stalledTasks([t], NOW, 120 * MIN);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      taskId: 'tb', status: 'blocked', assignee: 'm1', idleForMin: 130, kind: 'blocked-long',
    });
  });

  it('blocked 缺 blockedAt（手工编辑/旧数据）→ 退回 lastProgress 判定', () => {
    const t = task({
      id: 'tb', status: 'blocked', assignee: 'm1',
      createdAt: NOW - 500 * MIN, updatedAt: NOW - 500 * MIN,
    });
    t.history.push({ ts: NOW - 500 * MIN, event: 'blocked', by: 'm1' });
    const flags = stalledTasks([t], NOW, 120 * MIN);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.kind).toBe('blocked-long');
    expect(flags[0]!.idleForMin).toBe(500);
  });

  it('pending 超阈 → stalled（建议行=检查依赖或 cancel）', () => {
    const t = task({ id: 'tp', status: 'pending', createdAt: NOW - 300 * MIN, updatedAt: NOW - 300 * MIN });
    const flags = stalledTasks([t], NOW, 120 * MIN);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ taskId: 'tp', status: 'pending', kind: 'stalled' });
  });

  it('行内字段齐全（taskId/title/status/assignee/idleForMin/kind）', () => {
    const t = task({ id: 't1', status: 'claimed', assignee: 'm2', createdAt: NOW - 61 * MIN, updatedAt: NOW - 61 * MIN });
    const flags = stalledTasks([t], NOW, 60 * MIN);
    expect(flags[0]).toEqual({
      taskId: 't1', title: 'T t1', status: 'claimed', assignee: 'm2', idleForMin: 61, kind: 'stalled',
    });
  });
});

describe('stallThresholdMs（XC_STALL_MINUTES 可配 + 钳制）', () => {
  it('缺省 120min（方案 C5「默认 2h，可配」）', () => {
    expect(DEFAULT_STALL_MINUTES).toBe(120);
    expect(stallThresholdMs({}, 30 * MIN)).toEqual({ ms: 120 * MIN, clamped: false });
  });

  it('非有限/非正数 env 取缺省（0/负数/NaN/字符串垃圾）', () => {
    for (const bad of ['0', '-5', 'abc', '']) {
      expect(stallThresholdMs({ XC_STALL_MINUTES: bad }, 30 * MIN).ms).toBe(120 * MIN);
    }
    expect(stallThresholdMs({ XC_STALL_MINUTES: 'NaN' }, 30 * MIN).ms).toBe(120 * MIN);
  });

  it('合法 env 生效（30min→30min；小数分钟允许）', () => {
    expect(stallThresholdMs({ XC_STALL_MINUTES: '30' }, 30 * MIN)).toEqual({ ms: 30 * MIN, clamped: false });
    expect(stallThresholdMs({ XC_STALL_MINUTES: '45.5' }, 30 * MIN).ms).toBe(45.5 * MIN);
  });

  it('小于 stale 阈值 → 钳到 stale 阈值并 clamped:true（否则 sweeper 先收走、stall 永不展示）', () => {
    expect(stallThresholdMs({ XC_STALL_MINUTES: '10' }, 30 * MIN)).toEqual({ ms: 30 * MIN, clamped: true });
    expect(stallThresholdMs({ XC_STALL_MINUTES: '29.9' }, 30 * MIN)).toEqual({ ms: 30 * MIN, clamped: true });
  });

  it('等于 stale 阈值不钳（剧本③ XC_STALL_MINUTES=30 的口径）', () => {
    expect(stallThresholdMs({ XC_STALL_MINUTES: '30' }, 30 * MIN)).toEqual({ ms: 30 * MIN, clamped: false });
  });

  it('大于 stale 阈值不钳（产品缺省 120 > stale 缺省 30）', () => {
    expect(stallThresholdMs({ XC_STALL_MINUTES: '200' }, 30 * MIN)).toEqual({ ms: 200 * MIN, clamped: false });
  });
});

describe('stallSuggestion（建议行，§3.5 呈现）', () => {
  it('blocked-long → 解除/取消；pending → 依赖/取消；claimed/in_progress → 催办/转交', () => {
    expect(stallSuggestion('blocked-long', 'blocked')).toBe('处理阻塞原因（xc_team unblock）或 cancel');
    expect(stallSuggestion('stalled', 'pending')).toBe('检查依赖或 cancel');
    expect(stallSuggestion('stalled', 'claimed')).toBe('relay 催办 / cancel / 重派（转交）');
    expect(stallSuggestion('stalled', 'in_progress')).toBe('relay 催办 / cancel / 重派（转交）');
  });
});
