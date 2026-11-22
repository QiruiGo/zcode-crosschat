/**
 * v0.9.8（组 S）定向测试：**xc_relay 的 steer 接线**（方案 49-v098 §二 S1/S4/S5）——
 * 入参 schema、权限闸（S4）、回执形状（S5）、撤回互斥、peer 轴拒绝。
 *
 * 驱动方式：`vi.mock("../engine/wake.js")` 只替换 attemptWake（其余导出走 original）——
 * 终止→续跑机械的真值由 src/engine/wake-v098-steer.test.ts 直驱；本文件只测
 * 「工具面 → attemptWake 的指令形状」与「attemptWake → 回执 payload 的透传」。
 *
 * 覆盖：
 * 1. S1 接线：steer:true → attemptWake 收 reason="steer" + steer{by,viaUser}；
 *    消息落箱带 interrupt:true 元数据（steer 蕴含软中断信封）；
 * 2. S4 权限：成员→成员 steer 被拒（steer_not_authorized，一个字节不落箱）；
 *    lead 放行；用户原话（origin=user 盖章命中）放行；
 * 3. S4 跨 team：peer 轴 steer → steer_peer_axis_unsupported（编排层与发送面双闸）；
 * 4. S5 回执：payload interrupt 块 = steer 三态（preempted 带 stopped/turn；
 *    deferred 不带）；人可读行带 ⛔ 短语；engine message 事件带 steerRequested/steerResult；
 * 5. 撤回互斥：steer + withdrawMessageIds → invalid_params；
 * 6. duplicate + steer → 合成 deferred 块（duplicate 原因如实，不假装抢占）；
 * 7. 普通 interrupt（无 steer）→ 冻结键集不变（{requested,result,reason,envelope}）。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { identityStore } from "./identity.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { readMailbox } from "../core/mailbox.js";
import { writeSession } from "../core/registry.js";
import { uservoiceWrite } from "../core/uservoice.js";
import { createTeamRelayCore, relayPeerSend, xcRelay, type RelayArgs } from "./tools-relay.js";

const attemptWakeMock = vi.hoisted(() => vi.fn());
vi.mock("../engine/wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/wake.js")>();
  return { ...actual, attemptWake: (...args: unknown[]) => attemptWakeMock(...args) };
});

/** steer 抢占成功的 attemptWake 回执（engine 侧真值见 wake-v098-steer.test.ts）。 */
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
      reason: "已终止旧回合（pid 4242，graceful，等待 12ms）并以 steer 信封续跑新回合",
      stopped: { pid: 4242, graceful: true, waitedMs: 12 },
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
  workDir = mkdtempSync(join(tmpdir(), "xc-v098-steer-relay-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = mkdtempSync(join(tmpdir(), "xc-v098-steer-relay-peers-"));
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

function core() {
  return createTeamRelayCore({ stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } });
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

describe("v0.9.8 S1：steer 接线（工具面 → attemptWake 指令形状）", () => {
  it("【S1 锚点】steer:true → attemptWake 收 reason=steer + steer{by}；消息带 interrupt 元数据", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(preemptedWake());
    const res = await core().xc_message({ to: "b", msg: "别删生产库，先跑 dry-run", steer: true }, "conn-z");
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
    const req = attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(req["reason"]).toBe("steer");
    expect(req["steer"]).toEqual({ by: "z" });
    expect(req["urgent"]).toBe(true); // steer 蕴含 interrupt → urgent 排序
    // 消息落箱带 interrupt:true（软中断信封：纠偏即插队）。
    const box = await readMailbox(stateRoot, "default", "b");
    expect(box).toHaveLength(1);
    expect(box[0]!.interrupt).toBe(true);
    expect(box[0]!.urgent).toBe(true);
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("wake");
    expect(payload["urgent"]).toBe(true);
  });

  it("【S1 锚点】用户原话 steer（origin=user 盖章命中）→ viaUser:true 进指令", async () => {
    await seedTeam();
    await writeSession(stateRoot, { sessionId: "sess_a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
    await uservoiceWrite(peerRoot, "sess_a", "立刻停手别删库", Date.now());
    attemptWakeMock.mockResolvedValue(preemptedWake());
    await core().xc_message({ to: "b", msg: "立刻停手别删库", steer: true }, "conn-a");
    const req = attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(req["steer"]).toEqual({ by: "a", viaUser: true });
    // 盖章语义不减：origin=user 仍落箱。
    const box = await readMailbox(stateRoot, "default", "b");
    expect(box[0]!.origin).toBe("user");
  });
});

describe("v0.9.8 S4：steer 权限闸（仅 lead 或用户）", () => {
  it("【S4 锚点】成员→成员 steer → steer_not_authorized，一个字节不落箱", async () => {
    await seedTeam();
    const res = await core().xc_message({ to: "b", msg: "我要插队", steer: true }, "conn-a");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["error"]).toBe("steer_not_authorized");
    expect(String(payload["message"])).toContain("neither the team lead nor a user-stamped session");
    expect(attemptWakeMock).not.toHaveBeenCalled();
    expect(await readMailbox(stateRoot, "default", "b")).toHaveLength(0);
  });

  it("【S4 锚点】lead steer → 放行（attemptWake 被调用）", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(preemptedWake());
    const res = await core().xc_message({ to: "b", msg: "纠偏", steer: true }, "conn-z");
    expect(res.isError).toBeFalsy();
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
  });

  it("【S4 锚点】成员的软中断（interrupt:true，无 steer）→ 不受权限闸影响（功能不减）", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(deferredWake());
    const res = await core().xc_message({ to: "b", msg: "软中断纠偏", interrupt: true }, "conn-a");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as Record<string, unknown>;
    // 无 steer → 冻结键集不变（{requested,result,reason,envelope}）。
    expect(Object.keys(payload["interrupt"] as Record<string, unknown>).sort())
      .toEqual(["envelope", "reason", "requested", "result"]);
    const req = attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(req["reason"]).toBe("message");
    expect(req["steer"]).toBeUndefined();
  });

  it("【S4 锚点】peer 轴 steer → steer_peer_axis_unsupported（跨 team 拒绝）", async () => {
    await seedTeam();
    const res = await xcRelay(
      { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } },
      core(),
      { to: "b[peer]", msg: "跨 team 纠偏", steer: true } as RelayArgs,
      "conn-z",
      false,
    );
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["error"]).toBe("steer_peer_axis_unsupported");
    expect(payload["axis"]).toBe("peer");
  });

  it("【S4 锚点】relayPeerSend 直调同样拒 steer（编排层之外的二道闸）", async () => {
    await seedTeam();
    const me = identityStore.require("conn-z");
    await expect(relayPeerSend(
      { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } },
      me,
      { to: "ghost", msg: "x", steer: true } as RelayArgs,
      "ghost",
      true,
      true,
    )).rejects.toThrow(/steer is team-axis only/);
  });
});

