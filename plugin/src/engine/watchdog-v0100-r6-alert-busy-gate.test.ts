/**
 * v0.10.0（集成员·第 6 轮）定向单测：**看门狗成员死亡告警的忙闲闸**
 * （plugin/src/engine/watchdog.ts notifyAndWake）。
 *
 * 缺口（真实复测第 0.1 节第 2 条 + 裁决员打磨清单）：notifyAndWake 对非 lead 收件人直接
 * attemptWake，不看对方是否在途——死亡告警发给正跑到一半的队友时，会给同一个会话再拉一路
 * 无头回合，正是 R2 忙闲闸要消的双回合形态（两路抢信箱、重复劳动）。
 *
 * 修法：收件人（含 XC_WATCHDOG_WAKE_LEAD=1 时的 lead）在 attemptWake 之前过与派单忙闲闸
 * **同款判据**（任务板 claimed/in_progress ∨ 注册表 liveness=running 且 livenessTs 可信）；
 * 忙则不唤醒——urgent 告警照落邮箱，watchdog-wake 事件照落（delivered=mailbox + note 写明
 * 是因为成员回合进行中而未唤醒，不新增任何键，§15.5 冻结面不动）。
 *
 * 覆盖（任务书点名的四条 + 两条边界）：
 *  1. 在途成员收到告警但没有第二次唤醒（零 attemptWake、零 nonce、零 wake-deferred）；
 *  2. 空闲成员照旧被唤醒（真 spawn，delivered=wake）；
 *  3. lead 不受影响（默认只写邮箱、note 是 XC_WATCHDOG_WAKE_LEAD 那条，逐字节不变）；
 *  4. watchdog-wake 的键集不越 PROTOCOL §15.5 冻结面（note 是既有可选键）；
 *  5. XC_WATCHDOG_WAKE_LEAD=1 时 lead 也走同一道忙闲闸；
 *  6. 在途任务判据（①）与 running 自述判据（②）各自单独成立。
 *
 * 夹具纪律：状态根与 peer 注册表全部落系统 TEMP；用 fake spawn 让「真唤醒」可计数
 * （WatchdogDeps.spawn 测试注入，与 capacitySample 同纪律）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  sweepMembersOnce,
  type WatchdogDeps,
} from "./watchdog.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import { writeSession, writeSessionWitness } from "../core/registry.js";
import { writePeerRecord } from "../core/peerregistry.js";
import { localPidDomain } from "../core/peerdir.js";
import { pidAlive } from "../core/lock.js";
import type { CapacitySample } from "../core/capacity.js";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli.js";
import type { Task, TeamState } from "../core/types.js";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];
const spawnCalls: SpawnResumeOptions[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wd-v0100r6-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-wd-v0100r6-peers-"));
  dirs.push(root, peerRoot);
  spawnCalls.length = 0;
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

async function killSleeper(pid: number): Promise<void> {
  sleepers.find((c) => c.pid === pid)?.kill();
  const deadline = Date.now() + 10_000;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pidAlive(pid)).toBe(false);
}

/** 一条死掉的 peer 记录（pid 已亡 → 下次扫描进 dead 分区，reason=pid-dead）。 */
async function seedDeadPeerRecord(sessionId: string, tag: string): Promise<number> {
  const pid = await startSleeper();
  await writePeerRecord(peerRoot, {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-r6-${tag}-${pid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "bg",
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  });
  await killSleeper(pid);
  return pid;
}

/**
 * 团队形态：lead a（pid-dead，故告警改投队友）+ 成员 b（本轮判死的事故源）
 * + 成员 c（在途：running 自述或在途任务）+ 成员 d（空闲对照）。
 */
async function seedTeam(opts: { busyBy?: "session-running" | "open-task" } = {}): Promise<void> {
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
    { key: "d", sessionId: "sess_d", role: "worker", joinedAt: 1, lastSeen: 1 },
  );
  // a 与 b：pid 已亡（peer 记录进 dead 分区；无会话记录 ⇒ 无活 pid 可否否决）。
  await seedDeadPeerRecord("sess_a", "a");
  await seedDeadPeerRecord("sess_b", "b");
  // c：会话记录带活 pid。busyBy=session-running → liveness=running 且时刻新鲜；
  //    busyBy=open-task → liveness=idle（判据①那张在途任务独立成立）。
  const cPid = await startSleeper();
  await writeSession(root, {
    sessionId: "sess_c",
    cwd: "D:\\ws",
    startedAt: now - 3_600_000,
    lastSeen: now - 10_000,
    pid: cPid,
    liveness: opts.busyBy === "open-task" ? "idle" : "running",
    livenessTs: now - 10_000,
    lastEventTs: now - 10_000,
  });
  if (opts.busyBy === "open-task") {
    await writeSessionWitness(root, "sess_c", "idle", now - 10_000);
  }
  // d：空闲（活 pid + idle 自述 + idle 证言）——照旧被唤醒的对照组。
  const dPid = await startSleeper();
  await writeSession(root, {
    sessionId: "sess_d",
    cwd: "D:\\ws",
    startedAt: now - 3_600_000,
    lastSeen: now - 60_000,
    pid: dPid,
    liveness: "idle",
    livenessTs: now - 60_000,
    lastEventTs: now - 60_000,
  });
  await writeSessionWitness(root, "sess_d", "idle", now - 60_000);
  // busyBy=open-task：给 c 派一张 in_progress 单（任务板判据①）——直接进 team 快照，
  // 与 writeTeam 同一次落盘（不用先读后写：此刻 team.json 还没写）。
  if (opts.busyBy === "open-task") {
    const task: Task = {
      id: "t-c1",
      title: "c 的在途单",
      prompt: "p",
      dependsOn: [],
      status: "in_progress",
      assignee: "c",
      attempt: 1,
      attemptId: "att-c1",
      createdBy: "a",
      createdAt: now - 120_000,
      updatedAt: now - 60_000,
      lastProgressTs: now - 60_000,
      result: null,
      error: null,
      evidence: [],
      history: [],
    } as Task;
    team.tasks.push(task);
  }
  await writeTeam(root, team);
}

