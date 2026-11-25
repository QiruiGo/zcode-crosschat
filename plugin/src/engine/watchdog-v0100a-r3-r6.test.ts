/**
 * v0.10.0（组 A·看门狗与活性）定向测试：需求书 R3 / R5 / R6（GAP G-24 / G-29）。
 *
 * 锚点（任务书原文逐条）：
 * - **A1 / R3（最高优先）判亡前四道校验**：① 在途唤醒（生命周期账未写 exit，或 spawn 后
 *   60s 内没见到 session-running；以唤醒子 pid / 最新注册 pid 为准）∨ ② 成员名下
 *   claimed/in_progress 任务（在途即活）∨ ③ 记录 pid 亡但注册表已有更新的活 pid ——
 *   任一命中即不发 member-dead、不回池（落 `suspect-dead` 审计）；④ **连续两个扫描
 *   周期都判死才发 member-dead 并执行回池**（二次确认）。真正掉线（无在途、无在途回合、
 *   pid 亡、连续两周期）仍能检出并回池；
 * - **A2 / R6 注册表活性可信**：member-dead 后 sessions/<sid>.json 的 liveness 立即翻
 *   dead 并落盘（与 engine.jsonl 的 member-dead 双写一致）；重新 register 后翻回
 *   running；livenessTs 随引擎事件刷新（不再「冻结而 lastEventTs 新鲜」）；
 * - **A3 / R5 lead 不被拉成无头分身**：member-dead 告警对 lead 只写 urgent 邮箱、不调用
 *   attemptWake（XC_WATCHDOG_WAKE_LEAD 缺省不设；设为 "1" 恢复旧行为），事件如实记下
 *   「是否尝试过唤醒」；
 * - **A4 / R2 后半 补醒**：成员空闲（最近引擎事件 session-idle 且无在途回合）∧ 无在途
 *   唤醒 ∧ 收件箱有未读派单 → 按普通派单场景补一次唤醒（scene=dispatch-resume，容量闸
 *   照常、紧急不豁免），同一成员一个冷却窗内最多一次（XC_DISPATCH_RESUME_COOLDOWN_MS
 *   可覆盖，缺省 120s）；
 * - **告警文案职能段**：member-dead 邮箱文案在成员名后带 duty 一句话（组 D 字段；控制
 *   字符清掉、最多 60 字符；absent 不带）。
 *
 * 纪律（与 watchdog.test.ts 同款）：真活进程 pid（pid-dead 是 C8 唯一进程死硬证据）；
 * 唤醒 spawn 不注入——看门狗自己调 attemptWake，测试用「唤醒闸关闭」让它必然不 spawn
 * （attemptWake 在闸处如实降级并留 wake-skipped{scene} 痕，足以验证 scene 与决策面）。
 */
import { existsSync, appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import { makeTask, newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import {
  anchorSessionForRegister,
  clearSessionDead,
  createWakeNonce,
  markSessionDead,
  markSessionHeartbeat,
  readSession,
  writeSession,
} from "../core/registry.js";
import { writePeerRecord } from "../core/peerregistry.js";
import { localPidDomain } from "../core/peerdir.js";
import { pidAlive } from "../core/lock.js";
import { sessionDeathGuard } from "../core/offline.js";
import { wakeLifecycleFile } from "../core/paths.js";
import type { SessionRecord, TeamState } from "../core/types.js";
import {
  DISPATCH_RESUME_COOLDOWN_DEFAULT_MS,
  RESUME_SCENE_DISPATCH,
  RESUME_SCENE_REPORT,
  URGENT_RECEIPT_WAKE_DEFERRED,
  dispatchResumeCooldownMsFromEnv,
  dutySnippet,
  isTaskReceiptMessage,
  isUnreadDispatchMessage,
  isUrgentReceiptMessage,
  sweepMembersOnce,
  watchdogWakeLeadFromEnv,
  type WatchdogDeps,
} from "./watchdog.js";
import { readWatchdogState } from "./watchdog-state.js";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wd-v0100a-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-wd-v0100a-peers-"));
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

/** lead 邮箱全文（死亡告警落 a 的邮箱）。 */
function leadMail(): string {
  const file = join(root, "teams", "default", "inbox", "a.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

async function killSleeper(pid: number): Promise<void> {
  sleepers.find((c) => c.pid === pid)?.kill();
  const deadline = Date.now() + 10_000;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pidAlive(pid)).toBe(false);
}

/** 建 lead a（活 peer 记录可寻址）+ 成员 b（无 peer 记录的引擎成员形态）。 */
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
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v0100a-lead-${leadPid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  });
}

/** 成员 b 的崩溃形态：会话记录 pid 已亡 + running 自述悬停（无 Stop 钩子）、无 peer 记录。 */
async function seedCrashedMember(sid = "sess_b", opts: { lastEventAgeMs?: number } = {}): Promise<void> {
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

function deps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    stateRoot: root,
    workspace: "D:\\ws",
    env: { XC_MESSAGING_DIR: peerRoot },
    ...overrides,
  };
}

