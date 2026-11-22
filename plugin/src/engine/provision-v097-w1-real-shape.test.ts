/**
 * v0.9.7（W1/R2）定向测试：**app-server 模型枚举的真实形状解析**（47-v097 方案 §一 组 W W1）。
 *
 * 缺陷形态（41-v095 real-smoke C §2(2)，抓取件
 * `evidence/42-v096/real-smoke/appserver-models-probe.json`）：app-server 的
 * `settings.model.available[]` 实测形状是
 * ```json
 * { "ref": { "providerId": "new-provider", "modelId": "step-5-preview" },
 *   "reasoning": { "levels": [ {"value":"low"}, {"value":"medium"}, {"value":"high"} ],
 *                  "defaultLevel": "high" } }
 * ```
 * 旧 `collectModelRefs` 只认**顶层** providerId/modelId 且只收字符串档位 → 真实形状下
 * `reasoningLevels` 恒空 → pickModel 缺省路径落 `"max"` → 只声明 low/medium/high 的
 * step-5-preview 首试 setModel 即失败（R2「首试成功」未达成）。
 *
 * 本文件覆盖（可测面 = 纯函数/keeper 吸收层）：
 * 1. 真实形状 → providerId/modelId 从 `ref.*` 取、档位表从 `reasoning.levels[].value`
 *    取、缺省档从 `reasoning.defaultLevel` 取（**档位表不再恒空**）；
 * 2. 缺省配置（未配 member_reasoning）→ 首试档位 = defaultLevel（step-5-preview 实测
 *    defaultLevel="high"，与其档位表末位一致）——0 次失败重试的那个档位；
 * 3. 所配 "max"（旧缺省）→ **预检降级** high + reasoningFallback{from:"max",to:"high"}
 *    （provision.ts 据此在首试前落 `member-reasoning-fallback via:"pre-check"` 审计）；
 * 4. 旧扁平形状（顶层 providerId/modelId + 字符串档位）兼容——v0.9.6 及以前的替身/老数据；
 * 5. 重复枚举项只补空（create 结果带完整 reasoning、state.updated 兜底只带 ref）。
 *
 * 边界（如实声明）：`provisionMember` 的 setModel 首试/审计落盘依赖真实 app-server 握手
 * （假 CLI 过不了握手，v0.9.5 A6 复核先例），本文件止于 pickModel 的档位判定层；live 路径
 * 由 v0.9.7 端到端验收（缺省配置 member-add 首试成功、audit via:"pre-check"）承担。
 */
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { AppServerKeeper } from "./appserver.js";
import { pickModel } from "./provision.js";
import type { ModelRef } from "./appserver.js";

/** 假 ChildProcess：keeper 只用 stdout/stderr/on/stdin/kill，全部 no-op。 */
function fakeChild(): ChildProcess {
  return {
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
    on: () => undefined,
    stdin: { write: () => true, destroyed: false },
    kill: () => true,
  } as unknown as ChildProcess;
}

function keeper(): AppServerKeeper {
  return AppServerKeeper.start({
    cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
    // spawnImpl 的形状是 node:child_process.spawn；假 child 只实现 keeper 用到的面。
    spawnImpl: (() => fakeChild()) as unknown as typeof import("node:child_process").spawn,
  });
}

/** 41-v095 实测形状（appserver-models-probe.json 摘录，逐字段同形）。 */
const REAL_CREATE_RESULT = {
  settings: {
    model: {
      available: [
        {
          ref: { providerId: "new-provider", modelId: "step-5-preview" },
          label: "step-5-preview",
          providerLabel: "阶跃星辰",
          contextWindow: 1000000,
          maxOutputTokens: 128000,
          reasoning: {
            levels: [
              { value: "low", label: "low" },
              { value: "medium", label: "medium" },
              { value: "high", label: "high" },
            ],
            defaultLevel: "high",
          },
        },
      ],
    },
  },
};

