/**
 * v0.9.1（G-14）回合开始强提醒定向单测（方案 §二 组B 验收锚点）。
 *
 * 背景（G-14）：高压期 inbox 4 条关键回报躺着没人消费——prompt/memory
 * 规则不在决策强制位。修法 = UserPromptSubmit 时未读>0 或任务板有 completed 未接力
 * 项 → 注入**置顶**阻塞式提醒块。
 *
 * 三条硬口径逐条断言（任务书验收锚点）：
 * 1. 置顶：提醒块在 additionalContext 最前（先于 peer 信封块）；
 * 2. 阻塞式措辞：未读条数 + urgent 数 + 发送方 + xc_read 指令 + 「本回合已经开始」
 *    的事实 + 未接力任务 id；
 * 3. 平台边界如实声明：明写「不能否决或拦截任何工具调用」——**不声称**能拦下本回合
 *    首条工具调用（边界清单第一条：宿主不允许插件否决工具调用）。
 *
 * 另覆盖：无未读/无未接力 → 零注入（不回归 v0.8.1 的零块 stdout 契约）；team.json
 * 读失败只审计不阻断；「重复注入直到消费」由数据保证（未读不清就每回合都注入，
 * 清零即停）。
 *
 * 依赖隔离：与 prompt-submit.test.ts 同模式——`./shared.js` 用 importActual 保留真实
 * `emitAdditionalContext`（stdout 契约要测的就是它）；v0.9.1 新增的
 * `../core/teamstate.js`（readTeam + unrelayedCompletedTasks）mock 成假实现。
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
  peerRootFromEnv: vi.fn(() => "/peers"),
  readHookPermissionMode: vi.fn(() => "prompting" as const),
  refreshPeerBaseRecord: vi.fn(async () => {}),
}));

const peerMocks = vi.hoisted(() => ({
  drainPeerQueue: vi.fn(async () => [
    {
      msgId: "m-1",
      from: "bob",
      fromSessionId: "sess-bob",
      hopChain: ["bob"],
      text: "peer hi",
      ts: 1,
      via: "pipe" as const,
    },
  ]),
}));

const envelopeMocks = vi.hoisted(() => ({
  renderPeerEnvelope: vi.fn(
    (item: unknown) =>
      `<crosschat-peer-message from="bob" from-session="sess-bob" hop-chain="bob">\n${String(
        (item as { text?: string }).text ?? "",
      )}\n</crosschat-peer-message>`,
  ),
  queueItemToInjectBlock: vi.fn((item: unknown, rendered: string) => {
    const it = item as { msgId: string; from: string; ts: number };
    return { msgId: it.msgId, from: it.from, ts: it.ts, rendered, summaryLine: `[已省略 ${it.from} 的消息 ${it.msgId}]` };
  }),
}));

const uservoiceMocks = vi.hoisted(() => ({ uservoiceWrite: vi.fn(async () => {}) }));

const checkpointMocks = vi.hoisted(() => ({
  checkpointNudgeState: vi.fn(
    async (): Promise<{ openTaskCount: number; lastCheckpointAt: number | null; lastNudgeAt: number | null }> =>
      ({ openTaskCount: 0, lastCheckpointAt: null, lastNudgeAt: null }),
  ),
  checkpointNudgeDecision: vi.fn(
    (): { nudge: boolean; reason: string; ageMin?: number } => ({ nudge: false, reason: "no-active-task" }),
  ),
  renderCheckpointNudgeLine: vi.fn((ageMin?: number) =>
    ageMin === undefined
      ? "[zcode-crosschat] 建议先 /xc-checkpoint（尚未落过检查点）"
      : `[zcode-crosschat] 建议先 /xc-checkpoint（距上次检查点 ${ageMin}min）`),
  // v0.9.8（组 O C1）：上下文体积提醒三件套（缺省「低于阈值」= 不注入，本文件用例零影响）
  readContextSize: vi.fn(async (): Promise<{ bytes: number; messages: number }> => ({ bytes: 0, messages: 0 })),
  contextNudgeDecision: vi.fn(
    (): { nudge: boolean; reason: string; bytes: number; messages: number } =>
      ({ nudge: false, reason: "below-threshold", bytes: 0, messages: 0 }),
  ),
  renderContextNudgeLine: vi.fn(() => ""),
  writeNudgeMarker: vi.fn(async (): Promise<void> => {}),
}));

/** v0.9.1（G-14）：任务板读取与「已完成未接力」判据的假实现（本文件只测钩子接线）。 */
const teamstateMocks = vi.hoisted(() => ({
  readTeam: vi.fn(async (): Promise<unknown> => undefined),
  unrelayedCompletedTasks: vi.fn((): Array<{ id: string; title: string }> => []),
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

/** 取出 additionalContext（stdout 契约断言共用）。 */
async function injectedContext(): Promise<string> {
  const captured = await runHook();
  expect(captured).toHaveLength(1);
  const parsed = JSON.parse(captured[0]!) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["additionalContext"]);
  return String(parsed["additionalContext"]);
}

/** 设一版「有未读」的 summary（count/senders/messages 同源，urgent 单列）。 */
function withUnread(count: number, senders: string[], urgentCount = 0): void {
  sharedMocks.unreadSummary.mockResolvedValue({
    count,
    senders,
    messages: [],
    urgentCount,
  });
}

function hookEvents(): Array<Record<string, unknown>> {
  return sharedMocks.logHookEvent.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

describe("v0.9.1 G-14：回合开始强提醒（未读 / completed 未接力）", () => {
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
  });

  it("未读>0：注入含未读条数 + xc_read 指令 + 「本回合已经开始」+ 平台边界声明", async () => {
    withUnread(3, ["bob", "carol"], 1);

    const context = await injectedContext();
    expect(context).toContain("回合开始前置检查未通过");
    expect(context).toContain("3 条未读协作消息"); // v0.2 起的关键短语保留（回归）
    expect(context).toContain("含 1 条 urgent");
    expect(context).toContain("来自 bob、carol");
    expect(context).toContain('xc_read({scope:"inbox"})');
    expect(context).toContain("本回合已经开始");
    // 平台边界：只能注入、不能否决工具调用——不声称能拦截首条工具调用。
    expect(context).toContain("不能否决或拦截任何工具调用");
    expect(context).not.toContain("拦截本回合首条工具调用");
    expect(context).not.toContain("否决本回合");
    // 重复注入直到消费：明写收口条件。
    expect(context).toContain("重复注入");
  });

  it("置顶：提醒块排在 peer 信封块之前（unshift 语义）", async () => {
    withUnread(1, ["bob"]);
    peerMocks.drainPeerQueue.mockResolvedValue([
      {
        msgId: "m-1",
        from: "bob",
        fromSessionId: "sess-bob",
        hopChain: ["bob"],
        text: "peer hi",
        ts: 1,
        via: "pipe" as const,
      },
    ]);

    const context = await injectedContext();
    const reminderAt = context.indexOf("回合开始前置检查未通过");
    const envelopeAt = context.indexOf("<crosschat-peer-message");
    expect(reminderAt).toBeGreaterThanOrEqual(0);
    expect(envelopeAt).toBeGreaterThan(reminderAt);
  });

  it("completed 未接力：提醒块点名任务 id 与标题，并落 unrelayedCompleted 审计字段", async () => {
    withUnread(1, ["bob"]);
    teamstateMocks.readTeam.mockResolvedValue({ teamId: "default", tasks: [] });
    teamstateMocks.unrelayedCompletedTasks.mockReturnValue([
      { id: "era-t3", title: "修复 BD865" },
      { id: "era-t4", title: "补测回归" },
    ]);

    const context = await injectedContext();
    expect(context).toContain("2 个已完成任务尚未被你接力");
    expect(context).toContain("era-t3「修复 BD865」");
    expect(context).toContain("era-t4「补测回归」");

    const unreadEvent = hookEvents().find((event) => event["event"] === "hook-prompt-submit-unread");
    expect(unreadEvent).toMatchObject({ name: "alice", unread: 1, unrelayedCompleted: ["era-t3", "era-t4"] });
  });

  it("零注入不回归：无未读、无未接力 → additionalContext 为空串（stdout 契约不变）", async () => {
    const context = await injectedContext();
    expect(context).toBe("");
    expect(hookEvents().some((event) => event["event"] === "hook-prompt-submit-unread")).toBe(false);
    expect(teamstateMocks.unrelayedCompletedTasks).not.toHaveBeenCalled();
  });

  it("重复注入直到消费：未读不清 → 每回合都注入；清零即停", async () => {
    withUnread(2, ["bob"]);
    const first = await injectedContext();
    expect(first).toContain("回合开始前置检查未通过");

    const second = await injectedContext();
    expect(second).toContain("回合开始前置检查未通过"); // 消费前不消失

    sharedMocks.unreadSummary.mockResolvedValue({ count: 0, senders: [], messages: [], urgentCount: 0 });
    const third = await injectedContext();
    expect(third).toBe(""); // 已消费 → 自然停止，无需任何节流状态
  });

  it("team.json 读失败只审计不阻断：未读提醒照常注入（钩子永不失败会话）", async () => {
    withUnread(1, ["bob"]);
    teamstateMocks.readTeam.mockRejectedValue(new Error("EBUSY"));

    const context = await injectedContext();
    expect(context).toContain("1 条未读协作消息");
    expect(sharedMocks.auditHookFailure).toHaveBeenCalledWith(
      "<stateRoot>",
      "prompt-submit-turn-start-handoff",
      expect.anything(),
    );
  });

  it("未注册会话（无花名）不提醒：unreadSummary 压根不被调用", async () => {
    sharedMocks.boundNamesForSession.mockResolvedValueOnce([]);
    const context = await injectedContext();
    expect(context).toBe("");
    expect(sharedMocks.unreadSummary).not.toHaveBeenCalled();
  });
});