/** 往一名成员的收件箱落一条**未读派单**（task-assignment：带 taskId、无 readAt）。 */
async function seedUnreadDispatch(taskId: string): Promise<string> {
  const message = createMessage("a", "b", `派单 ${taskId}`, { taskId, deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

/**
 * 往成员 b 的收件箱落一条**未读紧急回执**（组 B 形态：content = task-receipt JSON 帧，
 * extras 带 urgent:true；`marker` = 帧上再打待补醒标记 `wakeDeferred`——组 B「补充」一节的
 * 正式位置是 **content 帧内**（top-level 白名单会拷掉它），无 urgent 旗标时靠它识别）。
 */
async function seedUnreadUrgentReceipt(taskId: string, opts: { marker?: boolean; urgent?: boolean } = {}): Promise<string> {
  const content = JSON.stringify({
    type: "task-receipt",
    teamId: "default",
    taskId,
    attemptId: `att-${taskId}`,
    status: "in_progress",
    result: "半截要点：批量预演已过 3/9",
    error: null,
    evidence: [],
    ...(opts.marker === true ? { wakeDeferred: "recipient-turn-running" } : {}),
  });
  const message = createMessage("a", "b", content, {
    taskId,
    sourceTaskId: taskId,
    sourceTaskStatus: "in_progress",
    deliveryClaimedAt: Date.now(),
    ...(opts.urgent !== false ? { urgent: true } : {}),
  });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

/** 落一条**非紧急** task-receipt（无 urgent、无标记）——不应触发补醒。 */
async function seedPlainReceipt(taskId: string): Promise<string> {
  const content = JSON.stringify({ type: "task-receipt", teamId: "default", taskId, status: "failed" });
  const message = createMessage("a", "b", content, { taskId, sourceTaskId: taskId, sourceTaskStatus: "failed", deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

/** 往板面加一张 pending 未认领单（to=b；isCurrentMail 要求任务在场）。 */
async function seedPendingTask(title = "派给 b 的单"): Promise<string> {
  const team = (await readTeam(root, "default"))! as TeamState;
  const task = makeTask(team, { title, prompt: "p", to: "b", createdBy: "a" }, Date.now());
  await writeTeam(root, team);
  return task.id;
}

  /** 成员 b 的空闲形态：Stop 钩子后的 idle 自述 + 引擎证言 idle（无在途回合）。 */
  async function seedIdleMember(): Promise<void> {
    const now = Date.now();
    const livePid = await startSleeper(); // 宿主进程活着（回合间隙零专属进程的活形态）
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 60_000,
      pid: livePid, liveness: "idle", livenessTs: now - 60_000, lastEventTs: now - 60_000,
    });
    const { writeSessionWitness } = await import("../core/registry.js");
    await writeSessionWitness(root, "sess_b", "idle", now - 60_000);
  }

// ─────────────────────── A1 / R3：判亡前四道校验 ───────────────────────

describe("v0.10.0 A1/R3：判亡前四道校验（G-29 误判亡修法）", () => {
  it("① 在途唤醒（fresh 未消费 nonce）→ 豁免：不发 member-dead、不回池，落 suspect-dead 审计", async () => {
    await seedTeam();
    await seedCrashedMember();
    // 在途唤醒：未消费、新鲜的 nonce（§2.5-3 在途标记）
    await createWakeNonce(root, { teamId: "default", agentKey: "b", sid: "sess_b" });

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual([]);
    expect(summary.deathExempt).toEqual([{ key: "b", reasons: ["inflight-wake"] }]);
    expect(eventsOf("member-dead")).toHaveLength(0);
    const suspect = eventsOf("suspect-dead");
    expect(suspect).toHaveLength(1);
    expect(suspect[0]!["member"]).toBe("b");
    expect(suspect[0]!["reasons"]).toEqual(["inflight-wake"]);
    // 同一豁免形态持续多轮不重复落审计（审计是状态转换信号，不是心跳）
    expect((await sweepMembersOnce(deps())).deathExempt).toEqual([{ key: "b", reasons: ["inflight-wake"] }]);
    expect(eventsOf("suspect-dead")).toHaveLength(1);
  });

  it("① 唤醒启动窗（spawn 20s 前、生命周期账无 exit、未见到 session-running）→ 豁免", async () => {
    await seedTeam();
    await seedCrashedMember();
    const { nonce } = await createWakeNonce(root, {
      teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now() - 20_000,
    });
    const lifecycle = wakeLifecycleFile(root, "b", nonce.ts);
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(lifecycle, `${JSON.stringify({ ts: nonce.ts, event: "wake-child-start", sid: "sess_b", to: "b", scene: "dispatch" })}\n`, "utf8");

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual([]);
    expect(summary.deathExempt).toEqual([{ key: "b", reasons: ["inflight-wake"] }]);
    expect(eventsOf("member-dead")).toHaveLength(0);
  });

  it("① 唤醒子 pid 活着（start-confirmed 汇报的 pid）→ 以唤醒子 pid 为准，旧 pid 亡不算死", async () => {
    await seedTeam();
    await seedCrashedMember();
    const childPid = await startSleeper(); // 唤醒子进程真活着
    const { nonce } = await createWakeNonce(root, {
      teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now() - 90_000,
    });
    const lifecycle = wakeLifecycleFile(root, "b", nonce.ts);
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(lifecycle, `${JSON.stringify({ ts: nonce.ts, event: "wake-child-start", sid: "sess_b", to: "b", scene: "dispatch" })}\n`, "utf8");
    appendFileSync(lifecycle, `${JSON.stringify({ ts: nonce.ts, event: "wake-child-start-confirmed", nonce: "x", pid: childPid })}\n`, "utf8");

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual([]);
    expect(summary.deathExempt).toEqual([{ key: "b", reasons: ["inflight-wake"] }]);
    expect(eventsOf("member-dead")).toHaveLength(0);
  });

  it("② 成员名下有 in_progress 任务 → 在途即活（17:42:11 误判实例形态）", async () => {
    await seedTeam();
    const team = (await readTeam(root, "default"))! as TeamState;
    const task = makeTask(team, { title: "在途单", prompt: "p", to: "b", createdBy: "a" }, Date.now());
    task.status = "in_progress";
    task.assignee = "b";
    task.attempt = 1;
    task.attemptId = `att-${task.id}`;
    await writeTeam(root, team);
    await seedCrashedMember();

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual([]);
    expect(summary.deathExempt).toEqual([{ key: "b", reasons: ["open-tasks"] }]);
    expect(eventsOf("member-dead")).toHaveLength(0);
  });

  it("③ 记录 pid 亡但注册表已有更新的活 pid → 不算死（纯判据 newer-pid；集成面见下条）", () => {
    // 纯判据（core/offline.ts sessionDeathGuard）：三个理由各自独立、任一命中即豁免。
    const base = {
      wake: {
        inflightNonce: false,
        lifecycleStartNoExit: false,
        sessionRunningSinceSpawn: true,
        wakeChildPidAlive: false,
      },
      openTaskCount: 0,
      newerPidAlive: false,
      now: 1_000_000,
    };
    expect(sessionDeathGuard(base)).toEqual({ exempt: false, reasons: [] });
    expect(sessionDeathGuard({ ...base, wake: { ...base.wake, inflightNonce: true } }).reasons).toEqual(["inflight-wake"]);
    expect(sessionDeathGuard({ ...base, wake: { ...base.wake, lifecycleStartNoExit: true, lastSpawnTs: 1_000_000 - 30_000 } }).reasons).toEqual(["inflight-wake"]);
    expect(sessionDeathGuard({ ...base, wake: { ...base.wake, lifecycleStartNoExit: true, lastSpawnTs: 1_000_000 - 20 * 60_000 } })).toEqual({ exempt: false, reasons: [] }); // 过 15min 窗不再无限豁免
    expect(sessionDeathGuard({ ...base, wake: { ...base.wake, lastSpawnTs: 1_000_000 - 30_000, sessionRunningSinceSpawn: false } }).reasons).toEqual(["inflight-wake"]); // spawn 后 60s 内未见 session-running
    expect(sessionDeathGuard({ ...base, openTaskCount: 2 }).reasons).toEqual(["open-tasks"]);
    expect(sessionDeathGuard({ ...base, newerPidAlive: true }).reasons).toEqual(["newer-pid"]);
  });

  it("③ 集成面：记录 pid 已被写成活 pid（SessionStart 写回）→ 成员不判死、零告警", async () => {
    await seedTeam();
    await seedCrashedMember();
    const newPid = await startSleeper();
    const existing = (await readSession(root, "sess_b"))!;
    await writeSession(root, { ...existing, pid: newPid, lastSeen: Date.now() });

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual([]);
    expect(summary.deathSuspects).toEqual([]);
    expect(summary.deathExempt).toEqual([]); // 不是「豁免」——pid 证据本身就不成立（活着）
    expect(eventsOf("member-dead")).toHaveLength(0);
    expect(eventsOf("suspect-dead")).toHaveLength(0);
  });

  it("④ 二次确认：第一周期只记 suspect，第二周期仍判死才发 member-dead 并回池", async () => {
    await seedTeam();
    const unclaimedId = await seedPendingTask();
    await seedCrashedMember();

    const first = await sweepMembersOnce(deps());
    expect(first.dead).toEqual([]);
    expect(first.deathSuspects).toEqual(["b"]);
    expect(first.unclaimedRepooled).toEqual([]); // 首轮回池不做（二次确认）
    expect(eventsOf("member-dead")).toHaveLength(0);
    const afterFirst = await readWatchdogState(root);
    expect(afterFirst.members["b|sess_b"]).toMatchObject({ state: "alive", liveness: "pid-dead" });

    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual(["b"]);
    expect(eventsOf("member-dead")).toHaveLength(1);
    // 回池随认领发生（V098-07 口径不变，只是后移一个周期）
    expect(second.unclaimedRepooled).toEqual([{ key: "b", taskIds: [unclaimedId] }]);
    const team = (await readTeam(root, "default"))!;
    expect(team.tasks.find((t) => t.id === unclaimedId)!.to).toBeUndefined();
    // 第三轮：同一次死亡不重复
    const third = await sweepMembersOnce(deps());
    expect(third.dead).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(1);
  });

  it("④ 中间活过一个周期 → 重新数两周期（不是「历史上判过死」就算确认）", async () => {
    await seedTeam();
    await seedCrashedMember();
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);

    // 成员活了过来（新 peer 记录在场）——suspect 条目被刷新成 alive/live
    const revivedPid = await startSleeper();
    await writePeerRecord(peerRoot, {
      pid: revivedPid,
      sessionId: "sess_b",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v0100a-b-${revivedPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    const alive = await sweepMembersOnce(deps());
    expect(alive.dead).toEqual([]);
    expect(alive.deathSuspects).toEqual([]);

    // 又死了（peer 记录仍在但 pid 亡 = pid-dead 硬证据）——从零开始数两周期
    await killSleeper(revivedPid);
    const deadAgain1 = await sweepMembersOnce(deps());
    expect(deadAgain1.deathSuspects).toEqual(["b"]);
    expect(deadAgain1.dead).toEqual([]);
    const deadAgain2 = await sweepMembersOnce(deps());
    expect(deadAgain2.dead).toEqual(["b"]);
    expect(eventsOf("member-dead")).toHaveLength(1);
  });

  it("真正掉线（无在途唤醒、无在途任务、pid 亡、连续两周期）→ 检出并回池（验收末句）", async () => {
    await seedTeam();
    const unclaimedId = await seedPendingTask();
    await seedCrashedMember();
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual(["b"]);
    expect(second.leadCurrentlyDead).toBe(false);
    expect(second.unclaimedRepooled).toEqual([{ key: "b", taskIds: [unclaimedId] }]);
    // 三件套齐：事件 + lead urgent 邮箱 + 「未尝试唤醒」如实记账（A3 默认档）。
    // 邮箱共 2 条：engine 的 urgent 告警 + 回池给创建者的 task-receipt（V098-07）。
    expect(eventsOf("member-dead")).toHaveLength(1);
    const box = await readMailbox(root, "default", "a");
    expect(box.filter((m) => m.from === "engine" && m.urgent === true)).toHaveLength(1);
    expect(box.some((m) => m.from === "b" && typeof m.taskId === "string")).toBe(true);
    expect(eventsOf("watchdog-wake")[0]!["delivered"]).toBe("mailbox");
  });
});

// ─────────────────────── A2 / R6：注册表活性可信 ───────────────────────

describe("v0.10.0 A2/R6：注册表活性双写（G-24 修法）", () => {
  it("member-dead 之后注册表 liveness 立即翻 dead 并落盘；engine 事件与注册表两处一致", async () => {
    await seedTeam();
    await seedCrashedMember();
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual(["b"]);

    // 注册表侧：sessions/<sid>.json 的 liveness = dead（G-24：修复前仍标 running）
    const record = (await readSession(root, "sess_b"))!;
    expect(record.liveness).toBe("dead");
    // engine 侧：member-dead（告警事件）+ session-dead（注册表翻转事件）各一条，同 sid
    expect(eventsOf("member-dead")).toHaveLength(1);
    const flips = eventsOf("session-dead");
    expect(flips).toHaveLength(1);
    expect(flips[0]!["sessionId"]).toBe("sess_b");
    expect(flips[0]!["state"]).toBe("dead");
    expect(flips[0]!["prev"]).toBe("running");
  });

  it("重新 register 后立即翻回 running（wakeToken 路径的单一写入点 anchorSessionForRegister）", async () => {
    await seedTeam();
    await seedCrashedMember();
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    await sweepMembersOnce(deps());
    expect((await readSession(root, "sess_b"))!.liveness).toBe("dead");

    // xc_identify（wakeToken 路径）重新锚定同一 sid：活性翻回 running + 迁移事件
    const record = await anchorSessionForRegister(root, "sess_b", { cwd: "D:\\ws", now: Date.now() });
    expect(record.liveness).toBe("running");
    expect((await readSession(root, "sess_b"))!.liveness).toBe("running");
    const flips = eventsOf("session-dead");
    expect(flips).toHaveLength(1); // 翻转事件不重复（翻回走 session-running）
    expect(eventsOf("session-running").some((e) => e["sessionId"] === "sess_b" && e["prev"] === "dead")).toBe(true);
  });

  it("重新武装（成员不再 pid-dead）→ 注册表的 dead 自述清回 idle", async () => {
    await seedTeam();
    await seedCrashedMember();
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    await sweepMembersOnce(deps());
    expect((await readSession(root, "sess_b"))!.liveness).toBe("dead");

    // 同一会话活了过来：新 peer 记录（pid 活）⇒ liveness 非 pid-dead ⇒ 台账重新武装
    const revivedPid = await startSleeper();
    await writePeerRecord(peerRoot, {
      pid: revivedPid,
      sessionId: "sess_b",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v0100a-rearm-${revivedPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    const rearmed = await sweepMembersOnce(deps());
    expect(rearmed.dead).toEqual([]);
    const record = (await readSession(root, "sess_b"))!;
    expect(record.liveness).toBe("idle"); // 无回合中的引擎证据 → 保守 idle
    expect(eventsOf("session-idle").some((e) => e["sessionId"] === "sess_b" && e["prev"] === "dead")).toBe(true);
  });

  it("markSessionDead/clearSessionDead 零写纪律：无记录/已 dead 不写不落事件", async () => {
    await seedTeam();
    // 无记录：no-op
    await markSessionDead(root, "sess_none", { now: Date.now() });
    expect(await readSession(root, "sess_none")).toBeUndefined();
    // 存量最小记录（无 liveness 字段）：不猜、不写
    await writeSession(root, { sessionId: "sess_min", cwd: "", startedAt: 1, lastSeen: 1 });
    await markSessionDead(root, "sess_min", { now: Date.now() });
    expect((await readSession(root, "sess_min"))!.liveness).toBeUndefined();
    expect(eventsOf("session-dead")).toHaveLength(0);
    // running → dead 落事件；同态再标不重复
    await writeSession(root, { sessionId: "sess_min", cwd: "", startedAt: 1, lastSeen: 1, liveness: "running", livenessTs: Date.now() });
    await markSessionDead(root, "sess_min", { now: Date.now() });
    await markSessionDead(root, "sess_min", { now: Date.now() });
    expect((await readSession(root, "sess_min"))!.liveness).toBe("dead");
    expect(eventsOf("session-dead")).toHaveLength(1);
    // clearSessionDead：dead → idle 一次；非 dead 不动
    await clearSessionDead(root, "sess_min", { now: Date.now() });
    await clearSessionDead(root, "sess_min", { now: Date.now() });
    expect((await readSession(root, "sess_min"))!.liveness).toBe("idle");
    expect(eventsOf("session-dead")).toHaveLength(1);
  });

  it("livenessTs 不再冻结：同态引擎事件（工具心跳）同点刷新 livenessTs 与 lastEventTs", async () => {
    await seedTeam();
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 3_600_000,
      liveness: "running", livenessTs: now - 3_600_000, lastEventTs: now - 3_600_000,
    });
    // 冻结形态（G-24 实测）：livenessTs 停在 1h 前而 lastEventTs 新鲜——心跳走
    // markSessionHeartbeat（同态 running）：两个时刻必须同点刷新。
    await markSessionHeartbeat(root, "sess_b", { now });
    const record = (await readSession(root, "sess_b"))!;
    expect(record.lastEventTs).toBe(now);
    expect(record.livenessTs).toBe(now); // v0.10.0 R6：不再冻结
  });

  it("翻转不熄灭 pid 判据：dead 自述 + pid 仍亡 ⇒ 后续扫描仍判 pid-dead（自愈回池的前置）", async () => {
    await seedTeam();
    await seedCrashedMember();
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    await sweepMembersOnce(deps());
    expect((await readSession(root, "sess_b"))!.liveness).toBe("dead");

    // 停机后仍有人给死者派单——下一轮必须照常回池（V098-07 自愈面）
    const strandedId = await seedPendingTask("死后新派单");
    const third = await sweepMembersOnce(deps());
    expect(third.dead).toEqual([]);
    expect(third.unclaimedRepooled).toEqual([{ key: "b", taskIds: [strandedId] }]);
  });
});

// ─────────────────────── A3 / R5：lead 不被拉成无头分身 ───────────────────────

describe("v0.10.0 A3/R5：member-dead 告警对 lead 只写邮箱不唤醒", () => {
  it("默认档：lead 邮箱收到 urgent，但**不尝试唤醒**（事件如实记 note；容量闸都不路过）", async () => {
    await seedTeam();
    await seedCrashedMember();
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    // 唤醒闸开启 + 容量 RED：若真尝试唤醒，必有 wake-deferred 透出；默认档下零痕迹
    const second = await sweepMembersOnce(deps({
      env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true" },
      capacitySample: {
        sampledAt: Date.now(),
        totalBytes: 16 * 1024 ** 3,
        freeBytes: 1_400_000_000,
        watermark: 0.089,
        steadyTreeBytes: 12 * 1024 ** 3,
        headlessTurnCount: 2,
        headlessTurnMaxRssBytes: 900 * 1024 * 1024,
        degraded: null,
      },
    }));
    expect(second.dead).toEqual(["b"]);
    // 邮箱三件套之一的告知照写（主控在自己回合看得到）
    const box = await readMailbox(root, "default", "a");
    expect(box).toHaveLength(1);
    expect(box[0]!.from).toBe("engine");
    expect(box[0]!.urgent).toBe(true);
    expect(box[0]!.content).toContain("进程已亡");
    // 「未尝试唤醒」如实记账；没有任何 attemptWake 痕迹（无 nonce、无 wake-deferred）
    const wakes = eventsOf("watchdog-wake");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!["to"]).toBe("a");
    expect(wakes[0]!["delivered"]).toBe("mailbox");
    expect(String(wakes[0]!["note"])).toContain("未尝试唤醒");
    expect(eventsOf("wake-deferred")).toHaveLength(0);
    expect(existsSync(join(root, "registry", "wake"))).toBe(false);
  });

  it("XC_WATCHDOG_WAKE_LEAD=1 恢复旧行为：对 lead 尝试唤醒（容量 RED 时 deferral 透出）", async () => {
    await seedTeam();
    await seedCrashedMember();
    const wakeLeadDeps = deps({
      env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true", XC_WATCHDOG_WAKE_LEAD: "1" },
      capacitySample: {
        sampledAt: Date.now(),
        totalBytes: 16 * 1024 ** 3,
        freeBytes: 1_400_000_000,
        watermark: 0.089,
        steadyTreeBytes: 12 * 1024 ** 3,
        headlessTurnCount: 2,
        headlessTurnMaxRssBytes: 900 * 1024 * 1024,
        degraded: null,
      },
    });
    expect((await sweepMembersOnce(wakeLeadDeps)).deathSuspects).toEqual(["b"]);
    await sweepMembersOnce(wakeLeadDeps);
    const wakes = eventsOf("watchdog-wake");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!["wakeDeferred"]).toBe(true); // 真走了 attemptWake（被容量闸挡下）
    // 尝试过的唤醒照旧带 attemptWake 的降级 note（容量闸说明）——与默认档的「未尝试唤醒」note 区分
    expect(String(wakes[0]!["note"])).not.toContain("未尝试唤醒");
    expect(eventsOf("wake-deferred")).toHaveLength(1);
  });

  it("env 口径：只认字面量 \"1\"；未设/空串/0/true 都不拉主控", () => {
    expect(watchdogWakeLeadFromEnv({})).toBe(false);
    expect(watchdogWakeLeadFromEnv({ XC_WATCHDOG_WAKE_LEAD: "" })).toBe(false);
    expect(watchdogWakeLeadFromEnv({ XC_WATCHDOG_WAKE_LEAD: "0" })).toBe(false);
    expect(watchdogWakeLeadFromEnv({ XC_WATCHDOG_WAKE_LEAD: "true" })).toBe(false);
    expect(watchdogWakeLeadFromEnv({ XC_WATCHDOG_WAKE_LEAD: "1" })).toBe(true);
  });
});

// ─────────────────────── A4 / R2 后半：dispatch-resume 补醒 ───────────────────────

describe("v0.10.0 A4/R2后半：看门狗补醒被忙闲闸挡下的派单", () => {
  it("空闲 + 收件箱有未读派单 + 无在途唤醒 → 按普通派单场景补一次唤醒（scene=dispatch-resume）", async () => {
    await seedTeam();
    await seedIdleMember();
    const taskId = await seedPendingTask();
    const messageId = await seedUnreadDispatch(taskId);

    const summary = await sweepMembersOnce(deps());
    // 补醒决策成立（note = attemptWake 的降级说明：唤醒闸关闭 → 仅落邮箱）
    expect(summary.dispatchResumed).toMatchObject([{ key: "b", messageIds: [messageId], delivered: "mailbox" }]);
    // 审计事件（scene 与任务 id 如实）
    const resumed = eventsOf("dispatch-resume");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!["to"]).toBe("b");
    expect(resumed[0]!["taskIds"]).toEqual([taskId]);
    expect(resumed[0]!["messageIds"]).toEqual([messageId]);
    expect(resumed[0]!["cooldownMs"]).toBe(DISPATCH_RESUME_COOLDOWN_DEFAULT_MS);
    // 走了 attemptWake 标准路径：唤醒闸关闭 → wake-skipped{scene:"dispatch-resume"} 留痕
    // （闸/容量闸/在途 nonce 全部照算，「紧急不豁免」口径不变——本路径不设 urgent）
    const skipped = eventsOf("wake-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!["scene"]).toBe("dispatch-resume");
  });

  it("空闲且**无**未读派单 → 绝不被唤醒（零 dispatch-resume、零唤醒尝试）", async () => {
    await seedTeam();
    await seedIdleMember();

    const summary = await sweepMembersOnce(deps());
    expect(summary.dispatchResumed).toEqual([]);
    expect(eventsOf("dispatch-resume")).toHaveLength(0);
    expect(eventsOf("wake-skipped")).toHaveLength(0);
    expect(eventsOf("watchdog-wake")).toHaveLength(0);
  });

  it("未读派单已读（readAt 在场）→ 不补醒", async () => {
    await seedTeam();
    await seedIdleMember();
    const taskId = await seedPendingTask();
    await seedUnreadDispatch(taskId);
    // 消费掉：readAt 落盘（acknowledgeMailbox 同族效果——直接改邮箱行）
    const { acknowledgeMailbox } = await import("../core/mailbox.js");
    const box = await readMailbox(root, "default", "b");
    await acknowledgeMailbox(root, "default", "b", [box[0]!.id], Date.now());

    const summary = await sweepMembersOnce(deps());
    expect(summary.dispatchResumed).toEqual([]);
    expect(eventsOf("dispatch-resume")).toHaveLength(0);
  });

  it("有在途唤醒（fresh nonce）→ 不补醒（等唤醒自己到位，不双 spawn）", async () => {
    await seedTeam();
    await seedIdleMember();
    const taskId = await seedPendingTask();
    await seedUnreadDispatch(taskId);
    await createWakeNonce(root, { teamId: "default", agentKey: "b", sid: "sess_b" });

    const summary = await sweepMembersOnce(deps());
    expect(summary.dispatchResumed).toEqual([]);
    expect(eventsOf("dispatch-resume")).toHaveLength(0);
  });

  it("有在途回合（record 自述 running 且时刻新鲜）→ 不补醒", async () => {
    await seedTeam();
    const now = Date.now();
    const livePid = await startSleeper();
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 600_000, lastSeen: now - 30_000,
      pid: livePid, liveness: "running", livenessTs: now - 30_000, lastEventTs: now - 30_000,
    });
    const { writeSessionWitness } = await import("../core/registry.js");
    await writeSessionWitness(root, "sess_b", "running", now - 30_000);
    const taskId = await seedPendingTask();
    await seedUnreadDispatch(taskId);

    const summary = await sweepMembersOnce(deps());
    expect(summary.dispatchResumed).toEqual([]);
    expect(eventsOf("dispatch-resume")).toHaveLength(0);
  });

  it("冷却窗内不重复补醒（生命周期账里 scene=dispatch-resume 的最近 spawn 即冷却源）", async () => {
    await seedTeam();
    await seedIdleMember();
    const taskId = await seedPendingTask();
    await seedUnreadDispatch(taskId);
    // 30s 前刚补醒过一次：只落生命周期账（scene=dispatch-resume）。刻意**不**签 nonce——
    // 那会制造在途唤醒把补醒本身挡掉，冷却源必须能与在途唤醒区分（判据不同源）。
    const spawnTs = Date.now() - 30_000;
    const lifecycle = wakeLifecycleFile(root, "b", spawnTs);
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(lifecycle, `${JSON.stringify({ ts: spawnTs, event: "wake-child-start", sid: "sess_b", to: "b", scene: "dispatch-resume" })}\n`, "utf8");

    const summary = await sweepMembersOnce(deps());
    expect(summary.dispatchResumed).toEqual([]); // 120s 冷却窗内不重复
    expect(eventsOf("dispatch-resume")).toHaveLength(0);

    // XC_DISPATCH_RESUME_COOLDOWN_MS=0（显式不冷却）→ 放行补醒
    const noCooldown = await sweepMembersOnce(deps({ env: { XC_MESSAGING_DIR: peerRoot, XC_DISPATCH_RESUME_COOLDOWN_MS: "0" } }));
    expect(noCooldown.dispatchResumed).toHaveLength(1);
    expect(eventsOf("dispatch-resume")).toHaveLength(1);
  });

  it("env 口径：缺省 120s；0=不冷却；负/非数字回落缺省（不静默关闸）", () => {
    expect(DISPATCH_RESUME_COOLDOWN_DEFAULT_MS).toBe(120_000);
    expect(dispatchResumeCooldownMsFromEnv({})).toBe(120_000);
    expect(dispatchResumeCooldownMsFromEnv({ XC_DISPATCH_RESUME_COOLDOWN_MS: "" })).toBe(120_000);
    expect(dispatchResumeCooldownMsFromEnv({ XC_DISPATCH_RESUME_COOLDOWN_MS: "0" })).toBe(0);
    expect(dispatchResumeCooldownMsFromEnv({ XC_DISPATCH_RESUME_COOLDOWN_MS: "5000" })).toBe(5_000);
    expect(dispatchResumeCooldownMsFromEnv({ XC_DISPATCH_RESUME_COOLDOWN_MS: "-1" })).toBe(120_000);
    expect(dispatchResumeCooldownMsFromEnv({ XC_DISPATCH_RESUME_COOLDOWN_MS: "soon" })).toBe(120_000);
  });

  it("A4 验收：被忙闲闸挡下的派单，在成员回合结束后两个扫描周期内被唤醒认领", async () => {
    await seedTeam();
    const taskId = await seedPendingTask();
    await seedUnreadDispatch(taskId);
    // 成员忙（在途回合）：补醒判据不命中（running 自述 + running 证言）
    const now = Date.now();
    const livePid = await startSleeper();
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 600_000, lastSeen: now,
      pid: livePid, liveness: "running", livenessTs: now, lastEventTs: now,
    });
    const { writeSessionWitness } = await import("../core/registry.js");
    await writeSessionWitness(root, "sess_b", "running", now);
    expect((await sweepMembersOnce(deps())).dispatchResumed).toEqual([]);

    // 回合结束（Stop 钩子：idle 自述 + idle 证言）——下一个扫描周期即补醒
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 600_000, lastSeen: now,
      pid: livePid, liveness: "idle", livenessTs: now, lastEventTs: now,
    });
    await writeSessionWitness(root, "sess_b", "idle", now);
    const resumed = await sweepMembersOnce(deps());
    expect(resumed.dispatchResumed).toHaveLength(1);
    expect(resumed.dispatchResumed[0]!.key).toBe("b");
    expect(resumed.dispatchResumed[0]!.scene).toBe(RESUME_SCENE_DISPATCH);
    expect(eventsOf("dispatch-resume")).toHaveLength(1);
  });
});

