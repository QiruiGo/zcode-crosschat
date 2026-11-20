/**
 * v0.9.2 组 C（C4）：`xc_overview` view:"panel" 任务计数口径——三桶改七态。
 *
 * 缺口事实（方案 C4 + 验收锚点「panel 与 team/status 面数值可对账」）：v0.9.1 及以前
 * panel 的 `tasks` 只有 `{pending, inProgress, done}` 三桶——`completed`/`failed`/`cancelled`
 * 被并成 `done`、`claimed`/`blocked` 无键可落；同一时刻 status 视图给七态、team 板面按
 * 七态排序呈现，三个面对不上账（lead 看到「done 3」无法知道是 3 个完成还是 1 完成 + 1 失败
 * + 1 取消；blocked 任务在 panel 完全不可见）。
 *
 * 覆盖面：
 * - payload `tasks` 七态全量、键集恒为 TASK_STATUSES（缺的记 0，形状稳定）；
 * - 文本 `tasks:` 行与 payload **同源同格式**（与 status 视图 tasks 行逐字同构，可对账）；
 * - 三桶时代的 `done`/`inProgress` 键不复存在（claimed/blocked 单列在场）；
 * - 跨面对账：panel == status == team.tasks 真实分布；
 * - 无 team → 七态全 0（不缺键）。
 *
 * 纪律：不跑全量单测（脚本统一恰跑一次）；本文件只测组 C 自有面。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { resetPeerServicesForTests } from "./peer-services.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { TASK_STATUSES, type Task, type TaskStatus, type TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";

/** 容量颜色钉成 GREEN（三条 red 规则都不命中；panel 也挂 capacity 块，与本题无关但要稳）。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

const T0 = Date.now();
const MIN = 60_000;

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v092-panel-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true }); // 空 peer 根：无活 peer
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot } };
});

afterEach(async () => {
  // panel 走 getPeerServices 的**进程级单例**（首调用的 deps 定死 stateRoot）——每个用例
  // 换临时状态根前必须重置，否则 agents() 读的是上一个用例的 stateRoot（已删除）→ 全 0。
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

function task(id: string, status: TaskStatus): Task {
  return {
    id,
    title: `任务 ${id}`,
    prompt: "p",
    dependsOn: [],
    status,
    assignee: status === "pending" ? null : "alice",
    attempt: status === "pending" ? 0 : 1,
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

/** 七态各来一单 + 一单重复（in_progress ×2）——分布可对账。 */
const SEVEN_STATE_TASKS: Task[] = [
  task("t-pending", "pending"),
  task("t-claimed", "claimed"),
  task("t-ip-1", "in_progress"),
  task("t-ip-2", "in_progress"),
  task("t-blocked", "blocked"),
  task("t-completed", "completed"),
  task("t-failed", "failed"),
  task("t-cancelled", "cancelled"),
];

const EXPECTED_COUNTS = {
  pending: 1,
  claimed: 1,
  in_progress: 2,
  blocked: 1,
  completed: 1,
  failed: 1,
  cancelled: 1,
};

async function seedTeam(tasks: Task[] = SEVEN_STATE_TASKS): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    name: "default",
    founderKey: "lead",
    founder: member("lead"),
    now: T0,
  });
  team.leadKey = "lead";
  team.members.push(member("alice"), member("bob"));
  team.tasks = tasks;
  await writeTeam(stateRoot, team);
}

function textOf(res: ToolResult): string {
  return (res.content[0] as { text?: string }).text ?? "";
}

function panelTasksLine(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("tasks: "));
  if (line === undefined) throw new Error(`panel 文本缺 tasks 行：\n${text}`);
  return line;
}

describe("v0.9.2 C4：panel 任务计数改七态（与 status/team 面可对账）", () => {
  it("payload tasks 七态全量且与构造的 team 逐项相等", async () => {
    await seedTeam();
    const res = await handleOverview(deps, { view: "panel" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["tasks"]).toEqual(EXPECTED_COUNTS);
    // 键集恒为七态（不按出现过的状态动态增减）。
    expect(Object.keys(payload["tasks"] as Record<string, number>).sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("文本 tasks 行与 payload 同源同格式（与 status 视图 tasks 行同构）", async () => {
    await seedTeam();
    const panel = await handleOverview(deps, { view: "panel" }, "conn-nobody");
    const status = await handleOverview(deps, { view: "status" }, "conn-nobody");
    const panelLine = panelTasksLine(textOf(panel));
    const statusLine = textOf(status).split("\n").find((l) => l.startsWith("tasks: "))!;
    // 同格式：`tasks: pending 1 / claimed 1 / … / cancelled 1`（status 行尾多 `| stalled N`）。
    expect(panelLine).toBe(
      "tasks: pending 1 / claimed 1 / in_progress 2 / blocked 1 / completed 1 / failed 1 / cancelled 1",
    );
    expect(statusLine.startsWith(panelLine)).toBe(true);
  });

  it("三桶时代的 done/inProgress 键不复存在；claimed/blocked 单列在场", async () => {
    await seedTeam();
    const payload = payloadOf(await handleOverview(deps, { view: "panel" }, "conn-nobody")) as Record<string, unknown>;
    const tasks = payload["tasks"] as Record<string, number>;
    expect(tasks["done"]).toBeUndefined();
    expect(tasks["inProgress"]).toBeUndefined();
    expect(tasks["claimed"]).toBe(1);
    expect(tasks["blocked"]).toBe(1);
  });

  it("跨面对账：panel == status taskCounts == team.tasks 真实分布", async () => {
    await seedTeam();
    const panelPayload = payloadOf(await handleOverview(deps, { view: "panel" }, "conn-nobody")) as Record<string, unknown>;
    const statusPayload = payloadOf(await handleOverview(deps, { view: "status" }, "conn-nobody")) as Record<string, unknown>;
    expect(panelPayload["tasks"]).toEqual(statusPayload["taskCounts"]);
    // 真实分布（不经过任何观测面）：按 team.tasks[].status 现数。
    const actual: Record<string, number> = {};
    for (const t of SEVEN_STATE_TASKS) actual[t.status] = (actual[t.status] ?? 0) + 1;
    expect(panelPayload["tasks"]).toEqual(actual);
    // 总数守恒：七态之和 = 任务条数（三桶时代 done 桶吞掉三个终态，也能守恒但不可分辨）。
    const sum = Object.values(panelPayload["tasks"] as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBe(SEVEN_STATE_TASKS.length);
  });

  it("无 team.json → 七态全 0（不缺键，形状稳定）", async () => {
    const res = await handleOverview(deps, { view: "panel" }, "conn-nobody");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["tasks"]).toEqual({
      pending: 0, claimed: 0, in_progress: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0,
    });
    expect(panelTasksLine(textOf(res))).toBe(
      "tasks: pending 0 / claimed 0 / in_progress 0 / blocked 0 / completed 0 / failed 0 / cancelled 0",
    );
  });

  it("文档登记：PROTOCOL 声明 panel 七态口径", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const protocol = readFileSync(join(repoRoot, "docs", "PROTOCOL.md"), "utf8");
    expect(protocol).toContain("C4 panel 口径");
    expect(protocol).toContain("七态全量");
    expect(protocol).toContain("可对账");
  });
});
