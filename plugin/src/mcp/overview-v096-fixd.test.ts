/**
 * v0.9.6（组 D·A8/V095-21）定向测试：死亡成员任务的「四面一致」——
 * ① xc_overview team 视图板面任务行（requeuePending/requeueAtMs）；
 * ② xc_overview Offline 行（offlineMembers[].tasks[].requeueAtMs + 行内「待回池 @ISO」）；
 * ④ 死亡告警文案（watchdog member-dead urgent：待回池 + requeueAtMs 指针）。
 * （③ handoff 待回池面在 tools-read-v096-fixd.test.ts，跨面一致性在其内对拍。）
 *
 * V095-21 实测（adv4-f0）：杀成员后 ≤stale 阈值的冻结窗内——overview 建议重派 /
 * team.json 任务仍 claimed / handoff 待领池空 / 文案「已回池」四面矛盾。修法：四面统一
 * 显示「待回池 + 回池时刻」（updatedAt + stale 阈值，graph.staleTasks 同判据）。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolCore, type ToolDeps } from "./core.js";
import { createTeamOverviewCore } from "./tools-overview.js";
import { sweepMembersOnce, type WatchdogDeps } from "../engine/watchdog.js";
import { writeSession, refreshSessionLastSeen } from "../core/registry.js";
import { readFileSync, existsSync } from "node:fs";
import { payloadOf, type ToolResult } from "./protocol.js";

/** 一个确定不存在的 pid（pidAlive → ESRCH → false）：进程死硬证据。 */
const DEAD_PID = 2_147_483_644;

interface BoardTask {
  id: string;
  status: string;
  assignee: string | null;
  updatedAt: number;
  requeuePending?: boolean;
  requeueAtMs?: number;
}

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;
let core: ReturnType<typeof createToolCore>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-fixd-overview-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true });
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } };
  core = createToolCore(deps);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function register(name: string, sid: string, conn: string, opts: { pid?: number } = {}): Promise<void> {
  await writeSession(stateRoot, {
    sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now(),
    ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
  });
  const res = await core.xc_register({ name, sessionId: sid }, conn);
  expect(res.isError, JSON.stringify(payloadOf(res))).toBeFalsy();
}

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

