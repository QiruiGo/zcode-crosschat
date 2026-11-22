/**
 * v0.9.6（R1）定向测试：**孤儿唤醒票压制派单**三件套（44-v096 方案 §一 组 R R1）。
 *
 * 缺陷形态（41-v095 real-smoke A §三）：member-add 失败尝试签发的未消费票据成为孤儿
 * nonce → 其后 15 分钟内 dispatch 全被 wake-skipped(inflight-nonce) 压制——只落邮箱、
 * 成员 idle 无人 pull、任务永久 pending。
 *
 * 修法三件套的回归锚点：
 * ① findLiveInflightWakeNonce 只认「有活体证据」的在途票（lifecycle 有本票据的 start
 *    证据且无 exit，或票据在短宽限窗内）——孤儿票不再压制派单；**硬回归：正常在途票
 *    仍去重**（方案 §二-5「R1 修复不得牺牲现有 wake 去重语义」）。
 * ② revokeWakeNonceForProvisionFailure 显式回收（used+revoked 落盘 + wake-nonce-revoked
 *    审计 + 不可再消费）。
 * ③ 闸序：成员状态门控（provisioning/failed/removed）先于 inflight 去重——failed/removed
 *    成员的 dispatch 给出明确原因/改派指引，不再被孤儿票误标 inflight-nonce（含 V095-23）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createWakeNonce, consumeWakeNonce, readWakeNonce, writeSession } from "../core/registry";
import { newTeamState, writeTeam } from "../core/teamstate";
import { wakeLifecycleFile } from "../core/paths";
import type { TeamMember } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import {
  attemptWake,
  findLiveInflightWakeNonce,
  revokeWakeNonceForProvisionFailure,
  wakeNonceDigest,
  WAKE_TICKET_GRACE_MS,
  type WakeRequest,
} from "./wake.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v096-r1-"));
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
    env: { XC_WAKE_ENABLED: "false" }, // 引擎成员免开关（分层），交互式成员按默认关
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    capacitySample: greenCapacity,
    watchWindowMs: 0,
    limboTimeoutMs: 3_600_000,
    wakeSlowMs: 3_600_000,
    fakeSuccessMs: 3_600_000,
    lifecycleWindowMs: 100,
    ...overrides,
  };
}

async function seedTeam(memberOverrides: Partial<TeamMember> = {}): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
  const member: TeamMember = {
    key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1,
    identity: "engine",
    ...memberOverrides,
  };
  team.members.push(member);
  await writeTeam(root, team);
}

async function seedSessionRecord(sessionId: string): Promise<void> {
  // boundName 必写：engine 成员免开关的判据是「当前 sid 记录带本名 boundName」。
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen: 1, boundName: "b" });
}

/** 签发一张票据（可指定签发时刻），可选写 lifecycle start/exit 行。 */
async function issueTicket(input: {
  agentKey?: string;
  sid?: string;
  now: number;
  lifecycle?: "start" | "start+exit" | undefined;
}): Promise<string> {
  const agentKey = input.agentKey ?? "b";
  const { token } = await createWakeNonce(root, {
    teamId: "default",
    agentKey,
    sid: input.sid ?? "sess_b",
    now: input.now,
    issuedToSid: input.sid ?? "sess_b",
    name: agentKey,
  });
  if (input.lifecycle !== undefined) {
    const file = wakeLifecycleFile(root, agentKey, input.now);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: input.now, event: "wake-child-start", nonce: wakeNonceDigest(token), sid: "sess_b", to: agentKey })}\n`);
    if (input.lifecycle === "start+exit") {
      appendFileSync(file, `${JSON.stringify({ ts: input.now + 10, event: "wake-child-exit", pid: 9, durationMs: 10, exitCode: null, startConfirmed: false })}\n`);
    }
  }
  return token;
}

describe("v0.9.6 R1①：在途去重只认有活体证据的票据", () => {
  it("【R1 锚点】孤儿票（无 spawn 证据、过短宽限窗）→ dispatch 不再被压制（delivered=wake）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    // 41-v095 run1 形态：member-add 失败留票——签发后无任何 lifecycle 账，2 分钟前签发
    //（15min TTL 内、30s 宽限窗外）。旧实现：dispatch 被 inflight-nonce 压制 15min。
    await issueTicket({ now: Date.now() - 120_000, lifecycle: undefined });
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("wake");
    // 跳过事件里不得再出现 inflight-nonce 压制
    const skips = readEngineEvents().filter((e) => e["event"] === "wake-skipped");
    expect(skips.some((e) => String(e["reason"]).includes("inflight-nonce"))).toBe(false);
  });

  it("【硬回归】正常在途票（lifecycle start 无 exit，子进程在途）→ 仍去重（inflight-nonce）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const token = await issueTicket({ now: Date.now() - 5_000, lifecycle: "start" });
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("inflight-nonce");
    const skip = readEngineEvents().find((e) => e["event"] === "wake-skipped");
    expect(skip).toBeDefined();
    expect(skip!["inflightNonce"]).toBe(wakeNonceDigest(token));
  });

  it("【硬回归】宽限窗内的刚签发票（start 未及落盘）→ 仍去重（竞态兜底语义保留）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    await issueTicket({ now: Date.now() - 2_000, lifecycle: undefined });
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("inflight-nonce");
  });

  it("子进程已退出（start+exit）的票据 → 不算在途（死票不压制）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    await issueTicket({ now: Date.now() - 60_000, lifecycle: "start+exit" });
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("wake");
  });

  it("宽限窗边界：恰好 WAKE_TICKET_GRACE_MS 前签发的无证据票 → 不在途", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    await issueTicket({ now: Date.now() - WAKE_TICKET_GRACE_MS - 1, lifecycle: undefined });
    const inflight = await findLiveInflightWakeNonce(root, "b", { teamId: "default", now: Date.now() });
    expect(inflight).toBeUndefined();
  });

  it("别的 attempt 的 lifecycle 账不认作本票据证据（摘要不匹配 → 落宽限判据）", async () => {
    const now = Date.now() - 120_000; // 过宽限窗
    const token = await issueTicket({ now, lifecycle: undefined });
    // 同名同 ts 的账属于另一个 attempt（摘要不同）——不算本票据的活体证据
    const file = wakeLifecycleFile(root, "b", now);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: now, event: "wake-child-start", nonce: "deadbeef0000", sid: "sess_b", to: "b" })}\n`);
    const inflight = await findLiveInflightWakeNonce(root, "b", { teamId: "default", now: Date.now() });
    expect(inflight).toBeUndefined();
    expect(await readWakeNonce(root, token)).toBeDefined();
  });
});

