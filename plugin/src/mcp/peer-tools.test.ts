/**
 * W6 单测：跨会话 peer 工具面（DESIGN-V0.3.md §8.1 七工具、§8.2 分立理由、
 * §7.4 回执六态、§7.5 发送侧权限防线；SPEC R-7 / R-13 / R-17 / R-24 / R-32）。
 *
 * 依赖隔离：工具层只依赖注入的 `PeerServices`（假实现），**不依赖真实管道与
 * 真实注册表**（所有权表：「工具层用例（不依赖真实管道，用注入的假端点）」）。
 *
 * 覆盖：
 * - 7 个工具全部注册、参数 schema 合法/非法；
 * - `xc_peer_send` 的工具描述内嵌反 launder 警示（R-17 / CC @34233402）；
 * - 各工具的结果信封形状（人可读摘要行 + 机器 JSON）与错误映射；
 * - 回执六态原样透传；发送失败时带 `errorClass`（R-32）。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PeerInboxShape,
  PeerListShape,
  PeerReadShape,
  PeerRegisterShape,
  PeerRenameShape,
  PeerReviewShape,
  PeerSendShape,
  registerPeerTools,
  validateSendModeArgs,
  type PeerAgentsPanel,
  type PeerReadResult,
  type PeerRegisterResult,
  type PeerRenameResult,
  type PeerReviewResult,
  type PeerRow,
  type PeerSendResult,
  type PeerServices,
} from "./peer-tools.js";
import type { PeerQueueItem } from "../core/peermsg.js";
import { payloadOf, ToolError, type ToolResult } from "./protocol.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./tools.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: Handler;
}

/** 假 MCP server：只收集注册进来的工具（不接 SDK transport）。 */
class FakeServer {
  readonly tools: RegisteredTool[] = [];

  tool(name: string, description: string, schema: unknown, handler: Handler): void {
    this.tools.push({
      name,
      description,
      schema: schema as Record<string, unknown>,
      handler,
    });
  }

  find(name: string): RegisteredTool {
    const found = this.tools.find((tool) => tool.name === name);
    if (found === undefined) throw new Error(`tool not registered: ${name}`);
    return found;
  }
}

const deps: ToolDeps = { stateRoot: "<stateRoot>", workspace: "<workspace>", env: {} };

function row(overrides: Partial<PeerRow> = {}): PeerRow {
  return {
    name: "bob",
    kind: "session",
    identity: "bob@3f9c1a20",
    ref: "b1c2d3d4",
    sessionId: "sess-bob",
    pid: 4242,
    cwd: "D:\\ws-b",
    status: "idle",
    lastSeenMs: 1200,
    ...overrides,
  };
}

