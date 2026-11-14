/**
 * v0.6 C1（M4）单测：urgent 唤醒（DESIGN-V0.6.md §3.1 读取序 3 / §4.2-M4）。
 *
 * 覆盖面：
 * - buildWakePrompt urgent=true → 正文携带段首位 URGENT 横幅（结构性部分不动）；
 * - urgent=false / 缺省 → 与 v0.5 行为逐字节一致（无横幅）；
 * - urgent 唤醒三态决策不豁免（decideDelivery 条件不变）；
 * - attemptWake 透传 urgent → spawn prompt 带横幅 + engine.jsonl wake 行带 urgent 标记。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attemptWake,
  buildWakePrompt,
  decideDelivery,
  URGENT_WAKE_BANNER,
  type WakeRequest,
} from './wake.js';
import type { SpawnResumeOptions, SpawnResumeResult } from './resume-cli.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xc-wake-urgent-'));
  mkdirSync(join(root, 'logs'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, 'logs', 'engine.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type CapturedSpawn = SpawnResumeOptions;

function fakeSpawn(pid: number | undefined, captured: CapturedSpawn[]): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    captured.push(opts);
    return { pid, logFile: opts.logFile };
  };
}

function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: 'default',
    toAgentKey: 'b',
    toSessionId: 'sess_b',
    workspace: 'D:\\ws',
    reason: 'message',
    receiptIds: ['m1'],
    ticket: 'urgent-intervention-body',
    env: { XC_WAKE_ENABLED: 'true' },
    cfg: { zcodeExe: 'Z.exe', zcodeCjs: 'z.cjs' },
    ...overrides,
  };
}

// ─────────────────────────── buildWakePrompt ───────────────────────────

describe('buildWakePrompt urgent（正文携带段首位横幅）', () => {
  const baseInput = {
    teamId: 'default',
    recipientKey: 'b',
    recipientSessionId: 'sess_b',
    wakeToken: 'tok123',
    receiptIds: ['m1'],
    bodyText: '正文内容',
  } as const;

  it('urgent=true：横幅位于正文首位，回执行/身份行结构不变', () => {
    const prompt = buildWakePrompt({ ...baseInput, urgent: true });
    // 回执行仍是首行（结构性部分纪律）。
    expect(prompt.startsWith('[CrossChat inbox receipt: ')).toBe(true);
    // 横幅在正文段首位（位于身份行之后）。
    const bannerIndex = prompt.indexOf(URGENT_WAKE_BANNER);
    expect(bannerIndex).toBeGreaterThan(0);
    expect(prompt.indexOf('正文内容')).toBeGreaterThan(bannerIndex);
    // 横幅与正文之间恰好一个换行（同一携带段）。
    expect(prompt).toContain(`${URGENT_WAKE_BANNER}\n正文内容`);
    // 总长仍在预算内。
    expect(prompt.length).toBeLessThanOrEqual(4000);
  });

  it('urgent 缺省/false：无横幅（v0.5 行为逐字节一致）', () => {
    const plain = buildWakePrompt(baseInput);
    const urgentOff = buildWakePrompt({ ...baseInput, urgent: false });
    expect(plain).not.toContain(URGENT_WAKE_BANNER);
    expect(urgentOff).toBe(plain);
  });

  it('urgent 横幅计入正文预算：超长正文仍截到 ≤4000 且横幅在场（头部优先保留）', () => {
    const longBody = 'x'.repeat(6000);
    const prompt = buildWakePrompt({ ...baseInput, bodyText: longBody, urgent: true });
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt).toContain(URGENT_WAKE_BANNER);
    expect(prompt.endsWith('…[truncated]')).toBe(true);
  });

  it('urgent=true + dispatch 守则场景：横幅仍在守则段之前（携带段次序 receipt→identity→body(横幅)→rules）', () => {
    const prompt = buildWakePrompt({ ...baseInput, urgent: true, includeMemberRules: true });
    const bannerIdx = prompt.indexOf(URGENT_WAKE_BANNER);
    const rulesIdx = prompt.indexOf('成员守则 v2');
    expect(bannerIdx).toBeGreaterThan(0);
    expect(rulesIdx).toBeGreaterThan(bannerIdx);
  });
});

// ─────────────────────────── 三态决策不豁免 ───────────────────────────

describe('urgent 不改变 decideDelivery 三态决策（E1：忙→下一回合）', () => {
  it('wake 关/属主在场/在途 nonce 的判定与 urgent 无关（决策函数无 urgent 入参）', () => {
    expect(decideDelivery({ wakeEnabledRaw: undefined }).mode).toBe('mailbox');
    expect(decideDelivery({ wakeEnabledRaw: 'true', ownerAbsent: false }).mode).toBe('mailbox');
    expect(decideDelivery({ wakeEnabledRaw: 'true', inflight: true }).mode).toBe('mailbox');
    expect(decideDelivery({ wakeEnabledRaw: 'true' }).mode).toBe('wake');
  });
});

// ─────────────────────────── attemptWake 透传 ───────────────────────────

describe('attemptWake urgent 透传（spawn prompt + 审计）', () => {
  it('urgent=true：spawn prompt 带横幅；engine.jsonl wake 行带 urgent:true', async () => {
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ urgent: true, spawn: fakeSpawn(4242, captured) }));
    expect(res.delivered).toBe('wake');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.prompt).toContain(URGENT_WAKE_BANNER);
    const wakeEvents = readEngineEvents().filter((e) => e['event'] === 'wake');
    expect(wakeEvents).toHaveLength(1);
    expect(wakeEvents[0]!['urgent']).toBe(true);
  });

  it('urgent 缺省：prompt 无横幅；wake 行无 urgent 键', async () => {
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ spawn: fakeSpawn(4243, captured) }));
    expect(res.delivered).toBe('wake');
    expect(captured[0]!.prompt).not.toContain(URGENT_WAKE_BANNER);
    const wakeEvents = readEngineEvents().filter((e) => e['event'] === 'wake');
    expect(wakeEvents[0]!['urgent']).toBeUndefined();
  });

  it('urgent=true 但 wake 关闭（XC_WAKE_ENABLED 非 "true"）：mailbox 降级，不 spawn、不落横幅', async () => {
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      urgent: true,
      env: { XC_WAKE_ENABLED: 'false' },
      spawn: fakeSpawn(1, captured),
    }));
    expect(res.delivered).toBe('mailbox');
    expect(captured).toHaveLength(0);
  });
});
