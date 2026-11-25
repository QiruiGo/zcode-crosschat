/**
 * v0.10.0（R2/G-28，组 B）定向测试：**xc_dispatch 忙闲闸**。
 *
 * 缺陷形态（R2 / G-28 实证）：
 * 成员已有在途任务/在途回合时，主控再 xc_dispatch 仍无条件 wake → 同一会话两路
 * 无头回合并发（m8 17:38 与 17:44 两路，两个 spawn pid、共用一个 sid、
 * 互抢信箱、重复劳动）。根因 = tools-tasks.ts 派单落邮箱后无脑调 wake，派单前去重
 * 只有同票维度，不查收方在途状态。
 *
 * 修法（本组 B1）：wake 之前加忙闲闸——收方满足任一即跳过 spawn、只落邮箱：
 * ① 任务板上有它 claimed/in_progress 的任务（blocked 不算：认领者显式申报的暂停）；
 * ② 注册表会话记录 liveness='running' 且 livenessTs 可信（session-running 之后
 *    没有 session-idle 的落盘投影）。回执 delivered="mailbox" + payload
 *    deferred{reason:"busy", openTaskIds} + 人可读行「成员在途，已落邮箱，回合结束
 *    后补醒」+ 审计 dispatch-deferred-busy{to, taskId}。收方不忙时行为逐字节不变。
 *
 * 驱动方式：vi.mock("../engine/wake.js") 只替换 attemptWake——不起真进程，
 * 「忙时一次都没调、不忙时照旧调」这条接线直接可判（v0.9.7 W3 同款注入纪律）。
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
import { writeSession } from "../core/registry.js";
import { engineLogFile } from "../core/paths.js";
import { readMailbox } from "../core/mailbox.js";
import { DEFAULT_TEAM_ID } from "../core/types.js";

/** 唤醒成功回执（不起真进程；只让 dispatch 走 wake 分支）。 */
function okWake() {
  return { delivered: "wake" as const, startConfirmed: true };
}

/** 分层闸挡下的 mailbox 降级（交互会话默认不唤醒）。 */
function gatedWake() {
  return {
    delivered: "mailbox" as const,
    note: "wake-disabled: 交互式会话自动唤醒未开启（XC_WAKE_ENABLED 非 \"true\"）——仅落邮箱（未唤醒）",
  };
}

const TICKET = {
  title: "忙闲闸回归票",
  prompt: "收方在途时不得再 spawn 第二路无头回合",
  acceptance: "t112 派单时 t111 在途 → delivered=mailbox + dispatch-deferred-busy",
} as const;

let workDir: string;
let stateRoot: string;
let core: ToolCore;

