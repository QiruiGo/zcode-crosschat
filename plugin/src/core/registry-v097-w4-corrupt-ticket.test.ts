/**
 * v0.9.7（W4/V096-02）定向测试：**坏唤醒票守卫**（47-v097 方案 §一 组 W W4）。
 *
 * 缺陷形态（adv-1 F-2 实测）：`registry/wake/` 里一个不可解析的 JSON 票据文件令
 * {@link readWakeNonce} 的 `JSON.parse` 抛 SyntaxError → 三个扫描点
 * （{@link findLiveInflightWakeNonce} / {@link consumeWakeTicketForSession} /
 * {@link revokeWakeNonceForProvisionFailure}）全部上抛 → **所有** dispatch 与 relay
 * 整单报 opaque internal（无自愈、无诊断、不知是哪个文件坏）。
 *
 * 本文件覆盖：
 * 1. readWakeNonce：坏票 → undefined（跳过）+ 审计 `wake-ticket-corrupt{path}` 指向坏文件；
 * 2. 好票不受影响（坏票不掩盖真票；其余票据照常参与判定）；
 * 3. findLiveInflightWakeNonce：坏票在场 + 好票在途 → 仍正确去重（不抛）；
 * 4. consumeWakeTicketForSession（钩子面扫描点）：坏票 → 跳过，好票照常消费；
 * 5. revokeWakeNonceForProvisionFailure（供给失败回收面）：坏票 → 不回收 + 同口径审计；
 * 6. dispatch 端到端：坏票在场 → dispatch 正常（不 internal）+ 审计指向坏文件。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  consumeWakeNonce,
  consumeWakeTicketForSession,
  createWakeNonce,
  readWakeNonce,
  writeSession,
} from "../core/registry.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { engineLogFile, wakeDir, wakeFile } from "../core/paths.js";
import {
  attemptWake,
  findLiveInflightWakeNonce,
  revokeWakeNonceForProvisionFailure,
  wakeNonceDigest,
} from "../engine/wake.js";
import type { SpawnResumeOptions, SpawnResumeResult } from "../engine/resume-cli.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-v097-w4-corrupt-"));
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
  const file = engineLogFile(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 放一个坏 JSON 票（半行截断 = 真实世界最常见的写坏形态）。 */
function plantCorruptTicket(token: string): string {
  const dir = wakeDir(root);
  mkdirSync(dir, { recursive: true });
  const file = wakeFile(root, token);
  appendFileSync(file, '{"token":"wake-broken","teamId":"default","agentKe');
  return file;
}

/** 放一个合法但形状不完整的票（coerceWakeNonce 宽容面：不抛、按 undefined 跳过）。 */
function plantIllShapedTicket(token: string): string {
  const dir = wakeDir(root);
  mkdirSync(dir, { recursive: true });
  appendFileSync(wakeFile(root, token), JSON.stringify({ hello: "world" }));
  return wakeFile(root, token);
}

async function issueTicket(input: { agentKey?: string; sid?: string; now: number }): Promise<string> {
  const agentKey = input.agentKey ?? "b";
  const { token } = await createWakeNonce(root, {
    teamId: "default",
    agentKey,
    sid: input.sid ?? "sess_b",
    now: input.now,
    issuedToSid: input.sid ?? "sess_b",
    name: agentKey,
  });
  return token;
}

async function seedTeam(memberState: "ready" | "failed" = "ready"): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
  team.members.push({
    key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1,
    identity: "engine", state: memberState,
  });
  await writeTeam(root, team);
  await writeSession(root, { sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: 1, boundName: "b" });
}

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

function baseReq() {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "dispatch",
    receiptIds: [],
    ticket: "计算 17*23",
    env: {},
    cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
    capacitySample: greenCapacity,
    watchWindowMs: 0,
    limboTimeoutMs: 3_600_000,
    wakeSlowMs: 3_600_000,
    fakeSuccessMs: 3_600_000,
    lifecycleWindowMs: 100,
    spawn: spawnOk(),
  };
}

