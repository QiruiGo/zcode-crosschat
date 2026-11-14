/**
 * W3 task-edges 单测（DESIGN-V0.2.md §5.1 E-b 边沿、§5.4 清扫、§7.3.1 快照刷新）：
 * 真实 M1/M2 磁盘契约上的包装层行为——
 * - dispatch 成功 → 快照刷新；duplicate → 不刷新；
 * - completed → 依赖解除：unblock-notice 入下游收件人邮箱 + 无开放任务时尝试唤醒
 *   （XC_WAKE_ENABLED=true 且未配 exe → spawn 同步失败 → engine.jsonl wake-failed 证明
 *   唤醒路径被走到；mailbox 兜底不丢消息）；
 * - v0.5.3（A3 修复）failed → 依赖死锁解除：闭包内 pending 下游自动置 cancelled
 *   （history=dependency-deadlock）+ 创建者收 cancelled 回执 + 锁外唤醒；
 * - 清扫：超时且无在途 nonce 的开放任务被引擎重置 + 派发方收 stale-swept 回执；
 *   有在途 nonce 的成员被豁免；
 * - 永不抛出：基座错误信封原样透传、不触发边沿。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore, type ToolDeps } from "./core.js";
import { withTaskEdges } from "./task-edges.js";
import { readMailbox } from "../core/mailbox.js";
import { createWakeNonce, writeSession } from "../core/registry.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import type { TeamState } from "../core/types.js";

// v0.4（DESIGN-V0.4 §2.4）：attemptWake 的 spawn 配置解析改为「env → 自动探测」后，
// 本文件「XC_WAKE_ENABLED=true 且未配 exe → spawn 同步失败」的原前提会被
// 探测命中（装有 zcode 的机器）取代——单测将依赖宿主安装且会真拉起 ZCode.exe。
// 这里把解析钉回「未配置且探测未命中」（本文件用例关心的正是该失败路径的
// wake-failed 审计面，非探测本身——探测行为由 zcode-locate.test.ts 以注入缝承载）。
vi.mock("../engine/zcode-locate", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveZcodeSpawnConfig: () => ({
    zcodeExe: "",
    zcodeCjs: "",
    outcome: { found: false, source: "", pair: null, attempts: [], guidance: "mock: 单测钉死未配置" },
  }),
}));

const dirs: string[] = [];
let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "xc-edges-"));
  dirs.push(workDir);
  stateRoot = join(workDir, ".crosschat");
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

function makeCore(env: NodeJS.ProcessEnv = {}): ToolCore {
  const deps: ToolDeps = { stateRoot, workspace: workDir, env };
  return withTaskEdges(createToolCore(deps), deps);
}

async function hookRegister(core: ToolCore, conn: string, name: string, sid: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  const res = await core.xc_register({ name, sessionId: sid }, conn);
  expect(res.isError).toBeFalsy();
}

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function snapshotFile(): string {
  return join(stateRoot, "teams", "default", "snapshot.json");
}

/** 证据门（v0.5.1 边界与-3 修复）要求证据文件真实存在：落一个真文件并返回其路径。 */
function evidenceFile(name: string, content = "evidence"): string {
  const p = join(workDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function refreshCount(): number {
  return readEngineEvents().filter((e) => e["event"] === "snapshot-refresh").length;
}

/** 给指定成员的开放任务回拨 updatedAt（构造僵尸）。 */
async function backdateOpenTask(memberKey: string, minusMs: number): Promise<void> {
  const team = await mutateTeam((t) => {
    const open = t.tasks.find((x) => x.assignee === memberKey && (x.status === "claimed" || x.status === "in_progress"));
    if (open !== undefined) open.updatedAt = Date.now() - minusMs;
  });
  await writeTeam(stateRoot, team);
}

async function mutateTeam(fn: (team: TeamState) => void): Promise<TeamState> {
  const team = await readTeam(stateRoot, "default");
  if (team === undefined) throw new Error("team missing");
  fn(team);
  return team;
}

async function setMemberState(key: string, state: string): Promise<void> {
  const team = await mutateTeam((t) => {
    const m = t.members.find((x) => x.key === key) as unknown as Record<string, unknown> | undefined;
    if (m !== undefined) m["state"] = state;
  });
  await writeTeam(stateRoot, team);
}

function unwrap(result: ToolResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
  return payloadOf(result);
}

/**
 * 认领并推进到 in_progress（六态状态机：claimed → in_progress → completed；
 * claimed 直接报 completed 是 illegal_transition，tools.ts:42-49 TASK_TRANSITIONS）。
 * @returns attemptId 供后续 completed/failed 报告使用。
 */
async function claimAndStart(core: ToolCore, conn: string, taskId: string): Promise<string> {
  const claim = unwrap(await core.xc_claim({ taskId }, conn));
  const attemptId = claim["attemptId"] as string;
  unwrap(await core.xc_report({ taskId, attemptId, status: "in_progress" }, conn));
  return attemptId;
}

// ─────────────────────────── E-a 派发边沿 ───────────────────────────

describe("withTaskEdges: xc_dispatch（E-a）", () => {
  it("成功派发 → snapshot.json 刷新（含任务与 engine 块）", async () => {
    const core = makeCore();
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");

    const res = unwrap(await core.xc_dispatch({ to: "b", title: "平方表", prompt: "算 1..10 平方" }, "conn-a"));
    // v0.5.1（故障注-5 修复）：任务 id 为 <era>-t<n> 形态，断言只锁后缀序号形态。
    expect(res["taskId"]).toMatch(/-t1$/);

    expect(existsSync(snapshotFile())).toBe(true);
    const snap = JSON.parse(readFileSync(snapshotFile(), "utf8")) as Record<string, unknown>;
    const tasks = snap["tasks"] as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(snap["engine"]).toBeDefined();
    expect(refreshCount()).toBe(1);
  });

  it("duplicate 派发（无状态变化）→ 不再刷新快照", async () => {
    const core = makeCore();
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const args = { to: "b", title: "平方表", prompt: "算 1..10 平方" };
    unwrap(await core.xc_dispatch(args, "conn-a"));
    expect(refreshCount()).toBe(1);
    unwrap(await core.xc_dispatch(args, "conn-a")); // duplicate
    expect(refreshCount()).toBe(1);
  });
});

// ─────────────────────────── E-b 终态报告边沿 ───────────────────────────

/** 标准三成员剧本：a 派 t1→m1、t2(依赖 t1)→m2；返回动态任务 id（<era>-t<n> 形态）。 */
async function seedChain(core: ToolCore): Promise<{ t1: string; t2: string }> {
  await hookRegister(core, "conn-a", "a", "sess_a");
  await hookRegister(core, "conn-m1", "m1", "sess_m1");
  await hookRegister(core, "conn-m2", "m2", "sess_m2");
  const t1 = (unwrap(await core.xc_dispatch({ to: "m1", title: "平方表", prompt: "算 1..10 平方" }, "conn-a"))["taskId"]) as string;
  const t2 = (unwrap(
    await core.xc_dispatch({ to: "m2", title: "求和", prompt: "把平方表求和", dependsOn: [t1] }, "conn-a"),
  )["taskId"]) as string;
  return { t1, t2 };
}

describe("withTaskEdges: xc_report completed → 依赖解除（E-b ②）", () => {
  it("下游就绪 → unblock-notice 入 m2 邮箱（带上游结果摘要）+ 无开放任务即尝试唤醒", async () => {
    const core = makeCore({ XC_WAKE_ENABLED: "true" }); // 未配 exe → spawn 同步失败 → wake-failed 证明走到唤醒
    const { t1, t2 } = await seedChain(core);

    const attemptId = await claimAndStart(core, "conn-m1", t1);
    const res = unwrap(
      await core.xc_report(
        { taskId: t1, attemptId, status: "completed", result: "1 4 9 … 100", evidence: [{ path: evidenceFile("sq.txt") }] },
        "conn-m1",
      ),
    );
    const unblocked = (res["edges"] as Record<string, unknown>)["unblocked"] as Array<Record<string, unknown>>;
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]).toMatchObject({ taskId: t2, recipient: "m2", woken: true });

    // m2 邮箱：unblock-notice 帧 + 上游结果摘要（collectDependencyOutputs）
    const box = await readMailbox(stateRoot, "default", "m2");
    const notices = box.filter((m) => m.content.includes('"unblock-notice"'));
    expect(notices).toHaveLength(1);
    const frame = JSON.parse(notices[0]!.content) as Record<string, unknown>;
    expect(frame["taskId"]).toBe(t2);
    expect(frame["unblockedBy"]).toBe(t1);
    expect(String(frame["dependencyOutputs"])).toContain("1 4 9");

    // 唤醒路径被走到（spawn 因未配 exe 失败 → wake-failed，scene=unblock，to=m2）。
    const wakeFailed = readEngineEvents().filter((e) => e["event"] === "wake-failed");
    expect(wakeFailed.some((e) => e["scene"] === "unblock" && e["to"] === "m2")).toBe(true);

    // 快照刷新（terminal 边沿后）。
    expect(refreshCount()).toBeGreaterThanOrEqual(1);
  });

  it("收件人有开放任务 → 只入箱不唤醒（woken:false，无 unblock 唤醒事件）", async () => {
    const core = makeCore({ XC_WAKE_ENABLED: "true" });
    const { t1 } = await seedChain(core);
    // m2 先领一张独立单（t3）→ 拥有开放任务。
    const t3 = (unwrap(await core.xc_dispatch({ to: "m2", title: "独立单", prompt: "P" }, "conn-a"))["taskId"]) as string;
    await claimAndStart(core, "conn-m2", t3);

    const attemptId = await claimAndStart(core, "conn-m1", t1);
    const res = unwrap(
      await core.xc_report(
        { taskId: t1, attemptId, status: "completed", result: "r", evidence: [{ path: evidenceFile("e.txt") }] },
        "conn-m1",
      ),
    );
    const unblocked = (res["edges"] as Record<string, unknown>)["unblocked"] as Array<Record<string, unknown>>;
    expect(unblocked[0]!["woken"]).toBe(false);
    const box = await readMailbox(stateRoot, "default", "m2");
    expect(box.some((m) => m.content.includes('"unblock-notice"'))).toBe(true);
    // m2 没有被唤醒（wake 事件只属于 m1 的 report 回执路径，scene=report）。
    const wakeEvents = readEngineEvents().filter((e) => e["event"] === "wake-failed" && e["to"] === "m2");
    expect(wakeEvents.some((e) => e["scene"] === "unblock")).toBe(false);
  });

  it("removed 成员不唤醒（§6.3/§7.3.3），通知照常入箱", async () => {
    const core = makeCore({ XC_WAKE_ENABLED: "true" });
    const { t1 } = await seedChain(core);
    await setMemberState("m2", "removed");

    const attemptId = await claimAndStart(core, "conn-m1", t1);
    const res = unwrap(
      await core.xc_report(
        { taskId: t1, attemptId, status: "completed", result: "r", evidence: [{ path: evidenceFile("e.txt") }] },
        "conn-m1",
      ),
    );
    const unblocked = (res["edges"] as Record<string, unknown>)["unblocked"] as Array<Record<string, unknown>>;
    expect(unblocked[0]!["woken"]).toBe(false);
    expect(await readMailbox(stateRoot, "default", "m2")).toHaveLength(2); // 派单 + unblock-notice
    // unblock 场景对 m2 无任何唤醒尝试（派发期的 wake-failed 是 dispatch 场景，另计）。
    const wakeEvents = readEngineEvents().filter(
      (e) => e["event"] === "wake-failed" && e["to"] === "m2" && e["scene"] === "unblock",
    );
    expect(wakeEvents).toHaveLength(0);
  });

  it("v0.5.3（A3 修复）failed 报告 → 死锁下游自动解除：t2 置 cancelled + 创建者收回执 + edges.deadlocked", async () => {
    const core = makeCore({ XC_WAKE_ENABLED: "true" }); // 未配 exe → spawn 失败 → wake-failed 证明走到唤醒
    const { t1, t2 } = await seedChain(core);
    const attemptId = await claimAndStart(core, "conn-m1", t1);
    const res = unwrap(
      await core.xc_report(
        { taskId: t1, attemptId, status: "failed", error: "算不动了" },
        "conn-m1",
      ),
    );
    // 无 unblock-notice（completed 专属）；有 deadlocked 边沿结果。
    expect(res["edges"]).toBeDefined();
    const deadlocked = ((res["edges"] as Record<string, unknown>)["deadlocked"] ?? []) as Array<Record<string, unknown>>;
    expect(deadlocked).toHaveLength(1);
    expect(deadlocked[0]).toMatchObject({ taskId: t2, createdBy: "a", deadlockedBy: t1 });

    // 任务板：t2 = cancelled（history 记 dependency-deadlock，error 写明根因）。
    const team = await mutateTeam(() => {});
    const t2Task = team.tasks.find((x) => x.id === t2)!;
    expect(t2Task.status).toBe("cancelled");
    expect(t2Task.error).toContain("dependency-deadlock");
    expect(t2Task.error).toContain(t1);
    expect(t2Task.history.at(-1)).toMatchObject({ event: "dependency-deadlock", by: "engine" });

    // 创建者（a）邮箱：cancelled 回执（cancelledBy=engine）。
    const aBox = await readMailbox(stateRoot, "default", "a");
    const receipts = aBox
      .map((m) => JSON.parse(m.content) as Record<string, unknown>)
      .filter((c) => c["type"] === "task-receipt" && c["taskId"] === t2);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: "cancelled", cancelledBy: "engine" });

    // 唤醒路径被走到（scene=dependency-deadlock，to=创建者 a）。
    const wakeFailed = readEngineEvents().filter((e) => e["event"] === "wake-failed");
    expect(wakeFailed.some((e) => e["scene"] === "dependency-deadlock" && e["to"] === "a")).toBe(true);

    // 解除审计 + 快照刷新。
    expect(readEngineEvents().filter((e) => e["event"] === "dependency-deadlock" && e["taskId"] === t2)).toHaveLength(1);
    expect(refreshCount()).toBeGreaterThanOrEqual(1);

    // m2 邮箱里没有 unblock-notice（completed 专属），但派单还在（消息面不清理）。
    const box = await readMailbox(stateRoot, "default", "m2");
    expect(box.some((m) => m.content.includes('"unblock-notice"'))).toBe(false);
  });

  it("v0.5.3（A3 修复）传递闭包：t3 依赖 t2、t2 依赖 t1，t1 failed → t2/t3 一并解除", async () => {
    const core = makeCore();
    const { t1, t2 } = await seedChain(core);
    const t3 = (unwrap(
      await core.xc_dispatch({ to: "m2", title: "三级", prompt: "P", dependsOn: [t2] }, "conn-a"),
    )["taskId"]) as string;
    const attemptId = await claimAndStart(core, "conn-m1", t1);
    const res = unwrap(
      await core.xc_report({ taskId: t1, attemptId, status: "failed", error: "x" }, "conn-m1"),
    );
    const deadlocked = ((res["edges"] as Record<string, unknown>)["deadlocked"] ?? []) as Array<Record<string, unknown>>;
    expect(deadlocked.map((d) => d["taskId"]).sort()).toEqual([t2, t3].sort());
    const team = await mutateTeam(() => {});
    expect(team.tasks.find((x) => x.id === t2)!.status).toBe("cancelled");
    expect(team.tasks.find((x) => x.id === t3)!.status).toBe("cancelled");
  });

  it("v0.5.3（A3 修复）无下游的 failed → edges 无 deadlocked 字段（零成本路径）", async () => {
    const core = makeCore();
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-m1", "m1", "sess_m1");
    const t1 = (unwrap(await core.xc_dispatch({ to: "m1", title: "孤立单", prompt: "P" }, "conn-a"))["taskId"]) as string;
    const attemptId = await claimAndStart(core, "conn-m1", t1);
    const res = unwrap(
      await core.xc_report({ taskId: t1, attemptId, status: "failed", error: "x" }, "conn-m1"),
    );
    expect(res["edges"]).toBeUndefined(); // swept/unblocked/deadlocked 全空 → 不追加 edges 块
  });

  it("v0.5.3（A3 修复）派发面：dependsOn 指向已 failed/cancelled 的任务 → invalid_params（生而死锁闸）", async () => {
    const core = makeCore();
    const { t1, t2 } = await seedChain(core);
    // 先造一张 failed 上游：t1 failed（级联把 t2 也解除了）。
    const attemptId = await claimAndStart(core, "conn-m1", t1);
    unwrap(await core.xc_report({ taskId: t1, attemptId, status: "failed", error: "x" }, "conn-m1"));

    const dead = await core.xc_dispatch({ to: "m2", title: "挂死上游", prompt: "P", dependsOn: [t1] }, "conn-a");
    expect(dead.isError).toBe(true);
    expect(payloadOf(dead)).toMatchObject({ error: "invalid_params" });
    expect(JSON.stringify(payloadOf(dead))).toContain("dependency deadlock");

    // cancelled 上游同闸：直接把一张单置 cancelled（xc_cancel 的级联解除在 lead-tools.test.ts），
    // 再派依赖它的 → 派发面同样拒绝。
    const t3 = (unwrap(await core.xc_dispatch({ to: "m1", title: "待取消", prompt: "P" }, "conn-a"))["taskId"]) as string;
    await writeTeam(stateRoot, await mutateTeam((t) => {
      const t3Task = t.tasks.find((x) => x.id === t3)!;
      t3Task.status = "cancelled";
    }));
    const onCancelled = await core.xc_dispatch({ to: "m2", title: "挂取消上游", prompt: "P", dependsOn: [t3] }, "conn-a");
    expect(onCancelled.isError).toBe(true);
    expect(payloadOf(onCancelled)).toMatchObject({ error: "invalid_params" });

    // 对照：pending/claimed 依赖照常放行（t2 已被级联取消，t3 也 cancelled —— 用新派的单）。
    const t4 = (unwrap(await core.xc_dispatch({ to: "m1", title: "活上游", prompt: "P" }, "conn-a"))["taskId"]) as string;
    const ok = await core.xc_dispatch({ to: "m2", title: "挂活上游", prompt: "P", dependsOn: [t4] }, "conn-a");
    expect(ok.isError).toBeFalsy();
  });

  it("in_progress 心跳 → 无边沿动作但快照刷新（§7.3.1 机制 3「每单 report 至少一次」）", async () => {
    const core = makeCore();
    const { t1 } = await seedChain(core);
    const before = refreshCount();
    const attemptId = await claimAndStart(core, "conn-m1", t1); // 含一次 in_progress 心跳
    void attemptId;
    expect(refreshCount()).toBeGreaterThan(before);
  });
});

