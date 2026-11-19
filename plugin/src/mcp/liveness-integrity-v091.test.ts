/**
 * v0.9.1 打回轮定向单测（合并裁决 V090-01 / V090-02 / V090-06，组A 域）。
 *
 * 三例缺陷的攻击形态 → 修复后必须全部失效：
 * - **V090-01**（活性真源无完整性保护）：一次本地文件写把会话记录伪造成
 *   `liveness=running` + `lastEventTs=未来` → 修复后读盘（coerceSessionRecord）即丢弃
 *   未来值字段，running 无可信 livenessTs 降级 idle —— 永久心跳/owner-running 豁免
 *   不再成立，任务照常回池（对照组同参）；
 * - **V090-02**（peer 注册表清扫面）：观测面（view:"peers"/panel→rowsOf、回执查找、
 *   发送活性判定）一律只读扫描——pid-dead 硬证据不再被自家工具删掉，C8 全链路
 *   （task-swept + task-offline + lead 转交）在「崩溃残留 + 残留 running 记录」的
 *   攻击形态下照常工作；仍会删记录的清扫面逐笔写机器全局日志
 *   `sessions/.sweeps.jsonl`（peerSweepJournalFile）；
 * - **V090-06**（豁免零审计 + 壅蔽 C8）：活性豁免每任务每超阈周期留痕
 *   `task-sweep-deferred`（epoch 去重），伪造/损坏记录落 `session-record-anomaly`
 *   ——豁免与伪造在 engine.jsonl 可见。
 *
 * 裁决书引用的 scratch/_scripts/case*.mjs 不在本工作区（已核查：仓库内无 scratch/
 * 与 integration/ 目录），本文件以同构攻击形态（直写伪造记录 / 崩溃残留 + 观测面
 * 扫描 / 豁免链路）复现并断言修复。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore, type ToolDeps } from "./core.js";
import { handleOverview } from "./tools-overview.js";
import { sweepStaleTasksOnce } from "./task-edges.js";
import { readMailbox } from "../core/mailbox.js";
import { readSession, readSessionWitness, writeSession, writeSessionWitness } from "../core/registry.js";
import type { SessionWitnessKind } from "../core/types.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import { scanPeers, peerSweepJournalFile } from "../core/peerregistry.js";
import { localPidDomain } from "../core/peerdir.js";
import type { TeamState } from "../core/types.js";

const dirs: string[] = [];
let workDir: string;
let stateRoot: string;
let peerRoot: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-liveness-v091-"));
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
  return { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot, ...env } };
}

async function hookRegister(core: ToolCore, conn: string, name: string, sid: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  const res = await core.xc_register({ name, sessionId: sid }, conn);
  expect(res.isError, JSON.stringify(payloadOf(res))).toBeFalsy();
}

/** 端点活性证词（v0.9.1 r2）：sid 的 peer 记录 pid 活（本进程）且心跳新鲜 → memberLiveness='live'。 */
async function seedLivePeerRecord(sid: string, lastSeen: number = Date.now()): Promise<void> {
  await writeFile(
    join(peerRoot, "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: sid,
      messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xc-liveness-v091",
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "bg",
      formerNames: [],
      startedAt: Date.now() - 3_600_000,
      lastSeen,
    }),
    "utf8",
  );
}

/** 引擎证言种子（v0.9.1 r3 豁免唯一输入）：registry/witness/<sid>.json。 */
async function seedWitness(sid: string, kind: SessionWitnessKind, ts: number): Promise<void> {
  await writeSessionWitness(stateRoot, sid, kind, ts);
}

/** 攻击形态 1（V090-01）：绕过产品写路径，直写伪造的会话记录（未来时刻 + running）。 */
function writeForgedSessionRecord(sid: string, futureOffsetMs: number): void {
  const now = Date.now();
  writeFileSync(
    join(stateRoot, "registry", "sessions", `${sid}.json`),
    JSON.stringify({
      sessionId: sid,
      cwd: workDir,
      startedAt: now - 3_600_000,
      lastSeen: now - 60_000,
      liveness: "running",
      livenessTs: now + futureOffsetMs,
      lastEventTs: now + futureOffsetMs,
    }),
    "utf8",
  );
}

