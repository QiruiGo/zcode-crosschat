/**
 * v0.9.9（组 T·任务回池）定向测试：**V098-07 看门狗判死路径回池未认领单 + 告警文案**。
 *
 * 缺陷形态（reports/51-v098验收.md adv-3 i=1，P2）：看门狗判死路径只告警不回池——
 * 派给死者的未认领单（pending ∧ assignee 空 ∧ to 命中）不在 stale 清扫域
 * （SWEEPABLE 只含 claimed/in_progress）、他人 claim 得 not_assignee、死者无法认领
 * ⇒ 永久搁浅，创建者零回执；且 urgent 告警「名下任务已冻结待回池（板面
 * requeueAtMs）」对未认领单属过度承诺（板面 requeueAtMs 只覆盖 assignee 命中单）。
 * 包 ⑥ 的 watchdog.ts 对回池三原语 0 处调用、文案原样。
 *
 * 修法（reports/53-v099方案.md §一 组 T）：死亡路径调用回池（与供给失败面同款
 * repoolUnclaimedTasksForFailedMember）；告警文案对未认领单改为「已回池」真实措辞，
 * 在途单保持「冻结待回池 + requeueAtMs」。
 * 验收：猝死后未认领单回池；告警文案与板面一致。
 *
 * 本文件覆盖（engine 层，真进程 pid 死亡证据）：
 * 1. 【锚点】pid-dead 成员名下的未认领单 → 判死即回池（to 清、状态仍 pending）+
 *    创建者 task-receipt + 审计 member-unclaimed-repooled{reason:"member-dead"} +
 *    summary.unclaimedRepooled；
 * 2. 同一成员的在途单（claimed/in_progress）**不**被看门狗回池——那是 stale 清扫
 *    （30min 阈值）的职责，告警文案对在途单保持 requeueAtMs 口径；
 * 3. 告警文案分流：有未认领单回池 → 「已回池至共享待领池（创建者已收到回执）」+
 *    在途单「冻结待回池（requeueAtMs）」；无未认领单 → v0.9.6 A8 原文案逐字节保持
 *    （watchdog-v096-fixd 的 A8 回归锚点不退步）；
 * 4. 自愈：往轮已死成员（台账 dead、不再告警）**新收到**的未认领单，下一轮照常回池
 *    （dispatch 面不拒 pid-dead-but-roster-ready 成员）；
 * 5. 他人的未认领单（to=活成员）不在回池域。
 *
 * 纪律（与 watchdog-v096-fixd.test.ts 同款）：真活进程 pid（kill 出真进程死）——pid-dead
 * 是 C8 唯一进程死硬证据，不用假 pid 伪造。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeSession } from "../core/registry.js";
import { makeTask, newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import { writePeerRecord } from "../core/peerregistry.js";
import { localPidDomain } from "../core/peerdir.js";
import { pidAlive } from "../core/lock.js";
import { sweepMembersOnce, type WatchdogDeps } from "./watchdog.js";
import type { Task, TeamState } from "../core/types.js";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-v099-wd-repool-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-v099-wd-repool-peers-"));
  dirs.push(root, peerRoot);
});

afterAll(() => {
  for (const child of sleepers) child.kill();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventsOf(name: string): Array<Record<string, unknown>> {
  return readEngineEvents().filter((e) => e["event"] === name);
}

/** lead 邮箱全文（死亡告警 + 任务回执都落在 a 的邮箱）。 */
function leadMail(): string {
  const file = join(root, "teams", "default", "inbox", "a.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** lead 邮箱的**回执帧**（from=b、带 taskId；与 engine 的 urgent 告警区分）。 */
function leadReceipts(): Array<Record<string, unknown>> {
  return leadMail()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((m) => m["from"] === "b" && typeof m["taskId"] === "string")
    .map((m) => JSON.parse(m["content"] as string) as Record<string, unknown>);
}

async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

async function killSleeper(pid: number): Promise<void> {
  const child = sleepers.find((c) => c.pid === pid);
  child?.kill();
  const deadline = Date.now() + 10_000;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pidAlive(pid)).toBe(false);
}

function deps(): WatchdogDeps {
  return { stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } };
}

