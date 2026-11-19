/**
 * v0.9.0（G-9/G-5）组A 定向单测：会话活性真源（core/liveness.ts）+ registry 落盘
 * 状态机（refreshSessionLastSeen / markSessionIdle / markSessionHeartbeat）。
 *
 * 覆盖：
 * - 纯状态机 applyLivenessTransition：首标/同态（不产生迁移）/双向迁移/lastEventTs 恒刷新；
 * - sweepOwnerGuard 清扫守卫四分支：running 豁免 / 心跳窗口豁免 / 真僵尸不豁免 /
 *   dead（C8 pid-dead）压过 running；
 * - memberLivenessView 三视图统一口径：dead 派生 / 存量记录（无 liveness 字段）→ idle /
 *   ageMin 取整与钳负；
 * - registry 集成：refreshSessionLastSeen 标 running + 迁移事件恰一次（同态不刷日志）；
 *   markSessionIdle 写 idle + session-idle 事件；记录缺失 no-op；markSessionHeartbeat
 *   节流 + idle→running 自愈；锁忙静默跳过（LOCK 忙预算内让路）；
 * - coerceSessionRecord 宽容增量：新字段非法值丢弃不拒文件（§11.1 纪律）；
 * - engine.jsonl 事件命名冻结（PROTOCOL §12.4）：session-running / session-idle
 *   → timeline family=liveness。
 *
 * 端到端清扫锚点（t1/t17/t25）与三视图一致性见 mcp/liveness-sweep-views.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_IDLE_EVENT,
  SESSION_RUNNING_EVENT,
  applyLivenessTransition,
  memberLivenessView,
  sessionRecordLivenessAnomaly,
  sessionRecordWitnessMismatch,
  sweepOwnerGuard,
  type SessionWitness,
} from "./liveness.js";
import { markSessionHeartbeat, markSessionIdle, readSession, readSessionWitness, refreshSessionLastSeen, writeSession, writeSessionWitness } from "./registry.js";
import { acquireFileLock } from "./lock.js";
import { registryLockNames } from "./paths.js";
import { readTimeline } from "./timeline.js";
import { coerceSessionRecord, type SessionRecord, type TeamMember } from "./types.js";
import type { PeerScanResult } from "./peerregistry.js";
import { localPidDomain } from "./peerdir.js";
import { mkdir, writeFile } from "node:fs/promises";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xc-liveness-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理尽力而为 */
  }
});

function engineEvents(): Array<Record<string, unknown>> {
  const file = join(dir, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key: "worker-1",
    sessionId: "sess_w1",
    role: "worker",
    joinedAt: 1_000,
    lastSeen: 1_000,
    ...overrides,
  };
}

/** 空 peer 扫描（无任何记录 → memberLiveness = no-record，不判死；无端点证词）。 */
const EMPTY_SCAN: PeerScanResult = { active: [], dead: [], foreign: [], skipped: 0 };

/**
 * 端点活性证词扫描（v0.9.1 r2）：sid 的 peer 记录 pid 活（本测试进程）且心跳新鲜
 * —— memberLiveness = 'live'，sweepOwnerGuard 豁免闸放行的前提。
 */
