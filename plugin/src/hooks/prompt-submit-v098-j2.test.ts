/**
 * v0.9.8（组 M·J2）定向单测：UserPromptSubmit 的**回合首行插队/纠偏横幅**。
 *
 * 锚点（方案 §二 J2 验收原文）：
 * - 「有 interrupt/steer 时第一行是『⛔ 插队/纠偏待处理（N 条）』，再列普通未读」；
 * - 「文本面第一行可见；无插队时不出现」。
 *
 * 依赖隔离：与 prompt-submit-v092-incident.test.ts 同模式——`./shared.js` 用
 * importActual 保留真实 `emitAdditionalContext`（stdout 契约要测的就是它）；
 * `unreadSummary` 用假实现直接喂「有/无纠错未读」两个输入（判据谓词用真实现）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMessage } from "../core/types.js";

const sharedMocks = vi.hoisted(() => ({
  readStdinPayload: vi.fn((): import("./shared.js").HookStdin | undefined => undefined),
  resolveHookContext: vi.fn(() => ({
    workspace: "ws",
    stateRoot: "<stateRoot>",
    sessionId: "sess-a",
    event: "UserPromptSubmit",
  })),
  logHookEvent: vi.fn(async (_stateRoot: string, _event: unknown) => {}),
  auditHookFailure: vi.fn(async () => {}),
  boundNamesForSession: vi.fn(async () => ["alice"]),
  unreadSummary: vi.fn(async () => ({
    count: 0,
    senders: [] as string[],
    messages: [] as unknown[],
    urgentCount: 0,
  })),
  markInjectedConsumed: vi.fn(async () => 0),
  refreshSessionRegistration: vi.fn(async () => undefined),
  sweepStaleProvisioning: vi.fn(async () => [] as string[]),
  peerRootFromEnv: vi.fn(() => "/peers"),
  readHookPermissionMode: vi.fn(() => "prompting" as const),
  refreshPeerBaseRecord: vi.fn(async () => {}),
}));

const peerMocks = vi.hoisted(() => ({ drainPeerQueue: vi.fn(async (): Promise<unknown[]> => []) }));

const envelopeMocks = vi.hoisted(() => ({
  renderPeerEnvelope: vi.fn(
    (item: unknown) =>
      `<crosschat-peer-message from="bob" from-session="sess-bob" hop-chain="bob">\n${String(
        (item as { text?: string }).text ?? "",
      )}\n</crosschat-peer-message>`,
  ),
  queueItemToInjectBlock: vi.fn((item: unknown) => {
    const it = item as { msgId: string; from: string; ts: number; text?: string };
    return {
      msgId: it.msgId, from: it.from, ts: it.ts,
      rendered: `<crosschat-peer-message>${it.text ?? ""}</crosschat-peer-message>`,
      summaryLine: `[已省略 ${it.from} 的消息 ${it.msgId}]`,
    };
  }),
}));

const uservoiceMocks = vi.hoisted(() => ({ uservoiceWrite: vi.fn(async () => {}) }));

const checkpointMocks = vi.hoisted(() => ({
  checkpointNudgeState: vi.fn(async () => ({ openTaskCount: 0, lastCheckpointAt: null, lastNudgeAt: null })),
  checkpointNudgeDecision: vi.fn((): { nudge: boolean; reason: string } => ({ nudge: false, reason: "no-active-task" })),
  renderCheckpointNudgeLine: vi.fn(() => ""),
  // v0.9.8（组 O C1）：上下文体积提醒三件套（缺省「低于阈值」= 不注入，本文件用例零影响）
  readContextSize: vi.fn(async (): Promise<{ bytes: number; messages: number }> => ({ bytes: 0, messages: 0 })),
  contextNudgeDecision: vi.fn(
    (): { nudge: boolean; reason: string; bytes: number; messages: number } =>
      ({ nudge: false, reason: "below-threshold", bytes: 0, messages: 0 }),
  ),
  renderContextNudgeLine: vi.fn(() => ""),
  writeNudgeMarker: vi.fn(async (): Promise<void> => {}),
}));

const teamstateMocks = vi.hoisted(() => ({
  readTeam: vi.fn(async (): Promise<unknown> => undefined),
  unrelayedCompletedTasks: vi.fn((): Array<{ id: string; title: string }> => []),
}));

const incidentMocks = vi.hoisted(() => ({
  readIncidentsSince: vi.fn(async (): Promise<{
    since: number; memberDead: number; limboDowngraded: number; wakeFailed: number; deadMembers: string[]; total: number;
  }> => ({ since: 1_000, memberDead: 0, limboDowngraded: 0, wakeFailed: 0, deadMembers: [], total: 0 })),
  renderIncidentSummary: vi.fn((counts: { memberDead: number }) => `[zcode-crosschat] ⚠ 协作事故摘要：${counts.memberDead} 个成员死亡。`),
}));

const registryMocks = vi.hoisted(() => ({
  readSession: vi.fn(async (): Promise<{ lastTurnTs?: number } | undefined> => ({ lastTurnTs: 1_000 })),
}));

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return { ...actual, ...sharedMocks };
});
vi.mock("../core/peermsg.js", () => peerMocks);
vi.mock("../core/peerenvelope.js", () => envelopeMocks);
vi.mock("../core/uservoice.js", () => uservoiceMocks);
vi.mock("../core/checkpoint.js", () => checkpointMocks);
vi.mock("../core/teamstate.js", () => teamstateMocks);
vi.mock("../core/incidents.js", () => incidentMocks);
vi.mock("../core/registry.js", () => registryMocks);

let writes: string[] = [];
let spy: ReturnType<typeof vi.spyOn> | undefined;

/** 每个用例都重新导入钩子模块（钩子模块在 import 时自启 main()）。 */
async function runHook(): Promise<string[]> {
  vi.resetModules();
  writes = [];
  spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await import("./prompt-submit.js");
    for (let i = 0; i < 40 && writes.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return writes;
  } finally {
    spy?.mockRestore();
    spy = undefined;
  }
}

