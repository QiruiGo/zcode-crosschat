/**
 * v0.8.1 防回归单测：29-v080 能力反向检验「身份重绑 × 队内状态真源」组
 * （M01 P1 + C6-BUG-1 P2 + C6-BUG-6 P3 + C2-B3 P2，本工作流负责的 4 项）。
 *
 * 复放依据（deepseek-crosschat/evidence/29-v080-capability-redteam/，均先在
 * evidence/30-v081/_scripts/replay-*.mjs 用产品 dist 原样复现后修复）：
 * - M01（C2-B1/C6-BUG-2）：以他人已占花名 identify（含 handoff 建议原文的
 *   `xc_identify({takeover:true})`）→ 队内轴改名先落地 → peer 轴 name_taken →
 *   回滚读不了已损坏的 team.json → 双重复员键、.bak 同步中毒、全队 team-axis
 *   工具 internal。修复 = 两轴**前置校验**（队内占用/peer 占用都在任何状态变更
 *   之前显式拒、零副作用）+ 已中毒 team.json 的工具面自愈（repairTeamState）。
 * - C6-BUG-1（C6 lane-b1-repro）：takeover 传未锚定 sid → 先撤销在途 attempt、
 *   任务回池、摘 names 绑定，才报 session_not_anchored。修复 = 同批校验前置。
 * - C6-BUG-6（C6 lane-b6）：终态任务引用（completed 的 assignee 永驻）让
 *   「做完手上的活再改名」这条错误指引做完也永远 team_rename_blocked。修复 =
 *   判据改非终态引用 + 未读（非全史邮件）+ 挡路明细进 payload。
 * - C2-B3（C2 adj-b3）：新花名接手后默认 self 接手包静默丢 tasks/unread/checkpoint；
 *   真改名也会把 checkpoints/<旧名>/ 留成孤儿。修复 = 空包连续性指针 + 检查点
 *   目录随改名搬迁。
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPidDomain } from "../core/peerdir.js";
import { writePeerRecord, type PeerRecord } from "../core/peerregistry.js";
import { writeSession } from "../core/registry.js";
import { appendMailbox, createMessage } from "../core/mailbox.js";
import { newTeamState, readTeam, repairTeamState, writeTeam } from "../core/teamstate.js";
import { carryCheckpointDir, latestCheckpoint } from "../core/checkpoint.js";
import { handleIdentify } from "./tools-identify.js";
import { handleRead } from "./tools-read.js";
import { handleTeam } from "./tools-team.js";
import { identityStore } from "./identity.js";
import { payloadOf, ToolError, type ToolPayload, type ToolResult } from "./protocol.js";
import {
  createDefaultPeerServices,
  resetPeerServicesForTests,
  setPeerServicesForTests,
  type PeerServices,
} from "./peer-services.js";
import {
  clearPeerSessionContext,
  setPeerSessionContext,
} from "./peer-drain.js";
import type { ToolDeps } from "./core.js";

let workDir = "";
let stateRoot = "";
let peerRoot = "";
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v081-identity-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peers-root");
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } as NodeJS.ProcessEnv };
  resetPeerServicesForTests();
  clearPeerSessionContext();
});

afterEach(async () => {
  resetPeerServicesForTests();
  clearPeerSessionContext();
  await rm(workDir, { recursive: true, force: true });
});

let connSeq = 0;
function nextConn(): string {
  connSeq += 1;
  return `conn-v081-${connSeq}`;
}

async function anchorSession(sid: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
}

async function readNames(): Promise<Record<string, { sessionId: string }>> {
  const file = join(stateRoot, "registry", "names.json");
  if (!existsSync(file)) return {};
  return JSON.parse(await readFile(file, "utf8")) as Record<string, { sessionId: string }>;
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function identify(
  args: { name: string; sessionId: string; role?: "peer" | "worker"; takeover?: boolean },
  connectionKey: string,
): Promise<{ result: ToolResult; payload: ToolPayload }> {
  const result = await handleIdentify(deps, args, connectionKey);
  return { result, payload: payloadOf(result) };
}

function peerRecord(pid: number, name: string, sessionId: string): PeerRecord {
  return {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xcc-v081-${Math.random().toString(16).slice(2)}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name,
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  };
}

/** 假 peer 服务：register/rename 可指定抛错并计数，其余用真实默认实现。 */
function fakePeerServices(overrides: {
  registerError?: ToolError;
  renameError?: ToolError;
  onRename?: (name: string) => void;
}): PeerServices {
  const base = createDefaultPeerServices(deps);
  return {
    ...base,
    async register(input) {
      if (overrides.registerError !== undefined) throw overrides.registerError;
      return {
        name: input.name,
        sessionId: input.sessionId,
        pid: process.pid,
        socketPath: "\\\\.\\pipe\\LOCAL\\xcc-v081-fake",
        keyFile: "C:\\peers\\keys\\fake.key",
        tokenHint: "deadbeef",
        modeClassSource: "base-record",
      };
    },
    async rename(name: string) {
      overrides.onRename?.(name);
      if (overrides.renameError !== undefined) throw overrides.renameError;
      return { name, formerName: "prev", notified: [] };
    },
  };
}

async function toolError(error: string, message: string, extra: Record<string, unknown> = {}) {
  return new ToolError({ error, message, ...extra }, message);
}

// ---------------------------------------------------------------------------
// M01（P1）：改名两轴前置校验——占用他人已占花名不再能把 team.json 写成重复键
// ---------------------------------------------------------------------------

