/**
 * v0.9.7（W2/R1）定向测试：**成员状态门控先于 takenOver/wake-disabled**（47-v097 方案 §一 组 W W2）。
 *
 * 缺陷形态（41-v095 real-smoke C §三 R1 残留）：供给失败的成员 `state=failed` ∧
 * `sessionId=""`（半程死亡/超时清扫后 sid 被清空）→ `resolveWakeGate` 的
 * `engineHolderIsHeadless` 判空 sid 为 false → 该行被读成「engine 标 ∧ 交互式持有者」
 * （takenOver）→ `decideDelivery` **先**返回 `wake-disabled`——回执/跳过原因只说
 * 「交互式会话自动唤醒未开启」，真正的行动项（重供给/改派）被掩盖，且派单面照样建单。
 *
 * 本文件覆盖（引擎闸序面）：
 * 1. failed ∧ sessionId="" → 跳过原因是 `member-state:failed`（含重供给指引），
 *    **不出现** wake-disabled/takenOver；
 * 2. removed ∧ sessionId="" → 同理 `member-state:removed`；
 * 3. provisioning → 仍是 `member-state:provisioning`（v0.9.6 R1③ 行为不减）；
 * 4. 正常成员（ready ∧ 无头持有者）→ 照常 wake（门控上移不误伤活成员）；
 * 5. 事件面带 memberState 键、且不落 in-flight nonce（跳过路径不写票）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createWakeNonce } from "../core/registry";
import { newTeamState, writeTeam } from "../core/teamstate";
import { wakeLifecycleFile } from "../core/paths";
import type { TeamMember } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli.js";
import { attemptWake, type WakeRequest } from "./wake.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v097-w2-"));
  dirs.push(root);
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

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 绿色容量样本（跳过容量闸的确定性；与 tools-team v094 a5 替身同形）。 */
const greenCapacity = {
  sampledAt: Date.now(),
  totalBytes: 16 * 1024 ** 3,
  freeBytes: 8 * 1024 ** 3,
  watermark: 0.5,
  steadyTreeBytes: 1 * 1024 ** 3,
  headlessTurnCount: 0,
  headlessTurnMaxRssBytes: null,
  degraded: null,
};

function spawnOk(): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    opts.onHelperSpawned?.(4242);
    return { pid: 4242, logFile: opts.logFile };
  };
}

/**
 * 唤醒请求：**不设 XC_WAKE_ENABLED**（交互式语义缺省关）——这样「分层闸判 wake-disabled」
 * 与「成员状态门控」谁先命中直接可辨：旧实现给 wake-disabled，新实现给 member-state:*。
 */
function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "dispatch",
    receiptIds: [],
    ticket: "计算 17*23",
    env: {}, // 无 XC_WAKE_ENABLED：交互式目标按内置默认关
    cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
    capacitySample: greenCapacity,
    watchWindowMs: 0,
    limboTimeoutMs: 3_600_000,
    wakeSlowMs: 3_600_000,
    fakeSuccessMs: 3_600_000,
    lifecycleWindowMs: 100,
    ...overrides,
  };
}

/** 建队 + 一名 engine 标成员（sid 可指定；failed/removed 场景传空串 = 真实复测形态）。 */
async function seedTeam(member: Partial<TeamMember>): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
  const row: TeamMember = {
    key: "b",
    sessionId: "sess_b",
    role: "worker",
    joinedAt: 1,
    lastSeen: 1,
    identity: "engine",
    ...member,
  };
  team.members.push(row);
  await writeTeam(root, team);
}

/** 无头持有者证据（engine 免开关判据：当前 sid 的记录带本名 boundName）。 */
async function seedHeadlessHolder(sessionId: string): Promise<void> {
  const { writeSession } = await import("../core/registry.js");
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen: 1, boundName: "b" });
}

