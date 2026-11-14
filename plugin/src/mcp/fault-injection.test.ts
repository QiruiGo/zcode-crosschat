/**
 * v0.5.1 故障注入组（FI-1~FI-6）防回归单测——红队 evidence/adversarial/故障注入
 * 用例的可自动化部分（工具层/引擎层可直驱形态）。
 *
 * 覆盖：
 * - FI-1（故障注-1）：team.json 损坏 → 备份自愈（恢复审计 + 残损保全）或显式
 *   降级诊断（含路径与修复指引），全队工具不再持续 internal 裸 JSON 错误。
 * - FI-2（故障注-2）：team.json tasks 被清空 → xc_status 孤儿引用告警 +
 *   xc_claim 孤儿诊断（orphan_task_reference），静默丢任务变可观测。
 * - FI-3（故障注-3）：inbox 坏行 → 摘要行披露 `N unreadable line(s) skipped`。
 * - FI-4（故障注-4）：已读消息不再重注入（README「读取并消费未读消息」）。
 * - FI-5（故障注-5）：删 team.json → 注册响应告警 + 审计 team-reset-detected；
 *   新时代任务 id 带纪元前缀不与旧邮箱撞号；旧分派信封判陈旧不再复活注入。
 * - FI-6（故障注-6）：不可解析残留锁安全清除（lock.test.ts 另有单元覆盖），
 *   此处端到端验证 dispatch 在残留锁下自愈而非 15s busy。
 */
import { mkdtemp, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf } from "./protocol.js";
import { createToolCore } from "./core.js";
import type { ToolCore } from "./core.js";
import type { ToolResult } from "./protocol.js";
import { writeSession } from "../core/registry.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import { teamBackupFile, teamCorruptFile, teamFile, lockFile } from "../core/paths.js";
import { readMailbox } from "../core/mailbox.js";
import { engineLogFile } from "../core/paths.js";
import { UNPARSEABLE_LOCK_GRACE_MS } from "../core/lock.js";

