/**
 * v0.10.0（R8 补充，用户追加裁决）定向测试：**紧急回单不拉进行中的主控**。
 *
 * 裁决原文要义（优先于需求书 R8 里「唤醒收方」的原话）：紧急回单不得把回合正在进行
 * 的主控拉成无头分身（R5 同款事故的回单面复现——17:42 主控正等用户答选项卡时被
 * urgent 唤醒成无头分身）。唤醒决策因此在 B2 基础上加闸：
 * ① 收件人（任务创建者）会话回合正在进行时——**不调用 attemptWake**。判据与忙闲闸
 *    同源：会话记录 liveness='running' ∧ livenessTs 可信（最近一次引擎事件是
 *    session-running 且之后没有 session-idle）；**有在途唤醒也算进行中**（15min 窗内
 *    新鲜未消费的 wake nonce）。回执消息照常 urgent 落邮箱并排在未读最前，消息
 *    content 上打待补醒标记 `wakeDeferred:"recipient-turn-running"`；审计
 *    report-urgent 的 woke=false + reason=recipient-turn-running，另落
 *    report-urgent-deferred{taskId, from, to}；调用方回执明说
 *    「已落邮箱、未唤醒：收方回合进行中，回合结束后送达」。
 * ② 收件人空闲时行为不变：立即 urgent 唤醒。
 * ③ 创建者不是 lead 时给 lead 的那份通知同样遵守①②（通知本来就不唤醒；进行中的
 *    lead 消息上打同一个待补醒标记 + 落一条 to=lead 的 report-urgent-deferred）。
 * ④ 回合结束后的补醒由组 A 在看门狗扫描里做——本测试只锁定「标记与审计落得让它认得
 *    出」，不测补醒本身。
 *
 * 驱动方式同 B1/B2 主测试：vi.mock("../engine/wake.js") 只替换 attemptWake——
 * 「进行中时一次都没调、空闲时照旧调」直接可判；engine.jsonl 与邮箱都是真落盘的。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { attemptWakeMock } = vi.hoisted(() => ({ attemptWakeMock: vi.fn() }));
vi.mock("../engine/wake.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../engine/wake.js")>();
  return { ...original, attemptWake: (...args: unknown[]) => attemptWakeMock(...args) };
});

import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore } from "./core.js";
import { writeSession, newWakeNonce, writeWakeNonce } from "../core/registry.js";
import { engineLogFile } from "../core/paths.js";
import { readMailbox } from "../core/mailbox.js";
import { DEFAULT_TEAM_ID } from "../core/types.js";
import { RECIPIENT_TURN_RUNNING } from "./tools-tasks.js";

const TICKET = {
  title: "紧急回单不拉进行中的主控",
  prompt: "urgent 回单在收方回合进行中时不得唤醒",
  acceptance: "无 attemptWake 调用 + 邮箱 urgent 回执带 wakeDeferred 标记 + 审计 deferred",
} as const;

let workDir: string;
let stateRoot: string;
let core: ToolCore;

beforeEach(async () => {
  attemptWakeMock.mockReset();
  workDir = await mkdtemp(join(tmpdir(), "xc-v0100b-r8b-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({
    stateRoot,
    workspace: workDir,
    env: { XC_MESSAGING_DIR: join(workDir, "peers-root") },
  });
  await register("conn-a", "a", "sess-a"); // founder = lead（默认收件人场景）
  await register("conn-b", "b", "sess-b"); // 执行成员（回报方）
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function register(conn: string, name: string, sid: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  await core.xc_register({ name, sessionId: sid }, conn);
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function textOf(res: ToolResult): string {
  const first = res.content[0];
  return first !== undefined && "text" in first ? first.text : "";
}

/** 把 sid 的会话记录置为「回合进行中」（session-running 之后没有 session-idle）。 */
async function markTurnRunning(sid: string): Promise<void> {
  await writeSession(stateRoot, {
    sessionId: sid,
    cwd: workDir,
    startedAt: Date.now(),
    lastSeen: Date.now(),
    liveness: "running",
    livenessTs: Date.now(),
  });
}

/** 给某成员签一张新鲜未消费的在途 wake nonce（spawn 已发起、回合尚未开跑的形态）。 */
async function seedInflightWake(agentKey: string): Promise<void> {
  const { token, nonce } = newWakeNonce({
    agentKey,
    teamId: DEFAULT_TEAM_ID,
    sid: "sess-inflight-target",
    issuedToSid: "sess-inflight-target",
  });
  await writeWakeNonce(stateRoot, token, nonce);
}