describe("v0.9.7 W2：failed/removed 成员不再被 wake-disabled/takenOver 抢先归因", () => {
  it("【W2 锚点】failed ∧ sessionId=\"\" → member-state:failed（含重供给指引），不出现 wake-disabled", async () => {
    await seedTeam({ state: "failed", sessionId: "", error: "setModel: Reasoning effort \"max\" is not supported" });
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("mailbox");
    // 真正的行动项进回执（旧实现只有 wake-disabled + takenOver 注）。
    expect(res.note).toContain("member-state:failed");
    expect(res.note).toContain("member-add");
    expect(res.note).not.toContain("wake-disabled");
    expect(res.note).not.toContain("takenOver");
    const skip = readEngineEvents().find((e) => e["event"] === "wake-skipped");
    expect(skip).toBeDefined();
    expect(skip!["memberState"]).toBe("failed");
    expect(String(skip!["reason"])).not.toContain("wake-disabled");
    expect(skip!["takenOver"]).toBeUndefined();
  });

  it("【W2 锚点】removed ∧ sessionId=\"\" → member-state:removed（改派指引），不出现 wake-disabled", async () => {
    await seedTeam({ state: "removed", sessionId: "", stopReason: "member-stop" });
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("member-state:removed");
    expect(res.note).toContain("改派");
    expect(res.note).not.toContain("wake-disabled");
    expect(readEngineEvents().find((e) => e["event"] === "wake-skipped")!["memberState"]).toBe("removed");
  });

  it("【W2 锚点】failed 成员的跳过路径不落唤醒票据（15min 在途标记不挡后续重供给）", async () => {
    await seedTeam({ state: "failed", sessionId: "" });
    await attemptWake(baseReq({ spawn: spawnOk() }));
    const wakeDir = join(root, "registry", "wake");
    expect(existsSync(wakeDir) ? require("node:fs").readdirSync(wakeDir) : []).toEqual([]);
  });

  it("【硬回归】provisioning 成员 → 仍是 member-state:provisioning（v0.9.6 R1③ 行为不减）", async () => {
    await seedTeam({ state: "provisioning", sessionId: "" });
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("member-state:provisioning");
  });

  it("【硬回归】正常成员（ready ∧ 无头持有者）→ 照常 wake（门控上移不误伤活成员）", async () => {
    await seedTeam({ state: "ready" });
    await seedHeadlessHolder("sess_b");
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("wake");
    expect(res.startConfirmed).toBe(true);
    expect(res.wakeTiers).toEqual({ spawnOk: "ok", childAlive: "ok", consumed: "pending" });
  });

  it("【硬回归】交互式成员（self 标）+ 显式关闭唤醒 → 仍是 wake-disabled（分层闸语义不减）", async () => {
    await seedTeam({ state: "ready", identity: "self" });
    const res = await attemptWake(baseReq({ spawn: spawnOk(), env: { XC_WAKE_ENABLED: "false" } }));
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("wake-disabled");
    const skip = readEngineEvents().find((e) => e["event"] === "wake-skipped");
    expect(skip).toBeDefined();
    expect(skip!["memberState"]).toBeUndefined(); // 未被成员状态门控抢先
  });

  it("【硬回归】团队不存在 → 放行到分层闸（成员状态门控不拦截不在册目标）", async () => {
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("wake-disabled");
  });

  it("孤儿票在场 + failed 成员 → 仍是 member-state:failed（不误标 inflight-nonce，V095-23 回归）", async () => {
    await seedTeam({ state: "failed", sessionId: "" });
    const { token } = await createWakeNonce(root, {
      teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now() - 5_000,
      issuedToSid: "sess_b", name: "b",
    });
    const file = wakeLifecycleFile(root, "b", Date.now() - 5_000);
    mkdirSync(dirname(file), { recursive: true });
    require("node:fs").appendFileSync(
      file,
      `${JSON.stringify({ ts: Date.now() - 5_000, event: "wake-child-start", sid: "sess_b", to: "b" })}\n`,
    );
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.note).toContain("member-state:failed");
    expect(res.note).not.toContain("inflight-nonce");
    expect(token.startsWith("wake-") || token.length > 0).toBe(true);
  });
});
