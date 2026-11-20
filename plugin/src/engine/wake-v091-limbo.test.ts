/**
 * v0.9.1 组A（G-12v3 机制 B + G-11）定向单测——reports/33-v091方案.md §二 组A 验收锚点：
 *
 * 1. **limbo 复现**：spawn 成功 → 不消费 → 超时 → 自动降级回 unread（重新可注入/
 *    可 pull/可重投）+ engine 事件 `message-limbo` + urgent 告知 lead；
 * 2. **正常消费不降级**：xc_read acknowledge（readAt+consumedAt）/ hook 注入回写
 *    （consumedAt）/ claim 读件（consumedAt）之后超时也不降级；
 * 3. **并发回写/降级恰一次**：团队锁内复判（消费先到则跳过；两把锁并发 sweep 恰一次）；
 * 4. **voiceOwner**：wakeToken 注册后连接身份带 voiceOwner；盖章面据此承认共享 sid 的
 *    无头续跑（sid 被 elsewhere 活进程持有也放行）；外部会话（无证明）仍被拒。
 *
 * 附带锚点：wake-child 生命周期日志（start 头行/exit 尾行）、wake-slow 信号、
 * wake-failed 的 urgent 告警通道、0 字节日志永不作失败判据。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot + M1 真实读写函数（end-to-end 到 M1 契约）；
 * 唤醒 spawn 注入假实现（不拉真子进程），pid 存活判定注入（不赌本机 pid 表）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeMailbox,
  appendMailbox,
  createMessage,
  markMailboxConsumed,
  readMailbox,
  readPendingMailbox,
  readUnreadMailbox,
  sweepLimboDeliveriesLocked,
} from "../core/mailbox";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate";
import { readWakeNonce, writeSession } from "../core/registry";
import { localPidDomain } from "../core/peerdir";
import { writePeerRecord, type PeerRecord } from "../core/peerregistry";
import { verifyUservoiceStampAuthority } from "../core/uservoice";
import { markInjectedConsumed } from "../hooks/shared";
import { withTeamLock } from "../core/lock";
import { xcRegister, identityStore, type BoundIdentity } from "../mcp/identity";
import type { TeamMember } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import { attemptWake, wakeNonceDigest, type WakeRequest } from "./wake";

const dirs: string[] = [];
let root: string;
/** 机器全局 peer 根（voiceOwner 测试用；与 stateRoot 分目录，模拟跨工作区可见性）。 */
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v091-limbo-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-wake-v091-peers-"));
  dirs.push(root, peerRoot);
});

afterAll(() => {
  for (const child of sleepers) child.kill();
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

/** 读指定 agent 的生命周期日志行（logs/wake-lifecycle-<to>-*.jsonl）。 */
function readLifecycleLines(agentKey: string): Array<Record<string, unknown>> {
  const dir = join(root, "logs");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.startsWith(`wake-lifecycle-${agentKey}-`) && f.endsWith(".jsonl"));
  const lines: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return lines;
}

/**
 * 轮询直到条件成立（每 stepMs 一次，deadline 后返回 false=硬失败）。
 * 判据可以是异步的（读邮箱/读盘）：负载无关地等**事实**成立，不猜固定 sleep。
 */
function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async (): Promise<boolean> => {
    for (;;) {
      if (await check()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  })();
}

/** 起一个真活进程（peer 注册表活性判据要吃真 pid）。 */
async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "message",
    receiptIds: ["m1"],
    ticket: "重踢：BD869",
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    ...overrides,
  };
}

/** 落一个含 lead「a」+ 成员「b」的 team.json（founderKey=a → leadKeyOf=a）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
  const member: TeamMember = { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 };
  team.members.push(member);
  await writeTeam(root, team);
}

/**
 * 落一条会话记录（lastSeen 传 1 = 远古）——模拟「从未被 SessionStart 刷新」的死会话
 * （wake-slow 判据的输入；voiceOwner 测试里它是锚定记录）。
 */
async function seedSessionRecord(sessionId: string, lastSeen = 1): Promise<void> {
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen });
}