async function dispatchAndClaim(): Promise<{ taskId: string; attemptId: string }> {
  attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });
  const dispatched = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
  const taskId = payloadOf(dispatched)["taskId"] as string;
  const claimed = await core.xc_claim({ taskId }, "conn-b");
  return { taskId, attemptId: payloadOf(claimed)["attemptId"] as string };
}

describe("v0.10.0 R8 补充：紧急回单不拉进行中的主控", () => {
  it("【补充锚点】收件人回合进行中 → 不调用 attemptWake + urgent 回执带待补醒标记 + 审计 deferred", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    await markTurnRunning("sess-a"); // 创建者 a 的回合正在跑（主控桌面回合/无头回合皆命中）
    attemptWakeMock.mockClear();

    const res = await core.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b");
    expect(res.isError).toBeFalsy();

    // ① 一次唤醒都没有发起（不得把在跑的主控拉成无头分身）。
    expect(attemptWakeMock).not.toHaveBeenCalled();
    // ② 回执消息照常 urgent 落邮箱（排在未读最前），content 上打待补醒标记。
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(box.length).toBe(1);
    expect(box[0]!.urgent).toBe(true);
    const frame = JSON.parse(box[0]!.content) as Record<string, unknown>;
    expect(frame["type"]).toBe("task-receipt");
    expect(frame["wakeDeferred"]).toBe(RECIPIENT_TURN_RUNNING);
    // ③ 调用方回执明说「已落邮箱、未唤醒：收方回合进行中，回合结束后送达」。
    const text = textOf(res);
    expect(text.startsWith("【插队回单】")).toBe(true);
    expect(text).toContain("已落邮箱、未唤醒：收方回合进行中，回合结束后送达");
    const payload = payloadOf(res);
    expect(payload["urgent"]).toBe(true);
    expect(payload["wakeBack"]).toBe("mailbox");
    // ④ 审计：report-urgent woke=false + reason；另落 report-urgent-deferred{taskId, from, to}。
    const events = await engineEvents();
    const urgent = events.find((e) => e["event"] === "report-urgent");
    expect(urgent).toBeDefined();
    expect(urgent!["woke"]).toBe(false);
    expect(urgent!["reason"]).toBe(RECIPIENT_TURN_RUNNING);
    expect(urgent!["taskId"]).toBe(taskId);
    expect(urgent!["from"]).toBe("b");
    expect(urgent!["to"]).toBe("a");
    const deferred = events.find((e) => e["event"] === "report-urgent-deferred");
    expect(deferred).toBeDefined();
    expect(deferred!["taskId"]).toBe(taskId);
    expect(deferred!["from"]).toBe("b");
    expect(deferred!["to"]).toBe("a");
    expect(deferred!["reason"]).toBe(RECIPIENT_TURN_RUNNING);
    // 常规 report 事件也带 wakeDeferred 标记（与容量闸的 mailbox 降级可分辨）。
    const report = events.filter((e) => e["event"] === "report").at(-1)!;
    expect(report["wakeDeferred"]).toBe(RECIPIENT_TURN_RUNNING);
    expect(report["wakeBack"]).toBe("mailbox");
  });

  it("在途唤醒（新鲜未消费 nonce）也算进行中 → 同样不唤醒、打标记", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    // 会话记录是 idle（无 running 自述），但有一张在途唤醒票：spawn 已发起、回合未开跑。
    await seedInflightWake("a");
    attemptWakeMock.mockClear();

    const res = await core.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b");
    expect(attemptWakeMock).not.toHaveBeenCalled();
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(JSON.parse(box[0]!.content)["wakeDeferred"]).toBe(RECIPIENT_TURN_RUNNING);
    expect(textOf(res)).toContain("收方回合进行中，回合结束后送达");
    expect((await engineEvents()).some((e) => e["event"] === "report-urgent-deferred" && e["to"] === "a")).toBe(true);
  });

  it("【硬回归】收件人空闲 → 立即 urgent 唤醒（补充裁决不改空闲行为）", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    attemptWakeMock.mockClear();
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });

    const res = await core.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b");
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
    expect((attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>)["urgent"]).toBe(true);
    // 回执无待补醒标记、审计 woke=true、无 report-urgent-deferred。
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(JSON.parse(box[0]!.content)["wakeDeferred"]).toBeUndefined();
    const events = await engineEvents();
    expect(events.find((e) => e["event"] === "report-urgent")!["woke"]).toBe(true);
    expect(events.find((e) => e["event"] === "report-urgent")!["reason"]).toBeUndefined();
    expect(events.some((e) => e["event"] === "report-urgent-deferred")).toBe(false);
    const text = textOf(res);
    expect(text.startsWith("【插队回单】")).toBe(true);
    expect(text).not.toContain("回合进行中");
  });

  it("③ 创建者不是 lead：进行中的 lead 不被唤醒，通知带同一待补醒标记 + to=lead 的 deferred 审计", async () => {
    await register("conn-c", "c", "sess-c"); // 派单方（创建者，非 lead）
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });
    const dispatched = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-c");
    expect(dispatched.isError).toBeFalsy();
    const taskId = payloadOf(dispatched)["taskId"] as string;
    const claimed = await core.xc_claim({ taskId }, "conn-b");
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    await markTurnRunning("sess-a"); // lead a 的回合正在跑；创建者 c 空闲
    attemptWakeMock.mockClear();
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });

    const res = await core.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b");

    // 只唤醒创建者 c（lead a 不被唤醒——通知路径本来就不唤醒）。
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
    expect((attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>)["toAgentKey"]).toBe("c");
    // lead a 的通知消息带同一个待补醒标记。
    const leadBox = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(leadBox.length).toBe(1);
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain(`wakeDeferred:"${RECIPIENT_TURN_RUNNING}"`);
    // 审计：report-urgent 的 woke=true（创建者唤醒成功）+ leadDeferred 标记；
    // report-urgent-deferred 落 to=lead 一条（target=lead-notice）。
    const events = await engineEvents();
    const urgent = events.find((e) => e["event"] === "report-urgent")!;
    expect(urgent["woke"]).toBe(true);
    expect(urgent["leadNotified"]).toBe(true);
    expect(urgent["leadDeferred"]).toBe(true);
    const leadDeferred = events.find((e) => e["event"] === "report-urgent-deferred" && e["to"] === "a")!;
    expect(leadDeferred["from"]).toBe("b");
    expect(leadDeferred["target"]).toBe("lead-notice");
    expect(leadDeferred["reason"]).toBe(RECIPIENT_TURN_RUNNING);
    // 调用方回执：创建者唤醒成功 → 不写「回合进行中」。
    expect(textOf(res)).not.toContain("收方回合进行中");
  });

  it("③ 对照：lead 空闲时给 lead 的通知不带标记、无 to=lead 的 deferred 审计", async () => {
    await register("conn-c", "c", "sess-c");
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });
    const dispatched = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-c");
    const taskId = payloadOf(dispatched)["taskId"] as string;
    const claimed = await core.xc_claim({ taskId }, "conn-b");
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    attemptWakeMock.mockClear();
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });

    await core.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b");
    const leadBox = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(leadBox.length).toBe(1);
    expect(leadBox[0]!.content).not.toContain("wakeDeferred");
    const events = await engineEvents();
    expect(events.some((e) => e["event"] === "report-urgent-deferred")).toBe(false);
    expect(events.find((e) => e["event"] === "report-urgent")!["leadDeferred"]).toBeUndefined();
  });

  it("【硬回归】无 urgent 的普通回报完全不触闸（不看回合状态、不读 nonce、行为逐字节不变）", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    await markTurnRunning("sess-a"); // 创建者回合进行中
    attemptWakeMock.mockClear();

    const res = await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-b");
    expect(attemptWakeMock).not.toHaveBeenCalled(); // 普通中间态本来就不唤醒
    expect(await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a")).toHaveLength(0); // 无回执
    expect(textOf(res)).toBe(`Task ${taskId} in_progress; no receipt (non-terminal); wake back via mailbox.`);
    expect((await engineEvents()).some((e) => e["event"] === "report-urgent")).toBe(false);
    expect((await engineEvents()).some((e) => e["event"] === "report-urgent-deferred")).toBe(false);
  });

  it("终态 urgent + 收方回合进行中 → 同样不唤醒（回执帧带标记），补醒留给组 A", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-b");
    await markTurnRunning("sess-a");
    attemptWakeMock.mockClear();
    const evidenceFile = join(workDir, "e.txt");
    await writeFile(evidenceFile, "r8b terminal evidence\n");

    const res = await core.xc_report(
      { taskId, attemptId, status: "completed", result: "done", evidence: [{ path: evidenceFile }], urgent: true },
      "conn-b",
    );
    expect(res.isError).toBeFalsy();
    expect(attemptWakeMock).not.toHaveBeenCalled();
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(box.length).toBe(1);
    expect(box[0]!.urgent).toBe(true);
    expect(JSON.parse(box[0]!.content)["wakeDeferred"]).toBe(RECIPIENT_TURN_RUNNING);
    expect(textOf(res)).toContain("已落邮箱、未唤醒：收方回合进行中，回合结束后送达");
    expect((await engineEvents()).some((e) => e["event"] === "report-urgent-deferred" && e["to"] === "a")).toBe(true);
  });
});
