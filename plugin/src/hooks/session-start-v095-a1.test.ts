/**
 * v0.9.5（A1/A6）：SessionStart 钩子的**ppid 采纳档闸**与**票据回滚**定向测试
 * （41-v095 方案 §一 组A A1 + A6）。
 *
 * A1（V094-02）：ppid 采纳默认关（XC_ADOPT_BY_PPID=1 才启用）——钩子的「票据消费 +
 * 身份自动绑定」随之默认关：默认档票据留给模型回合的 wakeToken xc_identify 兜底
 * （2 次调用），宁可多一次调用不许错绑；开启档照旧消费+绑定（v0.9.4 A6 能力保留）。
 *
 * A6（V094-03）：启用档下票据已置 used 而绑定失败（花名被别的 sid 持有）时**回滚
 * 票据**（restoreWakeNonce 恢复未用）——wake prompt 承诺的 wakeToken 兜底路径可用：
 * 回滚后同一 token 经 MCP 面 consumeWakeNonce 成功消费（不再 "already used"）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  peerRoot: "",
  stateRoot: "",
  workspace: "",
  sessionId: undefined as string | undefined,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    readStdinPayload: vi.fn(() => undefined),
    resolveHookContext: vi.fn(() => ({
      workspace: h.workspace,
      stateRoot: h.stateRoot,
      sessionId: h.sessionId,
      event: "SessionStart",
    })),
    emitAdditionalContext: vi.fn(),
    logHookEvent: vi.fn(async () => {}),
    auditHookFailure: vi.fn(async () => {}),
    peerRootFromEnv: vi.fn(() => h.peerRoot),
    readHookPermissionMode: vi.fn(() => undefined),
  };
});

const dirs: string[] = [];

beforeEach(() => {
  delete process.env["XC_ADOPT_BY_PPID"];
  h.stateRoot = mkdtempSync(join(tmpdir(), "xc-a1-v095-"));
  h.peerRoot = mkdtempSync(join(tmpdir(), "xc-a1-v095-peers-"));
  h.workspace = join(tmpdir(), "xc-a1-v095-ws-");
  h.sessionId = undefined;
  dirs.push(h.stateRoot, h.peerRoot);
});

afterEach(() => {
  delete process.env["XC_ADOPT_BY_PPID"];
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

async function importHook(): Promise<typeof import("./session-start.js")> {
  return await import("./session-start.js");
}

async function seedTeam(memberSid: string): Promise<void> {
  const { newTeamState, writeTeam } = await import("../core/teamstate.js");
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  team.members.push({ key: "b", sessionId: memberSid, role: "worker", joinedAt: 1, lastSeen: 1 });
  await writeTeam(h.stateRoot, team);
}

async function seedTicket(agentKey: string, sid: string): Promise<string> {
  const { createWakeNonce } = await import("../core/registry.js");
  const { token } = await createWakeNonce(h.stateRoot, {
    teamId: "default",
    agentKey,
    sid,
    voiceOwner: sid,
    issuedToSid: sid,
    name: agentKey,
  });
  return token;
}

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(h.stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readNonceUsed(token: string): Promise<boolean | undefined> {
  const { readWakeNonce } = await import("../core/registry.js");
  return (await readWakeNonce(h.stateRoot, token))?.used;
}

async function runHook(sessionId: string): Promise<void> {
  h.sessionId = sessionId;
  const { runSessionStartHook } = await importHook();
  await runSessionStartHook();
}

describe("v0.9.5 A1：钩子的票据消费随 ppid 采纳档默认关", () => {
  it("【锚点】默认档（未设 XC_ADOPT_BY_PPID）+ 目标 sid 票据 → 票据不被消费（留给模型回合 wakeToken 兜底）、不绑定", async () => {
    await seedTeam("sess_old_b");
    const token = await seedTicket("b", "sess_b");

    await runHook("sess_b");

    // 票据原封不动（未置 used）——模型回合的 xc_identify({wakeToken}) 可消费它（2 次调用兜底）
    expect(await readNonceUsed(token)).toBeUndefined();
    // 不建任何绑定
    const { readNames } = await import("../core/registry.js");
    expect(Object.keys(await readNames(h.stateRoot))).toEqual([]);
    // 不落绑定事件
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-bound")).toHaveLength(0);
  });

  it("开启档（XC_ADOPT_BY_PPID=1）照旧消费 + 绑定（v0.9.4 A6 能力保留，功能不减）", async () => {
    process.env["XC_ADOPT_BY_PPID"] = "1";
    await seedTeam("sess_old_b");
    const token = await seedTicket("b", "sess_b");

    await runHook("sess_b");

    expect(await readNonceUsed(token)).toBe(true);
    const { readNames, readSession } = await import("../core/registry.js");
    expect((await readNames(h.stateRoot))["b"]?.sessionId).toBe("sess_b");
    expect((await readSession(h.stateRoot, "sess_b"))?.boundName).toBe("b");
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-bound")).toHaveLength(1);
  });
});

describe("v0.9.5 A6：启用档绑定失败 → 票据回滚，wakeToken 兜底可用", () => {
  it("【锚点】花名已被别的 sid 持有 → 不抢绑 + 票据回滚未用；回滚后 MCP 面 wakeToken 消费成功", async () => {
    process.env["XC_ADOPT_BY_PPID"] = "1";
    // 花名 b 已被别的 sid 持有（名字冲突形态）
    await seedTeam("sess_old_b");
    const { writeNames } = await import("../core/registry.js");
    await writeNames(h.stateRoot, { b: { sessionId: "sess_other", role: "worker", registeredAt: 1 } });
    const token = await seedTicket("b", "sess_b");

    await runHook("sess_b");

    // 绑定没落地 + 票据已回滚未用（wakeToken 兜底可用）
    const { readNames } = await import("../core/registry.js");
    expect((await readNames(h.stateRoot))["b"]?.sessionId).toBe("sess_other"); // 不抢绑
    expect(await readNonceUsed(token)).toBeUndefined();
    const skipped = readEngineEvents().filter((e) => e["event"] === "wake-ticket-binding-skipped").at(-1);
    expect(skipped).toBeDefined();
    expect(skipped!["ticketRolledBack"]).toBe(true);

    // 回滚后：同一 token 走 MCP 面 xc_identify 的消费原语 → 成功（不再 "already used"）
    const { consumeWakeNonce, readWakeNonce } = await import("../core/registry.js");
    const consumed = await consumeWakeNonce(h.stateRoot, token, {
      teamId: "default",
      agentKey: "b",
      sid: "sess_b",
    });
    expect(consumed).toBeDefined();
    expect(consumed!.name).toBe("b");
    expect((await readWakeNonce(h.stateRoot, token))?.used).toBe(true);
  });

  it("绑定成功 → 票据保持 used（一次性语义不放松，不因 A6 回滚而可重放）", async () => {
    process.env["XC_ADOPT_BY_PPID"] = "1";
    await seedTeam("sess_old_b");
    const token = await seedTicket("b", "sess_b");

    await runHook("sess_b");

    expect(await readNonceUsed(token)).toBe(true);
    // 重放拒：同一 token 第二次消费不可行
    const { consumeWakeNonce } = await import("../core/registry.js");
    expect(await consumeWakeNonce(h.stateRoot, token, { teamId: "default", agentKey: "b", sid: "sess_b" })).toBeUndefined();
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-rollback")).toHaveLength(0);
  });
});
