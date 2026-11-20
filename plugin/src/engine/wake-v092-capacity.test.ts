/**
 * v0.9.2 组 C（容量闸与观测口径）定向测试——`34-v091验收.md` 五条 mustFix 的修复面：
 * V091-13（C1 进程归类）/ V091-14（C2 degraded 披露）/ V091-15（C3 冷却键分域+上钳）/
 * V091-19（C3 窗内沿用明示）/ V091-18（C5 gateEnv 原值）。
 *
 * 覆盖面：
 * - C1 spawnResume 给唤醒子注入 `XC_WAKE_CHILD=1`（direct/helper 两形态）；
 *   attemptWake 交给 spawn 的 prompt 带唤醒回执标记（CIM 可见的同族证据）→
 *   classifyProcess 判 headless-turn；README 文档化的用户 CLI 不带标记 → main（不再误伤）；
 * - C2 degraded 样本**放行路径**也落 `wake-capacity-degraded`（进程类规则未评，不静默）；
 *   持续降级只披露一次、恢复后重新披露；判红路径 detail 仍带降级声明；
 * - C3 冷却键分域（teamId+收方+紧急度）：一个成员的 RED 不挡别人、不挡紧急 relay；
 *   窗内同键域沿用明示（未重采样 + 快照时刻）；`XC_MEM_WAKE_COOLDOWN_MS` 上钳 1h 与
 *   非法值回落都在 detail 明示；记录文件 version 2 分域索引；v0.9.1 平铺旧记录不迁移；
 * - C5 wake-deferred engine 事件带 `gateEnv` 原值（未设=null，非法值原样落盘）。
 *
 * 纪律：不跑全量单测（脚本统一恰跑一次）；本文件只测组 C 自有面。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { newTeamState, writeTeam } from '../core/teamstate.js';
import { RECEIPT_PREFIX } from '../core/mailbox.js';
import { classifyProcess, judgeCapacity, type ProcRow } from '../core/capacity.js';
import { WAKE_CHILD_ENV_KEY, WAKE_CHILD_ENV_VALUE, spawnResume } from './resume-cli.js';
import {
  attemptWake,
  capacityWakeDeferral,
  wakeCapacityCooldownInfoFromEnv,
  wakeCapacityCooldownMsFromEnv,
  wakeCooldownKeyOf,
  wakeDeferralFile,
  type WakeRequest,
} from './wake.js';
import type { CapacitySample } from '../core/capacity.js';
import type { SpawnResumeOptions, SpawnResumeResult } from './resume-cli.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

let workDir = '';
let stateRoot = '';

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'xc-v092-capacity-'));
  stateRoot = join(workDir, '.crosschat');
  dirs.push(workDir);
});

async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: 'default', founderKey: 'a', now });
  team.members.push(
    { key: 'a', sessionId: 'sess_a', role: 'peer', joinedAt: now, lastSeen: now },
    { key: 'b', sessionId: 'sess_b', role: 'worker', joinedAt: now, lastSeen: now },
    { key: 'c', sessionId: 'sess_c', role: 'worker', joinedAt: now, lastSeen: now },
  );
  await writeTeam(stateRoot, team);
}

function engineEvents(): Array<Record<string, unknown>> {
  const file = join(stateRoot, 'logs', 'engine.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventsNamed(name: string): Array<Record<string, unknown>> {
  return engineEvents().filter((e) => e['event'] === name);
}

// ─────────────────────────── C1 进程归类 ───────────────────────────

/** 最小假 ChildProcess（spawnImpl 注入用；helper 形态只读 pid/once/stdout/stderr）。 */
function fakeChild(pid: number | undefined): ChildProcess {
  return {
    pid,
    once: () => fakeChild(pid),
    on: () => fakeChild(pid),
    unref: () => undefined,
  } as unknown as ChildProcess;
}