describe("v0.9.6 R1②：供给失败票据的显式回收", () => {
  it("【R1 锚点】回收 → used+revoked 落盘 ∧ wake-nonce-revoked 审计 ∧ 不可再消费 ∧ 不再算在途", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const token = await issueTicket({ now: Date.now(), lifecycle: undefined });
    const outcome = await revokeWakeNonceForProvisionFailure(root, token, {
      teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now(),
    });
    expect(outcome.revoked).toBe(true);
    expect(outcome.digest).toBe(wakeNonceDigest(token));
    // 票据本体：used:true + revoked{reason:"provision-failed"}（原始 JSON 在盘，法证面直读）
    const raw = JSON.parse(readFileSync(join(root, "registry", "wake", `${token}.json`), "utf8")) as Record<string, unknown>;
    expect(raw["used"]).toBe(true);
    expect((raw["revoked"] as Record<string, unknown>)["reason"]).toBe("provision-failed");
    // 不可再消费（回收=作废，不是消费）
    const consumed = await consumeWakeNonce(root, token, { teamId: "default", agentKey: "b", sid: "sess_b" });
    expect(consumed).toBeUndefined();
    // 不再算在途
    const inflight = await findLiveInflightWakeNonce(root, "b", { teamId: "default", now: Date.now() });
    expect(inflight).toBeUndefined();
    // 审计事件（摘要进共享日志，真值不出状态根）
    const event = readEngineEvents().find((e) => e["event"] === "wake-nonce-revoked");
    expect(event).toBeDefined();
    expect(event!["reason"]).toBe("provision-failed");
    expect(event!["nonce"]).toBe(wakeNonceDigest(token));
  });

  it("回收后的票据不再压制 dispatch（R1 端到端：失败留票 → 立即回收 → dispatch 成功）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const token = await issueTicket({ now: Date.now(), lifecycle: undefined });
    await revokeWakeNonceForProvisionFailure(root, token, { teamId: "default", agentKey: "b", sid: "sess_b" });
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("wake");
  });

  it("幂等：已消费的票不回收（alreadyUsed）；重入回收不改盘；票不存在返回 revoked=false", async () => {
    await seedTeam();
    const { token } = await createWakeNonce(root, { teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now() });
    await consumeWakeNonce(root, token, { teamId: "default", agentKey: "b", sid: "sess_b" });
    const used = await revokeWakeNonceForProvisionFailure(root, token, { teamId: "default", agentKey: "b", sid: "sess_b" });
    expect(used).toEqual({ revoked: false, alreadyUsed: true, digest: wakeNonceDigest(token) });
    const missing = await revokeWakeNonceForProvisionFailure(root, "no-such-token", { teamId: "default", agentKey: "b", sid: "sess_b" });
    expect(missing.revoked).toBe(false);
  });
});

describe("v0.9.6 R1③：成员状态门控先于 inflight 去重（含 V095-23）", () => {
  it("【R1 锚点】failed 成员 + 孤儿票在场 → 跳过原因是 member-state:failed（含改派指引），不再误标 inflight-nonce", async () => {
    await seedTeam({ state: "failed", error: "setModel: Reasoning effort \"max\" is not supported" });
    await seedSessionRecord("sess_b");
    await issueTicket({ now: Date.now() - 5_000, lifecycle: undefined }); // 孤儿票在场
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("member-state:failed");
    expect(res.note).toContain("member-add"); // 重供给指引
    expect(res.note).not.toContain("inflight-nonce"); // 闸序倒置的误标（V095-23）不复现
    const skip = readEngineEvents().find((e) => e["event"] === "wake-skipped");
    expect(skip!["memberState"]).toBe("failed");
    expect(String(skip!["reason"])).not.toContain("inflight-nonce");
  });

  it("removed 成员 → 跳过原因是 member-state:removed（改派指引），不误标 inflight-nonce", async () => {
    await seedTeam({ state: "removed", stopReason: "member-stop" });
    await seedSessionRecord("sess_b");
    await issueTicket({ now: Date.now() - 5_000, lifecycle: undefined });
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("member-state:removed");
    expect(res.note).toContain("改派");
    expect(res.note).not.toContain("inflight-nonce");
  });

  it("provisioning 成员 → 跳过原因是 member-state:provisioning（供给完成后投产唤醒补投）", async () => {
    await seedTeam({ state: "provisioning" });
    await seedSessionRecord("sess_b");
    const res = await attemptWake(baseReq({ spawn: spawnOk() }));
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("member-state:provisioning");
  });
});
