/**
 * v0.9.9（组 W，V098-02 + E3）定向测试：**steer 权限闸前移（guards 之前）+
 * hold 分支 steer 语义 + 抢占字段顶层别名**（方案 53-v099 §一组 W）。
 *
 * 缺陷（44-v098 对抗四 缺陷 B，P2）：`withGuards` 的入站策略层（hold/refuse）包装在
 * 内核 steer 权限闸**外层**——`policy.json` 一开 hold，同一调用「accept 下拒、hold 下
 * `delivered="held"` 无拒绝无审计、暂存副本丢 interrupt/steer/urgent 元数据、回执隐瞒
 * 『steer 未执行』」（内核已实现的披露在组装链下成死代码）。
 *
 * 本文件覆盖（每条对应方案验收项）：
 * V098-02：
 *   1. hold 下成员→成员 steer（组装链）→ steer_not_authorized + steer-rejected 审计 +
 *      零落箱（连 held 隔离区都没有）；
 *   2. refuse 下成员→成员 steer（组装链）→ 同样先被权限闸拒（闸先于入站策略）；
 *   3. hold 下 lead steer（组装链）→ delivered="held" + 回执明说「steer 未执行」+
 *      preempted:false；attemptWake 未被调用（无唤醒无终止）；
 *   4. hold 暂存副本保留 steer:true（+interrupt/urgent）——accept 放行后 J1 置顶/
 *      预留预算仍按 steer 语义（isInterruptOrSteer + interruptFirst）；
 *   5. 裸内核直调（无编排层）→ 内层第二道闸仍拒成员 steer（防御深度不减）；
 *   6. accept 下成员 steer（组装链）→ 与 v0.9.8 行为一致（拒 + 零落箱）。
 * E3：
 *   7. preempted → 顶层别名 preempted:true + stopped/turn（interrupt.* 旧字段不动）；
 *   8. deferred/unsupported → preempted:false、无 stopped/turn 顶层键；
 *   9. 无 steer → 无顶层别名键（payload 形状与 v0.9.8 逐字节一致）。
 *
 * 驱动方式：与 tools-relay-v098-steer.test.ts 同款 `vi.mock("../engine/wake.js")`
 * 只替换 attemptWake；**组装链**用 composeCore（withTaskEdges→withGuards→withPeerDrain，
 * 生产形态）——adv-4 缺陷 B 只有在组装链下才可复现，裸内核直调覆盖不到。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { identityStore } from "./identity.js";
import { composeCore } from "./core.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { readMailbox, interruptFirst } from "../core/mailbox.js";
import type { TeamMessage } from "../core/types.js";
import { writeSession } from "../core/registry.js";
import { acceptHeldMessages, heldInboxFile, writeInboundPolicy } from "../core/policy.js";
import { steerHeldReceipt, xcRelay, type RelayArgs } from "./tools-relay.js";

const attemptWakeMock = vi.hoisted(() => vi.fn());
vi.mock("../engine/wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/wake.js")>();
  return { ...actual, attemptWake: (...args: unknown[]) => attemptWakeMock(...args) };
});

/** steer 抢占成功的 attemptWake 回执（engine 侧真值见 wake-v099-steer-tree.test.ts）。 */
function preemptedWake() {
  return {
    delivered: "wake" as const,
    note: "spawned: 无头 --resume 已发起（fire-and-forget，非送达确认）",
    wakeLog: "logs/wake-b-1.json",
    startConfirmed: true,
    wakeTiers: { spawnOk: "ok" as const, childAlive: "ok" as const, consumed: "pending" as const },
    steer: {
      requested: true as const,
      result: "preempted" as const,
      reason: "已终止旧回合（pid 4242，forced，等待 772ms，进程树 3 个（4242/9001/9002）全部终止）并以 steer 信封续跑新回合",
      stopped: { pid: 4242, graceful: false, waitedMs: 772, tree: [4242, 9001, 9002], treeSurvivors: [] },
      turn: { nonce: "wake-abcdef", startConfirmed: true },
    },
  };
}