describe('v0.9.2 C1：唤醒子 env 标记 XC_WAKE_CHILD=1（spawnResume 注入）', () => {
  it('direct 形态：基底 env 之上恒注入 XC_WAKE_CHILD=1（不含 ELECTRON 覆盖问题）', () => {
    let seen: { cmd: string; args: string[]; opts: SpawnOptions } | undefined;
    spawnResume({
      mode: 'direct',
      cfg: { zcodeExe: 'Z.exe', zcodeCjs: 'z.cjs' },
      sessionId: 'sess_b',
      prompt: 'p',
      cwd: workDir,
      logFile: join(workDir, 'logs', 'w1.json'),
      env: { PATH: 'x' },
      spawnImpl: (cmd, args, opts) => {
        seen = { cmd, args, opts };
        return fakeChild(4242);
      },
    });
    const env = seen!.opts.env as NodeJS.ProcessEnv;
    expect(env[WAKE_CHILD_ENV_KEY]).toBe(WAKE_CHILD_ENV_VALUE);
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1'); // 既有注入不被挤掉
    expect(env['PATH']).toBe('x'); // 基底 env 透传
  });

  it('helper 形态：helper 的 env 也带标记（wake-helper 以 {...process.env} 转发给唤醒子）', () => {
    const helper = join(workDir, 'wake-helper.mjs');
    writeFileSync(helper, 'process.exit(0);', 'utf8'); // 只需 existsSync 过关
    let seen: SpawnOptions | undefined;
    spawnResume({
      cfg: { zcodeExe: 'Z.exe', zcodeCjs: 'z.cjs' },
      sessionId: 'sess_b',
      prompt: 'p',
      cwd: workDir,
      logFile: join(workDir, 'logs', 'w2.json'),
      env: { PATH: 'x' },
      helperPath: helper,
      spawnImpl: (_cmd, _args, opts) => {
        seen = opts;
        return fakeChild(4243);
      },
    });
    const env = seen!.env as NodeJS.ProcessEnv;
    expect(env[WAKE_CHILD_ENV_KEY]).toBe(WAKE_CHILD_ENV_VALUE);
    // 注入即「这次 spawn 是唤醒子」，与 opts.env 是否显式传入无关。
    expect(seen!.detached).toBe(false); // helper 形态不 detached（跟随本进程）
  });
});

describe('v0.9.2 C1：命令行标记（CIM 可见）与用户 CLI 不再误判（V091-13）', () => {
  const spawnCalls: SpawnResumeOptions[] = [];
  const fakeSpawn = (opts: SpawnResumeOptions): SpawnResumeResult => {
    spawnCalls.push(opts);
    // 模拟真实 helper 的行为：拉起唤醒子后经 onHelperSpawned 汇报 pid——容量闸测试不关心
    // 启动确认（组 A 的面），但启动证据不到达会让 attemptWake 白等满确认窗（5s 用例超时）。
    opts.onHelperSpawned?.(4242);
    return { pid: 4242, logFile: opts.logFile };
  };

  function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
    return {
      stateRoot,
      teamId: 'default',
      toAgentKey: 'b',
      toSessionId: 'sess_b',
      workspace: workDir,
      reason: 'message',
      receiptIds: ['m1'],
      ticket: '正文',
      env: { XC_WAKE_ENABLED: 'true' },
      cfg: { zcodeExe: 'Z.exe', zcodeCjs: 'z.cjs' },
      spawn: fakeSpawn,
      watchWindowMs: 0,
      ...overrides,
    };
  }

  function greenSample(): CapacitySample {
    return {
      sampledAt: Date.now(),
      totalBytes: 32_000_000_000,
      freeBytes: 28_000_000_000,
      watermark: 0.875,
      steadyTreeBytes: 3_000_000_000,
      headlessTurnCount: 0,
      headlessTurnMaxRssBytes: null,
      degraded: null,
    };
  }

  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('端到端：唤醒 prompt 带冻结回执前缀 → 该命令行被判 headless-turn', async () => {
    await seedTeam();
    await attemptWake(baseReq({ capacitySample: greenSample() }));
    expect(spawnCalls).toHaveLength(1);
    const prompt = spawnCalls[0]!.prompt;
    expect(prompt.startsWith(RECEIPT_PREFIX)).toBe(true);
    // 采样器看到的是整条命令行（--prompt 的值在内）→ 归类为唤醒子。
    const commandLine = `ZCode.exe zcode.cjs --resume sess_b --prompt "${prompt}" --cwd ${workDir} --output-format json`;
    expect(classifyProcess({ pid: 1, ppid: 0, name: 'ZCode.exe', commandLine, wsBytes: 0 })).toBe('headless-turn');
  });

  it('用户 CLI（README 文档化形态）不带标记 → main，900MB 也不触发 session-limit', () => {
    const userCli = 'ZCode.exe E:\\ZCode\\resources\\glm\\zcode.cjs --resume sess_x -p --mode yolo';
    const row: ProcRow = { pid: 2, ppid: 1, name: 'ZCode.exe', commandLine: userCli, wsBytes: 900 * 1024 * 1024 };
    expect(classifyProcess(row)).toBe('main');
    // 该进程不在回合树口径里 → red2（session-limit）无输入，不会因它判红。
    const sample: CapacitySample = {
      sampledAt: 1,
      totalBytes: 32_000_000_000,
      freeBytes: 16_000_000_000,
      watermark: 0.5,
      steadyTreeBytes: 900 * 1024 * 1024,
      headlessTurnCount: 0,
      headlessTurnMaxRssBytes: null,
      degraded: null,
    };
    expect(judgeCapacity(sample, { XC_MEM_SESSION_LIMIT_BYTES: String(800 * 1024 * 1024) }).violated).toEqual([]);
  });
});

