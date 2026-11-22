/**
 * v0.9.6（A1/V095-01）：开启档身份采纳**串号缺陷修复**定向回归（44-v096 方案 §一 组A）。
 *
 * 缺陷（41-v095 对抗一 C3/C8 实测，V095-01 P2）：`XC_ADOPT_BY_PPID=1` 下——
 * - C3.b：同宿主兄弟会话记录损坏（corrupt JSON）被 readSessionByHostPidSync 静默跳过
 *   → 「恰一条可解析命中」的歧义闸被旁路 → 未注册连接采纳他人身份；
 * - C3.c/3d：本会话记录缺失（V094-02 锁预算失败形态）→ 同宿主他人记录成唯一命中 →
 *   采纳 → rogue 读他人邮箱、领走受害人任务、冒名 completed。
 *
 * 修法（44-v096 方案 A1）：
 * ① **采纳歧义面把「不可解析记录」计入**——workspace 侧 readSessionByHostPidSync 与
 *    peer 基记录扫描两侧：损坏条目 >0 → 一律不采纳（损坏记录不得让歧义闸失效）；
 * ② **要求本连接自己的会话记录在场**——SessionStart 钩子每回合无锁必写的机器全局基
 *    记录（peers/base/<sid>.json，含宿主 pid + cwd）作为「本宿主进程在本工作区锚定了
 *    哪些会话」的独立事实源：佐证必须恰一条且等于 pid 命中记录的 sid；无佐证/多会话/
 *    不一致 → 不采纳，回退 wakeToken 票据兜底（2 次调用）；
 * ③ 唯一干净匹配 + cwd + token 才采纳（v0.9.5 判据原样保留）。
 *
 * 硬回归（方案验收原文）：默认档不采纳（宁可 2 次调用）；多记录不采纳；本连接记录
 * 在场且唯一 → 采纳；串号用例不再复现。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADOPT_ANCHOR_MAX_CLOCK_SKEW_MS,
  ADOPT_ANCHOR_MAX_PREBIRTH_MS,
  adoptByPpidEnabledFromEnv,
  probeHostResumeSidSync,
  readAdoptAnchorSync,
  readSessionByHostPid,
  readSessionByHostPidSync,
  writeAdoptAnchor,
} from "../core/registry.js";
import { writeSession } from "../core/registry.js";
import { writePeerBaseRecord } from "../core/peerdir.js";
import { adoptHookBoundIdentity, identityStore } from "./identity.js";
import type { SessionRecord } from "../core/types.js";
import { notRegisteredError } from "./protocol.js";

const dirs: string[] = [];
let workspace: string;
let stateRoot: string;
let sessionsDirPath: string;
let peerRoot: string;
const HOST_PID = process.ppid; // 与 adoptHookBoundIdentity 读取的 process.ppid 对位

beforeEach(() => {
  delete process.env["XC_ADOPT_BY_PPID"]; // 默认档起点（每个用例自管开关）
  workspace = mkdtempSync(join(tmpdir(), "xc-a1-v096-ws-"));
  stateRoot = join(workspace, ".crosschat");
  sessionsDirPath = join(stateRoot, "registry", "sessions");
  mkdirSync(sessionsDirPath, { recursive: true });
  // 采纳护栏 5（基记录佐证）按 XC_MESSAGING_DIR 读机器全局基记录——逐用例隔离，
  // 避免读到本机真实基记录（非确定性）；require() 生产路径也读进程 env。
  peerRoot = join(workspace, "peer-root");
  process.env["XC_MESSAGING_DIR"] = peerRoot;
  dirs.push(workspace);
});

afterEach(() => {
  identityStore.unbind("conn-v096");
  delete process.env["XC_ADOPT_BY_PPID"];
  delete process.env["XC_MESSAGING_DIR"];
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

/** 写 workspace 侧会话记录（默认按 SessionStart 钩子铸造形态给 pid/cwd/regToken）。 */
async function seedSession(record: Partial<SessionRecord> & { sessionId: string }): Promise<void> {
  await writeSession(stateRoot, {
    cwd: workspace,
    startedAt: 1,
    lastSeen: 1,
    pid: HOST_PID,
    regToken: "rt-v096-a1",
    ...record,
  } as SessionRecord);
}

