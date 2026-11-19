/**
 * v0.9.0（G-9/G-5）组A 定向单测（端到端）：清扫联动活性 + 三视图口径一致。
 *
 * 验收锚点（方案 §二 组A 行 + GAP-V0.9 §G-5 四例定性）：
 * - **t1 模式**（活跃等待裁决）：属主 idle 但 stale 窗口内有过引擎事件
 *   （registry lastEventTs 心跳代理）→ 不再被误扫；
 * - **t17 模式**（长任务多轮）：属主 running（回合执行中）→ stale 倒计时暂停，
 *   不再被误扫（结构性死循环解除）；
 * - **t25 模式**（规范心跳）：in_progress 心跳刷新 updatedAt 的旧路径行为不变
 *   （不超阈即不扫）；
 * - 真僵尸控制组：属主 idle、窗口内无事件 → 照扫（t19 边界与旧口径一致）；
 *   blocked 不在 SWEEPABLE 清扫域（旧口径不变）；
 * - **dead 不豁免**：属主残留 running 记录但 C8 pid-dead 硬证据 → 照扫 + 转交通知
 *   （C8 快刀口径不变）；
 * - **三视图一致**：team / panel / status 对同一成员的活性字段
 *   （{state, stateAgeMin, lastEventAgeMin}）同源同值；
 * - peer-drain 包装层的工具调用心跳：队内工具调用后调用方 lastEventTs 刷新。
 *
 * 纯状态机/registry 集成用例见 core/liveness.test.ts。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { payloadOf, type ToolResult } from "./protocol.js";
import { composeCore, createToolCore, type ToolCore, type ToolDeps } from "./core.js";
import { handleOverview } from "./tools-overview.js";
import { sweepStaleTasksOnce } from "./task-edges.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { readMailbox } from "../core/mailbox.js";
import { readSession, writeSession, writeSessionWitness } from "../core/registry.js";
import type { SessionWitnessKind, Task, TeamMember } from "../core/types.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import { localPidDomain } from "../core/peerdir.js";
import type { TeamState } from "../core/types.js";

const dirs: string[] = [];
let workDir: string;
let stateRoot: string;
let peerRoot: string;

/** 容量钉 GREEN（三条 red 规则不命中——观测块互不干扰）。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-liveness-e2e-"));
  dirs.push(workDir);
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  mkdirSync(join(peerRoot, "sessions"), { recursive: true });
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

function makeDeps(env: NodeJS.ProcessEnv = {}): ToolDeps {
  return { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot, ...env } };
}

async function hookRegister(core: ToolCore, conn: string, name: string, sid: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  const res = await core.xc_register({ name, sessionId: sid }, conn);
  expect(res.isError, JSON.stringify(payloadOf(res))).toBeFalsy();
}

/** 写一条受控活性状态的会话记录（覆盖注册时落下的默认形态；writeSession 整文件覆盖，先读后写）。 */
async function setLiveness(
  sid: string,
  state: { liveness?: "running" | "idle"; livenessTs?: number; lastEventTs?: number },
): Promise<void> {
  const existing = (await readSession(stateRoot, sid)) ?? {
    sessionId: sid,
    cwd: workDir,
    startedAt: Date.now(),
    lastSeen: Date.now(),
  };
  await writeSession(stateRoot, { ...existing, ...state });
}

/** 引擎证言种子（v0.9.1 r3 豁免唯一输入）：registry/witness/<sid>.json。 */
async function seedWitness(sid: string, kind: SessionWitnessKind, ts: number): Promise<void> {
  await writeSessionWitness(stateRoot, sid, kind, ts);
}

/** 端点活性证词（v0.9.1 r2）：sid 的 peer 记录 pid 活（本进程）且心跳新鲜 → memberLiveness='live'。 */
/** 端点活性证词（v0.9.1 r2）：sid 的 peer 记录 pid 活（本进程）且心跳新鲜 → memberLiveness='live'。 */
async function seedLivePeerRecord(sid: string): Promise<void> {
  await writeFile(
    join(peerRoot, "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: sid,
      messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xc-liveness-e2e",
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "bg",
      formerNames: [],
      startedAt: Date.now() - 3_600_000,
      lastSeen: Date.now(),
    }),
    "utf8",
  );
}

