/**
 * v0.9.6（R2）定向测试：**member_reasoning 缺省档位的首试兼容**（44-v096 方案 §一 组 R R2）。
 *
 * 缺陷形态（41-v095 real-smoke A）：userConfig `member_reasoning` 缺省 "max"，
 * new-provider/step-5-preview 不支持 → member-add 首试 setModel 失败（自动重试 high 成功，
 * 但失败尝试留下的孤儿唤醒票正是 R1 的压制源）。
 *
 * 修法的可测面（纯函数层）：
 * - pickModel 预检：模型声明档位表不含所配档位 → 首试前按 high → medium → 省略 有界
 *   降级（验收：step-5-preview + 缺省配置一次 member-add 成功，无首试失败）；
 * - 显式非法档位（不是合法档位名）→ 显式报错，不静默降级（LIMITATIONS 第 25 条）；
 * - 未配置（缺省 ""）→ 模型声明档位表末位（最高声明档）——首试即成功；
 * - 正常供给不降级（所配档位被声明 → 原样生效，reasoningFallback 不出现）。
 *
 * 边界（如实声明）：provisionMember 的 setModel 失败重试链（模型未声明档位表时的兜底）
 * 依赖真实 app-server 握手（v0.9.5 A6 复核先例：假 CLI 无法过握手），本轮以代码级审读
 * + 纯函数测试覆盖，live 路径由 v0.9.6 端到端验收（缺省配置 member-add 首试成功）承担。
 */
import { describe, expect, it } from "vitest";
import {
  KNOWN_REASONING_TIERS,
  pickModel,
  ProvisionError,
  REASONING_FALLBACK_ORDER,
  REASONING_OMITTED_LABEL,
  resolveReasoningFallbackTarget,
} from "./provision.js";
import type { ModelRef } from "./appserver.js";

/** 41-v095 实测形态：new-provider/step-5-preview 只声明 low/high（"max" 不支持）。 */
const STEP5_LIKE: readonly ModelRef[] = [
  { providerId: "new-provider", modelId: "step-5-preview", reasoningLevels: ["low", "high"] },
];

describe("v0.9.6 R2：pickModel 档位预检（缺省配置首试成功）", () => {
  it("【验收锚点】step-5-preview + 所配 \"max\"（旧缺省）→ 首试前降级为 high + reasoningFallback{from:max,to:high}", () => {
    const chosen = pickModel(STEP5_LIKE, { preferReasoning: "max" });
    expect(chosen.providerId).toBe("new-provider");
    expect(chosen.modelId).toBe("step-5-preview");
    expect(chosen.reasoningLevel).toBe("high"); // 不再是 max——首试即生效档位
    expect(chosen.reasoningFallback).toEqual({ from: "max", to: "high" });
  });

  it("缺省留空（v0.9.6 plugin.json 新缺省）→ 模型声明档位表末位（最高声明档），无降级记录", () => {
    const chosen = pickModel(STEP5_LIKE, {});
    expect(chosen.reasoningLevel).toBe("high"); // 表末位
    expect(chosen.reasoningFallback).toBeUndefined();
  });

  it("【硬回归·正常供给不降级】所配档位被模型声明 → 原样生效（reasoningFallback 不出现）", () => {
    const chosen = pickModel(STEP5_LIKE, { preferReasoning: "high" });
    expect(chosen.reasoningLevel).toBe("high");
    expect(chosen.reasoningFallback).toBeUndefined();
    const low = pickModel(STEP5_LIKE, { preferReasoning: "low" });
    expect(low.reasoningLevel).toBe("low");
    expect(low.reasoningFallback).toBeUndefined();
  });

  it("【验收锚点】显式非法档位（banana）→ ProvisionError 显式报错，不静默降级", () => {
    expect(() => pickModel(STEP5_LIKE, { preferReasoning: "banana" })).toThrow(ProvisionError);
    try {
      pickModel(STEP5_LIKE, { preferReasoning: "banana" });
      expect.unreachable("must throw");
    } catch (err) {
      expect((err as ProvisionError).step).toBe("model");
      expect((err as ProvisionError).message).toContain("banana");
      expect((err as ProvisionError).message).toContain("不静默降级");
    }
  });

  it("模型未声明档位表（levels=[]）→ 无预判据不猜：所配档位原样返回（由 setModel 重试链兜底）", () => {
    const models: readonly ModelRef[] = [{ providerId: "p", modelId: "glm-x", reasoningLevels: [] }];
    const chosen = pickModel(models, { preferReasoning: "max" });
    expect(chosen.reasoningLevel).toBe("max");
    expect(chosen.reasoningFallback).toBeUndefined();
  });

  it("声明表不含 high/medium → 降级到省略（\"\"，模型默认=最高声明档）", () => {
    const models: readonly ModelRef[] = [{ providerId: "p", modelId: "m", reasoningLevels: ["minimal", "low"] }];
    const chosen = pickModel(models, { preferReasoning: "max" });
    expect(chosen.reasoningLevel).toBe("");
    expect(chosen.reasoningFallback).toEqual({ from: "max", to: REASONING_OMITTED_LABEL });
  });

  it("模型声明含 max（claude-x 形态，v0.9.4 a7 fixture）→ max 原样生效，不降级", () => {
    const models: readonly ModelRef[] = [
      { providerId: "prov-b", modelId: "claude-x", reasoningLevels: ["max"] },
    ];
    const chosen = pickModel(models, { preferReasoning: "max" });
    expect(chosen.reasoningLevel).toBe("max");
    expect(chosen.reasoningFallback).toBeUndefined();
  });
});

describe("v0.9.6 R2：有界降级顺序与档位词表（钉死面）", () => {
  it("降级顺序钉死 high → medium → 省略（LIMITATIONS 第 25 条口径；不做 env 化）", () => {
    expect(REASONING_FALLBACK_ORDER).toEqual(["high", "medium", ""]);
  });

  it("可辨认档位词表 = CLI 档位族 + 现行缺省别名 max（zcode CLI \"minimal\",\"low\",\"medium\",\"high\",\"xhigh\"）", () => {
    expect(KNOWN_REASONING_TIERS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("resolveReasoningFallbackTarget：按声明表取第一个命中；全不命中 → 省略；空表 → undefined（不猜）", () => {
    expect(resolveReasoningFallbackTarget(["low", "high"])).toBe("high");
    expect(resolveReasoningFallbackTarget(["medium", "xhigh"])).toBe("medium");
    expect(resolveReasoningFallbackTarget(["minimal", "low"])).toBe("");
    expect(resolveReasoningFallbackTarget([])).toBeUndefined();
  });
});
