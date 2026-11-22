/**
 * v0.9.2 组A（reports/35-v092方案.md §二 组A 验收锚点）定向单测——**A2 成员看门狗**。
 *
 * 锚点（任务书原文逐条）：
 * 1. **杀伤一次不重复**：成员 alive→dead 迁移恰发一次（engine 事件 member-dead + lead
 *    邮箱 urgent + 尝试唤醒 lead），状态落 capacity/watchdog-state.json——连扫三轮只
 *    发一次，换了进程（重读状态）也不重复；
 * 2. **lead 死转移通知**：lead 自己 pid-dead → 通知**其余在册成员**并唤醒（C6-BUG-4
 *    口径：不通知崩溃者自己的邮箱），无人可通知时只落审计；
 * 3. **受容量闸约束**：唤醒走 attemptWake 标准路径——容量 RED 时不 spawn、记
 *    `watchdog-wake` 事件（deferred 事实透出）；
 * 4. 附带：在途 nonce 生命周期（孤儿唤醒只报一次）、limbo 判据（看门狗面降级 + 同轮
 *    合并 + 跨面节流）、env 口径（XC_WATCHDOG_MS 缺省 60s / 0=关 / 非法回落）。
 *
 * 依赖隔离：peer 注册表写临时目录（env XC_MESSAGING_DIR 钉住，不写宿主 peers 根）；
 * pid 活性用真活进程（spawn node sleeper）——pid-dead 是 C8 唯一进程死硬证据，不能用
 * 假 pid 伪造；唤醒 spawn 不注入（看门狗自己调 attemptWake），测试里用「唤醒闸关闭 /
 * 容量 RED」让它必然不 spawn。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMailbox, createMessage, markMailboxDelivered, readMailbox } from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { createWakeNonce } from "../core/registry";
import { pidAlive } from "../core/lock.js";
import { localPidDomain } from "../core/peerdir";
import { writePeerRecord, type PeerRecord } from "../core/peerregistry";
import type { CapacitySample } from "../core/capacity.js";
import { wakeLifecycleFile } from "../core/paths";
import {
  startMemberWatchdog,
  sweepMembersOnce,
  watchdogIntervalMsFromEnv,
  WATCHDOG_INTERVAL_DEFAULT_MS,
  type WatchdogDeps,
} from "./watchdog";
import { readWatchdogState, watchdogStateFile } from "./watchdog-state";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-watchdog-v092-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-watchdog-v092-peers-"));
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

function eventsOf(name: string): Array<Record<string, unknown>> {
  return readEngineEvents().filter((e) => e["event"] === name);
}

/** 起一个真活进程并落一条 peer 注册记录（活性判据吃真 pid）。 */
async function seedLivePeer(sessionId: string): Promise<number> {
  const pid = await startSleeper();
  const record: PeerRecord = {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-wd-${pid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name: `wd-${pid}`,
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  };
  await writePeerRecord(peerRoot, record);
  return pid;
}

async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

/** lead「a」+ 成员「b」（founderKey=a → leadKeyOf=a；lead 与成员一样占花名册行——
 *  生产形态见 identity.ts joinTeam：首个注册会话即 founder 且入册）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  team.members.push({ key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 });
  await writeTeam(root, team);
}

function deps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    stateRoot: root,
    workspace: "D:\\ws",
    // 唤醒闸关闭（env 层）：看门狗仍会**尝试**唤醒，attemptWake 如实降级 mailbox 并留痕
    // ——「尝试唤醒」与「唤醒成功」是两件事，本测试验证的正是前者与失败记事件。
    env: { XC_MESSAGING_DIR: peerRoot },
    ...overrides,
  };
}

/** RED 容量样本（水位 8.9%：命中 watermark 硬底）。 */
function redSample(): CapacitySample {
  return {
    sampledAt: Date.now(),
    totalBytes: 16 * 1024 ** 3,
    freeBytes: 1_400_000_000,
    watermark: 0.089,
    steadyTreeBytes: 12 * 1024 ** 3,
    headlessTurnCount: 2,
    headlessTurnMaxRssBytes: 900 * 1024 * 1024,
    degraded: null,
  };
}

// ─────────────────────── A2：看门狗（推） ───────────────────────

describe("v0.9.2 A2：成员看门狗", () => {
  it("env 口径：缺省 60000；0=关；负/非数字回落缺省（不静默关闸）", () => {
    expect(WATCHDOG_INTERVAL_DEFAULT_MS).toBe(60_000);
    expect(watchdogIntervalMsFromEnv({})).toBe(60_000);
    expect(watchdogIntervalMsFromEnv({ XC_WATCHDOG_MS: "0" })).toBe(0);
    expect(watchdogIntervalMsFromEnv({ XC_WATCHDOG_MS: "1500" })).toBe(1500);
    expect(watchdogIntervalMsFromEnv({ XC_WATCHDOG_MS: "-1" })).toBe(60_000);
    expect(watchdogIntervalMsFromEnv({ XC_WATCHDOG_MS: "soon" })).toBe(60_000);
    // 启动面：0 → 不起定时器
    expect(startMemberWatchdog(deps({ env: { XC_MESSAGING_DIR: peerRoot, XC_WATCHDOG_MS: "0" } }))).toBeUndefined();
  });

  it("无团队 → 跳过（不是错误）", async () => {
    const summary = await sweepMembersOnce(deps());
    expect(summary.team).toBe(false);
    expect(eventsOf("watchdog-sweep-failed")).toHaveLength(0);
  });

  it("【锚点1·杀伤一次不重复】alive→dead 恰发一次：member-dead 事件 + lead urgent + 尝试唤醒 lead；状态落账换进程不重复", async () => {
    await seedTeam();
    const leadPid = await seedLivePeer("sess_a");
    const memberPid = await seedLivePeer("sess_b");

    // 第一轮：两个成员都活着 → 不告警，只记录状态
    const first = await sweepMembersOnce(deps());
    expect(first.dead).toEqual([]);
    expect(first.scannedMembers).toBe(2);
    expect(eventsOf("member-dead")).toHaveLength(0);
    const stateAfterFirst = await readWatchdogState(root);
    expect(stateAfterFirst.members["a|sess_a"]?.state).toBe("alive");
    expect(stateAfterFirst.members["b|sess_b"]?.state).toBe("alive");
    // 状态文件真源落在方案指定的位置
    expect(existsSync(watchdogStateFile(root))).toBe(true);

    // 成员 b 的进程死亡（kill 后 peer 记录仍在 = pid-dead 硬证据）
    sleepers.splice(sleepers.findIndex((c) => c.pid === memberPid), 1);
    killSync(memberPid);
    // 负载无关：等「OS 已回收该 pid」这一产品判据成立（pidAlive 转 false），不猜固定
    // 50ms——负载下进程回收可能远超 50ms，固定等待会把活 pid 误当已死（g16 同款教训）。
    expect(await until(() => !pidAlive(memberPid), 10_000)).toBe(true);

    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual(["b"]);
    expect(second.leadDead).toBe(false);
    // 三件套齐：engine 事件 / lead 邮箱 urgent / 尝试唤醒 lead
    const dead = eventsOf("member-dead");
    expect(dead).toHaveLength(1);
    expect(dead[0]!["member"]).toBe("b");
    expect(dead[0]!["evidence"]).toBe("process-dead");
    expect(dead[0]!["via"]).toBe("watchdog");
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.from).toBe("engine");
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("成员 \"b\" 进程已亡");
    const wakes = eventsOf("watchdog-wake");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!["to"]).toBe("a");
    expect(wakes[0]!["delivered"]).toBe("mailbox"); // 唤醒闸关闭：如实降级并记事件

    // 第三轮：同一成员仍死 → **不重复**（状态说 dead，无迁移）
    const third = await sweepMembersOnce(deps());
    expect(third.dead).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(1);
    expect(eventsOf("watchdog-wake")).toHaveLength(1);
    expect(await readMailbox(root, "default", "a")).toHaveLength(1);
    const stateAfterThird = await readWatchdogState(root);
    expect(stateAfterThird.members["b|sess_b"]?.state).toBe("dead");
    expect(stateAfterThird.members["b|sess_b"]?.evidence).toBe("process-dead");

    // 「换进程不重复」：重读状态（模拟 server 重启后的新一轮）仍判 dead、无新迁移
    const fourth = await sweepMembersOnce(deps());
    expect(fourth.dead).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(1);
    expect(leadPid).toBeGreaterThan(0);
  });

  it("【锚点2·lead 死转移通知】lead pid-dead → 通知其余在册成员并唤醒；无人可通知只落审计", async () => {
    await seedTeam();
    const leadPid = await seedLivePeer("sess_a");
    const memberPid = await seedLivePeer("sess_b");
    expect(await sweepMembersOnce(deps())).toMatchObject({ dead: [] });

    // lead 的进程死亡
    sleepers.splice(sleepers.findIndex((c) => c.pid === leadPid), 1);
    killSync(leadPid);
    // 负载无关：等「OS 已回收该 pid」这一产品判据成立（pidAlive 转 false），不猜固定
    // 50ms——负载下进程回收可能远超 50ms，固定等待会把活 pid 误当已死（g16 同款教训）。
    expect(await until(() => !pidAlive(leadPid), 10_000)).toBe(true);

    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual(["a"]);
    expect(second.leadDead).toBe(true);
    const dead = eventsOf("member-dead");
    expect(dead).toHaveLength(1);
    expect(dead[0]!["member"]).toBe("a");
    // 通知改投**其他在册成员**（不通知崩溃者自己的邮箱——C6-BUG-4 口径）
    const memberBox = await readMailbox(root, "default", "b");
    expect(memberBox).toHaveLength(1);
    expect(memberBox[0]!.from).toBe("engine");
    expect(memberBox[0]!.urgent).toBe(true);
    expect(memberBox[0]!.content).toContain('lead "a" 进程已亡');
    expect(await readMailbox(root, "default", "a")).toHaveLength(0);
    // 唤醒也指向队友
    const wakes = eventsOf("watchdog-wake");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!["to"]).toBe("b");
    // 不重复
    expect(await sweepMembersOnce(deps())).toMatchObject({ dead: [] });
    expect(eventsOf("member-dead")).toHaveLength(1);
    expect(memberPid).toBeGreaterThan(0);
  });

  it("lead 死且无其他在册成员 → 只落审计（watchdog-notify-skipped），不抛", async () => {
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now: 1,
      founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
    });
    await writeTeam(root, team); // 花名册只有 lead 一名成员
    const leadPid = await seedLivePeer("sess_a");
    await sweepMembersOnce(deps());
    sleepers.splice(sleepers.findIndex((c) => c.pid === leadPid), 1);
    killSync(leadPid);
    // 负载无关：等「OS 已回收该 pid」这一产品判据成立（pidAlive 转 false），不猜固定
    // 50ms——负载下进程回收可能远超 50ms，固定等待会把活 pid 误当已死（g16 同款教训）。
    expect(await until(() => !pidAlive(leadPid), 10_000)).toBe(true);

    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual(["a"]);
    const skipped = eventsOf("watchdog-notify-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!["reason"]).toBe("lead-dead-no-other-live-members");
    expect(eventsOf("watchdog-wake")).toHaveLength(0);
  });

  it("【锚点3·容量闸约束】唤醒闸开启 + 容量 RED → 不 spawn、delivered:mailbox + watchdog-wake 记 deferred", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    const memberPid = await seedLivePeer("sess_b");
    await sweepMembersOnce(deps());
    sleepers.splice(sleepers.findIndex((c) => c.pid === memberPid), 1);
    killSync(memberPid);
    // 负载无关：等「OS 已回收该 pid」这一产品判据成立（pidAlive 转 false），不猜固定
    // 50ms——负载下进程回收可能远超 50ms，固定等待会把活 pid 误当已死（g16 同款教训）。
    expect(await until(() => !pidAlive(memberPid), 10_000)).toBe(true);

    // 唤醒闸开启（env 层）+ 容量 RED：attemptWake 在 spawn 前被容量闸挡下
    const second = await sweepMembersOnce(deps({
      env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true" },
      capacitySample: redSample(),
    }));
    expect(second.dead).toEqual(["b"]);
    const wakes = eventsOf("watchdog-wake");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!["delivered"]).toBe("mailbox");
    expect(wakes[0]!["wakeDeferred"]).toBe(true);
    expect(Array.isArray(wakes[0]!["detail"])).toBe(true);
    // 容量闸挡在 createWakeNonce 之前：没有留下任何在途 nonce（不挡后续重投）
    expect(existsSync(join(root, "registry", "wake"))).toBe(false);
    expect(eventsOf("wake-deferred")).toHaveLength(1);
    // lead 邮箱仍收到 urgent 告知（闸只挡唤醒，不拦告知）
    expect(await readMailbox(root, "default", "a")).toHaveLength(1);
  });

  it("【附带·在途 nonce 生命周期】唤醒子已退出而未消费 nonce → wake-orphan-nonce 恰一次", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    // 落一个在途 nonce（未消费、新鲜）+ 对应的唤醒子退出证据（生命周期账按 nonce.ts 命名）
    const { token, nonce } = await createWakeNonce(root, { teamId: "default", agentKey: "b", sid: "sess_b" });
    const lifecycle = wakeLifecycleFile(root, "b", nonce.ts);
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(lifecycle, `${JSON.stringify({ ts: Date.now(), event: "wake-child-start", nonce: "x" })}\n`);
    appendFileSync(lifecycle, `${JSON.stringify({ ts: Date.now(), event: "wake-child-exit", pid: 999, durationMs: 10, exitCode: null })}\n`);

    const first = await sweepMembersOnce(deps());
    expect(first.orphanNonces).toHaveLength(1);
    const orphans = eventsOf("wake-orphan-nonce");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!["to"]).toBe("b");
    expect(String(orphans[0]!["nonce"])).not.toBe(token); // 只落不可反查摘要
    // lead 被告知（合并进本轮 urgent）
    expect((await readMailbox(root, "default", "a"))[0]!.content).toContain("唤醒握手");
    // 再扫：不重复
    await sweepMembersOnce(deps());
    expect(eventsOf("wake-orphan-nonce")).toHaveLength(1);
  });

  it("【附带·在途 nonce 反例】唤醒子未退出（无 exit 证据）→ 不判孤儿", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const { nonce } = await createWakeNonce(root, { teamId: "default", agentKey: "b", sid: "sess_b" });
    const lifecycle = wakeLifecycleFile(root, "b", nonce.ts);
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(lifecycle, `${JSON.stringify({ ts: Date.now(), event: "wake-child-start", nonce: "x" })}\n`);

    const first = await sweepMembersOnce(deps());
    expect(first.orphanNonces).toEqual([]);
    expect(eventsOf("wake-orphan-nonce")).toHaveLength(0);
  });

  it("【附带·limbo 看门狗面】两条超时未消费 → 一次扫描降级两条 + **合并成一条** urgent；重复扫描不惊动；重新盖章=新一轮放行", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    // limbo 阈值压到 1s（env 口径；生产缺省 10min）
    const limboDeps = deps({ env: { XC_MESSAGING_DIR: peerRoot, XC_LIMBO_TIMEOUT_MS: "1000" } });
    const ids = [await seedLimboMessage(2_000), await seedLimboMessage(2_000)];

    const first = await sweepMembersOnce(limboDeps);
    expect(first.limboDowngraded.sort()).toEqual([...ids].sort());
    expect(first.limboAlerted.sort()).toEqual([...ids].sort());
    const limbo = eventsOf("message-limbo");
    expect(limbo).toHaveLength(2);
    expect(limbo.every((e) => e["via"] === "watchdog")).toBe(true);
    // 合并：恰一条 urgent，两条 id 都在里面
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    for (const id of ids) expect(leadBox[0]!.content).toContain(id);
    // 都已降级（可重投）
    for (const id of ids) {
      const box = await readMailbox(root, "default", "b");
      expect(box.find((m) => m.id === id)?.deliveredAt).toBeUndefined();
    }

    // 再扫：判据自销（无候选）→ 无新事件、无新告警
    const second = await sweepMembersOnce(limboDeps);
    expect(second.limboDowngraded).toEqual([]);
    expect(eventsOf("message-limbo")).toHaveLength(2);
    expect(await readMailbox(root, "default", "a")).toHaveLength(1);

    // 重新盖章（新一轮投递）→ 同一 messageId 也放行（(messageId, 轮次) 语义）
    await withLock(() => markMailboxDelivered(root, "default", "b", [ids[0]!], Date.now() - 2_000));
    const third = await sweepMembersOnce(limboDeps);
    expect(third.limboDowngraded).toEqual([ids[0]]);
    expect(third.limboAlerted).toEqual([ids[0]]);
    expect(await readMailbox(root, "default", "a")).toHaveLength(2);
  });

  it("定时器面：startMemberWatchdog 起一个 unref 定时器并至少跑一轮", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const timer = startMemberWatchdog(deps(), 30);
    expect(timer).toBeDefined();
    // 负载无关：等「至少跑过一轮」这个**事实**（状态文件已落账成员快照），不猜固定
    // sleep——一轮要做多次文件 IO + peer 活性探测，全量并行负载下远超 120ms，固定
    // 等待曾偶发读到空状态（round8 负载复现实测：expected [] to deeply equal ['a','b']）。
    expect(await until(async () =>
      Object.keys((await readWatchdogState(root)).members).length >= 2, 15_000)).toBe(true);
    clearInterval(timer!);
    // 跑过至少一轮：状态文件已落账（成员快照）
    const state = await readWatchdogState(root);
    expect(Object.keys(state.members).sort()).toEqual(["a|sess_a", "b|sess_b"]);
  });
});

/**
 * 轮询等待谓词成立（测试辅助；core/lock.test.ts `until` 同款，判据可异步）。
 * deadline 后返回 false=硬失败，不把用例放宽成永远通过。
 */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 落一条「已盖章、未消费、已超时」的消息（limbo 候选）。 */
async function seedLimboMessage(stampedAgoMs: number): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "回执待消费", { deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  await withLock(() => markMailboxDelivered(root, "default", "b", [message.id], Date.now() - stampedAgoMs));
  return message.id;
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const { withTeamLock } = await import("../core/lock.js");
  return withTeamLock(root, "default", fn);
}

/** 同步杀进程（测试辅助：peer 记录的 pid 必须真的死掉才是 pid-dead 硬证据）。 */
function killSync(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}
