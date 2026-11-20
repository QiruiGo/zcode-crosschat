/**
 * v0.9.3 组A（reports/37-v093方案.md §一 组A 验收锚点）定向单测——
 * **A2 wake 三级指标 + 致死原因回读** 与 **A3 假成功检测**。
 *
 * 锚点（任务书原文逐条）：
 * A2：
 * - ① 拆指标：`wake-spawn-ok` / `wake-child-alive` / `wake-consumed` 三个**新汇总事件**
 *   （既有 wake/wake-child 事件不删），回执 `WakeResult.wakeTiers` 与 overview 计数改用三级；
 * - ② 回读 `logs/wake-*.json` 识别 provider 限流类死亡（RateLimitError/quota/额度）→
 *   `wake-degraded{reason:"provider-rate-limit"}` + lead 告知；**正常 wake 不误报**；
 * - ③ 三级计数在 overview 可见（readWakeTierCounts 从 engine.jsonl 尾部窗口聚合）。
 * A3：
 * - delivered/wake 盖章后 `XC_FAKE_SUCCESS_MS`（缺省 5min）目标 sid 无
 *   session-running/prompt-submit 投影 → `delivery-unconfirmed` 事件 + urgent lead，**恰一条**；
 * - 目标随后有事件 → 不告警；
 * - 三个检测器（A1/A2/A3）**互斥不叠加**（A2 已披露限流致死 ⇒ A3 不再发通用告警）。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot；唤醒 spawn 注入假实现（不拉真子进程）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeMailbox,
  appendMailbox,
  createMessage,
  readMailbox,
} from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { markMailboxConsumed } from "../core/mailbox";
import { writeSession } from "../core/registry";
import type { TeamMember } from "../core/types";
import { withTeamLock } from "../core/lock";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import {
  attemptWake,
  FAKE_SUCCESS_DEFAULT_MS,
  fakeSuccessMsFromEnv,
  findProviderRateLimitEvidence,
  readWakeTierCounts,
  WAKE_TIER_EVENT_CHILD_ALIVE,
  WAKE_TIER_EVENT_CONSUMED,
  WAKE_TIER_EVENT_SPAWN_OK,
  type WakeRequest,
} from "./wake";
import type { CapacitySample } from "../core/capacity.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a2a3-v093-"));
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

/** lead「a」+ 成员「b」（founder 也占花名册行——lead 才可寻址，告知才落得到它邮箱）。 */
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

/** 会话记录（lastSeen 传 1 = 远古 = 「自盖章后无任何活动」）。 */
async function seedSessionRecord(sessionId: string, lastSeen = 1): Promise<void> {
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen });
}

/** 在当前临时 root 的 b 邮箱落一条消息（已盖 claimed = 一次投递尝试在途）。 */
async function seedMailbox(): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "重踢：BD869", { deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

/** GREEN 容量样本（测试注入——绕开真采样的 CIM 子进程，时序确定）。 */
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

/** 假 spawn：不汇报唤醒子 pid（= 无启动证据），pid 取本机不存在的大数（提前出口立即触发）。 */
function fakeSpawnSilent(pid = 424242): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => ({ pid, logFile: opts.logFile });
}

/** 假 spawn：helper 同步汇报唤醒子 pid（= 启动证据到场）。 */
function fakeSpawnWithChild(childPid = 5150): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    opts.onHelperSpawned?.(childPid);
    return { pid: 4242, logFile: opts.logFile };
  };
}

/** 假 spawn：把给定文本写进唤醒子日志（失败/致死原因回读的注入面）。 */
function fakeSpawnWritingLog(text: string): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    appendFileSync(opts.logFile, text);
    return { pid: 4242, logFile: opts.logFile };
  };
}

