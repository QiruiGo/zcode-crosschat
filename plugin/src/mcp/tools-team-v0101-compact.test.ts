/**
 * v0.10.1（G-26）定向单测：xc_team action=compact —— 主控代成员会话执行上下文压缩。
 *
 * 锁死契约（闸门顺序逐个判，命中即返回；「有没有调用协议客户端 / 有没有写审计 /
 * 有没有投递消息」三面对拍）：
 * 1. 非主控 → not_lead（零副作用：不调协议、不写审计、不投消息、不唤醒）；
 * 2. 压缩自己 → self_not_allowed；
 * 3. 成员不存在 → unknown_member；
 * 4. 交互式成员（identity≠engine / engine 粘滞标但持有者非无头）→ interactive_unsupported；
 * 5. 成员退出压缩（成员行 compact:false）→ compact_opted_out；
 * 6. 成员忙（会话记录 liveness=running 且时刻可信）→ member_busy；
 * 7. 无新检查点且无 force → checkpoint_required：先唤醒成员去落检查点（attemptWake
 *    被调 + 邮箱有要求 xc_team checkpoint 的消息 + 审计 member-compact-checkpoint-required），
 *    **不**调用压缩；
 * 8. 有新检查点的成功路径（note 传递、前后 token 数、审计 member-compacted、邮箱
 *    **不唤醒**的通知、互斥/标记解除）；
 * 9. force 成功路径（审计记 force:true + 说明加「该成员未落新检查点——」前缀）；
 * 10. 协议报错 → compact_failed（审计 member-compact-failed + 标记解除）；
 * 11. member-add 的 compact 参数落盘 + 没有该字段的旧成员行按允许处理。
 *
 * 评审修复轮新增：
 * - F3：removed 成员 → member_removed（member-stop 同语义）；
 * - F4：provisioning/failed → member_provisioning（不误报 interactive_unsupported）；
 * - F5：收尾清标记自兜错（清锁失败不掩盖压缩成功结果，落 member-compact-flag-clear-failed）；
 * - F6：标记新鲜时并发二次 compact → member_busy（不二次压缩）；团队锁等待耗尽
 *   （LockBusyError）→ member_busy 而非 compact_failed；
 * - F7：压缩窗口内到达的消息在成功/失败路径都补唤醒（scene compact-resume，
 *   receiptIds 恰为窗口内新到消息、不含不唤醒通知本身）；
 * - F12：mock 执行期间断言 compactInProgressAt 已置位（删置位行必红）；
 * - F14：置位前锁内复验授权（lead 被换 → not_lead）；
 * - F15：force 且无检查点的通知文案分叉（不再「无检查点」接「先读该检查点」）；
 * - F21：闸 2/3/4/5/6 负路径统一断言「不写审计、不投邮箱、不唤醒」（member-compact-*
 *   全族零事件）；F22：checkpoint_required 唤醒的 receiptIds/ticket 对拍；F23：force
 *   成功路径副作用断言；F25：检查点新鲜度取 latestCheckpoint.createdAt（front-matter
 *   优先）——mtime 新但 front-matter 旧照样不新鲜，反之亦然。
 *
 * 协议客户端（engine/compact.js compactMemberSession）与唤醒（engine/wake.js
 * attemptWake）以 mock 替身注入（零真实 spawn/会话，同 tools-team-v0100d-member-add-duty
 * 测试模式）。
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleTeamCompact, TeamShape, createMemberToolCore, compactCheckpointMaxAgeMinutes, checkpointAgeTrustworthy } from "./tools-team.js";
import { identityStore } from "./identity.js";
import { writeSession } from "../core/registry.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import { checkpointFile, engineLogFile, lockFile, teamLockNames } from "../core/paths.js";
import { checkpointStamp } from "../core/checkpoint.js";
import { sessionTurnLockName } from "../core/lock.js";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import { readJsonl } from "../core/jsonl.js";
import { COMPACT_IN_PROGRESS_STALE_MS, compactMemberSession, type CompactOutcome } from "../engine/compact.js";
import { attemptWake } from "../engine/wake.js";
import { provisionMember } from "../engine/provision.js";
import type { TeamMember, TeamState } from "../core/types.js";
import type { ToolDeps } from "./core.js";

vi.mock("../engine/compact.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/compact.js")>();
  return {
    ...actual,
    compactMemberSession: vi.fn(async (): Promise<CompactOutcome> => {
      throw new Error("compactMemberSession mock not configured");
    }),
  };
});

vi.mock("../engine/wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/wake.js")>();
  return {
    ...actual,
    attemptWake: vi.fn(async (): Promise<{ delivered: "wake"; note?: string; startConfirmed?: boolean }> => ({
      delivered: "wake",
      startConfirmed: true,
    })),
  };
});

vi.mock("../engine/provision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/provision.js")>();
  return {
    ...actual,
    provisionMember: vi.fn(async (_deps: ToolDeps, spec: { key: string }) => ({
      sessionId: `sess_${spec.key}`,
      providerId: "prov-test",
      modelId: "glm-test",
      reasoningLevel: "max",
      welcomeResponse: "welcome (mock)",
      reprovisioned: false,
    })),
  };
});

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;
/** 检查点种子的基准时刻 = 真实时钟（处理器用 Date.now() 判新鲜度，种子必须同基准）。 */
const NOW = () => Date.now();

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v0101-compact-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: {} };
  vi.mocked(compactMemberSession).mockReset();
  vi.mocked(compactMemberSession).mockImplementation(async () => {
    throw new Error("compactMemberSession mock not configured");
  });
  vi.mocked(attemptWake).mockClear();
  vi.mocked(provisionMember).mockClear();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function teamWith(members: TeamMember[]): TeamState {
  return {
    teamId: "default",
    name: "default",
    founderKey: "ldr1",
    leadKey: "ldr1",
    phase: "open",
    members,
    tasks: [],
    seq: 0,
    createdAt: 1,
  };
}

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key,
    sessionId: `sess_${key}`,
    role: "worker",
    identity: "engine",
    joinedAt: 1,
    lastSeen: 1,
    state: "ready",
    ...overrides,
  };
}