/** 写 peer 基记录（SessionStart 钩子产出形态：sessionId/cwd/pid 与 workspace 侧同值；
 * legacy=true 时省略 pid——v0.9.4 以前存量基记录形态）。 */
async function seedBase(record: {
  sessionId: string;
  pid?: number;
  cwd?: string;
  boundName?: string;
  regToken?: string;
  legacy?: boolean;
}): Promise<void> {
  await writePeerBaseRecord(peerRoot, {
    sessionId: record.sessionId,
    cwd: record.cwd ?? workspace,
    source: null,
    startedAt: 1,
    lastSeen: 1,
    ...(record.regToken !== undefined ? { regToken: record.regToken } : {}),
    ...(record.legacy ? {} : { pid: record.pid ?? HOST_PID }),
    ...(record.boundName !== undefined ? { boundName: record.boundName } : {}),
  });
}

/** 写会话↔server 进程绑定锚（护栏 6 数据源；测试进程 pid 充当 server pid 对位）。 */
async function seedAnchor(record: { sessionId: string; hostPid?: number; serverPid?: number; ts?: number }): Promise<void> {
  await writeAdoptAnchor(stateRoot, {
    sessionId: record.sessionId,
    hostPid: record.hostPid ?? HOST_PID,
    serverPid: record.serverPid ?? process.pid,
    ts: record.ts ?? Date.now(),
  });
}

/** 删除本进程 pid 的绑定锚（模拟钩子未写锚/零痕迹连接形态）。 */
function removeSelfAnchor(): void {
  rmSync(join(stateRoot, "registry", "adopt-anchor", `${process.pid}.json`), { force: true });
}

/** 本 server 进程的诞生时刻（与 adoptHookBoundIdentity 护栏 6 的算式同源）。 */
function selfBirthMs(): number {
  return Date.now() - process.uptime() * 1000;
}

/**
 * 护栏 6b 的宿主探测注入（r3，V096-21）：测试进程的 ppid cmdline 没有 --resume——
 * 真实 CIM 探测必然 fail-closed 拒绝，正例注入「宿主是本会话唤醒子」的对位事实；
 * 生产走真实探测（probeHostResumeSidSync）。
 */
function probeFor(sid: string): { available: boolean; resumeSid?: string } {
  return { available: true, resumeSid: sid };
}

/** 开启档 env（开关 + 隔离 peerRoot 一起注入，adoption 面的显式 env 口径）。 */
function enabledEnv(): NodeJS.ProcessEnv {
  return { XC_ADOPT_BY_PPID: "1", XC_MESSAGING_DIR: peerRoot };
}

/** 写一个损坏的会话记录文件（对抗一 C3.b 的同款损坏形态）。 */
function corruptSessionFile(sessionId: string): void {
  writeFileSync(join(sessionsDirPath, `${sessionId}.json`), "corrupt{{{not-json", "utf8");
}

describe("v0.9.6 A1：默认档口径不变（宁可 2 次调用）", () => {
  it("【硬回归·默认档】完美记录 + 完美基记录佐证也不采纳 → require 抛 not_registered；开启后同盘面才采纳", async () => {
    await seedSession({ sessionId: "sess_woken", boundName: "m1" });
    await seedBase({ sessionId: "sess_woken", boundName: "m1", regToken: "rt-v096-a1" });
    // 默认档：采纳面（env 参数未带开关）
    expect(adoptHookBoundIdentity(workspace)).toBeUndefined();
    // 默认档：连接面（require 读进程 env；本用例未设 XC_ADOPT_BY_PPID）
    expect(() => identityStore.require("conn-v096")).toThrow(notRegisteredError().message);
    // 对照：同一盘面，只差开关 → 采纳（拒绝确实只因开关，不是盘面问题）
    await seedAnchor({ sessionId: "sess_woken" }); // r2：开启档采纳还要求绑定锚在场
    const adopted = adoptHookBoundIdentity(workspace, enabledEnv(), { hostResumeProbe: probeFor("sess_woken") });
    expect(adopted).toBeDefined();
    expect(adopted!.agentKey).toBe("m1");
  });

  it("开关解析口径不变：只认字面量 '1'（回归 v0.9.5 判据）", () => {
    expect(adoptByPpidEnabledFromEnv({})).toBe(false);
    expect(adoptByPpidEnabledFromEnv({ XC_ADOPT_BY_PPID: "0" })).toBe(false);
    expect(adoptByPpidEnabledFromEnv({ XC_ADOPT_BY_PPID: "true" })).toBe(false);
    expect(adoptByPpidEnabledFromEnv({ XC_ADOPT_BY_PPID: "1" })).toBe(true);
  });
});

