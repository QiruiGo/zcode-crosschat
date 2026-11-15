/**
 * v0.7.1 防回归单测：xc_identify / 改名的**两轴原子性**（红队四番战 边界-4 / 边界-6 /
 * 并发与-1）。
 *
 * 复放依据（deepseek-crosschat/evidence/24-v071/_drv/g3-*.mjs，对 v0.7.0 基线实测）：
 * - 边界-4（g3-b4.mjs）：peer 轴 `name_taken`（另一活会话占着花名）→ 工具返回
 *   `peer_axis_failed`，但队内轴**已经落地**：names.json 已绑、roster 已入队、
 *   甚至当上 founderKey，`xc_overview` 的 me 就是新花名。调用方不能把错误当
 *   「无副作用」。
 * - 边界-6（g3-b6.mjs）：worker 板面有任务引用 → 队内改名被守卫阻止，peer 轴
 *   改名却照常生效，回执还是成功（`renamed:{peer:true,team:false}`）——同一会话
 *   两个身份（队内 tm-b / peer tm-b2），`xc_dispatch{to:"tm-b2"}` → not_a_member。
 * - 并发与-1（g3-con1.mjs）：6 进程同 name+sid 并发 identify → 5 个败者拿
 *   `session_id_in_use`，文案却写 "another live session … use your own id"，
 *   而冲突对象持有的是**同一个** sid（败者用的正是自己的 id）。
 *
 * 本文件锁死修复后的契约：
 * - peer 轴注册失败 → 队内轴**回滚**（names/roster/连接绑定全部撤销），错误信封
 *   如实写 `teamAxis.registered:false, rolledBack:true`；
 * - 队内改名被守卫阻止 → **两轴都不动**，显式 `team_rename_blocked` 错误（零副作用）；
 * - peer 轴改名失败 → 队内改名**回滚**，不留「队内新名 + peer 旧名」的半个改名；
 * - 同 sid 的 `session_id_in_use` 文案不再误述 "another live session"，payload 带
 *   `sameSessionId:true`；异 sid 保持原文案（那才是冒用场景）。
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPidDomain } from "../core/peerdir.js";
import { describeSessionIdConflict, writePeerRecord, type PeerRecord } from "../core/peerregistry.js";
import { writeSession } from "../core/registry.js";
import { readTeam } from "../core/teamstate.js";
import { handleIdentify } from "./tools-identify.js";
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
  workDir = await mkdtemp(join(tmpdir(), "xc-v071-atomic-"));
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
  return `conn-v071-${connSeq}`;
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

async function identify(
  args: { name: string; sessionId: string; role?: "peer" | "worker"; takeover?: boolean },
  connectionKey: string,
): Promise<{ result: ToolResult; payload: ToolPayload }> {
  const result = await handleIdentify(deps, args, connectionKey);
  return { result, payload: payloadOf(result) };
}

/** 活着的第三方 pid（peer 轴活记录用；本进程自己的记录豁免，故必须用别的进程）。 */
function peerRecord(pid: number, name: string, sessionId: string): PeerRecord {
  return {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xcc-v071-${Math.random().toString(16).slice(2)}`,
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

/** 假 peer 服务：register/rename 可指定为抛错，其余方法用真实默认实现的面包一层。 */
function fakePeerServices(overrides: {
  registerError?: ToolError;
  renameError?: ToolError;
  onRegister?: (input: { name: string; sessionId: string }) => void;
  onRename?: (name: string) => void;
}): PeerServices {
  const base = createDefaultPeerServices(deps);
  return {
    ...base,
    async register(input) {
      overrides.onRegister?.(input);
      if (overrides.registerError !== undefined) throw overrides.registerError;
      return {
        name: input.name,
        sessionId: input.sessionId,
        pid: process.pid,
        socketPath: "\\\\.\\pipe\\LOCAL\\xcc-v071-fake",
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

/** ToolError 的构造助手（与产品同源，避免在测试里手搓 payload 形状）。 */
async function toolError(error: string, message: string, extra: Record<string, unknown> = {}) {
  const { ToolError } = await import("./protocol.js");
  return new ToolError({ error, message, ...extra }, message);
}

// ---------------------------------------------------------------------------
// 边界-4（P3）：peer 轴失败 → 队内轴回滚，错误即无副作用
// ---------------------------------------------------------------------------

describe("边界-4：peer 轴注册失败时队内轴必须回滚（红队 g3-b4 复放）", () => {
  it("peer name_taken → peer_axis_failed，且 names.json / roster / 连接绑定全部撤销", async () => {
    await anchorSession("sess-v071-b4");
    setPeerServicesForTests(fakePeerServices({
      registerError: await toolError(
        "name_taken",
        'peer name "alice" is already registered on this machine',
      ),
    }));
    const conn = nextConn();
    const { result, payload } = await identify({ name: "alice", sessionId: "sess-v071-b4" }, conn);

    // 错误信封：peer 轴失败如实，队内轴「已回滚」也如实（不再虚报 registered:true）。
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("peer_axis_failed");
    expect(payload.peer).toMatchObject({ error: "name_taken" });
    expect(payload.teamAxis).toMatchObject({ registered: false, rolledBack: true });
    expect(result.content[0]?.text).toContain("rolled back");

    // 队内轴零残留：names.json 无该花名（修复前已绑）。
    expect(await readNames()).toEqual({});
    // roster 无该成员，且「本次注册建出来的队伍」连 team.json 一起撤（修复前已入队且是 founder）。
    expect(existsSync(join(stateRoot, "teams", "default", "team.json"))).toBe(false);
    // 连接绑定撤销：未注册连接的身份类工具入口必须拒。
    expect(() => identityStore.require(conn)).toThrow();
    // 审计留痕（可观测：回滚发生过）。
    const audit = await readFile(join(stateRoot, "logs", "engine.jsonl"), "utf8");
    expect(audit).toContain("register-rolled-back");
  });

  it("既有成员重注册时 peer 失败 → 只把本次 sid 刷新逆回，成员行不丢", async () => {
    // 先让别的连接把 alice 建成在册成员（队内轴已存在的行）。
    await anchorSession("sess-v071-b4-first");
    setPeerServicesForTests(fakePeerServices({}));
    const first = nextConn();
    const ok = await identify({ name: "alice", sessionId: "sess-v071-b4-first" }, first);
    expect(ok.result.isError).toBeFalsy();
    const before = await readTeam(stateRoot, "default");
    expect(before?.members.map((m) => m.key)).toEqual(["alice"]);

    // 同花名换 sid 重注册（本连接重绑），这次 peer 轴失败 → 回滚只能恢复原 sid，
    // 不能把别人的成员行删掉。
    await anchorSession("sess-v071-b4-second");
    setPeerServicesForTests(fakePeerServices({
      registerError: await toolError("name_taken", "peer name taken"),
    }));
    const second = nextConn();
    const failed = await identify({ name: "alice", sessionId: "sess-v071-b4-second" }, second);
    expect(failed.result.isError).toBe(true);
    const after = await readTeam(stateRoot, "default");
    expect(after?.members.map((m) => m.key)).toEqual(["alice"]);
    expect(after?.members[0]?.sessionId).toBe("sess-v071-b4-first");
    expect((await readNames())["alice"]?.sessionId).toBe("sess-v071-b4-first");
    // 第一个连接的绑定不受影响（回滚只解绑本次连接的绑定）。
    expect(identityStore.get(first)?.agentKey).toBe("alice");
  });

  it("回滚后重跑 identify 能成功（幂等修复：不再撞上自己刚建的状态）", async () => {
    await anchorSession("sess-v071-b4-retry");
    setPeerServicesForTests(fakePeerServices({
      registerError: await toolError("name_taken", "peer name taken"),
    }));
    const conn = nextConn();
    const failed = await identify({ name: "bob", sessionId: "sess-v071-b4-retry" }, conn);
    expect(failed.result.isError).toBe(true);
    // 失败后队内轴是干净的（names.json 无 bob、无 team.json）。
    expect(await readNames()).toEqual({});
    expect(existsSync(join(stateRoot, "teams", "default", "team.json"))).toBe(false);
    // 第二次（peer 轴放行）必须能从干净状态注册成功。
    setPeerServicesForTests(fakePeerServices({}));
    const retry = await identify({ name: "bob", sessionId: "sess-v071-b4-retry" }, conn);
    expect(retry.result.isError).toBeFalsy();
    expect((await readNames())["bob"]?.sessionId).toBe("sess-v071-b4-retry");
    expect((await readTeam(stateRoot, "default"))?.members.map((m) => m.key)).toEqual(["bob"]);
  });
});

// ---------------------------------------------------------------------------
// 边界-6（P3）：改名两轴原子
// ---------------------------------------------------------------------------

describe("边界-6：改名两轴原子（红队 g3-b6 复放）", () => {
  it("队内板面不干净 → team_rename_blocked，peer 轴**不改名**（两轴都不动）", async () => {
    await anchorSession("sess-v071-b6-lead");
    await anchorSession("sess-v071-b6-wk");
    setPeerServicesForTests(fakePeerServices({}));
    const leadConn = nextConn();
    const conn = nextConn();
    await identify({ name: "boss", sessionId: "sess-v071-b6-lead" }, leadConn);
    await identify({ name: "tm-b", sessionId: "sess-v071-b6-wk" }, conn);
    // 制造队内引用：lead 给 tm-b 派一单（createdBy=boss / assignee=tm-b 都在板上）。
    const { createToolCore } = await import("./core.js");
    const core = createToolCore(deps);
    const dispatched = await core.xc_dispatch(
      { to: "tm-b", title: "t", prompt: "p", acceptance: "a" } as never,
      leadConn,
    );
    expect(dispatched.isError).toBeFalsy();
    const taskId = String(payloadOf(dispatched)["taskId"]);
    expect(taskId.length).toBeGreaterThan(0);

    let renameCalls = 0;
    setPeerServicesForTests(fakePeerServices({
      onRename: () => { renameCalls += 1; },
    }));
    setPeerSessionContext({ sessionId: "sess-v071-b6-wk", name: "tm-b", pid: process.pid, root: peerRoot });

    const { result, payload } = await identify({ name: "tm-b2", sessionId: "sess-v071-b6-wk" }, conn);
    // 显式错误（修复前是成功回执 + renamed:{peer:true,team:false}）。
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("team_rename_blocked");
    expect(payload.renamed).toEqual({ peer: false, team: false });
    expect(result.content[0]?.text).toContain("BOTH axes");
    // peer 轴改名根本没被调用（修复前照常改名 → 双身份）。
    expect(renameCalls).toBe(0);
    // 队内轴仍是旧名、旧键。
    expect(identityStore.get(conn)?.agentKey).toBe("tm-b");
    expect((await readTeam(stateRoot, "default"))?.members.map((m) => m.key)).toEqual(["boss", "tm-b"]);
  });

  it("板面干净 → 两轴都改名（合法流程不被破坏）", async () => {
    await anchorSession("sess-v071-b6-ok");
    setPeerServicesForTests(fakePeerServices({}));
    const conn = nextConn();
    await identify({ name: "wk", sessionId: "sess-v071-b6-ok" }, conn);
    setPeerSessionContext({ sessionId: "sess-v071-b6-ok", name: "wk", pid: process.pid, root: peerRoot });
    const { result, payload } = await identify({ name: "wk2", sessionId: "sess-v071-b6-ok" }, conn);
    expect(result.isError).toBeFalsy();
    expect(payload.renamed).toEqual({ peer: true, team: true });
    expect(identityStore.get(conn)?.agentKey).toBe("wk2");
    expect((await readTeam(stateRoot, "default"))?.members.map((m) => m.key)).toEqual(["wk2"]);
  });

  it("peer 轴改名失败（name_taken）→ 队内改名回滚，不留「队内新名 + peer 旧名」", async () => {
    await anchorSession("sess-v071-b6-peerfail");
    setPeerServicesForTests(fakePeerServices({}));
    const conn = nextConn();
    await identify({ name: "solo", sessionId: "sess-v071-b6-peerfail" }, conn);
    setPeerSessionContext({ sessionId: "sess-v071-b6-peerfail", name: "solo", pid: process.pid, root: peerRoot });
    setPeerServicesForTests(fakePeerServices({
      renameError: await toolError("name_taken", 'peer name "taken" is already registered on this machine'),
    }));

    const { result, payload } = await identify({ name: "solo2", sessionId: "sess-v071-b6-peerfail" }, conn);
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("peer_axis_failed");
    expect(payload.peer).toMatchObject({ error: "name_taken" });
    // 队内轴被逆回原名：连接身份、roster 键、names.json 全是旧名（一个身份）。
    expect(payload.teamAxis).toMatchObject({ registered: false, rolledBack: true });
    expect(identityStore.get(conn)?.agentKey).toBe("solo");
    expect((await readTeam(stateRoot, "default"))?.members.map((m) => m.key)).toEqual(["solo"]);
    expect((await readNames())["solo"]?.sessionId).toBe("sess-v071-b6-peerfail");
    const audit = await readFile(join(stateRoot, "logs", "engine.jsonl"), "utf8");
    expect(audit).toContain("register-rename-rolled-back");
  });
});

// ---------------------------------------------------------------------------
// 并发与-1（P3）：同 sid 冲突的文案与载荷
// ---------------------------------------------------------------------------

describe("并发与-1：同 sid 的 session_id_in_use 文案（红队 g3-con1 复放）", () => {
  it("同 name+sid 并发败者：sameSessionId=true，文案不再说 another live session", async () => {
    // 另一个活进程持有**同一个** sid（同花名）——并发重复拉起的形状。
    const holder = peerRecord(process.pid === 1 ? 2 : 1, "rebinder", "sess-v071-con1");
    const conflict = describeSessionIdConflict(holder, "sess-v071-con1");
    expect(conflict.payload.sameSessionId).toBe(true);
    expect(conflict.payload.error).toBe("session_id_in_use");
    expect(conflict.payload.sessionId).toBe("sess-v071-con1");
    expect(conflict.payload.message).not.toContain("another live session");
    expect(conflict.payload.message).toContain("SAME sessionId");
    expect(conflict.payload.message).toContain("duplicate process");
    expect(conflict.text).not.toContain("another live session");
  });

  it("异 sid 冲突：sameSessionId=false，保留 v0.5.2 起的冒用文案与恢复动作", async () => {
    const holder = peerRecord(4242, "victim", "sess-victim");
    const conflict = describeSessionIdConflict(holder, "sess-rogue");
    expect(conflict.payload.sameSessionId).toBe(false);
    expect(conflict.payload.message).toContain("another live session");
    expect(conflict.payload.message).toContain("this session's own");
    expect(conflict.text).toContain("another live session");
  });

  it("队内轴 sid 闸用同一道文案（6 进程并发 identify 的败者形状）", async () => {
    // 另一个活进程持有本 sid（同花名）→ 队内轴在**任何状态变更之前**拒，
    // 且文案说清「同一个 sid 被重复认领」，不是「你用错 id 了」。
    await anchorSession("sess-v071-con1");
    const { spawn } = await import("node:child_process");
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => sleeper.once("spawn", () => resolve()));
    try {
      await writePeerRecord(peerRoot, peerRecord(sleeper.pid!, "rebinder", "sess-v071-con1"));
      setPeerServicesForTests(fakePeerServices({}));
      const { result, payload } = await identify({ name: "rebinder", sessionId: "sess-v071-con1" }, nextConn());
      expect(result.isError).toBe(true);
      expect(payload.error).toBe("session_id_in_use");
      expect(payload.sameSessionId).toBe(true);
      expect(String(payload.message)).not.toContain("another live session");
      // 零副作用：败者没有在花名册/ roster 上留下任何东西。
      expect(await readNames()).toEqual({});
      expect(existsSync(join(stateRoot, "teams", "default", "team.json"))).toBe(false);
    } finally {
      sleeper.kill();
    }
  });
});
