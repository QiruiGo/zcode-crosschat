/**
 * v0.8.0 A3（DESIGN-V0.8.md §5）：core/timeline.ts 单测——尾部窗口读 + 事件族归一化。
 * 覆盖判据（ACCEPT15-3「timeline：事件顺序正确、limit/预算生效、截断披露」）：
 * - 家族映射表逐行（九族 + other；高频噪声事件归 other）；
 * - actor 取值序（agentKey ?? by ?? createdBy ?? assignee ?? to ?? null）；
 * - summary 族级模板确定性 + 缺字段退化到事件名（永不为空串）；
 * - newest-first 顺序 + offset 自最新往回跳过；
 * - limit 缺省 20 / 钳 100 + limitClamped 披露；
 * - 坏行跳过；尾部窗口丢半行 + olderEventsOmitted 披露；
 * - 预算开窗超限 → truncated + 续读指针；
 * - ENOENT → 空结果。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeTimelineEvent,
  readTimeline,
  TAIL_READ_MAX_BYTES,
  TIMELINE_FAMILY_BY_EVENT,
  TIMELINE_MAX_LIMIT,
  timelineFamilyOf,
} from "./timeline.js";

let workDir: string;
let file: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-timeline-"));
  file = join(workDir, "engine.jsonl");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function line(rec: Record<string, unknown>): string {
  return JSON.stringify({ ts: 1, ...rec });
}

async function writeLines(lines: readonly string[]): Promise<void> {
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// 事件族映射表（照抄 DESIGN §5 冻结表逐行）
// ---------------------------------------------------------------------------

describe("timeline: 事件族映射表逐行", () => {
  it("表内事件逐行命中；表外（含高频噪声）归 other", () => {
    const expected: Record<string, string> = {
      "dispatch": "dispatch", "dispatch-refused": "dispatch",
      "claim": "claim",
      "report": "report",
      "task-swept": "sweep", "revoked-stale": "sweep",
      "task-offline": "offline",
      "tool-approval-request": "approval", "tool-approval": "approval", "tool-expired": "approval",
      "tool-request": "tool", "tool-executed": "tool", "tool-result-rejected": "tool",
      "lead-set": "lead", "lead-transfer": "lead", "lead-release": "lead",
      "member-added": "member", "member-add-started": "member", "member-add-failed": "member",
      "member-stopped": "member", "member-archive-written": "member", "member-archive-failed": "member",
      "member-provision-timeout": "member", "member-takeover": "member",
    };
    for (const [event, family] of Object.entries(expected)) {
      expect(timelineFamilyOf(event), event).toBe(family);
      expect(TIMELINE_FAMILY_BY_EVENT[event], event).toBe(family);
    }
    // 高频噪声事件 → other（§5 明示）
    for (const noise of ["status", "inject-budget", "inbox-check", "wake", "register", "message"]) {
      expect(timelineFamilyOf(noise), noise).toBe("other");
    }
  });

  it("normalizeTimelineEvent：形状不符（非对象/缺 event/ts 非数）→ undefined", () => {
    expect(normalizeTimelineEvent(null)).toBeUndefined();
    expect(normalizeTimelineEvent("str")).toBeUndefined();
    expect(normalizeTimelineEvent({ event: "claim" })).toBeUndefined();
    expect(normalizeTimelineEvent({ ts: 1 })).toBeUndefined();
    expect(normalizeTimelineEvent({ ts: "1", event: "claim" })).toBeUndefined();
    expect(normalizeTimelineEvent({ ts: 1, event: "claim" })?.family).toBe("claim");
  });
});

// ---------------------------------------------------------------------------
// actor / summary 归一化
// ---------------------------------------------------------------------------

describe("timeline: actor 取值序与 summary 模板", () => {
  it("actor：agentKey > by > createdBy > assignee > to > null", () => {
    const all = normalizeTimelineEvent({
      ts: 1, event: "x", agentKey: "a", by: "b", createdBy: "c", assignee: "d", to: "e",
    });
    expect(all?.actor).toBe("a");
    expect(normalizeTimelineEvent({ ts: 1, event: "x", by: "b", createdBy: "c", assignee: "d", to: "e" })?.actor).toBe("b");
    expect(normalizeTimelineEvent({ ts: 1, event: "x", createdBy: "c", assignee: "d", to: "e" })?.actor).toBe("c");
    expect(normalizeTimelineEvent({ ts: 1, event: "x", assignee: "d", to: "e" })?.actor).toBe("d");
    expect(normalizeTimelineEvent({ ts: 1, event: "x", to: "e" })?.actor).toBe("e");
    expect(normalizeTimelineEvent({ ts: 1, event: "x" })?.actor).toBeNull();
  });

  it("summary：族级模板；缺字段退化到事件名；永不为空串", () => {
    const s = (rec: Record<string, unknown>): string => normalizeTimelineEvent({ ts: 1, ...rec })!.summary;
    expect(s({ event: "dispatch", to: "bob", createdBy: "alice" })).toBe("dispatch → bob by alice");
    expect(s({ event: "dispatch-refused", assignee: "bob", by: "alice" })).toBe("dispatch → bob by alice");
    expect(s({ event: "dispatch" })).toBe("dispatch"); // 缺字段 → 事件名
    expect(s({ event: "claim", assignee: "bob", attempt: 2 })).toBe("claim by bob (attempt 2)");
    expect(s({ event: "claim", agentKey: "bob" })).toBe("claim by bob");
    expect(s({ event: "claim" })).toBe("claim");
    expect(s({ event: "report", status: "completed", agentKey: "bob" })).toBe("report completed by bob");
    expect(s({ event: "report" })).toBe("report");
    expect(s({ event: "task-swept", taskId: "t-1" })).toBe("task-swept t-1");
    expect(s({ event: "task-offline" })).toBe("task-offline");
    expect(s({ event: "lead-transfer", to: "carol" })).toBe("lead → carol");
    expect(s({ event: "lead-release" })).toBe("lead released");
    expect(s({ event: "member-stopped", agentKey: "bob" })).toBe("member stopped bob");
    expect(s({ event: "member-added", agentKey: "bob" })).toBe("member-added bob");
    expect(s({ event: "status" })).toBe("status"); // other 族 → 事件名
    for (const rec of [{ event: "x" }, { event: "dispatch", to: "bob" }]) {
      expect(s(rec).length).toBeGreaterThan(0);
    }
  });

  it("taskId：在场取之，缺省 null", () => {
    expect(normalizeTimelineEvent({ ts: 1, event: "claim", taskId: "t-1" })?.taskId).toBe("t-1");
    expect(normalizeTimelineEvent({ ts: 1, event: "claim" })?.taskId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 读取：顺序 / 分页 / 预算 / 窗口
// ---------------------------------------------------------------------------

describe("timeline: 尾部窗口读与分页", () => {
  it("newest-first；offset 自最新往回跳过；limit 缺省 20", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => line({ ts: 1000 + i, event: "claim", assignee: `a${i}` }));
    await writeLines(lines);
    const first = await readTimeline(file, { budgetChars: 1_000_000 });
    expect(first.total).toBe(25);
    expect(first.limit).toBe(20); // 缺省 20
    expect(first.events).toHaveLength(20);
    expect(first.events[0]!.ts).toBe(1024); // 最新在前
    expect(first.events[0]!.summary).toBe("claim by a24");
    const next = await readTimeline(file, { budgetChars: 1_000_000, offset: 20 });
    expect(next.events).toHaveLength(5);
    expect(next.events[0]!.ts).toBe(1004);
    expect(next.truncated).toBeUndefined();
  });

  it("limit > 100 钳到 100 并披露 limitClamped", async () => {
    const lines = Array.from({ length: 130 }, (_, i) => line({ ts: 1000 + i, event: "claim" }));
    await writeLines(lines);
    const r = await readTimeline(file, { budgetChars: 10_000_000, limit: 500 });
    expect(r.limitClamped).toEqual({ requested: 500, applied: TIMELINE_MAX_LIMIT });
    expect(r.events).toHaveLength(100);
  });

  it("坏行跳过（不可解析 JSON 不进 events、不抛）", async () => {
    await writeFile(
      file,
      `${line({ ts: 1, event: "claim" })}\n{not json\n${line({ ts: 2, event: "report", status: "completed", agentKey: "b" })}\n`,
      "utf8",
    );
    const r = await readTimeline(file, { budgetChars: 1_000_000 });
    expect(r.total).toBe(2);
    expect(r.events.map((e) => e.event)).toEqual(["report", "claim"]);
  });

  it("预算开窗超限 → truncated + 续读指针（offset=shown+offset）", async () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      line({ ts: 1000 + i, event: "dispatch", to: "bob", createdBy: "alice", taskId: `t-${i}`, summaryPad: "x".repeat(80) }),
    );
    await writeLines(lines);
    const r = await readTimeline(file, { budgetChars: 600, limit: 30 });
    expect(r.events.length).toBeLessThan(30);
    expect(r.truncated).toBeDefined();
    expect(r.truncated!.shown).toBe(r.events.length); // offset=0
    expect(r.truncated!.total).toBe(30);
    expect(r.truncated!.offset).toBe(0);
    // 续读指针：offset = shown + offset
    const page2 = await readTimeline(file, { budgetChars: 600, limit: 30, offset: r.truncated!.shown });
    expect(page2.events[0]!.ts).toBe(1029 - r.truncated!.shown);
    expect(page2.truncated!.shown).toBe(r.truncated!.shown + page2.events.length);
  });

  it("ENOENT → 空结果（total 0，不抛）", async () => {
    const r = await readTimeline(join(workDir, "missing.jsonl"), { budgetChars: 1000 });
    expect(r.total).toBe(0);
    expect(r.events).toEqual([]);
  });

  it("尾部窗口：>256KiB 只读末段、丢窗口首行（行边界对齐时可观测）", async () => {
    // 定长行（1024 字节含 \n）：窗口起点 = size-256KiB 恰好落在行边界 →
    // 窗口内含 256 行，首行按 DESIGN §5 被丢弃 → 255 条（可观测的「丢半行」纪律）。
    const n = 300;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const rec = JSON.stringify({ ts: 1000 + i, event: "claim", assignee: `a${i}` });
      lines.push(rec + " ".repeat(1023 - rec.length)); // 1023 + '\n' = 1024
    }
    await writeLines(lines);
    const r = await readTimeline(file, { budgetChars: 10_000_000, limit: 100 });
    expect(r.tailWindowBytes).toBe(n * 1024);
    expect(r.tailWindowBytes).toBeGreaterThan(TAIL_READ_MAX_BYTES);
    expect(r.total).toBe(256 - 1); // 窗口 256 行 - 丢弃的首行
    expect(r.events[0]!.ts).toBe(1299); // 最新仍在场
    // 窗口事件数(255) ≥ limit+offset → 不披露 olderEventsOmitted
    expect(r.olderEventsOmitted).toBeUndefined();
  });

  it("尾部窗口不足（窗口内事件 < limit+offset）→ 披露 olderEventsOmitted，最新事件仍在场", async () => {
    // 20KB 大行：256KiB 窗口只装得下十余条 → total < 20（缺省 limit）。
    const pad = line({ ts: 1, event: "status", pad: "x".repeat(20_000) });
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(pad); // ~410KB > 256KiB
    const tail = [
      line({ ts: 9001, event: "claim", assignee: "tail-1" }),
      line({ ts: 9002, event: "report", status: "completed", agentKey: "tail-2" }),
      line({ ts: 9003, event: "member-stopped", agentKey: "tail-3" }),
    ];
    await writeLines([...lines, ...tail]);
    const r = await readTimeline(file, { budgetChars: 10_000_000 });
    expect(r.tailWindowBytes).toBeGreaterThan(TAIL_READ_MAX_BYTES);
    expect(r.total).toBeGreaterThan(0);
    expect(r.total).toBeLessThan(20);
    expect(r.events.slice(0, 3).map((e) => e.ts)).toEqual([9003, 9002, 9001]); // 尾部三条最新在场
    expect(r.olderEventsOmitted).toBe(true);
  });

  it("整文件读（<256KiB）不丢行、不披露窗口字段", async () => {
    await writeLines([line({ ts: 1, event: "claim" }), line({ ts: 2, event: "claim" })]);
    const r = await readTimeline(file, { budgetChars: 1_000_000 });
    expect(r.total).toBe(2);
    expect(r.tailWindowBytes).toBeUndefined();
    expect(r.olderEventsOmitted).toBeUndefined();
  });
});
