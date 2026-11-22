/**
 * v0.9.9（组 H）定向测试：**V098-01（P2）钩子票据路径自签 boundName → steer 误杀交互宿主**。
 *
 * 缺陷形态（adv-1 G1，v0.9.8 对抗轮回归）：v0.9.8 给 classifySteerTarget 加了无头持有者
 * 校验（`record.boundName === member.key`），其可信度押在「boundName 唯一写入路径 =
 * member-add 供给代写」上——但钩子的**唤醒票据消费路径**（bindWakeTicketIdentity，门控
 * XC_ADOPT_BY_PPID=1）也在写会话记录 boundName。完整生产序列（opt-in 档）：
 *   1. 交互会话 takeover 已死引擎成员花名（行 sid=交互 sid，identity 粘滞 engine）；
 *   2. 对该行发 steer/消息（wake_enabled=true）→ 唤醒给交互 sid 留下未消费票据；
 *   3. 交互会话重启/resume 同一 sid → SessionStart 钩子按 sid 消费票据 → 把
 *      boundName=<花名> 写进**交互会话自己的记录**（自签）；
 *   4. 再发 steer → 分类看到「无头持有者」→ preempted → 强杀交互宿主 + 回执谎称抢占。
 *
 * 本文件的复现与验收（任务书：「自签序列复现失败；缺省/开启档都不误杀交互宿主」）：
 *   1. 【自签序列】开启档完整跑 1→3→4：票据被消费、身份绑定落地，但会话记录
 *      **不出现 boundName**（只出现专用记账标记 wakeTicketBound）→ 第 2 发 steer 判
 *      unsupported、kill 注入面零调用（自签失败）；
 *   2. 【缺省档】XC_ADOPT_BY_PPID 未设 → 票据根本不消费（留给模型回合 wakeToken 兜底）
 *      → 同样不误杀；
 *   3. 【功能不减】真引擎成员（member-add 代写 boundName 的供给形态）走完钩子 +
 *      steer → 照常 preempted + 终止（修复不误伤合法抢占）；
 *   4. 【durable boundary】wakeTicketBound 的形状宽容增量（合法收、非法丢字段）。
 *
 * 依赖隔离：shared.js 的 stdin/上下文/发射面 mock（session-start-v094-a6.test.ts 同款）；
 * registry/teamstate/peerdir/wake 全真跑临时 stateRoot 与临时 peer 根（env 钉住）。
 * steer 的终止面经 WakeRequest.steer.kill 注入（绝不真杀进程）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  peerRoot: "",
  stateRoot: "",
  sessionId: undefined as string | undefined,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    readStdinPayload: vi.fn(() => undefined),
    resolveHookContext: vi.fn(() => ({
      workspace: join(tmpdir(), "xc-v099-h-ws"),
      stateRoot: h.stateRoot,
      sessionId: h.sessionId,
      event: "SessionStart",
    })),
    emitAdditionalContext: vi.fn(),
    logHookEvent: vi.fn(async () => {}),
    auditHookFailure: vi.fn(async () => {}),
    peerRootFromEnv: vi.fn(() => h.peerRoot),
    readHookPermissionMode: vi.fn(() => undefined),
  };
});

// 票据消费成功后钩子会跑 writeAdoptAnchorsForHostServers（真实 PowerShell CIM 探测宿主
// cmdline，单拍 ~0.7s；宿主无 --resume → 跳过轮询）——与 session-start-v094-a6.test.ts
// 同款只放宽时间预算、不放宽断言。
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];

beforeEach(() => {
  h.stateRoot = mkdtempSync(join(tmpdir(), "xc-v099-h01-st-"));
  h.peerRoot = mkdtempSync(join(tmpdir(), "xc-v099-h01-peers-"));
  h.sessionId = undefined;
  dirs.push(h.stateRoot, h.peerRoot);
});

afterEach(() => {
  delete process.env["XC_ADOPT_BY_PPID"];
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

/** 交互会话 takeover 后的队形：m1 行 sid 已是交互 sid、identity 粘滞 engine；lead a 在册。 */
async function seedTakeoverTeam(): Promise<void> {
  const { newTeamState, writeTeam } = await import("../core/teamstate.js");
  const now = Date.now();
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now,
    founder: { key: "a", sessionId: "s-lead", role: "worker", joinedAt: now, lastSeen: now },
  });
  team.members.push({
    key: "m1",
    sessionId: "s-m1-takeover", // 交互会话的 sid（takeover 后行 sid 换成它）
    role: "worker",
    joinedAt: now,
    lastSeen: now,
    identity: "engine", // 粘滞标：谁建了这行，不证明当前持有者还是无头会话
  });
  await writeTeam(h.stateRoot, team);
}

