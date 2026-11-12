/**
 * W5 单测：withGuards（removed 成员硬拒 + chat 入站策略）+ xc_inbound_review
 * （DESIGN-V0.2.md §7.4-I4/I5、§7.3.3；错误码 member_removed / inbound_refused）。
 *
 * 策略只在 chat 入口（xc_message）裁决；协议帧与 v0.1.0 错误路径（自发消息、
 * source 不成对）原样透传内层。accept 模式下全部行为与 v0.1.0 等价（回归红线）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolCore, type ToolCore, type ToolDeps } from "./tools.js";
import { InboundReviewShape, FRAME_TYPES, registerSecurityTools, withGuards } from "./guards.js";
import { payloadOf, type ToolResult } from "./protocol.js";
import { heldInboxFile, policyFile, writeInboundPolicy } from "../core/policy.js";
import { writeSession } from "../core/registry.js";
import { FRAME_TYPES as CORE_FRAME_TYPES } from "../core/mailbox.js";

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;
let guarded: ToolCore;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-guards-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: {} };
  guarded = withGuards(createToolCore(deps), deps);
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let connSeq = 0;
function nextConn(): string {
  connSeq += 1;
  return `conn-${connSeq}`;
}

/** 注册两个成员（经守卫层——register 在 withGuards 中原样透传；hook 路径先落 session 锚）。 */
async function registerTeam(): Promise<{ connA: string; connB: string }> {
  const connA = nextConn();
  const connB = nextConn();
  const sidA = `sess-a-${connSeq}`;
  const sidB = `sess-b-${connSeq}`;
  const now = Date.now();
  await writeSession(stateRoot, { sessionId: sidA, cwd: workDir, startedAt: now, lastSeen: now });
  await writeSession(stateRoot, { sessionId: sidB, cwd: workDir, startedAt: now, lastSeen: now });
  const ra = await guarded.xc_register({ name: "a", sessionId: sidA }, connA);
  expect(ra.isError).toBeFalsy();
  const rb = await guarded.xc_register({ name: "b", sessionId: sidB }, connB);
  expect(rb.isError).toBeFalsy();
  return { connA, connB };
}

/** 直接改盘上的 team.json（W2 coerce 已保留可选 state 字段，readTeam 可见）。 */
async function setMemberState(key: string, state: "removed" | "provisioning" | "ready"): Promise<void> {
  const file = join(stateRoot, "teams", "default", "team.json");
  const team = JSON.parse(readFileSync(file, "utf8")) as {
    members: Array<{ key: string; state?: string }>;
  };
  const member = team.members.find((m) => m.key === key);
  if (!member) throw new Error(`member ${key} not in roster`);
  member.state = state;
  writeFileSync(file, JSON.stringify(team, null, 2), "utf8");
}

