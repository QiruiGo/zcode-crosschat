/**
 * v0.9.8（组 S）定向测试：**engine/wake.ts 的 steer 机械**（方案 49-v098 §二 S1-S5）
 * + V097-09（D3）回执有界二次回读 + R1 队友名单。
 *
 * 覆盖（每条对应方案验收项）：
 * S1 三态：
 *   1. 引擎供给成员 ∧ 活唤醒回合（liveness=running ∧ pid 存活）→ 抢占：终止→续跑，
 *      回执 result="preempted" + stopped + turn；审计 steer-stopped / steer-turn-started；
 *   2. 引擎供给成员但空闲（无记录/ idle）→ 降级普通唤醒：result="deferred-next-turn"，
 *      不调用终止；信封首行 = 「未发生回合中止」措辞（不谎称中止）；
 *   3. 交互式成员（identity=self）→ result="unsupported"（只有用户 Esc）；
 *      wake 关闭时同理（邮箱降级 + unsupported 回执）。
 * S2 终止路径：
 *   4. 优雅路径：taskkill 无 /F 被接受 + 宽限窗内退出 → graceful:true；
 *   5. 优雅被 OS 拒（Windows 无头进程常态）→ 立即 /F → graceful:false + gracefulRefusal 进审计；
 *   6. 优雅超时 → /F → graceful:false 且 waitedMs ≥ 宽限窗；
 *   7. 两种手段都失败（pid 仍存活）→ 不起新回合、回退软中断：delivered=mailbox、
 *      result="deferred-next-turn"、审计 steer-stop-failed、spawn 未被调用。
 * S3 续跑：
 *   8. steer 信封 = 新回合首条指令：首行「上一回合已被 lead/用户中止…未落盘进度可能丢失」
 *      + 正文（≤2KB）+ taskId/journal 指针；scene="steer"（prompt 不附加成员守则）。
 * S5 回执诚实：
 *   9. 抢占后 spawn 失败 → result 降 deferred + stopped 在场 + turn 缺席（不虚构新回合）；
 *   10. 旧回合的在途票据在终止成功后被消费（不挡住下一轮唤醒）；
 *   11. 非 steer 唤醒 → 结果无 steer 键（既有路径零行为变化）。
 * V097-09：
 *   12. 失败证据晚于回执落盘（spawn 后 120ms 才写盘）→ 有界二次回读命中 →
 *      wakeFailureSeen=true（单次回读的旧行为会读作成功）；
 *   13. 补读关闭（ROUNDS=0）→ 回退旧行为（不误报也不多等）；
 *   14. 日志文件不存在 → 不补读（零等待，既有「未见证据」测试形态不变）。
 * R1：
 *   15. 唤醒 prompt identity 段后带「队友：a, c（可 xc_relay({to:"a"}) 直连，不必经过 lead）」；
 *   16. 单人队（无队友）不附行。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWakeNonce, readWakeNonce, writeSession } from "../core/registry.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { appendMailbox, createMessage } from "../core/mailbox.js";
import type { TeamMember } from "../core/types.js";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli.js";
import {
  attemptWake,
  buildSteerEnvelope,
  classifySteerTarget,
  stopTurnForSteer,
  STEER_ENVELOPE_HEADER_ABORTED,
  STEER_ENVELOPE_HEADER_IDLE,
  type WakeRequest,
} from "./wake.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v098-steer-"));
  dirs.push(root);
});

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 绿色容量样本（跳过容量闸的确定性）。 */
const greenCapacity = {
  sampledAt: Date.now(),
  totalBytes: 16 * 1024 ** 3,
  freeBytes: 8 * 1024 ** 3,
  watermark: 0.5,
  steadyTreeBytes: 1 * 1024 ** 3,
  headlessTurnCount: 0,
  headlessTurnMaxRssBytes: null,
  degraded: null,
};

interface KillCall {
  pid: number;
  force: boolean;
}

function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "steer",
    receiptIds: [],
    ticket: "别删生产库，先跑 dry-run",
    // 唤醒开：本文件测的是 steer 机械而非分层闸（交互式+唤醒关的用例显式覆盖闸）。
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
    capacitySample: greenCapacity,
    watchWindowMs: 0,
    limboTimeoutMs: 3_600_000,
    wakeSlowMs: 3_600_000,
    fakeSuccessMs: 3_600_000,
    lifecycleWindowMs: 100,
    ...overrides,
  };
}