/** 假服务：记录调用并返回可预期的结果。 */
function fakeServices(overrides: Partial<PeerServices> = {}): PeerServices & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]): Promise<never> => {
      calls.push([name, ...args]);
      throw new Error("unexpected call");
    };
  const base: PeerServices = {
    register: async (input): Promise<PeerRegisterResult> => {
      calls.push(["register", input]);
      return {
        name: input.name,
        sessionId: input.sessionId,
        pid: 111,
        socketPath: "\\\\.\\pipe\\LOCAL\\xcc-msg-test",
        keyFile: "C:\\peers\\keys\\111.key",
        tokenHint: "abcdef12",
        modeClassSource: "base-record",
      };
    },
    list: async (kind): Promise<PeerRow[]> => {
      calls.push(["list", kind]);
      return [row()];
    },
    send: async (input): Promise<PeerSendResult> => {
      calls.push(["send", input]);
      return { receipt: "delivered", via: "pipe", msgId: "m-1", to: "bob" };
    },
    read: async (input): Promise<PeerReadResult> => {
      calls.push(["read", input]);
      return { msgId: input.msgId, total: 100, offset: input.offset ?? 0, text: "hi", hasMore: false };
    },
    inbox: async (limit): Promise<{ items: PeerQueueItem[]; rendered: string[] }> => {
      calls.push(["inbox", limit]);
      return {
        items: [
          {
            msgId: "m-1",
            from: "bob",
            hopChain: ["bob"],
            text: "hi",
            ts: 1,
            via: "pipe",
          },
        ],
        rendered: ['<crosschat-peer-message from="bob">\nhi\n</crosschat-peer-message>'],
      };
    },
    review: async (input): Promise<PeerReviewResult> => {
      calls.push(["review", input]);
      return {
        action: input.action,
        held: [{ msgId: "m-9", from: "bob", ts: 1, cause: "mode-mismatch" }],
        affected: input.ids ?? [],
        receipts: [],
      };
    },
    rename: async (name): Promise<PeerRenameResult> => {
      calls.push(["rename", name]);
      return { name, formerName: "alice", notified: [{ name: "bob", ok: true }] };
    },
    agents: async (): Promise<PeerAgentsPanel> => {
      calls.push(["agents"]);
      return {
        self: row({ name: "alice", kind: "self" }),
        peers: [row()],
        members: [{ key: "m1", role: "worker", state: "ready", unread: 0, isLead: false }],
        tasks: { pending: 1, inProgress: 2, done: 3 },
        inboundPolicy: { mode: "hold", decidedBy: "repo-setting", strictest: "hold" },
      };
    },
  };
  void record;
  return Object.assign(base, overrides, { calls }) as PeerServices & { calls: unknown[][] };
}

function setup(services: PeerServices): FakeServer {
  const server = new FakeServer();
  registerPeerTools(server as unknown as McpServer, { ...deps, peer: services });
  return server;
}

describe("注册面（DESIGN §8.1）", () => {
  it("8 个工具全部注册（v0.5 增 xc_peer_read，R-22）", () => {
    const server = setup(fakeServices());
    expect(server.tools.map((tool) => tool.name)).toEqual([
      "xc_peer_register",
      "xc_peers",
      "xc_peer_send",
      "xc_peer_inbox",
      "xc_peer_read",
      "xc_peer_review",
      "xc_peer_rename",
      "xc_agents",
    ]);
  });

  it("xc_peer_send 的描述内嵌反 launder 警示（R-17 / CC @34233402）", () => {
    const server = setup(fakeServices());
    const description = server.find("xc_peer_send").description;
    expect(description).toContain("permission laundering");
    expect(description).toContain("权限");
  });
});

describe("参数 schema", () => {
  it("各工具的合法入参通过校验", () => {
    expect(z.object(PeerRegisterShape).safeParse({ name: "alice", sessionId: "sess-a" }).success).toBe(true);
    expect(z.object(PeerListShape).safeParse({ kind: "session" }).success).toBe(true);
    expect(z.object(PeerListShape).safeParse({}).success).toBe(true);
    expect(z.object(PeerSendShape).safeParse({ to: "bob", message: "hi" }).success).toBe(true);
    expect(z.object(PeerInboxShape).safeParse({ limit: 5 }).success).toBe(true);
    expect(z.object(PeerReviewShape).safeParse({ action: "list" }).success).toBe(true);
    expect(z.object(PeerRenameShape).safeParse({ name: "alice2" }).success).toBe(true);
  });

  it("非法入参被拒", () => {
    expect(z.object(PeerRegisterShape).safeParse({ name: "", sessionId: "s" }).success).toBe(false);
    // v0.5（R-13）：message 改 optional（forwardOf 模式不带正文）；「message 与
    // forwardOf 至少其一」的互斥校验在服务面（services.send）兜底，schema 层只查形状。
    expect(z.object(PeerSendShape).safeParse({ to: "bob" }).success).toBe(true);
    expect(z.object(PeerSendShape).safeParse({ to: "bob", message: "" }).success).toBe(false);
    expect(z.object(PeerSendShape).safeParse({ to: "bob", forwardOf: "" }).success).toBe(false);
    expect(z.object(PeerRegisterShape).safeParse({ name: "a", sessionId: "s", contextChars: 0 }).success).toBe(false);
    expect(z.object(PeerRegisterShape).safeParse({ name: "a", sessionId: "s", contextChars: 1.5 }).success).toBe(false);
    expect(z.object(PeerListShape).safeParse({ kind: "nope" }).success).toBe(false);
    expect(z.object(PeerInboxShape).safeParse({ limit: 0 }).success).toBe(false);
    expect(z.object(PeerReadShape).safeParse({ msgId: "" }).success).toBe(false);
    expect(z.object(PeerReadShape).safeParse({ msgId: "m", offset: -1 }).success).toBe(false);
    expect(z.object(PeerReadShape).safeParse({ msgId: "m", limit: 0 }).success).toBe(false);
    expect(z.object(PeerReviewShape).safeParse({ action: "explode" }).success).toBe(false);
  });
});