/** 签一张唤醒票据（引擎给行当前 sid 的形态：sid=issuedToSid=交互 sid）。 */
async function seedTicket(agentKey: string, sid: string): Promise<string> {
  const { createWakeNonce } = await import("../core/registry.js");
  const { token } = await createWakeNonce(h.stateRoot, {
    teamId: "default",
    agentKey,
    sid,
    voiceOwner: sid,
    issuedToSid: sid,
    name: agentKey,
  });
  return token;
}

async function runHook(sessionId: string): Promise<void> {
  h.sessionId = sessionId;
  const { runSessionStartHook } = await import("./session-start.js");
  await runSessionStartHook();
}

async function readRecord(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const { readSession } = await import("../core/registry.js");
  return (await readSession(h.stateRoot, sessionId)) as Record<string, unknown> | undefined;
}

/** kill 注入面：记录每次调用，绝不死进程；配合 alive 旗标让终止轮询看到「进程已退出」。 */
function killSpy(): {
  calls: { pid: number; force: boolean }[];
  kill: (pid: number, force: boolean) => { ok: boolean };
  aliveProbe: () => boolean;
} {
  const calls: { pid: number; force: boolean }[] = [];
  let alive = true;
  return {
    calls,
    kill: (pid, force) => { calls.push({ pid, force }); alive = false; return { ok: true }; },
    aliveProbe: () => alive,
  };
}

/** 对 m1 发一发 steer（终止面可注；spawn 也注死，避免真拉起无头 CLI）。 */
async function steerM1(spy: ReturnType<typeof killSpy>): Promise<{
  result?: string; reason?: string; delivered: string;
}> {
  const { attemptWake } = await import("../engine/wake.js");
  const res = await attemptWake({
    stateRoot: h.stateRoot,
    teamId: "default",
    toAgentKey: "m1",
    toSessionId: "s-m1-takeover",
    workspace: join(tmpdir(), "xc-v099-h-ws"),
    reason: "steer",
    receiptIds: [],
    ticket: "别删生产库，先跑 dry-run",
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
    capacitySample: {
      sampledAt: Date.now(),
      totalBytes: 16 * 1024 ** 3,
      freeBytes: 8 * 1024 ** 3,
      watermark: 0.5,
      steadyTreeBytes: 1 * 1024 ** 3,
      headlessTurnCount: 0,
      headlessTurnMaxRssBytes: null,
      degraded: null,
    },
    watchWindowMs: 0,
    limboTimeoutMs: 3_600_000,
    wakeSlowMs: 3_600_000,
    fakeSuccessMs: 3_600_000,
    lifecycleWindowMs: 100,
    // 进程活着（pid 存活的注入面；kill 命中即翻旗标）——第 4 步若误判「无头持有者」
    // 就会走到终止分支，旗标不翻则终止轮询判失败（S2 语义）。
    pidAliveProbe: spy.aliveProbe,
    spawn: () => ({ pid: 7777, logFile: "unused" }),
    steer: { by: "a", kill: spy.kill, sleep: async () => {} },
  });
  return {
    ...(res.steer?.result !== undefined ? { result: res.steer.result } : {}),
    ...(res.steer?.reason !== undefined ? { reason: res.steer.reason } : {}),
    delivered: res.delivered,
  };
}

/** 交互会话自己的会话记录（ takeover 形态）：活回合、有 pid、**无 boundName**。 */
async function seedInteractiveRecord(): Promise<void> {
  const { writeSession } = await import("../core/registry.js");
  const now = Date.now();
  await writeSession(h.stateRoot, {
    sessionId: "s-m1-takeover",
    cwd: "D:\\ws",
    startedAt: now - 60_000,
    lastSeen: now,
    liveness: "running",
    livenessTs: now - 30_000,
    pid: 4242,
  });
}

