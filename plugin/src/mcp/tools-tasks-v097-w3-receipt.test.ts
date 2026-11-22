/**
 * v0.9.7（W3/V096-01）定向测试：**xc_dispatch / xc_report 的 wake 回执三态全接线**
 * （47-v097 方案 §一 组 W W3）。
 *
 * 缺陷形态（adv-1 F-1 实测）：tools-tasks.ts 的 wake() 帮手只转 delivered/wakeLog/note，
 * 把 WakeResult 的 startConfirmed/wakeTiers/wakeFailureSeen/failureEvidence **结构性丢弃**
 * → 两轮唤醒全失败的回执仍写 "dispatched via wake"，且 payload 无任何失败面结构化键。
 *
 * 驱动方式：`vi.mock("../engine/wake.js")` 只替换 attemptWake（其余导出走 original），
 * 按场景返回不同的 WakeResult（全失败 / 未见启动证据 / 成功 / mailbox 降级）——不起真进程，
 * 直测「三态键有没有从 attemptWake 活到回执」这条接线（V095-14 在 tools-team 面用的就是
 * 这类注入；本文件把同口径补到 dispatch/report 两面）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只替换 attemptWake（其余导出走 original）——不起真进程，直测「三态键有没有从
// attemptWake 活到回执」这条接线（vi.mock 由 vitest 提升到 import 之前；mock fn 经
// vi.hoisted 提出，规避工厂执行期的 TDZ）。
const { attemptWakeMock } = vi.hoisted(() => ({ attemptWakeMock: vi.fn() }));
vi.mock("../engine/wake.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../engine/wake.js")>();
  return { ...original, attemptWake: (...args: unknown[]) => attemptWakeMock(...args) };
});

import { payloadOf } from "./protocol.js";
import { createToolCore, type ToolCore } from "./core.js";
import { writeSession } from "../core/registry.js";
import { engineLogFile } from "../core/paths.js";
import { readTeam } from "../core/teamstate.js";

/** 两轮唤醒全失败（主唤醒 + sessionNotFound 自动重绑重试）的回执形态。 */
function allFailedWake() {
  return {
    delivered: "wake" as const,
    note: "spawned: 无头 --resume 已发起；⚠ 失败侦听：回执时刻 wake 日志已见失败证据（Error: Session not found: sess_deadbeef）",
    wakeLog: "logs/wake-b-1.json",
    startConfirmed: false,
    wakeFailureSeen: true,
    failureEvidence: "Error: Session not found: sess_deadbeef",
    wakeTiers: { spawnOk: "ok" as const, childAlive: "no" as const, consumed: "pending" as const },
  };
}

function startedWake() {
  return {
    delivered: "wake" as const,
    note: "spawned: 无头 --resume 已发起",
    wakeLog: "logs/wake-b-2.json",
    startConfirmed: true,
    wakeTiers: { spawnOk: "ok" as const, childAlive: "ok" as const, consumed: "pending" as const },
  };
}

let workDir: string;
let stateRoot: string;
let core: ToolCore;
/** xc_report 的 evidence 条目（工作区内真实文件；sha256 由工具现算）。 */
let evidenceFile: string;

const TICKET = {
  title: "修复 V096-01 回执三态",
  prompt: "dispatch/report 的 wake 回执必须带三态键与失败措辞",
  acceptance: "两轮全失败时回执含失败措辞 + wakeTiers/wakeFailureSeen",
} as const;

