/**
 * v0.8.0 A2（DESIGN-V0.8.md §4）：core/handoff.ts 单测——七要素组装 + 4000 字符预算
 * 降级序列 + id 三视角冻结语义。纯函数直驱（now/数据注入，无 I/O）。
 *
 * 覆盖判据（ACCEPT15-2「handoff：包内 7 要素；超预算有截断标注；id 过滤正确」）：
 * - payload 七键齐全且**恰好**七键+文档化附加键（input-only 字段不泄漏进 payload）；
 * - id 三视角七要素逐格对照 §4.1 冻结表（self / task / member）；
 * - 花名视角未读只给计数 + tool_request subject 遮蔽（§4.4）；
 * - 4000 超限走固定降级序列（pool → unread → tasks → suggestions → 硬截），
 *   每级留名（droppedSections/cappedItems）——无静默丢；
 * - 基础帽生效时文本内披露（另有 N 条…/待领池共 M 个…）；
 * - 建议下一步按任务真实状态给可达指引（他人 in_progress → takeover/等清扫；
 *   受领人指定 → claim 会被拒；可认领 → xc_claim 指针）。
 */
import { describe, expect, it } from "vitest";
import {
  assembleHandoff,
  handoffIdCandidates,
  handoffUnreadView,
  resolveHandoffFilter,
  selectHandoffTasks,
  HANDOFF_BUDGET_CHARS,
  type HandoffInput,
  type HandoffPoolItem,
  type HandoffTask,
} from "./handoff.js";
import type { Task, TeamMessage, TeamState } from "./types.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function task(overrides: Partial<HandoffTask> & { taskId: string }): HandoffTask {
  return {
    title: "任务标题",
    status: "in_progress",
    attempt: 1,
    assignee: "alice",
    lastProgressTs: NOW - 20 * MIN,
    unmetDependsOn: [],
    ...overrides,
  };
}

function poolItem(overrides: Partial<HandoffPoolItem> & { taskId: string }): HandoffPoolItem {
  return {
    title: "池任务",
    priority: "normal",
    dependsOn: [],
    unmetDependsOn: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    now: NOW,
    filter: { kind: "self" },
    identity: {
      agentKey: "alice",
      teamId: "default",
      leadKey: "alice",
      role: "worker",
      memberState: "ready",
      isLead: false,
    },
    tasks: [],
    pool: [],
    poolTotal: 0,
    unread: { count: 0, urgentCount: 0, top: [] },
    capacity: { watermarkPct: 23.5, freeGb: 7.2, level: "GREEN", sampledAt: NOW },
    checkpoint: { path: "/ws/.crosschat/checkpoints/alice/2026-11-15T18-00-00-000Z.md", createdAt: NOW - 12 * MIN, ageMin: 12, bytes: 1234 },
    stalled: [],
    myOpenTaskId: null,
    ...overrides,
  };
}

function message(overrides: Partial<TeamMessage> & { id: string; content: string }): TeamMessage {
  return { from: "bob", to: "alice", ts: NOW, ...overrides } as TeamMessage;
}

// ---------------------------------------------------------------------------
// 七要素与双层输出
// ---------------------------------------------------------------------------