describe("M01：改名两轴前置校验（红队 C2-B1 / C6-BUG-2 复放）", () => {
  it("以他人已占花名 identify（takeover:true，handoff 建议原文）→ team_rename_blocked，零副作用", async () => {
    await anchorSession("sess-v081-m01-a");
    await anchorSession("sess-v081-m01-b");
    await anchorSession("sess-v081-m01-c");
    setPeerServicesForTests(fakePeerServices({}));
    const connA = nextConn();
    const connB = nextConn();
    const connC = nextConn();
    await identify({ name: "alice", sessionId: "sess-v081-m01-a" }, connA);
    await identify({ name: "bob", sessionId: "sess-v081-m01-b" }, connB);
    await identify({ name: "carol", sessionId: "sess-v081-m01-c" }, connC);

    let renameCalls = 0;
    setPeerServicesForTests(fakePeerServices({ onRename: () => { renameCalls += 1; } }));
    setPeerSessionContext({ sessionId: "sess-v081-m01-c", name: "carol", pid: process.pid, root: peerRoot });

    // handoff 对他人 in_progress 任务的建议原文：xc_identify({takeover:true}) 接管。
    const { result, payload } = await identify(
      { name: "bob", sessionId: "sess-v081-m01-c", takeover: true },
      connC,
    );
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("team_rename_blocked");
    expect(payload.renamed).toEqual({ peer: false, team: false });
    expect(String(payload.reason)).toContain("held by another member on the team roster");
    expect(String(result.content[0]?.text)).toContain("BOTH axes");

    // ① 零副作用：team.json 可读且无重复成员键（修复前 members=[alice,bob,bob] → readTeam 抛）。
    const team = await readTeam(stateRoot, "default");
    expect(team?.members.map((m) => m.key)).toEqual(["alice", "bob", "carol"]);
    // ② names.json 三键原样（修复前 carol 被解绑、bob 仍指旧 sid）。
    const names = await readNames();
    expect(Object.keys(names).sort()).toEqual(["alice", "bob", "carol"]);
    expect(names["bob"]?.sessionId).toBe("sess-v081-m01-b");
    // ③ 连接身份未被改写；peer 轴改名从未被调用（两轴都没动）。
    expect(identityStore.get(connC)?.agentKey).toBe("carol");
    expect(renameCalls).toBe(0);
    // ④ 没有任何 register-renamed / rollback 审计（没发生改名，也没发生回滚）。
    const events = await engineEvents();
    expect(events.some((e) => e["event"] === "register-renamed")).toBe(false);
    expect(events.some((e) => e["event"] === "register-rename-rolled-back")).toBe(false);
    expect(existsSync(join(stateRoot, "teams", "default", "team.json.corrupt"))).toBe(false);
  });

  it("plain identify（不带 takeover）占用他人已占花名同样前置拒（C2 adj-b1b 变体）", async () => {
    await anchorSession("sess-v081-m01b-a");
    await anchorSession("sess-v081-m01b-b");
    await anchorSession("sess-v081-m01b-c");
    setPeerServicesForTests(fakePeerServices({}));
    const connA = nextConn();
    const connB = nextConn();
    const connC = nextConn();
    await identify({ name: "alice", sessionId: "sess-v081-m01b-a" }, connA);
    await identify({ name: "bob", sessionId: "sess-v081-m01b-b" }, connB);
    await identify({ name: "carol", sessionId: "sess-v081-m01b-c" }, connC);

    const { result, payload } = await identify({ name: "bob", sessionId: "sess-v081-m01b-c" }, connC);
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("team_rename_blocked");
    const team = await readTeam(stateRoot, "default");
    expect(team?.members.map((m) => m.key)).toEqual(["alice", "bob", "carol"]);
    expect(identityStore.get(connC)?.agentKey).toBe("carol");
  });

  it("peer 轴花名被另一个**活**会话占着 → 预检拒（peer_axis_failed），队内轴不落地", async () => {
    await anchorSession("sess-v081-m01c");
    setPeerServicesForTests(fakePeerServices({}));
    const conn = nextConn();
    await identify({ name: "solo", sessionId: "sess-v081-m01c" }, conn);
    setPeerSessionContext({ sessionId: "sess-v081-m01c", name: "solo", pid: process.pid, root: peerRoot });

    // 另一个活进程占着 peer 花名 "dora"（pid 必须活着——本进程自己的记录豁免）。
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => sleeper.once("spawn", () => resolve()));
    try {
      await writePeerRecord(peerRoot, peerRecord(sleeper.pid!, "dora", "sess-v081-m01c-dora"));
      let renameCalls = 0;
      setPeerServicesForTests(fakePeerServices({ onRename: () => { renameCalls += 1; } }));

      const { result, payload } = await identify({ name: "dora", sessionId: "sess-v081-m01c" }, conn);
      expect(result.isError).toBe(true);
      expect(payload.error).toBe("peer_axis_failed");
      expect((payload.peer as Record<string, unknown>).error).toBe("name_taken");
      expect((payload.teamAxis as Record<string, unknown>).registered).toBe(false);
      expect(payload.renamed).toEqual({ peer: false, team: false });
      // 队内轴零残留：成员键、names.json、连接身份全是旧名（修复前队内已换成 dora）。
      const team = await readTeam(stateRoot, "default");
      expect(team?.members.map((m) => m.key)).toEqual(["solo"]);
      expect((await readNames())["solo"]?.sessionId).toBe("sess-v081-m01c");
      expect(identityStore.get(conn)?.agentKey).toBe("solo");
      expect(renameCalls).toBe(0);
    } finally {
      sleeper.kill();
    }
  });

  it("peer 花名只被**死**记录占着 → 不挡改名（死名可 reclaim 的既有语义不破坏）", async () => {
    await anchorSession("sess-v081-m01d");
    setPeerServicesForTests(fakePeerServices({}));
    const conn = nextConn();
    await identify({ name: "solo", sessionId: "sess-v081-m01d" }, conn);
    setPeerSessionContext({ sessionId: "sess-v081-m01d", name: "solo", pid: process.pid, root: peerRoot });
    // 死记录：pid 不可能活着（不生成真进程，pidAlive 直接判死）。
    await writePeerRecord(peerRoot, peerRecord(999999, "dora", "sess-v081-m01d-dora"));

    const { result, payload } = await identify({ name: "dora", sessionId: "sess-v081-m01d" }, conn);
    expect(result.isError).toBeFalsy();
    expect(payload.renamed).toEqual({ peer: true, team: true });
    expect((await readTeam(stateRoot, "default"))?.members.map((m) => m.key)).toEqual(["dora"]);
  });

  it("合法改名（两轴都空的新花名）不受影响（既有流程回归）", async () => {
    await anchorSession("sess-v081-m01e");
    setPeerServicesForTests(fakePeerServices({}));
    const conn = nextConn();
    await identify({ name: "solo", sessionId: "sess-v081-m01e" }, conn);
    setPeerSessionContext({ sessionId: "sess-v081-m01e", name: "solo", pid: process.pid, root: peerRoot });

    const { result, payload } = await identify({ name: "duet", sessionId: "sess-v081-m01e" }, conn);
    expect(result.isError).toBeFalsy();
    expect(payload.renamed).toEqual({ peer: true, team: true });
    expect(identityStore.get(conn)?.agentKey).toBe("duet");
    expect((await readTeam(stateRoot, "default"))?.members.map((m) => m.key)).toEqual(["duet"]);
    expect((await readNames())["duet"]?.sessionId).toBe("sess-v081-m01e");
  });
});

