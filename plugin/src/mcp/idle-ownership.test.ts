/**
 * v0.5.3（安全对-4 三番战 a9 修复）防回归：xc_idle 注入伪造协议帧。
 *
 * adj052 攻击原样（a9-idleforge.mjs）：普通成员 attacker 认领 victim 派发的任务
 * （停在 claimed），再 `xc_idle{completedTaskId:<该任务>, completedStatus:"completed",
 * result:"FORGED-IDLE-FRAME-2"}` → lead 邮箱收到帧内 completedStatus/result 全为
 * 调用者任意填写、无任何校验；`completedTaskId:"no-such-task-xyz"` 同样投递成功。
 *
 * 修复语义（保持帧协议可用）：
 *   ① completedTaskId 非空 → 任务必须存在（unknown_task 硬拒）；
 *   ② 且必须属于发送者（assignee === 调用者，not_task_owner 硬拒）；
 *   ③ 帧自称 completedStatus 与任务板矛盾（或 completed 无证据）→ 帧内附
 *     integrityWarning + 审计 `{event:"idle", integrityWarning:true}`（告警不硬拒）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf } from "./protocol.js";
import { createLeadToolCore, type LeadToolCore } from "./lead-tools.js";
import { identityStore } from "./identity.js";
import { readMailbox } from "../core/mailbox.js";
import { engineLogFile } from "../core/paths.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import type { TeamMember, TeamState, Task } from "../core/types.js";

let workDir: string;
let stateRoot: string;
let core: LeadToolCore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-idle-a9-"));
  stateRoot = join(workDir, ".crosschat");
  core = createLeadToolCore({ stateRoot, workspace: workDir, env: {} }); // 无 XC_WAKE_ENABLED → mailbox
});

afterEach(async () => {
  identityStore.bind("__discard__", bindIdentity("ghost", "sess-ghost")); // 防 require 泄漏到断言外
  await rm(workDir, { recursive: true, force: true });
});

function bindIdentity(name: string, sessionId: string) {
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
    joinedAt: 1,
    lastSeen: 1,
    state: "ready",
    identity: "engine",
    ...overrides,
  };
}

/** 任务种子（adj052 a9 形态：victim=a 派给 attacker=b，b 认领后停在 claimed）。 */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "7485be67-t1",
    title: "long task",
    prompt: "work slowly",
    dependsOn: [],
    status: "claimed",
    assignee: "b",
    attempt: 1,
    attemptId: "attempt-1",
    createdBy: "a",
    createdAt: 1,
    updatedAt: 1,
    result: null,
    error: null,
    evidence: [],
    history: [],
    ...overrides,
  };
}

async function seedTeamWithTasks(tasks: Task[]): Promise<TeamState> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: "a", founder: member("a"), now: 1 });
  team.members.push(member("b"), member("c"));
  team.leadKey = "a";
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

/** lead (a) 邮箱里最新 idle-notification 帧的解析结果。 */
async function leadIdleFrames(): Promise<Array<Record<string, unknown>>> {
  const mail = await readMailbox(stateRoot, "default", "a");
  return mail
    .filter((m) => m.from === "b")
    .map((m) => JSON.parse(m.content) as Record<string, unknown>)
    .filter((frame) => frame["type"] === "idle-notification");
}

