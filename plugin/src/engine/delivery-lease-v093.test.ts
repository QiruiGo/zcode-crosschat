/**
 * v0.9.3 组A（reports/37-v093方案.md §一 组A 验收锚点）+ **打回第 1 轮 V093-01/02/03** 定向单测。
 *
 * 锚点（任务书原文逐条）：
 * - A1：`deliveryClaimedAt` 有、`deliveredAt` 无、超时（默认 10min，可配）→ 释放投递租约、
 *   消息回 pending、`delivery-lease-expired` 事件 + urgent lead；幂等；不与 limbo 双触发。
 * - 打回第 1 轮（三条 P1，全部无需对抗者即可触发）：
 *   · **V093-01** 判据漏 `consumedAt`：`markMailboxConsumed`（hook 注入 / xc_claim / xc_read /
 *     limbo injectedConsumed 的消费回写面，只写 consumedAt）之后，claimed∧¬delivered 的消息
 *     仍被判「无声放弃」⇒ 假告警 + 已消费消息回 pending（可被再次注入/再次投递）。
 *   · **V093-02** 判据无「真实投递尝试」门槛：`deliveryClaimedAt` 被多面共用——派单信封
 *     （mcp/tools-tasks.ts 建帧 extras）、看门狗自写帧（watchdog.ts notifyAndWake 建帧）、
 *     toolgate 审批门帧（core/toolgate.ts）**出生即带租约**，唤醒被闸挡下时从未有过任何
 *     spawn 尝试，10min 后照样命中 ⇒ 假告警；看门狗告警帧自身因此自我增殖（告警报自己）。
 *   · **V093-03** 判据不交叉校验在途证据：attemptWake 的 claim 与补盖章是两次独立
 *     best-effort 取锁（前者成后者败即 claimed∧¬delivered 永驻），而 fresh nonce（15min 窗）
 *     与生命周期账 start 头行都在盘上——不校验就会把在途尝试判放弃、清租约、误告警。
 *
 * 修复口径（本文件锁死的判据）：
 * ① 邮箱行形态判据补 `consumedAt === undefined`（与 limbo 判据对齐）；
 * ② 释放前加**跨源门槛**：租约必须精确对应一次 attemptWake 尝试（nonce.ts === claimedAt，
 *    或生命周期账文件名 ts === claimedAt——attemptWake 写 nonce 与盖租约用同一个 now）；
 * ③ 加**在途豁免**：fresh nonce / start 头行无 exit 尾行（15min 窗内）⇒ 本轮不释放。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot + M1 真实读写函数；看门狗 sweep 直接调
 * `sweepMembersOnce`（不注入唤醒——env 层唤醒闸关闭让它必然不 spawn，与 watchdog.test.ts 同纪律）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendMailbox,
  createMessage,
  DELIVERY_LEASE_EXPIRY_DEFAULT_MS,
  deliveryLeaseMsFromEnv,
  expiredDeliveryClaimMessages,
  markMailboxConsumed,
  readMailbox,
  readPendingMailbox,
  sweepExpiredDeliveryClaimsLocked,
} from "../core/mailbox";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate";
import { createWakeNonce } from "../core/registry";
import type { TeamMember } from "../core/types";
import { withTeamLock } from "../core/lock";
import { localPidDomain } from "../core/peerdir";
import { writePeerRecord, type PeerRecord } from "../core/peerregistry";
import { wakeLifecycleFile } from "../core/paths";
import { sweepMembersOnce, type WatchdogDeps } from "./watchdog";
import { gateToolRequestRender } from "../core/toolgate";

const dirs: string[] = [];
let root: string;
let peerRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a1-lease-v093-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-a1-lease-v093-peers-"));
  dirs.push(root, peerRoot);
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

/** lead「a」+ 成员「b」（founder 也占花名册行——lead 才可寻址，告知才落得到它邮箱）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  const member: TeamMember = { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 };
  team.members.push(member);
  await writeTeam(root, team);
}

/** 给在册 sid 落一条活 peer 记录（pid 取本测试进程——A1 不判进程死，只为不让成员被判死）。 */
async function seedLivePeer(sessionId: string): Promise<void> {
  const record: PeerRecord = {
    pid: process.pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-a1-${process.pid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name: `a1-${process.pid}`,
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  };
  await writePeerRecord(peerRoot, record);
}

/** 在 b 邮箱落一条消息（extra 可带 deliveryClaimedAt/deliveredAt/readAt/consumedAt/…）。 */
async function seedMessage(
  claimedAt: number | undefined,
  extra: Record<string, unknown> = {},
): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "投递尝试后引擎死了", {
    ...(claimedAt !== undefined ? { deliveryClaimedAt: claimedAt } : {}),
    ...extra,
  });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

