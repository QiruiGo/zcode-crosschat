/**
 * W3 graph 单测（DESIGN-V0.2.md §9.1 所有权表「graph.test.ts ★ 同属 W3」）：
 * 覆盖 §11.2 要求的「依赖解除、清扫、预算截断」三类判据 + 引擎特权重置与收件人扫描。
 * 全部为纯函数驱动：直接构造 Task/TeamMessage 字面量，不触盘。
 */
import { describe, expect, it } from "vitest";
import type { Task, TeamMessage } from "./types.js";
import {
  collectDependencyOutputs,
  completedDependencyOutputs,
  deadlockedDependents,
  downstreamReady,
  findTaskRecipient,
  revokeAttempt,
  staleTasks,
} from "./graph.js";

// ─────────────────────────── 测试任务工厂 ───────────────────────────

function task(overrides: Partial<Task> & Pick<Task, "id" | "status">): Task {
  return {
    title: `T ${overrides.id}`,
    prompt: "P",
    dependsOn: [],
    assignee: null,
    attempt: 0,
    attemptId: null,
    createdBy: "a",
    createdAt: 1_000,
    updatedAt: 1_000,
    result: null,
    error: null,
    evidence: [],
    history: [],
    ...overrides,
  } as Task;
}

function msg(overrides: Partial<TeamMessage> & Pick<TeamMessage, "id" | "to" | "content">): TeamMessage {
  const { id, to, content, ...rest } = overrides;
  return { from: "a", ts: 1, id, to, content, ...rest };
}

// ─────────────────────────── downstreamReady（依赖解除） ───────────────────────────

describe("downstreamReady（E-b ②依赖解除的核心谓词）", () => {
  it("直依赖完成 → pending 且依赖全满足的下游任务就绪", () => {
    const tasks = [
      task({ id: "t1", status: "completed" }),
      task({ id: "t2", status: "pending", dependsOn: ["t1"] }),
    ];
    expect(downstreamReady(tasks, "t1").map((t) => t.id)).toEqual(["t2"]);
  });

  it("部分依赖未满足 → 不就绪（t2 未完成时 t3 不解锁）", () => {
    const tasks = [
      task({ id: "t1", status: "completed" }),
      task({ id: "t2", status: "pending", dependsOn: ["t1"] }),
      task({ id: "t3", status: "pending", dependsOn: ["t1", "t2"] }),
    ];
    expect(downstreamReady(tasks, "t1").map((t) => t.id)).toEqual(["t2"]);
  });

  it("传递闭包：中间任务已完成后，末端任务在中间任务完成边就绪（不在 t1 边提前）", () => {
    const tasks = [
      task({ id: "t1", status: "completed" }),
      task({ id: "t2", status: "completed", dependsOn: ["t1"] }),
      task({ id: "t3", status: "pending", dependsOn: ["t2"] }),
    ];
    // t1 的完成边不会重复解锁 t3（t2 已把它解锁）——就绪判定以全依赖满足为准，
    // 但 t3 的直接依赖是 t2，t1 边上 t3 不就绪是因 t2 此刻已 completed、t3 理应早已解锁；
    // 防御性场景：t3 仍 pending（例如曾被清扫回池），t1 边不把它算作「恰因此就绪」。
    expect(downstreamReady(tasks, "t1")).toEqual([]);
    expect(downstreamReady(tasks, "t2").map((t) => t.id)).toEqual(["t3"]);
  });

  it("菱形依赖：两条路径汇合的下游只出现一次（visited 去重）", () => {
    const tasks = [
      task({ id: "t1", status: "completed" }),
      task({ id: "t2", status: "completed", dependsOn: ["t1"] }),
      task({ id: "t3", status: "completed", dependsOn: ["t1"] }),
      task({ id: "t4", status: "pending", dependsOn: ["t2", "t3"] }),
    ];
    expect(downstreamReady(tasks, "t1").map((t) => t.id)).toEqual([]);
    expect(downstreamReady(tasks, "t2").map((t) => t.id)).toEqual(["t4"]);
  });

  it("环安全：依赖环不断言崩溃，只跳过环上不可就绪的任务", () => {
    const tasks = [
      task({ id: "t1", status: "completed" }),
      task({ id: "t2", status: "pending", dependsOn: ["t3"] }),
      task({ id: "t3", status: "pending", dependsOn: ["t2"] }),
    ];
    expect(() => downstreamReady(tasks, "t1")).not.toThrow();
    expect(downstreamReady(tasks, "t1")).toEqual([]);
  });

  it("非 pending（claimed/completed/failed）的下游不进入就绪表", () => {
    const tasks = [
      task({ id: "t1", status: "completed" }),
      task({ id: "t2", status: "claimed", assignee: "m1", dependsOn: ["t1"] }),
      task({ id: "t3", status: "completed", dependsOn: ["t1"] }),
      task({ id: "t4", status: "failed", dependsOn: ["t1"] }),
    ];
    expect(downstreamReady(tasks, "t1")).toEqual([]);
  });

  it("dependsOn 引用不存在的任务 → 视为未满足，不就绪、不崩溃", () => {
    const tasks = [
      task({ id: "t1", status: "completed" }),
      task({ id: "t2", status: "pending", dependsOn: ["t1", "tX"] }),
    ];
    expect(downstreamReady(tasks, "t1")).toEqual([]);
  });

  it("完成边只解锁「恰好因本条完成而满足全部依赖」的下游", () => {
    const tasks = [
      task({ id: "t1", status: "completed" }),
      task({ id: "t2", status: "completed", dependsOn: ["t1"] }),
      task({ id: "t3", status: "completed", dependsOn: ["t1"] }),
      task({ id: "t4", status: "pending", dependsOn: ["t2", "t3"] }),
      task({ id: "t5", status: "pending", dependsOn: ["t1"] }),
    ];
    // t2 完成边：t4 的依赖 t2 ✓ + t3（早已 completed）✓ → t4 就绪；
    // t5 与 t2 无依赖关系，不在本边。
    expect(downstreamReady(tasks, "t2").map((t) => t.id)).toEqual(["t4"]);
    // t1 完成边（重放视角）：t5 直依赖 t1 且依赖全满足 → 就绪；
    // t4 不直依赖 t1（其就绪归属 t3/t2 的完成边），不重复通知。
    expect(downstreamReady(tasks, "t1").map((t) => t.id)).toEqual(["t5"]);
  });
});

