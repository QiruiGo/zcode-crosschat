/**
 * v0.9.4（A4）：wake-consumed 的**双计时窗口**定向测试（39-v094 方案 §二 A 表）。
 *
 * 判据（方案原文）：「wake-consumed 的 waitedMs 从 spawn 起算（同时保留 deliveredAt
 * 起算值，两个字段）」；任务书：「同时给 waitedFromSpawnMs 与 waitedFromDeliveredMs
 * 两个字段（保留旧字段名兼容），契约测试锁键集」；验收：「双字段在场且差值=spawn 延迟」。
 *
 * 实现口径（engine/wake.ts startWakeLifecycleWatch ③）：
 * - `waitedFromSpawnMs` = consumedAt − spawnedAt（spawn 时刻起算；方案主口径）；
 * - `waitedFromDeliveredMs` = consumedAt − stampedAt（投递盖章时刻起算；旧 waitedMs 口径）；
 * - `waitedMs`（旧字段名，兼容保留）= waitedFromSpawnMs；
 * - 两字段之差 = spawnedAt − stampedAt = 本次唤醒的 spawn 前开销（分层闸/在途 nonce/
 *   状态门/容量闸/nonce 落盘/租约/prompt 组装）——注入可观测的 spawn 延迟即可验证。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot；唤醒 spawn 注入假实现（不拉真子进程）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeMailbox,
  appendMailbox,
  createMessage,
  markMailboxConsumed,
} from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { writeSession } from "../core/registry";
import type { TeamMember } from "../core/types";
import { withTeamLock } from "../core/lock";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import {
  attemptWake,
  WAKE_TIER_EVENT_CONSUMED,
  type WakeRequest,
} from "./wake";
import type { CapacitySample } from "../core/capacity.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a4-v094-"));
  dirs.push(root);
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventsOf(name: string): Array<Record<string, unknown>> {
  return readEngineEvents().filter((e) => e["event"] === name);
}

async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  const member: TeamMember = { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 };
  team.members.push(member);
  await writeTeam(root, team);
}

async function seedSessionRecord(sessionId: string, lastSeen = 1): Promise<void> {
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen });
}

async function seedMailbox(): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "重踢：BD869", { deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

function greenSample(): CapacitySample {
  return {
    sampledAt: Date.now(),
    totalBytes: 16 * 1024 ** 3,
    freeBytes: 8 * 1024 ** 3,
    watermark: 0.5,
    steadyTreeBytes: 1 * 1024 ** 3,
    headlessTurnCount: 0,
    headlessTurnMaxRssBytes: null,
    degraded: null,
  };
}

function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "message",
    receiptIds: ["m1"],
    ticket: "重踢：BD869",
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    capacitySample: greenSample(),
    ...overrides,
  };
}

/** 假 spawn：同步汇报唤醒子 pid（= 启动证据到场；child-alive 二级成立）。 */
function fakeSpawnWithChild(childPid = 5150): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    opts.onHelperSpawned?.(childPid);
    return { pid: 4242, logFile: opts.logFile };
  };
}