describe("xc_peer_register", () => {
  it("调用注册服务并回显结果", async () => {
    const services = fakeServices();
    const server = setup(services);
    const result = await server.find("xc_peer_register").handler({ name: "alice", sessionId: "sess-a" }, {});
    expect(services.calls[0]).toEqual(["register", { name: "alice", sessionId: "sess-a" }]);
    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.text).toContain("alice");
    const payload = payloadOf(result);
    expect(payload["sessionId"]).toBe("sess-a");
    expect(payload["tokenHint"]).toBe("abcdef12");
  });

  it("注册失败 → 结构化错误信封", async () => {
    const services = fakeServices({
      register: async () => {
        throw new ToolError({ error: "name_taken", name: "alice" }, "peer name already registered");
      },
    });
    const server = setup(services);
    const result = await server.find("xc_peer_register").handler({ name: "alice", sessionId: "s" }, {});
    expect(result.isError).toBe(true);
    expect(payloadOf(result)["error"]).toBe("name_taken");
  });
});

describe("xc_peers", () => {
  it("列出 peer 行并渲染表格", async () => {
    const services = fakeServices();
    const server = setup(services);
    const result = await server.find("xc_peers").handler({ kind: "session" }, {});
    expect(services.calls[0]).toEqual(["list", "session"]);
    expect(result.content[0]!.text).toContain("bob");
    const payload = payloadOf(result);
    expect(payload["count"]).toBe(1);
  });

  it("行文本用 W3 的规范行格式（DESIGN §5.2：`<名字> [<kind>]` + cwd/status/seen）", async () => {
    const services = fakeServices();
    const server = setup(services);
    const result = await server.find("xc_peers").handler({ kind: "session" }, {});
    const text = result.content[0]!.text;
    expect(text).toContain("bob [session]");
    expect(text).toContain("cwd=D:\\ws-b");
    expect(text).toContain("status=idle");
    // 身份串只进结构化字段，不进紧凑行文本（DESIGN §5.2）。
    expect(text).not.toContain("bob@3f9c1a20");
    expect(JSON.stringify(payloadOf(result)["rows"])).toContain("3f9c1a20");
  });

  it("缺省 kind 时把 undefined 透传（默认三类行口径，见 peer-tools.integration.test.ts）", async () => {
    const services = fakeServices();
    const server = setup(services);
    await server.find("xc_peers").handler({}, {});
    expect(services.calls[0]).toEqual(["list", undefined]);
  });
});

