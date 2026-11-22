/**
 * v0.9.5（A3/V094-14）：xc_overview 的 offlineMembers 挂载接 **pid 证据**定向测试。
 *
 * V094-14 实测形态（ws4r2）：成员先 claim 任务、宿主被杀、**不启看门狗**——成员行
 * state:dead（memberLivenessView 现场派生 pid 证据）、任务行 claimed by m1、
 * payload.offlineMembers 缺席且无 `Offline:` 行——三面自相矛盾。修法：挂载面按成员
 * 派生会话记录 pid 证据（deriveSessionPidEvidence 单一派生点）注入 offlineMembers。
 *
 * 方案验收原文：「dead 成员的 fresh 任务 → offlineMembers 列出 + 回池通知」。
 * 挂载面 harness 与 overview-offline-mount.test.ts 同款（peer 根指向临时目录）。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolCore, type ToolDeps } from "./core.js";
import { createTeamOverviewCore } from "./tools-overview.js";
import { writeSession, refreshSessionLastSeen } from "../core/registry.js";
import { payloadOf, type ToolResult } from "./protocol.js";

/** 一个确定不存在的 pid（pidAlive → ESRCH → false）：进程死硬证据。 */
const DEAD_PID = 2_147_483_644;

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;
let core: ReturnType<typeof createToolCore>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-off-mount-a3-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true });
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } };
  core = createToolCore(deps);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function register(name: string, sid: string, conn: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  const res = await core.xc_register({ name, sessionId: sid }, conn);
  expect(res.isError, JSON.stringify(payloadOf(res))).toBeFalsy();
}

/** 派一单给 to 并让其认领 + 推进到 in_progress（fresh 在途任务，远未到 stale/阈值）。 */
async function dispatchAndClaim(conn: string, to: string, memberConn: string): Promise<string> {
  const d = await core.xc_dispatch({ to, title: "T", prompt: "P" }, conn);
  expect(d.isError, JSON.stringify(payloadOf(d))).toBeFalsy();
  const taskId = payloadOf(d)["taskId"] as string;
  const claim = await core.xc_claim({ taskId }, memberConn);
  expect(claim.isError, JSON.stringify(payloadOf(claim))).toBeFalsy();
  const attemptId = payloadOf(claim)["attemptId"] as string;
  const started = await core.xc_report({ taskId, attemptId, status: "in_progress" }, memberConn);
  expect(started.isError, JSON.stringify(payloadOf(started))).toBeFalsy();
  return taskId;
}

async function overview(): Promise<{ payload: Record<string, unknown>; text: string; memberRows: Array<Record<string, unknown>> }> {
  const result = await createTeamOverviewCore(deps).xc_status({}, "conn-overview");
  const payload = payloadOf(result) as Record<string, unknown>;
  const text = (result.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
  const members = (payload["members"] as Array<Record<string, unknown>> | undefined) ?? [];
  return { payload, text, memberRows: members };
}

describe("v0.9.5 A3/V094-14：offlineMembers 挂载接 pid 证据（无 peer 记录的崩溃成员）", () => {
  it("【方案验收】成员崩溃（无 peer 记录 + 会话记录 pid 亡 + running 自述悬停）+ fresh 任务 → offlineMembers 列出 + Offline 行", async () => {
    await register("a", "sess-a3-a", "conn-a3-a");
    await register("m1", "sess-a3-m1", "conn-a3-m1");
    const taskId = await dispatchAndClaim("conn-a3-a", "m1", "conn-a3-m1");
    // 崩溃形态：宿主 pid 亡 + running 自述悬停（无 Stop 钩子）；**不留 peer 记录**
    //（引擎成员从未 peer 注册 / 干净摘除——V094-14 的 pid-only 证据形态）。
    await refreshSessionLastSeen(stateRoot, "sess-a3-m1", {
      now: Date.now(), liveness: "running", pid: DEAD_PID,
    });

    const { payload, text, memberRows } = await overview();
    // 三面一致：成员行 liveness.state=dead（与 offlineMembers 块同判据，V094-14 矛盾收口）
    const row = memberRows.find((m) => m["key"] === "m1") as { liveness?: { state?: string } } | undefined;
    expect(row?.liveness?.state).toBe("dead");
    // 离线清单列出（旧实现：payload.offlineMembers 缺席、无 Offline: 行）
    const members = payload["offlineMembers"] as Array<Record<string, unknown>> | undefined;
    expect(members).toHaveLength(1);
    expect(members![0]).toMatchObject({
      key: "m1",
      liveness: "pid-dead",
      evidence: "process-dead",
      sessionId: "sess-a3-m1",
    });
    const hitTask = (members![0]!["tasks"] as Array<{ taskId: string; status: string; requeueAtMs?: number }>)[0]!;
    expect(hitTask).toMatchObject({ taskId, status: "in_progress" });
    // v0.9.6（A8/V095-21）：挂载注入 stale 阈值 → 命中任务带待回池的预计回池时刻
    expect(typeof hitTask.requeueAtMs).toBe("number");
    // 回池通知行（建议 xc_dispatch 重派）+ V095-21 待回池标注（与 payload 同一时刻）
    expect(text).toContain(
      `Offline: m1(process-dead, 名下任务 1 个：待回池 ${taskId}@${new Date(hitTask.requeueAtMs!).toISOString()} → 建议 xc_dispatch 重派)`,
    );
  });
});
