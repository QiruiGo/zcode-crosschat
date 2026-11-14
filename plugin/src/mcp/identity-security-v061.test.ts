/**
 * v0.6.1 红队四番战防回归单测（身份/花名/takeover 三修复，本组 = 安全对-1/2/4
 * + 顺带 安全对-5/边界-2）。
 *
 * 攻击链均取自 deepseek-crosschat/redteam-4/evidence/adversarial/adjudication.md
 * 的复现步骤（裁决员已在 installed 0.6.0 上 confirmed；本文件锁定修复后的行为）：
 *
 * 安全对-1（P0，sec1.mjs）：队内轴可用他人公开 sessionId 无凭据重绑身份——
 *   rogue xc_identify{name:"alice", sessionId:<受害者 sid>} → peer 轴拒
 *   （session_id_in_use）但 teamAxis.registered:true，rogue 以 alice 身份派单/
 *   读箱。修复 = xcRegister hook 路径补 sid 归属/活性闸（与 peer 轴同一语义、
 *   同一实现 findLiveSessionIdHolder）。
 * 安全对-2（P1，sec2.mjs）：队内轴花名静默归一到碰撞键——squatter 先注册
 *   Ａｌｉｃｅ（全角）→ teamAxis 键 alice；真人 alice → name_taken 锁死；敏感
 *   任务重定向进 squatter 箱。修复 = validateMemberName 严格闸（注册/改名/
 *   接管/member-add 全路径），与 peer 轴严格文法同一口径。
 * 安全对-4（P1，sec345.mjs）：takeover:true 夺走活着成员的队内身份与 lead——
 *   唯一实质闸门（在途唤醒标记）依赖默认关闭的 wake_enabled；原 ② 查的是接管
 *   方自己的新 sid，对旧持有者死活不设防。修复 = 第三道闸：旧持有者 sid 仍被
 *   活进程持有 → takeover_live_holder（真实活信号，与 wake_enabled 无关）。
 * 边界-2（P2，b123.mjs）：改名路径绕过保留名校验——"LEAD" 改名成 roster 键
 *   lead 并自任 founder/lead。修复 = 改名路径与注册同一道 validateMemberName。
 *
 * 合法流程不回退（同文件锁定）：同进程幂等重注册、旧持有者已死的重启重绑、
 * wake 路径（nonce 归属证明）不受 sid 闸影响、dead-sid takeover、合法改名。
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPidDomain } from "../core/peerdir.js";
import { findLiveSessionIdHolder, scanPeers, writePeerRecord, type PeerRecord } from "../core/peerregistry.js";
import { createWakeNonce, writeSession } from "../core/registry.js";
import { readTeam } from "../core/teamstate.js";
import { handleIdentify } from "./tools-identify.js";
import { identityStore, xcRegister } from "./identity.js";
import { payloadOf, type ToolResult, type ToolPayload } from "./protocol.js";
import type { ToolDeps } from "./core.js";

let workDir = "";
let stateRoot = "";
let peerRoot = "";
let deps: ToolDeps;
let sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v061-identity-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peers-root");
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } as NodeJS.ProcessEnv };
});

afterEach(async () => {
  for (const child of sleepers) child.kill();
  sleepers = [];
  await rm(workDir, { recursive: true, force: true });
});

/** 起一个活着的子进程——它的 pid 用来当「另一个活会话」的 pid（peer 轴活记录）。 */
async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

/** 起一个随即退出的子进程——它的 pid 是「已死会话」的 pid（惰性清扫后不挡接管）。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid!;
}

function peerRecord(pid: number, name: string, sessionId: string): PeerRecord {
  return {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xcc-v061-${Math.random().toString(16).slice(2)}`,
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

/** hook 锚定（workspace 侧 registry/sessions/<sid>.json，SessionStart 钩子产物）。 */
async function anchorSession(sid: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
}

async function readNames(): Promise<Record<string, { sessionId: string }>> {
  const file = join(stateRoot, "registry", "names.json");
  if (!existsSync(file)) return {};
  return JSON.parse(await readFile(file, "utf8")) as Record<string, { sessionId: string }>;
}

