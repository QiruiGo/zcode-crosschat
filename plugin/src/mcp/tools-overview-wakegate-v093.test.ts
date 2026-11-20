/**
 * v0.9.3（37-v093 方案 §一 组B B2）定向测试：xc_overview 三视图的闸状态挂载。
 *
 * 覆盖面（对应方案验收判据「构造 RED → overview 三视图同源显示原因与 retryAfter；
 * GREEN → 不显示阻塞」）：
 * - team/status/panel 三视图 payload 同带 capacity.wakeGate 块（键集冻结 ↔ PROTOCOL §15.7）；
 * - 构造 RED 冷却记录 → 三视图同源显示阻塞条件名、下次重判时刻、本窗 wake-deferred 计数；
 * - GREEN → blocked=false / conditions=[] / nextRetryAt=null，文本不显示阻塞；
 * - 文本面：闸摘要拼在 capacity 行尾（status 行序冻结不位移）；
 * - file 层阈值进判定与展示（config.json capacity.warn_watermark → 判红 + detail 标签）。
 *
 * 纪律：不跑全量单测；peer 根一律指向临时目录（XC_MESSAGING_DIR——绝不碰机器全局注册表，
 * 同 tools-overview-views.test.ts）；sampleCapacity 经 vi.mock 钉成确定性样本。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { capacityWakeDeferral } from "../engine/wake.js";
import type { CapacitySample } from "../core/capacity.js";
import type { ToolDeps } from "./core.js";

/** 钉成 GREEN 的确定性样本（水位 48%、无回合树）。 */
const GREEN_SAMPLE: CapacitySample = {
  sampledAt: 1_800_000_000_000,
  totalBytes: 31_300_000_000,
  freeBytes: 15_000_000_000,
  watermark: 0.48,
  steadyTreeBytes: 3_000_000_000,
  headlessTurnCount: 0,
  headlessTurnMaxRssBytes: null,
  degraded: null,
};

const sampleProbe = vi.hoisted(() => ({ sample: undefined as CapacitySample | undefined }));
vi.mock("../core/capacity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/capacity.js")>();
  return {
    ...actual,
    sampleCapacity: async (): Promise<CapacitySample> => sampleProbe.sample ?? GREEN_SAMPLE,
  };
});

const NOW = 1_800_000_000_000;

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-overview-wakegate-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true }); // 空 peer 根：无活 peer
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } };
  sampleProbe.sample = undefined;
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function seedTeam(): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "lead", now: NOW });
  team.members.push(
    { key: "lead", sessionId: "sess_lead", role: "peer", joinedAt: NOW, lastSeen: NOW },
    { key: "b", sessionId: "sess_b", role: "worker", joinedAt: NOW, lastSeen: NOW },
  );
  await writeTeam(stateRoot, team);
}

/**
 * 构造一个 RED 冷却记录（走真闸入口：判定 + 落盘 + 计数，与生产同路径）。
 * 时刻取**真实** Date.now()——挂载面也是真实时钟，合成未来时刻会让窗长得离谱。
 * 返回落盘时刻（until = 该值 + 120000）。
 */
async function seedRedCooldown(): Promise<number> {
  const seededAt = Date.now();
  const red: CapacitySample = {
    ...GREEN_SAMPLE,
    freeBytes: 2_790_000_000,
    watermark: 0.089,
    headlessTurnCount: 13,
    headlessTurnMaxRssBytes: 280_000_000,
  };
  const deferral = await capacityWakeDeferral(
    stateRoot,
    { XC_MEM_WAKE_COOLDOWN_MS: "120000" },
    seededAt,
    { teamId: "default", to: "b", urgent: false },
    red,
  );
  expect(deferral?.reason).toBe("capacity-red");
  return seededAt;
}

type GateBlock = Record<string, unknown>;

async function gateBlockOf(view: "team" | "status" | "panel"): Promise<{ payload: GateBlock; text: string }> {
  const res = (await handleOverview(deps, { view }, "conn-x")) as ToolResult;
  const payload = payloadOf(res) as Record<string, unknown>;
  const capacity = payload["capacity"] as Record<string, unknown> | undefined;
  return { payload: (capacity?.["wakeGate"] ?? {}) as GateBlock, text: res.content[0]?.text ?? "" };
}