async function bindIdentity(conn: string, agentKey: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: `sess_${agentKey}`, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  identityStore.bind(conn, {
    sessionKey: `xc:default:${agentKey}`,
    teamId: "default",
    name: agentKey,
    agentKey,
    sessionId: `sess_${agentKey}`,
    role: "worker",
    boundAt: Date.now(),
  });
}

/** 成员行的无头持有者证据（engineHolderIsHeadless 判据：记录 boundName === 本名）。 */
async function bindMemberSession(key: string, record: Partial<{ liveness: "running" | "idle" | "dead"; livenessTs: number; boundName: string }> = {}): Promise<void> {
  await writeSession(stateRoot, {
    sessionId: `sess_${key}`,
    cwd: workDir,
    startedAt: Date.now(),
    lastSeen: Date.now(),
    boundName: key,
    ...record,
  });
}

/**
 * 落一份检查点。createdAt 写进 front-matter（latestCheckpoint.createdAt 的第一真源），
 * offsetMs>0 时再把文件 mtime 一并回溯（F25 之后 mtime 只是回退口径）。
 */
async function seedCheckpoint(key: string, offsetMs = 0): Promise<string> {
  await mkdir(join(stateRoot, "checkpoints", key), { recursive: true });
  const writtenAt = NOW() - offsetMs;
  const stamp = checkpointStamp(writtenAt);
  const path = checkpointFile(stateRoot, key, stamp);
  await writeFile(path, `---\ncreatedAt: ${new Date(writtenAt).toISOString()}\n---\n# checkpoint\n`);
  if (offsetMs > 0) {
    await utimes(path, new Date(writtenAt), new Date(writtenAt));
  }
  return path;
}

/** 对抗检验 3a：落一份 front-matter createdAt 写在指定时刻（可为未来）的检查点。 */
async function seedCheckpointWithCreatedAt(key: string, createdAtMs: number): Promise<string> {
  await mkdir(join(stateRoot, "checkpoints", key), { recursive: true });
  const path = checkpointFile(stateRoot, key, checkpointStamp(createdAtMs));
  await writeFile(path, `---\ncreatedAt: ${new Date(createdAtMs).toISOString()}\n---\n# checkpoint\n`);
  return path;
}

/** 对抗检验 3b：无 front-matter 的裸检查点（latestCheckpoint.createdAt 回退 mtime），mtime 用 utimes 拨到指定时刻。 */
async function seedCheckpointRaw(key: string, mtimeMs: number): Promise<string> {
  await mkdir(join(stateRoot, "checkpoints", key), { recursive: true });
  const path = checkpointFile(stateRoot, key, checkpointStamp(mtimeMs));
  await writeFile(path, "# checkpoint (no front-matter)\n");
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

async function compact(name: string, args: { note?: string; force?: boolean } = {}, conn = "conn-lead"): Promise<{ result: ToolResult; payload: Record<string, unknown> }> {
  const result = await handleTeamCompact(deps, { name, ...args }, conn);
  return { result, payload: payloadOf(result) as Record<string, unknown> };
}

/**
 * fake-timers 驱动器（评审 F6/F14/F5 用例专用）：
 * - realYield：真·事件循环让路——vi.useFakeTimers() 劫持了 setTimeout/setImmediate，
 *   被测代码里的真实 fs I/O 只有靠原始计时器让出的 macrotask 才能继续；
 * - waitForPendingFakeTimer：等到被测 promise 真正挂起在锁等待循环的首个 sleep 上
 *   （闸面 fs 全部走完），之后改盘才落在「读盘后、置位前」的窗口上；
 * - driveToSettle：反复推进假时钟直到落定（单次大步 advance 在 I/O 未完成时是空转，
 *   之后挂起的 fake sleep 永远不会再被推进——死锁）。
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis) as unknown as typeof setTimeout;
const realYield = (): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, 0));

async function waitForPendingFakeTimer(max = 500): Promise<void> {
  for (let i = 0; i < max && vi.getTimerCount() === 0; i++) {
    await realYield();
  }
  expect(vi.getTimerCount()).toBeGreaterThan(0);
}

async function driveToSettle<T>(promise: Promise<T>): Promise<T> {
  const settledMarker = promise.then(() => "settled" as const, () => "settled" as const);
  for (let i = 0; i < 600; i++) {
    const state = await Promise.race([
      settledMarker.then(() => "settled" as const),
      Promise.resolve("pending" as const),
    ]);
    if (state === "settled") break;
    await vi.advanceTimersByTimeAsync(3_000);
    await realYield();
  }
  return promise;
}

async function auditEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    return await readJsonl<Record<string, unknown>>(engineLogFile(stateRoot), (v): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v));
  } catch {
    return [];
  }
}

function auditOf(events: Array<Record<string, unknown>>, name: string): Array<Record<string, unknown>> {
  return events.filter((e) => e["event"] === name);
}

/** F21：member-compact-* 全族审计（闸门负路径必须零事件——漏写 member-compact-failed/
 *  member-compact-checkpoint-required 等意外事件也让测试红）。 */
function auditCompactFamily(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.filter((e) => String(e["event"]).startsWith("member-compact"));
}

async function mailboxOf(key: string) {
  return readMailbox(stateRoot, "default", key);
}

async function compactCalls(): Promise<Array<unknown[]>> {
  return vi.mocked(compactMemberSession).mock.calls;
}

/** F21：闸门负路径统一对拍——协议零调用、零唤醒、零 member-compact-* 审计、目标邮箱零投递。 */
async function expectNoCompactSideEffects(targetKey: string): Promise<void> {
  expect(await compactCalls()).toHaveLength(0);
  expect(vi.mocked(attemptWake)).not.toHaveBeenCalled();
  expect(auditCompactFamily(await auditEvents())).toHaveLength(0);
  expect(await mailboxOf(targetKey)).toHaveLength(0);
}

/** 手写一个锁文件（测试模拟持锁者；格式同 core/lock 的 LockContent）。 */
async function seedLockFile(name: string, pid: number): Promise<void> {
  await mkdir(join(stateRoot, "locks"), { recursive: true });
  await writeFile(lockFile(stateRoot, name), JSON.stringify({ pid, ts: Date.now(), token: "test-token" }));
}

/** 一个保活的外部活进程（pidAlive 判真），测试结束回收。 */
function spawnAliveHolder(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000_000)"], { stdio: "ignore" });
}

