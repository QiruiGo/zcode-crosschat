/**
 * v0.9.5（A2/A7）定向测试：**首见新鲜死亡不静音**与**休眠恢复补扫**
 * （41-v095 方案 §一 组A A2 + A7）。
 *
 * A2（V094-13）：新鲜度判据补 registry 会话记录 lastEventTs 与引擎证言 witness ts
 * （不只看 peer 记录）——方案验收原文：「构造『peer 无记录 + witness 90s 内』→
 * member-dead 恰一条」。旧判据只扫 peer 注册记录，引擎成员从未 peer 注册（每次工具
 * 调用的 server 短命、干净注销）时 90 秒前还活着的成员被当存量死记录永久静音。
 *
 * A7（batch 12）：机器休眠 14.5h = 监控盲区——恢复后首扫应补扫而非按首见：
 * - 定时器面检测扫描间隔 > 2×周期 → `watchdog-resume{gapMs}`（共享台账去重，恰一条）；
 * - 补扫窗口（min(gapMs, 7 天)）内死亡按补扫告警（不静音）；窗口外照旧静音（防误报）；
 * - 正常间隔零事件（验收判据）。
 *
 * 纪律：真活进程 pid（kill 出真进程死，C8 同款）；合成时刻只走 sweepMembersOnce 的
 * `now` 注入与 timer 面的 Date mock（toFake:['Date']，定时器真实调度）。
 *
 * v0.10.0（组 A / R3）口径变化：**连续两个扫描周期都判死才发 member-dead**（二次确认，
 * 需求书 R3 修法④）。死亡用例在 seed 之后先跑一个 suspect 周期（只记台账 +
 * suspect-dead 审计），原断言移到第二个周期之后——断言本身逐字不变。补扫轮（resume）
 * 的「窗外死记录静默认认」路径不受影响（首周期即静默认领，零告警口径原样）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSession, writeSessionWitness, readSessionWitness } from "../core/registry.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { writePeerRecord } from "../core/peerregistry.js";
import { localPidDomain } from "../core/peerdir.js";
import { sweepMembersOnce, startMemberWatchdog, type WatchdogDeps } from "./watchdog.js";
import { pidAlive } from "../core/lock.js";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a2a7-v095-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-a2a7-v095-peers-"));
  dirs.push(root, peerRoot);
});

afterEach(() => {
  vi.useRealTimers();
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

/** 建 lead a（活 peer 记录可寻址）+ 成员 b（无 peer 记录，V094-13 形态）。 */
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
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-a2a7-lead-${leadPid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  });
}

/** 成员 b：崩溃形态——会话记录 pid 已亡 + running 自述悬停（无 Stop 钩子）、无 peer 记录。 */
async function seedCrashedMember(opts: { lastEventAgeMs?: number; witnessAgeMs?: number } = {}): Promise<number> {
  const now = Date.now();
  const deadPid = await startSleeper();
  await killSleeper(deadPid);
  await writeSession(root, {
    sessionId: "sess_b",
    cwd: "D:\\ws",
    startedAt: now - 3_600_000,
    lastSeen: now - (opts.lastEventAgeMs ?? 90_000),
    pid: deadPid,
    liveness: "running",
    livenessTs: now - 3_600_000,
    lastEventTs: now - (opts.lastEventAgeMs ?? 90_000),
  });
  if (opts.witnessAgeMs !== undefined) {
    await writeSessionWitness(root, "sess_b", "heartbeat", now - opts.witnessAgeMs);
  }
  return deadPid;
}

function deps(): WatchdogDeps {
  return { stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } };
}

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ─────────────────────────────── A2：首见新鲜死亡不静音 ───────────────────────────────

