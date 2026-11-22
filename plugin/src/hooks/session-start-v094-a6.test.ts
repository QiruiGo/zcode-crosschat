/**
 * v0.9.4（A6）：SessionStart 钩子**唤醒票据一次性消费 + 身份自动绑定**定向测试
 * （39-v094 方案 §二 A 表：「唤醒一次到位」机制合并）。
 *
 * 判据（任务书原文）：「票据一次性消费（消费即 used），非目标 sid 拒」；方案：
 * 「SessionStart 钩子消费唤醒票据自动绑身份（不经模型回合）」。
 *
 * 覆盖点：
 * 1. 无票据（普通会话启动）→ 零副作用（不建绑定、不落绑定事件）；
 * 2. 有票据（目标 sid）→ 一次性消费（nonce.used=true）+ 队内轴（names.json/roster/
 *    会话记录 boundName）+ peer 轴（基记录 boundName + pid）绑定落地；
 * 3. 一次性：第二次跑同 sid 钩子 → 票据已用 → 不再绑定、不重复落事件；
 * 4. 非目标 sid 拒：别个 sid 的票据不被消费、不被绑定；
 * 5. 旧 nonce（无 issuedToSid/name 字段）→ sid 兜底匹配、agentKey 兜底取名（兼容）；
 * 6. 冲突路径：花名已被别的 sid 持有 / 本会话已有别的 boundName → 不抢不覆盖，
 *    只留审计（模型回合随后显式处理）。
 *
 * 依赖隔离：shared.js 的 stdin/上下文/发射面 mock（stop.test.ts 同款），registry/
 * teamstate/peerdir/lock 全真跑临时 stateRoot 与临时 peer 根（env 钉住）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  peerRoot: "",
  stateRoot: "",
  workspace: "",
  sessionId: undefined as string | undefined,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    readStdinPayload: vi.fn(() => undefined),
    resolveHookContext: vi.fn(() => ({
      workspace: h.workspace,
      stateRoot: h.stateRoot,
      sessionId: h.sessionId,
      event: "SessionStart",
    })),
    emitAdditionalContext: vi.fn(),
    logHookEvent: vi.fn(async () => {}),
    auditHookFailure: vi.fn(async () => {}),
    peerRootFromEnv: vi.fn(() => h.peerRoot),
    readHookPermissionMode: vi.fn(() => undefined),
  };
});

// v0.9.6 r2（V096-12）：bindWakeTicketIdentity 在票据消费成功后调用
// writeAdoptAnchorsForHostServers（会话↔server 绑定锚），其默认轮询
// ADOPT_ANCHOR_POLL_SCHEDULE_MS=[0,800,1600] 用真实 PowerShell 子进程枚举
// （listPluginServerChildPids）——每个消费票据的钩子运行固定多花 ~4s。
// 本文件全部判据走 runSessionStartHook 真路径（不注入 lister/pollScheduleMs），
// 单跑 ~4.4s/例已贴 vitest 默认 testTimeout=5s；全量并行满载下 ~5.2s/次必超时
// （05:59 全量实跑：4 次 attempt×5s≈20.8s 红）。只放宽时间预算、不放宽任何断言
// （与 vitest.config.ts「retry 吸收负载抖动、不放宽判据」同纪律）。
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];

// v0.9.5（A1/V094-02）：ppid 采纳默认关——钩子的票据消费+自动绑定随之默认关
//（XC_ADOPT_BY_PPID=1 才执行）。本文件锁「开启档」的绑定回归，beforeEach 显式开启；
// 默认关闭（票据不消费、留给模型回合兜底）的定向判据见 session-start-v095-a1.test.ts。
beforeEach(() => {
  process.env["XC_ADOPT_BY_PPID"] = "1";
  h.stateRoot = mkdtempSync(join(tmpdir(), "xc-a6-v094-"));
  h.peerRoot = mkdtempSync(join(tmpdir(), "xc-a6-v094-peers-"));
  h.workspace = join(tmpdir(), "xc-a6-v094-ws-");
  h.sessionId = undefined;
  dirs.push(h.stateRoot, h.peerRoot);
});

afterEach(() => {
  delete process.env["XC_ADOPT_BY_PPID"];
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

async function importHook(): Promise<typeof import("./session-start.js")> {
  return await import("./session-start.js");
}

/** 建一张队（lead a + 成员 b，b 的 sid 先留空/旧值——模拟重供给/重绑前的形态）。 */
async function seedTeam(memberSid: string): Promise<void> {
  const { newTeamState, writeTeam } = await import("../core/teamstate.js");
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  team.members.push({ key: "b", sessionId: memberSid, role: "worker", joinedAt: 1, lastSeen: 1 });
  await writeTeam(h.stateRoot, team);
}

