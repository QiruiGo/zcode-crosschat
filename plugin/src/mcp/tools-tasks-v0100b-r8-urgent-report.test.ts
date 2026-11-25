/**
 * v0.10.0（R8，用户点名，组 B）定向测试：**xc_report 插队回单（urgent）**。
 *
 * 需求（R8）：成员任务半截把重要信息当
 * 「插队回单」送出——回执消息 urgent（排到收件人未读最前）+ 对任务创建者一次 urgent
 * 唤醒尝试（创建者不是 lead 时 lead 邮箱落一份不唤醒的通知）+ 人可读行以【插队回单】
 * 开头；唤醒被任何闸挡下时回执明说「已落邮箱、未唤醒」及原因；防风暴：同一成员
 * 10 分钟内最多 5 次 urgent（XC_URGENT_REPORT_MAX 可调），超出的自动降级为普通
 * 回单并在回执写明。审计 report-urgent{taskId, from, to, woke}。不新增工具。
 *
 * 驱动方式：vi.mock("../engine/wake.js") 只替换 attemptWake——「唤醒有没有发起、
 * urgent 档位有没有透传、被闸挡下时 note 有没有进回执」直接可判；engine.jsonl 是
 * 真写落的（防风暴计数吃它）。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { writeSession } from "../core/registry.js";
import { engineLogFile, logsDir } from "../core/paths.js";
import { readMailbox } from "../core/mailbox.js";
import { DEFAULT_TEAM_ID } from "../core/types.js";
import { countRecentUrgentReports, urgentReportMaxFromEnv } from "./tools-tasks.js";

const TICKET = {
  title: "半截回单回归票",
  prompt: "重要发现半截就报，不等任务完成",
  acceptance: "urgent 回执置顶 + urgent 唤醒 + 审计 report-urgent",
} as const;

let workDir: string;
let stateRoot: string;
let core: ToolCore;
let evidenceFile: string;

beforeEach(async () => {
  attemptWakeMock.mockReset();
  workDir = await mkdtemp(join(tmpdir(), "xc-v0100b-r8-"));
  stateRoot = join(workDir, ".crosschat");
  evidenceFile = join(workDir, "evidence.txt");
  await writeFile(evidenceFile, "r8 urgent evidence\n");
  core = createToolCore({
    stateRoot,
    workspace: workDir,
    env: { XC_MESSAGING_DIR: join(workDir, "peers-root") },
  });
  await register("conn-a", "a", "sess-a"); // founder = lead
  await register("conn-b", "b", "sess-b"); // 执行成员
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

/** 人可读行（content[0]；payload JSON 在 content[1]，逐字节断言只取第一块）。 */
function textOf(res: ToolResult): string {
  const first = res.content[0];
  return first !== undefined && "text" in first ? first.text : "";
}

/** 建一张票并让 b 认领（返回 taskId/attemptId）。 */
async function dispatchAndClaim(): Promise<{ taskId: string; attemptId: string }> {
  attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });
  const dispatched = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
  const taskId = payloadOf(dispatched)["taskId"] as string;
  const claimed = await core.xc_claim({ taskId }, "conn-b");
  return { taskId, attemptId: payloadOf(claimed)["attemptId"] as string };
}