function greenSample(): CapacitySample {
  return {
    sampledAt: Date.now(),
    totalBytes: 32_000_000_000,
    freeBytes: 28_000_000_000,
    watermark: 0.875,
    steadyTreeBytes: 3_000_000_000,
    headlessTurnCount: 0,
    headlessTurnMaxRssBytes: null,
    degraded: null,
  };
}

/** fake spawn：模拟真实 helper——拉起唤醒子后经 onHelperSpawned 汇报 pid。 */
function fakeSpawn(opts: SpawnResumeOptions): SpawnResumeResult {
  spawnCalls.push(opts);
  opts.onHelperSpawned?.(4242);
  return { pid: 4242, logFile: opts.logFile };
}

/** 真唤醒路径的 deps（唤醒闸开 + GREEN 容量 + fake spawn；生产路径三项都不传）。 */
function deps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    stateRoot: root,
    workspace: "D:\\ws",
    env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true" },
    capacitySample: greenSample(),
    spawn: fakeSpawn,
    ...overrides,
  };
}

/** PROTOCOL §15.5 watchdog-wake 冻结键集（行级 ts 除外；note/wakeDeferred/retryAfterMs/detail 为可选键）。 */
const WATCHDOG_WAKE_KEYS = new Set([
  "event", "teamId", "to", "delivered", "note", "wakeDeferred", "retryAfterMs", "detail",
]);

/** 跑两轮扫描（第一轮 suspect、第二轮确认并告警）并返回第二轮 summary。 */
async function sweepTwice(d: WatchdogDeps = deps()) {
  await sweepMembersOnce(d);
  return sweepMembersOnce(d);
}

// ───────────────── 主用例：在途成员不被二次唤醒，空闲成员照旧 ─────────────────

