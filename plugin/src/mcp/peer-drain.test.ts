/**
 * W6 单测：tool-round 间隙的 peer 投递（DESIGN-V0.3.md §7.1「面 B」的插入形态、
 * §10.1 所有权表；§9.5 回归清单第 5 条）。
 *
 * **回归断言**（复核意见 F7 钉死的硬约束）：
 * - 无待投递 peer 消息时：任一队内工具的返回 `content.length === 2`，
 *   `content[0]` 仍是人可读摘要行、`content[1]` 仍是机器 JSON，且与 v0.2 逐字节相同；
 * - 有待投递 peer 消息时：`content.length === 3`，`content[0]/content[1]` **不变**，
 *   `content[2]` 是信封块。
 *
 * 依赖隔离：排空后端是注入的假实现（不依赖真实管道与真实队列文件）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPeerSessionContext,
  setPeerSessionContext,
  withPeerDrain,
  type PeerDrainBackend,
} from "./peer-drain.js";
import { okResult, payloadOf, type ToolResult } from "./protocol.js";
import type { ToolCore, ToolDeps } from "./tools.js";

const deps: ToolDeps = { stateRoot: "<stateRoot>", workspace: "<workspace>", env: {} };

/** 造一个 v0.2 形状的队内工具核心（成功信封 = [摘要行, 机器 JSON]）。 */
function fakeCore(summary = "操作完成", payload: Record<string, unknown> = { ok: true }): ToolCore {
  const handler = async (): Promise<ToolResult> => okResult(summary, payload);
  return {
    xc_register: handler as never,
    xc_dispatch: handler as never,
    xc_check_inbox: handler as never,
    xc_claim: handler as never,
    xc_report: handler as never,
    xc_message: handler as never,
    xc_status: handler as never,
  };
}

function fakeBackend(items: unknown[]): PeerDrainBackend & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    drain: async (root, sessionId, limit) => {
      calls.push([root, sessionId, limit]);
      return items;
    },
    render: (item) => `<crosschat-peer-message from="bob">\n${String(item)}\n</crosschat-peer-message>`,
  };
}

beforeEach(() => {
  clearPeerSessionContext();
});

describe("面 B · 无待投递消息时结果逐字节不变", () => {
  it("content.length === 2，content[0]/content[1] 与 v0.2 相同", async () => {
    setPeerSessionContext({ sessionId: "sess-a", root: "/peers" });
    const backend = fakeBackend([]);
    const core = withPeerDrain(fakeCore("操作完成", { ok: true }), { ...deps, peerDrain: backend });

    const result = await core.xc_status({}, "conn-1");

    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.text).toBe("操作完成");
    expect(JSON.parse(result.content[1]!.text)).toEqual({ ok: true });
    expect(payloadOf(result)).toEqual({ ok: true });
    expect(backend.calls).toHaveLength(1);
  });

  it("未注册（无会话上下文）→ 根本不排空，结果不变", async () => {
    const backend = fakeBackend([{ msgId: "m-1" }]);
    const core = withPeerDrain(fakeCore(), { ...deps, peerDrain: backend });

    const result = await core.xc_message({ to: "b", content: "hi" }, "conn-1");

    expect(result.content).toHaveLength(2);
    expect(backend.calls).toHaveLength(0);
  });

  it("排空抛错 → 静默降级，队内工具结果不受影响", async () => {
    setPeerSessionContext({ sessionId: "sess-a", root: "/peers" });
    const backend: PeerDrainBackend = {
      drain: async () => {
        throw new Error("disk full");
      },
      render: () => "",
    };
    const core = withPeerDrain(fakeCore(), { ...deps, peerDrain: backend });

    const result = await core.xc_claim({ taskId: "t1" }, "conn-1");
    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.text).toBe("操作完成");
  });
});

describe("面 B · 有待投递消息时只追加为末尾 text 块", () => {
  it("content.length === 3，content[0]/content[1] 不变，content[2] 是信封块", async () => {
    setPeerSessionContext({ sessionId: "sess-a", root: "/peers" });
    const backend = fakeBackend([{ msgId: "m-1" }, { msgId: "m-2" }]);
    const core = withPeerDrain(fakeCore("操作完成", { ok: true }), { ...deps, peerDrain: backend });

    const result = await core.xc_dispatch({ to: "b", title: "T", prompt: "P" }, "conn-1");

    expect(result.content).toHaveLength(3);
    // 前两块逐字节不变（payloadOf 仍取 content[1]）。
    expect(result.content[0]!.text).toBe("操作完成");
    expect(JSON.parse(result.content[1]!.text)).toEqual({ ok: true });
    expect(payloadOf(result)).toEqual({ ok: true });
    // 第三块 = 信封块（两条以空行分隔）。
    expect(result.content[2]!.type).toBe("text");
    expect(result.content[2]!.text).toContain("<crosschat-peer-message from=\"bob\">");
    expect(result.content[2]!.text.split("\n\n")).toHaveLength(2);
  });

  it("队内工具的原有 content 数组不被就地改写（不可变）", async () => {
    setPeerSessionContext({ sessionId: "sess-a", root: "/peers" });
    const original = okResult("操作完成", { ok: true });
    const before = original.content.map((block) => block.text);
    const core = withPeerDrain(
      {
        xc_register: (async () => original) as never,
        xc_dispatch: (async () => original) as never,
        xc_check_inbox: (async () => original) as never,
        xc_claim: (async () => original) as never,
        xc_report: (async () => original) as never,
        xc_message: (async () => original) as never,
        xc_status: (async () => original) as never,
      },
      { ...deps, peerDrain: fakeBackend([{ msgId: "m-1" }]) },
    );

    const result = await core.xc_status({}, "conn-1");

    expect(result.content).toHaveLength(3);
    expect(original.content).toHaveLength(2);
    expect(original.content.map((block) => block.text)).toEqual(before);
  });
});

describe("面 B · 七个队内工具都被包裹", () => {
  it("每个工具调用后都触发一次排空", async () => {
    setPeerSessionContext({ sessionId: "sess-a", root: "/peers" });
    const backend = fakeBackend([]);
    const core = withPeerDrain(fakeCore(), { ...deps, peerDrain: backend });

    await core.xc_register({ name: "a", sessionId: "s" }, "c");
    await core.xc_dispatch({ to: "b", title: "T", prompt: "P" }, "c");
    await core.xc_check_inbox({}, "c");
    await core.xc_claim({ taskId: "t" }, "c");
    await core.xc_report({ taskId: "t", attemptId: "a", status: "completed" }, "c");
    await core.xc_message({ to: "b", content: "c" }, "c");
    await core.xc_status({}, "c");

    expect(backend.calls).toHaveLength(7);
    expect(backend.calls[0]![1]).toBe("sess-a");
  });
});
