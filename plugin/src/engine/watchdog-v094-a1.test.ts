/**
 * v0.9.4（A1）：成员 **pid 证据**定向测试（39-v094 方案 §二 A 表）。
 *
 * 判据（方案原文）：「引擎供给成员的 SessionStart 钩子把 process.pid 写入
 * registry/sessions/<sid>.json 与 peer base 记录；memberLiveness 据此可判 pid-dead」；
 * 验收：「建员后 session 记录含 pid；kill 该 pid 后 90s 内 member-dead 恰一条」。
 *
 * 实现口径：
 * - hooks/session-start.ts `hookSessionPid()`：记**宿主进程** pid（钩子的父进程）。
 *   钩子自身短命（hooks.json type:process / 10s 超时），记自己的 pid 会秒级变「已亡」
 *   把活会话误判 pid-dead；父进程才是「杀它即会话亡」的对象；
 * - core/registry.ts `refreshSessionLastSeen({pid})`：pid 与 lastSeen/活性状态同一
 *   原子写落盘（coerceSessionRecord 宽容透传：正整数才收）；
 * - core/offline.ts `memberLiveness` 补 pid 判据：**无 peer 记录**（引擎成员从未
 *   identify 的空档）+ 记录自述 running + pid 已亡 → pid-dead（第二硬证据）；
 * - engine/watchdog.ts：扫描时读会话记录、探测 pid 存活并注入判据 → kill 后下一拍
 *   （缺省 60s 节拍）内 member-dead 恰一条。
 *
 * 本文件三层覆盖：纯判据（offline）/ 落盘与宽容读取（registry）/ 看门狗端到端
 * （真活进程 pid，不用假 pid 伪造进程死——C8 同款纪律）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { memberLiveness, type SessionPidEvidence } from "../core/offline.js";
import { readSession, refreshSessionLastSeen, writeSession } from "../core/registry.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { scanPeers } from "../core/peerregistry.js";
import { peerRootFromEnv, writePeerBaseRecord, readPeerBaseRecord } from "../core/peerdir.js";
import { sweepMembersOnce, type WatchdogDeps } from "../engine/watchdog.js";
import { pidAlive } from "../core/lock.js";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a1-v094-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-a1-v094-peers-"));
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

/** 起一个真活进程（pid 活性判据吃真 pid——不用假 pid 伪造进程死）。 */
async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

/** 杀一个真进程并等到 pidAlive 报死（避免「kill 已发出但尚未生效」的竞态）。 */
async function killSleeper(pid: number): Promise<void> {
  const child = sleepers.find((c) => c.pid === pid);
  child?.kill();
  const deadline = Date.now() + 10_000;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pidAlive(pid)).toBe(false);
}

const emptyScan = { active: [], dead: [], foreign: [], skipped: 0 };

const member = { key: "b", sessionId: "sess_b", role: "worker" as const, joinedAt: 1, lastSeen: 1 };

function pidEvidence(pid: number, alive: boolean, turnInProgress: boolean): SessionPidEvidence {
  return { pid, alive, turnInProgress };
}