// ─────────────────────────── §5.4 僵尸清扫 ───────────────────────────

describe("withTaskEdges: 僵尸清扫（E-b ①）", () => {
  it("超时 40min 且无在途 nonce → 引擎重置回 pending + 派发方收 stale-swept 回执 + 审计", async () => {
    const core = makeCore();
    const { t1 } = await seedChain(core);
    // m1 认领 t1 后失联（无心跳）；m2 在独立单（t3）上认领并完成 → E-b 边沿清扫 t1。
    // （t2 依赖 t1、m2 领不了——清扫边沿需要一条无关的终态报告来触发。）
    const attemptId1 = await claimAndStart(core, "conn-m1", t1);
    const t3 = (unwrap(await core.xc_dispatch({ to: "m2", title: "独立单", prompt: "P" }, "conn-a"))["taskId"]) as string;
    const attemptId3 = await claimAndStart(core, "conn-m2", t3);
    await backdateOpenTask("m1", 40 * 60_000);

    const res = unwrap(
      await core.xc_report(
        { taskId: t3, attemptId: attemptId3, status: "completed", result: "385", evidence: [{ path: evidenceFile("sum.txt") }] },
        "conn-m2",
      ),
    );
    const swept = (res["edges"] as Record<string, unknown>)["swept"] as Array<Record<string, unknown>>;
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ taskId: t1, assignee: "m1" });
    expect(swept[0]!["revokedAttemptId"]).toBe(attemptId1);

    // t1 已回 pending 池（引擎特权重置）。
    const team = (await readTeam(stateRoot, "default"))!;
    const t1rec = team.tasks.find((t) => t.id === t1)!;
    expect(t1rec.status).toBe("pending");
    expect(t1rec.assignee).toBeNull();
    expect(t1rec.attemptId).toBeNull();
    expect(t1rec.history[t1rec.history.length - 1]!.event).toBe("revoked-stale");

    // 派发方 a 的邮箱收到 stale-swept 回执。
    const boxA = await readMailbox(stateRoot, "default", "a");
    const receipts = boxA.filter((m) => m.content.includes("stale-swept"));
    expect(receipts).toHaveLength(1);
    const frame = JSON.parse(receipts[0]!.content) as Record<string, unknown>;
    expect(frame["type"]).toBe("task-receipt");
    expect(frame["status"]).toBe("failed");
    expect(String(frame["error"])).toContain("stale-swept");

    // engine.jsonl 审计行。
    expect(readEngineEvents().some((e) => e["event"] === "task-swept" && e["taskId"] === t1)).toBe(true);

    // 复活的 m1 用旧令牌报告 → 硬拒（重置后任务 pending 且无当前 attempt，
    // pending→completed 转移本身也非法——双保险拒绝）。
    const late = await core.xc_report(
      { taskId: t1, attemptId: attemptId1, status: "completed", result: "x", evidence: [{ path: evidenceFile("e.txt") }] },
      "conn-m1",
    );
    expect(late.isError).toBe(true);
    expect((payloadOf(late))["error"]).toBe("illegal_transition");
  });

  it("成员有在途 wake nonce → 豁免清扫（回合可能仍在跑）", async () => {
    const core = makeCore();
    const { t1 } = await seedChain(core);
    const attemptId1 = await claimAndStart(core, "conn-m1", t1);
    const t3 = (unwrap(await core.xc_dispatch({ to: "m2", title: "独立单", prompt: "P" }, "conn-a"))["taskId"]) as string;
    const attemptId3 = await claimAndStart(core, "conn-m2", t3);
    await backdateOpenTask("m1", 40 * 60_000);
    await createWakeNonce(stateRoot, { teamId: "default", agentKey: "m1", sid: "sess_m1", now: Date.now() });

    const res = unwrap(
      await core.xc_report(
        { taskId: t3, attemptId: attemptId3, status: "completed", result: "385", evidence: [{ path: evidenceFile("sum.txt") }] },
        "conn-m2",
      ),
    );
    expect(res["edges"]).toBeUndefined(); // 无清扫（豁免）、无解除（独立单无下游）
    const t1rec = (await readTeam(stateRoot, "default"))!.tasks.find((t) => t.id === t1)!;
    expect(t1rec.status).toBe("in_progress"); // 原样保留（claimAndStart 已推进到 in_progress）
    void attemptId1;
  });
});