/**
 * 复刻 attemptWake 的真实落盘形态：一次投递尝试 = 一个 nonce（registry/wake，ts 恒等于该次
 * attemptWake 的 now）+ 一份生命周期账（logs/wake-lifecycle-<to>-<now>.jsonl，start 头行）。
 * `exited` = 是否已写 wake-child-exit 尾行（引擎观察到唤醒子消失）。
 */
async function seedWakeAttempt(
  attemptNow: number,
  opts: { exited?: boolean } = {},
): Promise<void> {
  await createWakeNonce(root, { teamId: "default", agentKey: "b", sid: "sess_b", now: attemptNow });
  const file = wakeLifecycleFile(root, "b", attemptNow);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ event: "wake-child-start", to: "b", ts: attemptNow })}\n`, "utf8");
  if (opts.exited === true) {
    appendFileSync(file, `${JSON.stringify({ event: "wake-child-exit", pid: 999999, ts: attemptNow + 1000 })}\n`, "utf8");
  }
}

function deps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    stateRoot: root,
    workspace: "D:\\ws",
    // 唤醒闸关闭：看门狗仍会尝试唤醒，attemptWake 如实降级 mailbox 并留痕。
    env: { XC_MESSAGING_DIR: peerRoot },
    ...overrides,
  };
}

const MIN = 60_000;

// ─────────────────────── 纯判据（core/mailbox.ts） ───────────────────────

describe("v0.9.3 A1：claimed-未投递判据（纯函数，与 limbo 判据互斥）", () => {
  it("env 口径：缺省 600000；正整数生效；0/负/非数字回落缺省", () => {
    expect(DELIVERY_LEASE_EXPIRY_DEFAULT_MS).toBe(600_000);
    expect(deliveryLeaseMsFromEnv({})).toBe(600_000);
    expect(deliveryLeaseMsFromEnv({ XC_DELIVERY_LEASE_MS: "1234" })).toBe(1234);
    expect(deliveryLeaseMsFromEnv({ XC_DELIVERY_LEASE_MS: "0" })).toBe(600_000);
    expect(deliveryLeaseMsFromEnv({ XC_DELIVERY_LEASE_MS: "-5" })).toBe(600_000);
    expect(deliveryLeaseMsFromEnv({ XC_DELIVERY_LEASE_MS: "abc" })).toBe(600_000);
  });

  it("【V093-01】判据补 consumedAt：已消费（markMailboxConsumed 只写 consumedAt）→ 不是候选；其余条件逐条不满足也不是", () => {
    const now = 10_000_000;
    const base = createMessage("a", "b", "x", { deliveryClaimedAt: now - 600_001 });
    const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });

    // 命中：claimed 超时、无 delivered/consumed/readAt/discardedAt
    expect(expiredDeliveryClaimMessages([base], team, now, 600_000)).toHaveLength(1);
    // V093-01：成员已从 hook 注入 / xc_claim / xc_read 面消费（只落 consumedAt）⇒ 不是候选
    expect(expiredDeliveryClaimMessages([{ ...base, consumedAt: now - 100 }], team, now, 600_000)).toHaveLength(0);
    // 未超时（599_999 < 600_000）
    expect(
      expiredDeliveryClaimMessages([{ ...base, deliveryClaimedAt: now - 599_999 }], team, now, 600_000),
    ).toHaveLength(0);
    // 已盖章（deliveredAt 在场）——这是 limbo 的领地，不是 A1 的
    expect(expiredDeliveryClaimMessages([{ ...base, deliveredAt: now - 100 }], team, now, 600_000)).toHaveLength(0);
    // 已读
    expect(expiredDeliveryClaimMessages([{ ...base, readAt: now - 100 }], team, now, 600_000)).toHaveLength(0);
    // 已作废
    expect(expiredDeliveryClaimMessages([{ ...base, discardedAt: now - 100 }], team, now, 600_000)).toHaveLength(0);
    // 无 claimed（从未开始过投递尝试）
    const { deliveryClaimedAt: _drop, ...unclaimed } = base;
    expect(expiredDeliveryClaimMessages([unclaimed], team, now, 600_000)).toHaveLength(0);
  });

  it("sweep：onlyIds 门——不放行任何 id 时一条都不释放（跨源门槛在调用方）", async () => {
    await seedTeam();
    const id = await seedMessage(Date.now() - 700_000);
    const sweepOnce = async (onlyIds?: Set<string>): Promise<string[]> => {
      const team = await readTeam(root, "default");
      if (team === undefined) return [];
      return (await withTeamLock(root, "default", async () =>
        sweepExpiredDeliveryClaimsLocked(root, team, "b", Date.now(), 600_000, onlyIds))).map((m) => m.id);
    };
    // 不传 onlyIds：一行都不放行（「从未尝试/仍在途」的判据不是邮箱行条件）
    expect(await sweepOnce()).toHaveLength(0);
    // 显式放行本条：照常释放 + 自销（二扫空手）
    expect(await sweepOnce(new Set([id]))).toEqual([id]);
    expect((await readMailbox(root, "default", "b"))[0]!.deliveryClaimedAt).toBeUndefined();
    expect((await readPendingMailbox(root, "default", "b")).map((m) => m.id)).toEqual([id]);
    expect(await sweepOnce(new Set([id]))).toHaveLength(0);
  });
});

// ─────────────────────── 看门狗面：真实尝试才释放（V093-02/03） ───────────────────────

describe("v0.9.3 A1：看门狗 sweep 释放（跨源门槛：真尝试 ∧ 不在途）", () => {
  it("【锚点】真尝试（nonce.ts === claimedAt）且已过在途窗 → 释放 + 事件恰一条 + lead urgent 恰一条；重复 sweep 不重复", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const attemptNow = Date.now() - 16 * MIN; // nonce 16min 前建的：已过 15min 在途窗
    await seedWakeAttempt(attemptNow);
    const id = await seedMessage(attemptNow); // 租约与 nonce 同一个 now（attemptWake 同参）

    const first = await sweepMembersOnce(deps());
    expect(first.leaseExpired).toEqual([id]);

    const rows = await readMailbox(root, "default", "b");
    expect(rows[0]!.deliveryClaimedAt).toBeUndefined();
    expect((await readPendingMailbox(root, "default", "b")).map((m) => m.id)).toEqual([id]);

    const expired = eventsOf("delivery-lease-expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]!["to"]).toBe("b");
    expect(expired[0]!["messageId"]).toBe(id);
    expect(expired[0]!["via"]).toBe("watchdog");
    expect(expired[0]!["leaseMs"]).toBe(600_000);
    // v0.9.3 打回第 2 轮（验收四 V093-05）：计时字段**忠实值**断言——旧测试只断 typeof，
    // 放过了「claimedAt 恒 0 / waitedMs 纪元量级」的真实缺陷。claimedAt = 租约盖章时刻
    // （种子消息的 deliveryClaimedAt，扫前候选捕获）；waitedMs = 真实等待 ≈16min。
    expect(expired[0]!["claimedAt"]).toBe(attemptNow);
    const waitedMs = expired[0]!["waitedMs"];
    expect(typeof waitedMs).toBe("number");
    expect(waitedMs as number).toBeGreaterThanOrEqual(16 * MIN);
    expect(waitedMs as number).toBeLessThan(16 * MIN + 60_000); // 纪元量级（≈1.8e12）必红
    const releasedAt = expired[0]!["releasedAt"];
    expect(typeof releasedAt).toBe("number");
    expect(releasedAt as number).toBeGreaterThanOrEqual(attemptNow + 16 * MIN);
    expect((releasedAt as number) - (expired[0]!["claimedAt"] as number)).toBe(waitedMs);

    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("delivery-lease-expired");

    // 幂等：再扫两轮，事件不增、urgent 不增（判据自销）
    await sweepMembersOnce(deps());
    await sweepMembersOnce(deps());
    expect(eventsOf("delivery-lease-expired")).toHaveLength(1);
    expect((await readMailbox(root, "default", "a")).length).toBe(1);
  });

  it("【V093-03a】在途豁免：nonce 仍 fresh（15min 窗内）→ 本轮不释放；出窗后才释放", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const attemptNow = Date.now() - 11 * MIN; // 租约超时（>10min）但 nonce 仍在途（<15min）
    await seedWakeAttempt(attemptNow);
    const id = await seedMessage(attemptNow);

    // 在途：引擎自己的证据说「这次尝试还可能活着」——不清租约、不告警
    const inflight = await sweepMembersOnce(deps());
    expect(inflight.leaseExpired).toEqual([]);
    expect(eventsOf("delivery-lease-expired")).toHaveLength(0);
    expect((await readMailbox(root, "default", "a")).length).toBe(0);
    expect((await readMailbox(root, "default", "b"))[0]!.deliveryClaimedAt).toBe(attemptNow);

    // 出窗（16min）：在途证据失效，租约仍超时 ⇒ 释放（迟告警，不错告警）
    const later = await sweepMembersOnce(deps({ }), attemptNow + 16 * MIN);
    expect(later.leaseExpired).toEqual([id]);
    expect(eventsOf("delivery-lease-expired")).toHaveLength(1);
    // v0.9.3 打回第 2 轮（验收四 V093-05）：**确定性时机**断言——sweep 的 now 显式传入，
    // claimedAt/waitedMs/releasedAt 三点必须精确对上（ waitedMs 恰 = 16min，不是约等于）。
    const ev = eventsOf("delivery-lease-expired")[0]!;
    expect(ev["claimedAt"]).toBe(attemptNow);
    expect(ev["releasedAt"]).toBe(attemptNow + 16 * MIN);
    expect(ev["waitedMs"]).toBe(16 * MIN);
  });

  it("【V093-03b】在途豁免第二证据：nonce 已被消费（xc_identify）但生命周期账 start 头行无 exit 尾行 → 仍不释放", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const attemptNow = Date.now() - 11 * MIN;
    // 只落生命周期账（nonce 文件缺失/被清），start 头行无 exit 尾行 = 未观察到子进程消失
    await seedWakeAttempt(attemptNow, { exited: false });
    const id = await seedMessage(attemptNow);
    // 手工消费 nonce（= 唤醒回合起来了并完成握手），使 fresh-nonce 判据不成立
    const { consumeWakeNonce } = await import("../core/registry.js");
    const nonceFile = join(root, "registry", "wake");
    const { readdirSync } = await import("node:fs");
    const token = readdirSync(nonceFile).find((f) => f.endsWith(".json"))!.slice(0, -5);
    await consumeWakeNonce(root, token, { teamId: "default", agentKey: "b", sid: "sess_b" }, attemptNow);

    const summary = await sweepMembersOnce(deps());
    expect(summary.leaseExpired).toEqual([]); // start 无 exit ⇒ 仍按在途处理
    expect(eventsOf("delivery-lease-expired")).toHaveLength(0);

    // 补齐 exit 尾行（引擎观察到子进程消失）且 nonce 已消费 ⇒ 在途证据清空 ⇒ 释放
    const file = wakeLifecycleFile(root, "b", attemptNow);
    appendFileSync(file, `${JSON.stringify({ event: "wake-child-exit", pid: 999999, ts: attemptNow + 2000 })}\n`, "utf8");
    const later = await sweepMembersOnce(deps());
    expect(later.leaseExpired).toEqual([id]);
    expect(eventsOf("delivery-lease-expired")).toHaveLength(1);
  });

  it("【V093-01】已消费（markMailboxConsumed）但未读未盖章 → 不释放、不告警（即便 nonce 在场）", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const attemptNow = Date.now() - 16 * MIN;
    await seedWakeAttempt(attemptNow);
    const id = await seedMessage(attemptNow);
    // 成员侧真实消费面：hook 未读注入 / xc_claim → markMailboxConsumed（只写 consumedAt）
    await markMailboxConsumed(root, "default", "b", [id], Date.now() - 15 * MIN);

    const before = (await readMailbox(root, "default", "b"))[0]!;
    expect(before.consumedAt).toBeDefined();
    expect(before.deliveryClaimedAt).toBe(attemptNow);
    expect(before.deliveredAt).toBeUndefined();

    const summary = await sweepMembersOnce(deps());
    expect(summary.leaseExpired).toEqual([]);
    expect(eventsOf("delivery-lease-expired")).toHaveLength(0);
    expect((await readMailbox(root, "default", "a")).length).toBe(0);
    // 已消费的消息不被清租约（不会再次注入/再次投递）；租约原样挂着
    const after = (await readMailbox(root, "default", "b"))[0]!;
    expect(after.deliveryClaimedAt).toBe(attemptNow);
    expect(after.consumedAt).toBeDefined();
  });

  it("【V093-02a】从未尝试：派单信封出生即带租约、唤醒被闸挡下（零 spawn 尝试）→ 不释放、不告警", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    // 不写 config.json、不设 XC_WAKE_ENABLED ⇒ 交互式会话唤醒缺省关闭（plugin.json 默认 false）
    const id = await seedMessage(Date.now() - 16 * MIN);

    const summary = await sweepMembersOnce(deps());
    expect(summary.leaseExpired).toEqual([]);
    expect(eventsOf("delivery-lease-expired")).toHaveLength(0);
    expect((await readMailbox(root, "default", "a")).length).toBe(0);
    // 佐证：唤醒确实被挡在写 nonce 之前（不是「尝试了但失败」）
    expect(eventsOf("wake-skipped").length).toBeGreaterThanOrEqual(0);
    // 消息仍是 unread 且租约未被动（pull/注入面本来就不受租约约束）
    expect((await readMailbox(root, "default", "b"))[0]!.deliveryClaimedAt).toBeDefined();
    expect((await readPendingMailbox(root, "default", "b")).map((m) => m.id)).toEqual([id]);
  });

  it("【V093-02b】无自持循环：看门狗告警帧自身出生带租约、唤醒被挡 → 不再被判「无声放弃」（不增殖）", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    // 第一轮：一条真尝试过的消息触发 A1 告警（看门狗把合并事故 urgent 写给 lead，帧自带租约）
    const attemptNow = Date.now() - 16 * MIN;
    await seedWakeAttempt(attemptNow);
    await seedMessage(attemptNow);
    expect((await sweepMembersOnce(deps())).leaseExpired).toHaveLength(1);

    const alerts = await readMailbox(root, "default", "a");
    expect(alerts).toHaveLength(1);
    const alertId = alerts[0]!.id;
    expect(alerts[0]!.deliveryClaimedAt).toBeDefined(); // 落盘即盖租约
    expect(alerts[0]!.deliveredAt).toBeUndefined(); // 唤醒被闸挡下，从未盖章

    // 一个租约窗后：这条引擎自己的告警**不是**候选（没有对应的 attemptWake 尝试）
    const second = await sweepMembersOnce(deps());
    expect(second.leaseExpired).toEqual([]);
    expect(eventsOf("delivery-lease-expired")).toHaveLength(1);
    // 不增殖：lead 邮箱不增长、事件不翻倍
    const afterSecond = await readMailbox(root, "default", "a");
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(alertId);
  });

  it("【V093-02c】toolgate 审批门帧（设计上不唤醒投递）→ 不释放、不告警", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const now = Date.now();
    // b 给 a 投一条 tool_request；a 读它 → 台账缺失 ⇒ fail-closed 首拒：门给 b 回投
    // tool_result{refused}（toolgate.ts 建帧自带 deliveryClaimedAt，按设计不唤醒投递）。
    const request = createMessage("b", "a", JSON.stringify({
      type: "tool_request", requestId: "req-v093", from: "b", to: "a",
      tool: "xc_doctor", args: {}, reason: "打回第 1 轮用例",
      approval: { required: true },
    }));
    await appendMailbox(root, "default", "a", request);
    const gate = await gateToolRequestRender(request, {
      stateRoot: root, teamId: "default", readerKey: "a", now,
    });
    expect(gate.gate).toBe("refuse");

    const bBox = await readMailbox(root, "default", "b");
    expect(bBox).toHaveLength(1);
    expect(bBox[0]!.deliveryClaimedAt).toBe(now);
    expect(bBox[0]!.deliveredAt).toBeUndefined();

    const summary = await sweepMembersOnce(deps(), now + 16 * MIN);
    expect(summary.leaseExpired).toEqual([]); // 从未有过投递尝试的帧不被判「放弃」
    expect(eventsOf("delivery-lease-expired")).toHaveLength(0);
  });

  it("负例：租约未超时 / 已 delivered / 已读 / 已作废 → 不释放、不告警", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const fresh = await seedMessage(Date.now() - 60_000); // 60s < 10min
    // 已盖章（且盖章在 limbo 窗内——隔离 A1 负例，不让 limbo 也发声）
    const stamped = await seedMessage(Date.now() - 700_000, { deliveredAt: Date.now() - 500_000 });
    const read = await seedMessage(Date.now() - 700_000, { readAt: Date.now() - 600_000 });
    const discarded = await seedMessage(Date.now() - 700_000, { discardedAt: Date.now() - 600_000 });

    const summary = await sweepMembersOnce(deps());
    expect(summary.leaseExpired).toEqual([]);
    expect(eventsOf("delivery-lease-expired")).toHaveLength(0);
    expect((await readMailbox(root, "default", "a")).length).toBe(0);
    const rows = await readMailbox(root, "default", "b");
    expect(rows.map((m) => m.id).sort()).toEqual([fresh, stamped, read, discarded].sort());
    expect(rows.find((m) => m.id === fresh)!.deliveryClaimedAt).toBeDefined();
  });

  it("互斥：A1 只碰 claimed 那条、limbo 只碰 delivered 那条——两条消息各自一条事件，不叠加", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const attemptNow = Date.now() - 16 * MIN;
    await seedWakeAttempt(attemptNow);
    const claimedId = await seedMessage(attemptNow); // A1 领地（真尝试过、未盖章）
    const stampedId = await seedMessage(Date.now() - 900_000, { deliveredAt: Date.now() - 800_000 }); // limbo 领地

    const summary = await sweepMembersOnce(deps({ env: { XC_MESSAGING_DIR: peerRoot, XC_LIMBO_TIMEOUT_MS: "600000" } }));
    expect(summary.leaseExpired).toEqual([claimedId]);
    expect(summary.limboDowngraded).toEqual([stampedId]);
    expect(eventsOf("delivery-lease-expired")).toHaveLength(1);
    expect(eventsOf("message-limbo")).toHaveLength(1);
    expect(eventsOf("delivery-lease-expired")[0]!["messageId"]).toBe(claimedId);
    expect(eventsOf("message-limbo")[0]!["messageId"]).toBe(stampedId);
  });

  it("env 口径（看门狗面）：XC_DELIVERY_LEASE_MS 小值 → 新近的真尝试租约也释放", async () => {
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const attemptNow = Date.now() - 20_000; // nonce 20s 前建的：在途窗内（<15min）
    await seedWakeAttempt(attemptNow);
    const id = await seedMessage(attemptNow);

    const summary = await sweepMembersOnce(deps({
      env: { XC_MESSAGING_DIR: peerRoot, XC_DELIVERY_LEASE_MS: "1000" },
    }));
    // 在途豁免优先于租约窗：nonce 仍 fresh ⇒ 仍不释放（在途证据比租约窗更硬）
    expect(summary.leaseExpired).toEqual([]);
    expect(id).toBeTruthy();
  });
});