let connSeq = 0;
function nextConn(): string {
  connSeq += 1;
  return `conn-v061-${connSeq}`;
}

/** 调 handleIdentify 并取结构化 payload（runCore 把 ToolError 映射成 isError 结果）。 */
async function identify(
  args: { name: string; sessionId: string; takeover?: boolean; role?: "peer" | "worker" },
  connectionKey: string,
): Promise<{ result: ToolResult; payload: ToolPayload }> {
  const result = await handleIdentify(deps, args, connectionKey);
  return { result, payload: payloadOf(result) };
}

// ---------------------------------------------------------------------------
// 安全对-1（P0）：队内轴 sid 归属/活性闸
// ---------------------------------------------------------------------------

describe("安全对-1（P0）：队内轴注册校验 sessionId 归属与活性（红队 sec1 重放）", () => {
  it("rogue 用受害者 sid（hook 路径）→ session_id_in_use；零副作用（names/roster/绑定均不动）", async () => {
    // 受害者：hook 锚定 + 队内注册（生产顺序：team 轴先、peer 轴后——peer 记录
    // 在 victim 自己的进程里落盘，pid=该进程；测试用 sleeper pid 模拟「另一个
    // 活进程持有该 sid」）。
    await anchorSession("sess-victim");
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-victim" }, nextConn(), { peerRoot });
    const livePid = await startSleeper();
    await writePeerRecord(peerRoot, peerRecord(livePid, "victim", "sess-victim"));

    // 攻击者 1：同花名 + 受害者 sid（红队原样：name="alice"/sid=victim）。
    const rogueConn = nextConn();
    const rogue = await xcRegister(
      stateRoot,
      { name: "victim", sessionId: "sess-victim" },
      rogueConn,
      { peerRoot },
    ).catch((err: unknown) => ({ thrown: err }));
    expect(rogue).toMatchObject({ thrown: expect.anything() });
    const payload = (rogue as { thrown: { payload: ToolPayload } }).thrown.payload;
    expect(payload.error).toBe("session_id_in_use");
    expect(payload.sessionId).toBe("sess-victim");
    expect(payload.boundName).toBe("victim");
    expect(payload.boundPid).toBe(livePid);

    // 攻击者 2：空闲花名 + 受害者 sid（不碰 victim 花名也不能串号）。
    // v0.6.1 复验定位修复：抛错点移到名字/sid 交叉校验之后，这条路径恢复 v0.6.0 起
    // 文档化的 session_already_bound（"该 sid 已绑到别的名字"）——两者都是拒绝，
    // 错误码契约不变（历史回归断言按旧码判）。
    const rogue2 = await xcRegister(
      stateRoot,
      { name: "bob", sessionId: "sess-victim" },
      nextConn(),
      { peerRoot },
    ).catch((err: unknown) => ({ thrown: err }));
    expect((rogue2 as { thrown: { payload: ToolPayload } }).thrown.payload.error).toBe("session_already_bound");

    // 零副作用：names.json 仍只有 victim→sess-victim；花名册未增员；rogue 连接未绑定。
    const names = await readNames();
    expect(Object.keys(names)).toEqual(["victim"]);
    expect(names.victim?.sessionId).toBe("sess-victim");
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.key)).toEqual(["victim"]);
    expect(team.members[0]!.sessionId).toBe("sess-victim");
    expect(identityStore.get(rogueConn)).toBeUndefined();
  });

  it("工具层（xc_identify）同样在队内轴即拒——不再出现 peer_axis_failed + teamAxis.registered:true", async () => {
    await anchorSession("sess-victim");
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-victim" }, nextConn(), { peerRoot });
    const livePid = await startSleeper();
    await writePeerRecord(peerRoot, peerRecord(livePid, "victim", "sess-victim"));

    const rogueConn = nextConn();
    const { result, payload } = await identify({ name: "victim", sessionId: "sess-victim" }, rogueConn);
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("session_id_in_use");
    // 修复前这里是 peer_axis_failed{teamAxis:{registered:true}}——rogue 已是队内 victim。
    expect(JSON.stringify(payload)).not.toContain("teamAxis");
    expect(identityStore.get(rogueConn)).toBeUndefined();
  });

  it("本进程自己的 sid → 豁免（agent 重试/重连的幂等重注册，peer-1 语义）", async () => {
    await anchorSession("sess-mine");
    await writePeerRecord(peerRoot, peerRecord(process.pid, "mine", "sess-mine"));
    const out = await xcRegister(stateRoot, { name: "mine", sessionId: "sess-mine" }, nextConn(), { peerRoot });
    expect(out.via).toBe("hook");
    expect(out.sessionKey).toBe("xc:default:mine");
  });

  it("合法重启：旧持有者进程已死（记录被惰性清扫）→ 同 (name, sid) 重绑成功", async () => {
    await anchorSession("sess-restart");
    const dead = await deadPid();
    await writePeerRecord(peerRoot, peerRecord(dead, "restarter", "sess-restart"));
    const out = await xcRegister(stateRoot, { name: "restarter", sessionId: "sess-restart" }, nextConn(), { peerRoot });
    expect(out.via).toBe("hook");
    expect(out.sessionKey).toBe("xc:default:restarter");
  });

  it("wake 路径不受 sid 闸影响（一次性 nonce 已是归属证明；无头回合可与交互会话同 sid）", async () => {
    const { token } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "w1", sid: "sess-w1" });
    const livePid = await startSleeper();
    await writePeerRecord(peerRoot, peerRecord(livePid, "w1", "sess-w1"));
    const out = await xcRegister(
      stateRoot,
      { name: "w1", sessionId: "sess-w1", wakeToken: token },
      nextConn(),
      { peerRoot },
    );
    expect(out.via).toBe("wake");
  });
});