/** 建队：a（founder=lead）、b（引擎成员，steer 目标）、c（队友，R1 名单用）。 */
async function seedTeam(memberB: Partial<TeamMember> = {}): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: "default", founderKey: "a", now });
  const b: TeamMember = {
    key: "b", sessionId: "sess_b", role: "worker", joinedAt: now, lastSeen: now,
    identity: "engine",
    ...memberB,
  };
  team.members.push({ key: "a", sessionId: "sess_a", role: "peer", joinedAt: now, lastSeen: now });
  team.members.push(b);
  team.members.push({ key: "c", sessionId: "sess_c", role: "worker", joinedAt: now, lastSeen: now, identity: "engine" });
  await writeTeam(root, team);
}

/** 会话记录：活唤醒回合（liveness=running + pid）。 */
async function seedRunningSession(pid = 4242): Promise<void> {
  const now = Date.now();
  await writeSession(root, {
    sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 60_000, lastSeen: now,
    boundName: "b", liveness: "running", livenessTs: now - 30_000, pid,
  });
}

/** 捕获 prompt 的 spawn 注入（同步汇报启动证据 → startConfirmed=true）。 */
function spawnOk(captured: SpawnResumeOptions[]): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    opts.onHelperSpawned?.(7777);
    captured.push(opts);
    return { pid: 7777, logFile: opts.logFile };
  };
}

/** steer 指令（终止注入面可配）。 */
function steerDirective(overrides: {
  by?: string;
  viaUser?: boolean;
  kill?: (pid: number, force: boolean) => { ok: boolean; error?: string };
  sleep?: (ms: number) => Promise<void>;
} = {}): NonNullable<WakeRequest["steer"]> {
  return {
    by: overrides.by ?? "a",
    ...(overrides.viaUser !== undefined ? { viaUser: overrides.viaUser } : {}),
    kill: overrides.kill ?? (() => ({ ok: true })),
    sleep: overrides.sleep ?? (async () => {}),
  };
}

/** 「优雅终止即生效」的注入面：WM_CLOSE 被接受且进程随即退出。 */
function gracefulWorkingKill(): {
  calls: KillCall[];
  aliveProbe: (pid: number) => boolean;
  kill: (pid: number, force: boolean) => { ok: boolean; error?: string };
} {
  let alive = true;
  const calls: KillCall[] = [];
  return {
    calls,
    aliveProbe: () => alive,
    kill: (pid, force) => {
      calls.push({ pid, force });
      if (!force) alive = false; // 优雅信号被接受 → 进程退出
      return { ok: true };
    },
  };
}