/** 落一条 pid 已亡的 peer 注册记录（C8 pid-dead 硬证据）。 */
async function seedDeadPeerRecord(sid: string): Promise<void> {
  const pid = 2_147_483_646;
  await writeFile(
    join(peerRoot, "sessions", `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: sid,
      messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xc-liveness-e2e",
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "bg",
      formerNames: [],
      startedAt: Date.now() - 3_600_000,
      lastSeen: Date.now(),
    }),
    "utf8",
  );
}

async function dispatchAndStart(core: ToolCore, ownerConn: string, leadConn: string): Promise<string> {
  const d = await core.xc_dispatch({ to: "b", title: "长任务", prompt: "P:多轮" }, leadConn);
  expect(d.isError, JSON.stringify(payloadOf(d))).toBeFalsy();
  const taskId = payloadOf(d)["taskId"] as string;
  const claim = await core.xc_claim({ taskId }, ownerConn);
  expect(claim.isError, JSON.stringify(payloadOf(claim))).toBeFalsy();
  const attemptId = payloadOf(claim)["attemptId"] as string;
  const started = await core.xc_report({ taskId, attemptId, status: "in_progress" }, ownerConn);
  expect(started.isError, JSON.stringify(payloadOf(started))).toBeFalsy();
  return taskId;
}

async function backdateOpenTask(minusMs: number): Promise<void> {
  const team = (await readTeam(stateRoot, "default"))!;
  for (const task of team.tasks) {
    if (task.status === "in_progress" || task.status === "claimed") task.updatedAt = Date.now() - minusMs;
  }
  await writeTeam(stateRoot, team);
}

async function taskOf(taskId: string): Promise<{ status: string; assignee: string | null }> {
  const team = (await readTeam(stateRoot, "default"))!;
  const task = team.tasks.find((t) => t.id === taskId)!;
  return { status: task.status, assignee: task.assignee };
}

function engineEvents(): Array<Record<string, unknown>> {
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function textOf(res: ToolResult): string {
  return (res.content[0] as { text?: string }).text ?? "";
}

interface LivenessRow {
  state: string;
  stateAgeMin: number | null;
  lastEventAgeMin: number | null;
}

// ---------------------------------------------------------------------------
// 清扫联动锚点（GAP t1 / t17 / t25 三模式 + 控制组）
// ---------------------------------------------------------------------------

describe("清扫联动活性（G-5）：sweepStaleTasksOnce", () => {
  it("t1 模式（活跃等待裁决）：属主 idle 但 stale 窗口内有过引擎事件 → 心跳代理，不误扫", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000); // 任务时间线超阈（等同 12:35 的形态）
    // 属主会话：回合已结束（idle），但 30s 前刚发过聊天 relay——引擎证言 heartbeat（r3 唯一输入）。
    await seedWitness("sess_b", "heartbeat", Date.now() - 30_000);
    await setLiveness("sess_b", { liveness: "idle", livenessTs: Date.now() - 20 * 60_000, lastEventTs: Date.now() - 30_000 });

    const summary = await sweepStaleTasksOnce(deps);
    expect(summary).toMatchObject({ swept: 0, skipped: true }); // 无锁预检即豁免（常态零成本路径）
    expect(await taskOf(taskId)).toMatchObject({ status: "in_progress", assignee: "b" });
    expect(engineEvents().filter((e) => e["event"] === "task-swept")).toHaveLength(0);
    // 派发方邮箱无 stale-swept 回执。
    const boxA = await readMailbox(stateRoot, "default", "a");
    expect(boxA.filter((m) => m.content.includes("stale-swept"))).toHaveLength(0);
  });

  it("t17 模式（长任务多轮）：属主 running → stale 倒计时暂停，不误扫（lastEventTs 陈旧也在豁免域）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    // 属主会话：长回合执行中——引擎证言 running（40min 前 hook 迁移），2×界（2min）内 → owner-running。
    await seedWitness("sess_b", "running", Date.now() - 40_000);
    await setLiveness("sess_b", { liveness: "running", livenessTs: Date.now() - 40 * 60_000, lastEventTs: Date.now() - 40 * 60_000 });

    const summary = await sweepStaleTasksOnce(deps);
    expect(summary).toMatchObject({ swept: 0, skipped: true });
    expect(await taskOf(taskId)).toMatchObject({ status: "in_progress", assignee: "b" });
  });

  it("t25 模式（规范心跳）：in_progress 心跳维持 updatedAt 新鲜 → 旧路径行为不变", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a"); // 末次 in_progress report 即心跳
    // 属主会话完全静止（idle 且无近期事件）——活性能帮的只有任务时间线本身。
    await setLiveness("sess_b", { liveness: "idle", livenessTs: Date.now() - 40 * 60_000, lastEventTs: Date.now() - 40 * 60_000 });

    const summary = await sweepStaleTasksOnce(deps);
    expect(summary).toMatchObject({ swept: 0, skipped: true }); // 无超阈候选（与旧实现同判）
    expect(await taskOf(taskId)).toMatchObject({ status: "in_progress", assignee: "b" });
  });

  it("控制组（真僵尸，t19 口径）：属主 idle、窗口内无事件 → 照扫回池 + 回执", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    await setLiveness("sess_b", { liveness: "idle", livenessTs: Date.now() - 40 * 60_000, lastEventTs: Date.now() - 40 * 60_000 });

    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
  });

  it("blocked 不在清扫域（旧口径不变）：超阈 blocked 任务不被活性联动影响", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const d = await core.xc_dispatch({ to: "b", title: "T", prompt: "P" }, "conn-a");
    const taskId = payloadOf(d)["taskId"] as string;
    const claim = await core.xc_claim({ taskId }, "conn-b");
    const attemptId = payloadOf(claim)["attemptId"] as string;
    expect(
      (await core.xc_report({ taskId, attemptId, status: "blocked", error: "等上游裁决" }, "conn-b")).isError,
    ).toBeFalsy();
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = Date.now() - 2 * 60_000;
    task.blockedAt = Date.now() - 2 * 60_000;
    await writeTeam(stateRoot, team);
    await setLiveness("sess_b", { liveness: "idle", livenessTs: Date.now() - 40 * 60_000, lastEventTs: Date.now() - 40 * 60_000 });

    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 0, skipped: true });
    expect(await taskOf(taskId)).toMatchObject({ status: "blocked", assignee: "b" });
  });

  it("dead 不豁免（C8 口径不变）：残留 running 记录 + pid-dead 硬证据 → 照扫 + 转交通知", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    // 崩溃会话：Stop 钩子永远没来 → 记录残留 running；peer 注册表 pid 已亡。
    await setLiveness("sess_b", { liveness: "running", livenessTs: Date.now() - 5 * 60_000, lastEventTs: Date.now() - 5 * 60_000 });
    await seedDeadPeerRecord("sess_b");

    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
    // C8 转交审计与 lead 通知照旧。
    expect(engineEvents().filter((e) => e["event"] === "task-offline")).toHaveLength(1);
    const boxA = await readMailbox(stateRoot, "default", "a");
    expect(boxA.some((m) => m.content.includes("task-receipt") && m.content.includes("offline"))).toBe(true);
  });

  it("混合属主：一个 running（豁免）+ 一个真僵尸 → 只扫僵尸（预检不整单跳过）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    await hookRegister(core, "conn-c", "c", "sess_c");
    const tB = await dispatchAndStart(core, "conn-b", "conn-a");
    // c 的任务走 dispatch→claim（in_progress）。
    const d2 = await core.xc_dispatch({ to: "c", title: "T2", prompt: "P2" }, "conn-a");
    const tC = payloadOf(d2)["taskId"] as string;
    const claimC = await core.xc_claim({ taskId: tC }, "conn-c");
    await core.xc_report({ taskId: tC, attemptId: payloadOf(claimC)["attemptId"] as string, status: "in_progress" }, "conn-c");
    await backdateOpenTask(2 * 60_000);
    await seedWitness("sess_b", "running", Date.now() - 90_000); // 2×界内 → 豁免
    await setLiveness("sess_b", { liveness: "running", livenessTs: Date.now() - 30 * 60_000, lastEventTs: Date.now() - 30 * 60_000 });
    await setLiveness("sess_c", { liveness: "idle", livenessTs: Date.now() - 40 * 60_000, lastEventTs: Date.now() - 40 * 60_000 });

    const summary = await sweepStaleTasksOnce(deps);
    expect(summary).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(tB)).toMatchObject({ status: "in_progress", assignee: "b" }); // running 豁免
    expect(await taskOf(tC)).toMatchObject({ status: "pending", assignee: null }); // 僵尸照扫
  });
});

// ---------------------------------------------------------------------------
// 三视图口径一致（G-9）+ 工具调用心跳
// ---------------------------------------------------------------------------

describe("xc_overview 三视图活性一致（G-9）", () => {
  function member(key: string, sessionId: string): { key: string; sessionId: string; role: "worker"; joinedAt: number; lastSeen: number; state: "ready"; identity: "engine" } {
    return { key, sessionId, role: "worker", joinedAt: Date.now() - 3_600_000, lastSeen: Date.now() - 60_000, state: "ready", identity: "engine" };
  }

  async function seedTeamWithLiveness(): Promise<void> {
    const team: TeamState = {
      teamId: "default",
      name: "default",
      founderKey: "lead",
      leadKey: "lead",
      phase: "open",
      era: "e2e-era1",
      members: [member("lead", "sess-lead"), member("alice", "sess-alice"), member("bob", "sess-bob"), member("carol", "sess-carol")],
      tasks: [],
      seq: 0,
      createdAt: Date.now() - 3_600_000,
    };
    await writeTeam(stateRoot, team);
    const now = Date.now();
    // lead：长回合运行中；alice：回合已结束、5min 前有事件；bob：完全静止（存量形态）；
    // carol：残留 running 但 pid 已亡（dead 派生）。
    await writeSession(stateRoot, { sessionId: "sess-lead", cwd: workDir, startedAt: now, lastSeen: now, liveness: "running", livenessTs: now - 2 * 60_000, lastEventTs: now - 2 * 60_000 });
    await writeSession(stateRoot, { sessionId: "sess-alice", cwd: workDir, startedAt: now, lastSeen: now, liveness: "idle", livenessTs: now - 6 * 60_000, lastEventTs: now - 5 * 60_000 });
    await writeSession(stateRoot, { sessionId: "sess-bob", cwd: workDir, startedAt: now, lastSeen: now });
    await writeSession(stateRoot, { sessionId: "sess-carol", cwd: workDir, startedAt: now, lastSeen: now, liveness: "running", livenessTs: now - 3 * 60_000, lastEventTs: now - 3 * 60_000 });
    const pid = 2_147_483_646;
    await writeFile(
      join(peerRoot, "sessions", `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: "sess-carol",
        messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xc-liveness-views",
        pidDomain: localPidDomain(),
        peerProtocol: 1,
        peerFeatures: [],
        kind: "bg",
        formerNames: [],
        startedAt: now - 3_600_000,
        lastSeen: now,
      }),
      "utf8",
    );
  }

  it("team / panel / status 对同一成员给出同值活性字段；dead 压过 running", async () => {
    await seedTeamWithLiveness();
    const deps = makeDeps();
    // C8 语义：pid-dead 记录会被任一全量 peer 扫描惰性清扫（panel 的花名解析、
    // offline 挂载等）——「进程死」是**扫描时刻的瞬态事实**。为让三次独立视图调用
    // 观察同一事实，每次调用前重放崩溃残留记录（固定 pid，内容同 seedTeamWithLiveness）。
    const ensureCarolDead = async (): Promise<void> => {
      const pid = 2_147_483_646;
      await writeFile(
        join(peerRoot, "sessions", `${pid}.json`),
        JSON.stringify({
          pid,
          sessionId: "sess-carol",
          messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xc-liveness-views",
          pidDomain: localPidDomain(),
          peerProtocol: 1,
          peerFeatures: [],
          kind: "bg",
          formerNames: [],
          startedAt: Date.now() - 3_600_000,
          lastSeen: Date.now(),
        }),
        "utf8",
      );
    };

    await ensureCarolDead();
    const teamPayload = payloadOf(await handleOverview(deps, { view: "team" }, "conn-v")) as Record<string, unknown>;
    await ensureCarolDead();
    const panelPayload = payloadOf(await handleOverview(deps, { view: "panel" }, "conn-v")) as Record<string, unknown>;
    await ensureCarolDead();
    const statusPayload = payloadOf(await handleOverview(deps, { view: "status" }, "conn-v")) as Record<string, unknown>;

    const teamRows = teamPayload["members"] as Array<{ key: string; liveness?: LivenessRow }>;
    const panelRows = panelPayload["members"] as Array<{ key: string; liveness?: LivenessRow }>;
    const statusLiveness = statusPayload["liveness"] as { running: number; idle: number; dead: number; byMember: Record<string, LivenessRow> };
    const teamCounts = teamPayload["liveness"] as { running: number; idle: number; dead: number };
    const panelCounts = panelPayload["liveness"] as { running: number; idle: number; dead: number };

    // 三态计数三视图一致（bob 无记录 → 保守 idle）。
    expect(teamCounts).toEqual({ running: 1, idle: 2, dead: 1 });
    expect(panelCounts).toEqual(teamCounts);
    expect(statusLiveness).toMatchObject({ running: 1, idle: 2, dead: 1 });
    expect(Object.keys(statusLiveness.byMember).sort()).toEqual(["alice", "bob", "carol", "lead"]);

    // 成员行等价物逐成员同值（state + lastEventAgeMin）。
    const pick = (rows: Array<{ key: string; liveness?: LivenessRow }>, key: string): LivenessRow | undefined => rows.find((m) => m.key === key)?.liveness;
    for (const key of ["lead", "alice", "bob", "carol"]) {
      const teamRow = pick(teamRows, key);
      const panelRow = pick(panelRows, key);
      const statusRow = statusLiveness.byMember[key]!;
      expect(teamRow, `${key} team row`).toBeDefined();
      expect(panelRow, `${key} panel row`).toEqual(teamRow);
      expect(statusRow, `${key} status row`).toEqual(teamRow);
    }
    // 语义抽查：lead=running、alice=idle、bob（存量无字段）=idle、carol dead 压过 running。
    expect(pick(teamRows, "lead")).toMatchObject({ state: "running" });
    expect(pick(teamRows, "alice")).toMatchObject({ state: "idle", lastEventAgeMin: 5 });
    expect(pick(teamRows, "bob")).toMatchObject({ state: "idle", lastEventAgeMin: null });
    expect(pick(teamRows, "carol")).toMatchObject({ state: "dead", stateAgeMin: null });

    // 文本面：team / panel 紧凑计数行；status 行序冻结（活性只在 payload）。
    await ensureCarolDead();
    const teamText = textOf(await handleOverview(deps, { view: "team" }, "conn-v"));
    expect(teamText).toContain("liveness: running 1 / idle 2 / dead 1");
    await ensureCarolDead();
    const panelText = textOf(await handleOverview(deps, { view: "panel" }, "conn-v"));
    expect(panelText).toContain("liveness: running 1 / idle 2 / dead 1");
    const statusText = textOf(await handleOverview(deps, { view: "status" }, "conn-v"));
    // status 文本行序冻结（team/tasks/capacity/checkpoint/unread）——活性只进 payload。
    expect(statusText).not.toContain("liveness:");
    expect(statusText.split("\n")[0]).toContain("members: 4");
  });

  it("队内工具调用 → 调用方 lastEventTs 刷新（peer-drain 包装层心跳）", async () => {
    const deps = makeDeps();
    const core = composeCore(deps); // 组装链含 withPeerDrain（心跳挂在包装层）
    identityStore.bind("conn-hb", {
      sessionKey: "sess-hb:b",
      teamId: "default",
      name: "b",
      agentKey: "b",
      sessionId: "sess-hb",
      role: "peer",
      boundAt: Date.now(),
    } satisfies BoundIdentity);
    // 陈旧心跳（>30s 节流窗）→ 本次工具调用必然刷新。
    await writeSession(stateRoot, {
      sessionId: "sess-hb", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now(),
      liveness: "idle", livenessTs: Date.now() - 10 * 60_000, lastEventTs: Date.now() - 60_000,
    });
    const res = await core.xc_status({}, "conn-hb");
    expect(res.isError).toBeFalsy();
    const record = (await readSession(stateRoot, "sess-hb"))!;
    expect(record.lastEventTs).toBeGreaterThan(Date.now() - 5_000);
    expect(record.liveness).toBe("running"); // idle 记录自愈（工具调用只在回合内发生）
    // 免注册连接（观测工具免豁免注册）→ 取不到 sessionId → 心跳无操作、不抛。
    const anon = await core.xc_status({}, "conn-anon");
    expect(anon.isError).toBeFalsy();
    const afterAnon = (await readSession(stateRoot, "sess-hb"))!;
    expect(afterAnon.lastEventTs).toBe(record.lastEventTs); // 旁连接不碰别人的心跳
  });
});