/** 签一张唤醒票据（attemptWake 的落盘形状：teamId/agentKey/sid/voiceOwner + A6 新字段）。 */
async function seedTicket(input: {
  agentKey: string; sid: string; issuedToSid?: string; name?: string; withLegacyShape?: boolean;
}): Promise<string> {
  const { createWakeNonce, readWakeNonce } = await import("../core/registry.js");
  const { token } = await createWakeNonce(h.stateRoot, {
    teamId: "default",
    agentKey: input.agentKey,
    sid: input.sid,
    voiceOwner: input.sid,
    ...(input.withLegacyShape === true ? {} : {
      ...(input.issuedToSid !== undefined ? { issuedToSid: input.issuedToSid } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
    }),
  });
  const nonce = await readWakeNonce(h.stateRoot, token);
  expect(nonce).toBeDefined();
  return token;
}

async function readNames(): Promise<Record<string, { sessionId: string; role: string }>> {
  const { readNames: read } = await import("../core/registry.js");
  return (await read(h.stateRoot)) as Record<string, { sessionId: string; role: string }>;
}

async function readNonceUsed(token: string): Promise<boolean | undefined> {
  const { readWakeNonce } = await import("../core/registry.js");
  return (await readWakeNonce(h.stateRoot, token))?.used;
}

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(h.stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runHook(sessionId: string): Promise<void> {
  h.sessionId = sessionId;
  const { runSessionStartHook } = await importHook();
  await runSessionStartHook();
}

describe("v0.9.4 A6：唤醒票据一次性消费 + 自动绑定身份（队内轴 + peer 轴）", () => {
  it("无票据（普通会话启动）→ 零副作用：不建绑定、不落绑定事件、pid 证据照写", async () => {
    await runHook("sess_plain");
    const { readSession } = await import("../core/registry.js");
    const record = await readSession(h.stateRoot, "sess_plain");
    expect(record).toBeDefined();
    expect(record?.pid).toBe(process.ppid); // A1：宿主进程 pid（钩子父进程）
    expect(Object.keys(await readNames())).toEqual([]); // 不建任何花名绑定
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-bound")).toHaveLength(0);
  });

  it("【锚点】目标 sid 的票据 → 一次性消费（used=true）+ 队内轴/peer 轴绑定落地", async () => {
    await seedTeam("sess_old_b"); // 成员 b 在册但 sid 是旧值（重绑形态）
    const token = await seedTicket({ agentKey: "b", sid: "sess_b", issuedToSid: "sess_b", name: "b" });

    await runHook("sess_b");

    // ① 一次性：票据消费即 used
    expect(await readNonceUsed(token)).toBe(true);
    // ② 队内轴：names.json 绑定到本 sid
    expect((await readNames())["b"]?.sessionId).toBe("sess_b");
    // roster 行 sid 刷新到本 sid
    const { readTeam } = await import("../core/teamstate.js");
    const row = (await readTeam(h.stateRoot, "default"))!.members.find((m) => m.key === "b");
    expect(row?.sessionId).toBe("sess_b");
    // v0.9.9（V098-01）：会话记录**不再写 boundName**——该字段是「引擎供给的无头持有者」
    // 判据，唯一写入路径必须是 member-add 供给代写；票据路径自签 boundName 即 adv-1 G1
    // （交互宿主被 steer 当无头会话强杀 + 谎称 preempted）。记账改走专用标记
    // wakeTicketBound（花名 + 消费时刻），持有者判据不认它。
    const { readSession } = await import("../core/registry.js");
    const recordAfter = await readSession(h.stateRoot, "sess_b");
    expect(recordAfter?.boundName).toBeUndefined();
    expect(recordAfter?.wakeTicketBound).toMatchObject({ name: "b" });
    expect(typeof recordAfter?.wakeTicketBound?.ts).toBe("number");
    // pid 投影照写（A1 成员 pid 证据，与持有者判据无关）
    expect(recordAfter?.pid).toBe(process.ppid);
    // ③ peer 轴：基记录 boundName + pid 盖章
    const { readPeerBaseRecord } = await import("../core/peerdir.js");
    const base = await readPeerBaseRecord(h.peerRoot, "sess_b");
    expect(base?.boundName).toBe("b");
    expect(base?.pid).toBe(process.ppid);
    // ④ 审计事件落账（nonce 只落不可反查摘要，真值不进共享日志）
    const bound = readEngineEvents().filter((e) => e["event"] === "wake-ticket-bound");
    expect(bound).toHaveLength(1);
    expect(bound[0]!["name"]).toBe("b");
    expect(String(bound[0]!["nonce"])).not.toBe(token);
    expect(String(bound[0]!["nonce"]).length).toBe(12); // sha256 前 12 hex
  });

  it("一次性：第二次跑同 sid 钩子 → 票据已用 → 不再绑定、不重复落事件", async () => {
    await seedTeam("sess_b");
    const token = await seedTicket({ agentKey: "b", sid: "sess_b", issuedToSid: "sess_b", name: "b" });
    await runHook("sess_b");
    expect(await readNonceUsed(token)).toBe(true);
    const afterFirst = readEngineEvents().filter((e) => e["event"] === "wake-ticket-bound").length;
    expect(afterFirst).toBe(1);

    await runHook("sess_b"); // 同 sid 再启动一次（--resume 新回合）
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-bound")).toHaveLength(1);
  });

  it("非目标 sid 拒：别个 sid 的票据不被消费、不绑定（票据留给它的目标会话）", async () => {
    await seedTeam("sess_other");
    const token = await seedTicket({ agentKey: "b", sid: "sess_other", issuedToSid: "sess_other", name: "b" });
    await runHook("sess_b"); // 本钩子跑在 sess_b 上
    expect(await readNonceUsed(token)).toBeUndefined(); // 仍未消费
    expect((await readNames())["b"]).toBeUndefined(); // 没有替别人绑定
    expect(readEngineEvents().filter((e) => e["event"] === "wake-ticket-bound")).toHaveLength(0);
  });

  it("旧 nonce（无 issuedToSid/name）→ sid 兜底匹配 + agentKey 兜底取名（兼容 v0.9.3 票据）", async () => {
    await seedTeam("sess_old_b");
    const token = await seedTicket({ agentKey: "b", sid: "sess_b", withLegacyShape: true });
    await runHook("sess_b");
    expect(await readNonceUsed(token)).toBe(true);
    expect((await readNames())["b"]?.sessionId).toBe("sess_b");
  });

  it("冲突1：花名已被别的 sid 持有 → 不抢绑，只留审计（模型回合显式处理）", async () => {
    await seedTeam("sess_b");
    const { bindName } = await import("../core/registry.js");
    await bindName(h.stateRoot, "b", { sessionId: "sess_someone_else", role: "worker", registeredAt: 1 });
    const token = await seedTicket({ agentKey: "b", sid: "sess_b", issuedToSid: "sess_b", name: "b" });

    await runHook("sess_b");
    // v0.9.5（A6/V094-03）：绑定冲突 → 票据**回滚未用**（旧实现 used=true 使兜底必撞
    // "already used"）；审计事件带 ticketRolledBack 位。
    expect(await readNonceUsed(token)).toBeUndefined();
    expect((await readNames())["b"]?.sessionId).toBe("sess_someone_else"); // 不抢
    const skipped = readEngineEvents().filter((e) => e["event"] === "wake-ticket-binding-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!["reason"]).toBe("name-bound-elsewhere");
    expect(skipped[0]!["ticketRolledBack"]).toBe(true);
  });

  it("冲突2：本会话记录已有别的 boundName → 不覆盖既有身份", async () => {
    await seedTeam("sess_b");
    const { writeSession } = await import("../core/registry.js");
    await writeSession(h.stateRoot, { sessionId: "sess_b", cwd: "", startedAt: 1, lastSeen: 1, boundName: "other-name" });
    const token = await seedTicket({ agentKey: "b", sid: "sess_b", issuedToSid: "sess_b", name: "b" });

    await runHook("sess_b");
    expect(await readNonceUsed(token)).toBeUndefined(); // v0.9.5（A6）：回滚未用
    const { readSession } = await import("../core/registry.js");
    expect((await readSession(h.stateRoot, "sess_b"))?.boundName).toBe("other-name"); // 不覆盖
    const skipped = readEngineEvents().filter((e) => e["event"] === "wake-ticket-binding-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!["reason"]).toBe("bound-name-conflict");
    expect(skipped[0]!["ticketRolledBack"]).toBe(true);
  });

  it("多次唤醒在途（同 sid 两张票）→ 消费 ts 最新的一张", async () => {
    await seedTeam("sess_b");
    const older = await seedTicket({ agentKey: "b", sid: "sess_b", issuedToSid: "sess_b", name: "b" });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await seedTicket({ agentKey: "b", sid: "sess_b", issuedToSid: "sess_b", name: "b" });

    await runHook("sess_b");
    expect(await readNonceUsed(newer)).toBe(true);
    expect(await readNonceUsed(older)).toBeUndefined(); // 旧的留在途（在途标记语义不变）
    expect((await readNames())["b"]?.sessionId).toBe("sess_b");
  });
});
