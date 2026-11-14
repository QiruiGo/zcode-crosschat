/**
 * v0.5.3 红队三番战 A6（安全对-1）防回归单测：(name, sessionId) 精确对重放冒充。
 *
 * 攻击链（evidence/adversarial/adjudication/adj052/cases/a6-impersonate.mjs 重放）：
 * 1. 免注册连接 xc_status 读到 victim ↔ sid 精确对；
 * 2. 新连接 xc_register{name:"victim", sessionId: victim 的真 sid} → 命中「已绑定
 *    精确对」的幂等重绑路径 → 成功绑定 victim 身份；
 * 3. 冒充者 xc_check_inbox 偷消费 victim 邮箱、xc_lead_transfer 移走 lead，
 *    victim 零告警。
 *
 * 根因：(name, sid) 对可经 xc_status 公开读到，本身不是凭据；重绑路径无属主证明。
 * 修复：SessionStart 钩子铸造锚定令牌 regToken（只注入本会话上下文 + 落锚定记录），
 * 重绑已绑定 (name, sid) 对必须出示与锚定记录一致的 regToken（identity_token_required）。
 * 豁免：同连接幂等重试（peer-1 语义）/ wakeToken 路径（一次性 nonce 即属主凭据）/
 * 升级前旧锚（无 regToken，放行 + 告警披露，不静默）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityStore, xcRegister } from "./identity.js";
import { createWakeNonce, readSession, writeSession } from "../core/registry.js";
import { readPeerBaseRecord, writePeerBaseRecord } from "../core/peerdir.js";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import type { ToolError } from "./protocol.js";

let workDir = "";
let stateRoot = "";
let peerRoot = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-a6-regtoken-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peers-root");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 取 ToolError 的结构化负载（xcRegister 校验失败以 throw 传播）。 */
async function errorPayload(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (err) {
    return (err as ToolError).payload;
  }
  throw new Error("expected the call to reject with ToolError");
}

let connSeq = 0;
function nextConn(): string {
  connSeq += 1;
  return `conn-${connSeq}`;
}

/** 模拟 v0.5.3 SessionStart 钩子的锚定产物：workspace 会话记录 + 机器全局基记录。 */
async function anchorLikeHook(sid: string, options: { regToken?: string; cwd?: string } = {}): Promise<string> {
  const regToken = options.regToken ?? "rt-" + Math.random().toString(16).slice(2, 18);
  await writeSession(stateRoot, {
    sessionId: sid,
    cwd: options.cwd ?? workDir,
    startedAt: Date.now(),
    lastSeen: Date.now(),
    regToken,
  });
  await writePeerBaseRecord(peerRoot, {
    sessionId: sid,
    cwd: options.cwd ?? workDir,
    source: "startup",
    startedAt: Date.now(),
    lastSeen: Date.now(),
    regToken,
  });
  return regToken;
}

describe("A6：xc_register 精确对重放属主校验", () => {
  it("新对注册（未绑定的 (name, sid)）不需要令牌——正常路径零改动", async () => {
    const token = await anchorLikeHook("sess-vic");
    const out = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });
    expect(out.via).toBe("hook");
    expect(out.warnings).toEqual([]);
    expect(token).toMatch(/^rt-/);
  });

  it("精确对重放（新连接、无令牌）→ identity_token_required（a6 攻击重放，闸生效）", async () => {
    await anchorLikeHook("sess-vic");
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });

    // 攻击者：新连接出示公开可读的精确对（xc_status 读者），无 regToken。
    const payload = await errorPayload(() =>
      xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot }),
    );
    expect(payload.error).toBe("identity_token_required");
    expect(payload.name).toBe("victim");
    expect(payload.sessionId).toBe("sess-vic");
  });

  it("精确对重放（令牌错误）→ identity_token_required", async () => {
    await anchorLikeHook("sess-vic", { regToken: "rt-true-token" });
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic", regToken: "rt-true-token" }, nextConn(), { peerRoot });

    const payload = await errorPayload(() =>
      xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic", regToken: "rt-forged" }, nextConn(), { peerRoot }),
    );
    expect(payload.error).toBe("identity_token_required");
  });

  it("精确对重绑（令牌正确）→ 成功（--resume 新回合 / MCP 进程重启的合法重连）", async () => {
    await anchorLikeHook("sess-vic", { regToken: "rt-true-token" });
    const first = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic", regToken: "rt-true-token" }, nextConn(), { peerRoot });
    expect(first.via).toBe("hook");

    // 同一 (name, sid) 对、另一条连接（真实语义：会话重连后的新 MCP server 进程）。
    const second = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic", regToken: "rt-true-token" }, nextConn(), { peerRoot });
    expect(second.via).toBe("hook");
    expect(second.sessionKey).toBe("xc:default:victim");
  });

  it("同一连接的幂等重试不需要令牌（agent 重试语义，peer-1 同族豁免）", async () => {
    await anchorLikeHook("sess-vic");
    const conn = nextConn();
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, conn, { peerRoot });
    const retry = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, conn, { peerRoot });
    expect(retry.via).toBe("hook");
  });

  it("升级前旧锚（无 regToken）→ 重绑放行但告警披露（不静默）", async () => {
    await writeSession(stateRoot, {
      sessionId: "sess-old",
      cwd: workDir,
      startedAt: Date.now(),
      lastSeen: Date.now(),
      // 无 regToken：v0.5.3 之前的锚定记录
    });
    await xcRegister(stateRoot, { name: "old", sessionId: "sess-old" }, nextConn(), { peerRoot });

    const out = await xcRegister(stateRoot, { name: "old", sessionId: "sess-old" }, nextConn(), { peerRoot });
    expect(out.via).toBe("hook");
    expect(out.warnings.some((w) => w.includes("regToken"))).toBe(true);
  });

  it("wakeToken 路径重绑不需要 regToken（一次性 nonce 即属主凭据），且代写保留锚定令牌", async () => {
    const token = await anchorLikeHook("sess-w");
    // 先以 wake 路径注册（无头回合）。
    const { token: wake } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "m", sid: "sess-w" });
    const out = await xcRegister(stateRoot, { name: "m", sessionId: "sess-w", wakeToken: wake }, nextConn(), { peerRoot });
    expect(out.via).toBe("wake");

    // 服务端代写没有抹掉钩子写的锚定令牌。
    const record = await readSession(stateRoot, "sess-w");
    expect(record?.regToken).toBe(token);

    // 后续 wake 重绑（新 nonce）依旧不索要 regToken。
    const { token: wake2 } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "m", sid: "sess-w" });
    const out2 = await xcRegister(stateRoot, { name: "m", sessionId: "sess-w", wakeToken: wake2 }, nextConn(), { peerRoot });
    expect(out2.via).toBe("wake");
  });

  it("既有闸不变：新花名+他人 sid → session_already_bound；花名+他人 sid 的名字 → name_taken（先于令牌闸）", async () => {
    await anchorLikeHook("sess-a");
    await anchorLikeHook("sess-b");
    await xcRegister(stateRoot, { name: "a", sessionId: "sess-a" }, nextConn(), { peerRoot });

    const sidTaken = await errorPayload(() =>
      xcRegister(stateRoot, { name: "b", sessionId: "sess-a" }, nextConn(), { peerRoot }),
    );
    expect(sidTaken.error).toBe("session_already_bound");

    const nameTaken = await errorPayload(() =>
      xcRegister(stateRoot, { name: "a", sessionId: "sess-b" }, nextConn(), { peerRoot }),
    );
    expect(nameTaken.error).toBe("name_taken");
  });
});