/** 在当前临时 root 的 b 邮箱落一条消息（deliveryClaimedAt 模拟锁内 append 后的租约）。 */
async function seedMailbox(content = "重踢：BD869"): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", content, { deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

function fakeSpawn(pid: number | undefined): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => ({ pid, logFile: opts.logFile });
}

// ─────────────────────── 锚点 1：limbo 复现（机制 B 核心） ───────────────────────

describe("v0.9.1 组A：limbo 降级（G-12v3 机制 B）", () => {
  it("【锚点1·limbo 复现】spawn 成功→不消费→超时→降级 unread→重新可注入/可 pull/可重投 + lead urgent 告知", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b"); // 死会话：无 session-start 投影
    const messageId = await seedMailbox();

    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      // 测试时序：500ms 后判 limbo；wake-slow 拉到 1h 外（本锚点隔离 limbo）；监视 2s 后收工。
      limboTimeoutMs: 500,
      wakeSlowMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      spawn: fakeSpawn(4242),
    }));
    expect(res.delivered).toBe("wake");

    // spawn 即写 start 头行（nonce 摘要/sid/ts 三要素）——v0.9.1 打回第 1 轮
    // （V091-01）：头行只记不可反查摘要，真值不进共享日志（收割面收窄）。
    const startLines = readLifecycleLines("b").filter((l) => l["event"] === "wake-child-start");
    expect(startLines).toHaveLength(1);
    expect(startLines[0]!["nonce"]).toBe(wakeNonceDigest(res.nonce!));
    expect(startLines[0]!["nonce"]).not.toBe(res.nonce);
    expect(startLines[0]!["sid"]).toBe("sess_b");
    expect(typeof startLines[0]!["ts"]).toBe("number");

    // 盖章成功（deliveredAt 在场、consumedAt 缺席=limbo 判据成立）
    const stamped = await readMailbox(root, "default", "b");
    expect(stamped[0]!.deliveredAt).toBeDefined();
    expect(stamped[0]!.consumedAt).toBeUndefined();

    // 等到降级（不消费 → 超时 → 自动降级）
    const sawLimbo = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "message-limbo"));
    expect(sawLimbo).toBe(true);

    // 降级后：unread 仍在（可注入/可 pull），且重新可重投（deliveredAt 清掉）
    const box = await readMailbox(root, "default", "b");
    expect(box).toHaveLength(1);
    expect(box[0]!.id).toBe(messageId);
    expect(box[0]!.deliveredAt).toBeUndefined();
    expect(box[0]!.deliveryClaimedAt).toBeUndefined();
    expect(box[0]!.readAt).toBeUndefined();
    expect(box[0]!.consumedAt).toBeUndefined();
    expect((await readUnreadMailbox(root, "default", "b")).map((m) => m.id)).toEqual([messageId]);
    expect((await readPendingMailbox(root, "default", "b")).map((m) => m.id)).toEqual([messageId]);

    // engine 事件（含判据字段）+ lead urgent 告知（复用邮箱，不新增工具）
    const limbo = readEngineEvents().find((e) => e["event"] === "message-limbo")!;
    expect(limbo["to"]).toBe("b");
    expect(limbo["messageId"]).toBe(messageId);
    // v0.9.1 打回第 1 轮（V091-01）：事件只记 nonce 摘要（对账可做、收割不可行）。
    expect(limbo["nonce"]).toBe(wakeNonceDigest(res.nonce!));
    expect(limbo["timeoutMs"]).toBe(500);
    // PROTOCOL §15.3 冻结键集对拍（行级 ts 除外；taskId 仅任务绑定消息出现）
    expect(Object.keys(limbo).filter((k) => k !== "ts").sort()).toEqual(
      ["downgradedAt", "event", "from", "messageId", "nonce", "scene", "sid", "stampedAt", "teamId", "timeoutMs", "to", "waitedMs"],
    );
    // 告知在事件**之后**落账（降级 → message-limbo 事件 → urgent 告知 lead）：等「lead
    // 已被告知」这个事实本身，而不是等事件后猜一段固定时间——全量并行负载下事件与告知
    // 之间的间隔会拉宽，等事件即读邮箱曾偶发读到空箱（round8 实测复现）。
    expect(await waitUntil(async () => (await readMailbox(root, "default", "a")).length === 1)).toBe(true);
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.from).toBe("engine");
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("limbo");
    expect(leadBox[0]!.content).toContain(messageId);
    // 生命周期账也记一行（运维可在同目录对账）
    expect(readLifecycleLines("b").some((l) => l["event"] === "limbo-downgrade")).toBe(true);
  });

  it("【锚点1b·幂等】同一轮次恰降级一次（判据自销：第二遍扫不到；事件恰一条）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 300,
      wakeSlowMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 3_000,
      spawn: fakeSpawn(4243),
    }));
    expect(await waitUntil(() => readEngineEvents().some((e) => e["event"] === "message-limbo"))).toBe(true);
    // 越过后再等两轮轮询：不重复降级、不重复告知
    await new Promise((r) => setTimeout(r, 400));
    expect(readEngineEvents().filter((e) => e["event"] === "message-limbo")).toHaveLength(1);
    // 告知晚于事件落账：等事实而非猜时间（400ms 只是幂等性观察窗，不承担告知可达性）
    expect(await waitUntil(async () => (await readMailbox(root, "default", "a")).length === 1)).toBe(true);
    expect(await readMailbox(root, "default", "a")).toHaveLength(1);
  });

  it("【锚点2·正常消费不降级】xc_read acknowledge（readAt+consumedAt）后超时也不降级", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 400,
      wakeSlowMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      spawn: fakeSpawn(4244),
    }));
    // 成员回合实际消费：xc_read({scope:"inbox"}) 的 acknowledge（现在同时写 consumedAt）
    await acknowledgeMailbox(root, "default", "b", [messageId]);
    const consumed = await readMailbox(root, "default", "b");
    expect(consumed[0]!.readAt).toBeDefined();
    expect(consumed[0]!.consumedAt).toBeDefined();

    await new Promise((r) => setTimeout(r, 900)); // 越过 limbo 超时
    expect(readEngineEvents().some((e) => e["event"] === "message-limbo")).toBe(false);
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.deliveredAt).toBeDefined(); // 盖章未被清
    expect(await readMailbox(root, "default", "a")).toHaveLength(0); // 无误告警
  });

  it("【锚点2b·hook 注入回写不降级】markInjectedConsumed 后超时不降级", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 400,
      wakeSlowMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      spawn: fakeSpawn(4245),
    }));
    // 钩子侧真实实现（hooks/shared.ts）：团队锁内回写 consumedAt
    const marked = await markInjectedConsumed(root, "b");
    expect(marked).toBe(1);
    const after = await readMailbox(root, "default", "b");
    expect(after[0]!.consumedAt).toBeDefined();
    expect(after[0]!.readAt).toBeUndefined(); // 注入≠已读，未读态保留（下回合继续提醒）

    await new Promise((r) => setTimeout(r, 900));
    expect(readEngineEvents().some((e) => e["event"] === "message-limbo")).toBe(false);
    expect((await readMailbox(root, "default", "b"))[0]!.deliveredAt).toBeDefined();
  });

  it("【锚点2c·claim 读件语义】markMailboxConsumed 后超时不降级（认领=消费派单信封）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 400,
      wakeSlowMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      spawn: fakeSpawn(4246),
    }));
    await markMailboxConsumed(root, "default", "b", [messageId]);
    await new Promise((r) => setTimeout(r, 900));
    expect(readEngineEvents().some((e) => e["event"] === "message-limbo")).toBe(false);
    expect((await readMailbox(root, "default", "b"))[0]!.deliveredAt).toBeDefined();
  });
});

