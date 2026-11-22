/**
 * v0.9.8 组 O：xc_overview 两面定向单测（tools-overview.ts）。
 *
 * **R2 team 板面成员行可寻址名**：payload members[].peerName = 该成员 sessionId
 * 对应的活跃 peer 花名（与 panel agents() 同一解析源 peerNameBySessionId——
 * 「两面一致」）；snapshot.json（落盘板面）**不 gaining** peerName：花名是注册表
 * 活查询，不是花名册状态，不进盘。
 *
 * **C1 status 上下文体积估算**：
 * - payload `context` 块恒在（无团队 → 空块，键集稳定）：threshold + byMember
 *   {bytes, messages, overThreshold} + overThreshold 花名册键数组；
 * - 低于阈值 → 文本**无** context 行（正常不打扰）；
 * - 字节达阈值 → 文本出现一次建议行（checkpoint 后压缩/新会话，不自动压缩）；
 * - 条数达阈值（字节低于）→ 同样出行（或的关系）；
 * - XC_CONTEXT_NUDGE=0 → 文本不出行，但 payload **事实仍在**（关提醒不减事实）；
 * - 事实与邮箱真源一致：byMember[key].bytes = stat.size、messages = 解析行数。
 *
 * 纪律：不跑全量单测（脚本统一恰跑一次）；本文件只测组 O 自有面。
 */
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { resetPeerServicesForTests } from "./peer-services.js";
import { appendMailbox, createMessage } from "../core/mailbox.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { localPidDomain } from "../core/peerdir.js";
import { writePeerRecord } from "../core/peerregistry.js";
import { inboxFile, snapshotFile } from "../core/paths.js";
import {
  CONTEXT_NUDGE_BYTES,
  CONTEXT_NUDGE_MESSAGES,
} from "../core/checkpoint.js";
import type { Task, TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";

const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

const MIN = 60_000;
const T0 = Date.now();

/**
 * 「条数达阈值」用例的显式超时（30s）。
 *
 * 为什么需要它：该用例往 bob 邮箱顺序灌 {@link CONTEXT_NUDGE_MESSAGES}(500) 条消息。
 * `appendJsonl` 是 O(1) 追加（尾探针 + 一次 O_APPEND 写，成本不随文件增长——P0 回归见
 * `core/jsonl-append-cost-v093.test.ts`），500 次约 1.2s（隔离实测 1254ms），已占缺省 5s
 * 超时的 1/4。机器有并行负载时该用例 >5s，且 `vitest.config.ts` 的 `retry: 3` 救不了——
 * 负载在整个 run 内持续，三次重试同样超时（v0.9.8 第 2 轮全量实测：12:52 与 12:53 两次
 * 全量各 4/4 次尝试全部 timed out in 5000ms；空载 12:47 与 12:55 两次全量全绿）。
 *
 * 纪律：**只放宽时间预算，不放宽任何断言**（6 条断言逐字未动）；30s ≈ 隔离实测的 24 倍，
 * 仍远小于任何合理用例时长，超时依旧会红。
 */
const SLOW_TEST_TIMEOUT_MS = 30_000;

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v098-o-ovw-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true });
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot } };
});

afterEach(async () => {
  resetPeerServicesForTests();
  await rm(workDir, { recursive: true, force: true });
});

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key,
    sessionId: `sess-${key}`,
    role: "worker",
    joinedAt: T0 - 300 * MIN,
    lastSeen: T0 - MIN,
    state: "ready",
    identity: "engine",
    ...overrides,
  };
}

function task(id: string, status: Task["status"], assignee: string | null): Task {
  return {
    id,
    title: `任务 ${id}`,
    prompt: "p",
    dependsOn: [],
    status,
    assignee,
    attempt: assignee === null ? 0 : 1,
    attemptId: null,
    createdBy: "lead",
    createdAt: T0 - 60 * MIN,
    updatedAt: T0 - 20 * MIN,
    lastProgressTs: T0 - 20 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: T0 - 20 * MIN, event: "report", by: "lead" }],
  };
}

async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    name: "default",
    founderKey: "lead",
    founder: member("lead"),
    now: T0,
  });
  team.leadKey = "lead";
  team.members.push(member("alice"), member("bob"));
  team.tasks = [task("t-ip", "in_progress", "alice")];
  await writeTeam(stateRoot, team);
}

async function writeLivePeer(sessionId: string, name: string): Promise<void> {
  await writePeerRecord(peerRoot, {
    pid: process.pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xcc-msg-${name}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name,
    formerNames: [],
    startedAt: T0 - MIN,
    lastSeen: T0,
  });
}

interface ContextBlock {
  threshold: { bytes: number; messages: number };
  byMember: Record<string, { bytes: number; messages: number; overThreshold: boolean }>;
  overThreshold: string[];
}

function contextOf(res: ToolResult): ContextBlock {
  return (payloadOf(res) as { context: ContextBlock }).context;
}

function textOf(res: ToolResult): string {
  return res.content[0]!.text;
}

