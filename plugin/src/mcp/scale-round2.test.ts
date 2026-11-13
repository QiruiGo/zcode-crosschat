/**
 * v0.5.2 红队二番战·规模压力组的防回归单测（本文件先以「复现」形态落地）。
 *
 * 覆盖（裁决 #18~#21 / 二番战 cases.md 规模压力）：
 * - SCALE-1（#18，P1）：xc_status 板面/leadHistory/xc_agents/xc_peers 全部接入
 *   接收方声明预算（XC_CONTEXT_CHARS）——700 任务 285K 直灌、声明 4× 预算输出
 *   不变的根因修复：板面按「人可读行+JSON 条目」联合成本开到达序窗口（保底
 *   一条），窗口外任务 boardTruncated{shown,total,offset,budgetChars} +
 *   xc_status{offset} 分页；snapshot.json 落盘仍全量（R-21）。
 * - SCALE-2（#19，P1）：peer 入站队列上限 64→1024 且可配（XC_PEER_MAX_QUEUE_
 *   DEPTH）；queue-full 丢弃的 detail 带上限值与恢复动作（发方可行动）。
 * - SCALE-3（#20，P2）：xc_peer_inbox 批次改为「窥视→预算窗口→只消费窗口内」，
 *   窗口外消息留在队列、remaining/「再拉一次」指针名副其实，响应不再出现
 *   「已省略（超注入预算）」占位符（消费即省略的根因）。
 * - SCALE-4（#21，P2）：发送限速常量契约锁定（README 文档化 30 条/10s，实现
 *   常量漂移即测试红）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore } from "./tools.js";
import { writeSession } from "../core/registry.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import { PEER_MAX_QUEUE_DEPTH, PEER_RATE_LIMIT, PEER_RATE_WINDOW_MS, admitPeerMessage, createRateBuckets, peerMaxQueueDepthFromEnv } from "../core/peermsg.js";
import { admissionDropDetail, createDefaultPeerServices, registerPeerTools, validateSendModeArgs } from "./peer-tools.js";
import { appendPeerQueue, readPeerQueue } from "../core/peermsg.js";
import { stopPeerEndpoint } from "../transport/pipe.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-scale-r2-"));
  stateRoot = join(workDir, ".crosschat");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function coreWith(env: NodeJS.ProcessEnv = {}): ToolCore {
  return createToolCore({ stateRoot, workspace: workDir, env });
}

/** 注册辅助：模拟 SessionStart 钩子落盘 sessions/<sid>.json 后走 hook 路径。 */
async function hookRegister(core: ToolCore, conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

interface StatusPayload {
  tasks: Array<{ id: string; title: string }>;
  boardTruncated?: { shown: number; total: number; offset: number; budgetChars: number };
  leadHistory?: Array<Record<string, unknown>>;
  leadHistoryTruncated?: { shown: number; total: number; budgetChars: number };
  members?: Array<{ key: string; isLead?: boolean }>;
}

// ─────────────────────────── SCALE-1（#18，P1）：xc_status 板面接入注入预算 ───────────────────────────

describe("SCALE-1: xc_status 板面注入预算窗口（xc_status/history 接入 XC_CONTEXT_CHARS）", () => {
  async function dispatchTasks(core: ToolCore, count: number): Promise<void> {
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    for (let i = 0; i < count; i += 1) {
      const res = await core.xc_dispatch(
        { to: "b", title: `任务-${String(i).padStart(3, "0")}-${"t".repeat(40)}`, prompt: "p" },
        "conn-a",
      );
      expect(res.isError).toBeUndefined();
    }
  }

  it("小批次预算：板面只呈现窗口前缀、响应整体有界、boardTruncated 指针、snapshot.json 仍全量", async () => {
    const core = coreWith({ XC_INJECT_ITEM_CHARS: "1200", XC_INJECT_TOTAL_CHARS: "2500" });
    await dispatchTasks(core, 40);

    const res = await core.xc_status({}, "conn-a");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as unknown as StatusPayload;
    // 窗口前缀：保底一条；40 条装不下
    expect(payload.tasks.length).toBeGreaterThanOrEqual(1);
    expect(payload.tasks.length).toBeLessThan(40);
    expect(payload.boardTruncated).toEqual({
      shown: payload.tasks.length,
      total: 40,
      offset: 0,
      budgetChars: 2500,
    });
    // 响应整体有界：人可读表 + JSON payload 都算上（未修复时 40 任务 ≈ 数万字符）
    expect(textOf(res).length).toBeLessThan(6000);

    // 指针行：给出 xc_status({offset}) 续读
    expect(textOf(res)).toContain("xc_status({offset:");
    expect(textOf(res)).toContain(`本页 ${payload.tasks.length}/40`);

    // 磁盘真源：snapshot.json 落盘仍是全量（R-21）
    const snap = JSON.parse(await readFile(join(stateRoot, "teams", "default", "snapshot.json"), "utf8")) as {
      tasks: unknown[];
    };
    expect(snap.tasks).toHaveLength(40);

    // 分页可续读：offset=shown 起读后续任务，不重叠、可对账
    const seen = new Set(payload.tasks.map((t) => t.id));
    let offset = payload.tasks.length;
    for (let guard = 0; guard < 40 && seen.size < 40; guard += 1) {
      const page = payloadOf(await core.xc_status({ offset }, "conn-a")) as unknown as StatusPayload;
      expect(page.tasks.length).toBeGreaterThanOrEqual(1);
      for (const t of page.tasks) {
        expect(seen.has(t.id)).toBe(false);
        seen.add(t.id);
      }
      if (page.boardTruncated === undefined) break;
      offset = (page.boardTruncated.offset ?? 0) + page.tasks.length;
    }
    expect(seen.size).toBe(40);
    // 末页无截断字段
    const last = payloadOf(await core.xc_status({ offset: 40 }, "conn-a")) as unknown as StatusPayload;
    expect(last.tasks).toHaveLength(0);
    expect(last.boardTruncated).toBeUndefined();
  });

  it("声明预算改变输出（回归红队『XC_CONTEXT_CHARS=1000000 输出不变』）：context 4× 的页比 0.25× 大", async () => {
    const core = coreWith();
    await dispatchTasks(core, 40);

    // 0.25× 钳制（context 50k → total 4000）
    const small = payloadOf(
      await coreWith({ XC_CONTEXT_CHARS: "50000" }).xc_status({}, "conn-a"),
    ) as unknown as StatusPayload;
    // 4× 钳制（context 1M → total 64000）
    const big = payloadOf(
      await coreWith({ XC_CONTEXT_CHARS: "1000000" }).xc_status({}, "conn-a"),
    ) as unknown as StatusPayload;
    // 两页都受各自预算约束（此处 40×~350 字符 ≈ 14k，落在两者之间）
    expect(small.tasks.length).toBeLessThan(40);
    expect(small.boardTruncated).toBeDefined();
    expect(small.boardTruncated?.budgetChars).toBe(4000);
    expect(big.tasks.length).toBe(40);
    expect(big.boardTruncated).toBeUndefined();
    // 同一任务序：两页都是到达序前缀
    expect(small.tasks[0]?.id).toBe(big.tasks[0]?.id);
  });

  it("板面装得下时 payload 与 v0.5.1 形状一致（无 boardTruncated 字段，行为兼容）", async () => {
    const core = coreWith();
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    for (let i = 0; i < 3; i += 1) {
      await core.xc_dispatch({ to: "b", title: `t${i}`, prompt: "p" }, "conn-a");
    }
    const payload = payloadOf(await core.xc_status({}, "conn-a")) as unknown as StatusPayload;
    expect(payload.tasks).toHaveLength(3);
    expect(payload.boardTruncated).toBeUndefined();
    // v0.5.1 契约：任务行 result 截断（resultTruncated）在窗口内任务上仍然生效
    const st1 = payloadOf(await core.xc_status({ history: true }, "conn-a")) as unknown as StatusPayload & {
      leadHistory: unknown[];
    };
    expect(st1.leadHistory).toEqual([]);
    expect(st1.members?.find((m) => m.key === "a")?.isLead).toBe(true);
  });

  it("history:true 的 leadHistory 超预算被窗口化并带 leadHistoryTruncated（history 面也查预算）", async () => {
    // 注意：readTeam 的 coerceLeadHistory 把 leadHistory 钳到尾部 32 条（R-10，
    // 既有设计）——写入 40 条读回 32；item 预算 1000 → total = max(1500, 1000)
    // = 1500，固定面之外装不下 32×~112 字符 → history 面被窗口化。
    const core = coreWith({ XC_INJECT_ITEM_CHARS: "1000", XC_INJECT_TOTAL_CHARS: "1500" });
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    const team = (await readTeam(stateRoot, "default"))!;
    team.leadKey = "b";
    team.leadSince = 1;
    team.leadHistory = Array.from({ length: 40 }, (_, i) => ({
      event: "transfer", from: "a", to: "b", ts: 1000 + i,
      reason: `变更理由-${String(i).padStart(3, "0")}-${"r".repeat(30)}`,
    }));
    await writeTeam(stateRoot, team);

    const payload = payloadOf(await core.xc_status({ history: true }, "conn-a")) as unknown as StatusPayload;
    // 真源钳制：读回 32 条（R-10 尾部保留）
    expect(payload.leadHistory!.length).toBeGreaterThan(0);
    expect(payload.leadHistory!.length).toBeLessThan(40);
    // 窗口化：呈现条数 < 真源条数，且带截断标记（history 面查询了声明预算）
    expect(payload.leadHistory!.length).toBeLessThan(32);
    expect(payload.leadHistoryTruncated).toEqual({
      shown: payload.leadHistory!.length,
      total: 32,
      budgetChars: 1500,
    });
    // leadKey/leadSince 照常（v0.5.1 形状不丢）
    expect(payload.members?.find((m) => m.key === "b")?.isLead).toBe(true);
  });
});

// ─────────────────────────── SCALE-2（#19，P1）：peer 队列上限可配 + 丢弃可行动 ───────────────────────────

describe("SCALE-2: peer 入站队列上限（默认 1024、XC_PEER_MAX_QUEUE_DEPTH 可配）", () => {
  const base = {
    now: 1_000,
    sender: "alice",
    msgId: "m1",
    hopChain: ["alice"],
    selfSent: false,
    queueDepth: 0,
    buckets: createRateBuckets(),
  };

  it("默认上限提高到 1024：红队触发点（深度 ≥64）不再 queue-full", () => {
    // 旧默认 64：queueDepth=64 即丢（红队 10 发送方×10 条第 65 条起全丢）。
    expect(admitPeerMessage({ ...base, queueDepth: 64 }).ok).toBe(true);
    expect(admitPeerMessage({ ...base, queueDepth: 1023, msgId: "m2" }).ok).toBe(true);
    expect(admitPeerMessage({ ...base, queueDepth: 1024, msgId: "m3" })).toEqual({ ok: false, reason: "queue-full" });
    expect(PEER_MAX_QUEUE_DEPTH).toBe(1024);
  });

  it("XC_PEER_MAX_QUEUE_DEPTH 可配：合法值生效、0/负数/非数字/空白回落默认", () => {
    expect(peerMaxQueueDepthFromEnv({})).toBe(1024);
    expect(peerMaxQueueDepthFromEnv({ XC_PEER_MAX_QUEUE_DEPTH: "5" })).toBe(5);
    expect(peerMaxQueueDepthFromEnv({ XC_PEER_MAX_QUEUE_DEPTH: "2048" })).toBe(2048);
    for (const bad of ["0", "-1", "abc", "  "]) {
      expect(peerMaxQueueDepthFromEnv({ XC_PEER_MAX_QUEUE_DEPTH: bad })).toBe(1024);
    }
    // 配置值真实作用于入队闸（可配不是摆设）
    const buckets = createRateBuckets();
    expect(admitPeerMessage({ ...base, buckets, queueDepth: 5, maxQueueDepth: 5, msgId: "m10" }))
      .toEqual({ ok: false, reason: "queue-full" });
    expect(admitPeerMessage({ ...base, buckets, queueDepth: 5, maxQueueDepth: 6, msgId: "m11" }).ok).toBe(true);
  });

  it("queue-full 的丢弃 detail 带上限值与恢复动作（发方可行动，不再是裸原因码）", () => {
    const detail = admissionDropDetail("queue-full", 1024);
    expect(detail).toContain("1024");
    expect(detail).toContain("NOT delivered");
    expect(detail).toContain("xc_peer_inbox");
    const rate = admissionDropDetail("rate-limited", 1024);
    expect(rate).toContain(String(PEER_RATE_LIMIT));
    expect(rate).toContain("10s");
    expect(admissionDropDetail("duplicate", 1024)).toContain("duplicate");
    expect(admissionDropDetail("loop-depth", 1024)).toContain("loop-depth");
    expect(admissionDropDetail(undefined, 1024)).toBe("admission-gate");
  });
});

// ─────────────────────────── SCALE-4（#21，P2）：限速常量契约（README 文档化的数值） ───────────────────────────

describe("SCALE-4: 发送限速契约锁定（README 文档化 30 条/10s 窗口，常量漂移即红）", () => {
  it("PEER_RATE_LIMIT=30 / PEER_RATE_WINDOW_MS=10000（README 已知限制同步文档化的值）", () => {
    expect(PEER_RATE_LIMIT).toBe(30);
    expect(PEER_RATE_WINDOW_MS).toBe(10_000);
  });
});

// ─────────────────────────── SCALE-3（#20，P2）：xc_peer_inbox 窗口外保持未读 ───────────────────────────

describe("SCALE-3: xc_peer_inbox 批次窗口（窗口外消息留在队列 + 再拉指针，无占位符省略）", () => {
  let root: string;
  let workspace: string;
  let stateRoot2: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "xc-scale-r2-peers-"));
    workspace = mkdtempSync(join(tmpdir(), "xc-scale-r2-ws-"));
    stateRoot2 = join(workspace, ".crosschat");
    mkdirSync(stateRoot2, { recursive: true });
  });

  afterEach(async () => {
    await stopPeerEndpoint();
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  function item(msgId: string, text: string): Parameters<typeof appendPeerQueue>[2] {
    return { msgId, from: "bob", fromSessionId: "sess-bob", hopChain: ["bob"], text, ts: Date.now(), via: "pipe" };
  }

  it("20 条积压 + 小批次预算：只消费窗口内条目，其余留在队列；响应无『已省略』占位符；续拉对账 20/20", async () => {
    // 信封渲染开销 ≈1k 字符/条（页脚三段 + 回复指引），20 条需 ~20k——预算给 9600
    // 让窗口恰装下约一半，剩下的一半留在队列（红队 SC-10/SC-11 同款场景）。
    const services = createDefaultPeerServices({
      stateRoot: stateRoot2,
      workspace,
      env: { XC_MESSAGING_DIR: root, XC_INJECT_ITEM_CHARS: "3000", XC_INJECT_TOTAL_CHARS: "9600" } as NodeJS.ProcessEnv,
    });
    await services.register({ name: "alice", sessionId: "sess-alice" });
    // 红队同款积压：20 条 ×209 字符正文（信封渲染后每条 >1k 字符）
    for (let i = 0; i < 20; i += 1) {
      await appendPeerQueue(root, "sess-alice", item(`m-${String(i).padStart(2, "0")}`, `消息-${String(i).padStart(2, "0")}-${"x".repeat(180)}`));
    }

    const first = await services.inbox(50);
    // 窗口：保底一条，但装不下全部 20 条
    expect(first.items.length).toBeGreaterThanOrEqual(1);
    expect(first.items.length).toBeLessThan(20);
    // 窗口外保持未读（留在队列）：remaining + 磁盘双证
    expect(first.remaining).toBe(20 - first.items.length);
    const queued = await readPeerQueue(root, "sess-alice");
    expect(queued.map((entry) => entry.msgId)).toEqual(
      Array.from({ length: first.remaining }, (_, i) => `m-${String(first.items.length + i).padStart(2, "0")}`),
    );
    // 信封与条目一一对应，且不再有「已省略（超注入预算）」占位符（消费即省略的根因）
    expect(first.rendered).toHaveLength(first.items.length);
    expect(first.rendered.join("\n")).not.toContain("已省略");

    // 工具面续拉（同一预算口径）：反复拉取直到排空，对账 20/20 不重不漏；
    // remaining > 0 时摘要行给「再调一次」指针，排空后指针消失。
    const server: { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }> } = new (class {
      readonly tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }> = [];
      tool(name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<ToolResult>): void {
        this.tools.push({ name, handler });
      }
    })() as never;
    registerPeerTools(server as unknown as McpServer, {
      stateRoot: stateRoot2,
      workspace,
      env: { XC_MESSAGING_DIR: root, XC_INJECT_ITEM_CHARS: "3000", XC_INJECT_TOTAL_CHARS: "9600" } as NodeJS.ProcessEnv,
      peer: services,
    });
    const inboxTool = server.tools.find((tool) => tool.name === "xc_peer_inbox");
    expect(inboxTool).toBeDefined();
    const all = new Set(first.items.map((entry) => entry.msgId));
    // 信封正文含「消息-NN-…」（信封 tag 不带 msgId）；按正文序号对账。
    const idOf = (envelope: string): string[] =>
      [...envelope.matchAll(/消息-(\d{2})/g)].map((match) => `m-${match[1]}`);
    let pointerSeen = false;
    for (let guard = 0; guard < 20 && first.remaining > 0; guard += 1) {
      const res = await inboxTool!.handler({});
      const payload = payloadOf(res) as { count: number; envelopes: string[]; remaining: number };
      expect(payload.count).toBeGreaterThanOrEqual(1);
      expect(payload.count).toBe(payload.envelopes.length);
      expect(payload.envelopes.join("\n")).not.toContain("已省略");
      for (const envelope of payload.envelopes) {
        for (const id of idOf(envelope)) {
          expect(all.has(id)).toBe(false); // 不重复注入
          all.add(id);
        }
      }
      if (payload.remaining > 0) {
        pointerSeen = true;
        expect(String(res.content[0]?.text)).toContain("再调一次 xc_peer_inbox 继续拉取");
      } else {
        expect(String(res.content[0]?.text)).not.toContain("再调一次");
        break;
      }
    }
    expect(pointerSeen).toBe(true);
    expect(all.size).toBe(20);
  }, 20_000);

  it("单条超批次预算也保底消费一条（item 截断 + xc_peer_read 指针兜住单条上限）", async () => {
    // 红队场景等价：批次预算 600 < 单条成本 → 保底一条消费，截断只发生在注入层
    const services = createDefaultPeerServices({
      stateRoot: stateRoot2,
      workspace,
      env: { XC_MESSAGING_DIR: root, XC_INJECT_ITEM_CHARS: "800", XC_INJECT_TOTAL_CHARS: "600" } as NodeJS.ProcessEnv,
    });
    await services.register({ name: "alice2", sessionId: "sess-alice2" });
    const bigText = "B".repeat(5000);
    await appendPeerQueue(root, "sess-alice2", item("m-big", bigText));

    // 工具面全链路：预算传给服务面（窗口与排布同源），单条被 item 截断 + xc_peer_read 指针
    const server: { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }> } = new (class {
      readonly tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }> = [];
      tool(name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<ToolResult>): void {
        this.tools.push({ name, handler });
      }
    })() as never;
    registerPeerTools(server as unknown as McpServer, {
      stateRoot: stateRoot2,
      workspace,
      env: { XC_MESSAGING_DIR: root, XC_INJECT_ITEM_CHARS: "800", XC_INJECT_TOTAL_CHARS: "600" } as NodeJS.ProcessEnv,
      peer: services,
    });
    const inboxTool = server.tools.find((tool) => tool.name === "xc_peer_inbox");
    const res = await inboxTool!.handler({});
    const payload = payloadOf(res) as { count: number; envelopes: string[]; remaining: number; budgetTruncated?: boolean };
    expect(payload.count).toBe(1);
    expect(payload.remaining).toBe(0);
    expect(payload.envelopes[0]?.length).toBeLessThan(1200);
    expect(payload.envelopes.join("\n")).toContain("xc_peer_read");
    expect(payload.budgetTruncated).toBe(true);
    expect(payload.envelopes.join("\n")).not.toContain("已省略");
    // 服务面直证：队列已排空（消费真发生，不是「省略了事」）
    expect(await readPeerQueue(root, "sess-alice2")).toHaveLength(0);
  }, 20_000);
});

