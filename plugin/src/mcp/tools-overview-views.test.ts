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
import { localPidDomain } from "../core/peerdir.js";
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
    // v0.8.1（M03）：lead-transfer 的 actor 取 from（转让者 alice），不再是 to（新 lead carol）
    expect(events[1]).toMatchObject({ family: "lead", actor: "alice", summary: "lead → carol" });
    expect(events[2]).toMatchObject({ family: "claim", actor: "bob", taskId: "t-1", summary: "claim by bob (attempt 1)" });
    expect(events[3]).toMatchObject({ family: "dispatch", actor: "alice", summary: "dispatch → bob by alice" });
    // 文本行格式：ISO | event | family | actor | taskId | summary
    const text = textOf(res);
    expect(text).toContain("| lead-transfer | lead | alice | - | lead → carol");
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

  it("预算开窗超限 → truncated 披露 + 续读指针 + 位置游标语义披露（B7）", async () => {
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
    // v0.8.1（C3-B7）：位置游标语义随截断尾注披露（实时追加下跳号/重叠都可能）
    expect(text).toContain("位置游标");
    expect(text).toContain("跳号");
  });

  it("B3 回归：坏行/形状不符行在文本与 payload 双面披露 skippedEvents", async () => {
    await mkdir(join(stateRoot, "logs"), { recursive: true });
    await writeFile(
      join(stateRoot, "logs", "engine.jsonl"),
      [
        JSON.stringify({ ts: 1, event: "claim", taskId: "legal-1", by: "alice" }),
        "{}",
        "{not json",
        JSON.stringify({ ts: 2, event: "claim", taskId: "legal-2", by: "bob" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const res = await view({ view: "timeline" }, "conn-nobody");
    const payload = payloadOf(res) as { total: number; skippedEvents?: number };
    expect(payload.total).toBe(2);
    expect(payload.skippedEvents).toBe(2); // {} + 坏行
    expect(textOf(res)).toContain("2 行未能归一化");
  });

  it("B4 回归：文本视图控制字符折空格；JSON payload 保持原值", async () => {
    await logEngineEvent(stateRoot, { event: "claim", teamId: "default", taskId: "ctrl", by: "a\u0000b\u0007c" });
    const res = await view({ view: "timeline" }, "conn-nobody");
    const text = textOf(res);
    expect(text).not.toMatch(/[\u0000-\u0008]/); // 无裸 NUL/BEL
    expect(text).toContain("| claim | claim | a b c | ctrl | claim by a b c");
    const payload = payloadOf(res) as { events: Array<Record<string, unknown>> };
    expect(payload.events[0]!["actor"]).toBe("a\u0000b\u0007c"); // JSON 面原值（stringify 转义）
  });

  it("无 engine.jsonl → 空占位（不抛）", async () => {
    const res = await view({ view: "timeline" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toContain("引擎日志暂无事件");
    expect((payloadOf(res) as { total: number }).total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// timeline 预算刻度：identify 的 contextChars 逐会话声明（v0.8.1 C3-B8）
// ---------------------------------------------------------------------------

describe("xc_overview view=timeline：budget 接 identify 的 contextChars（B8）", () => {
  /** 落一条 peer 注册记录（含 contextChars 声明）——同 overview-offline-mount.test.ts 口径。 */
  async function writePeerRecord(sid: string, contextChars?: number): Promise<void> {
    await mkdir(join(peerRoot, "sessions"), { recursive: true });
    await writeFile(
      join(peerRoot, "sessions", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: sid,
        messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xcc-msg-b8test",
        pidDomain: localPidDomain(),
        peerProtocol: 1,
        peerFeatures: [],
        kind: "bg",
        formerNames: [],
        startedAt: Date.now() - 3_600_000,
        lastSeen: Date.now(),
        ...(contextChars !== undefined ? { contextChars } : {}),
      }),
      "utf8",
    );
  }

  /**
   * 30 条大条目（归一化后每条 ~6k 字符）：缺省 limit=20 的页面在 64000/16000/4000
   * 三档预算下都必截断——truncated.budgetChars 三档都可读（B8 的观测窗）。
   */
  async function seedBigLog(): Promise<void> {
    for (let i = 0; i < 30; i += 1) {
      await logEngineEvent(stateRoot, {
        event: "claim", teamId: "default", taskId: `t-${i}-${"x".repeat(2000)}`, assignee: "a".repeat(2000), attempt: 1,
      });
    }
  }

  it("未声明 → 回落 env 刻度（XC_CONTEXT_CHARS=800000 → 64000）", async () => {
    await seedBigLog();
    const big: ToolDeps = { ...deps, env: { ...deps.env, XC_CONTEXT_CHARS: "800000" } };
    const res = await handleOverview(big, { view: "timeline" }, "conn-nobody");
    const payload = payloadOf(res) as { truncated?: { budgetChars: number } };
    expect(payload.truncated).toBeDefined();
    expect(payload.truncated!.budgetChars).toBe(64000);
  });

  it("identify 声明 contextChars=2000 → 预算缩到 4000（v0.8.0 忽略声明，恒 16000）", async () => {
    await seedBigLog();
    identityStore.bind("conn-b8-small", bindIdentity("smallctx", "sess-b8-small"));
    await writePeerRecord("sess-b8-small", 2000);
    const res = await view({ view: "timeline" }, "conn-b8-small");
    const payload = payloadOf(res) as { truncated?: { budgetChars: number } };
    expect(payload.truncated).toBeDefined();
    expect(payload.truncated!.budgetChars).toBe(4000);
    identityStore.unbind("conn-b8-small");
  });

  it("逐会话声明压过 env（声明 800000 + env 20000 → 64000；v0.8.0 跟随 env 得 4000）", async () => {
    await seedBigLog();
    identityStore.bind("conn-b8-big", bindIdentity("bigctx", "sess-b8-big"));
    await writePeerRecord("sess-b8-big", 800000);
    const envSmall: ToolDeps = { ...deps, env: { ...deps.env, XC_CONTEXT_CHARS: "20000" } };
    const res = await handleOverview(envSmall, { view: "timeline" }, "conn-b8-big");
    const payload = payloadOf(res) as { truncated?: { budgetChars: number } };
    expect(payload.truncated!.budgetChars).toBe(64000);
    identityStore.unbind("conn-b8-big");
  });

  it("声明缺省（peer 记录无 contextChars）→ 回落 env 缺省 200k（16000）", async () => {
    await seedBigLog();
    identityStore.bind("conn-b8-nodecl", bindIdentity("nodecl", "sess-b8-nodecl"));
    await writePeerRecord("sess-b8-nodecl"); // 无 contextChars 字段
    const res = await view({ view: "timeline" }, "conn-b8-nodecl");
    const payload = payloadOf(res) as { truncated?: { budgetChars: number } };
    expect(payload.truncated!.budgetChars).toBe(16000);
    identityStore.unbind("conn-b8-nodecl");
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
    // v0.8.1（C5-BUG-C5-02）：status 文本按精确分钟渲染（与 handoff 文本/payload 的
    // ageMin 同粒度）——旧实现按 h/d 阶梯向下取整，95min 渲染成「1h前」。
    expect(text.split("\n")[3]).toBe("checkpoint: lead=95min前, alice=5min前, bob=(none)");
  });

  // v0.8.1（29 红队 C4-F3）：checkpoint 行的文档口径钉死——「me（已注册时）+ 全部
  // 花名册成员；无检查点记 (none)」（PROTOCOL §14.5 散文与同节示例拉齐后的口径，
  // 与 unread 行的「对每个成员」平行）。payload checkpoints 与文本行同集合。
  it("C4-F3 口径钉死：文本行与 payload 同为 me+全员花名册，(none) 不省略", async () => {
    await seedStatusTeam();
    await writeCheckpoint("alice", "2026-11-15T18-00-00-000Z", 5);
    const res = await view({ view: "status" }, "conn-nobody"); // 未注册：无 me 行
    const payload = payloadOf(res) as { checkpoints: Record<string, unknown> };
    expect(Object.keys(payload.checkpoints).sort()).toEqual(["alice", "bob", "lead"]);
    expect(payload.checkpoints).toMatchObject({ lead: { ageMin: null }, alice: { ageMin: 5 }, bob: { ageMin: null } });
    expect(textOf(res).split("\n")[3]).toBe("checkpoint: lead=(none), alice=5min前, bob=(none)");
  });

  // v0.8.1（29 红队 M05 收口）：team 视图 history:true payload 的 leadKey 与同一 payload 的
  // members[].isLead 同源（都走 leadKeyOf 的 founder 兜底）。v0.8.0 直读 team.leadKey ?? null：
  // 无显式 lead 时 payload 给 leadKey:null 而 members[] 里 founder 又 isLead:true——同一块
  // 自相矛盾（status/handoff/checkpoint 三面在 M05 已拉齐，这是漏网的第四处）。
  it("M05 收口：history:true payload 的 leadKey 与 members[].isLead 同源（无显式 lead → founder）", async () => {
    const team = newTeamState({ teamId: "default", name: "default", founderKey: "lead", founder: member("lead"), now: T0 });
    team.members.push(member("alice"), member("bob"));
    team.tasks = [task({ id: "t-p", status: "pending", assignee: null })];
    await writeTeam(stateRoot, team); // 无显式 leadKey（founder 兜底同判）
    const res = await handleOverview(deps, { view: "team", history: true }, "conn-nobody");
    const payload = payloadOf(res) as {
      leadKey: string | null;
      members: Array<{ key: string; isLead: boolean }>;
    };
    expect(payload.leadKey).toBe("lead");
    expect(payload.members.find((m) => m.key === "lead")?.isLead).toBe(true);
    expect(payload.members.find((m) => m.key === "alice")?.isLead).toBe(false);
  });

  // v0.8.1（29 红队 C4-F1）：status payload 补 offline 阈值键（team 视图早有；此前
  // status 只有文本 WARNING——两视图机器可读面不对称）。
  it("C4-F1：XC_OFFLINE_MINUTES 非法/钳制 → payload 键 + WARNING 双披露（与 team 视图同键）", async () => {
    await seedStatusTeam();
    const fallback: ToolDeps = { ...deps, env: { ...deps.env, XC_OFFLINE_MINUTES: "0" } };
    const res1 = await handleOverview(fallback, { view: "status" }, "conn-nobody");
    const p1 = payloadOf(res1) as Record<string, unknown>;
    expect(p1["offlineThresholdFallback"]).toBe(true);
    expect(p1["offlineThresholdClamped"]).toBeUndefined();
    expect(textOf(res1)).toContain("WARNING XC_OFFLINE_MINUTES 非法");

    const clamped: ToolDeps = { ...deps, env: { ...deps.env, XC_OFFLINE_MINUTES: "10" } };
    const res2 = await handleOverview(clamped, { view: "status" }, "conn-nobody");
    const p2 = payloadOf(res2) as Record<string, unknown>;
    expect(p2["offlineThresholdClamped"]).toBe(true);
    expect(p2["offlineThresholdFallback"]).toBeUndefined();
    expect(textOf(res2)).toContain("WARNING XC_OFFLINE_MINUTES 低于僵尸清扫阈值");

    // 合法值 → 两键都不出（无噪声）
    const ok = await view({ view: "status" }, "conn-nobody");
    const p3 = payloadOf(ok) as Record<string, unknown>;
    expect(p3["offlineThresholdFallback"]).toBeUndefined();
    expect(p3["offlineThresholdClamped"]).toBeUndefined();
  });

  // v0.8.1（29 红队 C4-F2）：XC_STALL_MINUTES 非法值两级披露拉齐（payload 键 + WARNING），
  // 且钳制通道的 WARNING 也补进 status（此前 status 有键无 WARNING、offline 反之）。
  it("C4-F2：XC_STALL_MINUTES 非法 → stalledThresholdFallback 键 + WARNING；钳制 → 键 + WARNING", async () => {
    await seedStatusTeam();
    const bad: ToolDeps = { ...deps, env: { ...deps.env, XC_STALL_MINUTES: "0" } };
    const res1 = await handleOverview(bad, { view: "status" }, "conn-nobody");
    const p1 = payloadOf(res1) as Record<string, unknown>;
    expect(p1["stalledThresholdFallback"]).toBe(true);
    expect(p1["stalledThresholdClamped"]).toBeUndefined();
    expect(textOf(res1)).toContain("WARNING XC_STALL_MINUTES 非法");

    const clamped: ToolDeps = { ...deps, env: { ...deps.env, XC_STALL_MINUTES: "5" } }; // < stale 30
    const res2 = await handleOverview(clamped, { view: "status" }, "conn-nobody");
    const p2 = payloadOf(res2) as Record<string, unknown>;
    expect(p2["stalledThresholdClamped"]).toBe(true);
    expect(p2["stalledThresholdFallback"]).toBeUndefined();
    expect(textOf(res2)).toContain("WARNING XC_STALL_MINUTES 低于僵尸清扫阈值");

    const ok = await view({ view: "status" }, "conn-nobody");
    const p3 = payloadOf(ok) as Record<string, unknown>;
    expect(p3["stalledThresholdFallback"]).toBeUndefined();
    expect(p3["stalledThresholdClamped"]).toBeUndefined();
  });

  // v0.8.1（29 红队 C4-O1）：XC_MEM_WARN_WATERMARK 越界（≥1/0/负数/非数字）不再静默
  // 按缺省判定——payload capacity.memWarnWatermarkFallback + 文本 WARNING 双披露。
  it("C4-O1：XC_MEM_WARN_WATERMARK 越界 → capacity payload 键 + WARNING；合法值不披露", async () => {
    await seedStatusTeam();
    const bad: ToolDeps = { ...deps, env: { ...deps.env, XC_MEM_WARN_WATERMARK: "2" } };
    const res = await handleOverview(bad, { view: "status" }, "conn-nobody");
    const payload = payloadOf(res) as { capacity: Record<string, unknown> | null };
    expect(payload.capacity).not.toBeNull();
    expect(payload.capacity!["memWarnWatermarkFallback"]).toBe(true);
    const text = textOf(res);
    expect(text).toContain("WARNING XC_MEM_WARN_WATERMARK 越界");
    // 容量行本身仍是正常渲染（水位照常展示，不因阈值越界而丢失观测）
    expect(text.split("\n")[2]).toMatch(/^capacity: (GREEN|RED) \| /);

    const ok = await view({ view: "status" }, "conn-nobody"); // GREEN_ENV 的 0.0000001 合法
    const okPayload = payloadOf(ok) as { capacity: Record<string, unknown> | null };
    expect(okPayload.capacity!["memWarnWatermarkFallback"]).toBeUndefined();
    expect(textOf(ok)).not.toContain("WARNING XC_MEM_WARN_WATERMARK");
  });
});
