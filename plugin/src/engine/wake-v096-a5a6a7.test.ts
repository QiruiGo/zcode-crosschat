/**
 * v0.9.6（A5/A6/A7 = V095-14/15/16）定向测试（44-v096 方案 §一 组 A 表）。
 *
 * V095-14（adv3-F1）：wake 回执三态披露——启动确认 / 未见启动证据 / 失败（回执时刻
 * wake 日志已见失败证据）；payload 结构化键 startConfirmed/wakeTiers/wakeFailureSeen。
 * 旧缺陷：两次唤醒全失败后回执仍「已发起唤醒」零失败披露、两态措辞只进 note 散文。
 *
 * V095-15（adv3-F2）：重试轮双窗口锚——stampedAt/spawnedAt 保留**首轮 spawn 时刻**，
 * 重试轮自己的重盖章时刻单列 retryStampedAt；waitedFromDeliveredMs ≥ 邮箱真源
 * （consumedAt−deliveredAt）。旧缺陷：锚 retryNow（邮箱里不存在的章），2.7× 失真。
 *
 * V095-16（adv3-F3）：settled 只认 consumedAt/readAt——结构性丢弃（discardedAt）单列
 * `wake-discarded` 桶；漏斗 consumed 与收方审计 consumed 不再当面矛盾。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMailbox, createMessage, discardMailboxMessages, markMailboxConsumed, readMailbox } from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { withTeamLock } from "../core/lock";
import { writeSession } from "../core/registry";
import type { TeamMember } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import { attemptWake, WAKE_TIER_EVENT_CONSUMED, type WakeRequest } from "./wake.js";
import { renderDeliveryOutcome, renderMessage } from "../mcp/render.js";
import { renderDeliveryOutcome as renderDeliveryOutcomeTeam } from "../mcp/tools-team.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v096-a5-"));
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

const greenCapacity = {
  sampledAt: Date.now(),
  totalBytes: 16 * 1024 ** 3,
  freeBytes: 8 * 1024 ** 3,
  watermark: 0.5,
  steadyTreeBytes: 1 * 1024 ** 3,
  headlessTurnCount: 0,
  headlessTurnMaxRssBytes: null,
  degraded: null,
};

async function seedTeam(): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
  const member: TeamMember = {
    key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1,
    identity: "engine",
  };
  team.members.push(member);
  await writeTeam(root, team);
}

async function seedSessionRecord(sessionId: string): Promise<void> {
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen: 1, boundName: "b" });
}

async function seedMailbox(): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "计算 17*23", { deliveryClaimedAt: Date.now() });
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
    reason: "dispatch",
    receiptIds: [],
    ticket: "计算 17*23",
    env: { XC_WAKE_ENABLED: "false" },
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    capacitySample: greenCapacity,
    limboTimeoutMs: 3_600_000,
    wakeSlowMs: 3_600_000,
    fakeSuccessMs: 3_600_000,
    lifecycleWindowMs: 100,
    ...overrides,
  };
}

function waitUntil(check: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (check()) resolve(true);
      else if (Date.now() > deadline) resolve(false);
      else setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe("v0.9.6 V095-14：wake 回执三态披露 + payload 结构化键", () => {
  it("【三态·失败】回执时刻 wake 日志已见失败证据 → wakeFailureSeen=true + failureEvidence + note 失败措辞", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0, // 关闭异步失败侦听：只测回执时刻的失败第三态（快失败已落盘）
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(4242); // 启动证据在场（确认态）——但日志同时已见失败
        mkdirSync(dirname(opts.logFile), { recursive: true });
        appendFileSync(opts.logFile, "Error: Session not found: sess_b\n");
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    expect(res.startConfirmed).toBe(true);
    expect(res.wakeFailureSeen).toBe(true);
    expect(res.failureEvidence).toContain("Session not found");
    expect(res.note).toContain("失败侦听");
    expect(res.note).toContain("大概率失败");
    expect(res.wakeTiers).toEqual({ spawnOk: "ok", childAlive: "ok", consumed: "pending" });
  });

  it("【三态·启动确认】正常 spawn（日志无失败证据）→ 不误报失败（wakeFailureSeen 缺省）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(4242);
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    expect(res.startConfirmed).toBe(true);
    expect(res.wakeFailureSeen).toBeUndefined();
    expect(res.failureEvidence).toBeUndefined();
    expect(res.note).toContain("启动确认：已见到 wake-child 启动证据");
    expect(res.note).not.toContain("大概率失败");
  });

  it("【三态·未见证据】日志不存在（子进程未写）→ 不表态（不虚构失败）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      startConfirmMs: 1,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => ({ pid: 4242, logFile: opts.logFile }),
    }));
    expect(res.delivered).toBe("wake");
    expect(res.wakeFailureSeen).toBeUndefined();
    expect(res.note).not.toContain("大概率失败");
  });

  it("文本面三态（render.ts 与 tools-team.ts 措辞逐字一致；V095-14 TC3 两态进文本行）", () => {
    // 启动确认 / 未见证据 两态——text 行不再只有「已发起唤醒」一句
    expect(renderDeliveryOutcome("wake", true)).toBe("已发起唤醒（wake，非送达确认）");
    expect(renderDeliveryOutcome("wake", false)).toBe("已发起唤醒但未见启动证据（wake，非送达确认）");
    expect(renderDeliveryOutcome("wake")).toBe("已发起唤醒（wake，非送达确认）"); // 旧调用方零行为变化
    expect(renderDeliveryOutcome("mailbox")).toBe("仅落邮箱（未唤醒，pull 兜底）");
    // 两处组装链逐字对拍（文案漂移锁定）
    expect(renderDeliveryOutcome("wake", false)).toBe(renderDeliveryOutcomeTeam("wake", false));
    expect(renderDeliveryOutcome("mailbox")).toBe(renderDeliveryOutcomeTeam("mailbox"));
    // renderMessage：wake 分支渲染 note + startConfirmed（adv3-F1 TC3：两态进 text 行）
    const line = renderMessage("1a2b3c4d5e6f", "a", "b", "wake", "启动确认：已发起但未见启动证据", false);
    expect(line).toContain("已发起唤醒但未见启动证据");
    expect(line).toContain("已发起但未见启动证据"); // note 透传进文本行
    // 缺省参数输出与 v0.9.5 逐字节一致（旧调用方零行为变化；shortId 前 8 位）
    expect(renderMessage("1a2b3c4d5e6f", "a", "b", "wake")).toBe(
      "Message 1a2b3c4d a → b 已发起唤醒（wake，非送达确认）.",
    );
  });
});

describe("v0.9.6 V095-15：重试轮双窗口锚首轮 spawn（retryStampedAt 单列）", () => {
  it("【验收锚点】sessionNotFound → 重试成功 → 消费 → wake-consumed 带 retried/retryStampedAt 且 waitedFromDeliveredMs ≥ 邮箱真源", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    let calls = 0;
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 3000,
      watchPollMs: 20,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 30_000,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        calls += 1;
        if (calls === 1) {
          // 首轮快失败：300ms 后落失败证据（与重试之间留出可分辨的时间差）
          setTimeout(() => {
            mkdirSync(dirname(opts.logFile), { recursive: true });
            appendFileSync(opts.logFile, "Error: Session not found: sess_b\n");
          }, 300);
        } else {
          opts.onHelperSpawned?.(4242);
        }
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    const sawRetry = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-retry"));
    expect(sawRetry).toBe(true);

    // 邮箱真源：deliveredAt（首轮章）→ consumedAt（真实消费时刻）——首轮 spawn 的锚面
    await withTeamLock(root, "default", async () => {
      await markMailboxConsumed(root, "default", "b", [messageId], Date.now());
    });
    const rows = await readMailbox(root, "default", "b");
    const row = rows.find((m) => m.id === messageId)!;
    expect(row.deliveredAt).toBeDefined();
    expect(row.consumedAt).toBeDefined();

    const sawConsumed = await waitUntil(() =>
      readEngineEvents().filter((e) => e["event"] === WAKE_TIER_EVENT_CONSUMED).length >= 1);
    expect(sawConsumed).toBe(true);
    const consumed = readEngineEvents().find((e) => e["event"] === WAKE_TIER_EVENT_CONSUMED)!;
    // v0.9.6（V095-15）：重试轮单列字段 + 标记（旧实现两字段皆缺）
    expect(consumed["retried"]).toBe(true);
    expect(typeof consumed["retryStampedAt"]).toBe("number");
    // 双窗口锚首轮 spawn 的正面证据：waitedFromDeliveredMs 严格大于
    // 「retryStampedAt − 首轮 wake 事件」——旧锚（retryNow）下该断言必然为假
    //（consumedNow ≈ retryNow+Δ，spawn1 < wakeTs ⇒ 旧值 ≈ Δ < retryNow − spawn1 量级）。
    const waitedFromDeliveredMs = Number(consumed["waitedFromDeliveredMs"]);
    const wakeTs = Number(readEngineEvents().find((e) => e["event"] === "wake")!["ts"]);
    expect(waitedFromDeliveredMs).toBeGreaterThan(Number(consumed["retryStampedAt"]) - wakeTs);
    // 锚语义可解释：waitedFromDeliveredMs ≥ 重试自身的存活时长（从重试 spawn 到消费）
    const retryTs = Number(readEngineEvents().find((e) => e["event"] === "wake-retry")!["ts"]);
    expect(waitedFromDeliveredMs).toBeGreaterThan(0);
    expect(retryTs).toBeGreaterThan(wakeTs);
  });

  it("wake-retry 审计事件带 retrySpawnedAt/retryStampedAt（重试自身的发起/重盖章时刻可对账）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    let calls = 0;
    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 3000,
      watchPollMs: 20,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 30_000,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        calls += 1;
        if (calls === 1) {
          setTimeout(() => {
            mkdirSync(dirname(opts.logFile), { recursive: true });
            appendFileSync(opts.logFile, "Error: Session not found: sess_b\n");
          }, 60);
        } else {
          opts.onHelperSpawned?.(4242);
        }
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    const sawRetry = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-retry"));
    expect(sawRetry).toBe(true);
    const retry = readEngineEvents().find((e) => e["event"] === "wake-retry")!;
    expect(typeof retry["retrySpawnedAt"]).toBe("number");
    expect(typeof retry["retryStampedAt"]).toBe("number");
    // 重试的 spawn 发生在重试流程开始（retryNow = 重盖章锚值）之后
    expect(Number(retry["retrySpawnedAt"])).toBeGreaterThanOrEqual(Number(retry["retryStampedAt"]));
  });
});

describe("v0.9.6 V095-16：settled 只认 consumedAt/readAt；discardedAt 单列 discarded 桶", () => {
  it("【验收锚点】结构性丢弃（discardedAt）→ wake-discarded 事件单列，漏斗 consumed 不计数", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 30_000,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(4242);
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    // 结构性丢弃：frame-rejected 的盘上形态（读取面就地丢弃 → discardedAt 落定）
    await withTeamLock(root, "default", async () => {
      await discardMailboxMessages(root, "default", "b", [messageId], Date.now());
    });
    const sawDiscarded = await waitUntil(() =>
      readEngineEvents().some((e) => e["event"] === "wake-discarded"));
    expect(sawDiscarded).toBe(true);
    const discarded = readEngineEvents().find((e) => e["event"] === "wake-discarded")!;
    expect(discarded["discardedIds"]).toEqual([messageId]);
    expect(discarded["receiptIds"]).toEqual([messageId]);
    // consumed 漏斗不计数（收方审计 consumed=0 与漏斗 consumed=1 的矛盾不再复现）
    expect(readEngineEvents().filter((e) => e["event"] === WAKE_TIER_EVENT_CONSUMED)).toHaveLength(0);
  });

  it("【硬回归】真实消费（consumedAt 回写）→ wake-consumed 照旧（正常语义不降级）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 30_000,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(4242);
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    await withTeamLock(root, "default", async () => {
      await markMailboxConsumed(root, "default", "b", [messageId], Date.now());
    });
    const sawConsumed = await waitUntil(() =>
      readEngineEvents().filter((e) => e["event"] === WAKE_TIER_EVENT_CONSUMED).length >= 1);
    expect(sawConsumed).toBe(true);
    expect(readEngineEvents().filter((e) => e["event"] === "wake-discarded")).toHaveLength(0);
  });

  it("混合批次（部分消费 + 部分丢弃）→ wake-discarded 带两桶明细，不进 consumed", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
    const consumedMsg = createMessage("a", "b", "正常件", { deliveryClaimedAt: Date.now() });
    const discardedMsg = createMessage("a", "b", "白名单外帧", { deliveryClaimedAt: Date.now() });
    await appendMailbox(root, "default", "b", consumedMsg);
    await appendMailbox(root, "default", "b", discardedMsg);
    const res = await attemptWake(baseReq({
      receiptIds: [consumedMsg.id, discardedMsg.id],
      watchWindowMs: 0,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 30_000,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(4242);
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    await withTeamLock(root, "default", async () => {
      await markMailboxConsumed(root, "default", "b", [consumedMsg.id], Date.now());
      await discardMailboxMessages(root, "default", "b", [discardedMsg.id], Date.now());
    });
    const sawDiscarded = await waitUntil(() =>
      readEngineEvents().some((e) => e["event"] === "wake-discarded"));
    expect(sawDiscarded).toBe(true);
    const discarded = readEngineEvents().find((e) => e["event"] === "wake-discarded")!;
    expect(discarded["consumedIds"]).toEqual([consumedMsg.id]);
    expect(discarded["discardedIds"]).toEqual([discardedMsg.id]);
    expect(readEngineEvents().filter((e) => e["event"] === WAKE_TIER_EVENT_CONSUMED)).toHaveLength(0);
  });
});