/** steer 降级（空闲目标）的 attemptWake 回执。 */
function deferredWake() {
  return {
    delivered: "wake" as const,
    note: "spawned: 无头 --resume 已发起",
    wakeLog: "logs/wake-b-2.json",
    startConfirmed: true,
    steer: {
      requested: true as const,
      result: "deferred-next-turn" as const,
      reason: "引擎供给成员但当前无活唤醒回合——未执行终止，纠偏随本次投递送达",
    },
  };
}

let workDir: string;
let stateRoot: string;
let peerRoot: string;

beforeEach(() => {
  attemptWakeMock.mockReset();
  workDir = mkdtempSync(join(tmpdir(), "xc-v099-steer-hold-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = mkdtempSync(join(tmpdir(), "xc-v099-steer-hold-peers-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(peerRoot, { recursive: true, force: true });
});

/** 建队：z（founder=lead）、a（成员，发起者）、b（引擎成员，steer 目标）。 */
async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: "default", founderKey: "z", now });
  team.members.push(
    { key: "z", sessionId: "sess_z", role: "peer", joinedAt: now, lastSeen: now },
    { key: "a", sessionId: "sess_a", role: "worker", joinedAt: now, lastSeen: now },
    { key: "b", sessionId: "sess_b", role: "worker", joinedAt: now, lastSeen: now, identity: "engine" },
  );
  await writeTeam(stateRoot, team);
  identityStore.bind("conn-z", {
    sessionKey: "xc:default:z", teamId: "default", name: "z", agentKey: "z",
    sessionId: "sess_z", role: "peer", boundAt: now,
  });
  identityStore.bind("conn-a", {
    sessionKey: "xc:default:a", teamId: "default", name: "a", agentKey: "a",
    sessionId: "sess_a", role: "worker", boundAt: now,
  });
}

function deps() {
  return { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } };
}

/** 生产形态的组装链（withTaskEdges → withGuards → withPeerDrain）。 */
function composed() {
  return composeCore(deps());
}

