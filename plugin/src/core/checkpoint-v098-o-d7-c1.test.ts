/**
 * v0.9.8 组 O：core/checkpoint.ts 的两块新面定向单测。
 *
 * 覆盖面（对应 49-v098方案 §二 组 C C1 + §四 D7 = 48-v097验收 V097-21）：
 *
 * **D7 未读裁决单一真源**（currentUnreadMessages / unreadCountFor）：
 * - 判据逐条：未读∧未丢弃∧isCurrentMail 才计；已读(readAt)/已丢弃(discardedAt)/
 *   陈旧(taskId 指向不存在任务、attempt 已换代、来源任务已终态)都不计；
 * - 与 core/mailbox.ts isCurrentMail 逐案一致（同一判据两个入口，不是两套）；
 * - urgent 消息照样计数（裁决只看新鲜度，不看优先级）。
 *
 * **C1 上下文体积提醒**（readMailboxBytes / readContextSize / contextOverThreshold /
 * contextNudgeDecision / renderContextNudgeLine）：
 * - 取数：无邮箱文件 → {0,0}；有文件 → stat 字节 + 解析行数（坏行不计 messages）；
 * - 事实判定：字节/条数任一达阈值即 over（与 env 开关无关——关提醒不减事实）；
 * - 判据四态：disabled（XC_CONTEXT_NUDGE=0）/ below-threshold（正常不打扰）/
 *   rate-limited（30min 内已提醒过，与 checkpoint 提醒共用 .nudge）/ emit；
 * - emit 的 over 维度标注（bytes/messages/both）；
 * - 文案含「建议 checkpoint 后压缩/新会话」+「不自动压缩」+ 可关 env——不假装
 *   测到了模型上下文（插件读不到宿主上下文，估算口径是邮箱积压，诚实边界）。
 *
 * 纪律：不跑全量单测（脚本统一恰跑一次）；本文件只测组 O 自有面。
 */
import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTEXT_NUDGE_BYTES,
  CONTEXT_NUDGE_ENV,
  CONTEXT_NUDGE_MESSAGES,
  CHECKPOINT_NUDGE_MINUTES,
  contextNudgeDecision,
  contextOverThreshold,
  currentUnreadMessages,
  readContextSize,
  readMailboxBytes,
  renderContextNudgeLine,
  unreadCountFor,
} from "./checkpoint.js";
import { appendMailbox, createMessage, isCurrentMail, mutateMailbox, readMailbox } from "./mailbox.js";
import { newTeamState, readTeam, writeTeam } from "./teamstate.js";
import { inboxFile } from "./paths.js";
import type { Task, TeamMember } from "./types.js";

const MIN = 60_000;
const T0 = Date.now();

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v098-o-core-"));
  stateRoot = join(workDir, ".crosschat");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key,
    sessionId: `sess-${key}`,
    role: "worker",
    joinedAt: T0 - 120 * MIN,
    lastSeen: T0 - MIN,
    state: "ready",
    identity: "engine",
    ...overrides,
  };
}

function task(id: string, status: Task["status"], assignee: string | null, attemptId: string | null = null): Task {
  return {
    id,
    title: `任务 ${id}`,
    prompt: "p",
    dependsOn: [],
    status,
    assignee,
    attempt: assignee === null ? 0 : 1,
    attemptId,
    createdBy: "lead",
    createdAt: T0 - 60 * MIN,
    updatedAt: T0 - 20 * MIN,
    lastProgressTs: T0 - 20 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: T0 - 20 * MIN, event: "report", by: "lead" }],
  };
}

async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    name: "default",
    founderKey: "lead",
    founder: member("lead"),
    now: T0,
  });
  team.leadKey = "lead";
  team.members.push(member("alice"));
  // 在途任务（attempt 1）+ 已终态任务（来源回执的合法锚点）。
  team.tasks = [task("t-live", "in_progress", "alice", "att-1"), task("t-done", "completed", "alice", "att-1")];
  await writeTeam(stateRoot, team);
}

