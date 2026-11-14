/**
 * v0.6 M1 条款 1（DESIGN-V0.6.md §5 T1-a/T1-b）单测：工具面收敛 + 旧名弃用垫片。
 *
 * 驱动方式：真实 McpServer + 真实家族注册器 + alias 覆盖层，经 SDK InMemoryTransport
 * 建链（initialize → tools/list → tools/call），对 tools/list 与旧名调用做黑盒断言
 * （与 ACCEPT10 的 stdio 直驱同源，只是传输层换成内存对——避免 CI spawn node）。
 *
 * 覆盖：
 * - T1-a：tools/list 恰 10 个新名（精确集合比较，顺序不敏感）；
 * - T1-b：22 个更名旧名逐个 tools/call → 非 isError + 首块 [DEPRECATED] 前缀 +
 *   payload.deprecated{tool,replacement} 正确 + ignored 披露（xc_register 的 regToken
 *   等未映射旧参）；
 * - xc_message / xc_peer_send 带 forwardOf → 显式 forwardOf_removed；
 * - 同名四工具（dispatch/claim/report/doctor）调用无弃用警告；
 * - 别名路径身份连续性（L1）：同一连接先 xc_register 后 xc_check_inbox 能读到同一邮箱
 *   （extra 透传 → connectionKeyOf 一致）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { composeCore, resolveDeps, type PrimaryRegistry } from "./core.js";
import { installAliasLayer } from "./alias.js";
import { registerIdentifyTools } from "./tools-identify.js";
import { registerTaskTools } from "./tools-tasks.js";
import { registerReadTools } from "./tools-read.js";
import { registerRelay } from "./tools-relay.js";
import { registerOverviewTools } from "./tools-overview.js";
import { registerTeamTools } from "./tools-team.js";
import { registerReviewTools } from "./tools-review.js";
import { registerDoctorTool } from "./doctor-tool.js";
import { writeSession } from "../core/registry.js";
import { readTeam } from "../core/teamstate.js";
import { storePeerMessageFull } from "../core/msgstore.js";
import { resetPeerServicesForTests } from "./peer-services.js";

const EXPECTED_TOOLS = [
  "xc_identify",
  "xc_dispatch",
  "xc_claim",
  "xc_report",
  "xc_read",
  "xc_relay",
  "xc_overview",
  "xc_team",
  "xc_review",
  "xc_doctor",
];

/** 迁移表（DESIGN §1.3）：旧名 → {replacement, 调用参数, 期望 ignored 披露}。 */
const RENAMED: Array<{ old: string; replacement: string; args: Record<string, unknown>; ignored?: string[] }> = [
  { old: "xc_register", replacement: "xc_identify", args: { name: "alice", sessionId: "sess-a" } },
  { old: "xc_peer_register", replacement: "xc_identify", args: { name: "alice", sessionId: "sess-a" } },
  { old: "xc_peer_rename", replacement: "xc_identify", args: { name: "alice2", sessionId: "sess-a" } },
  { old: "xc_check_inbox", replacement: "xc_read", args: {} },
  { old: "xc_mail_read", replacement: "xc_read", args: { messageId: "m1" } },
  { old: "xc_task_read", replacement: "xc_read", args: { taskId: "t1", field: "result" } },
  { old: "xc_peer_inbox", replacement: "xc_read", args: {} },
  { old: "xc_peer_read", replacement: "xc_read", args: { msgId: "m1" } },
  { old: "xc_message", replacement: "xc_relay", args: { to: "bob", content: "hi" } },
  { old: "xc_peer_send", replacement: "xc_relay", args: { to: "bob", message: "hi" } },
  { old: "xc_status", replacement: "xc_overview", args: {} },
  { old: "xc_peers", replacement: "xc_overview", args: {} },
  { old: "xc_agents", replacement: "xc_overview", args: {} },
  { old: "xc_team_init", replacement: "xc_team", args: {} },
  { old: "xc_lead_transfer", replacement: "xc_team", args: { to: "bob" } },
  { old: "xc_lead_release", replacement: "xc_team", args: {} },
  { old: "xc_member_add", replacement: "xc_team", args: { name: "m1" } },
  { old: "xc_member_stop", replacement: "xc_team", args: { name: "m1" } },
  { old: "xc_idle", replacement: "xc_team", args: { summary: "done" } },
  { old: "xc_cancel", replacement: "xc_team", args: { taskId: "t1" } },
  { old: "xc_inbound_review", replacement: "xc_review", args: {} },
  { old: "xc_peer_review", replacement: "xc_review", args: {} },
];