beforeEach(async () => {
  await bindIdentity("conn-lead", "ldr1");
  await bindIdentity("conn-m1", "m1");
  await bindMemberSession("m1");
  await writeTeam(stateRoot, teamWith([
    member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
    member("m1"),
  ]));
});

describe("v0.10.1 G-26：xc_team compact 闸门（顺序逐个判，命中即返回）", () => {
  it("1. 非主控 → not_lead；零副作用（不调协议、不写审计、不投消息、不唤醒）", async () => {
    const { result } = await compact("m1", {}, "conn-m1");
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: "not_lead" });
    await expectNoCompactSideEffects("m1");
  });

  it("2. 压缩自己 → self_not_allowed；零副作用", async () => {
    const { payload } = await compact("ldr1");
    expect(payload).toMatchObject({ error: "self_not_allowed", name: "ldr1" });
    await expectNoCompactSideEffects("ldr1");
  });

  it("3. 成员不存在 → unknown_member；零副作用", async () => {
    const { payload } = await compact("ghost");
    expect(payload).toMatchObject({ error: "unknown_member", name: "ghost" });
    await expectNoCompactSideEffects("ghost");
  });

  it("4. 交互式成员 → interactive_unsupported（identity≠engine，或 engine 粘滞标但持有者非无头）；零副作用", async () => {
    // identity 缺省 = self（存量 peer 注册）→ 交互式
    await writeTeam(stateRoot, teamWith([
      member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
      member("m1", { identity: undefined }),
    ]));
    const { payload } = await compact("m1");
    expect(payload).toMatchObject({ error: "interactive_unsupported" });
    await expectNoCompactSideEffects("m1");

    // engine 粘滞标但当前 sid 的会话记录不是无头持有者（boundName 缺失 = 交互式接管形态）
    await writeTeam(stateRoot, teamWith([
      member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
      member("m1"),
    ]));
    await writeSession(stateRoot, {
      sessionId: "sess_m1", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now(),
      // 无 boundName：交互式会话锚定（SessionStart 钩子形态）
    });
    const { payload: payload2 } = await compact("m1");
    expect(payload2).toMatchObject({ error: "interactive_unsupported" });
    await expectNoCompactSideEffects("m1");
  });

  it("5. 成员退出压缩（compact:false）→ compact_opted_out；零副作用（force 也不放行）", async () => {
    await writeTeam(stateRoot, teamWith([
      member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
      member("m1", { compact: false }),
    ]));
    const { payload } = await compact("m1", { force: true });
    expect(payload).toMatchObject({ error: "compact_opted_out", name: "m1" });
    await expectNoCompactSideEffects("m1");
  });

  it("6. 成员忙（liveness=running 且时刻可信）→ member_busy；force 不放行；零副作用", async () => {
    await bindMemberSession("m1", { liveness: "running", livenessTs: Date.now() });
    const { payload } = await compact("m1", { force: true });
    expect(payload).toMatchObject({ error: "member_busy", name: "m1" });
    await expectNoCompactSideEffects("m1");
  });

  it("6b（评审 F3）. removed 成员 → member_removed（member-stop/dispatch 同语义；不 resume 不 compact 不投邮箱）", async () => {
    await writeTeam(stateRoot, teamWith([
      member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
      member("m1", { state: "removed" }),
    ]));
    const { payload } = await compact("m1", { force: true });
    expect(payload).toMatchObject({ error: "member_removed", name: "m1" });
    await expectNoCompactSideEffects("m1");
  });

  it("6c（评审 F4）. provisioning/failed 成员 → member_provisioning（准确状态，不误报 interactive_unsupported）", async () => {
    await writeTeam(stateRoot, teamWith([
      member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
      member("m1", { state: "provisioning" }),
    ]));
    const { payload } = await compact("m1");
    expect(payload).toMatchObject({ error: "member_provisioning", name: "m1", memberState: "provisioning" });
    await expectNoCompactSideEffects("m1");

    await writeTeam(stateRoot, teamWith([
      member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
      member("m1", { state: "failed" }),
    ]));
    const { payload: p2 } = await compact("m1");
    expect(p2).toMatchObject({ error: "member_provisioning", name: "m1", memberState: "failed" });
    expect(String(p2["message"])).toContain("member-add");
    await expectNoCompactSideEffects("m1");
  });
});

