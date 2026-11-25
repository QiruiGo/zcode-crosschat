/**
 * v0.9.6（组 D·死亡与补扫）定向测试：44-v096方案.md §一 组A 的 A2/A3/A4 三项缺陷。
 *
 * - **A2 / V095-06 同键重供给静音**：v0.9.5 台账按键（成员名）记账，同名重供给（member-add
 *   换新会话）后新化身死在首拍内被 `previous.state==='dead'` 吞掉。修法：台账键改
 *   `(成员名, sessionId)` 复合键（watchdogLedgerKey）；旧格式条目一次性清除（宁误报不静音）；
 *   死亡文案不再「自荐误导」（重供给路径如实注明按 (成员,会话) 独立记账）。
 * - **A3 / V095-07 首见新鲜死亡静音**：引擎成员未 peer 注册 + 无工具回合（三源全过期）+
 *   台账无历史 → 常规轮首见死亡**默认告警**（宁误报一次，文案附【首见】标注）；「窗外静音」
 *   只保留在补扫轮（resume）的补扫窗（≤7 天）之外——A7 的防误报上界不回退。
 * - **A4 / V095-10+13 补扫窗收缩与时钟阻塞**：补扫窗 = min(max(gapMs, 常规 10min 新鲜窗),
 *   7 天上界)（短恢复不再把新鲜窗收缩到 gapMs）；恢复判据加 60s 下界钳制（事件循环秒级
 *   同步阻塞不得判恢复 → 不落误报事件、无同款静音）。
 *
 * 纪律（与 watchdog-v095-a2a7.test.ts 同款）：真活进程 pid（kill 出真进程死）；合成时刻
 * 只走 sweepMembersOnce 的 `now` 注入与 timer 面的 Date mock（toFake:['Date']，定时器真实调度）。
 *
 * v0.10.0（组 A / R3）口径变化：**连续两个扫描周期都判死才发 member-dead**（二次确认）。
 * 死亡用例在 seed 之后先跑一个 suspect 周期，原断言移到第二个周期之后——断言本身逐字
 * 不变。补扫轮（resume）的「窗外死记录静默认认」路径不受影响（首周期即静默认领）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSession, writeSessionWitness } from "../core/registry.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { writePeerRecord } from "../core/peerregistry.js";
import { localPidDomain } from "../core/peerdir.js";
import {
  WATCHDOG_FRESH_DEATH_MS,
  WATCHDOG_RESUME_CATCHUP_MAX_MS,
  WATCHDOG_RESUME_GAP_FLOOR_MS,
  sweepMembersOnce,
  startMemberWatchdog,
  watchdogCatchupWindowMs,
  watchdogLedgerKey,
  type WatchdogDeps,
} from "./watchdog.js";
import { readWatchdogState, writeWatchdogState } from "./watchdog-state";
import { pidAlive } from "../core/lock.js";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-fixd-v096-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-fixd-v096-peers-"));
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

/** 建 lead a（活 peer 记录可寻址）+ 成员 b（指定 sid，无 peer 记录——引擎成员形态）。 */
async function seedTeam(memberSid: string = "sess_b1"): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  team.members.push({ key: "b", sessionId: memberSid, role: "worker", joinedAt: 1, lastSeen: 1 });
  await writeTeam(root, team);
  const leadPid = await startSleeper();
  await writePeerRecord(peerRoot, {
    pid: leadPid,
    sessionId: "sess_a",
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-fixd-lead-${leadPid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  });
}

/**
 * 成员 b 的崩溃形态：会话记录 pid 已亡 + running 自述悬停（无 Stop 钩子）、无 peer 记录。
 * `lastEventAgeMs` 同时控制会话记录 lastEventTs 的年龄（witness 年龄独立可选）。
 */
async function seedCrashedMember(
  sid: string,
  opts: { lastEventAgeMs?: number; witnessAgeMs?: number } = {},
): Promise<number> {
  const now = Date.now();
  const deadPid = await startSleeper();
  await killSleeper(deadPid);
  await writeSession(root, {
    sessionId: sid,
    cwd: "D:\\ws",
    startedAt: now - 3_600_000,
    lastSeen: now - (opts.lastEventAgeMs ?? 90_000),
    pid: deadPid,
    liveness: "running",
    livenessTs: now - 3_600_000,
    lastEventTs: now - (opts.lastEventAgeMs ?? 90_000),
  });
  if (opts.witnessAgeMs !== undefined) {
    await writeSessionWitness(root, sid, "heartbeat", now - opts.witnessAgeMs);
  }
  return deadPid;
}