beforeEach(async () => {
  attemptWakeMock.mockReset();
  workDir = await mkdtemp(join(tmpdir(), "xc-v097-w3-tasks-"));
  stateRoot = join(workDir, ".crosschat");
  evidenceFile = join(workDir, "evidence.txt");
  await writeFile(evidenceFile, "w3 receipt evidence\n");
  core = createToolCore({
    stateRoot,
    workspace: workDir,
    env: { XC_MESSAGING_DIR: join(workDir, "peers-root"), XC_WAKE_ENABLED: "false" },
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

describe("v0.9.7 W3：xc_dispatch 回执三态", () => {
  it("【W3 锚点】两轮唤醒全失败 → 人可读行写失败措辞（不写 via wake）+ payload 四键齐全", async () => {
    attemptWakeMock.mockResolvedValue(allFailedWake());
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    const payload = payloadOf(res);
    expect(text).toContain("唤醒失败");
    expect(text).not.toContain("via wake");
    expect(payload["delivered"]).toBe("wake");
    expect(payload["startConfirmed"]).toBe(false);
    expect(payload["wakeFailureSeen"]).toBe(true);
    expect(payload["failureEvidence"]).toContain("Session not found");
    expect(payload["wakeTiers"]).toEqual({ spawnOk: "ok", childAlive: "no", consumed: "pending" });
    // 审计同口径（三态键进 engine.jsonl）。
    const dispatch = (await engineEvents()).find((e) => e["event"] === "dispatch");
    expect(dispatch!["startConfirmed"]).toBe(false);
    expect(dispatch!["wakeFailureSeen"]).toBe(true);
  });

  it("【W3 锚点】成功唤醒 → 不误报失败，四键如实", async () => {
    attemptWakeMock.mockResolvedValue(startedWake());
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    const payload = payloadOf(res);
    expect(text).toContain("via wake");
    expect(text).not.toContain("失败");
    expect(payload["wakeFailureSeen"]).toBeUndefined();
    expect(payload["failureEvidence"]).toBeUndefined();
    expect(payload["startConfirmed"]).toBe(true);
    expect(payload["wakeTiers"]).toEqual({ spawnOk: "ok", childAlive: "ok", consumed: "pending" });
  });

  it("mailbox 降级（wake-skipped）→ 无失败键、无 via wake 谎话", async () => {
    attemptWakeMock.mockResolvedValue({ delivered: "mailbox", note: "wake-disabled: 交互式会话自动唤醒未开启" });
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    const payload = payloadOf(res);
    expect(text).toContain("via mailbox");
    expect(payload["wakeFailureSeen"]).toBeUndefined();
    expect(payload["startConfirmed"]).toBeUndefined();
    expect(payload["note"]).toContain("wake-disabled");
  });
});

describe("v0.9.7 W3：xc_report 回执三态", () => {
  it("【W3 锚点】两轮唤醒全失败 → 失败措辞（不写 wake back via wake）+ payload 四键齐全", async () => {
    // 第一轮 dispatch 成功（唤醒起来了），第二轮 report 回执唤醒全失败。
    attemptWakeMock.mockResolvedValueOnce(startedWake());
    const dispatched = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    const taskId = payloadOf(dispatched)["taskId"] as string;
    const claimed = await core.xc_claim({ taskId }, "conn-b");
    const attemptId = payloadOf(claimed)["attemptId"] as string;

    attemptWakeMock.mockResolvedValueOnce(allFailedWake());
    const res = await core.xc_report(
      { taskId, attemptId, status: "in_progress" },
      "conn-b",
    );
    // 先报一次 in_progress（claimed → in_progress 合法），再报终态 completed。
    const finalRes = await core.xc_report(
      { taskId, attemptId, status: "completed", result: "done", evidence: [{ path: evidenceFile }] },
      "conn-b",
    );
    expect(finalRes.isError).toBeFalsy();
    const text = finalRes.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    const payload = payloadOf(finalRes);
    expect(text).toContain("唤醒失败");
    expect(text).not.toContain("wake back via wake");
    expect(payload["wakeBack"]).toBe("wake");
    expect(payload["startConfirmed"]).toBe(false);
    expect(payload["wakeFailureSeen"]).toBe(true);
    expect(payload["failureEvidence"]).toContain("Session not found");
    expect(payload["wakeTiers"]).toEqual({ spawnOk: "ok", childAlive: "no", consumed: "pending" });
    const reports = (await engineEvents()).filter((e) => e["event"] === "report");
    expect(reports[reports.length - 1]!["wakeFailureSeen"]).toBe(true);
    expect(reports[reports.length - 1]!["startConfirmed"]).toBe(false);
  });

  it("【硬回归】无回执的 intermediate 回报（in_progress）→ 不唤醒、无三态键、行为不减", async () => {
    attemptWakeMock.mockResolvedValue(startedWake());
    const dispatched = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    const taskId = payloadOf(dispatched)["taskId"] as string;
    const claimed = await core.xc_claim({ taskId }, "conn-b");
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    attemptWakeMock.mockClear();

    const res = await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-b");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res);
    expect(payload["wakeBack"]).toBe("mailbox");
    expect(payload["wakeFailureSeen"]).toBeUndefined();
    expect(attemptWakeMock).not.toHaveBeenCalled(); // 中间态不回执唤醒（§2.9）
  });
});
