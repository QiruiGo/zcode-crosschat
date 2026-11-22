/**
 * v0.9.8（D4/V097-12）定向测试：**readWakeNonce 的读取错误按坏票处理**。
 *
 * 缺陷形态（49-v098 方案 §二 组 D D4）：v0.9.7（W4）只把 `JSON.parse` 失败修成
 * 「跳过 + 审计」，readWakeNonce 的 readFile catch 仍**只放行 ENOENT**——票据路径被
 * 换成目录（EISDIR）、票据文件权限被收（EACCES/EPERM）等读取错误原样上抛，三个
 * 扫描点（consumeWakeTicketForSession / findLiveInflightWakeNonce /
 * revokeWakeNonceForProvisionFailure）照样整单选成 opaque internal：形态与 adv-1 F-2
 * 同族（一张问题票拖垮所有 dispatch/relay），且回执里没有指向问题文件的线索。
 *
 * 本文件覆盖：
 * 1. 票据路径是**目录**（EISDIR，真实可造）→ undefined + 审计
 *    `wake-ticket-corrupt{path,error}`（error 带 errno 与原文），不再上抛；
 * 2. 三个扫描点同口径：目录票在场 → 不抛，好票照常参与判定/回收；
 * 3. attemptWake 端到端：目录票在场 → 唤醒判定照常（不 internal）+ 审计指向文件；
 * 4. ENOENT 语义不变（真缺席无审计）；
 * 5. 坏 JSON（v0.9.7 W4 既有行为）不回退：仍 undefined + 审计。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
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
  root = mkdtempSync(join(tmpdir(), "xc-v098-d4-readerr-"));
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

/** 把票据路径造成一个**目录**（readFile → EISDIR；Windows/POSIX 同形）。 */
function plantDirectoryTicket(token: string): string {
  const dir = wakeDir(root);
  mkdirSync(dir, { recursive: true });
  const file = wakeFile(root, token);
  mkdirSync(file, { recursive: true });
  return file;
}

/** 放一个坏 JSON 票（v0.9.7 W4 既有形态，防回归）。 */
function plantCorruptTicket(token: string): string {
  const dir = wakeDir(root);
  mkdirSync(dir, { recursive: true });
  const file = wakeFile(root, token);
  appendFileSync(file, '{"token":"wake-broken","teamId":"default","agentKe');
  return file;
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

describe("v0.9.8 D4：readWakeNonce 的读取错误按坏票处理（不再整单 internal）", () => {
  it("【D4 锚点】票据路径是目录（EISDIR）→ undefined（不抛）+ 审计 wake-ticket-corrupt{path,error}", async () => {
    const file = plantDirectoryTicket("wake-dir-ticket");
    // 旧实现在此原样上抛 EISDIR → 三个扫描点整单 internal。
    await expect(readWakeNonce(root, "wake-dir-ticket")).resolves.toBeUndefined();
    const events = readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt");
    expect(events).toHaveLength(1);
    expect(events[0]!["path"]).toBe(file); // 指向问题文件本体（运维可直读定位）
    expect(String(events[0]!["error"])).toContain("EISDIR"); // errno 与原文都在
    expect(events[0]!["reason"]).toBe("read-failed"); // 与坏 JSON（parse-failed）可分辨
  });

  it("【D4 锚点】consumeWakeTicketForSession（钩子面扫描点）：目录票跳过，好票照常一次性消费", async () => {
    plantDirectoryTicket("wake-dir-ticket");
    const good = await issueTicket({ sid: "sess_hook", now: Date.now() });
    const consumed = await consumeWakeTicketForSession(root, { sid: "sess_hook", now: Date.now() });
    expect(consumed?.token).toBe(good);
    expect(await consumeWakeTicketForSession(root, { sid: "sess_hook", now: Date.now() })).toBeUndefined();
    const events = readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e["path"] === wakeFile(root, "wake-dir-ticket"))).toBe(true);
  });

  it("【D4 锚点】findLiveInflightWakeNonce：目录票在场 → 不抛，好票在途判据照常", async () => {
    await seedTeam();
    plantDirectoryTicket("wake-dir-ticket");
    const live = await issueTicket({ now: Date.now() - 2_000 });
    const found = await findLiveInflightWakeNonce(root, "b", { teamId: "default", now: Date.now() });
    expect(found?.token).toBe(live);
  });

  it("【D4 锚点】revokeWakeNonceForProvisionFailure（回收面）：目录票 → 不回收、不抛（同口径不 internal）", async () => {
    plantDirectoryTicket("wake-dir-ticket");
    const outcome = await revokeWakeNonceForProvisionFailure(root, "wake-dir-ticket", {
      teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now(),
    });
    expect(outcome).toEqual({ revoked: false, alreadyUsed: false, digest: wakeNonceDigest("wake-dir-ticket") });
    // 边界（如实声明）：回收面在 engine/wake.ts 里有**自带的** readFile 读取器（为保留
    // 票据上的未知字段而整文件读），其 catch 对一切读取错误静默返回「无可回收」——
    // 不抛、不 internal（本验收点），但不落 wake-ticket-corrupt 审计。审计对齐属
    // wake.ts 文件域（组 S），本组不越域修改；readWakeNonce 本体（三个扫描点的公共
    // 读取面）已按坏票审计，见上方锚点例。
  });

  it("【D4 锚点】attemptWake 端到端：目录票在场 → 唤醒判定照常（不 internal）+ 审计指向文件", async () => {
    await seedTeam();
    plantDirectoryTicket("wake-dir-ticket");
    const res = await attemptWake(baseReq());
    expect(res.delivered).toBe("wake");
    expect(res.startConfirmed).toBe(true);
    const events = readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e["path"] === wakeFile(root, "wake-dir-ticket"))).toBe(true);
  });

  it("【硬回归】ENOENT 语义不变：票据真缺席 → undefined，无审计", async () => {
    expect(await readWakeNonce(root, "no-such-token")).toBeUndefined();
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt")).toHaveLength(0);
  });

  it("【硬回归】坏 JSON（v0.9.7 W4 既有行为）不回退：undefined + 审计 parse-failed", async () => {
    const file = plantCorruptTicket("wake-broken");
    expect(await readWakeNonce(root, "wake-broken")).toBeUndefined();
    const events = readEngineEvents().filter((e) => e["event"] === "wake-ticket-corrupt");
    expect(events).toHaveLength(1);
    expect(events[0]!["path"]).toBe(file);
    expect(events[0]!["reason"]).toBe("parse-failed");
  });

  it("【硬回归】目录票不掩盖好票（同目录好票照常可读、在途判定不受扰）", async () => {
    plantDirectoryTicket("wake-dir-ticket");
    const good = await issueTicket({ now: Date.now() });
    expect(await readWakeNonce(root, good)).toBeDefined();
    expect(await readWakeNonce(root, "wake-dir-ticket")).toBeUndefined();
  });
});