// ─────────────────────────── 三视图同源 ───────────────────────────

describe("v0.9.3 B2：xc_overview 三视图同源挂载闸状态", () => {
  it("RED：team/status/panel 三视图 payload 都带 wakeGate 块且关键字段同值", async () => {
    await seedTeam();
    const seededAt = await seedRedCooldown();
    const team = await gateBlockOf("team");
    const status = await gateBlockOf("status");
    const panel = await gateBlockOf("panel");
    for (const view of [team, status, panel]) {
      expect(view.payload["blocked"]).toBe(true);
      expect(view.payload["conditions"]).toEqual(["watermark", "turn-concurrency"]);
      expect(view.payload["nextRetryAt"]).toBe(seededAt + 120_000);
      expect(view.payload["deferredWindowCount"]).toBe(1);
      expect(view.payload["deferredAlertThreshold"]).toBe(5);
      expect(view.payload["enabled"]).toBe(true);
    }
    // 三视图逐字段同源（同一份读数）；retryAfterMs 是「此刻」的活读数（各次调用相差
    // 毫秒级），对拍时剥掉它——稳定字段（条件/时刻/水位/计数）必须逐字节相同。
    const stripRetry = (v: unknown): unknown =>
      JSON.parse(JSON.stringify(v), (key, value) => (key === "retryAfterMs" ? 0 : value));
    expect(stripRetry(status.payload)).toEqual(stripRetry(team.payload));
    expect(stripRetry(panel.payload)).toEqual(stripRetry(team.payload));
  });

  it("RED：文本三视图都显示阻塞条件与下次重判时刻（拼在 capacity 行尾）", async () => {
    await seedTeam();
    const seededAt = await seedRedCooldown();
    const iso = new Date(seededAt + 120_000).toISOString();
    for (const view of ["team", "status", "panel"] as const) {
      const { text } = await gateBlockOf(view);
      expect(text).toContain("唤醒闸 阻塞（watermark, turn-concurrency）");
      expect(text).toContain(`下次重判 ${iso}`);
      expect(text).toContain("本窗 wake-deferred 1/5");
      expect(text).toContain("单回合预估");
    }
  });

  it("RED：blockedScopes 逐域明细（分域键/条件/detail/水位/retryAfterMs）", async () => {
    await seedTeam();
    const seededAt = await seedRedCooldown();
    const { payload } = await gateBlockOf("team");
    const scopes = payload["blockedScopes"] as Array<Record<string, unknown>>;
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!["scope"]).toBe("default|b|normal");
    expect(scopes[0]!["to"]).toBe("b");
    expect(scopes[0]!["conditions"]).toEqual(["watermark", "turn-concurrency"]);
    expect(scopes[0]!["watermark"]).toBe(0.089);
    expect(scopes[0]!["until"]).toBe(seededAt + 120_000);
    // retryAfterMs = until - 读取时刻（活读数）：窗内剩余，落在 (0, 120000]
    expect(scopes[0]!["retryAfterMs"] as number).toBeGreaterThan(0);
    expect(scopes[0]!["retryAfterMs"] as number).toBeLessThanOrEqual(120_000);
    expect(Array.isArray(scopes[0]!["detail"])).toBe(true);
  });

  it("GREEN：不显示阻塞（blocked=false / conditions=[] / nextRetryAt=null / 文本无阻塞字样）", async () => {
    await seedTeam();
    const { payload, text } = await gateBlockOf("team");
    expect(payload["blocked"]).toBe(false);
    expect(payload["conditions"]).toEqual([]);
    expect(payload["blockedScopes"]).toEqual([]);
    expect(payload["nextRetryAt"]).toBeNull();
    expect(text).toContain("唤醒闸 开启·未阻塞");
    expect(text).not.toContain("阻塞（");
  });

  it("status 视图行序不位移（capacity 行仍在下标 2，闸摘要并入首行）", async () => {
    await seedTeam();
    await seedRedCooldown();
    const res = (await handleOverview(deps, { view: "status" }, "conn-x")) as ToolResult;
    const lines = (res.content[0]?.text ?? "").split("\n");
    expect(lines[0]).toMatch(/^team: default \| lead: lead \| members: 2/);
    expect(lines[1]).toMatch(/^tasks: /);
    expect(lines[2]).toMatch(/^capacity: /);
    expect(lines[2]).toContain("唤醒闸 阻塞");
    expect(lines[3]).toMatch(/^checkpoint: /); // 行序冻结：未被新增行顶跑
  });

  it("file 层阈值进判定与展示（config.json warn_watermark=0.99 → 判红 + 标签不虚标 env）", async () => {
    await seedTeam();
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "config.json"),
      JSON.stringify({ capacity: { warn_watermark: 0.99, turn_estimate_bytes: 2048 } }),
      "utf8",
    );
    const { payload, text } = await gateBlockOf("team");
    const capacity = (payloadOf(await handleOverview(deps, { view: "team" }, "conn-x") as ToolResult) as Record<string, unknown>)["capacity"] as Record<string, unknown>;
    expect(capacity["red"]).toBe(true); // 0.48 < 0.99（file 层生效）
    expect(String((capacity["detail"] as unknown[] | undefined)?.[0] ?? "")).toContain("config.json capacity.warn_watermark");
    const thresholds = payload["thresholds"] as Record<string, unknown>;
    expect(thresholds["warnWatermark"]).toBe(0.99);
    expect(thresholds["turnEstimateBytes"]).toBe(2048);
    const sources = payload["thresholdSources"] as Record<string, unknown>;
    expect(sources["warn_watermark"]).toBe("file");
    expect(sources["turn_estimate_bytes"]).toBe("file");
    expect(text).toContain("单回合预估 2048B"); // <1MB 按字节原样呈现（不虚报成 KB）
  });

  it("file 层 wake_gate=false → 读数 enabled=false（文本「唤醒闸 关闭」）", async () => {
    await seedTeam();
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "config.json"), JSON.stringify({ capacity: { wake_gate: false } }), "utf8");
    const { payload, text } = await gateBlockOf("team");
    expect(payload["enabled"]).toBe(false);
    expect(text).toContain("唤醒闸 关闭（wake_gate 生效值 false）");
  });

  it("file 键畸形 → wakeGate.warnings 披露（payload 机器可读）", async () => {
    await seedTeam();
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "config.json"), JSON.stringify({ capacity: { warn_watermark: "x" } }), "utf8");
    const { payload } = await gateBlockOf("team");
    const warnings = payload["warnings"] as string[] | undefined;
    expect(warnings?.some((w) => w.includes("warn_watermark"))).toBe(true);
  });

  it("wake-off 持续态进行尾披露（wakeOffSince 在场时文本带持续分钟数）", async () => {
    await seedTeam();
    // 直接写告警状态（wakeOff.since = NOW-3600000）：观测面只读它。
    const offSince = Date.now() - 3_600_000;
    await mkdir(join(stateRoot, "capacity"), { recursive: true });
    await writeFile(
      join(stateRoot, "capacity", "wake-alert-state.json"),
      JSON.stringify({
        version: 1,
        deferred: { count: 0, windowStartedAt: 0, alertedAt: 0 },
        wakeOff: { since: offSince, alertedAt: 0 },
      }),
      "utf8",
    );
    const { payload, text } = await gateBlockOf("team");
    expect(payload["wakeOffSince"]).toBe(offSince);
    expect(payload["wakeOffAlertMs"]).toBe(1_800_000);
    expect(text).toContain("wake 关闭持续");
  });

  it("冻结契约：wakeGate payload 块键集 ↔ PROTOCOL §15.7 冻结块（行级除外）", async () => {
    await seedTeam();
    const { payload } = await gateBlockOf("team");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const protocol = readFileSync(join(repoRoot, "docs", "PROTOCOL.md"), "utf8");
    const at = protocol.indexOf("capacity payload 增 `wakeGate` 块（键集冻结，值为占位）");
    expect(at).toBeGreaterThan(0);
    const block = protocol.slice(at, at + 2000).match(/```json\r?\n([\s\S]*?)```/);
    expect(block).not.toBeNull();
    const frozen = Object.keys(JSON.parse(block![1]!) as Record<string, unknown>).sort();
    // 干净配置下 warnings 不在场（条件键）→ 键集恰等于冻结块
    expect(Object.keys(payload).sort()).toEqual(frozen);
  });
});
