/**
 * v0.9.3 组A（reports/37-v093方案.md §一 组A 验收锚点）定向单测——
 * **A4 in_progress + idle → needs-continuation**（G-22 的可行解）。
 *
 * 锚点（任务书原文逐条）：
 * - 成员 `in_progress` 且有开放任务、其 liveness=idle 持续 ≥`XC_CONTINUATION_MS`
 *   （缺省 1800000=30min）→ `needs-continuation` 事件 + lead 通知（**一条**）；
 * - **状态变化才重置**：成员恢复 running（或任务离开 in_progress）→ 台账条目删除，
 *   下一个 idle episode 从零计时、可再通知一次；
 * - **重复轮询不轰炸**：同一 episode 只通知一次；
 * - **不依赖 wake**（方案原文）：唤醒闸全程关闭，通知照发（邮箱兜底 + 尝试唤醒失败
 *   只记事件）——本检测不是「续踢」，是「回合结束/成员空闲时告知 lead」。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot；直接调 `sweepMembersOnce`（不起定时器）。
 * 成员不落 peer 注册记录（no-record ≠ pid-dead，活性判据读作 idle——A4 不判进程死，
 * 进程死由看门狗的 member-dead 通道负责）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newTeamState, writeTeam } from "../core/teamstate";
import { writeSession } from "../core/registry";
import type { SessionLivenessView } from "../core/liveness";
import type { SessionRecord, TeamMember } from "../core/types";
import {
  CONTINUATION_THRESHOLD_DEFAULT_MS,
  continuationCandidateOf,
  continuationThresholdMsFromEnv,
  sweepMembersOnce,
  type WatchdogDeps,
} from "./watchdog";
import { readContinuationState } from "./continuation-state";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a4-continuation-v093-"));
  dirs.push(root);
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

/** lead「a」+ 成员「b」；b 名下挂一条 in_progress 任务（attempt 已开）。 */
async function seedTeam(taskStatus: "in_progress" | "completed" = "in_progress"): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  const member: TeamMember = { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 };
  team.members.push(member);
  team.tasks.push({
    id: "t1",
    title: "长任务",
    prompt: "p",
    dependsOn: [],
    status: taskStatus,
    assignee: "b",
    attempt: 1,
    attemptId: "att1",
    createdBy: "a",
    createdAt: 1,
    updatedAt: 1,
    result: null,
    error: null,
    evidence: [],
    history: [],
  });
  await writeTeam(root, team);
}

/**
 * 成员会话记录：liveness=idle 且 idleSinceTs 之前进入 idle。
 *
 * v0.9.9（V098-08，集成员第 1 轮修红）：补 `lastEventTs: idleSinceTs`——该字段是**心跳通道**
 * （core/liveness.ts:70「凡是触到 registry 的引擎事件都是心跳」）。core/types.ts:1065-1071 的
 * 30min 陈旧上限只套「无心跳通道」的记录：本 harness 原本只写 livenessTs=1h 前且无 lastEventTs，
 * 读盘即被丢成 undefined ⇒ continuationCandidateOf（engine/watchdog.ts:466）拿不到 idle 起点
 * ⇒ 看门狗面 5 例全红。补上心跳通道后，记录形态与真实「空闲 1h 的活成员」一致（livenessTs 记
 * 进入 idle 的时刻，lastEventTs 记最后一次引擎事件），陈旧上限按设计把新鲜度裁决权交还心跳的
 * 既有消费面，本文件要测的「idle ≥ 阈值 ⇒ 待续跑」判据回到可测状态。
 * 对判死面无扰动：WATCHDOG_FRESH_DEATH_MS=10min（engine/watchdog.ts:154），1h 前的
 * lastEventTs/lastSeen 在 recentLifeEvidence 里与「字段缺席」同为 false。
 */
async function seedIdleSession(sessionId: string, idleSinceTs: number): Promise<void> {
  await writeSession(root, {
    sessionId,
    cwd: "D:\\ws",
    startedAt: idleSinceTs,
    lastSeen: idleSinceTs,
    liveness: "idle",
    livenessTs: idleSinceTs,
    lastEventTs: idleSinceTs,
  });
}

/** 成员会话记录：liveness=running（回合执行中）。 */
async function seedRunningSession(sessionId: string): Promise<void> {
  const now = Date.now();
  await writeSession(root, {
    sessionId,
    cwd: "D:\\ws",
    startedAt: now,
    lastSeen: now,
    liveness: "running",
    livenessTs: now,
  });
}