describe("A6：注册成功后的 boundName 盖章（a8 的 peer 轴联动）", () => {
  it("注册成功 → 基记录盖上 boundName，regToken 与 workspace 锚定记录同值", async () => {
    const token = await anchorLikeHook("sess-vic");
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });

    const base = await readPeerBaseRecord(peerRoot, "sess-vic");
    expect(base?.boundName).toBe("victim");
    expect(base?.regToken).toBe(token);
  });

  it("不给 peerRoot（旧装配/直调）→ 注册成功但无盖章（向后兼容）", async () => {
    await anchorLikeHook("sess-vic");
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn());
    const base = await readPeerBaseRecord(peerRoot, "sess-vic");
    expect(base?.boundName).toBeUndefined();
  });

  it("基记录缺失时按注册事实补建（cwd/startedAt 落盘，令牌同步）", async () => {
    const token = await anchorLikeHook("sess-vic");
    // 删掉基记录，模拟「钩子基记录先行丢失」的供给形态。
    await writePeerBaseRecord(peerRoot, {
      sessionId: "sess-vic",
      cwd: workDir,
      source: "startup",
      startedAt: 1,
      lastSeen: 1,
      regToken: token,
    });
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });
    const base = await readPeerBaseRecord(peerRoot, "sess-vic");
    expect(base?.boundName).toBe("victim");
    expect(base?.regToken).toBe(token);
    expect(base?.startedAt).toBe(1); // 既有记录字段保留
  });
});

describe("A6：完整攻击链重放（偷邮箱在闸前失效）", () => {
  it("冒充者注册被拒后，victim 邮箱原封不动（对照 adj052 a6-impersonate.jsonl 的 containsSecret=true）", async () => {
    const token = await anchorLikeHook("sess-vic");
    const victimConn = nextConn();
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic", regToken: token }, victimConn, { peerRoot });

    // attacker（真实会话）种一封密信。
    const attackerConn = nextConn();
    await anchorLikeHook("sess-att", { regToken: "rt-att" });
    await xcRegister(stateRoot, { name: "attacker", sessionId: "sess-att", regToken: "rt-att" }, attackerConn, { peerRoot });
    const secret = createMessage("attacker", "victim", "REDTEAM-SECRET-COORDINATION-9f3a", {});
    await appendMailbox(stateRoot, "default", "victim", secret);

    // 攻击者新连接精确对重放 → 拒。
    const payload = await errorPayload(() =>
      xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot }),
    );
    expect(payload.error).toBe("identity_token_required");

    // 冒充连接未获得身份：require 抛 not_registered，邮箱读不到。
    const impostorConn = nextConn();
    try {
      identityStore.require(impostorConn);
      throw new Error("expected require to throw");
    } catch (err) {
      expect((err as ToolError).payload.error).toBe("not_registered");
    }

    // victim 的邮箱还在：密信未被消费。
    const box = await readMailbox(stateRoot, "default", "victim");
    expect(box.some((m) => m.id === secret.id && m.readAt === undefined)).toBe(true);
  });
});