let workDir: string;
let stateRoot: string;
let core: ToolCore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-fi-test-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({ stateRoot, workspace: workDir, env: {} }); // wake 关 → mailbox
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function hookRegister(conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** 建队 + 派发一条任务（返回任务 id），b 不消费（邮箱留未读信封）。 */
async function seedTeamWithUnreadAssignment(): Promise<string> {
  await hookRegister("conn-a", "a", "sess-a");
  await hookRegister("conn-b", "b", "sess-b");
  const res = payloadOf(await core.xc_dispatch({ to: "b", title: "compute 17*23", prompt: "只写数字" }, "conn-a")) as { taskId: string };
  return res.taskId;
}

// ---------------------------------------------------------------------------
// FI-1：真源损坏 → 备份自愈 / 显式降级
// ---------------------------------------------------------------------------

describe("FI-1 team.json 损坏自愈（故障注-1）", () => {
  it("半行截断 → xc_status/xc_dispatch 照常工作（从 last-known-good 自愈），残损字节保全", async () => {
    const taskId = await seedTeamWithUnreadAssignment();
    const file = teamFile(stateRoot, "default");
    const raw = await readFile(file, "utf8");
    await writeFile(file, raw.slice(0, Math.floor(raw.length * 0.55)), "utf8"); // 红队 55% 截断形态

    // 只读工具不再 internal：
    const status = await core.xc_status({}, "conn-a");
    expect(status.isError).toBeUndefined();
    const snap = payloadOf(status) as { tasks: Array<{ id: string }> };
    expect(snap.tasks.map((t) => t.id)).toContain(taskId);

    // 变更工具照常（自愈态上继续建任务）：
    const dispatch = await core.xc_dispatch({ to: "b", title: "after repair", prompt: "p" }, "conn-a");
    expect(dispatch.isError).toBeUndefined();

    // 残损现场保全 + 自愈审计
    expect(existsSync(teamCorruptFile(stateRoot, "default"))).toBe(true);
    const events = await engineEvents();
    expect(events.find((e) => e["event"] === "team-state-recovered")).toMatchObject({ teamId: "default" });
  });

  it("无备份 → 显式降级诊断（含文件路径与修复指引），不再裸抛 JSON 解析错误", async () => {
    await hookRegister("conn-a", "a", "sess-a");
    await hookRegister("conn-b", "b", "sess-b");
    // 抹掉 .bak（模拟 v0.5.1 之前的存量：从未写过备份）
    await rm(teamBackupFile(stateRoot, "default"), { force: true });
    const file = teamFile(stateRoot, "default");
    await writeFile(file, '{"teamId":"default","tasks":', "utf8"); // 二进制乱码/半行同类

    const status = await core.xc_status({}, "conn-a");
    expect(status.isError).toBe(true);
    const message = String(payloadOf(status)["message"] ?? "");
    expect(message).toContain("is corrupt");
    expect(message).toContain("team.json");
    expect(message).toContain("restore it manually or delete the team directory to reset");
    const events = await engineEvents();
    expect(events.find((e) => e["event"] === "team-state-corrupt")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FI-2：tasks 被清空（合法 JSON）→ 孤儿引用告警
// ---------------------------------------------------------------------------

describe("FI-2 静默丢任务可观测（故障注-2）", () => {
  it("xc_status 披露孤儿任务引用；xc_claim 给 orphan_task_reference 诊断", async () => {
    const taskId = await seedTeamWithUnreadAssignment();

    // 红队 FJ-2c 形态：合法 JSON，tasks 清空（b 的在途凭证无声蒸发）
    const team = (await readTeam(stateRoot, "default"))!;
    const wiped = { ...team, tasks: [] };
    await writeTeam(stateRoot, wiped);

    // xc_status：不再「tasks=0 无任何告警」
    const status = await core.xc_status({}, "conn-a");
    expect(status.isError).toBeUndefined();
    const snap = payloadOf(status) as { orphanTasks?: Record<string, string[]> };
    expect(snap.orphanTasks).toBeDefined();
    expect(Object.values(snap.orphanTasks ?? {}).flat()).toContain(taskId);
    const statusText = status.content[0]?.type === "text" ? status.content[0].text : "";
    expect(statusText).toContain("orphan task references");

    // xc_claim：unknown task 不再裸报，给出可行动诊断
    const claim = await core.xc_claim({ taskId }, "conn-b");
    expect(claim.isError).toBe(true);
    const err = payloadOf(claim) as { error: string; message: string };
    expect(err.error).toBe("orphan_task_reference");
    expect(err.message).toContain("mailbox still holds envelope(s) referencing it");
  });
});

// ---------------------------------------------------------------------------
// FI-3：inbox 坏行披露；FI-4：已读不重注入
// ---------------------------------------------------------------------------

describe("FI-3/FI-4 邮箱读取（故障注-3/4）", () => {
  it("首行截断：好行照常投递 + 摘要行披露 `1 unreadable line(s) skipped`（故障注-3）", async () => {
    await seedTeamWithUnreadAssignment();
    // 再派发一条好消息（其信封行在坏行之后）
    await core.xc_message({ to: "b", msg: "second message" }, "conn-a");
    const inboxFile = join(stateRoot, "teams", "default", "inbox", "b.jsonl");
    const raw = await readFile(inboxFile, "utf8");
    const lines = raw.split("\n");
    const truncated = lines.map((line, i) => (i === 0 && line !== "" ? line.slice(0, 30) : line)).join("\n");
    await writeFile(inboxFile, truncated, "utf8");

    const res = await core.xc_check_inbox({}, "conn-b");
    expect(res.isError).toBeUndefined();
    const summary = res.content[0]?.type === "text" ? res.content[0].text : "";
    expect(summary).toContain("1 unreadable line(s) skipped");
    const payload = payloadOf(res) as { messages: Array<{ content: string }>; malformedLines?: number };
    expect(payload.malformedLines).toBe(1);
    // 好行消息照常投递
    expect(payload.messages.map((m) => m.content)).toContain("second message");
    // 整箱乱码变体不再是「静默当空箱」（摘要行披露坏行数）
    await writeFile(inboxFile, "\u0000bad\n", "utf8");
    const garbage = await core.xc_check_inbox({}, "conn-b");
    const gSummary = garbage.content[0]?.type === "text" ? garbage.content[0].text : "";
    expect(gSummary).toContain("unreadable line(s) skipped");
  });

  it("已读消息不再重注入；走完生命周期后也只返回未读（故障注-4）", async () => {
    const taskId = await seedTeamWithUnreadAssignment();
    const first = payloadOf(await core.xc_check_inbox({}, "conn-b")) as { messages: Array<{ id: string }> };
    expect(first.messages).toHaveLength(1);

    // 红队放大形态：消费后立即再调 → 0 条（v0.5.0 返回同一条）
    const second = payloadOf(await core.xc_check_inbox({}, "conn-b")) as { messages: Array<{ id: string }> };
    expect(second.messages).toHaveLength(0);

    // 走完 claimed→in_progress→completed 后再调：回执（新未读）发给派发方 a，
    // 旧分派信封（已读）不再重注入
    const claim = payloadOf(await core.xc_claim({ taskId }, "conn-b")) as { attemptId: string };
    await writeFile(join(workDir, "e.txt"), "391", "utf8");
    await core.xc_report({ taskId, attemptId: claim.attemptId, status: "in_progress" }, "conn-b");
    await core.xc_report({
      taskId, attemptId: claim.attemptId, status: "completed", result: "391",
      evidence: [{ path: join(workDir, "e.txt"), note: "" }],
    }, "conn-b");
    const aFirst = payloadOf(await core.xc_check_inbox({}, "conn-a")) as {
      messages: Array<{ id: string; content: string }>;
    };
    expect(aFirst.messages).toHaveLength(1);
    expect(aFirst.messages[0]?.content).toContain("task-receipt");
    const aAgain = payloadOf(await core.xc_check_inbox({}, "conn-a")) as { messages: Array<{ id: string }> };
    expect(aAgain.messages).toHaveLength(0);
    // b 的邮箱（旧分派已读）也不再有任何注入
    const bAgain = payloadOf(await core.xc_check_inbox({}, "conn-b")) as { messages: Array<{ id: string }> };
    expect(bAgain.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FI-5：删 team.json → 告警 + 纪元前缀不撞号 + 旧分派不复活
// ---------------------------------------------------------------------------

describe("FI-5 静默重置告警与纪元前缀（故障注-5）", () => {
  it("删 team.json 后重新注册：响应带重置告警 + 审计 team-reset-detected", async () => {
    await seedTeamWithUnreadAssignment();
    await rm(teamFile(stateRoot, "default"), { force: true }); // 只删 team.json（红队 FJ-4a 形态）

    const reReg = await hookRegister("conn-a2", "a", "sess-a");
    expect(reReg.isError).toBeUndefined();
    const text = reReg.content[0]?.type === "text" ? reReg.content[0].text : "";
    expect(text).toContain("team.json was missing while previous-era state still exists");
    const payload = payloadOf(reReg) as { warnings?: string[] };
    expect((payload.warnings ?? []).join(" ")).toContain("new team era was created");
    const events = await engineEvents();
    expect(events.find((e) => e["event"] === "team-reset-detected")).toMatchObject({ teamId: "default", inboxFiles: 1 });
  });

  it("新时代任务 id 带纪元前缀：不与残存邮箱里的旧时代 id 撞号；旧分派信封判陈旧不复活", async () => {
    const oldTaskId = await seedTeamWithUnreadAssignment(); // era1 任务，b 未读
    await rm(teamFile(stateRoot, "default"), { force: true });
    await hookRegister("conn-a2", "a", "sess-a");
    await hookRegister("conn-b2", "b", "sess-b");
    const again = payloadOf(await core.xc_dispatch({ to: "b", title: "compute 5*5", prompt: "只写数字" }, "conn-a")) as { taskId: string };

    // 新旧时代任务 id 结构性不同名（不再同为 "t1"）
    expect(again.taskId).not.toBe(oldTaskId);
    expect(oldTaskId).toMatch(/-t1$/);
    expect(again.taskId).toMatch(/-t1$/);
    const [oldEra] = oldTaskId.split("-t1");
    const [newEra] = again.taskId.split("-t1");
    expect(oldEra).not.toBe(newEra);

    // b 查箱：旧时代分派信封（taskId 不存在）判陈旧就地丢弃并披露，不再复活注入；
    // 新时代分派照常投递。
    const inbox = await core.xc_check_inbox({}, "conn-b");
    expect(inbox.isError).toBeUndefined();
    const summary = inbox.content[0]?.type === "text" ? inbox.content[0].text : "";
    expect(summary).toContain("1 stale discarded");
    const payload = payloadOf(inbox) as { messages: Array<{ taskId?: string; content: string }> };
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]?.taskId).toBe(again.taskId);
    // 新时代任务可正常认领（attempt 链健全）
    const claim = await core.xc_claim({ taskId: again.taskId }, "conn-b");
    expect(claim.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FI-6：不可解析残留锁端到端（单元级在 lock.test.ts）
// ---------------------------------------------------------------------------

describe("FI-6 残留锁自愈端到端（故障注-6）", () => {
  it("乱码残留锁：dispatch 不再 15s busy，宽限期后自愈成功", async () => {
    await seedTeamWithUnreadAssignment();
    // 捕获真实锁名（与红队 FJ-5d 同形态：把真实锁内容覆写为乱码）
    const names = join(stateRoot, "locks");
    await mkdir(names, { recursive: true });
    const ergodic = await readFile(engineLogFile(stateRoot), "utf8").catch(() => "");
    void ergodic;
    // 直接按 teamLockNames 规则构造锁名
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(stateRoot.toLowerCase()).digest("hex").slice(0, 8);
    const lockPath = lockFile(stateRoot, `team-${digest}-default`);
    await writeFile(lockPath, "{}", "utf8"); // 合法 JSON 但缺 pid/ts/token → 不可解析
    const stale = new Date(Date.now() - UNPARSEABLE_LOCK_GRACE_MS * 2);
    await utimes(lockPath, stale, stale);

    const started = Date.now();
    const res = await core.xc_dispatch({ to: "b", title: "after lock repair", prompt: "p" }, "conn-a");
    expect(res.isError).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000); // 不再 ~15.2s busy
    const events = await engineEvents();
    expect(events.find((e) => e["event"] === "lock-repaired")).toMatchObject({ lock: `team-${digest}-default` });
    // 锁已在操作完成后正常释放
    expect(existsSync(lockPath)).toBe(false);
  }, 20000);
});