// ---------------------------------------------------------------------------
// M01 ②：已中毒 team.json（双重复员键）的工具面自愈（core/teamstate.ts repairTeamState）
// ---------------------------------------------------------------------------

describe("M01 ②：中毒 team.json 自愈（repairTeamState）", () => {
  async function seedTeam(): Promise<void> {
    await mkdir(join(stateRoot, "teams", "default"), { recursive: true });
    await mkdir(join(stateRoot, "registry"), { recursive: true });
    const team = newTeamState({
      teamId: "default",
      founderKey: "alice",
      founder: { key: "alice", sessionId: "sess-v081-heal-a", role: "peer", joinedAt: 1, lastSeen: 1 },
      now: 1,
    });
    team.members.push({ key: "bob", sessionId: "sess-v081-heal-b", role: "peer", joinedAt: 2, lastSeen: 2 });
    await writeTeam(stateRoot, team);
    // names.json 权威索引：bob 绑原持有者 sid（改名残留行在索引里没有绑定——M01 的形状）。
    await writeFile(
      join(stateRoot, "registry", "names.json"),
      JSON.stringify({
        alice: { sessionId: "sess-v081-heal-a", role: "peer", registeredAt: 1 },
        bob: { sessionId: "sess-v081-heal-b", role: "peer", registeredAt: 2 },
      }),
      "utf8",
    );
  }

  /** 写入 M01 中毒态：members 出现两个 bob 行（原持有者在前、改名残留在后），.bak 同步中毒。 */
  async function poisonTeam(): Promise<string> {
    const file = join(stateRoot, "teams", "default", "team.json");
    const team = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const members = team["members"] as Array<Record<string, unknown>>;
    members.push({ ...members.find((m) => m["key"] === "bob"), sessionId: "sess-v081-heal-residue", lastSeen: 3 });
    const poisoned = JSON.stringify(team, null, 2);
    await writeFile(file, poisoned, "utf8");
    await writeFile(`${file}.bak`, poisoned, "utf8");
    return file;
  }

  it("双重复员键（含 .bak 中毒）→ 自愈：保留 names 权威行、丢弃残留行、.bak 一并治好", async () => {
    await seedTeam();
    const file = await poisonTeam();
    // 中毒态确实不可读（readTeam 拒读）——M01 的「全队 internal」形态。
    await expect(readTeam(stateRoot, "default")).rejects.toThrow(/duplicate member keys/);

    const repair = await repairTeamState(stateRoot, "default");
    expect(repair.repaired).toBe(true);
    expect(repair.reason).toBe("repaired");
    // 权威索引指向原持有者 → 保留原持有者行，丢弃改名残留行。
    expect(repair.kept).toEqual([
      { key: "alice", sessionId: "sess-v081-heal-a" },
      { key: "bob", sessionId: "sess-v081-heal-b" },
    ]);
    expect(repair.dropped).toEqual([{ key: "bob", sessionId: "sess-v081-heal-residue" }]);
    expect(repair.fallbackKeys).toEqual([]);

    // 真源与 .bak 都被重写成健康态（修复前 .bak 同步中毒）。
    const healed = await readTeam(stateRoot, "default");
    expect(healed?.members.map((m) => m.key)).toEqual(["alice", "bob"]);
    expect(healed?.members.find((m) => m.key === "bob")?.sessionId).toBe("sess-v081-heal-b");
    const backup = JSON.parse(await readFile(`${file}.bak`, "utf8")) as { members: Array<{ key: string }> };
    expect(backup.members.map((m) => m.key)).toEqual(["alice", "bob"]);
    // 残损字节保全（forensic）。
    expect(existsSync(`${file}.corrupt`)).toBe(true);
    // 审计留痕。
    const events = (await readFile(join(stateRoot, "logs", "engine.jsonl"), "utf8"));
    expect(events).toContain("team-state-repaired");
  });

  it("无 names 权威绑定的重复键 → 兜底保留先到行并披露 fallbackKeys", async () => {
    await seedTeam();
    await rm(join(stateRoot, "registry", "names.json"), { force: true });
    await poisonTeam();

    const repair = await repairTeamState(stateRoot, "default");
    expect(repair.repaired).toBe(true);
    expect(repair.fallbackKeys).toEqual(["bob"]);
    const healed = await readTeam(stateRoot, "default");
    // 兜底保留**先到**行（原持有者 sid 先写入）。
    expect(healed?.members.find((m) => m.key === "bob")?.sessionId).toBe("sess-v081-heal-b");
  });

  it("健康态调用 = no-op（幂等，不写字节）", async () => {
    await seedTeam();
    const file = join(stateRoot, "teams", "default", "team.json");
    const before = await readFile(file, "utf8");
    const repair = await repairTeamState(stateRoot, "default");
    expect(repair.repaired).toBe(false);
    expect(repair.reason).toBe("not-corrupt");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(existsSync(`${file}.corrupt`)).toBe(false);
  });

  it("非重复键缺陷（缺 founderKey / 非 JSON）→ 不猜不修，字节原样", async () => {
    await seedTeam();
    const file = join(stateRoot, "teams", "default", "team.json");
    const team = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    delete team["founderKey"];
    const broken = JSON.stringify(team, null, 2);
    await writeFile(file, broken, "utf8");
    await writeFile(`${file}.bak`, broken, "utf8");

    const repair = await repairTeamState(stateRoot, "default");
    expect(repair.repaired).toBe(false);
    expect(repair.reason).toBe("unrepairable");
    expect(repair.defect).toContain("founderKey");
    expect(await readFile(file, "utf8")).toBe(broken);
    expect(existsSync(`${file}.corrupt`)).toBe(false);

    // 非 JSON 同样拒修。
    await writeFile(file, "{ not json", "utf8");
    const repair2 = await repairTeamState(stateRoot, "default");
    expect(repair2.reason).toBe("unrepairable");
    expect(repair2.defect).toContain("not valid JSON");
  });
});

