/**
 * v0.9.7（I1 / V096-15 修复）：xc_identify 成功后基记录盖章**合并写**定向回归。
 *
 * 缺陷（45-v096 验收 §6.3 V096-15，P2 mustFix；分类员原文：「xc_identify 盖章整文件
 * 重写基记录丢 pid（writePeerBaseRecord 实参不含 pid），抹掉钩子写入的 A1 宿主
 * pid——观测面失真 + 开启档采纳窗口期可用性回退」）：
 * identity.ts 的队内绑定盖章（boundName 标记）按字段白名单**整记录重建**
 * `peers/base/<sid>.json`——重建实参只列 sessionId/cwd/source/startedAt/lastSeen/
 * permissionMode/regToken/boundName，SessionStart 钩子 v0.9.4（A1）起写进基记录的
 * **宿主 pid 投影**（hooks/session-start.ts：与 workspace 侧 sessions/<sid>.json 同值
 * 同口径）不在其中 ⇒ identify 一成功，机器全局面的 pid 证据即被抹掉：
 * - 观测面失真：跨工作区读取方（红队/运维对账）看不到该会话的宿主 pid；
 * - 开启档可用性回退：采纳护栏 5 的基记录佐证面（identity.ts
 *   readPeerBaseSidsByHostPidSync）按 pid 归因宿主——pid 被抹后佐证缺席，
 *   XC_ADOPT_BY_PPID=1 窗口期内本会话连接的回落实例被拒（回落 2 次调用）。
 *
 * 修法（47-v097 方案 §一 组 I I1）：盖章改为**合并写**（读旧记录→更新字段→原子写）：
 * 以 readPeerBaseRecord 读到的旧记录为底稿，本次盖章字段（sessionId/cwd/source/
 * startedAt/lastSeen/regToken/boundName）以最新为准覆盖，pid 及其他既有字段原样
 * 保留。writePeerBaseRecord 本身即 tmp+rename 原子写（core/atomic.ts）。
 *
 * 验收（方案原文）：identify 前后 pid 不变（实测 pidBefore=pidAfter）；跨工作区 pid
 * 证据不断档。本文件逐条落成可执行断言。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptHookBoundIdentity, identityStore, xcRegister } from "./identity.js";
import { createWakeNonce, writeAdoptAnchor, writeSession } from "../core/registry.js";
import { peerBaseFile, readPeerBaseRecord, writePeerBaseRecord } from "../core/peerdir.js";
import type { SessionRecord } from "../core/types.js";

/** 宿主进程 pid：钩子写进基记录的 A1 pid 投影即取此值（与 process.ppid 对位）。 */
const HOST_PID = process.ppid;

let workDir = "";
let stateRoot = "";
let peerRoot = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-i1-v097-"));
  stateRoot = join(workDir, ".crosschat");
  // 机器全局 peer 根：基记录跨工作区共享（生产经 XC_MESSAGING_DIR 解析，测试逐用例隔离）。
  peerRoot = join(workDir, "peers-root");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

let connSeq = 0;
function nextConn(): string {
  connSeq += 1;
  return `conn-i1-${connSeq}`;
}

/** SessionStart 钩子产物形态：workspace 侧会话记录（含 pid/regToken/boundName）。 */
async function seedSessionRecord(sid: string, options: { cwd?: string; boundName?: string } = {}): Promise<void> {
  await writeSession(stateRoot, {
    sessionId: sid,
    cwd: options.cwd ?? workDir,
    startedAt: 1,
    lastSeen: 1,
    pid: HOST_PID,
    regToken: "rt-v097-i1",
    ...(options.boundName !== undefined ? { boundName: options.boundName } : {}),
  } as SessionRecord);
}

/** SessionStart 钩子产物形态：机器全局基记录（v0.9.4 A1 起含宿主 pid 投影）。 */
async function seedBaseRecord(
  sid: string,
  options: { cwd?: string; permissionMode?: "bypass" | "prompting"; pid?: number; boundName?: string } = {},
): Promise<void> {
  await writePeerBaseRecord(peerRoot, {
    sessionId: sid,
    cwd: options.cwd ?? workDir,
    source: "startup",
    startedAt: 1,
    lastSeen: 1,
    permissionMode: options.permissionMode ?? "bypass",
    regToken: "rt-v097-i1",
    ...(options.pid !== undefined ? { pid: options.pid } : { pid: HOST_PID }),
    ...(options.boundName !== undefined ? { boundName: options.boundName } : {}),
  });
}