// ─────────────── 补充（追加裁决）：未读**紧急回执**的补醒 ───────────────

describe("v0.10.0 补充·R2/R8 联动：回合进行中只落邮箱的紧急回执，空闲后补醒（report-resume）", () => {
  /** 紧急回执 + 唤醒闸开启 + 容量 RED 的 deps（验证 urgent 真到达 attemptWake 的探针）。 */
  function urgentProbeDeps(): WatchdogDeps {
    return deps({
      env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true" },
      capacitySample: {
        sampledAt: Date.now(),
        totalBytes: 16 * 1024 ** 3,
        freeBytes: 1_400_000_000,
        watermark: 0.089,
        steadyTreeBytes: 12 * 1024 ** 3,
        headlessTurnCount: 2,
        headlessTurnMaxRssBytes: 900 * 1024 * 1024,
        degraded: null,
      },
    });
  }

  /** 容量闸 deferral 的落盘冷却键（`<teamId>|<收方>|<urgent|normal>`）——urgent 到达 attemptWake 的硬证据。 */
  function wakeCooldownKeys(): string[] {
    const file = join(root, "capacity", "wake-deferred.json");
    if (!existsSync(file)) return [];
    const store = JSON.parse(readFileSync(file, "utf8")) as { entries?: Record<string, unknown> };
    return Object.keys(store.entries ?? {});
  }

  it("纯判据：两类未读的识别（task-receipt / urgent 标记 / 派单）", () => {
    const receipt = { content: JSON.stringify({ type: "task-receipt", taskId: "t1" }) };
    const dispatch = { content: "派单票面", taskId: "t1" };
    const chat = { content: "普通聊天" };
    expect(URGENT_RECEIPT_WAKE_DEFERRED).toBe("recipient-turn-running");
    expect(RESUME_SCENE_DISPATCH).toBe("dispatch-resume");
    expect(RESUME_SCENE_REPORT).toBe("report-resume");
    // task-receipt 识别
    expect(isTaskReceiptMessage(receipt)).toBe(true);
    expect(isTaskReceiptMessage(dispatch)).toBe(false);
    expect(isTaskReceiptMessage(chat)).toBe(false);
    // 紧急回执 = task-receipt ∧（urgent 旗标 ∨ 帧上待补醒标记；标记在 content 帧内）
    const marked = { content: JSON.stringify({ type: "task-receipt", taskId: "t1", wakeDeferred: "recipient-turn-running" }) };
    expect(isUrgentReceiptMessage({ ...receipt, urgent: true })).toBe(true);
    expect(isUrgentReceiptMessage(marked)).toBe(true); // 无 urgent 旗标、帧上有标记
    expect(isUrgentReceiptMessage({ ...receipt, urgent: true })).toBe(true); // 旗标在，帧上异值标记不影响
    expect(isUrgentReceiptMessage(receipt)).toBe(false); // 非紧急回执（无旗标无标记）
    expect(isUrgentReceiptMessage({ ...dispatch, urgent: true })).toBe(false); // 派单再 urgent 也不是回执
    // 派单 = 带 taskId 且不是回执
    expect(isUnreadDispatchMessage(dispatch)).toBe(true);
    expect(isUnreadDispatchMessage(receipt)).toBe(false);
    expect(isUnreadDispatchMessage(chat)).toBe(false);
  });

  it("【追加裁决锚点】回合进行中落了邮箱的紧急回执 → 收件人空闲后一个扫描周期内补醒（scene=report-resume、urgent 真达 attemptWake）", async () => {
    await seedTeam();
    const taskId = await seedPendingTask();
    const receiptId = await seedUnreadUrgentReceipt(taskId);
    // 收件人回合进行中（组 B 的「只落邮箱不唤醒」形态）：running 自述 + running 证言
    const now = Date.now();
    const livePid = await startSleeper();
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 600_000, lastSeen: now,
      pid: livePid, liveness: "running", livenessTs: now, lastEventTs: now,
    });
    const { writeSessionWitness } = await import("../core/registry.js");
    await writeSessionWitness(root, "sess_b", "running", now);

    // 回合进行中：绝不补醒（附加裁决末句）
    const busy = await sweepMembersOnce(urgentProbeDeps());
    expect(busy.dispatchResumed).toEqual([]);
    expect(eventsOf("report-resume")).toHaveLength(0);
    expect(wakeCooldownKeys()).toEqual([]); // 连 attemptWake 都没走过

    // 回合结束（Stop 钩子）→ 下一个扫描周期即补醒（≤ 两个扫描周期）
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 600_000, lastSeen: now,
      pid: livePid, liveness: "idle", livenessTs: now, lastEventTs: now,
    });
    await writeSessionWitness(root, "sess_b", "idle", now);
    const resumed = await sweepMembersOnce(urgentProbeDeps());
    expect(resumed.dispatchResumed).toMatchObject([{
      key: "b", scene: "report-resume", messageIds: [receiptId], delivered: "mailbox",
    }]); // note = 容量闸降级说明（attemptWake 真被走过）
    // 审计事件与 scene 同名；taskIds 如实
    const audit = eventsOf("report-resume");
    expect(audit).toHaveLength(1);
    expect(audit[0]!["to"]).toBe("b");
    expect(audit[0]!["taskIds"]).toEqual([taskId]);
    expect(audit[0]!["messageIds"]).toEqual([receiptId]);
    expect(String(audit[0]!["note"])).toContain("紧急回执");
    // urgent:true 真到达 attemptWake 的硬证据：容量闸 deferral 的分域冷却键是 …|b|urgent
    expect(wakeCooldownKeys()).toEqual(["default|b|urgent"]);
  });

  it("兜底约定兼容：回执只带待补醒标记（无 urgent 旗标）也识别为紧急回执并补醒", async () => {
    await seedTeam();
    const taskId = await seedPendingTask();
    const receiptId = await seedUnreadUrgentReceipt(taskId, { marker: true, urgent: false });
    await seedIdleMember();

    const resumed = await sweepMembersOnce(deps());
    expect(resumed.dispatchResumed).toMatchObject([{ key: "b", scene: "report-resume", messageIds: [receiptId] }]);
    expect(eventsOf("report-resume")).toHaveLength(1);
  });

  it("冷却窗内不重复补醒（report-resume 也计入同一冷却窗）；env=0 放行", async () => {
    await seedTeam();
    const taskId = await seedPendingTask();
    const receiptId = await seedUnreadUrgentReceipt(taskId);
    await seedIdleMember();
    // 30s 前刚补醒过一次：只落生命周期账（scene=report-resume；不签 nonce）
    const spawnTs = Date.now() - 30_000;
    const lifecycle = wakeLifecycleFile(root, "b", spawnTs);
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(lifecycle, `${JSON.stringify({ ts: spawnTs, event: "wake-child-start", sid: "sess_b", to: "b", scene: "report-resume" })}\n`, "utf8");

    const first = await sweepMembersOnce(deps());
    expect(first.dispatchResumed).toEqual([]); // 120s 冷却窗内不重复（派单/紧急回执共用一窗）
    expect(eventsOf("report-resume")).toHaveLength(0);

    const noCooldown = await sweepMembersOnce(deps({ env: { XC_MESSAGING_DIR: peerRoot, XC_DISPATCH_RESUME_COOLDOWN_MS: "0" } }));
    expect(noCooldown.dispatchResumed).toMatchObject([{ key: "b", scene: "report-resume", messageIds: [receiptId] }]);
    expect(eventsOf("report-resume")).toHaveLength(1);
  });

  it("非紧急 task-receipt（stale 清扫回执等）→ 不触发补醒（两类未读口径写死）", async () => {
    await seedTeam();
    const taskId = await seedPendingTask();
    await seedPlainReceipt(taskId);
    await seedIdleMember();

    const summary = await sweepMembersOnce(deps());
    expect(summary.dispatchResumed).toEqual([]);
    expect(eventsOf("report-resume")).toHaveLength(0);
    expect(eventsOf("dispatch-resume")).toHaveLength(0);
    expect(eventsOf("wake-skipped")).toHaveLength(0);
  });

  it("派单与紧急回执同时在箱 → 一次补醒走 report-resume（urgent），两类 id 都带上", async () => {
    await seedTeam();
    const taskId = await seedPendingTask();
    const dispatchId = await seedUnreadDispatch(taskId);
    const receiptId = await seedUnreadUrgentReceipt(taskId);
    await seedIdleMember();

    const resumed = await sweepMembersOnce(deps());
    expect(resumed.dispatchResumed).toHaveLength(1);
    expect(resumed.dispatchResumed[0]!.scene).toBe("report-resume");
    expect([...resumed.dispatchResumed[0]!.messageIds].sort()).toEqual([dispatchId, receiptId].sort());
    expect(eventsOf("report-resume")).toHaveLength(1);
    expect(eventsOf("dispatch-resume")).toHaveLength(0); // 同一周期不双场景唤醒
  });
});

