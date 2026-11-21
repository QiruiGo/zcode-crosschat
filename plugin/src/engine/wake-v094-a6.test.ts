/**
 * v0.9.4（A6②）：wake prompt 「正文已内嵌，不要 xc_read，直接 xc_claim(taskId)」
 * 定向测试（39-v094 方案 §二 A 表）。
 *
 * 判据（任务书原文）：「wake prompt 改为『正文已内嵌，不要 xc_read，直接
 * xc_claim(taskId)』」。实现口径（engine/wake.ts buildWakePrompt + attemptWake）：
 * - 身份行改「钩子已自动绑定」口径（wakeToken 退居兜底，一次性/目标 sid 校验不变）；
 * - 行动行三态分流：带 taskId → 「任务票 taskId=…：直接 xc_claim」；消息正文场景
 *   （message/withdrawal）→ 「正文已内嵌，不要 xc_read」；其余（摘要/通知场景）→
 *   保留 xc_read 指引（那些场景的正文不是消息实体，不撒谎）；
 * - taskId 来源：attemptWake 从本批回执消息的 extras.taskId 解析（**单一** taskId
 *   才给；混单不猜），因此任务票正文保持「不含 taskId」的幂等判据不变；
 * - 守则：唤醒回合用 MEMBER_RULES_V2_WAKE（规则 1 改写），欢迎回合仍用
 *   MEMBER_RULES_V2（跑在 app-server 里、无钩子、须显式 identify）。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMailbox, createMessage } from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { writeSession } from "../core/registry";
import type { TeamMember } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import {
  attemptWake,
  buildWakePrompt,
  MEMBER_RULES_V2,
  MEMBER_RULES_V2_WAKE,
  WAKE_PROMPT_MAX_CHARS,
  type WakeRequest,
} from "./wake";
import type { CapacitySample } from "../core/capacity.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a6-v094-"));
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

function basePromptInput(overrides: Partial<Parameters<typeof buildWakePrompt>[0]> = {}) {
  return {
    teamId: "default",
    recipientKey: "b",
    recipientSessionId: "sess_b",
    wakeToken: "tok-123",
    receiptIds: ["m1"],
    bodyText: "计算 17*23",
    includeMemberRules: true,
    ...overrides,
  };
}

describe("v0.9.4 A6②：wake prompt 行动行（一次到位）", () => {
  it("【锚点】带 taskId → 「正文已内嵌，不要 xc_read，直接 xc_claim(taskId)」", () => {
    const p = buildWakePrompt(basePromptInput({ taskId: "86e8b61a-t1", scene: "dispatch" }));
    expect(p).toContain("任务票 taskId=86e8b61a-t1");
    expect(p).toContain("正文已内嵌——不要 xc_read");
    expect(p).toContain('直接 xc_claim("86e8b61a-t1")');
    expect(p).not.toContain('调用 xc_read({scope:"inbox"})'); // 不再要求先读箱
    // 身份行：自动绑定口径 + wakeToken 兜底
    expect(p).toContain("身份已由引擎在会话启动时自动绑定");
    expect(p).toContain("不要再调 xc_identify");
    expect(p).toContain('wakeToken 填 "tok-123"');
    expect(p.length).toBeLessThanOrEqual(WAKE_PROMPT_MAX_CHARS);
  });

  it("消息正文场景（message）无 taskId → 「正文已内嵌，不要 xc_read」（正文即消息本体）", () => {
    const p = buildWakePrompt(basePromptInput({ scene: "message", includeMemberRules: false }));
    expect(p).toContain("正文已内嵌——不要 xc_read");
    expect(p).not.toContain("任务票 taskId");
    expect(p).not.toContain('调用 xc_read({scope:"inbox"})');
  });

  it("摘要/通知场景（idle）无 taskId → 保留 xc_read 指引（不把摘要谎称正文）", () => {
    const p = buildWakePrompt(basePromptInput({ scene: "idle", includeMemberRules: false }));
    expect(p).toContain('调用 xc_read({scope:"inbox"}) 读取回执对应的消息');
    expect(p).not.toContain("任务票 taskId");
  });

  it("守则两变体：欢迎版规则 1 不变（显式 identify）；唤醒版规则 1 改写，第 2-8 条逐字一致", () => {
    // 欢迎版（provision.ts 复用）：原规则 1 逐字保留
    expect(MEMBER_RULES_V2).toContain("1) 身份：先 xc_identify（本 prompt 已给出 name/sessionId/wakeToken），再 xc_read({scope:\"inbox\"}) 读消息。");
    // 唤醒版：规则 1 改写为自动绑定口径
    expect(MEMBER_RULES_V2_WAKE).toContain("本会话启动时引擎钩子已自动绑定");
    expect(MEMBER_RULES_V2_WAKE).toContain("不要再调 xc_identify");
    expect(MEMBER_RULES_V2_WAKE).toContain("有任务票直接 xc_claim(taskId)");
    // 尾部（第 2-8 条）逐字一致——两变体只差规则 1
    const tailOf = (text: string): string => text.split("\n").slice(2).join("\n");
    expect(tailOf(MEMBER_RULES_V2_WAKE)).toBe(tailOf(MEMBER_RULES_V2));
  });
});

// ─────────────────────── 端到端：attemptWake 从邮箱解析 taskId 进 prompt ───────────────────────

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
    reason: "dispatch",
    receiptIds: [],
    ticket: JSON.stringify({ type: "task-assignment", teamId: "default", title: "算 17*23", prompt: "算出结果", acceptance: "" }),
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    capacitySample: greenSample(),
    ...overrides,
  };
}

describe("v0.9.4 A6②：attemptWake 端到端（taskId 从回执消息解析进 prompt）", () => {
  it("【锚点】派单唤醒（单任务票）→ 唤醒 prompt 带 taskId 直达 claim 指令", async () => {
    await seedTeam();
    await writeSession(root, { sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: 1 });
    mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
    const message = createMessage("a", "b", "task-assignment", { taskId: "86e8b61a-t1" });
    await appendMailbox(root, "default", "b", message);

    let capturedPrompt = "";
    await attemptWake(baseReq({
      receiptIds: [message.id],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 100,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        capturedPrompt = opts.prompt;
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(capturedPrompt).toContain("任务票 taskId=86e8b61a-t1");
    expect(capturedPrompt).toContain('直接 xc_claim("86e8b61a-t1")');
    expect(capturedPrompt).toContain("不要 xc_read");
  });

  it("混单（多个不同 taskId）→ 不猜哪一个：无 taskId 指令，回落按正文/邮箱处理", async () => {
    await seedTeam();
    await writeSession(root, { sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: 1 });
    mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
    const m1 = createMessage("a", "b", "task-assignment", { taskId: "t-1" });
    const m2 = createMessage("a", "b", "task-assignment", { taskId: "t-2" });
    await appendMailbox(root, "default", "b", m1);
    await appendMailbox(root, "default", "b", m2);

    let capturedPrompt = "";
    await attemptWake(baseReq({
      receiptIds: [m1.id, m2.id],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 100,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        capturedPrompt = opts.prompt;
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(capturedPrompt).not.toContain("任务票 taskId");
    // 结构段没有「直接 xc_claim("…")」的具名指令（守则里的通用表述不在此列）
    expect(capturedPrompt).not.toContain('直接 xc_claim("');
    // 回落：dispatch 场景仍附守则（自驱循环），由成员按守则取单
    expect(capturedPrompt).toContain("成员守则");
  });

  it("非任务消息（无 taskId）→ 无 taskId 指令（不虚构任务）", async () => {
    await seedTeam();
    await writeSession(root, { sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: 1 });
    mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
    const message = createMessage("a", "b", "自由消息：今天怎么样");
    await appendMailbox(root, "default", "b", message);

    let capturedPrompt = "";
    await attemptWake(baseReq({
      reason: "message",
      receiptIds: [message.id],
      ticket: "自由消息：今天怎么样",
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 100,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        capturedPrompt = opts.prompt;
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(capturedPrompt).not.toContain("任务票 taskId");
    // message 场景：正文即消息本体 → 直接按正文处理
    expect(capturedPrompt).toContain("正文已内嵌——不要 xc_read");
    expect(capturedPrompt).toContain("自由消息：今天怎么样");
  });
});