/** 建 lead a（活 peer 记录可寻址）+ 成员 b（指定 sid，无 peer 记录——引擎成员形态）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  team.members.push({ key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 });
  await writeTeam(root, team);
  const leadPid = await startSleeper();
  await writePeerRecord(peerRoot, {
    pid: leadPid,
    sessionId: "sess_a",
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v099-wd-lead-${leadPid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  });
}

/** 在队上追加任务（makeTask 同款落盘形态：to 预留 + assignee 空）。 */
async function addTask(input: { title: string; to?: string; createdBy: string; status?: Task["status"]; assignee?: string }): Promise<Task> {
  const team = (await readTeam(root, "default"))!;
  const task = makeTask(team, { title: input.title, prompt: "p", ...(input.to === undefined ? {} : { to: input.to }), createdBy: input.createdBy }, Date.now());
  if (input.status !== undefined) task.status = input.status;
  if (input.assignee !== undefined) task.assignee = input.assignee;
  if (input.status !== undefined || input.assignee !== undefined) {
    task.attempt = 1;
    task.attemptId = `att-${task.id}`;
  }
  await writeTeam(root, team);
  return task;
}

/** 成员 b 的崩溃形态：会话记录 pid 已亡 + running 自述悬停（无 Stop 钩子）、无 peer 记录。
 *
 * `livenessTs` 必须**新鲜**（≤ LIVENESS_TS_STALE_MS=30min，v0.9.9 V098-08 的陈旧上限：
 * coerceSessionRecord 丢超窗的 running 自述时刻 → pid 证据的 turnInProgress 不成立）——
 * 取与 lastEventTs 同龄的 90s（「刚进回合即崩」的真实形态；对无陈旧上限的旧语义同样成立）。
 * `lastEventAgeMs` 同时控制会话记录 lastEventTs 的年龄（recentLifeEvidence 的新鲜源）。 */
async function seedCrashedMember(sid: string, opts: { lastEventAgeMs?: number } = {}): Promise<void> {
  const now = Date.now();
  const ageMs = opts.lastEventAgeMs ?? 90_000;
  const deadPid = await startSleeper();
  await killSleeper(deadPid);
  await writeSession(root, {
    sessionId: sid,
    cwd: "D:\\ws",
    startedAt: now - 3_600_000,
    lastSeen: now - ageMs,
    pid: deadPid,
    liveness: "running",
    livenessTs: now - ageMs,
    lastEventTs: now - ageMs,
  });
}

// ---------------------------------------------------------------------------
// V098-07：判死路径回池 + 文案
// ---------------------------------------------------------------------------

