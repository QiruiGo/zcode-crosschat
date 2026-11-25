/**
 * v0.10.0（集成员·第 5 轮 / 真实复测 mustFix #1）定向单测：
 * **peer 死分区旧记录不得遮蔽注册表活 pid**（core/offline.ts memberLiveness）。
 *
 * 缺陷形态（真实会话实测、无伪造前提）：曾 xc_identify 的会话当前回合不刷新 peer 端点时，
 * peer 扫描 dead 分区里同 sid 的旧记录（pid 已亡）使 memberLiveness 直接判 'pid-dead'；
 * 注册表里活着的新 pid 从不被咨询（pid 证据只在无任何 peer 记录时才被咨询）——主控保活
 * 进程全程存活仍被判死并连锁唤醒（误杀与唤醒风暴两面俱全）。
 *
 * 修法：dead 分区全部 pid-dead 时加一票**活证据否决**——`opts.sessionPid.alive === true`
 * → 'heartbeat-stale'（peer 死分区记录是旧化身残留；判 stale 而非 live：没有心跳证据，
 * 只证明进程没死）。无 sessionPid 证据或 alive=false → 维持 'pid-dead'（不放松既有判死）。
 *
 * 覆盖：
 * 1. 单元：dead 全 pid-dead ∧ 活 pid → heartbeat-stale；alive=false / 缺失 → 仍 pid-dead；
 *    其它分支（active / lastSeen-stale / 缺 reason / 无记录）形状不变；
 * 2. 集成（看门狗）：同形态连扫两个周期 → 零 member-dead、零回池、零告警、零连锁唤醒。
 *
 * 夹具纪律：纯函数部分 now 全注入、无时钟副作用；集成部分用系统 TEMP 临时目录。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { localPidDomain, peerRecordFile } from "./peerdir.js";
import { writePeerRecord, scanPeers, type PeerRecord, type PeerScanResult } from "./peerregistry.js";
import { memberLiveness, type SessionPidEvidence } from "./offline.js";
import type { TeamMember } from "./types.js";
import { sweepMembersOnce, type WatchdogDeps } from "../engine/watchdog.js";
import { newTeamState, writeTeam } from "./teamstate.js";
import { writeSession } from "./registry.js";
import { pidAlive } from "./lock.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function member(overrides: Partial<TeamMember> & Pick<TeamMember, "key" | "sessionId">): TeamMember {
  return { role: "peer", joinedAt: NOW - 10 * MIN, lastSeen: NOW, ...overrides };
}

function record(overrides: Partial<PeerRecord> & Pick<PeerRecord, "pid" | "sessionId" | "lastSeen">): PeerRecord {
  return {
    messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xcc-msg-v0100r5",
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "bg",
    formerNames: [],
    startedAt: NOW - 60 * MIN,
    ...overrides,
  };
}

/** 只读扫描结果记忆夹具（memberLiveness 只吃 PeerScanResult）。 */
function scan(rows: { active?: PeerRecord[]; dead?: { record: PeerRecord; reason?: "pid-dead" | "lastSeen-stale" }[] } = {}): PeerScanResult {
  return { active: rows.active ?? [], dead: rows.dead ?? [], foreign: [], skipped: 0 };
}

/** 本进程 pid：pidAlive 为真 → active 分区自洽。 */
const LIVE_PID = process.pid;
/** 一个确定不存在的 pid（进程死硬证据）。 */
const DEAD_PID = 2_147_483_646;

/** 注册表会话 pid 证据（deriveSessionPidEvidence 的输出形状）。 */
function pidEvidence(alive: boolean): SessionPidEvidence {
  return { pid: alive ? LIVE_PID : DEAD_PID, alive, turnInProgress: false };
}

// ───────────────── 单元：dead 分区分支的活 pid 一票否决 ─────────────────

