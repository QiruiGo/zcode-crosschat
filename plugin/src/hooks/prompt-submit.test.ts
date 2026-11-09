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
  readStdinPayload: vi.fn(() => undefined),
  resolveHookContext: vi.fn(() => ({
    workspace: "ws",
    stateRoot: "<stateRoot>",
    sessionId: "sess-a",
    event: "UserPromptSubmit",
  })),
  logHookEvent: vi.fn(async () => {}),
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
}));

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return { ...actual, ...sharedMocks };
});

vi.mock("../core/peermsg.js", () => peerMocks);
vi.mock("../core/peerenvelope.js", () => envelopeMocks);

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