describe("v0.9.8 S1：steer 三态（引擎抢占 / 空闲降级 / 交互式不支持）", () => {
  it("【S1 锚点】引擎成员 + 活唤醒回合 → 抢占：终止→续跑，回执三块实况齐全", async () => {
    await seedTeam();
    await seedRunningSession(4242);
    const killer = gracefulWorkingKill();
    const captured: SpawnResumeOptions[] = [];
    const res = await attemptWake(baseReq({
      spawn: spawnOk(captured),
      pidAliveProbe: killer.aliveProbe,
      steer: steerDirective({ kill: killer.kill }),
    }));
    expect(res.delivered).toBe("wake");
    expect(res.steer?.requested).toBe(true);
    expect(res.steer?.result).toBe("preempted");
    expect(res.steer?.stopped).toEqual({ pid: 4242, graceful: true, waitedMs: expect.any(Number) });
    expect(res.steer?.turn?.startConfirmed).toBe(true);
    // turn.nonce = 不可反查摘要（与 steer-turn-started 审计同值；真值只在 prompt/registry）。
    expect(res.steer?.turn?.nonce).toHaveLength(12);
    expect(res.steer?.turn?.nonce).not.toBe(res.nonce);
    // S2：先优雅；本用例优雅即退出（不升级强杀）。
    expect(killer.calls).toEqual([{ pid: 4242, force: false }]);
    // S3：新回合首条指令 = steer 信封（中止措辞 + 纠偏正文）。
    expect(captured).toHaveLength(1);
    const prompt = captured[0]!.prompt;
    expect(prompt).toContain(STEER_ENVELOPE_HEADER_ABORTED);
    expect(prompt).toContain("未落盘进度可能丢失");
    expect(prompt).toContain("别删生产库，先跑 dry-run");
    expect(prompt).toContain("sessionId=sess_b");
    // 审计：steer-stopped{pid,graceful,waitedMs} + steer-turn-started{nonce,startConfirmed}。
    const stopped = readEngineEvents().find((e) => e["event"] === "steer-stopped");
    expect(stopped).toBeDefined();
    expect(stopped!["pid"]).toBe(4242);
    expect(stopped!["graceful"]).toBe(true);
    expect(typeof stopped!["waitedMs"]).toBe("number");
    expect(stopped!["by"]).toBe("a");
    const started = readEngineEvents().find((e) => e["event"] === "steer-turn-started");
    expect(started).toBeDefined();
    expect(started!["startConfirmed"]).toBe(true);
    expect(typeof started!["nonce"]).toBe("string");
    expect(String(started!["nonce"]).length).toBe(12); // 只落摘要（V091-01 纪律）
    expect(readEngineEvents().some((e) => e["event"] === "steer-degraded")).toBe(false);
  });

  it("【S1 锚点】引擎成员但空闲（无会话记录）→ 降级普通唤醒：deferred-next-turn，不终止", async () => {
    await seedTeam();
    const killer = gracefulWorkingKill();
    const captured: SpawnResumeOptions[] = [];
    const res = await attemptWake(baseReq({
      spawn: spawnOk(captured),
      pidAliveProbe: killer.aliveProbe,
      steer: steerDirective({ kill: killer.kill }),
    }));
    expect(res.delivered).toBe("wake");
    expect(res.steer?.result).toBe("deferred-next-turn");
    expect(res.steer?.reason).toContain("无活唤醒回合");
    expect(res.steer?.stopped).toBeUndefined();
    expect(res.steer?.turn).toBeUndefined();
    expect(killer.calls).toEqual([]); // 未执行任何终止
    // 信封首行用「未发生回合中止」措辞——不谎称中止过。
    expect(captured[0]!.prompt).toContain(STEER_ENVELOPE_HEADER_IDLE);
    expect(captured[0]!.prompt).not.toContain(STEER_ENVELOPE_HEADER_ABORTED);
    const degraded = readEngineEvents().find((e) => e["event"] === "steer-degraded");
    expect(degraded).toBeDefined();
    expect(degraded!["result"]).toBe("deferred-next-turn");
  });

  it("【S1 锚点】引擎成员 + liveness=idle（回合已结束）→ 同样降级，不终止", async () => {
    await seedTeam();
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 60_000, lastSeen: now,
      boundName: "b", liveness: "idle", livenessTs: now - 30_000, pid: 4242,
    });
    const killer = gracefulWorkingKill();
    const res = await attemptWake(baseReq({
      spawn: spawnOk([]),
      pidAliveProbe: killer.aliveProbe,
      steer: steerDirective({ kill: killer.kill }),
    }));
    expect(res.delivered).toBe("wake");
    expect(res.steer?.result).toBe("deferred-next-turn");
    expect(killer.calls).toEqual([]);
  });

  it("【S1 锚点】交互式成员（identity=self）+ 唤醒开 → unsupported，绝不终止", async () => {
    await seedTeam({ identity: "self" });
    await seedRunningSession(4242);
    const killer = gracefulWorkingKill();
    const captured: SpawnResumeOptions[] = [];
    const res = await attemptWake(baseReq({
      spawn: spawnOk(captured),
      pidAliveProbe: killer.aliveProbe,
      steer: steerDirective({ kill: killer.kill }),
    }));
    expect(res.delivered).toBe("wake");
    expect(res.steer?.result).toBe("unsupported");
    expect(res.steer?.reason).toContain("交互式会话无法被插件终止");
    expect(killer.calls).toEqual([]); // 交互式会话一个字节都不杀
    // 未发生终止 → 信封不得谎称「上一回合已中止」。
    expect(captured[0]!.prompt).toContain(STEER_ENVELOPE_HEADER_IDLE);
  });

  it("【S1 锚点】交互式成员 + 唤醒关（默认档）→ 邮箱降级 + unsupported 回执仍在", async () => {
    await seedTeam({ identity: "self" });
    await seedRunningSession(4242);
    const res = await attemptWake(baseReq({
      spawn: spawnOk([]),
      env: {}, // 无 XC_WAKE_ENABLED：交互式目标按内置默认关
      steer: steerDirective(),
    }));
    expect(res.delivered).toBe("mailbox");
    expect(res.steer?.result).toBe("unsupported");
    expect(res.note).toContain("wake-disabled");
  });

  it("【S1 边界】目标不在册 → unsupported（无法确认引擎供给身份，不终止）", async () => {
    const res = await attemptWake(baseReq({
      spawn: spawnOk([]),
      steer: steerDirective(),
    }));
    expect(res.steer?.result).toBe("unsupported");
    expect(res.steer?.reason).toContain("不在队内花名册");
  });
});

