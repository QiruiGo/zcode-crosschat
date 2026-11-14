/**
 * v0.5.3 红队三番战 A8（安全对-3）防回归单测：xc_peer_register 不校验 sessionId 归属。
 *
 * 攻击链（evidence/adversarial/adjudication/adj052/cases/a8-peersid.mjs 重放）：
 * (a) victim 是队内在册成员（基记录 boundName 在册），其 peer 连接不在线时，攻击者
 *     xc_peer_register{name:"fakeboss", sessionId: victim 真 sid} → 成功 → 向第三方
 *     发信，信封 from-session=victim 的 sid，且能被 xc_status 交叉「验证」；
 * (b) 全伪造 sid（无任何锚定记录）→ 直接成功。
 *
 * 根因：sessionId 是自述数据且可经 xc_status/xc_peers 交叉读到；v0.5.2 的
 * session_id_in_use 只挡「活 peer 记录冲突」，对队内成员 sid 与凭空 sid 完全不设防。
 * 修复（三道闸，按序）：
 * ① session_id_in_use（活 peer 持有者，v0.5.2 语义不变）；
 * ② session_not_anchored：基记录（peers/base/<sid>.json，钩子 SessionStart 写）缺失
 *    即拒——全伪造 sid 无锚定，进不来；
 * ③ identity_token_required：基记录 boundName 在册（该 sid 已被绑为队内身份，
 *    xc_register 盖章、跨工作区可见）时必须出示与基记录一致的锚定令牌。
 * 豁免：本进程幂等重认领自己的 sid（peer-1 语义）；基记录有 boundName 但无
 * v0.6 改判（DESIGN-V0.6.md §2.2 行 2）：regToken 归属硬闸砍除——已绑定 sid 的
 * peer 认领改为放行（软校验）；session_id_in_use（活冲突）/ session_not_anchored
 * （锚定存在性）两道闸保留。原「令牌不符 → identity_token_required」断言移除。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePeerBaseRecord, readPeerBaseRecord, localPidDomain } from "../core/peerdir.js";
import { writePeerRecord, type PeerRecord } from "../core/peerregistry.js";
import { writeSession } from "../core/registry.js";
import { xcRegister } from "./identity.js";
import { createDefaultPeerServices } from "./peer-services.js";
import { stopPeerEndpoint } from "../transport/pipe.js";
import { ToolError } from "./protocol.js";
import type { ToolDeps } from "./core.js";

let root = "";
let workDir = "";
let stateRoot = "";
let deps: ToolDeps;
let sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xc-a8-ownership-"));
  workDir = await mkdtemp(join(tmpdir(), "xc-a8-ws-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: root } as NodeJS.ProcessEnv };
});

afterEach(async () => {
  await stopPeerEndpoint();
  for (const child of sleepers) child.kill();
  sleepers = [];
  await rm(root, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

/** 起一个活着的子进程——它的 pid 用来当「另一个活会话」的 pid。 */
async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