describe("v0.10.1 G-26：checkpoint_required 闸（唤醒去落检查点，不调用压缩）", () => {
  it("7. 无检查点且无 force → 先唤醒成员落检查点、审计、返回 checkpoint_required；协议客户端不被调用；receiptIds/ticket 对拍（F22）", async () => {
    const { result, payload } = await compact("m1");
    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      error: "checkpoint_required",
      name: "m1",
      checkpointRequested: true,
      checkpointRequestDelivered: "wake",
      maxAgeMinutes: 30,
    });
    // 协议客户端零调用
    expect(await compactCalls()).toHaveLength(0);
    // 会唤醒的消息：attemptWake 被调（场景 compact-checkpoint）+ 邮箱有要求 xc_team checkpoint 的原文
    expect(vi.mocked(attemptWake)).toHaveBeenCalledTimes(1);
    const wakeCall = vi.mocked(attemptWake).mock.calls[0]![0] as unknown as {
      reason: string; toAgentKey: string; toSessionId: string; receiptIds: readonly string[]; ticket: string;
    };
    expect(wakeCall.reason).toBe("compact-checkpoint");
    expect(wakeCall.toAgentKey).toBe("m1");
    expect(wakeCall.toSessionId).toBe("sess_m1");
    // F22：receiptIds 恰为刚投的那条消息 id（实现传空数组/错 id 都会红）；ticket 携带行动指令原文
    const mail = await mailboxOf("m1");
    expect(mail).toHaveLength(1);
    expect(Array.from(wakeCall.receiptIds)).toEqual([mail[0]!.id]);
    expect(wakeCall.ticket).toContain('xc_team({action:"checkpoint"');
    expect(wakeCall.ticket).toContain("保持空闲");
    expect(mail[0]!.content).toContain('xc_team({action:"checkpoint"');
    expect(mail[0]!.content).toContain("保持空闲");
    // 审计：member-compact-checkpoint-required
    const events = auditOf(await auditEvents(), "member-compact-checkpoint-required");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "m1", by: "ldr1", delivered: "wake", maxAgeMinutes: 30 });
  });

  it("7b. 检查点超龄（> XC_COMPACT_CHECKPOINT_MAX_AGE_MIN）同闸；env 可调窗；非法 env 回落缺省", async () => {
    // 40 分钟前写的检查点，默认窗 30 分钟 → 不新鲜
    await seedCheckpoint("m1", 40 * 60_000);
    const { payload } = await compact("m1");
    expect(payload).toMatchObject({ error: "checkpoint_required", maxAgeMinutes: 30 });
    expect(await compactCalls()).toHaveLength(0);

    // env 把窗调大到 60 分钟 → 新鲜，走到协议面（force 语义之外的正路）
    vi.mocked(compactMemberSession).mockImplementation(async () => ({
      preCompactTokenCount: 10,
      postCompactTokenCount: 5,
      durationMs: 1,
    }));
    const freshDeps: ToolDeps = { stateRoot, workspace: workDir, env: { XC_COMPACT_CHECKPOINT_MAX_AGE_MIN: "60" } };
    const result = await handleTeamCompact(freshDeps, { name: "m1" }, "conn-lead");
    expect(result.isError).toBeFalsy();
    // 非法值回落缺省 30（纯函数直证）
    expect(compactCheckpointMaxAgeMinutes({ XC_COMPACT_CHECKPOINT_MAX_AGE_MIN: "abc" })).toBe(30);
    expect(compactCheckpointMaxAgeMinutes({ XC_COMPACT_CHECKPOINT_MAX_AGE_MIN: "0" })).toBe(30);
    expect(compactCheckpointMaxAgeMinutes({})).toBe(30);
    expect(compactCheckpointMaxAgeMinutes({ XC_COMPACT_CHECKPOINT_MAX_AGE_MIN: "15" })).toBe(15);
  });

  it("7c（评审 F25）. 新鲜度取 latestCheckpoint 的 createdAt（front-matter 优先）：mtime 新但 front-matter 旧 → 仍 checkpoint_required", async () => {
    // front-matter createdAt = 40 分钟前；文件 mtime 被 utimes 拨到现在（外部触碰形态）
    const path = await seedCheckpoint("m1", 40 * 60_000);
    await utimes(path, new Date(), new Date());
    const { payload } = await compact("m1");
    expect(payload).toMatchObject({ error: "checkpoint_required" });
    expect(payload["checkpointAgeMin"]).toBeGreaterThanOrEqual(40);
    expect(await compactCalls()).toHaveLength(0);
  });

  it("7d（评审 F25）. 反向：mtime 陈旧但 front-matter createdAt 新鲜 → 照常过闸（与展示面同一真源）", async () => {
    // 检查点 front-matter createdAt = 现在；文件 mtime 回溯 40 分钟（拷贝/还原形态）
    const path = await seedCheckpoint("m1");
    await utimes(path, new Date(Date.now() - 40 * 60_000), new Date(Date.now() - 40 * 60_000));
    vi.mocked(compactMemberSession).mockImplementation(async () => ({ preCompactTokenCount: 1, postCompactTokenCount: 1, durationMs: 1 }));
    const { result } = await compact("m1");
    expect(result.isError).toBeFalsy();
  });
  it("7e（对抗检验 3a）. front-matter createdAt 写在未来（超 60s 容差）→ 不可信时刻，判不新鲜走 checkpoint_required（payload/审计披露 futureSkew）；force 才放行", async () => {
    await seedCheckpointWithCreatedAt("m1", NOW() + 60 * 60_000); // 1 小时后的未来
    const { payload } = await compact("m1");
    expect(payload).toMatchObject({ error: "checkpoint_required", name: "m1" });
    expect(payload["checkpointTsFutureSkewMs"]).toBeGreaterThanOrEqual(59 * 60_000);
    expect(await compactCalls()).toHaveLength(0);
    // 审计如实披露 skew（过期文件被当依据之前先被闸下）
    const events = auditOf(await auditEvents(), "member-compact-checkpoint-required");
    expect(events).toHaveLength(1);
    expect(events[0]["checkpointTsFutureSkewMs"]).toBeGreaterThanOrEqual(59 * 60_000);
    // force 明示跳过闸 6 → 放行（用户裁决优先于守卫）
    vi.mocked(compactMemberSession).mockImplementation(async () => ({ preCompactTokenCount: 1, postCompactTokenCount: 1, durationMs: 1 }));
    const { result } = await compact("m1", { force: true });
    expect(result.isError).toBeFalsy();
  });

  it("7f（对抗检验 3b）. 无 front-matter、mtime 拨到未来 → createdAt 回退 mtime 同样判不可信（同一守卫关闭两个变体）", async () => {
    await seedCheckpointRaw("m1", NOW() + 60 * 60_000);
    const { payload } = await compact("m1");
    expect(payload).toMatchObject({ error: "checkpoint_required", name: "m1" });
    expect(payload["checkpointTsFutureSkewMs"]).toBeGreaterThanOrEqual(59 * 60_000);
    expect(await compactCalls()).toHaveLength(0);
    expect(vi.mocked(attemptWake)).toHaveBeenCalledTimes(1); // 闸 6 照常唤醒去重落检查点
  });

  it("7g（对抗检验 3a 容差边界）. 未来 30s（≤60s 容差）→ 可信时刻、照常过闸（不把时钟毛刺当过期）", async () => {
    await seedCheckpointWithCreatedAt("m1", NOW() + 30_000);
    vi.mocked(compactMemberSession).mockImplementation(async () => ({ preCompactTokenCount: 1, postCompactTokenCount: 1, durationMs: 1 }));
    const { result } = await compact("m1");
    expect(result.isError).toBeFalsy();
  });

  it("7h（对抗检验 3a/3b 纯函数边界）. checkpointAgeTrustworthy：容差内可信（恰 ±60s）、超容差不可信；过去值不归它管", () => {
    const nowFixed = NOW(); // 单一冻结基准：两参同源，防真实时钟推进翻转边界
    expect(checkpointAgeTrustworthy(nowFixed, nowFixed)).toBe(true);
    expect(checkpointAgeTrustworthy(nowFixed - 60_000, nowFixed)).toBe(true);
    expect(checkpointAgeTrustworthy(nowFixed + 60_000, nowFixed)).toBe(true); // 恰在容差上（-60000 ≥ -60000）
    expect(checkpointAgeTrustworthy(nowFixed + 60_001, nowFixed)).toBe(false);
    expect(checkpointAgeTrustworthy(nowFixed + 60 * 60_000, nowFixed)).toBe(false);
    expect(checkpointAgeTrustworthy(nowFixed - 40 * 60_000, nowFixed)).toBe(true); // 过去时刻不归本守卫管
  });

});