beforeEach(async () => {
  attemptWakeMock.mockReset();
  workDir = await mkdtemp(join(tmpdir(), "xc-v0100b-r2-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({
    stateRoot,
    workspace: workDir,
    env: { XC_MESSAGING_DIR: join(workDir, "peers-root") },
  });
  await register("conn-a", "a", "sess-a");
  await register("conn-b", "b", "sess-b");
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

/** 把 b 变成「有 in_progress 在途任务」的成员（G-28 的 17:38→17:44 场景）。 */
async function makeBInProgress(): Promise<{ taskId: string; attemptId: string }> {
  const dispatched = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
  const taskId = payloadOf(dispatched)["taskId"] as string;
  const claimed = await core.xc_claim({ taskId }, "conn-b");
  const attemptId = payloadOf(claimed)["attemptId"] as string;
  await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-b");
  return { taskId, attemptId };
}

describe("v0.10.0 R2：xc_dispatch 忙闲闸（G-28）", () => {
  it("【R2 锚点】收方有 in_progress 在途任务 → 跳过唤醒只落邮箱（G-28 复现场景）", async () => {
    // 第一张票：b 认领并报 in_progress（在途）。
    attemptWakeMock.mockResolvedValue(okWake());
    const { taskId } = await makeBInProgress();
    attemptWakeMock.mockClear();

    // 第二张票（t112 形态）：此刻 b 的在途任务还在跑。
    attemptWakeMock.mockResolvedValue(okWake());
    const second = await core.xc_dispatch({ to: "b", title: "第二张票", prompt: "在途期间再派一张", acceptance: "不得唤醒" }, "conn-a");
    expect(second.isError).toBeFalsy();
    const taskId2 = payloadOf(second)["taskId"] as string;

    // ① 无第二个 wake-spawn：第二次 dispatch 一次都没调 attemptWake。
    expect(attemptWakeMock).not.toHaveBeenCalled();
    // ② delivered=mailbox + deferred 块。
    const payload = payloadOf(second);
    expect(payload["delivered"]).toBe("mailbox");
    expect(payload["deferred"]).toEqual({ reason: "busy", openTaskIds: [taskId] });
    expect(payload["startConfirmed"]).toBeUndefined();
    expect(payload["wakeFailureSeen"]).toBeUndefined();
    // ③ 人可读行写明「成员在途，已落邮箱，回合结束后补醒」+ 在途任务 id。
    const text = textOf(second);
    expect(text).toContain("成员在途，已落邮箱，回合结束后补醒");
    expect(text).toContain(taskId);
    // ④ 消息仍落 b 的邮箱（不丢单：下个 prompt 读未读/可 pull）。
    const box = await readMailbox(stateRoot, DEFAULT_TEAM_ID, "b");
    expect(box.filter((m) => m.attemptId === undefined).length).toBe(2);
    // ⑤ 审计 dispatch-deferred-busy{to, taskId, ...} + dispatch 事件 delivered=mailbox。
    const events = await engineEvents();
    const deferred = events.find((e) => e["event"] === "dispatch-deferred-busy");
    expect(deferred).toBeDefined();
    expect(deferred!["to"]).toBe("b");
    expect(deferred!["taskId"]).toBe(taskId2);
    expect(deferred!["openTaskIds"]).toEqual([taskId]);
    expect(deferred!["sessionRunning"]).toBe(false);
    const dispatch = events.find((e) => e["event"] === "dispatch" && e["taskId"] === taskId2);
    expect(dispatch!["delivered"]).toBe("mailbox");
  });

  it("收方会话回合在跑（无在途任务，liveness=running）→ 同样跳过唤醒，openTaskIds 为空", async () => {
    // b 无在途任务，但注册表里 sess-b 最近的引擎事件是 session-running（无 session-idle）。
    await writeSession(stateRoot, {
      sessionId: "sess-b",
      cwd: workDir,
      startedAt: Date.now(),
      lastSeen: Date.now(),
      liveness: "running",
      livenessTs: Date.now(),
    });
    attemptWakeMock.mockResolvedValue(okWake());

    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(attemptWakeMock).not.toHaveBeenCalled();
    const payload = payloadOf(res);
    expect(payload["delivered"]).toBe("mailbox");
    expect(payload["deferred"]).toEqual({ reason: "busy", openTaskIds: [] });
    expect(textOf(res)).toContain("会话回合进行中");
    const deferred = (await engineEvents()).find((e) => e["event"] === "dispatch-deferred-busy");
    expect(deferred!["sessionRunning"]).toBe(true);
  });

  it("【硬回归】收方不忙（idle 记录、无在途任务）→ 行为逐字节不变：照旧 wake、无 deferred", async () => {
    attemptWakeMock.mockResolvedValue(gatedWake());
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    const taskId = payloadOf(res)["taskId"] as string;
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
    const payload = payloadOf(res);
    expect(payload["delivered"]).toBe("mailbox");
    expect("deferred" in payload).toBe(false);
    expect(textOf(res)).toBe(`Task ${taskId} dispatched to b via mailbox.`);
    expect((await engineEvents()).some((e) => e["event"] === "dispatch-deferred-busy")).toBe(false);
  });

  it("【硬回归】收方不忙且唤醒成功 → 人可读行与 v0.9.9 逐字节一致（via wake）", async () => {
    attemptWakeMock.mockResolvedValue(okWake());
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    const taskId = payloadOf(res)["taskId"] as string;
    expect(textOf(res)).toBe(`Task ${taskId} dispatched to b via wake.`);
    expect("deferred" in payloadOf(res)).toBe(false);
  });

  it("blocked 任务不算忙（认领者显式申报的暂停，不是回合在跑）→ 照旧 wake", async () => {
    attemptWakeMock.mockResolvedValue(okWake());
    const first = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    const taskId = payloadOf(first)["taskId"] as string;
    const claimed = await core.xc_claim({ taskId }, "conn-b");
    await core.xc_report(
      { taskId, attemptId: payloadOf(claimed)["attemptId"] as string, status: "blocked", error: "等主控裁令" },
      "conn-b",
    );
    attemptWakeMock.mockClear();

    const second = await core.xc_dispatch({ to: "b", title: "blocked 期间的票", prompt: " blocked 不算在途回合", acceptance: "照旧唤醒" }, "conn-a");
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
    expect(payloadOf(second)["delivered"]).toBe("wake");
    expect("deferred" in payloadOf(second)).toBe(false);
  });

  it("liveness=running 但 livenessTs 是未来值（伪造/损坏）→ 按不忙，照旧 wake", async () => {
    await writeSession(stateRoot, {
      sessionId: "sess-b",
      cwd: workDir,
      startedAt: Date.now(),
      lastSeen: Date.now(),
      liveness: "running",
      livenessTs: Date.now() + 10 * 60_000,
    });
    attemptWakeMock.mockResolvedValue(okWake());
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(attemptWakeMock).toHaveBeenCalledTimes(1);
    expect(payloadOf(res)["delivered"]).toBe("wake");
    expect("deferred" in payloadOf(res)).toBe(false);
  });
});
