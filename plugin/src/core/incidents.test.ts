/**
 * v0.9.2 组A（A3）定向单测——core/incidents.ts：回合开始事故摘要的**计数真源**。
 *
 * 锚点（任务书原文「事故摘要计数正确且零注入回归」的计数侧）：
 * - 窗口 = [上一回合 lastTurnTs, 本回合]，`ts <= since` 不计（左开右闭）；
 * - 成员死亡按 member-dead 事件**去重成员键**；limbo 降级按 message-limbo 条数；
 *   唤醒失败按 wake-failed + wake-retry-failed 条数（容量闸 deferral 不计失败）；
 * - 尾部有界读取（256 KiB）：超限只取尾段，被截断的首行丢弃，坏行跳过，不虚报不漏报；
 * - 缺文件/读失败 → 零计数（钩子永不因观测面失败）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  countIncidents,
  emptyIncidentCounts,
  INCIDENT_TAIL_BYTES_DEFAULT,
  parseIncidentLines,
  readIncidentsSince,
  renderIncidentSummary,
  type IncidentEventLine,
} from "./incidents";
import { logEngineEvent } from "./log";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-incidents-v092-"));
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

function line(ts: number, event: string, extra: Record<string, unknown> = {}): IncidentEventLine {
  return { ts, event, ...extra };
}

describe("v0.9.2 A3：事故计数（纯函数）", () => {
  it("三类事故分别计数；total = 三者之和", () => {
    const counts = countIncidents([
      line(100, "member-dead", { member: "b" }),
      line(101, "member-dead", { member: "c" }),
      line(102, "message-limbo", { messageId: "m1" }),
      line(103, "message-limbo", { messageId: "m2" }),
      line(104, "wake-failed", { to: "b" }),
      line(105, "wake-retry-failed", { to: "b" }),
    ], 50);
    expect(counts.memberDead).toBe(2);
    expect(counts.limboDowngraded).toBe(2);
    expect(counts.wakeFailed).toBe(2);
    expect(counts.total).toBe(6);
    expect(counts.deadMembers).toEqual(["b", "c"]);
  });

  it("窗口左开右闭：ts <= since 不计（「自上次回合」不含上一回合自身的事件）", () => {
    const counts = countIncidents([
      line(100, "member-dead", { member: "b" }), // ts == since → 不计
      line(101, "message-limbo", { messageId: "m1" }), // ts > since → 计
    ], 100);
    expect(counts.memberDead).toBe(0);
    expect(counts.limboDowngraded).toBe(1);
    expect(counts.total).toBe(1);
  });

  it("成员死亡按成员键去重（防审计账被外部追加重复行时虚报）", () => {
    const counts = countIncidents([
      line(100, "member-dead", { member: "b" }),
      line(101, "member-dead", { member: "b" }),
      line(102, "member-dead", { to: "c" }), // member 缺省回退 to
    ], 50);
    expect(counts.memberDead).toBe(2);
    expect(counts.deadMembers).toEqual(["b", "c"]);
  });

  it("无关事件不计入（wake-slow / wake-deferred / capacity 等不是「唤醒失败」）", () => {
    const counts = countIncidents([
      line(100, "wake-slow", { to: "b" }),
      line(101, "wake-deferred", { to: "b" }),
      line(102, "wake-orphan-nonce", { to: "b" }),
      line(103, "task-offline", { member: "b" }),
      line(104, "hook-prompt-submit-unread", { name: "b" }),
    ], 50);
    expect(counts.total).toBe(0);
    expect(emptyIncidentCounts(50).total).toBe(0);
  });

  it("坏行/半行/非对象行跳过（观测面永不为难）", () => {
    const parsed = parseIncidentLines(
      ['{"ts":1,"event":"member-dead","member":"b"}', 'not json', '{"ts":2}', '[1,2,3]', '', '{"ts":"x","event":"y"}'].join("\n"),
    );
    expect(parsed).toEqual([{ ts: 1, event: "member-dead", member: "b" }]);
  });

  it("文案：三类计数 + 窗口起点 ISO + 点名死亡成员 + 平台边界（不声称能拦截）", () => {
    const counts = countIncidents([
      line(1_700_000_000_000, "member-dead", { member: "b" }),
      line(1_700_000_000_001, "message-limbo", { messageId: "m1" }),
      line(1_700_000_000_002, "wake-failed", { to: "c" }),
    ], 1_700_000_000_000 - 7 * 60_000);
    const text = renderIncidentSummary(counts, 1_700_000_000_000);
    expect(text).toContain("1 个成员死亡（b）");
    expect(text).toContain("1 条 limbo 降级");
    expect(text).toContain("1 次唤醒失败");
    expect(text).toContain(new Date(1_700_000_000_000 - 7 * 60_000).toISOString());
    expect(text).toContain("约 7 分钟前");
    expect(text).toContain("不能否决或拦截任何工具调用");
    expect(text).toContain("最后保险");
    expect(text).not.toContain("已拦截");
  });
});

describe("v0.9.2 A3：事故计数（engine.jsonl 只读投影）", () => {
  it("真实审计账：窗口内计数正确、窗口外为零", async () => {
    const t = Date.now();
    await logEngineEvent(root, { event: "member-dead", teamId: "default", member: "b", evidence: "process-dead" });
    await logEngineEvent(root, { event: "message-limbo", teamId: "default", to: "b", messageId: "m1" });
    await logEngineEvent(root, { event: "wake-failed", teamId: "default", to: "b", where: "spawn" });
    await logEngineEvent(root, { event: "hook-prompt-submit-unread", sessionId: "s", name: "b", unread: 1 });

    const counts = await readIncidentsSince(root, t - 1_000);
    expect(counts.memberDead).toBe(1);
    expect(counts.limboDowngraded).toBe(1);
    expect(counts.wakeFailed).toBe(1);
    expect(counts.total).toBe(3);

    // 窗口推到所有事件之后 → 零事故（零注入的收口条件）
    const after = await readIncidentsSince(root, Date.now() + 1_000);
    expect(after.total).toBe(0);
  });

  it("缺审计文件 → 零计数（钩子永不失败）", async () => {
    const counts = await readIncidentsSince(root, Date.now() - 60_000);
    expect(counts.total).toBe(0);
    expect(counts.deadMembers).toEqual([]);
  });

  it("尾部有界读取：超大审计账也只读尾段，窗口内事故一个不漏", async () => {
    const t = Date.now();
    // 造远超 256 KiB 的噪音行（真实形态：长期运行的 engine.jsonl）
    const noise = `${JSON.stringify({ ts: 1, event: "noise", pad: "x".repeat(400) })}\n`.repeat(2000);
    const { appendFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(join(root, "logs", "engine.jsonl"), noise);
    await logEngineEvent(root, { event: "member-dead", teamId: "default", member: "z", evidence: "process-dead" });
    await logEngineEvent(root, { event: "wake-retry-failed", teamId: "default", to: "z", where: "retry-spawn" });

    const counts = await readIncidentsSince(root, t - 1_000);
    expect(counts.memberDead).toBe(1);
    expect(counts.wakeFailed).toBe(1);
    // 上限本身是常量（钩子 10s 生存期内的读取预算）
    expect(INCIDENT_TAIL_BYTES_DEFAULT).toBe(262_144);
  });
});
