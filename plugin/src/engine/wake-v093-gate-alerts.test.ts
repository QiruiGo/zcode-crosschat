/**
 * v0.9.3（37-v093 方案 §一 组B B2/B3/B4）定向测试——唤醒闸段（engine/wake.ts）：
 *
 * - B4 配置生效值变更事件：attemptWake 走到容量闸段时现读比对（capacity/config-state.json），
 *   改 file 层 → `config-effective-changed{key,from,to,source}` 恰一条；不变更 → 零事件；
 *   关闸（wake_gate=false）也照常对拍（配置解析前置到开关判定）；
 * - B3① wake-deferred 累积告警：窗内累积 ≥XC_DEFERRED_ALERT_N → urgent lead + 事件
 *   （每窗一次）；窗内沿用的冷却命中不计数；GREEN 放行清窗（恢复后重置）；
 * - B3② wake 关闭持续态告警：生效值连续 false ≥XC_WAKE_OFF_ALERT_MS 且有 pending →
 *   urgent lead + 事件（一次）；恢复即清零；无 pending 不告警；
 * - B2 闸状态读数 wakeGateStatus / readActiveWakeCooldowns：阻塞条件名、下次重判时刻、
 *   本窗计数、分层阈值与来源；
 * - 文档登记：PROTOCOL §15.7 冻结事件块 ↔ 实跑键集对拍 + README 已知限制 24 + §9 env。
 *
 * 纪律：不跑全量单测（脚本统一恰跑一次）；本文件只测组 B 自有面。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newTeamState, writeTeam } from '../core/teamstate.js';
import { appendMailbox, createMessage, readMailbox } from '../core/mailbox.js';
import { workspaceConfigFile } from '../core/config.js';
import {
  attemptWake,
  deferredAlertNFromEnv,
  deferredAlertWindowMsFromEnv,
  readActiveWakeCooldowns,
  wakeAlertStateFile,
  wakeGateStatus,
  wakeOffAlertMsFromEnv,
  type WakeRequest,
} from './wake.js';
import type { SpawnResumeOptions, SpawnResumeResult } from './resume-cli.js';
import type { CapacitySample } from '../core/capacity.js';

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
  workDir = mkdtempSync(join(tmpdir(), 'xc-v093-gate-'));
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

/** 落一版 config.json（capacity 段或任意 JSON）。 */
function seedConfig(content: unknown): void {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(workspaceConfigFile(stateRoot), JSON.stringify(content), 'utf8');
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

/** lead（founder a）邮箱里来自 engine 的 urgent 消息文本。 */
async function leadUrgentTexts(): Promise<string[]> {
  const messages = await readMailbox(stateRoot, 'default', 'a');
  return messages
    .filter((m) => m.from === 'engine' && m.urgent === true)
    .map((m) => (typeof m.content === 'string' ? m.content : ''));
}

/** RED 样本（watermark 0.089 命中 red1 硬底）。 */
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

/** GREEN 样本（三条 red 规则都不命中、边际预估也放得下）。 */
const greenSample = (): CapacitySample => ({
  sampledAt: Date.now(),
  totalBytes: 31_300_000_000,
  freeBytes: 15_000_000_000,
  watermark: 0.48,
  steadyTreeBytes: 3_000_000_000,
  headlessTurnCount: 0,
  headlessTurnMaxRssBytes: null,
  degraded: null,
});

const spawnCalls: SpawnResumeOptions[] = [];
const fakeSpawn = (opts: SpawnResumeOptions): SpawnResumeResult => {
  spawnCalls.push(opts);
  opts.onHelperSpawned?.(4242); // 启动证据即时到达：容量闸测试不关心启动确认窗
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

beforeEach(() => {
  spawnCalls.length = 0;
});

// ─────────────────────────── B4：配置生效值变更事件 ───────────────────────────

describe('v0.9.3 B4：config-effective-changed（现读比对 + 防刷屏）', () => {
  it('首次唤醒判定静默立基线（无事件）；改 file 层 → 恰一条 {key,from,to,source}', async () => {
    await seedTeam();
    const now = 1_800_000_000_000;
    await attemptWake(baseReq({ now, capacitySample: greenSample() }));
    expect(eventsNamed('config-effective-changed')).toHaveLength(0);
    expect(existsSync(join(stateRoot, 'capacity', 'config-state.json'))).toBe(true);

    seedConfig({ wake_enabled: true, capacity: { warn_watermark: 0.2 } });
    // 换收件人 c：b 的在途 nonce（15min TTL）会挡在容量闸之前，本组只测配置对拍。
    await attemptWake(baseReq({ now: now + 1000, toAgentKey: 'c', toSessionId: 'sess_c', capacitySample: greenSample() }));
    const events = eventsNamed('config-effective-changed');
    expect(events).toHaveLength(1);
    expect(events[0]!['key']).toBe('warn_watermark');
    expect(events[0]!['from']).toBe(0.15);
    expect(events[0]!['to']).toBe(0.2);
    expect(events[0]!['source']).toBe('file');
  });

  it('不变更 → 零事件（重复唤醒不刷屏）', async () => {
    await seedTeam();
    const now = 1_800_000_000_000;
    await attemptWake(baseReq({ now, capacitySample: greenSample() }));
    await attemptWake(baseReq({ now: now + 1000, capacitySample: greenSample() }));
    await attemptWake(baseReq({ now: now + 2000, capacitySample: greenSample() }));
    expect(eventsNamed('config-effective-changed')).toHaveLength(0);
  });

  it('一次改两个键 → 两条事件（逐键一条）', async () => {
    await seedTeam();
    const now = 1_800_000_000_000;
    await attemptWake(baseReq({ now, capacitySample: greenSample() }));
    seedConfig({ capacity: { warn_watermark: 0.3, wake_gate: false } });
    await attemptWake(baseReq({ now: now + 1000, toAgentKey: 'c', toSessionId: 'sess_c', capacitySample: greenSample() }));
    const events = eventsNamed('config-effective-changed');
    expect(events.map((e) => e['key']).sort()).toEqual(['wake_gate', 'warn_watermark']);
  });

  it('关闸（file wake_gate=false）也照常对拍（配置解析前置到开关判定）', async () => {
    await seedTeam();
    const now = 1_800_000_000_000;
    await attemptWake(baseReq({ now, capacitySample: greenSample() }));
    seedConfig({ capacity: { wake_gate: false } });
    const res = await attemptWake(baseReq({ now: now + 1000, toAgentKey: 'c', toSessionId: 'sess_c', capacitySample: redSample() }));
    expect(res.delivered).toBe('wake'); // 关闸 → RED 也不 defer（回到「只警不拦」）
    expect(eventsNamed('wake-deferred')).toHaveLength(0);
    const events = eventsNamed('config-effective-changed');
    expect(events).toHaveLength(1);
    expect(events[0]!['key']).toBe('wake_gate');
    expect(events[0]!['from']).toBe(true);
    expect(events[0]!['to']).toBe(false);
  });

  it('env 层变更同样产出事件（source=env）', async () => {
    await seedTeam();
    const now = 1_800_000_000_000;
    await attemptWake(baseReq({ now, capacitySample: greenSample() }));
    await attemptWake(baseReq({
      now: now + 1000,
      toAgentKey: 'c',
      toSessionId: 'sess_c',
      capacitySample: greenSample(),
      env: { XC_WAKE_ENABLED: 'true', XC_TURN_ESTIMATE_BYTES: '2048' },
    }));
    const events = eventsNamed('config-effective-changed');
    expect(events).toHaveLength(1);
    expect(events[0]!['key']).toBe('turn_estimate_bytes');
    expect(events[0]!['to']).toBe(2048);
    expect(events[0]!['source']).toBe('env');
  });

  it('capacity 段畸形 → config-malformed 披露（scene capacity-gate）+ 回落 env/默认', async () => {
    await seedTeam();
    const now = 1_800_000_000_000;
    seedConfig({ capacity: { warn_watermark: 'x' } });
    await attemptWake(baseReq({ now, capacitySample: greenSample() }));
    const malformed = eventsNamed('config-malformed');
    expect(malformed.some((e) => e['scene'] === 'capacity-gate')).toBe(true);
    const gateWarn = malformed.find((e) => e['scene'] === 'capacity-gate');
    expect(String(gateWarn!['warning'])).toContain('warn_watermark');
  });
});

// ─────────────────────────── B3①：wake-deferred 累积告警 ───────────────────────────

describe('v0.9.3 B3①：wake-deferred 窗内累积 ≥N → urgent lead（每窗一次）', () => {
  const now = 1_800_000_000_000;

  it('累积达阈值恰一条告警（urgent lead + 事件）；再累积不重复', async () => {
    await seedTeam();
    const env = {
      XC_WAKE_ENABLED: 'true',
      XC_MEM_WAKE_COOLDOWN_MS: '0', // 每次投递都重新判定（计数确定性）
      XC_DEFERRED_ALERT_N: '3',
      XC_DEFERRED_ALERT_WINDOW_MS: '600000',
    };
    for (let i = 1; i <= 3; i++) {
      const res = await attemptWake(baseReq({ env, now: now + i * 1000, capacitySample: redSample() }));
      expect(res.delivered).toBe('mailbox');
      expect(res.wakeDeferred?.reason).toBe('capacity-red');
    }
    const alerts = eventsNamed('wake-deferred-alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!['count']).toBe(3);
    expect(alerts[0]!['threshold']).toBe(3);
    expect(alerts[0]!['windowMs']).toBe(600000);
    expect(alerts[0]!['scope']).toBe('default|b|normal');
    const urgent = await leadUrgentTexts();
    expect(urgent).toHaveLength(1);
    expect(urgent[0]).toContain('容量闸告警');

    // 第 4 次累积：不重复告警（每窗一次）
    await attemptWake(baseReq({ env, now: now + 4000, capacitySample: redSample() }));
    expect(eventsNamed('wake-deferred-alert')).toHaveLength(1);
    expect(await leadUrgentTexts()).toHaveLength(1);
  });

  it('未达阈值 → 零告警', async () => {
    await seedTeam();
    const env = {
      XC_WAKE_ENABLED: 'true',
      XC_MEM_WAKE_COOLDOWN_MS: '0',
      XC_DEFERRED_ALERT_N: '5',
    };
    for (let i = 1; i <= 4; i++) {
      await attemptWake(baseReq({ env, now: now + i * 1000, capacitySample: redSample() }));
    }
    expect(eventsNamed('wake-deferred-alert')).toHaveLength(0);
    expect(await leadUrgentTexts()).toHaveLength(0);
  });

  it('窗内沿用的冷却命中不计数（同一次 RED 判定只计一次）', async () => {
    await seedTeam();
    const env = {
      XC_WAKE_ENABLED: 'true',
      XC_MEM_WAKE_COOLDOWN_MS: '120000', // 冷却窗内第二次命中 = 沿用
      XC_DEFERRED_ALERT_N: '2',
    };
    await attemptWake(baseReq({ env, now, capacitySample: redSample() }));
    const reuse = await attemptWake(baseReq({ env, now: now + 1000, capacitySample: redSample() }));
    expect(reuse.wakeDeferred?.cooldownActive).toBe(true);
    const state = JSON.parse(readFileSync(wakeAlertStateFile(stateRoot), 'utf8')) as {
      deferred: { count: number };
    };
    expect(state.deferred.count).toBe(1); // 沿用不计数
    expect(eventsNamed('wake-deferred-alert')).toHaveLength(0);
  });

  it('恢复后重置：GREEN 放行清窗，下一段 RED 从头计', async () => {
    await seedTeam();
    const env = {
      XC_WAKE_ENABLED: 'true',
      XC_MEM_WAKE_COOLDOWN_MS: '0',
      XC_DEFERRED_ALERT_N: '2',
    };
    await attemptWake(baseReq({ env, now, capacitySample: redSample() }));
    // 换收件人 c：GREEN 唤醒会留下在途 nonce，b 的后续 attempt 会被挡在容量闸之前。
    await attemptWake(baseReq({ env, now: now + 1000, toAgentKey: 'c', toSessionId: 'sess_c', capacitySample: greenSample() })); // 恢复
    let state = JSON.parse(readFileSync(wakeAlertStateFile(stateRoot), 'utf8')) as {
      deferred: { count: number };
    };
    expect(state.deferred.count).toBe(0);
    // 下一段 RED：从 1 开始计，第 2 次才告警
    await attemptWake(baseReq({ env, now: now + 2000, capacitySample: redSample() }));
    expect(eventsNamed('wake-deferred-alert')).toHaveLength(0);
    await attemptWake(baseReq({ env, now: now + 3000, capacitySample: redSample() }));
    expect(eventsNamed('wake-deferred-alert')).toHaveLength(1);
    state = JSON.parse(readFileSync(wakeAlertStateFile(stateRoot), 'utf8')) as { deferred: { count: number } };
    expect(state.deferred.count).toBe(2);
  });

  it('换窗：超出窗长重新计数（持续 RED 每窗一条）', async () => {
    await seedTeam();
    const env = {
      XC_WAKE_ENABLED: 'true',
      XC_MEM_WAKE_COOLDOWN_MS: '0',
      XC_DEFERRED_ALERT_N: '2',
      XC_DEFERRED_ALERT_WINDOW_MS: '10000',
    };
    await attemptWake(baseReq({ env, now, capacitySample: redSample() }));
    await attemptWake(baseReq({ env, now: now + 1000, capacitySample: redSample() })); // 第 1 窗告警
    expect(eventsNamed('wake-deferred-alert')).toHaveLength(1);
    await attemptWake(baseReq({ env, now: now + 20000, capacitySample: redSample() })); // 换窗：计数归 1
    await attemptWake(baseReq({ env, now: now + 21000, capacitySample: redSample() })); // 第 2 窗再告警
    expect(eventsNamed('wake-deferred-alert')).toHaveLength(2);
  });

  it('XC_DEFERRED_ALERT_N=0 → 关该告警（不计数不告警）', async () => {
    await seedTeam();
    const env = {
      XC_WAKE_ENABLED: 'true',
      XC_MEM_WAKE_COOLDOWN_MS: '0',
      XC_DEFERRED_ALERT_N: '0',
    };
    for (let i = 1; i <= 6; i++) {
      await attemptWake(baseReq({ env, now: now + i * 1000, capacitySample: redSample() }));
    }
    expect(eventsNamed('wake-deferred-alert')).toHaveLength(0);
    expect(existsSync(wakeAlertStateFile(stateRoot))).toBe(false); // 0=关：连状态都不建
  });

  it('env 解析：缺省 5/600000/1800000；非法回落缺省；0=关', () => {
    expect(deferredAlertNFromEnv({})).toBe(5);
    expect(deferredAlertNFromEnv({ XC_DEFERRED_ALERT_N: '2' })).toBe(2);
    expect(deferredAlertNFromEnv({ XC_DEFERRED_ALERT_N: '0' })).toBe(0);
    expect(deferredAlertNFromEnv({ XC_DEFERRED_ALERT_N: 'abc' })).toBe(5);
    expect(deferredAlertWindowMsFromEnv({})).toBe(600_000);
    expect(deferredAlertWindowMsFromEnv({ XC_DEFERRED_ALERT_WINDOW_MS: '0' })).toBe(0);
    expect(wakeOffAlertMsFromEnv({})).toBe(1_800_000);
    expect(wakeOffAlertMsFromEnv({ XC_WAKE_OFF_ALERT_MS: '-1' })).toBe(1_800_000);
  });
});

// ─────────────────────────── B3②：wake 关闭持续态告警 ───────────────────────────

describe('v0.9.3 B3②：wake 生效值连续 false ≥T 且有 pending → urgent lead（一次）', () => {
  const now = 1_800_000_000_000;

  /** 给成员 b 的邮箱压一条未读（制造 pending）。 */
  async function seedPending(): Promise<void> {
    await appendMailbox(stateRoot, 'default', 'b', createMessage('a', 'b', '待投递消息'));
  }

  it('关闭未达阈值 → 只记账不告警；达阈值 + 有 pending → 恰一条', async () => {
    await seedTeam();
    await seedPending();
    const env = { XC_WAKE_OFF_ALERT_MS: '5000' }; // wake_enabled 未设 → 默认 false
    const first = await attemptWake(baseReq({ env, now }));
    expect(first.delivered).toBe('mailbox');
    expect(eventsNamed('wake-off-alert')).toHaveLength(0); // offFor=0 < 5000

    await attemptWake(baseReq({ env, now: now + 6000 }));
    const alerts = eventsNamed('wake-off-alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!['offForMs']).toBeGreaterThanOrEqual(5000);
    expect(alerts[0]!['thresholdMs']).toBe(5000);
    expect(alerts[0]!['pendingMessages']).toBeGreaterThan(0);
    const urgent = await leadUrgentTexts();
    expect(urgent).toHaveLength(1);
    expect(urgent[0]).toContain('唤醒开关告警');

    // 再 attempt 不重复（一次）
    await attemptWake(baseReq({ env, now: now + 12000 }));
    expect(eventsNamed('wake-off-alert')).toHaveLength(1);
    expect(await leadUrgentTexts()).toHaveLength(1);
  });

  it('无 pending 消息 → 不告警（关闭唤醒但无积压时没有说话的必要）', async () => {
    await seedTeam(); // 不压消息：所有邮箱空
    const env = { XC_WAKE_OFF_ALERT_MS: '5000' };
    await attemptWake(baseReq({ env, now }));
    await attemptWake(baseReq({ env, now: now + 60000 }));
    expect(eventsNamed('wake-off-alert')).toHaveLength(0);
    expect(await leadUrgentTexts()).toHaveLength(0);
  });

  it('恢复即清零：wake_enabled=true 放行后，持续态从头起算', async () => {
    await seedTeam();
    await seedPending();
    const offEnv = { XC_WAKE_OFF_ALERT_MS: '5000' };
    await attemptWake(baseReq({ env: offEnv, now }));
    await attemptWake(baseReq({ env: offEnv, now: now + 6000 }));
    expect(eventsNamed('wake-off-alert')).toHaveLength(1);

    // 恢复：开启唤醒并放行（GREEN 样本）
    await attemptWake(baseReq({ env: { ...offEnv, XC_WAKE_ENABLED: 'true' }, now: now + 7000, capacitySample: greenSample() }));
    let state = JSON.parse(readFileSync(wakeAlertStateFile(stateRoot), 'utf8')) as {
      wakeOff: { since: number };
    };
    expect(state.wakeOff.since).toBe(0);

    // 再次关闭：重新起算，不会立刻又告警
    await attemptWake(baseReq({ env: offEnv, now: now + 8000 }));
    expect(eventsNamed('wake-off-alert')).toHaveLength(1);
    state = JSON.parse(readFileSync(wakeAlertStateFile(stateRoot), 'utf8')) as { wakeOff: { since: number } };
    expect(state.wakeOff.since).toBe(now + 8000);
  });

  it('owner-present 等非开关挡下不记持续态（只有生效值 false 才记）', async () => {
    await seedTeam();
    await seedPending();
    const env = { XC_WAKE_ENABLED: 'true', XC_WAKE_OFF_ALERT_MS: '5000' };
    await attemptWake(baseReq({ env, now, ownerAbsent: false, capacitySample: greenSample() }));
    expect(existsSync(wakeAlertStateFile(stateRoot))).toBe(false); // 没建 wakeOff 账
  });

  it('XC_WAKE_OFF_ALERT_MS=0 → 关该告警', async () => {
    await seedTeam();
    await seedPending();
    const env = { XC_WAKE_OFF_ALERT_MS: '0' };
    await attemptWake(baseReq({ env, now }));
    await attemptWake(baseReq({ env, now: now + 600000 }));
    expect(eventsNamed('wake-off-alert')).toHaveLength(0);
  });
});

// ─────────────────────────── B2：闸状态读数 ───────────────────────────

describe('v0.9.3 B2：wakeGateStatus / readActiveWakeCooldowns', () => {
  const now = 1_800_000_000_000;

  it('RED deferral 后：blocked + 条件名 + 下次重判时刻 + 本窗计数', async () => {
    await seedTeam();
    await attemptWake(baseReq({ now, capacitySample: redSample() }));
    const status = await wakeGateStatus(stateRoot, {}, now + 1000);
    expect(status.enabled).toBe(true);
    expect(status.blocked).toBe(true);
    // 该样本同时命中 watermark 与 turn-concurrency（13×1.5GB > 可用 2.79GB）
    expect(status.conditions).toEqual(['watermark', 'turn-concurrency']);
    expect(status.nextRetryAt).toBe(now + 120_000);
    expect(status.deferredWindowCount).toBe(1);
    expect(status.deferredAlertThreshold).toBe(5);
    const scopes = status.blockedScopes;
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.scope).toBe('default|b|normal');
    expect(scopes[0]!.conditions).toEqual(['watermark', 'turn-concurrency']);
    expect(scopes[0]!.retryAfterMs).toBe(119_000);
    expect(scopes[0]!.detail.some((d) => d.startsWith('watermark:'))).toBe(true);
  });

  it('GREEN 后：未阻塞、条件空、nextRetryAt=null（不显示阻塞）', async () => {
    await seedTeam();
    await attemptWake(baseReq({ now, capacitySample: greenSample() }));
    const status = await wakeGateStatus(stateRoot, {}, now + 1000);
    expect(status.blocked).toBe(false);
    expect(status.conditions).toEqual([]);
    expect(status.blockedScopes).toEqual([]);
    expect(status.nextRetryAt).toBeNull();
  });

  it('过期冷却条目不算活跃（读数是「此刻」的阻塞面）', async () => {
    await seedTeam();
    await attemptWake(baseReq({ now, capacitySample: redSample() }));
    const later = await wakeGateStatus(stateRoot, {}, now + 200_000);
    expect(later.blocked).toBe(false);
    expect(later.nextRetryAt).toBeNull();
  });

  it('分层阈值与来源进读数（file 层生效时 thresholds 听 file 的）', async () => {
    await seedTeam();
    seedConfig({ capacity: { warn_watermark: 0.6, turn_estimate_bytes: 2048 } });
    const status = await wakeGateStatus(stateRoot, {}, now);
    expect(status.thresholds.warnWatermark).toBe(0.6);
    expect(status.thresholds.turnEstimateBytes).toBe(2048);
    expect(status.thresholdSources.warn_watermark).toBe('file');
    expect(status.thresholdSources.turn_estimate_bytes).toBe('file');
    expect(status.thresholdSources.wake_gate).toBe('default');
  });

  it('file 层 wake_gate=false → 读数 enabled=false（观测面如实报关闸）', async () => {
    await seedTeam();
    seedConfig({ capacity: { wake_gate: false } });
    const status = await wakeGateStatus(stateRoot, {}, now);
    expect(status.enabled).toBe(false);
  });

  it('warnings 进读数（file 键畸形披露）', async () => {
    await seedTeam();
    seedConfig({ capacity: { warn_watermark: 'x' } });
    const status = await wakeGateStatus(stateRoot, {}, now);
    expect(status.warnings.some((w) => w.includes('warn_watermark'))).toBe(true);
  });

  it('readActiveWakeCooldowns 对坏文件返回空数组（不抛）', async () => {
    mkdirSync(join(stateRoot, 'capacity'), { recursive: true });
    writeFileSync(join(stateRoot, 'capacity', 'wake-deferred.json'), '{ broken', 'utf8');
    expect(await readActiveWakeCooldowns(stateRoot, now)).toEqual([]);
  });

  it('紧急 relay 单独键域（紧急度分域在读数里可辨）', async () => {
    await seedTeam();
    await attemptWake(baseReq({ now, capacitySample: redSample(), urgent: true }));
    const scopes = await readActiveWakeCooldowns(stateRoot, now + 1000);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.scope).toBe('default|b|urgent');
    expect(scopes[0]!.urgent).toBe(true);
  });
});

// ─────────────────────────── 文档登记（PROTOCOL §15.7 + README 24 + §9 env） ───────────────────────────

describe('v0.9.3 组B 文档登记（PROTOCOL §15.7 + 已知限制 24 + §9 env 表）', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');
  const protocol = read('docs/PROTOCOL.md');
  // v0.9.4 B3：已知限制整段搬去 docs/LIMITATIONS.md（README 只留指针）——条目锁随搬家。
  const limitations = read('docs/LIMITATIONS.md');

  it('PROTOCOL §15.7 在册（B1 段 schema / 优先级 / 畸形披露 / 热生效四口径）', () => {
    expect(protocol).toContain('### 15.7 v0.9.3 增量：配置可观测');
    expect(protocol).toContain('{"wake_enabled": true, "capacity": {"warn_watermark": 0.2, "turn_estimate_bytes": 2147483648, "wake_gate": true}}');
    expect(protocol).toContain('优先级 file > env > 内置默认');
    expect(protocol).toContain('每次现读无缓存');
    expect(protocol).toContain('capacity/config-state.json');
    expect(protocol).toContain('capacity/wake-alert-state.json');
  });

  it('§9 env 表登记三个新 env（缺省值 + 0=关 + 回落口径）', () => {
    expect(protocol).toContain('`XC_DEFERRED_ALERT_N`（v0.9.3 B3 wake-deferred 累积告警阈值，缺省 5');
    expect(protocol).toContain('`XC_DEFERRED_ALERT_WINDOW_MS`（v0.9.3 B3 累积窗，缺省 600000=10min');
    expect(protocol).toContain('`XC_WAKE_OFF_ALERT_MS`（v0.9.3 B3 唤醒开关持续关闭告警阈值，缺省 1800000=30min');
  });

  it('已知限制 24 在场（含边界声明：doctor/journal/checkpoint 仍 env 口径；v0.9.4 B3 起在 docs/LIMITATIONS.md）', () => {
    const item = limitations.split('\n').find((l) => l.startsWith('24. **容量闸三旋钮走 config.json'));
    expect(item).toBeDefined();
    expect(item!).toContain('warn_watermark');
    expect(item!).toContain('config-effective-changed');
    expect(item!).toContain('xc_doctor');
  });

  it('冻结契约：三个新 engine 事件块 ↔ 实跑键集对拍（行级 ts 除外）', async () => {
    const sortedKeys = (o: Record<string, unknown>): string[] => Object.keys(o).sort();
    const blockAfter = (heading: string): Record<string, unknown> => {
      const at = protocol.indexOf(heading);
      expect(at).toBeGreaterThan(0);
      const block = protocol.slice(at, at + 2000).match(/```json\r?\n([\s\S]*?)```/);
      expect(block).not.toBeNull();
      return JSON.parse(block![1]!) as Record<string, unknown>;
    };
    // config-effective-changed
    await seedTeam();
    const now = 1_800_000_000_000;
    await attemptWake(baseReq({ now, capacitySample: greenSample() }));
    seedConfig({ capacity: { warn_watermark: 0.2 } });
    await attemptWake(baseReq({ now: now + 1000, toAgentKey: 'c', toSessionId: 'sess_c', capacitySample: greenSample() }));
    const changed = eventsNamed('config-effective-changed')[0]!;
    const { ts: _t1, ...changedFields } = changed;
    expect(sortedKeys(changedFields)).toEqual(sortedKeys(blockAfter('**engine 事件 `config-effective-changed`**')));

    // wake-deferred-alert（新 stateRoot 避免上一段基线干扰）
    workDir = mkdtempSync(join(tmpdir(), 'xc-v093-gate-doc-'));
    stateRoot = join(workDir, '.crosschat');
    dirs.push(workDir);
    await seedTeam();
    const env = { XC_WAKE_ENABLED: 'true', XC_MEM_WAKE_COOLDOWN_MS: '0', XC_DEFERRED_ALERT_N: '2' };
    await attemptWake(baseReq({ env, now, capacitySample: redSample() }));
    await attemptWake(baseReq({ env, now: now + 1000, capacitySample: redSample() }));
    const alert = eventsNamed('wake-deferred-alert')[0]!;
    const { ts: _t2, ...alertFields } = alert;
    expect(sortedKeys(alertFields)).toEqual(sortedKeys(blockAfter('**engine 事件 `wake-deferred-alert`**')));

    // wake-off-alert（再换一个 stateRoot）
    workDir = mkdtempSync(join(tmpdir(), 'xc-v093-gate-doc2-'));
    stateRoot = join(workDir, '.crosschat');
    dirs.push(workDir);
    await seedTeam();
    await appendMailbox(stateRoot, 'default', 'b', createMessage('a', 'b', 'pending'));
    await attemptWake(baseReq({ env: { XC_WAKE_OFF_ALERT_MS: '1000' }, now }));
    await attemptWake(baseReq({ env: { XC_WAKE_OFF_ALERT_MS: '1000' }, now: now + 2000 }));
    const off = eventsNamed('wake-off-alert')[0]!;
    const { ts: _t3, ...offFields } = off;
    expect(sortedKeys(offFields)).toEqual(sortedKeys(blockAfter('**engine 事件 `wake-off-alert`**')));
  });
});