/** 读盘上基记录的原始 JSON（不经 schema 过滤——用于核对未列举字段也在场）。 */
async function readRawBase(sid: string): Promise<Record<string, unknown>> {
  const raw = await readFile(peerBaseFile(peerRoot, sid), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("v0.9.7 I1（V096-15）：hook 路径 identify 前后 pid 不变（pidBefore=pidAfter）", () => {
  it("【修复主判据】钩子写了 pid 的基记录 → xc_identify 成功后 pid 原样保留（旧实现此处丢 pid）", async () => {
    await seedSessionRecord("sess-i1", { boundName: "m1" });
    await seedBaseRecord("sess-i1");

    const pidBefore = (await readPeerBaseRecord(peerRoot, "sess-i1"))?.pid;
    expect(pidBefore).toBe(HOST_PID); // 前提：钩子的 pid 投影确实在场

    const out = await xcRegister(stateRoot, { name: "m1", sessionId: "sess-i1" }, nextConn(), { peerRoot });
    expect(out.via).toBe("hook");

    const base = await readPeerBaseRecord(peerRoot, "sess-i1");
    expect(base?.pid).toBe(pidBefore); // 实测 pidBefore=pidAfter
    expect(base?.pid).toBe(HOST_PID);
  });

  it("盖章语义不减：boundName 盖上、regToken 同步、cwd/startedAt/lastSeen 不被动（功能不减）", async () => {
    await seedSessionRecord("sess-i1", { boundName: "m1" });
    await seedBaseRecord("sess-i1");

    await xcRegister(stateRoot, { name: "m1", sessionId: "sess-i1" }, nextConn(), { peerRoot });

    const base = await readPeerBaseRecord(peerRoot, "sess-i1");
    expect(base?.boundName).toBe("m1"); // 队内绑定标记照盖
    expect(base?.regToken).toBe("rt-v097-i1"); // 与 workspace 锚定记录同值
    expect(base?.cwd).toBe(workDir);
    expect(base?.startedAt).toBe(1); // 既有 startedAt 保留（不重置为 now）
    expect(base?.lastSeen).toBe(1); // 旧实现同样不刷新 lastSeen——行为逐字保留
    expect(base?.source).toBe("startup");
  });

  it("其他既有字段一并保留：permissionMode 与白名单外的未知字段都不被重建抹掉", async () => {
    await seedSessionRecord("sess-i1", { boundName: "m1" });
    await seedBaseRecord("sess-i1", { permissionMode: "prompting" });
    // 白名单外的字段（模拟未来扩展/外部佐证字段）——旧实现整记录重建会连它一起抹掉。
    await mkdir(join(peerRoot, "base"), { recursive: true });
    const seeded = await readRawBase("sess-i1");
    await writeFile(
      peerBaseFile(peerRoot, "sess-i1"),
      `${JSON.stringify({ ...seeded, futureEvidence: { hostAnchored: true } }, null, 2)}\n`,
      "utf8",
    );

    await xcRegister(stateRoot, { name: "m1", sessionId: "sess-i1" }, nextConn(), { peerRoot });

    const raw = await readRawBase("sess-i1");
    expect(raw["pid"]).toBe(HOST_PID);
    expect(raw["permissionMode"]).toBe("prompting");
    expect(raw["futureEvidence"]).toEqual({ hostAnchored: true }); // 未列举字段保留
    expect(raw["boundName"]).toBe("m1"); // 冲突字段以最新为准（盖章值覆盖）
  });

  it("冲突字段以最新为准：基记录里的陈旧 boundName 被本次注册名覆盖", async () => {
    await seedSessionRecord("sess-i1", { boundName: "m1" });
    await seedBaseRecord("sess-i1", { boundName: "stale-old-name" });

    await xcRegister(stateRoot, { name: "m1", sessionId: "sess-i1" }, nextConn(), { peerRoot });

    const base = await readPeerBaseRecord(peerRoot, "sess-i1");
    expect(base?.boundName).toBe("m1");
    expect(base?.pid).toBe(HOST_PID); // 覆盖绑定标记不牵连 pid
  });
});

describe("v0.9.7 I1（V096-15）：wake 路径同样合并写", () => {
  it("wakeToken 路径注册成功后 pid 不被盖章抹掉（同一盖章代码面）", async () => {
    await seedSessionRecord("sess-i1-wk");
    await seedBaseRecord("sess-i1-wk");
    const { token: wake } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "m", sid: "sess-i1-wk" });

    const pidBefore = (await readPeerBaseRecord(peerRoot, "sess-i1-wk"))?.pid;
    expect(pidBefore).toBe(HOST_PID);

    const out = await xcRegister(
      stateRoot,
      { name: "m", sessionId: "sess-i1-wk", wakeToken: wake },
      nextConn(),
      { peerRoot },
    );
    expect(out.via).toBe("wake");

    const base = await readPeerBaseRecord(peerRoot, "sess-i1-wk");
    expect(base?.pid).toBe(pidBefore);
    expect(base?.boundName).toBe("m");
  });
});