describe("v0.9.7 W1：真实形状 available[] 解析（档位表不再恒空）", () => {
  it("【W1 锚点】真实形状 → ref.* 定位 + levels[].value 档位 + defaultLevel 缺省档", () => {
    const k = keeper();
    k.absorbModels(REAL_CREATE_RESULT);
    expect(k.getModels()).toEqual([
      {
        providerId: "new-provider",
        modelId: "step-5-preview",
        reasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "high",
      },
    ]);
  });

  it("【W1 锚点】缺省配置（未配 member_reasoning）→ 首试档位 = defaultLevel（high），无降级记录", () => {
    const k = keeper();
    k.absorbModels(REAL_CREATE_RESULT);
    const chosen = pickModel(k.getModels(), {});
    expect(chosen.providerId).toBe("new-provider");
    expect(chosen.modelId).toBe("step-5-preview");
    // 首试即生效档位：setModel 传 high，0 次失败重试（R2 验收锚点）。
    expect(chosen.reasoningLevel).toBe("high");
    expect(chosen.reasoningFallback).toBeUndefined();
  });

  it("【W1 锚点】所配 \"max\"（旧缺省）→ 预检降级 high + reasoningFallback{from:max,to:high}", () => {
    const k = keeper();
    k.absorbModels(REAL_CREATE_RESULT);
    const chosen = pickModel(k.getModels(), { preferReasoning: "max" });
    expect(chosen.reasoningLevel).toBe("high");
    expect(chosen.reasoningFallback).toEqual({ from: "max", to: "high" });
    // provision.ts 见 reasoningFallback 即落 member-reasoning-fallback via:"pre-check"
    // （首试前降级，不再有 setModel 首试失败）。
  });

  it("【硬回归】旧扁平形状（顶层 providerId/modelId + 字符串档位）仍全量解析", () => {
    const k = keeper();
    k.absorbModels({
      settings: {
        model: {
          available: [
            { providerId: "prov-a", modelId: "step-5-preview", reasoning: { levels: ["low", "high"] } },
            { providerId: "prov-b", modelId: "claude-x", reasoning: { levels: ["max"] } },
          ],
        },
      },
    });
    expect(k.getModels()).toEqual([
      { providerId: "prov-a", modelId: "step-5-preview", reasoningLevels: ["low", "high"] },
      { providerId: "prov-b", modelId: "claude-x", reasoningLevels: ["max"] },
    ]);
    const chosen = pickModel(k.getModels(), { preferModel: "step-5-preview", preferReasoning: "max" });
    expect(chosen.reasoningLevel).toBe("high");
    expect(chosen.reasoningFallback).toEqual({ from: "max", to: "high" });
  });

  it("无 defaultLevel（旧扁平形状）→ 缺省回落档位表末位；表也空 → \"max\"（零行为变化）", () => {
    const k = keeper();
    k.absorbModels({
      available: [
        { ref: { providerId: "p", modelId: "m1" }, reasoning: { levels: [{ value: "low" }, { value: "high" }] } },
        { ref: { providerId: "p", modelId: "m2" } },
      ],
    });
    const [m1, m2] = k.getModels();
    expect(m1).toEqual({ providerId: "p", modelId: "m1", reasoningLevels: ["low", "high"] });
    expect(m2).toEqual({ providerId: "p", modelId: "m2", reasoningLevels: [] });
    expect(pickModel([m1!], {}).reasoningLevel).toBe("high"); // 表末位
    expect(pickModel([m2!], {}).reasoningLevel).toBe("max"); // 无表无缺省档：旧行为
  });

  it("defaultLevel 与表末位不一致时以模型自报缺省档为准（缺省 = 不指定档位）", () => {
    const models: readonly ModelRef[] = [
      { providerId: "p", modelId: "m", reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium" },
    ];
    expect(pickModel(models, {}).reasoningLevel).toBe("medium");
    // 显式所配仍按声明表校验（不被 defaultLevel 影响）。
    expect(pickModel(models, { preferReasoning: "high" }).reasoningLevel).toBe("high");
  });

  it("重复枚举项只补空：先到者无档位表（state.updated 兜底）→ 后到者补全，不覆盖已得值", () => {
    const k = keeper();
    // 先吸收只有 ref 的兜底流（旧实现会把它锁死成空档位表）。
    k.absorbModels({ state: { model: { available: [{ ref: { providerId: "new-provider", modelId: "step-5-preview" } }] } } });
    expect(k.getModels()[0]!.reasoningLevels).toEqual([]);
    // 再吸收 create 结果内联的完整枚举 → 补全档位表与缺省档。
    k.absorbModels(REAL_CREATE_RESULT);
    expect(k.getModels()).toEqual([
      {
        providerId: "new-provider",
        modelId: "step-5-preview",
        reasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "high",
      },
    ]);
  });

  it("档位条目含非字符串垃圾（null/数字/空串）→ 只收合法 value，不抛", () => {
    const k = keeper();
    k.absorbModels({
      available: [
        {
          ref: { providerId: "p", modelId: "m" },
          reasoning: { levels: [{ value: "low" }, null, 7, { value: "" }, { value: "high", label: "high" }], defaultLevel: "high" },
        },
      ],
    });
    expect(k.getModels()[0]!.reasoningLevels).toEqual(["low", "high"]);
  });

  it("【硬回归·显式非法档位】banana → ProvisionError 显式报错（不因新解析路径静默降级）", () => {
    const k = keeper();
    k.absorbModels(REAL_CREATE_RESULT);
    expect(() => pickModel(k.getModels(), { preferReasoning: "banana" })).toThrow(/banana/);
  });
});