describe("v0.9.9 V098-01（P2）：钩子票据路径不得自签会话记录 boundName（steer 不误杀交互宿主）", () => {
  it("【锚点·自签序列复现失败】开启档完整序列（takeover → 票据 → 钩子自签 → 第 2 发 steer）→ 记录无 boundName、steer=unsupported、kill 零调用", async () => {
    process.env["XC_ADOPT_BY_PPID"] = "1"; // 运营者显式开启 ppid 采纳（adv-1 G1 的触发档）
    await seedTakeoverTeam();
    await seedInteractiveRecord(); // 交互会话自己在跑（活回合 + pid，无 boundName）
    const token = await seedTicket("m1", "s-m1-takeover");

    // 第 1 发 steer（钩子还没跑）：V098-01 直接路径已挡——交互接管形态判 unsupported。
    const first = await steerM1(killSpy());
    expect(first.result).toBe("unsupported");

    // 第 3 步：交互会话带开启档重启 → 钩子按 sid 消费票据并「自签」。
    await runHook("s-m1-takeover");

    // 票据确已消费、队内轴身份绑定落地（「唤醒一次到位」能力保留）。
    const { readWakeNonce } = await import("../core/registry.js");
    expect((await readWakeNonce(h.stateRoot, token))?.used).toBe(true);
    const { readNames } = await import("../core/registry.js");
    expect((await readNames(h.stateRoot))["m1"]?.sessionId).toBe("s-m1-takeover");

    // 自签失败：会话记录**没有** boundName（无头持有者判据字段），只有专用记账标记。
    const record = await readRecord("s-m1-takeover");
    expect(record?.["boundName"]).toBeUndefined();
    expect(record?.["wakeTicketBound"]).toMatchObject({ name: "m1" });
    expect(typeof (record?.["wakeTicketBound"] as { ts?: number } | undefined)?.ts).toBe("number");

    // 第 4 步：第 2 发 steer——旧行为在此 preempted + 强杀交互宿主；修复后 unsupported。
    const spy = killSpy();
    const second = await steerM1(spy);
    expect(second.result).toBe("unsupported");
    expect(second.reason).toContain("交互式接管形态"); // 回执如实说明为何不终止
    expect(spy.calls).toEqual([]); // 一个字节都不杀
  });

  it("【边界·缺省档】XC_ADOPT_BY_PPID 未设 → 票据不消费（留给 wakeToken 兜底）、不写任何标记；steer 仍 unsupported 不误杀", async () => {
    delete process.env["XC_ADOPT_BY_PPID"]; // 缺省配置（v0.9.5 起默认关）
    await seedTakeoverTeam();
    await seedInteractiveRecord();
    const token = await seedTicket("m1", "s-m1-takeover");

    await runHook("s-m1-takeover");

    const { readWakeNonce } = await import("../core/registry.js");
    expect((await readWakeNonce(h.stateRoot, token))?.used).toBeUndefined(); // 票据原封不动
    const record = await readRecord("s-m1-takeover");
    expect(record?.["boundName"]).toBeUndefined();
    expect(record?.["wakeTicketBound"]).toBeUndefined(); // 票据路径整段没跑
    const { readNames } = await import("../core/registry.js");
    expect((await readNames(h.stateRoot))["m1"]).toBeUndefined(); // 不抢绑（模型回合兜底）

    const spy = killSpy();
    const res = await steerM1(spy);
    expect(res.result).toBe("unsupported");
    expect(spy.calls).toEqual([]);
  });

  it("【功能不减】真引擎成员（member-add 代写 boundName 的供给形态）→ 钩子保留 boundName、steer 照常 preempted + 终止", async () => {
    process.env["XC_ADOPT_BY_PPID"] = "1";
    await seedTakeoverTeam();
    const token = await seedTicket("m1", "s-m1-takeover");
    // member-add 供给代写：sid 的记录带本名 boundName（无头持有者的唯一合法写入路径）。
    const { writeSession } = await import("../core/registry.js");
    const now = Date.now();
    await writeSession(h.stateRoot, {
      sessionId: "s-m1-takeover",
      cwd: "D:\\ws",
      startedAt: now - 60_000,
      lastSeen: now,
      boundName: "m1",
      liveness: "running",
      livenessTs: now - 30_000,
      pid: 4242,
    });

    await runHook("s-m1-takeover");

    // 钩子不抹供给代写的 boundName（只补记账标记 + pid 投影）。
    const record = await readRecord("s-m1-takeover");
    expect(record?.["boundName"]).toBe("m1");
    expect(record?.["wakeTicketBound"]).toMatchObject({ name: "m1" });

    // steer 照常抢占（S1 主路径不回归）：终止调用发生、回执 preempted。
    const spy = killSpy();
    const res = await steerM1(spy);
    expect(res.result).toBe("preempted");
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]!.pid).toBe(record!["pid"] as number);
  });

  it("【durable boundary】wakeTicketBound 形状宽容增量：合法收、形状不符整字段丢弃（不拒整条记录）", async () => {
    const { coerceSessionRecord } = await import("../core/types.js");
    const now = Date.now();
    const base = { sessionId: "s-x", cwd: "", startedAt: now, lastSeen: now };
    const ok = coerceSessionRecord({ ...base, wakeTicketBound: { name: "m1", ts: now - 5_000 } }, "s-x", now);
    expect(ok.ok && ok.record.wakeTicketBound).toEqual({ name: "m1", ts: now - 5_000 });
    // name 空串 / ts 非数 / 非对象：整字段丢弃，记录本身照常解析。
    for (const bad of [{ name: "", ts: now }, { name: "m1", ts: "x" }, "m1", 42, null]) {
      const parsed = coerceSessionRecord({ ...base, wakeTicketBound: bad }, "s-x", now);
      expect(parsed.ok && parsed.record.wakeTicketBound).toBeUndefined();
    }
    // 缺省（旧记录）→ 照常缺省。
    const absent = coerceSessionRecord(base, "s-x", now);
    expect(absent.ok && absent.record.wakeTicketBound).toBeUndefined();
  });
});
