/** M3 protocol 单测：错误映射与结果信封（零内部依赖，可独立运行）。 */
import { describe, expect, it } from "vitest";
import {
  busyError,
  errorResult,
  invalidParamsError,
  mapToolError,
  notRegisteredError,
  okResult,
  payloadOf,
  runTool,
  staleAttemptError,
  ToolError,
} from "./protocol.js";

describe("protocol: 结构化错误", () => {
  it("busyError 携带 {error:'busy', lock}（DESIGN §2.7-2）", () => {
    const err = busyError("team:d:\\ws\\x:default");
    expect(err).toBeInstanceOf(ToolError);
    expect(err.payload).toEqual({ error: "busy", lock: "team:d:\\ws\\x:default" });
    expect(err.message).toContain("retry once shortly");
  });

  it("notRegisteredError 的码为 not_registered（DESIGN §2.3-2）", () => {
    const err = notRegisteredError();
    expect(err.payload.error).toBe("not_registered");
    expect(String(err.payload.message)).toContain("xc_register first");
  });

  it("staleAttemptError 携带期望的当前 attemptId（§2.6 硬拒）", () => {
    const err = staleAttemptError("t1", "att-xyz");
    expect(err.payload).toMatchObject({ error: "stale_attempt", taskId: "t1", attemptId: "att-xyz" });
  });

  it("invalidParamsError 可附带额外字段", () => {
    const err = invalidParamsError("bad dependsOn", { dependsOn: ["t9"] });
    expect(err.payload).toMatchObject({ error: "invalid_params", dependsOn: ["t9"] });
  });
});

describe("protocol: 结果信封", () => {
  it("okResult = [人可读行, 机器 JSON] 两个 text 块", () => {
    const res = okResult("Task t1 dispatched to b via mailbox.", { taskId: "t1", delivered: "mailbox" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(2);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("t1");
    expect(payloadOf(res)).toEqual({ taskId: "t1", delivered: "mailbox" });
  });

  it("errorResult = isError:true + 单 JSON 块", () => {
    const res = errorResult({ error: "busy", lock: "l1" });
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
    expect(payloadOf(res)).toEqual({ error: "busy", lock: "l1" });
  });

  it("payloadOf 对错误信封取第一块", () => {
    const res = errorResult({ error: "x" });
    expect(payloadOf(res).error).toBe("x");
  });
});

describe("protocol: mapToolError / runTool", () => {
  it("ToolError → 其负载；普通 Error → {error:'internal'}", () => {
    const fromTool = mapToolError(busyError("L"));
    expect(payloadOf(fromTool)).toEqual({ error: "busy", lock: "L" });
    expect(fromTool.isError).toBe(true);

    const fromPlain = mapToolError(new Error("boom"));
    expect(payloadOf(fromPlain).error).toBe("internal");
    expect(payloadOf(fromPlain).message).toBe("boom");

    const fromJunk = mapToolError("just a string");
    expect(payloadOf(fromJunk).error).toBe("internal");
    expect(payloadOf(fromJunk).message).toBe("just a string");
  });

  it("runTool 捕获异常并映射，成功时原样返回", async () => {
    const ok = await runTool(async () => okResult("fine", { ok: true }));
    expect(payloadOf(ok)).toEqual({ ok: true });

    const bad = await runTool(async () => {
      throw notRegisteredError();
    });
    expect(bad.isError).toBe(true);
    expect(payloadOf(bad).error).toBe("not_registered");
  });
});