describe("v0.9.7 I1（V096-15）：跨工作区 pid 证据不断档", () => {
  it("identify 后机器全局基记录仍带宿主 pid——另一工作区的读取方照样看得到（对读不断档）", async () => {
    // 两个工作区共享同一台机器的 peer 根（基记录是机器全局面，跨工作区可见）。
    const wsB = await mkdtemp(join(tmpdir(), "xc-i1-v097-wsb-"));
    try {
      await seedSessionRecord("sess-xws", { boundName: "m1" });
      await seedBaseRecord("sess-xws");

      const pidBefore = (await readPeerBaseRecord(peerRoot, "sess-xws"))?.pid;
      expect(pidBefore).toBe(HOST_PID);

      await xcRegister(stateRoot, { name: "m1", sessionId: "sess-xws" }, nextConn(), { peerRoot });

      // 以「另一工作区」的身份读同一份机器全局基记录（wsB 不写任何东西，只对读）。
      const fromElsewhere = await readPeerBaseRecord(peerRoot, "sess-xws");
      expect(fromElsewhere?.pid).toBe(pidBefore);
      const raw = await readRawBase("sess-xws");
      expect(raw["pid"]).toBe(HOST_PID);
      expect(raw["cwd"]).toBe(workDir); // 锚定工作区不变
      expect(join(wsB, "unused")).toContain(wsB); // wsB 确为独立工作区（夹具自检）
    } finally {
      await rm(wsB, { recursive: true, force: true });
    }
  });

  it("开启档采纳佐证面：identify 之后护栏 5 的宿主 pid 佐证仍在 → 本会话连接照常采纳（旧实现被拒）", async () => {
    // V096-15 的行为面后果：pid 被抹后 readPeerBaseSidsByHostPidSync 佐证缺席 →
    // adoptHookBoundIdentity 拒（回落 2 次调用）。修复后佐证不断档。
    await seedSessionRecord("sess-adopt", { boundName: "m1" });
    await seedBaseRecord("sess-adopt");
    // 护栏 6：钩子把本 server 进程绑定到本会话（写侧拓扑：宿主 --resume 本 sid）。
    await writeAdoptAnchor(stateRoot, {
      sessionId: "sess-adopt",
      hostPid: HOST_PID,
      serverPid: process.pid,
      ts: Date.now(),
    });

    // 先 identify（旧实现在此抹掉基记录 pid），再走采纳面。
    await xcRegister(stateRoot, { name: "m1", sessionId: "sess-adopt" }, nextConn(), { peerRoot });
    const base = await readPeerBaseRecord(peerRoot, "sess-adopt");
    expect(base?.pid).toBe(HOST_PID);

    const adopted = adoptHookBoundIdentity(
      workDir,
      { XC_ADOPT_BY_PPID: "1", XC_MESSAGING_DIR: peerRoot },
      { hostResumeProbe: { available: true, resumeSid: "sess-adopt" } },
    );
    expect(adopted).toBeDefined();
    expect(adopted!.agentKey).toBe("m1");
    expect(adopted!.sessionId).toBe("sess-adopt");
  });
});

describe("v0.9.7 I1（V096-15）：基记录缺席时的补建行为不变（回归护栏）", () => {
  it("无基记录 → 按注册事实补建（无 pid 可保；不凭空铸造 pid）", async () => {
    await seedSessionRecord("sess-nobase", { boundName: "m1" });
    // 不写基记录：peerRoot/base 目录都不存在。
    await xcRegister(stateRoot, { name: "m1", sessionId: "sess-nobase" }, nextConn(), { peerRoot });

    const base = await readPeerBaseRecord(peerRoot, "sess-nobase");
    expect(base?.boundName).toBe("m1");
    expect(base?.regToken).toBe("rt-v097-i1");
    expect(base?.pid).toBeUndefined(); // 盘上无 pid 证据 ⇒ 不编造（与旧行为一致）
    expect(base?.cwd).toBe(process.cwd()); // 补建时 cwd 兜底进程工作区（与旧行为一致）
  });

  it("不给 peerRoot（旧装配/直调）→ 注册成功但无盖章（向后兼容不变）", async () => {
    await seedSessionRecord("sess-nopr", { boundName: "m1" });
    await seedBaseRecord("sess-nopr");
    const pidBefore = (await readPeerBaseRecord(peerRoot, "sess-nopr"))?.pid;

    await xcRegister(stateRoot, { name: "m1", sessionId: "sess-nopr" }, nextConn());

    const base = await readPeerBaseRecord(peerRoot, "sess-nopr");
    expect(base?.pid).toBe(pidBefore); // 无盖章 ⇒ 盘上记录原样不动
    expect(base?.boundName).toBeUndefined();
  });
});
