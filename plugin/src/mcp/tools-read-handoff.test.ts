/**
 * v0.8.0 A2（DESIGN-V0.8.md §4 / §8 AC2）：`xc_read({scope:"handoff"})` 工具层单测。
 * 临时 stateRoot 端到端（磁盘真源），与 G1 的 tools-team-checkpoint.test.ts 同族脚手架：
 * - scope 路由 + shape；未注册 → not_registered；无 team → no_team；
 * - self/task/member 三视角七要素（payload 键集恰好、文本七章、视角行自明）；
 * - task 视角终态任务也出（复盘）；checkpoint 取受领人目录；未读按 taskId 过滤；
 * - member 视角未读只给计数（unreadWithheld）；花名清洗漂移 → checkpoint null + warnings；
 * - 非法 id → invalid_params 且附现存候选；
 * - 容量 RED/GREEN 与构造 env 一致；checkpoint 年龄按 mtime 断言；
 * - 4000 超预算 → truncated 披露 + 文本末行标注（无静默丢）；
 * - ≤3 步彩排：handoff 的 suggestions 指向的 claim 真实可达（identify→handoff→claim）。
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { payloadOf } from "./protocol.js";
import { handleRead, ReadShape } from "./tools-read.js";
import { createToolCore, type ToolDeps } from "./core.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { appendMailbox, createMessage } from "../core/mailbox.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import type { Task, TeamMember, TeamState } from "../core/types.js";
import type { ToolResult } from "./protocol.js";

/** 容量颜色钉成 GREEN（三条 red 规则都不命中），让断言确定。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};
/** 容量颜色钉成 RED（watermark < 0.99 必命中 red1）。 */
const RED_ENV = { ...GREEN_ENV, XC_MEM_WARN_WATERMARK: "0.99" };

const MIN = 60_000;
const T0 = Date.now();

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-read-handoff-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV } };
});

