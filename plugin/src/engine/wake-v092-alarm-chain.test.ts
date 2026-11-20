/**
 * v0.9.2 组A（reports/35-v092方案.md §二 组A 验收锚点）定向单测——
 * **A1 同步启动确认** + **A4 limbo 校准**。
 *
 * 锚点（任务书原文逐条）：
 * - A1 `startConfirmed` **两态**：helper 汇报唤醒子 pid（启动证据）→ true；未见 →
 *   false + 措辞「已发起但未见启动证据」（不再以 fire-and-forget 结案）。等待有提前
 *   出口（helper 已退出而未汇报 = 不可能再有证据），不得白等满窗。
 * - A4(a) 锁竞争回写失败 → **宽限重试**：目标 sid 自盖章后有会话活动时，缺失的
 *   consumedAt 不立即判未消费——宽限窗内不降级，窗过后才判；
 * - A4(b) wake prompt 内嵌消息全文 → 记 `injectedConsumed`，不因未调 xc_read 误判；
 * - A4(c) 降级告警按 (messageId, 轮次) 节流/合并（台账语义在本文件单测，看门狗面的
 *   合并与跨面节流在 watchdog.test.ts）。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot + M1 真实读写函数；唤醒 spawn 注入假实现
 * （不拉真子进程）；pid 存活判定不赌本机 pid 表（假 spawn 返回的 pid 一律取本机
 * 不存在的大数，唯一例外是「证据在窗内迟到」用例——那条必须给一个真活 pid）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeMailbox,
  appendMailbox,
  createMessage,
  limboCandidateMessages,
  readMailbox,
} from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { writeSession } from "../core/registry";
import type { TeamMember } from "../core/types";
import { withTeamLock } from "../core/lock";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import {
  attemptWake,
  createWakeStartLatch,
  START_CONFIRM_DEFAULT_MS,
  startConfirmMsFromEnv,
  wakePromptEmbedsMessageBody,
  type WakeRequest,
} from "./wake";
import type { CapacitySample } from "../core/capacity.js";
import {
  emptyWatchdogState,
  limboAlertAlreadySent,
  markLimboAlertSent,
} from "./watchdog-state";

const dirs: string[] = [];
let root: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v092-a-"));
  dirs.push(root);
});

afterAll(() => {
  for (const child of sleepers) child.kill();
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

/** 读指定 agent 的生命周期日志行（logs/wake-lifecycle-<to>-*.jsonl）。 */
function readLifecycleLines(agentKey: string): Array<Record<string, unknown>> {
  const dir = join(root, "logs");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.startsWith(`wake-lifecycle-${agentKey}-`) && f.endsWith(".jsonl"));
  const lines: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return lines;
}

/**
 * 轮询直到条件成立（每 stepMs 一次，deadline 后返回 false=硬失败）。
 * 判据可以是异步的（读邮箱/读盘）：负载无关地等**事实**成立，不猜固定 sleep。
 */
function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async (): Promise<boolean> => {
    for (;;) {
      if (await check()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  })();
}

/** 起一个真活进程（「证据在窗内迟到」用例要一个真活 pid 让提前出口不触发）。 */
async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

/** 落一个含 lead「a」+ 成员「b」的 team.json（founderKey=a → leadKeyOf=a）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
  const member: TeamMember = { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 };
  team.members.push(member);
  await writeTeam(root, team);
}

/** 会话记录（lastSeen 传 1 = 远古 = 「自盖章后无任何活动」）。 */
async function seedSessionRecord(sessionId: string, lastSeen = 1): Promise<void> {
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen });
}

/** 在当前临时 root 的 b 邮箱落一条消息。 */
async function seedMailbox(content = "重踢：BD869"): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", content, { deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
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

/** 假 spawn：不汇报唤醒子 pid（= 无启动证据），pid 取本机不存在的大数（提前出口立即触发）。 */
function fakeSpawnSilent(pid = 424242): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => ({ pid, logFile: opts.logFile });
}

