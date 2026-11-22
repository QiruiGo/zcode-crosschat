/**
 * v0.9.9（组 A / V098-13，P3）定向测试：**模型池序按来源权威级分层**。
 *
 * 缺陷形态（53-v099 方案 §一 组 A）：模型池序取决于兜底流（state.updated）与 create
 * 流的到达顺序。v0.9.8 D1 只修了「档位表」的权威合并（create 后到覆盖兜底锁定的
 * 错档），**池序**仍按到达序：兜底流先到时它枚举的模型占住池首，后到的 create 新
 * 模型只能追加到池尾 → provision 步骤②无显式 model 的缺省 pick（`pool[0]`，
 * provision.ts pickModel）取到兜底模型而非 create 池首，供给结果随乱序漂移。
 *
 * 修法（53-v099 方案 §一 组 A）：池序按权威源排序（create 优先，兜底流只补缺）；
 * 无显式 model 时取 create 池首。实现 = appserver.ts 的 create 层分层不变式
 * （createTierEnd：create 新条目插 create 层尾、兜底条目被 create 晋升时移到
 * create 层尾、纯兜底条目恒留其后）。
 *
 * 本文件覆盖：
 * 1.【锚点】两流乱序到达（兜底流带**不同**模型先到 / create 先到）→ 池序与
 *   pickModel 缺省 pick 完全一致（供给结果稳定）；
 * 2.【锚点】兜底流锁定的模型被 create 结果覆盖（D1 存量语义）→ 该模型晋升到
 *   create 层，池序仍是 create 在前；
 * 3.【锚点】多模型晋升场景（兜底 [A,B] + create [B,C]）乱序 → 恒 [B,C,A]；
 * 4. 无 create 流（§6.4 resume 续用路径 absorbModels(undefined)）→ 池序 = 兜底
 *   到达序，缺省 pick 取兜底池首（create 池为空时的既定行为）；
 * 5. 交错到达、create 层内次序 = create 结果内次序、重复吸收幂等；
 * 6. getModels() 对外形状仍不含来源字段（v0.9.7 W1 精确形状断言不回退）。
 */
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { AppServerKeeper } from "./appserver.js";
import { pickModel } from "./provision.js";

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

function keeper(): { k: AppServerKeeper; push: (line: string) => void } {
  const { child, push } = fakeChildWithStdout();
  const k = AppServerKeeper.start({
    cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
    spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
  });
  return { k, push };
}

/** 把一条 state.updated 兜底流事件推给 keeper（params 原样嵌入）。 */
function pushStateUpdated(push: (line: string) => void, params: unknown): void {
  push(JSON.stringify({ method: "state.updated", params }));
}

const model = (providerId: string, modelId: string): { ref: { providerId: string; modelId: string } } =>
  ({ ref: { providerId, modelId } });

