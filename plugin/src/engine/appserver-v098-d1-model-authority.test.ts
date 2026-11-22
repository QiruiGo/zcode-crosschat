/**
 * v0.9.8（D1/V097-01）定向测试：**模型枚举的权威源优先合并 + 档位名交叉校验**。
 *
 * 缺陷形态（49-v098 方案 §二 组 D D1）：`collectModelRefs 合并无权威排序`——
 * `state.updated` 兜底流**先到**时会把自身那份（可能陈旧/不一致的）档位表锁死，
 * 后到的 session/create 结果（P1 权威主路径）反而只被「补空」对待 → pickModel 按
 * 错档发 setModel 首试，且无审计。旧合并还有一个盲区：缺省路径直接取模型自报的
 * `reasoning.defaultLevel`，不与该模型自己的声明表交叉校验——自报缺省档不在表里
 * （枚举数据自相矛盾）时同样首试发错档。
 *
 * 本文件覆盖：
 * 1. state.updated 先到（带错档位表）→ create 后到 → **create 权威档位表覆盖**
 *    （验收锚点「state.updated 先到 → 仍用 create 档位」）；
 * 2. create 先到 → state.updated 后到带冲突档位表 → create 不被覆盖（只补空）；
 * 3. 补空方向不变：create 自身缺席的字段（levels/defaultLevel）不被抹掉；
 * 4. pickModel 交叉校验：自报缺省档不在声明表 → 回退表末位 + reasoningFallback
 *    （provision 侧据此落 member-reasoning-fallback 审计——「错档注入 → 审计/回退」）；
 * 5. 交叉校验不误伤：缺省档在表内/声明表为空 → 原样返回（零行为变化）；
 * 6. getModels() 对外形状不含来源字段（v0.9.7 W1 精确形状断言不回退）。
 */
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { AppServerKeeper } from "./appserver.js";
import { pickModel } from "./provision.js";
import type { ModelRef } from "./appserver.js";

/** 假 ChildProcess + 可推送 stdout 行的通道（驱动 keeper 的 state.updated 事件面）。 */
function fakeChildWithStdout(): { child: ChildProcess; push: (line: string) => void } {
  const handlers: Array<(chunk: Buffer) => void> = [];
  const child = {
    stdout: { on: (_event: string, cb: (chunk: Buffer) => void) => { handlers.push(cb); } },
    stderr: { on: () => undefined },
    on: () => undefined,
    stdin: { write: () => true, destroyed: false },
    kill: () => true,
  } as unknown as ChildProcess;
  return {
    child,
    push: (line: string) => {
      for (const handler of handlers) handler(Buffer.from(`${line}\n`));
    },
  };
}

function keeper(): AppServerKeeper {
  return AppServerKeeper.start({
    cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
    spawnImpl: (() => ({
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      on: () => undefined,
      stdin: { write: () => true, destroyed: false },
      kill: () => true,
    })) as unknown as typeof import("node:child_process").spawn,
  });
}

