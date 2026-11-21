/**
 * v0.9.4 打回第 1 轮（V094-13）：**同一死亡跨面一致**定向测试。
 *
 * 缺陷形态（验收实测）：看门狗按 pid 判 charlie1 pid-dead 并落 `member-dead`（lead 邮箱
 * urgent、UserPromptSubmit 事故摘要 memberDead=1 全部跟上），但 `xc_overview` 三视图
 * （team/status/panel）在同一死亡后 67s / 364s 仍报 `running 3 / idle 0 / dead 0`、
 * charlie1 `state=running` 且 `livenessSources` 含 `hooks-pid`——同一份证据在两个面对
 * 不上账。
 *
 * 根因：pid 证据（会话记录 `pid` + `pidAlive` + running 自述）此前只有看门狗显式注入；
 * 展示面（`tools-overview` 的 `livenessMount` → `memberLivenessView`）未注入 → pid 判据
 * 不参与 → 残留 running 自述直接呈现为 running。
 *
 * 修复：pid 证据派生收敛到**单一派生点** `core/offline.ts deriveSessionPidEvidence`；
 * `memberLivenessView` 在未显式注入时按会话记录现场派生（`judge.pidAliveProbe` 缺省
 * `core/lock.ts pidAlive`），看门狗同样改走派生点——判死发射面与三视图展示面必然同判据。
 *
 * 判据（本文件逐条锁）：
 * 1. 【锚点】alive 期三视图 running；kill 宿主 pid 后**未扫**三视图即 dead=1 且
 *    charlie1 state=dead / sources 为空；随后看门狗恰一条 member-dead；扫后三视图仍 dead=1；
 * 2. pid 仍活 → 三视图 running、dead=0（不误报）；
 * 3. Stop 钩子后的 idle 会话（pid 已亡）→ idle（不误报正常回合间隙）；
 * 4. 纯判据：`deriveSessionPidEvidence` 非法 pid → undefined；`memberLivenessView` 与
 *    `memberLiveness`（同 record/scan）同判据（不漂移）；
 * 5. 注入面：`judge.sessionPid` 显式值优先于现场派生（测试可控性不变）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { resetPeerServicesForTests } from "./peer-services.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { writeSession } from "../core/registry.js";
import { pidAlive } from "../core/lock.js";
import { deriveSessionPidEvidence, memberLiveness } from "../core/offline.js";
import { memberLivenessView } from "../core/liveness.js";
import { scanPeers, type PeerScanResult } from "../core/peerregistry.js";
import { sweepMembersOnce, type WatchdogDeps } from "../engine/watchdog.js";
import type { TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";
import type { CapacitySample } from "../core/capacity.js";

/** 容量绿色（三条 red 规则都不命中——与 overview-panel-v092.test.ts 同款口径）。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

const dirs: string[] = [];
const sleepers: ReturnType<typeof spawn>[] = [];
let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-v094-13-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  mkdirSync(join(peerRoot, "sessions"), { recursive: true }); // 空 peer 注册表（charlie1 无 peer 记录）
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot } };
  dirs.push(workDir);
});

afterEach(() => {
  resetPeerServicesForTests();
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

/** 起一个真活进程（pid 判据吃真 pid——不用假 pid 伪造进程死）。 */
async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

/** 杀真进程并等到 pidAlive 报死（避免 kill 已发出但未生效的竞态）。 */
async function killSleeper(pid: number): Promise<void> {
  const child = sleepers.find((c) => c.pid === pid);
  child?.kill();
  const deadline = Date.now() + 10_000;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pidAlive(pid)).toBe(false);
}

function member(key: string): TeamMember {
  return { key, sessionId: `sess_${key}`, role: "worker", joinedAt: 1, lastSeen: 1, state: "ready", identity: "engine" };
}