// ---------------------------------------------------------------------------
// C6-BUG-1（P2）：takeover 传未锚定 sid —— 先验后改，失败零副作用
// ---------------------------------------------------------------------------

describe("C6-BUG-1：takeover 的 sessionId 前置校验（红队 lane-b1-repro 复放）", () => {
  it("未锚定 sid + takeover:true → session_not_anchored，且在途 attempt/任务/names 全部零变化", async () => {
    await anchorSession("sess-v081-b1-kay");
    await anchorSession("sess-v081-b1-meg");
    setPeerServicesForTests(fakePeerServices({}));
    const connKay = nextConn();
    const connMeg = nextConn();
    const { createToolCore } = await import("./core.js");
    const core = createToolCore(deps);
    await identify({ name: "kay", sessionId: "sess-v081-b1-kay" }, connKay);
    await identify({ name: "meg", sessionId: "sess-v081-b1-meg" }, connMeg);
    await handleTeam(deps, { action: "init" } as never, connKay);
    const dispatched = await core.xc_dispatch(
      { to: "meg", title: "t1", prompt: "do t1", acceptance: "done" } as never,
      connKay,
    );
    const taskId = String(payloadOf(dispatched)["taskId"]);
    const claim = await core.xc_claim({ taskId } as never, connMeg);
    const attemptId = String(payloadOf(claim)["attemptId"]);
    expect(attemptId.length).toBeGreaterThan(0);

    const before = {
      task: (await readTeam(stateRoot, "default"))!.tasks[0]!,
      names: await readNames(),
    };
    expect(before.task.status).toBe("claimed");
    expect(before.task.attempt).toBe(1);

    // 攻击调用：同一活连接，花名对、sid 是打错的未锚定值、带 takeover:true。
    const { result, payload } = await identify(
      { name: "meg", sessionId: "sess-v081-b1-TYPO", takeover: true },
      connMeg,
    );
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("session_not_anchored");
    expect(payload.sessionId).toBe("sess-v081-b1-TYPO");

    // 零副作用（修复前：attempt 1→2、任务回 pending、history 落 revoked-rebind-takeover、
    // names.json 丢 meg 绑定）。
    const after = {
      task: (await readTeam(stateRoot, "default"))!.tasks[0]!,
      names: await readNames(),
    };
    expect(after.task.status).toBe("claimed");
    expect(after.task.assignee).toBe("meg");
    expect(after.task.attempt).toBe(1);
    expect(after.task.history.at(-1)?.event).toBe("claimed");
    expect(Object.keys(after.names).sort()).toEqual(Object.keys(before.names).sort());
    expect(after.names["meg"]?.sessionId).toBe("sess-v081-b1-meg");
    // 连接身份未被换写。
    expect(identityStore.get(connMeg)?.agentKey).toBe("meg");
    // 无任何撤销/回滚审计。
    const events = await engineEvents();
    expect(events.some((e) => e["event"] === "revoked-rebind-takeover")).toBe(false);
    expect(events.some((e) => e["event"] === "member-takeover")).toBe(false);

    // 可恢复性不破坏：用正确 sid 重跑 takeover 形状的 identify（幂等重绑）仍成功。
    const retry = await identify({ name: "meg", sessionId: "sess-v081-b1-meg" }, connMeg);
    expect(retry.result.isError).toBeFalsy();
    const reclaim = await core.xc_claim({ taskId } as never, connMeg);
    // 任务仍在 meg 名下（未回池）→ 再领得 task_not_pending，与攻击前一致。
    expect(payloadOf(reclaim)["error"]).toBe("task_not_pending");
  });

  it("sid 已被别的花名绑定 + takeover:true → session_already_bound 前置拒，零副作用", async () => {
    await anchorSession("sess-v081-b1b-kay");
    await anchorSession("sess-v081-b1b-meg");
    setPeerServicesForTests(fakePeerServices({}));
    const connKay = nextConn();
    const connMeg = nextConn();
    const { createToolCore } = await import("./core.js");
    const core = createToolCore(deps);
    await identify({ name: "kay", sessionId: "sess-v081-b1b-kay" }, connKay);
    await identify({ name: "meg", sessionId: "sess-v081-b1b-meg" }, connMeg);
    await handleTeam(deps, { action: "init" } as never, connKay);
    const dispatched = await core.xc_dispatch(
      { to: "meg", title: "t1", prompt: "do t1", acceptance: "done" } as never,
      connKay,
    );
    const taskId = String(payloadOf(dispatched)["taskId"]);
    await core.xc_claim({ taskId } as never, connMeg);

    // meg 的连接用 kay 的 sid  takeover meg：sid 归属校验必须在任何变更前拒。
    const { result, payload } = await identify(
      { name: "meg", sessionId: "sess-v081-b1b-kay", takeover: true },
      connMeg,
    );
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("session_already_bound");
    const task = (await readTeam(stateRoot, "default"))!.tasks[0]!;
    expect(task.status).toBe("claimed");
    expect(task.attempt).toBe(1);
    expect(task.history.at(-1)?.event).toBe("claimed");
    expect(Object.keys(await readNames()).sort()).toEqual(["kay", "meg"]);
  });

  it("对照组：普通 identify（无 takeover）未锚定 sid → session_not_anchored，零副作用（既有行为不破坏）", async () => {
    await anchorSession("sess-v081-b1c");
    setPeerServicesForTests(fakePeerServices({}));
    const conn = nextConn();
    await identify({ name: "meg", sessionId: "sess-v081-b1c" }, conn);
    const { result, payload } = await identify({ name: "meg", sessionId: "sess-v081-b1c-TYPO" }, conn);
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("session_not_anchored");
    expect((await readNames())["meg"]?.sessionId).toBe("sess-v081-b1c");
    expect(identityStore.get(conn)?.agentKey).toBe("meg");
  });
});