describe("v0.9.8 S2：终止路径（优雅 / 优雅被拒→强杀 / 优雅超时→强杀 / 全失败）", () => {
  it("【S2 锚点】优雅路径：WM_CLOSE 语义被接受 + 窗内退出 → graceful:true", async () => {
    const res = await stopTurnForSteer(4242, 8_000, {
      kill: () => ({ ok: true }),
      alive: () => false, // 第一轮轮询即已退出
      sleep: async () => {},
    });
    expect(res).toEqual({ pid: 4242, graceful: true, stopped: true, waitedMs: expect.any(Number) });
  });

  it("【S2 锚点】优雅被 OS 拒（Windows 无头进程常态）→ 立即强杀：graceful:false + refusal 留痕", async () => {
    const kills: KillCall[] = [];
    const res = await stopTurnForSteer(4242, 8_000, {
      kill: (pid, force) => {
        kills.push({ pid, force });
        return force ? { ok: true } : { ok: false, error: "错误: 只能强行终止这个进程(带 /F 选项)" };
      },
      alive: (pid) => kills.every((k) => !k.force), // 强杀后死亡
      sleep: async () => {},
    });
    expect(res.graceful).toBe(false);
    expect(res.stopped).toBe(true);
    expect(res.gracefulRefusal).toContain("只能强行终止");
    expect(kills.map((k) => k.force)).toEqual([false, true]); // 先优雅、被拒即强杀
    expect(res.waitedMs).toBeLessThan(8_000); // 没有信号在途，不等满窗
  });

  it("【S2 锚点】优雅超时 → 强杀：graceful:false 且 waitedMs ≥ 宽限窗", async () => {
    let alive = true;
    const res = await stopTurnForSteer(4242, 150, {
      kill: (_pid, force) => { if (force) alive = false; return { ok: true }; },
      alive: () => alive,
      sleep: async () => {},
    });
    expect(res.graceful).toBe(false);
    expect(res.stopped).toBe(true);
    expect(res.waitedMs).toBeGreaterThanOrEqual(150);
  });

  it("【S2 锚点】两种手段都失败（pid 仍存活）→ 不起新回合、回退软中断、审计 steer-stop-failed", async () => {
    await seedTeam();
    await seedRunningSession(4242);
    const kills: KillCall[] = [];
    const captured: SpawnResumeOptions[] = [];
    const res = await attemptWake(baseReq({
      spawn: spawnOk(captured),
      pidAliveProbe: () => true, // 两种手段后进程仍存活
      steer: steerDirective({
        kill: (pid, force) => { kills.push({ pid, force }); return { ok: false, error: `refused(${force})` }; },
      }),
    }));
    expect(res.delivered).toBe("mailbox");
    expect(res.steer?.result).toBe("deferred-next-turn");
    expect(res.steer?.reason).toContain("steer 终止失败");
    expect(res.steer?.stopped).toBeUndefined(); // 没终止成功，不写 stopped 块
    expect(res.steer?.turn).toBeUndefined();
    expect(kills.map((k) => k.force)).toEqual([false, true]); // 优雅 + 强杀都试过
    expect(captured).toHaveLength(0); // 未发起新回合（避免同会话并发 --resume）
    expect(res.note).toContain("仅落邮箱");
    const failed = readEngineEvents().find((e) => e["event"] === "steer-stop-failed");
    expect(failed).toBeDefined();
    expect(failed!["pid"]).toBe(4242);
    expect(String(failed!["error"])).toContain("refused(true)");
    // 票据与租约已清（失败路径不留可用的 15min 在途标记——票据置 used，文件按真源纪律保留）。
    const wakeDir = join(root, "registry", "wake");
    const left = existsSync(wakeDir) ? require("node:fs").readdirSync(wakeDir) : [];
    expect(left).toHaveLength(1); // 恰一张：本轮签发的票据（已置 used）
    const stored = JSON.parse(readFileSync(join(wakeDir, String(left[0])), "utf8")) as { used?: boolean };
    expect(stored.used).toBe(true);
  });

  it("【S2 边界】会话记录 pid = 本进程 → 分类即拒（绝不自杀）", async () => {
    const cls = classifySteerTarget({
      member: { key: "b", sessionId: "s", role: "worker", joinedAt: 1, lastSeen: 1, identity: "engine" },
      record: {
        sessionId: "s", cwd: "D:\\ws", startedAt: 1, lastSeen: 1,
        liveness: "running", livenessTs: Date.now(), pid: process.pid,
      },
      now: Date.now(),
      alive: () => true,
    });
    expect(cls.result).toBe("deferred-next-turn");
    expect(cls.pid).toBeUndefined();
    expect(cls.reason).toContain("与本进程相同");
  });
});