// ─────────────────────────── 永不抛出与透传 ───────────────────────────

describe("withTaskEdges: 透传与错误隔离（§11.1 基座不动）", () => {
  it("基座错误信封原样透传（不刷快照、无边沿动作）", async () => {
    const core = makeCore();
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-m1", "m1", "sess_m1");
    const t1 = (unwrap(await core.xc_dispatch({ to: "m1", title: "T", prompt: "P" }, "conn-a"))["taskId"]) as string;
    expect(refreshCount()).toBe(1);

    // 未认领的 pending 任务直接报 completed：状态机拒绝（pending 无 completed 边）。
    const bad = await core.xc_report({ taskId: t1, attemptId: "wrong", status: "completed", result: "r", evidence: [{ path: evidenceFile("e.txt") }] }, "conn-m1");
    expect(bad.isError).toBe(true);
    expect((payloadOf(bad))["error"]).toBe("illegal_transition");
    expect(refreshCount()).toBe(1); // 无快照刷新
  });

  it("损坏数据下基座返回干净错误信封；恢复后边沿链路健全（永不向上抛冒烟）", async () => {
    const core = makeCore();
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-m1", "m1", "sess_m1");
    const t1 = (unwrap(await core.xc_dispatch({ to: "m1", title: "T", prompt: "P" }, "conn-a"))["taskId"]) as string;
    // 损坏 team.json（含 .bak 镜像，避免 v0.5.1 故障注-1 的 last-known-good 自愈
    // 介入）：基座对不可解析真源一律干净错误信封（不向上抛）。
    const teamFile = join(stateRoot, "teams", "default", "team.json");
    const bakFile = join(stateRoot, "teams", "default", "team.json.bak");
    const good = readFileSync(teamFile, "utf8");
    try {
      writeFileSync(teamFile, "{ corrupt");
      if (existsSync(bakFile)) writeFileSync(bakFile, "!!!");
      const bad = await core.xc_report(
        { taskId: t1, attemptId: "x", status: "completed", result: "r", evidence: [{ path: evidenceFile("e.txt") }] },
        "conn-m1",
      );
      expect(bad.isError).toBe(true);
      expect((payloadOf(bad))["error"]).toBe("internal");
    } finally {
      writeFileSync(teamFile, good);
      if (existsSync(bakFile)) writeFileSync(bakFile, good);
    }
    // 恢复后正常终态报告：边沿正常工作（健全性）。
    const attemptId = await claimAndStart(core, "conn-m1", t1);
    const res = unwrap(
      await core.xc_report({ taskId: t1, attemptId, status: "completed", result: "done", evidence: [{ path: evidenceFile("e.txt") }] }, "conn-m1"),
    );
    expect(res["status"]).toBe("completed");
    expect(existsSync(snapshotFile())).toBe(true);
  });
});