afterEach(async () => {
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
    joinedAt: T0 - 120 * MIN,
    lastSeen: T0 - MIN,
    state: "ready",
    identity: "engine",
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "落盘脚本改造",
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

function bind(name: string, conn: string): void {
  identityStore.bind(conn, bindIdentity(name, `sess-${name}`));
}

/** 写一份检查点文件并把 mtime 拨到 ageMin 分钟前（latestCheckpoint 按 stamp 取名、按 mtime 算年龄）。 */
async function writeCheckpoint(agentKey: string, stamp: string, ageMin: number): Promise<string> {
  const dir = join(stateRoot, "checkpoints", agentKey);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stamp}.md`);
  await writeFile(path, "---\nagent: x\n---\n", "utf8");
  const mtime = new Date(Date.now() - ageMin * MIN);
  await utimes(path, mtime, mtime);
  return path;
}

async function handoff(args: { id?: string }, conn: string): Promise<ToolResult> {
  return handleRead(deps, { scope: "handoff", ...args }, conn);
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
}

/** content[0] = 人可读文本面（接手包正文）；content[1] = JSON payload。 */
function renderLineOf(res: ToolResult): string {
  return (res.content[0] as { text?: string }).text ?? "";
}

// ---------------------------------------------------------------------------
describe("xc_read scope=handoff：路由与前置闸", () => {
  it("shape 接受 handoff（含 id 收窄）；路由到接手包", async () => {
    expect(z.object(ReadShape).safeParse({ scope: "handoff" }).success).toBe(true);
    expect(z.object(ReadShape).safeParse({ scope: "handoff", id: "t-1" }).success).toBe(true);
    await seedTeam([task({ id: "t-1", status: "in_progress", assignee: "alice" })]);
    bind("alice", "conn-alice");
    const res = await handoff({}, "conn-alice");
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toContain("视角：self");
  });

  it("未注册连接 → not_registered", async () => {
    await seedTeam([task()]);
    const res = await handoff({}, "conn-ghost");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as { error: string }).error).toBe("not_registered");
  });

  it("无 team.json → no_team（与 tools-read 其余 scope 同族）", async () => {
    bind("alice", "conn-alice");
    const res = await handoff({}, "conn-alice");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as { error: string }).error).toBe("no_team");
  });

  it("非法 id → invalid_params 且附现存 taskId/花名候选", async () => {
    await seedTeam([task({ id: "t-1" }), task({ id: "t-2" })]);
    bind("alice", "conn-alice");
    const res = await handoff({ id: "nope" }, "conn-alice");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as { error: string; message: string };
    expect(payload.error).toBe("invalid_params");
    expect(payload.message).toContain("t-1");
    expect(payload.message).toContain("t-2");
    expect(payload.message).toContain("alice"); // 花名候选
  });
});

// ---------------------------------------------------------------------------
describe("xc_read scope=handoff：self 视角七要素", () => {
  it("payload 八键（七要素 + filter）；文本七章；identity/isLead 如实", async () => {
    await seedTeam([
      task({ id: "t-a1", status: "in_progress", assignee: "alice", attempt: 2 }),
      task({ id: "t-b2", status: "blocked", assignee: "alice", blockedReason: "等审批文件", lastProgressTs: T0 - 200 * MIN }),
      task({ id: "t-c3", status: "pending", assignee: null, priority: "high", title: "补单测" }),
      task({ id: "t-done", status: "completed", assignee: "bob" }),
    ]);
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "记得先落盘再压缩", { urgent: true }));
    await appendMailbox(stateRoot, "default", "alice", createMessage("carol", "alice", "文档我看完了"));
    await appendMailbox(stateRoot, "default", "alice", createMessage("lead", "alice", JSON.stringify({ type: "tool_request", tool: "xc_claim" })));
    await writeCheckpoint("alice", "2026-11-15T18-00-00-000Z", 12);
    bind("alice", "conn-alice");

    const res = await handoff({}, "conn-alice");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as Record<string, unknown>;
    // 七要素 + filter（无 truncated/warnings/unreadWithheld——未超限、无异常）
    expect(Object.keys(payload).sort()).toEqual(
      ["capacity", "checkpoint", "filter", "identity", "pool", "suggestions", "tasks", "unread"].sort(),
    );
    // 1. 身份
    expect(payload["identity"]).toMatchObject({
      agentKey: "alice", teamId: "default", leadKey: "lead", role: "worker", memberState: "ready", isLead: false,
    });
    // 2. 我的任务（OPEN 状态 ∧ 我）
    expect((payload["tasks"] as Array<{ taskId: string; status: string }>).map((t) => `${t.taskId}:${t.status}`))
      .toEqual(["t-a1:in_progress", "t-b2:blocked"]);
    // 3. 待领池（pending 前 10；completed 不在内）
    expect((payload["pool"] as Array<{ taskId: string }>).map((t) => t.taskId)).toEqual(["t-c3"]);
    // 4. 未读（urgent 优先；tool_request 遮蔽）
    const unread = payload["unread"] as { count: number; urgentCount: number; top: Array<{ from: string; subject: string }> };
    expect(unread.count).toBe(3);
    expect(unread.urgentCount).toBe(1);
    expect(unread.top[0]).toMatchObject({ from: "bob" });
    expect(unread.top.some((t) => t.subject.includes("tool_request"))).toBe(true);
    expect(unread.top.some((t) => t.subject.includes("xc_claim"))).toBe(false);
    // 5. 容量（GREEN_ENV 钉色）
    expect(payload["capacity"]).toMatchObject({ level: "GREEN" });
    // 6. 最近检查点（mtime 12min 前）
    expect(payload["checkpoint"]).toMatchObject({ ageMin: 12 });
    // 7. 建议下一步（blocked 建议在场）
    expect((payload["suggestions"] as string[]).join("\n")).toContain("处理阻塞原因（xc_team unblock）或 cancel");
    // 文本面：七章 + 视角行 + 章节内容抽样
    const text = textOf(res);
    expect(text.startsWith("视角：self")).toBe(true);
    expect(text).toContain("## 2. 我的任务");
    expect(text).toContain("阻塞原因：等审批文件");
    expect(text).toContain("- t-c3 | high | 补单测 | 依赖 -");
  });

  it("checkpoint 缺失 → null + 文本占位（不假装有）", async () => {
    await seedTeam([task({ id: "t-a1", status: "in_progress", assignee: "alice" })]);
    bind("alice", "conn-alice");
    const res = await handoff({}, "conn-alice");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["checkpoint"]).toBeNull();
    expect(textOf(res)).toContain("（无检查点：/xc-checkpoint 可一键落盘）");
  });

  it("容量 RED（env 钉色）→ payload level RED + suggestions 带 C9 压缩建议行", async () => {
    await seedTeam([task({ id: "t-a1", status: "in_progress", assignee: "alice" })]);
    bind("alice", "conn-alice");
    const redDeps: ToolDeps = { ...deps, env: { ...RED_ENV } };
    const res = await handleRead(redDeps, { scope: "handoff" }, "conn-alice");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["capacity"]).toMatchObject({ level: "RED" });
    expect((payload["suggestions"] as string[]).join("\n")).toContain("compress-advice: 容量预警");
  });
});

// ---------------------------------------------------------------------------
describe("xc_read scope=handoff：id 三视角（§4.1 冻结表）", () => {
  it("task 视角：仅该任务一条（终态也出）；未读按 taskId 过滤；checkpoint 取受领人目录", async () => {
    await seedTeam([
      task({ id: "t-done", status: "completed", assignee: "bob" }),
      task({ id: "t-a1", status: "in_progress", assignee: "alice" }),
    ]);
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "关于 t-done 的复盘", { taskId: "t-done" }));
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "关于 t-a1 的进展", { taskId: "t-a1" }));
    await writeCheckpoint("bob", "2026-11-15T17-00-00-000Z", 180);
    bind("alice", "conn-alice");

    const res = await handoff({ id: "t-done" }, "conn-alice");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["filter"]).toEqual({ kind: "task", id: "t-done" });
    const tasks = payload["tasks"] as Array<{ taskId: string; status: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: "t-done", status: "completed" }); // 终态也出，供复盘
    const unread = payload["unread"] as { count: number; top: Array<{ subject: string }> };
    expect(unread.count).toBe(1);
    expect(unread.top[0]!.subject).toContain("复盘");
    expect(payload["checkpoint"]).toMatchObject({ ageMin: 180 }); // 受领人 bob 的目录
    expect(textOf(res)).toContain("视角：task t-done");
  });

  it("task 视角：他人 in_progress → suggestions 给 takeover/等清扫（不出走不通的 claim）", async () => {
    await seedTeam([task({ id: "t-bobs", status: "in_progress", assignee: "bob" })]);
    bind("alice", "conn-alice");
    const res = await handoff({ id: "t-bobs" }, "conn-alice");
    const suggestions = (payloadOf(res) as { suggestions: string[] }).suggestions.join("\n");
    expect(suggestions).toContain("xc_identify({takeover:true})");
    expect(suggestions).toContain("task_not_pending");
  });

  it("member 视角：未读只给计数（unreadWithheld）；checkpoint 取该成员目录", async () => {
    await seedTeam([
      task({ id: "t-bobs", status: "claimed", assignee: "bob" }),
      task({ id: "t-a1", status: "in_progress", assignee: "alice" }),
    ]);
    await appendMailbox(stateRoot, "default", "bob", createMessage("carol", "bob", "bob 的私信", { urgent: true }));
    await writeCheckpoint("bob", "2026-11-15T17-30-00-000Z", 45);
    bind("alice", "conn-alice");

    const res = await handoff({ id: "bob" }, "conn-alice");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["filter"]).toEqual({ kind: "member", id: "bob" });
    expect((payload["tasks"] as Array<{ taskId: string }>).map((t) => t.taskId)).toEqual(["t-bobs"]);
    expect(payload["unread"]).toEqual({ count: 1, urgentCount: 1, top: [] });
    expect(payload["unreadWithheld"]).toBe("subjects");
    expect(payload["checkpoint"]).toMatchObject({ ageMin: 45 });
    expect(textOf(res)).toContain("（主题不跨成员披露）");
    // 不发他人箱里的主题
    expect(textOf(res)).not.toContain("bob 的私信");
  });

  it("member 视角：花名清洗后与原文不同 → checkpoint null + warnings（不猜路径）", async () => {
    await seedTeam([task({ id: "t-bobs", status: "claimed", assignee: "bob" })]);
    await writeCheckpoint("bob", "2026-11-15T17-30-00-000Z", 45);
    bind("alice", "conn-alice");
    // "Bob" 清洗后 = "bob"（命中花名册），但与原文不同 → 漂移披露
    const res = await handoff({ id: "Bob" }, "conn-alice");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["filter"]).toEqual({ kind: "member", id: "Bob" });
    expect(payload["checkpoint"]).toBeNull();
    expect((payload["warnings"] as string[]).join("\n")).toContain("sanitizes to");
    // 任务视角仍按清洗后的花名取（bob 的开放任务）
    expect((payload["tasks"] as Array<{ taskId: string }>).map((t) => t.taskId)).toEqual(["t-bobs"]);
  });

  it("member 视角：该成员无开放任务 → 文本与 suggestions 双明示", async () => {
    await seedTeam([task({ id: "t-a1", status: "in_progress", assignee: "alice" })]);
    bind("alice", "conn-alice");
    const res = await handoff({ id: "bob" }, "conn-alice");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["tasks"]).toEqual([]);
    expect(payload["suggestions"]).toEqual(["（该成员无开放任务）"]);
    expect(textOf(res)).toContain("（该成员无开放任务）");
  });
});

// ---------------------------------------------------------------------------
describe("xc_read scope=handoff：预算与 ≤3 步可达性", () => {
  it("大任务板 → truncated 披露 + 文本末行标注（无静默丢）", async () => {
    const tasks: Task[] = [
      task({ id: "t-a1", status: "in_progress", assignee: "alice", title: "x".repeat(3000) }),
      ...Array.from({ length: 12 }, (_, i) =>
        task({ id: `t-p${i}`, status: "pending", assignee: null, title: "池".repeat(300) })),
    ];
    await seedTeam(tasks);
    bind("alice", "conn-alice");
    const res = await handoff({}, "conn-alice");
    const payload = payloadOf(res) as Record<string, unknown>;
    const truncated = payload["truncated"] as { budgetChars: number; droppedSections: string[] } | undefined;
    expect(truncated).toBeDefined();
    expect(truncated!.budgetChars).toBe(4000);
    expect(truncated!.droppedSections.length).toBeGreaterThan(0);
    // 预算只作用于文本面（content[0]）；payload 机器面另计
    expect(renderLineOf(res).length).toBeLessThanOrEqual(4000);
    expect(renderLineOf(res)).toContain("字符预算截断");
    // payload 机器面仍带全部要素（预算只裁文本）
    expect((payload["pool"] as unknown[]).length).toBe(10);
    expect(payload["tasks"]).toHaveLength(1);
  });

  it("≤3 步彩排：handoff 的 claim 建议真实可达（identify → handoff → claim）", async () => {
    await seedTeam([task({ id: "t-c3", status: "pending", assignee: null, priority: "high", title: "补单测" })]);
    bind("alice", "conn-alice");
    // 第 2 步：handoff
    const res = await handoff({}, "conn-alice");
    const suggestions = (payloadOf(res) as { suggestions: string[] }).suggestions.join("\n");
    expect(suggestions).toContain("t-c3");
    // 第 3 步：按建议直接 claim——真实可达（不得出现走不通的指令）
    const core = createToolCore(deps);
    const claimed = await core.xc_claim({ taskId: "t-c3" }, "conn-alice");
    expect(claimed.isError).toBeFalsy();
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.tasks.find((t) => t.id === "t-c3")!.assignee).toBe("alice");
    // 接手后无需再翻板面：handoff 一次拿全（无第二/第三次读面调用）
    expect((payloadOf(res) as { tasks: unknown[] }).tasks).toBeDefined();
  });

  it("checkpoint 目录按 agent 隔离：我的包不引用他人目录", async () => {
    await seedTeam([
      task({ id: "t-a1", status: "in_progress", assignee: "alice" }),
      task({ id: "t-bobs", status: "claimed", assignee: "bob" }),
    ]);
    await writeCheckpoint("alice", "2026-11-15T18-00-00-000Z", 5);
    await writeCheckpoint("bob", "2026-11-15T18-00-00-000Z", 90);
    bind("alice", "conn-alice");
    const res = await handoff({}, "conn-alice");
    const payload = payloadOf(res) as Record<string, unknown>;
    const path = String((payload["checkpoint"] as { path: string }).path);
    expect(path).toContain(join("checkpoints", "alice"));
    expect(path).not.toContain(join("checkpoints", "bob"));
    expect((payload["checkpoint"] as { ageMin: number }).ageMin).toBe(5);
    // 磁盘面：bob 的检查点文件仍在（handoff 是纯读，无副作用）
    const bobDir = await readdir(join(stateRoot, "checkpoints", "bob"));
    expect(bobDir.filter((n) => n.endsWith(".md"))).toHaveLength(1);
  });
});
