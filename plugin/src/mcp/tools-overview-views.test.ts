/**
 * v0.8.0 A3/A4（DESIGN-V0.8.md §5/§6 / §8 AC3/AC4）：xc_overview 的 timeline / status
 * 两个新视图工具层单测。临时 stateRoot 端到端（磁盘真源）；peer 根一律指向临时目录
 * （XC_MESSAGING_DIR 优先——绝不碰机器全局注册表，同 overview-offline-mount.test.ts）。
 *
 * - timeline：newest-first、offset 续读指针、limit 钳 100 + limitClamped、预算截断披露；
 * - status：七态计数与构造 team 逐项相等；stalled = stalledTasks；offline = offlineMembers；
 *   checkpoint 年龄按 mtime 断言；unread 数与 mailbox 实况相等；
 * - 容量 RED/GREEN/UNKNOWN 三种样本各一行（UNKNOWN 经采样失败注入——挂载 null → UNKNOWN，
 *   不谎报 GREEN）；RED 附 C9 原句；
 * - 无 team → 两视图都有优雅占位；免注册（未注册连接可调）；
 * - status 预算降级序列留名披露。
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { appendMailbox, createMessage } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import type { Task, TeamMember, TeamState } from "../core/types.js";
import type { ToolDeps } from "./core.js";

/** 容量颜色钉成 GREEN（三条 red 规则都不命中）。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};
/** 容量颜色钉成 RED（watermark < 0.99 必命中 red1）。 */
const RED_ENV = { ...GREEN_ENV, XC_MEM_WARN_WATERMARK: "0.99" };

/** 采样失败注入（hoisted：vi.mock 工厂可引用）；UNKNOWN 路径专用。 */
const capacityProbe = vi.hoisted(() => ({ failSampling: false }));
vi.mock("../core/capacity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/capacity.js")>();
  return {
    ...actual,
    sampleCapacity: async (
      env: NodeJS.ProcessEnv,
      cacheFile: string,
      now: number,
    ): Promise<unknown> => {
      if (capacityProbe.failSampling) throw new Error("probe: capacity sampling failed");
      return actual.sampleCapacity(env, cacheFile, now);
    },
  };
});

const MIN = 60_000;
const T0 = Date.now();

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-overview-views-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true }); // 空 peer 根：无活 peer
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot } };
});

afterEach(async () => {
  capacityProbe.failSampling = false;
  identityStore.bind("__discard__", bindIdentity("ghost", "sess-ghost")); // 防 require 泄漏到断言外
  await rm(workDir, { recursive: true, force: true });
});

function bindIdentity(name: string, sessionId: string): BoundIdentity {
  return {
    sessionKey: `${sessionId}:${name}`,
    teamId: "default",
    name,
    agentKey: name,
    sessionId,
    role: "peer" as const,
    boundAt: Date.now(),
  };
}

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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "任务",
    prompt: "p",
    dependsOn: [],
    status: "pending",
    assignee: null,
    attempt: 0,
    attemptId: null,
    createdBy: "lead",
    createdAt: T0 - 60 * MIN,
    updatedAt: T0 - 20 * MIN,
    lastProgressTs: T0 - 20 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: T0 - 20 * MIN, event: "report", by: "lead" }],
    ...overrides,
  };
}

async function seedTeam(tasks: Task[] = [], members: TeamMember[] = []): Promise<TeamState> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: "lead", founder: member("lead"), now: T0 });
  team.leadKey = "lead";
  team.members.push(member("alice"), member("bob"), ...members);
  team.tasks = tasks;
  await writeTeam(stateRoot, team);
  return team;
}