describe("v0.10.0 集成员·R6：成员死亡告警的忙闲闸（notifyAndWake）", () => {
  it("在途成员（running 自述）收到告警但没有第二次唤醒；空闲成员照旧被唤醒", async () => {
    await seedTeam({ busyBy: "session-running" });
    const summary = await sweepTwice();
    // 事故成立：b 判死（两周期确认），lead a 也已亡 ⇒ 告警改投队友 c/d
    expect(summary.dead).toContain("b");
    expect(summary.leadCurrentlyDead).toBe(true);
    expect(eventsOf("member-dead").some((e) => e["member"] === "b")).toBe(true);

    // 邮箱：c 与 d 都收到 urgent 告警（闸只挡唤醒，不挡投递）
    const boxC = readMailboxFor("c");
    const boxD = readMailboxFor("d");
    expect(boxC).toHaveLength(1);
    expect(boxC[0]!.urgent).toBe(true);
    expect(boxD).toHaveLength(1);
    expect(boxD[0]!.urgent).toBe(true);

    // 唤醒：只有空闲的 d 被真唤醒（spawnCalls 恰 1 条且 to=d）；c 零唤醒痕迹
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.sessionId).toBe("sess_d");
    expect(eventsOf("wake-deferred")).toHaveLength(0); // 没有任何 attemptWake 被容量闸挡下
    // c 从未被 attemptWake 调用过：registry/wake 里只有 d 的那一张 nonce
    // （文件名是票据 token 不含 sid，故读文件体的 agentKey 判归属）。
    const wakeDir = join(root, "registry", "wake");
    const nonceFiles = existsSync(wakeDir) ? readdirSync(wakeDir).filter((f) => f.endsWith(".json")) : [];
    const nonceAgents = nonceFiles.map((f) => {
      try {
        return JSON.parse(readFileSync(join(wakeDir, f), "utf8")) as { agentKey?: string };
      } catch {
        return {} as { agentKey?: string };
      }
    }).map((n) => n.agentKey);
    expect(nonceAgents).toEqual(["d"]);

    // watchdog-wake 审计：c = delivered:mailbox + note 写明「回合进行中」；d = delivered:wake
    const wakes = eventsOf("watchdog-wake");
    const wakeC = wakes.find((e) => e["to"] === "c");
    const wakeD = wakes.find((e) => e["to"] === "d");
    expect(wakeC).toBeDefined();
    expect(wakeC!["delivered"]).toBe("mailbox");
    expect(String(wakeC!["note"])).toContain("回合进行中");
    expect(String(wakeC!["note"])).toContain("不发起唤醒");
    expect(wakeD).toBeDefined();
    expect(wakeD!["delivered"]).toBe("wake");

    // 键集不越 §15.5 冻结面（note 是既有可选键；没有任何新键）
    for (const event of wakes) {
      for (const key of Object.keys(event)) {
        if (key === "ts") continue;
        expect(WATCHDOG_WAKE_KEYS.has(key), `watchdog-wake 越界键: ${key}`).toBe(true);
      }
    }
    // summary 同步记账（观测面）
    expect(summary.wakes.find((w) => w.to === "c")?.delivered).toBe("mailbox");
    expect(String(summary.wakes.find((w) => w.to === "c")?.note)).toContain("回合进行中");
    expect(summary.wakes.find((w) => w.to === "d")?.delivered).toBe("wake");
  });

  it("在途成员（任务板 in_progress）同样被挡下——判据① 独立成立", async () => {
    await seedTeam({ busyBy: "open-task" });
    const summary = await sweepTwice();
    expect(summary.dead).toContain("b");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.sessionId).toBe("sess_d");
    const wakeC = eventsOf("watchdog-wake").find((e) => e["to"] === "c");
    expect(wakeC!["delivered"]).toBe("mailbox");
    expect(String(wakeC!["note"])).toContain("回合进行中");
    expect(String(wakeC!["note"])).toContain("t-c1"); // note 点名在途任务
  });

  it("lead 不受影响：默认档只写邮箱（note 是 XC_WATCHDOG_WAKE_LEAD 那条，逐字节不变）", async () => {
    // lead a 活着（活 peer 记录 + 活会话 pid）⇒ 收件人只有 lead
    const now = Date.now();
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
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-r6-lead-${leadPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    // b：本轮判死的事故源（pid 亡 + 无在途任务/唤醒）
    await seedDeadPeerRecord("sess_b", "b");
    // lead 自己的会话记录：**在途**（running）——默认档下它照样只写邮箱不唤醒
    await writeSession(root, {
      sessionId: "sess_a", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 5_000,
      pid: leadPid, liveness: "running", livenessTs: now - 5_000, lastEventTs: now - 5_000,
    });

    await sweepTwice();
    const wakes = eventsOf("watchdog-wake");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!["to"]).toBe("a");
    expect(wakes[0]!["delivered"]).toBe("mailbox");
    expect(String(wakes[0]!["note"])).toContain("XC_WATCHDOG_WAKE_LEAD");
    expect(String(wakes[0]!["note"])).toContain("未尝试唤醒");
    expect(String(wakes[0]!["note"])).not.toContain("回合进行中"); // 走的是 lead 分支，不是忙闲闸
    expect(spawnCalls).toHaveLength(0);
    // lead 邮箱里那条 urgent 告警照留
    const box = readMailboxFor("a");
    expect(box).toHaveLength(1);
    expect(box[0]!.urgent).toBe(true);
  });

  it("XC_WATCHDOG_WAKE_LEAD=1 时 lead 也走同一道忙闲闸（在途 ⇒ 不唤醒；空闲 ⇒ 唤醒）", async () => {
    const now = Date.now();
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
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-r6-lead2-${leadPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    await seedDeadPeerRecord("sess_b", "b");
    // lead 在途（running 自述）
    await writeSession(root, {
      sessionId: "sess_a", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 5_000,
      pid: leadPid, liveness: "running", livenessTs: now - 5_000, lastEventTs: now - 5_000,
    });

    await sweepTwice(deps({ env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true", XC_WATCHDOG_WAKE_LEAD: "1" } }));
    let wakes = eventsOf("watchdog-wake");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!["delivered"]).toBe("mailbox");
    expect(String(wakes[0]!["note"])).toContain("回合进行中");
    expect(spawnCalls).toHaveLength(0);

    // lead 回合结束（Stop 钩子 → idle）后再扫：照旧被唤醒（闸不误挡空闲收件人）
    await writeSession(root, {
      sessionId: "sess_a", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 5_000,
      pid: leadPid, liveness: "idle", livenessTs: now - 5_000, lastEventTs: now - 5_000,
    });
    await writeSessionWitness(root, "sess_a", "idle", now - 5_000);
    // 再造一次事故源：新成员 c（peer 记录 pid 已亡 ⇒ 扫描进 dead 分区判 pid-dead）。
    const cPid = await startSleeper();
    await killSleeper(cPid);
    await seedDeadPeerRecord("sess_c", "c2");
    await writeSession(root, {
      sessionId: "sess_c", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 90_000,
      pid: cPid, liveness: "idle", livenessTs: now - 90_000, lastEventTs: now - 90_000,
    });
    const current = (await readTeam(root, "default"))! as TeamState;
    current.members.push({ key: "c", sessionId: "sess_c", role: "worker", joinedAt: 1, lastSeen: 1 });
    await writeTeam(root, current);
    spawnCalls.length = 0;
    await sweepMembersOnce(deps({ env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true", XC_WATCHDOG_WAKE_LEAD: "1" } }));
    await sweepMembersOnce(deps({ env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true", XC_WATCHDOG_WAKE_LEAD: "1" } }));
    wakes = eventsOf("watchdog-wake");
    const wakeA = wakes.filter((e) => e["to"] === "a");
    expect(wakeA.length).toBeGreaterThanOrEqual(1);
    expect(wakeA[wakeA.length - 1]!["delivered"]).toBe("wake"); // 空闲后被真唤醒
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
  });
});

/** 读一名成员的邮箱全文（行 = JSON 消息）。 */
function readMailboxFor(member: string): Array<{ urgent?: boolean; from: string; content: string }> {
  const file = join(root, "teams", "default", "inbox", `${member}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { urgent?: boolean; from: string; content: string });
}
