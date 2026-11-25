/**
 * v0.10.0（集成员·第 7 轮）定向单测：**已判亡的成员不被「重新武装」**
 * （plugin/src/engine/watchdog.ts，真实加测 REAL-SMOKE-H-R3.md §6.1 打回）。
 *
 * 缺陷形态（真实加测事实链）：m2 于 04:42:09 认领 member-dead（注册表翻 dead）；
 * 04:50:33 台账把它**重新武装**（`session-idle{m2,prev:"dead",state:"idle"}`，即
 * clearSessionDead），记录变成 idle；04:51:33 m3 判亡时 m2 的活性已算成 `no-record`
 * （不再是 pid-dead）⇒ 进告警收件人生效名单 ⇒ 04:51:35 `watchdog-wake{to:m2,delivered:wake}`
 * 把死会话重新拉起一回合。根因：**旧 pid 被系统回收复用**——`memberLiveness` 的 pid 证据支
 * 要求 `!pidEvidence.alive`，pid 一旦被别的进程复用，pid 证据（含 selfClaimsDead）整支失效，
 * 活性退成 no-record；而重新武装条件（台账 dead ∧ 活性≠pid-dead）成立。
 *
 * 修法：看门狗里所有按「pid-dead 字符串」判死人的地方改用**视图的 dead**
 * （core/liveness.ts memberLivenessView 的 state==='dead' = 活性 pid-dead ∨ 记录自述 dead
 * 且无 live/heartbeat-stale 活证据）——重新武装条件、planRecipients（V092-02）、
 * leadCurrentlyDead、补醒候选、往轮死者自愈回池面，共 6 处。
 * 「已判亡」要有**正向复活证据**才翻回：记录不再自述 dead（该会话自己的钩子写过
 * running/idle）或有 live/heartbeat-stale 证据。
 *
 * 覆盖（任务书点名的三条 + 两条连带）：
 *  1. 判亡后 pid 复用 → 连续多轮台账仍 dead、注册表仍 dead、零 session-idle{prev:'dead'}、
 *     不进收件人名单、零唤醒、member-dead 不重复；
 *  2. 判亡后该会话的钩子把记录翻成 running → 下一轮照常重新武装（正向复活证据）；
 *  3. 存量（台账 dead 但注册表记录不是 dead）→ 与修复前一致（照旧重新武装）；
 *  4. lead 已判亡 + pid 复用 → leadCurrentlyDead 仍为真、通知继续改投队友（不投给死 lead）；
 *  5. 往轮死者的未认领单在 pid 复用后仍每轮自愈回池（回池面不静默停摆）。
 *
 * 「pid 复用」的模拟：把会话记录里的 pid 改写成**本测试进程的 pid**（真实活着）——
 * 与「旧 pid 被系统回收给别的进程」语义完全一致（alive(storedPid) 为真），
 * 比注入假 alive 函数更强（真进程、真 pidAlive 判定、无测试钩子）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  sweepMembersOnce,
  watchdogLedgerKey,
  type WatchdogDeps,
} from "./watchdog.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { readSession, writeSession } from "../core/registry.js";
import { writePeerRecord } from "../core/peerregistry.js";
import { localPidDomain } from "../core/peerdir.js";
import { pidAlive } from "../core/lock.js";
import { readWatchdogState, writeWatchdogState } from "./watchdog-state.js";
import type { Task, TeamState } from "../core/types.js";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: Array<ReturnType<typeof spawn>> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wd-v0100r7-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-wd-v0100r7-peers-"));
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

async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

async function startAndKill(): Promise<number> {
  const pid = await startSleeper();
  sleepers.find((c) => c.pid === pid)?.kill();
  const deadline = Date.now() + 10_000;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pidAlive(pid)).toBe(false);
  return pid;
}

/**
 * 团队形态：lead a（判亡）+ 成员 b（判亡）+ 成员 c（唯一活成员，告警的对照收件人）。
 * a 与 b 都是「会话记录 pid 已亡 + running 自述悬停」的崩溃形态（无 Stop 钩子）。
 */
