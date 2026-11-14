/**
 * 周期僵尸清扫防回归单测（故障注-8 修复，v0.5.1）：
 * README L215 承诺「在途任务超过 stale_task_minutes 无任何更新且成员无在途唤醒时，
 * 被引擎清扫回待领并回执队长」。修复前清扫只挂在 xc_report 终态边沿——成员死后再无
 * 报告，承诺落空（红队实测：taskkill 成员 + 等 75s，任务仍 claimed、0 清扫事件、
 * 他人领不走，唯一恢复手段是 lead 手动 xc_cancel）。
 *
 * 修复后 sweepStaleTasksOnce 可被 server 进程的周期定时器（startStaleSweeper）独立
 * 驱动。本组用例覆盖红队复现序列的可自动化部分：
 * - claimed/in_progress 僵尸 → 重置回 pending（他人可领）+ 派发方收 stale-swept 回执
 *   + engine.jsonl task-swept 审计 + 快照刷新；
 * - 阈值可配（XC_STALE_TASK_MINUTES=1）；未超阈值/在途 wake nonce 豁免；
 * - 并发清扫幂等（只一张回执）；无团队/损坏真源 → 静默跳过（永不抛出）。
 *
 * 注：taskId 一律取自 dispatch 回执（v0.5.1 故障注-5 修复后为 <era>-t<n> 形态，
 * 不硬编码 t1）。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payloadOf } from "./protocol.js";
import { createToolCore, type ToolCore, type ToolDeps } from "./core.js";
import {
  startStaleSweeper,
  sweepStaleTasksOnce,
  sweepTickMsFromThreshold,
  staleThresholdMsFromEnv,
} from "./task-edges.js";
import { readMailbox } from "../core/mailbox.js";
import { createWakeNonce, writeSession } from "../core/registry.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import type { TeamState } from "../core/types.js";

const dirs: string[] = [];
let workDir: string;
let stateRoot: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-sweep-"));
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

function makeDeps(env: NodeJS.ProcessEnv = {}): ToolDeps {
  return { stateRoot, workspace: workDir, env };
}

function makeCore(deps: ToolDeps): ToolCore {
  return createToolCore(deps);
}

async function hookRegister(core: ToolCore, conn: string, name: string, sid: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  const res = await core.xc_register({ name, sessionId: sid }, conn);
  expect(res.isError, JSON.stringify(payloadOf(res))).toBeFalsy();
}

async function dispatchTask(core: ToolCore, conn: string, to: string, title: string): Promise<string> {
  const res = await core.xc_dispatch({ to, title, prompt: `P:${title}` }, conn);
  const payload = payloadOf(res);
  expect(payload["error"], JSON.stringify(payload)).toBeUndefined();
  return payload["taskId"] as string;
}

/** 红队序列的可自动化部分：a 派单 → b 认领（成员在此后「死亡」——不再有任何工具调用）。 */
async function seedZombie(core: ToolCore): Promise<string> {
  await hookRegister(core, "conn-a", "a", "sess_a");
  await hookRegister(core, "conn-b", "b", "sess_b");
  const taskId = await dispatchTask(core, "conn-a", "b", "计算 17*23");
  const claim = await core.xc_claim({ taskId }, "conn-b");
  expect(claim.isError, JSON.stringify(payloadOf(claim))).toBeFalsy();
  return taskId;
}

async function mutateTeam(fn: (team: TeamState) => void): Promise<void> {
  const team = await readTeam(stateRoot, "default");
  if (team === undefined) throw new Error("team missing");
  fn(team);
  await writeTeam(stateRoot, team);
}

