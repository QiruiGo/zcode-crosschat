/**
 * v0.8.0 A1（DESIGN-V0.8.md §3 / §8 AC1/AC6）：`xc_team({action:"checkpoint"})` 工具层单测。
 *
 * 临时 stateRoot 端到端（磁盘真源）：
 * - 文件存在 + 七章在场 + front-matter 7 键 + payload 键集；
 * - 21 份后恰 20 份（滚动）——每次调用各得一份文件（同毫秒进位）；
 * - `checkpoint_write_failed` 路径（不假装落盘）+ 无 team → `no_team` + 未注册 → `not_registered`；
 * - 成员不在花名册仍可写（身份章如实记 (not on roster)）；
 * - 未读只抄索引 + `tool_request` 帧遮蔽；审计事件 `checkpoint` / `checkpoint-write-failed`；
 * - 模型可见面双面同步：工具级 describe 与 `note` 字段级 describe 都覆盖 checkpoint；
 * - 工具面不新增：注册器只注册 xc_team 一个工具（精确集合 = 恰 10 由 legacy-removal.test.ts 断言）；
 * - 未知 action 走 zod 拒（`action:"checkpoint"` 之外的拼写错值）。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { payloadOf } from "./protocol.js";
import { handleTeam, registerTeamTools, TeamShape, type ToolDepsLike } from "./tools-team.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { appendMailbox, createMessage } from "../core/mailbox.js";
import { engineLogFile } from "../core/paths.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import type { Task, TeamMember, TeamState } from "../core/types.js";
import type { ToolDeps } from "./core.js";

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

/** 容量颜色钉成 GREEN（env 注入：三条 red 规则都不命中），让断言确定。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

const MIN = 60_000;
const T0 = Date.now();

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-team-checkpoint-"));
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
    id: "86e8b61a-t1",
    title: "落盘脚本改造",
    prompt: "p",
    dependsOn: [],
    status: "in_progress",
    assignee: "alice",
    attempt: 2,
    attemptId: "att-2",
    createdBy: "lead",
    createdAt: T0 - 60 * MIN,
    updatedAt: T0 - 20 * MIN,
    lastProgressTs: T0 - 20 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: T0 - 20 * MIN, event: "report", by: "alice" }],
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

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function bind(name: string, conn: string): void {
  identityStore.bind(conn, bindIdentity(name, `sess-${name}`));
}

// ---------------------------------------------------------------------------
describe("xc_team action=checkpoint：服务端落盘（临时 stateRoot 端到端）", () => {
  it("写盘成功：文件在场 + 七章 + front-matter 7 键 + payload 键集", async () => {
    await seedTeam([
      task({ id: "t-a1", status: "in_progress" }),
      task({ id: "t-b2", status: "blocked", blockedReason: "等审批文件", lastProgressTs: T0 - 200 * MIN, history: [{ ts: T0 - 200 * MIN, event: "report", by: "alice" }] }),
      task({ id: "t-c3", status: "pending", assignee: null, priority: "high", title: "补单测" }),
      task({ id: "t-done", status: "completed", assignee: "alice" }),
    ]);
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "记得先落盘再压缩", { urgent: true }));
    await appendMailbox(stateRoot, "default", "alice", createMessage("carol", "alice", "文档我看完了"));
    await appendMailbox(stateRoot, "default", "alice", createMessage("lead", "alice", JSON.stringify({ type: "tool_request", tool: "xc_claim" })));
    bind("alice", "conn-alice");

    const res = await handleTeam(deps, { action: "checkpoint", note: "先落盘再压缩" }, "conn-alice");
    expect(res.isError).toBeUndefined();

    // 文本一行
    const line = res.content[0]!.text;
    expect(line).toMatch(/^Checkpoint written: .+\(\d+ bytes, 2 open task\(s\), 3 unread, capacity GREEN\)\.$/);

    // payload 键集（§3.4）
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["bytes", "capacity", "createdAt", "path", "pruned", "tasks", "unread"],
    );
    expect(payload["tasks"]).toEqual([
      { taskId: "t-a1", status: "in_progress" },
      { taskId: "t-b2", status: "blocked" },
    ]);
    expect(payload["unread"]).toBe(3);
    expect(payload["capacity"]).toMatchObject({ level: "GREEN" });
    expect(typeof payload["bytes"]).toBe("number");

    // 磁盘真源：路径落在 checkpoints/<me>/，七章 + front-matter 7 键
    const path = String(payload["path"]);
    expect(path.startsWith(join(stateRoot, "checkpoints", "alice"))).toBe(true);
    expect(path.endsWith(".md")).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const headings = text.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## 1. 身份",
      "## 2. 我的进行中任务（claimed / in_progress / blocked）",
      "## 3. 待领池（前 10，priority → createdAt）",
      "## 4. 最近 journal（每任务末 5 行 + 路径）",
      "## 5. 未读摘要（urgent 优先，最多 5 条）",
      "## 6. 建议下一步",
      "## 7. note",
    ]);
    const fm = text.slice(text.indexOf("---\n") + 4, text.indexOf("\n---"));
    expect(fm.split("\n").filter((l) => l.trim() !== "").map((l) => l.split(":")[0]))
      .toEqual(["agent", "team", "lead", "createdAt", "taskCounts", "unread", "capacity"]);
    expect(fm).toContain("taskCounts: {claimed:0, in_progress:1, blocked:1}");
    expect(fm).toContain("unread: 3");
    expect(fm).toContain("level: GREEN");
    // 章节内容：我的任务 / 待领池 / 未读索引 / note
    expect(text).toContain("| t-a1 | in_progress | 落盘脚本改造 | 2 | ");
    expect(text).toContain("（阻塞原因：等审批文件）");
    expect(text).toContain("| t-c3 | high | 补单测 | - |");
    expect(text).toContain("- [urgent] bob | 记得先落盘再压缩（");
    expect(text).toContain("| [tool_request 审批门控帧]（"); // 未读索引不进 tool_request 原文
    expect(text).toContain("- t-b2：blocked 超 200min → 处理阻塞原因（xc_team unblock）或 cancel");
    expect(text).toContain("先落盘再压缩"); // 第 7 章 note
    // 审计事件 checkpoint
    const events = await engineEvents();
    const checkpoint = events.find((e) => e["event"] === "checkpoint");
    expect(checkpoint).toMatchObject({ teamId: "default", agentKey: "alice", openTasks: 2, unread: 3, pruned: 0 });
  });

  it("每 agent 保留最近 20 份：连写 21 次后恰 20 份、最旧被删", async () => {
    await seedTeam([task()]);
    bind("alice", "conn-alice");
    for (let i = 0; i < 21; i += 1) {
      const res = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
      expect(res.isError).toBeUndefined();
    }
    const names = (await readdir(join(stateRoot, "checkpoints", "alice"))).filter((n) => n.endsWith(".md"));
    expect(names).toHaveLength(20);
    const last = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    expect((payloadOf(last) as { pruned: number }).pruned).toBe(1);
  });

  it("写失败 → checkpoint_write_failed（不返回成功、不假装落盘）+ 审计", async () => {
    await seedTeam([task()]);
    bind("alice", "conn-alice");
    await import("node:fs/promises").then((fs) => fs.mkdir(stateRoot, { recursive: true }));
    await writeFile(join(stateRoot, "checkpoints"), "not a directory"); // 占住 checkpoints 路径

    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["error"]).toBe("checkpoint_write_failed");
    expect(typeof payload["message"]).toBe("string");
    const events = await engineEvents();
    expect(events.some((e) => e["event"] === "checkpoint-write-failed" && e["agentKey"] === "alice")).toBe(true);
    // 不得留下任何 .md
    const names = await readdir(join(stateRoot, "checkpoints", "alice")).catch(() => [] as string[]);
    expect(names.filter((n) => n.endsWith(".md"))).toEqual([]);
  });

  it("team.json 不存在 → no_team（与 tools-read 同族错误）", async () => {
    bind("alice", "conn-alice");
    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as { error: string }).error).toBe("no_team");
  });

  it("未注册连接 → not_registered", async () => {
    await seedTeam([task()]);
    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-ghost");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as { error: string }).error).toBe("not_registered");
  });

  it("成员不在花名册仍可写，身份章如实记 (not on roster)", async () => {
    await seedTeam([task()]);
    bind("stranger", "conn-stranger");
    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-stranger");
    expect(res.isError).toBeUndefined();
    const path = String((payloadOf(res) as { path: string }).path);
    const text = await readFile(path, "utf8");
    expect(text).toContain("role: (not on roster) | state: (not on roster)");
    // 只写自己的目录
    expect(path.startsWith(join(stateRoot, "checkpoints", "stranger"))).toBe(true);
    // 不动 team.json / 邮箱
    const team = await readTeam(stateRoot, "default");
    expect(team?.tasks[0]?.status).toBe("in_progress");
  });

  it("未读读取失败（邮箱路径被占用）→ 仍写盘，第 5 章如实记 + payload warnings[] 披露", async () => {
    await seedTeam([task()]);
    bind("alice", "conn-alice");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(stateRoot, "teams", "default", "inbox", "alice.jsonl"), { recursive: true }));

    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    expect(res.isError).toBeUndefined(); // 邮箱读取问题不毁掉检查点
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["unread"]).toBe(0);
    expect(Array.isArray(payload["warnings"])).toBe(true);
    expect(String((payload["warnings"] as string[])[0])).toContain("unread read failed");
    const text = await readFile(String(payload["path"]), "utf8");
    expect(text).toContain("（未读读取失败：");
  });

  it("副作用面干净：不写 snapshot.json、不进邮箱、不唤醒", async () => {
    await seedTeam([task()]);
    bind("alice", "conn-alice");
    await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    const names = await readdir(stateRoot);
    expect(names).not.toContain("snapshot.json");
    const teamDir = await readdir(join(stateRoot, "teams", "default"));
    expect(teamDir).not.toContain("snapshot.json");
    const inbox = await readdir(join(stateRoot, "teams", "default", "inbox")).catch(() => [] as string[]);
    expect(inbox).toEqual([]); // 无新帧入任何邮箱
  });
});

// ---------------------------------------------------------------------------
describe("xc_team action=checkpoint：模型可见面与工具面", () => {
  it("action 枚举含 checkpoint；未知拼写走 zod 拒", () => {
    expect(z.object(TeamShape).safeParse({ action: "checkpoint" }).success).toBe(true);
    expect(z.object(TeamShape).safeParse({ action: "checkpointt" }).success).toBe(false);
    expect(z.object(TeamShape).safeParse({ action: "chekpoint" }).success).toBe(false);
    expect(TeamShape.action.options).toContain("checkpoint");
  });

  it("note 字段级 describe 覆盖两个 action（member-add 审计备注 + checkpoint 第 7 章）", () => {
    // zod4 把 .describe() 存进 schema.description（模型可见面）
    const describe = (TeamShape.note as { description?: string }).description ?? "";
    expect(describe).toContain("action=member-add");
    expect(describe).toContain("action=checkpoint");
  });

  it("工具级 describe 提到 checkpoint；注册器仍只注册 xc_team 一个工具（工具面不新增）", () => {
    const registered: Array<{ name: string; description: string }> = [];
    const fakeServer = {
      tool: (name: string, description: string) => {
        registered.push({ name, description });
      },
    };
    const registry = { set: () => {} };
    registerTeamTools(fakeServer as never, deps as ToolDepsLike, {} as never, registry as never);
    expect(registered.map((r) => r.name)).toEqual(["xc_team"]);
    expect(registered[0]!.description).toContain("checkpoint");
    expect(registered[0]!.description).toContain("checkpoints/<you>/");
  });
});

// ---------------------------------------------------------------------------
// v0.8.1（29 红队 M05 / C1-B02 修复）：lead 渲染同源 + .tmp 残留清扫披露。
// ---------------------------------------------------------------------------
describe("xc_team action=checkpoint：v0.8.1 修复回归", () => {
  it("M05：无显式 leadKey → front-matter/身份章的 lead 渲染 founder（与 status/team 同源）", async () => {
    await seedTeam([task({ id: "t-a1", status: "in_progress" })]);
    const team = (await readTeam(stateRoot, "default"))!;
    delete team.leadKey; // 无显式 lead：founder（lead）读作 lead
    await writeTeam(stateRoot, team);
    bind("alice", "conn-alice");

    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    expect(res.isError).toBeUndefined();
    const text = await readFile(String((payloadOf(res) as { path: string }).path), "utf8");
    expect(text).toContain("lead: lead"); // front-matter + 身份章都不再是 (none)
    expect(text).not.toContain("lead: (none)");
  });

  it("C1-B02：残留 .tmp 被清扫且落审计 checkpoint-tmp-swept；.md 与 payload 不受影响", async () => {
    await seedTeam([task({ id: "t-a1", status: "in_progress" })]);
    const dir = join(stateRoot, "checkpoints", "alice");
    await mkdir(dir, { recursive: true });
    const stale = join(dir, "2026-11-15T17-00-00-000Z.md.999.deadbeef.tmp");
    await writeFile(stale, "x".repeat(512), "utf8");
    const old = new Date(Date.now() - 10 * 60_000); // 10min 前 → 超 60s 清扫阈值
    await utimes(stale, old, old);
    bind("alice", "conn-alice");

    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    expect(res.isError).toBeUndefined();
    // payload 冻结形状不增不减（§14.1）——披露走审计事件
    expect(Object.keys(payloadOf(res) as Record<string, unknown>).sort()).toEqual(
      ["bytes", "capacity", "createdAt", "path", "pruned", "tasks", "unread"],
    );
    const swept = (await engineEvents()).filter((e) => e["event"] === "checkpoint-tmp-swept");
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ teamId: "default", agentKey: "alice", removed: 1 });
    const left = await readdir(dir);
    expect(left.filter((n) => n.endsWith(".tmp"))).toEqual([]); // 在途/残留 temp 都不剩
    expect(left.filter((n) => n.endsWith(".md"))).toHaveLength(1); // 本轮检查点在场
  });

  it("C1-B01：同刻并发 6 次调用各得一份文件（工具层排他落盘，无静默覆写）", async () => {
    await seedTeam([task({ id: "t-a1", status: "in_progress" })]);
    bind("alice", "conn-alice");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => handleTeam(deps, { action: "checkpoint" }, "conn-alice")),
    );
    const paths = results.map((r) => String((payloadOf(r) as { path: string }).path));
    expect(new Set(paths).size).toBe(6);
    const dir = join(stateRoot, "checkpoints", "alice");
    expect((await readdir(dir)).filter((n) => n.endsWith(".md"))).toHaveLength(6);
  });
});