// ─────────────────────────── collectDependencyOutputs（2000/12000 预算） ───────────────────────────

describe("collectDependencyOutputs（§12-O11：dsh scheduler.js:20-93 预算语义）", () => {
  it("无已完成依赖 → (none)", () => {
    const tasks = [task({ id: "t1", status: "pending", dependsOn: ["t0"] })];
    expect(collectDependencyOutputs(tasks, "t1")).toBe("(none)");
  });

  it("已完成依赖按拓扑序列出，含 id/title/result", () => {
    const tasks = [
      task({ id: "t1", status: "completed", title: "平方表", result: "1 4 9", dependsOn: [] }),
      task({ id: "t2", status: "pending", dependsOn: ["t1"] }),
    ];
    const out = collectDependencyOutputs(tasks, "t2");
    expect(out).toContain("- t1 平方表:");
    expect(out).toContain("1 4 9");
    expect(out).not.toContain("t2"); // 只列祖先，不含本任务
  });

  it("多层传递闭包：依赖在前、依赖者在后（拓扑序）", () => {
    const tasks = [
      task({ id: "tA", status: "completed", title: "A", result: "ra" }),
      task({ id: "tB", status: "completed", title: "B", result: "rb", dependsOn: ["tA"] }),
      task({ id: "tC", status: "pending", dependsOn: ["tB"] }),
    ];
    const out = collectDependencyOutputs(tasks, "tC");
    expect(out.indexOf("tA")).toBeLessThan(out.indexOf("tB"));
  });

  it("单项超 2000 → 截断并加 [truncated]", () => {
    const tasks = [
      task({ id: "t1", status: "completed", title: "T", result: "x".repeat(3000) }),
      task({ id: "t2", status: "pending", dependsOn: ["t1"] }),
    ];
    const out = collectDependencyOutputs(tasks, "t2");
    expect(out).toContain("[truncated]");
    expect(out.length).toBeLessThan(3000);
  });

  it("总超 12000 → 从最上游开始丢弃，保底留最近一项", () => {
    // 单项 1900（未超单项预算 2000）× 9 项 ≈ 17k > 12000 → 丢弃最上游至总额内。
    const tasks: Task[] = [];
    for (let i = 1; i <= 8; i++) {
      tasks.push(task({ id: `d${i}`, status: "completed", title: `D${i}`, result: "z".repeat(1900) }));
    }
    tasks.push(
      task({ id: "d8b", status: "completed", title: "D8b", result: "z".repeat(1900), dependsOn: ["d8"] }),
    );
    tasks.push(task({ id: "top", status: "pending", dependsOn: ["d8b"] }));
    // 闭包含 d1..d8, d8b 共 9 项，每项格式化后 ~1900+开销 → 总长超 12000。
    const out = collectDependencyOutputs(tasks, "top");
    expect(out.length).toBeLessThanOrEqual(12_000 + "[truncated]".length + 100);
    // 保底项 = 拓扑序最后一项（离 top 最近）必须保留。
    expect(out).toContain("d8b");
    // 最上游被丢弃。
    expect(out).not.toContain("- d1 ");
  });

  it("结果为空的已完成依赖 → (no output recorded) 占位", () => {
    const tasks = [
      task({ id: "t1", status: "completed", title: "T", result: null }),
      task({ id: "t2", status: "pending", dependsOn: ["t1"] }),
    ];
    expect(collectDependencyOutputs(tasks, "t2")).toContain("(no output recorded)");
  });

  it("completedDependencyOutputs：跳过未完成祖先；taskId 自身不入列", () => {
    const tasks = [
      task({ id: "t1", status: "completed", title: "A", result: "ra" }),
      task({ id: "t2", status: "failed", title: "B", result: null, dependsOn: ["t1"] }),
      task({ id: "t3", status: "completed", title: "C", result: "rc", dependsOn: ["t2"] }),
    ];
    expect(completedDependencyOutputs(tasks, "t3").map((i) => i.id)).toEqual(["t1"]);
  });
});