// ---------------------------------------------------------------------------
// 安全对-4（P1）：takeover 旧持有者活性闸
// ---------------------------------------------------------------------------

describe("安全对-4（P1）：takeover 对活成员的真实防护（红队 sec345 重放）", () => {
  /** 前置：victim 队内注册（ founder/lead ）+ peer 轴活/死记录（旧持有者活性信号）。 */
  async function setupVictim(holderPid: number): Promise<void> {
    await anchorSession("sess-victim");
    await anchorSession("sess-thief");
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-victim" }, nextConn(), { peerRoot });
    await writePeerRecord(peerRoot, peerRecord(holderPid, "victim", "sess-victim"));
  }

  it("旧持有者活着（peer 轴活记录）→ takeover_live_holder；身份/花名/lead 零换绑", async () => {
    const livePid = await startSleeper();
    await setupVictim(livePid);

    const thiefConn = nextConn();
    const { result, payload } = await identify(
      { name: "victim", sessionId: "sess-thief", takeover: true },
      thiefConn,
    );
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("takeover_live_holder");
    expect(payload.agentKey).toBe("victim");
    expect(payload.sessionId).toBe("sess-victim");
    expect(payload.boundPid).toBe(livePid);

    // 零换绑：names.json / roster / lead 归属全部保持旧持有者；thief 连接未绑定。
    expect((await readNames()).victim?.sessionId).toBe("sess-victim");
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.sessionId)).toEqual(["sess-victim"]);
    expect(team.founderKey).toBe("victim");
    expect(identityStore.get(thiefConn)).toBeUndefined();
  });

  it("旧持有者已死（进程亡，记录惰性清扫）→ takeover 成功（合法 dead-sid 接管）", async () => {
    const dead = await deadPid();
    await setupVictim(dead);

    const thiefConn = nextConn();
    const { result, payload } = await identify(
      { name: "victim", sessionId: "sess-thief", takeover: true },
      thiefConn,
    );
    expect(result.isError).toBeFalsy();
    expect(payload.takeoverApplied).toEqual(["team"]);
    // 花名换绑到新 sid；绑定生效。
    expect((await readNames()).victim?.sessionId).toBe("sess-thief");
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.sessionId)).toEqual(["sess-thief"]);
    expect(identityStore.get(thiefConn)?.agentKey).toBe("victim");
  });

  it("接管方自己的新 sid 已被活进程持有 → session_id_in_use（换绑前拒，无中间态）", async () => {
    const dead = await deadPid();
    await setupVictim(dead);
    const thiefSidePid = await startSleeper();
    await writePeerRecord(peerRoot, peerRecord(thiefSidePid, "thief-side", "sess-thief"));

    const { result, payload } = await identify(
      { name: "victim", sessionId: "sess-thief", takeover: true },
      nextConn(),
    );
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("session_id_in_use");
    // 关键：unbindName 尚未发生——victim 花名仍绑旧 sid（修复前会先解绑再失败，
    // 把花名卡在「已解绑未重绑」的中间态）。
    expect((await readNames()).victim?.sessionId).toBe("sess-victim");
  });

  it("在途唤醒标记仍在（gate ①）：15min 内 nonce → takeover_inflight", async () => {
    const dead = await deadPid();
    await setupVictim(dead);
    await createWakeNonce(stateRoot, { teamId: "default", agentKey: "victim", sid: "sess-victim" });

    const { result, payload } = await identify(
      { name: "victim", sessionId: "sess-thief", takeover: true },
      nextConn(),
    );
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("takeover_inflight");
  });
});

