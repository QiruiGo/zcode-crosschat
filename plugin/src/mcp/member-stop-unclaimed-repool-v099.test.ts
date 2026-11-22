/**
 * v0.9.9（组 T·任务回池）定向测试：**V098-06 member-stop 未认领单回池**。
 *
 * 缺陷形态（reports/51-v098验收.md adv-3 i=0，P2）：member-stop 只收回**已认领**在途
 * 单（memberOpenTasks → revokeAttempt），派了没人领的单（pending ∧ assignee 空 ∧ to
 * 命中）永久搁浅——他人 claim 得 not_assignee（to 硬闸）、停机成员无法认领、pending
 * 不在 stale 清扫域（SWEEPABLE 只含 claimed/in_progress）、创建者零回执。包 ⑥ 的
 * tools-team.ts 对回池三原语 0 处调用（唯一调用点是 provision.ts 的供给失败 catch）。
 *
 * 修法（reports/53-v099方案.md §一 组 T）：回池判据改用 to；member-stop 时把该成员
 * 未认领单回池 + 通知创建者 + 审计 member-unclaimed-repooled。
 * 验收：停机后未认领单回池；创建者收到回执。
 *
 * 本文件覆盖（mcp 工具面，磁盘真源）：
 * 1. 【锚点】停机 → 未认领单回池（to 清、状态仍 pending、attempt 不动）+ 在途单照常
 *    收回（attempt+1）+ 创建者收到两张 task-receipt（未认领单的 error 说明
 *    member-stopped + 已回池）；
 * 2. 审计双落：member-stopped（附 repooledUnclaimedTasks）+ member-unclaimed-repooled
 *    {name,taskIds,reason:"member-stopped"}；
 * 3. 回执面：payload repooledUnclaimed + 文本行「unclaimed tasks returned to the
 *    pending pool」（不变式 5：回池事实不得虚报，空 = none 逐字节旧行为）；
 * 4. 归属精确：别人的未认领单（to=mateb）不动；
 * 5. 回池即共享待领池：他人（mateb）可认领该单（to 硬闸解除）；
 * 6. 无未认领单 → 零回池审计、payload 空数组、停止照常成功（旧行为逐字节保持）；
 * 7. 非 lead / 不存在成员的失败路径仍零副作用（V092R-08 不退步）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore } from "./core.js";
import { createMemberToolCore } from "./tools-team.js";
import { identityStore } from "./identity.js";
import { makeTask, readTeam, writeTeam } from "../core/teamstate.js";
import type { Task, TeamMember, TeamState } from "../core/types.js";
import type { ToolDeps } from "./core.js";

const dirs: string[] = [];
let stateRoot = "";
let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-v099-stop-repool-"));
  stateRoot = join(workDir, ".crosschat");
  dirs.push(workDir);
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

function deps(): ToolDeps {
  // XC_WAKE_ENABLED=false：本测试只验证任务回池/回执/审计，不驱动唤醒 spawn。
  return { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: join(workDir, "peers-root"), XC_WAKE_ENABLED: "false" } };
}

/** lead（ldr1）+ 成员 b/mateb（sessionId 置空 ⇒ member-stop 的收尾唤醒走 skipped）。 */
function teamWith(members: TeamMember[], tasks: Task[] = []): TeamState {
  return {
    teamId: "default",
    name: "default",
    founderKey: "ldr1",
    leadKey: "ldr1",
    phase: "open",
    members,
    tasks,
    seq: 0,
    createdAt: 1,
  };
}

function member(key: string, state: TeamMember["state"]): TeamMember {
  return { key, sessionId: "", role: "worker", identity: "engine", joinedAt: 1, lastSeen: 1, state };
}

async function bindConn(key: string): Promise<string> {
  const conn = `conn-${key}`;
  identityStore.bind(conn, {
    sessionKey: `xc:default:${key}`, teamId: "default", name: key, agentKey: key,
    sessionId: `sess-${key}`, role: "worker", boundAt: Date.now(),
  });
  return conn;
}