describe("v0.9.4 A1：memberLiveness 的 pid 判据（无 peer 记录空档的第二硬证据）", () => {
  it("【锚点】无 peer 记录 + running 自述 + pid 已亡 → pid-dead", () => {
    expect(memberLiveness(member, emptyScan, Date.now(), { sessionPid: pidEvidence(999_999, false, true) }))
      .toBe("pid-dead");
  });

  it("负例：pid 仍活着 → no-record（不误判进程死）", () => {
    expect(memberLiveness(member, emptyScan, Date.now(), { sessionPid: pidEvidence(process.pid, true, true) }))
      .toBe("no-record");
  });

  it("负例：记录 idle（Stop 钩子已标记回合结束）→ 旧 pid 已亡也**不**判死（回合间隙零进程是正常形态）", () => {
    expect(memberLiveness(member, emptyScan, Date.now(), { sessionPid: pidEvidence(999_999, false, false) }))
      .toBe("no-record");
  });

  it("负例：未注入 pid 证据（存量记录/未接线面）→ 行为与旧版逐字一致（no-record）", () => {
    expect(memberLiveness(member, emptyScan, Date.now())).toBe("no-record");
    expect(memberLiveness(member, emptyScan, Date.now(), {})).toBe("no-record");
  });

  it("保留既有判据：peer active 记录在场 → live（活证据优先，pid 证据不推翻）", async () => {
    const pid = await startSleeper();
    const scan = await scanPeers(peerRoot, Date.now());
    const { writePeerRecord } = await import("../core/peerregistry.js");
    const { localPidDomain } = await import("../core/peerdir.js");
    await writePeerRecord(peerRoot, {
      pid,
      sessionId: "sess_b",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-a1-${pid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    const withLivePeer = await scanPeers(peerRoot, Date.now());
    expect(memberLiveness(member, withLivePeer, Date.now(), { sessionPid: pidEvidence(999_999, false, true) }))
      .toBe("live");
    expect(scan.active).toHaveLength(0); // 写入前是空的（上面的判据确实吃的是注入证据）
  });
});

describe("v0.9.4 A1：pid 落盘与宽容读取（registry / peerdir）", () => {
  it("refreshSessionLastSeen({pid}) → 会话记录带 pid；readSession 原样读回", async () => {
    const pid = await startSleeper();
    await refreshSessionLastSeen(root, "sess_x", { cwd: "D:\\ws", pid, now: Date.now() });
    const record = await readSession(root, "sess_x");
    expect(record?.pid).toBe(pid);
    // 未传 pid 的刷新不动既有值（UserPromptSubmit/心跳路径不刷新 pid）
    await refreshSessionLastSeen(root, "sess_x", { cwd: "D:\\ws", now: Date.now() });
    expect((await readSession(root, "sess_x"))?.pid).toBe(pid);
  });

  it("durable boundary 宽容：pid 非正整数 → 整字段丢弃（不拒整条记录）", async () => {
    mkdirSync(join(root, "registry", "sessions"), { recursive: true });
    const { writeFileAtomic } = await import("../core/atomic.js");
    await writeFileAtomic(join(root, "registry", "sessions", "sess_y.json"), JSON.stringify({
      sessionId: "sess_y", cwd: "", startedAt: 1, lastSeen: 1, pid: -5,
    }));
    expect((await readSession(root, "sess_y"))?.pid).toBeUndefined();
    await writeFileAtomic(join(root, "registry", "sessions", "sess_z.json"), JSON.stringify({
      sessionId: "sess_z", cwd: "", startedAt: 1, lastSeen: 1, pid: 12.5,
    }));
    expect((await readSession(root, "sess_z"))?.pid).toBeUndefined();
    await writeFileAtomic(join(root, "registry", "sessions", "sess_w.json"), JSON.stringify({
      sessionId: "sess_w", cwd: "", startedAt: 1, lastSeen: 1, pid: "4242",
    }));
    expect((await readSession(root, "sess_w"))?.pid).toBeUndefined();
  });

  it("peer 基记录可带 pid（机器全局面的同步投影；读回原样）", async () => {
    const pid = await startSleeper();
    await writePeerBaseRecord(peerRoot, {
      sessionId: "sess_x", cwd: "D:\\ws", source: null, startedAt: 1, lastSeen: 2, pid,
    });
    expect((await readPeerBaseRecord(peerRoot, "sess_x"))?.pid).toBe(pid);
  });
});

describe("v0.9.4 A1：看门狗端到端（kill 宿主 pid → member-dead 恰一条）", () => {
  it("【锚点】成员无 peer 记录 + 会话记录带 pid/running：活着时不判死；kill 后恰一条 member-dead", async () => {
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now: 1,
      founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
    });
    team.members.push({ key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 });
    await writeTeam(root, team);
    // lead 有活 peer 记录（可寻址，收死亡通知）；成员 b **没有** peer 记录（A1 空档）。
    const { writePeerRecord } = await import("../core/peerregistry.js");
    const { localPidDomain } = await import("../core/peerdir.js");
    const leadPid = await startSleeper();
    await writePeerRecord(peerRoot, {
      pid: leadPid,
      sessionId: "sess_a",
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-a1-lead-${leadPid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    const memberPid = await startSleeper();
    // 成员 b 的会话记录：pid = 宿主进程 + running 自述（SessionStart 钩子的输出形状）。
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: Date.now(), lastSeen: Date.now(),
      pid: memberPid, liveness: "running", livenessTs: Date.now(),
    });

    const deps: WatchdogDeps = { stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } };

    // ① 活着：pid 证据在场但进程活着 → 不判死（台账武装为 alive）
    const first = await sweepMembersOnce(deps);
    expect(first.dead).toEqual([]);
    expect(first.scannedMembers).toBe(2);

    // ② kill 宿主 pid（会话进程死亡；无 Stop 钩子 → running 自述悬停）
    await killSleeper(memberPid);

    // ③ v0.10.0（组 A / R3）：kill 后第一个扫描周期只记 suspect（二次确认：不发
    //    member-dead、不回池）；第二个周期仍判死 → pid-dead → member-dead 恰一条
    //    （+ lead 通知与唤醒尝试照旧发生）。
    expect((await sweepMembersOnce(deps)).deathSuspects).toEqual(["b"]);
    const second = await sweepMembersOnce(deps);
    expect(second.dead).toEqual(["b"]);
    const events = readEngineEvents().filter((e) => e["event"] === "member-dead");
    expect(events).toHaveLength(1);
    expect(events[0]!["member"]).toBe("b");
    expect(events[0]!["liveness"]).toBe("pid-dead");
    expect(events[0]!["via"]).toBe("watchdog");

    // ④ 再扫一轮：同一死亡不重复（杀伤一次不重复）
    const third = await sweepMembersOnce(deps);
    expect(third.dead).toEqual([]);
    expect(readEngineEvents().filter((e) => e["event"] === "member-dead")).toHaveLength(1);
  });

  it("负例：Stop 钩子后的 idle 会话（旧 pid 已亡）→ 不判 member-dead（不误报正常回合间隙）", async () => {
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now: 1,
      founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
    });
    team.members.push({ key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 });
    await writeTeam(root, team);
    const deadPid = await startSleeper();
    await killSleeper(deadPid);
    // idle 自述（Stop 钩子已跑）+ 旧 pid 已亡 = 正常回合间隙形态。
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: Date.now(), lastSeen: Date.now(),
      pid: deadPid, liveness: "idle", livenessTs: Date.now(),
    });
    const deps: WatchdogDeps = { stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } };
    const summary = await sweepMembersOnce(deps);
    expect(summary.dead).toEqual([]);
    expect(readEngineEvents().filter((e) => e["event"] === "member-dead")).toHaveLength(0);
  });
});

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
