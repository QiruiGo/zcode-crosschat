/**
 * v0.9.5（A5/A6）定向测试：**重试轮计数/归属**与**票据签发字段**
 * （41-v095 方案 §一 组A A5 + A6）。
 *
 * A5（V094-08）：sessionNotFound 自动重试轮的 startWakeLifecycleWatch 未传 receiptIds
 * → 第三级消费检测（以 receiptIds 非空为硬门槛）永远不触发；实际消费被原轮（已判失败
 * attempt）的监视器记账 → 一次成功消费计 2×spawn-ok + 2×child-alive + 1×consumed 且
 * consumed 的 nonce 属原始失败 attempt。修法：重试轮传 receiptIds + 重试 spawn 成功后
 * markSuperseded 原轮监视器（只保留 ① exit 尾行）。
 * 方案验收原文：「一次成功消费计 spawn-ok 2 / child-alive 2 / consumed 1 且 nonce 属重试」。
 *
 * A6（V094-05）：attemptWake 签发点补 issuedToSid/name——「字段在真实 attemptWake 票据
 * 非空」（验收原文）；prompt 身份行按 ppid 采纳档分流（默认档 = wakeToken 自证，A1）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMailbox, createMessage, markMailboxConsumed } from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { writeSession, readWakeNonce } from "../core/registry";
import type { TeamMember } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import { attemptWake, type WakeRequest } from "./wake.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v095-"));
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

type CapturedSpawn = SpawnResumeOptions;

function spawnThenLog(captured: CapturedSpawn[], delayMs: number, line: string | null): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    captured.push(opts);
    if (line !== null) {
      setTimeout(() => {
        mkdirSync(dirname(opts.logFile), { recursive: true });
        appendFileSync(opts.logFile, line + "\n");
      }, delayMs);
    }
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
    receiptIds: ["m1"],
    ticket: "计算 17*23",
    env: { XC_WAKE_ENABLED: "false" }, // 引擎成员免开关（分层），与 v090 锚点同形
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    ...overrides,
  };
}

async function seedTeam(): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
  const member: TeamMember = {
    key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1,
    identity: "engine",
  };
  team.members.push(member);
  await writeTeam(root, team);
}

async function seedSessionRecord(sessionId: string): Promise<void> {
  // boundName 必写：engine 成员免开关的判据是「当前 sid 记录带本名 boundName」
  //（member-add 供给代写形态，V090-04 口径）——与 wake-v090 锚点同形。
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen: 1, boundName: "b" });
}

async function seedMailbox(): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "计算 17*23", { deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

function waitUntil(check: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (check()) resolve(true);
      else if (Date.now() > deadline) resolve(false);
      else setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe("v0.9.5 A6：attemptWake 票据签发字段（issuedToSid/name 非空）", () => {
  it("【验收锚点】真实 attemptWake 票据 issuedToSid=sid ∧ name=agentKey（V094-05 死字段收口）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 100,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => ({ pid: 4242, logFile: opts.logFile }),
    }));
    expect(res.delivered).toBe("wake");
    expect(res.nonce).toBeDefined();
    const nonce = await readWakeNonce(root, res.nonce!);
    expect(nonce?.issuedToSid).toBe("sess_b");
    expect(nonce?.name).toBe("b");
    expect(nonce?.voiceOwner).toBe("sess_b");
  });

  it("【A1】默认档 prompt：身份行写 wakeToken 自证路径，不写「已自动绑定/不要再调 xc_identify」", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    let capturedPrompt = "";
    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 100,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        capturedPrompt = opts.prompt;
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(capturedPrompt).toContain("先用 wakeToken 填");
    expect(capturedPrompt).toContain("调一次 xc_identify");
    expect(capturedPrompt).not.toContain("不要再调 xc_identify");
    expect(capturedPrompt).not.toContain("身份已由引擎在会话启动时自动绑定");
  });

  it("【A1】开启档（XC_ADOPT_BY_PPID=1）prompt：保留 v0.9.4「已自动绑定」口径", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    let capturedPrompt = "";
    await attemptWake(baseReq({
      env: { XC_WAKE_ENABLED: "false", XC_ADOPT_BY_PPID: "1" },
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 100,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        capturedPrompt = opts.prompt;
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(capturedPrompt).toContain("身份已由引擎在会话启动时自动绑定");
    expect(capturedPrompt).toContain("不要再调 xc_identify");
    expect(capturedPrompt).toContain('wakeToken 填'); // 兜底路径仍在
  });
});

describe("v0.9.5 A5：重试轮 receiptIds + consumed 归属重试 nonce", () => {
  it("【验收锚点】sessionNotFound → 重试成功 → 成员消费 → spawn-ok 2 / consumed 1 且 consumed 的 nonce 属重试轮", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 2000,
      watchPollMs: 20,
      lifecyclePollMs: 20,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 30_000,
      spawn: spawnThenLog(captured, 60, "Error: Session not found: sess_b"),
    }));
    expect(res.delivered).toBe("wake");

    // 重试恰一次（G-8 既有口径）
    const sawRetry = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-retry"));
    expect(sawRetry).toBe(true);
    expect(captured).toHaveLength(2);
    const retryEvent = readEngineEvents().find((e) => e["event"] === "wake-retry")!;
    const retryNonceDigest = String(retryEvent["nonce"]);
    const originalEvent = readEngineEvents().find((e) => e["event"] === "wake")!;
    const originalNonceDigest = String(originalEvent["nonce"]);
    expect(retryNonceDigest).not.toBe(originalNonceDigest);

    // 成员实际消费本批消息（consumedAt 回写）
    await markMailboxConsumed(root, "default", "b", [messageId]);

    // 第三级指标恰一条，且 nonce 属**重试轮**（V094-08：旧实现归原始失败 attempt）
    const sawConsumed = await waitUntil(() => readEngineEvents().filter((e) => e["event"] === "wake-consumed").length >= 1);
    expect(sawConsumed).toBe(true);
    // 给原轮监视器（已 superseded）留一拍：确认不会补记第二笔
    await new Promise((r) => setTimeout(r, 400));
    const consumedEvents = readEngineEvents().filter((e) => e["event"] === "wake-consumed");
    expect(consumedEvents).toHaveLength(1); // consumed 1（不是 2）
    expect(String(consumedEvents[0]!["nonce"])).toBe(retryNonceDigest); // 归属重试 nonce
    expect(String(consumedEvents[0]!["nonce"])).not.toBe(originalNonceDigest);
    expect((consumedEvents[0]!["receiptIds"] as string[])).toEqual([messageId]);

    // 一级/二级漏斗：spawn-ok 2（原始 + 重试）
    const spawnOkEvents = readEngineEvents().filter((e) => e["event"] === "wake-spawn-ok");
    expect(spawnOkEvents).toHaveLength(2);
    expect(spawnOkEvents.filter((e) => e["retried"] === true)).toHaveLength(1);
  });

  it("重试 spawn 失败（retry-spawn 抛错）→ 原轮监视器不被压制（superseded 不置位），consumed 可仍归原轮（失败路径不为 A5 而丢账）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    let calls = 0;
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 2000,
      watchPollMs: 20,
      lifecyclePollMs: 20,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      fakeSuccessMs: 3_600_000,
      lifecycleWindowMs: 30_000,
      spawn: (opts: SpawnResumeOptions): SpawnResumeResult => {
        calls += 1;
        captured.push(opts);
        if (calls === 1) {
          setTimeout(() => {
            mkdirSync(dirname(opts.logFile), { recursive: true });
            appendFileSync(opts.logFile, "Error: Session not found: sess_b\n");
          }, 40);
        } else {
          throw new Error("retry spawn boom");
        }
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    const sawFailed = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-retry-failed"));
    expect(sawFailed).toBe(true);
    // 失败路径：原轮监视器未被接管（重试没起来）——成员若此后消费，账仍落（原轮记账）
    await markMailboxConsumed(root, "default", "b", [messageId]);
    const sawConsumed = await waitUntil(() => readEngineEvents().filter((e) => e["event"] === "wake-consumed").length >= 1);
    expect(sawConsumed).toBe(true);
    const consumedEvents = readEngineEvents().filter((e) => e["event"] === "wake-consumed");
    expect(consumedEvents).toHaveLength(1);
    // 原轮 nonce（wake 事件的 nonce 摘要）——失败路径的归属保持旧口径
    const originalNonceDigest = String(readEngineEvents().find((e) => e["event"] === "wake")!["nonce"]);
    expect(String(consumedEvents[0]!["nonce"])).toBe(originalNonceDigest);
  });
});