function peerRecord(pid: number, name: string, sessionId: string): PeerRecord {
  return {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xcc-a8-${Math.random().toString(16).slice(2)}`,
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

/** 模拟 v0.5.3 SessionStart 钩子基记录（无 boundName = 未入队的普通会话）。 */
async function anchorBase(sid: string, extra: { regToken?: string; boundName?: string } = {}): Promise<void> {
  await writePeerBaseRecord(root, {
    sessionId: sid,
    cwd: workDir,
    source: "startup",
    startedAt: Date.now(),
    lastSeen: Date.now(),
    ...extra,
  });
}

describe("A8-(b)：全伪造 sid（无锚定）→ session_not_anchored", () => {
  it("pghost / sess_FAKE-REDTEAM-NOANCHOR 重放：无基记录即拒", async () => {
    const services = createDefaultPeerServices(deps);
    const error = await services
      .register({ name: "pghost", sessionId: "sess_FAKE-REDTEAM-NOANCHOR" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).payload).toMatchObject({
      error: "session_not_anchored",
      sessionId: "sess_FAKE-REDTEAM-NOANCHOR",
    });
    // 注册表无残留记录（伪造身份没有落盘）。
    const { scanPeers } = await import("../core/peerregistry.js");
    const scanned = await scanPeers(root);
    expect(scanned.active.filter((r) => r.name === "pghost")).toHaveLength(0);
  });

  it("被 hook 锚定过的 sid（普通会话）→ 放行（无 boundName 不索要令牌，兼容普通会话）", async () => {
    await anchorBase("sess-plain");
    const services = createDefaultPeerServices(deps);
    const result = await services.register({ name: "listener", sessionId: "sess-plain" });
    expect(result.sessionId).toBe("sess-plain");
    // 基记录在场但无档类 → 档类来源 unknown（与 v0.5.2 行为一致，fail-closed 不变）。
    expect(result.modeClassSource).toBe("unknown");
  });
});

describe("A8-(a)：v0.6 改判——队内成员 sid 的 peer 认领一律放行（regToken 闸砍除）", () => {
  it("基记录 boundName 在册 → 放行（旧版 identity_token_required 硬拒已砍）", async () => {
    await anchorBase("sess-victim", { regToken: "rt-victim", boundName: "victim" });
    const services = createDefaultPeerServices(deps);

    // v0.6（§2.2 行 2）：regToken 归属硬闸砍除——认领已绑定 sid 放行（软校验）。
    const result = await services.register({ name: "fakeboss", sessionId: "sess-victim" });
    expect(result.name).toBe("fakeboss");
    expect(result.sessionId).toBe("sess-victim");
    // 活冲突（session_id_in_use）仍由另一道闸挡——见下方 describe。
  });

  it("v0.6：token 参数不再参与判定（认领一律放行，正确与否无差别）", async () => {
    await anchorBase("sess-victim", { regToken: "rt-victim", boundName: "victim" });
    const services = createDefaultPeerServices(deps);

    // 旧版：rt-forged → identity_token_required；rt-victim → 成功。
    // v0.6：令牌不入 PeerRegisterInput——两次认领行为一致（先到者花名判定照旧）。
    const first = await services.register({ name: "fakeboss", sessionId: "sess-victim" });
    expect(first.sessionId).toBe("sess-victim");
    const legit = await services.register({ name: "vic-peer", sessionId: "sess-victim" });
    expect(legit.sessionId).toBe("sess-victim");
  });

  it("端到端：真实 xc_register 成功后基记录盖章，随后 peer 轴认领同 sid 被令牌闸拦住", async () => {
    // victim 会话：钩子锚定（workspace 会话记录 + 机器全局基记录）+ xc_register。
    await writeSession(stateRoot, {
      sessionId: "sess-vic",
      cwd: workDir,
      startedAt: Date.now(),
      lastSeen: Date.now(),
      regToken: "rt-vic",
    });
    await writePeerBaseRecord(root, {
      sessionId: "sess-vic",
      cwd: workDir,
      source: "startup",
      startedAt: Date.now(),
      lastSeen: Date.now(),
      regToken: "rt-vic",
    });
    const out = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, "conn-vic", { peerRoot: root });
    expect(out.via).toBe("hook");
    expect((await readPeerBaseRecord(root, "sess-vic"))?.boundName).toBe("victim");

    // v0.6 改判（a8 攻击链）：攻击者连接用公开可读的 victim sid 注册 peer →
    // 不再被 regToken 闸挡（放行）。活冲突/锚定两道闸仍见下方 describe。
    const attackerDeps: ToolDeps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: root } as NodeJS.ProcessEnv };
    const services = createDefaultPeerServices(attackerDeps);
    const result = await services.register({ name: "fakeboss", sessionId: "sess-vic" });
    expect(result.sessionId).toBe("sess-vic");
  });
});

describe("A8：闸序与豁免（v0.5.2 语义不回退）", () => {
  it("活 peer 持有者的 sid → 仍 session_id_in_use（第一道闸先行，错误码不变）", async () => {
    const pid = await startSleeper();
    await writePeerRecord(root, peerRecord(pid, "sx-recv", "sess_live_holder"));
    const services = createDefaultPeerServices(deps);
    const error = await services
      .register({ name: "sx-imp", sessionId: "sess_live_holder" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).payload.error).toBe("session_id_in_use");
  });

  it("本进程幂等重认领自己的 sid → 不被锚定/令牌闸误伤（peer-1 语义）", async () => {
    await anchorBase("sess-mine", { regToken: "rt-mine", boundName: "mine" });
    const services = createDefaultPeerServices(deps);
    // 首次注册（出示令牌，合法）。
    const first = await services.register({ name: "mine", sessionId: "sess-mine" });
    expect(first.pid).toBe(process.pid);
    // 重试/重连：即使不带令牌也放行（同进程同 sid 豁免）。
    const second = await services.register({ name: "mine", sessionId: "sess-mine" });
    expect(second.pid).toBe(process.pid);
  });

  it("v0.6：boundName 在册的 sid 认领一律放行（令牌闸砍除；旧锚差异不再存在）", async () => {
    await anchorBase("sess-legacy", { boundName: "legacy" }); // 无 regToken
    const services = createDefaultPeerServices(deps);
    const result = await services.register({ name: "legacy-peer", sessionId: "sess-legacy" });
    expect(result.sessionId).toBe("sess-legacy");

    // v0.6（§2.2 行 2）：令牌归属闸整块砍除——连「旧锚未验证」的过渡审计也不复
    // 存在（无闸即无留痕需求）；注册审计照常（peer-registered）。
    const { readFile } = await import("node:fs/promises");
    const { peerAuditLogFile } = await import("../core/peerdir.js");
    const log = await readFile(peerAuditLogFile(root), "utf8");
    expect(log).toContain("peer-registered");
    expect(log).not.toContain("peer-ownership-unverified");
    expect(log).not.toContain("peer-ownership-blocked");
  });
});