async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  team.members.push(
    { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 },
    { key: "c", sessionId: "sess_c", role: "worker", joinedAt: 1, lastSeen: 1 },
  );
  await writeTeam(root, team);
  const deadA = await startAndKill();
  const deadB = await startAndKill();
  for (const [sid, pid] of [["sess_a", deadA], ["sess_b", deadB]] as const) {
    await writeSession(root, {
      sessionId: sid, cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 90_000,
      pid, liveness: "running", livenessTs: now - 90_000, lastEventTs: now - 90_000,
    });
  }
  // c：空闲活成员
  const liveC = await startSleeper();
  await writeSession(root, {
    sessionId: "sess_c", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 60_000,
    pid: liveC, liveness: "idle", livenessTs: now - 60_000, lastEventTs: now - 60_000,
  });
  const { writeSessionWitness } = await import("../core/registry.js");
  await writeSessionWitness(root, "sess_c", "idle", now - 60_000);
}

function deps(): WatchdogDeps {
  return { stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } };
}

/** 把某成员的会话记录 pid 改成一个**活着**的 pid（模拟旧 pid 被系统回收复用）。 */
async function recyclePid(sessionId: string): Promise<void> {
  const livePid = process.pid; // 本测试进程：真实活着
  expect(pidAlive(livePid)).toBe(true);
  const record = await readSession(root, sessionId);
  expect(record, `${sessionId} 应有会话记录`).toBeDefined();
  await writeSession(root, { ...record!, pid: livePid });
}

/** 台账里某成员的条目（复合键）。 */
async function ledgerEntry(key: string, sid: string): Promise<{ state: string } | undefined> {
  const state = await readWatchdogState(root);
  return state.members[watchdogLedgerKey(key, sid)] as { state: string } | undefined;
}

/** 跑两轮扫描（首轮 suspect、次轮确认并告警）。 */
async function sweepTwice(d: WatchdogDeps = deps()) {
  await sweepMembersOnce(d);
  return sweepMembersOnce(d);
}

/** 读一名成员的邮箱行数。 */
function mailboxCount(member: string): number {
  const file = join(root, "teams", "default", "inbox", `${member}.jsonl`);
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").length;
}