function deps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    stateRoot: root,
    workspace: "D:\\ws",
    // 唤醒闸关闭：通知仍照发（邮箱兜底），attemptWake 如实降级并留痕——「不依赖 wake」。
    env: {},
    ...overrides,
  };
}

// 三视图活性判据的展示字段（v0.9.3 C1 起必填；本测试只关心 state，判据来源留空数组）。
const IDLE_VIEW: SessionLivenessView = {
  state: "idle", stateAgeMin: 31, lastEventAgeMin: 31, endpointLive: false, livenessSources: [],
};
const RUNNING_VIEW: SessionLivenessView = {
  state: "running", stateAgeMin: 1, lastEventAgeMin: 0, endpointLive: true, livenessSources: ["hooks-pid"],
};

function member(key = "b"): TeamMember {
  return { key, sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 };
}

// ─────────────────────── 纯判据 ───────────────────────

describe("v0.9.3 A4：needs-continuation 判据（纯函数）", () => {
  it("env 口径：缺省 1800000；非负有限数生效；负数/非数字回落缺省", () => {
    expect(CONTINUATION_THRESHOLD_DEFAULT_MS).toBe(1_800_000);
    expect(continuationThresholdMsFromEnv({})).toBe(1_800_000);
    expect(continuationThresholdMsFromEnv({ XC_CONTINUATION_MS: "60000" })).toBe(60_000);
    expect(continuationThresholdMsFromEnv({ XC_CONTINUATION_MS: "0" })).toBe(0);
    expect(continuationThresholdMsFromEnv({ XC_CONTINUATION_MS: "-5" })).toBe(1_800_000);
    expect(continuationThresholdMsFromEnv({ XC_CONTINUATION_MS: "abc" })).toBe(1_800_000);
  });

  it("判据：idle ∧ 名下 in_progress → 候选（带 idleSinceTs）；running / 无开放任务 / removed → 不是", async () => {
    await seedTeam();
    const { readTeam } = await import("../core/teamstate.js");
    const team = (await readTeam(root, "default"))!;
    const now = Date.now();
    const record: SessionRecord = {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: 1, liveness: "idle", livenessTs: now - 600_000,
    };

    const hit = continuationCandidateOf(member(), IDLE_VIEW, record, team.tasks, now);
    expect(hit?.taskId).toBe("t1");
    expect(hit?.idleSinceTs).toBe(now - 600_000);

    // running（回合在跑）→ 不判
    expect(continuationCandidateOf(member(), RUNNING_VIEW, record, team.tasks, now)).toBeUndefined();
    // 名下无开放 in_progress（任务已终态）→ 不判
    expect(continuationCandidateOf(member(), IDLE_VIEW, record, [{ ...team.tasks[0]!, status: "completed" }], now))
      .toBeUndefined();
    // removed 成员 → 不判（显式终态不是「待续跑」）
    expect(continuationCandidateOf({ ...member(), state: "removed" }, IDLE_VIEW, record, team.tasks, now))
      .toBeUndefined();
    // 无 livenessTs（存量记录）→ 仍是候选，idleSinceTs=undefined（看门狗首见时刻兜底）
    const legacy = continuationCandidateOf(member(), IDLE_VIEW, undefined, team.tasks, now);
    expect(legacy?.taskId).toBe("t1");
    expect(legacy?.idleSinceTs).toBeUndefined();
  });
});

// ─────────────────────── 看门狗面 ───────────────────────