// v0.5.1 既有契约保持：validateSendModeArgs 不受本轮改动影响（冒烟，防接线回归）
describe("本轮改动的接线冒烟", () => {
  it("xc_peer_inbox handler 把预算传给服务面（窗口与排布同源）", async () => {
    let receivedBudget: unknown;
    const server: { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }> } = new (class {
      readonly tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }> = [];
      tool(name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<ToolResult>): void {
        this.tools.push({ name, handler });
      }
    })() as never;
    registerPeerTools(server as unknown as McpServer, {
      stateRoot: "<stateRoot>",
      workspace: "<workspace>",
      env: { XC_INJECT_TOTAL_CHARS: "7777" } as NodeJS.ProcessEnv,
      peer: {
        register: async () => { throw new Error("unused"); },
        list: async () => [],
        send: async () => { throw new Error("unused"); },
        read: async () => { throw new Error("unused"); },
        inbox: async (_limit, budget) => {
          receivedBudget = budget;
          return { items: [], rendered: [], remaining: 0 };
        },
        review: async () => { throw new Error("unused"); },
        rename: async () => { throw new Error("unused"); },
        agents: async () => { throw new Error("unused"); },
      },
    });
    const inboxTool = server.tools.find((tool) => tool.name === "xc_peer_inbox");
    expect(inboxTool).toBeDefined();
    const res = await inboxTool!.handler({});
    expect(res.isError).toBeUndefined();
    expect(receivedBudget).toMatchObject({ total: 7777 });
  });

  it("xc_peers handler 小清单行为不变（count=rows、无 rowsTruncated 字段）", async () => {
    const server: { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }> } = new (class {
      readonly tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }> = [];
      tool(name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<ToolResult>): void {
        this.tools.push({ name, handler });
      }
    })() as never;
    registerPeerTools(server as unknown as McpServer, {
      stateRoot: "<stateRoot>",
      workspace: "<workspace>",
      env: {} as NodeJS.ProcessEnv,
      peer: {
        register: async () => { throw new Error("unused"); },
        list: async () => [{
          name: "bob", kind: "session" as const, identity: "bob@x", ref: "b1c2d3e4",
          sessionId: "sess-bob", pid: 1, cwd: "D:\\ws-b", status: "idle", lastSeenMs: 1,
        }],
        send: async () => { throw new Error("unused"); },
        read: async () => { throw new Error("unused"); },
        inbox: async () => ({ items: [], rendered: [], remaining: 0 }),
        review: async () => { throw new Error("unused"); },
        rename: async () => { throw new Error("unused"); },
        agents: async () => { throw new Error("unused"); },
      },
    });
    const peersTool = server.tools.find((tool) => tool.name === "xc_peers");
    const res = await peersTool!.handler({});
    const payload = payloadOf(res) as { count: number; total?: number; rowsTruncated?: unknown };
    expect(payload.count).toBe(1);
    expect(payload.total).toBe(1);
    expect(payload.rowsTruncated).toBeUndefined();
    expect(String(res.content[0]?.text)).toContain("bob [session]");
  });
});
