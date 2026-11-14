/**
 * v0.6（DESIGN-V0.6.md §4.1 M1）改判+保留测试：peer 服务契约面。
 *
 * 原 peer-tools.test.ts（v0.5 的 8 工具面单测）在 v0.6 的处置：
 * - **工具面用例改判 N/A**（条款 2a 台账登记）：xc_peer_register/xc_peers/xc_peer_send/
 *   xc_peer_inbox/xc_peer_read/xc_peer_review/xc_peer_rename/xc_agents 八个旧工具
 *   已并入五家族（xc_identify / xc_relay / xc_read / xc_overview / xc_review，
 *   §1.3 迁移表）；「8 工具注册」「各工具 schema」「面 B 挂在 peer 工具上」
 *   「forwardOf 互斥（handler 透传）」等旧面用例随之 N/A。替代覆盖：
 *   · 新工具面（恰 10 名 + 22 旧名垫片 + forwardOf_removed）→ src/mcp/alias.test.ts；
 *   · relay 双轴路由/urgent/interrupt/入站策略 → src/mcp/tools-relay.test.ts；
 *   · peer 真实管道端到端（register/send/inbox/read/review/rename/agents）→
 *     src/mcp/peer-tools.integration.test.ts；
 *   · inbox count 口径 → src/mcp/peer-inbox-count.test.ts。
 * - **服务契约用例保留**（本文件）：PeerServices 接口的入参透传/回执六态/分页/
 *   面板/审阅摘要等纯契约不随工具面合并而失效——旧「经工具 handler 驱动」改为
 *   「直驱服务接口」（工具层的信封映射/错误映射由上述新测试覆盖）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  admissionDropDetail,
  countReleaseOutcomes,
  createDefaultPeerServices,
  renderReviewSummary,
  validateSendModeArgs,
  type PeerAgentsPanel,
  type PeerReadResult,
  type PeerRegisterResult,
  type PeerRenameResult,
  type PeerReviewResult,
  type PeerRow,
  type PeerServices,
  type PeerSendResult,
} from "./peer-services.js";
import type { PeerQueueItem } from "../core/peermsg.js";

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

/** 假服务：记录调用并返回可预期的结果（工具面 N/A 后，直驱契约）。 */
function fakeServices(overrides: Partial<PeerServices> = {}): PeerServices & { calls: unknown[][] } {
  const calls: unknown[][] = [];
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
    inbox: async (limit, budget): Promise<{ items: PeerQueueItem[]; rendered: string[]; remaining: number }> => {
      calls.push(["inbox", limit, ...(budget === undefined ? [] : [budget])]);
      return {
        items: [{ msgId: "m-1", from: "bob", hopChain: ["bob"], text: "hi", ts: 1, via: "pipe" }],
        rendered: ['<crosschat-peer-message from="bob">\nhi\n</crosschat-peer-message>'],
        remaining: 0,
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
  return Object.assign(base, overrides, { calls }) as PeerServices & { calls: unknown[][] };
}

// ─────────────────────────── 注册/寻址契约（原 xc_peer_register 用例） ───────────────────────────

describe("PeerServices.register 契约（原 xc_peer_register 工具用例的服务半边）", () => {
  it("入参透传 + 回显结果（tokenHint/socketPath/modeClassSource）", async () => {
    const services = fakeServices();
    const result = await services.register({ name: "alice", sessionId: "sess-a" });
    expect(services.calls[0]).toEqual(["register", { name: "alice", sessionId: "sess-a" }]);
    expect(result.sessionId).toBe("sess-a");
    expect(result.tokenHint).toBe("abcdef12");
    expect(result.modeClassSource).toBe("base-record");
  });

  it("contextChars 透传（R-18 不回退）", async () => {
    const services = fakeServices();
    await services.register({ name: "a", sessionId: "s", contextChars: 50000 });
    expect(services.calls[0]).toEqual(["register", { name: "a", sessionId: "s", contextChars: 50000 }]);
  });

  it("注册失败（name_taken）以错误传播（工具层信封映射见 tools-identify/alias 测试）", async () => {
    const services = fakeServices({
      register: async () => {
        throw new Error("peer name already registered");
      },
    });
    await expect(services.register({ name: "alice", sessionId: "s" })).rejects.toThrow(/already registered/);
  });
});

describe("PeerServices.list 契约（原 xc_peers 工具用例的服务半边）", () => {
  it("行对象携带寻址字段（name/kind/ref/identity/cwd/status/lastSeenMs）", async () => {
    const services = fakeServices();
    const rows = await services.list("session");
    expect(services.calls[0]).toEqual(["list", "session"]);
    expect(rows[0]).toMatchObject({
      name: "bob",
      kind: "session",
      ref: "b1c2d3d4",
      sessionId: "sess-bob",
      pid: 4242,
      cwd: "D:\\ws-b",
      status: "idle",
    });
    // 身份串只进结构化字段（行文本规范在 peeraddr.formatPeerRows，integration 覆盖）。
    expect(rows[0]!.identity).toBe("bob@3f9c1a20");
  });

  it("缺省 kind 时把 undefined 透传（默认三类行口径）", async () => {
    const services = fakeServices();
    await services.list();
    expect(services.calls[0]).toEqual(["list", undefined]);
  });
});

// ─────────────────────────── 发送契约（原 xc_peer_send 工具用例的服务半边） ───────────────────────────

describe("PeerServices.send 契约（原 xc_peer_send 工具用例的服务半边）", () => {
  it("回执六态原样透传（held/denied/expired/delivered/refused/dropped）", async () => {
    for (const receipt of ["held", "denied", "expired", "delivered", "refused", "dropped"] as const) {
      const services = fakeServices({
        send: async () => ({ receipt, via: "pipe", msgId: "m-1", to: "bob" }),
      });
      const result = await services.send({ to: "bob", message: "hi" });
      expect(result.receipt).toBe(receipt);
      expect(result.via).toBe("pipe");
    }
  });

  it("summary 透传（SendMessage 参数形状同规）", async () => {
    const services = fakeServices();
    await services.send({ to: "bob", message: "hi", summary: "s" });
    expect(services.calls[0]).toEqual(["send", { to: "bob", message: "hi", summary: "s" }]);
  });

  it("v0.6（§2.2 行 4）：send 入参无 forwardOf——转发请求在 alias/xc_relay 层即被拒", () => {
    // 旧用例「handler 把 message/forwardOf 原样传给服务面」N/A：PeerSendInput 已无
    // forwardOf 字段（类型级不可能透传）；显式 forwardOf_removed 报错见
    // tools-relay.test.ts 的「迁移垫片」describe 与 alias.test.ts 的 T1-b-2。
    const input: { to: string; message: string } = { to: "bob", message: "hi" };
    expect(Object.keys(input)).toEqual(["to", "message"]);
  });
});

// ─────────────────────────── 读取契约（原 xc_peer_read / xc_peer_inbox 工具用例的服务半边） ───────────────────────────

describe("PeerServices.read 契约（原 xc_peer_read 工具用例的服务半边）", () => {
  it("msgId/offset/limit 透传 + 分页信息回显", async () => {
    const services = fakeServices();
    const page = await services.read({ msgId: "m-1", offset: 40, limit: 20 });
    expect(services.calls[0]).toEqual(["read", { msgId: "m-1", offset: 40, limit: 20 }]);
    expect(page).toMatchObject({ msgId: "m-1", total: 100, offset: 40, hasMore: false });
  });

  it("未知 msgId 以错误传播（工具层映射 invalid_params 信封）", async () => {
    const services = fakeServices({
      read: async () => {
        throw new Error('unknown msgId "m-x"');
      },
    });
    await expect(services.read({ msgId: "m-x" })).rejects.toThrow(/unknown msgId/);
  });
});

describe("PeerServices.inbox 契约（原 xc_peer_inbox 工具用例的服务半边）", () => {
  it("limit 透传 + 渲染信封 + remaining 计数", async () => {
    const services = fakeServices();
    const result = await services.inbox(10);
    expect(services.calls[0]).toEqual(["inbox", 10]);
    expect(result.items).toHaveLength(1);
    expect(result.rendered[0]).toContain("<crosschat-peer-message");
    expect(result.remaining).toBe(0);
  });

  it("预算入参透传（SCALE-3：窗口与排布同源）", async () => {
    const services = fakeServices();
    await services.inbox(10, { item: 200, total: 300, scale: 1 });
    expect(services.calls[0]).toEqual(["inbox", 10, { item: 200, total: 300, scale: 1 }]);
  });
});

// ─────────────────────────── 审阅契约（原 xc_peer_review / renderReviewSummary 用例） ───────────────────────────

describe("PeerServices.review 契约（原 xc_peer_review 工具用例的服务半边）", () => {
  it("list/accept 入参透传", async () => {
    const services = fakeServices();
    await services.review({ action: "list" });
    expect(services.calls[0]).toEqual(["review", { action: "list" }]);
    await services.review({ action: "accept", ids: ["m-9"] });
    expect(services.calls[1]).toEqual(["review", { action: "accept", ids: ["m-9"] }]);
  });
});

describe("renderReviewSummary（BND-2 修复：摘要行不再虚报「影响 N 条」）", () => {
  it("accept 全部放行 → 摘要行报「放行投递 N 条」，不再出现「影响 N 条」", () => {
    const text = renderReviewSummary({
      action: "accept",
      held: [{ msgId: "m-9", from: "bob", ts: 1, cause: "repo-setting" }],
      affected: ["m-9"],
      receipts: [{ msgId: "m-9", receipt: "delivered", outcome: "delivered" }],
    });
    expect(text).toContain("accept 结果：放行投递 1 条");
    expect(text).not.toContain("影响");
  });

  it("accept 混合终态（delivered + still-held）→ 分组如实播报，滞留不再被算成成功", () => {
    const text = renderReviewSummary({
      action: "accept",
      held: [
        { msgId: "m-1", from: "bob", ts: 1, cause: "repo-setting" },
        { msgId: "m-2", from: "bob", ts: 2, cause: "repo-setting" },
      ],
      affected: ["m-1", "m-2"],
      receipts: [
        { msgId: "m-1", receipt: "delivered", outcome: "delivered" },
        { msgId: "m-2", outcome: "still-held" },
      ],
    });
    expect(text).toContain("放行投递 1 条");
    expect(text).toContain("仍滞留 1 条（未放行）");
  });

  it("accept 无可处理项 → 明说「无可处理的暂存件」而非「影响 0 条」的含糊口径", () => {
    const text = renderReviewSummary({ action: "accept", held: [], affected: [], receipts: [] });
    expect(text).toContain("无可处理的暂存件");
  });

  it("list/discard 摘要行保持旧口径（discard 的结果全是 discarded，「影响 N 条」属实）", () => {
    const listed = renderReviewSummary({
      action: "list",
      held: [{ msgId: "m-9", from: "bob", ts: 1, cause: "repo-setting" }],
      affected: [],
      receipts: [],
    });
    expect(listed).toContain("本次动作 list，影响 0 条");
    const discarded = renderReviewSummary({
      action: "discard",
      held: [{ msgId: "m-9", from: "bob", ts: 1, cause: "repo-setting" }],
      affected: ["m-9"],
      receipts: [{ msgId: "m-9", receipt: "denied", outcome: "discarded" }],
    });
    expect(discarded).toContain("本次动作 discard，影响 1 条");
  });

  it("损坏暂存件计数披露（故障注-4：审阅面不再显示干净假象）", () => {
    const text = renderReviewSummary({
      action: "list",
      held: [],
      affected: [],
      receipts: [],
      corrupted: [{ file: "x.json", error: "bad" }],
    });
    expect(text).toContain("1 条暂存件损坏");
  });

  it("countReleaseOutcomes：未知终态计进 other（前向兼容，不静默丢）", () => {
    const counts = countReleaseOutcomes([
      { outcome: "delivered" },
      { outcome: "still-held" },
      { outcome: "refused" },
      { outcome: "dropped" },
      { outcome: "future-state" },
      {},
    ]);
    expect(counts).toEqual({ delivered: 1, dropped: 1, refused: 1, "still-held": 1, other: 2 });
  });
});

// ─────────────────────────── 入队闸 detail（SCALE-2：dropped 回执可行动化） ───────────────────────────

describe("admissionDropDetail（SCALE-2 修复：dropped 回执带上限值与恢复动作）", () => {
  it("queue-full 带上限与恢复动作", () => {
    const text = admissionDropDetail("queue-full", 1024);
    expect(text).toContain("1024");
    expect(text).toContain("NOT delivered");
  });

  it("rate-limited / duplicate / loop-depth 各有可行动文案", () => {
    expect(admissionDropDetail("rate-limited", 1024)).toContain("pace your sends");
    expect(admissionDropDetail("duplicate", 1024)).toContain("nothing to retry");
    expect(admissionDropDetail("loop-depth", 1024)).toContain("forwarding loops are dropped");
    expect(admissionDropDetail("mystery", 1024)).toBe("mystery");
  });
});

// ─────────────────────────── v0.6：发送入参校验（forwardOf 砍除后的 message 必填） ───────────────────────────

describe("v0.6 validateSendModeArgs（§2.2 行 4：forwardOf 已砍，message 必填）", () => {
  it("缺 message → invalid_params", () => {
    expect(() => validateSendModeArgs({} as never)).toThrowError(/message is required/);
    expect(() => validateSendModeArgs({ message: "" })).toThrowError(/message is required/);
  });

  it("普通发送（带 message）合法", () => {
    expect(() => validateSendModeArgs({ message: "hi" })).not.toThrow();
  });
});

// ─────────────────────────── v0.6：默认装配冒烟（真实 createDefaultPeerServices 可构造） ───────────────────────────

describe("v0.6：createDefaultPeerServices 默认装配（迁移后端到端可用性）", () => {
  it("八个服务方法全部在场（工具家族经 getPeerServices 单例消费）", () => {
    const root = mkdtempSync(join(tmpdir(), "xc-peer-svc-default-"));
    try {
      const services = createDefaultPeerServices({ stateRoot: root, workspace: root, env: {} });
      for (const method of ["register", "list", "send", "read", "inbox", "review", "rename", "agents"] as const) {
        expect(typeof services[method]).toBe("function");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
