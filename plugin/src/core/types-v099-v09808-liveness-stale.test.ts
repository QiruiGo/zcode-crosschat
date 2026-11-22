/**
 * v0.9.9（组 H）定向测试：**V098-08（P3）活性自述无陈旧上限 + pid 只验存活不验身份**。
 *
 * 缺陷形态（adv-1 G2/F2）：
 * 1. `plausibleLivenessTs` 只拒未来值，**无陈旧上限**——一张 2h 前的 `running` 自述 +
 *    OS pid 复用，就能让 steer 判「有活唤醒回合」→ preempted → 强杀一个与插件毫无关系的
 *    旁观进程（回执还不披露记录陈旧）；
 * 2. pid 判据只 `process.kill(pid,0)` 验存活，**不验身份**——复用后的 pid 属于谁完全
 *    不问。
 *
 * 修法与覆盖（任务书：「加陈旧上限（如 livenessTs 超过 N 分钟不判 running）；pid 判据补
 * 命令行/进程名校校（可及则做，不可及如实声明）」；验收：「陈旧记录 + pid 复用 → 不判活、
 * 不误杀」）：
 *   1. 【陈旧上限·durable boundary】无心跳通道的记录，livenessTs 老于
 *      LIVENESS_TS_STALE_MS → 时刻被丢（running 自述失去可信时刻）；
 *   2. 【不误伤长回合】带心跳通道（lastEventTs）的记录，回合开始久但心跳新鲜 → 自述可信
 *      （V094-13/V095-07 锚点：长回合进程猝死仍要判 pid-dead，不能被回合开始一票否决）；
 *   3. 【端到端·不误杀】G2 原形（陈旧无心跳记录 + 活旁观 pid + boundName）→ steer 判
 *      deferred-next-turn、kill 零调用；对照：新鲜记录照常 preempted + 终止（功能不减）；
 *   4. 【pid 身份判据】probePidResumeClaim 三态：confirmed（cmdline 是 --resume <sid>）/
 *      refuted（可读但不是本会话唤醒子）/ unknown（不可读——调用方须按「未核验」披露）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSession } from "./registry.js";
import { newTeamState, writeTeam } from "./teamstate.js";
import { attemptWake } from "../engine/wake.js";
import {
  LIVENESS_TS_STALE_MS,
  LIVENESS_TS_FUTURE_SKEW_MS,
  coerceSessionRecord,
  plausibleLivenessTs,
} from "./types.js";
import { probeHostResumeSidSync, probePidResumeClaim } from "./registry.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-v099-h08-"));
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

// ---------------------------------------------------------------------------
// 1+2：durable boundary 的陈旧上限（coerceSessionRecord）
// ---------------------------------------------------------------------------

describe("v0.9.9 V098-08：livenessTs 陈旧上限（durable boundary，G2 修）", () => {
  const base = (now: number) => ({ sessionId: "s-x", cwd: "", startedAt: now - 3_600_000, lastSeen: now });

  it("【锚点】无心跳通道 + running 自述 2h 前（G2 原形）→ livenessTs 丢弃、liveness 保留（异常面可记账）", () => {
    const now = Date.now();
    const parsed = coerceSessionRecord(
      { ...base(now), liveness: "running", livenessTs: now - 2 * 3_600_000, pid: 4242 },
      "s-x",
      now,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.livenessTs).toBeUndefined(); // 陈旧：时刻不可信
    expect(parsed.record.liveness).toBe("running"); // 自述字段保留（不静默消失）
    expect(parsed.record.pid).toBe(4242); // pid 证据不受影响
  });

  it("【锚点】无心跳通道 + running 自述新鲜（<30min）→ livenessTs 保留（正常回合不误伤）", () => {
    const now = Date.now();
    const parsed = coerceSessionRecord(
      { ...base(now), liveness: "running", livenessTs: now - 30_000, pid: 4242 },
      "s-x",
      now,
    );
    expect(parsed.ok && parsed.record.livenessTs).toBe(now - 30_000);
  });

  it("【锚点·不误伤长回合】有心跳通道 + 回合开始 2h 前但 lastEventTs 90s 前 → livenessTs 保留（心跳是更新的佐证）", () => {
    const now = Date.now();
    const parsed = coerceSessionRecord(
      {
        ...base(now),
        liveness: "running",
        livenessTs: now - 2 * 3_600_000,
        lastEventTs: now - 90_000,
        pid: 4242,
      },
      "s-x",
      now,
    );
    // V094-13/V095-07 锚点形态：长回合（工具调用不断 → 心跳新鲜）进程猝死仍要判
    // pid-dead；回合开始时刻不得一票否决长回合。
    expect(parsed.ok && parsed.record.livenessTs).toBe(now - 2 * 3_600_000);
    expect(parsed.ok && parsed.record.lastEventTs).toBe(now - 90_000);
  });

  it("【边界】未来值仍拒（既有 V090-01 口径不回归）：> now+5min 丢、容差内收", () => {
    const now = Date.now();
    const far = coerceSessionRecord(
      { ...base(now), liveness: "running", livenessTs: now + LIVENESS_TS_FUTURE_SKEW_MS + 60_000 },
      "s-x",
      now,
    );
    expect(far.ok && far.record.livenessTs).toBeUndefined();
    const near = coerceSessionRecord(
      { ...base(now), liveness: "running", livenessTs: now + 60_000, lastEventTs: now },
      "s-x",
      now,
    );
    expect(near.ok && near.record.livenessTs).toBe(now + 60_000);
  });

  it("【边界】lastEventTs 不受陈旧上限影响（心跳时刻的新鲜窗由各消费面自己裁决）", () => {
    const now = Date.now();
    const parsed = coerceSessionRecord(
      { ...base(now), liveness: "running", livenessTs: now - 30_000, lastEventTs: now - 2 * 3_600_000 },
      "s-x",
      now,
    );
    // 有心跳通道 ⇒ livenessTs 不套陈旧窗；lastEventTs 本身只做未来值校验（旧口径）。
    expect(parsed.ok && parsed.record.livenessTs).toBe(now - 30_000);
    expect(parsed.ok && parsed.record.lastEventTs).toBe(now - 2 * 3_600_000);
  });

  it("【纯函数】plausibleLivenessTs 第三参 maxAgeMs：缺省语义不变、显式给出即生效", () => {
    const now = 1_000_000_000_000;
    expect(plausibleLivenessTs(now - 10_000, now)).toBe(true); // 缺省：无陈旧上限
    expect(plausibleLivenessTs(now - 10_000, now, LIVENESS_TS_STALE_MS)).toBe(true);
    expect(plausibleLivenessTs(now - LIVENESS_TS_STALE_MS - 1, now, LIVENESS_TS_STALE_MS)).toBe(false);
    expect(plausibleLivenessTs(now + 60_000, now, LIVENESS_TS_STALE_MS)).toBe(true); // 容差内未来值仍收
    expect(plausibleLivenessTs(now + LIVENESS_TS_FUTURE_SKEW_MS + 1, now, LIVENESS_TS_STALE_MS)).toBe(false);
    expect(plausibleLivenessTs(undefined, now, LIVENESS_TS_STALE_MS)).toBe(false);
    expect(plausibleLivenessTs(0, now, LIVENESS_TS_STALE_MS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3：端到端（attemptWake 真路径）——G2 原形不再误杀
// ---------------------------------------------------------------------------

describe("v0.9.9 V098-08：陈旧记录 + pid 复用 → steer 不判活、不误杀（端到端）", () => {
  async function seedTeam(): Promise<void> {
    const now = Date.now();
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now,
      founder: { key: "a", sessionId: "s-lead", role: "worker", joinedAt: now, lastSeen: now },
    });
    team.members.push({
      key: "m1",
      sessionId: "sess-m1",
      role: "worker",
      joinedAt: now,
      lastSeen: now,
      identity: "engine",
    });
    await writeTeam(root, team);
  }

  /** steer 一发（终止/存活/spawn 全注入；绝不真杀进程）。 */
  async function steer(spy: {
    calls: { pid: number; force: boolean }[];
    kill: (pid: number, force: boolean) => { ok: boolean };
    aliveProbe: () => boolean;
  }): Promise<{ result?: string; reason?: string }> {
    const res = await attemptWake({
      stateRoot: root,
      teamId: "default",
      toAgentKey: "m1",
      toSessionId: "sess-m1",
      workspace: "D:\\ws",
      reason: "steer",
      receiptIds: [],
      ticket: "纠偏：先 dry-run",
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
      pidAliveProbe: spy.aliveProbe,
      spawn: () => ({ pid: 7777, logFile: "unused" }),
      steer: { by: "a", kill: spy.kill, sleep: async () => {} },
    });
    return {
      ...(res.steer?.result !== undefined ? { result: res.steer.result } : {}),
      ...(res.steer?.reason !== undefined ? { reason: res.steer.reason } : {}),
    };
  }

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

  it("【验收锚点】G2 原形：2h 前 running 自述（无心跳）+ boundName + 活旁观 pid → deferred-next-turn，kill 零调用", async () => {
    await seedTeam();
    const now = Date.now();
    // adv-1 s5c 的记录形状：boundName 保留、livenessTs 2h 前、pid=旁观进程、无 lastEventTs。
    await writeSession(root, {
      sessionId: "sess-m1",
      cwd: "D:\\ws",
      startedAt: now - 3_600_000,
      lastSeen: now - 2 * 3_600_000,
      boundName: "m1",
      liveness: "running",
      livenessTs: now - 2 * 3_600_000,
      pid: 4242,
    });
    const spy = killSpy();
    const res = await steer(spy);
    expect(res.result).toBe("deferred-next-turn"); // 不判活
    expect(spy.calls).toEqual([]); // 不误杀（旧行为在此 preempted + 强杀旁观进程）
  });

  it("【功能不减】新鲜 running 自述（无心跳）→ 照常 preempted + 终止（修复不误伤合法抢占）", async () => {
    await seedTeam();
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess-m1",
      cwd: "D:\\ws",
      startedAt: now - 60_000,
      lastSeen: now,
      boundName: "m1",
      liveness: "running",
      livenessTs: now - 30_000,
      pid: 4242,
    });
    const spy = killSpy();
    const res = await steer(spy);
    expect(res.result).toBe("preempted");
    expect(spy.calls).toEqual([{ pid: 4242, force: false }]);
  });

  it("【不误伤长回合】2h 前回合开始 + 90s 前心跳（工具调用不断的长回合）→ 照常 preempted", async () => {
    await seedTeam();
    const now = Date.now();
    await writeSession(root, {
      sessionId: "sess-m1",
      cwd: "D:\\ws",
      startedAt: now - 3_600_000,
      lastSeen: now - 90_000,
      boundName: "m1",
      liveness: "running",
      livenessTs: now - 2 * 3_600_000,
      lastEventTs: now - 90_000,
      pid: 4242,
    });
    const spy = killSpy();
    const res = await steer(spy);
    expect(res.result).toBe("preempted");
    expect(spy.calls).toEqual([{ pid: 4242, force: false }]);
  });
});