// ---------------------------------------------------------------------------
// 安全对-2 / 边界-2：改名路径与注册同一道严格花名闸
// ---------------------------------------------------------------------------

describe("安全对-2 / 边界-2（P1/P2）：改名路径花名严格校验（红队 b123 重放）", () => {
  it("改名到保留名（LEAD）→ name_reserved；roster 键/names/lead 归属零改动", async () => {
    await anchorSession("sess-zzz");
    const conn = nextConn();
    await xcRegister(stateRoot, { name: "zzz", sessionId: "sess-zzz" }, conn, { peerRoot });

    const { result, payload } = await identify({ name: "LEAD", sessionId: "sess-zzz" }, conn);
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("name_reserved");
    expect(payload.name).toBe("LEAD");

    // 零改动：花名册键仍是 zzz（修复前 roster key 变成 lead 且自任 founder/lead）。
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.key)).toEqual(["zzz"]);
    expect(team.founderKey).toBe("zzz");
    expect((await readNames()).zzz?.sessionId).toBe("sess-zzz");
    expect(identityStore.get(conn)?.agentKey).toBe("zzz");
  });

  it("改名到全角名（Ａｌｉｃｅ）→ invalid_name；零改动", async () => {
    await anchorSession("sess-zzz");
    const conn = nextConn();
    await xcRegister(stateRoot, { name: "zzz", sessionId: "sess-zzz" }, conn, { peerRoot });

    const fullwidth = String.fromCodePoint(0xff23, 0xff33); // ＡＳ
    const { result, payload } = await identify({ name: fullwidth, sessionId: "sess-zzz" }, conn);
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("invalid_name");
    expect((await readNames()).zzz?.sessionId).toBe("sess-zzz");
    expect(identityStore.get(conn)?.agentKey).toBe("zzz");
  });

  it("合法改名（alice-2）照常成功（对照：闸不误伤）", async () => {
    await anchorSession("sess-zzz");
    const conn = nextConn();
    await xcRegister(stateRoot, { name: "zzz", sessionId: "sess-zzz" }, conn, { peerRoot });

    const { result, payload } = await identify({ name: "alice-2", sessionId: "sess-zzz" }, conn);
    expect(result.isError).toBeFalsy();
    expect(payload.renamed).toMatchObject({ team: true });
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.key)).toEqual(["alice-2"]);
    expect(identityStore.get(conn)?.agentKey).toBe("alice-2");
  });

  it("注册路径（红队 sec2 重放）：全角 squatter 先到也拒，真人 alice 随后可注册", async () => {
    await anchorSession("sess-squatter");
    await anchorSession("sess-real");

    const squatterConn = nextConn();
    const { result, payload } = await identify(
      { name: "Ａｌｉｃｅ", sessionId: "sess-squatter" },
      squatterConn,
    );
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("invalid_name");
    // squatter 未入册、未绑定——随后真人注册不被锁死。
    expect(existsSync(join(stateRoot, "registry", "names.json"))).toBe(false);
    expect(identityStore.get(squatterConn)).toBeUndefined();

    const real = await xcRegister(stateRoot, { name: "alice", sessionId: "sess-real" }, nextConn(), { peerRoot });
    expect(real.sessionKey).toBe("xc:default:alice");
    expect((await readNames()).alice?.sessionId).toBe("sess-real");
  });
});

