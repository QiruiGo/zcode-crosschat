/**
 * v0.9.1 r4（V090-04，P2）单测：wakeToken 消费路径**不得**自签 boundName。
 *
 * 裁决证据链（adv-2/adjudication-r3/r3-c3b-waketoken-selfstamp）复现的边界序列：
 *   ① 交互会话 xc_identify({takeover:true}) 接管已死引擎成员花名 m1
 *      （joinTeam 保留 identity:"engine"、只换 sid=sess_INT）；
 *   ② wake_enabled=true 期 lead dispatch → 无头 --resume 打向交互 sid，
 *      wake prompt 身份行显式携带 wakeToken；
 *   ③ 接管方用自己收到的 wakeToken 调 xc_identify → 旧实现把
 *      boundName="m1" 写进交互会话自己的 sessions 记录（自签）；
 *   ④ 用户把 config.json 改 {"wake_enabled":false}；
 *   ⑤ lead 再 dispatch → resolveWakeGate 对 engine 标行恒以 source=engine-member
 *      免开关放行（r3 的持有者校验被自签蒙混），无头唤醒继续打向交互会话，
 *      且不产生任何 takenOver/wake-skipped 披露 → bypassedUserDisable=true。
 *
 * 修法（第 4 轮规划指示）：wakeToken 消费路径写 boundName 加闸——r4 起该路径
 * **不再写 boundName**（mcp/identity.ts：只做「不依赖钩子落盘」的记录锚定，
 * 既有 boundName 经 spread 原样保留）。boundName 的唯一写入路径收敛为
 * member-add 供给代写（mcp/tools-team.ts Phase 3）——攻击者无法让引擎为自己的
 * 交互 sid 代写，自签链断裂。
 *
 * 本文件覆盖：自签被阻断（记录保持无 boundName、注册本身仍成功——文档化恢复
 * 流程不被破坏）、合法成员的 boundName 不被重写抹掉、记录缺失时不新建
 * boundName（fail-safe），以及链末端「用户显式关闭配置后豁免不成立」。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityStore, xcRegister } from "./identity.js";
import { createWakeNonce, readSession, writeSession } from "../core/registry.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { resolveWakeGate } from "../core/config.js";
import { writeFileSync } from "node:fs";
import type { TeamMember } from "../core/types.js";

let workDir = "";
let stateRoot = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-r4-selfstamp-"));
  stateRoot = join(workDir, ".crosschat");
});

afterEach(async () => {
  identityStore.bind("__discard__", { sessionKey: "x", teamId: "default", name: "ghost", agentKey: "ghost", sessionId: "sess-ghost", role: "peer", boundAt: 0 });
  await rm(workDir, { recursive: true, force: true });
});

let connSeq = 0;
function nextConn(): string {
  connSeq += 1;
  return `conn-${connSeq}`;
}

/** 引擎行被交互会话接管后的 roster 形态（identity 粘滞、sid 换成交际 sid）。 */
async function seedTakenOverEngineRow(key: string, sessionId: string): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "lead", now: 1 });
  const member: TeamMember = {
    key, sessionId, role: "worker", joinedAt: 1, lastSeen: 1,
    state: "ready", identity: "engine",
  };
  team.members.push(member);
  team.leadKey = "lead";
  await writeTeam(stateRoot, team);
}

/** SessionStart 钩子锚定产物（交互会话形态：无 boundName）。 */
async function anchorLikeInteractive(sid: string): Promise<void> {
  await writeSession(stateRoot, {
    sessionId: sid,
    cwd: workDir,
    startedAt: Date.now(),
    lastSeen: Date.now(),
    regToken: "rt-" + Math.random().toString(16).slice(2, 18),
  });
}

/** member-add 供给代写产物（引擎形态：带本名 boundName，tools-team.ts Phase 3）。 */
async function anchorLikeEngineProvision(key: string, sid: string): Promise<void> {
  await writeSession(stateRoot, {
    sessionId: sid,
    cwd: workDir,
    startedAt: Date.now(),
    lastSeen: Date.now(),
    boundName: key,
    regToken: "rt-" + Math.random().toString(16).slice(2, 18),
  });
}

