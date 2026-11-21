/**
 * v0.9.4（A6）：MCP 连接身份**盘上自动采纳**定向测试（39-v094 方案 §二 A 表 +
 * 主会话 2026-11-21 裁决的四道护栏）。
 *
 * 机制：SessionStart 钩子把身份写进会话记录（boundName + pid，A1/A6①）；MCP server
 * 与钩子同父进程，`adoptHookBoundIdentity` 按 process.ppid 反查记录并把身份采纳进
 * 内存缓存——被唤醒成员的首回合只需 xc_claim（不再先 xc_identify）。
 *
 * 护栏判据（裁决原文）：
 * 1. 唯一性才采纳：恰一条 pid==process.ppid 命中 ∧ cwd==本 server 工作区 ∧
 *    boundName 非空；零条/多条 → 不采纳（not_registered 照旧）；
 * 2. 只增不改：已绑定连接绝不覆盖；采纳只写内存缓存，不写盘、不改 team.json；
 * 3. 不绕过既有闸：采纳不是注册（name_taken/session_id_in_use/takeover/removed 门
 *    在 xc_identify 路径原样生效；票据已由钩子一次性消费；不设 voiceOwner）；
 * 4. 盘读异常 → 不采纳。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { identityStore, adoptHookBoundIdentity } from "./identity.js";
import { writeSession } from "../core/registry.js";
import type { SessionRecord } from "../core/types.js";
import { notRegisteredError } from "./protocol.js";

const dirs: string[] = [];
let workspace: string;
let stateRoot: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "xc-a6-adopt-ws-"));
  stateRoot = join(workspace, ".crosschat");
  mkdirSync(join(stateRoot, "registry", "sessions"), { recursive: true });
  dirs.push(workspace);
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

/** 本测试进程的 ppid（= 真实宿主持有的pid 语义在测试里的对位：一个活进程）。 */
const HOST_PID = process.ppid;

async function seedRecord(record: Partial<SessionRecord> & { sessionId: string }): Promise<void> {
  await writeSession(stateRoot, {
    cwd: workspace,
    startedAt: 1,
    lastSeen: 1,
    ...record,
  } as SessionRecord);
}

/** 快照 stateRoot 下所有文件的内容（护栏 5：采纳不写盘的对拍基线）。 */
function snapshotStateRoot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(full, readFileSync(full, "utf8"));
    }
  };
  walk(stateRoot);
  return out;
}