describe("xc_peer_send", () => {
  it("回执六态原样透传", async () => {
    for (const receipt of ["held", "denied", "expired", "delivered", "refused", "dropped"] as const) {
      const services = fakeServices({
        send: async () => ({ receipt, via: "pipe", msgId: "m-1", to: "bob" }),
      });
      const server = setup(services);
      const result = await server.find("xc_peer_send").handler({ to: "bob", message: "hi" }, {});
      expect(payloadOf(result)["receipt"]).toBe(receipt);
      expect(result.content[0]!.text).toContain(receipt);
    }
  });

  it("发送失败 → 错误信封带 errorClass（R-32）", async () => {
    const services = fakeServices({
      send: async () => {
        throw new ToolError(
          { error: "peer_send_failed", errorClass: "stale_socket", message: "peer is gone" },
          "peer is gone",
        );
      },
    });
    const server = setup(services);
    const result = await server.find("xc_peer_send").handler({ to: "bob", message: "hi" }, {});
    expect(result.isError).toBe(true);
    expect(payloadOf(result)["errorClass"]).toBe("stale_socket");
  });

  it("未注册 → not_registered", async () => {
    const services = fakeServices({
      send: async () => {
        throw new ToolError({ error: "not_registered", message: "not registered: call xc_peer_register first" });
      },
    });
    const server = setup(services);
    const result = await server.find("xc_peer_send").handler({ to: "bob", message: "hi" }, {});
    expect(payloadOf(result)["error"]).toBe("not_registered");
  });
});

describe("xc_peer_inbox", () => {
  it("返回渲染好的信封", async () => {
    const services = fakeServices();
    const server = setup(services);
    const result = await server.find("xc_peer_inbox").handler({ limit: 10 }, {});
    expect(services.calls[0]).toEqual(["inbox", 10]);
    const payload = payloadOf(result);
    expect(payload["count"]).toBe(1);
    expect(String(payload["envelopes"])).toContain("<crosschat-peer-message");
  });
});

describe("xc_peer_review", () => {
  it("list 默认动作", async () => {
    const services = fakeServices();
    const server = setup(services);
    await server.find("xc_peer_review").handler({}, {});
    expect(services.calls[0]).toEqual(["review", { action: "list" }]);
  });

  it("accept 带 ids", async () => {
    const services = fakeServices();
    const server = setup(services);
    const result = await server.find("xc_peer_review").handler({ action: "accept", ids: ["m-9"] }, {});
    expect(services.calls[0]).toEqual(["review", { action: "accept", ids: ["m-9"] }]);
    expect(payloadOf(result)["action"]).toBe("accept");
  });
});

describe("xc_peer_rename", () => {
  it("旧名进 formerNames 并回报通知结果", async () => {
    const services = fakeServices();
    const server = setup(services);
    const result = await server.find("xc_peer_rename").handler({ name: "alice2" }, {});
    expect(services.calls[0]).toEqual(["rename", "alice2"]);
    const payload = payloadOf(result);
    expect(payload["formerName"]).toBe("alice");
    expect(result.content[0]!.text).toContain("alice2");
  });
});

describe("xc_agents", () => {
  it("一次返回面板（peers + 成员 + 任务概览 + 入站策略）", async () => {
    const services = fakeServices();
    const server = setup(services);
    const result = await server.find("xc_agents").handler({}, {});
    const payload = payloadOf(result);
    expect(payload["self"]).toBeDefined();
    expect(Array.isArray(payload["peers"])).toBe(true);
    expect(Array.isArray(payload["members"])).toBe(true);
    expect(payload["tasks"]).toEqual({ pending: 1, inProgress: 2, done: 3 });
    expect((payload["inboundPolicy"] as { mode: string }).mode).toBe("hold");
  });
});