describe("v0.9.8 V098-01（P1）：steer 分类须验无头持有者（boundName），不认粘滞 identity 标", () => {
  it("【V098-01 锚点·纯函数】engine 粘滞标 + 活回合 + 记录无 boundName（交互接管形态）→ unsupported，不抢占", () => {
    const cls = classifySteerTarget({
      member: { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1, identity: "engine" },
      record: {
        sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now(),
        liveness: "running", livenessTs: Date.now(), pid: 4242,
        // 无 boundName：交互式接管（xc_identify takeover）后 joinTeam 只换 sid、
        // 保留 identity 粘滞标；V090-04 起交互会话无法自签 boundName。
      },
      now: Date.now(),
      alive: () => true,
    });
    expect(cls.result).toBe("unsupported");
    expect(cls.pid).toBeUndefined();
    expect(cls.reason).toContain("粘滞标");
    expect(cls.reason).toContain("boundName 不匹配");
    expect(cls.reason).toContain("请人工 Esc");
  });

  it("【V098-01 锚点·纯函数】engine 粘滞标 + 活回合 + boundName 是别的名字 → 同样 unsupported", () => {
    const cls = classifySteerTarget({
      member: { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1, identity: "engine" },
      record: {
        sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now(),
        liveness: "running", livenessTs: Date.now(), pid: 4242, boundName: "c",
      },
      now: Date.now(),
      alive: () => true,
    });
    expect(cls.result).toBe("unsupported");
    expect(cls.pid).toBeUndefined();
  });

  it("【V098-01 锚点·纯函数】engine 标 + boundName=本名 + 活回合 → 照常 preempted（修复不误伤真引擎成员）", () => {
    const cls = classifySteerTarget({
      member: { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1, identity: "engine" },
      record: {
        sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now(),
        liveness: "running", livenessTs: Date.now(), pid: 4242, boundName: "b",
      },
      now: Date.now(),
      alive: () => true,
    });
    expect(cls.result).toBe("preempted");
    expect(cls.pid).toBe(4242);
  });

  it("【V098-01 锚点·端到端】交互接管形态 + wake_enabled=true → unsupported 回执，一个字节都不杀", async () => {
    await seedTeam(); // b 带 identity:"engine" 粘滞标（接管后形态）
    // 会话记录 = 交互接管方：running + pid 存活，但**无 boundName**（V090-04 起交互会话无法自签）。
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 60_000, lastSeen: now,
      liveness: "running", livenessTs: now - 30_000, pid: 4242,
    });
    const killer = gracefulWorkingKill();
    const captured: SpawnResumeOptions[] = [];
    const res = await attemptWake(baseReq({
      spawn: spawnOk(captured),
      pidAliveProbe: killer.aliveProbe,
      steer: steerDirective({ kill: killer.kill }),
    }));
    // 唤醒闸放行（XC_WAKE_ENABLED=true）→ 投递照常发生；但 steer 不抢占。
    expect(res.delivered).toBe("wake");
    expect(res.steer?.result).toBe("unsupported");
    expect(res.steer?.reason).toContain("粘滞标");
    expect(res.steer?.stopped).toBeUndefined();
    expect(res.steer?.turn).toBeUndefined();
    expect(killer.calls).toEqual([]); // 交互宿主进程一个字节都不杀
    // 未发生终止 → 信封不得谎称「上一回合已中止」。
    expect(captured[0]!.prompt).toContain(STEER_ENVELOPE_HEADER_IDLE);
    const degraded = readEngineEvents().find((e) => e["event"] === "steer-degraded");
    expect(degraded).toBeDefined();
    expect(degraded!["result"]).toBe("unsupported");
    expect(readEngineEvents().some((e) => e["event"] === "steer-stopped")).toBe(false);
  });

  it("【V098-01 边界】非无头持有者但无活回合（idle）→ 仍是 deferred（没有活回合就没有抢占，与持有者形态无关）", () => {
    const cls = classifySteerTarget({
      member: { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1, identity: "engine" },
      record: {
        sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now(),
        liveness: "idle", livenessTs: Date.now(), pid: 4242,
      },
      now: Date.now(),
      alive: () => true,
    });
    expect(cls.result).toBe("deferred-next-turn");
  });

  it("【V098-01 锚点·跨面一致】steer 分类的无头判据 ≡ 唤醒闸 engineHolderIsHeadless（同一输入同结论）", async () => {
    const { engineHolderIsHeadless } = await import("../core/config.js");
    const { sessionFile } = await import("../core/paths.js");
    const shapes: Array<{ label: string; record: Record<string, unknown> | undefined }> = [
      { label: "member-add 供给代写（boundName=本名）", record: { boundName: "b" } },
      { label: "交互接管（无 boundName）", record: {} },
      { label: "记录被别的名字盖过", record: { boundName: "c" } },
      { label: "记录缺失", record: undefined },
    ];
    const member = { key: "b", sessionId: "sess_b", role: "worker" as const, joinedAt: 1, lastSeen: 1, identity: "engine" as const };
    for (const shape of shapes) {
      // 每个形态都从干净状态开始（上一形态的记录文件先删掉——「记录缺失」形态才真实）。
      rmSync(sessionFile(root, "sess_b"), { force: true });
      if (shape.record !== undefined) {
        await writeSession(root, {
          sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now(),
          liveness: "running", livenessTs: Date.now(), pid: 4242,
          ...shape.record,
        } as Parameters<typeof writeSession>[1]);
      }
      const gateHeadless = engineHolderIsHeadless(root, member);
      // steer 侧：把同一条记录喂给分类（record 缺省 = 与 gate 同样的「记录缺失」输入）。
      const record = shape.record !== undefined
        ? {
            sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now(),
            liveness: "running" as const, livenessTs: Date.now(), pid: 4242,
            ...(shape.record.boundName !== undefined ? { boundName: String(shape.record.boundName) } : {}),
          }
        : undefined;
      const cls = classifySteerTarget({ member, record, now: Date.now(), alive: () => true });
      // 判据一致：gate 认无头 ⟺ steer 分类给 preempted（有活回合同为前提）。
      expect(cls.result === "preempted", `${shape.label}: gate=${gateHeadless} steer=${cls.result}`).toBe(gateHeadless);
      // 非无头持有者的后半分流（与持有者形态无关的活回合判据）：
      // 记录在场（有活回合）→ unsupported（不得抢占交互/非无头回合）；
      // 记录缺失（无活回合）→ deferred（没有活回合就没有抢占对象）。
      if (!gateHeadless) {
        expect(cls.result, shape.label).toBe(shape.record !== undefined ? "unsupported" : "deferred-next-turn");
      }
    }
  });
});

