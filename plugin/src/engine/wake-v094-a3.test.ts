/**
 * v0.9.4（A3）：唤醒降级**回执文案如实**定向测试（39-v094 方案 §二 A 表）。
 *
 * 判据（方案原文）：「回执/通知区分『已送达并消费』『仅落邮箱未唤醒』；wake-skipped
 * 时禁止写『已送达』」；任务书/验收：「构造 wake 关闭 → 通知文案含『仅邮箱』、
 * 不含『已送达』」。
 *
 * 实现口径：
 * - engine/wake.ts `mailboxOnlyNote(reason)`：一切「没有真正发起唤醒」的降级路径
 *   （分层闸 wake-disabled / 在途 nonce / 成员状态门 / spawn 配置无效 / 容量闸
 *   deferral / spawn 同步失败）的回执 note 都带「仅落邮箱（未唤醒）：消息未送达也
 *   未消费」——禁出现「已送达/已消费」字样；
 * - wake 成功路径（delivered:"wake"）的回执保持「已发起（非送达确认）」口径——
 *   「送达」只在唤醒成功后才可写，且成功回执本身仍不谎称送达；
 * - mcp/tools-team.ts `renderDeliveryOutcome`：idle/cancel/lead-transfer 三类通知
 *   的投递结果措辞按同一口径分流（mailbox → 仅落邮箱（未唤醒）；wake → 已发起唤醒）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMailbox, createMessage } from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { writeSession } from "../core/registry";
import type { TeamMember } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import { attemptWake, mailboxOnlyNote, type WakeRequest } from "./wake.js";
import type { CapacitySample } from "../core/capacity.js";
import {
  renderCancel,
  renderDeliveryOutcome,
  renderIdle,
  renderLeadTransfer,
} from "../mcp/tools-team.js";

/** A3 判据的文案断言助手（一）：任何降级文案都不得出现送达/消费宣称。 */
function expectNoDeliveryClaim(text: string): void {
  expect(text).not.toContain("已送达");
  expect(text).not.toContain("已消费");
  expect(text).not.toContain("delivered");
}

/** A3 判据的文案断言助手（二）：邮箱降级文案必含「仅落邮箱（未唤醒」族短语。 */
function expectMailboxOnly(text: string): void {
  expect(text).toContain("仅落邮箱（未唤醒");
  expectNoDeliveryClaim(text);
}

/** mailboxOnlyNote 的完整口径：仅落邮箱 + 明示未送达也未消费 + pull 兜底路径。 */
function expectMailboxOnlyHonest(text: string): void {
  expectMailboxOnly(text);
  expect(text).toContain("消息未送达也未消费");
  expect(text).toContain('xc_read({scope:"inbox"})');
}

// ─────────────────────── 端到端：构造 wake 关闭 → 回执 note 如实 ───────────────────────

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a3-v094-"));
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

async function seedInteractiveTeam(): Promise<void> {
  // 交互式成员（无 identity:"engine"）→ 分层闸吃 file/env/默认层；本用例不给任何
  // 开启源（env 无 XC_WAKE_ENABLED、无 config.json）→ wake-disabled 降级。
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

async function seedSessionRecord(sessionId: string): Promise<void> {
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen: 1 });
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

function disabledReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "message",
    receiptIds: ["m1"],
    ticket: "重踢：BD869",
    env: {}, // 无 XC_WAKE_ENABLED → 交互式会话按内置默认 false → wake-disabled
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    capacitySample: greenSample(),
    ...overrides,
  };
}

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("v0.9.4 A3：端到端（构造 wake 关闭 → 回执/通知文案如实）", () => {
  it("【锚点】交互式成员 + wake 关闭 → delivered=mailbox，note 含「仅落邮箱（未唤醒）」、无已送达/已消费", async () => {
    await seedInteractiveTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    let spawnCalls = 0;
    const res = await attemptWake(disabledReq({
      receiptIds: [messageId],
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        spawnCalls += 1;
        return { pid: 1, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("mailbox");
    expect(spawnCalls).toBe(0); // 没发起唤醒（降级路径不 spawn）
    expectMailboxOnlyHonest(String(res.note));
    // 引擎事件面：wake-skipped 原因行照旧（可诊断），不带任何送达宣称
    const skip = readEngineEvents().filter((e) => e["event"] === "wake-skipped").at(-1);
    expect(skip).toBeDefined();
    expect(String(skip!["reason"])).toContain("wake-disabled");
  });

  it("wake 成功路径（对照）：note 写「已发起」且明示非送达确认，不写「仅落邮箱」", async () => {
    await seedInteractiveTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(disabledReq({
      receiptIds: [messageId],
      env: { XC_WAKE_ENABLED: "true" }, // 开启
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 100,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => ({ pid: 4242, logFile: opts.logFile }),
    }));
    expect(res.delivered).toBe("wake");
    expect(String(res.note)).toContain("已发起");
    expect(String(res.note)).toContain("非送达确认");
    expect(String(res.note)).not.toContain("仅落邮箱");
    expect(String(res.note)).not.toContain("已送达");
    expect(String(res.note)).not.toContain("已消费");
  });

  it("spawn 同步失败（对照）：降级 note 同样诚实（仅落邮箱，无已送达）", async () => {
    await seedInteractiveTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const failing = (): SpawnResumeResult => {
      throw new Error("ENOENT: no such ZCode.exe");
    };
    const res = await attemptWake(disabledReq({
      receiptIds: [messageId],
      env: { XC_WAKE_ENABLED: "true" },
      spawn: failing,
    }));
    expect(res.delivered).toBe("mailbox");
    expect(String(res.note)).toContain("spawn-failed");
    expectMailboxOnlyHonest(String(res.note));
  });
});

describe("v0.9.4 A3：wake-skipped 场景回执/通知文案如实（禁已送达/已消费，改「仅落邮箱」）", () => {
  it("mailboxOnlyNote：降级后缀必含「仅落邮箱（未唤醒）+ 未送达也未消费」，原样保留原因行", () => {
    const note = mailboxOnlyNote('wake-disabled: 交互式会话自动唤醒未开启（来源 env-default；引擎供给成员不受此开关约束）');
    // 原因行原样在前（运维可诊断）
    expect(note.startsWith("wake-disabled:")).toBe(true);
    expectMailboxOnlyHonest(note);
    // pull 兜底路径写在文案里（收方下回合或 xc_read）
    expect(note).toContain('xc_read({scope:"inbox"})');
  });

  it("renderDeliveryOutcome：mailbox 与 wake 两态措辞分流（wake 才可写「已发起唤醒」）", () => {
    expectMailboxOnly(renderDeliveryOutcome("mailbox"));
    const wake = renderDeliveryOutcome("wake");
    expect(wake).toContain("已发起唤醒");
    expect(wake).toContain("非送达确认"); // 唤醒成功也仍不谎称「已送达」
    expect(wake).not.toContain("仅落邮箱");
    expectNoDeliveryClaim(wake);
  });

  it("三类通知渲染（idle/cancel/lead-transfer）：mailbox 态无「delivered」字样", () => {
    const texts = [
      renderIdle("a", "b", "mailbox"),
      renderCancel("t1", "a", "b", "mailbox"),
      renderLeadTransfer("a", "b", "mailbox"),
    ];
    for (const text of texts) {
      expectMailboxOnly(text);
    }
    // wake 态：可写「已发起唤醒」
    expect(renderIdle("a", "b", "wake")).toContain("已发起唤醒");
    expect(renderCancel("t1", "a", "b", "wake")).toContain("已发起唤醒");
    expect(renderLeadTransfer("a", "b", "wake")).toContain("已发起唤醒");
  });
});