describe("v0.9.5 A2/V094-13：新鲜度三源合判（peer 记录之外的死亡不再静音）", () => {
  it("【方案验收锚点】peer 无记录 + witness 90s 内 → member-dead 恰一条（旧实现判存量永久静音）", async () => {
    await seedTeam();
    await seedCrashedMember({ witnessAgeMs: 90_000, lastEventAgeMs: 90_000 });
    // v0.10.0（组 A / R3）：第一周期只记 suspect（不发 member-dead、不告警）
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual(["b"]);
    expect(summary.firstSightDead).toEqual(["b"]);
    const events = readEngineEvents().filter((e) => e["event"] === "member-dead");
    expect(events).toHaveLength(1); // 恰一条
    expect(events[0]!["member"]).toBe("b");
    expect(events[0]!["liveness"]).toBe("pid-dead");
    // lead 邮箱有通知（告警一次 = 事件 + 通知，不是零事件零通知的旧形态）
    const inboxFile = join(root, "teams", "default", "inbox", "a.jsonl");
    expect(existsSync(inboxFile)).toBe(true);
    expect(readFileSync(inboxFile, "utf8")).toContain("进程已亡");
  });

  it("registry lastEventTs 90s 内（无证言、无 peer 记录）→ 同样告警（第二证据源独立有效）", async () => {
    await seedTeam();
    await seedCrashedMember({ lastEventAgeMs: 90_000 }); // 不写证言
    // v0.10.0（组 A / R3）：第一周期 suspect、第二周期认领告警
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual(["b"]);
    expect(readEngineEvents().filter((e) => e["event"] === "member-dead")).toHaveLength(1);
  });

  it("v0.9.6 A3/V095-07：三源全窗外（peer 无记录 + witness/lastEventTs 2h 前）+ 常规轮 → 首见死亡默认告警（宁误报一次，附【首见】标注）", async () => {
    // v0.9.5 口径（本例原为负例）：三源全过期 → 存量死记录静默认领（notify:'sent'，
    // 零事件零审计）。V095-07 推翻：t2 实测形态（引擎成员未 peer 注册 + 无工具回合 +
    // 台账无历史，回合 >10min 后进程死）三源必然全过期——静默 = 真崩溃被吞。v0.9.6 起
    // **常规轮首见一律告警**（宁误报一次）；「窗外静音」只保留在补扫轮（resume）的
    // 补扫窗（≤7 天）之外（见 watchdog-v096-fixd.test.ts）。
    await seedTeam();
    await seedCrashedMember({ witnessAgeMs: 2 * 3_600_000, lastEventAgeMs: 2 * 3_600_000 });
    // v0.10.0（组 A / R3）：第一周期 suspect、第二周期认领并告警（首见标注不变）
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual(["b"]);
    expect(summary.firstSightDead).toEqual(["b"]);
    const events = readEngineEvents().filter((e) => e["event"] === "member-dead");
    expect(events).toHaveLength(1);
    // 首见标注（宁误报一次）：lead 能把启动期存量死记录形态的误报安全忽略
    const inboxFile = join(root, "teams", "default", "inbox", "a.jsonl");
    const mail = readFileSync(inboxFile, "utf8");
    expect(mail).toContain("【首见】");
    expect(mail).toContain("宁误报一次");
    // 台账按复合键认领；通知落地后转 sent（不留给重发队列）
    const state = JSON.parse(readFileSync(join(root, "capacity", "watchdog-state.json"), "utf8")) as {
      members: Record<string, { state: string; notify?: string }>;
    };
    expect(state.members["b|sess_b"]?.state).toBe("dead");
    expect(state.members["b|sess_b"]?.notify).toBe("sent");
    // 同化身同一次死亡不重复
    expect((await sweepMembersOnce(deps())).dead).toEqual([]);
    expect(readEngineEvents().filter((e) => e["event"] === "member-dead")).toHaveLength(1);
  });
});

// ─────────────────────────────── A7：休眠恢复补扫 ───────────────────────────────