/** 一张**未认领**派单（pending ∧ assignee 空 ∧ to 命中；xc_dispatch 带 to 的落盘形态）。 */
function unclaimedFixture(id: string, to: string, createdBy: string): Task {
  const now = Date.now();
  return {
    id,
    title: `派单 ${id}`,
    prompt: "p",
    dependsOn: [],
    status: "pending",
    assignee: null,
    attempt: 0,
    attemptId: null,
    createdBy,
    createdAt: now - 60_000,
    updatedAt: now - 30_000,
    lastProgressTs: now - 30_000,
    result: null,
    error: null,
    evidence: [],
    history: [],
    to,
  };
}

/** 一张 assignee=b 的在途任务（in_progress ∈ OPEN_TASK_STATUSES；既有收回路径的域）。 */
function claimedFixture(id: string, assignee: string): Task {
  const now = Date.now();
  return {
    id,
    title: `在途 ${id}`,
    prompt: "p",
    dependsOn: [],
    status: "in_progress",
    assignee,
    attempt: 1,
    attemptId: `att-${id}`,
    createdBy: "ldr1",
    createdAt: now - 60_000,
    updatedAt: now - 20_000,
    lastProgressTs: now - 20_000,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: now - 20_000, event: "report", by: assignee }],
  };
}

/** 建队（ldr1 lead + b/mateb）并绑定 lead / b / mateb 连接身份。 */
async function seedTeam(tasks: Task[] = []): Promise<{ leadConn: string; bConn: string; matebConn: string }> {
  await writeTeam(stateRoot, teamWith([member("ldr1", "ready"), member("b", "ready"), member("mateb", "ready")], tasks));
  return {
    leadConn: await bindConn("ldr1"),
    bConn: await bindConn("b"),
    matebConn: await bindConn("mateb"),
  };
}

function stopCore(): ReturnType<typeof createMemberToolCore> {
  return createMemberToolCore(deps());
}

async function stopAs(conn: string, name: string, archive?: boolean): Promise<ToolResult> {
  return stopCore().xc_member_stop({ name, ...(archive === undefined ? {} : { archive }) }, conn);
}

function taskCore(): ToolCore {
  return createToolCore(deps());
}

