/** M3/W4 render 单测：人可读一行摘要、任务板与 v0.2 全景（不触盘的纯函数部分）。 */
import { describe, expect, it } from "vitest";
import {
  renderClaim,
  renderDispatch,
  renderInbox,
  renderMessage,
  renderPanorama,
  renderRegister,
  renderReport,
  renderStatusTable,
  shortId,
  type PanoramaExtras,
  type StatusSnapshot,
} from "./render.js";

function snapshot(): StatusSnapshot {
  return {
    teamId: "default",
    generatedAt: 1762660000000,
    phase: "open",
    founderKey: "a",
    members: [
      { key: "a", sessionId: "sess-a", role: "peer", lastSeen: 1762659999000 },
      { key: "b", sessionId: "sess-b", role: "worker", lastSeen: 1762659998000 },
    ],
    tasks: [
      {
        id: "t1",
        title: "计算 17*23 并写盘",
        status: "completed",
        assignee: "b",
        attempt: 1,
        attemptId: "9f2c1a3b4d5e6f70",
        dependsOn: [],
        createdBy: "a",
        result: "391",
        error: null,
        evidenceCount: 1,
        updatedAt: 1762660001000,
      },
      {
        id: "t2",
        title: "另一件事\n带换行的长标题会折叠为空格并被截断处理",
        status: "in_progress",
        assignee: "a",
        attempt: 2,
        attemptId: null,
        dependsOn: ["t1"],
        createdBy: "a",
        result: null,
        error: null,
        evidenceCount: 0,
        updatedAt: 1762660002000,
      },
    ],
    unread: { a: 1, b: 0 },
  };
}

describe("render: 一行摘要", () => {
  it("shortId 取前 8 位", () => {
    expect(shortId("1234567890abcdef")).toBe("12345678");
    expect(shortId("short")).toBe("short");
  });

  it("register 行含名字/团队/花名册与告警", () => {
    const line = renderRegister("a", "sess-abcdef12", "default", snapshot().members, ["old lastSeen"]);
    expect(line).toContain("a (sess-abc");
    expect(line).toContain('team "default"');
    expect(line).toContain("a, b");
    expect(line).toContain("warnings: old lastSeen");
  });

  it("dispatch/report/message/inbox/claim 行格式与 dsh render 思路一致", () => {
    expect(renderDispatch("t1", "b", "mailbox")).toBe("Task t1 dispatched to b via mailbox.");
    expect(renderReport("t1", "completed", "a", "wake")).toBe(
      "Task t1 completed; receipt sent to a; wake back via wake.",
    );
    expect(renderReport("t2", "in_progress", null, "mailbox")).toContain("no receipt (non-terminal)");
    expect(renderMessage("1a2b3c4d5e6f", "a", "b", "duplicate")).toBe(
      "Message 1a2b3c4d a → b delivered via duplicate.",
    );
    expect(renderInbox(2, 1, 0)).toBe("Inbox: 2 message(s) consumed, 1 stale discarded, 0 unread remain.");
    expect(renderClaim("t1", 1, "9f2c1a3b4d5e6f70")).toBe("Task t1 claimed (attempt 1, attemptId 9f2c1a3b).");
  });
});

describe("render: 任务板", () => {
  it("含团队成员与未读数、任务六态/认领人/attempt 代数", () => {
    const text = renderStatusTable(snapshot());
    expect(text).toContain('Team "default" phase=open founder=a tasks=2');
    expect(text).toContain("a:1unread");
    expect(text).toContain("t1");
    expect(text).toContain("completed");
    expect(text).toContain("b");
    expect(text).toContain("1@9f2c1a3b");
    expect(text).toContain("391");
  });

  it("单行折叠多行标题且不出畸形容器", () => {
    const text = renderStatusTable(snapshot());
    const t2Line = text.split("\n").find((l) => l.startsWith("t2"));
    expect(t2Line).toBeDefined();
    expect(t2Line?.includes("\n")).toBe(false);
  });

  it("空任务列表显示 (none)", () => {
    const empty = { ...snapshot(), tasks: [], members: [] };
    const text = renderStatusTable(empty);
    expect(text).toContain("Tasks: (none)");
    expect(text).toContain("Members: (none)");
  });
});

// ---------------------------------------------------------------------------
// W4：v0.2 全景渲染（DESIGN-V0.2 §7.3.1）
// ---------------------------------------------------------------------------