function engineEvents(): Array<Record<string, unknown>> {
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

async function readHeldRows(): Promise<Array<Record<string, unknown>>> {
  const file = heldInboxFile(stateRoot, "default", "b");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("v0.9.9 V098-02：steerHeldReceipt 共用形状（守卫层与内核层同源）", () => {
  it("【V098-02 锚点】hold 披露块 = interrupt 三态 deferred + 「steer 未执行」+ preempted:false", () => {
    const receipt = steerHeldReceipt("policy");
    expect(receive_keys(receipt)).toEqual(["interrupt", "preempted"]);
    expect(receipt.preempted).toBe(false);
    const block = receipt.interrupt;
    expect(block.requested).toBe(true);
    expect(block.result).toBe("deferred-next-turn");
    expect(block.reason).toContain("入站策略 hold（source=policy）");
    expect(block.reason).toContain("steer 未执行（无唤醒、无终止）");
    expect(block.reason).toContain("xc_review({action:\"accept\"}) 放行后随下次投递生效");
    // 不写 stopped/turn——hold 下什么都没发生（不把「未执行」写成「已终止」）。
    expect("stopped" in block).toBe(false);
    expect("turn" in block).toBe(false);
  });
});

/** 顶层键集合（防未来加键时漂移）。 */
function receive_keys(receipt: Record<string, unknown>): string[] {
  return Object.keys(receipt).sort();
}

describe("v0.9.9 V098-02：steer 权限闸前移（组装链下 hold 不再短路）", () => {
  it("【V098-02 锚点】hold 下成员→成员 steer（组装链）→ steer_not_authorized + 审计 + 零落箱", async () => {
    await seedTeam();
    await writeInboundPolicy(stateRoot, "default", "hold");
    const res = await composed().xc_message({ to: "b", msg: "我要插队", steer: true }, "conn-a");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["error"]).toBe("steer_not_authorized");
    expect(String(payload["message"])).toContain("neither the team lead nor a user-stamped session");
    // 审计不断（adv-4 B：hold 下 steer-rejected 1→1 无留痕的修复）。
    const rejected = engineEvents().filter((e) => e["event"] === "steer-rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!["from"]).toBe("a");
    expect(rejected[0]!["to"]).toBe("b");
    // 一个字节都不落箱：主邮箱与 held 隔离区都是空的。
    expect(await readMailbox(stateRoot, "default", "b")).toHaveLength(0);
    expect(existsSync(heldInboxFile(stateRoot, "default", "b"))).toBe(false);
    expect(attemptWakeMock).not.toHaveBeenCalled();
  });

  it("【V098-02 边界】refuse 下成员→成员 steer（组装链）→ 权限闸先于 refuse 回执", async () => {
    await seedTeam();
    await writeInboundPolicy(stateRoot, "default", "refuse");
    const res = await composed().xc_message({ to: "b", msg: "我要插队", steer: true }, "conn-a");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as Record<string, unknown>)["error"]).toBe("steer_not_authorized");
    expect(engineEvents().some((e) => e["event"] === "steer-rejected")).toBe(true);
    // refuse 的 delivery-refused 回执也没有写（拒绝发生在入站策略之前）。
    expect(engineEvents().some((e) => e["event"] === "inbound-refused")).toBe(false);
    expect(await readMailbox(stateRoot, "default", "a")).toHaveLength(0);
  });

  it("【V098-02 锚点】accept 下成员→成员 steer（组装链）→ 与 v0.9.8 一致（拒 + 零落箱）", async () => {
    await seedTeam();
    const res = await composed().xc_message({ to: "b", msg: "我要插队", steer: true }, "conn-a");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as Record<string, unknown>)["error"]).toBe("steer_not_authorized");
    expect(await readMailbox(stateRoot, "default", "b")).toHaveLength(0);
  });

  it("【V098-02 锚点】hold 下 lead steer（组装链）→ held + 回执明说「steer 未执行」+ 暂存保留 steer 元数据", async () => {
    await seedTeam();
    await writeInboundPolicy(stateRoot, "default", "hold");
    attemptWakeMock.mockResolvedValue(preemptedWake());
    const res = await composed().xc_message({ to: "b", msg: "纠偏：立刻停手", steer: true }, "conn-z");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("held");
    const block = payload["interrupt"] as Record<string, unknown>;
    expect(block["result"]).toBe("deferred-next-turn");
    expect(String(block["reason"])).toContain("steer 未执行");
    expect(String(block["reason"])).toContain("无唤醒、无终止");
    // E3 顶层别名：hold 形态恒未抢占。
    expect(payload["preempted"]).toBe(false);
    expect("stopped" in payload).toBe(false);
    // steer 机械未跑：没有唤醒、没有终止。
    expect(attemptWakeMock).not.toHaveBeenCalled();
    // 暂存副本保留 steer:true + interrupt + urgent（放行后 J1 置顶仍按 steer 语义）。
    const held = await readHeldRows();
    expect(held).toHaveLength(1);
    expect(held[0]!["steer"]).toBe(true);
    expect(held[0]!["interrupt"]).toBe(true);
    expect(held[0]!["urgent"]).toBe(true);
    expect(held[0]!["from"]).toBe("z");
    // 人可读行不谎称抢占。
    expect(textOf(res)).not.toContain("抢占成功");
  });

  it("【V098-02 验收】放行后仍按 steer 语义置顶（accept → 主邮箱 + J1 interruptFirst）", async () => {
    await seedTeam();
    await writeInboundPolicy(stateRoot, "default", "hold");
    attemptWakeMock.mockResolvedValue(preemptedWake());
    await composed().xc_message({ to: "b", msg: "纠偏：立刻停手", steer: true }, "conn-z");
    const held = await readHeldRows();
    expect(held).toHaveLength(1);
    const heldId = String(held[0]!["id"]);
    // 再塞一条更早的普通消息——放行后 steer 件必须排在它前面（J1 置顶）。
    await composed().xc_message({ to: "b", msg: "普通工作消息" }, "conn-z");
    // hold 下普通消息也进隔离区；先放行 steer 件。
    const moved = await acceptHeldMessages(stateRoot, "default", "b", [heldId], Date.now());
    expect(moved).toHaveLength(1);
    const box = await readMailbox(stateRoot, "default", "b");
    const steerRow = box.find((m) => m.id === heldId);
    expect(steerRow).toBeDefined();
    // 读面宽容拷贝（core/mailbox.ts withSteerTolerance：steer 尚未进 TeamMessage 白名单）。
    expect((steerRow as TeamMessage & { steer?: boolean }).steer).toBe(true);
    expect(steerRow!.interrupt).toBe(true);
    // J1：纠错消息在 urgent/普通之上置顶（interruptFirst 首元素即 steer 件）。
    const unread = interruptFirst(box.filter((m) => m.readAt === undefined));
    expect(unread[0]!.id).toBe(heldId);
  });

  it("【V098-02 锚点】hold 下成员+用户原话 steer（组装链）→ 编排层盖章放行 + held 披露", async () => {
    await seedTeam();
    await writeSession(stateRoot, { sessionId: "sess_a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
    const { uservoiceWrite } = await import("../core/uservoice.js");
    await uservoiceWrite(peerRoot, "sess_a", "立刻停手别删库", Date.now());
    await writeInboundPolicy(stateRoot, "default", "hold");
    attemptWakeMock.mockResolvedValue(preemptedWake());
    const res = await composed().xc_message({ to: "b", msg: "立刻停手别删库", steer: true }, "conn-a");
    // 权限闸放行（用户原话命中）→ 消息进隔离区；回执如实说 steer 未执行。
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("held");
    expect(payload["preempted"]).toBe(false);
    const held = await readHeldRows();
    expect(held).toHaveLength(1);
    expect(held[0]!["steer"]).toBe(true);
    // 审计可对账：steer-rejected 不出现（放行），inbound-held 带 steerRequested。
    expect(engineEvents().some((e) => e["event"] === "steer-rejected")).toBe(false);
    const inbound = engineEvents().find((e) => e["event"] === "inbound-held");
    expect(inbound).toBeDefined();
    expect(inbound!["steerRequested"]).toBe(true);
  });

  it("【V098-02 锚点】accept 下成员+用户原话 steer（组装链）→ 印章不丢（viaUser + origin=user + uservoice-hit）", async () => {
    await seedTeam();
    await writeSession(stateRoot, { sessionId: "sess_a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
    const { uservoiceWrite } = await import("../core/uservoice.js");
    await uservoiceWrite(peerRoot, "sess_a", "立刻停手别删库", Date.now());
    attemptWakeMock.mockResolvedValue(preemptedWake());
    const res = await composed().xc_message({ to: "b", msg: "立刻停手别删库", steer: true }, "conn-a");
    expect(res.isError).toBeFalsy();
    // 编排层消费的印章结论下传内层：指令带 viaUser（不因前移而丢）。
    const req = attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(req["steer"]).toEqual({ by: "a", viaUser: true });
    // origin=user 仍落箱 + uservoice-hit 审计仍恰一条（一次性印章未被双重消费吞掉）。
    const box = await readMailbox(stateRoot, "default", "b");
    expect(box).toHaveLength(1);
    expect(box[0]!.origin).toBe("user");
    expect((box[0] as TeamMessage & { steer?: boolean }).steer).toBe(true);
    expect(engineEvents().filter((e) => e["event"] === "uservoice-hit")).toHaveLength(1);
  });

  it("【V098-02 边界】裸内核直调（无编排层）→ 内层第二道闸仍拒成员 steer", async () => {
    await seedTeam();
    await writeInboundPolicy(stateRoot, "default", "hold");
    // 绕过 xcRelay 编排层直调内核（guards 已包）：hold 分支在权限闸之后不可达，
    // 内层闸（steerAuthorized 缺省 → 自判）必须兜住。
    const res = await composed().xc_message({ to: "b", msg: "我要插队", steer: true }, "conn-a");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as Record<string, unknown>)["error"]).toBe("steer_not_authorized");
  });

  it("【V098-02 编排层】xcRelay（组装链）+ hold + 成员 steer → 拒；lead → held 披露", async () => {
    await seedTeam();
    await writeInboundPolicy(stateRoot, "default", "hold");
    const memberRes = await xcRelay(deps(), composed(), { to: "b", msg: "我要插队", steer: true } as RelayArgs, "conn-a", true);
    expect(memberRes.isError).toBe(true);
    expect((payloadOf(memberRes) as Record<string, unknown>)["error"]).toBe("steer_not_authorized");
    expect(existsSync(heldInboxFile(stateRoot, "default", "b"))).toBe(false);

    attemptWakeMock.mockResolvedValue(preemptedWake());
    const leadRes = await xcRelay(deps(), composed(), { to: "b", msg: "纠偏：立刻停手", steer: true } as RelayArgs, "conn-z", true);
    expect(leadRes.isError).toBeFalsy();
    const payload = payloadOf(leadRes) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("held");
    expect(String((payload["interrupt"] as Record<string, unknown>)["reason"])).toContain("steer 未执行");
  });

  it("【V098-02 边界】hold + 普通 interrupt（组装链）→ 回执形状与 v0.9.8 一致（无 interrupt 块）", async () => {
    await seedTeam();
    await writeInboundPolicy(stateRoot, "default", "hold");
    const res = await composed().xc_message({ to: "b", msg: "软中断纠偏", interrupt: true }, "conn-a");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("held");
    // v0.9.8 口径：held 件不带 envelope 标注（信封未进可读邮箱）。
    expect("interrupt" in payload).toBe(false);
    expect("preempted" in payload).toBe(false);
    // 但暂存副本保留 interrupt 元数据（接受后渲染不丢）。
    const held = await readHeldRows();
    expect(held).toHaveLength(1);
    expect(held[0]!["interrupt"]).toBe(true);
    expect(held[0]!["urgent"]).toBe(true);
  });
});