/**
 * 轮询直到条件成立（每 stepMs 一次，deadline 后返回 false=硬失败）。
 * 负载无关地等**事实**成立，不猜固定 sleep（与既有 wake 测试同口径）。
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

// ─────────────────────── A2：三级指标 ───────────────────────

describe("v0.9.3 A2：唤醒三级指标（spawn-ok / child-alive / consumed）", () => {
  it("纯判据：provider 限流关键词命中（RateLimitError/quota/额度/429），正常文本不误报", () => {
    expect(findProviderRateLimitEvidence("Error: RateLimitError: 429 Too Many Requests\n")).toContain("RateLimitError");
    expect(findProviderRateLimitEvidence('{"error":"quota exceeded for this billing period"}\n')).toContain("quota");
    expect(findProviderRateLimitEvidence("上游返回：额度不足，请充值\n")).toContain("额度");
    expect(findProviderRateLimitEvidence("HTTP 429 too many requests\n")).toContain("429");
    // 正常唤醒输出（CLI 单对象 JSON 结果 / 普通告警）不含关键词 → 不误报
    expect(findProviderRateLimitEvidence('{"sessionId":"sess_b","response":"ok"}\n')).toBeUndefined();
    expect(findProviderRateLimitEvidence("resume completed in 1200ms\n")).toBeUndefined();
    expect(findProviderRateLimitEvidence("")).toBeUndefined();
  });

  it("第一/二级：spawn 成功落 wake-spawn-ok；helper 汇报 pid 落 wake-child-alive（既有 wake/wake-child 不删）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: fakeSpawnWithChild(5150),
    }));

    expect(res.delivered).toBe("wake");
    // 回执三级（第三级恒 pending——消费是异步确认）
    expect(res.wakeTiers).toEqual({ spawnOk: "ok", childAlive: "ok", consumed: "pending" });
    expect(String(res.note)).toContain("三级指标");
    // 既有事件不删 + 新汇总事件在场
    expect(eventsOf("wake")).toHaveLength(1);
    expect(eventsOf("wake-child")).toHaveLength(1);
    const spawnOk = eventsOf(WAKE_TIER_EVENT_SPAWN_OK);
    expect(spawnOk).toHaveLength(1);
    expect(spawnOk[0]!["to"]).toBe("b");
    const childAlive = eventsOf(WAKE_TIER_EVENT_CHILD_ALIVE);
    expect(childAlive).toHaveLength(1);
    expect(childAlive[0]!["pid"]).toBe(5150);
  });

  it("第二级缺失：helper 未汇报 pid → child-alive 零条、回执 childAlive=no（spawn-ok 仍记）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: fakeSpawnSilent(),
    }));

    expect(res.wakeTiers).toEqual({ spawnOk: "ok", childAlive: "no", consumed: "pending" });
    expect(eventsOf(WAKE_TIER_EVENT_SPAWN_OK)).toHaveLength(1);
    expect(eventsOf(WAKE_TIER_EVENT_CHILD_ALIVE)).toHaveLength(0);
  });

  it("第三级：消息被消费（consumedAt 回写）→ wake-consumed 恰一条 + 监视器收工", async () => {
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

    // 未消费前：第三级零条
    expect(eventsOf(WAKE_TIER_EVENT_CONSUMED)).toHaveLength(0);
    // 成员回合消费（hook 注入/xc_read 的落盘形态）
    await withTeamLock(root, "default", async () => {
      await markMailboxConsumed(root, "default", "b", [messageId], Date.now());
    });

    expect(await waitUntil(() => eventsOf(WAKE_TIER_EVENT_CONSUMED).length === 1)).toBe(true);
    const consumed = eventsOf(WAKE_TIER_EVENT_CONSUMED)[0]!;
    expect(consumed["to"]).toBe("b");
    expect(consumed["receiptIds"]).toEqual([messageId]);
    // 收工：再消费别的消息也不会再出一条（本批次已结算）
    await new Promise((r) => setTimeout(r, 200));
    expect(eventsOf(WAKE_TIER_EVENT_CONSUMED)).toHaveLength(1);
  });

  it("计数：readWakeTierCounts 从 engine.jsonl 聚合三级（无日志 → 全 0）", async () => {
    expect(await readWakeTierCounts(root)).toEqual({
      spawnOk: 0, childAlive: 0, consumed: 0, windowBytes: 0, windowMs: 24 * 60 * 60_000,
    });

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
      await acknowledgeMailbox(root, "default", "b", [messageId], Date.now());
    });
    expect(await waitUntil(() => eventsOf(WAKE_TIER_EVENT_CONSUMED).length === 1)).toBe(true);

    const counts = await readWakeTierCounts(root);
    expect(counts.spawnOk).toBe(1);
    expect(counts.childAlive).toBe(1);
    expect(counts.consumed).toBe(1);
    expect(counts.windowBytes).toBeGreaterThan(0);
  });
});

// ─────────────────────── A2：致死原因回读 ───────────────────────

describe("v0.9.3 A2：provider 限流致死回读（wake-degraded）", () => {
  it("【锚点】wake 日志含 RateLimitError → wake-degraded{reason:provider-rate-limit} + lead 告知恰一条（wake-failed 不叠加 urgent）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 800,
      watchPollMs: 20,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: fakeSpawnWritingLog("Error: RateLimitError: 429 Too Many Requests (quota exceeded)\n"),
    }));

    //  degraded 事件（根因 + 证据 + where）
    const sawDegraded = await waitUntil(() => eventsOf("wake-degraded").length === 1);
    expect(sawDegraded).toBe(true);
    const degraded = eventsOf("wake-degraded")[0]!;
    expect(degraded["reason"]).toBe("provider-rate-limit");
    expect(degraded["to"]).toBe("b");
    expect(String(degraded["evidence"])).toContain("RateLimitError");
    expect(degraded["where"]).toBe("wake-child");
    // 失败语义不变：wake-failed 事件仍落、租约仍释放（消息回 pending）
    expect(await waitUntil(() => eventsOf("wake-failed").length === 1)).toBe(true);
    const rows = await readMailbox(root, "default", "b");
    expect(rows[0]!.deliveryClaimedAt).toBeUndefined();
    // 告警不叠加：lead 只收到**一条** urgent（wake-degraded 的，wake-failed 的被抑制）
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("wake-degraded");
  });

  it("正常 wake 不误报：日志是成功 JSON → 零 wake-degraded、零额外 urgent", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 500,
      watchPollMs: 20,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: fakeSpawnWritingLog('{"sessionId":"sess_b","response":"ok","usage":{"total_tokens":120}}\n'),
    }));

    await new Promise((r) => setTimeout(r, 300));
    expect(eventsOf("wake-degraded")).toHaveLength(0);
    expect(eventsOf("wake-failed")).toHaveLength(0);
    expect(await readMailbox(root, "default", "a")).toHaveLength(0);
  });

  it("env 口径：XC_FAKE_SUCCESS_MS 缺省 300000；正整数生效；0/负/非数字回落缺省", () => {
    expect(FAKE_SUCCESS_DEFAULT_MS).toBe(300_000);
    expect(fakeSuccessMsFromEnv({})).toBe(300_000);
    expect(fakeSuccessMsFromEnv({ XC_FAKE_SUCCESS_MS: "1234" })).toBe(1234);
    expect(fakeSuccessMsFromEnv({ XC_FAKE_SUCCESS_MS: "0" })).toBe(300_000);
    expect(fakeSuccessMsFromEnv({ XC_FAKE_SUCCESS_MS: "-5" })).toBe(300_000);
    expect(fakeSuccessMsFromEnv({ XC_FAKE_SUCCESS_MS: "abc" })).toBe(300_000);
  });
});

// ─────────────────────── A3：假成功检测 ───────────────────────

describe("v0.9.3 A3：假成功检测（delivery-unconfirmed）", () => {
  it("【锚点】已 delivered + 目标零事件 → 超时恰一条 delivery-unconfirmed + lead urgent 恰一条", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b"); // 远古 lastSeen：无会话活动投影
    const messageId = await seedMailbox();

    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      // 只让假成功档先到期（隔离慢档）→ 只落 delivery-unconfirmed，不落 wake-slow
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 300,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 3_000,
      spawn: fakeSpawnSilent(),
    }));

    expect(await waitUntil(() => eventsOf("delivery-unconfirmed").length === 1)).toBe(true);
    const unconfirmed = eventsOf("delivery-unconfirmed")[0]!;
    expect(unconfirmed["reason"]).toBe("fake-success-suspected");
    expect(unconfirmed["to"]).toBe("b");
    expect(unconfirmed["sid"]).toBe("sess_b");
    expect(unconfirmed["thresholdMs"]).toBe(300);
    expect(eventsOf("wake-slow")).toHaveLength(0); // 慢档未到期：不落（键集冻结的事件不凑数）

    // urgent 恰一条（等「lead 已被告知」这个事实，不等固定时间）
    expect(await waitUntil(async () => (await readMailbox(root, "default", "a")).length === 1)).toBe(true);
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("delivery-unconfirmed");

    // 一次：越过窗口也不重复（窗口 3s > 阈值 300ms，已覆盖多轮 tick）
    await new Promise((r) => setTimeout(r, 500));
    expect(eventsOf("delivery-unconfirmed")).toHaveLength(1);
    expect((await readMailbox(root, "default", "a")).length).toBe(1);
  });

  it("负例：目标随后有事件（session-start 刷新 lastSeen）→ 不告警", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 300,
      fakeSuccessMs: 300,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      spawn: fakeSpawnSilent(),
    }));
    // 唤醒子的 SessionStart/UserPromptSubmit 钩子刷新会话记录（生产等价：回合开跑）
    await writeSession(root, { sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now() });

    await new Promise((r) => setTimeout(r, 800)); // 越过两个阈值
    expect(eventsOf("delivery-unconfirmed")).toHaveLength(0);
    expect(eventsOf("wake-slow")).toHaveLength(0);
    expect(await readMailbox(root, "default", "a")).toHaveLength(0);
  });

  it("同刻双档（默认相等）：wake-slow 与 delivery-unconfirmed 事件双落、urgent 仍恰一条（互斥不叠加）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 300,
      fakeSuccessMs: 300,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      spawn: fakeSpawnSilent(),
    }));

    expect(await waitUntil(() => eventsOf("delivery-unconfirmed").length === 1)).toBe(true);
    expect(eventsOf("wake-slow")).toHaveLength(1);
    // wake-slow 事件键集冻结不变（PROTOCOL §15.3 契约测试同款对拍）
    const slow = eventsOf("wake-slow")[0]!;
    expect(Object.keys(slow).filter((k) => k !== "ts").sort()).toEqual(
      ["event", "nonce", "pid", "scene", "sid", "teamId", "thresholdMs", "to", "waitedMs"],
    );
    expect(await waitUntil(async () => (await readMailbox(root, "default", "a")).length === 1)).toBe(true);
    expect((await readMailbox(root, "default", "a")).length).toBe(1);
    expect((await readMailbox(root, "default", "a"))[0]!.content).toContain("delivery-unconfirmed");
  });

  it("三检测器互斥：provider 限流致死（A2 已披露根因）→ 不再发通用假成功告警（A3）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();

    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 800,
      watchPollMs: 20,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 300,
      fakeSuccessMs: 300,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 3_000,
      spawn: fakeSpawnWritingLog("Error: RateLimitError: quota exceeded\n"),
    }));

    expect(await waitUntil(() => eventsOf("wake-degraded").length === 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 1_200)); // 越过假成功阈值
    // A3 不叠加：限流根因已知，通用「疑似假成功」不再发声
    expect(eventsOf("delivery-unconfirmed")).toHaveLength(0);
    expect(eventsOf("wake-slow")).toHaveLength(0);
    // lead 仍只收到一条告警（wake-degraded 的）
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.content).toContain("wake-degraded");
  });
});