// ─────────────────────────── C2 degraded 披露 ───────────────────────────

describe('v0.9.2 C2：degraded 样本放行也披露（V091-14）', () => {
  const spawnCalls: SpawnResumeOptions[] = [];
  const fakeSpawn = (opts: SpawnResumeOptions): SpawnResumeResult => {
    spawnCalls.push(opts);
    // 模拟真实 helper 的行为：拉起唤醒子后经 onHelperSpawned 汇报 pid——容量闸测试不关心
    // 启动确认（组 A 的面），但启动证据不到达会让 attemptWake 白等满确认窗（5s 用例超时）。
    opts.onHelperSpawned?.(4242);
    return { pid: 4242, logFile: opts.logFile };
  };

  function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
    return {
      stateRoot,
      teamId: 'default',
      toAgentKey: 'b',
      toSessionId: 'sess_b',
      workspace: workDir,
      reason: 'message',
      receiptIds: ['m1'],
      ticket: '正文',
      env: { XC_WAKE_ENABLED: 'true' },
      cfg: { zcodeExe: 'Z.exe', zcodeCjs: 'z.cjs' },
      spawn: fakeSpawn,
      watchWindowMs: 0,
      ...overrides,
    };
  }

  /** CIM 不可用样本：只有 os 水位可信，进程类字段全空。 */
  function degradedSample(overrides: Partial<CapacitySample> = {}): CapacitySample {
    return {
      sampledAt: Date.now(),
      totalBytes: 32_000_000_000,
      freeBytes: 28_000_000_000,
      watermark: 0.875,
      steadyTreeBytes: null,
      headlessTurnCount: 0,
      headlessTurnMaxRssBytes: null,
      degraded: 'cim-unavailable',
      ...overrides,
    };
  }

  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('CIM 不可用 + 绿灯：唤醒照常放行，但落 wake-capacity-degraded（进程类规则未评）', async () => {
    await seedTeam();
    const res = await attemptWake(baseReq({ capacitySample: degradedSample() }));
    expect(spawnCalls).toHaveLength(1); // fail-open：观测故障不挡协作
    expect(res.delivered).toBe('wake');
    const events = eventsNamed('wake-capacity-degraded');
    expect(events).toHaveLength(1);
    expect(events[0]!['degraded']).toBe('cim-unavailable');
    const detail = events[0]!['detail'] as string[];
    expect(detail.join('')).toContain('进程类规则（session-limit/turn-concurrency）未评');
    expect(String(events[0]!['note'])).toContain('未评');
  });

  it('持续降级只披露一次（同一状态根）；采样恢复后再次降级重新披露', async () => {
    // 直驱 capacityWakeDeferral（attemptWake 第二发会被在途 nonce 挡住，到不了容量闸）。
    const scope = { teamId: 'default', to: 'b', urgent: false };
    const env = { XC_WAKE_ENABLED: 'true' };
    expect(await capacityWakeDeferral(stateRoot, env, Date.now(), scope, degradedSample())).toBeUndefined();
    expect(await capacityWakeDeferral(stateRoot, env, Date.now() + 1000, scope, degradedSample())).toBeUndefined();
    expect(eventsNamed('wake-capacity-degraded')).toHaveLength(1); // 节流：不刷噪声
    // 恢复（非 degraded 样本）→ 除名。
    expect(await capacityWakeDeferral(stateRoot, env, Date.now() + 2000, scope, { ...degradedSample(), degraded: null })).toBeUndefined();
    expect(eventsNamed('wake-capacity-degraded')).toHaveLength(1);
    // 再降级 → 重新披露。
    expect(await capacityWakeDeferral(stateRoot, env, Date.now() + 3000, scope, degradedSample())).toBeUndefined();
    expect(eventsNamed('wake-capacity-degraded')).toHaveLength(2);
  });

  it('CIM 不可用 + 红灯：wake-deferred detail 带降级声明（不声称已评进程类规则）', async () => {
    await seedTeam();
    const res = await attemptWake(baseReq({
      capacitySample: degradedSample({ watermark: 0.089, freeBytes: 2_790_000_000 }),
    }));
    expect(res.delivered).toBe('mailbox');
    expect(res.wakeDeferred?.detail.join('')).toContain('degraded: CIM 进程采样不可用');
    expect(res.wakeDeferred?.detail.join('')).toContain('未评');
    // 判红路径的降级声明走 wake-deferred，不重复落 degraded 事件（同一事实一个出口）。
    expect(eventsNamed('wake-capacity-degraded')).toHaveLength(0);
  });
});