function seedConfig(enabled: boolean): void {
  writeFileSync(join(stateRoot, "config.json"), JSON.stringify({ wake_enabled: enabled }), "utf8");
}

describe("V090-04：wakeToken 路径不自签 boundName（交互 takeover 后引擎行不被蒙混）", () => {
  it("攻击链：接管方用收到的 wakeToken 注册 → 成功但记录无 boundName；用户关闭配置后豁免不成立", async () => {
    // ① takeover 形态的 roster 行 + 交互会话的钩子锚定记录（无 boundName）
    await seedTakenOverEngineRow("m1", "sess_INT");
    await anchorLikeInteractive("sess_INT");
    // ② 唤醒期派单：引擎为该 (花名, 交互 sid) 签发 wakeToken（attemptWake 同款）
    const { token } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "m1", sid: "sess_INT" });

    // ③ 接管方以该 wakeToken 注册（文档化恢复流程本身不被破坏：via=wake 成功）
    const out = await xcRegister(stateRoot, { name: "m1", sessionId: "sess_INT", wakeToken: token }, nextConn());
    expect(out.via).toBe("wake");

    // 自签被阻断：交互会话自己的记录没有 boundName
    const record = await readSession(stateRoot, "sess_INT");
    expect(record?.boundName).toBeUndefined();
    // 锚定令牌仍被保留（代写的既有目的不受影响）
    expect(record?.regToken).toBeDefined();

    // ④+⑤ 用户把 config.json 显式关 → 分层闸不认 engine-member（无 boundName 佐证），
    // 回落 file 层并带 takenOver 披露——无头唤醒不再打向交互会话。
    seedConfig(false);
    const gate = resolveWakeGate(stateRoot, {}, {
      identity: "engine", key: "m1", sessionId: "sess_INT",
    });
    expect(gate).toEqual({ enabled: false, source: "file", takenOver: true });
  });

  it("记录缺失形态：wakeToken 路径只锚定记录，不新建 boundName（fail-safe，免开关不成立）", async () => {
    await seedTakenOverEngineRow("m2", "sess_INT2");
    // 不落会话记录：模拟钩子未锚定/记录被清——旧实现会连 boundName 一起补写
    const { token } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "m2", sid: "sess_INT2" });
    const out = await xcRegister(stateRoot, { name: "m2", sessionId: "sess_INT2", wakeToken: token }, nextConn());
    expect(out.via).toBe("wake");
    const record = await readSession(stateRoot, "sess_INT2");
    expect(record).toBeDefined(); // 锚定目的保持（§2.3-4 ②）
    expect(record?.boundName).toBeUndefined(); // 但不自签持有者判据
    seedConfig(false);
    expect(resolveWakeGate(stateRoot, {}, {
      identity: "engine", key: "m2", sessionId: "sess_INT2",
    })).toEqual({ enabled: false, source: "file", takenOver: true });
  });
});

describe("V090-04：合法引擎成员的 boundName 与豁免不受影响（member-add 链是唯一真源）", () => {
  it("wakeToken 重绑保留 member-add 代写的 boundName 与 regToken，engine-member 豁免保持", async () => {
    await seedTakenOverEngineRow("m3", "sess_ENG");
    await anchorLikeEngineProvision("m3", "sess_ENG"); // 供给链代写形状
    const { token } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "m3", sid: "sess_ENG" });

    const before = await readSession(stateRoot, "sess_ENG");
    const out = await xcRegister(stateRoot, { name: "m3", sessionId: "sess_ENG", wakeToken: token }, nextConn());
    expect(out.via).toBe("wake");

    const after = await readSession(stateRoot, "sess_ENG");
    expect(after?.boundName).toBe("m3"); // spread 原样保留，不被抹掉
    expect(after?.regToken).toBe(before?.regToken); // a6：代写不抹锚定令牌

    // 全局关（env + file 双关）下引擎成员仍免开关唤醒——G-4 不回退
    seedConfig(false);
    expect(resolveWakeGate(stateRoot, { XC_WAKE_ENABLED: "false" }, {
      identity: "engine", key: "m3", sessionId: "sess_ENG",
    })).toEqual({ enabled: true, source: "engine-member" });
  });
});
