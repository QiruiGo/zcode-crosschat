/**
 * v0.9.6（组 D·A8/V095-21）定向测试：handoff 的**待回池面**（四面之三）。
 *
 * V095-21 实测（adv4-f0）：死亡成员的任务在 stale 清扫到期前不在待领池（pending），
 * `xc_read({scope:"handoff"})` §3 待领池为空——接手会话按 overview/死亡文案的指引去
 * 待领池找不到任务。修法：handoff 在七章之后如实追加「待回池」清单（文本块）+
 * payload.requeuePending（机器面），与 xc_overview 板面任务行 requeuePending/requeueAtMs、
 * Offline 行、死亡告警文案四面同口径（同一 updatedAt + stale 阈值时刻）。
 *
 * 跨面一致性锚点：本文件同时驱动 xc_overview（板面行）与 xc_read(handoff)，断言同一
 * 冻结任务在两个面的回池时刻逐字节一致（面①↔面③）。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolCore, type ToolDeps } from "./core.js";
import { handleRead } from "./tools-read.js";
import { createTeamOverviewCore } from "./tools-overview.js";
import { writeSession, refreshSessionLastSeen } from "../core/registry.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { payloadOf, type ToolResult } from "./protocol.js";
import type { TeamMember } from "../core/types.js";

/** 一个确定不存在的 pid（pidAlive → ESRCH → false）：进程死硬证据。 */
const DEAD_PID = 2_147_483_644;

interface BoardTask {
  id: string;
  status: string;
  assignee: string | null;
  updatedAt: number;
  requeuePending?: boolean;
  requeueAtMs?: number;
}

interface RequeueItem {
  taskId: string;
  assignee: string;
  status: string;
  requeueAtMs: number;
}

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-fixd-handoff-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true });
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } };
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function bind(name: string, conn: string, sid: string): void {
  const identity: BoundIdentity = {
    sessionKey: `${sid}:${name}`,
    teamId: "default",
    name,
    agentKey: name,
    sessionId: sid,
    role: "peer",
    boundAt: Date.now(),
  };
  identityStore.bind(conn, identity);
}

function rosterMember(key: string, sid: string): TeamMember {
  return { key, sessionId: sid, role: "worker", joinedAt: 1, lastSeen: 1 };
}

async function handoff(conn: string, id?: string): Promise<{ text: string; payload: Record<string, unknown> }> {
  const res = await handleRead(deps, { scope: "handoff", ...(id !== undefined ? { id } : {}) }, conn);
  expect(res.isError, JSON.stringify(payloadOf(res))).toBeFalsy();
  return {
    text: (res.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n"),
    payload: payloadOf(res) as Record<string, unknown>,
  };
}

async function seedWithCrashedMember(taskUpdatedAt: number): Promise<string> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: rosterMember("a", "sess-a"),
  });
  team.members.push(rosterMember("m1", "sess-m1"));
  team.tasks.push({
    id: "t-fixd",
    title: "冻结在途任务",
    prompt: "P",
    dependsOn: [],
    attempt: 1,
    attemptId: "att-1",
    createdBy: "a",
    createdAt: taskUpdatedAt - 60_000,
    updatedAt: taskUpdatedAt,
    result: null,
    error: null,
    evidence: [],
    history: [],
    status: "in_progress",
    assignee: "m1",
  } as never);
  await writeTeam(stateRoot, team);
  // 会话记录：lead a 活着（pid 本进程），m1 崩溃（pid 亡 + running 自述悬停）
  await writeSession(stateRoot, {
    sessionId: "sess-a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now(), pid: process.pid,
  });
  await writeSession(stateRoot, {
    sessionId: "sess-m1", cwd: workDir, startedAt: Date.now() - 3_600_000,
    lastSeen: Date.now() - 90_000, pid: DEAD_PID,
    liveness: "running", livenessTs: Date.now() - 3_600_000, lastEventTs: Date.now() - 90_000,
  });
  return "t-fixd";
}