describe("v0.9.8 S3：steer 信封（新回合首条指令）", () => {
  it("【S3 锚点】信封 = 首行中止措辞 + 归因 + 正文 + taskId/journal 指针（≤2KB 正文截断）", async () => {
    await seedTeam();
    await seedRunningSession(4242);
    const message = createMessage("a", "b", "别删生产库，先跑 dry-run", { taskId: "t-42", deliveryClaimedAt: Date.now() });
    await appendMailbox(root, "default", "b", message);
    const killer = gracefulWorkingKill();
    const captured: SpawnResumeOptions[] = [];
    await attemptWake(baseReq({
      spawn: spawnOk(captured),
      receiptIds: [message.id],
      ticket: "x".repeat(5000), // 超 2KB → 信封内截断（C2 短指令）
      pidAliveProbe: killer.aliveProbe,
      steer: steerDirective({ by: "a", viaUser: true, kill: killer.kill }),
    }));
    const prompt = captured[0]!.prompt;
    expect(prompt).toContain(STEER_ENVELOPE_HEADER_ABORTED);
    expect(prompt).toContain("来自用户（origin=user，经 a 的会话转达）");
    expect(prompt).toContain("…[truncated]"); // 5000 字符正文被截到 2KB 内
    expect(prompt).toContain("taskId=t-42");
    // journal 指针（路径分隔符随平台；用正则跨 Windows/POSIX 对拍）。
    expect(prompt).toMatch(/tasks[\\/]t-42[\\/]journal\.md/);
    expect(prompt).not.toContain("成员守则"); // steer 场景不附加守则（预算留给纠偏）
    // 整 prompt 仍受 4000 上限约束。
    expect(prompt.length).toBeLessThanOrEqual(4000);
  });

  it("【S3 纯函数】buildSteerEnvelope：aborted 分流 + 归因 + 指针行", () => {
    const aborted = buildSteerEnvelope({ body: "先别发布", by: "lead", aborted: true });
    expect(aborted.startsWith(STEER_ENVELOPE_HEADER_ABORTED)).toBe(true);
    expect(aborted).toContain("来自 lead");
    expect(aborted).toContain("先别发布");
    const idle = buildSteerEnvelope({ body: "先别发布", by: "lead", aborted: false });
    expect(idle.startsWith(STEER_ENVELOPE_HEADER_IDLE)).toBe(true);
    expect(idle).not.toContain("已中止");
    const withPointers = buildSteerEnvelope({
      body: "b", by: "lead", aborted: true, taskId: "t-1", journalPath: "J.md",
    });
    expect(withPointers).toContain("指针：taskId=t-1；journal=J.md");
  });
});