describe("v0.10.1 G-26：成功路径（协议、审计、不唤醒通知、互斥解除）", () => {
  it("8. 有新检查点 + note → 压缩被调用（note 作 instructions）、审计带前后 token 与检查点路径、邮箱收不唤醒通知、attemptWake 不被调、标记解除；mock 执行期间标记已置位（F12）", async () => {
    const checkpointPath = await seedCheckpoint("m1");
    vi.mocked(compactMemberSession).mockImplementation(async (input) => {
      // 协议客户端收到的入参对拍（sessionId / instructions = note）
      expect((input as { sessionId: string }).sessionId).toBe("sess_m1");
      expect((input as { instructions?: string }).instructions).toBe("保留任务 A 的验收标准与当前进度");
      // F12：协议执行期间 compactInProgressAt 必须已置位（删掉置位行此断言必红——
      // 置位失效正是「压缩期间挡唤醒防并发写」要防的事故）
      const teamDuring = (await readTeam(stateRoot, "default"))!;
      expect(teamDuring.members.find((m) => m.key === "m1")!.compactInProgressAt).toBeDefined();
      return { preCompactTokenCount: 40000, postCompactTokenCount: 9000, truePostCompactTokenCount: 8800, operationId: "cmp_test1", durationMs: 1234 };
    });
    const { result, payload } = await compact("m1", { note: "保留任务 A 的验收标准与当前进度" });
    expect(result.isError).toBeFalsy();
    expect(payload).toMatchObject({
      name: "m1",
      sessionId: "sess_m1",
      preCompactTokenCount: 40000,
      postCompactTokenCount: 9000,
      truePostCompactTokenCount: 8800,
      operationId: "cmp_test1",
      checkpointPath,
      durationMs: 1234,
    });
    expect(await compactCalls()).toHaveLength(1);
    // 审计 member-compacted：谁、对谁、前后 token、检查点路径（无 force 键）
    const events = auditOf(await auditEvents(), "member-compacted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "m1", by: "ldr1",
      preCompactTokenCount: 40000, postCompactTokenCount: 9000, truePostCompactTokenCount: 8800,
      checkpointPath, operationId: "cmp_test1",
    });
    expect(events[0]["force"]).toBeUndefined();
    // 不唤醒的通知：邮箱恰 1 条、attemptWake 未被调（窗口内无新消息 → 也无补唤醒）
    expect(vi.mocked(attemptWake)).not.toHaveBeenCalled();
    const mail = await mailboxOf("m1");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.from).toBe("ldr1");
    expect(mail[0]!.content).toContain("40000");
    expect(mail[0]!.content).toContain("9000");
    expect(mail[0]!.content).toContain(checkpointPath);
    expect(mail[0]!.content).toContain("先读该检查点");
    // 互斥/标记解除：成员行无 compactInProgressAt（评审 F1：字段为置位时刻）
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "m1")!.compactInProgressAt).toBeUndefined();
  });

  it("8b（评审 F7）. 压缩窗口内到达的消息 → 成功后补唤醒一次（scene compact-resume；receiptIds 恰为窗口内新到消息，不含不唤醒通知）", async () => {
    await seedCheckpoint("m1");
    const arrivedMessageId = { id: "" };
    vi.mocked(compactMemberSession).mockImplementation(async () => {
      // 模拟压缩窗口内别的会话给 m1 投了一条消息（其唤醒被标记闸跳过、只入箱）
      const msg = createMessage("ldr1", "m1", "压缩期间到达的急件", { deliveryClaimedAt: Date.now() });
      arrivedMessageId.id = msg.id;
      await appendMailbox(stateRoot, "default", "m1", msg);
      return { preCompactTokenCount: 100, postCompactTokenCount: 50, durationMs: 1 };
    });
    const { result, payload } = await compact("m1");
    expect(result.isError).toBeFalsy();
    // 补唤醒：恰一次、场景 compact-resume、receiptIds 恰为窗口内新到的那条（不含通知本身）
    expect(vi.mocked(attemptWake)).toHaveBeenCalledTimes(1);
    const wakeCall = vi.mocked(attemptWake).mock.calls[0]![0] as unknown as {
      reason: string; toAgentKey: string; receiptIds: readonly string[]; ticket: string;
    };
    expect(wakeCall.reason).toBe("compact-resume");
    expect(wakeCall.toAgentKey).toBe("m1");
    expect(Array.from(wakeCall.receiptIds)).toEqual([arrivedMessageId.id]);
    expect(wakeCall.ticket).toContain("压缩");
    expect(payload["catchUpWake"]).toMatchObject({ messageIds: [arrivedMessageId.id], delivered: "wake" });
  });

  it("8c（评审 F7）. 压缩窗口内无新消息 → 无补唤醒（通知保持不唤醒投递）", async () => {
    await seedCheckpoint("m1");
    vi.mocked(compactMemberSession).mockImplementation(async () => ({ preCompactTokenCount: 1, postCompactTokenCount: 1, durationMs: 1 }));
    const { payload } = await compact("m1");
    expect(payload["error"]).toBeUndefined();
    expect(vi.mocked(attemptWake)).not.toHaveBeenCalled();
    expect(payload["catchUpWake"]).toBeUndefined();
  });

  it("9. force 成功路径（检查点超龄）→ 协议被调、说明带 force 前缀、审计记 force:true、邮箱收通知且 attemptWake 不被调（F23）", async () => {
    await seedCheckpoint("m1", 40 * 60_000); // 超龄（默认窗 30min）
    vi.mocked(compactMemberSession).mockImplementation(async (input) => {
      expect((input as { instructions?: string }).instructions).toContain("该成员未落新检查点——");
      expect((input as { instructions?: string }).instructions).toContain("摘要必须保留");
      return { preCompactTokenCount: 500, postCompactTokenCount: 60, durationMs: 10 };
    });
    const { result, payload } = await compact("m1", { force: true });
    expect(result.isError).toBeFalsy();
    expect(payload).toMatchObject({ name: "m1", preCompactTokenCount: 500, postCompactTokenCount: 60, force: true });
    const events = auditOf(await auditEvents(), "member-compacted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "m1", by: "ldr1", force: true });
    // F23：通知照投（force 分支文案）、attemptWake 未被调、标记解除
    const mail = await mailboxOf("m1");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.content).toContain("force");
    expect(mail[0]!.content).toContain("500");
    expect(mail[0]!.content).toContain("60");
    expect(vi.mocked(attemptWake)).not.toHaveBeenCalled();
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "m1")!.compactInProgressAt).toBeUndefined();
  });

  it("9b（评审 F15）. force 且磁盘无检查点 → 通知文案分叉：不再「无检查点」接「先读该检查点」", async () => {
    // 不落任何检查点
    vi.mocked(compactMemberSession).mockImplementation(async () => ({ preCompactTokenCount: 10, postCompactTokenCount: 2, durationMs: 1 }));
    const { result, payload } = await compact("m1", { force: true });
    expect(result.isError).toBeFalsy();
    expect(payload["checkpointPath"]).toBeUndefined();
    const mail = await mailboxOf("m1");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.content).toContain("无（本次 force 未依据检查点）");
    expect(mail[0]!.content).not.toContain("先读该检查点");
    expect(mail[0]!.content).toContain("任务板");
    expect(vi.mocked(attemptWake)).not.toHaveBeenCalled();
  });
});