// ─────────────────────────── revokeAttempt（引擎特权重置，§5.4） ───────────────────────────

describe("revokeAttempt（引擎特权重置：claimed|in_progress → pending）", () => {
  it("claimed 任务重置：pending + assignee/attemptId 清空 + attempt+1 + 结果清空 + history", () => {
    const t = task({
      id: "t1",
      status: "claimed",
      assignee: "m1",
      attempt: 1,
      attemptId: "at-1",
      result: "半成品",
      evidence: [{ path: "D:\\e.txt", sha256: null, note: "" }],
    });
    t.history.push({ ts: 1, event: "claimed", by: "m1", attemptId: "at-1" });
    const ok = revokeAttempt(t, { by: "engine", now: 5_000, event: "revoked-stale" });
    expect(ok).toBe(true);
    expect(t.status).toBe("pending");
    expect(t.assignee).toBeNull();
    expect(t.attemptId).toBeNull();
    expect(t.attempt).toBe(2); // 代数 +1（§5.4 明文）
    expect(t.result).toBeNull();
    expect(t.evidence).toEqual([]);
    expect(t.updatedAt).toBe(5_000);
    const last = t.history[t.history.length - 1]!;
    expect(last.event).toBe("revoked-stale");
    expect(last.by).toBe("engine");
  });

  it("in_progress 同样可重置；缺省 event 为 revoked-stale、by 为 engine", () => {
    const t = task({ id: "t1", status: "in_progress", assignee: "m2", attempt: 3, attemptId: "at-3" });
    expect(revokeAttempt(t, { now: 9 })).toBe(true);
    expect(t.status).toBe("pending");
    expect(t.history[t.history.length - 1]!.event).toBe("revoked-stale");
    expect(t.history[t.history.length - 1]!.by).toBe("engine");
  });

  it("terminal/pending 任务为幂等 no-op，返回 false", () => {
    for (const status of ["pending", "completed", "failed", "cancelled"] as const) {
      const t = task({ id: "t1", status, attempt: 1, attemptId: status === "pending" ? null : "at" });
      expect(revokeAttempt(t)).toBe(false);
      expect(t.status).toBe(status);
      expect(t.attempt).toBe(1);
    }
  });
});

// ─────────────────────────── staleTasks（清扫候选，§5.4） ───────────────────────────