// ---------------------------------------------------------------------------
// v0.6.1 复验定位修复（验收员）：sid 归属闸是纯查询——不清扫死 peer 记录
//
// 根因（22-v061 验收发现，r3 regression-battery F8.*.reclaim-audited 由 PASS 转
// FAIL）：队内轴 sid 归属闸自建扫描时用了会惰性删除死记录的 scanPeers，把死前任的
// 记录文件提前删掉；紧随其后的 peer 花名 claim（claimPeerName 的单次共享扫描）再也
// 看不到前任，peer-name-reclaimed 接管留痕与 reclaimedFrom 一并丢失。
// 修复 = scanPeers 增加只读模式（sweep:false），纯查询路径一律用它。
// ---------------------------------------------------------------------------
describe("v0.6.1 复验定位修复：sid 归属闸查询无清扫副作用（接管留痕不回退）", () => {
  it("scanPeers({sweep:false}) 收死记录但不删文件；默认仍惰性清扫", async () => {
    const dead = await deadPid();
    await writePeerRecord(peerRoot, peerRecord(dead, "gone", "sess-gone"));
    const file = join(peerRoot, "sessions", `${dead}.json`);
    expect(existsSync(file)).toBe(true);

    const readOnly = await scanPeers(peerRoot, Date.now(), { sweep: false });
    expect(readOnly.dead.map((row) => row.record.name)).toContain("gone");
    expect(existsSync(file)).toBe(true); // 只读：文件还在，claim 路径仍看得到前任

    const sweeping = await scanPeers(peerRoot);
    expect(sweeping.dead.map((row) => row.record.name)).toContain("gone");
    expect(existsSync(file)).toBe(false); // 默认行为不变：惰性清扫
  });

  it("findLiveSessionIdHolder 是纯查询：问过之后死记录文件仍在（留痕不失明）", async () => {
    const dead = await deadPid();
    await writePeerRecord(peerRoot, peerRecord(dead, "foo", "sess-old"));
    const file = join(peerRoot, "sessions", `${dead}.json`);

    const holder = await findLiveSessionIdHolder(peerRoot, "sess-old");
    expect(holder).toBeUndefined(); // 死持有者不是活冲突
    expect(existsSync(file)).toBe(true); // 但证据未被查询抹掉

    // 活持有者照旧命中（闸的语义不变）。
    const live = await startSleeper();
    await writePeerRecord(peerRoot, peerRecord(live, "bar", "sess-live"));
    const liveHolder = await findLiveSessionIdHolder(peerRoot, "sess-live");
    expect(liveHolder?.pid).toBe(live);
  });

  it("死前任花名：队内轴注册（sid 闸查询）之后，peer claim 仍能拿到前任并留痕", async () => {
    // 直接复刻验收探针 reclaim-trail.mjs 的核心：先有一次「队内轴 sid 归属闸」的
    // 只读扫描，再走花名 claim——reclaimedFrom 必须仍然可见。
    const dead = await deadPid();
    await writePeerRecord(peerRoot, peerRecord(dead, "foo", "sess-old"));
    // ① 队内轴闸口查询（修复后为只读扫描）
    expect(await findLiveSessionIdHolder(peerRoot, "sess-new")).toBeUndefined();
    // ② 花名 claim 的单次扫描：死前任必须在 dead 集里（claimPeerName 据此留痕）
    const claimScan = await scanPeers(peerRoot);
    expect(claimScan.dead.map((row) => row.record.name)).toContain("foo");
    expect(claimScan.dead.find((row) => row.record.name === "foo")?.record.sessionId).toBe("sess-old");
  });
});