describe("v0.10.0 R8：xc_report 插队回单（urgent）", () => {
  it("【R8 锚点】半截 urgent in_progress → urgent 回执置顶 + urgent 唤醒尝试 + 审计 report-urgent", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    attemptWakeMock.mockClear();
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });

    const res = await core.xc_report(
      { taskId, attemptId, status: "in_progress", result: "发现根因：配置缺项", urgent: true },
      "conn-b",
    );
    expect(res.isError).toBeFalsy();

    // ① 回执消息带 urgent（排到创建者 a 的未读最前）。
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(box.length).toBe(1); // 创建者就是 lead：只此一条回执，无 lead 通知副本
    expect(box[0]!.urgent).toBe(true);
    expect(box[0]!.from).toBe("b");
    expect(box[0]!.content).toContain("task-receipt");
    // ② 对创建者发起一次 urgent:true 的唤醒尝试。
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
    const wakeReq = attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(wakeReq["urgent"]).toBe(true);
    expect(wakeReq["toAgentKey"]).toBe("a");
    // ③ 人可读行以【插队回单】开头；payload 带 urgent:true。
    const payload = payloadOf(res);
    expect(textOf(res).startsWith("【插队回单】")).toBe(true);
    expect(payload["urgent"]).toBe(true);
    expect(payload["wakeBack"]).toBe("wake");
    // ④ 审计 report-urgent{taskId, from, to, woke}。
    const urgentEvent = (await engineEvents()).find((e) => e["event"] === "report-urgent");
    expect(urgentEvent).toBeDefined();
    expect(urgentEvent!["taskId"]).toBe(taskId);
    expect(urgentEvent!["from"]).toBe("b");
    expect(urgentEvent!["to"]).toBe("a");
    expect(urgentEvent!["woke"]).toBe(true);
    expect(urgentEvent!["leadNotified"]).toBeUndefined();
  });

  it("唤醒被闸挡下（分层闸/交互会话默认不唤醒）→ 回执明说「已落邮箱、未唤醒」及原因", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    attemptWakeMock.mockClear();
    const gateNote = "wake-disabled: 交互式会话自动唤醒未开启（XC_WAKE_ENABLED 非 \"true\"）——仅落邮箱（未唤醒）：消息未送达也未消费，收方下回合或 xc_read({scope:\"inbox\"}) pull 兜底";
    attemptWakeMock.mockResolvedValue({ delivered: "mailbox", note: gateNote });

    const res = await core.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b");
    const text = textOf(res);
    expect(text.startsWith("【插队回单】")).toBe(true);
    expect(text).toContain("已落邮箱、未唤醒");
    expect(text).toContain("wake-disabled"); // 原因（note 原文）进回执
    const payload = payloadOf(res);
    expect(payload["wakeBack"]).toBe("mailbox");
    expect(payload["urgent"]).toBe(true);
    // 消息仍在邮箱（投递不因唤醒失败而丢）。
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(box.length).toBe(1);
    expect(box[0]!.urgent).toBe(true);
    const urgentEvent = (await engineEvents()).find((e) => e["event"] === "report-urgent");
    expect(urgentEvent!["woke"]).toBe(false);
  });

  it("【硬回归】无 urgent 的中间态回报 → 不建回执、不唤醒、回执无 urgent 键（v0.9.9 逐字节）", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    attemptWakeMock.mockClear();

    const res = await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-b");
    expect(attemptWakeMock).not.toHaveBeenCalled();
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(box.length).toBe(0);
    const payload = payloadOf(res);
    expect("urgent" in payload).toBe(false);
    expect("urgentDowngraded" in payload).toBe(false);
    expect(textOf(res)).toBe(`Task ${taskId} in_progress; no receipt (non-terminal); wake back via mailbox.`);
    expect((await engineEvents()).some((e) => e["event"] === "report-urgent")).toBe(false);
  });

  it("urgent 终态 completed → 回执 urgent + urgent 唤醒（既有终态行为 + 插队标记）", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    // claimed → completed 不是合法边；先进 in_progress（普通回报，无 urgent）。
    await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-b");
    attemptWakeMock.mockClear();
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });

    const res = await core.xc_report(
      { taskId, attemptId, status: "completed", result: "done", evidence: [{ path: evidenceFile }], urgent: true },
      "conn-b",
    );
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(box.length).toBe(1);
    expect(box[0]!.urgent).toBe(true);
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
    expect((attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>)["urgent"]).toBe(true);
    expect(textOf(res).startsWith("【插队回单】")).toBe(true);
    expect(payloadOf(res)["urgent"]).toBe(true);
  });

  it("创建者不是 lead → lead 邮箱落一份不唤醒的通知（含要点摘录）", async () => {
    // 第三人 c 当派单方（非 lead：lead 是 founder a）。
    await register("conn-c", "c", "sess-c");
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });
    const dispatched = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-c");
    const taskId = payloadOf(dispatched)["taskId"] as string;
    const claimed = await core.xc_claim({ taskId }, "conn-b");
    attemptWakeMock.mockClear();
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });

    await core.xc_report(
      { taskId, attemptId: payloadOf(claimed)["attemptId"] as string, status: "in_progress", result: "半截要点：先例在 src/x.ts:42", urgent: true },
      "conn-b",
    );

    // ① 只对创建者 c 唤醒一次；lead a 不被唤醒。
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
    expect((attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>)["toAgentKey"]).toBe("c");
    // ② lead a 邮箱落一条 urgent 通知（不唤醒），带要点摘录。
    const leadBox = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(leadBox.length).toBe(1);
    expect(leadBox[0]!.from).toBe("b");
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("半截要点：先例在 src/x.ts:42");
    expect(leadBox[0]!.content).toContain("未唤醒 lead");
    // ③ 创建者 c 收到 urgent 回执。
    const creatorBox = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "c");
    expect(creatorBox.length).toBe(1);
    expect(creatorBox[0]!.urgent).toBe(true);
    // ④ 审计留痕 leadNotified。
    const urgentEvent = (await engineEvents()).find((e) => e["event"] === "report-urgent");
    expect(urgentEvent!["to"]).toBe("c");
    expect(urgentEvent!["leadNotified"]).toBe(true);
  });

  it("urgent blocked（另一种半截态）→ 同样建 urgent 回执 + urgent 唤醒", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    attemptWakeMock.mockClear();
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });

    const res = await core.xc_report(
      { taskId, attemptId, status: "blocked", error: "缺主控裁令：A 还是 B", urgent: true },
      "conn-b",
    );
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(box.length).toBe(1);
    expect(box[0]!.urgent).toBe(true);
    expect(box[0]!.content).toContain("blocked");
    expect((attemptWakeMock.mock.calls[0]![0] as Record<string, unknown>)["urgent"]).toBe(true);
    expect(textOf(res).startsWith("【插队回单】")).toBe(true);
  });
});

