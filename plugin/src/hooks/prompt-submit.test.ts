/**
 * W6 单测：UserPromptSubmit 钩子的 stdout 契约（DESIGN-V0.3.md §11.3 硬约束 1、
 * §9.5 回归清单第 5 条；所有权表把本文件划给 W6）。
 *
 * **回归断言**：钩子 stdout 必须**恰好一行** JSON、**恰好一个** `additionalContext` 键
 * ——队内未读提示与跨会话 peer 信封块必须**先拼成一段文本再 emit 一次**
 * （宿主对多行 JSON 的处理未实测，不赌）。
 *
 * 依赖隔离：钩子的入参解析与队内读面全部 mock（`./shared.js` 用 importActual 保留
 * 真实的 `emitAdditionalContext`——stdout 契约要测的就是它），跨会话排空面
 * （`../core/peermsg.js`）与信封渲染面（`../core/peerenvelope.js`）也 mock 成假实现。
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
    count: 1,
    senders: ["bob"],
    messages: [],
  })),
  peerRootFromEnv: vi.fn(() => "/peers"),
  readHookPermissionMode: vi.fn(() => "prompting" as const),
  refreshPeerBaseRecord: vi.fn(async () => {}),
  // v0.9.1（G-12v3 机制 B）：hook 注入的 consumedAt 回写——真实实现要碰团队锁与邮箱
  // 盘（本文件的 stateRoot 是占位串），这里 mock 成计数桩；真实写入行为由
  // engine/wake-v091-limbo.test.ts 的「hook 注入回写 → 不降级」锚点覆盖。
  markInjectedConsumed: vi.fn(async (): Promise<number> => 0),
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
  // v0.5（§6.3-10）：面 A 走「渲染 → 队列项装配 InjectBlock → 预算排布」链路，
  // mock 补齐装配函数（与真实实现同形的透传），既有断言不变。
  queueItemToInjectBlock: vi.fn((item: unknown, rendered: string) => {
    const it = item as { msgId: string; from: string; ts: number };
    return { msgId: it.msgId, from: it.from, ts: it.ts, rendered, summaryLine: `[已省略 ${it.from} 的消息 ${it.msgId}]` };
  }),
}));

// v0.5（R-12）：盖章链第一步 uservoiceWrite——mock 掉真实 FS 写入（记录 IO 的行为
// 断言在 core/uservoice.test.ts），本文件只保证钩子在无 prompt 键时审计不写记录。
const uservoiceMocks = vi.hoisted(() => ({
  uservoiceWrite: vi.fn(async () => {}),
}));

// v0.8.0（A1，DESIGN-V0.8.md §3.5）：检查点提醒——判据/取数/文案属主 core/checkpoint.ts，
// 钩子只做「取数 → 判据 → 拼一行」。本文件 mock 掉该模块，专测钩子侧接线：
// 该提醒时一行注入 + 写节流标记 + 审计；四种负例一律不注入/不标记/不审计。
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
  writeNudgeMarker: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return { ...actual, ...sharedMocks };
});

vi.mock("../core/peermsg.js", () => peerMocks);
vi.mock("../core/peerenvelope.js", () => envelopeMocks);
vi.mock("../core/uservoice.js", () => uservoiceMocks);
vi.mock("../core/checkpoint.js", () => checkpointMocks);

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
    // 等钩子的异步 main() 跑完（emit 之后还有一点尾巴）。
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

describe("UserPromptSubmit 钩子：stdout 契约（§11.3 硬约束 1）", () => {
  it("stdout 恰好一行 JSON，且恰好一个 additionalContext 键", async () => {
    const captured = await runHook();

    expect(captured.length).toBe(1);
    const text = captured[0]!;
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(1);

    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["additionalContext"]);
    expect(typeof parsed["additionalContext"]).toBe("string");
  });

  it("队内未读提示出现在 additionalContext 里", async () => {
    const captured = await runHook();
    const parsed = JSON.parse(captured[0]!) as { additionalContext: string };
    expect(parsed.additionalContext).toContain("未读协作消息");
  });

  it("peer 信封块与队内提示合并成**一次** emit（§11.3）", async () => {
    const captured = await runHook();

    expect(peerMocks.drainPeerQueue).toHaveBeenCalled();
    expect(captured.length).toBe(1);
    const parsed = JSON.parse(captured[0]!) as { additionalContext: string };
    expect(parsed.additionalContext).toContain("<crosschat-peer-message");
    expect(parsed.additionalContext).toContain("未读协作消息");
  });
});

// ---------------------------------------------------------------------------
// v0.5（DESIGN-V0.5.md §6.3-10）：盖章记录（R-12）与面 A 预算排布（R-23）新行为用例。
// ---------------------------------------------------------------------------

describe("UserPromptSubmit 钩子：v0.5 盖章记录与预算排布", () => {
  it("载荷无提示文本键 → 审计 hook-uservoice-no-prompt 且不写 uservoice 记录（V-4 回落安全方向）", async () => {
    sharedMocks.readStdinPayload.mockReturnValueOnce(undefined);
    await runHook();
    expect(uservoiceMocks.uservoiceWrite).not.toHaveBeenCalled();
    const events = sharedMocks.logHookEvent.mock.calls.map((call) => call[1] as { event?: string });
    expect(events.some((e) => e?.event === "hook-uservoice-no-prompt")).toBe(true);
  });

  it("载荷带 prompt 键 → uservoiceWrite 以（root, sessionId, 原文, now）被调用", async () => {
    sharedMocks.readStdinPayload.mockReturnValueOnce({
      raw: { prompt: "把我的话带给 bob" },
      str: (keySnake: string) => (keySnake === "prompt" ? "把我的话带给 bob" : undefined),
    });
    await runHook();
    expect(uservoiceMocks.uservoiceWrite).toHaveBeenCalledWith(
      "/peers",
      "sess-a",
      "把我的话带给 bob",
      expect.any(Number),
    );
  });

  it("面 A 走预算排布：inject-budget 审计 face='A' 且 envelope 输出保留", async () => {
    const captured = await runHook();
    const events = sharedMocks.logHookEvent.mock.calls.map((call) => call[1] as Record<string, unknown>);
    const budgetEvent = events.find((e) => e["event"] === "inject-budget");
    expect(budgetEvent).toMatchObject({ face: "A" });
    expect(typeof budgetEvent?.["budget"]).toBe("number");
    expect(typeof budgetEvent?.["truncatedCount"]).toBe("number");
    const parsed = JSON.parse(captured[0]!) as { additionalContext: string };
    expect(parsed.additionalContext).toContain("<crosschat-peer-message");
  });
});

// ---------------------------------------------------------------------------
// v0.8.0（A1，DESIGN-V0.8.md §3.5）：检查点提醒（无 PreCompact 的降级替代）。
// 判据五态矩阵在 core/checkpoint.test.ts 逐条覆盖；这里只测钩子接线：
// emit → 一行注入 + 节流标记 + 审计；四种负例 → 一律不注入/不标记/不审计。
// ---------------------------------------------------------------------------

describe("UserPromptSubmit 钩子：v0.8.0 检查点提醒", () => {
  /** 每个用例前清空 checkpoint mock 与审计记录的调用历史（mock.calls 跨用例累积）。 */
  beforeEach(() => {
    sharedMocks.logHookEvent.mockClear();
    sharedMocks.auditHookFailure.mockClear();
    checkpointMocks.checkpointNudgeState.mockReset();
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 0, lastCheckpointAt: null, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReset();
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "no-active-task" });
    checkpointMocks.renderCheckpointNudgeLine.mockClear();
    checkpointMocks.writeNudgeMarker.mockReset();
    checkpointMocks.writeNudgeMarker.mockResolvedValue(undefined);
  });

  function nudgeEvents(): Array<Record<string, unknown>> {
    return sharedMocks.logHookEvent.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((e) => e["event"] === "hook-checkpoint-nudge");
  }

  it("该提醒：提醒行并入 additionalContext，仍是一次 emit / 一行 / 一键", async () => {
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 1, lastCheckpointAt: 1000, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: true, reason: "emit", ageMin: 32 });

    const captured = await runHook();
    expect(captured.length).toBe(1);
    const text = captured[0]!;
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["additionalContext"]);
    expect(parsed["additionalContext"]).toContain("/xc-checkpoint");
    expect(parsed["additionalContext"]).toContain("距上次检查点 32min");
  });

  it("该提醒：先写节流标记再注入，并记 hook-checkpoint-nudge 审计（含 agentKey/ageMin/reason）", async () => {
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 2, lastCheckpointAt: 1000, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: true, reason: "emit", ageMin: 32 });

    await runHook();
    expect(checkpointMocks.writeNudgeMarker).toHaveBeenCalledWith("<stateRoot>", "alice", expect.any(Number));
    expect(nudgeEvents()).toHaveLength(1);
    expect(nudgeEvents()[0]).toMatchObject({ sessionId: "sess-a", agentKey: "alice", reason: "emit", ageMin: 32 });
  });

  it("从未写过检查点：ageMin 缺省 → 文案走「尚未落过检查点」分支", async () => {
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 1, lastCheckpointAt: null, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: true, reason: "emit" });

    const captured = await runHook();
    const parsed = JSON.parse(captured[0]!) as { additionalContext: string };
    expect(parsed.additionalContext).toContain("尚未落过检查点");
  });

  it("负例 no-active-task：无活跃任务不提醒（不注入/不写标记/不审计）", async () => {
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 0, lastCheckpointAt: null, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "no-active-task" });

    const captured = await runHook();
    const parsed = JSON.parse(captured[0]!) as { additionalContext: string };
    expect(parsed.additionalContext).not.toContain("/xc-checkpoint");
    expect(checkpointMocks.writeNudgeMarker).not.toHaveBeenCalled();
    expect(nudgeEvents()).toHaveLength(0);
  });

  it("负例 within-threshold：刚写过不重复提醒", async () => {
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 1, lastCheckpointAt: 1000, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "within-threshold" });

    const captured = await runHook();
    const parsed = JSON.parse(captured[0]!) as { additionalContext: string };
    expect(parsed.additionalContext).not.toContain("/xc-checkpoint");
    expect(checkpointMocks.writeNudgeMarker).not.toHaveBeenCalled();
    expect(nudgeEvents()).toHaveLength(0);
  });

  it("负例 rate-limited：30min 内提醒过 → 最多一次", async () => {
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 1, lastCheckpointAt: 1000, lastNudgeAt: 2000 });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "rate-limited" });

    const captured = await runHook();
    const parsed = JSON.parse(captured[0]!) as { additionalContext: string };
    expect(parsed.additionalContext).not.toContain("/xc-checkpoint");
    expect(nudgeEvents()).toHaveLength(0);
  });

  it("负例 disabled：XC_CHECKPOINT_NUDGE=0 可关", async () => {
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 1, lastCheckpointAt: null, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "disabled" });

    const captured = await runHook();
    const parsed = JSON.parse(captured[0]!) as { additionalContext: string };
    expect(parsed.additionalContext).not.toContain("/xc-checkpoint");
    expect(nudgeEvents()).toHaveLength(0);
  });

  it("节流标记写失败仍注入（提醒比记账重要），只审计 checkpoint-nudge-marker-failed", async () => {
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 1, lastCheckpointAt: 1000, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: true, reason: "emit", ageMin: 32 });
    checkpointMocks.writeNudgeMarker.mockRejectedValueOnce(new Error("EBUSY"));

    const captured = await runHook();
    const parsed = JSON.parse(captured[0]!) as { additionalContext: string };
    expect(parsed.additionalContext).toContain("/xc-checkpoint");
    expect(sharedMocks.auditHookFailure).toHaveBeenCalledWith(
      "<stateRoot>",
      "checkpoint-nudge-marker-failed",
      expect.anything(),
    );
  });

  it("取数/判据异常只审计不阻断（钩子永不失败会话，stdout 契约不变）", async () => {
    checkpointMocks.checkpointNudgeState.mockRejectedValueOnce(new Error("boom"));

    const captured = await runHook();
    expect(captured.length).toBe(1);
    expect(Object.keys(JSON.parse(captured[0]!) as Record<string, unknown>)).toEqual(["additionalContext"]);
    expect(sharedMocks.auditHookFailure).toHaveBeenCalledWith(
      "<stateRoot>",
      "prompt-submit-checkpoint-nudge",
      expect.anything(),
    );
  });

  it("未注册会话（无花名）不提醒：取数助手压根不被调用", async () => {
    sharedMocks.boundNamesForSession.mockResolvedValueOnce([]);
    await runHook();
    expect(checkpointMocks.checkpointNudgeState).not.toHaveBeenCalled();
    expect(checkpointMocks.writeNudgeMarker).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// v0.8.1（29 红队 C1-B03 修复）：零注入块时 stdout 也必须是协议形状——恰一行 JSON、
// 恰一个 additionalContext 键（空串 = 无注入语义；strict schema 认可）。旧实现零块时
// stdout 为空字符串（JSON.parse 直接失败），形状随内容有无而变。
// ---------------------------------------------------------------------------
describe("UserPromptSubmit 钩子：零注入块的 stdout 形状（C1-B03）", () => {
  it("无未读、无 peer 信封、无提醒 → 仍输出一行 JSON 单键（additionalContext 为空串）", async () => {
    sharedMocks.unreadSummary.mockResolvedValue({ count: 0, senders: [], messages: [] });
    peerMocks.drainPeerQueue.mockResolvedValue([]);
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 0, lastCheckpointAt: null, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "no-active-task" });

    const captured = await runHook();
    expect(captured).toHaveLength(1); // 恰好一次 write
    const text = captured[0]!;
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(1); // 恰一行
    const parsed = JSON.parse(text) as Record<string, unknown>; // 旧实现：空串 → parse 抛错
    expect(Object.keys(parsed)).toEqual(["additionalContext"]); // 恰一个键
    expect(parsed["additionalContext"]).toBe(""); // 空注入（宿主无副作用语义）
    // 负例审计纪律不变：无提醒就不写标记/不审计
    expect(checkpointMocks.writeNudgeMarker).not.toHaveBeenCalled();
  });

  it("有任一注入块时形状不变（一行 JSON 单键，内容非空）——与零块路径同契约", async () => {
    sharedMocks.unreadSummary.mockResolvedValue({ count: 2, senders: ["bob"], messages: [] });
    peerMocks.drainPeerQueue.mockResolvedValue([]);
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "disabled" });

    const captured = await runHook();
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["additionalContext"]);
    expect(String(parsed["additionalContext"])).toContain("未读协作消息");
  });
});