describe("v0.9.7 W4：坏票守卫（readWakeNonce）", () => {
  it("【W4 锚点】坏 JSON 票 → 跳过（undefined）+ 审计 wake-ticket-corrupt{path} 指向坏文件", async () => {
    const file = plantCorruptTicket("wake-broken");
    expect(await readWakeNonce(root, "wake-broken")).toBeUndefined();
    const events = readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt");
    expect(events).toHaveLength(1);
    expect(events[0]!["path"]).toBe(file); // 指向坏文件本体（运维可直读定位）
    expect(String(events[0]!["error"]).length).toBeGreaterThan(0);
  });

  it("【W4 锚点】坏票不掩盖好票（同目录好票照常可读）", async () => {
    plantCorruptTicket("wake-broken");
    const good = await issueTicket({ now: Date.now() });
    expect(await readWakeNonce(root, good)).toBeDefined();
    expect(await readWakeNonce(root, "wake-broken")).toBeUndefined();
  });

  it("形状非法的合法 JSON（coerce 面）→ 仍按 undefined 跳过，不记 corrupt 审计", async () => {
    plantIllShapedTicket("wake-weird");
    expect(await readWakeNonce(root, "wake-weird")).toBeUndefined();
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt")).toHaveLength(0);
  });

  it("票据不存在 → undefined（ENOENT 语义不变，无审计）", async () => {
    expect(await readWakeNonce(root, "no-such-token")).toBeUndefined();
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt")).toHaveLength(0);
  });
});

describe("v0.9.7 W4：三个扫描点同口径（坏票不整单 internal）", () => {
  it("【W4 锚点】findLiveInflightWakeNonce：坏票在场 → 不抛，好票在途判据照常", async () => {
    await seedTeam();
    plantCorruptTicket("wake-broken");
    const live = await issueTicket({ now: Date.now() - 2_000 });
    // 宽限窗内的刚签发票 → 在途（坏票被跳过，不影响本判据）。
    const found = await findLiveInflightWakeNonce(root, "b", { teamId: "default", now: Date.now() });
    expect(found?.token).toBe(live);
  });

  it("【W4 锚点】consumeWakeTicketForSession（钩子面）：坏票跳过，好票照常一次性消费", async () => {
    plantCorruptTicket("wake-broken");
    const good = await issueTicket({ sid: "sess_hook", now: Date.now() });
    const consumed = await consumeWakeTicketForSession(root, { sid: "sess_hook", now: Date.now() });
    expect(consumed?.token).toBe(good);
    // 一次性：第二次无命中。
    expect(await consumeWakeTicketForSession(root, { sid: "sess_hook", now: Date.now() })).toBeUndefined();
    // 每次扫描读到坏票都记一条（两次调用 = 两条），全部指向同一个坏文件。
    const events = readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e["path"] === wakeFile(root, "wake-broken"))).toBe(true);
  });

  it("【W4 锚点】revokeWakeNonceForProvisionFailure（回收面）：坏票 → 不回收 + 同口径审计", async () => {
    plantCorruptTicket("wake-broken");
    const outcome = await revokeWakeNonceForProvisionFailure(root, "wake-broken", {
      teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now(),
    });
    expect(outcome).toEqual({ revoked: false, alreadyUsed: false, digest: wakeNonceDigest("wake-broken") });
    const events = readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt");
    expect(events).toHaveLength(1);
    expect(events[0]!["path"]).toBe(wakeFile(root, "wake-broken"));
  });

  it("【W4 锚点】attemptWake 端到端：坏票在场 → 唤醒判定照常（不 internal）", async () => {
    await seedTeam();
    plantCorruptTicket("wake-broken");
    const res = await attemptWake(baseReq());
    // 坏票被跳过、无其他在途票 → 正常走到 wake（旧实现在此整单抛 SyntaxError）。
    expect(res.delivered).toBe("wake");
    expect(res.startConfirmed).toBe(true);
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt")).toHaveLength(1);
  });

  it("【硬回归】坏票 + 真在途票（lifecycle start 无 exit）→ 仍去重（守卫不放松去重语义）", async () => {
    await seedTeam();
    plantCorruptTicket("wake-broken");
    const token = await issueTicket({ now: Date.now() - 2_000 });
    const { wakeLifecycleFile } = await import("../core/paths.js");
    const file = wakeLifecycleFile(root, "b", Date.now() - 2_000);
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({ ts: Date.now() - 2_000, event: "wake-child-start", nonce: wakeNonceDigest(token), sid: "sess_b", to: "b" })}\n`,
    );
    const res = await attemptWake(baseReq());
    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("inflight-nonce");
  });
});