function engineEvents(): Array<Record<string, unknown>> {
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventsOf(name: string): Array<Record<string, unknown>> {
  return engineEvents().filter((e) => e["event"] === name);
}

// ---------------------------------------------------------------------------
// V098-06：停机面未认领单回池
// ---------------------------------------------------------------------------

describe("v0.9.9 V098-06：member-stop 把未认领单回池 + 通知创建者 + 审计", () => {
  it("【锚点】停机 → 未认领单回池（to 清/状态不动/attempt 不动）+ 在途单照常收回 + 创建者两张回执", async () => {
    const unclaimedId = "u-t1";
    const claimedId = "c-t1";
    const { leadConn } = await seedTeam([unclaimedFixture(unclaimedId, "b", "ldr1"), claimedFixture(claimedId, "b")]);

    const res = await stopAs(leadConn, "b");
    expect(res.isError).toBeFalsy();

    // ① 任务板：未认领单回池（to 清 = 共享待领池、状态仍 pending、attempt 不动——
    //    从未被认领过，不像在途单那样 attempt+1）；在途单照常收回。
    const team = (await readTeam(stateRoot, "default"))!;
    const unclaimed = team.tasks.find((t) => t.id === unclaimedId)!;
    expect(unclaimed.to).toBeUndefined();
    expect(unclaimed.status).toBe("pending");
    expect(unclaimed.assignee).toBeNull();
    expect(unclaimed.attempt).toBe(0);
    expect(unclaimed.history.at(-1)).toMatchObject({ event: "released-member-unavailable", by: "ldr1" });
    const claimed = team.tasks.find((t) => t.id === claimedId)!;
    expect(claimed.status).toBe("pending");
    expect(claimed.assignee).toBeNull();
    expect(claimed.attempt).toBe(2); // revokeAttempt：attempt 代数 +1
    expect(team.members.find((m) => m.key === "b")?.state).toBe("removed");

    // ② 创建者 ldr1 收到两张 task-receipt（未认领单 + 在途单各一）。
    const inbox = await import("../core/mailbox.js").then((m) => m.readMailbox(stateRoot, "default", "ldr1"));
    const receipts = inbox.filter((m) => m.taskId !== undefined);
    expect(receipts.map((r) => r.taskId).sort()).toEqual([claimedId, unclaimedId].sort());
    const unclaimedReceipt = receipts.find((r) => r.taskId === unclaimedId)!;
    const frame = JSON.parse(unclaimedReceipt.content) as Record<string, unknown>;
    expect(frame["type"]).toBe("task-receipt");
    expect(frame["status"]).toBe("failed");
    expect(unclaimedReceipt.from).toBe("b");
    expect(String(frame["error"])).toContain("member-stopped");
    expect(String(frame["error"])).toContain("returned to the pending pool");
    // 未认领单回执的 sourceTaskStatus = pending（与在途单回执的 claimed 快照不同族）。
    expect(unclaimedReceipt.sourceTaskStatus).toBe("pending");
    expect(unclaimedReceipt.sourceTaskId).toBe(unclaimedId);

    // ③ 审计双落：member-stopped（附回池事实）+ member-unclaimed-repooled（方案点名）。
    const stopped = eventsOf("member-stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!["revokedTasks"]).toEqual([claimedId]);
    expect(stopped[0]!["repooledUnclaimedTasks"]).toEqual([unclaimedId]);
    const repooled = eventsOf("member-unclaimed-repooled");
    expect(repooled).toHaveLength(1);
    expect(repooled[0]!["name"]).toBe("b");
    expect(repooled[0]!["reason"]).toBe("member-stopped");
    expect(repooled[0]!["taskIds"]).toEqual([unclaimedId]);

    // ④ 回执面：payload + 文本行如实披露（不变式 5）。
    const payload = payloadOf(res) as {
      repooledUnclaimed: { taskId: string; title: string }[];
      revokedTasks: { taskId: string }[];
    };
    expect(payload.repooledUnclaimed).toEqual([{ taskId: unclaimedId, title: `派单 ${unclaimedId}` }]);
    expect(payload.revokedTasks.map((r) => r.taskId)).toEqual([claimedId]);
    expect(String(res.content[0]!.text)).toContain("unclaimed tasks returned to the pending pool: u-t1");
    expect(String(res.content[0]!.text)).toContain("requeued tasks: c-t1");
  });

  it("回池即共享待领池：他人（mateb）可认领该单（to 硬闸解除）", async () => {
    const unclaimedId = "u-t2";
    const { leadConn, matebConn } = await seedTeam([unclaimedFixture(unclaimedId, "b", "ldr1")]);

    // 停机前：mateb 抢认得 not_assignee（to 硬闸）——证明回池前该单确实被锁死。
    const before = await taskCore().xc_claim({ taskId: unclaimedId }, matebConn);
    expect(before.isError).toBe(true);
    expect((payloadOf(before) as { error: string }).error).toBe("not_assignee");

    expect((await stopAs(leadConn, "b")).isError).toBeFalsy();

    // 停机后：同一张单回到共享待领池，mateb 认领成功（拿到 attempt 令牌）。
    const after = await taskCore().xc_claim({ taskId: unclaimedId }, matebConn);
    expect(after.isError).toBeFalsy();
    const payload = payloadOf(after) as { taskId: string; attemptId: string; attempt: number };
    expect(payload.taskId).toBe(unclaimedId);
    expect(typeof payload.attemptId).toBe("string");
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === unclaimedId)!;
    expect(task.status).toBe("claimed");
    expect(task.assignee).toBe("mateb");
    expect(task.to).toBeUndefined();
  });

  it("归属精确：别人的未认领单（to=mateb）不受停机影响", async () => {
    const mineId = "u-t3";
    const otherId = "u-t4";
    const { leadConn } = await seedTeam([
      unclaimedFixture(mineId, "b", "ldr1"),
      unclaimedFixture(otherId, "mateb", "ldr1"),
    ]);

    expect((await stopAs(leadConn, "b")).isError).toBeFalsy();

    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.tasks.find((t) => t.id === mineId)!.to).toBeUndefined();
    // 别人的单原样：to 仍在、状态仍 pending、无 released history。
    const other = team.tasks.find((t) => t.id === otherId)!;
    expect(other.to).toBe("mateb");
    expect(other.status).toBe("pending");
    expect(other.history).toHaveLength(0);
    // 审计只记被停成员那一张。
    expect(eventsOf("member-unclaimed-repooled")[0]!["taskIds"]).toEqual([mineId]);
  });

  it("无未认领单 → 零回池审计 + payload 空数组 + 停止照常成功（旧行为逐字节保持）", async () => {
    const claimedId = "c-t2";
    const { leadConn } = await seedTeam([claimedFixture(claimedId, "b")]);

    const res = await stopAs(leadConn, "b");
    expect(res.isError).toBeFalsy();
    expect(eventsOf("member-unclaimed-repooled")).toHaveLength(0);
    const payload = payloadOf(res) as { repooledUnclaimed: unknown[] };
    expect(payload.repooledUnclaimed).toEqual([]);
    expect(String(res.content[0]!.text)).toContain("unclaimed tasks returned to the pending pool: none");
    // 在途单收回照旧（attempt+1）。
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.tasks.find((t) => t.id === claimedId)!.attempt).toBe(2);
  });

  it("停机原因进回执 error（reason 透传）且成员 removed 终态不变", async () => {
    const unclaimedId = "u-t5";
    const { leadConn } = await seedTeam([unclaimedFixture(unclaimedId, "b", "ldr1")]);

    const res = await stopAs(leadConn, "b", false);
    expect(res.isError).toBeFalsy();
    const inbox = await import("../core/mailbox.js").then((m) => m.readMailbox(stateRoot, "default", "ldr1"));
    const frame = JSON.parse(inbox.find((m) => m.taskId === unclaimedId)!.content) as Record<string, unknown>;
    expect(String(frame["error"])).toContain("member-stopped");
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "b")?.state).toBe("removed");
    expect(team.members.find((m) => m.key === "b")?.stopReason).toBeUndefined();
  });

  it("失败路径不退步：非 lead stop → not_lead 且零回池零审计（V092R-08 纪律保持）", async () => {
    const unclaimedId = "u-t6";
    const { bConn } = await seedTeam([unclaimedFixture(unclaimedId, "b", "ldr1")]);

    const res = await stopAs(bConn, "b", false);
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as { error: string }).error).toBe("not_lead");
    // 未认领单原样（to 仍在），零审计行。
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.tasks.find((t) => t.id === unclaimedId)!.to).toBe("b");
    expect(engineEvents()).toEqual([]);
  });

  it("回归：makeTask 派单形态（to 落盘 + 无 assignee）正是本修复的判据输入", () => {
    // 判据锚点：xc_dispatch 带 to 建单 = pending ∧ assignee 空 ∧ to 命中（makeTask 同款）。
    const team = teamWith([member("ldr1", "ready"), member("b", "ready")]);
    const task = makeTask(team, { title: "t", prompt: "p", to: "b", createdBy: "ldr1" }, 1_000);
    expect(task.status).toBe("pending");
    expect(task.assignee).toBeNull();
    expect(task.to).toBe("b");
  });
});