describe("v0.9.3 A4：看门狗 sweep → needs-continuation（一条 / 重置 / 不轰炸）", () => {
  it("【锚点】idle 持续 ≥ 阈值 + in_progress → 事件恰一条 + lead 通知恰一条；重复轮询不轰炸", async () => {
    await seedTeam();
    await seedIdleSession("sess_b", Date.now() - 3_600_000); // 已 idle 1h
    await seedIdleSession("sess_a", Date.now() - 3_600_000);

    const first = await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1800000" } }));
    expect(first.needsContinuation).toHaveLength(1);
    expect(first.needsContinuation[0]!.key).toBe("b");
    expect(first.needsContinuation[0]!.taskId).toBe("t1");

    const events = eventsOf("needs-continuation");
    expect(events).toHaveLength(1);
    expect(events[0]!["member"]).toBe("b");
    expect(events[0]!["taskId"]).toBe("t1");
    expect(events[0]!["liveness"]).toBe("idle");
    expect(events[0]!["thresholdMs"]).toBe(1_800_000);
    expect(events[0]!["via"]).toBe("watchdog");
    expect(typeof events[0]!["idleForMs"]).toBe("number");

    // lead 通知恰一条（按轮合并；同轮无其他事故时只有这一条）
    const leadBox = await import("../core/mailbox.js").then((m) => m.readMailbox(root, "default", "a"));
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("needs-continuation");
    expect(leadBox[0]!.content).toContain("t1");

    // 不轰炸：再扫三轮，事件与通知都不增（台账 notifiedAt 为闸）
    for (let i = 0; i < 3; i += 1) await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1800000" } }));
    expect(eventsOf("needs-continuation")).toHaveLength(1);
    expect((await import("../core/mailbox.js").then((m) => m.readMailbox(root, "default", "a"))).length).toBe(1);
  });

  it("未达阈值：idle 但持续不够 → 不通知（台账记 episode 起点，不告警）", async () => {
    await seedTeam();
    await seedIdleSession("sess_b", Date.now() - 60_000); // 才 idle 1min
    await seedIdleSession("sess_a", Date.now() - 60_000);

    const summary = await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1800000" } }));
    expect(summary.needsContinuation).toEqual([]);
    expect(eventsOf("needs-continuation")).toHaveLength(0);
    const state = await readContinuationState(root);
    expect(state.members["b"]).toBeDefined(); // episode 起点已记账（持续计时用）
    expect(state.members["b"]!.notifiedAt).toBeUndefined();
  });

  it("状态变化重置：成员恢复 running → 台账清空；再度 idle 且超时 → 可再通知一条", async () => {
    await seedTeam();
    await seedIdleSession("sess_b", Date.now() - 3_600_000);
    await seedIdleSession("sess_a", Date.now() - 3_600_000);
    await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1000" } }));
    expect(eventsOf("needs-continuation")).toHaveLength(1);

    // 成员恢复 running（回合开跑）→ 不命中判据 → 台账条目删除（重置）
    await seedRunningSession("sess_b");
    await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1000" } }));
    const afterRunning = await readContinuationState(root);
    expect(afterRunning.members["b"]).toBeUndefined();
    // running 期间不通知
    expect(eventsOf("needs-continuation")).toHaveLength(1);

    // 再度 idle 且超时 → 新 episode，可再通知一条
    await seedIdleSession("sess_b", Date.now() - 5_000);
    const third = await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1000" } }));
    expect(third.needsContinuation).toHaveLength(1);
    expect(eventsOf("needs-continuation")).toHaveLength(2);
  });

  it("状态变化重置（任务侧）：任务离开 in_progress（completed）→ 台账清空、不再通知", async () => {
    await seedTeam();
    await seedIdleSession("sess_b", Date.now() - 3_600_000);
    await seedIdleSession("sess_a", Date.now() - 3_600_000);
    await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1000" } }));
    expect(eventsOf("needs-continuation")).toHaveLength(1);

    await seedTeam("completed"); // 任务终态（同 id 覆写）
    await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1000" } }));
    const state = await readContinuationState(root);
    expect(state.members["b"]).toBeUndefined();
    expect(eventsOf("needs-continuation")).toHaveLength(1); // 不因任务完成再通知
  });

  it("台账：锁内认领——续跑记录落 capacity/continuation-state.json（形状与 version）", async () => {
    await seedTeam();
    await seedIdleSession("sess_b", Date.now() - 3_600_000);
    await seedIdleSession("sess_a", Date.now() - 3_600_000);
    await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1000" } }));
    const state = await readContinuationState(root);
    expect(state.version).toBe(1);
    expect(state.members["b"]!.taskId).toBe("t1");
    expect(typeof state.members["b"]!.since).toBe("number");
    expect(typeof state.members["b"]!.notifiedAt).toBe("number");
  });

  it("不依赖 wake：唤醒闸关闭（env 层）→ needs-continuation 照发（邮箱兜底）", async () => {
    await seedTeam();
    await seedIdleSession("sess_b", Date.now() - 3_600_000);
    await seedIdleSession("sess_a", Date.now() - 3_600_000);

    const summary = await sweepMembersOnce(deps({ env: { XC_CONTINUATION_MS: "1000", XC_WAKE_ENABLED: "false" } }));
    expect(summary.needsContinuation).toHaveLength(1);
    expect(eventsOf("needs-continuation")).toHaveLength(1);
    // 尝试过唤醒但被闸挡下（watchdog-wake 事件留痕）——「尝试唤醒」与「唤醒成功」是两件事
    expect(eventsOf("watchdog-wake").length).toBeGreaterThanOrEqual(1);
    const leadBox = await import("../core/mailbox.js").then((m) => m.readMailbox(root, "default", "a"));
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.content).toContain("needs-continuation");
  });
});