// ─────────────────────── 锚点 3：并发回写/降级恰一次 ───────────────────────

describe("v0.9.1 组A：回写与降级的竞态（团队锁内复判，恰一次）", () => {
  /** 造一条「已盖章、未消费、已超时」的消息。 */
  async function seedLimboCandidate(): Promise<string> {
    await seedTeam();
    const messageId = await seedMailbox();
    const team = (await readTeam(root, "default"))!;
    await withTeamLock(root, "default", async () => {
      const { markMailboxDelivered } = await import("../core/mailbox.js");
      await markMailboxDelivered(root, "default", "b", [messageId], Date.now() - 60_000);
    });
    expect(team).toBeDefined();
    return messageId;
  }

  it("两把锁并发 sweep 恰一次（第二遍锁内复判扫不到）", async () => {
    const messageId = await seedLimboCandidate();
    const sweepOnce = async (): Promise<number> =>
      withTeamLock(root, "default", async () => {
        const team = (await readTeam(root, "default"))!;
        return (await sweepLimboDeliveriesLocked(root, team, "b", Date.now(), 100)).length;
      });
    const [first, second] = await Promise.all([sweepOnce(), sweepOnce()]);
    expect(first + second).toBe(1);
    // 终态：降级后不可再降（deliveredAt 已清=判据自销）
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.id).toBe(messageId);
    expect(box[0]!.deliveredAt).toBeUndefined();
  });

  it("消费先到 → sweep 跳过（不是 limbo；盖章不被清）", async () => {
    const messageId = await seedLimboCandidate();
    await acknowledgeMailbox(root, "default", "b", [messageId]); // 消费回写先赢
    const downgraded = await withTeamLock(root, "default", async () => {
      const team = (await readTeam(root, "default"))!;
      return sweepLimboDeliveriesLocked(root, team, "b", Date.now(), 100);
    });
    expect(downgraded).toHaveLength(0);
    expect((await readMailbox(root, "default", "b"))[0]!.deliveredAt).toBeDefined();
  });

  it("降级先到 → 消费照常（成员随后读到；终态一致，不重复降级）", async () => {
    const messageId = await seedLimboCandidate();
    const downgraded = await withTeamLock(root, "default", async () => {
      const team = (await readTeam(root, "default"))!;
      return sweepLimboDeliveriesLocked(root, team, "b", Date.now(), 100);
    });
    expect(downgraded.map((m) => m.id)).toEqual([messageId]);
    await acknowledgeMailbox(root, "default", "b", [messageId]); // 降级后成员仍读到
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.readAt).toBeDefined();
    expect(box[0]!.consumedAt).toBeDefined();
    // 再扫一次：无第二次降级
    const again = await withTeamLock(root, "default", async () => {
      const team = (await readTeam(root, "default"))!;
      return sweepLimboDeliveriesLocked(root, team, "b", Date.now(), 100);
    });
    expect(again).toHaveLength(0);
  });

  it("并发消费 vs 降级：恰一次生效且终态自洽（at most once）", async () => {
    const messageId = await seedLimboCandidate();
    const outcome = await Promise.all([
      // 消费回写（持团队锁）
      withTeamLock(root, "default", async () => {
        await acknowledgeMailbox(root, "default", "b", [messageId]);
        return "consumed" as const;
      }),
      // limbo 降级（持团队锁；锁内复判）
      withTeamLock(root, "default", async () => {
        const team = (await readTeam(root, "default"))!;
        const downgraded = await sweepLimboDeliveriesLocked(root, team, "b", Date.now(), 100);
        return downgraded.length === 1 ? ("downgraded" as const) : ("skipped" as const);
      }),
    ]);
    // 恰一次：要么消费赢（降级 skipped），要么降级赢（消费随后落到已读态）
    expect(outcome.filter((o) => o === "downgraded").length).toBeLessThanOrEqual(1);
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.readAt).toBeDefined(); // 消费必然落地（两种序都成立）
  });
});