describe("v0.9.5 A7：休眠恢复补扫（watchdog-resume + 窗口内死亡补扫告警）", () => {
  it("【方案验收锚点】模拟时钟跳跃（gap 14.5h > 2×周期）→ watchdog-resume{gapMs} 一条 + 窗口内死亡补扫告警一条", async () => {
    await seedTeam();
    // 死亡发生在盲区：witness/lastEventTs 距恢复后首扫 14h（> 10min 新鲜窗，< 14.5h 补扫窗）
    await seedCrashedMember({ witnessAgeMs: 14 * 3_600_000, lastEventAgeMs: 14 * 3_600_000 });
    const gapMs = 14.5 * 3_600_000;
    const resumeOpts = { resume: { gapMs, catchupWindowMs: Math.min(gapMs, 7 * 24 * 3_600_000) } };
    // v0.10.0（组 A / R3）：恢复后首周期只记 suspect（补扫口径照跑：resume 事件落账）；
    // 第二个补扫周期仍判死 → 认领 + 补扫口径告警（文案含「补扫」）。
    const first = await sweepMembersOnce(deps(), Date.now(), resumeOpts);
    // resume 事件恰一条（带 gapMs 与补扫窗）
    const resumes = readEngineEvents().filter((e) => e["event"] === "watchdog-resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!["gapMs"]).toBe(gapMs);
    expect(resumes[0]!["catchupWindowMs"]).toBe(gapMs);
    expect(first.resume).toEqual({ gapMs, catchupWindowMs: gapMs });
    expect(first.deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps(), Date.now(), resumeOpts);
    // 窗口内死亡按补扫告警（不静音）
    expect(summary.resume).toEqual({ gapMs, catchupWindowMs: gapMs });
    expect(summary.dead).toEqual(["b"]);
    expect(readEngineEvents().filter((e) => e["event"] === "member-dead")).toHaveLength(1);
    const inboxFile = join(root, "teams", "default", "inbox", "a.jsonl");
    expect(readFileSync(inboxFile, "utf8")).toContain("补扫");
  });

  it("补扫上界 7 天：gap 30 天但死亡存活证据 10 天前（窗外）→ 不告警（防误报）", async () => {
    await seedTeam();
    const deadPid = await startSleeper();
    await killSleeper(deadPid);
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 11 * 24 * 3_600_000,
      lastSeen: now - 10 * 24 * 3_600_000, pid: deadPid,
      liveness: "running", livenessTs: now - 11 * 24 * 3_600_000,
      lastEventTs: now - 10 * 24 * 3_600_000,
    });
    await writeSessionWitness(root, "sess_b", "heartbeat", now - 10 * 24 * 3_600_000);
    const gapMs = 30 * 24 * 3_600_000;
    const summary = await sweepMembersOnce(deps(), now, {
      resume: { gapMs, catchupWindowMs: Math.min(gapMs, 7 * 24 * 3_600_000) }, // = 7 天
    });
    expect(summary.dead).toEqual([]); // 10 天前的死亡在 7 天窗外 → 不翻旧账
    expect(readEngineEvents().filter((e) => e["event"] === "member-dead")).toHaveLength(0);
    expect(readEngineEvents().filter((e) => e["event"] === "watchdog-resume")).toHaveLength(1); // resume 事件照落
  });

  it("多把扫描同刻恢复：共享台账去重 → watchdog-resume 恰一条（第二把只按补扫口径跑）", async () => {
    await seedTeam();
    await seedCrashedMember({ witnessAgeMs: 90_000, lastEventAgeMs: 90_000 });
    const now = Date.now();
    const resumeInput = { resume: { gapMs: 14.5 * 3_600_000, catchupWindowMs: 14.5 * 3_600_000 } as const };
    // v0.10.0（组 A / R3）：第一把记 suspect、第二把认领——死亡认领仍由 watchdog-state
    // 台账去重（同一次死亡只告警一次），「恰一条 member-dead」的断言不变。
    const first = await sweepMembersOnce(deps(), now, resumeInput);
    const second = await sweepMembersOnce(deps(), now + 1_000, resumeInput); // 1s 后的另一把扫描
    expect(first.resume).toBeDefined();
    expect(second.resume).toBeDefined();
    expect(readEngineEvents().filter((e) => e["event"] === "watchdog-resume")).toHaveLength(1);
    // 死亡认领由 watchdog-state 台账去重：同一次死亡只告警一次
    expect(readEngineEvents().filter((e) => e["event"] === "member-dead")).toHaveLength(1);
    expect(first.deathSuspects).toEqual(["b"]);
    expect(second.dead).toEqual(["b"]);
  });

  it("正常间隔（不传 resume）→ 零补扫事件（验收判据：正常间隔不写）", async () => {
    await seedTeam();
    await sweepMembersOnce(deps());
    await sweepMembersOnce(deps());
    expect(readEngineEvents().filter((e) => e["event"] === "watchdog-resume")).toHaveLength(0);
    expect(readEngineEvents().filter((e) => e["event"] === "member-dead")).toHaveLength(0);
  });

  it("定时器面检测（真实调度 + Date mock）：间隔 > 2×周期 → 恢复事件；正常节拍 → 零事件", async () => {
    await seedTeam();
    const t0 = 1_700_000_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const timer = startMemberWatchdog(deps(), 20);
    expect(timer).toBeDefined();
    // 正常节拍：真实时间流动 ~120ms（Date 仍停在 t0，间隔 0 ≤ 2×20ms）→ 零事件
    await new Promise((r) => setTimeout(r, 120));
    expect(readEngineEvents().filter((e) => e["event"] === "watchdog-resume")).toHaveLength(0);
    // 模拟时钟跳跃 +3h：下一拍真实间隔（mock 墙钟）= 3h > 40ms → 恢复事件
    vi.setSystemTime(t0 + 3 * 3_600_000);
    await new Promise((r) => setTimeout(r, 200));
    timer!.unref();
    clearInterval(timer!);
    const resumes = readEngineEvents().filter((e) => e["event"] === "watchdog-resume");
    expect(resumes).toHaveLength(1);
    expect(Number(resumes[0]!["gapMs"])).toBeGreaterThanOrEqual(3 * 3_600_000 - 1000);
    vi.useRealTimers();
  });
});

// 证言写入后的自检（防测试自身写坏形状：witness 读不回来会让 A2 断言失真）
describe("测试夹具自检", () => {
  it("seedCrashedMember 写入的证言可读回（readSessionWitness 形状正确）", async () => {
    await seedCrashedMember({ witnessAgeMs: 90_000 });
    const witness = await readSessionWitness(root, "sess_b");
    expect(witness?.kind).toBe("heartbeat");
    expect(typeof witness?.ts).toBe("number");
  });
});