/** 攻击形态 2（V090-02）：崩溃残留的 pid-dead 注册记录（确定不存在的 pid）。 */
async function seedDeadPeerRecord(sid: string): Promise<number> {
  const pid = 2_147_483_646;
  await writeFile(
    join(peerRoot, "sessions", `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: sid,
      messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xc-liveness-v091",
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
  return pid;
}

async function dispatchAndStart(core: ToolCore, ownerConn: string, leadConn: string): Promise<string> {
  const d = await core.xc_dispatch({ to: "b", title: "T", prompt: "P" }, leadConn);
  expect(d.isError, JSON.stringify(payloadOf(d))).toBeFalsy();
  const taskId = payloadOf(d)["taskId"] as string;
  const claim = await core.xc_claim({ taskId }, ownerConn);
  expect(claim.isError).toBeFalsy();
  const attemptId = payloadOf(claim)["attemptId"] as string;
  const started = await core.xc_report({ taskId, attemptId, status: "in_progress" }, ownerConn);
  expect(started.isError).toBeFalsy();
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

// ---------------------------------------------------------------------------
// V090-01：伪造会话记录 → 读盘校验丢弃未来值 → 豁免失效、任务照常回池
// ---------------------------------------------------------------------------

describe("V090-01：活性真源完整性（伪造记录不可见效）", () => {
  it("伪造 running + lastEventTs=+1年 → 读盘字段被丢弃，清扫照常回池（对照组同参）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    writeForgedSessionRecord("sess_b", 365 * 24 * 60 * 60_000);

    // 读盘边界：未来值字段必须已被丢弃（running 无可信时刻）。
    const record = (await readSession(stateRoot, "sess_b"))!;
    expect(record.lastEventTs).toBeUndefined();
    expect(record.livenessTs).toBeUndefined();
    expect(record.liveness).toBe("running"); // 枚举字段保留（枚举外才丢）

    const summary = await sweepStaleTasksOnce(deps);
    expect(summary).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
    expect(engineEvents().filter((e) => e["event"] === "task-swept")).toHaveLength(1);
    // 异常留痕：伪造字段被审计（session-record-anomaly）。
    expect(engineEvents().filter((e) => e["event"] === "session-record-anomaly").length).toBeGreaterThanOrEqual(1);
  });

  it("容差内的未来值（时钟漂移 ≤5min）不被丢弃（正常时钟抖动不误伤）", async () => {
    const deps = makeDeps();
    const now = Date.now();
    mkdirSync(join(stateRoot, "registry", "sessions"), { recursive: true });
    writeFileSync(
      join(stateRoot, "registry", "sessions", "sess_skew.json"),
      JSON.stringify({
        sessionId: "sess_skew", cwd: workDir, startedAt: now, lastSeen: now,
        liveness: "running", livenessTs: now + 60_000, lastEventTs: now + 60_000,
      }),
      "utf8",
    );
    const record = (await readSession(stateRoot, "sess_skew"))!;
    expect(record.lastEventTs).toBe(now + 60_000); // ≤ now + 5min 容差 → 保留
    expect(record.livenessTs).toBe(now + 60_000);
  });
});

// ---------------------------------------------------------------------------
// V090-06：豁免留痕（task-sweep-deferred epoch 去重）+ 异常审计去重
// ---------------------------------------------------------------------------

describe("V090-06：清扫豁免审计（task-sweep-deferred / session-record-anomaly）", () => {
  it("真 running 属主：豁免生效且逐周期留痕；同周期不重复；跨周期再留一行", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    const T0 = Date.now();
    // 任务 updatedAt = T0 - 65s（超阈 1 个周期）；属主 running（livenessTs 可信）。
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = T0 - 65_000;
    await writeTeam(stateRoot, team);
    // 引擎证言（v0.9.1 r3 豁免唯一输入）：回合进行中（hook 三态迁移）。
    await seedWitness("sess_b", "running", T0 - 60_000);

    // 第 1 轮（now=T0）：豁免 + epoch 1 留痕（带端点证词字段）。
    expect(await sweepStaleTasksOnce(deps, T0)).toMatchObject({ swept: 0, skipped: true });
    let deferred = engineEvents().filter((e) => e["event"] === "task-sweep-deferred" && e["taskId"] === taskId);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ reason: "owner-running", epoch: 1, assignee: "b", witnessAgeMin: 1 });
    expect(await taskOf(taskId)).toMatchObject({ status: "in_progress", assignee: "b" });

    // 第 2 轮（now=T0+20s，仍在 epoch 1，证言 80s 前 ≤ 2×界 120s）：不重复留痕。
    expect(await sweepStaleTasksOnce(deps, T0 + 20_000)).toMatchObject({ swept: 0, skipped: true });
    expect(engineEvents().filter((e) => e["event"] === "task-sweep-deferred" && e["taskId"] === taskId)).toHaveLength(1);

    // 第 3 轮（now=T0+55s，进入 epoch 2，证言 115s 前仍在 2×界内）：再留一行。
    expect(await sweepStaleTasksOnce(deps, T0 + 55_000)).toMatchObject({ swept: 0, skipped: true });
    deferred = engineEvents().filter((e) => e["event"] === "task-sweep-deferred" && e["taskId"] === taskId);
    expect(deferred).toHaveLength(2);
    expect(deferred[1]).toMatchObject({ epoch: 2 });
  });

  it("豁免审计的心跳代理形态：reason=heartbeat 同样留痕", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    const T0 = Date.now();
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = T0 - 65_000;
    await writeTeam(stateRoot, team);
    // 属主 idle 但 30s 前有过引擎事件（t1 心跳代理形态）→ 证言 heartbeat。
    await seedWitness("sess_b", "heartbeat", T0 - 30_000);

    expect(await sweepStaleTasksOnce(deps, T0)).toMatchObject({ swept: 0, skipped: true });
    const deferred = engineEvents().filter((e) => e["event"] === "task-sweep-deferred" && e["taskId"] === taskId);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ reason: "heartbeat", epoch: 1, witnessAgeMin: 1 });
  });

  it("伪造记录：session-record-anomaly 进程内去重（第二次清扫不再重复）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    writeForgedSessionRecord("sess_b", 365 * 24 * 60 * 60_000);

    await sweepStaleTasksOnce(deps);
    const first = engineEvents().filter((e) => e["event"] === "session-record-anomaly" && e["sessionId"] === "sess_b");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ field: "livenessTs", member: "b" });

    // 第二轮（记录已被清扫改写不了 session 文件——伪造文件仍在盘上）再扫：无重复审计。
    await sweepStaleTasksOnce(deps);
    expect(engineEvents().filter((e) => e["event"] === "session-record-anomaly" && e["sessionId"] === "sess_b")).toHaveLength(1);
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
  });
});

// ---------------------------------------------------------------------------
// V090-02：观测面只读 + .sweeps.jsonl 删除审计（崩溃证据不被自家工具抹掉）
// ---------------------------------------------------------------------------

describe("V090-02：peer 注册表清扫面（观测面只读 + 删除留痕）", () => {
  it("view:\"peers\" 不删 pid-dead 证据；清扫链路照常回池 + 转交（case2 攻击形态失效）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    // 崩溃形态：peer 注册记录 pid-dead 在场 + 会话记录残留 running（Stop 永远没来）。
    const pid = await seedDeadPeerRecord("sess_b");
    await writeSession(stateRoot, {
      sessionId: "sess_b", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now(),
      liveness: "running", livenessTs: Date.now() - 60_000, lastEventTs: Date.now() - 60_000,
    });

    // 观测面（view:"peers"）：死记录文件必须原样在场（只读）。
    const peersView = await handleOverview(deps, { view: "peers" }, "conn-a");
    expect(peersView.isError).toBeFalsy();
    expect(existsSync(join(peerRoot, "sessions", `${pid}.json`))).toBe(true);
    // 观测面未触发任何删除 → 清扫日志不存在（无删除即无痕）。
    expect(existsSync(peerSweepJournalFile(peerRoot))).toBe(false);

    // 清扫链路：pid-dead 证据在场 → 照扫 + C8 转交（残留 running 压不过进程死）。
    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
    const offline = engineEvents().filter((e) => e["event"] === "task-offline");
    expect(offline).toHaveLength(1);
    expect(offline[0]).toMatchObject({ evidence: "process-dead", member: "b" });
    const boxA = await readMailbox(stateRoot, "default", "a");
    expect(boxA.some((m) => m.content.includes("task-receipt") && m.content.includes("offline"))).toBe(true);
  });

  it("v0.9.1 r2：缺省档只读（死记录保留、零日志）；显式 sweep:true 才删除并逐笔留痕", async () => {
    const pid = await seedDeadPeerRecord("sess_dead1");
    // 缺省档（v0.9.1 r2 起缺省只读）：死记录进 dead 但文件保留、零删除零日志。
    const scan = await scanPeers(peerRoot);
    expect(scan.dead).toHaveLength(1);
    expect(scan.dead[0]!.reason).toBe("pid-dead");
    expect(existsSync(join(peerRoot, "sessions", `${pid}.json`))).toBe(true);
    expect(existsSync(peerSweepJournalFile(peerRoot))).toBe(false);

    // 显式清扫（{sweep:true}）：删除 + 逐笔留痕（pid/sessionId/reason 断言）。
    const sweptScan = await scanPeers(peerRoot, Date.now(), { sweep: true });
    expect(sweptScan.dead).toHaveLength(1);
    expect(existsSync(join(peerRoot, "sessions", `${pid}.json`))).toBe(false);
    expect(existsSync(peerSweepJournalFile(peerRoot))).toBe(true);
    const lines = readFileSync(peerSweepJournalFile(peerRoot), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sweptCount: 1 });
    const swept = lines[0]!["swept"] as Array<Record<string, unknown>>;
    expect(swept[0]).toMatchObject({ pid, sessionId: "sess_dead1", reason: "pid-dead" });

    // 只读扫描：死记录（另一条）进 dead 但文件保留、日志零新增。
    await seedDeadPeerRecord("sess_dead2");
    const before = readFileSync(peerSweepJournalFile(peerRoot), "utf8").split("\n").filter((l) => l.trim() !== "").length;
    const readonlyScan = await scanPeers(peerRoot, Date.now(), { sweep: false });
    expect(readonlyScan.dead).toHaveLength(1);
    expect(existsSync(join(peerRoot, "sessions", "2147483646.json"))).toBe(true);
    const after = readFileSync(peerSweepJournalFile(peerRoot), "utf8").split("\n").filter((l) => l.trim() !== "").length;
    expect(after).toBe(before);
  });

  it("view:\"peers\" 文本面照常工作（死记录仍在场时按 dead 呈现，不崩）", async () => {
    await seedDeadPeerRecord("sess_view");
    const deps = makeDeps();
    const res = await handleOverview(deps, { view: "peers" }, "conn-a");
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBeDefined();
    // 死记录不被观测面删除（只读纪律）。
    expect(existsSync(join(peerRoot, "sessions", "2147483646.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 防御纵深回归：真实 running 豁免（t17 形态）在可信记录下仍然生效
// ---------------------------------------------------------------------------

describe("V090 防御纵深不误伤：可信活性豁免照常", () => {
  it("可信 running（产品写路径）→ 豁免 + 留痕；修复不改 G-5 语义", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    // 阈值 1min（2× 界 = 2min）：running 证言 90s 前 → owner-running 豁免带内。
    await seedWitness("sess_b", "running", Date.now() - 90_000);
    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 0, skipped: true });
    expect(await taskOf(taskId)).toMatchObject({ status: "in_progress", assignee: "b" });
    const deferred = engineEvents().filter((e) => e["event"] === "task-sweep-deferred");
    expect(deferred.length).toBeGreaterThanOrEqual(1);
    expect(deferred[0]).toMatchObject({ reason: "owner-running", witnessAgeMin: 2 });
  });
});

// ---------------------------------------------------------------------------
// 打回第 2 轮（V090-01/05 r2）：自洽过去值伪造 + 端点活性证词闸 + C8 不被壅蔽
// ---------------------------------------------------------------------------

describe("V090-02 r4：证言未来容差归零（case9r4：豁免窗不再被 skew 放大）", () => {
  /** 攻击形态（裁决 case9r4）：伪造证言 ts=now+4min——r3 的 5min 容差接受它，age 为负
   * 恒满足 boundMs，豁免窗 = skew(240s) + 2×阈值(120s) = 360s（对照组过去值 120s）。 */
  async function seedFutureWitness(sid: string, futureMs: number): Promise<void> {
    await writeSessionWitness(stateRoot, sid, "running", Date.now() + futureMs);
  }

  it("r4：伪造未来证言（now+4min）→ 读盘即拒，任务在 2×阈值内照扫（不放大到 360s）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    const T0 = Date.now();
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = T0 - 65_000;
    await writeTeam(stateRoot, team);
    await seedFutureWitness("sess_b", 4 * 60_000);

    // 证言读回 undefined（未来值整条拒绝）→ 无豁免。
    expect(await readSessionWitness(stateRoot, "sess_b")).toBeUndefined();
    // 第 1 轮（now=T0）：照扫（对照组过去值同参也照扫；r3 缺陷态下这里会豁免到 360s）。
    expect(await sweepStaleTasksOnce(deps, T0)).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
    expect(engineEvents().filter((e) => e["event"] === "task-swept")).toHaveLength(1);
    // 无 deferred 留痕（从未豁免）。
    expect(engineEvents().filter((e) => e["event"] === "task-sweep-deferred")).toHaveLength(0);
  });

  it("r4：真实 running 证言（恰现在）→ 豁免照常（容差归零不误伤）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    const T0 = Date.now();
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = T0 - 65_000;
    await writeTeam(stateRoot, team);
    await seedWitness("sess_b", "running", T0 - 60_000); // 过去 60s：正常 running 证言

    expect(await sweepStaleTasksOnce(deps, T0)).toMatchObject({ swept: 0, skipped: true });
    expect(await taskOf(taskId)).toMatchObject({ status: "in_progress", assignee: "b" });
  });
});

describe("V090-01 r2：自洽过去值伪造（running + 可信过去时刻）", () => {
  /** 攻击形态 1-r2：自洽伪造（全部过去时刻——轮 1 的未来值校验拦不住的变体）。 */
  function writeSelfConsistentForgedRecord(sid: string, tsOffsetMs = -1_000): void {
    const now = Date.now();
    writeFileSync(
      join(stateRoot, "registry", "sessions", `${sid}.json`),
      JSON.stringify({
        sessionId: sid,
        cwd: workDir,
        startedAt: now - 3_600_000,
        lastSeen: now - 60_000,
        liveness: "running",
        livenessTs: now + tsOffsetMs,
        lastEventTs: now + tsOffsetMs,
      }),
      "utf8",
    );
  }

  it("单文件伪造（无端点证词）→ 不豁免，任务照常回池（对照组同参）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    writeSelfConsistentForgedRecord("sess_b");

    const summary = await sweepStaleTasksOnce(deps);
    expect(summary).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
    expect(engineEvents().filter((e) => e["event"] === "task-swept")).toHaveLength(1);
    // 观测面可见伪造签名：running 自述 + endpointLive=false（三视图同字段）。
    const payload = payloadOf(await handleOverview(deps, { view: "team" }, "conn-a")) as Record<string, unknown>;
    const rows = payload["members"] as Array<{ key: string; liveness?: { state: string; endpointLive: boolean } }>;
    expect(rows.find((m) => m.key === "b")?.liveness).toMatchObject({ state: "running", endpointLive: false });
  });

  it("伪造 + 心跳已停的伪造 peer 记录（pid 活、lastSeen 陈旧 = heartbeat-stale）→ 不豁免", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    writeSelfConsistentForgedRecord("sess_b");
    // 伪造的第二份文件：pid 活（本进程）但心跳 5min 前停 → memberLiveness=heartbeat-stale ≠ live。
    await seedLivePeerRecord("sess_b", Date.now() - 5 * 60_000);

    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
  });

  it("r3 case1r3 精确形态：自述伪造 + 自有活 server 端点（endpointLive=true）→ 仍照扫", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    await backdateOpenTask(2 * 60_000);
    // 裁决 case1r3 攻击：一次外部写把自述记录伪造成 running + 过去可信时刻；
    // 攻击者自有的 MCP server 全会话常驻（15s 端点心跳）→ peer 注册表该 sid 记录 live。
    writeSelfConsistentForgedRecord("sess_b"); // 自述 running + 过去可信时刻
    await seedLivePeerRecord("sess_b"); // 自有活 server 的端点心跳（r2 修法的绕过面）

    // 绕过前提复现：三视图自述 running 且 endpointLive=true（r2 闸门确实被满足）……
    const payload = payloadOf(await handleOverview(deps, { view: "team" }, "conn-a")) as Record<string, unknown>;
    const rows = payload["members"] as Array<{ key: string; liveness?: { state: string; endpointLive: boolean } }>;
    expect(rows.find((m) => m.key === "b")?.liveness).toMatchObject({ state: "running", endpointLive: true });

    // ……但豁免只认引擎证言：无证言 → 照扫（对照组同参）。
    expect(await sweepStaleTasksOnce(deps)).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
    expect(engineEvents().filter((e) => e["event"] === "task-swept")).toHaveLength(1);
    // 伪造签名留痕：自述 running 而无证言 → session-record-anomaly。
    expect(engineEvents().filter((e) => e["event"] === "session-record-anomaly" && e["sessionId"] === "sess_b")).toHaveLength(1);
  });

  it("r3：伪造 peer 记录不再产生豁免（端点活性非豁免输入）；证言停止后有界照扫", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    const T0 = Date.now();
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = T0 - 65_000;
    await writeTeam(stateRoot, team);
    writeSelfConsistentForgedRecord("sess_b");
    await seedLivePeerRecord("sess_b", T0); // 伪造 peer 记录（r2 攻击面）：r3 起非豁免输入

    // 第 1 轮（now=T0）：自述+peer 双伪造 → 无引擎证言 → 照扫（r2 攻击面已闭）。
    expect(await sweepStaleTasksOnce(deps, T0)).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
  });

  it("r3：证言有界——running 证言 2×阈值后失效照扫（防永久滞留，V090-GUIDANCE-R3）", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    const T0 = Date.now();
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = T0 - 65_000;
    await writeTeam(stateRoot, team);
    await seedWitness("sess_b", "running", T0 - 60_000); // 回合起了（引擎亲见）

    // 第 1 轮（now=T0）：running 证言 1min 前 → owner-running 豁免。
    expect(await sweepStaleTasksOnce(deps, T0)).toMatchObject({ swept: 0, skipped: true });
    expect(await taskOf(taskId)).toMatchObject({ status: "in_progress", assignee: "b" });

    // 第 2 轮（now=T0+121s）：证言 2min+ 前 > 2×阈值（120s）→ 有界失效，照扫。
    expect(await sweepStaleTasksOnce(deps, T0 + 121_000)).toMatchObject({ swept: 1, skipped: false });
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
  });
});

describe("V090-05 r2：豁免不壅蔽 C8（离线转交通知照发）", () => {
  it("豁免任务命中 idle-timeout → task-offline + lead 转交通知；offlineNoticeAt 持久闸防重复", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1", XC_OFFLINE_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    const T0 = Date.now();
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = T0 - 65_000;
    task.lastProgressTs = T0 - 65_000;
    await writeTeam(stateRoot, team);
    // 引擎证言 running（豁免成立）；idle-timeout 阈值 1min，任务 65s 无进展 → C8 命中。
    await seedWitness("sess_b", "running", T0 - 1_000);

    // 第 1 轮：豁免（不回池）但 C8 兜底照发（idle-timeout → task-offline + lead 通知）。
    expect(await sweepStaleTasksOnce(deps, T0)).toMatchObject({ swept: 0, skipped: false, offline: 1 });
    expect(await taskOf(taskId)).toMatchObject({ status: "in_progress", assignee: "b" });
    const offline = engineEvents().filter((e) => e["event"] === "task-offline");
    expect(offline).toHaveLength(1);
    expect(offline[0]).toMatchObject({ evidence: "idle-timeout", member: "b" });
    const boxA = await readMailbox(stateRoot, "default", "a");
    expect(boxA.some((m) => m.content.includes("task-receipt") && m.content.includes("offline"))).toBe(true);
    // v0.9.1 r3（V090-02）：豁免任务的通知文案**如实分流**——写「仍滞留属主名下、未回池」，
    // 不再谎称「requeued to the pending pool」（lead 按旧文案去待领池找不到任务）。
    const notice = boxA.find((m) => m.content.includes("offline-handover"))!.content;
    const noticeFrame = JSON.parse(notice) as { error: string; offline: { tasks: Array<{ taskId: string; requeued: boolean }> } };
    expect(noticeFrame.error).toContain('still held by "b" under liveness exemption');
    expect(noticeFrame.error).toContain("NOT requeued");
    expect(noticeFrame.error).not.toContain("requeued to the pending pool");
    const frame = noticeFrame;
    expect(frame.offline.tasks).toEqual([{ taskId, status: "in_progress", idleForMin: 1, requeued: false }]);
    // 任务确实未回池（豁免只暂停回池）。
    expect(await taskOf(taskId)).toMatchObject({ status: "in_progress", assignee: "b" });
    // 通知闸落盘。
    const afterTeam = (await readTeam(stateRoot, "default"))!;
    expect(afterTeam.tasks.find((t) => t.id === taskId)?.offlineNoticeAt).toBe(T0);

    // 第 2 轮（阈值窗口内）：豁免照旧，但通知不重复（闸生效）。
    expect(await sweepStaleTasksOnce(deps, T0 + 30_000)).toMatchObject({ swept: 0, offline: 0 });
    expect(engineEvents().filter((e) => e["event"] === "task-offline")).toHaveLength(1);
  });

  it("r3（V090-02）：真回池路径的通知文案不变（仍写 requeued to the pending pool）", async () => {
    // 无证言 → 无豁免 → 任务真回池；offline 命中（pid-dead / idle-timeout）时通知走旧文案。
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1", XC_OFFLINE_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    const T0 = Date.now();
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = T0 - 65_000;
    task.lastProgressTs = T0 - 65_000;
    await writeTeam(stateRoot, team);

    expect(await sweepStaleTasksOnce(deps, T0)).toMatchObject({ swept: 1, offline: 1 });
    const boxA = await readMailbox(stateRoot, "default", "a");
    const notice = boxA.find((m) => m.content.includes("offline-handover"))!.content;
    const frame = JSON.parse(notice) as { error: string; offline: { tasks: Array<{ taskId: string; requeued: boolean }> } };
    expect(frame.error).toContain("open task(s) requeued to the pending pool");
    expect(frame.error).not.toContain("liveness exemption");
    expect(frame.offline.tasks).toEqual([{ taskId, status: "in_progress", idleForMin: 1, requeued: true }]);
    // 任务确实已回池。
    expect(await taskOf(taskId)).toMatchObject({ status: "pending", assignee: null });
  });

  it("伪造 offlineNoticeAt=+1年（压制 C8 通知）→ 读盘丢弃，闸重开通知照发", async () => {
    const deps = makeDeps({ XC_STALE_TASK_MINUTES: "1", XC_OFFLINE_MINUTES: "1" });
    const core = createToolCore(deps);
    await hookRegister(core, "conn-a", "a", "sess_a");
    await hookRegister(core, "conn-b", "b", "sess_b");
    const taskId = await dispatchAndStart(core, "conn-b", "conn-a");
    const T0 = Date.now();
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    task.updatedAt = T0 - 65_000;
    task.lastProgressTs = T0 - 65_000;
    task.offlineNoticeAt = T0 + 365 * 24 * 60 * 60_000; // 伪造未来值：企图永久压制通知
    await writeTeam(stateRoot, team);
    await seedWitness("sess_b", "running", T0 - 1_000);

    expect(await sweepStaleTasksOnce(deps, T0)).toMatchObject({ swept: 0, offline: 1 });
    expect(engineEvents().filter((e) => e["event"] === "task-offline")).toHaveLength(1);
    // 读盘闸已重开（未来值字段被 coerce 丢弃 → 现算 offlineNoticeAt=now 落盘）。
    const afterTeam = (await readTeam(stateRoot, "default"))!;
    expect(afterTeam.tasks.find((t) => t.id === taskId)?.offlineNoticeAt).toBe(T0);
  });
});