/** lead a + 两个成员（charlie1 = 本次受害者；bob = 对照）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1, state: "ready", identity: "engine" },
  });
  team.members.push(member("charlie1"), member("bob"));
  await writeTeam(stateRoot, team);
}

function greenSample(): CapacitySample {
  return {
    sampledAt: Date.now(),
    totalBytes: 16 * 1024 ** 3,
    freeBytes: 8 * 1024 ** 3,
    watermark: 0.5,
    steadyTreeBytes: 1 * 1024 ** 3,
    headlessTurnCount: 0,
    headlessTurnMaxRssBytes: null,
    degraded: null,
  };
}

function watchdogDeps(): WatchdogDeps {
  return { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot, ...GREEN_ENV }, capacitySample: greenSample() };
}

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface MemberRow { key: string; liveness?: { state: string; livenessSources: string[]; endpointLive: boolean } }

async function teamView(): Promise<{ text: string; payload: { liveness?: { running: number; idle: number; dead: number }; members: MemberRow[] } }> {
  const res = await handleOverview(deps, { view: "team" }, "__stdio__");
  return {
    text: res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
    payload: payloadOf(res) as { liveness?: { running: number; idle: number; dead: number }; members: MemberRow[] },
  };
}

async function statusView(): Promise<{ payload: { liveness?: { running: number; idle: number; dead: number; byMember: Record<string, { state: string; livenessSources: string[] }> } } }> {
  const res = await handleOverview(deps, { view: "status" }, "__stdio__");
  return { payload: payloadOf(res) as { liveness?: { running: number; idle: number; dead: number; byMember: Record<string, { state: string; livenessSources: string[] }> } } };
}

async function panelView(): Promise<{ payload: { liveness?: { running: number; idle: number; dead: number }; members: MemberRow[] } }> {
  const res = await handleOverview(deps, { view: "panel" }, "__stdio__");
  return { payload: payloadOf(res) as { liveness?: { running: number; idle: number; dead: number }; members: MemberRow[] } };
}

function rowOf(rows: MemberRow[], key: string): MemberRow | undefined {
  return rows.find((r) => r.key === key);
}

describe("V094-13：同一次 pid-dead 在 看门狗 / xc_overview 三视图 同判据（跨面一致）", () => {
  it("【锚点】kill 宿主 pid → 未扫时三视图即 dead=1（charlie1 state=dead）；看门狗恰一条 member-dead；扫后仍 dead=1", async () => {
    await seedTeam();
    const charliePid = await startSleeper();
    // 三个成员都在回合中自述（running）：a/b 无 pid 证据（存量/钩子未写形态），charlie1 带宿主 pid。
    const now = Date.now();
    await writeSession(stateRoot, { sessionId: "sess_a", cwd: workDir, startedAt: now, lastSeen: now, liveness: "running", livenessTs: now });
    await writeSession(stateRoot, { sessionId: "sess_bob", cwd: workDir, startedAt: now, lastSeen: now, liveness: "running", livenessTs: now });
    await writeSession(stateRoot, {
      sessionId: "sess_charlie1", cwd: workDir, startedAt: now, lastSeen: now,
      liveness: "running", livenessTs: now, pid: charliePid,
    });

    // ① alive 期：三视图 running 3 / dead 0（pid 判据不误报活进程）
    const before = await teamView();
    expect(before.payload.liveness).toEqual({ running: 3, idle: 0, dead: 0 });
    expect(rowOf(before.payload.members, "charlie1")?.liveness?.state).toBe("running");

    // ② 看门狗首扫：台账武装为 alive（生产形态：先活着被扫到，后崩）
    const armed = await sweepMembersOnce(watchdogDeps());
    expect(armed.dead).toEqual([]);
    expect(readEngineEvents().filter((e) => e["event"] === "member-dead")).toHaveLength(0);

    // ③ kill 宿主 pid —— 未跑任何看门狗扫描，三视图必须**立刻**看到同一死亡
    await killSleeper(charliePid);
    const afterKill = await teamView();
    expect(afterKill.payload.liveness).toEqual({ running: 2, idle: 0, dead: 1 });
    expect(afterKill.text).toContain("liveness: running 2 / idle 0 / dead 1");
    const charlieRow = rowOf(afterKill.payload.members, "charlie1")!;
    expect(charlieRow.liveness?.state).toBe("dead");
    expect(charlieRow.liveness?.livenessSources).toEqual([]); // dead 压过一切活证据（pid-dead 不是活证据）
    expect(charlieRow.liveness?.endpointLive).toBe(false);
    // 对照成员不受影响
    expect(rowOf(afterKill.payload.members, "bob")?.liveness?.state).toBe("running");

    // ④ status / panel 两视图同值（三视图同源）
    const status = await statusView();
    expect(status.payload.liveness?.dead).toBe(1);
    expect(status.payload.liveness?.running).toBe(2);
    expect(status.payload.liveness?.byMember["charlie1"]?.state).toBe("dead");
    const panel = await panelView();
    expect(panel.payload.liveness).toEqual({ running: 2, idle: 0, dead: 1 });
    expect(rowOf(panel.payload.members, "charlie1")?.liveness?.state).toBe("dead");

    // ⑤ 看门狗随后扫描：恰一条 member-dead（发射面与展示面指向同一次死亡）
    const swept = await sweepMembersOnce(watchdogDeps());
    expect(swept.dead).toEqual(["charlie1"]);
    const deadEvents = readEngineEvents().filter((e) => e["event"] === "member-dead");
    expect(deadEvents).toHaveLength(1);
    expect(deadEvents[0]!["member"]).toBe("charlie1");
    expect(deadEvents[0]!["liveness"]).toBe("pid-dead");

    // ⑥ 扫后三视图不变：仍 dead=1（事件落账不是视图翻转的前提）
    const afterSweep = await teamView();
    expect(afterSweep.payload.liveness).toEqual({ running: 2, idle: 0, dead: 1 });
    expect(rowOf(afterSweep.payload.members, "charlie1")?.liveness?.state).toBe("dead");
  });

  it("负例：pid 仍活 → 三视图 running、dead=0（不把活进程误报成 dead）", async () => {
    await seedTeam();
    const pid = await startSleeper();
    const now = Date.now();
    await writeSession(stateRoot, {
      sessionId: "sess_charlie1", cwd: workDir, startedAt: now, lastSeen: now,
      liveness: "running", livenessTs: now, pid,
    });
    const view = await teamView();
    expect(view.payload.liveness?.dead).toBe(0);
    const row = rowOf(view.payload.members, "charlie1")!;
    expect(row.liveness?.state).toBe("running");
    expect(row.liveness?.livenessSources).toContain("hooks-pid");
  });

  it("负例：idle 自述（Stop 钩子后）+ pid 已亡 → idle，不判 dead（回合间隙零进程是正常形态）", async () => {
    await seedTeam();
    const pid = await startSleeper();
    await killSleeper(pid);
    const now = Date.now();
    await writeSession(stateRoot, {
      sessionId: "sess_charlie1", cwd: workDir, startedAt: now, lastSeen: now,
      liveness: "idle", livenessTs: now, pid,
    });
    const view = await teamView();
    expect(view.payload.liveness?.dead).toBe(0);
    expect(rowOf(view.payload.members, "charlie1")?.liveness?.state).toBe("idle");
    const swept = await sweepMembersOnce(watchdogDeps());
    expect(swept.dead).toEqual([]);
  });

  it("纯判据：deriveSessionPidEvidence 只认正整数 pid；view 与 memberLiveness 同判据不漂移", () => {
    const now = Date.now();
    expect(deriveSessionPidEvidence(undefined, now, () => false)).toBeUndefined();
    expect(deriveSessionPidEvidence({}, now, () => false)).toBeUndefined();
    expect(deriveSessionPidEvidence({ pid: -1 }, now, () => false)).toBeUndefined();
    expect(deriveSessionPidEvidence({ pid: 1.5 }, now, () => false)).toBeUndefined();

    const record = { sessionId: "sess_charlie1", cwd: "w", startedAt: 1, lastSeen: 1, pid: 424242, liveness: "running" as const, livenessTs: now };
    const evidence = deriveSessionPidEvidence(record, now, () => false)!;
    expect(evidence).toEqual({ pid: 424242, alive: false, turnInProgress: true });
    const scan: PeerScanResult = { active: [], dead: [], foreign: [], skipped: 0 };
    const memberRow: TeamMember = { key: "charlie1", sessionId: "sess_charlie1", role: "worker", joinedAt: 1, lastSeen: 1 };
    // 两个面吃同一次派生 → 同判 pid-dead
    expect(memberLiveness(memberRow, scan, now, { sessionPid: evidence })).toBe("pid-dead");
    expect(memberLivenessView(memberRow, record, scan, now, { pidAliveProbe: () => false }).state).toBe("dead");
  });

  it("注入面：judge.sessionPid 显式值优先于现场派生（既有测试注入纪律不变）", () => {
    const now = Date.now();
    const record = { sessionId: "s", cwd: "w", startedAt: 1, lastSeen: 1, pid: 999999, liveness: "running" as const, livenessTs: now };
    const memberRow: TeamMember = { key: "m", sessionId: "s", role: "worker", joinedAt: 1, lastSeen: 1 };
    const scan: PeerScanResult = { active: [], dead: [], foreign: [], skipped: 0 };
    // 现场派生：pid 死 → dead
    expect(memberLivenessView(memberRow, record, scan, now, { pidAliveProbe: () => false }).state).toBe("dead");
    // 显式注入 alive=true 覆盖派生 → running
    expect(memberLivenessView(memberRow, record, scan, now, { sessionPid: { pid: 999999, alive: true }, pidAliveProbe: () => false }).state).toBe("running");
  });
});