describe("handoff: 七要素与文本七章", () => {
  it("payload 七键齐全；文本面七章同构 + 视角行", () => {
    const { text, payload } = assembleHandoff(baseInput({
      tasks: [task({ taskId: "t-a1" })],
      pool: [poolItem({ taskId: "t-c3", priority: "high" })],
      poolTotal: 1,
      unread: { count: 1, urgentCount: 1, top: [{ msgId: "msg-123456789", from: "bob", subject: "记得先落盘", urgent: true }] },
    }));
    // 冻结七键
    for (const key of ["identity", "tasks", "pool", "unread", "capacity", "checkpoint", "suggestions"]) {
      expect(Object.keys(payload)).toContain(key);
    }
    // 视角自明（不允许调用方猜）
    expect(payload.filter).toEqual({ kind: "self" });
    expect(text.startsWith("视角：self")).toBe(true);
    // 七章顺序固定
    const chapters = [...text.matchAll(/^## (\d)\. (.+)$/gm)].map((m) => `${m[1]}.${m[2]}`);
    expect(chapters).toEqual([
      "1.身份",
      "2.我的任务",
      "3.待领池（前 10，priority → createdAt）",
      "4.未读",
      "5.容量",
      "6.最近检查点",
      "7.建议下一步",
    ]);
    // 未超限 → 不披露 truncated
    expect(payload.truncated).toBeUndefined();
    expect(text).not.toContain("字符预算截断");
  });

  it("input-only 字段不泄漏进 payload（tasks 无 unmetDependsOn/to；unread.top 无 urgent）", () => {
    const { payload } = assembleHandoff(baseInput({
      tasks: [task({ taskId: "t-a1", unmetDependsOn: ["t-x"], to: "alice" })],
      pool: [poolItem({ taskId: "t-c3", unmetDependsOn: ["t-a1"], to: "bob" })],
      poolTotal: 1,
      unread: { count: 1, urgentCount: 1, top: [{ msgId: "m1", from: "bob", subject: "s", urgent: true }] },
    }));
    expect(Object.keys(payload.tasks[0]!).sort()).toEqual(
      ["assignee", "attempt", "lastProgressTs", "status", "taskId", "title"].sort(),
    );
    expect(Object.keys(payload.pool[0]!).sort()).toEqual(
      ["dependsOn", "priority", "taskId", "title", "unmetDependsOn"].sort(),
    );
    expect(Object.keys(payload.unread.top[0]!).sort()).toEqual(["from", "msgId", "subject"].sort());
  });

  it("空态：无任务/空池/无未读/无检查点/容量失败各有占位行", () => {
    const { text, payload } = assembleHandoff(baseInput({ capacity: null, checkpoint: null }));
    expect(text).toContain("（无进行中任务）");
    expect(text).toContain("（待领池为空）");
    expect(text).toContain("（无未读）");
    expect(text).toContain("（无检查点：/xc-checkpoint 可一键落盘）");
    expect(text).toContain("（容量采样失败——不按 GREEN 呈现；warnings 见 payload）");
    expect(payload.capacity).toBeNull();
    expect(payload.checkpoint).toBeNull();
  });

  it("blocked 任务带阻塞原因；容量 RED 建议行进 suggestions", () => {
    const { text } = assembleHandoff(baseInput({
      tasks: [task({ taskId: "t-b2", status: "blocked", blockedReason: "等用户落 approvals/" })],
      capacity: { watermarkPct: 9.9, freeGb: 1.2, level: "RED", sampledAt: NOW },
    }));
    expect(text).toContain("阻塞原因：等用户落 approvals/");
    expect(text).toContain("compress-advice: 容量预警");
  });
});

// ---------------------------------------------------------------------------
// id 三视角七要素冻结语义（§4.1 表逐格）
// ---------------------------------------------------------------------------

describe("handoff: id 三视角冻结语义（§4.1）", () => {
  const team: TeamState = {
    teamId: "default",
    name: "default",
    founderKey: "alice",
    phase: "open",
    leadKey: "alice",
    members: [
      { key: "alice", sessionId: "s-a", role: "peer", joinedAt: NOW, lastSeen: NOW },
      { key: "bob", sessionId: "s-b", role: "worker", joinedAt: NOW, lastSeen: NOW },
    ],
    tasks: [
      {
        id: "t-mine", title: "我的活", prompt: "p", dependsOn: [], status: "in_progress",
        assignee: "alice", attempt: 2, attemptId: null, createdBy: "alice", createdAt: NOW - 90 * MIN,
        updatedAt: NOW - 20 * MIN, lastProgressTs: NOW - 20 * MIN, result: null, error: null, evidence: [], history: [],
      },
      {
        id: "t-bobs", title: "bob 的活", prompt: "p", dependsOn: [], status: "claimed",
        assignee: "bob", attempt: 1, attemptId: null, createdBy: "alice", createdAt: NOW - 90 * MIN,
        updatedAt: NOW - 10 * MIN, lastProgressTs: NOW - 10 * MIN, result: null, error: null, evidence: [], history: [],
      },
      {
        id: "t-done", title: "已完成的活", prompt: "p", dependsOn: [], status: "completed",
        assignee: "bob", attempt: 1, attemptId: null, createdBy: "alice", createdAt: NOW - 90 * MIN,
        updatedAt: NOW - 5 * MIN, lastProgressTs: NOW - 5 * MIN, result: "done", error: null, evidence: [], history: [],
      },
      {
        id: "t-pool", title: "待领", prompt: "p", dependsOn: [], status: "pending",
        assignee: null, attempt: 0, attemptId: null, createdBy: "alice", createdAt: NOW - 80 * MIN,
        updatedAt: NOW - 80 * MIN, result: null, error: null, evidence: [], history: [],
      },
    ],
    seq: 4,
    createdAt: NOW - 100 * MIN,
  };

  it("resolveHandoffFilter：taskId 精确命中优先，花名经 sanitizeKey，都不中 → undefined", () => {
    expect(resolveHandoffFilter(undefined, team)).toEqual({ kind: "self" });
    expect(resolveHandoffFilter("", team)).toEqual({ kind: "self" });
    expect(resolveHandoffFilter("t-bobs", team)).toEqual({ kind: "task", id: "t-bobs" });
    expect(resolveHandoffFilter("bob", team)).toEqual({ kind: "member", id: "bob" });
    expect(resolveHandoffFilter("Bob", team)).toEqual({ kind: "member", id: "Bob" }); // 清洗后命中，原文保留供漂移披露
    expect(resolveHandoffFilter("nope", team)).toBeUndefined();
  });

  it("handoffIdCandidates：至多 10 个 taskId + 10 个花名", () => {
    const many: TeamState = {
      ...team,
      tasks: Array.from({ length: 15 }, (_, i) => ({ ...team.tasks[3]!, id: `t-${i}` })),
      members: Array.from({ length: 12 }, (_, i) => ({ key: `m${i}`, sessionId: `s${i}`, role: "peer" as const, joinedAt: NOW, lastSeen: NOW })),
    };
    const c = handoffIdCandidates(many);
    expect(c.taskIds).toHaveLength(10);
    expect(c.memberKeys).toHaveLength(10);
  });

  it("selectHandoffTasks：self=我的开放；task=仅该条（终态也出）；member=该名开放", () => {
    expect(selectHandoffTasks({ kind: "self" }, team, "alice").map((t) => t.id)).toEqual(["t-mine"]);
    expect(selectHandoffTasks({ kind: "task", id: "t-done" }, team, "alice").map((t) => t.id)).toEqual(["t-done"]);
    expect(selectHandoffTasks({ kind: "member", id: "bob" }, team, "alice").map((t) => t.id)).toEqual(["t-bobs"]);
    expect(selectHandoffTasks({ kind: "member", id: "carol" }, team, "alice")).toEqual([]);
  });

  it("task 视角：任务仅一条（终态也出）+ 未读按 taskId 过滤 + 视角行", () => {
    const { text, payload } = assembleHandoff(baseInput({
      filter: { kind: "task", id: "t-done" },
      tasks: [task({ taskId: "t-done", status: "completed", assignee: "bob", title: "已完成的活" })],
      unread: { count: 0, urgentCount: 0, top: [] },
      checkpoint: { path: "/cp/bob/x.md", createdAt: NOW - 180 * MIN, ageMin: 180, bytes: 999 },
    }));
    expect(text.startsWith("视角：task t-done")).toBe(true);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0]!.taskId).toBe("t-done");
    expect(payload.tasks[0]!.status).toBe("completed"); // 终态也出，供复盘
    expect(text).toContain("（我的箱里没有该任务的未读）");
    expect(payload.checkpoint!.path).toBe("/cp/bob/x.md"); // 受领人目录
  });

  it("member 视角：未读只给计数（top:[] + unreadWithheld）；该成员无开放任务有明示", () => {
    const { text, payload } = assembleHandoff(baseInput({
      filter: { kind: "member", id: "bob" },
      tasks: [],
      unread: { count: 3, urgentCount: 1, top: [], withheld: "subjects" },
    }));
    expect(payload.unread).toEqual({ count: 3, urgentCount: 1, top: [] });
    expect(payload.unreadWithheld).toBe("subjects");
    expect(text).toContain("（主题不跨成员披露）");
    expect(text).toContain("（该成员无开放任务）");
    expect(payload.suggestions).toEqual(["（该成员无开放任务）"]);
  });

  it("handoffUnreadView：task 视角按 m.taskId 过滤；member 视角计数-only", () => {
    const msgs: TeamMessage[] = [
      message({ id: "m1", content: "a", taskId: "t-1" }),
      message({ id: "m2", content: "b", taskId: "t-2", urgent: true }),
      message({ id: "m3", content: "c" }),
    ];
    const taskView = handoffUnreadView({ kind: "task", id: "t-1" }, msgs);
    expect(taskView.count).toBe(1);
    expect(taskView.top.map((t) => t.msgId)).toEqual(["m1"]);
    const memberView = handoffUnreadView({ kind: "member", id: "bob" }, msgs);
    expect(memberView).toEqual({ count: 3, urgentCount: 1, top: [], withheld: "subjects" });
    const selfView = handoffUnreadView({ kind: "self" }, msgs);
    expect(selfView.count).toBe(3);
    expect(selfView.top[0]!.msgId).toBe("m2"); // urgent 优先
  });

  it("tool_request 帧 subject 一律遮蔽（审批门不开侧门，§4.4）", () => {
    const msgs: TeamMessage[] = [
      message({ id: "m1", content: JSON.stringify({ type: "tool_request", secret: "payload原文" }) }),
      message({ id: "m2", content: "普通消息" }),
    ];
    const view = handoffUnreadView({ kind: "self" }, msgs);
    expect(view.top.map((t) => t.subject)).not.toContain("payload原文");
    expect(view.top.some((t) => t.subject.includes("tool_request"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 基础帽披露
// ---------------------------------------------------------------------------

describe("handoff: 基础帽生效时文本内披露", () => {
  it("tasks > 5 / pool > 10 / unread > 5 / suggestions > 5 均有「另有 N 条」披露 + cappedItems", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => task({ taskId: `t-${i}` }));
    const pool = Array.from({ length: 13 }, (_, i) => poolItem({ taskId: `p-${i}` }));
    const top = Array.from({ length: 8 }, (_, i) => ({ msgId: `m-${i}`, from: "bob", subject: `s${i}`, urgent: false }));
    const { text, payload } = assembleHandoff(baseInput({
      tasks,
      pool,
      poolTotal: 13,
      unread: { count: 8, urgentCount: 0, top },
      stalled: tasks.map((t, i) => ({ taskId: t.taskId, title: t.title, status: "in_progress" as const, assignee: "alice", idleForMin: 200 + i, kind: "stalled" as const })),
    }));
    expect(text).toContain("（另有 2 条任务略去）");
    expect(text).toContain("（待领池共 13 个，列前 10）");
    expect(text).toContain("（另有 3 条未读，xc_read({scope:\"inbox\"}) 消费）");
    expect(text).toContain("（另有 3 条建议略去）"); // 7 条 stalled 建议 + 1 条单在途规则提示 = 8 → 5 + 披露
    // v0.8.1（C2-B5）：基础帽对 JSON 消费方不再隐身——只要任一章被裁，truncated 就在场，
    // 且 cappedItems.shown 恒等于 payload 数组长度（文本与机器面同一组 shown 数）。
    expect(payload.truncated).toBeDefined();
    expect(payload.truncated!.droppedSections).toEqual([]);
    expect(payload.truncated!.cappedItems).toEqual({
      tasks: { shown: 5, total: 7 },
      pool: { shown: 10, total: 13 },
      unreadTop: { shown: 5, total: 8 },
      suggestions: { shown: 5, total: 8 },
    });
    expect(payload.tasks).toHaveLength(payload.truncated!.cappedItems.tasks!.shown);
    expect(payload.pool).toHaveLength(payload.truncated!.cappedItems.pool!.shown);
    expect(payload.unread.top).toHaveLength(payload.truncated!.cappedItems.unreadTop!.shown);
    expect(payload.suggestions).toHaveLength(payload.truncated!.cappedItems.suggestions!.shown);
  });

  it("未触任何帽 → truncated 不出现（形状不增不减）", () => {
    const tasks = [task({ taskId: "t-0" }), task({ taskId: "t-1" })];
    const pool = [poolItem({ taskId: "p-0" })];
    const { payload } = assembleHandoff(baseInput({
      tasks,
      pool,
      poolTotal: 1,
      unread: { count: 1, urgentCount: 0, top: [{ msgId: "m-0", from: "bob", subject: "s", urgent: false }] },
    }));
    expect(payload.truncated).toBeUndefined();
    expect(payload.tasks).toHaveLength(2);
    expect(payload.pool).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4000 字符预算降级序列（§4.3；无静默丢）
// ---------------------------------------------------------------------------

describe("handoff: 4000 字符预算降级序列", () => {
  const fat = (n: number, prefix: string): string => `${prefix}${"x".repeat(n)}`;

  it("刚好超限 → 只降 pool（droppedSections=[pool]，留名 + 末行标注）", () => {
    // L0（含整章 pool）超 4000；L1 去掉 pool 章后回落到预算内（实测标定值）。
    const tasks = [task({ taskId: "t-a1", title: fat(120, "任务") })];
    const pool = Array.from({ length: 10 }, (_, i) => poolItem({ taskId: `p-${i}`, title: fat(400, "池") }));
    const { text, payload } = assembleHandoff(baseInput({
      tasks,
      pool,
      poolTotal: 10,
      unread: { count: 5, urgentCount: 1, top: Array.from({ length: 5 }, (_, i) => ({ msgId: `m-${i}`, from: "bob", subject: fat(60, "主题"), urgent: i === 0 })) },
    }));
    expect(text.length).toBeLessThanOrEqual(HANDOFF_BUDGET_CHARS);
    expect(payload.truncated).toBeDefined();
    expect(payload.truncated!.droppedSections).toEqual(["pool"]);
    expect(payload.truncated!.budgetChars).toBe(4000);
    expect(payload.truncated!.cappedItems.pool).toEqual({ shown: 0, total: 10 });
    expect(text).toContain("（待领池按 4000 字符预算略去：xc_overview 看板）");
    expect(text).toContain("[已按 4000 字符预算截断：略去/缩减 pool；");
    // 不静默丢：未读/tasks/建议仍在场
    expect(text).toContain("## 2. 我的任务");
    expect(text).toContain("## 4. 未读");
    expect(text).toContain("## 7. 建议下一步");
    // v0.8.1（C2-B5）：payload 与文本面同一级裁切——pool 章被降级，payload.pool 也是空数组，
    // cappedItems.shown === payload 数组长度恒成立（旧实现这里留 10 条，JSON 消费方误判「没丢」）。
    expect(payload.pool).toHaveLength(0);
    expect(payload.truncated!.cappedItems.pool).toEqual({ shown: 0, total: 10 });
  });

  it("更大 → 级联 pool+unread+tasks（顺序固定，逐级留名）", () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task({ taskId: `t-${i}`, title: fat(3000, "任务") }));
    const pool = Array.from({ length: 10 }, (_, i) => poolItem({ taskId: `p-${i}`, title: fat(300, "池") }));
    const top = Array.from({ length: 5 }, (_, i) => ({ msgId: `m-${i}`, from: "bob", subject: fat(200, "主题"), urgent: false }));
    const { text, payload } = assembleHandoff(baseInput({
      tasks,
      pool,
      poolTotal: 10,
      unread: { count: 5, urgentCount: 0, top },
      stalled: tasks.map((t, i) => ({ taskId: t.taskId, title: t.title, status: "in_progress" as const, assignee: "alice", idleForMin: 200 + i, kind: "stalled" as const })),
    }));
    expect(text.length).toBeLessThanOrEqual(HANDOFF_BUDGET_CHARS);
    const dropped = payload.truncated!.droppedSections;
    expect(dropped.length).toBeGreaterThanOrEqual(2);
    // 固定降级序的前缀（命中的级数由尺寸决定，但顺序必须固定）
    const order = ["pool", "unread", "tasks", "suggestions"];
    expect(order.slice(0, dropped.length)).toEqual(dropped);
    expect(text).toContain("字符预算截断");
    // 每级留名：末行列出全部被略去的章
    for (const name of dropped) expect(text).toContain(name);
    // 被降级章的替代文本在场（不是静默消失）
    expect(text).toContain("（待领池按 4000 字符预算略去：xc_overview 看板）");
    expect(text).toMatch(/未读 \d+ 条（urgent \d+）——主题按 4000 字符预算略去/);
    expect(text).toContain("（另有 4 条任务略去）"); // tasks 降级到首条
  });

  it("巨大 → 整体硬截（含「正文」留名）且不超预算", () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task({ taskId: `t-${i}`, title: fat(5000, "任务") }));
    const pool = Array.from({ length: 10 }, (_, i) => poolItem({ taskId: `p-${i}`, title: fat(3000, "池") }));
    const { text, payload } = assembleHandoff(baseInput({
      tasks,
      pool,
      poolTotal: 10,
      unread: { count: 5, urgentCount: 0, top: Array.from({ length: 5 }, (_, i) => ({ msgId: `m-${i}`, from: "bob", subject: fat(1000, "主题"), urgent: false })) },
      stalled: tasks.map((t, i) => ({ taskId: t.taskId, title: t.title, status: "in_progress" as const, assignee: "alice", idleForMin: 200 + i, kind: "stalled" as const })),
    }));
    expect(text.length).toBeLessThanOrEqual(HANDOFF_BUDGET_CHARS);
    expect(payload.truncated!.droppedSections).toEqual(["pool", "unread", "tasks", "suggestions", "正文"]);
    expect(text.endsWith("取]")).toBe(true);
    // 身份章（最小集）在硬截后仍在场
    expect(text).toContain("## 1. 身份");
  });
});

// ---------------------------------------------------------------------------
// 建议下一步：可达性（C9-B5——不得给出走不通的指令）
// ---------------------------------------------------------------------------

describe("handoff: 建议下一步可达性", () => {
  it("task 视角：他人 in_progress → takeover/等清扫指引（不出走不通的 claim）", () => {
    const { payload } = assembleHandoff(baseInput({
      filter: { kind: "task", id: "t-bobs" },
      tasks: [task({ taskId: "t-bobs", status: "in_progress", assignee: "bob" })],
      myOpenTaskId: null,
    }));
    expect(payload.suggestions.join("\n")).toContain("xc_identify({takeover:true})");
    expect(payload.suggestions.join("\n")).toContain("task_not_pending");
  });

  it("task 视角：pending 可认领 → xc_claim 指针；有在途时附单在途规则", () => {
    const claimable = assembleHandoff(baseInput({
      filter: { kind: "task", id: "t-pool" },
      tasks: [task({ taskId: "t-pool", status: "pending", assignee: null })],
      myOpenTaskId: null,
    }));
    expect(claimable.payload.suggestions.join("\n")).toContain('xc_claim({taskId:"t-pool"})');
    const withOpen = assembleHandoff(baseInput({
      filter: { kind: "task", id: "t-pool" },
      tasks: [task({ taskId: "t-pool", status: "pending", assignee: null })],
      myOpenTaskId: "t-mine",
    }));
    expect(withOpen.payload.suggestions.join("\n")).toContain("先 xc_report 收尾 t-mine");
  });

  it("task 视角：pending 但受领人是他人 → 明示 claim 会被拒", () => {
    const { payload } = assembleHandoff(baseInput({
      filter: { kind: "task", id: "t-pool" },
      tasks: [task({ taskId: "t-pool", status: "pending", assignee: null, to: "bob" })],
      myOpenTaskId: null,
    }));
    expect(payload.suggestions.join("\n")).toContain("not_assignee");
  });

  it("task 视角：依赖未满足 → 等待项（不出 claim 指令）", () => {
    const { payload } = assembleHandoff(baseInput({
      filter: { kind: "task", id: "t-pool" },
      tasks: [task({ taskId: "t-pool", status: "pending", assignee: null, unmetDependsOn: ["t-x"] })],
      myOpenTaskId: null,
    }));
    const joined = payload.suggestions.join("\n");
    expect(joined).toContain("依赖 t-x 未终态 → 等待项");
    expect(joined).not.toContain("xc_claim");
  });

  it("self 视角：有在途 + 池有可认领 → 单在途规则提示；无在途 → 认领建议", () => {
    const withOpen = assembleHandoff(baseInput({
      tasks: [task({ taskId: "t-mine" })],
      pool: [poolItem({ taskId: "p-1" }), poolItem({ taskId: "p-2", unmetDependsOn: ["t-x"] })],
      poolTotal: 2,
      myOpenTaskId: "t-mine",
    }));
    expect(withOpen.payload.suggestions.join("\n")).toContain("先 xc_report 收尾当前任务（t-mine）再认领 p-1");
    const noOpen = assembleHandoff(baseInput({
      tasks: [],
      pool: [poolItem({ taskId: "p-1" })],
      poolTotal: 1,
      myOpenTaskId: null,
    }));
    expect(noOpen.payload.suggestions.join("\n")).toContain("无在途任务且有待领 → 可认领 p-1");
  });

  it("停滞/阻塞建议用 stallSuggestion 原文；无项时回落行", () => {
    const stalled = assembleHandoff(baseInput({
      tasks: [task({ taskId: "t-a1", status: "in_progress" })],
      stalled: [{ taskId: "t-a1", title: "任务标题", status: "in_progress", assignee: "alice", idleForMin: 200, kind: "stalled" }],
    }));
    expect(stalled.payload.suggestions[0]).toContain("relay 催办 / cancel / 重派（转交）");
    const none = assembleHandoff(baseInput({ tasks: [task({ taskId: "t-a1" })] }));
    expect(none.payload.suggestions).toEqual(["（暂无：按 journal 指针继续）"]);
  });
});

// ---------------------------------------------------------------------------
// v0.8.1 红队二十九番修复回归（本组：M02 渲染判据 / C2-B5 口径 / C2-B8 形状 / C2-B9 成员视角）
// ---------------------------------------------------------------------------

describe("handoff v0.8.1: 身份章判据 = 花名册成员身份（M02）", () => {
  it("在册成员（memberState=ready，identify 入册不落 state 字段时的访问器值）→ state: ready", () => {
    // 根因回放：xc_identify 入册的成员记录本就不落 state 字段；工具层旧实现直取
    // member?.state ?? null，使在册成员恒报 (not on roster)/memberState:null，
    // 与 team.json / status / identify roster / checkpoint 身份章（state: ready）相反。
    const { text, payload } = assembleHandoff(baseInput({
      identity: { agentKey: "alice", teamId: "default", leadKey: null, role: "peer", memberState: "ready", isLead: true },
    }));
    expect(text).toContain("state: ready");
    expect(text).not.toContain("(not on roster)");
    expect(payload.identity.memberState).toBe("ready");
  });

  it("不在册（role/memberState 均 null）→ 才报 (not on roster)（§14.1 语义）", () => {
    const { text, payload } = assembleHandoff(baseInput({
      identity: { agentKey: "ghost", teamId: "default", leadKey: null, role: null, memberState: null, isLead: false },
    }));
    expect(text).toContain("role: (not on roster)");
    expect(text).toContain("state: (not on roster)");
    expect(payload.identity.memberState).toBeNull();
  });
});

describe("handoff v0.8.1: cappedItems 与 payload 口径一致（C2-B5）", () => {
  it("L2 降级：unread 章降为计数行 → payload.unread.top 空数组 + cappedItems.unreadTop={0,total}", () => {
    const tasks = [task({ taskId: "t-a1", title: "x".repeat(1500) })];
    const pool = Array.from({ length: 10 }, (_, i) => poolItem({ taskId: `p-${i}`, title: "y".repeat(300) }));
    const top = Array.from({ length: 5 }, (_, i) => ({ msgId: `m-${i}`, from: "bob", subject: "z".repeat(800), urgent: false }));
    const { payload } = assembleHandoff(baseInput({
      tasks, pool, poolTotal: 10,
      unread: { count: 5, urgentCount: 0, top },
    }));
    const dropped = payload.truncated!.droppedSections;
    expect(dropped).toContain("unread");
    // 旧实现：文本 shown:0 而 payload.top 保留 5 条 → 只读 JSON 消费方误判「没丢」。
    expect(payload.unread.top).toHaveLength(0);
    expect(payload.truncated!.cappedItems.unreadTop).toEqual({ shown: 0, total: 5 });
    expect(payload.truncated!.cappedItems.pool).toEqual({ shown: 0, total: 10 });
    expect(payload.pool).toHaveLength(0);
    // 不变量：每个 cappedItems 项的 shown === 对应 payload 数组长度
    expect(payload.pool.length).toBe(payload.truncated!.cappedItems.pool!.shown);
    expect(payload.unread.top.length).toBe(payload.truncated!.cappedItems.unreadTop!.shown);
  });

  it("L3 降级：tasks 只留首条 → payload.tasks 同步只 1 条 + cappedItems.tasks", () => {
    const tasks = Array.from({ length: 6 }, (_, i) => task({ taskId: `t-${i}`, title: "x".repeat(700) }));
    const { text, payload } = assembleHandoff(baseInput({
      tasks, pool: [], poolTotal: 0,
      unread: { count: 0, urgentCount: 0, top: [] },
    }));
    expect(text).toContain("（另有 5 条任务略去）");
    expect(payload.tasks).toHaveLength(1);
    expect(payload.truncated!.cappedItems.tasks).toEqual({ shown: 1, total: 6 });
  });

  it("L4 降级：suggestions 只留首条 → payload.suggestions 同步 1 条", () => {
    // 尺寸标定：L3（tasks 首条 3200 字符 + 5 条建议）≈4080 > 4000；L4（只留 1 条建议）≈3840 ≤ 4000。
    const tasks = Array.from({ length: 5 }, (_, i) => task({ taskId: `t-${i}`, title: i === 0 ? "x".repeat(3200) : "短" }));
    const pool = Array.from({ length: 10 }, (_, i) => poolItem({ taskId: `p-${i}`, title: "y".repeat(300) }));
    const { payload } = assembleHandoff(baseInput({
      tasks, pool, poolTotal: 10,
      unread: { count: 5, urgentCount: 0, top: Array.from({ length: 5 }, (_, i) => ({ msgId: `m-${i}`, from: "bob", subject: "z".repeat(300), urgent: false })) },
      stalled: tasks.map((t) => ({ taskId: t.taskId, title: t.title, status: "in_progress" as const, assignee: "alice", idleForMin: 300, kind: "stalled" as const })),
    }));
    expect(payload.truncated!.droppedSections).toEqual(["pool", "unread", "tasks", "suggestions"]);
    expect(payload.suggestions).toHaveLength(1);
    expect(payload.truncated!.cappedItems.suggestions!.shown).toBe(1);
  });
});

describe("handoff v0.8.1: pool 冻结形状 priority 恒在（C2-B8）", () => {
  it("priority 缺省（旧记录 normal）→ payload 键集恰五键且 priority='normal'（不丢键）", () => {
    // 根因回放：JSON.stringify 丢弃 value 为 undefined 的键——旧实现直传
    // p.priority（undefined），normal 项在 JSON 面缺 priority 键，而 §14.3
    // 冻结形状 [{taskId,title,priority,dependsOn,unmetDependsOn}] 要求恒在。
    const { payload } = assembleHandoff(baseInput({
      pool: [poolItem({ taskId: "p-0", priority: undefined }), poolItem({ taskId: "p-1", priority: "low" })],
      poolTotal: 2,
    }));
    expect(Object.keys(payload.pool[0]!).sort()).toEqual(
      ["dependsOn", "priority", "taskId", "title", "unmetDependsOn"].sort(),
    );
    expect(payload.pool[0]!.priority).toBe("normal");
    expect(payload.pool[1]!.priority).toBe("low");
    // 文本面同口径（缺省渲染 normal）
    const { text } = assembleHandoff(baseInput({ pool: [poolItem({ taskId: "p-0", priority: undefined })], poolTotal: 1 }));
    expect(text).toContain("- p-0 | normal |");
  });
});

describe("handoff v0.8.1: member 视角补单在途任务规则（C2-B9）", () => {
  it("该成员有在途 + 池有可认领 → 第三人称单在途规则（self 视角同规则不缺席）", () => {
    const memberView = assembleHandoff(baseInput({
      filter: { kind: "member", id: "bob" },
      tasks: [task({ taskId: "t-bobs", assignee: "bob" })],
      pool: [poolItem({ taskId: "p-1" }), poolItem({ taskId: "p-2", unmetDependsOn: ["t-x"] })],
      poolTotal: 2,
      myOpenTaskId: null, // 调用方（alice）无在途——规则仍须在场（旧实现此处退化成「暂无」）
    }));
    const joined = memberView.payload.suggestions.join("\n");
    expect(joined).toContain("单在途任务规则");
    expect(joined).toContain("bob 需先 xc_report 收尾当前任务（t-bobs）再认领 p-1");
    // 走不开的指令纪律（C9-B5）：member 视角不得对调用方下「你替 bob 收尾」的祈使句
    expect(joined).not.toMatch(/^先 xc_report/m);
    const selfView = assembleHandoff(baseInput({
      tasks: [task({ taskId: "t-mine" })],
      pool: [poolItem({ taskId: "p-1" })],
      poolTotal: 1,
      myOpenTaskId: "t-mine",
    }));
    expect(selfView.payload.suggestions.join("\n")).toContain("单在途任务规则：先 xc_report 收尾当前任务（t-mine）再认领 p-1");
  });

  it("member 视角：可认领项按该成员视角算（受领指定给 bob 的池项对 bob 可达）", () => {
    const { payload } = assembleHandoff(baseInput({
      filter: { kind: "member", id: "bob" },
      tasks: [task({ taskId: "t-bobs", assignee: "bob" })],
      pool: [poolItem({ taskId: "p-for-bob", to: "bob" }), poolItem({ taskId: "p-for-carol", to: "carol" })],
      poolTotal: 2,
      myOpenTaskId: null,
    }));
    const joined = payload.suggestions.join("\n");
    expect(joined).toContain("再认领 p-for-bob");
    expect(joined).not.toContain("p-for-carol");
  });

  it("member 视角无开放任务 → 仍记「（该成员无开放任务）」（既有冻结语义不回归）", () => {
    const { payload } = assembleHandoff(baseInput({
      filter: { kind: "member", id: "bob" },
      tasks: [],
      pool: [poolItem({ taskId: "p-1" })],
      poolTotal: 1,
    }));
    expect(payload.suggestions).toEqual(["（该成员无开放任务）"]);
  });
});

describe("handoff v0.8.1: member 视角 withhold 不进 cappedItems（防把隐私披露误读成截断）", () => {
  it("member 视角有未读计数但 top 为空（§4.4）→ 无 unreadTop 帽、无 truncated（未被裁）", () => {
    const { text, payload } = assembleHandoff(baseInput({
      filter: { kind: "member", id: "bob" },
      tasks: [task({ taskId: "t-bobs", assignee: "bob" })],
      unread: { count: 3, urgentCount: 1, top: [], withheld: "subjects" },
    }));
    expect(payload.unread).toEqual({ count: 3, urgentCount: 1, top: [] });
    expect(payload.unreadWithheld).toBe("subjects");
    expect(text).toContain("（主题不跨成员披露）");
    expect(text).not.toContain("另有");
    expect(payload.truncated).toBeUndefined();
  });
});