describe("v0.10.0 集成员·R7：已判亡的成员不被重新武装（pid 复用）", () => {
  it("判亡后 pid 复用 → 连续多轮台账仍 dead、注册表仍 dead、零 session-idle{prev:'dead'}、零唤醒", async () => {
    await seedTeam();
    const summary = await sweepTwice();
    // 前置：lead a 与成员 b 都被确认判亡（两周期二次确认）
    expect(summary.dead.sort()).toEqual(["a", "b"]);
    expect(eventsOf("member-dead").filter((e) => e["member"] === "b")).toHaveLength(1);
    // 注册表已被 markSessionDead 翻成 dead（R6 的双写）
    expect((await readSession(root, "sess_b"))?.liveness).toBe("dead");
    expect(eventsOf("session-dead").filter((e) => e["sessionId"] === "sess_b").length).toBeGreaterThanOrEqual(1);
    expect((await ledgerEntry("b", "sess_b"))?.state).toBe("dead");
    // 告警只发给唯一的活成员 c（lead 已死 ⇒ 改投队友；b 已判死 ⇒ 不收）
    expect(eventsOf("watchdog-wake").map((e) => e["to"])).toEqual(["c"]);
    const wakesBefore = eventsOf("watchdog-wake").length;

    // ── 模拟 pid 被系统回收复用：b 记录里的 pid 改写成本测试进程的 pid（活着）──
    await recyclePid("sess_b");

    // 连续多轮扫描：死人必须继续是死人
    for (let i = 0; i < 4; i++) {
      const round = await sweepMembersOnce(deps());
      expect(round.dead, `第 ${i + 3} 轮不应再有新判死`).toEqual([]);
    }
    // 台账仍 dead（没有被重新武装）
    expect((await ledgerEntry("b", "sess_b"))?.state).toBe("dead");
    // 注册表记录仍自述 dead（没有 clearSessionDead 把它清成 idle）
    expect((await readSession(root, "sess_b"))?.liveness).toBe("dead");
    // 零 session-idle{prev:'dead'}（重新武装路径的唯一痕迹）
    expect(eventsOf("session-idle").filter((e) => e["prev"] === "dead"),
      "不应出现重新武装的 session-idle{prev:'dead'}").toEqual([]);
    // 零新增唤醒、零告警落 b 的邮箱（死人不在收件人名单里）
    expect(eventsOf("watchdog-wake").length).toBe(wakesBefore);
    expect(eventsOf("watchdog-wake").filter((e) => e["to"] === "b")).toEqual([]);
    expect(mailboxCount("b"), "死成员邮箱不应再收到新告警").toBe(0);
    // member-dead 不重复发（同一次死亡只通告一次）
    expect(eventsOf("member-dead").filter((e) => e["member"] === "b")).toHaveLength(1);
  });

  it("pid 复用后别的成员死亡：死人仍不进收件人名单、不被唤醒（V092-02 不被绕过）", async () => {
    await seedTeam();
    await sweepTwice();
    await recyclePid("sess_b");
    // 再扫几轮让「重新武装」有机会发生（有 bug 的版本这里就会翻 alive）
    await sweepMembersOnce(deps());
    await sweepMembersOnce(deps());
    expect((await ledgerEntry("b", "sess_b"))?.state).toBe("dead");
    const wakesBefore = eventsOf("watchdog-wake").length;

    // 再造一次事故：把唯一的活成员 c 也弄死（pid 亡 + running 自述悬停）
    const now = Date.now();
    const deadC = await startAndKill();
    await writeSession(root, {
      sessionId: "sess_c", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 90_000,
      pid: deadC, liveness: "running", livenessTs: now - 90_000, lastEventTs: now - 90_000,
    });
    const third = await sweepTwice();
    expect(third.dead).toContain("c");
    expect(eventsOf("member-dead").filter((e) => e["member"] === "c")).toHaveLength(1);
    // 全员已判亡（lead a / b / c）⇒ 无人可通知 ⇒ watchdog-notify-skipped，零新增唤醒
    expect(eventsOf("watchdog-wake").length).toBe(wakesBefore);
    expect(eventsOf("watchdog-notify-skipped").length).toBeGreaterThanOrEqual(1);
    expect(eventsOf("watchdog-wake").filter((e) => e["to"] === "b")).toEqual([]);
    expect(mailboxCount("b")).toBe(0);
  });

  it("正向复活证据①：该会话自己的钩子把记录翻成 running → 下一轮照常重新武装", async () => {
    await seedTeam();
    await sweepTwice();
    expect((await ledgerEntry("b", "sess_b"))?.state).toBe("dead");
    expect((await readSession(root, "sess_b"))?.liveness).toBe("dead");

    // 会话自己的钩子（SessionStart/UserPromptSubmit）写回 running + 活 pid
    const livePid = await startSleeper();
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now,
      pid: livePid, liveness: "running", livenessTs: now, lastEventTs: now,
    });

    const round = await sweepMembersOnce(deps());
    expect(round.dead).not.toContain("b");
    // 重新武装：台账翻 alive
    expect((await ledgerEntry("b", "sess_b"))?.state).toBe("alive");
    // 记录仍是钩子写的 running——clearSessionDead 的零写纪律：只清「仍自述 dead」的记录，
    // 不把更新鲜的 running 自述盖回 idle（也不会伪造一条 session-idle{prev:'dead'}）。
    expect((await readSession(root, "sess_b"))?.liveness).toBe("running");
    expect(eventsOf("session-idle").filter((e) => e["prev"] === "dead")).toEqual([]);
  });

  it("正向复活证据②：peer 端点变活（live 证据）压过记录里陈旧的 dead 自述 → 重新武装并清回 idle", async () => {
    await seedTeam();
    await sweepTwice();
    expect((await ledgerEntry("b", "sess_b"))?.state).toBe("dead");
    expect((await readSession(root, "sess_b"))?.liveness).toBe("dead");

    // 同一 sid 出现**活着的** peer 端点（会话重启后重新 identify 的形态）
    const livePeer = await startSleeper();
    await writePeerRecord(peerRoot, {
      pid: livePeer,
      sessionId: "sess_b",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-r7-b-live-${livePeer}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });

    const round = await sweepMembersOnce(deps());
    expect(round.dead).not.toContain("b");
    // 重新武装：台账 alive + clearSessionDead 把仍自述 dead 的记录清回 idle
    expect((await ledgerEntry("b", "sess_b"))?.state).toBe("alive");
    expect((await readSession(root, "sess_b"))?.liveness).toBe("idle");
    const idleEvents = eventsOf("session-idle")
      .filter((e) => e["prev"] === "dead" && e["sessionId"] === "sess_b");
    expect(idleEvents).toHaveLength(1);
  });

  it("存量形态：台账 dead 但注册表记录不是 dead → 与修复前一致（照旧重新武装）", async () => {
    await seedTeam();
    // 直接写一个「升级前存量」台账：b 已 dead，但注册表记录**不**自述 dead
    // （旧版本没有 markSessionDead 双写，记录停在 idle）。
    await writeWatchdogState(root, {
      version: 1,
      members: {
        [watchdogLedgerKey("b", "sess_b")]: {
          state: "dead", at: Date.now() - 600_000, liveness: "pid-dead",
          evidence: "process-dead", notify: "sent",
        },
      },
      limbo: {},
      nonces: {},
    });
    const record = await readSession(root, "sess_b");
    await writeSession(root, { ...record!, liveness: "idle", livenessTs: Date.now() - 60_000 });

    await sweepMembersOnce(deps());
    // 存量形态照旧重新武装（视图的 dead 在记录不自述 dead 时就等于「活性 === pid-dead」，
    // 与旧判据逐字节等价）——本条锁「不因修法把存量也冻成死人」。
    expect((await ledgerEntry("b", "sess_b"))?.state).toBe("alive");
  });

  it("连带：lead 已判亡 + pid 复用 → leadCurrentlyDead 仍为真（通知继续改投队友，不投死 lead）", async () => {
    await seedTeam();
    const first = await sweepTwice();
    expect(first.leadCurrentlyDead).toBe(true);
    expect(first.dead.sort()).toEqual(["a", "b"]);

    // lead a 的旧 pid 也被回收复用
    await recyclePid("sess_a");
    const second = await sweepMembersOnce(deps());
    expect(second.leadCurrentlyDead, "pid 复用不应把死 lead 洗成活").toBe(true);
    // lead 的台账也仍 dead、注册表仍 dead
    expect((await ledgerEntry("a", "sess_a"))?.state).toBe("dead");
    expect((await readSession(root, "sess_a"))?.liveness).toBe("dead");
    const wakesBefore = eventsOf("watchdog-wake").length;

    // 再造一次事故（c 死）⇒ 死 lead 不能变成收件人
    const now = Date.now();
    const deadC = await startAndKill();
    await writeSession(root, {
      sessionId: "sess_c", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 90_000,
      pid: deadC, liveness: "running", livenessTs: now - 90_000, lastEventTs: now - 90_000,
    });
    await sweepTwice();
    expect(eventsOf("watchdog-wake").length).toBe(wakesBefore);
    expect(eventsOf("watchdog-wake").filter((e) => e["to"] === "a")).toEqual([]);
    expect(eventsOf("watchdog-notify-skipped").length).toBeGreaterThanOrEqual(1);
  });

  it("连带：往轮死者的未认领单在 pid 复用后仍每轮自愈回池（回池面不静默停摆）", async () => {
    await seedTeam();
    // 给 b 派一张未认领单（pending ∧ assignee 空 ∧ to=b）
    const team = (await import("../core/teamstate.js").then((m) => m.readTeam(root, "default")))! as TeamState;
    const task: Task = {
      id: "t-b1", title: "派给 b 的单", prompt: "p", dependsOn: [], status: "pending",
      assignee: null, attempt: 0, attemptId: null, createdBy: "a", to: "b",
      createdAt: Date.now(), updatedAt: Date.now(), lastProgressTs: Date.now(),
      result: null, error: null, evidence: [], history: [],
    } as Task;
    team.tasks.push(task);
    await writeTeam(root, team);
    await sweepTwice();
    // 判死即回池（创建者收到回执）
    expect(eventsOf("member-unclaimed-repooled").length).toBeGreaterThanOrEqual(1);

    // pid 复用后再派一张给死者的单：仍要被自愈回池（字符串判据下这里会静默停摆）
    await recyclePid("sess_b");
    const team2 = (await import("../core/teamstate.js").then((m) => m.readTeam(root, "default")))! as TeamState;
    team2.tasks.push({ ...task, id: "t-b2", title: "停机后新派给死者的单" } as Task);
    await writeTeam(root, team2);
    const repoolBefore = eventsOf("member-unclaimed-repooled").length;
    await sweepMembersOnce(deps());
    expect(eventsOf("member-unclaimed-repooled").length, "pid 复用后未认领单仍应自愈回池")
      .toBeGreaterThan(repoolBefore);
    // 回池的那张确实是 t-b2
    const repooled = eventsOf("member-unclaimed-repooled");
    expect(JSON.stringify(repooled[repooled.length - 1])).toContain("t-b2");
  });
});