/** 模拟 member-add 幂等重供给的 roster 侧：成员 b 换新 sid（state ready、清 pid 证据）。 */
async function reprovisionMember(newSid: string): Promise<void> {
  const teamFile = join(root, "teams", "default", "team.json");
  const team = JSON.parse(readFileSync(teamFile, "utf8")) as {
    members: Array<{ key: string; sessionId: string; state?: string; lastSeen: number }>;
  };
  const b = team.members.find((m) => m.key === "b")!;
  b.sessionId = newSid;
  b.state = "ready";
  b.lastSeen = Date.now();
  await import("node:fs/promises").then((fs) => fs.writeFile(teamFile, `${JSON.stringify(team, null, 2)}\n`, "utf8"));
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

function deadEvents(): Array<Record<string, unknown>> {
  return readEngineEvents().filter((e) => e["event"] === "member-dead");
}

function leadMail(): string {
  const file = join(root, "teams", "default", "inbox", "a.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// ─────────────────────── A2 / V095-06：同键重供给后新化身首拍死亡 ───────────────────────

describe("v0.9.6 A2/V095-06：台账复合键 (成员,会话)——重供给后的新化身死亡照常告警", () => {
  it("【方案验收锚点】重供给（换新 sid）→ 新化身死在首个扫描节拍内 → member-dead 恰 1 条（不再被旧化身的 dead 条目吞掉）", async () => {
    await seedTeam("sess_b1");
    // 第 1 化身（sess_b1）崩溃并被扫描认领：恰 1 条告警，台账记 `b|sess_b1`。
    // v0.10.0（组 A / R3）：kill 后先 suspect 一个周期，第二周期认领。
    await seedCrashedMember("sess_b1", { lastEventAgeMs: 90_000 });
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const first = await sweepMembersOnce(deps());
    expect(first.dead).toEqual(["b"]);
    expect(deadEvents()).toHaveLength(1);
    expect(deadEvents()[0]!["sessionId"]).toBe("sess_b1");
    const afterFirst = await readWatchdogState(root);
    expect(afterFirst.members["b|sess_b1"]?.state).toBe("dead");
    expect(afterFirst.members["b|sess_b1"]?.notify).toBe("sent");

    // 重供给：同名成员 b 换新会话 sess_b2（member-add 的 roster 侧效果），新化身
    // 供给后**任何扫描节拍之前**就崩溃（V095-06 的首拍形态）。
    await reprovisionMember("sess_b2");
    await seedCrashedMember("sess_b2", { lastEventAgeMs: 90_000 });

    // v0.10.0（组 A / R3）：新化身同样先 suspect 一个周期，第二周期认领。
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual(["b"]);
    expect(second.firstSightDead).toEqual(["b"]);
    // 恰 1 条新告警（总计 2 条 = 每化身一条；旧实现这里是 0——被 b 键的 dead 条目吞掉）
    expect(deadEvents()).toHaveLength(2);
    expect(deadEvents()[1]!["sessionId"]).toBe("sess_b2");
    // 复合键台账 + 花名册投影收敛：重供给（roster sid 已换）时旧化身的 dead 条目随之
    // 清除（「重供给时清 dead 态」的等效面）——新化身按复合键独立记账、告警不吞。
    const afterSecond = await readWatchdogState(root);
    expect(afterSecond.members["b|sess_b1"]).toBeUndefined();
    expect(afterSecond.members["b|sess_b2"]?.state).toBe("dead");
    expect(afterSecond.members["b|sess_b2"]?.notify).toBe("sent");
    // 同化身不重复：第三轮零新告警
    expect((await sweepMembersOnce(deps())).dead).toEqual([]);
    expect(deadEvents()).toHaveLength(2);
  });

  it("死亡文案不再自荐误导：附「待回池 + requeueAtMs」口径与重供给独立记账说明（A8 四面之一的文案面）", async () => {
    await seedTeam("sess_b1");
    await seedCrashedMember("sess_b1", { lastEventAgeMs: 90_000 });
    // v0.10.0（组 A / R3）：先 suspect 一个周期，第二周期认领后文案才落邮箱
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    await sweepMembersOnce(deps());
    const mail = leadMail();
    // 旧文案「名下任务请用 xc_overview 核对后用 xc_dispatch 重派，或用 … 幂等重供给」：
    // 冻结窗内去待领池找不到任务（V095-21）、重供给路径恰是静音路径（V095-06）。
    // 新文案：待回池 + 回池时刻指针（板面 requeueAtMs）+ 重供给独立记账说明。
    expect(mail).toContain("待回池");
    expect(mail).toContain("requeueAtMs");
    expect(mail).toContain("独立记账");
    expect(mail).not.toContain("名下任务请用 xc_overview 核对后用 xc_dispatch 重派");
  });

  it("旧格式台账（v0.9.5 按键记账）升级残留 → 一次性清除，不把旧化身的 dead 错记到新化身头上（宁误报不静音）", async () => {
    await seedTeam("sess_b2");
    // v0.9.5 形态：台账按键记了一条 dead（哪个化身的无从得知）
    const now = Date.now();
    await writeWatchdogState(root, {
      version: 1,
      members: {
        b: { state: "dead", at: now - 60_000, liveness: "pid-dead", evidence: "process-dead", notify: "sent" },
      },
      limbo: {},
      nonces: {},
    });
    // 当前化身（sess_b2，可能是重供给后的新化身）已死且证据过期
    await seedCrashedMember("sess_b2", { witnessAgeMs: 2 * 3_600_000, lastEventAgeMs: 2 * 3_600_000 });

    // v0.10.0（组 A / R3）：旧格式条目清除后按复合键先 suspect 一个周期，第二周期首见告警
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps());
    // 静音 = V095-06 残留；修复方向「宁误报一次」：旧格式清除后按复合键首见告警
    expect(summary.dead).toEqual(["b"]);
    expect(deadEvents()).toHaveLength(1);
    const after = await readWatchdogState(root);
    expect(after.members["b"]).toBeUndefined(); // 旧格式条目已清除
    expect(after.members["b|sess_b2"]?.state).toBe("dead");
  });
});

// ─────────────────────── A3 / V095-07：首见死亡默认告警（补扫轮边界） ───────────────────────

describe("v0.9.6 A3/V095-07：首见死亡的静默只保留在补扫窗之外", () => {
  it("补扫轮 + 首见 + 证据在补扫窗外（8 天前，窗 7 天）→ 仍不告警（A7 防误报上界不回退）", async () => {
    await seedTeam("sess_b1");
    const deadPid = await startSleeper();
    await killSleeper(deadPid);
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess_b1", cwd: "D:\\ws", startedAt: now - 9 * 24 * 3_600_000,
      lastSeen: now - 8 * 24 * 3_600_000, pid: deadPid,
      liveness: "running", livenessTs: now - 9 * 24 * 3_600_000,
      lastEventTs: now - 8 * 24 * 3_600_000,
    });
    await writeSessionWitness(root, "sess_b1", "heartbeat", now - 8 * 24 * 3_600_000);
    const gapMs = 30 * 24 * 3_600_000;
    const summary = await sweepMembersOnce(deps(), now, {
      resume: { gapMs, catchupWindowMs: Math.min(gapMs, WATCHDOG_RESUME_CATCHUP_MAX_MS) },
    });
    expect(summary.dead).toEqual([]); // 补扫窗外的远古死亡不翻旧账（v0.9.5 A7 口径保留）
    expect(deadEvents()).toHaveLength(0);
    // 静默认领也走复合键（同化身不重复；换化身重新判定）
    const after = await readWatchdogState(root);
    expect(after.members["b|sess_b1"]?.state).toBe("dead");
    expect(after.members["b|sess_b1"]?.notify).toBe("sent");
  });
});