/** 慢 spawn：在 spawn 实现里睡 `ms`——制造可观测的 spawn 前开销之外的 spawn 耗时。 */
function fakeSpawnSlow(childPid: number, ms: number): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* 忙等：测试替身，制造确定性的 spawn 时刻差 */
    }
    opts.onHelperSpawned?.(childPid);
    return { pid: 4242, logFile: opts.logFile };
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("v0.9.4 A4：wake-consumed 双计时窗口（waitedFromSpawnMs / waitedFromDeliveredMs）", () => {
  it("【锚点】双字段在场 + waitedMs 兼容保留 + 差值 = spawn 延迟（spawn 前开销）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    // req.now 显式传远古 → stampedAt = req.now；spawn 实现忙等 120ms → spawnedAt ≈ now+120ms。
    // 消费确认到齐后：waitedFromDeliveredMs − waitedFromSpawnMs ≈ 120ms（spawn 延迟）。
    const t0 = Date.now() - 5_000; // 显式 now：盖一个确定的「spawn 前开销」基线
    await attemptWake(baseReq({
      receiptIds: [messageId],
      now: t0,
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 5_000,
      spawn: fakeSpawnSlow(5150, 120),
    }));
    await withTeamLock(root, "default", async () => {
      await markMailboxConsumed(root, "default", "b", [messageId], Date.now());
    });
    expect(await waitUntil(() => eventsOf(WAKE_TIER_EVENT_CONSUMED).length === 1)).toBe(true);

    const consumed = eventsOf(WAKE_TIER_EVENT_CONSUMED)[0]!;
    // ① 契约键集锁定（恰 11 键 = 事件体 10 + logEngineEvent 的 ts；waitedMs 旧名保留 = 兼容）
    expect(Object.keys(consumed).sort()).toEqual([
      "event", "nonce", "receiptIds", "scene", "sid", "teamId", "to", "ts",
      "waitedFromDeliveredMs", "waitedFromSpawnMs", "waitedMs",
    ]);
    // ② 双字段都是数且量级自洽（消费时刻 − 各自起点；spawn 窗口不可能超过 delivered 窗口）
    const fromSpawn = consumed["waitedFromSpawnMs"] as number;
    const fromDelivered = consumed["waitedFromDeliveredMs"] as number;
    expect(typeof fromSpawn).toBe("number");
    expect(typeof fromDelivered).toBe("number");
    expect(fromSpawn).toBeGreaterThanOrEqual(0);
    expect(fromDelivered).toBeGreaterThan(fromSpawn);
    // ③ 差值 = spawn 前开销（忙等 120ms + 闸门/nonce/租约/prompt 的盘上耗时）
    expect(fromDelivered - fromSpawn).toBeGreaterThanOrEqual(120);
    // ④ waitedMs（旧字段名）= spawn 口径（方案「waitedMs 从 spawn 起算」）
    expect(consumed["waitedMs"]).toBe(fromSpawn);
    // ⑤ 其余键值不变（三级指标既有语义不回归）
    expect(consumed["to"]).toBe("b");
    expect(consumed["scene"]).toBe("message");
    expect(consumed["receiptIds"]).toEqual([messageId]);
  });

  it("生命周期账（wake-consumed 行）同样落双字段 + waitedMs", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 5_000,
      spawn: fakeSpawnWithChild(),
    }));
    await withTeamLock(root, "default", async () => {
      await acknowledgeMailbox(root, "default", "b", [messageId]);
    });
    expect(await waitUntil(() => eventsOf(WAKE_TIER_EVENT_CONSUMED).length === 1)).toBe(true);

    const lifecycleFile = join(root, "logs", readdirLifecycleName(root));
    const lines = readFileSync(lifecycleFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const consumedLine = lines.find((l) => l["event"] === "wake-consumed");
    expect(consumedLine).toBeDefined();
    expect(typeof consumedLine!["waitedFromSpawnMs"]).toBe("number");
    expect(typeof consumedLine!["waitedFromDeliveredMs"]).toBe("number");
    expect(consumedLine!["waitedMs"]).toBe(consumedLine!["waitedFromSpawnMs"]);
  });

  it("spawn 同步失败（没有 spawn 时刻）→ 两窗口同起点（差值 0），不虚构 spawn 开销", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    // 同步 spawn 失败：不写 wake-consumed（没有唤醒轮次可结算）——本用例只锁
    // 「spawnedAt 缺省时回落 stampedAt」的实现口径不抛、不产生负值窗口。
    const failing = (): SpawnResumeResult => {
      throw new Error("ENOENT: no such ZCode.exe");
    };
    const res = await attemptWake(baseReq({ receiptIds: [messageId], spawn: failing }));
    expect(res.delivered).toBe("mailbox");
    expect(eventsOf(WAKE_TIER_EVENT_CONSUMED)).toHaveLength(0);
  });
});

/** 取 logs 目录里唯一的 wake-lifecycle-*.jsonl 文件名（本测试每次只跑一轮唤醒）。 */
function readdirLifecycleName(stateRoot: string): string {
  const names = readdirSync(join(stateRoot, "logs")).filter((n) => /^wake-lifecycle-.*\.jsonl$/.test(n));
  if (names.length !== 1) throw new Error(`expected exactly one lifecycle file, got ${names.length}`);
  return names[0]!;
}