// ─────────────────────── 告警文案：职能段（G-25） ───────────────────────

describe("v0.10.0 告警文案：member-dead 邮箱文案带一句话职能", () => {
  it("dutySnippet：控制字符清掉、trim、最长 60 字符；非字符串/空 → undefined", () => {
    expect(dutySnippet({ duty: "  工单执行：MR 放行流水线  " })).toBe("工单执行：MR 放行流水线");
    expect(dutySnippet({ duty: "a\u0000b\tc" })).toBe("a b c");
    expect(dutySnippet({ duty: "x".repeat(80) })).toBe(`${"x".repeat(59)}…`);
    expect(dutySnippet({ duty: "x".repeat(60) })).toBe("x".repeat(60));
    expect(dutySnippet({})).toBeUndefined();
    expect(dutySnippet({ duty: "   " })).toBeUndefined();
    expect(dutySnippet({ duty: 42 as unknown as string })).toBeUndefined();
  });

  it("成员行带 duty → 文案在成员名后带（职能：…）；无 duty → 原文案逐字节不变", async () => {
    await seedTeam();
    await seedCrashedMember();
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    await sweepMembersOnce(deps());
    // 无 duty：文案不含职能段（旧形态）
    expect(leadMail()).toContain("进程已亡");
    expect(leadMail()).not.toContain("职能：");

    // 组 D 的 duty 字段落到 team.json 成员行后，下一次死亡的文案带职能段
    const team = (await readTeam(root, "default"))! as TeamState;
    team.members = team.members.map((m) => (m.key === "b" ? { ...m, duty: "工单执行：MR 放行流水线" } : m));
    await writeTeam(root, team);
    // 新化身（新 sid）再死一次——复合键独立记账，文案带职能
    team.members = team.members.map((m) => (m.key === "b" ? { ...m, sessionId: "sess_b2" } : m));
    await writeTeam(root, team);
    await seedCrashedMember("sess_b2");
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    await sweepMembersOnce(deps());
    const mail = leadMail();
    expect(mail).toContain("（职能：工单执行：MR 放行流水线） 进程已亡"); // 职能段紧缀成员名后（模板空格保留）
  });
});