describe("v0.9.8 S5：回执诚实（spawn 失败 / 票据作废 / 非 steer 不变）", () => {
  it("【S5 锚点】抢占后 spawn 失败 → deferred + stopped 在场 + turn 缺席（不虚构新回合）", async () => {
    await seedTeam();
    await seedRunningSession(4242);
    const killer = gracefulWorkingKill();
    const res = await attemptWake(baseReq({
      spawn: () => { throw new Error("wake-helper not found"); },
      pidAliveProbe: killer.aliveProbe,
      steer: steerDirective({ kill: killer.kill }),
    }));
    expect(res.delivered).toBe("mailbox");
    expect(res.steer?.result).toBe("deferred-next-turn");
    expect(res.steer?.reason).toContain("已终止旧回合");
    expect(res.steer?.reason).toContain("spawn 失败");
    expect(res.steer?.stopped).toEqual({ pid: 4242, graceful: true, waitedMs: expect.any(Number) });
    expect(res.steer?.turn).toBeUndefined();
  });

  it("【S5 锚点】终止成功 → 旧回合在途票据被消费（下一轮唤醒不被 15min 标记挡住）", async () => {
    await seedTeam();
    await seedRunningSession(4242);
    const { token } = await createWakeNonce(root, {
      teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now(),
      issuedToSid: "sess_b", name: "b",
    });
    const killer = gracefulWorkingKill();
    await attemptWake(baseReq({
      spawn: spawnOk([]),
      pidAliveProbe: killer.aliveProbe,
      steer: steerDirective({ kill: killer.kill }),
    }));
    const nonce = await readWakeNonce(root, token);
    expect(nonce?.used).toBe(true); // 旧票据已作废（consumeWakeNonce 置 used）
  });

  it("【S5 锚点】非 steer 唤醒 → 结果无 steer 键（既有路径零行为变化）", async () => {
    await seedTeam();
    const captured: SpawnResumeOptions[] = [];
    const res = await attemptWake(baseReq({
      reason: "message",
      spawn: spawnOk(captured),
    }));
    expect(res.delivered).toBe("wake");
    expect(res.steer).toBeUndefined();
    expect(captured[0]!.prompt).not.toContain("⛔");
  });
});