/** v0.2 全景快照：v0.1.0 形状 + leadKey/dag/engine + 成员 state/openTaskId（§7.3.1 v2 JSON）。 */
function panoramaSnapshot(): StatusSnapshot & PanoramaExtras {
  return {
    ...snapshot(),
    leadKey: "a",
    dag: { t2: ["t1"], t3: ["t1", "t2"] },
    engine: { wakeEnabled: true, maxMembers: 8, inboundMode: "accept" },
    members: [
      { key: "a", sessionId: "sess-a", role: "peer", lastSeen: 1762659999000 },
      { key: "m1", sessionId: "sess-m1", role: "worker", lastSeen: 1762659998000, state: "ready", identity: "engine", openTaskId: "t2" },
      { key: "m2", sessionId: "sess-m2", role: "worker", lastSeen: 1762659997000, state: "ready", identity: "engine" },
      { key: "m3", sessionId: "sess-m3", role: "worker", lastSeen: 1762659996000, state: "provisioning", identity: "engine" },
      { key: "m4", sessionId: "sess-m4", role: "worker", lastSeen: 1762659995000, state: "removed", identity: "engine" },
    ],
    tasks: [
      ...snapshot().tasks,
      {
        id: "t3",
        title: "依赖 t1/t2 的汇总任务",
        status: "pending",
        assignee: null,
        attempt: 0,
        attemptId: null,
        dependsOn: ["t1", "t2"],
        createdBy: "a",
        result: null,
        error: null,
        evidenceCount: 0,
        updatedAt: 1762660003000,
      },
    ],
  };
}

describe("render: renderPanorama v2 全景（§7.3.1）", () => {
  it("首行含 lead/founder/tasks/members 计数；engine 行渲染三配置", () => {
    const text = renderPanorama(panoramaSnapshot());
    const first = text.split("\n")[0];
    expect(first).toContain('Team "default"');
    expect(first).toContain("lead=a");
    expect(first).toContain("founder=a");
    expect(first).toContain("tasks=3");
    expect(first).toContain("members=5");
    expect(text).toContain("Engine: wake=on maxMembers=8 inbound=accept");
  });

  it("成员状态表：lead ★ 标注 + working/idle/provisioning/removed 派生 + openTaskId/未读", () => {
    const text = renderPanorama(panoramaSnapshot());
    // lead a：无 state/openTaskId 字段 → ready 语义 + 无开放任务 → idle；未读 1。
    expect(text).toContain("★a(idle,1unread)");
    expect(text).toContain("m1(working,t2)");
    expect(text).toContain("m2(idle)");
    expect(text).toContain("m3(provisioning)");
    expect(text).toContain("m4(removed)");
  });

  it("DAG 一行图：来自 dag 派生视图（上游 ─▶ 下游），排序稳定", () => {
    const text = renderPanorama(panoramaSnapshot());
    expect(text).toContain("DAG: t1 ─▶ t2  t1 ─▶ t3  t2 ─▶ t3");
  });

  it("无 dag 字段时从 tasks[].dependsOn 推导 DAG 边", () => {
    const snap = { ...panoramaSnapshot(), dag: undefined };
    const text = renderPanorama(snap);
    expect(text).toContain("DAG: t1 ─▶ t2  t1 ─▶ t3  t2 ─▶ t3");
  });

  it("无边 DAG 显示 (none)；空成员显示 (none)", () => {
    const snap = { ...panoramaSnapshot(), dag: {}, members: [], tasks: [] };
    const text = renderPanorama(snap);
    expect(text).toContain("DAG: (none)");
    expect(text).toContain("Members: (none)");
    expect(text).toContain("Tasks: (none)");
  });

  it("旧数据兼容：成员无 state 字段（v0.1.0 花名）按 ready 语义派生 working/idle（§6.5）", () => {
    const snap = { ...panoramaSnapshot(), members: [{ key: "b", sessionId: "sess-b", role: "worker", lastSeen: 1 }] };
    const text = renderPanorama(snap);
    expect(text).toContain("b(idle)");
  });
});

describe("render: renderStatusTable 双形态（v0.1.0 回归锁定 + v2 升级）", () => {
  it("v0.1.0 形状（无 leadKey/dag/engine）→ 输出与 v0.1.0 一致", () => {
    const text = renderStatusTable(snapshot());
    expect(text).toContain('Team "default" phase=open founder=a tasks=2');
    expect(text).toContain("a:1unread");
    expect(text).toContain("1@9f2c1a3b");
    expect(text).not.toContain("DAG:");
    expect(text).not.toContain("Engine:");
  });

  it("v2 全景形状（leadKey/dag/engine 在）→ 委托 renderPanorama 输出全景", () => {
    const text = renderStatusTable(panoramaSnapshot());
    expect(text).toContain("lead=a");
    expect(text).toContain("DAG: t1 ─▶ t2  t1 ─▶ t3  t2 ─▶ t3");
    expect(text).toContain("Engine: wake=on maxMembers=8 inbound=accept");
  });
});