// ─────────────────────── 锚点 4：wake-child 生命周期日志 + wake-slow + wake-failed 告警 ───────────────────────

describe("v0.9.1 组A：wake-child 生命周期日志与引擎信号", () => {
  it("start 头行 + 观察到子进程消失写 exit 尾行（时长；孤儿退出码如实 exitCode:null）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      // 假 helper：汇报唤醒子 pid=999999（测试用不可信 pid，存活判定注入为「已死」）
      spawn: (opts) => {
        opts.onHelperSpawned?.(999999);
        return { pid: 999999, logFile: opts.logFile };
      },
      pidAliveProbe: () => false,
    }));
    const sawExit = await waitUntil(() =>
      readLifecycleLines("b").some((l) => l["event"] === "wake-child-exit"));
    expect(sawExit).toBe(true);
    const exit = readLifecycleLines("b").find((l) => l["event"] === "wake-child-exit")!;
    expect(exit["pid"]).toBe(999999);
    expect(exit["exitCode"]).toBeNull(); // 孤儿化唤醒子（V9）退出码不可观测——如实 null
    expect(typeof exit["durationMs"]).toBe("number");
  });

  it("wake-slow：spawn 后阈值内目标 sid 无 session-start → 事件 + urgent 告知 lead", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b"); // 远古 lastSeen：无会话活动投影
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 300,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      spawn: fakeSpawn(4250),
    }));
    const sawSlow = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-slow"));
    expect(sawSlow).toBe(true);
    const slow = readEngineEvents().find((e) => e["event"] === "wake-slow")!;
    expect(slow["to"]).toBe("b");
    expect(slow["sid"]).toBe("sess_b");
    expect(slow["thresholdMs"]).toBe(300);
    // PROTOCOL §15.3 冻结键集对拍（行级 ts 除外）
    expect(Object.keys(slow).filter((k) => k !== "ts").sort()).toEqual(
      ["event", "nonce", "pid", "scene", "sid", "teamId", "thresholdMs", "to", "waitedMs"],
    );
    // 告知在事件**之后**落账（wake-slow 事件 → urgent 告知 lead，wake.ts:1325→1336）：
    // 等「lead 已被告知」这个事实，而不是等事件后猜固定时间（负载下两者间隔拉宽，
    // 等事件即读邮箱曾偶发红——round8 负载复现实测）。
    expect(await waitUntil(async () => (await readMailbox(root, "default", "a")).length === 1)).toBe(true);
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("wake-slow");
  });

  it("wake-slow 负例：session-start 跟上（lastSeen 刷新）→ 不判慢", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 300,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      spawn: fakeSpawn(4251),
    }));
    // 唤醒子的 SessionStart 钩子刷新会话记录（生产等价：回合开跑）
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 800)); // 越过 slow 阈值
    expect(readEngineEvents().some((e) => e["event"] === "wake-slow")).toBe(false);
    expect(res.nonce).toBeDefined();
    expect(await readMailbox(root, "default", "a")).toHaveLength(0);
  });

  it("0 字节日志永不作失败判据：唤醒日志无任何输出 + 无 session-start → 只判 wake-slow，不判 wake-failed", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 250,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 2_000,
      watchWindowMs: 600, // 失败侦听窗内日志始终为空（fakeSpawn 不写日志）
      watchPollMs: 20,
      spawn: fakeSpawn(4252),
    }));
    expect(await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-slow"))).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    // 空日志 ≠ 失败：无 wake-failed（既有 FI-7 口径不变），消息仍盖着章在邮箱
    expect(readEngineEvents().some((e) => e["event"] === "wake-failed")).toBe(false);
    expect((await readMailbox(root, "default", "b"))[0]!.deliveredAt).toBeDefined();
  });

  it("wake-failed 告警通道：同步 spawn 失败 → wake-failed + lifecycle exit 尾行 + urgent 告知 lead", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      spawn: () => {
        throw new Error("spawnResume: boom");
      },
    }));
    expect(res.delivered).toBe("mailbox");
    expect(String(res.note)).toContain("spawn-failed");
    const failed = readEngineEvents().find((e) => e["event"] === "wake-failed")!;
    expect(failed["where"]).toBe("spawn");
    // 生命周期账：start 头行 + spawn 失败 exit 尾行（子进程从未存在）
    const lines = readLifecycleLines("b");
    expect(lines.filter((l) => l["event"] === "wake-child-start")).toHaveLength(1);
    const exit = lines.find((l) => l["event"] === "wake-child-exit")!;
    expect(exit["spawnError"]).toContain("boom");
    // 告警通道：lead 收到 urgent（此前只写 engine.jsonl，lead 不巡检不知情）
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.from).toBe("engine");
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("wake-failed");
  });
});