describe("v0.9.8 S5：steer 回执（三态形状 + 人可读行 + 审计）", () => {
  it("【S5 锚点】preempted → interrupt 块 = {requested,result,reason,stopped,turn} + ⛔ 行", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(preemptedWake());
    const res = await core().xc_message({ to: "b", msg: "纠偏", steer: true }, "conn-z");
    const payload = payloadOf(res) as Record<string, unknown>;
    const block = payload["interrupt"] as Record<string, unknown>;
    expect(Object.keys(block).sort()).toEqual(["reason", "requested", "result", "stopped", "turn"]);
    expect(block["result"]).toBe("preempted");
    expect(block["stopped"]).toEqual({ pid: 4242, graceful: true, waitedMs: 12 });
    expect(block["turn"]).toEqual({ nonce: "wake-abcdef", startConfirmed: true });
    const text = textOf(res);
    expect(text).toContain("⛔ steer 抢占成功");
    expect(text).toContain("终止 pid 4242，graceful");
    expect(text).toContain("未落盘进度可能丢失");
  });

  it("【S5 锚点】deferred（空闲降级）→ 无 stopped/turn 块，⛔ 降级措辞（不写抢占成功）", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(deferredWake());
    const res = await core().xc_message({ to: "b", msg: "纠偏", steer: true }, "conn-z");
    const payload = payloadOf(res) as Record<string, unknown>;
    const block = payload["interrupt"] as Record<string, unknown>;
    expect(block["result"]).toBe("deferred-next-turn");
    expect(block["stopped"]).toBeUndefined();
    expect(block["turn"]).toBeUndefined();
    const text = textOf(res);
    expect(text).toContain("⛔ steer 降级（未抢占）");
    expect(text).not.toContain("抢占成功");
  });

  it("【S5 锚点】engine message 事件带 steerRequested + steerResult（审计可对账）", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(preemptedWake());
    await core().xc_message({ to: "b", msg: "纠偏", steer: true }, "conn-z");
    const file = join(stateRoot, "logs", "engine.jsonl");
    const events = (await import("node:fs")).readFileSync(file, "utf8")
      .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    const message = events.find((e) => e["event"] === "message");
    expect(message).toBeDefined();
    expect(message!["steerRequested"]).toBe(true);
    expect(message!["steerResult"]).toBe("preempted");
  });

  it("【S5 边界】duplicate + steer → 合成 deferred 块（既有件即纠偏载体，不假装抢占）", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(deferredWake());
    await core().xc_message({ to: "b", msg: "同文纠偏", steer: true }, "conn-z");
    attemptWakeMock.mockClear();
    const res = await core().xc_message({ to: "b", msg: "同文纠偏", steer: true }, "conn-z");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("duplicate");
    expect(payload["duplicate"]).toBe(true);
    const block = payload["interrupt"] as Record<string, unknown>;
    expect(block["result"]).toBe("deferred-next-turn");
    expect(String(block["reason"])).toContain("duplicate");
    expect(attemptWakeMock).not.toHaveBeenCalled(); // duplicate 不重投、不唤醒
  });

  it("【S5 边界】撤回互斥：steer + withdrawMessageIds → invalid_params", async () => {
    await seedTeam();
    const res = await core().xc_message(
      { to: "b", withdrawMessageIds: ["m1"], steer: true } as RelayArgs,
      "conn-z",
    );
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["error"]).toBe("withdraw_exclusive_params");
    expect(payload["offenders"]).toEqual(["steer"]);
  });

  it("【S4/S5 边界】成员的 steer 在 hold 策略下同样被拒（权限闸先于入站策略，隔离区都不进）", async () => {
    await seedTeam();
    const { writeInboundPolicy } = await import("../core/policy.js");
    await writeInboundPolicy(stateRoot, "default", "hold");
    const res = await core().xc_message({ to: "b", msg: "我要插队", steer: true }, "conn-a");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as Record<string, unknown>)["error"]).toBe("steer_not_authorized");
    // 一个字节都不落箱（连 held 隔离区都没有）。
    expect(await readMailbox(stateRoot, "default", "b")).toHaveLength(0);
    const heldFile = join(stateRoot, "teams", "default", "inbox", "b.held.jsonl");
    expect(existsSync(heldFile)).toBe(false);
  });

  it("【S5 边界】lead 的 steer 被 hold 挡下 → 回执明说 steer 未执行（不假装抢占）", async () => {
    await seedTeam();
    const { writeInboundPolicy } = await import("../core/policy.js");
    await writeInboundPolicy(stateRoot, "default", "hold");
    attemptWakeMock.mockResolvedValue(preemptedWake());
    const res = await core().xc_message({ to: "b", msg: "纠偏", steer: true }, "conn-z");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("held");
    const block = payload["interrupt"] as Record<string, unknown>;
    expect(block["result"]).toBe("deferred-next-turn");
    expect(String(block["reason"])).toContain("steer 未执行");
    expect(attemptWakeMock).not.toHaveBeenCalled(); // hold 件不唤醒 → steer 机械不跑
  });
});