describe("v0.9.4 A6：adoptHookBoundIdentity（四道护栏）", () => {
  it("【护栏1·锚点】唯一匹配（pid+cwd+boundName）→ 采纳成功，require 不再 not_registered", async () => {
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1", liveness: "running" });
    const adopted = adoptHookBoundIdentity(workspace);
    expect(adopted).toBeDefined();
    expect(adopted!.agentKey).toBe("m1");
    expect(adopted!.sessionId).toBe("sess_woken");
    expect(adopted!.teamId).toBe("default");
    // 采纳身份可被 require 直接用（成员首回合直接 claim 的前提）
    identityStore.bind("conn-a6", adopted!);
    expect(identityStore.require("conn-a6").agentKey).toBe("m1");
  });

  it("【护栏1】ppid 命中多条（一个宿主进程多个会话）→ 不采纳（歧义不猜）", async () => {
    await seedRecord({ sessionId: "sess_x", pid: HOST_PID, boundName: "m1" });
    await seedRecord({ sessionId: "sess_y", pid: HOST_PID, boundName: "m2" });
    expect(adoptHookBoundIdentity(workspace)).toBeUndefined();
  });

  it("【护栏1】cwd 不一致（记录属于别的工作区）→ 不采纳", async () => {
    await seedRecord({ sessionId: "sess_z", pid: HOST_PID, boundName: "m1", cwd: "D:\\elsewhere" });
    expect(adoptHookBoundIdentity(workspace)).toBeUndefined();
  });

  it("【护栏1】boundName 缺失/空 → 不采纳（未绑定身份的会话不冒名）", async () => {
    await seedRecord({ sessionId: "sess_n", pid: HOST_PID });
    expect(adoptHookBoundIdentity(workspace)).toBeUndefined();
    await seedRecord({ sessionId: "sess_b", pid: HOST_PID, boundName: "  " });
    expect(adoptHookBoundIdentity(workspace)).toBeUndefined();
  });

  it("【护栏2】已绑定连接绝不覆盖（只增不改）", async () => {
    identityStore.bind("conn-bound", {
      sessionKey: "xc:default:orig", teamId: "default", name: "orig", agentKey: "orig",
      sessionId: "sess_orig", role: "peer", boundAt: 1,
    });
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1" });
    const me = identityStore.require("conn-bound");
    expect(me.agentKey).toBe("orig"); // 原身份原样返回
    expect(identityStore.get("conn-bound")?.agentKey).toBe("orig");
    identityStore.unbind("conn-bound");
  });

  it("【护栏4】无 stateRoot（盘读不到）→ 不采纳，require 照旧 not_registered", () => {
    const empty = mkdtempSync(join(tmpdir(), "xc-a6-adopt-empty-"));
    dirs.push(empty);
    expect(adoptHookBoundIdentity(empty)).toBeUndefined();
    let caught: unknown;
    try {
      identityStore.require("conn-nobody");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(notRegisteredError().constructor);
  });

  it("【护栏5】采纳不写盘：stateRoot 内容逐字节不变（只写内存缓存）", async () => {
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1" });
    const before = snapshotStateRoot();
    const adopted = adoptHookBoundIdentity(workspace);
    expect(adopted).toBeDefined();
    identityStore.bind("conn-a6-writecheck", adopted!);
    const after = snapshotStateRoot();
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    identityStore.unbind("conn-a6-writecheck");
  });

  it("【护栏3】采纳身份不设 voiceOwner（uservoice 唤醒续跑证明只认 wakeToken 路径）", async () => {
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1" });
    const adopted = adoptHookBoundIdentity(workspace);
    expect(adopted!.voiceOwner).toBeUndefined();
    expect(identityStore.voiceOwnerForSession("sess_woken")).toBeUndefined();
  });

  it("缓存：采纳后删除盘上记录 → 连接仍持有身份（不再读盘、不改盘）", async () => {
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1" });
    const adopted = adoptHookBoundIdentity(workspace);
    expect(adopted).toBeDefined();
    identityStore.bind("conn-cache", adopted!);
    // 删掉盘上记录：已采纳的连接仍持有身份（缓存生效，且删除本身不是产品行为）
    rmSync(join(stateRoot, "registry", "sessions", "sess_woken.json"), { force: true });
    expect(identityStore.require("conn-cache")).toBe(adopted);
    identityStore.unbind("conn-cache");
  });

  it("require 的默认工作区口径（生产形态）：以 process.cwd() 解析 stateRoot；无匹配 → not_registered", () => {
    // 生产里 MCP server 的 cwd = ZCODE_PROJECT_DIR（plugin.json mcpServers.cwd），
    // 钩子写的记录 cwd = 同一工作区 → 默认口径命中。本测试只验「默认口径不抛、
    // 无匹配时照旧 not_registered」。
    let caught: unknown;
    try {
      identityStore.require("conn-default-cwd");
    } catch (error) {
      caught = error;
    }
    // 当前测试进程的 ppid 在 plugin/.crosschat 的存量记录里不可能有 pid 命中
    // （存量记录无 pid 字段）→ 不采纳 → not_registered。
    expect(caught).toBeDefined();
  });

  it("stat 口径：采纳前后 stateRoot 目录 mtime 不变（不新建/不删文件）", async () => {
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1" });
    const before = statSync(stateRoot).mtimeMs;
    adoptHookBoundIdentity(workspace);
    expect(statSync(stateRoot).mtimeMs).toBe(before);
  });
});