describe("v0.10.1 G-26：协议失败与 member-add 的 compact 参数", () => {
  it("10. 协议报错 → compact_failed 带根因；审计 member-compact-failed；标记解除", async () => {
    await seedCheckpoint("m1");
    vi.mocked(compactMemberSession).mockImplementation(async () => {
      throw new Error("rpc timeout: session/compact");
    });
    const { result, payload } = await compact("m1");
    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ error: "compact_failed", name: "m1", detail: "rpc timeout: session/compact" });
    const failed = auditOf(await auditEvents(), "member-compact-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ name: "m1", by: "ldr1", error: "rpc timeout: session/compact" });
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "m1")!.compactInProgressAt).toBeUndefined();
  });

  it("10b（评审 F7）. 协议失败路径也补唤醒：窗口内到达的消息先补发 compact-resume 唤醒，再报 compact_failed", async () => {
    await seedCheckpoint("m1");
    const arrivedMessageId = { id: "" };
    vi.mocked(compactMemberSession).mockImplementation(async () => {
      const msg = createMessage("ldr1", "m1", "压缩窗口内到达", { deliveryClaimedAt: Date.now() });
      arrivedMessageId.id = msg.id;
      await appendMailbox(stateRoot, "default", "m1", msg);
      throw new Error("rpc timeout: session/events");
    });
    const { payload } = await compact("m1");
    expect(payload).toMatchObject({ error: "compact_failed", name: "m1" });
    expect(vi.mocked(attemptWake)).toHaveBeenCalledTimes(1);
    const wakeCall = vi.mocked(attemptWake).mock.calls[0]![0] as unknown as { reason: string; receiptIds: readonly string[] };
    expect(wakeCall.reason).toBe("compact-resume");
    expect(Array.from(wakeCall.receiptIds)).toEqual([arrivedMessageId.id]);
    const failed = auditOf(await auditEvents(), "member-compact-failed");
    expect(failed).toHaveLength(1);
  });

  it("11. member-add 的 compact 参数落盘；重供给不带 compact 保留既有值；新成员缺省不落键；旧成员行无该字段按允许处理（闸 4 不命中）；重供给不复活压缩标记（F1）", async () => {
    // compact:false 落成员行
    const core = createMemberToolCore(deps);
    await core.xc_member_add({ name: "m2", compact: false }, "conn-lead");
    let team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "m2")!.compact).toBe(false);
    // compact:true 落成员行（重供给覆盖）
    team.members.find((m) => m.key === "m2")!.state = "failed";
    await writeTeam(stateRoot, team);
    await core.xc_member_add({ name: "m2", compact: true }, "conn-lead");
    team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "m2")!.compact).toBe(true);
    // 重供给不带 compact ⇒ spread 保留既有值（与 duty 同款「同键重供给不丢」口径）
    team.members.find((m) => m.key === "m2")!.state = "failed";
    await writeTeam(stateRoot, team);
    await core.xc_member_add({ name: "m2" }, "conn-lead");
    team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "m2")!.compact).toBe(true);
    // 全新成员缺省供给 ⇒ 不落键（absent = 允许）
    await core.xc_member_add({ name: "m5" }, "conn-lead");
    team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "m5")!.compact).toBeUndefined();
    // F1：残留的压缩标记不随重供给复活（同键重供给显式复位——崩溃残留不再传染新供给行）
    team.members.find((m) => m.key === "m2")!.state = "failed";
    team.members.find((m) => m.key === "m2")!.compactInProgressAt = Date.now() - COMPACT_IN_PROGRESS_STALE_MS - 60_000;
    await writeTeam(stateRoot, team);
    await core.xc_member_add({ name: "m2" }, "conn-lead");
    team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "m2")!.compactInProgressAt).toBeUndefined();
    // 旧成员行（无 compact 字段）→ 闸 4 不命中（走 force 成功路径证明没被 opted_out 拦下）
    await writeTeam(stateRoot, teamWith([
      member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
      member("m3"),
    ]));
    await bindMemberSession("m3");
    vi.mocked(compactMemberSession).mockImplementation(async () => ({ preCompactTokenCount: 1, postCompactTokenCount: 1, durationMs: 1 }));
    const result = await handleTeamCompact(deps, { name: "m3", force: true }, "conn-lead");
    expect(result.isError).toBeFalsy();
    // TeamShape 的新枚举与参数可被 zod 解析（模型可见面自明）
    const shape = z.object(TeamShape);
    expect(shape.safeParse({ action: "compact", name: "m1", force: true, note: "n" }).success).toBe(true);
    expect(shape.safeParse({ action: "member-add", name: "x", compact: false }).success).toBe(true);
    expect(shape.safeParse({ action: "compact", force: "yes" }).success).toBe(false);
    expect(TeamShape.action.options).toContain("compact");
  });
});