// ---------------------------------------------------------------------------
// R2：team 板面成员行可寻址名
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O R2：team 板面成员行 peerName", () => {
  it("活跃 peer 记录 → peerName 在成员行；无记录 → absent；snapshot.json 不 gaining", async () => {
    await seedTeam();
    await writeLivePeer("sess-alice", "alice-pc");

    const res = await handleOverview(deps, { view: "team" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    const members = (payloadOf(res) as { members: Array<{ key: string; peerName?: string }> }).members;
    const byKey = Object.fromEntries(members.map((m) => [m.key, m.peerName]));
    expect(byKey["alice"]).toBe("alice-pc");
    expect(byKey["bob"]).toBeUndefined();
    expect(byKey["lead"]).toBeUndefined();

    // 落盘快照形状不变：peerName 是注册表活查询，不是花名册状态（不进 snapshot.json）。
    const snapshot = JSON.parse(await readFile(snapshotFile(stateRoot, "default"), "utf8")) as {
      members: Array<Record<string, unknown>>;
    };
    for (const m of snapshot.members) expect(Object.keys(m).sort()).toEqual(["key", "lastSeen", "role", "sessionId"]);
  });
});

// ---------------------------------------------------------------------------
// C1：status 上下文体积估算
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O C1：status 上下文体积估算块", () => {
  it("无团队 → context 空块（键集与有团队时一致）", async () => {
    const res = await handleOverview(deps, { view: "status" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    expect(contextOf(res)).toEqual({
      threshold: { bytes: CONTEXT_NUDGE_BYTES, messages: CONTEXT_NUDGE_MESSAGES },
      byMember: {},
      overThreshold: [],
    });
  });

  it("低于阈值 → 文本无 context 行（正常不打扰），payload 事实恒在且与 stat 真源一致", async () => {
    await seedTeam();
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m1"));
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m2"));

    const res = await handleOverview(deps, { view: "status" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).not.toContain("context:");
    const ctx = contextOf(res);
    expect(ctx.overThreshold).toEqual([]);
    const size = (await stat(inboxFile(stateRoot, "default", "alice"))).size;
    expect(ctx.byMember["alice"]).toEqual({ bytes: size, messages: 2, overThreshold: false });
    expect(ctx.byMember["lead"]).toEqual({ bytes: 0, messages: 0, overThreshold: false });
  });

  it("字节达阈值 → 文本出现一次建议行（checkpoint 后压缩/新会话，不自动压缩）", async () => {
    await seedTeam();
    const big = "x".repeat(CONTEXT_NUDGE_BYTES + 1024);
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", big));

    const res = await handleOverview(deps, { view: "status" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    const text = textOf(res);
    expect(text).toContain("context: alice(");
    expect(text).toContain("超阈值");
    expect(text).toContain("xc_team({action:\"checkpoint\"})");
    expect(text).toContain("不自动压缩");
    // 「出现一次」：整段文本里恰好一行 context 建议（不是每成员一行、不重复）。
    expect(text.split("\n").filter((l) => l.startsWith("context:")).length).toBe(1);
    const ctx = contextOf(res);
    expect(ctx.overThreshold).toEqual(["alice"]);
    expect(ctx.byMember["alice"]!.overThreshold).toBe(true);
    expect(ctx.byMember["alice"]!.bytes).toBeGreaterThanOrEqual(CONTEXT_NUDGE_BYTES);
    expect(ctx.byMember["bob"]!.overThreshold).toBe(false);
  });

  it("条数达阈值（字节低于）→ 同样出行（或的关系）", async () => {
    await seedTeam();
    for (let i = 0; i < CONTEXT_NUDGE_MESSAGES; i += 1) {
      await appendMailbox(stateRoot, "default", "bob", createMessage("carol", "bob", `m${i}`));
    }
    const res = await handleOverview(deps, { view: "status" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    const ctx = contextOf(res);
    expect(ctx.overThreshold).toEqual(["bob"]);
    expect(ctx.byMember["bob"]!.messages).toBe(CONTEXT_NUDGE_MESSAGES);
    expect(ctx.byMember["bob"]!.bytes).toBeLessThan(CONTEXT_NUDGE_BYTES);
    expect(textOf(res)).toContain("context: bob(");
  }, SLOW_TEST_TIMEOUT_MS);

  it("XC_CONTEXT_NUDGE=0 → 文本不出行，payload 事实仍在（关提醒不减事实）", async () => {
    await seedTeam();
    const big = "x".repeat(CONTEXT_NUDGE_BYTES + 1024);
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", big));

    const offDeps: ToolDeps = { ...deps, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot, XC_CONTEXT_NUDGE: "0" } };
    const res = await handleOverview(offDeps, { view: "status" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).not.toContain("context:");
    const ctx = contextOf(res);
    expect(ctx.overThreshold).toEqual(["alice"]);
    expect(ctx.byMember["alice"]!.overThreshold).toBe(true);
  });
});
