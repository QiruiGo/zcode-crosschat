/**
 * P3 防回归单测（v0.5.1，预算修复员组）：xc_peer_inbox count 口径。
 *
 * 红队现象（裁决 #6 残留观察 / 附带观察 3）：单次 xc_peer_inbox 响应有 3 个
 * content block——面 C 排空 ≤limit 条（count=10、envelopes=10）之后，call 包装器
 * 又叠加面 B 排空（PEER_DRAIN_LIMIT=5）把更多信封塞进末尾 text 块——响应实际
 * 承载 15 条而结构化 count 只报 10，只读结构化块的消费方误判「丢了 5 条」
 * （红队 conc1 据此误判消息丢失）。
 *
 * 修复（白盒）：xc_peer_inbox 跳过面 B 叠加排空（skipFaceB）——count = envelopes =
 * 本次响应真实呈现数；剩余件留在 queue，payload.remaining + 摘要行给「再拉一次」
 * 指针。其他 peer 工具（xc_peers 等）不自主排空，面 B 投递语义保持不变。
 */
import { describe, expect, it } from "vitest";
import { registerPeerTools, type PeerServices } from "./peer-tools.js";
import type { PeerQueueItem } from "../core/peermsg.js";
import { payloadOf } from "./protocol.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./tools.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<import("./protocol.js").ToolResult>;

interface RegisteredTool {
  name: string;
  description: string;
  handler: Handler;
}

/** 假 MCP server：只收集注册进来的工具（不接 SDK transport）。 */
class FakeServer {
  readonly tools: RegisteredTool[] = [];
  tool(name: string, description: string, _schema: unknown, handler: Handler): void {
    this.tools.push({ name, description, handler });
  }
  find(name: string): RegisteredTool {
    const found = this.tools.find((tool) => tool.name === name);
    if (found === undefined) throw new Error(`tool not registered: ${name}`);
    return found;
  }
}

const deps: ToolDeps = { stateRoot: "<stateRoot>", workspace: "<workspace>", env: {} };

function queueItem(msgId: string, text: string): PeerQueueItem {
  return { msgId, from: "pa", hopChain: ["pa"], text, ts: 1, via: "pipe" as const };
}

/** 假服务：面 C 排空返回 3 条 + 队列还剩 `remaining` 条。 */
function fakeServices(count: number, remaining: number, overrides: Partial<PeerServices> = {}): PeerServices {
  const items = Array.from({ length: count }, (_, i) => queueItem(`m-${i}`, `hello-${i}`));
  const rendered = items.map((item) => `<crosschat-peer-message from="pa">\n${item.text}\n</crosschat-peer-message>`);
  const base: PeerServices = {
    register: async () => {
      throw new Error("unexpected call");
    },
    list: async () => [],
    send: async () => {
      throw new Error("unexpected call");
    },
    read: async () => {
      throw new Error("unexpected call");
    },
    inbox: async () => ({ items, rendered, remaining }),
    review: async () => {
      throw new Error("unexpected call");
    },
    rename: async () => {
      throw new Error("unexpected call");
    },
    agents: async () => {
      throw new Error("unexpected call");
    },
  };
  return Object.assign(base, overrides) as PeerServices;
}

/** 假面 B 后端：只要被调到就返回 5 条（模拟「面 B 又排空 5 条」的旧行为）。 */
const faceBDrainBackend = {
  drain: async () => [queueItem("m-faceb", "from-face-B")],
  render: () => '<crosschat-peer-message from="pa">\nfrom-face-B\n</crosschat-peer-message>',
};

function setup(services: PeerServices): FakeServer {
  const server = new FakeServer();
  registerPeerTools(server as unknown as McpServer, { ...deps, peer: services, peerDrain: faceBDrainBackend });
  return server;
}

const withPeerSession = async (fn: () => Promise<void>): Promise<void> => {
  const { setPeerSessionContext, clearPeerSessionContext } = await import("./peer-drain.js");
  setPeerSessionContext({ sessionId: "sess-bob", name: "bob", root: "<peerRoot>" });
  try {
    await fn();
  } finally {
    clearPeerSessionContext();
  }
};

describe("P3: xc_peer_inbox count 口径（面 B 双排空抑制 + remaining 指针）", () => {
  it("count = envelopes = 本次真实呈现数；面 B 不再叠加 content[2]（content.length===2）", async () => {
    await withPeerSession(async () => {
      const server = setup(fakeServices(3, 7));
      const result = await server.find("xc_peer_inbox").handler({ limit: 10 }, {});
      // 旧行为：content.length === 3（面 B 追加 5 条文本块）；修复后恒为 2。
      expect(result.content).toHaveLength(2);
      const payload = payloadOf(result) as { count: number; envelopes: string[]; remaining: number };
      expect(payload.count).toBe(3);
      expect(Array.isArray(payload.envelopes)).toBe(true);
      expect(payload.envelopes).toHaveLength(3);
      expect(payload.count).toBe(payload.envelopes.length);
      // textOf 里也只承载面 C 的 3 条信封（无 face-B 的 m-faceb）
      expect(result.content.map((b) => b.text).join("\n")).not.toContain("from-face-B");
    });
  });

  it("remaining>0 → 摘要行与 JSON payload 都给「再拉一次」指针", async () => {
    await withPeerSession(async () => {
      const server = setup(fakeServices(3, 7));
      const result = await server.find("xc_peer_inbox").handler({ limit: 10 }, {});
      const payload = payloadOf(result) as { count: number; remaining: number };
      expect(payload.remaining).toBe(7);
      expect(result.content[0]?.text).toContain("另有 7 条待投递");
      expect(result.content[0]?.text).toContain("xc_peer_inbox");
    });
  });

  it("remaining=0 → 摘要行不带指针（与 v0.5.0 输出一致）", async () => {
    await withPeerSession(async () => {
      const server = setup(fakeServices(1, 0));
      const result = await server.find("xc_peer_inbox").handler({}, {});
      const payload = payloadOf(result) as { count: number; remaining: number };
      expect(payload.remaining).toBe(0);
      expect(result.content[0]?.text).toBe("取到 1 条跨会话消息（已消费）。");
    });
  });

  it("面 B 语义不扩伤：xc_peers（非自主排空面）仍走面 B 追加 content[2]", async () => {
    await withPeerSession(async () => {
      const server = setup(fakeServices(0, 0));
      const result = await server.find("xc_peers").handler({}, {});
      expect(result.content).toHaveLength(3);
      expect(String((result.content[2] as { text?: string }).text)).toContain("from-face-B");
    });
  });

  it("工具描述声明 count 口径与 remaining 翻页语义（schema 面回归锁定）", () => {
    const server = setup(fakeServices(0, 0));
    const description = server.find("xc_peer_inbox").description;
    expect(description).toContain("count = envelopes presented in this response");
    expect(description).toContain("remaining");
  });
});