// ---------------------------------------------------------------------------
// v0.9.1（G-12v3 机制 B）：hook 注入 = 消费确认回写（limbo 降级的放行判据）。
// 真实写入行为（团队锁 + 邮箱盘）由 engine/wake-v091-limbo.test.ts 锚点 2b 覆盖；
// 本文件只测钩子侧接线：有未读注入时必须调用 markInjectedConsumed，零注入不调用。
// ---------------------------------------------------------------------------
describe("UserPromptSubmit 钩子：未读注入的 consumedAt 回写接线", () => {
  it("有未读 → 注入前调用 markInjectedConsumed（会话活着≠limbo）", async () => {
    sharedMocks.markInjectedConsumed.mockClear();
    sharedMocks.unreadSummary.mockResolvedValue({ count: 1, senders: ["bob"], messages: [] });
    peerMocks.drainPeerQueue.mockResolvedValue([]);
    await runHook();
    expect(sharedMocks.markInjectedConsumed).toHaveBeenCalledTimes(1);
    expect(sharedMocks.markInjectedConsumed).toHaveBeenCalledWith("<stateRoot>", "alice");
  });

  it("零未读 → 不回写（无需证明）", async () => {
    sharedMocks.markInjectedConsumed.mockClear();
    sharedMocks.unreadSummary.mockResolvedValue({ count: 0, senders: [], messages: [] });
    peerMocks.drainPeerQueue.mockResolvedValue([]);
    checkpointMocks.checkpointNudgeState.mockResolvedValue({ openTaskCount: 0, lastCheckpointAt: null, lastNudgeAt: null });
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "no-active-task" });
    await runHook();
    expect(sharedMocks.markInjectedConsumed).not.toHaveBeenCalled();
  });
});