/** 把 b 的开放任务 updatedAt 回拨（模拟时间流逝越过阈值）。 */
async function backdateOpenTask(minusMs: number): Promise<void> {
  await mutateTeam((t) => {
    for (const task of t.tasks) {
      if (task.assignee === "b" && (task.status === "claimed" || task.status === "in_progress")) {
        task.updatedAt = Date.now() - minusMs;
      }
    }
  });
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

async function taskOf(taskId: string): Promise<{ status: string; assignee: string | null; attempt: number }> {
  const team = (await readTeam(stateRoot, "default"))!;
  const task = team.tasks.find((t) => t.id === taskId)!;
  return { status: task.status, assignee: task.assignee, attempt: task.attempt };
}

describe("sweepStaleTasksOnce（周期清扫轮）", () => {
  it("红队 #16 回归：claimed 僵尸超阈值 → 清扫回 pending + 派发方回执 + 审计 + 快照", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = makeCore(deps);
    const taskId = await seedZombie(core);
    expect(await taskOf(taskId)).toMatchObject({ status: "claimed", assignee: "b" });
    await backdateOpenTask(2 * 60_000); // 阈值 1min，超时 2min

    const summary = await sweepStaleTasksOnce(deps);
    expect(summary).toMatchObject({ swept: 1, skipped: false });

    // 重置回待领（revokeAttempt 语义）。
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });

    // 派发方（lead 主导派发流中即队长）邮箱收到 stale-swept 失败回执。
    const boxA = await readMailbox(stateRoot, "default", "a");
    const receipts = boxA.filter((m) => m.content.includes("stale-swept"));
    expect(receipts).toHaveLength(1);
    const frame = JSON.parse(receipts[0]!.content) as Record<string, unknown>;
    expect(frame).toMatchObject({ type: "task-receipt", taskId, status: "failed" });
    expect(String(frame["error"])).toContain("stale-swept");

    // engine.jsonl 清扫审计行（红队实测为 0 条的地方现在有 1 条）。
    expect(readEngineEvents().filter((e) => e["event"] === "task-swept" && e["taskId"] === taskId)).toHaveLength(1);

    // 快照刷新（任务图真实变化）。
    expect(existsSync(snapshotFile())).toBe(true);
  });

  it("清扫后其他成员可认领（红队「他人领不走」解除）+ in_progress 僵尸同样被清扫", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = makeCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    await hookRegister(core, "conn-c", "c", "sess_c");
    const taskId = await dispatchTask(core, "conn-a", "b", "T");
    const claim = await core.xc_claim({ taskId }, "conn-b");
    expect(claim.isError).toBeFalsy();
    const attemptId = payloadOf(claim)["attemptId"] as string;
    // b 推进到 in_progress 后死亡。
    expect((await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-b")).isError).toBeFalsy();
    await backdateOpenTask(2 * 60_000);

    // 清扫前：c 认领被拒（task_not_pending）——红队实测的受困形态。
    expect(payloadOf(await core.xc_claim({ taskId }, "conn-c"))["error"]).toBe("task_not_pending");

    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 1 });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });

    // 清扫后：c 成功认领（attempt 换代）。
    const reclaim = payloadOf(await core.xc_claim({ taskId }, "conn-c"));
    expect(reclaim["error"]).toBeUndefined();
    expect(typeof reclaim["attemptId"]).toBe("string");
  });

  it("未超阈值 → 不清扫（任务原样、无回执、无审计）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "30" });
    const core = makeCore(deps);
    const taskId = await seedZombie(core);
    await backdateOpenTask(60_000); // 1min << 30min

    const summary = await sweepStaleTasksOnce(deps);
    expect(summary).toMatchObject({ swept: 0, skipped: true });
    expect(await taskOf(taskId)).toMatchObject({ status: "claimed", assignee: "b" });
    expect(readEngineEvents().filter((e) => e["event"] === "task-swept")).toHaveLength(0);
  });

  it("成员有在途 wake nonce → 豁免（§5.4，唤醒回合可能仍在跑）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = makeCore(deps);
    const taskId = await seedZombie(core);
    await backdateOpenTask(2 * 60_000);
    await createWakeNonce(stateRoot, { teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now() });

    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 0 });
    expect(await taskOf(taskId)).toMatchObject({ status: "claimed", assignee: "b" });
  });

  it("并发两轮清扫只清扫一次（锁内重读 + revokeAttempt 幂等）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = makeCore(deps);
    const taskId = await seedZombie(core);
    await backdateOpenTask(2 * 60_000);

    const [s1, s2] = await Promise.all([sweepStaleTasksOnce(deps), sweepStaleTasksOnce(deps)]);
    expect(s1.swept + s2.swept).toBe(1);
    const boxA = await readMailbox(stateRoot, "default", "a");
    expect(boxA.filter((m) => m.content.includes("stale-swept"))).toHaveLength(1);
  });

  it("无团队 / 损坏 team.json → 静默跳过、永不抛出", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    // 无团队。
    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 0, skipped: true });

    // 损坏真源。
    await seedZombie(makeCore(deps));
    const teamFile = join(stateRoot, "teams", "default", "team.json");
    writeFileSync(teamFile, "{ corrupt", "utf8");
    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 0, skipped: true });
  });
});

describe("startStaleSweeper（server 周期定时器）", () => {
  it("定时轮询独立于任何工具调用兑现清扫承诺（红队 75s 等待场景的加速等价）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = makeCore(deps);
    const taskId = await seedZombie(core);
    await backdateOpenTask(2 * 60_000);

    const timer = startStaleSweeper(deps, 25);
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await taskOf(taskId)).status === "pending") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
    } finally {
      clearInterval(timer);
    }
  }, 10_000);
});

describe("配置解析", () => {
  it("sweepTickMsFromThreshold：阈值/6 钳制 [10s, 60s]", () => {
    expect(sweepTickMsFromThreshold(60_000)).toBe(10_000); // 红队阈值 1min → 10s 节拍（75s 内必清扫）
    expect(sweepTickMsFromThreshold(30 * 60_000)).toBe(60_000); // 缺省 30min → 60s 节拍
    expect(sweepTickMsFromThreshold(6 * 60_000)).toBe(60_000);
    expect(sweepTickMsFromThreshold(1_000)).toBe(10_000); // 极小阈值下限保护
  });

  it("staleThresholdMsFromEnv：XC_STALE_TASK_MINUTES 可配，非法值回缺省 30min", () => {
    expect(staleThresholdMsFromEnv({ XC_STALE_TASK_MINUTES: "1" })).toBe(60_000);
    expect(staleThresholdMsFromEnv({})).toBe(30 * 60_000);
    expect(staleThresholdMsFromEnv({ XC_STALE_TASK_MINUTES: "abc" })).toBe(30 * 60_000);
    expect(staleThresholdMsFromEnv({ XC_STALE_TASK_MINUTES: "0" })).toBe(30 * 60_000);
    expect(staleThresholdMsFromEnv({ XC_STALE_TASK_MINUTES: "-3" })).toBe(30 * 60_000);
  });
});
