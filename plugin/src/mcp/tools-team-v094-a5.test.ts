/**
 * v0.9.4（A5）：member-add **供给唤醒计入三级指标**定向测试（39-v094 方案 §二 A 表）。
 *
 * 判据（方案原文）：「member-add 的供给唤醒与派单唤醒都计入 wake-spawn-ok/
 * child-alive/consumed」；验收：「建员后三级计数各 +1」；任务书：「区分
 * scene=post-provision」。
 *
 * 机制：member-add Phase 4（E-e 投产唤醒）走 attemptWake（reason="post-provision"），
 * 三级事件由 attemptWake 的成功/启动证据/消费确认三条路径按 scene 落账——供给唤醒
 * 与派单唤醒同一套漏斗，scene 字段供 overview 区分「投产唤醒」与「派单唤醒」。
 *
 * 替身（零真实 spawn、零真实 app-server）：
 * - provisionMember mock（member-cap-flow.test.ts 同款路径）：返回伪供给结果；
 * - attemptWake mock：转调**真** attemptWake 但注入假 spawn + 确定性容量样本 +
 *   小轮询间隔（注入即信任的生产纪律：测试替身只替 I/O 面，判据全走真代码）。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createMemberToolCore } from "./tools-team.js";
import { identityStore } from "./identity.js";
import { appendMailbox, createMessage, markMailboxConsumed } from "../core/mailbox.js";
import { readTeam, writeTeam, newTeamState } from "../core/teamstate.js";
import { writeSession } from "../core/registry.js";
import type { TeamMember, TeamState } from "../core/types.js";
import { withTeamLock } from "../core/lock.js";
import type { SpawnResumeOptions, SpawnResumeResult } from "../engine/resume-cli.js";
import type { ToolDeps } from "./core.js";
import type { CapacitySample } from "../core/capacity.js";
import { readWakeTierCounts, WAKE_TIER_EVENT_CHILD_ALIVE, WAKE_TIER_EVENT_CONSUMED, WAKE_TIER_EVENT_SPAWN_OK } from "../engine/wake.js";

vi.mock("../engine/provision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/provision.js")>();
  return {
    ...actual,
    provisionMember: vi.fn(async (_deps: ToolDeps, spec: { key: string }) => ({
      sessionId: `sess_${spec.key}`,
      providerId: "prov-test",
      modelId: "glm-test",
      reasoningLevel: "max",
      welcomeResponse: "welcome (mock)",
      reprovisioned: false,
    })),
  };
});

// attemptWake 替身：转调真 attemptWake（判据真跑），只注入测试 I/O 面。
vi.mock("../engine/wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/wake.js")>();
  return {
    ...actual,
    attemptWake: vi.fn(async (req: Parameters<typeof actual.attemptWake>[0]) => {
      const greenSample: CapacitySample = {
        sampledAt: Date.now(),
        totalBytes: 16 * 1024 ** 3,
        freeBytes: 8 * 1024 ** 3,
        watermark: 0.5,
        steadyTreeBytes: 1 * 1024 ** 3,
        headlessTurnCount: 0,
        headlessTurnMaxRssBytes: null,
        degraded: null,
      };
      return actual.attemptWake({
        ...req,
        capacitySample: greenSample,
        watchWindowMs: 0,
        lifecyclePollMs: 20,
        lifecycleWindowMs: 6_000,
        spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
          opts.onHelperSpawned?.(4242); // helper 汇报唤醒子 pid = 启动证据（child-alive）
          return { pid: 5150, logFile: opts.logFile };
        },
      });
    }),
  };
});

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-a5-v094-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: {} };
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function readEngineEvents(): Array<Record<string, unknown>> {
  // 直读 engine.jsonl（与 wake 测试同口径；counts 经 readWakeTierCounts 聚合）。
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function teamWith(members: TeamMember[]): TeamState {
  return {
    teamId: "default",
    name: "default",
    founderKey: "ldr1",
    leadKey: "ldr1",
    phase: "open",
    members,
    tasks: [],
    seq: 0,
    createdAt: 1,
  };
}

async function bindLead(): Promise<void> {
  await writeSession(stateRoot, { sessionId: "sess_ldr1", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  identityStore.bind("conn-lead", {
    sessionKey: "xc:default:ldr1", teamId: "default", name: "ldr1", agentKey: "ldr1",
    sessionId: "sess_ldr1", role: "worker", boundAt: Date.now(),
  });
}

const memberCore = () => createMemberToolCore(deps);

describe("v0.9.4 A5：member-add 供给唤醒计入三级（scene=post-provision）", () => {
  it("【锚点】建员（有未读积压）→ 三级计数各 +1 且 scene=post-provision", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([
      { key: "ldr1", sessionId: "sess_ldr1", role: "worker", joinedAt: 1, lastSeen: 1, state: "ready" },
    ]));
    // 预置 m1 邮箱的一条未读（供给完成时的 E-e 积压）——消息先于成员在册落盘。
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(stateRoot, "teams", "default", "inbox"), { recursive: true });
    const backlog = createMessage("ldr1", "m1", "建员前积压：先读我", {});
    await appendMailbox(stateRoot, "default", "m1", backlog);

    const add = (args: Record<string, unknown>) =>
      memberCore().xc_member_add(args as Parameters<ReturnType<typeof memberCore>["xc_member_add"]>[0], "conn-lead");
    const res: ToolResult = await add({ name: "m1" });
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as { name: string; state: string; backlog: number; delivered: string };
    expect(payload.name).toBe("m1");
    expect(payload.state).toBe("ready");
    expect(payload.backlog).toBe(1);
    // 供给唤醒走的是 wake 态（引擎成员免分层闸）
    expect(payload.delivered).toBe("wake");

    // ① spawn-ok：恰一条，scene=post-provision（供给唤醒，非派单唤醒）
    const spawnOk = readEngineEvents().filter((e) => e["event"] === WAKE_TIER_EVENT_SPAWN_OK);
    expect(spawnOk).toHaveLength(1);
    expect(spawnOk[0]!["scene"]).toBe("post-provision");
    // ② child-alive：恰一条，scene=post-provision
    const childAlive = readEngineEvents().filter((e) => e["event"] === WAKE_TIER_EVENT_CHILD_ALIVE);
    expect(childAlive).toHaveLength(1);
    expect(childAlive[0]!["scene"]).toBe("post-provision");
    // ③ consumed：成员消费积压后恰一条（异步确认路径）
    await withTeamLock(stateRoot, "default", async () => {
      await markMailboxConsumed(stateRoot, "default", "m1", [backlog.id], Date.now());
    });
    const consumedDeadline = Date.now() + 5_000;
    for (;;) {
      if (readEngineEvents().filter((e) => e["event"] === WAKE_TIER_EVENT_CONSUMED).length === 1) break;
      if (Date.now() > consumedDeadline) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const consumed = readEngineEvents().filter((e) => e["event"] === WAKE_TIER_EVENT_CONSUMED);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]!["scene"]).toBe("post-provision");

    // ④ overview 聚合面：三级计数各 1（readWakeTierCounts 同一真源投影）
    const counts = await readWakeTierCounts(stateRoot);
    expect(counts.spawnOk).toBe(1);
    expect(counts.childAlive).toBe(1);
    expect(counts.consumed).toBe(1);
  });

  it("回执文案如实（A3 同口径）：wake 态写「已发起唤醒」、无积压不写投递结果段", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([
      { key: "ldr1", sessionId: "sess_ldr1", role: "worker", joinedAt: 1, lastSeen: 1, state: "ready" },
    ]));
    // 无积压 → 无供给唤醒（E-e 无唤醒面）→ 回执不出现投递结果段。
    const res = await memberCore().xc_member_add({ name: "m2" } as never, "conn-lead");
    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    expect(text).not.toContain("backlog");
    expect(text).not.toContain("已送达");
    expect(text).not.toContain("已消费");
    expect(text).not.toContain("仅落邮箱");
    // 无积压也**不**造唤醒：三级计数零条（供给唤醒只对真实积压发起）。
    expect(readEngineEvents().filter((e) => e["event"] === WAKE_TIER_EVENT_SPAWN_OK)).toHaveLength(0);
  });

  it("有积压且唤醒成功（对照 A3）：回执写「已发起唤醒（非送达确认）」而非已送达（v0.9.6 V095-14：措辞统一走 renderDeliveryOutcome）", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([
      { key: "ldr1", sessionId: "sess_ldr1", role: "worker", joinedAt: 1, lastSeen: 1, state: "ready" },
    ]));
    mkdirSync(join(stateRoot, "teams", "default", "inbox"), { recursive: true });
    await appendMailbox(stateRoot, "default", "m3", createMessage("ldr1", "m3", "积压", {}));
    const res = await memberCore().xc_member_add({ name: "m3" } as never, "conn-lead");
    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    // v0.9.6（V095-14）：backlog 行措辞与其余路径统一为 renderDeliveryOutcome
    //（wake → 「已发起唤醒（wake，非送达确认）」；唤醒子未见启动证据时自动升级为
    // 「已发起唤醒但未见启动证据」——本替身汇报了 pid，故为确认态）。
    expect(text).toContain("backlog 1 message(s) → 已发起唤醒（wake，非送达确认）");
    expect(text).not.toContain("已送达");
    expect(text).not.toContain("已消费");
  });
});
