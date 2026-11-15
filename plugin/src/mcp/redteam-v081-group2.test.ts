/**
 * v0.8.1 红队二十九番修复回归（本组跨面用例）：status 文本 ↔ handoff 文本的检查点年龄
 * 粒度一致（C5-BUG-C5-02）+ 年龄取数同源（C2-B4）。
 *
 * 背景（29 报告 §2.3 / merged-adjudication P3 表）：
 * - C5-BUG-C5-02：status 文本按 min/h/d 阶梯向下取整（26h → 「1d前」=1440min），而
 *   handoff 文本给精确 ageMin（「1560min 前」）——同一事实两种粒度，跨面对照时像两个
 *   检查点。PROTOCOL §14.5 散文本就承诺「年龄 min 前」。
 * - C2-B4：年龄取文件 mtime 而非 front-matter createdAt，外部拷贝/还原后两值分歧。
 *
 * 本文件用磁盘真源同时驱动两个工具面，钉死「同一 checkpoint → 同一数字同一单位」。
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleRead } from "./tools-read.js";
import { handleOverview } from "./tools-overview.js";
import { createToolCore, type ToolDeps } from "./core.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import type { Task, TeamMember } from "../core/types.js";

/** 容量颜色钉成 GREEN（三条 red 规则都不命中），让断言确定。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

const MIN = 60_000;
const T0 = Date.now();

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v081-group2-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV } };
});

afterEach(async () => {
  identityStore.bind("__discard__", {
    sessionKey: "discard:ghost", teamId: "default", name: "ghost", agentKey: "ghost",
    sessionId: "sess-ghost", role: "peer", boundAt: Date.now(),
  } satisfies BoundIdentity);
  await rm(workDir, { recursive: true, force: true });
});

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

async function seedTeam(): Promise<void> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: "lead", founder: member("lead"), now: T0 });
  team.leadKey = "lead";
  team.members.push(member("alice"), member("bob"));
  team.tasks = [task({ id: "t-a1", status: "in_progress", assignee: "alice" })];
  await writeTeam(stateRoot, team);
}

/** 写一份 front-matter createdAt = ageMin 分钟前、mtime = mtimeAgeMin 分钟前的检查点。 */
async function writeCheckpoint(agentKey: string, stamp: string, ageMin: number, mtimeAgeMin = ageMin): Promise<void> {
  const dir = join(stateRoot, "checkpoints", agentKey);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stamp}.md`);
  const createdAt = new Date(Date.now() - ageMin * MIN).toISOString();
  await writeFile(
    path,
    `---\nagent: ${agentKey}\nteam: default\nlead: (none)\ncreatedAt: ${createdAt}\n`
    + "taskCounts: {claimed:0, in_progress:0, blocked:0}\nunread: 0\n"
    + "capacity: {watermarkPct: 30.0, freeGb: 9.0, level: GREEN}\n---\n\n## 1. 身份\n",
    "utf8",
  );
  const mtime = new Date(Date.now() - mtimeAgeMin * MIN);
  await utimes(path, mtime, mtime);
}

function bind(name: string, conn: string): void {
  identityStore.bind(conn, {
    sessionKey: `sess-${name}:${name}`,
    teamId: "default",
    name,
    agentKey: name,
    sessionId: `sess-${name}`,
    role: "peer",
    boundAt: Date.now(),
  } satisfies BoundIdentity);
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
}

describe("v0.8.1 C5-BUG-C5-02: status 文本与 handoff 文本的检查点年龄同粒度", () => {
  it("26h 前的检查点：status 文本 = 1560min前（不再按天向下取整成 1d前），与 handoff 文本同数字", async () => {
    await seedTeam();
    await writeCheckpoint("alice", "2026-11-14T13-00-00-000Z", 26 * 60);
    bind("alice", "conn-alice");

    const handoff = await handleRead(deps, { scope: "handoff" }, "conn-alice");
    const status = await handleOverview(deps, { view: "status" }, "conn-alice");
    expect(handoff.isError).toBeUndefined();
    expect(status.isError).toBeUndefined();

    // handoff 文本面：精确分钟
    expect(textOf(handoff)).toMatch(/（15[5-6]\dmin 前，\d+ bytes）/);
    // status 文本面：同一事实同一粒度（旧实现此处为「1d前」=1440min，跨面分歧）
    const statusCkptLine = textOf(status).split("\n").find((l) => l.startsWith("checkpoint:"))!;
    expect(statusCkptLine).toMatch(/^checkpoint: lead=\(none\), alice=15[5-6]\dmin前, bob=\(none\)$/);
    expect(statusCkptLine).not.toMatch(/\d+d前/);
    // 两视图 payload 的 ageMin 与文本同值（三面一贯）
    const handoffAge = (payloadOf(handoff) as { checkpoint: { ageMin: number } }).checkpoint.ageMin;
    const statusAge = (payloadOf(status) as { checkpoints: { alice: { ageMin: number } } }).checkpoints.alice.ageMin;
    expect(handoffAge).toBe(statusAge);
    expect(handoffAge).toBeGreaterThanOrEqual(26 * 60 - 2);
    expect(handoffAge).toBeLessThanOrEqual(26 * 60 + 2);
  });

  it("取数同源：mtime 被外部拨新 → 两面的年龄都按 front-matter createdAt（C2-B4）", async () => {
    await seedTeam();
    await writeCheckpoint("alice", "2026-11-14T13-00-00-000Z", 26 * 60, 0); // front-matter 26h，mtime=现在
    bind("alice", "conn-alice");

    const handoff = await handleRead(deps, { scope: "handoff" }, "conn-alice");
    const status = await handleOverview(deps, { view: "status" }, "conn-alice");
    const handoffAge = (payloadOf(handoff) as { checkpoint: { ageMin: number } }).checkpoint.ageMin;
    const statusAge = (payloadOf(status) as { checkpoints: { alice: { ageMin: number } } }).checkpoints.alice.ageMin;
    expect(handoffAge).toBeGreaterThanOrEqual(26 * 60 - 2);
    expect(statusAge).toBe(handoffAge);
  });

  it("合法流程不回归：刚写的检查点 → 0min前（两面的常规形态不变）", async () => {
    await seedTeam();
    await writeCheckpoint("alice", "2026-11-15T18-00-00-000Z", 0);
    bind("alice", "conn-alice");
    const handoff = await handleRead(deps, { scope: "handoff" }, "conn-alice");
    const status = await handleOverview(deps, { view: "status" }, "conn-alice");
    expect(textOf(handoff)).toContain("（0min 前，");
    expect(textOf(status)).toContain("alice=0min前");
  });
});
