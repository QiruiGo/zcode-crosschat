/**
 * v0.7.1 红队四番战「故障注入」组（故障注-1/3/4）防回归单测。
 *
 * 逐项对应裁决报告 evidence/adversarial/adjudication.md 的 confirmed 项：
 *
 * - **故障注-1（P2）**：lead 的 MCP server 中途死亡 → 成员永久卡 provisioning
 *   （超时绑在存活 watcher 上、无回执、无审计、占名额；红队 fi1）。修复三段：
 *   ① Phase 1 把 `provisionDeadlineAt` 随 provisioning 记录落盘；
 *   ② 锁内清扫（sweepStaleProvisioningLocked）：过期 → failed + error（释放名额）；
 *   ③ 回执/审计：engine.jsonl `member-provision-timeout`；同名重试干净接管并在
 *      成功载荷披露 `recovered:"provision-timeout"`。钩子面（UserPromptSubmit）
 *      清扫由 hooks/shared.ts 的 sweepStaleProvisioning 承担（本文件直测）。
 *
 * - **故障注-3（P2）**：peer 大消息 messages/<msgId>.json 损坏 → xc_read
 *   peer-msg 返回误导性 unknown msgId（恢复路径阻断；红队 fi3）。修复：查找落空
 *   先分辨「从没收到」与「存储损坏」（storedMessageCorruptFile）→ 显式
 *   `message_corrupt`（带文件路径 + 恢复动作）+ peer 审计；消息未消费时 queue
 *   兜底仍可读回原文（恢复路径不阻断）。
 *
 * - **故障注-4（P3）**：peer 队列坏行被静默跳过且不计数（队内 inbox 有
 *   malformedLines、held 有 corrupted，三方不一致；红队 fi4）。修复：坏行计数经
 *   drainPeerQueueDetailed → PeerServices.inbox → xc_read peer scope 披露
 *   （`malformedLines`，与 inbox 同口径）+ peer 审计 `peer-queue-malformed`。
 *
 * provisionMember 以 mock 替身注入（零真实会话；同 member-cap-flow.test.ts 纪律）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createMemberToolCore } from "./tools-team.js";
import { identityStore } from "./identity.js";
import { writeSession } from "../core/registry.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import type { TeamMember, TeamState } from "../core/types.js";
import type { ToolDeps } from "./core.js";
import { engineLogFile } from "../core/paths.js";
import { writePeerBaseRecord, peerQueueFile, peerAuditLogFile } from "../core/peerdir.js";
import { stopPeerEndpoint } from "../transport/pipe.js";
import {
  createDefaultPeerServices,
  resetPeerServicesForTests,
  setPeerServicesForTests,
  type PeerServices,
} from "./peer-services.js";
import { registerReadTools } from "./tools-read.js";
import { createToolCore } from "./core.js";
import { sweepStaleProvisioning } from "../hooks/shared.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// provisionMember 替身：默认供给成功；provisionProbe 在供给过程中被调用（供测试
// 观测供给中的 roster 落盘态）。mock 路径必须与 tools-team.ts 的导入说明符一致
// （../engine/provision.js），否则替身不生效、测试会拉起真实 app-server。
const provisionProbe = vi.fn<() => Promise<void>>();
vi.mock("../engine/provision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/provision.js")>();
  return {
    ...actual,
    provisionMember: vi.fn(async (_deps: ToolDeps, spec: { key: string }) => {
      await provisionProbe();
      if (spec.key === "m-fail") {
        throw new actual.ProvisionError("spawn", "mocked spawn failure (fi1 fixture)");
      }
      return {
        sessionId: `sess_${spec.key}`,
        providerId: "prov-test",
        modelId: "glm-test",
        reasoningLevel: "max",
        welcomeResponse: "welcome (mock)",
        reprovisioned: false,
      };
    }),
  };
});

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-fi4v071-"));
  stateRoot = join(workDir, ".crosschat");
  provisionProbe.mockReset();
  provisionProbe.mockResolvedValue(undefined);
  resetPeerServicesForTests();
});
afterEach(async () => {
  await stopPeerEndpoint();
  await rm(workDir, { recursive: true, force: true });
});

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function teamWith(members: TeamMember[]): TeamState {
  return {
    teamId: "default",
    name: "default",
    founderKey: "ldr1",
    leadKey: "ldr1",
    phase: "open",
    members,
    tasks: [],
    seq: 0,
    createdAt: 1,
  };
}

function member(key: string, state: TeamMember["state"], overrides: Partial<TeamMember> = {}): TeamMember {
  return { key, sessionId: key === "ldr1" ? "sess_ldr1" : "", role: "worker", identity: "engine", joinedAt: 1, lastSeen: 1, state, ...overrides };
}

async function bindLead(): Promise<void> {
  await writeSession(stateRoot, { sessionId: "sess_ldr1", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  identityStore.bind("conn-lead", {
    sessionKey: "xc:default:ldr1", teamId: "default", name: "ldr1", agentKey: "ldr1",
    sessionId: "sess_ldr1", role: "worker", boundAt: Date.now(),
  });
}

const add = (args: Record<string, unknown>, conn = "conn-lead"): Promise<ToolResult> =>
  createMemberToolCore({ stateRoot, workspace: workDir, env: { XC_MEMBER_BOOTSTRAP_TIMEOUT_MS: "1000" } })
    .xc_member_add(args as never, conn as never) as unknown as Promise<ToolResult>;

const rosterOf = async (key: string): Promise<TeamMember | undefined> =>
  (await readTeam(stateRoot, "default"))!.members.find((m) => m.key === key);

// ---------------------------------------------------------------------------
// 故障注-1：provisioning 超时不再依赖存活 watcher
// ---------------------------------------------------------------------------

describe("故障注-1 provisioning 超时（红队 fi1：lead server 死亡 → 永久卡死）", () => {
  it("Phase 1 把 provisionDeadlineAt 随 provisioning 记录落盘（供给过程中可见）", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([member("ldr1", "ready")]));
    let midFlight: TeamMember | undefined;
    provisionProbe.mockImplementation(async () => {
      midFlight = await rosterOf("m-new");
    });
    const r = await add({ name: "m-new" });
    expect(r.isError).toBeFalsy();
    // 供给四步执行时，roster 已是 provisioning 且 deadline 已落盘
    expect(midFlight?.state).toBe("provisioning");
    expect(midFlight?.provisionedAt).toBeTypeOf("number");
    // deadline = provisionedAt + bootstrapTimeout(1000) + 60s 宽限
    expect(midFlight?.provisionDeadlineAt).toBe((midFlight?.provisionedAt ?? 0) + 61_000);
  });

  it("过期 provisioning 记录被锁内清扫：failed + error + 审计 + 释放名额（红队 fi1 核心）", async () => {
    await bindLead();
    // 红队形态：m6 卡 provisioning 且早已超过 deadline（lead server 已亡）。
    const staleStart = Date.now() - (1000 + 60_000 + 5_000);
    await writeTeam(stateRoot, teamWith([
      member("ldr1", "ready"),
      member("m6", "provisioning", { provisionedAt: staleStart, provisionDeadlineAt: staleStart + 61_000 }),
    ]));
    const r = await add({ name: "m7" });
    expect(r.isError).toBeFalsy();
    const swept = await rosterOf("m6");
    expect(swept?.state).toBe("failed");
    expect(swept?.error).toMatch(/provisioning deadline exceeded/);
    expect(swept?.error).toMatch(/member-add/); // 恢复指引
    const events = await engineEvents();
    const timeout = events.filter((e) => e.event === "member-provision-timeout");
    expect(timeout).toHaveLength(1);
    expect(timeout[0]).toMatchObject({ name: "m6", via: "member-add" });
    // 名额释放：m7 放行（清扫前 m6 占位会让 XC_MAX_MEMBERS=1 的团队直接 cap）
    expect((await rosterOf("m7"))?.state).toBe("ready");
  });

  it("占名额修复：max=1 时卡死的 provisioning 成员清扫后新成员才放行（修复前必被 cap 硬拒）", async () => {
    await bindLead();
    const staleStart = Date.now() - (1000 + 60_000 + 5_000);
    await writeTeam(stateRoot, teamWith([
      member("ldr1", "ready"),
      member("m6", "provisioning", { provisionedAt: staleStart, provisionDeadlineAt: staleStart + 61_000 }),
    ]));
    const core = createMemberToolCore({ stateRoot, workspace: workDir, env: { XC_MEMBER_BOOTSTRAP_TIMEOUT_MS: "1000", XC_MAX_MEMBERS: "1" } });
    const r = (await (core.xc_member_add as (a: unknown, c: string) => Promise<ToolResult>)({ name: "m7" }, "conn-lead"));
    expect(r.isError).toBeFalsy();
    expect((payloadOf(r) as { name: string }).name).toBe("m7");
  });

  it("同名重试干净接管：成功载荷披露 recovered=provision-timeout（无回执 → 有回执）", async () => {
    await bindLead();
    const staleStart = Date.now() - (1000 + 60_000 + 5_000);
    await writeTeam(stateRoot, teamWith([
      member("ldr1", "ready"),
      member("m6", "provisioning", { provisionedAt: staleStart, provisionDeadlineAt: staleStart + 61_000 }),
    ]));
    const r = await add({ name: "m6" });
    expect(r.isError).toBeFalsy();
    const payload = payloadOf(r) as { name: string; state: string; recovered?: string };
    expect(payload.state).toBe("ready");
    expect(payload.recovered).toBe("provision-timeout");
    expect(r.content[0]?.text).toContain("previous provisioning attempt had timed out");
  });

  it("未过期的 provisioning 不被误清扫（重试仍得 member_provisioning）", async () => {
    await bindLead();
    const started = Date.now() - 1_000;
    await writeTeam(stateRoot, teamWith([
      member("ldr1", "ready"),
      member("m6", "provisioning", { provisionedAt: started, provisionDeadlineAt: started + 61_000 }),
    ]));
    const r = await add({ name: "m6" });
    expect(r.isError).toBe(true);
    expect((payloadOf(r) as { error: string }).error).toBe("member_provisioning");
    expect((await rosterOf("m6"))?.state).toBe("provisioning");
    expect((await engineEvents()).some((e) => e.event === "member-provision-timeout")).toBe(false);
  });

  it("存量记录（无 deadline 字段）按 startedAt + 口径兜底清扫", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([
      member("ldr1", "ready"),
      member("legacy", "provisioning", { provisionedAt: Date.now() - (1000 + 60_000 + 5_000) }),
    ]));
    const r = await add({ name: "m7" });
    expect(r.isError).toBeFalsy();
    expect((await rosterOf("legacy"))?.state).toBe("failed");
  });

  it("钩子面清扫：任一存活会话的 UserPromptSubmit 回合把过期记录置 failed + 审计（via=hook）", async () => {
    await bindLead();
    const staleStart = Date.now() - (1000 + 60_000 + 5_000);
    await writeTeam(stateRoot, teamWith([
      member("ldr1", "ready"),
      member("m6", "provisioning", { provisionedAt: staleStart, provisionDeadlineAt: staleStart + 61_000 }),
    ]));
    const sweptKeys = await sweepStaleProvisioning(stateRoot);
    expect(sweptKeys).toEqual(["m6"]);
    expect((await rosterOf("m6"))?.state).toBe("failed");
    const events = await engineEvents();
    expect(events.filter((e) => e.event === "member-provision-timeout")).toHaveLength(1);
    expect(events.find((e) => e.event === "member-provision-timeout")).toMatchObject({ name: "m6", via: "hook" });
    // 幂等：再扫一次不再有动作（无重复审计、无重复写）
    expect(await sweepStaleProvisioning(stateRoot)).toEqual([]);
    expect((await engineEvents()).filter((e) => e.event === "member-provision-timeout")).toHaveLength(1);
  });

  it("钩子面清扫：无团队/无过期记录 → 空操作（不写 team.json）", async () => {
    expect(await sweepStaleProvisioning(stateRoot)).toEqual([]); // 无 team.json
    await bindLead();
    const started = Date.now() - 1_000;
    await writeTeam(stateRoot, teamWith([
      member("ldr1", "ready"),
      member("live", "provisioning", { provisionedAt: started, provisionDeadlineAt: started + 61_000 }),
    ]));
    expect(await sweepStaleProvisioning(stateRoot)).toEqual([]);
    expect((await rosterOf("live"))?.state).toBe("provisioning");
  });
});

// ---------------------------------------------------------------------------
// 故障注-3：peer 消息 store 损坏 → 显式 message_corrupt（不误报 unknown msgId）
// ---------------------------------------------------------------------------

describe("故障注-3 peer 消息存储损坏（红队 fi3：误导性 unknown msgId）", () => {
  let peerRoot: string;

  beforeEach(async () => {
    peerRoot = await mkdtemp(join(tmpdir(), "xc-fi3v071-peers-"));
    await writePeerBaseRecord(peerRoot, {
      sessionId: "sess-b", cwd: workDir, source: "startup", startedAt: Date.now(), lastSeen: Date.now(),
    });
  });

  afterEach(async () => {
    await rm(peerRoot, { recursive: true, force: true });
  });

  const depsWith = (): ToolDeps => ({ stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } });

  it("store 坏件 + 无处兜底 → message_corrupt（带路径与恢复动作）+ peer 审计", async () => {
    const services = createDefaultPeerServices(depsWith());
    await services.register({ name: "pb", sessionId: "sess-b" });
    // 坏件（红队同款字节）
    await mkdir(join(peerRoot, "messages"), { recursive: true });
    await writeFile(join(peerRoot, "messages", "m-corrupt.json"), "CORRUPTED-GARBAGE-\x00\x01-not-json", "utf8");

    const error = await services.read({ msgId: "m-corrupt" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const payload = (error as { payload: Record<string, unknown> }).payload;
    expect(payload.error).toBe("message_corrupt");
    expect(payload.msgId).toBe("m-corrupt");
    expect(String(payload.path)).toContain("m-corrupt.json");
    expect(String(payload.message)).toMatch(/storage damage, not an unknown msgId/);
    expect(String(payload.message)).toMatch(/resend/);
    expect(String(payload.message)).toMatch(/deleting or repairing the file/);
    // 不再是误导性 unknown msgId（不带「only messages received by this session」的身份误述）
    expect(String(payload.message)).not.toMatch(/only messages received by this session/);
    expect(String(payload.message)).not.toMatch(/^unknown msgId/);

    const auditLines = (await readFile(peerAuditLogFile(peerRoot), "utf8"))
      .trim().split("\n").filter((l) => l.includes("peer-msg-read-corrupt"));
    expect(auditLines.length).toBeGreaterThan(0);
    const audit = JSON.parse(auditLines[auditLines.length - 1]!) as { event: Record<string, unknown> };
    expect(audit.event.event).toBe("peer-msg-read-corrupt");
    expect(String(audit.event.file)).toContain("m-corrupt.json");
  });

  it("真的从没收到 → 仍报 unknown msgId（invalid_params；不被误判成损坏）", async () => {
    const services = createDefaultPeerServices(depsWith());
    await services.register({ name: "pb", sessionId: "sess-b" });
    const error = await services.read({ msgId: "m-never-seen" }).catch((e: unknown) => e);
    const payload = (error as { payload: Record<string, unknown> }).payload;
    expect(payload.error).toBe("invalid_params");
    expect(String(payload.message)).toMatch(/unknown msgId/);
  });

  it("恢复路径：消息未消费（仍在 queue）时 store 坏件不挡兜底读取", async () => {
    const services = createDefaultPeerServices(depsWith());
    await services.register({ name: "pb", sessionId: "sess-b" });
    const item = { msgId: "m-q", from: "pa", fromSessionId: "sess-a", hopChain: ["pa"], text: "queue 兜底正文", ts: 1, via: "pipe" as const };
    await mkdir(join(peerRoot, "queue"), { recursive: true });
    await writeFile(peerQueueFile(peerRoot, "sess-b"), `${JSON.stringify(item)}\n`, "utf8");
    await mkdir(join(peerRoot, "messages"), { recursive: true });
    await writeFile(join(peerRoot, "messages", "m-q.json"), "garbage", "utf8");

    const page = await services.read({ msgId: "m-q" });
    expect(page.text).toContain("queue 兜底正文");
  });
});

// ---------------------------------------------------------------------------
// 故障注-4：peer 队列坏行计数披露（与 inbox malformedLines 同口径）
// ---------------------------------------------------------------------------

describe("故障注-4 peer 队列坏行计数披露（红队 fi4：静默跳过且不计数）", () => {
  let peerRoot: string;

  beforeEach(async () => {
    peerRoot = await mkdtemp(join(tmpdir(), "xc-fi4v071-peers-"));
    await writePeerBaseRecord(peerRoot, {
      sessionId: "sess-b", cwd: workDir, source: "startup", startedAt: Date.now(), lastSeen: Date.now(),
    });
  });

  afterEach(async () => {
    await rm(peerRoot, { recursive: true, force: true });
  });

  it("inbox() 透出 malformed（坏行计数不再被 drain 丢弃）", async () => {
    const services = createDefaultPeerServices({ stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } });
    await services.register({ name: "pb", sessionId: "sess-b" });
    const item = { msgId: "m-1", from: "pa", fromSessionId: "sess-a", hopChain: ["pa"], text: "real-message-one", ts: 1, via: "pipe" as const };
    await mkdir(join(peerRoot, "queue"), { recursive: true });
    // 红队 fi4 注入形态：1 条合法 + 乱码行 + 半行 JSON
    await writeFile(
      peerQueueFile(peerRoot, "sess-b"),
      `${JSON.stringify(item)}\nTHIS_IS_GARBAGE_NOT_JSON\x00\x01\n{"msgId":"half","from":"pa","text":"trunc`,
      "utf8",
    );
    const result = await services.inbox(10, { item: 4000, total: 16000, scale: 1 });
    expect(result.items.map((i) => i.msgId)).toEqual(["m-1"]);
    expect(result.malformed).toBe(1);
  });

  it("xc_read({scope:peer}) 披露 malformedLines + 摘要行提示（口径对齐 inbox）；无坏行时不带键", async () => {
    const server = new (class {
      readonly tools: Array<{ name: string; description: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> }> = [];
      tool(name: string, description: string, _schema: unknown, handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>): void {
        this.tools.push({ name, description, handler });
      }
    })();
    const deps: ToolDeps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } };
    const item = { msgId: "m-1", from: "pa", hopChain: ["pa"], text: "hello", ts: 1, via: "pipe" as const };
    const rendered = ['<crosschat-peer-message from="pa">\nhello\n</crosschat-peer-message>'];
    const fake: PeerServices = {
      register: async () => { throw new Error("unexpected"); },
      list: async () => [],
      send: async () => { throw new Error("unexpected"); },
      read: async () => { throw new Error("unexpected"); },
      inbox: async () => ({ items: [item], rendered, remaining: 0, malformed: 2 }),
      review: async () => { throw new Error("unexpected"); },
      rename: async () => { throw new Error("unexpected"); },
      agents: async () => { throw new Error("unexpected"); },
    };
    setPeerServicesForTests(fake);
    const registry = new Map<string, { description: string; shape: unknown; handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> }>();
    registerReadTools(server as unknown as McpServer, deps, createToolCore(deps), registry as never);
    const result = await server.tools.find((t) => t.name === "xc_read")!.handler({ scope: "peer" }, {});
    const payload = payloadOf(result) as { count: number; malformedLines?: number };
    expect(payload.count).toBe(1);
    expect(payload.malformedLines).toBe(2);
    expect(result.content[0]?.text).toContain("2 条队列坏行已跳过");

    // 无坏行 → 不带 malformedLines 键（响应形状与 v0.7.0 逐字节一致）
    const clean: PeerServices = { ...fake, inbox: async () => ({ items: [item], rendered, remaining: 0 }) };
    setPeerServicesForTests(clean);
    const cleanResult = await server.tools.find((t) => t.name === "xc_read")!.handler({ scope: "peer" }, {});
    const cleanPayload = payloadOf(cleanResult) as { count: number; malformedLines?: number };
    expect("malformedLines" in cleanPayload).toBe(false);
    expect(cleanResult.content[0]?.text).toBe("取到 1 条跨会话消息（已消费）。");
    resetPeerServicesForTests();
  });
});