/**
 * GREEN 容量样本（测试注入）——绕开真采样的 CIM 子进程（数百 ms），让 attemptWake 的
 * 时序确定：闸放行、不 deferral。注入纪律与 req.cfg/req.spawn 同族。
 */
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

// ─────────────────────── A1：同步启动确认（两态） ───────────────────────

describe("v0.9.2 A1：同步启动确认（spawn 后不再以 fire-and-forget 结案）", () => {
  it("env 口径：缺省 5000；正整数生效；0/负/非数字回落缺省（不静默关闸）", () => {
    expect(START_CONFIRM_DEFAULT_MS).toBe(5_000);
    expect(startConfirmMsFromEnv({})).toBe(5_000);
    expect(startConfirmMsFromEnv({ XC_START_CONFIRM_MS: "1234" })).toBe(1234);
    expect(startConfirmMsFromEnv({ XC_START_CONFIRM_MS: "0" })).toBe(5_000);
    expect(startConfirmMsFromEnv({ XC_START_CONFIRM_MS: "-5" })).toBe(5_000);
    expect(startConfirmMsFromEnv({ XC_START_CONFIRM_MS: "abc" })).toBe(5_000);
    expect(startConfirmMsFromEnv({ XC_START_CONFIRM_MS: "  " })).toBe(5_000);
  });

  it("闩单元：signal 先于 confirm → 立即确认（waitedMs 0）；confirm(0) → 未见", async () => {
    const latch = createWakeStartLatch();
    latch.signal(4321);
    expect(latch.evidence?.pid).toBe(4321);
    const first = await latch.confirm(5_000);
    expect(first.confirmed).toBe(true);
    expect(first.pid).toBe(4321);
    expect(first.waitedMs).toBe(0);

    const empty = createWakeStartLatch();
    const second = await empty.confirm(0);
    expect(second.confirmed).toBe(false);
    expect(second.pid).toBeUndefined();
  });

  it("闩单元：证据在窗内迟到（helper 还活着）→ 等到即确认，提前出口不误杀", async () => {
    const latch = createWakeStartLatch();
    setTimeout(() => latch.signal(777), 60).unref();
    const outcome = await latch.confirm(3_000, () => true);
    expect(outcome.confirmed).toBe(true);
    expect(outcome.pid).toBe(777);
    expect(Number(outcome.waitedMs)).toBeGreaterThanOrEqual(40);
  });

  it("闩单元：helper 已退出而未汇报 → 提前出口，不白等满窗", async () => {
    const latch = createWakeStartLatch();
    const startedAt = Date.now();
    const outcome = await latch.confirm(5_000, () => false);
    expect(outcome.confirmed).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("【锚点·startConfirmed=true】helper 汇报唤醒子 pid → true + note/生命周期账/engine 事件三面一致", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      // 关掉失败侦听与生命周期监视的其它信号，隔离启动确认本体。
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: (opts) => {
        opts.onHelperSpawned?.(5150); // helper 同步汇报：唤醒子已被拉起
        return { pid: 4242, logFile: opts.logFile };
      },
    }));

    expect(res.delivered).toBe("wake");
    expect(res.startConfirmed).toBe(true);
    expect(res.note).toContain("启动确认");
    expect(res.note).toContain("已见到 wake-child 启动证据");
    expect(res.note).toContain("5150");
    expect(res.note).toContain("非送达确认"); // 既有承诺短语不回归
    // 生命周期账：confirmed 行与 spawn 前的 start 头行并排
    const lines = readLifecycleLines("b");
    const startLine = lines.find((l) => l["event"] === "wake-child-start");
    const confirmLine = lines.find((l) => l["event"] === "wake-child-start-confirmed");
    expect(startLine).toBeDefined();
    expect(confirmLine?.["pid"]).toBe(5150);
    expect(confirmLine?.["sid"]).toBe("sess_b");
    expect(confirmLine?.["thresholdMs"]).toBe(5_000);
    expect(lines.some((l) => l["event"] === "wake-child-start-unconfirmed")).toBe(false);
    // engine 事件（时间线可查）
    const confirmEvent = readEngineEvents().find((e) => e["event"] === "wake-start-confirm");
    expect(confirmEvent?.["startConfirmed"]).toBe(true);
    expect(confirmEvent?.["to"]).toBe("b");
    expect(confirmEvent?.["pid"]).toBe(5150);
  });

  it("【锚点·startConfirmed=false】注入 spawn（无 helper 汇报通道）→ false + 「已发起但未见启动证据」", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    const startedAt = Date.now();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: fakeSpawnSilent(),
    }));
    const elapsed = Date.now() - startedAt;

    expect(res.delivered).toBe("wake");
    expect(res.startConfirmed).toBe(false);
    // 注入 spawn 没有汇报通道：不空等满窗（5s 缺省窗）
    expect(elapsed).toBeLessThan(2_000);
    // 措辞硬口径：不得再说「已发起」就完事
    expect(res.note).toContain("已发起但未见启动证据");
    expect(res.note).toContain("非送达确认");
    expect(res.note).not.toContain("已见到 wake-child 启动证据");
    // 三面对齐：unconfirmed 生命周期行 + engine 事件 false
    expect(readLifecycleLines("b").some((l) => l["event"] === "wake-child-start-unconfirmed")).toBe(true);
    expect(readLifecycleLines("b").some((l) => l["event"] === "wake-child-start-confirmed")).toBe(false);
    const confirmEvent = readEngineEvents().find((e) => e["event"] === "wake-start-confirm");
    expect(confirmEvent?.["startConfirmed"]).toBe(false);
    // 消息仍在邮箱（pull 兜底不丢）——「未见启动证据」不等于失败，不释放投递
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.deliveredAt).toBeDefined();
  });

  it("注入 spawn 但 helper 同步汇报 → 仍确认（注入纪律：上报即证据，不等候）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: (opts) => {
        opts.onHelperSpawned?.(5150); // helper 同步汇报：唤醒子已被拉起
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(res.startConfirmed).toBe(true);
    expect(res.note).toContain("已见到 wake-child 启动证据");
    const line = readLifecycleLines("b").find((l) => l["event"] === "wake-child-start-confirmed");
    expect(line?.["pid"]).toBe(5150);
  });
});

