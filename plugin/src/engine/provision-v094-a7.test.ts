/**
 * v0.9.4（A7）：member-add 的 modelId **不静默回落**定向测试（39-v094 方案 §二 A 表）。
 *
 * 判据（方案原文）：「member-add 传的 model 在枚举里匹配不到 → 显式报错（附可用
 * modelId 列表），不再静默取第一个」；验收：传 "no-such-model" → 报错且不建员；
 * 传 "step-5-preview" → 回执正确。
 *
 * 覆盖点：显式报错 / 可用 modelId 列表在场 / provider 过滤后的列表口径 / 未传仍取
 * 枚举首个（缺省语义不减）/ env（XC_MEMBER_MODEL）同一把闸 / 空串按未传处理 /
 * ProvisionError.step=model（member_add 的失败回执 detail 形态 `${step}: ${message}`）。
 *
 * 纯函数直测（零真实 spawn、零真实会话）——provisionMember 的装配路径在
 * provision-config-error.test.ts（spawn 配置快速失败）与 member-cap-flow.test.ts
 * （member_add 编排）覆盖，本文件只锁 model 选择判据本体。
 */
import { describe, expect, it } from "vitest";
import { ProvisionError, pickModel } from "./provision.js";
import type { ModelRef } from "./appserver.js";

const MODELS: ModelRef[] = [
  { providerId: "prov-a", modelId: "step-5-preview", reasoningLevels: ["low", "high"] },
  { providerId: "prov-a", modelId: "glm-5.3-flash", reasoningLevels: [] },
  { providerId: "prov-b", modelId: "claude-x", reasoningLevels: ["max"] },
];

describe("v0.9.4 A7：pickModel 显式 model 匹配不到 → 报错并列可用 modelId（不静默取首个）", () => {
  it("【锚点】传 no-such-model → ProvisionError(step=model)，message 列可用 modelId", () => {
    let caught: unknown;
    try {
      pickModel(MODELS, { preferModel: "no-such-model" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProvisionError);
    const pe = caught as ProvisionError;
    expect(pe.step).toBe("model");
    // 请求的 model 名在场（运维对账）
    expect(pe.message).toContain("no-such-model");
    // 可用 modelId 列表逐个在场
    expect(pe.message).toContain("step-5-preview");
    expect(pe.message).toContain("glm-5.3-flash");
    expect(pe.message).toContain("claude-x");
    // 「不再静默取首个」写进 message（失败给明确指引，硬标准 2）
    expect(pe.message).toContain("不再静默取枚举首个");
    // 回执根因透传形态（member-tools 失败映射 `${step}: ${message}`）
    expect(`model: ${pe.message}`).toContain("no-such-model");
  });

  it("【锚点】传 step-5-preview（枚举内）→ 正确回执（命中项 + 档位末位兜底）", () => {
    const chosen = pickModel(MODELS, { preferModel: "step-5-preview" });
    expect(chosen).toEqual({ providerId: "prov-a", modelId: "step-5-preview", reasoningLevel: "high" });
  });

  it("未传 model（undefined/空白）→ 维持「枚举首个」缺省（功能不减）", () => {
    expect(pickModel(MODELS, {})).toEqual({ providerId: "prov-a", modelId: "step-5-preview", reasoningLevel: "high" });
    expect(pickModel(MODELS, { preferModel: "   " })).toEqual({ providerId: "prov-a", modelId: "step-5-preview", reasoningLevel: "high" });
    // 显式推理档位优先不变
    expect(pickModel(MODELS, { preferReasoning: "low" }).reasoningLevel).toBe("low");
  });

  it("env 口径（XC_MEMBER_MODEL）同一把闸：匹配不到同样报错（member-add 的两个显式来源不双轨）", () => {
    expect(() => pickModel(MODELS, { preferModel: "ghost-model" })).toThrow(ProvisionError);
    // env 值有效时照常命中（XC_MEMBER_MODEL 由 provisionMember 解析成 preferModel）
    expect(pickModel(MODELS, { preferModel: "claude-x" }).modelId).toBe("claude-x");
  });

  it("provider 过滤后的可用列表只列该 provider 的 modelId（报错指对方向）", () => {
    let caught: unknown;
    try {
      pickModel(MODELS, { preferModel: "step-5-preview", preferProvider: "prov-b" });
    } catch (error) {
      caught = error;
    }
    const pe = caught as ProvisionError;
    expect(pe).toBeInstanceOf(ProvisionError);
    expect(pe.message).toContain("prov-b"); // 过滤条件明示
    // 可用列表 = 该 provider 过滤后的池（只有 claude-x；请求名自身在场属正常）
    expect(pe.message).toContain("可用 modelId = claude-x");
    expect(pe.message).not.toContain("glm-5.3-flash"); // 别provider 的 model 不混进列表
  });

  it("provider 过滤未命中任何模型 → 回落全量池（旧口径不变），此时显式 model 在全量池里可命中", () => {
    const chosen = pickModel(MODELS, { preferModel: "claude-x", preferProvider: "no-such-provider" });
    expect(chosen.modelId).toBe("claude-x");
  });

  it("枚举为空 → 原有「未枚举到任何可用模型」报错不变（A7 不改该路径）", () => {
    let caught: unknown;
    try {
      pickModel([], { preferModel: "step-5-preview" });
    } catch (error) {
      caught = error;
    }
    const pe = caught as ProvisionError;
    expect(pe.step).toBe("model");
    expect(pe.message).toContain("未枚举到任何可用模型");
  });
});