describe("v0.10.1 G-26：并发与互斥（评审 F6/F12/F24/F14/F5/F1）", () => {
  it("12（F12/F6）. 第一路压缩在跑（标记新鲜）→ 第二路 compact 在闸 5 直收 member_busy，不进二次压缩", async () => {
    await seedCheckpoint("m1");
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.mocked(compactMemberSession).mockImplementationOnce(async () => {
      // 第一路：执行期间标记已置位（F12 断言在 mock 内）
      const during = (await readTeam(stateRoot, "default"))!;
      expect(during.members.find((m) => m.key === "m1")!.compactInProgressAt).toBeDefined();
      await firstDone;
      return { preCompactTokenCount: 1, postCompactTokenCount: 1, durationMs: 1 };
    });
    const first = compact("m1");
    // 等第一路真正置位（轮询标记出现，避免时序猜测）
    for (let i = 0; i < 100; i++) {
      const t = (await readTeam(stateRoot, "default"))!;
      if (t.members.find((m) => m.key === "m1")!.compactInProgressAt !== undefined) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const { payload: second } = await compact("m1");
    expect(second).toMatchObject({ error: "member_busy", name: "m1" });
    // 第二路没有直压：协议调用仍恰 1 次
    expect(await compactCalls()).toHaveLength(1);
    releaseFirst();
    const { result } = await first;
    expect(result.isError).toBeFalsy();
  });

  it("13（F24）. turn 锁被另一活进程持有 → SessionTurnBusyError 映射 member_busy（契约信封，非 compact_failed）", async () => {
    await seedCheckpoint("m1");
    const holder = spawnAliveHolder();
    try {
      await seedLockFile(sessionTurnLockName("sess_m1"), holder.pid!);
      const { payload } = await compact("m1");
      expect(payload).toMatchObject({ error: "member_busy", name: "m1" });
      expect(String(payload["message"])).toContain("another live process");
      expect(await compactCalls()).toHaveLength(0);
    } finally {
      holder.kill();
    }
  });

  it("14（F6）. 团队锁等待耗尽（LockBusyError，15s）→ member_busy 而非 compact_failed（本进程持锁者等待路径；fake timers 驱动）", { timeout: 30_000 }, async () => {
    vi.useFakeTimers();
    try {
      await seedCheckpoint("m1");
      // 本进程持有团队锁（case 2：withFileLock 退回普通等待，15s 耗尽抛 LockBusyError）
      await seedLockFile(teamLockNames(stateRoot, "default").file, process.pid);
      const pending = compact("m1");
      await waitForPendingFakeTimer(); // 闸面走完、挂起在团队锁等待循环
      const payload = await driveToSettle(pending.then((r) => r.payload));
      expect(payload).toMatchObject({ error: "member_busy", name: "m1" });
      expect(await compactCalls()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("15（F14）. 置位前锁内权威复验：lead 在准备阶段被 transfer → not_lead（不置位、不压缩）", { timeout: 30_000 }, async () => {
    vi.useFakeTimers();
    try {
      await seedCheckpoint("m1");
      // 持住团队锁，让闸面（读 v1，ldr1 是 lead）先过、置位块等待
      await seedLockFile(teamLockNames(stateRoot, "default").file, process.pid);
      const pending = compact("m1");
      await waitForPendingFakeTimer(); // 挂起在置位块的团队锁等待循环（闸面已读 v1）
      // 闸面读盘后、锁内置位前：lead 被移交给 m1
      const flipped = teamWith([
        member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
        member("m1"),
      ]);
      flipped.leadKey = "m1";
      await writeTeam(stateRoot, flipped);
      // 放行团队锁 → 置位块拿到锁 → 复验发现 lead 已变 → not_lead
      await rm(lockFile(stateRoot, teamLockNames(stateRoot, "default").file), { force: true });
      const payload = await driveToSettle(pending.then((r) => r.payload));
      expect(payload).toMatchObject({ error: "not_lead" });
      expect(await compactCalls()).toHaveLength(0);
      const team = (await readTeam(stateRoot, "default"))!;
      expect(team.members.find((m) => m.key === "m1")!.compactInProgressAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("16（F5）. 收尾清标记自身失败（团队锁 15s 耗尽）→ 压缩成功结果不被掩盖（ok:true），落 member-compact-flag-clear-failed 审计", { timeout: 30_000 }, async () => {
    const holder = spawnAliveHolder();
    vi.useFakeTimers();
    try {
      await seedCheckpoint("m1");
      vi.mocked(compactMemberSession).mockImplementation(async () => {
        // mock 执行期间占住团队锁（外部活进程）→ 收尾的清标记 withTeamLock 等待耗尽
        await seedLockFile(teamLockNames(stateRoot, "default").file, holder.pid!);
        return { preCompactTokenCount: 7, postCompactTokenCount: 3, durationMs: 1 };
      });
      const pending = compact("m1");
      await waitForPendingFakeTimer(); // 挂起在收尾清标记的团队锁等待循环（mark-set 已成功、mock 已落锁）
      const { result, payload } = await driveToSettle(pending);
      // F5 核心：清标记失败绝不顶替压缩结果
      expect(result.isError).toBeFalsy();
      expect(payload).toMatchObject({ name: "m1", preCompactTokenCount: 7, postCompactTokenCount: 3 });
      expect(payload["error"]).toBeUndefined();
      // 失败事实留痕
      const cleared = auditOf(await auditEvents(), "member-compact-flag-clear-failed");
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatchObject({ name: "m1", by: "ldr1" });
      // 标记残留（诚实披露）：由新鲜窗 fail-open + 下次置位清扫 + 重供给复位兜底
      const team = (await readTeam(stateRoot, "default"))!;
      expect(team.members.find((m) => m.key === "m1")!.compactInProgressAt).toBeDefined();
    } finally {
      vi.useRealTimers();
      holder.kill();
    }
  });

  it("17（F1）. 陈旧压缩标记（超新鲜窗）不挡本成员的 compact（fail-open），置位时锁内清扫复位残留", async () => {
    await seedCheckpoint("m1");
    await writeTeam(stateRoot, teamWith([
      member("ldr1", { sessionId: "sess_ldr1", role: "peer" }),
      member("m1", { compactInProgressAt: Date.now() - COMPACT_IN_PROGRESS_STALE_MS - 60_000 }),
      member("m2", { sessionId: "sess_m2", compactInProgressAt: Date.now() - COMPACT_IN_PROGRESS_STALE_MS - 60_000 }),
    ]));
    vi.mocked(compactMemberSession).mockImplementation(async () => ({ preCompactTokenCount: 1, postCompactTokenCount: 1, durationMs: 1 }));
    const { result } = await compact("m1");
    expect(result.isError).toBeFalsy();
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "m1")!.compactInProgressAt).toBeUndefined();
    // 锁内清扫顺路复位了其它行的陈旧残留
    expect(team.members.find((m) => m.key === "m2")!.compactInProgressAt).toBeUndefined();
  });
});