// ─────────────────────── A4：limbo 判据校准 ───────────────────────

describe("v0.9.2 A4：limbo 校准（三处误判不再降级）", () => {
  it("scene → prompt 是否内嵌消息全文（纯函数；message/withdrawal 才算全文）", () => {
    expect(wakePromptEmbedsMessageBody("message")).toBe(true);
    expect(wakePromptEmbedsMessageBody("withdrawal")).toBe(true);
    for (const scene of ["dispatch", "report", "unblock", "idle", "cancel", "post-provision", "shutdown", "stale-sweep", "task-offline"]) {
      expect(wakePromptEmbedsMessageBody(scene)).toBe(false);
    }
  });

  it("候选判据纯函数（core/mailbox.ts 单一真源；sweep 与预读共用）", () => {
    const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
    const base = { from: "a", to: "b", ts: 1 };
    const stamped = { ...createMessage("a", "b", "x"), ...base, deliveredAt: 1_000 };
    const now = 1_000 + 600_000;
    expect(limboCandidateMessages([stamped], team, now, 600_000)).toHaveLength(1);
    // 已消费 / 已读 / 已作废 / 未超时 → 都不是候选
    expect(limboCandidateMessages([{ ...stamped, consumedAt: 1_500 }], team, now, 600_000)).toHaveLength(0);
    expect(limboCandidateMessages([{ ...stamped, readAt: 1_500 }], team, now, 600_000)).toHaveLength(0);
    expect(limboCandidateMessages([{ ...stamped, discardedAt: 1_500 }], team, now, 600_000)).toHaveLength(0);
    expect(limboCandidateMessages([stamped], team, 1_000 + 599_999, 600_000)).toHaveLength(0);
  });

  it("【锚点A4-a·锁竞争宽限】会话活着而被知会 → 宽限窗内不降级；窗过后才判", async () => {
    await seedTeam();
    const messageId = await seedMailbox();
    // 会话活动**先于** spawn 落定（生产形态：成员回合早已在跑，hook 每回合刷 lastSeen），
    // 盖章时刻取 200ms 前 ⇒ 判据「自盖章后有活动」恒真，且 elapsed 仍落在宽限窗内。
    await seedSessionRecord("sess_b", Date.now());

    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      now: Date.now() - 200,
      // dispatch 场景：prompt 不内嵌全文，隔离宽限本体（A4-b 另有用例）
      reason: "dispatch",
      watchWindowMs: 0,
      limboTimeoutMs: 300,
      limboGraceMs: 700,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 4_000,
      wakeSlowMs: 3_600_000,
      spawn: fakeSpawnSilent(),
    }));
    expect(res.delivered).toBe("wake");

    // 宽限窗内（>limboTimeout 但 < limboTimeout+grace）：不判未消费、不降级、不告警
    await new Promise((r) => setTimeout(r, 500));
    expect(readEngineEvents().some((e) => e["event"] === "message-limbo")).toBe(false);
    expect((await readMailbox(root, "default", "b"))[0]!.deliveredAt).toBeDefined();
    expect((await readMailbox(root, "default", "a")).length).toBe(0); // 无 limbo 告警

    // 宽限过后仍无消费确认 → 才降级（那时确实无人消费）
    expect(await waitUntil(() => readEngineEvents().some((e) => e["event"] === "message-limbo"), 4_000)).toBe(true);
    expect((await readMailbox(root, "default", "b"))[0]!.deliveredAt).toBeUndefined();
  });

  it("【锚点A4-b·injectedConsumed】prompt 内嵌全文且回合已开跑 → 记 consumedAt，不降级不告警", async () => {
    await seedTeam();
    const messageId = await seedMailbox();
    await seedSessionRecord("sess_b", Date.now());

    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      now: Date.now() - 200,
      reason: "message", // prompt 内嵌消息全文
      watchWindowMs: 0,
      limboTimeoutMs: 300,
      limboGraceMs: 5_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 4_000,
      wakeSlowMs: 3_600_000,
      spawn: fakeSpawnSilent(),
    }));
    expect(res.delivered).toBe("wake");

    // 等到 injectedConsumed 回写
    expect(await waitUntil(() =>
      readLifecycleLines("b").some((l) => l["event"] === "injected-consumed"), 4_000)).toBe(true);
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.consumedAt).toBeDefined(); // 消费确认已回写
    expect(box[0]!.readAt).toBeUndefined();   // readAt 仍归 xc_read（本回写只证明「看到了」）
    expect(box[0]!.deliveredAt).toBeDefined(); // 未被降级（盖章不清）
    // 不误判：无 limbo 事件、无 lead 告警
    expect(readEngineEvents().some((e) => e["event"] === "message-limbo")).toBe(false);
    expect(await readMailbox(root, "default", "a")).toHaveLength(0);
    const injected = readLifecycleLines("b").find((l) => l["event"] === "injected-consumed");
    expect(injected?.["messageIds"]).toEqual([messageId]);
  });

  it("【锚点A4-b 反例】prompt 不内嵌全文（dispatch）→ 不记 injectedConsumed，照旧走判据", async () => {
    await seedTeam();
    const messageId = await seedMailbox();
    await seedSessionRecord("sess_b", Date.now());

    await attemptWake(baseReq({
      receiptIds: [messageId],
      now: Date.now() - 200,
      reason: "dispatch",
      watchWindowMs: 0,
      limboTimeoutMs: 300,
      limboGraceMs: 5_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 4_000,
      wakeSlowMs: 3_600_000,
      spawn: fakeSpawnSilent(),
    }));
    await new Promise((r) => setTimeout(r, 600));
    expect(readLifecycleLines("b").some((l) => l["event"] === "injected-consumed")).toBe(false);
    // 宽限期内不降级（A4-a 接管），consumedAt 也没有
    expect((await readMailbox(root, "default", "b"))[0]!.consumedAt).toBeUndefined();
    expect((await readMailbox(root, "default", "b"))[0]!.deliveredAt).toBeDefined();
  });

  it("【锚点A4-c·节流语义】(messageId, 轮次) 已告警 → 抑制；新一轮盖章 → 放行；无键 → 不抑制", () => {
    const state = emptyWatchdogState();
    expect(limboAlertAlreadySent(state, "m1", 1_000)).toBe(false);
    markLimboAlertSent(state, "m1", 1_000, 2_000);
    expect(limboAlertAlreadySent(state, "m1", 1_000)).toBe(true); // 同一轮次：抑制
    expect(limboAlertAlreadySent(state, "m1", 9_999)).toBe(false); // 重新盖章 = 新一轮：放行
    expect(limboAlertAlreadySent(state, "m2", 1_000)).toBe(false); // 别的消息不受影响
    expect(limboAlertAlreadySent(state, "m1", undefined)).toBe(false); // 无轮次键：不抑制（不漏报）
  });

  it("【回归】会话全静默（无活动投影）→ 不宽限、不注入消费，超时即降级（v0.9.1 锚点1 不回归）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b"); // lastSeen 远古：唤醒回合从未开跑
    const messageId = await seedMailbox();

    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      reason: "message",
      watchWindowMs: 0,
      limboTimeoutMs: 250,
      limboGraceMs: 5_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 3_000,
      wakeSlowMs: 3_600_000,
      spawn: fakeSpawnSilent(),
    }));
    expect(res.delivered).toBe("wake");

    expect(await waitUntil(() => readEngineEvents().some((e) => e["event"] === "message-limbo"))).toBe(true);
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.deliveredAt).toBeUndefined();
    expect(box[0]!.consumedAt).toBeUndefined();
    // 告知在事件**之后**落账（降级 → message-limbo 事件 → urgent 告知 lead，wake.ts
    // 1433→1451）：等「lead 已被告知」这个事实本身，而不是等事件后猜一段固定时间——
    // 全量并行负载下事件与告知之间的间隔会拉宽，等事件即读邮箱曾偶发读到空箱
    // （round8 负载复现实测：expected [] to have a length of 1）。
    expect(await waitUntil(async () => (await readMailbox(root, "default", "a")).length === 1)).toBe(true);
    // lead 收到恰一条 urgent 告知（合并语义：一条消息列全部降级 id）
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.from).toBe("engine");
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain(messageId);
  });

  it("【回归】正常消费（xc_read acknowledge）不降级——A4 校准不放宽真消费", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      reason: "message",
      watchWindowMs: 0,
      // 超时拉到 attemptWake 返回之后，保证「先消费后判据」的时序（生产形态）
      limboTimeoutMs: 1_500,
      limboGraceMs: 5_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 4_000,
      wakeSlowMs: 3_600_000,
      spawn: fakeSpawnSilent(),
    }));
    await acknowledgeMailbox(root, "default", "b", [messageId]);
    await new Promise((r) => setTimeout(r, 700));
    expect(readEngineEvents().some((e) => e["event"] === "message-limbo")).toBe(false);
    expect((await readMailbox(root, "default", "b"))[0]!.deliveredAt).toBeDefined();
    expect((await readMailbox(root, "default", "a")).length).toBe(0); // 无告警
  });
});