describe("v0.9.8 V097-09（D3）：回执有界二次回读", () => {
  it("【V097-09 锚点】失败证据晚于回执落盘（spawn 后 120ms）→ 补读命中 → wakeFailureSeen=true", async () => {
    await seedTeam();
    const message = createMessage("a", "b", "正文", { deliveryClaimedAt: Date.now() });
    await appendMailbox(root, "default", "b", message);
    const res = await attemptWake(baseReq({
      receiptIds: [message.id],
      watchWindowMs: 0, // 关异步侦听：只测回执时刻的补读
      env: { XC_WAKE_ENABLED: "true", XC_WAKE_RECEIPT_RECHECK_MS: "50", XC_WAKE_RECEIPT_RECHECK_ROUNDS: "8" },
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(7777);
        // 生产形态：spawnResume 先建日志文件（openSync），子进程随后才写内容。
        mkdirSync(dirname(opts.logFile), { recursive: true });
        writeFileSync(opts.logFile, "", "utf8");
        // 单次回读之后才落盘的失败证据（旧行为的竞态窗口）。
        setTimeout(() => {
          try { appendFileSync(opts.logFile, "Error: Session not found: sess_b\n"); } catch { /* 清理竞态 */ }
        }, 120);
        return { pid: 7777, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    expect(res.wakeFailureSeen).toBe(true);
    expect(res.failureEvidence).toContain("Session not found");
    expect(res.note).toContain("失败侦听");
  });

  it("【V097-09 锚点】补读关闭（ROUNDS=0）→ 回退旧行为：迟到证据不进回执（由 wake-failed 事件兜底）", async () => {
    await seedTeam();
    const res = await attemptWake(baseReq({
      watchWindowMs: 0,
      env: { XC_WAKE_ENABLED: "true", XC_WAKE_RECEIPT_RECHECK_ROUNDS: "0" },
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(7777);
        mkdirSync(dirname(opts.logFile), { recursive: true });
        writeFileSync(opts.logFile, "", "utf8");
        setTimeout(() => {
          try { appendFileSync(opts.logFile, "Error: Session not found: sess_b\n"); } catch { /* 清理竞态 */ }
        }, 120);
        return { pid: 7777, logFile: opts.logFile };
      },
    }));
    expect(res.wakeFailureSeen).toBeUndefined();
  });

  it("【V097-09 边界】日志文件不存在 → 不补读（零等待；既有「未见证据」形态不变）", async () => {
    await seedTeam();
    const started = Date.now();
    const res = await attemptWake(baseReq({
      watchWindowMs: 0,
      env: { XC_WAKE_ENABLED: "true", XC_WAKE_RECEIPT_RECHECK_MS: "300", XC_WAKE_RECEIPT_RECHECK_ROUNDS: "2" },
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        opts.onHelperSpawned?.(7777);
        return { pid: 7777, logFile: opts.logFile }; // 不建日志文件
      },
    }));
    expect(res.wakeFailureSeen).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(400); // 没有 600ms 补读等待
  });
});

describe("v0.9.8 R1：队友名单进唤醒 prompt", () => {
  it("【R1 锚点】wake to b → prompt identity 段后带「队友：a, c（可 xc_relay 直连，不必经过 lead）」", async () => {
    await seedTeam();
    const captured: SpawnResumeOptions[] = [];
    await attemptWake(baseReq({ reason: "message", spawn: spawnOk(captured) }));
    const prompt = captured[0]!.prompt;
    expect(prompt).toContain("队友：a, c");
    expect(prompt).toContain('xc_relay({to:"a"})');
    expect(prompt).toContain("不必经过 lead");
    // 队友行在身份段之后、行动行之前（message 场景行动行 = 「正文已内嵌…」）。
    expect(prompt.indexOf("队友：")).toBeGreaterThan(prompt.indexOf("sessionId=sess_b"));
    expect(prompt.indexOf("队友：")).toBeLessThan(prompt.indexOf("正文已内嵌"));
  });

  it("【R1 锚点】单人队（无队友）→ 不附队友行（无噪声）", async () => {
    const team = newTeamState({ teamId: "default", founderKey: "b", now: Date.now() });
    team.members.push({ key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1, identity: "engine" });
    await writeTeam(root, team);
    const captured: SpawnResumeOptions[] = [];
    await attemptWake(baseReq({ reason: "message", spawn: spawnOk(captured) }));
    expect(captured[0]!.prompt).not.toContain("队友：");
  });
});