describe("v0.10.0 集成员·R5：memberLiveness 的 dead 分区不再遮蔽注册表活 pid", () => {
  const m = member({ key: "m1", sessionId: "sess_m1" });
  const deadPartition = [{ record: record({ pid: DEAD_PID, sessionId: "sess_m1", lastSeen: NOW - 60 * MIN }), reason: "pid-dead" as const }];

  it("dead 全 pid-dead + 注册表会话 pid 活着 → heartbeat-stale（不是 pid-dead；02:11 形态）", () => {
    expect(memberLiveness(m, scan({ dead: deadPartition }), NOW, { sessionPid: pidEvidence(true) })).toBe("heartbeat-stale");
  });

  it("多条死记录全是 pid-dead + 活 pid → 同样 heartbeat-stale（保守方向不变）", () => {
    const s = scan({
      dead: [
        { record: record({ pid: DEAD_PID, sessionId: "sess_m1", lastSeen: NOW - 90 * MIN }), reason: "pid-dead" },
        { record: record({ pid: DEAD_PID + 1, sessionId: "sess_m1", lastSeen: NOW - 120 * MIN }), reason: "pid-dead" },
      ],
    });
    expect(memberLiveness(m, s, NOW, { sessionPid: pidEvidence(true) })).toBe("heartbeat-stale");
  });

  it("活 pid 否决不放松既有判死：sessionPid.alive=false → 仍 pid-dead", () => {
    expect(memberLiveness(m, scan({ dead: deadPartition }), NOW, { sessionPid: pidEvidence(false) })).toBe("pid-dead");
  });

  it("无 sessionPid 证据（未注入 / record 无 pid）→ 仍 pid-dead（判据形状逐字节不变）", () => {
    expect(memberLiveness(m, scan({ dead: deadPartition }), NOW)).toBe("pid-dead");
    expect(memberLiveness(m, scan({ dead: deadPartition }), NOW, {})).toBe("pid-dead");
  });

  it("否决只发生在 dead 分区：active 分区形状不受影响（live / heartbeat-stale 照旧）", () => {
    const fresh = scan({ active: [record({ pid: LIVE_PID, sessionId: "sess_m1", lastSeen: NOW - 5_000 })] });
    const stale = scan({ active: [record({ pid: LIVE_PID, sessionId: "sess_m1", lastSeen: NOW - 10 * MIN })] });
    expect(memberLiveness(m, fresh, NOW, { sessionPid: pidEvidence(true) })).toBe("live");
    expect(memberLiveness(m, stale, NOW, { sessionPid: pidEvidence(true) })).toBe("heartbeat-stale");
  });

  it("dead 分区里本就有非 pid-dead 记录 → 走原分支 heartbeat-stale（否决不改变结果）", () => {
    const s = scan({
      dead: [
        { record: record({ pid: DEAD_PID, sessionId: "sess_m1", lastSeen: NOW - 90 * MIN }), reason: "pid-dead" },
        { record: record({ pid: LIVE_PID, sessionId: "sess_m1", lastSeen: NOW - 90 * MIN }), reason: "lastSeen-stale" },
      ],
    });
    expect(memberLiveness(m, s, NOW, { sessionPid: pidEvidence(false) })).toBe("heartbeat-stale");
  });
});

// ───────────────── 集成：看门狗连扫两周期零误判亡 ─────────────────

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-offline-v0100r5-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-offline-v0100r5-peers-"));
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

async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

function engineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function eventsOf(name: string): Array<Record<string, unknown>> {
  return engineEvents().filter((e) => e["event"] === name);
}

function deps(): WatchdogDeps {
  return { stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } };
}

