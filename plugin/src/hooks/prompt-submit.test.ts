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
import { describe, expect, it, vi } from "vitest";

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

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return { ...actual, ...sharedMocks };
});

vi.mock("../core/peermsg.js", () => peerMocks);
vi.mock("../core/peerenvelope.js", () => envelopeMocks);
vi.mock("../core/uservoice.js", () => uservoiceMocks);

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