// ---------------------------------------------------------------------------
// v0.9.1 r4（V090-01 观测 + 口径统一）：成员行 witness 块 + 任务板豁免期数
// ---------------------------------------------------------------------------

describe("xc_overview r4：豁免可观测（witness 展示 + 豁免 N×阈值）", () => {
  function member(key: string, sessionId: string): TeamMember {
    return {
      key,
      sessionId,
      role: "worker",
      joinedAt: Date.now() - 3_600_000,
      lastSeen: Date.now() - 60_000,
      state: "ready",
      identity: "engine",
    };
  }

  function taskRow(overrides: Partial<Task> = {}): Task {
    return {
      id: "t-1",
      title: "长任务",
      prompt: "p",
      dependsOn: [],
      status: "in_progress",
      assignee: "alice",
      attempt: 1,
      attemptId: "attempt-1",
      createdBy: "lead",
      createdAt: Date.now() - 3_600_000,
      updatedAt: Date.now() - 31 * 60_000, // 超缺省 stale 阈值 30min 一个周期
      lastProgressTs: Date.now() - 31 * 60_000,
      result: null,
      error: null,
      evidence: [],
      history: [{ ts: Date.now() - 31 * 60_000, event: "report", by: "alice" }],
      ...overrides,
    };
  }

  async function seedExemptBoard(): Promise<string> {
    const team: TeamState = {
      teamId: "default",
      name: "default",
      founderKey: "lead",
      leadKey: "lead",
      phase: "open",
      era: "e2e-r4",
      members: [member("lead", "sess-lead"), member("alice", "sess-alice")],
      tasks: [taskRow()],
      seq: 1,
      createdAt: Date.now() - 3_600_000,
    };
    await writeTeam(stateRoot, team);
    const now = Date.now();
    // alice：自述 running + 引擎证言 running（60s 前）→ owner-running 豁免成立。
    await writeSession(stateRoot, { sessionId: "sess-alice", cwd: workDir, startedAt: now, lastSeen: now, liveness: "running", livenessTs: now - 60_000, lastEventTs: now - 60_000 });
    await seedWitness("sess-alice", "running", now - 60_000);
    // lead：无证言（witness 块为 null）。
    await writeSession(stateRoot, { sessionId: "sess-lead", cwd: workDir, startedAt: now, lastSeen: now, liveness: "idle", livenessTs: now - 60_000, lastEventTs: now - 60_000 });
    return team.tasks[0]!.id;
  }

  it("成员行 witness 块与任务板豁免期数三视图同源；无证言记 null", async () => {
    const taskId = await seedExemptBoard();
    const deps = makeDeps();

    const teamPayload = payloadOf(await handleOverview(deps, { view: "team" }, "conn-a")) as Record<string, unknown>;
    const teamRows = teamPayload["members"] as Array<{ key: string; liveness?: LivenessRow & { witness: { kind: string; ageMin: number } | null } }>;
    // 成员行：alice 带 running 证言（age 1min），lead 无证言（null）。
    expect(teamRows.find((m) => m.key === "alice")?.liveness?.witness).toMatchObject({ kind: "running", ageMin: 1 });
    expect(teamRows.find((m) => m.key === "lead")?.liveness?.witness).toBeNull();
    // 任务板：被豁免的超阈任务带期数与原因（floor(31min/30min)=1）。
    const rows = teamPayload["tasks"] as Array<{ id: string; sweepExemptPeriods?: number; sweepExemptReason?: string }>;
    expect(rows.find((t) => t.id === taskId)).toMatchObject({ sweepExemptPeriods: 1, sweepExemptReason: "owner-running" });
    // 文本行：豁免 N×阈值对人可见。
    const teamText = textOf(await handleOverview(deps, { view: "team" }, "conn-a"));
    expect(teamText).toContain(`Exempt: ${taskId}(owner-running, 豁免 1×阈值)`);

    // panel / status：witness 块同值（三视图口径一致）。
    const panelPayload = payloadOf(await handleOverview(deps, { view: "panel" }, "conn-a")) as Record<string, unknown>;
    const panelRows = panelPayload["members"] as Array<{ key: string; liveness?: { witness: { kind: string; ageMin: number } | null } }>;
    expect(panelRows.find((m) => m.key === "alice")?.liveness?.witness).toMatchObject({ kind: "running", ageMin: 1 });
    expect(panelRows.find((m) => m.key === "lead")?.liveness?.witness).toBeNull();

    const statusPayload = payloadOf(await handleOverview(deps, { view: "status" }, "conn-a")) as Record<string, unknown>;
    const byMember = (statusPayload["liveness"] as { byMember: Record<string, { witness: { kind: string; ageMin: number } | null }> }).byMember;
    expect(byMember["alice"]!.witness).toMatchObject({ kind: "running", ageMin: 1 });
    expect(byMember["lead"]!.witness).toBeNull();
    // status 文本行序冻结：无 Exempt 行（观测只在 payload）。
    const statusText = textOf(await handleOverview(deps, { view: "status" }, "conn-a"));
    expect(statusText).not.toContain("Exempt:");
  });

  it("无豁免（证言缺失/任务未超阈）→ 板面无 sweepExemptPeriods、无 Exempt 行", async () => {
    const team: TeamState = {
      teamId: "default",
      name: "default",
      founderKey: "lead",
      leadKey: "lead",
      phase: "open",
      era: "e2e-r4b",
      members: [member("lead", "sess-lead"), member("alice", "sess-alice")],
      tasks: [taskRow({ assignee: "alice" })],
      seq: 1,
      createdAt: Date.now() - 3_600_000,
    };
    await writeTeam(stateRoot, team);
    const now = Date.now();
    // alice 自述 running 但**无证言**（伪造签名形态）→ 不豁免。
    await writeSession(stateRoot, { sessionId: "sess-alice", cwd: workDir, startedAt: now, lastSeen: now, liveness: "running", livenessTs: now - 60_000 });
    await writeSession(stateRoot, { sessionId: "sess-lead", cwd: workDir, startedAt: now, lastSeen: now, liveness: "idle" });
    const deps = makeDeps();

    const payload = payloadOf(await handleOverview(deps, { view: "team" }, "conn-a")) as Record<string, unknown>;
    const rows = payload["tasks"] as Array<{ id: string; sweepExemptPeriods?: number }>;
    expect(rows.find((t) => t.id === team.tasks[0]!.id)?.sweepExemptPeriods).toBeUndefined();
    const text = textOf(await handleOverview(deps, { view: "team" }, "conn-a"));
    expect(text).not.toContain("Exempt:");
    // 成员行 witness=null 但自述 state=running（展示面可见伪造签名）。
    const teamRows = payload["members"] as Array<{ key: string; liveness?: { state: string; witness: unknown } }>;
    expect(teamRows.find((m) => m.key === "alice")?.liveness).toMatchObject({ state: "running", witness: null });
  });
});