// ---------------------------------------------------------------------------
// 4：pid 身份判据（probePidResumeClaim / probeHostResumeSidSync）
// ---------------------------------------------------------------------------

describe("v0.9.9 V098-08：pid 身份判据（命令行自证 --resume <sid>；可及则做，不可及如实声明）", () => {
  const WIN_CLI = "C:\\ZCode.exe C:\\resources\\glm\\zcode.cjs --resume sess-m1 --prompt hi";

  it("【锚点】cmdline 是 --resume <本 sid> → confirmed", () => {
    expect(probePidResumeClaim(4242, "sess-m1", { readCommandLine: () => WIN_CLI })).toBe("confirmed");
  });

  it("【锚点】cmdline 可读但 resume 的是别的 sid / 没有该 token（桌面宿主）→ refuted", () => {
    expect(probePidResumeClaim(4242, "sess-m1", {
      readCommandLine: () => "C:\\ZCode.exe zcode.cjs --resume sess-other --prompt hi",
    })).toBe("refuted");
    expect(probePidResumeClaim(4242, "sess-m1", {
      readCommandLine: () => "C:\\Program Files\\ZCode\\ZCode.exe --type=renderer",
    })).toBe("refuted");
  });

  it("【锚点】cmdline 不可读（枚举失败/超时/权限）→ unknown（调用方须按「未核验」披露）", () => {
    expect(probePidResumeClaim(4242, "sess-m1", { readCommandLine: () => undefined })).toBe("unknown");
    expect(probePidResumeClaim(0, "sess-m1", { readCommandLine: () => WIN_CLI })).toBe("unknown");
    expect(probePidResumeClaim(-1, "sess-m1", { readCommandLine: () => WIN_CLI })).toBe("unknown");
  });

  it("【边界】sid 空串 → refuted（无从自证即不认）；引号/路径分隔归一化", () => {
    expect(probePidResumeClaim(4242, "", { readCommandLine: () => WIN_CLI })).toBe("refuted");
    // 引号包裹的 sid 与反斜杠混用都要能解析（probeHostResumeSidSync 归一化口径）。
    expect(probePidResumeClaim(4242, "sess-m1", {
      readCommandLine: () => 'C:/ZCode.exe zcode.cjs --resume "sess-m1" --prompt hi',
    })).toBe("confirmed");
  });

  it("【兼容】probeHostResumeSidSync 既有语义不回归（available/resumeSid 两形态）", () => {
    expect(probeHostResumeSidSync(4242, { readCommandLine: () => WIN_CLI }))
      .toEqual({ available: true, resumeSid: "sess-m1" });
    expect(probeHostResumeSidSync(4242, { readCommandLine: () => "desktop app" }))
      .toEqual({ available: true });
    expect(probeHostResumeSidSync(4242, { readCommandLine: () => undefined }))
      .toEqual({ available: false });
    expect(probeHostResumeSidSync(0)).toEqual({ available: false });
  });
});