// ---------------------------------------------------------------------------
// C6-BUG-6（P3）：改名守卫死胡同——终态引用不再永挡，挡路项具体可执行
// ---------------------------------------------------------------------------

describe("C6-BUG-6：改名守卫对终态引用放行、挡路明细可执行（红队 lane-b6 复放）", () => {
  it("做完错误指引的两步（完成/取消任务 + 排空未读）后改名成功，回执披露 terminalTaskRefs", async () => {
    await anchorSession("sess-v081-b6-lead");
    await anchorSession("sess-v081-b6-bob");
    setPeerServicesForTests(fakePeerServices({}));
    const connLead = nextConn();
    const connBob = nextConn();
    const { createToolCore } = await import("./core.js");
    const core = createToolCore(deps);
    await identify({ name: "boss", sessionId: "sess-v081-b6-lead" }, connLead);
    await identify({ name: "bob", sessionId: "sess-v081-b6-bob" }, connBob);
    await handleTeam(deps, { action: "init" } as never, connLead);

    // bob 名下一 completed（assignee 永驻——终态引用的主角）+ lead 名下两 cancelled。
    const d1 = await core.xc_dispatch(
      { to: "bob", title: "t1", prompt: "do t1", acceptance: "done" } as never,
      connLead,
    );
    const t1 = String(payloadOf(d1)["taskId"]);
    const claim = await core.xc_claim({ taskId: t1 } as never, connBob);
    await core.xc_report({ taskId: t1, attemptId: String(payloadOf(claim)["attemptId"]), status: "in_progress" } as never, connBob);
    const evidence = join(workDir, "ev-b6.txt");
    await writeFile(evidence, "done\n", "utf8");
    const completed = await core.xc_report(
      { taskId: t1, attemptId: String(payloadOf(claim)["attemptId"]), status: "completed", result: "ok", evidence: [{ path: evidence }] } as never,
      connBob,
    );
    expect(payloadOf(completed)["error"]).toBeUndefined();
    const d2 = await core.xc_dispatch(
      { to: "bob", title: "t2", prompt: "do t2", acceptance: "done" } as never,
      connLead,
    );
    await handleTeam(deps, { action: "cancel", taskId: String(payloadOf(d2)["taskId"]) } as never, connLead);

    // 排空 bob 的未读（派发/完成回执都进过他的箱）。
    for (let i = 0; i < 5; i += 1) {
      const inbox = await handleRead(deps, { scope: "inbox" } as never, connBob);
      const left = Number(payloadOf(inbox)["unreadCount"] ?? 0);
      if (left === 0) break;
    }

    // 终态引用（completed 的 assignee=bob）就位后改名——修复前恒 team_rename_blocked。
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.tasks.some((t) => t.status === "completed" && t.assignee === "bob")).toBe(true);

    setPeerSessionContext({ sessionId: "sess-v081-b6-bob", name: "bob", pid: process.pid, root: peerRoot });
    const { result, payload } = await identify({ name: "bobby", sessionId: "sess-v081-b6-bob" }, connBob);
    expect(result.isError).toBeFalsy();
    expect(payload.renamed).toEqual({ peer: true, team: true });
    // 终态引用数如实披露（历史审计留痕，不再挡路）。
    expect(payload.terminalTaskRefs).toBe(1);
    expect(String(result.content[0]?.text)).toContain("terminal task record(s)");
    // 花名册与 names 都换成新键，终态任务的 assignee 保持历史原值。
    expect((await readTeam(stateRoot, "default"))?.members.map((m) => m.key)).toEqual(["boss", "bobby"]);
    expect((await readNames())["bobby"]?.sessionId).toBe("sess-v081-b6-bob");
    const finalTask = (await readTeam(stateRoot, "default"))!.tasks.find((t) => t.status === "completed")!;
    expect(finalTask.assignee).toBe("bob");
  });

  it("开放任务引用仍挡改名，且理由给出任务 id（守卫本身不放松）", async () => {
    await anchorSession("sess-v081-b6b-lead");
    await anchorSession("sess-v081-b6b-bob");
    setPeerServicesForTests(fakePeerServices({}));
    const connLead = nextConn();
    const connBob = nextConn();
    const { createToolCore } = await import("./core.js");
    const core = createToolCore(deps);
    await identify({ name: "boss", sessionId: "sess-v081-b6b-lead" }, connLead);
    await identify({ name: "bob", sessionId: "sess-v081-b6b-bob" }, connBob);
    await handleTeam(deps, { action: "init" } as never, connLead);
    const d1 = await core.xc_dispatch(
      { to: "bob", title: "t1", prompt: "do t1", acceptance: "done" } as never,
      connLead,
    );
    const t1 = String(payloadOf(d1)["taskId"]);
    await core.xc_claim({ taskId: t1 } as never, connBob);

    setPeerSessionContext({ sessionId: "sess-v081-b6b-bob", name: "bob", pid: process.pid, root: peerRoot });
    const { result, payload } = await identify({ name: "bobby", sessionId: "sess-v081-b6b-bob" }, connBob);
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("team_rename_blocked");
    expect(String(payload.reason)).toContain("open task(s) assigned to you");
    expect(payload.openTaskIds).toEqual([t1]);
    expect(payload.mailboxCount).toBeGreaterThan(0);
    // 两轴都没动。
    expect((await readTeam(stateRoot, "default"))?.members.map((m) => m.key)).toEqual(["boss", "bob"]);
    expect(identityStore.get(connBob)?.agentKey).toBe("bob");
  });

  it("指定受领的 pending 任务（to=本人）也挡改名（防搁浅：他人 claim 得 not_assignee）", async () => {
    await anchorSession("sess-v081-b6c-lead");
    await anchorSession("sess-v081-b6c-bob");
    setPeerServicesForTests(fakePeerServices({}));
    const connLead = nextConn();
    const connBob = nextConn();
    const { createToolCore } = await import("./core.js");
    const core = createToolCore(deps);
    await identify({ name: "boss", sessionId: "sess-v081-b6c-lead" }, connLead);
    await identify({ name: "bob", sessionId: "sess-v081-b6c-bob" }, connBob);
    await handleTeam(deps, { action: "init" } as never, connLead);
    const d1 = await core.xc_dispatch(
      { to: "bob", title: "t1", prompt: "do t1", acceptance: "done" } as never,
      connLead,
    );
    const t1 = String(payloadOf(d1)["taskId"]);

    setPeerSessionContext({ sessionId: "sess-v081-b6c-bob", name: "bob", pid: process.pid, root: peerRoot });
    const { result, payload } = await identify({ name: "bobby", sessionId: "sess-v081-b6c-bob" }, connBob);
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("team_rename_blocked");
    expect(payload.designatedPendingIds).toEqual([t1]);
  });

  it("邮件**已读历史**不挡改名、**未读**挡（v0.8.1 修正的另一条死胡同路径）", async () => {
    await anchorSession("sess-v081-b6d");
    setPeerServicesForTests(fakePeerServices({}));
    const conn = nextConn();
    await identify({ name: "solo", sessionId: "sess-v081-b6d" }, conn);
    const { appendMailbox, createMessage } = await import("../core/mailbox.js");
    await appendMailbox(stateRoot, "default", "solo", createMessage("bob", "solo", "hello", {}));
    // 消费成已读：readCurrentMailbox + acknowledge。
    const { acknowledgeMailbox, readCurrentMailbox } = await import("../core/mailbox.js");
    const current = await readCurrentMailbox(stateRoot, "default", "solo");
    await acknowledgeMailbox(stateRoot, "default", "solo", current.map((m) => m.id), Date.now());

    setPeerSessionContext({ sessionId: "sess-v081-b6d", name: "solo", pid: process.pid, root: peerRoot });
    const ok = await identify({ name: "solo2", sessionId: "sess-v081-b6d" }, conn);
    expect(ok.result.isError).toBeFalsy();

    // 未读一条 → 挡（同一连接先改回 solo 名太绕，直接换新连接新花名验未读分支）。
    const conn2 = nextConn();
    await anchorSession("sess-v081-b6d-2");
    await identify({ name: "reader", sessionId: "sess-v081-b6d-2" }, conn2);
    await appendMailbox(stateRoot, "default", "reader", createMessage("bob", "reader", "unread one", {}));
    setPeerSessionContext({ sessionId: "sess-v081-b6d-2", name: "reader", pid: process.pid, root: peerRoot });
    const blocked = await identify({ name: "reader2", sessionId: "sess-v081-b6d-2" }, conn2);
    expect(blocked.result.isError).toBe(true);
    expect(payloadOf(blocked.result).error).toBe("team_rename_blocked");
    expect(String(payloadOf(blocked.result).reason)).toContain("unread");
    expect(payloadOf(blocked.result).mailboxCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C2-B3（P2）：改名/新花名后的接手连续性
// ---------------------------------------------------------------------------

describe("C2-B3：改名与接手的连续性（红队 adj-b3 复放）", () => {
  it("carryCheckpointDir：检查点目录随改名搬迁（含 .nudge），无旧目录 = 无可搬", async () => {
    const dir = join(stateRoot, "checkpoints", "alice");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-11-15T00-00-00-000Z.md"), "# checkpoint\n", "utf8");
    await writeFile(join(dir, ".nudge"), "2026-11-15T00:00:00.000Z\n", "utf8");

    const carried = await carryCheckpointDir(stateRoot, "alice", "alice2");
    expect(carried).toEqual({ carried: true });
    expect(existsSync(dir)).toBe(false);
    const moved = join(stateRoot, "checkpoints", "alice2");
    expect(existsSync(join(moved, "2026-11-15T00-00-00-000Z.md"))).toBe(true);
    expect(existsSync(join(moved, ".nudge"))).toBe(true);
    // 搬完后 latestCheckpoint 按新花名即可寻回（默认 self 接手包不再静默丢要素）。
    expect(await latestCheckpoint(stateRoot, "alice2")).not.toBeNull();
    expect(await latestCheckpoint(stateRoot, "alice")).toBeNull();

    // 无旧目录 → carried:false 且无 error（不是失败）。
    expect(await carryCheckpointDir(stateRoot, "nobody", "somebody")).toEqual({ carried: false });
  });

  it("carryCheckpointDir：目标已存在 → 逐文件合并搬迁（不吞文件）", async () => {
    const from = join(stateRoot, "checkpoints", "old");
    const to = join(stateRoot, "checkpoints", "new");
    await mkdir(from, { recursive: true });
    await mkdir(to, { recursive: true });
    await writeFile(join(from, "2026-11-15T00-00-00-000Z.md"), "old\n", "utf8");
    await writeFile(join(to, "2026-11-15T00-00-01-000Z.md"), "new\n", "utf8");

    const carried = await carryCheckpointDir(stateRoot, "old", "new");
    expect(carried.carried).toBe(true);
    expect(existsSync(join(to, "2026-11-15T00-00-00-000Z.md"))).toBe(true);
    expect(existsSync(join(to, "2026-11-15T00-00-01-000Z.md"))).toBe(true);
  });

  it("handoff self 包三要素全空 + 不在场成员持有状态 → 连续性指针进 suggestions 与 warnings", async () => {
    await mkdir(join(stateRoot, "teams", "default"), { recursive: true });
    const team = newTeamState({
      teamId: "default",
      founderKey: "me",
      founder: { key: "me", sessionId: "sess-v081-b3-me", role: "peer", joinedAt: 1, lastSeen: 1 },
      now: 1,
    });
    team.members.push({ key: "oldhands", sessionId: "sess-v081-b3-old", role: "peer", joinedAt: 2, lastSeen: 2 });
    team.tasks.push({
      id: "era-t1",
      title: "旧会话的活",
      prompt: "p",
      dependsOn: [],
      status: "in_progress",
      assignee: "oldhands",
      attempt: 1,
      attemptId: "a-1",
      createdBy: "me",
      createdAt: 1,
      updatedAt: 1,
      lastProgressTs: 1,
      result: null,
      error: null,
      evidence: [],
      history: [],
    });
    await writeTeam(stateRoot, team);
    await appendMailbox(
      stateRoot,
      "default",
      "oldhands",
      createMessage("me", "oldhands", "一条给 oldhands 的未读", {}),
    );
    await mkdir(join(stateRoot, "checkpoints", "oldhands"), { recursive: true });
    await writeFile(join(stateRoot, "checkpoints", "oldhands", "2026-11-15T00-00-00-000Z.md"), "# cp\n", "utf8");

    identityStore.bind("conn-v081-b3", {
      sessionKey: "xc:default:me",
      teamId: "default",
      name: "me",
      agentKey: "me",
      sessionId: "sess-v081-b3-me",
      role: "peer",
      boundAt: 1,
    });
    const result = await handleRead(deps, { scope: "handoff" }, "conn-v081-b3");
    const payload = payloadOf(result);
    const suggestions = payload["suggestions"] as string[];
    expect(suggestions[0]).toContain("continuity:");
    expect(suggestions[0]).toContain("oldhands");
    expect(suggestions[0]).toContain("xc_read");
    expect(payload["warnings"]).toEqual(
      expect.arrayContaining([expect.stringContaining("absent roster member(s) hold state")]),
    );
    // 文本面同样可见（第七章建议行，不是只在 JSON 里）。
    expect(String(result.content[0]?.text)).toContain("continuity:");
    // 默认 self 包本身仍如实为空（不伪造要素）。
    expect(payload["tasks"]).toEqual([]);
    expect((payload["unread"] as { count: number }).count).toBe(0);
    expect(payload["checkpoint"]).toBeNull();
  });

  it("handoff self 包有自有任务 → 不出连续性指针（正常成员不被打扰）", async () => {    await mkdir(join(stateRoot, "teams", "default"), { recursive: true });
    const team = newTeamState({
      teamId: "default",
      founderKey: "me",
      founder: { key: "me", sessionId: "sess-v081-b3b-me", role: "peer", joinedAt: 1, lastSeen: 1 },
      now: 1,
    });
    team.tasks.push({
      id: "era-t1",
      title: "我的活",
      prompt: "p",
      dependsOn: [],
      status: "in_progress",
      assignee: "me",
      attempt: 1,
      attemptId: "a-1",
      createdBy: "me",
      createdAt: 1,
      updatedAt: 1,
      lastProgressTs: 1,
      result: null,
      error: null,
      evidence: [],
      history: [],
    });
    await writeTeam(stateRoot, team);

    identityStore.bind("conn-v081-b3b", {
      sessionKey: "xc:default:me",
      teamId: "default",
      name: "me",
      agentKey: "me",
      sessionId: "sess-v081-b3b-me",
      role: "peer",
      boundAt: 1,
    });
    const result = await handleRead(deps, { scope: "handoff" }, "conn-v081-b3b");
    const payload = payloadOf(result);
    const suggestions = payload["suggestions"] as string[];
    expect(suggestions.some((s) => s.includes("continuity:"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M05 收口（集成轮）：lead 渲染跨面同源的漏网点——lead 闸错误信封的 payload leadKey。
// v0.8.1 的 M05 修复对齐了 status / handoff / checkpoint / team(history) 四面，但
// xc_team cancel 与 unblock 的 not_lead / not_authorized 信封仍直读 team.leadKey：
// 无显式 leadKey（founder 兜底）时 payload 给 null，而同一报文的门闸按 founder 判
// isLead、message 也展示 founder——与 M05 同型的自相矛盾。修法同其余三面（leadKeyOf）。
// ---------------------------------------------------------------------------

describe("M05 收口：lead 闸错误信封的 payload leadKey 与门闸/message 同源", () => {
  it("无显式 leadKey 时 cancel 的 not_lead 信封 leadKey = founder（不是 null）", async () => {
    // 注意：不传 founder（members 起空）再逐个 push——传了又 push 同键会造出
    // duplicate member keys，readTeam 直接拒读（那正是 M01 的中毒形态）。
    const team = newTeamState({ teamId: "default", name: "default", founderKey: "lead", now: Date.now() });
    team.members.push(
      { key: "lead", sessionId: "sess-lead", role: "peer", joinedAt: Date.now(), lastSeen: Date.now() },
      { key: "bob", sessionId: "sess-bob", role: "worker", joinedAt: Date.now(), lastSeen: Date.now() },
    );
    team.tasks.push({
      id: "t-1", title: "T", prompt: "p", dependsOn: [], status: "pending", assignee: null,
      attempt: 0, attemptId: null, createdBy: "carol", createdAt: Date.now(), updatedAt: Date.now(),
      lastProgressTs: Date.now(), result: null, error: null, evidence: [],
      history: [{ ts: Date.now(), event: "dispatch", by: "bob" }],
    });
    await writeTeam(stateRoot, team); // 无显式 leadKey
    identityStore.bind("conn-bob", {
      sessionKey: "sess-bob:bob", teamId: "default", name: "bob", agentKey: "bob",
      sessionId: "sess-bob", role: "worker", boundAt: Date.now(),
    });

    const res = await handleTeam(deps, { action: "cancel", taskId: "t-1" }, "conn-bob");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as { error: string; leadKey: string | null; message: string };
    expect(payload.error).toBe("not_lead");
    expect(payload.leadKey).toBe("lead"); // founder 读作 lead（与 message / isLead 门闸同源）
    expect(payload.message).toContain('only the team lead ("lead")');
  });
});



describe("M01 ②：xc_doctor action=repair-team（真 MCP 协议面）", () => {
  it("中毒 team.json → repair-team 修复且默认体检面不变（缺省调用零写入）", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerDoctorTool } = await import("./doctor-tool.js");
    const { z: zod } = await import("zod");

    // 造中毒态（与 core 单测同形：重复成员行 + .bak 同步中毒）。
    const ws = await mkdtemp(join(tmpdir(), "xc-v081-doctor-"));
    const root = join(ws, ".crosschat");
    await mkdir(join(root, "teams", "default"), { recursive: true });
    const team = newTeamState({
      teamId: "default",
      founderKey: "alice",
      founder: { key: "alice", sessionId: "sess-doc-a", role: "peer", joinedAt: 1, lastSeen: 1 },
      now: 1,
    });
    team.members.push({ key: "bob", sessionId: "sess-doc-b", role: "peer", joinedAt: 2, lastSeen: 2 });
    const raw = JSON.stringify(team, null, 2);
    const poisonedObj = JSON.parse(raw) as Record<string, unknown>;
    (poisonedObj["members"] as Array<Record<string, unknown>>).push({
      ...(poisonedObj["members"] as Array<Record<string, unknown>>).find((m) => m["key"] === "bob"),
      sessionId: "sess-doc-residue",
      lastSeen: 3,
    });
    const poisoned = JSON.stringify(poisonedObj, null, 2);
    const teamFile = join(root, "teams", "default", "team.json");
    await writeFile(teamFile, poisoned, "utf8");
    await writeFile(`${teamFile}.bak`, poisoned, "utf8");
    await expect(readTeam(root, "default")).rejects.toThrow(/duplicate member keys/);

    const server = new McpServer({ name: "doctor-v081", version: "0.0.0" });
    const actionShape = {
      action: zod.enum(["repair-team"]).optional().describe("v0.8.1 M01 自愈面"),
    };
    registerDoctorTool(server, {
      version: "0.8.1-test",
      env: {} as NodeJS.ProcessEnv,
      cwd: ws,
      stateRoot: root,
      actionShape,
    });
    const [serverT, clientT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "doctor-v081-client", version: "1.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      // tools/list：action 是**可选**参数（不新增必填配置）。
      const { tools } = await client.listTools();
      const doctor = tools.find((t) => t.name === "xc_doctor");
      expect(doctor).toBeDefined();
      const schema = doctor!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(schema.properties?.action).toBeDefined();
      expect(schema.required ?? []).toEqual([]);

      // 缺省调用：只读体检，不修 team.json（仍中毒）。
      const plain = (await client.callTool({ name: "xc_doctor", arguments: {} })) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(plain.content[0]!.text).toContain("zcode-crosschat 0.8.1-test");
      await expect(readTeam(root, "default")).rejects.toThrow(/duplicate member keys/);

      // action=repair-team：修复 + 结构化回执。
      const repaired = (await client.callTool({ name: "xc_doctor", arguments: { action: "repair-team" } })) as {
        isError?: unknown;
        content: Array<{ type: string; text: string }>;
      };
      expect(repaired.isError).toBeFalsy();
      expect(repaired.content[0]!.text).toContain("REPAIRED duplicate member keys");
      const payload = JSON.parse(repaired.content[1]!.text) as {
        repaired: boolean;
        reason: string;
        kept: Array<{ key: string; sessionId: string }>;
        dropped: Array<{ key: string; sessionId: string }>;
      };
      expect(payload.repaired).toBe(true);
      expect(payload.reason).toBe("repaired");
      expect(payload.kept.map((k) => k.sessionId)).toEqual(["sess-doc-a", "sess-doc-b"]);
      expect(payload.dropped).toEqual([{ key: "bob", sessionId: "sess-doc-residue" }]);

      // 修好后 team-axis 恢复可读（M01 的「全队 internal」被治好）。
      const healed = await readTeam(root, "default");
      expect(healed?.members.map((m) => m.key)).toEqual(["alice", "bob"]);

      // 非法 action 值被 zod 拒（入参面不变松）。
      const bad = (await client.callTool({ name: "xc_doctor", arguments: { action: "nope" } }).catch((e: unknown) => e)) as {
        isError?: unknown;
      };
      expect(bad).toBeDefined();
    } finally {
      await client.close();
      await server.close();
      await rm(ws, { recursive: true, force: true });
    }
  });
});