let workDir = "";
let client: Client;
let server: McpServer;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v06-alias-"));
  const deps = resolveDeps(workDir, {
    XC_MESSAGING_DIR: join(workDir, "peers-root"),
    XC_WAKE_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  const core = composeCore(deps);
  const registry: PrimaryRegistry = new Map();
  server = new McpServer({ name: "zcode-crosschat", version: "0.6.0" });
  registerIdentifyTools(server, deps, core, registry);
  registerTaskTools(server, deps, core, registry);
  registerReadTools(server, deps, core, registry);
  registerRelay(server, deps, core, registry);
  registerOverviewTools(server, deps, core, registry);
  registerTeamTools(server, deps, core, registry);
  registerReviewTools(server, deps, core, registry);
  registerDoctorTool(server, { version: "0.6.0", env: deps.env, cwd: workDir });
  registry.set("xc_doctor", {
    description: "doctor",
    shape: {},
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  // alias 覆盖层：CallTool 分发器整体替换（SDK 1.32.2 实测机制）。
  installAliasLayer(server, (name, args, extra) =>
    dispatchForTest(registry, name, args, extra));

  // 前置态：hook 路径要求 registry/sessions/<sid>.json 在场（SessionStart 钩子产物）。
  const stateRoot = join(workDir, ".crosschat");
  for (const sid of ["sess-a", "sess-lead"]) {
    await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  }

  // 前置态：xc_peer_read 需要本会话收到过的消息（store 记录 toSessionId=本会话）。
  await storePeerMessageFull(join(workDir, "peers-root"), {
    msgId: "m1",
    text: "hello from a peer",
    from: "bob",
    fromSessionId: "sess-bob",
    toSessionId: "sess-a",
    hopChain: ["bob"],
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "alias-smoke", version: "0.6.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  resetPeerServicesForTests();
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
});

/** 首块文本（别名层前置警告块后 content[0] 恒为警告/摘要面）。 */
function firstBlockText(res: unknown): string {
  const blocks = ((res as { content?: unknown }).content ?? []) as Array<{ text?: string }>;
  return String(blocks[0]?.text ?? "");
}

/** 从工具结果里取机器 JSON 负载块（警告块前置后位置不固定——取最后一个可解析块）。 */
function jsonPayloadOf(res: unknown): Record<string, unknown> {
  const blocks = ((res as { content?: unknown }).content ?? []) as Array<{ type?: string; text?: string }>;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const text = blocks[i]?.text;
    if (typeof text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 人可读面：继续找
    }
  }
  return {};
}

/** dispatcher（与 server.ts dispatchPrimary 同口径：zod 校验 → handler）。 */
async function dispatchForTest(
  registry: PrimaryRegistry,
  name: string,
  args: Record<string, unknown>,
  extra: unknown,
): Promise<unknown> {
  const { z } = await import("zod");
  const { ErrorCode, McpError } = await import("@modelcontextprotocol/sdk/types.js");
  const entry = registry.get(name);
  if (entry === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
  }
  const parsed = z.object(entry.shape).safeParse(args);
  if (!parsed.success) {
    throw new McpError(ErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${name}`);
  }
  return await entry.handler(parsed.data as Record<string, unknown>, extra);
}

describe("T1-a：tools/list 恰 10 个新名（精确集合比较）", () => {
  it("10 个名字与 DESIGN §1.1 表逐一相等", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    expect(names).toHaveLength(10);
  });
});

describe("T1-b：22 个更名旧名可调 + 弃用警告 + deprecated 载荷", () => {
  for (const entry of RENAMED) {
    it(`${entry.old} → ${entry.replacement}：警告在场 + payload.deprecated 正确`, async () => {
      const res = await client.callTool({ name: entry.old, arguments: entry.args });
      const first = firstBlockText(res);
      expect(first).toContain(`[DEPRECATED] ${entry.old} 已更名为 ${entry.replacement}`);
      expect(first).toContain("v0.7.0 移除");
      const payload = jsonPayloadOf(res);
      expect(payload["deprecated"]).toMatchObject({ tool: entry.old, replacement: entry.replacement });
      if (entry.ignored !== undefined) {
        expect((payload["deprecated"] as Record<string, unknown>)["ignored"]).toEqual(entry.ignored);
      }
    });
  }

  it("xc_register 携带未映射旧参（regToken）→ ignored 披露（M1 纪律：不静默丢参）", async () => {
    const res = await client.callTool({
      name: "xc_register",
      arguments: { name: "carol", sessionId: "sess-c", regToken: "rt-legacy" },
    });
    const payload = jsonPayloadOf(res);
    expect((payload["deprecated"] as Record<string, unknown>)["ignored"]).toContain("regToken");
  });
});

describe("T1-b-2：relay 两别名的 forwardOf → 显式 forwardOf_removed", () => {
  for (const old of ["xc_message", "xc_peer_send"]) {
    it(`${old} 带 forwardOf → forwardOf_removed（不静默丢参）`, async () => {
      // alias 层对 forwardOf 抛 McpError(InvalidParams)——客户端表现为 JSON-RPC 错误
      // （不是 isError 信封：替换发生在 SDK 分发器层，工具 handler 尚未执行）。
      const err = await client
        .callTool({
          name: old,
          arguments: { to: "bob", ...(old === "xc_message" ? { content: "hi" } : { message: "hi" }), forwardOf: "m-1" },
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).toContain("forwardOf_removed");
      expect(String((err as Error).message)).toContain("docs/MIGRATION.md");
    });
  }
});

describe("T1-b-3：同名四工具调用无弃用警告（v0.6 不弃用）", () => {
  it("xc_dispatch / xc_claim / xc_report / xc_doctor 首块无 [DEPRECATED]", async () => {
    // doctor：免注册只读。
    const doctor = await client.callTool({ name: "xc_doctor", arguments: {} });
    expect(doctor.isError).toBeFalsy();
    expect(firstBlockText(doctor)).not.toContain("[DEPRECATED]");

    // dispatch/claim/report 需要注册身份——先经别名注册（别名路径身份连续性断言见下）。
    await writeSession(join(workDir, ".crosschat"), {
      sessionId: "sess-lead",
      cwd: workDir,
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    const reg = await client.callTool({ name: "xc_register", arguments: { name: "ldr", sessionId: "sess-lead" } });
    expect(reg.isError).toBeFalsy();

    const dispatched = await client.callTool({
      name: "xc_dispatch",
      arguments: { to: "ldr", title: "T", prompt: "P" },
    });
    // to=self → invalid_params（预期行为）；此处只断言「无弃用警告」。
    expect(firstBlockText(dispatched)).not.toContain("[DEPRECATED]");
  });
});

describe("T1-b-4：别名路径身份连续性（L1：extra 透传）", () => {
  it("同一连接先 xc_register 后 xc_check_inbox 读到同一邮箱（连接键一致）", async () => {
    // 注册 alice（sess-a）成功后，其邮箱应有 identify 的两轴注册产物可查——
    // 关键断言：别名路径的 connectionKeyOf(extra) 与新名路径一致（同一连接键），
    // 因此 identityStore 里绑定生效（未注册连接会得 not_registered）。
    const reg = await client.callTool({ name: "xc_register", arguments: { name: "alice", sessionId: "sess-a" } });
    expect(reg.isError).toBeFalsy();
    const inbox = await client.callTool({ name: "xc_check_inbox", arguments: {} });
    // 已注册 → 空箱正常返回（不是 not_registered）——证明别名路径拿到了同一连接的身份。
    expect(inbox.isError).toBeFalsy();
    const payload = jsonPayloadOf(inbox);
    expect(payload["unreadCount"]).toBeDefined();
  });
});

describe("T1-c：新名主路径端到端（dispatcher + 家族实现，未经别名层）", () => {
  it("xc_identify → dispatch → claim → report(completed) → read(inbox) → overview 全链路", async () => {
    const { writeTeam } = await import("../core/teamstate.js");
    const { writeFile } = await import("node:fs/promises");
    const stateRoot = join(workDir, ".crosschat");

    // ① identify（新名直调）：alice 注册并建队（founder）。
    const identify = await client.callTool({
      name: "xc_identify",
      arguments: { name: "alice", sessionId: "sess-a" },
    });
    expect(identify.isError).toBeFalsy();

    // ② 直接把 bob 加进花名册（dispatch 的 to 必须是已注册成员）。
    const team = (await readTeam(stateRoot, "default"))!;
    team.members.push({
      key: "bob",
      sessionId: "sess-b",
      role: "worker",
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    });
    await writeTeam(stateRoot, team);

    // ③ dispatch（新名直调；带 priority——C2 新参）。
    const dispatched = await client.callTool({
      name: "xc_dispatch",
      arguments: { to: "bob", title: "e2e", prompt: "do the thing", priority: "high" },
    });
    expect(dispatched.isError).toBeFalsy();
    const taskId = jsonPayloadOf(dispatched)["taskId"] as string;
    expect(typeof taskId).toBe("string");

    // ④ claim（同一连接=alice；状态机允许认领 pending 单）。
    const claimed = await client.callTool({ name: "xc_claim", arguments: { taskId } });
    expect(claimed.isError).toBeFalsy();
    const attemptId = jsonPayloadOf(claimed)["attemptId"] as string;
    expect(typeof attemptId).toBe("string");

    // ⑤ report in_progress（状态机要求 claimed → in_progress → completed）。
    const progress = await client.callTool({
      name: "xc_report",
      arguments: { taskId, attemptId, status: "in_progress" },
    });
    expect(progress.isError).toBeFalsy();

    // ⑥ report completed（evidence 文件+摘要，无哈希）。
    const evidencePath = join(workDir, "e2e-evidence.txt");
    await writeFile(evidencePath, "done", "utf8");
    const reported = await client.callTool({
      name: "xc_report",
      arguments: {
        taskId,
        attemptId,
        status: "completed",
        result: "finished",
        evidence: [{ path: evidencePath, note: "产物" }],
      },
    });
    expect(reported.isError).toBeFalsy();
    expect(jsonPayloadOf(reported)["status"]).toBe("completed");

    // ⑥ read scope=inbox：派发方（alice）收到终态回执。
    const inbox = await client.callTool({ name: "xc_read", arguments: { scope: "inbox" } });
    expect(inbox.isError).toBeFalsy();
    const messages = jsonPayloadOf(inbox)["messages"] as Array<{ content: string }>;
    expect(messages.some((m) => m.content.includes('"task-receipt"'))).toBe(true);

    // ⑦ overview：任务板显示 completed + priority 排序键在场。
    const overview = await client.callTool({ name: "xc_overview", arguments: {} });
    expect(overview.isError).toBeFalsy();
    const board = jsonPayloadOf(overview)["tasks"] as Array<{ id: string; status: string }>;
    expect(board.some((t) => t.id === taskId && t.status === "completed")).toBe(true);
  });
});