function mainInboxLines(key: string): string[] {
  const file = join(stateRoot, "teams", "default", "inbox", `${key}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
}

function engineLog(): string {
  const file = join(stateRoot, "logs", "engine.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

type SecurityHandler = (args: unknown, extra: unknown) => Promise<ToolResult>;

/** 捕获 registerSecurityTools 注册的 handler，直接驱动（绕开 SDK server 类型面）。 */
function captureSecurityHandler(): SecurityHandler {
  const handlers: SecurityHandler[] = [];
  const server = {
    tool: (_name: string, _desc: string, _shape: unknown, handler: SecurityHandler) => {
      handlers.push(handler);
    },
  } as unknown as McpServer;
  registerSecurityTools(server, deps);
  return handlers[handlers.length - 1]!;
}

async function securityCall(
  connectionKey: string,
  args: { action?: "list" | "accept" | "discard"; ids?: string[] },
): Promise<Record<string, unknown>> {
  const handler = captureSecurityHandler();
  return payloadOf(await handler(args, { sessionId: connectionKey }));
}

describe("withGuards: accept 模式（默认）= v0.1.0 行为不变（回归红线）", () => {
  it("chat 端到端入箱 + delivered=mailbox（wake 未启用）", async () => {
    const { connA } = await registerTeam();
    const res = await guarded.xc_message({ to: "b", content: "hello teammate" }, connA);
    expect(res.isError).toBeFalsy();
    expect(payloadOf(res)["delivered"]).toBe("mailbox");
    expect(mainInboxLines("b")).toHaveLength(1);
  });

  it("xc_status 豁免守卫（未注册也可观测，§2.8）", async () => {
    const { connA } = await registerTeam();
    const res = await guarded.xc_status({}, connA);
    expect(res.isError).toBeFalsy();
  });
});

describe("withGuards: removed 成员硬拒（§7.3.3，错误码 member_removed）", () => {
  it("身份类工具全部硬拒；audit 记 member-removed-gate；其他成员不受影响", async () => {
    const { connA, connB } = await registerTeam();
    await setMemberState("b", "removed");

    for (const call of [
      () => guarded.xc_check_inbox({}, connB),
      () => guarded.xc_claim({ taskId: "t1" }, connB),
      () => guarded.xc_report({ taskId: "t1", attemptId: "x", status: "failed", error: "stopped" }, connB),
      () => guarded.xc_message({ to: "a", content: "am I still here?" }, connB),
    ]) {
      const res = await call();
      expect(res.isError).toBe(true);
      expect(payloadOf(res)["error"]).toBe("member_removed");
    }
    expect(engineLog()).toContain('"member-removed-gate"');

    // a 未被移除：派发仍可走通（建任务 + 入箱；wake 关闭 → mailbox）。
    const res = await guarded.xc_dispatch({ to: "b", title: "t", prompt: "p" }, connA);
    expect(res.isError).toBeFalsy();
    // v0.5.1（故障注-5 修复）：新时代任务 id 带纪元前缀（`<era>-t1`）。
    expect(payloadOf(res)["taskId"]).toMatch(/-t1$/);
  });
});

describe("withGuards: hold 策略（§7.4-I4）", () => {
  it("chat 进 .held.jsonl，主邮箱为空（钩子/唤醒不可见），review accept 后转主邮箱", async () => {
    const { connA, connB } = await registerTeam();
    await writeInboundPolicy(stateRoot, "default", "hold");

    const res = await guarded.xc_message({ to: "b", content: "quarantine me" }, connA);
    expect(res.isError).toBeFalsy();
    expect(payloadOf(res)["delivered"]).toBe("held");
    expect(mainInboxLines("b")).toHaveLength(0); // 主邮箱为零
    expect(readFileSync(heldInboxFile(stateRoot, "default", "b"), "utf8")).toContain("quarantine me");

    // 收件人查箱：held 不可见。
    const inbox = await guarded.xc_check_inbox({}, connB);
    expect(payloadOf(inbox)["messages"]).toHaveLength(0);

    // xc_inbound_review：list → 1；accept → 主邮箱 1 行、held 清空。
    const list = await securityCall(connB, { action: "list" });
    expect(list["count"]).toBe(1);
    const heldId = (list["messages"] as Array<{ id: string }>)[0]!.id;
    const accept = await securityCall(connB, { action: "accept", ids: [heldId] });
    expect(accept["count"]).toBe(1);
    expect(mainInboxLines("b")).toHaveLength(1);
    expect(existsSync(heldInboxFile(stateRoot, "default", "b"))).toBe(false);
    expect(engineLog()).toContain('"inbound-held"');
    expect(engineLog()).toContain('"inbound-review"');

    // 转正后 isCurrentMail 正常裁决，check_inbox 可消费。
    const inbox2 = await guarded.xc_check_inbox({}, connB);
    expect(payloadOf(inbox2)["messages"]).toHaveLength(1);
  });

  it("review discard：直接丢弃不投递", async () => {
    const { connA, connB } = await registerTeam();
    await writeInboundPolicy(stateRoot, "default", "hold");
    await guarded.xc_message({ to: "b", content: "junk" }, connA);
    const discard = await securityCall(connB, { action: "discard" });
    expect(discard["count"]).toBe(1);
    expect(mainInboxLines("b")).toHaveLength(0);
    expect(existsSync(heldInboxFile(stateRoot, "default", "b"))).toBe(false);
  });

  it("source 字段成对时随 held 消息透传；不成对仍走内层 invalid_params（v0.1.0 口径）", async () => {
    const { connA, connB } = await registerTeam();
    const dispatched = payloadOf(await guarded.xc_dispatch({ to: "b", title: "t", prompt: "p" }, connA));
    const taskId = dispatched["taskId"] as string;
    const claimed = payloadOf(await guarded.xc_claim({ taskId }, connB));
    const attemptId = claimed["attemptId"] as string;
    await writeInboundPolicy(stateRoot, "default", "hold");

    const held = await guarded.xc_message(
      { to: "a", content: "progress note", sourceTaskId: taskId, sourceAttemptId: attemptId },
      connB,
    );
    expect(payloadOf(held)["delivered"]).toBe("held");
    const heldRaw = JSON.parse(readFileSync(heldInboxFile(stateRoot, "default", "a"), "utf8")) as {
      sourceTaskId?: string;
      sourceAttemptId?: string;
    };
    expect(heldRaw.sourceTaskId).toBe(taskId);
    expect(heldRaw.sourceAttemptId).toBe(attemptId);

    const unpaired = await guarded.xc_message({ to: "a", content: "x", sourceTaskId: taskId }, connB);
    expect(unpaired.isError).toBe(true);
    expect(payloadOf(unpaired)["error"]).toBe("invalid_params");
  });
});

describe("withGuards: refuse 策略（§7.4-I4，错误码 inbound_refused）", () => {
  it("不入目标邮箱；发送者收 delivery-refused 白名单帧回执 + 审计", async () => {
    const { connA } = await registerTeam();
    await writeInboundPolicy(stateRoot, "default", "refuse");

    const res = await guarded.xc_message({ to: "b", content: "will be refused" }, connA);
    expect(res.isError).toBe(true);
    const payload = payloadOf(res);
    expect(payload["error"]).toBe("inbound_refused");
    expect(payload["to"]).toBe("b");
    expect(mainInboxLines("b")).toHaveLength(0);

    const senderMail = mainInboxLines("a");
    expect(senderMail).toHaveLength(1);
    const line = JSON.parse(senderMail[0]!) as { content: string };
    const frame = JSON.parse(line.content) as { type: string; to: string };
    expect(frame.type).toBe("delivery-refused"); // 白名单帧（读取侧放行）
    expect(frame.to).toBe("b");
    expect(engineLog()).toContain('"inbound-refused"');
  });

  it("自发消息保持 v0.1.0 invalid_params，不被策略改写", async () => {
    const { connA } = await registerTeam();
    await writeInboundPolicy(stateRoot, "default", "refuse");
    const res = await guarded.xc_message({ to: "a", content: "self" }, connA);
    expect(res.isError).toBe(true);
    expect(payloadOf(res)["error"]).toBe("invalid_params");
  });
});

describe("入站策略解析（policy.json > env > default，fail-open）", () => {
  it("policy.json 损坏 → 审计 policy-invalid 并回落（env 无值 → accept）", async () => {
    const { connA } = await registerTeam();
    writeFileSync(policyFile(stateRoot, "default"), "{not json", "utf8");
    const res = await guarded.xc_message({ to: "b", content: "still delivered" }, connA);
    expect(res.isError).toBeFalsy();
    expect(payloadOf(res)["delivered"]).toBe("mailbox");
    expect(engineLog()).toContain('"policy-invalid"');
  });

  it("无 policy.json 时 env XC_INBOUND_MODE 生效（hold）", async () => {
    deps = { stateRoot, workspace: workDir, env: { XC_INBOUND_MODE: "hold" } };
    guarded = withGuards(createToolCore(deps), deps);
    const connA = nextConn();
    const connB = nextConn();
    const sidA = `sess-env-${connSeq}`;
    const sidB = `sess-env2-${connSeq}`;
    const now = Date.now();
    await writeSession(stateRoot, { sessionId: sidA, cwd: workDir, startedAt: now, lastSeen: now });
    await writeSession(stateRoot, { sessionId: sidB, cwd: workDir, startedAt: now, lastSeen: now });
    await guarded.xc_register({ name: "a", sessionId: sidA }, connA);
    await guarded.xc_register({ name: "b", sessionId: sidB }, connB);

    const held = await guarded.xc_message({ to: "b", content: "env hold" }, connA);
    expect(payloadOf(held)["delivered"]).toBe("held");
    void connB;
  });
});

describe("xc_inbound_review（registerSecurityTools / §9.2 契约）", () => {
  it("工具形状存在且 action 枚举 list/accept/discard；FRAME_TYPES 转出与 core 同一常量", () => {
    expect(Object.keys(InboundReviewShape)).toEqual(["action", "ids"]);
    expect(FRAME_TYPES).toBe(CORE_FRAME_TYPES); // 单一定义点（core/mailbox.ts）
    expect(FRAME_TYPES).toContain("unblock-notice");
    expect(FRAME_TYPES).toContain("shutdown-request");
    expect(FRAME_TYPES).not.toContain("plan-approval"); // v0.3 backlog 帧不入白名单
  });

  it("未注册连接 → not_registered", async () => {
    const handler = captureSecurityHandler();
    const res = await handler({}, { sessionId: undefined });
    expect(res.isError).toBe(true);
    expect(payloadOf(res)["error"]).toBe("not_registered");
  });
});
