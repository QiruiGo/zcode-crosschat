/**
 * v0.10.0 组 D（G-25）定向单测——core/types.ts 的 duty（会话职能声明）字段。
 *
 * 锁死契约：
 * 1. sanitizeDuty：控制字符清成空格 + trim；超 120 字符截断加 …；非串/清洗后空串
 *    → undefined（「没说」与「说空了」同一态）；
 * 2. coerceMember/coerceTeamState 宽容增量（§11.1）：duty 非空串才收；非法值
 *    （数字/空串/纯空白）整字段丢弃，**绝不整文件拒绝**；
 * 3. 旧 team.json（无 duty 字段）照常解析——一切行为不变。
 */
import { describe, expect, it } from "vitest";
import {
  DUTY_MAX_CHARS,
  coerceTeamState,
  sanitizeDuty,
  type TeamMember,
} from "./types.js";

function memberRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "a",
    sessionId: "sess-a",
    role: "peer",
    joinedAt: 1,
    lastSeen: 2,
    ...overrides,
  };
}

function teamWith(members: unknown[]): unknown {
  return {
    teamId: "default",
    name: "default",
    founderKey: "a",
    phase: "open",
    members,
    tasks: [],
    seq: 0,
    createdAt: 1,
  };
}

describe("v0.10.0 组 D / G-25：sanitizeDuty（写入侧唯一清洗入口）", () => {
  it("正常一句话原样收", () => {
    expect(sanitizeDuty("负责 site-a 发布监控的值守")).toBe("负责 site-a 发布监控的值守");
  });

  it("控制字符清成空格 + trim（\\u0000/\\u001f/\\u007f 同族）", () => {
    expect(sanitizeDuty("a\u0000b\u001fc\u007fd")).toBe("a b c d");
    expect(sanitizeDuty("  \t 前后空白 \n ")).toBe("前后空白");
  });

  it("超长按 120 字符截断加 …（不多不少）", () => {
    const long = "x".repeat(500);
    const out = sanitizeDuty(long)!;
    expect(out).toHaveLength(DUTY_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe(`${"x".repeat(DUTY_MAX_CHARS - 1)}…`);
  });

  it("恰好 120 字符不截断（不加省略号）", () => {
    const exact = "y".repeat(DUTY_MAX_CHARS);
    expect(sanitizeDuty(exact)).toBe(exact);
  });

  it("非字符串 / 空串 / 纯空白 → undefined（absent，不落空字段）", () => {
    expect(sanitizeDuty(undefined)).toBeUndefined();
    expect(sanitizeDuty(42)).toBeUndefined();
    expect(sanitizeDuty({})).toBeUndefined();
    expect(sanitizeDuty("")).toBeUndefined();
    expect(sanitizeDuty("   \t\n ")).toBeUndefined();
  });
});

describe("v0.10.0 组 D / G-25：coerceTeamState 的 duty 宽容读取", () => {
  it("非空串 duty 收进成员行", () => {
    const parsed = coerceTeamState(teamWith([memberRecord({ duty: "看容量闸" })]), "default");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.state.members[0]!.duty).toBe("看容量闸");
  });

  it("非法 duty（数字/空串/纯空白/对象）整字段丢弃，不拒整文件", () => {
    for (const bad of [42, "", "   ", { a: 1 }, null, ["x"]]) {
      const parsed = coerceTeamState(teamWith([memberRecord({ duty: bad })]), "default");
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect((parsed.state.members[0] as TeamMember).duty).toBeUndefined();
    }
  });

  it("旧 team.json（无 duty 字段）照常解析，其余字段不丢", () => {
    const parsed = coerceTeamState(teamWith([memberRecord()]), "default");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const m = parsed.state.members[0]!;
    expect(m.duty).toBeUndefined();
    expect(m.key).toBe("a");
    expect(m.sessionId).toBe("sess-a");
  });

  it("多成员：有声明与无声明共存，互不影响", () => {
    const parsed = coerceTeamState(
      teamWith([memberRecord({ key: "a", duty: "主控" }), memberRecord({ key: "b" })]),
      "default",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.state.members.map((m) => m.duty)).toEqual(["主控", undefined]);
  });
});