async function writeCheckpoint(agentKey: string, stamp: string, ageMin: number): Promise<void> {
  const dir = join(stateRoot, "checkpoints", agentKey);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stamp}.md`);
  await writeFile(path, "---\nagent: x\n---\n", "utf8");
  const mtime = new Date(Date.now() - ageMin * MIN);
  await utimes(path, mtime, mtime);
}

async function view(args: { view: "timeline" | "status"; limit?: number; offset?: number }, conn: string): Promise<ToolResult> {
  return handleOverview(deps, args, conn);
}

function textOf(res: ToolResult): string {
  return (res.content[0] as { text?: string }).text ?? "";
}

// ---------------------------------------------------------------------------
// timeline（A3）
// ---------------------------------------------------------------------------

describe("xc_overview view=timeline（A3）", () => {
  it("newest-first + 归一化行（ts/event/family/actor/taskId/summary）", async () => {
    await logEngineEvent(stateRoot, { event: "dispatch", teamId: "default", to: "bob", createdBy: "alice", taskId: "t-1" });
    await new Promise((r) => setTimeout(r, 2));
    await logEngineEvent(stateRoot, { event: "claim", teamId: "default", taskId: "t-1", assignee: "bob", attempt: 1 });
    await new Promise((r) => setTimeout(r, 2));
    await logEngineEvent(stateRoot, { event: "lead-transfer", teamId: "default", from: "alice", to: "carol" });
    await new Promise((r) => setTimeout(r, 2));
    await logEngineEvent(stateRoot, { event: "status", teamId: "default", agentKey: "alice", tasks: 3 }); // 噪声 → other

    const res = await view({ view: "timeline" }, "conn-nobody"); // 免注册
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as { total: number; events: Array<Record<string, unknown>> };
    expect(payload.total).toBe(4);
    const events = payload.events;
    expect(events.map((e) => e["event"])).toEqual(["status", "lead-transfer", "claim", "dispatch"]);
    expect(events[0]).toMatchObject({ family: "other", actor: "alice", taskId: null, summary: "status" });
    expect(events[1]).toMatchObject({ family: "lead", actor: "carol", summary: "lead → carol" });
    expect(events[2]).toMatchObject({ family: "claim", actor: "bob", taskId: "t-1", summary: "claim by bob (attempt 1)" });
    expect(events[3]).toMatchObject({ family: "dispatch", actor: "alice", summary: "dispatch → bob by alice" });
    // 文本行格式：ISO | event | family | actor | taskId | summary
    const text = textOf(res);
    expect(text).toContain("| lead-transfer | lead | carol | - | lead → carol");
    expect(text.split("\n")[0]).toContain("引擎事件（窗口内 4 条，新→旧；本页 4 条，offset 0）");
  });

  it("offset 自最新往回跳过 + 续读；limit 缺省 20", async () => {
    for (let i = 0; i < 3; i += 1) {
      await logEngineEvent(stateRoot, { event: "claim", teamId: "default", taskId: `t-${i}`, assignee: "bob" });
      await new Promise((r) => setTimeout(r, 2));
    }
    const first = await view({ view: "timeline" }, "conn-nobody");
    expect((payloadOf(first) as { limit: number }).limit).toBe(20);
    const second = await view({ view: "timeline", offset: 2 }, "conn-nobody");
    const payload = payloadOf(second) as { events: Array<Record<string, unknown>>; offset: number };
    expect(payload.offset).toBe(2);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({ taskId: "t-0" });
  });

  it("limit > 100 钳到 100 并披露 limitClamped", async () => {
    for (let i = 0; i < 5; i += 1) {
      await logEngineEvent(stateRoot, { event: "claim", teamId: "default", taskId: `t-${i}`, assignee: "bob" });
    }
    const res = await view({ view: "timeline", limit: 500 }, "conn-nobody");
    const payload = payloadOf(res) as { limitClamped?: { requested: number; applied: number }; limit: number };
    expect(payload.limitClamped).toEqual({ requested: 500, applied: 100 });
    expect(payload.limit).toBe(100);
  });

  it("预算开窗超限 → truncated 披露 + 续读指针", async () => {
    for (let i = 0; i < 8; i += 1) {
      await logEngineEvent(stateRoot, {
        event: "dispatch", teamId: "default", to: "bob", createdBy: "alice", taskId: `t-${i}`, pad: "x".repeat(80),
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    const tight: ToolDeps = { ...deps, env: { ...deps.env, XC_INJECT_ITEM_CHARS: "50", XC_INJECT_TOTAL_CHARS: "300" } };
    const res = await handleOverview(tight, { view: "timeline" }, "conn-nobody");
    const payload = payloadOf(res) as { truncated?: { shown: number; total: number }; events: unknown[] };
    expect(payload.events.length).toBeLessThan(8);
    expect(payload.truncated).toBeDefined();
    expect(payload.truncated!.total).toBe(8);
    const text = textOf(res);
    expect(text).toContain(`用 xc_overview({view:"timeline", offset:${payload.truncated!.shown}}) 续读`);
  });

  it("无 engine.jsonl → 空占位（不抛）", async () => {
    const res = await view({ view: "timeline" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toContain("引擎日志暂无事件");
    expect((payloadOf(res) as { total: number }).total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// status（A4）
// ---------------------------------------------------------------------------

describe("xc_overview view=status（A4）", () => {
  async function seedStatusTeam(): Promise<void> {
    await seedTeam([
      task({ id: "t-p", status: "pending", assignee: null }),
      task({ id: "t-c", status: "claimed", assignee: "alice", attempt: 1, lastProgressTs: T0 - 10 * MIN }),
      task({ id: "t-ip", status: "in_progress", assignee: "alice", attempt: 1, lastProgressTs: T0 - 20 * MIN }),
      task({ id: "t-b", status: "blocked", assignee: "alice", attempt: 1, lastProgressTs: T0 - 30 * MIN }),
      task({ id: "t-done", status: "completed", assignee: "bob", lastProgressTs: T0 - 400 * MIN }),
      task({ id: "t-f", status: "failed", assignee: "bob", lastProgressTs: T0 - 400 * MIN }),
      task({ id: "t-x", status: "cancelled", assignee: "bob", lastProgressTs: T0 - 400 * MIN }),
      // 300min 无进展：stalled（>120min）且离线（>240min，名下非终态任务 idle-timeout）
      task({ id: "t-bobs", status: "in_progress", assignee: "bob", attempt: 1, lastProgressTs: T0 - 300 * MIN }),
    ]);
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m1"));
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m2"));
    await appendMailbox(stateRoot, "default", "bob", createMessage("carol", "bob", "urgent!", { urgent: true }));
    await writeCheckpoint("alice", "2026-11-15T18-00-00-000Z", 5);
  }

  it("七态计数/stalled/offline/checkpoint 年龄/unread 与真实状态逐项相等（GREEN）", async () => {
    await seedStatusTeam();
    const res = await view({ view: "status" }, "conn-nobody"); // 免注册
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["taskCounts"]).toEqual({
      pending: 1, claimed: 1, in_progress: 2, blocked: 1, completed: 1, failed: 1, cancelled: 1,
    });
    expect(payload["stalled"]).toBe(1);
    expect(payload["members"]).toEqual({ total: 3, offline: 1 });
    expect(payload["unread"]).toEqual({ lead: 0, alice: 2, bob: 1 });
    expect(payload["checkpoints"]).toMatchObject({ lead: { ageMin: null }, alice: { ageMin: 5 }, bob: { ageMin: null } });
    expect(payload["capacity"]).toMatchObject({ level: "GREEN" });
    // 文本面：行序冻结（team / tasks / capacity / checkpoint / unread）
    const lines = textOf(res).split("\n");
    expect(lines[0]).toBe("team: default | lead: lead | members: 3 (offline 1)");
    expect(lines[1]).toBe(
      "tasks: pending 1 / claimed 1 / in_progress 2 / blocked 1 / completed 1 / failed 1 / cancelled 1 | stalled 1",
    );
    expect(lines[2]).toMatch(/^capacity: GREEN \| 水位 \d+\.\d% 可用 \| /);
    expect(lines[3]).toBe("checkpoint: lead=(none), alice=5min前, bob=(none)");
    expect(lines[4]).toBe("unread: lead=0, alice=2, bob=1");
    // 未超预算 → 无 truncated
    expect(payload["truncated"]).toBeUndefined();
  });

  it("容量 RED → 文本行 RED + C9 压缩建议原句；payload level RED", async () => {
    await seedStatusTeam();
    const redDeps: ToolDeps = { ...deps, env: { ...RED_ENV, XC_MESSAGING_DIR: peerRoot } };
    const res = await handleOverview(redDeps, { view: "status" }, "conn-nobody");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["capacity"]).toMatchObject({ level: "RED" });
    const text = textOf(res);
    expect(text.split("\n")[2]).toMatch(/^capacity: RED \| /);
    expect(text).toContain("compress-advice: 容量预警");
  });

  it("容量采样失败 → UNKNOWN（不谎报 GREEN）+ payload capacity null", async () => {
    await seedStatusTeam();
    capacityProbe.failSampling = true;
    const res = await view({ view: "status" }, "conn-nobody");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["capacity"]).toBeNull();
    const text = textOf(res);
    expect(text.split("\n")[2]).toContain("capacity: UNKNOWN");
    expect(text.split("\n")[2]).not.toMatch(/^capacity: (GREEN|RED)/); // 不谎报水位
    // 其余行不受影响（观测面永不为难）
    expect(text.split("\n")[0]).toBe("team: default | lead: lead | members: 3 (offline 1)");
  });

  it("预算超限 → 固定降级序留名披露（unread → checkpoint → offline/stalled → capacity 明细）", async () => {
    await seedStatusTeam();
    const tight: ToolDeps = { ...deps, env: { ...deps.env, XC_INJECT_ITEM_CHARS: "50", XC_INJECT_TOTAL_CHARS: "260" } };
    const res = await handleOverview(tight, { view: "status" }, "conn-nobody");
    const payload = payloadOf(res) as Record<string, unknown>;
    const truncated = payload["truncated"] as { budgetChars: number; droppedSections: string[] } | undefined;
    expect(truncated).toBeDefined();
    expect(truncated!.budgetChars).toBe(260);
    expect(truncated!.droppedSections.length).toBeGreaterThan(0);
    const text = textOf(res);
    expect(text.length).toBeLessThanOrEqual(260);
    expect(text).toContain("字符预算截断");
    // 降级序前缀性质（顺序固定）
    const order = ["unread", "checkpoint", "offline", "stalled", "capacity-details", "正文"];
    expect(order.slice(0, truncated!.droppedSections.length)).toEqual(truncated!.droppedSections);
  });

  it("无 team.json → 优雅占位（不抛、不写 snapshot）", async () => {
    const res = await view({ view: "status" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toContain("team: (none)");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["phase"]).toBe("none");
    expect(payload["taskCounts"]).toMatchObject({ pending: 0 });
  });

  it("已注册时 me 的 checkpoint 年龄在场（花名册内不重复列）", async () => {
    await seedStatusTeam();
    await writeCheckpoint("lead", "2026-11-15T17-00-00-000Z", 95);
    identityStore.bind("conn-alice", bindIdentity("alice", "sess-alice"));
    const res = await view({ view: "status" }, "conn-alice");
    const text = textOf(res);
    expect(text.split("\n")[3]).toBe("checkpoint: lead=1h前, alice=5min前, bob=(none)");
  });
});