// ─────────────────────────── C3 冷却键分域 / 上钳 / 沿用明示 ───────────────────────────

describe('v0.9.2 C3：冷却键分域 + 上钳 + 沿用明示（V091-15 / V091-19）', () => {
  const spawnCalls: SpawnResumeOptions[] = [];
  const fakeSpawn = (opts: SpawnResumeOptions): SpawnResumeResult => {
    spawnCalls.push(opts);
    // 模拟真实 helper 的行为：拉起唤醒子后经 onHelperSpawned 汇报 pid——容量闸测试不关心
    // 启动确认（组 A 的面），但启动证据不到达会让 attemptWake 白等满确认窗（5s 用例超时）。
    opts.onHelperSpawned?.(4242);
    return { pid: 4242, logFile: opts.logFile };
  };

  function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
    return {
      stateRoot,
      teamId: 'default',
      toAgentKey: 'b',
      toSessionId: 'sess_b',
      workspace: workDir,
      reason: 'message',
      receiptIds: ['m1'],
      ticket: '正文',
      env: { XC_WAKE_ENABLED: 'true' },
      cfg: { zcodeExe: 'Z.exe', zcodeCjs: 'z.cjs' },
      spawn: fakeSpawn,
      watchWindowMs: 0,
      ...overrides,
    };
  }

  function redSample(): CapacitySample {
    return {
      sampledAt: Date.now(),
      totalBytes: 31_300_000_000,
      freeBytes: 2_790_000_000,
      watermark: 0.089,
      steadyTreeBytes: 12_000_000_000,
      headlessTurnCount: 13,
      headlessTurnMaxRssBytes: 280_000_000,
      degraded: null,
    };
  }

  function greenSample(): CapacitySample {
    return {
      sampledAt: Date.now(),
      totalBytes: 32_000_000_000,
      freeBytes: 28_000_000_000,
      watermark: 0.875,
      steadyTreeBytes: 3_000_000_000,
      headlessTurnCount: 0,
      headlessTurnMaxRssBytes: null,
      degraded: null,
    };
  }

  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('成员 b 的 RED 冷却不挡成员 c 的唤醒（收方分域）', async () => {
    await seedTeam();
    const now = Date.now();
    const first = await attemptWake(baseReq({ capacitySample: redSample(), now }));
    expect(first.delivered).toBe('mailbox');
    expect(first.wakeDeferred?.cooldownActive).toBe(false);
    // c 在另一个键域：重新判定（这里是绿灯）→ 放行 spawn。
    const second = await attemptWake(baseReq({
      toAgentKey: 'c', toSessionId: 'sess_c', capacitySample: greenSample(), now: now + 1000,
    }));
    expect(second.delivered).toBe('wake');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.sessionId).toBe('sess_c');
  });

  it('普通消息的冷却不挡紧急 relay（紧急度分域）', async () => {
    await seedTeam();
    const now = Date.now();
    await attemptWake(baseReq({ capacitySample: redSample(), now }));
    expect(eventsNamed('wake-deferred')).toHaveLength(1);
    // 同一收方、urgent：另一个键域 → 重新判定（红灯照样 defer，但那是当次结论）。
    const urgent = await attemptWake(baseReq({ urgent: true, capacitySample: redSample(), now: now + 1000 }));
    expect(urgent.delivered).toBe('mailbox');
    expect(urgent.wakeDeferred?.cooldownActive).toBe(false); // 不是「沿用别人的冷却」
    expect(eventsNamed('wake-deferred')).toHaveLength(2);
    const keys = eventsNamed('wake-deferred').map((e) => `${e['teamId']}|${e['to']}|${e['urgent']}`);
    expect(keys).toEqual(['default|b|false', 'default|b|true']);
  });

  it('窗内同键域命中：detail 明示沿用旧判据（未重采样 + 快照时刻），retryAfterMs 递减', async () => {
    await seedTeam();
    const now = Date.now();
    await attemptWake(baseReq({ capacitySample: redSample(), now }));
    const second = await attemptWake(baseReq({ capacitySample: redSample(), now: now + 30_000 }));
    expect(second.wakeDeferred?.cooldownActive).toBe(true);
    const detail = second.wakeDeferred!.detail.join('；');
    expect(detail).toContain('cooldown-reuse');
    expect(detail).toContain('未重采样');
    expect(detail).toContain(new Date(now).toISOString()); // 快照时刻可对账
    expect(detail).toContain('default|b|normal'); // 键域明示
    expect(second.wakeDeferred!.retryAfterMs).toBeGreaterThan(0);
    expect(second.wakeDeferred!.retryAfterMs).toBeLessThanOrEqual(90_000);
    // 窗内不重采样：采样器注入的样本不该被读取（redSample 仍会被传入，但不参与判定）。
    expect(spawnCalls).toHaveLength(0);
  });

  it('XC_MEM_WAKE_COOLDOWN_MS 超上钳 → 钳到 1h 且 detail 明示（不静默）', async () => {
    await seedTeam();
    const res = await attemptWake(baseReq({
      capacitySample: redSample(),
      env: { XC_WAKE_ENABLED: 'true', XC_MEM_WAKE_COOLDOWN_MS: '999999999999' },
    }));
    expect(res.wakeDeferred?.cooldownMs).toBe(3_600_000);
    expect(res.wakeDeferred!.detail.join('')).toContain('cooldown-clamped');
    expect(res.wakeDeferred!.detail.join('')).toContain('3600000ms（1h）');
    expect(wakeCapacityCooldownMsFromEnv({ XC_MEM_WAKE_COOLDOWN_MS: '999999999999' })).toBe(3_600_000);
    expect(wakeCapacityCooldownInfoFromEnv({ XC_MEM_WAKE_COOLDOWN_MS: '999999999999' }).fellBack).toBe('clamped');
  });

  it('XC_MEM_WAKE_COOLDOWN_MS 非法值 → 回落内置缺省 120s 且 detail 明示', async () => {
    await seedTeam();
    const res = await attemptWake(baseReq({
      capacitySample: redSample(),
      env: { XC_WAKE_ENABLED: 'true', XC_MEM_WAKE_COOLDOWN_MS: 'abc' },
    }));
    expect(res.wakeDeferred?.cooldownMs).toBe(120_000);
    expect(res.wakeDeferred!.detail.join('')).toContain('cooldown-env');
    expect(wakeCapacityCooldownInfoFromEnv({ XC_MEM_WAKE_COOLDOWN_MS: 'abc' }).fellBack).toBe('invalid');
    expect(wakeCapacityCooldownInfoFromEnv({}).fellBack).toBeNull(); // 没配 = 不是回落
  });

  it('冷却记录文件：version 2 + 按分域键索引；GREEN 只清本键域', async () => {
    await seedTeam();
    const now = Date.now();
    await attemptWake(baseReq({ capacitySample: redSample(), now }));
    const file = wakeDeferralFile(stateRoot);
    const store = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(store['version']).toBe(2);
    const entries = store['entries'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(entries)).toEqual(['default|b|normal']);
    expect(entries['default|b|normal']!['scope']).toEqual({ teamId: 'default', to: 'b', urgent: false });
    // b 的窗内再来一个 RED（键域不变，仍 defer），随后 c 的 GREEN 只清 c 的条目。
    await attemptWake(baseReq({ capacitySample: redSample(), now: now + 1000 }));
    await attemptWake(baseReq({
      toAgentKey: 'c', toSessionId: 'sess_c', capacitySample: greenSample(), now: now + 2000,
    }));
    const after = JSON.parse(readFileSync(file, 'utf8')) as { entries: Record<string, unknown> };
    expect(Object.keys(after.entries)).toEqual(['default|b|normal']); // b 的冷却还在
    // 最后 b 也 GREEN → 条目清空 → 文件删除（不留残挡）。
    await attemptWake(baseReq({ capacitySample: greenSample(), now: now + 120_001 }));
    expect(existsSync(file)).toBe(false);
  });

  it('v0.9.1 平铺旧记录不迁移：按损坏处理 → 重新判定（不误读成别域挡门）', async () => {
    await seedTeam();
    const file = wakeDeferralFile(stateRoot);
    mkdirSync(join(stateRoot, 'capacity'), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      reason: 'capacity-red', detail: ['旧格式'], watermark: 0.089, freeBytes: 1, cooldownMs: 120_000,
      retryAfterMs: 120_000, cooldownActive: true, until: Date.now() + 60_000,
    })}\n`, 'utf8');
    const res = await attemptWake(baseReq({ capacitySample: greenSample() }));
    expect(res.delivered).toBe('wake'); // 旧平铺记录不被当成挡门
    expect(spawnCalls).toHaveLength(1);
  });

  it('键函数：teamId+收方+紧急度三维各不同', () => {
    expect(wakeCooldownKeyOf({ teamId: 'default', to: 'b', urgent: false })).toBe('default|b|normal');
    expect(wakeCooldownKeyOf({ teamId: 'default', to: 'c', urgent: false })).toBe('default|c|normal');
    expect(wakeCooldownKeyOf({ teamId: 'default', to: 'b', urgent: true })).toBe('default|b|urgent');
    expect(wakeCooldownKeyOf({ teamId: 'other', to: 'b', urgent: false })).toBe('other|b|normal');
  });

  it('capacityWakeDeferral 直驱：scope 必填（无默认键域可掉进去）', async () => {
    const scope = { teamId: 'default', to: 'b', urgent: false };
    expect(await capacityWakeDeferral(stateRoot, { XC_WAKE_ENABLED: 'true' }, Date.now(), scope, greenSample())).toBeUndefined();
    const block = await capacityWakeDeferral(stateRoot, { XC_WAKE_ENABLED: 'true' }, Date.now(), scope, redSample());
    expect(block?.reason).toBe('capacity-red');
  });
});

// ─────────────────────────── C5 gateEnv 原值 ───────────────────────────

describe('v0.9.2 C5：wake-deferred 事件 gateEnv 原值（V091-18）', () => {
  const spawnCalls: SpawnResumeOptions[] = [];
  const fakeSpawn = (opts: SpawnResumeOptions): SpawnResumeResult => {
    spawnCalls.push(opts);
    // 模拟真实 helper 的行为：拉起唤醒子后经 onHelperSpawned 汇报 pid——容量闸测试不关心
    // 启动确认（组 A 的面），但启动证据不到达会让 attemptWake 白等满确认窗（5s 用例超时）。
    opts.onHelperSpawned?.(4242);
    return { pid: 4242, logFile: opts.logFile };
  };

  function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
    return {
      stateRoot,
      teamId: 'default',
      toAgentKey: 'b',
      toSessionId: 'sess_b',
      workspace: workDir,
      reason: 'message',
      receiptIds: ['m1'],
      ticket: '正文',
      env: { XC_WAKE_ENABLED: 'true' },
      cfg: { zcodeExe: 'Z.exe', zcodeCjs: 'z.cjs' },
      spawn: fakeSpawn,
      watchWindowMs: 0,
      ...overrides,
    };
  }

  const redSample = (): CapacitySample => ({
    sampledAt: Date.now(),
    totalBytes: 31_300_000_000,
    freeBytes: 2_790_000_000,
    watermark: 0.089,
    steadyTreeBytes: 12_000_000_000,
    headlessTurnCount: 13,
    headlessTurnMaxRssBytes: 280_000_000,
    degraded: null,
  });

  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('未设 XC_MEM_WAKE_GATE → gateEnv=null（「没配」与「配错」可分辨）', async () => {
    await seedTeam();
    await attemptWake(baseReq({ capacitySample: redSample() }));
    const event = eventsNamed('wake-deferred')[0]!;
    expect(event['wakeGateEnabled']).toBe(true);
    expect(event['gateEnv']).toBeNull();
  });

  it('非法值 → 闸按开启处理且 gateEnv 落原值', async () => {
    await seedTeam();
    await attemptWake(baseReq({
      capacitySample: redSample(),
      env: { XC_WAKE_ENABLED: 'true', XC_MEM_WAKE_GATE: 'yes-please' },
    }));
    const event = eventsNamed('wake-deferred')[0]!;
    expect(event['wakeGateEnabled']).toBe(true); // 非 off 一律按开启
    expect(event['gateEnv']).toBe('yes-please');
  });

  it('XC_MEM_WAKE_GATE=off → 关闸不放行 deferral（无事件可披露）', async () => {
    await seedTeam();
    const res = await attemptWake(baseReq({
      capacitySample: redSample(),
      env: { XC_WAKE_ENABLED: 'true', XC_MEM_WAKE_GATE: 'off' },
    }));
    expect(res.delivered).toBe('wake');
    expect(eventsNamed('wake-deferred')).toHaveLength(0);
  });
});

// ─────────────────────────── 文档登记（C1/C2/C3/C5 口径必须在 PROTOCOL 在场） ───────────────────────────

describe('v0.9.2 组 C 文档登记（PROTOCOL §15.2 + README 已知限制 22）', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');
  const protocol = read('docs/PROTOCOL.md');
  const readme = read('README.md');

  it('PROTOCOL §15.2 登记键分域/上钳/沿用明示/degraded 事件/进程归类五条口径', () => {
    expect(protocol).toContain('C3 冷却键分域');
    expect(protocol).toContain('<teamId>|<收方>|<urgent|normal>');
    expect(protocol).toContain('C3 冷却 env 上钳');
    expect(protocol).toContain('3600000ms（1h');
    expect(protocol).toContain('C3 窗内沿用明示');
    expect(protocol).toContain('C2 degraded 披露');
    expect(protocol).toContain('wake-capacity-degraded');
    expect(protocol).toContain('C1 进程归类');
    expect(protocol).toContain('WAKE_CHILD_COMMAND_MARKER');
  });

  it('PROTOCOL §15.2 冻结事件块含 gateEnv 与 urgent（契约测试同源对拍）', () => {
    const at = protocol.indexOf('**engine 事件 `wake-deferred`**');
    expect(at).toBeGreaterThan(0);
    const block = protocol.slice(at, at + 2000).match(/```json\r?\n([\s\S]*?)```/);
    expect(block).not.toBeNull();
    const keys = Object.keys(JSON.parse(block![1]!) as Record<string, unknown>).sort();
    expect(keys).toContain('gateEnv');
    expect(keys).toContain('urgent');
    expect(keys).toContain('wakeGateEnabled');
  });

  it('README 已知限制 22 同步（XC_MEM_WAKE_COOLDOWN_MS 上钳与降级披露在场）', () => {
    const item = readme.split('\n').find((l) => l.startsWith('22. **容量闸挡唤醒不拦投递'));
    expect(item).toBeDefined();
    expect(item!).toContain('XC_MEM_WAKE_COOLDOWN_MS');
    expect(item!).toContain('wake-capacity-probe-failed');
  });
});