/** 41-v095 实测形状（create 结果内联 available[].ref，逐字段同形）。 */
const REAL_CREATE_RESULT = {
  settings: {
    model: {
      available: [
        {
          ref: { providerId: "new-provider", modelId: "step-5-preview" },
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

/** state.updated 兜底流的**陈旧/错档**形态：只声明一个不受支持的 "max"。 */
const STALE_STATE_UPDATED = {
  settings: {
    model: {
      available: [
        {
          ref: { providerId: "new-provider", modelId: "step-5-preview" },
          reasoning: { levels: [{ value: "max" }], defaultLevel: "max" },
        },
      ],
    },
  },
};

describe("v0.9.8 D1：模型枚举合并的权威源排序（create 结果优先）", () => {
  it("【D1 锚点】state.updated 先到锁错档 → create 后到 → 仍用 create 权威档位表", () => {
    const { child, push } = fakeChildWithStdout();
    const k = AppServerKeeper.start({
      cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
      spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    // 兜底流先到（真实时序：create 请求在途时事件流已推来枚举）。
    push(JSON.stringify({ method: "state.updated", params: STALE_STATE_UPDATED }));
    expect(k.getModels()[0]!.reasoningLevels).toEqual(["max"]); // 此刻被错档锁死
    // create 结果后到（P1 权威主路径）→ 覆盖兜底流锁定的档位表与缺省档。
    k.absorbModels(REAL_CREATE_RESULT);
    expect(k.getModels()).toEqual([
      {
        providerId: "new-provider",
        modelId: "step-5-preview",
        reasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "high",
      },
    ]);
    // 首试档位即 create 表内档（无降级记录）——旧实现此处会按 ["max"] 发错档。
    expect(pickModel(k.getModels(), {}).reasoningLevel).toBe("high");
    expect(pickModel(k.getModels(), {}).reasoningFallback).toBeUndefined();
  });

  it("【D1 锚点】create 先到 → state.updated 后到带冲突档位表 → create 不被覆盖（只补空）", () => {
    const { child, push } = fakeChildWithStdout();
    const k = AppServerKeeper.start({
      cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
      spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    // create 权威结果先落定。
    k.absorbModels(REAL_CREATE_RESULT);
    // 冲突的兜底流后到 → 只补空，不动已得的 create 档位表/缺省档。
    push(JSON.stringify({ method: "state.updated", params: STALE_STATE_UPDATED }));
    expect(k.getModels()).toEqual([
      {
        providerId: "new-provider",
        modelId: "step-5-preview",
        reasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "high",
      },
    ]);
  });

  it("补空方向不变：create 缺 levels/defaultLevel → 兜底流已锁值不被抹掉", () => {
    const { child, push } = fakeChildWithStdout();
    const k = AppServerKeeper.start({
      cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
      spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    push(JSON.stringify({ method: "state.updated", params: STALE_STATE_UPDATED }));
    // create 结果里同模型只带 ref（无 reasoning 段）→ 非空才覆盖，空值不抹除。
    k.absorbModels({
      settings: { model: { available: [{ ref: { providerId: "new-provider", modelId: "step-5-preview" } }] } },
    });
    expect(k.getModels()).toEqual([
      {
        providerId: "new-provider",
        modelId: "step-5-preview",
        reasoningLevels: ["max"],
        defaultReasoningLevel: "max",
      },
    ]);
  });

  it("create 只补缺省档（levels 缺席）→ 兜底流 levels 保留、缺省档以 create 为准", () => {
    const { child, push } = fakeChildWithStdout();
    const k = AppServerKeeper.start({
      cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
      spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    push(JSON.stringify({
      method: "state.updated",
      params: { available: [{ ref: { providerId: "p", modelId: "m" }, reasoning: { levels: [{ value: "low" }, { value: "high" }] } }] },
    }));
    k.absorbModels({
      available: [{ ref: { providerId: "p", modelId: "m" }, reasoning: { defaultLevel: "low" } }],
    });
    expect(k.getModels()).toEqual([
      { providerId: "p", modelId: "m", reasoningLevels: ["low", "high"], defaultReasoningLevel: "low" },
    ]);
  });

  it("多模型各自独立定序：一个被 create 覆盖、另一个仍是纯兜底流", () => {
    const { child, push } = fakeChildWithStdout();
    const k = AppServerKeeper.start({
      cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
      spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    push(JSON.stringify({
      method: "state.updated",
      params: {
        available: [
          { ref: { providerId: "p", modelId: "m1" }, reasoning: { levels: [{ value: "max" }], defaultLevel: "max" } },
          { ref: { providerId: "p", modelId: "m2" }, reasoning: { levels: [{ value: "low" }] } },
        ],
      },
    }));
    k.absorbModels({
      available: [{ ref: { providerId: "p", modelId: "m1" }, reasoning: { levels: [{ value: "low" }, { value: "high" }], defaultLevel: "high" } }],
    });
    expect(k.getModels()).toEqual([
      { providerId: "p", modelId: "m1", reasoningLevels: ["low", "high"], defaultReasoningLevel: "high" },
      { providerId: "p", modelId: "m2", reasoningLevels: ["low"] },
    ]);
  });
});

describe("v0.9.8 D1：档位名与声明表交叉校验（缺省路径）", () => {
  it("【D1 锚点】自报缺省档不在声明表 → 回退表末位 + reasoningFallback{from,to}（审计面）", () => {
    const models: readonly ModelRef[] = [
      {
        providerId: "new-provider",
        modelId: "step-5-preview",
        reasoningLevels: ["low", "medium", "high"],
        // 自相矛盾的枚举数据：缺省档不在自己的声明表里。
        defaultReasoningLevel: "xhigh",
      },
    ];
    const chosen = pickModel(models, {});
    expect(chosen.reasoningLevel).toBe("high"); // 表末位
    expect(chosen.reasoningFallback).toEqual({ from: "xhigh", to: "high" });
    // provision.ts 见 reasoningFallback 即落 member-reasoning-fallback via:"pre-check"。
  });

  it("自报缺省档在声明表 → 原样生效（零行为变化，无降级记录）", () => {
    const models: readonly ModelRef[] = [
      { providerId: "p", modelId: "m", reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium" },
    ];
    const chosen = pickModel(models, {});
    expect(chosen.reasoningLevel).toBe("medium");
    expect(chosen.reasoningFallback).toBeUndefined();
  });

  it("声明表为空（模型未声明）→ 无判据不交叉：自报缺省档原样（setModel 重试链兜底）", () => {
    const models: readonly ModelRef[] = [
      { providerId: "p", modelId: "m", reasoningLevels: [], defaultReasoningLevel: "max" },
    ];
    const chosen = pickModel(models, {});
    expect(chosen.reasoningLevel).toBe("max");
    expect(chosen.reasoningFallback).toBeUndefined();
  });

  it("无自报缺省档 → 维持 v0.9.7 口径（表末位 → \"max\"），交叉校验不介入", () => {
    const withTable: readonly ModelRef[] = [{ providerId: "p", modelId: "m", reasoningLevels: ["low", "high"] }];
    expect(pickModel(withTable, {}).reasoningLevel).toBe("high");
    const noTable: readonly ModelRef[] = [{ providerId: "p", modelId: "m", reasoningLevels: [] }];
    expect(pickModel(noTable, {}).reasoningLevel).toBe("max");
  });

  it("显式所配档位仍按原两道闸（非法名报错 / 不被声明则有界降级），不受缺省路径改动影响", () => {
    const models: readonly ModelRef[] = [
      { providerId: "p", modelId: "m", reasoningLevels: ["low", "high"], defaultReasoningLevel: "high" },
    ];
    expect(pickModel(models, { preferReasoning: "high" }).reasoningLevel).toBe("high");
    expect(pickModel(models, { preferReasoning: "max" }).reasoningFallback).toEqual({ from: "max", to: "high" });
    expect(() => pickModel(models, { preferReasoning: "banana" })).toThrow(/banana/);
  });

  it("getModels() 形状不含来源字段（v0.9.7 W1 精确形状断言不回退）", () => {
    const { child, push } = fakeChildWithStdout();
    const k = AppServerKeeper.start({
      cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
      spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    push(JSON.stringify({ method: "state.updated", params: STALE_STATE_UPDATED }));
    k.absorbModels(REAL_CREATE_RESULT);
    expect(Object.keys(k.getModels()[0]!).sort()).toEqual(
      ["defaultReasoningLevel", "modelId", "providerId", "reasoningLevels"],
    );
  });
});