function liveScan(sid: string, now: number): PeerScanResult {
  return {
    active: [{
      pid: process.pid,
      sessionId: sid,
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-liveness-test-${sid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "bg",
      formerNames: [],
      startedAt: now - 60_000,
      lastSeen: now,
    }],
    dead: [],
    foreign: [],
    skipped: 0,
  };
}

/** 心跳停但 pid 活的证词（伪造 peer 记录 60s 后的衰减形态 → heartbeat-stale，不满足 live）。 */
function staleButAliveScan(sid: string, now: number): PeerScanResult {
  const scan = liveScan(sid, now - 5 * 60_000);
  return scan;
}

describe("applyLivenessTransition（纯状态机）", () => {
  const base: SessionRecord = { sessionId: "s", cwd: "", startedAt: 1, lastSeen: 1 };

  it("无状态 → running：迁移产生（首标），livenessTs/lastEventTs 落 now", () => {
    const { record, transition } = applyLivenessTransition(base, "running", 5_000);
    expect(transition).toEqual({ from: null, to: "running" });
    expect(record.liveness).toBe("running");
    expect(record.livenessTs).toBe(5_000);
    expect(record.lastEventTs).toBe(5_000);
  });

  it("同态刷新：不产生迁移（防每 prompt 刷日志），lastEventTs 仍刷新", () => {
    const running: SessionRecord = { ...base, liveness: "running", livenessTs: 2_000, lastEventTs: 2_000 };
    const { record, transition } = applyLivenessTransition(running, "running", 9_000);
    expect(transition).toBeNull();
    expect(record.liveness).toBe("running");
    expect(record.livenessTs).toBe(2_000); // 状态进入时刻不变
    expect(record.lastEventTs).toBe(9_000); // 心跳恒刷新
  });

  it("running → idle → running 双向迁移（回合边界交替）", () => {
    const running: SessionRecord = { ...base, liveness: "running", livenessTs: 2_000, lastEventTs: 2_000 };
    const idle = applyLivenessTransition(running, "idle", 3_000);
    expect(idle.transition).toEqual({ from: "running", to: "idle" });
    const back = applyLivenessTransition(idle.record, "running", 4_000);
    expect(back.transition).toEqual({ from: "idle", to: "running" });
  });
});

describe("sweepOwnerGuard（G-5 清扫守卫：引擎证言为唯一输入，r3）", () => {
  const TH = 30 * 60_000;

  it("证言 running（回合中）且年龄 ≤ 2×阈值 → owner-running（t17 长任务模式）", () => {
    const now = 1_000_000_000;
    const witness: SessionWitness = { sessionId: "sess_w1", kind: "running", ts: now - 31 * 60_000 };
    expect(sweepOwnerGuard(witness, now, TH)).toBe("owner-running");
  });

  it("证言 heartbeat/idle（引擎事件）且年龄 ≤ 阈值 → heartbeat（t1 活跃等待模式）", () => {
    const now = 1_000_000_000;
    expect(sweepOwnerGuard({ sessionId: "s", kind: "heartbeat", ts: now - 10 * 60_000 }, now, TH)).toBe("heartbeat");
    expect(sweepOwnerGuard({ sessionId: "s", kind: "idle", ts: now - 10 * 60_000 }, now, TH)).toBe("heartbeat");
    // 窗口边界（恰在阈值上，<=）。
    expect(sweepOwnerGuard({ sessionId: "s", kind: "heartbeat", ts: now - TH }, now, TH)).toBe("heartbeat");
  });

  it("无证言 → null（一次外部写伪造的自述记录造不出证言；V090-01 r3 攻击形态）", () => {
    const now = 1_000_000_000;
    expect(sweepOwnerGuard(undefined, now, TH)).toBeNull();
  });

  it("有界（V090-GUIDANCE-R3）：年龄 > 2×阈值 → null，照扫（防永久滞留）", () => {
    const now = 1_000_000_000;
    // running 证言 61min 前（阈值 30min，2× = 60min）：超界 → 照扫。
    expect(sweepOwnerGuard({ sessionId: "s", kind: "running", ts: now - 61 * 60_000 }, now, TH)).toBeNull();
    // heartbeat 证言 61min 前：同样超界。
    expect(sweepOwnerGuard({ sessionId: "s", kind: "heartbeat", ts: now - 61 * 60_000 }, now, TH)).toBeNull();
    // 恰在 2× 阈值上：仍豁免（<= 边界）。
    expect(sweepOwnerGuard({ sessionId: "s", kind: "running", ts: now - 2 * TH }, now, TH)).toBe("owner-running");
  });

  it("阈值 < 年龄 ≤ 2×阈值：仅 running 证言豁免（长回合），heartbeat 证言不豁免", () => {
    const now = 1_000_000_000;
    const running45: SessionWitness = { sessionId: "s", kind: "running", ts: now - 45 * 60_000 };
    const hb45: SessionWitness = { sessionId: "s", kind: "heartbeat", ts: now - 45 * 60_000 };
    expect(sweepOwnerGuard(running45, now, TH)).toBe("owner-running");
    expect(sweepOwnerGuard(hb45, now, TH)).toBeNull();
  });

  it("自述记录与豁免无关（r3：liveness 字段仅展示）——同证言下不同自述同结果", () => {
    const now = 1_000_000_000;
    const witness: SessionWitness = { sessionId: "s", kind: "heartbeat", ts: now - 60_000 };
    // 伪造自述 running / 无自述 / 自述 idle：证言相同 → 豁免相同（heartbeat）。
    expect(sweepOwnerGuard(witness, now, TH)).toBe("heartbeat");
    // 自述 running + heartbeat 证言 = 引擎正常流（工具调用把记录拉回 running 并写心跳证言）。
    expect(sessionRecordWitnessMismatch(
      { sessionId: "s", cwd: "", startedAt: 1, lastSeen: 1, liveness: "running", livenessTs: now - 1_000 },
      witness,
      now,
    )).toBeNull();
    expect(sessionRecordWitnessMismatch(
      { sessionId: "s", cwd: "", startedAt: 1, lastSeen: 1, liveness: "idle" },
      witness,
      now,
    )).toBeNull(); // 自述 idle + 心跳证言：正常（工具调用把会话拉回活跃）
  });

  it("自述 running 而无证言 / 证言止于 idle → 异常检出（伪造签名，审计面）", () => {
    const now = 1_000_000_000;
    const forged: SessionRecord = { sessionId: "s", cwd: "", startedAt: 1, lastSeen: 1, liveness: "running", livenessTs: now - 1_000 };
    expect(sessionRecordWitnessMismatch(forged, undefined, now)).toMatchObject({ field: "liveness" });
    expect(sessionRecordWitnessMismatch(forged, { sessionId: "s", kind: "idle", ts: now - 5_000 }, now)).toMatchObject({ field: "liveness" });
    // 自述 running + running 证言：一致，无异常。
    expect(sessionRecordWitnessMismatch(forged, { sessionId: "s", kind: "running", ts: now - 5_000 }, now)).toBeNull();
    // 自述非 running：不检测。
    expect(sessionRecordWitnessMismatch({ sessionId: "s", cwd: "", startedAt: 1, lastSeen: 1 }, undefined, now)).toBeNull();
  });
});

describe("memberLivenessView（三视图统一口径）", () => {
  it("running/idle 记录：state + stateAgeMin + lastEventAgeMin + endpointLive（分钟取整，负值钳 0）", () => {
    const now = 10 * 60_000;
    const record: SessionRecord = {
      sessionId: "sess_w1", cwd: "", startedAt: 0, lastSeen: now,
      liveness: "running", livenessTs: now - 90_000, lastEventTs: now - 119_500,
    };
    const view = memberLivenessView(member(), record, EMPTY_SCAN, now);
    expect(view).toEqual({ state: "running", stateAgeMin: 2, lastEventAgeMin: 2, endpointLive: false });
    expect(memberLivenessView(member(), record, liveScan("sess_w1", now), now)).toEqual({
      state: "running", stateAgeMin: 2, lastEventAgeMin: 2, endpointLive: true,
    });
    // 时钟回拨 → 钳 0（不出负数）。
    const future: SessionRecord = { ...record, lastEventTs: now + 60_000 };
    expect(memberLivenessView(member(), future, EMPTY_SCAN, now).lastEventAgeMin).toBe(0);
  });

  it("存量记录（无 liveness 字段）→ idle（保守），无 lastEventTs → age null", () => {
    const legacy: SessionRecord = { sessionId: "sess_w1", cwd: "", startedAt: 1, lastSeen: 1 };
    expect(memberLivenessView(member(), legacy, EMPTY_SCAN, 1_000)).toEqual({
      state: "idle",
      stateAgeMin: null,
      lastEventAgeMin: null,
      endpointLive: false,
    });
    expect(memberLivenessView(member(), undefined, EMPTY_SCAN, 1_000)).toMatchObject({ state: "idle", endpointLive: false });
  });
});

describe("registry 落盘状态机（hooks/工具心跳的接入点）", () => {
  it("refreshSessionLastSeen 默认标 running + 迁移事件恰一次；同态再刷不重复落事件", async () => {
    const first = await refreshSessionLastSeen(dir, "sess_a", { now: 1_000 });
    expect(first.liveness).toBe("running");
    expect(first.livenessTs).toBe(1_000);
    expect(first.lastEventTs).toBe(1_000);
    let events = engineEvents().filter((e) => e["event"] === SESSION_RUNNING_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: "sess_a", prev: null, state: "running" });
    // 刻意不用 from/to 键名：时间线 actor 链（from/to 在链上）不吃状态字符串。
    expect(events[0]).not.toHaveProperty("from");
    expect(events[0]).not.toHaveProperty("to");

    // 同态再刷：记录 lastEventTs 前进，engine.jsonl 不加行。
    const second = await refreshSessionLastSeen(dir, "sess_a", { now: 2_000 });
    expect(second.liveness).toBe("running");
    expect(second.lastEventTs).toBe(2_000);
    expect(engineEvents().filter((e) => e["event"] === SESSION_RUNNING_EVENT)).toHaveLength(1);
  });

  it("markSessionIdle：idle→running 迁移事件成对；同态静默；记录缺失 no-op", async () => {
    await refreshSessionLastSeen(dir, "sess_a", { now: 1_000 });
    const t1 = await markSessionIdle(dir, "sess_a", { now: 2_000 });
    expect(t1).toEqual({ from: "running", to: "idle" });
    expect((await readSession(dir, "sess_a"))?.liveness).toBe("idle");
    // 同态再停：无迁移、无事件。
    expect(await markSessionIdle(dir, "sess_a", { now: 3_000 })).toBeNull();
    expect(engineEvents().filter((e) => e["event"] === SESSION_IDLE_EVENT)).toHaveLength(1);
    // 记录缺失：no-op。
    expect(await markSessionIdle(dir, "sess_missing", { now: 4_000 })).toBeNull();
  });

  it("markSessionHeartbeat：刷新 lastEventTs；30s 节流不重写；idle 记录自愈 running", async () => {
    await refreshSessionLastSeen(dir, "sess_a", { now: 0 });
    await markSessionIdle(dir, "sess_a", { now: 10_000 });
    // 节流：10s 内（<30s）不重写（lastEventTs 保留 idle 标记时的值）。
    await markSessionHeartbeat(dir, "sess_a", { now: 20_000 });
    let record = (await readSession(dir, "sess_a"))!;
    expect(record.lastEventTs).toBe(10_000);
    // 过节流窗：心跳刷新 + idle→running 自愈（工具调用只能在回合内发生）+ 迁移事件。
    await markSessionHeartbeat(dir, "sess_a", { now: 45_000 });
    record = (await readSession(dir, "sess_a"))!;
    expect(record.lastEventTs).toBe(45_000);
    expect(record.liveness).toBe("running");
    expect(engineEvents().filter((e) => e["event"] === SESSION_RUNNING_EVENT)).toHaveLength(2);
  });

  it("锁忙（文件锁被占）：markSessionIdle 按 waitMs 让路并显式抛 LockBusyError（钩子捕获降级）", async () => {
    await refreshSessionLastSeen(dir, "sess_a", { now: 1_000 });
    // 直接占住 registry 文件锁（绕过进程内互斥——锁忙只在跨进程发生，进程内
    // withRegistryLock 经 withProcessLock 串行化，无法自锁）。
    const names = registryLockNames(dir);
    const held = await acquireFileLock(dir, names.file, { waitMs: 1_000 });
    try {
      await expect(markSessionIdle(dir, "sess_a", { now: 2_000, waitMs: 50 })).rejects.toThrow();
    } finally {
      await held.release();
    }
    // 锁让路后重试：正常标记（from running——首标已置 running）。
    expect(await markSessionIdle(dir, "sess_a", { now: 3_000 })).toEqual({ from: "running", to: "idle" });
  });

  it("coerceSessionRecord：活性三字段宽容增量（非法值整字段丢弃，不拒文件）", () => {
    const parsed = coerceSessionRecord(
      {
        sessionId: "sess_a", cwd: "", startedAt: 1, lastSeen: 2,
        liveness: "zombie", livenessTs: "not-a-number", lastEventTs: 5,
      },
      "sess_a",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.record.liveness).toBeUndefined(); // 枚举外丢弃
      expect(parsed.record.livenessTs).toBeUndefined(); // 非数丢弃
      expect(parsed.record.lastEventTs).toBe(5); // 合法值保留
    }
  });
});