describe("v0.9.6 A8/V095-21：handoff 待回池面（死亡成员名下的冻结任务如实列出）", () => {
  it("【方案验收锚点】杀成员后 handoff 文本块列「待回池 + 预计回池时刻」，payload.requeuePending 与板面行同刻", async () => {
    const updatedAt = Date.now() - 2 * 60_000;
    const taskId = await seedWithCrashedMember(updatedAt);
    bind("a", "conn-a", "sess-a");

    const { text, payload } = await handoff("conn-a");
    // 面③文本块：七章之后追加待回池清单（taskId/属主/状态/ISO 时刻）
    expect(text).toContain("[待回池]");
    expect(text).toContain(taskId);
    expect(text).toContain("m1");
    expect(text).toContain("in_progress");
    expect(text).toContain(new Date(updatedAt + 30 * 60_000).toISOString());
    expect(text).toContain("task_not_pending"); // 如实告知现在 claim 会失败
    // 面③机器面：payload.requeuePending 与面①（板面行）同刻
    const requeue = payload["requeuePending"] as RequeueItem[];
    expect(requeue).toEqual([
      { taskId, title: "冻结在途任务", assignee: "m1", status: "in_progress", requeueAtMs: updatedAt + 30 * 60_000 },
    ]);
    // 跨面一致性：xc_overview 板面同一任务的 requeueAtMs 逐字节一致（面①↔面③）
    const overviewRes: ToolResult = await createTeamOverviewCore(deps).xc_status({}, "conn-a");
    const boardTasks = (payloadOf(overviewRes) as Record<string, unknown>)["tasks"] as BoardTask[];
    const boardRow = boardTasks.find((t) => t.id === taskId) as BoardTask;
    expect(boardRow.requeuePending).toBe(true);
    expect(boardRow.requeueAtMs).toBe(requeue[0]!.requeueAtMs);
  });

  it("负例：无死亡成员（全员在场）→ 无 requeuePending 键、无待回池文本块（七章形状不变）", async () => {
    const updatedAt = Date.now() - 2 * 60_000;
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now: 1,
      founder: rosterMember("a", "sess-a"),
    });
    team.members.push(rosterMember("m9", "sess-m9"));
    team.tasks.push({
      id: "t-live", title: "在途", prompt: "P", dependsOn: [], attempt: 1, attemptId: "att",
      createdBy: "a", createdAt: updatedAt - 60_000, updatedAt, result: null, error: null,
      evidence: [], history: [], status: "in_progress", assignee: "m9",
    } as never);
    await writeTeam(stateRoot, team);
    await writeSession(stateRoot, {
      sessionId: "sess-a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now(), pid: process.pid,
    });
    await writeSession(stateRoot, {
      sessionId: "sess-m9", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now(), pid: process.pid,
    });
    bind("a", "conn-a", "sess-a");

    const { text, payload } = await handoff("conn-a");
    expect(payload["requeuePending"]).toBeUndefined();
    expect(text).not.toContain("[待回池]");
  });

  it("XC_STALE_TASK_MINUTES 生效值参与 handoff 侧回池时刻（与板面同 env 同源；0 新增必填配置）", async () => {
    const updatedAt = Date.now() - 2 * 60_000;
    const taskId = await seedWithCrashedMember(updatedAt);
    bind("a", "conn-a", "sess-a");
    const customDeps: ToolDeps = { stateRoot, workspace: workDir, env: { ...deps.env, XC_STALE_TASK_MINUTES: "7" } };
    const res = await handleRead(customDeps, { scope: "handoff" }, "conn-a");
    const requeue = (payloadOf(res) as Record<string, unknown>)["requeuePending"] as RequeueItem[];
    expect(requeue[0]!.taskId).toBe(taskId);
    expect(requeue[0]!.requeueAtMs).toBe(updatedAt + 7 * 60_000);
  });

  it("blocked 任务（非 stale 清扫域）不进待回池面——不会自动回池，不谎报时刻", async () => {
    const updatedAt = Date.now() - 2 * 60_000;
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now: 1,
      founder: rosterMember("a", "sess-a"),
    });
    team.members.push(rosterMember("m1", "sess-m1"));
    team.tasks.push({
      id: "t-blk", title: "暂停", prompt: "P", dependsOn: [], attempt: 1, attemptId: "att",
      createdBy: "a", createdAt: updatedAt - 60_000, updatedAt, result: null, error: null,
      evidence: [], history: [], status: "blocked", assignee: "m1", blockedReason: "等审批",
    } as never);
    await writeTeam(stateRoot, team);
    await writeSession(stateRoot, {
      sessionId: "sess-a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now(), pid: process.pid,
    });
    await writeSession(stateRoot, {
      sessionId: "sess-m1", cwd: workDir, startedAt: Date.now() - 3_600_000,
      lastSeen: Date.now() - 90_000, pid: DEAD_PID,
      liveness: "running", livenessTs: Date.now() - 3_600_000, lastEventTs: Date.now() - 90_000,
    });
    bind("a", "conn-a", "sess-a");
    const { payload, text } = await handoff("conn-a");
    expect(payload["requeuePending"]).toBeUndefined();
    expect(text).not.toContain("[待回池]");
  });
});