describe("v0.10.0 集成员·R5：peer 死分区旧记录 + 注册表活 pid → 看门狗不判 member-dead", () => {
  it("连扫两个周期：零 member-dead、零回池、零告警、零连锁唤醒", async () => {
    const leadPid = await startSleeper();
    const memberPid = await startSleeper();
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now: 1,
      founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
    });
    team.members.push({ key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 });
    await writeTeam(root, team);

    // lead 有活 peer 记录（可寻址）；成员 b 只有 **dead 分区**的同 sid 旧记录（pid 已亡）。
    await writePeerRecord(peerRoot, {
      pid: leadPid,
      sessionId: "sess_a",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v0100r5-lead-${leadPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    // 旧化身残留：写一条记录后把进程杀掉 → 下次扫描进 dead 分区（reason=pid-dead）。
    const ghostPid = await startSleeper();
    await writePeerRecord(peerRoot, {
      pid: ghostPid,
      sessionId: "sess_b",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v0100r5-ghost-${ghostPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "bg",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    sleepers.find((c) => c.pid === ghostPid)?.kill();
    const deadline = Date.now() + 10_000;
    while (pidAlive(ghostPid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(pidAlive(ghostPid)).toBe(false);

    // 注册表里 b 的会话记录带着**活着的新 pid**（SessionStart 钩子写的宿主进程 pid）。
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess_b",
      cwd: "D:\\ws",
      startedAt: now - 3_600_000,
      lastSeen: now - 30_000,
      pid: memberPid,
      liveness: "idle",
      livenessTs: now - 30_000,
      lastEventTs: now - 30_000,
    });

    // 连扫两个周期（同一形态持续两轮——既验「不判死」，也验「不重复告警」）。
    // 夹具自检（防假绿）：ghost 记录确实被扫描归入 **dead 分区且 reason=pid-dead**，
    // 且带活 pid 证据时 memberLiveness 判 heartbeat-stale——否则本用例会因「记录根本没进
    // dead 分区」而假绿。
    const scanResult = await scanPeers(peerRoot, Date.now(), { sweep: false });
    const ghost = scanResult.dead.find((row) => row.record.sessionId === "sess_b");
    expect(ghost?.reason).toBe("pid-dead");
    expect(memberLiveness(
      { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 },
      scanResult,
      Date.now(),
      { sessionPid: { pid: memberPid, alive: true, turnInProgress: false } },
    )).toBe("heartbeat-stale");
    const first = await sweepMembersOnce(deps());
    const second = await sweepMembersOnce(deps());
    expect(first.dead).toEqual([]);
    expect(second.dead).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(0);
    expect(eventsOf("watchdog-wake")).toHaveLength(0); // 零连锁唤醒（不惊动任何人）
    expect(eventsOf("member-unclaimed-repooled")).toHaveLength(0); // 零回池
    expect(eventsOf("suspect-dead")).toHaveLength(0); // 连 suspect 都不进（不是「待确认死亡」）
    expect(first.deathSuspects).toEqual([]);
    expect(second.deathSuspects).toEqual([]);
  });

  it("反面对照：注册表 pid 也亡（且无在途任务/唤醒）→ 仍判 pid-dead（否决不放松判死）", async () => {
    const leadPid = await startSleeper();
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now: 1,
      founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
    });
    team.members.push({ key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 });
    await writeTeam(root, team);
    await writePeerRecord(peerRoot, {
      pid: leadPid,
      sessionId: "sess_a",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v0100r5-lead2-${leadPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    const ghostPid = await startSleeper();
    await writePeerRecord(peerRoot, {
      pid: ghostPid,
      sessionId: "sess_b",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v0100r5-ghost2-${ghostPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "bg",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    sleepers.find((c) => c.pid === ghostPid)?.kill();
    const deadline = Date.now() + 10_000;
    while (pidAlive(ghostPid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // 注册表记录的 pid 同样已亡 → 没有活证据可否决 → 走原判死路径（两周期确认后 member-dead）。
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess_b",
      cwd: "D:\\ws",
      startedAt: now - 3_600_000,
      lastSeen: now - 90_000,
      pid: ghostPid,
      liveness: "idle",
      livenessTs: now - 90_000,
      lastEventTs: now - 90_000,
    });
    expect((await sweepMembersOnce(deps())).deathSuspects).toEqual(["b"]);
    expect((await sweepMembersOnce(deps())).dead).toEqual(["b"]);
    expect(eventsOf("member-dead")).toHaveLength(1);
    // 死记录的落点仍在 peer 注册表里（dead 分区由扫描判定，非本测试职责）——自检夹具真的写进去了。
    expect(existsSync(peerRecordFile(peerRoot, ghostPid))).toBe(true);
  });
});