describe("活性字段信任规则（v0.9.1 V090-01：未来值/无时刻的 running 不可信）", () => {
  const now = 10 * 60_000;

  it("running 无 livenessTs（伪造形态）→ 视图降级 idle + 未来值异常检出；守卫只认证言（无证言不豁免）", () => {
    const forged: SessionRecord = { sessionId: "sess_w1", cwd: "", startedAt: 1, lastSeen: now, liveness: "running" };
    expect(memberLivenessView(member(), forged, EMPTY_SCAN, now)).toMatchObject({
      state: "idle", stateAgeMin: null, lastEventAgeMin: null, endpointLive: false,
    });
    expect(sweepOwnerGuard(undefined, now, 30 * 60_000)).toBeNull(); // 无证言 → 不豁免
    expect(sessionRecordLivenessAnomaly(forged, now)).toMatchObject({ field: "livenessTs" });
  });

  it("running 的 livenessTs 在未来（> now + 5min 容差）→ 同上降级；容差内可信", () => {
    const far: SessionRecord = { sessionId: "s", cwd: "", startedAt: 1, lastSeen: now, liveness: "running", livenessTs: now + 6 * 60_000 };
    expect(memberLivenessView(member(), far, EMPTY_SCAN, now).state).toBe("idle");
    expect(sweepOwnerGuard(undefined, now, 30 * 60_000)).toBeNull();
    const near: SessionRecord = { ...far, livenessTs: now + 60_000 };
    expect(memberLivenessView(member(), near, EMPTY_SCAN, now).state).toBe("running"); // ≤5min 容差 → 可信
    expect(sessionRecordLivenessAnomaly(near, now)).toBeNull();
  });

  it("lastEventTs 未来值：心跳恒真不再成立（now-last<=threshold 被可信度前置）", () => {
    const yearMs = 365 * 24 * 60 * 60_000;
    const forged: SessionRecord = { sessionId: "s", cwd: "", startedAt: 1, lastSeen: now, lastEventTs: now + yearMs };
    // 伪造 +1年：now - last 为大负数，旧判据 `now - last <= thresholdMs` 恒真 → 永久豁免；
    // 修复后可信度前置 → 不豁免。
    expect(now - (forged.lastEventTs as number) <= 30 * 60_000).toBe(true); // 旧判据确实恒真（缺陷本体）
    expect(sweepOwnerGuard(undefined, now, 30 * 60_000)).toBeNull();
    expect(memberLivenessView(member(), forged, EMPTY_SCAN, now).lastEventAgeMin).toBeNull(); // 不钳 0 展示
    expect(sessionRecordLivenessAnomaly(forged, now)).toMatchObject({ field: "lastEventTs" });
  });

  it("可信记录 + 证言：无异常、豁免照常（防御纵深不误伤）", () => {
    const good: SessionRecord = {
      sessionId: "s", cwd: "", startedAt: 1, lastSeen: now,
      liveness: "running", livenessTs: now - 60_000, lastEventTs: now - 60_000,
    };
    expect(sessionRecordLivenessAnomaly(good, now)).toBeNull();
    expect(sessionRecordWitnessMismatch(good, { sessionId: "s", kind: "running", ts: now - 60_000 }, now)).toBeNull();
    expect(sweepOwnerGuard({ sessionId: "s", kind: "running", ts: now - 60_000 }, now, 30 * 60_000)).toBe("owner-running");
    expect(sweepOwnerGuard({ sessionId: "s", kind: "heartbeat", ts: now - 10 * 60_000 }, now, 30 * 60_000)).toBe("heartbeat");
    const idleFresh: SessionRecord = { ...good, liveness: "idle", livenessTs: now - 10 * 60_000 };
    expect(sessionRecordLivenessAnomaly(idleFresh, now)).toBeNull();
  });

  it("coerceSessionRecord：未来值字段读盘即丢弃（durable boundary），容差内保留", async () => {
    const { coerceSessionRecord } = await import("./types.js");
    const realNow = Date.now();
    const parsed = coerceSessionRecord(
      {
        sessionId: "sess_a", cwd: "", startedAt: 1, lastSeen: 2,
        liveness: "running",
        livenessTs: realNow + 365 * 24 * 60 * 60_000, // +1 年：伪造
        lastEventTs: realNow + 60_000, // +1min：容差内
      },
      "sess_a",
      realNow,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.record.livenessTs).toBeUndefined(); // 未来值丢弃
      expect(parsed.record.lastEventTs).toBe(realNow + 60_000); // 容差内保留
      expect(parsed.record.liveness).toBe("running");
    }
  });
});