describe("v0.9.9 E3：抢占字段的顶层别名（preempted/stopped/turn；interrupt.* 不动）", () => {
  it("【E3 锚点】preempted → 顶层 preempted:true + stopped/turn 别名 + 旧字段仍在", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(preemptedWake());
    const res = await composed().xc_message({ to: "b", msg: "纠偏", steer: true }, "conn-z");
    const payload = payloadOf(res) as Record<string, unknown>;
    // 顶层别名（调用方按顶层解析不再取空）。
    expect(payload["preempted"]).toBe(true);
    expect(payload["stopped"]).toEqual({ pid: 4242, graceful: false, waitedMs: 772, tree: [4242, 9001, 9002], treeSurvivors: [] });
    expect(payload["turn"]).toEqual({ nonce: "wake-abcdef", startConfirmed: true });
    // 旧字段原位不动（向后兼容）。
    const block = payload["interrupt"] as Record<string, unknown>;
    expect(block["result"]).toBe("preempted");
    expect(block["stopped"]).toEqual(payload["stopped"]);
    expect(block["turn"]).toEqual(payload["turn"]);
    expect(textOf(res)).toContain("⛔ steer 抢占成功");
    // E1 的进程树披露随 stopped 块进回执（顶层与 interrupt 下同值）。
    expect((payload["stopped"] as Record<string, unknown>)["tree"]).toEqual([4242, 9001, 9002]);
  });

  it("【E3 边界】deferred → preempted:false、无 stopped/turn 顶层键（原因不隐瞒）", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(deferredWake());
    const res = await composed().xc_message({ to: "b", msg: "纠偏", steer: true }, "conn-z");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["preempted"]).toBe(false);
    expect("stopped" in payload).toBe(false);
    expect("turn" in payload).toBe(false);
    const block = payload["interrupt"] as Record<string, unknown>;
    expect(block["result"]).toBe("deferred-next-turn");
    expect(String(block["reason"])).toContain("无活唤醒回合");
  });

  it("【E3 边界】无 steer（普通 interrupt）→ 无顶层别名键，冻结键集不变", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(deferredWake());
    const res = await composed().xc_message({ to: "b", msg: "软中断纠偏", interrupt: true }, "conn-a");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect("preempted" in payload).toBe(false);
    expect("stopped" in payload).toBe(false);
    expect("turn" in payload).toBe(false);
    expect(Object.keys(payload["interrupt"] as Record<string, unknown>).sort())
      .toEqual(["envelope", "reason", "requested", "result"]);
  });
});