describe("v0.9.6 A1：开启档正例——本连接记录在场且唯一 → 采纳", () => {
  it("【硬回归·正例】唯一干净匹配（pid+cwd+boundName+token）+ 基记录佐证恰一 + 绑定锚吻合 → 采纳", async () => {
    await seedSession({ sessionId: "sess_woken", boundName: "m1" });
    await seedBase({ sessionId: "sess_woken", boundName: "m1", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_woken" }); // r2：钩子把本 server pid 绑定到本会话
    const adopted = adoptHookBoundIdentity(workspace, enabledEnv(), { hostResumeProbe: probeFor("sess_woken") });
    expect(adopted).toBeDefined();
    expect(adopted!.agentKey).toBe("m1");
    expect(adopted!.sessionId).toBe("sess_woken");
    expect(adopted!.teamId).toBe("default");
    expect(adopted!.voiceOwner).toBeUndefined(); // 采纳不设 voiceOwner（护栏 3 保留）
  });

  it("require 生产路径（进程 env 开启 + cwd 即工作区）：盘面佐证齐全 → 连接免 identify 直接持有身份（1 次调用开工形态保留）", async () => {
    await seedSession({ sessionId: "sess_woken", boundName: "m1" });
    await seedBase({ sessionId: "sess_woken", boundName: "m1", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_woken" });
    process.env["XC_ADOPT_BY_PPID"] = "1";
    const previousCwd = process.cwd();
    process.chdir(workspace); // require() 以 process.cwd() 解析工作区（生产形态对位）
    try {
      const me = identityStore.require("conn-v096", { hostResumeProbe: probeFor("sess_woken") });
      expect(me.agentKey).toBe("m1");
      expect(me.sessionId).toBe("sess_woken");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("别的工作区的基记录（cwd 不同）不参与佐证：pid+cwd 过滤后佐证缺席 → 不采纳", async () => {
    await seedSession({ sessionId: "sess_woken", boundName: "m1" });
    await seedBase({ sessionId: "sess_woken", cwd: "D:\\elsewhere" });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });
});

describe("v0.9.6 A1：多记录不采纳（硬回归）", () => {
  it("【硬回归】两条干净记录同 pid + 两条基记录（同宿主同 cwd）→ 歧义不猜", async () => {
    await seedSession({ sessionId: "sess_x", boundName: "m1" });
    await seedSession({ sessionId: "sess_y", boundName: "m2" });
    await seedBase({ sessionId: "sess_x", boundName: "m1" });
    await seedBase({ sessionId: "sess_y", boundName: "m2" });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
    expect(() => {
      process.env["XC_ADOPT_BY_PPID"] = "1";
      identityStore.require("conn-v096-multi");
    }).toThrow(notRegisteredError().message);
    identityStore.unbind("conn-v096-multi");
  });

  it("两条干净记录同 pid + 无基记录 → 不采纳（记录歧义与佐证缺席双拒）", async () => {
    await seedSession({ sessionId: "sess_x", boundName: "m1" });
    await seedSession({ sessionId: "sess_y", boundName: "m2" });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });
});

describe("v0.9.6 A1：串号用例不再复现（对抗一 C3 四形态）", () => {
  it("【C3.b 复现】兄弟记录损坏 JSON + 受害人记录唯一干净 + 无基记录 → 不采纳（旧实现采纳他人身份）", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    corruptSessionFile("sess_bob");
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("【①直接证明】损坏记录计入歧义面：受害人记录唯一干净 + 佐证恰一，但损坏兄弟在场 → 仍不采纳", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    corruptSessionFile("sess_bob");
    // 佐证面本身是干净的（基记录恰一条且等于命中 sid）——拒绝只因 workspace 侧
    // 损坏条目在场：损坏记录不得让歧义闸失效。
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("【C3.c 复现】本会话记录缺失（V094-02 形态）+ 受害人记录唯一命中 + 无基记录 → 不采纳", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
    expect(() => {
      process.env["XC_ADOPT_BY_PPID"] = "1";
      identityStore.require("conn-rogue");
    }).toThrow(notRegisteredError().message);
    identityStore.unbind("conn-rogue");
  });

  it("【②直接证明·V094-02 真实形态】本会话 workspace 记录缺失但钩子基记录在场 → 基记录说出第二个会话 → 不采纳", async () => {
    // 真实锁预算失败形态：两个会话的钩子都跑了（基记录无锁必写），本会话的
    // workspace 记录没写成 → workspace 侧受害人记录成唯一命中。基记录揭示
    // 本宿主锚定了两个会话 → 歧义 → 不采纳（旧实现此处采纳 alice）。
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    await seedBase({ sessionId: "sess_bob", boundName: "bob", regToken: "rt-v096-a1" });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("【②不一致分支】佐证指向别的会话（本会话基记录缺席、他人基记录在场）→ 佐证与命中不一致 → 不采纳", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_bob", boundName: "bob", regToken: "rt-v096-a1" });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("【①基记录层】损坏基记录在场（可能有被隐藏的第二会话）→ 不采纳", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    writeFileSync(join(peerRoot, "base", "sess_broken.json"), "corrupt{{{not-json", "utf8");
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("【佐证细则】基记录内部 sessionId 与文件名错位 → 计入损坏 → 不采纳（篡改/错位形态不猜）", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    // 文件名 sess_ghost.json，内部 sessionId=sess_other —— 错位形态（writePeerBaseRecord
    // 不会产出这种文件，手工落盘模拟外部错写/篡改）。
    mkdirSync(join(peerRoot, "base"), { recursive: true });
    writeFileSync(
      join(peerRoot, "base", "sess_ghost.json"),
      JSON.stringify({ sessionId: "sess_other", cwd: workspace, source: null, startedAt: 1, lastSeen: 1, pid: HOST_PID }),
      "utf8",
    );
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("【佐证细则】基记录 pid 字段坏（非正整数）→ 计入损坏 → 不采纳", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    mkdirSync(join(peerRoot, "base"), { recursive: true });
    writeFileSync(
      join(peerRoot, "base", "sess_badpid.json"),
      JSON.stringify({ sessionId: "sess_badpid", cwd: workspace, source: null, startedAt: 1, lastSeen: 1, pid: -5 }),
      "utf8",
    );
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("【佐证细则】基记录 pid 指向别的宿主 → 不参与佐证 → 佐证缺席 → 不采纳", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", pid: HOST_PID + 1 });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("【佐证细则】存量基记录无 pid（v0.9.4 以前升级路径）→ 不佐证 → 不采纳（fail-safe）", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", legacy: true });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });
});

describe("v0.9.6 A1：readSessionByHostPidSync 损坏计入歧义面（registry.ts ① 直测）", () => {
  it("恰一条 pid 命中（其余记录 pid 不同）→ 照常返回记录（干净面行为不变）", async () => {
    await seedSession({ sessionId: "sess_hit", boundName: "m1" });
    await seedSession({ sessionId: "sess_other", pid: HOST_PID + 1, boundName: "m2" });
    const record = readSessionByHostPidSync(stateRoot, HOST_PID);
    expect(record).toBeDefined();
    expect(record!.sessionId).toBe("sess_hit");
  });

  it("pid 命中 + 兄弟记录损坏 JSON → undefined（旧实现返回命中记录——旁路已关）", async () => {
    await seedSession({ sessionId: "sess_hit", boundName: "m1" });
    corruptSessionFile("sess_broken");
    expect(readSessionByHostPidSync(stateRoot, HOST_PID)).toBeUndefined();
  });

  it("pid 命中 + 兄弟记录结构不符（合法 JSON 非会话记录）→ undefined", async () => {
    await seedSession({ sessionId: "sess_hit", boundName: "m1" });
    writeFileSync(join(sessionsDirPath, "sess_shape.json"), JSON.stringify({ nope: true }), "utf8");
    expect(readSessionByHostPidSync(stateRoot, HOST_PID)).toBeUndefined();
  });

  it("pid 命中 + 兄弟条目读错误（目录冒充 .json，EISDIR）→ undefined（读得了名字读不了内容也算不可解析）", async () => {
    await seedSession({ sessionId: "sess_hit", boundName: "m1" });
    mkdirSync(join(sessionsDirPath, "sess_dir.json"), { recursive: true });
    expect(readSessionByHostPidSync(stateRoot, HOST_PID)).toBeUndefined();
  });

  it("损坏条目在场但无 pid 命中 → undefined（零命中本就拒绝，语义不变）", async () => {
    corruptSessionFile("sess_broken");
    expect(readSessionByHostPidSync(stateRoot, HOST_PID)).toBeUndefined();
  });

  it("异步版同步修：pid 命中 + 兄弟记录损坏 → undefined（两版判据逐字一致）", async () => {
    await seedSession({ sessionId: "sess_hit", boundName: "m1" });
    corruptSessionFile("sess_broken");
    expect(await readSessionByHostPid(stateRoot, HOST_PID)).toBeUndefined();
  });

  it("异步版干净面：恰一条 pid 命中 → 返回记录", async () => {
    await seedSession({ sessionId: "sess_hit", boundName: "m1" });
    const record = await readSessionByHostPid(stateRoot, HOST_PID);
    expect(record).toBeDefined();
    expect(record!.sessionId).toBe("sess_hit");
  });
});

describe("v0.9.6 r2（V096-12）：护栏 6 绑定锚——零痕迹会话不再借他人记录冒名", () => {
  it("【V096-12 复现】受害人记录+基记录在场（佐证恰一）、本连接两记录双缺且无锚 → 不采纳（回一实现此处采纳他人身份）", async () => {
    // 回二缺陷形态：开启档 + 同宿主多会话 + 本连接 sessions/<sid>.json 与
    // peers/base/<sid>.json 双缺 → 护栏 5 佐证面只剩受害者一条（恰等于 pid 命中
    // 记录 sid）→ 唯一性判据失守。护栏 6：本进程 pid 无锚 → 拒。
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    removeSelfAnchor(); // 本连接零痕迹：无锚
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
    expect(() => {
      process.env["XC_ADOPT_BY_PPID"] = "1";
      identityStore.require("conn-v096-rogue");
    }).toThrow(notRegisteredError().message);
    identityStore.unbind("conn-v096-rogue");
  });

  it("锚在场且 hostPid/时窗/sid 与命中记录全部吻合 → 采纳成立（护栏 6 正例）", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_alice" });
    const adopted = adoptHookBoundIdentity(workspace, enabledEnv(), { hostResumeProbe: probeFor("sess_alice") });
    expect(adopted).toBeDefined();
    expect(adopted!.sessionId).toBe("sess_alice");
  });

  it("锚的 hostPid 与本宿主不符 → 不采纳（宿主 pid 错位/复用形态不猜）", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_alice", hostPid: HOST_PID + 1 });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("陈旧锚（早于本进程诞生超过预生窗）→ 不采纳（前任 server 残锚 + pid 复用形态）", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_alice", ts: selfBirthMs() - ADOPT_ANCHOR_MAX_PREBIRTH_MS - 60_000 });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("未来锚（超出时钟偏移窗）→ 不采纳", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_alice", ts: Date.now() + ADOPT_ANCHOR_MAX_CLOCK_SKEW_MS + 60_000 });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("锚绑定的会话与 pid 命中记录不一致 → 不采纳", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_other" });
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("锚损坏（坏 JSON/结构不符）→ 按无锚拒绝（fail-closed）", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    mkdirSync(join(stateRoot, "registry", "adopt-anchor"), { recursive: true });
    writeFileSync(join(stateRoot, "registry", "adopt-anchor", `${process.pid}.json`), "corrupt{{{not-json", "utf8");
    expect(readAdoptAnchorSync(stateRoot, process.pid)).toBeUndefined();
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("锚结构不符（字段缺失/非法）→ 按无锚拒绝", async () => {
    await seedSession({ sessionId: "sess_alice", boundName: "alice" });
    await seedBase({ sessionId: "sess_alice", boundName: "alice", regToken: "rt-v096-a1" });
    mkdirSync(join(stateRoot, "registry", "adopt-anchor"), { recursive: true });
    writeFileSync(
      join(stateRoot, "registry", "adopt-anchor", `${process.pid}.json`),
      JSON.stringify({ sessionId: "sess_alice", hostPid: -5, serverPid: process.pid, ts: Date.now() }),
      "utf8",
    );
    expect(readAdoptAnchorSync(stateRoot, process.pid)).toBeUndefined();
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });
});

describe("v0.9.6 r2（V096-13）：legacy 记录升级并存形态——老会话连接回落 not_registered", () => {
  it("【V096-13 复现】legacy 记录（无 pid 可解析）+ 新版会话全套装：老连接形态（无锚）→ not_registered（回一实现此处误采纳新会话身份）", async () => {
    // legacy 老会话记录：可正常解析但无 pid（0.9.4 以前锚定形态），两层扫描按
    // 「无法宿主归因」跳过（不佐证不歧义）；新版会话记录（pid 在场）成唯一命中。
    await seedSession({ sessionId: "sess_legacy", pid: undefined, boundName: "old" });
    await seedSession({ sessionId: "sess_new", boundName: "new" });
    await seedBase({ sessionId: "sess_new", boundName: "new", regToken: "rt-v096-a1" });
    // 老会话连接形态：其会话的 0.9.6 钩子从未以票据路径锚定它 → 无锚 → 拒绝
    // （承诺的 not_registered 回落；回一实现因 legacy 不可见 + 新记录唯一命中而误采纳）。
    removeSelfAnchor();
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
    // 新会话连接形态：锚在场且绑定吻合 → 采纳自己的身份（不受 legacy 隐身影响）。
    await seedAnchor({ sessionId: "sess_new" });
    const adopted = adoptHookBoundIdentity(workspace, enabledEnv(), { hostResumeProbe: probeFor("sess_new") });
    expect(adopted).toBeDefined();
    expect(adopted!.sessionId).toBe("sess_new");
    // 再删锚 → 老连接形态照旧拒绝（锚是自证通道，删锚即回落）。
    removeSelfAnchor();
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });

  it("legacy 记录损坏（不可解析）→ 计入歧义面（回一 ① 判据保留）：唯一 pid 命中 + 损坏 legacy 兄弟 → 不采纳", async () => {
    await seedSession({ sessionId: "sess_new", boundName: "new" });
    await seedBase({ sessionId: "sess_new", boundName: "new", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_new" });
    corruptSessionFile("sess_legacy_broken");
    expect(adoptHookBoundIdentity(workspace, enabledEnv())).toBeUndefined();
  });
});

describe("v0.9.6 r3（V096-21）：护栏 6b 宿主唤醒子事实复核——锚归属可判定才采纳", () => {
  it("【V096-21 复现】锚在场且全吻合但宿主不是本会话唤醒子（桌面多会话宿主/非 --resume）→ 不采纳（回二 R4 形态：外来 server 子进程被受害者钩子误绑）", async () => {
    // 回二 R4 实测形态（零伪造）：受害者钩子把锚写到先于其在位的外来 server 子进程
    // （宿主下恰一个本插件 server），恶意连接读自身 pid 的锚全吻合。护栏 6b：宿主
    // cmdline 的 resume sid ≠ 命中记录 sid → 拒。
    await seedSession({ sessionId: "sess_victim", boundName: "victim" });
    await seedBase({ sessionId: "sess_victim", boundName: "victim", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_victim" }); // 锚在场且与命中记录吻合（回二的全部条件）
    // 宿主不是 --resume 唤醒子（桌面 app-server 形态：无 resume token）
    expect(adoptHookBoundIdentity(workspace, enabledEnv(), {
      hostResumeProbe: { available: true },
    })).toBeUndefined();
    // 宿主是别会话的唤醒子（resume token 指向别的 sid）
    expect(adoptHookBoundIdentity(workspace, enabledEnv(), {
      hostResumeProbe: { available: true, resumeSid: "sess_someone_else" },
    })).toBeUndefined();
    // 宿主 cmdline 不可读（枚举失败）→ fail-closed
    expect(adoptHookBoundIdentity(workspace, enabledEnv(), {
      hostResumeProbe: { available: false },
    })).toBeUndefined();
  });

  it("锚在场 + 宿主 resume sid = 命中记录 sid → 采纳成立（单会话唤醒子拓扑）", async () => {
    await seedSession({ sessionId: "sess_victim", boundName: "victim" });
    await seedBase({ sessionId: "sess_victim", boundName: "victim", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_victim" });
    const adopted = adoptHookBoundIdentity(workspace, enabledEnv(), {
      hostResumeProbe: { available: true, resumeSid: "sess_victim" },
    });
    expect(adopted).toBeDefined();
    expect(adopted!.sessionId).toBe("sess_victim");
  });

  it("锚与宿主事实矛盾（锚 sid=A、宿主 resume=B、pid 命中=B）→ 不采纳", async () => {
    await seedSession({ sessionId: "sess_b", boundName: "b" });
    await seedBase({ sessionId: "sess_b", boundName: "b", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_a" }); // 锚绑的是别会话（误写/残留形态）
    expect(adoptHookBoundIdentity(workspace, enabledEnv(), {
      hostResumeProbe: { available: true, resumeSid: "sess_b" },
    })).toBeUndefined();
  });

  it("默认档不变：完美盘面 + 锚 + 宿主事实吻合，未设开关 → 不采纳", async () => {
    await seedSession({ sessionId: "sess_victim", boundName: "victim" });
    await seedBase({ sessionId: "sess_victim", boundName: "victim", regToken: "rt-v096-a1" });
    await seedAnchor({ sessionId: "sess_victim" });
    expect(adoptHookBoundIdentity(workspace)).toBeUndefined();
  });
});

describe("v0.9.6 r3（V096-21）：probeHostResumeSidSync 解析判据（registry.ts 直测）", () => {
  const wakeHostCmdline = (sid: string): string =>
    '"E:\ZCode\ZCode.exe" "E:\ZCode\resources\glm\zcode.cjs" --resume ' + sid
    + ' --prompt "hi" --cwd D:\tools\ws --output-format json';
  const desktopHostCmdline = '"E:\ZCode\ZCode.exe" "E:\ZCode\resources\glm\zcode.cjs" app-server --stdio --surface desktop';

  it("唤醒子宿主 cmdline → 解析出 resume sid", () => {
    const probe = probeHostResumeSidSync(4242, { readCommandLine: () => wakeHostCmdline("sess-abc") });
    expect(probe).toEqual({ available: true, resumeSid: "sess-abc" });
  });

  it("桌面 app-server 宿主（无 --resume）→ available 但 resumeSid 缺省（不写锚、不采纳）", () => {
    const probe = probeHostResumeSidSync(4242, { readCommandLine: () => desktopHostCmdline });
    expect(probe.available).toBe(true);
    expect(probe.resumeSid).toBeUndefined();
  });

  it("cmdline 不可读（枚举失败）→ available:false（fail-closed）", () => {
    expect(probeHostResumeSidSync(4242, { readCommandLine: () => undefined })).toEqual({ available: false });
  });

  it("宿主 pid 非法 → available:false", () => {
    expect(probeHostResumeSidSync(0, { readCommandLine: () => wakeHostCmdline("sess-abc") })).toEqual({ available: false });
    expect(probeHostResumeSidSync(-1, { readCommandLine: () => wakeHostCmdline("sess-abc") })).toEqual({ available: false });
  });

  it("--resume 后无 token / 引号包裹 sid → 解析稳健", () => {
    expect(probeHostResumeSidSync(4242, { readCommandLine: () => 'node x.cjs --resume' }).resumeSid).toBeUndefined();
    const quoted = probeHostResumeSidSync(4242, { readCommandLine: () => 'node x.cjs --resume "sess-q"' });
    expect(quoted.resumeSid).toBe("sess-q");
  });
});
