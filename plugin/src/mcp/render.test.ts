/** M3 render 单测：人可读一行摘要与任务板（不触盘的纯函数部分）。 */
import { describe, expect, it } from "vitest";
import {
  renderClaim,
  renderDispatch,
  renderInbox,
  renderMessage,
  renderRegister,
  renderReport,
  renderStatusTable,
  shortId,
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