describe("v0.9.9 V098-07：看门狗判死路径回池未认领单 + 死亡告警真实措辞", () => {
  it("【锚点】pid-dead 成员未认领单 → 判死即回池 + 创建者回执 + 审计 + summary；在途单不动（清扫职责）", async () => {
    await seedTeam();
    const unclaimed = await addTask({ title: "派给死者的单", to: "b", createdBy: "a" });
    await seedCrashedMember("sess_b", { lastEventAgeMs: 90_000 });

    // v0.10.0（组 A / R3）：二次确认——第一周期 suspect（不回池），第二周期认领 + 回池。
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual(["b"]);

    // ① 未认领单回池：to 清（共享待领池）、状态仍 pending、attempt 不动（从未被认领）。
    const team = (await readTeam(root, "default"))! as TeamState;
    const repooled = team.tasks.find((t) => t.id === unclaimed.id)!;
    expect(repooled.to).toBeUndefined();
    expect(repooled.status).toBe("pending");
    expect(repooled.assignee).toBeNull();
    expect(repooled.attempt).toBe(0);
    expect(repooled.history.at(-1)).toMatchObject({ event: "released-member-unavailable" });

    // ② 在途单**不**被看门狗回池——stale 清扫（XC_STALE_TASK_MINUTES 缺省 30min）的职责；
    //    告警文案对在途单保持 requeueAtMs 口径（板面该字段只覆盖 assignee 命中单）。
    //    v0.10.0（组 A / R3）叠一层：成员已判死之后**新出现**的在途单同样不回池（自愈面只
    //    认未认领单），且此时 open-tasks 校验如实记豁免（deathExempt）——判据可见。
    const inflight = await addTask({ title: "死者的在途单", to: "b", createdBy: "a", status: "in_progress", assignee: "b" });
    const after = await sweepMembersOnce(deps());
    expect(after.dead).toEqual([]); // 同一次死亡不重复告警
    expect(after.deathExempt).toEqual([{ key: "b", reasons: ["open-tasks"] }]);
    expect(after.unclaimedRepooled).toEqual([]); // 在途单不在判死回池域
    const stillInflight = (await readTeam(root, "default"))!.tasks.find((t) => t.id === inflight.id)!;
    expect(stillInflight.status).toBe("in_progress");
    expect(stillInflight.assignee).toBe("b");

    // ③ 创建者 a 收到 task-receipt（from=b；与 engine 的 urgent 告警同箱但可区分）。
    const receipts = leadReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!["type"]).toBe("task-receipt");
    expect(receipts[0]!["status"]).toBe("failed");
    expect(receipts[0]!["taskId"]).toBe(unclaimed.id);
    expect(String(receipts[0]!["error"])).toContain("member-dead");
    expect(String(receipts[0]!["error"])).toContain("returned to the pending pool");

    // ④ 审计：member-unclaimed-repooled{name,taskIds,reason:"member-dead"}（与供给失败面同键）。
    const repoolEvents = eventsOf("member-unclaimed-repooled");
    expect(repoolEvents).toHaveLength(1);
    expect(repoolEvents[0]!["name"]).toBe("b");
    expect(repoolEvents[0]!["reason"]).toBe("member-dead");
    expect(repoolEvents[0]!["taskIds"]).toEqual([unclaimed.id]);
    // ⑤ summary 挂账（观测面直读）。
    expect(summary.unclaimedRepooled).toEqual([{ key: "b", taskIds: [unclaimed.id] }]);

    // ⑥ 告警文案分流：未认领单「已回池」+ 任务 id + 在途单「冻结待回池（requeueAtMs）」。
    const mail = leadMail();
    expect(mail).toContain("已回池至共享待领池");
    expect(mail).toContain(unclaimed.id);
    expect(mail).toContain("创建者已收到回执");
    expect(mail).toContain("在途任务已冻结待回池");
    expect(mail).toContain("requeueAtMs");
    expect(mail).toContain("独立记账"); // v0.9.6 A8 文案面不退步
    // 文案与板面一致：repooled 单在板面上是 pending 且无 to（= 共享待领池，板面不会给它
    // requeuePending/requeueAtMs——那两项只覆盖 assignee 命中的在途单）。
    expect(repooled.to).toBeUndefined();
    expect(repooled.assignee).toBeNull();
  });

  it("无未认领单 → 零回池零审计；死亡告警保持 v0.9.6 A8 原文案（名下任务已冻结待回池）", async () => {
    await seedTeam();
    await seedCrashedMember("sess_b", { lastEventAgeMs: 90_000 });

    // v0.10.0（组 A / R3）：二次确认——suspect → 认领（此时名下无任何单）。
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual(["b"]);
    expect(summary.unclaimedRepooled).toEqual([]);
    expect(eventsOf("member-unclaimed-repooled")).toHaveLength(0);
    expect(eventsOf("watchdog-repool-failed")).toHaveLength(0);
    // 原文案锚点（watchdog-v096-fixd A8 回归同款）：未认领单缺席时不得出现「已回池」措辞。
    const mail = leadMail();
    expect(mail).toContain("名下任务已冻结待回池");
    expect(mail).toContain("requeueAtMs");
    expect(mail).not.toContain("已回池至共享待领池");
    // 判死之后新出现的死在途单：仍挂死者名下（清扫职责，不看门狗），且不被回池。
    await addTask({ title: "只有一死在途单", to: "b", createdBy: "a", status: "in_progress", assignee: "b" });
    const after = await sweepMembersOnce(deps());
    expect(after.unclaimedRepooled).toEqual([]);
    const team = (await readTeam(root, "default"))!;
    expect(team.tasks[0]!.assignee).toBe("b");
    expect(team.tasks[0]!.status).toBe("in_progress");
  });

  it("自愈：往轮已死成员（不再告警）新收到的未认领单 → 下一轮回池，且不重复死亡告警", async () => {
    await seedTeam();
    await seedCrashedMember("sess_b", { lastEventAgeMs: 90_000 });

    // 第 0 轮：suspect（v0.10.0 组 A / R3 二次确认的第一周期，无回池无告警）。
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);

    // 第 1 轮：判死 + 告警（此时名下无任何单）。
    const first = await sweepMembersOnce(deps());
    expect(first.dead).toEqual(["b"]);
    expect(first.unclaimedRepooled).toEqual([]);

    // 停机后仍有人给死者派单（dispatch 面只拒 removed/failed，不拒 pid-dead-but-ready）。
    const stranded = await addTask({ title: "死后新派单", to: "b", createdBy: "a" });
    expect(stranded.to).toBe("b");

    // 第 2 轮：同一次死亡不重复告警，但未认领单被回池（幂等自愈）。
    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(1);
    expect(second.unclaimedRepooled).toEqual([{ key: "b", taskIds: [stranded.id] }]);
    const team = (await readTeam(root, "default"))!;
    expect(team.tasks.find((t) => t.id === stranded.id)!.to).toBeUndefined();
    // 创建者收到回执（自愈面的通知闭环）。
    const receipts = leadReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!["taskId"]).toBe(stranded.id);

    // 第 3 轮：无单可回池 → 零审计零披露（幂等，不每轮刷事件）。
    const third = await sweepMembersOnce(deps());
    expect(third.unclaimedRepooled).toEqual([]);
    expect(eventsOf("member-unclaimed-repooled")).toHaveLength(1);
  });

  it("他人的未认领单（to=活成员）不在判死回池域", async () => {
    await seedTeam();
    // 队里再加一个活成员 c（活 peer 记录），它的未认领单不得被 b 的死亡带回池。
    const team = (await readTeam(root, "default"))!;
    team.members.push({ key: "c", sessionId: "sess_c", role: "worker", joinedAt: 1, lastSeen: 1 });
    await writeTeam(root, team);
    const cPid = await startSleeper();
    await writePeerRecord(peerRoot, {
      pid: cPid,
      sessionId: "sess_c",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v099-wd-c-${cPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    const bTask = await addTask({ title: "b 的派单", to: "b", createdBy: "a" });
    const cTask = await addTask({ title: "c 的派单", to: "c", createdBy: "a" });
    await seedCrashedMember("sess_b", { lastEventAgeMs: 90_000 });

    // v0.10.0（组 A / R3）：第一周期 suspect、第二周期认领并回池（回池域断言不变）
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual(["b"]);
    expect(summary.unclaimedRepooled).toEqual([{ key: "b", taskIds: [bTask.id] }]);
    const after = (await readTeam(root, "default"))!;
    expect(after.tasks.find((t) => t.id === bTask.id)!.to).toBeUndefined();
    expect(after.tasks.find((t) => t.id === cTask.id)!.to).toBe("c"); // 活成员的单原样
  });

  it("活成员的未认领单零干扰：无人死亡 → 零回池零审计（判据不误触）", async () => {
    await seedTeam();
    await addTask({ title: "正常派单", to: "b", createdBy: "a" });
    // 成员 b 活着（活 peer 记录 + 活 pid）——但注意 seedTeam 里 b 无 peer 记录且无会话记录
    // ⇒ liveness=no-record（不是 pid-dead），不触发判死回池。
    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual([]);
    expect(summary.unclaimedRepooled).toEqual([]);
    expect(eventsOf("member-unclaimed-repooled")).toHaveLength(0);
    const team = (await readTeam(root, "default"))!;
    expect(team.tasks[0]!.to).toBe("b");
    expect(team.tasks[0]!.status).toBe("pending");
  });
});