describe("面 B：peer 工具结果里的信封投递（DESIGN §7.1）", () => {
  it("有待投递的 peer 消息时，信封块被追加为末尾 text 块，content[0]/content[1] 不变", async () => {
    const { setPeerSessionContext, clearPeerSessionContext } = await import("./peer-drain.js");
    setPeerSessionContext({ sessionId: "sess-bob", name: "bob", root: "<peerRoot>" });
    try {
      const server = new FakeServer();
      const fakeDrain = {
        drain: async () => [{ msgId: "m-9", from: "alice", hopChain: ["alice"], text: "ping", ts: 1, via: "pipe" as const }],
        render: () => '<crosschat-peer-message from="alice">\nping\n</crosschat-peer-message>',
      };
      registerPeerTools(server as unknown as McpServer, {
        ...deps,
        peer: fakeServices(),
        peerDrain: fakeDrain,
      });
      const result = await server.find("xc_peers").handler({}, {});
      expect(result.content.length).toBe(3);
      expect(result.content[2]?.type).toBe("text");
      expect(String((result.content[2] as { text?: string }).text)).toContain("<crosschat-peer-message");
      // content[0] 仍是人可读摘要行、content[1] 仍是机器 JSON（既有解析方不错位）。
      expect(payloadOf(result)).toBeDefined();
      expect(String(result.content[0]?.text)).toContain("可寻址 peer");
    } finally {
      clearPeerSessionContext();
    }
  });

  it("无待投递消息时，工具结果与未包装时逐字节相同（content.length===2）", async () => {
    const { setPeerSessionContext, clearPeerSessionContext } = await import("./peer-drain.js");
    setPeerSessionContext({ sessionId: "sess-bob", name: "bob", root: "<peerRoot>" });
    try {
      const server = new FakeServer();
      registerPeerTools(server as unknown as McpServer, {
        ...deps,
        peer: fakeServices(),
        peerDrain: { drain: async () => [], render: () => "" },
      });
      const result = await server.find("xc_peers").handler({}, {});
      expect(result.content.length).toBe(2);
      expect(payloadOf(result)).toBeDefined();
    } finally {
      clearPeerSessionContext();
    }
  });
});

// ---------------------------------------------------------------------------
// v0.5 M5（DESIGN-V0.5.md §6.3-11）：forwardOf 互斥（R-13）、xc_peer_read（R-22）、
// 面 C 注入预算（R-23）、contextChars 透传（R-18）、isLead（R-7）。
// ---------------------------------------------------------------------------

describe("v0.5 forwardOf 互斥（R-13）", () => {
  it("forwardOf 与 message 混用 → invalid_params", () => {
    expect(() => validateSendModeArgs({ message: "hi", forwardOf: "m-1" })).toThrowError(/R-13/);
  });

  it("两者都缺 → invalid_params（message 必填或 forwardOf）", () => {
    expect(() => validateSendModeArgs({})).toThrowError(/message is required/);
  });

  it("普通发送（只带 message）/ 纯转发（只带 forwardOf）均合法", () => {
    expect(() => validateSendModeArgs({ message: "hi" })).not.toThrow();
    expect(() => validateSendModeArgs({ forwardOf: "m-1" })).not.toThrow();
  });

  it("handler 把 message/forwardOf 原样传给服务面", async () => {
    const services = fakeServices();
    const server = setup(services);
    await server.find("xc_peer_send").handler({ to: "bob", forwardOf: "m-9" }, {});
    expect(services.calls[0]).toEqual(["send", { to: "bob", forwardOf: "m-9" }]);
    await server.find("xc_peer_send").handler({ to: "bob", message: "hi", summary: "s" }, {});
    expect(services.calls[1]).toEqual(["send", { to: "bob", message: "hi", summary: "s" }]);
  });
});

describe("v0.5 xc_peer_read（R-22 只读分页器）", () => {
  it("透传 msgId/offset/limit 给服务面并回显分页信息", async () => {
    const services = fakeServices();
    const server = setup(services);
    const result = await server.find("xc_peer_read").handler({ msgId: "m-1", offset: 40, limit: 20 }, {});
    expect(services.calls[0]).toEqual(["read", { msgId: "m-1", offset: 40, limit: 20 }]);
    const payload = payloadOf(result);
    expect(payload["msgId"]).toBe("m-1");
    expect(payload["total"]).toBe(100);
    expect(payload["offset"]).toBe(40);
    expect(payload["hasMore"]).toBe(false);
    expect(result.content[0]!.text).toContain("m-1");
  });

  it("服务面抛 invalid_params（未知 msgId）→ 错误信封", async () => {
    const services = fakeServices({
      read: async () => {
        throw new ToolError(
          { error: "invalid_params", msgId: "m-x", message: 'unknown msgId "m-x"' },
          'unknown msgId "m-x"',
        );
      },
    });
    const server = setup(services);
    const result = await server.find("xc_peer_read").handler({ msgId: "m-x" }, {});
    expect(result.isError).toBe(true);
    expect(payloadOf(result)["error"]).toBe("invalid_params");
  });
});