async function overview(): Promise<{ payload: Record<string, unknown>; text: string }> {
  const result: ToolResult = await createTeamOverviewCore(deps).xc_status({}, "conn-overview");
  const payload = payloadOf(result) as Record<string, unknown>;
  const text = (result.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
  return { payload, text };
}

describe("v0.9.6 A8/V095-21：死亡成员任务的四面一致（板面行 / Offline 行 / 死亡文案）", () => {
  it("【方案验收锚点】杀成员后（任务仍 in_progress 冻结）：板面行 requeuePending+requeueAtMs、Offline 行同刻、死亡文案同口径", async () => {
    await register("a", "sess-a", "conn-a", { pid: process.pid });
    await register("m1", "sess-m1", "conn-m1");
    const taskId = await dispatchAndClaim("conn-a", "m1", "conn-m1");
    // 杀成员：宿主 pid 亡 + running 自述悬停（无 Stop 钩子）——三视图判死形态
    await refreshSessionLastSeen(stateRoot, "sess-m1", { now: Date.now(), liveness: "running", pid: DEAD_PID });

    // 面①②：板面行与 Offline 行同口径（同一 updatedAt + stale 阈值）
    const { payload, text } = await overview();
    const boardTasks = payload["tasks"] as BoardTask[];
    const row = boardTasks.find((t) => t.id === taskId)!;
    expect(row.status).toBe("in_progress"); // 冻结窗内未回池（team.json 视图如实）
    expect(row.requeuePending).toBe(true);
    expect(typeof row.requeueAtMs).toBe("number");

    const offline = payload["offlineMembers"] as Array<{ key: string; tasks: Array<{ taskId: string; requeueAtMs?: number }> }>;
    expect(offline).toHaveLength(1);
    const offlineTask = offline[0]!.tasks.find((t) => t.taskId === taskId)!;
    // 四面同刻：板面行与 Offline 行的回池时刻逐字节一致
    expect(offlineTask.requeueAtMs).toBe(row.requeueAtMs);
    // Offline 文本行带「待回池 @ISO」
    expect(text).toContain(`待回池 ${taskId}@${new Date(row.requeueAtMs!).toISOString()}`);

    // 面④：看门狗死亡告警文案同口径（待回池 + requeueAtMs 指针）
    const watchdog = await sweepMembersOnce({ stateRoot, workspace: workDir, env: deps.env } as WatchdogDeps);
    expect(watchdog.dead).toEqual(["m1"]);
    const mailFile = join(stateRoot, "teams", "default", "inbox", "a.jsonl");
    expect(existsSync(mailFile)).toBe(true);
    const mail = readFileSync(mailFile, "utf8");
    expect(mail).toContain("进程已亡");
    expect(mail).toContain("待回池");
    expect(mail).toContain("requeueAtMs");
    expect(mail).not.toContain("名下任务请用 xc_overview 核对后用 xc_dispatch 重派");
  });

  it("负例：活成员的在途任务 / 已回池的无属主任务 → 板面行不带 requeuePending（形状不变）", async () => {
    await register("a", "sess-a", "conn-a", { pid: process.pid });
    await register("m2", "sess-m2", "conn-m2");
    const live = await dispatchAndClaim("conn-a", "m2", "conn-m2");
    // 再派一单留在待领池（pending、无属主）
    const d = await core.xc_dispatch({ to: "m2", title: "P2", prompt: "P" }, "conn-a");
    expect(d.isError, JSON.stringify(payloadOf(d))).toBeFalsy();
    const pendingId = payloadOf(d)["taskId"] as string;

    const { payload } = await overview();
    const rows = payload["tasks"] as BoardTask[];
    const liveRow = rows.find((t) => t.id === live)!;
    expect(liveRow.requeuePending).toBeUndefined();
    expect(liveRow.requeueAtMs).toBeUndefined();
    const pendingRow = rows.find((t) => t.id === pendingId)!;
    expect(pendingRow.requeuePending).toBeUndefined();
    expect(payload["offlineMembers"]).toBeUndefined();
  });

  it("XC_STALE_TASK_MINUTES 生效值参与回池时刻（可选 env 口径；板面与 Offline 同源）", async () => {
    await register("a", "sess-a", "conn-a", { pid: process.pid });
    await register("m3", "sess-m3", "conn-m3");
    const taskId = await dispatchAndClaim("conn-a", "m3", "conn-m3");
    await refreshSessionLastSeen(stateRoot, "sess-m3", { now: Date.now(), liveness: "running", pid: DEAD_PID });
    const customDeps: ToolDeps = { stateRoot, workspace: workDir, env: { ...deps.env, XC_STALE_TASK_MINUTES: "5" } };
    const result: ToolResult = await createTeamOverviewCore(customDeps).xc_status({}, "conn-overview");
    const payload = payloadOf(result) as Record<string, unknown>;
    const row = (payload["tasks"] as BoardTask[]).find((t) => t.id === taskId)!;
    expect(row.requeuePending).toBe(true);
    // 5min 阈值：回池时刻 = updatedAt + 5min（板面）
    const offline = payload["offlineMembers"] as Array<{ tasks: Array<{ taskId: string; requeueAtMs?: number }> }>;
    expect(offline[0]!.tasks.find((t) => t.taskId === taskId)!.requeueAtMs).toBe(row.requeueAtMs);
    const taskOnDisk = JSON.parse(
      readFileSync(join(stateRoot, "teams", "default", "team.json"), "utf8"),
    ) as { tasks: Array<{ id: string; updatedAt: number }> };
    const updatedAt = taskOnDisk.tasks.find((t) => t.id === taskId)!.updatedAt;
    expect(row.requeueAtMs).toBe(updatedAt + 5 * 60_000);
  });
});
