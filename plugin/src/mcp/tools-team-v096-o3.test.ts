/**
 * v0.9.6（O3/B2 + V095-14 + R2）定向测试（tools-team 面）。
 *
 * O3：xc_team unblock 回执旧措辞 `notice delivered via ${delivered}` 改为与其余路径
 * 一致的如实口径（44-v096 方案 §一 组 B B2 / 42-v095验收 O3）——"delivered via mailbox"
 * 会把「仅落邮箱」读成「已送达」；skipped 也如实写「未尝试唤醒的原因」。
 *
 * V095-14：tools-team 面的 wake 态回执带 startConfirmed/wakeTiers 结构化键
 *（adv3-F1：结构化键在 MCP 面 grep 零命中）。
 *
 * R2：member-add 回执如实披露实际生效档位 + reasoningFallback{from,to}
 *（LIMITATIONS 第 25 条：回执/审计含实际档位）。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createMemberToolCore, handleTeam } from "./tools-team.js";
import { identityStore } from "./identity.js";
import { appendMailbox, createMessage } from "../core/mailbox.js";
import { readTeam, writeTeam, newTeamState } from "../core/teamstate.js";
import type { TeamState } from "../core/types.js";
import { writeSession } from "../core/registry.js";
import type { TeamMember, Task } from "../core/types.js";
import type { ToolDeps } from "./core.js";
import type { CapacitySample } from "../core/capacity.js";
import type { SpawnResumeOptions, SpawnResumeResult } from "../engine/resume-cli.js";

const mockProvisionResult = {
  sessionId: "sess_m1",
  providerId: "new-provider",
  modelId: "step-5-preview",
  reasoningLevel: "high",
  reasoningFallback: { from: "max", to: "high" } as { from: string; to: string } | undefined,
  welcomeResponse: "welcome (mock)",
  reprovisioned: false,
};

vi.mock("../engine/provision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/provision.js")>();
  return {
    ...actual,
    provisionMember: vi.fn(async () => mockProvisionResult),
  };
});

// attemptWake 替身：转调真 attemptWake（判据真跑），只注入测试 I/O 面（v094 a5 同纪律）。
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
          opts.onHelperSpawned?.(4242); // 启动证据 → startConfirmed=true
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
  workDir = await mkdtemp(join(tmpdir(), "xc-o3-v096-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: {} };
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function humanLine(res: ToolResult): string {
  const first = res.content.find((c) => c.type === "text");
  return first?.text ?? "";
}

function teamWith(members: TeamMember[], tasks: Task[] = []): TeamState {
  return {
    teamId: "default",
    name: "default",
    founderKey: "ldr1",
    leadKey: "ldr1",
    phase: "open",
    members,
    tasks,
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

function blockedTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "20261122-t1",
    title: "被阻塞的任务",
    prompt: "do it",
    dependsOn: [],
    status: "blocked",
    preBlockedStatus: "claimed",
    blockedReason: "waiting for upstream input",
    assignee: "w1",
    attempt: 1,
    attemptId: null,
    createdBy: "ldr1",
    createdAt: now,
    updatedAt: now,
    result: null,
    error: null,
    evidence: [],
    history: [],
    ...overrides,
  };
}

describe("v0.9.6 O3：unblock 回执措辞如实化（无 delivered via）", () => {
  it("【O3 锚点】unblock 回执不含 'delivered via'；skipped 态写「已入箱（未尝试唤醒…）」", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([
      { key: "ldr1", sessionId: "sess_ldr1", role: "worker", joinedAt: 1, lastSeen: 1, state: "ready" },
      { key: "w1", sessionId: "sess_w1", role: "worker", joinedAt: 1, lastSeen: 1, identity: "engine", state: "ready" },
    ], [blockedTask()]));

    const res = await handleTeam(deps, { action: "unblock", taskId: "20261122-t1" }, "conn-lead");
    expect(res.isError).toBeFalsy();
    const line = humanLine(res);
    // 旧措辞禁现（"delivered via mailbox/skipped" 把入箱/跳过读成已投递）
    expect(line).not.toContain("delivered via");
    // 解除后的任务回 claimed（认领者有开放任务）→ 未尝试唤醒；通知已入箱——如实写
    expect(line).toContain("已入箱");
    expect(line).toContain("未尝试唤醒");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("skipped");
    expect(payload["status"]).toBe("claimed");
  });

  it("back=pending（无认领者通知）→ skipped 措辞不谎称「已入箱」", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([
      { key: "ldr1", sessionId: "sess_ldr1", role: "worker", joinedAt: 1, lastSeen: 1, state: "ready" },
      { key: "w1", sessionId: "sess_w1", role: "worker", joinedAt: 1, lastSeen: 1, identity: "engine", state: "ready" },
    ], [blockedTask({ preBlockedStatus: "pending", assignee: "w1" })]));

    const res = await handleTeam(deps, { action: "unblock", taskId: "20261122-t1" }, "conn-lead");
    expect(res.isError).toBeFalsy();
    const line = humanLine(res);
    expect(line).not.toContain("delivered via");
    expect(line).toContain("无通知可投");
    expect(line).not.toContain("已入箱");
  });

  it("mailbox/wake 两态措辞与其余路径逐字一致（renderDeliveryOutcome 对拍）", async () => {
    const { renderDeliveryOutcome } = await import("./render.js");
    const { renderDeliveryOutcome: teamWording } = await import("./tools-team.js");
    expect(teamWording("mailbox")).toBe(renderDeliveryOutcome("mailbox"));
    expect(teamWording("wake", false)).toBe(renderDeliveryOutcome("wake", false));
    expect(teamWording("wake", true)).toBe(renderDeliveryOutcome("wake", true));
  });
});

describe("v0.9.6 V095-14 + R2：member-add 回执的结构化披露", () => {
  it("【V095-14】wake 态投产回执 payload 带 startConfirmed=true ∧ wakeTiers 三级快照", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([
      { key: "ldr1", sessionId: "sess_ldr1", role: "worker", joinedAt: 1, lastSeen: 1, state: "ready" },
    ]));
    mkdirSync(join(stateRoot, "teams", "default", "inbox"), { recursive: true });
    const backlog = createMessage("ldr1", "m1", "建员前积压：先读我", {});
    await appendMailbox(stateRoot, "default", "m1", backlog);

    const memberCore = createMemberToolCore(deps);
    const res = await memberCore.xc_member_add({ name: "m1" }, "conn-lead");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("wake");
    // adv3-F1：结构化键在 MCP 面被丢弃（grep 零命中）——现在 member-add 面兑现
    expect(payload["startConfirmed"]).toBe(true);
    expect(payload["wakeTiers"]).toEqual({ spawnOk: "ok", childAlive: "ok", consumed: "pending" });
  });

  it("【R2 锚点】回执如实披露实际生效档位 + reasoningFallback{from,to}（文本 + payload 双通道）", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([
      { key: "ldr1", sessionId: "sess_ldr1", role: "worker", joinedAt: 1, lastSeen: 1, state: "ready" },
    ]));

    const memberCore = createMemberToolCore(deps);
    const res = await memberCore.xc_member_add({ name: "m1" }, "conn-lead");
    expect(res.isError).toBeFalsy();
    const line = humanLine(res);
    expect(line).toContain("reasoning high"); // 实际生效档位
    expect(line).toContain("降级自 max"); // 文本通道披露降级
    const payload = payloadOf(res) as Record<string, unknown>;
    const model = payload["model"] as { reasoningLevel: string };
    expect(model.reasoningLevel).toBe("high");
    expect(payload["reasoningFallback"]).toEqual({ from: "max", to: "high" });
    // engine 事件双通道：member-added 带 reasoningFallback
    const added = readEngineEvents().find((e) => e["event"] === "member-added");
    expect(added).toBeDefined();
    expect(added!["reasoningLevel"]).toBe("high");
    expect(added!["reasoningFallback"]).toEqual({ from: "max", to: "high" });
  });

  it("【R1② 接线】供给失败回执 payload 带 nonceRevoked{reason,nonce}（结构化回收证据，不受 detail 截断影响）", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([
      { key: "ldr1", sessionId: "sess_ldr1", role: "worker", joinedAt: 1, lastSeen: 1, state: "ready" },
    ]));
    // 替身 provisionMember 抛带回收证据的 ProvisionError（回收本身在真 provisionMember
    // 的 catch 里，live 路径见 FIX-W §三-1 如实声明；本测试锁 tools-team 面的证据透传）。
    const { provisionMember } = await import("../engine/provision.js");
    vi.mocked(provisionMember).mockImplementationOnce(async () => {
      const { ProvisionError } = await import("../engine/provision.js");
      throw new ProvisionError(
        "setModel",
        "setModel: Reasoning effort \"max\" is not supported by new-provider/step-5-preview",
        { reason: "provision-failed", nonce: "abc123def456" },
      );
    });
    const memberCore = createMemberToolCore(deps);
    const res = await memberCore.xc_member_add({ name: "m1" }, "conn-lead");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["error"]).toBe("member_provision_failed");
    expect(payload["nonceRevoked"]).toEqual({ reason: "provision-failed", nonce: "abc123def456" });
    // 引擎事件双通道：member-add-failed 同步携带回收证据
    const failed = readEngineEvents().find((e) => e["event"] === "member-add-failed");
    expect(failed).toBeDefined();
    expect(failed!["nonceRevoked"]).toEqual({ reason: "provision-failed", nonce: "abc123def456" });
  });
});