describe("v0.10.0 R8：防风暴闸（同一成员 10 分钟内 urgent 回单上限）", () => {
  it("【锚点】默认上限 5：第 6 次自动降级为普通回单并在回执写明", async () => {
    const { taskId, attemptId } = await dispatchAndClaim();
    attemptWakeMock.mockClear();
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });

    for (let i = 0; i < 5; i++) {
      const res = await core.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b");
      expect(payloadOf(res)["urgent"]).toBe(true);
      expect(textOf(res).startsWith("【插队回单】")).toBe(true);
    }
    // 前 5 次各发起一次 urgent 唤醒。
    expect(attemptWakeMock).toHaveBeenCalledTimes(5);

    // 第 6 次：降级。
    const sixth = await core.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b");
    expect(attemptWakeMock).toHaveBeenCalledTimes(5); // 不再唤醒
    const payload = payloadOf(sixth);
    expect("urgent" in payload).toBe(false);
    expect(payload["urgentDowngraded"]).toBe(true);
    expect(payload["urgentDowngradedReason"]).toContain("上限 5 次");
    const text = textOf(sixth);
    expect(text).toContain("插队回单请求已降级为普通回单");
    expect(text.startsWith("【插队回单】")).toBe(false); // 降级后不是插队回单
    // 降级 Attempt 不落 report-urgent（不占额度），只在 report 事件留痕。
    const events = await engineEvents();
    expect(events.filter((e) => e["event"] === "report-urgent").length).toBe(5);
    const reportEvent = events.filter((e) => e["event"] === "report").at(-1)!;
    expect(reportEvent["urgent"]).toBe(false);
    expect(reportEvent["urgentDowngraded"]).toBe(true);
    // 创建者邮箱仍只有前 5 条的 urgent 回执（降级这条不建回执）。
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "a");
    expect(box.length).toBe(5);
    expect(box.every((m) => m.urgent === true)).toBe(true);
  });

  it("env XC_URGENT_REPORT_MAX 覆盖上限（=2 → 第 3 次降级）", async () => {
    const capped = createToolCore({
      stateRoot,
      workspace: workDir,
      env: { XC_MESSAGING_DIR: join(workDir, "peers-root"), XC_URGENT_REPORT_MAX: "2" },
    });
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });
    const dispatched = await capped.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    const taskId = payloadOf(dispatched)["taskId"] as string;
    const claimed = await capped.xc_claim({ taskId }, "conn-b");
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    attemptWakeMock.mockClear();
    attemptWakeMock.mockResolvedValue({ delivered: "wake", startConfirmed: true });

    expect(payloadOf(await capped.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b"))["urgent"]).toBe(true);
    expect(payloadOf(await capped.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b"))["urgent"]).toBe(true);
    const third = await capped.xc_report({ taskId, attemptId, status: "in_progress", urgent: true }, "conn-b");
    expect(payloadOf(third)["urgentDowngraded"]).toBe(true);
    expect(payloadOf(third)["urgentDowngradedReason"]).toContain("上限 2 次");
    expect((await engineEvents()).filter((e) => e["event"] === "report-urgent").length).toBe(2);
  });

  it("env 解析单测：缺省 5；非正/不可解析回落 5；合法正整数生效", () => {
    expect(urgentReportMaxFromEnv({})).toBe(5);
    expect(urgentReportMaxFromEnv({ XC_URGENT_REPORT_MAX: "" })).toBe(5);
    expect(urgentReportMaxFromEnv({ XC_URGENT_REPORT_MAX: "0" })).toBe(5);
    expect(urgentReportMaxFromEnv({ XC_URGENT_REPORT_MAX: "-3" })).toBe(5);
    expect(urgentReportMaxFromEnv({ XC_URGENT_REPORT_MAX: "abc" })).toBe(5);
    expect(urgentReportMaxFromEnv({ XC_URGENT_REPORT_MAX: " 7 " })).toBe(7);
  });

  it("计数真源 = engine.jsonl 的 report-urgent 事件（窗内计数；窗外/异成员/坏行不计）", async () => {
    const now = Date.now();
    const line = (o: Record<string, unknown>): string => JSON.stringify(o);
    await mkdir(logsDir(stateRoot), { recursive: true });
    await writeFile(
      engineLogFile(stateRoot),
      [
        line({ ts: now - 1_000, event: "report-urgent", from: "b", to: "a", woke: true }),
        line({ ts: now - 2_000, event: "report-urgent", from: "b", to: "a", woke: true }),
        line({ ts: now - 3_000, event: "report-urgent", from: "b", to: "a", woke: true }),
        line({ ts: now, event: "report-urgent", from: "other", to: "a", woke: true }),
        line({ ts: now - 20 * 60_000, event: "report-urgent", from: "b", to: "a", woke: true }), // 窗外
        line({ ts: now, event: "report", by: "b" }), // 异事件
        "{ broken json", // 坏行
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await countRecentUrgentReports(stateRoot, "b", now)).toBe(3);
    expect(await countRecentUrgentReports(stateRoot, "other", now)).toBe(1);
    // 读不到审计日志 → 0（fail-open：闸只防风暴，不因观测面故障降级回单）。
    expect(await countRecentUrgentReports(join(workDir, "no-such-root"), "b", now)).toBe(0);
  });
});