async function injectedContext(): Promise<string> {
  const captured = await runHook();
  expect(captured).toHaveLength(1);
  const parsed = JSON.parse(captured[0]!) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["additionalContext"]);
  return String(parsed["additionalContext"]);
}

function hookEvents(): Array<Record<string, unknown>> {
  return sharedMocks.logHookEvent.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

function msg(id: string, from: string, extra: Partial<TeamMessage> & { steer?: boolean } = {}): TeamMessage {
  return { id, from, to: "alice", content: `消息 ${id}`, ts: 1_000, ...extra };
}

/** 设一版未读 summary（messages 会被真谓词 isInterruptOrSteer 过滤）。 */
function withUnread(messages: TeamMessage[]): void {
  const senders: string[] = [];
  for (const m of [...messages].sort((a, b) => b.ts - a.ts)) {
    if (!senders.includes(m.from)) senders.push(m.from);
  }
  sharedMocks.unreadSummary.mockResolvedValue({
    count: messages.length,
    senders,
    messages,
    urgentCount: messages.filter((m) => m.urgent === true).length,
  });
}

describe("v0.9.8 J2：回合首行插队/纠偏横幅", () => {
  beforeEach(() => {
    sharedMocks.logHookEvent.mockClear();
    sharedMocks.auditHookFailure.mockClear();
    sharedMocks.unreadSummary.mockReset();
    sharedMocks.unreadSummary.mockResolvedValue({ count: 0, senders: [], messages: [], urgentCount: 0 });
    peerMocks.drainPeerQueue.mockReset();
    peerMocks.drainPeerQueue.mockResolvedValue([]);
    checkpointMocks.checkpointNudgeDecision.mockReset();
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "no-active-task" });
    teamstateMocks.readTeam.mockReset();
    teamstateMocks.readTeam.mockResolvedValue(undefined);
    teamstateMocks.unrelayedCompletedTasks.mockReset();
    teamstateMocks.unrelayedCompletedTasks.mockReturnValue([]);
    incidentMocks.readIncidentsSince.mockReset();
    incidentMocks.readIncidentsSince.mockResolvedValue({
      since: 1_000, memberDead: 0, limboDowngraded: 0, wakeFailed: 0, deadMembers: [], total: 0,
    });
    registryMocks.readSession.mockReset();
    registryMocks.readSession.mockResolvedValue({ lastTurnTs: 1_000 });
  });

  it("【方案验收锚点】有 interrupt：第一行就是「⛔ 插队/纠偏待处理（N 条）」", async () => {
    withUnread([
      msg("n-1", "bob"),
      msg("n-2", "bob"),
      msg("s-1", "lead", { interrupt: true }),
      msg("s-2", "carol", { interrupt: true }),
    ]);

    const context = await injectedContext();
    const firstLine = context.split("\n")[0]!;
    expect(firstLine).toContain("⛔ 插队/纠偏待处理（2 条）");
    expect(context.startsWith("⛔ 插队/纠偏待处理（2 条）")).toBe(true);
    // 再列普通未读：横幅里给出其余普通未读条数与发送方
    expect(context).toContain("其余 2 条普通未读");
    expect(context).toContain("来自 lead、carol");
    // 置顶预留预算与「不降级成摘要」的口径写进文案
    expect(context).toContain("绝不降级成摘要");
    // 平台边界如实声明（不声称能拦工具调用）
    expect(context).toContain("不能否决或拦截任何工具调用");
    // 审计行带同源计数
    const audit = hookEvents().find((e) => e["event"] === "hook-prompt-submit-interrupt");
    expect(audit).toBeDefined();
    expect(audit!["interrupt"]).toBe(2);
    expect(audit!["unread"]).toBe(4);
    expect(audit!["senders"]).toEqual(["lead", "carol"]);
  });

  it("steer 元数据同样触发横幅（与 interrupt 同一个谓词）", async () => {
    // v0.9.9 复核（V098-09）：写入侧已落 steer 键（组 W 的 V098-02 修法），谓词两键同一判定。
    withUnread([msg("s-1", "lead", { steer: true })]);
    const context = await injectedContext();
    expect(context.startsWith("⛔ 插队/纠偏待处理（1 条）")).toBe(true);
  });

  it("置顶：横幅先于事故摘要（A3）与未读强提醒（G-14）", async () => {
    incidentMocks.readIncidentsSince.mockResolvedValue({
      since: 1_000, memberDead: 1, limboDowngraded: 0, wakeFailed: 0, deadMembers: ["b"], total: 1,
    });
    withUnread([msg("n-1", "bob"), msg("s-1", "lead", { interrupt: true })]);
    peerMocks.drainPeerQueue.mockResolvedValue([
      { msgId: "p-1", from: "bob", fromSessionId: "sess-bob", hopChain: ["bob"], text: "peer hi", ts: 1, via: "pipe" as const },
    ]);

    const context = await injectedContext();
    const bannerAt = context.indexOf("⛔ 插队/纠偏待处理");
    const incidentAt = context.indexOf("协作事故摘要");
    const reminderAt = context.indexOf("回合开始前置检查未通过");
    const envelopeAt = context.indexOf("<crosschat-peer-message");
    expect(bannerAt).toBe(0);
    expect(incidentAt).toBeGreaterThan(bannerAt);
    expect(reminderAt).toBeGreaterThan(incidentAt);
    expect(envelopeAt).toBeGreaterThan(reminderAt);
  });

  it("无插队 → 不出现横幅（零注入回归：纯普通未读时首行不是横幅）", async () => {
    withUnread([msg("n-1", "bob"), msg("n-2", "bob", { urgent: true })]);
    const context = await injectedContext();
    expect(context).not.toContain("⛔ 插队/纠偏待处理");
    expect(context).toContain("回合开始前置检查未通过");
    expect(hookEvents().some((e) => e["event"] === "hook-prompt-submit-interrupt")).toBe(false);
  });

  it("一条未读都没有 → 零注入（stdout 仍是恰一行单键 JSON）", async () => {
    withUnread([]);
    const context = await injectedContext();
    expect(context).toBe("");
  });

  it("钩子永不失败：unreadSummary 抛错 → 只审计不阻断，无横幅", async () => {
    sharedMocks.unreadSummary.mockRejectedValue(new Error("邮箱被占用"));
    const context = await injectedContext();
    expect(context).toBe("");
    expect(sharedMocks.auditHookFailure).toHaveBeenCalledWith(
      "<stateRoot>",
      "prompt-submit-inbox",
      expect.any(Error),
    );
  });
});