// ─────────────────────── 锚点 5：G-11 voiceOwner（uservoice 归属） ───────────────────────

describe("v0.9.1 组A：G-11 uservoice 归属（voiceOwner）", () => {
  /** 在机器全局 peer 注册表落一个「别的活进程持有该 sid」的记录（生产：桌面原会话）。 */
  async function seedLiveHolder(sessionId: string): Promise<number> {
    const pid = await startSleeper();
    const record: PeerRecord = {
      pid,
      sessionId,
      messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v091-${pid}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      name: "desktop-master",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    };
    await writePeerRecord(peerRoot, record);
    return pid;
  }

  it("nonce 落盘带 voiceOwner；wakeToken 注册后连接身份继承 voiceOwner", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: fakeSpawn(4260),
    }));
    // nonce 文件带 voiceOwner=原会话（=sid）
    const nonce = await readWakeNonce(root, res.nonce!);
    expect(nonce?.voiceOwner).toBe("sess_b");

    // 无头回合持唤醒 prompt 里的 wakeToken 注册（xc_identify 路径 2）
    const outcome = await xcRegister(
      root,
      { name: "b", sessionId: "sess_b", wakeToken: res.nonce },
      "conn-wake-1",
      { peerRoot },
    );
    expect(outcome.via).toBe("wake");
    const bound: BoundIdentity | undefined = identityStore.get("conn-wake-1");
    expect(bound?.voiceOwner).toBe("sess_b");
    expect(identityStore.voiceOwnerForSession("sess_b")).toBe("sess_b");
    // 未接管别的 sid：查不到证明
    expect(identityStore.voiceOwnerForSession("sess-other")).toBeUndefined();
  });

  it("盖章判定：voiceOwner 匹配 → 不再因 sid 被 elsewhere 活进程持有而拒", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    await seedLiveHolder("sess_b"); // 桌面原会话活着持有同一 sid（生产冲突形态）

    // 无证明（外部会话/冒充态）：照旧被拒（安全面不回退）
    const refused = await verifyUservoiceStampAuthority(peerRoot, root, "sess_b");
    expect(refused).toEqual({ ok: false, reason: "session-id-held-elsewhere" });

    // 唤醒续跑证明（nonce → 连接身份 → 盖章面）：放行
    const ok = await verifyUservoiceStampAuthority(peerRoot, root, "sess_b", { voiceOwner: "sess_b" });
    expect(ok).toEqual({ ok: true });

    // 证明与目标 sid 不匹配：不放宽（防拿别处的证明蒙混）
    const mismatch = await verifyUservoiceStampAuthority(peerRoot, root, "sess_b", { voiceOwner: "sess-other" });
    expect(mismatch).toEqual({ ok: false, reason: "session-id-held-elsewhere" });
  });

  it("盖章判定：unanchored 不因 voiceOwner 放宽（锚定线照旧）", async () => {
    await seedTeam();
    // 不写会话记录（无锚定）+ elsewhere 持有
    await seedLiveHolder("sess_b");
    const verdict = await verifyUservoiceStampAuthority(peerRoot, root, "sess_b", { voiceOwner: "sess_b" });
    expect(verdict).toEqual({ ok: false, reason: "unanchored" });
  });

  it("端到端：wake 注册 → relay 盖章接受 voiceOwner（xc_identify wakeToken → BoundIdentity）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: fakeSpawn(4261),
    }));
    await xcRegister(root, { name: "b", sessionId: "sess_b", wakeToken: res.nonce }, "conn-wake-2", { peerRoot });
    const bound = identityStore.get("conn-wake-2")!;
    expect(bound.voiceOwner).toBe("sess_b");
    // 工具面（tools-relay/peer-services）传的正是这个证明：voiceOwner === sessionId
    expect(bound.voiceOwner === bound.sessionId).toBe(true);
  });
});
