/**
 * v0.9.4（A2）：wake-child **exit 尾行**定向测试（39-v094 方案 §二 A 表）。
 *
 * 判据（方案原文）：「生命周期账补 exit 尾行（时长、是否确认、退出时可观测信息），
 * 子进程消失即写；无 exit 观测时不误写」；任务书覆盖点：「不伪造」。
 *
 * 实现口径（engine/wake.ts startWakeLifecycleWatch ① + releaseOnFailure）：
 * - 观察到唤醒子进程消失（pid 已汇报 ∧ pidAlive=false）**即写** exit 尾行：
 *   `{event:"wake-child-exit", pid, durationMs, exitCode:null, startConfirmed, evidence?}`；
 * - `startConfirmed`（v0.9.4 新增的「是否确认」）= 启动确认结算值（true/false）；
 *   监视器观察到退出时确认尚未落账 → `null`（不猜、不伪造）；
 * - `exitCode` 恒 null：孤儿化唤醒子（V9 边界）的退出码对引擎进程不可观测——如实记
 *   null，失败语义由 `evidence`（wake 日志快照）承载；
 * - spawn 同步失败（子进程从未存在）→ exit 尾行 `pid:null, durationMs:0,
 *   startConfirmed:false, spawnError`（start 头行不悬空）；
 * - 无 exit 观测（子进程还活着/pid 从未汇报）→ **不写** exit 尾行（不伪造退出）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMailbox, createMessage } from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { writeSession } from "../core/registry";
import type { TeamMember } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import { attemptWake, type WakeRequest } from "./wake";
import type { CapacitySample } from "../core/capacity.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a2-v094-"));
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

/** 读 lifecycle 账全部行（唯一的 wake-lifecycle-*.jsonl）。 */
function readLifecycleLines(): Array<Record<string, unknown>> {
  const names = readdirSync(join(root, "logs")).filter((n) => /^wake-lifecycle-.*\.jsonl$/.test(n));
  if (names.length !== 1) throw new Error(`expected exactly one lifecycle file, got ${names.length}`);
  return readFileSync(join(root, "logs", names[0]!), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("v0.9.4 A2：wake-child exit 尾行（时长/是否确认/可观测信息；不伪造）", () => {
  it("【锚点】唤醒子消失即写 exit 尾行：pid + durationMs + exitCode:null + startConfirmed 在场", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    // 假 spawn：helper 汇报一个**本机不存在**的 pid（启动证据到场；随即判死）。
    const ghostPid = 0x7fffffff;
    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 5_000,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(ghostPid);
        return { pid: 4242, logFile: opts.logFile };
      },
    }));

    expect(await waitUntil(() => readLifecycleLines().some((l) => l["event"] === "wake-child-exit"))).toBe(true);
    const exit = readLifecycleLines().find((l) => l["event"] === "wake-child-exit")!;
    expect(exit["pid"]).toBe(ghostPid);
    expect(typeof exit["durationMs"]).toBe("number"); // 时长
    expect((exit["durationMs"] as number) >= 0).toBe(true);
    expect(exit["exitCode"]).toBe(null); // 孤儿化唤醒子退出码不可观测——如实 null
    expect(exit["startConfirmed"]).toBe(true); // helper 汇报过 pid = 启动确认成立
    // 恰一条 exit 尾行（同一轮死亡不重复落账）
    expect(readLifecycleLines().filter((l) => l["event"] === "wake-child-exit")).toHaveLength(1);
  });

  it("无 exit 观测（唤醒子 pid 仍活着）→ 不写 exit 尾行（不伪造退出）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    // 用本进程 pid 当唤醒子 pid（必然活着）→ 监视器看不到退出。
    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 1_200,
      pidAliveProbe: () => true, // 注入恒活（不依赖真实 pid 语义）
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(process.pid);
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    // 等满监视窗（1.2s）后：只有 start 头行，没有任何 exit 尾行。
    await new Promise((r) => setTimeout(r, 1_500));
    const lines = readLifecycleLines();
    expect(lines.some((l) => l["event"] === "wake-child-start")).toBe(true);
    expect(lines.some((l) => l["event"] === "wake-child-exit")).toBe(false);
  });

  it("helper 从未汇报 pid（无启动证据）→ 也看不到退出：不写 exit 尾行", async () => {
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
      lifecycleWindowMs: 1_200,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => ({ pid: 4242, logFile: opts.logFile }),
    }));
    await new Promise((r) => setTimeout(r, 1_500));
    const lines = readLifecycleLines();
    expect(lines.some((l) => l["event"] === "wake-child-exit")).toBe(false);
  });

  it("spawn 同步失败（子进程从未存在）→ exit 尾行 pid:null/startConfirmed:false/spawnError 在场", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const failing = (): SpawnResumeResult => {
      throw new Error("ENOENT: no such ZCode.exe");
    };
    await attemptWake(baseReq({ receiptIds: [messageId], spawn: failing }));
    const lines = readLifecycleLines();
    const exit = lines.find((l) => l["event"] === "wake-child-exit")!;
    expect(exit).toBeDefined();
    expect(exit["pid"]).toBe(null);
    expect(exit["durationMs"]).toBe(0);
    expect(exit["exitCode"]).toBe(null);
    expect(exit["startConfirmed"]).toBe(false); // 子进程从未被拉起：确认无从成立
    expect(String(exit["spawnError"])).toContain("ENOENT");
  });

  it("wake 日志含失败证据 → exit 尾行带 evidence 快照（退出时可观测信息）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const ghostPid = 0x7ffffffe;
    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 5_000,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        // 同步写一行失败证据进 wake 日志（模拟唤醒子 CLI 崩溃输出）。
        mkdirSync(join(root, "logs"), { recursive: true });
        appendFileSync(opts.logFile, "Error: Session not found: sess-…\n", "utf8");
        opts.onHelperSpawned?.(ghostPid);
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(await waitUntil(() => readLifecycleLines().some((l) => l["event"] === "wake-child-exit"))).toBe(true);
    const exit = readLifecycleLines().find((l) => l["event"] === "wake-child-exit")!;
    expect(String(exit["evidence"])).toContain("Session not found");
    expect(existsSync(join(root, "logs"))).toBe(true);
  });
});