// ---------------------------------------------------------------------------
// D7（V097-21）：未读裁决单一真源
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O D7（V097-21）：未读裁决单一真源", () => {
  it("【主判据】未读∧未丢弃∧现行才计数；已读/已丢弃/陈旧都不计（与 isCurrentMail 同判据）", async () => {
    await seedTeam();
    const plain = createMessage("bob", "alice", "plain");
    const read = createMessage("bob", "alice", "read");
    const dropped = createMessage("bob", "alice", "dropped");
    // taskId 指向不存在的任务（无 attemptId）⇒ 陈旧（v0.5.1 故障注-5 口径）。
    const staleGhost = createMessage("bob", "alice", "stale-ghost", { taskId: "t-gone" });
    // attempt 已换代：信封绑 att-0，任务的现attempt 是 att-1 ⇒ 陈旧。
    const staleAttempt = createMessage("lead", "alice", "stale-attempt", { taskId: "t-live", attemptId: "att-0" });
    // 来源任务已终态且来源状态不符：sourceTaskStatus 与 task.status 不一致 ⇒ 陈旧。
    const staleSource = createMessage("lead", "alice", "stale-source", {
      taskId: "t-live", attemptId: "att-1", sourceTaskId: "t-done", sourceAttemptId: "att-1", sourceTaskStatus: "in_progress",
    });
    // 合法在途信封：绑 t-live 的现 attempt（att-1）、收方=受领人、任务 in_progress ⇒ 现行。
    const liveBound = createMessage("lead", "alice", "live-bound", { taskId: "t-live", attemptId: "att-1" });
    for (const m of [plain, read, dropped, staleGhost, staleAttempt, staleSource, liveBound]) {
      await appendMailbox(stateRoot, "default", "alice", m);
    }
    await mutateMailbox(stateRoot, "default", "alice", [read.id], (m) => ({ ...m, readAt: Date.now() }));
    await mutateMailbox(stateRoot, "default", "alice", [dropped.id], (m) => ({ ...m, discardedAt: Date.now() }));

    const team = (await readTeam(stateRoot, "default"))!;
    const msgs = await readMailbox(stateRoot, "default", "alice");
    const current = currentUnreadMessages(team, msgs);

    expect(current.map((m) => m.id).sort()).toEqual([liveBound.id, plain.id].sort());
    expect(unreadCountFor(team, msgs)).toBe(2);
    // 同一判据的另一个入口（core/mailbox.ts isCurrentMail）逐案一致——不是两套裁决。
    for (const m of msgs) {
      const inCurrent = current.some((c) => c.id === m.id);
      const fresh = m.readAt === undefined && m.discardedAt === undefined && isCurrentMail(team, m);
      expect(inCurrent).toBe(fresh);
    }
  });

  it("urgent 消息照样计数（裁决只看新鲜度，不看优先级）", async () => {
    await seedTeam();
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "urgent!", { urgent: true }));
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "normal"));

    const team = (await readTeam(stateRoot, "default"))!;
    expect(unreadCountFor(team, await readMailbox(stateRoot, "default", "alice"))).toBe(2);
  });

  it("空邮箱/无文件 → 0（0 是实数不是桩）", async () => {
    await seedTeam();
    const team = (await readTeam(stateRoot, "default"))!;
    expect(unreadCountFor(team, [])).toBe(0);
    expect(unreadCountFor(team, await readMailbox(stateRoot, "default", "alice"))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C1：上下文体积估算取数
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O C1：上下文体积估算取数", () => {
  it("无邮箱文件 → {bytes:0, messages:0}（缺席不是错）", async () => {
    expect(await readMailboxBytes(stateRoot, "alice")).toBe(0);
    expect(await readContextSize(stateRoot, "alice")).toEqual({ bytes: 0, messages: 0 });
  });

  it("有邮箱 → bytes=stat.size、messages=解析成功行数（坏行不计 messages 但计 bytes）", async () => {
    await seedTeam();
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m1"));
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m2"));
    const file = inboxFile(stateRoot, "default", "alice");
    await appendFile(file, '{"broken",,,\n'); // 追加一行坏行

    const sample = await readContextSize(stateRoot, "alice");
    expect(sample.messages).toBe(2);
    const size = (await stat(file)).size;
    expect(sample.bytes).toBe(size); // 字节含坏行（stat 真值）；条数只算解析成功的
    expect(await readMailboxBytes(stateRoot, "alice")).toBe(size);
    // 坏行不影响两条好消息的读取（readMailbox 容错跳过 + 审计）。
    expect((await readMailbox(stateRoot, "default", "alice")).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// C1：阈值事实判定（与 env 开关/节流无关）
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O C1：contextOverThreshold 事实判定", () => {
  it("两维度都低于阈值 → false（正常态）", () => {
    expect(contextOverThreshold({ bytes: CONTEXT_NUDGE_BYTES - 1, messages: CONTEXT_NUDGE_MESSAGES - 1 })).toBe(false);
    expect(contextOverThreshold({ bytes: 0, messages: 0 })).toBe(false);
  });

  it("字节达阈值 → true；条数达阈值 → true；双超 → true（或的关系）", () => {
    expect(contextOverThreshold({ bytes: CONTEXT_NUDGE_BYTES, messages: 1 })).toBe(true);
    expect(contextOverThreshold({ bytes: 1, messages: CONTEXT_NUDGE_MESSAGES })).toBe(true);
    expect(contextOverThreshold({ bytes: CONTEXT_NUDGE_BYTES * 2, messages: CONTEXT_NUDGE_MESSAGES * 2 })).toBe(true);
  });

  it("非有限值按 0 计（不炸）", () => {
    expect(contextOverThreshold({ bytes: Number.NaN, messages: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C1：提醒判据四态
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O C1：contextNudgeDecision 四态", () => {
  const NOW = T0;
  const over = { bytes: CONTEXT_NUDGE_BYTES, messages: CONTEXT_NUDGE_MESSAGES };
  const under = { bytes: 10, messages: 2 };

  it("XC_CONTEXT_NUDGE=0 → disabled（可关；事实仍在，只是不提醒）", () => {
    const d = contextNudgeDecision({ env: { [CONTEXT_NUDGE_ENV]: "0" }, ...over, lastNudgeAt: null, now: NOW });
    expect(d).toMatchObject({ nudge: false, reason: "disabled" });
  });

  it("低于阈值 → below-threshold（正常不打扰；有活没活都不打扰）", () => {
    const d = contextNudgeDecision({ env: {}, ...under, lastNudgeAt: null, now: NOW });
    expect(d).toMatchObject({ nudge: false, reason: "below-threshold" });
  });

  it("超阈值且 30min 内提醒过 → rate-limited（超阈值也最多 30min 一条）", () => {
    const d = contextNudgeDecision({
      env: {}, ...over, lastNudgeAt: NOW - (CHECKPOINT_NUDGE_MINUTES * 60_000 - 1), now: NOW,
    });
    expect(d).toMatchObject({ nudge: false, reason: "rate-limited" });
  });

  it("超阈值且超出节流窗（或从未提醒）→ emit，over 标注命中维度", () => {
    const never = contextNudgeDecision({ env: {}, ...over, lastNudgeAt: null, now: NOW });
    expect(never).toMatchObject({ nudge: true, reason: "emit", over: "both" });
    const bytesOnly = contextNudgeDecision({
      env: {}, bytes: CONTEXT_NUDGE_BYTES, messages: 1, lastNudgeAt: null, now: NOW,
    });
    expect(bytesOnly).toMatchObject({ nudge: true, reason: "emit", over: "bytes" });
    const msgsOnly = contextNudgeDecision({
      env: {}, bytes: 1, messages: CONTEXT_NUDGE_MESSAGES, lastNudgeAt: null, now: NOW,
    });
    expect(msgsOnly).toMatchObject({ nudge: true, reason: "emit", over: "messages" });
    const stale = contextNudgeDecision({
      env: {}, ...over, lastNudgeAt: NOW - (CHECKPOINT_NUDGE_MINUTES * 60_000 + 1), now: NOW,
    });
    expect(stale).toMatchObject({ nudge: true, reason: "emit" });
  });

  it("判定顺序固定：disabled 先于 below-threshold（关了就连低于阈值也不评估）", () => {
    const d = contextNudgeDecision({ env: { [CONTEXT_NUDGE_ENV]: "0" }, ...under, lastNudgeAt: null, now: NOW });
    expect(d.reason).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// C1：文案（只建议、不自动压缩、诚实口径）
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O C1：renderContextNudgeLine", () => {
  it("含「建议 checkpoint 后压缩/新会话」+「不自动压缩」+ 可关 env + 阈值事实", () => {
    const line = renderContextNudgeLine({ bytes: 5 * 1024 * 1024, messages: 777 });
    expect(line).toContain("xc_team({action:\"checkpoint\"})");
    expect(line).toContain("压缩或开新会话");
    expect(line).toContain("xc_read({scope:\"handoff\"})");
    expect(line).toContain("不自动压缩");
    expect(line).toContain("XC_CONTEXT_NUDGE=0");
    expect(line).toContain("777 条");
    expect(line).toContain(`${5 * 1024 * 1024} 字节`);
  });
});