describe("引擎证言 IO（registry/witness/<sid>.json，V090-01 r3 豁免输入）", () => {
  it("refreshSessionLastSeen / markSessionIdle / markSessionHeartbeat 三写点同步证言", async () => {
    // 回合开始（hook）→ 证言 running。
    await refreshSessionLastSeen(dir, "sess_w", { now: 1_000_000 });
    expect(await readSessionWitness(dir, "sess_w")).toEqual({ sessionId: "sess_w", kind: "running", ts: 1_000_000 });
    // 工具调用心跳（30s 节流窗外）→ 证言 heartbeat。
    await markSessionHeartbeat(dir, "sess_w", { now: 1_031_000 });
    expect(await readSessionWitness(dir, "sess_w")).toMatchObject({ kind: "heartbeat", ts: 1_031_000 });
    // 节流窗内（30s）→ 不重写。
    await markSessionHeartbeat(dir, "sess_w", { now: 1_040_000 });
    expect((await readSessionWitness(dir, "sess_w"))!.ts).toBe(1_031_000);
    // 回合结束（Stop 钩子）→ 证言 idle。
    expect(await markSessionIdle(dir, "sess_w", { now: 1_200_000 })).toEqual({ from: "running", to: "idle" });
    expect(await readSessionWitness(dir, "sess_w")).toMatchObject({ kind: "idle", ts: 1_200_000 });
  });

  it("证言与自述记录分路：直写伪造自述造不出证言（读证言 = undefined）", async () => {
    // 攻击形态（裁决 case1r3）：一次外部写只落 sessions/<sid>.json。
    await writeSession(dir, {
      sessionId: "sess_f", cwd: "", startedAt: 1_000_000, lastSeen: 1_000_000,
      liveness: "running", livenessTs: 1_000_000, lastEventTs: 1_000_000,
    });
    expect((await readSession(dir, "sess_f"))!.liveness).toBe("running"); // 自述在
    expect(await readSessionWitness(dir, "sess_f")).toBeUndefined(); // 证言无 → 不豁免
  });

  it("证言未来值整条拒绝（coerceSessionWitness：引擎写入不可能在未来）", async () => {
    const now = Date.now();
    await writeSessionWitness(dir, "sess_f", "running", now);
    // 直接覆写文件为未来值 → 读回 undefined（拒绝）。
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "registry", "witness", "sess_f.json"), JSON.stringify({ sessionId: "sess_f", kind: "running", ts: now + 3_600_000 }), "utf8");
    expect(await readSessionWitness(dir, "sess_f")).toBeUndefined();
    // kind 枚举外同样拒绝。
    writeFileSync(join(dir, "registry", "witness", "sess_f.json"), JSON.stringify({ sessionId: "sess_f", kind: "zombie", ts: now }), "utf8");
    expect(await readSessionWitness(dir, "sess_f")).toBeUndefined();
  });

  // v0.9.1 r4（V090-02）：容差归零——r3 实现误继承自述的 5min 容差，与「证言无漂移
  // 场景」的注释矛盾：伪造 ts=now+4min 使守卫 age 为负、恒满足 boundMs，单次写的
  // 豁免窗被放大到 skew+2×阈值（裁决实测 360s vs 过去值 120s）。
  it("r4（V090-02）：证言容差归零——ts 超 now 一毫秒即拒（4min 内的「近未来」也拒）", async () => {
    const now = Date.now();
    await writeSessionWitness(dir, "sess_z", "running", now);
    const { writeFileSync } = await import("node:fs");
    const file = join(dir, "registry", "witness", "sess_z.json");
    // now + 4min（裁决 case9r4 的伪造量）：r3 会接受（≤ now+5min 容差），r4 拒。
    // （1ms 级边界不走文件路径——读盘时刻的真实时间推进会覆盖它；毫秒级由下方
    // 纯函数用例以注入 now 确定性覆盖。）
    writeFileSync(file, JSON.stringify({ sessionId: "sess_z", kind: "running", ts: now + 4 * 60_000 }), "utf8");
    expect(await readSessionWitness(dir, "sess_z")).toBeUndefined();
    // now 本身（恰此刻）：仍接受（引擎写入时刻 = 判定时刻的同机时钟）。
    writeFileSync(file, JSON.stringify({ sessionId: "sess_z", kind: "running", ts: now }), "utf8");
    expect(await readSessionWitness(dir, "sess_z")).toEqual({ sessionId: "sess_z", kind: "running", ts: now });
  });

  it("r4（V090-02）：守卫防御——未来证言（含 1ms 级）不豁免（age 为负不恒真）", () => {
    const now = 1_000_000_000;
    // 读盘之外的构造路径：ts 在未来 → 直接不豁免（age 为负会恒满足 boundMs）。
    expect(sweepOwnerGuard({ sessionId: "s", kind: "running", ts: now + 1 }, now, 30 * 60_000)).toBeNull();
    expect(sweepOwnerGuard({ sessionId: "s", kind: "running", ts: now + 4 * 60_000 }, now, 30 * 60_000)).toBeNull();
    // 恰现在：正常豁免（对照）。
    expect(sweepOwnerGuard({ sessionId: "s", kind: "running", ts: now }, now, 30 * 60_000)).toBe("owner-running");
  });

  it("证言缺失时心跳立即补写（存量会话首次工具调用）", async () => {
    await markSessionHeartbeat(dir, "sess_new", { now: 5_000_000 });
    expect(await readSessionWitness(dir, "sess_new")).toEqual({ sessionId: "sess_new", kind: "heartbeat", ts: 5_000_000 });
  });
});

describe("活性迁移事件 → 时间线 family=liveness（PROTOCOL §12.4 冻结命名）", () => {
  it("session-running / session-idle 归入 liveness 族，摘要取花名兜底 sessionId", async () => {
    await writeSession(dir, { sessionId: "sess_a", cwd: "", startedAt: 1, lastSeen: 1, boundName: "m3" });
    await refreshSessionLastSeen(dir, "sess_a", { now: 1_000 });
    await markSessionIdle(dir, "sess_a", { now: 2_000 });
    const result = await readTimeline(join(dir, "logs", "engine.jsonl"), { budgetChars: 64_000 });
    const rows = result.events.filter((e) => e.family === "liveness");
    expect(rows.map((e) => e.event)).toEqual(["session-idle", "session-running"]); // ts 降序
    expect(rows.every((e) => e.actor === null)).toBe(true); // actor 链不含 sessionId/name（冻结链不动）
    expect(rows.find((e) => e.event === SESSION_RUNNING_EVENT)?.summary).toBe("session-running m3");
    expect(rows.find((e) => e.event === SESSION_IDLE_EVENT)?.summary).toBe("session-idle m3");
  });
});