describe("staleTasks（清扫候选判定）", () => {
  it("claimed/in_progress 且超时者入选；pending 与新鲜任务不入", () => {
    const now = 1_000_000;
    const threshold = 30 * 60_000;
    const tasks = [
      task({ id: "t1", status: "claimed", assignee: "m1", updatedAt: now - threshold - 1 }), // 超时 1ms
      task({ id: "t2", status: "in_progress", assignee: "m1", updatedAt: now - threshold - 60_000 }),
      task({ id: "t3", status: "claimed", assignee: "m2", updatedAt: now - threshold }), // 恰在阈值上：不算（严格 >）
      task({ id: "t4", status: "pending", updatedAt: now - threshold - 1 }), // pending 不清
      task({ id: "t5", status: "completed", updatedAt: now - threshold - 1 }),
    ];
    expect(staleTasks(tasks, now, threshold).map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});

// ─────────────────────────── findTaskRecipient（收件人扫描） ───────────────────────────

describe("findTaskRecipient（unblock-notice 投递目标定位）", () => {
  const assignment = JSON.stringify({ type: "task-assignment", teamId: "default", title: "T", prompt: "P" });

  it("命中携带该 taskId 的 task-assignment 帧 → 返回消息 to", () => {
    const messages = [
      msg({ id: "m1", to: "m2", content: JSON.stringify({ type: "task-receipt", taskId: "t9" }), taskId: "t9" }),
      msg({ id: "m2", to: "m1", content: assignment, taskId: "t2" }),
    ];
    expect(findTaskRecipient(messages, "t2")).toBe("m1");
  });

  it("无派发帧 / taskId 不匹配 / 非派单帧 → undefined", () => {
    expect(findTaskRecipient([], "t2")).toBeUndefined();
    expect(findTaskRecipient([msg({ id: "m1", to: "m1", content: assignment, taskId: "t1" })], "t2")).toBeUndefined();
    // receipt 帧虽带 taskId 但不是 task-assignment → 不算派发对象
    const receipt = JSON.stringify({ type: "task-receipt", taskId: "t2" });
    expect(findTaskRecipient([msg({ id: "m1", to: "m1", content: receipt, taskId: "t2" })], "t2")).toBeUndefined();
    // 自由文本（不可解析）→ 忽略
    expect(findTaskRecipient([msg({ id: "m2", to: "m3", content: "hello", taskId: "t2" })], "t2")).toBeUndefined();
  });
});

// ─────────────────────────── v0.5.3（A3 修复）：deadlockedDependents ───────────────────────────

describe("deadlockedDependents（A3：failed/cancelled 上游的死锁下游）", () => {
  it("直依赖的 pending 下游被收集", () => {
    const tasks = [
      task({ id: "t1", status: "failed" }),
      task({ id: "t2", status: "pending", dependsOn: ["t1"] }),
    ];
    expect(deadlockedDependents(tasks, "t1").map((t) => t.id)).toEqual(["t2"]);
  });

  it("传递闭包：深度 ≥2 的下游同样死锁（t3 依赖 t2、t2 依赖 t1）", () => {
    const tasks = [
      task({ id: "t1", status: "failed" }),
      task({ id: "t2", status: "pending", dependsOn: ["t1"] }),
      task({ id: "t3", status: "pending", dependsOn: ["t2"] }),
    ];
    expect(deadlockedDependents(tasks, "t1").map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  it("幂等：已 cancelled 的下游不重复收集（跳过），pending 的仍收集", () => {
    const tasks = [
      task({ id: "t1", status: "cancelled" }),
      task({ id: "t2", status: "cancelled", dependsOn: ["t1"] }),
      task({ id: "t3", status: "pending", dependsOn: ["t1"] }),
    ];
    expect(deadlockedDependents(tasks, "t1").map((t) => t.id)).toEqual(["t3"]);
  });

  it("claimed/in_progress 下游不被触碰（防御：pending 过滤）", () => {
    const tasks = [
      task({ id: "t1", status: "failed" }),
      task({ id: "t2", status: "claimed", dependsOn: ["t1"] }),
      task({ id: "t3", status: "in_progress", dependsOn: ["t1"] }),
    ];
    expect(deadlockedDependents(tasks, "t1")).toEqual([]);
  });

  it("diamond：多路径依赖只收集一次（visited 去重）", () => {
    const tasks = [
      task({ id: "t1", status: "failed" }),
      task({ id: "t2", status: "pending", dependsOn: ["t1"] }),
      task({ id: "t3", status: "pending", dependsOn: ["t1"] }),
      task({ id: "t4", status: "pending", dependsOn: ["t2", "t3"] }),
    ];
    const ids = deadlockedDependents(tasks, "t1").map((t) => t.id);
    expect(ids.sort()).toEqual(["t2", "t3", "t4"]);
  });

  it("环安全：依赖环只断该支，不死循环", () => {
    const tasks = [
      task({ id: "t1", status: "failed" }),
      task({ id: "t2", status: "pending", dependsOn: ["t1", "t3"] }),
      task({ id: "t3", status: "pending", dependsOn: ["t2"] }),
    ];
    const ids = deadlockedDependents(tasks, "t1").map((t) => t.id).sort();
    expect(ids).toEqual(["t2", "t3"]);
  });

  it("无下游 → 空数组（绝大多数 failed 任务零成本）", () => {
    expect(deadlockedDependents([task({ id: "t1", status: "failed" })], "t1")).toEqual([]);
  });
});
