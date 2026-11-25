/**
 * v0.10.0 组 D（G-25）定向单测——core/handoff.ts 花名册的 duty（职能声明）透传。
 *
 * 锁死契约：
 * 1. roster 条目带 duty ⇒ 第 1 章「可寻址队友」行出现「职能：<duty>；」前缀，
 *    payload.roster 同项带 duty（文本/payload 同源）；
 * 2. duty absent（未声明/旧调用方）⇒ 文本行形状与 v0.9.8 逐字一致（不出「职能」片段），
 *    payload 不出 duty 键——零回归；
 * 3. 文本面折叠控制字符（防御纵深：外部手改 team.json 的可能）。
 */
import { describe, expect, it } from "vitest";
import { assembleHandoff, type HandoffInput } from "./handoff.js";

const NOW = 1_800_000_000_000;

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
    checkpoint: { path: "/ws/.crosschat/checkpoints/alice/x.md", createdAt: NOW, ageMin: 0, bytes: 1 },
    stalled: [],
    myOpenTaskId: null,
    ...overrides,
  };
}

describe("v0.10.0 组 D / G-25：handoff 花名册职能声明", () => {
  it("带 duty：文本行出「职能：…；」前缀 + payload 同项带 duty", () => {
    const { text, payload } = assembleHandoff(
      baseInput({
        roster: [
          { key: "bob", isLead: true, peerName: "bob-peer", duty: "负责容量闸值守" },
          { key: "carol", duty: "回归测试" },
        ],
      }),
    );
    expect(text).toContain("bob(lead)（职能：负责容量闸值守；队内 bob / peer bob-peer）");
    expect(text).toContain("carol（职能：回归测试；队内 carol / 仅队内）");
    expect(payload.roster).toEqual([
      { key: "bob", peerName: "bob-peer", isLead: true, duty: "负责容量闸值守" },
      { key: "carol", duty: "回归测试" },
    ]);
  });

  it("duty absent：文本形状与 v0.9.8 逐字一致，payload 不出 duty 键", () => {
    const { text, payload } = assembleHandoff(
      baseInput({ roster: [{ key: "bob", isLead: true, peerName: "bob-peer" }] }),
    );
    expect(text).toContain("bob(lead)（队内 bob / peer bob-peer）");
    expect(text).not.toContain("职能：");
    expect(payload.roster).toEqual([{ key: "bob", peerName: "bob-peer", isLead: true }]);
  });

  it("空串/纯空白 duty 按未声明处理（不出片段、不出键）", () => {
    const { text, payload } = assembleHandoff(baseInput({ roster: [{ key: "bob", duty: "   " }] }));
    expect(text).not.toContain("职能：");
    expect(payload.roster).toEqual([{ key: "bob" }]);
  });

  it("文本面折叠控制字符（payload 保留入库原值）", () => {
    const { text, payload } = assembleHandoff(
      baseInput({ roster: [{ key: "bob", duty: "看\u0000闸\u001f" }] }),
    );
    expect(text).toContain("职能：看 闸；");
    expect(payload.roster?.[0]?.duty).toBe("看\u0000闸\u001f");
  });

  it("未提供 roster（旧调用方）⇒ 不出寻址行、payload 无 roster 键", () => {
    const { text, payload } = assembleHandoff(baseInput());
    expect(text).not.toContain("可寻址队友");
    expect(payload.roster).toBeUndefined();
  });
});