describe("xc_idle completedTaskId 归属校验（a9 修复）", () => {
  it("a9 攻击重放：任务停在 claimed 且无证据时帧仍投递，但带 integrityWarning + 审计", async () => {
    await seedTeamWithTasks([task()]); // status=claimed, evidence=[]，正属 b
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));

    const res = await core.xc_idle(
      { summary: "idle check", completedTaskId: "7485be67-t1", completedStatus: "completed", result: "FORGED-IDLE-FRAME-2" },
      "conn-b",
    );
    // 帧不硬拒（P3 口径：误导面靠告警覆盖），但调用方拿到机器可读告警。
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as { delivered: string; integrityWarning?: string };
    expect(payload.delivered).toBe("mailbox");
    expect(payload.integrityWarning).toContain("7485be67-t1");
    expect(payload.integrityWarning).toContain('board status="claimed"');
    expect(payload.integrityWarning).toContain("0 evidence item(s)");

    const frames = await leadIdleFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!["completedStatus"]).toBe("completed");
    expect(frames[0]!["result"]).toBe("FORGED-IDLE-FRAME-2");
    expect(frames[0]!["integrityWarning"]).toBe(payload.integrityWarning);

    const idleEvents = (await engineEvents()).filter((e) => e["event"] === "idle");
    expect(idleEvents).toHaveLength(1);
    expect(idleEvents[0]!["integrityWarning"]).toBe(true);
  });

  it("unknown completedTaskId is rejected (adj052: no-such-task-xyz was delivered)", async () => {
    await seedTeamWithTasks([task()]);
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));

    const res = await core.xc_idle(
      { summary: "idle check 2", completedTaskId: "no-such-task-xyz", completedStatus: "completed", result: "FORGED-2" },
      "conn-b",
    );
    expect(res.isError).toBe(true);
    const err = payloadOf(res) as { error: string; taskId: string };
    expect(err.error).toBe("unknown_task");
    expect(err.taskId).toBe("no-such-task-xyz");
    expect(await leadIdleFrames()).toHaveLength(0); // 未投递
  });

  it("someone else's task is rejected (not_task_owner)", async () => {
    await seedTeamWithTasks([task({ assignee: "c", attemptId: "attempt-c" })]);
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));

    const res = await core.xc_idle(
      { summary: "steal", completedTaskId: "7485be67-t1", completedStatus: "completed", result: "STOLEN" },
      "conn-b",
    );
    expect(res.isError).toBe(true);
    const err = payloadOf(res) as { error: string; taskId: string; assignee: string | null };
    expect(err.error).toBe("not_task_owner");
    expect(err.assignee).toBe("c");
    expect(await leadIdleFrames()).toHaveLength(0);
  });

  it("unassigned (pending) task is rejected for a non-owner", async () => {
    await seedTeamWithTasks([task({ status: "pending", assignee: null, attempt: 0, attemptId: null })]);
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));

    const res = await core.xc_idle({ summary: "x", completedTaskId: "7485be67-t1" }, "conn-b");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as { error: string }).error).toBe("not_task_owner");
  });

  it("legit completed path: board status completed + evidence → no warning", async () => {
    await seedTeamWithTasks([
      task({
        status: "completed",
        result: "TV1 done as specified",
        evidence: [{ path: "C:\\evidence\\tv1.txt", sha256: "a".repeat(64), note: "tv1.txt" }],
      }),
    ]);
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));

    const res = await core.xc_idle(
      { summary: "done", completedTaskId: "7485be67-t1", completedStatus: "completed", result: "TV1 done" },
      "conn-b",
    );
    expect(res.isError).toBeUndefined();
    expect((payloadOf(res) as { integrityWarning?: string }).integrityWarning).toBeUndefined();
    const frames = await leadIdleFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!["integrityWarning"]).toBeUndefined();
    const idleEvents = (await engineEvents()).filter((e) => e["event"] === "idle");
    expect(idleEvents[0]!["integrityWarning"]).toBeUndefined();
  });

  it("legit failed path: claimed failed status matching a failed board task → no warning (evidence not required)", async () => {
    await seedTeamWithTasks([task({ status: "failed", error: "boom" })]);
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));

    const res = await core.xc_idle(
      { summary: "gave up", completedTaskId: "7485be67-t1", completedStatus: "failed", failureReason: "boom" },
      "conn-b",
    );
    expect(res.isError).toBeUndefined();
    expect((payloadOf(res) as { integrityWarning?: string }).integrityWarning).toBeUndefined();
  });

  it("board/claimed mismatch without completedStatus claim: completedTaskId alone passes silently", async () => {
    await seedTeamWithTasks([task()]); // claimed, 无 completedStatus 声明 → 无从矛盾
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));

    const res = await core.xc_idle({ summary: "paused", completedTaskId: "7485be67-t1" }, "conn-b");
    expect(res.isError).toBeUndefined();
    expect((payloadOf(res) as { integrityWarning?: string }).integrityWarning).toBeUndefined();
  });

  it("empty completedTaskId is treated as absent (frame carries null, no checks)", async () => {
    await seedTeamWithTasks([task()]);
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));

    const res = await core.xc_idle({ summary: "idle", completedTaskId: "  " }, "conn-b");
    expect(res.isError).toBeUndefined();
    const frames = await leadIdleFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!["completedTaskId"]).toBeNull();
  });
});
