/**
 * v0.9.8 组 O R2：core/handoff.ts 接手包「可寻址队友」名单定向单测。
 *
 * 方案判据（49-v098方案 §二 组 R R2）：「handoff 包与 xc_overview 成员行补可寻址名
 * （队内 key / peer 名）；两面一致；可直接复制地址」。
 *
 * 本文件（handoff 包侧；overview 成员行侧见
 * mcp/peer-services-v098-o-r2-d7.test.ts 与 mcp/tools-overview-v098-o-r2-c1.test.ts，
 * 两面共用同一解析源 peerNameBySessionId——一致性由注入方保证，本模块只负责渲染）：
 * - 第 1 章身份内联「可寻址队友」行：队内 key 恒在、peer 名 absent = 仅队内可达；
 * - payload `roster` 与文本**同帽**（C2-B5：shown === payload 数组长度恒成立）；
 * - self 不出现在名单里（自己的队内键已在身份行 agent: 给出）；
 * - 基础帽 10 + 「等 N 人」披露，超帽进 truncated.cappedItems.roster；
 * - roster absent（调用方未提供）→ 不出寻址行、payload 无 roster 键（旧形状兼容）；
 * - 名单在章 1（永不被降级）——不新增降级级、不动既有降级序列。
 */
import { describe, expect, it } from "vitest";
import {
  assembleHandoff,
  HANDOFF_ROSTER_MAX,
  type HandoffInput,
  type HandoffRosterEntry,
} from "./handoff.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function baseInput(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    now: NOW,
    filter: { kind: "self" },
    identity: {
      agentKey: "alice",
      teamId: "default",
      leadKey: "lead",
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

function roster(n: number): HandoffRosterEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `m${i + 1}`,
    ...(i % 2 === 0 ? { peerName: `m${i + 1}-pc` } : {}),
    ...(i === 0 ? { isLead: true } : {}),
  }));
}

describe("v0.9.8 组 O R2：handoff 包可寻址队友名单", () => {
  it("【主判据】第 1 章列队友两种地址（队内 key 恒在 / peer 名 absent=仅队内）+ 直连接指针", () => {
    const { text, payload } = assembleHandoff(
      baseInput({
        roster: [
          { key: "lead", isLead: true, peerName: "lead-pc" },
          { key: "bob", peerName: "bob-pc" },
          { key: "carol" }, // 无活跃 peer 记录 → 仅队内
        ],
      }),
    );
    // 文本面：身份行之后紧跟寻址行（章 1 内联，永不被降级）。
    expect(text).toContain("- agent: alice | team: default | lead: lead");
    expect(text).toContain("可寻址队友: lead(lead)（队内 lead / peer lead-pc）、bob（队内 bob / peer bob-pc）、carol（队内 carol / 仅队内）");
    expect(text).toContain('队内 xc_relay({to:"<队内 key>"})');
    expect(text).toContain('跨会话 xc_relay({to:"<peer 名>"})');
    // payload：同帽同形（三键；peerName/isLead 按在场条件出现）。
    expect(payload.roster).toEqual([
      { key: "lead", peerName: "lead-pc", isLead: true },
      { key: "bob", peerName: "bob-pc" },
      { key: "carol" },
    ]);
    // 名单不是预算裁切 → 不进 cappedItems、不出 truncated。
    expect(payload.truncated).toBeUndefined();
  });

  it("self 不出现在名单里（自己的队内键已在身份行 agent: 给出）", () => {
    const { text, payload } = assembleHandoff(
      baseInput({ roster: [{ key: "alice", peerName: "alice-pc" }, { key: "bob", peerName: "bob-pc" }] }),
    );
    expect(payload.roster).toEqual([{ key: "bob", peerName: "bob-pc" }]);
    expect(text).toContain("可寻址队友: bob（队内 bob / peer bob-pc）");
    expect(text).not.toContain("alice-pc");
  });

  it("roster absent（调用方未提供）→ 不出寻址行、payload 无 roster 键（旧形状兼容）", () => {
    const { text, payload } = assembleHandoff(baseInput());
    expect(text).not.toContain("可寻址队友");
    expect("roster" in payload).toBe(false);
  });

  it(`基础帽 ${HANDOFF_ROSTER_MAX} + 「等 N 人」披露；文本与 payload 同帽（C2-B5）`, () => {
    const entries = roster(HANDOFF_ROSTER_MAX + 3);
    const { text, payload } = assembleHandoff(baseInput({ roster: entries }));
    expect(payload.roster).toHaveLength(HANDOFF_ROSTER_MAX); // payload 与文本同帽
    expect(text).toContain(`等 ${HANDOFF_ROSTER_MAX + 3} 人`);
    // 超帽留名：truncated.cappedItems.roster.shown === payload.roster.length。
    expect(payload.truncated?.cappedItems.roster).toEqual({ shown: HANDOFF_ROSTER_MAX, total: HANDOFF_ROSTER_MAX + 3 });
    expect(payload.truncated!.cappedItems.roster!.shown).toBe(payload.roster!.length);
  });

  it("名单在章 1：七章编号标题不变、不新增降级级（预算超限只动既有序列）", () => {
    const { text } = assembleHandoff(baseInput({ roster: roster(3) }));
    const headings = text.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## 1. 身份",
      "## 2. 我的任务",
      "## 3. 待领池（前 10，priority → createdAt）",
      "## 4. 未读",
      "## 5. 容量",
      "## 6. 最近检查点",
      "## 7. 建议下一步",
    ]);
  });

  it("member/task 视角同样带名单（读者不一定是该成员——寻址信息三视角同源）", () => {
    const memberView = assembleHandoff(
      baseInput({ filter: { kind: "member", id: "bob" }, roster: [{ key: "carol", peerName: "carol-pc" }] }),
    );
    expect(memberView.text).toContain("视角：member bob");
    expect(memberView.text).toContain("可寻址队友: carol（队内 carol / peer carol-pc）");
    expect(memberView.payload.roster).toEqual([{ key: "carol", peerName: "carol-pc" }]);

    const taskView = assembleHandoff(
      baseInput({ filter: { kind: "task", id: "t-1" }, roster: [{ key: "dave" }] }),
    );
    expect(taskView.text).toContain("视角：task t-1");
    expect(taskView.text).toContain("可寻址队友: dave（队内 dave / 仅队内）");
  });
});
