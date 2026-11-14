/**
 * v0.6 C3 挂载单测（验收补缺）：xc_overview team/panel 两视图须携带 capacity 块
 * （sampleCapacity/judgeCapacity 真采样；os 水位恒在，CIM 可降级但不缺席），
 * 文本行含 capacity 预警行；采样意外不挂载时任务板仍正常（fail-safe 由实现保证，
 * 本测试只验正常路径的形状与缓存落盘）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolCore, type ToolDeps } from "./core.js";
import { createTeamOverviewCore, handleOverview } from "./tools-overview.js";
import { writeSession } from "../core/registry.js";
import { payloadOf } from "./protocol.js";
import { capacityCacheFile } from "../core/capacity.js";

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;
let core: ReturnType<typeof createToolCore>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-cap-mount-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: {} };
  core = createToolCore(deps);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("overview capacity mount (C3)", () => {
  it("team 视图 payload 携带 capacity 块且文本含预警行", async () => {
    await writeSession(stateRoot, { sessionId: "sess-cap-a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
    await core.xc_register({ name: "a", sessionId: "sess-cap-a" }, "conn-cap-a");
    const overviewCore = createTeamOverviewCore(deps);
    const r = await overviewCore.xc_status({}, "conn-cap-a");
    const payload = payloadOf(r) as Record<string, unknown>;
    const cap = payload.capacity as Record<string, unknown> | undefined;
    expect(cap).toBeDefined();
    expect(typeof cap!.sampledAt).toBe("number");
    expect(typeof cap!.watermark).toBe("number");
    expect(cap!.watermark as number).toBeGreaterThan(0);
    expect(cap!.watermark as number).toBeLessThanOrEqual(1);
    expect(typeof cap!.red).toBe("boolean");
    expect(Array.isArray(cap!.violated)).toBe(true);
    expect(typeof cap!.degraded === "string" || cap!.degraded === null).toBe(true);
    // 文本行：capacity: GREEN|RED | 水位 …（formatCapacityLines 直出）
    const text = (r.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
    expect(text).toMatch(/capacity: (GREEN|RED) \| 水位/);
    // 缓存文件落盘（60s 最小间隔的惰性采样凭证）
    expect(existsSync(capacityCacheFile(stateRoot))).toBe(true);
  });

  it("panel 视图 payload 同样携带 capacity 块", async () => {
    const r = await handleOverview(deps, { view: "panel" }, "conn-cap-panel");
    const payload = payloadOf(r) as Record<string, unknown>;
    const cap = payload.capacity as Record<string, unknown> | undefined;
    expect(cap).toBeDefined();
    expect(typeof cap!.watermark).toBe("number");
    const text = (r.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
    expect(text).toMatch(/capacity: (GREEN|RED) \| 水位/);
  });

  it("team 视图在无团队时也返回（capacity 不阻碍空板）", async () => {
    const overviewCore = createTeamOverviewCore(deps);
    const r = await overviewCore.xc_status({}, "conn-cap-empty");
    const payload = payloadOf(r) as Record<string, unknown>;
    expect(payload.capacity).toBeDefined();
  });
});