describe("v0.5 面 C 注入预算（R-23）", () => {
  function setupWithEnv(services: PeerServices, env: Record<string, string>): FakeServer {
    const server = new FakeServer();
    registerPeerTools(server as unknown as McpServer, { ...deps, env: { ...deps.env, ...env }, peer: services });
    return server;
  }

  it("渲染结果超预算 → envelopes 为排布结果（降级/截断 + budgetTruncated）", async () => {
    const big = "x".repeat(500);
    const services = fakeServices({
      inbox: async () => ({
        items: [
          { msgId: "m-big", from: "bob", hopChain: ["bob"], text: big, ts: 2, via: "pipe" as const },
          { msgId: "m-small", from: "bob", hopChain: ["bob"], text: "hi", ts: 1, via: "pipe" as const },
        ],
        rendered: [`<crosschat-peer-message from="bob">\n${big}\n</crosschat-peer-message>`],
      }),
    });
    const server = setupWithEnv(services, { XC_INJECT_ITEM_CHARS: "200", XC_INJECT_TOTAL_CHARS: "300" });
    const result = await server.find("xc_peer_inbox").handler({}, {});
    const payload = payloadOf(result);
    expect(payload["count"]).toBe(2);
    const envelopes = payload["envelopes"] as string[];
    // 总预算 300：新块 m-big 截到 item=199+指针行、m-small 20 字符 → 排布结果非原文直通
    expect(envelopes.length).toBeGreaterThan(0);
    expect(envelopes.join("\n").length).toBeLessThan(big.length);
    expect(payload["budgetTruncated"]).toBe(true);
    expect(envelopes.join("\n")).toContain("xc_peer_read");
  });

  it("预算充足 → envelopes 即渲染原文（v0.4 行为不变）", async () => {
    const services = fakeServices();
    const server = setupWithEnv(services, { XC_INJECT_ITEM_CHARS: "99999999", XC_INJECT_TOTAL_CHARS: "99999999" });
    const result = await server.find("xc_peer_inbox").handler({}, {});
    const payload = payloadOf(result);
    expect(payload["count"]).toBe(1);
    expect(String(payload["envelopes"])).toContain("<crosschat-peer-message");
    expect(payload["budgetTruncated"]).toBeUndefined();
  });
});

describe("v0.5 xc_peer_register contextChars 透传（R-18）与 xc_agents isLead（R-7）", () => {
  it("contextChars 透传给注册服务", async () => {
    const services = fakeServices();
    const server = setup(services);
    await server.find("xc_peer_register").handler({ name: "a", sessionId: "s", contextChars: 50000 }, {});
    expect(services.calls[0]).toEqual(["register", { name: "a", sessionId: "s", contextChars: 50000 }]);
  });

  it("agents 面板成员行带 isLead（现算字段透传）", async () => {
    const services = fakeServices({
      agents: async (): Promise<PeerAgentsPanel> => ({
        peers: [],
        members: [
          { key: "lead1", role: "peer", state: "ready", unread: 0, isLead: true },
          { key: "m2", role: "worker", state: "ready", unread: 0, isLead: false },
        ],
        tasks: { pending: 0, inProgress: 0, done: 0 },
      }),
    });
    const server = setup(services);
    const result = await server.find("xc_agents").handler({}, {});
    const members = (payloadOf(result)["members"] as { key: string; isLead: boolean }[]);
    expect(members.map((member) => ({ key: member.key, isLead: member.isLead }))).toEqual([
      { key: "lead1", isLead: true },
      { key: "m2", isLead: false },
    ]);
  });
});
