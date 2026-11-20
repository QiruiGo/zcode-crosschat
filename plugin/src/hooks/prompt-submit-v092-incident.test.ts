/**
 * v0.9.2 组A（A3）定向单测——UserPromptSubmit 的**回合开始事故摘要**接线面。
 *
 * 锚点（任务书原文「事故摘要计数正确且零注入回归」的注入侧）：
 * 1. **置顶**：事故摘要块排在 additionalContext 最前（先于未读强提醒与 peer 信封）；
 * 2. **计数透出**：注入块含 N 个成员死亡 / M 条 limbo 降级 / K 次唤醒失败与死亡成员点名，
 *    审计行 `hook-prompt-submit-incidents` 带同源四个计数（since 为上一回合 lastTurnTs）；
 * 3. **零注入回归**：无事故（total=0）→ 不产块；无上一回合记录（lastTurnTs 缺席）→
 *    根本不读审计账、不产块（存量会话首回合不虚报「无事故」也不回归 v0.8.1 零块契约）；
 * 4. **钩子永不失败**：事故读取抛错 → 只审计不阻断（stdout 仍是恰一行单键 JSON）。
 *
 * 依赖隔离：与 prompt-submit-g14.test.ts 同模式——`./shared.js` 用 importActual 保留真实
 * `emitAdditionalContext`（stdout 契约要测的就是它）； incidents / registry 用假实现控制
 * 「上一回合时刻」与「事故计数」两个输入。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  readHookPermissionMode: vi.fn(() => "proming" as const),
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
    return { msgId: it.msgId, from: it.from, ts: it.ts, rendered: `<crosschat-peer-message>${it.text ?? ""}</crosschat-peer-message>`, summaryLine: `[已省略 ${it.from} 的消息 ${it.msgId}]` };
  }),
}));

const uservoiceMocks = vi.hoisted(() => ({ uservoiceWrite: vi.fn(async () => {}) }));

const checkpointMocks = vi.hoisted(() => ({
  checkpointNudgeState: vi.fn(async () => ({ openTaskCount: 0, lastCheckpointAt: null, lastNudgeAt: null })),
  checkpointNudgeDecision: vi.fn((): { nudge: boolean; reason: string } => ({ nudge: false, reason: "no-active-task" })),
  renderCheckpointNudgeLine: vi.fn(() => ""),
  writeNudgeMarker: vi.fn(async (): Promise<void> => {}),
}));

const teamstateMocks = vi.hoisted(() => ({
  readTeam: vi.fn(async (): Promise<unknown> => undefined),
  unrelayedCompletedTasks: vi.fn((): Array<{ id: string; title: string }> => []),
}));

/** A3 的两个新输入：上一回合时刻（registry 读）与事故计数（incidents 模块）。 */
const incidentMocks = vi.hoisted(() => ({
  readIncidentsSince: vi.fn(async (): Promise<{
    since: number;
    memberDead: number;
    limboDowngraded: number;
    wakeFailed: number;
    deadMembers: string[];
    total: number;
  }> => ({
    since: 1_000,
    memberDead: 0,
    limboDowngraded: 0,
    wakeFailed: 0,
    deadMembers: [],
    total: 0,
  })),
  renderIncidentSummary: vi.fn((counts: { memberDead: number; limboDowngraded: number; wakeFailed: number; deadMembers: string[] }) =>
    `[zcode-crosschat] ⚠ 协作事故摘要：${counts.memberDead} 个成员死亡（${counts.deadMembers.join("、")}）/ `
    + `${counts.limboDowngraded} 条 limbo 降级 / ${counts.wakeFailed} 次唤醒失败。`),
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

/** 设一版「有未读」的 summary（未读强提醒块出现，供置顶次序断言）。 */
function withUnread(count: number, senders: string[]): void {
  sharedMocks.unreadSummary.mockResolvedValue({ count, senders, messages: [], urgentCount: 0 });
}

function setIncidents(overrides: {
  memberDead?: number;
  limboDowngraded?: number;
  wakeFailed?: number;
  deadMembers?: string[];
}): void {
  const memberDead = overrides.memberDead ?? 0;
  const limboDowngraded = overrides.limboDowngraded ?? 0;
  const wakeFailed = overrides.wakeFailed ?? 0;
  incidentMocks.readIncidentsSince.mockResolvedValue({
    since: 1_000,
    memberDead,
    limboDowngraded,
    wakeFailed,
    deadMembers: overrides.deadMembers ?? [],
    total: memberDead + limboDowngraded + wakeFailed,
  });
}

describe("v0.9.2 A3：回合开始事故摘要（看门狗未覆盖时的最后保险）", () => {
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

  it("有事故：三类计数透出 + 点名死亡成员 + 审计行带同源计数（since=上一回合 lastTurnTs）", async () => {
    setIncidents({ memberDead: 1, limboDowngraded: 2, wakeFailed: 3, deadMembers: ["b"] });

    const context = await injectedContext();
    expect(context).toContain("协作事故摘要");
    expect(context).toContain("1 个成员死亡（b）");
    expect(context).toContain("2 条 limbo 降级");
    expect(context).toContain("3 次唤醒失败");
    const incident = hookEvents().find((e) => e["event"] === "hook-prompt-submit-incidents");
    expect(incident).toBeDefined();
    expect(incident!["since"]).toBe(1_000);
    expect(incident!["memberDead"]).toBe(1);
    expect(incident!["limboDowngraded"]).toBe(2);
    expect(incident!["wakeFailed"]).toBe(3);
    expect(incident!["deadMembers"]).toEqual(["b"]);
  });

  it("置顶：事故摘要排在未读强提醒与 peer 信封之前", async () => {
    setIncidents({ memberDead: 1, deadMembers: ["b"] });
    withUnread(2, ["bob"]);
    peerMocks.drainPeerQueue.mockResolvedValue([
      { msgId: "m-1", from: "bob", fromSessionId: "sess-bob", hopChain: ["bob"], text: "peer hi", ts: 1, via: "pipe" as const },
    ]);

    const context = await injectedContext();
    const incidentAt = context.indexOf("协作事故摘要");
    const reminderAt = context.indexOf("回合开始前置检查未通过");
    const envelopeAt = context.indexOf("<crosschat-peer-message");
    expect(incidentAt).toBeGreaterThanOrEqual(0);
    expect(reminderAt).toBeGreaterThan(incidentAt);
    expect(envelopeAt).toBeGreaterThan(reminderAt);
  });

  it("零事故 → 零注入（不回归 v0.8.1 的零块 stdout 契约）", async () => {
    setIncidents({});
    const context = await injectedContext();
    expect(context).toBe("");
    expect(hookEvents().some((e) => e["event"] === "hook-prompt-submit-incidents")).toBe(false);
    // 连审计都不落（无事故即无摘要，与未读提醒同口径）
    expect(incidentMocks.readIncidentsSince).toHaveBeenCalledTimes(1);
  });

  it("无上一回合记录（存量会话首回合）→ 不读审计账、零注入", async () => {
    registryMocks.readSession.mockResolvedValue(undefined);
    setIncidents({ memberDead: 5, deadMembers: ["b"] }); // 即便有事故也不得注入（无窗口）
    const context = await injectedContext();
    expect(context).toBe("");
    expect(incidentMocks.readIncidentsSince).not.toHaveBeenCalled();
  });

  it("事故读取抛错 → 只审计不阻断（stdout 仍是恰一行单键 JSON）", async () => {
    incidentMocks.readIncidentsSince.mockRejectedValue(new Error("engine.jsonl 被占用"));
    withUnread(1, ["bob"]);
    const context = await injectedContext();
    // 未读提醒照常注入（事故面失败不影响其余面）
    expect(context).toContain("回合开始前置检查未通过");
    expect(context).not.toContain("协作事故摘要");
    expect(sharedMocks.auditHookFailure).toHaveBeenCalledWith(
      "<stateRoot>",
      "prompt-submit-incident-summary",
      expect.any(Error),
    );
  });
});
