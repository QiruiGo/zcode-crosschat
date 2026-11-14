/**
 * v0.6（DESIGN-V0.6.md §2.2 行 2）改判测试：regToken 身份锚定硬闸砍除。
 *
 * 原 v0.5.3 A6（安全对-1）攻击链重放（adj052 a6-impersonate.mjs）在 v0.6 的
 * 改判结论（条款 2a 台账「改编」类）：
 * - 旧断言 identity_token_required（无令牌重绑 → 硬拒）**已移除**——个人/内部
 *   场景威胁模型不成立，重绑降级为软校验；
 * - 保留的硬点（本文件新断言）：① (name, sid) 精确对重绑 → **幂等成功**
 *   （bug-02 语义：刷新 lastSeen/成员记录，不抛错）；② 新花名+他人 sid →
 *   session_already_bound 仍拒（bug-12 活性冲突语义）；③ 花名+他人 sid 的名字
 *   → name_taken 仍拒；④ wakeToken 路径不变（一次性 nonce 即属主凭据，服务端
 *   代写保留锚定令牌字段——仅作钩子延续用，不再构成闸）。
 * - 原「精确对重放（新连接、无令牌）→ identity_token_required」攻击步骤改判为
 *   「不再存在该闸」：重放方会拿到同一身份（bug-02 幂等），这是 v0.6 的显式
 *   取舍（README 威胁模型：同机冒充不做密码学防御）。
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

  it("v0.6 改判：精确对重放（新连接）→ 幂等成功（regToken 闸已砍；bug-02 语义）", async () => {
    await anchorLikeHook("sess-vic");
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });

    // 旧版：新连接无 regToken → identity_token_required 硬拒。
    // v0.6（§2.2 行 2）：闸已砍——精确对重绑幂等刷新（同 name+sid 的合法 --resume 重连）。
    const replay = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });
    expect(replay.via).toBe("hook");
    expect(replay.sessionKey).toBe("xc:default:victim");
    expect(replay.warnings).toEqual([]);
  });

  it("v0.6 改判：令牌错误的重绑同样幂等成功（regToken 参数不再被读取）", async () => {
    await anchorLikeHook("sess-vic", { regToken: "rt-true-token" });
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });

    // 旧版：regToken:"rt-forged" → identity_token_required。v0.6：参数不入 RegisterArgs，
    // 重绑幂等（令牌错误与否与身份绑定无关）。
    const replay = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });
    expect(replay.sessionKey).toBe("xc:default:victim");
  });

  it("精确对重绑（另一连接）→ 成功（--resume 新回合 / MCP 进程重启的合法重连）", async () => {
    await anchorLikeHook("sess-vic", { regToken: "rt-true-token" });
    const first = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });
    expect(first.via).toBe("hook");

    // 同一 (name, sid) 对、另一条连接（真实语义：会话重连后的新 MCP server 进程）。
    const second = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });
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

  it("旧锚（无 regToken 字段）→ 重绑放行且无令牌类告警（v0.6 无令牌闸可言）", async () => {
    await writeSession(stateRoot, {
      sessionId: "sess-old",
      cwd: workDir,
      startedAt: Date.now(),
      lastSeen: Date.now(),
      // 无 regToken：v0.5.3 之前的锚定记录（v0.6 起令牌字段不再参与任何校验）
    });
    await xcRegister(stateRoot, { name: "old", sessionId: "sess-old" }, nextConn(), { peerRoot });

    const out = await xcRegister(stateRoot, { name: "old", sessionId: "sess-old" }, nextConn(), { peerRoot });
    expect(out.via).toBe("hook");
    expect(out.warnings).toEqual([]);
  });

  it("wakeToken 路径重绑不需要令牌（一次性 nonce 即属主凭据），且代写保留锚定令牌字段", async () => {
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
    await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, victimConn, { peerRoot });

    // attacker（真实会话）种一封密信。
    const attackerConn = nextConn();
    await anchorLikeHook("sess-att", { regToken: "rt-att" });
    await xcRegister(stateRoot, { name: "attacker", sessionId: "sess-att" }, attackerConn, { peerRoot });
    const secret = createMessage("attacker", "victim", "REDTEAM-SECRET-COORDINATION-9f3a", {});
    await appendMailbox(stateRoot, "default", "victim", secret);

    // v0.6 改判（a6 攻击链）：精确对重放不再被拒——重放方拿到同一身份（bug-02 幂等）。
    // 这是显式取舍：个人/内部威胁模型下不做密码学防御（README 威胁模型声明）。
    const replay = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-vic" }, nextConn(), { peerRoot });
    expect(replay.sessionKey).toBe("xc:default:victim");

    // 重放连接此刻**是** victim 身份（同一 (name, sid) 对）——邮箱内容不变
    // （不丢：JSONL 追加真源；不串号：身份与任务板归属一致）。
    const box = await readMailbox(stateRoot, "default", "victim");
    expect(box.some((m) => m.id === secret.id)).toBe(true);
  });
});