describe("v0.9.9 组 A（V098-13）：模型池序按来源分层（create 优先，兜底只补缺）", () => {
  it("【锚点】两流乱序到达（不同模型）→ 池序与缺省 pick 稳定（兜底流先到亦然）", () => {
    const createPayload = { settings: { model: { available: [model("new-provider", "create-first")] } } };
    const fallbackParams = { settings: { model: { available: [model("new-provider", "fallback-only")] } } };

    // 时序 1：兜底流先到（真实时序：create 请求在途时事件流已推来枚举）。
    const a = keeper();
    pushStateUpdated(a.push, fallbackParams);
    a.k.absorbModels(createPayload);
    const poolA = a.k.getModels();

    // 时序 2：create 先到、兜底流后到。
    const b = keeper();
    b.k.absorbModels(createPayload);
    pushStateUpdated(b.push, fallbackParams);
    const poolB = b.k.getModels();

    // 两种乱序到达 → 同一池序：create 池首在前，纯兜底条目补缺在后。
    expect(poolA.map((m) => m.modelId)).toEqual(["create-first", "fallback-only"]);
    expect(poolB).toEqual(poolA);
    // 无显式 model → 取 create 池首（两种时序同一个供给结果）。
    expect(pickModel(poolA, {}).modelId).toBe("create-first");
    expect(pickModel(poolB, {})).toEqual(pickModel(poolA, {}));
    // 整笔供给判定（provider/model/档位）逐字段一致。
    expect(pickModel(poolB, {})).toEqual({
      providerId: "new-provider",
      modelId: "create-first",
      reasoningLevel: "max",
    });
  });

  it("【锚点】兜底流先锁（含错档）→ create 后到：晋升 + 档位覆盖，缺省 pick 仍 create 池首", () => {
    const a = keeper();
    // 兜底流先到：先锁一个纯 ref 条目，再锁一个带陈旧档位表的同池条目。
    pushStateUpdated(a.push, { settings: { model: { available: [model("new-provider", "stale-levels")] } } });
    pushStateUpdated(a.push, {
      settings: {
        model: {
          available: [
            {
              ref: { providerId: "new-provider", modelId: "stale-levels" },
              reasoning: { levels: [{ value: "max" }], defaultLevel: "max" },
            },
          ],
        },
      },
    });
    expect(a.k.getModels()[0]!.reasoningLevels).toEqual(["max"]); // 此刻被错档锁死
    // create 后到（P1 权威主路径）→ 覆盖档位表并把该条目晋升进 create 层。
    a.k.absorbModels({
      settings: {
        model: {
          available: [
            {
              ref: { providerId: "new-provider", modelId: "stale-levels" },
              reasoning: { levels: [{ value: "low" }, { value: "high" }], defaultLevel: "high" },
            },
            model("new-provider", "create-new"),
          ],
        },
      },
    });
    // create 层（stale-levels 晋升 + create-new）在前；池内无纯兜底条目。
    expect(a.k.getModels().map((m) => m.modelId)).toEqual(["stale-levels", "create-new"]);
    expect(a.k.getModels()[0]!.reasoningLevels).toEqual(["low", "high"]);
    expect(pickModel(a.k.getModels(), {}).reasoningLevel).toBe("high");
    expect(pickModel(a.k.getModels(), {}).reasoningFallback).toBeUndefined();
  });

  it("【锚点】多模型晋升场景乱序（兜底 [A,B] + create [B,C]）→ 恒 [B,C,A]", () => {
    const fallback = {
      available: [
        { ref: { providerId: "p", modelId: "A" }, reasoning: { levels: [{ value: "low" }] } },
        { ref: { providerId: "p", modelId: "B" }, reasoning: { levels: [{ value: "low" }] } },
      ],
    };
    const create = {
      available: [
        { ref: { providerId: "p", modelId: "B" }, reasoning: { levels: [{ value: "low" }, { value: "high" }], defaultLevel: "high" } },
        { ref: { providerId: "p", modelId: "C" }, reasoning: { levels: [{ value: "medium" }] } },
      ],
    };

    // 时序 1：兜底流先到。
    const a = keeper();
    pushStateUpdated(a.push, fallback);
    a.k.absorbModels(create);
    // 时序 2：create 先到。
    const b = keeper();
    b.k.absorbModels(create);
    pushStateUpdated(b.push, fallback);

    expect(a.k.getModels().map((m) => m.modelId)).toEqual(["B", "C", "A"]);
    expect(b.k.getModels().map((m) => m.modelId)).toEqual(["B", "C", "A"]);
    expect(b.k.getModels()).toEqual(a.k.getModels());
    // 缺省 pick = create 池首（B），档位取 create 覆盖后的 high。
    expect(pickModel(a.k.getModels(), {}).modelId).toBe("B");
    expect(pickModel(a.k.getModels(), {}).reasoningLevel).toBe("high");
    expect(pickModel(b.k.getModels(), {})).toEqual(pickModel(a.k.getModels(), {}));
  });

  it("无 create 流（§6.4 resume 路径 absorbModels(undefined)）→ 池序 = 兜底到达序，缺省取兜底池首", () => {
    const a = keeper();
    // provisionMember 的 resume 续用路径 createResult === undefined（appserver 对 undefined 无操作）。
    a.k.absorbModels(undefined);
    pushStateUpdated(a.push, {
      available: [model("p", "fb-1"), model("p", "fb-2")],
    });
    a.k.absorbModels(undefined); // 再调一次仍无操作、不改序
    expect(a.k.getModels().map((m) => m.modelId)).toEqual(["fb-1", "fb-2"]);
    expect(pickModel(a.k.getModels(), {}).modelId).toBe("fb-1");
  });

  it("交错到达（兜底→create→兜底→create）→ create 层按 create 内次序在前、兜底按首见在后", () => {
    const a = keeper();
    pushStateUpdated(a.push, { available: [model("p", "fb-1")] });
    a.k.absorbModels({ available: [model("p", "cr-1")] });
    pushStateUpdated(a.push, { available: [model("p", "fb-2")] });
    a.k.absorbModels({ available: [model("p", "cr-2")] });
    expect(a.k.getModels().map((m) => m.modelId)).toEqual(["cr-1", "cr-2", "fb-1", "fb-2"]);
    expect(pickModel(a.k.getModels(), {}).modelId).toBe("cr-1");
  });

  it("重复吸收同一 create 结果（幂等）→ 池序与档位不变", () => {
    const a = keeper();
    const create = {
      available: [
        { ref: { providerId: "p", modelId: "cr-1" }, reasoning: { levels: [{ value: "low" }, { value: "high" }], defaultLevel: "high" } },
        model("p", "cr-2"),
      ],
    };
    a.k.absorbModels(create);
    const once = a.k.getModels();
    a.k.absorbModels(create);
    expect(a.k.getModels()).toEqual(once);
    expect(a.k.getModels().map((m) => m.modelId)).toEqual(["cr-1", "cr-2"]);
  });

  it("create 已锁定的模型 → 兜底流后到只补空、不降级不重排（D1 存量语义不回退）", () => {
    const a = keeper();
    a.k.absorbModels({
      available: [{ ref: { providerId: "p", modelId: "cr-1" }, reasoning: { levels: [{ value: "low" }, { value: "high" }], defaultLevel: "high" } }],
    });
    pushStateUpdated(a.push, {
      available: [{ ref: { providerId: "p", modelId: "cr-1" }, reasoning: { levels: [{ value: "max" }], defaultLevel: "max" } }],
    });
    expect(a.k.getModels()).toEqual([
      { providerId: "p", modelId: "cr-1", reasoningLevels: ["low", "high"], defaultReasoningLevel: "high" },
    ]);
    expect(pickModel(a.k.getModels(), {}).reasoningLevel).toBe("high");
  });

  it("provider 过滤（XC_MEMBER_PROVIDER）不破坏分层：过滤后仍取 create 池首", () => {
    const a = keeper();
    pushStateUpdated(a.push, { available: [model("prov-a", "fb-a")] });
    a.k.absorbModels({ available: [model("prov-a", "cr-a"), model("prov-b", "cr-b")] });
    // 无过滤 → create 池首 cr-a；按 prov-a 过滤 → 该 provider 内 create 条目仍在兜底条目之前。
    expect(pickModel(a.k.getModels(), {}).modelId).toBe("cr-a");
    expect(pickModel(a.k.getModels(), { preferProvider: "prov-a" }).modelId).toBe("cr-a");
    expect(pickModel(a.k.getModels(), { preferProvider: "prov-b" }).modelId).toBe("cr-b");
  });

  it("getModels() 形状不含来源字段（v0.9.7 W1 精确形状断言不回退）", () => {
    const a = keeper();
    pushStateUpdated(a.push, { available: [model("p", "fb-1")] });
    a.k.absorbModels({
      available: [{ ref: { providerId: "p", modelId: "cr-1" }, reasoning: { levels: [{ value: "low" }], defaultLevel: "low" } }],
    });
    expect(Object.keys(a.k.getModels()[0]!).sort()).toEqual(
      ["defaultReasoningLevel", "modelId", "providerId", "reasoningLevels"],
    );
    // 显式 model 匹配不受池序影响（按 modelId 精确命中兜底层条目）。
    expect(pickModel(a.k.getModels(), { preferModel: "fb-1" }).modelId).toBe("fb-1");
    // 缺省 pick 不受形状断言影响：仍 create 池首。
    expect(pickModel(a.k.getModels(), {}).modelId).toBe("cr-1");
  });
});