// ─────────────────────── A4 / V095-10+13：补扫窗钳制与恢复判据下界 ───────────────────────

describe("v0.9.6 A4/V095-10：补扫窗取 max(gap, 常规新鲜窗) 钳 7 天上界——短恢复不再收缩窗", () => {
  it("【方案验收锚点】gap=130s 短恢复（旧公式窗=min(gap,7d)=130s）+ 死亡证据 130s → 窗口生效值钳到常规 10min，告警恰 1 条", async () => {
    await seedTeam("sess_b1");
    // 死亡证据年龄 130s（V095-10 实测：恰落旧公式窗缘 → 静默）
    await seedCrashedMember("sess_b1", { witnessAgeMs: 130_000, lastEventAgeMs: 130_000 });
    const gapMs = 130_000;
    // 按旧公式传窗（min(gap,7d)=gap）——复现 V095-10 的缺陷输入；sweep 面钳到 ≥10min。
    // v0.10.0（组 A / R3）：第一周期 suspect、第二周期认领（补扫口径的文案与窗口不变）。
    expect((await sweepMembersOnce(deps(), Date.now(), {
      resume: { gapMs, catchupWindowMs: Math.min(gapMs, WATCHDOG_RESUME_CATCHUP_MAX_MS) },
    })).deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps(), Date.now(), {
      resume: { gapMs, catchupWindowMs: Math.min(gapMs, WATCHDOG_RESUME_CATCHUP_MAX_MS) },
    });
    // 补扫不比常规更聋：窗内死亡告警恰 1 条
    expect(summary.dead).toEqual(["b"]);
    expect(deadEvents()).toHaveLength(1);
    // 生效窗口如实钳到常规新鲜窗（summary 与事件同值）
    expect(summary.resume).toEqual({ gapMs, catchupWindowMs: WATCHDOG_FRESH_DEATH_MS });
    const resumes = readEngineEvents().filter((e) => e["event"] === "watchdog-resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!["catchupWindowMs"]).toBe(WATCHDOG_FRESH_DEATH_MS);
    // 文案注明补扫
    expect(leadMail()).toContain("补扫");
  });

  it("纯函数：watchdogCatchupWindowMs = min(max(gap,10min),7d)——130s→10min、3.5s→10min、30d→7d、14.5h→14.5h", () => {
    expect(watchdogCatchupWindowMs(130_000)).toBe(WATCHDOG_FRESH_DEATH_MS);
    expect(watchdogCatchupWindowMs(3_500)).toBe(WATCHDOG_FRESH_DEATH_MS);
    expect(watchdogCatchupWindowMs(WATCHDOG_RESUME_CATCHUP_MAX_MS + 1)).toBe(WATCHDOG_RESUME_CATCHUP_MAX_MS);
    expect(watchdogCatchupWindowMs(14.5 * 3_600_000)).toBe(14.5 * 3_600_000);
  });
});

describe("v0.9.6 A4/V095-13：恢复判据 60s 下界钳制——事件循环秒级阻塞不判恢复、无同款静音", () => {
  it("纯常量：下界 60s", () => {
    expect(WATCHDOG_RESUME_GAP_FLOOR_MS).toBe(60_000);
  });

  it("sweep 面：以旧公式形态传入 3.5s 微窗（V095-13 的静音根因）→ 生效窗钳到常规 10min，窗内死亡照告", async () => {
    await seedTeam("sess_b1");
    await seedCrashedMember("sess_b1", { witnessAgeMs: 3_500, lastEventAgeMs: 3_500 });
    // v0.10.0（组 A / R3）：第一周期 suspect、第二周期认领（窗口钳制断言不变）
    expect((await sweepMembersOnce(deps(), Date.now(), {
      resume: { gapMs: 3_500, catchupWindowMs: 3_500 },
    })).deathSuspects).toEqual(["b"]);
    const summary = await sweepMembersOnce(deps(), Date.now(), {
      resume: { gapMs: 3_500, catchupWindowMs: 3_500 },
    });
    expect(summary.dead).toEqual(["b"]); // 不静音（v0.9.5 在此形态下静默认领）
    expect(deadEvents()).toHaveLength(1);
    expect(summary.resume?.catchupWindowMs).toBe(WATCHDOG_FRESH_DEATH_MS);
  });

  it("【方案验收锚点】定时器面（真实调度 + Date mock）：3.5s 事件循环阻塞（间隔 20ms 时远超 2×周期）→ 零恢复事件；3h 跳跃 → 恰 1 条", async () => {
    await seedTeam("sess_b1");
    const t0 = 1_700_000_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const timer = startMemberWatchdog(deps(), 20);
    expect(timer).toBeDefined();
    // 正常节拍：真实时间流动 ~150ms（mock 墙钟停走，间隔 0）→ 零事件
    await new Promise((r) => setTimeout(r, 150));
    // V095-13 形态：mock 墙钟跳 3.5s（事件循环同步阻塞的等价形态）——旧判据 2×20ms
    // 必判恢复；新判据被 60s 下界钳住 → 零事件、零补扫口径
    vi.setSystemTime(t0 + 3_500);
    await new Promise((r) => setTimeout(r, 150));
    expect(readEngineEvents().filter((e) => e["event"] === "watchdog-resume")).toHaveLength(0);
    // 真休眠形态：3h 跳跃 → 恰 1 条恢复事件（补扫窗 = min(max(3h,10min),7d) = 3h）
    vi.setSystemTime(t0 + 3 * 3_600_000);
    await new Promise((r) => setTimeout(r, 200));
    timer!.unref();
    clearInterval(timer!);
    const resumes = readEngineEvents().filter((e) => e["event"] === "watchdog-resume");
    expect(resumes).toHaveLength(1);
    const gapMs = Number(resumes[0]!["gapMs"]);
    expect(gapMs).toBeGreaterThanOrEqual(3 * 3_600_000 - 5_000);
    // 补扫窗 = min(max(gap,10min),7d)：3h 量级的 gap ≥ 常规窗 → 窗即 gap 本身
    expect(resumes[0]!["catchupWindowMs"]).toBe(gapMs);
    vi.useRealTimers();
  });
});

// ─────────────────────── 复合键单元 ───────────────────────

describe("watchdogLedgerKey：复合键形态与旧格式判别", () => {
  it("键 = `<成员>|<sid>`；成员名/sid 都不含分隔符（sanitizeKey 字母数字连字符）", () => {
    expect(watchdogLedgerKey("b", "sess_b1")).toBe("b|sess_b1");
    expect(watchdogLedgerKey("m-1_2", "sess_abc-123")).toBe("m-1_2|sess_abc-123");
  });
});
