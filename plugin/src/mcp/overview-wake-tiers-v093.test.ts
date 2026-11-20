/**
 * v0.9.3 组A（reports/37-v093方案.md §一 组A 验收判据③）定向单测——
 * **A2 三级计数在 overview 可见**（xc_overview 挂载面）。
 *
 * 锚点：「三级计数在 overview 可见」。本文件只验**挂载面**（统计行 + payload 块 + 文本行），
 * 判据与取数的单一真源在 engine/wake.ts（其单测见 wake-v093-tiers-fakesuccess.test.ts）。
 *
 * 临时 stateRoot 端到端；peer 根指向临时目录（绝不碰机器全局注册表，同
 * tools-overview-views.test.ts 纪律）。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { logEngineEvent } from "../core/log.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import type { TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";

const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-overview-wake-tiers-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true }); // 空 peer 根：无活 peer
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot } };
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 建一个只有 lead 的小队（founder 也占花名册行）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 } as TeamMember,
  });
  await writeTeam(stateRoot, team);
}

/** 往 engine.jsonl 落三条三级指标事件（readWakeTierCounts 的唯一输入）。 */
async function seedTierEvents(): Promise<void> {
  await logEngineEvent(stateRoot, { event: "wake-spawn-ok", to: "b" });
  await logEngineEvent(stateRoot, { event: "wake-child-alive", to: "b" });
  await logEngineEvent(stateRoot, { event: "wake-consumed", to: "b" });
}

async function overview(view: "team" | "panel" | "status"): Promise<ToolResult> {
  return handleOverview(deps, { view }, "conn-test");
}

describe("v0.9.3 A2：xc_overview 唤醒三级指标挂载", () => {
  it("team 视图：文本行 + payload wake 块（spawn-ok / child-alive / consumed）", async () => {
    await seedTeam();
    await seedTierEvents();
    const result = await overview("team");
    const payload = payloadOf(result) as Record<string, unknown>;
    expect(String(result.content[0]?.text ?? "")).toContain("wake: spawn-ok 1 / child-alive 1 / consumed 1");
    expect(payload["wake"]).toMatchObject({ spawnOk: 1, childAlive: 1, consumed: 1 });
    expect(typeof (payload["wake"] as Record<string, unknown>)["windowBytes"]).toBe("number");
  });

  it("panel 视图：文本行 + payload wake 块（与 team 同源同形）", async () => {
    await seedTeam();
    await seedTierEvents();
    const result = await overview("panel");
    const payload = payloadOf(result) as Record<string, unknown>;
    expect(String(result.content[0]?.text ?? "")).toContain("wake: spawn-ok 1 / child-alive 1 / consumed 1");
    expect(payload["wake"]).toMatchObject({ spawnOk: 1, childAlive: 1, consumed: 1 });
  });

  it("status 视图：payload wake 块在（文本行序归 render.ts，本组只碰统计行）", async () => {
    await seedTeam();
    await seedTierEvents();
    const result = await overview("status");
    const payload = payloadOf(result) as Record<string, unknown>;
    expect(payload["wake"]).toMatchObject({ spawnOk: 1, childAlive: 1, consumed: 1 });
  });

  it("零唤醒 → 不挂载（三视图 payload 均无 wake 块、文本无 wake 行）", async () => {
    await seedTeam();
    for (const view of ["team", "panel", "status"] as const) {
      const result = await overview(view);
      const payload = payloadOf(result) as Record<string, unknown>;
      expect(payload["wake"]).toBeUndefined();
      expect(String(result.content[0]?.text ?? "")).not.toContain("wake: spawn-ok");
    }
  });
});
