/**
 * v0.10.0（集成员·第 5 轮 / 对抗 ADV-02，裁决维持 P1）定向单测：
 * 看门狗补醒的**防风暴总次数上限**（engine/watchdog.ts）。
 *
 * 缺口：补醒只有 120s 冷却窗（一个窗内不重复），没有总次数上限——成员空闲、无在途唤醒、
 * 收件箱有未读派单/未读紧急回执而**始终不认领**时，看门狗每过一个冷却窗就补醒一次
 * （实测 t0 / t0+121s / t0+242s 三次真唤醒），每次补醒一整棵无头进程树 ⇒ 慢速唤醒风暴。
 * 修法（仿 mcp/tools-tasks.ts 的 urgent 回单上限）：同一成员 10min 窗内**真起进程树**的
 * 补醒（dispatch-resume / report-resume ∧ delivered≠mailbox）达 XC_RESUME_WAKE_MAX（缺省 5）
 * → 不补醒、不动邮箱、只落 `resume-wake-deferred` 审计；计数读失败 → 0（fail-open）。
 *
 * 覆盖：
 * 1. env 口径（与 urgent 同款：不接受「关闭用 0」）；
 * 2. 计数器纯函数（事件名 / to / delivered / 窗内 / 坏行 / fail-open 六条判据）；
 * 3. 集成·风暴形态：连扫 6 个冷却窗（Date mock 推进），前 5 窗各恰 1 次**真唤醒**
 *    （fake spawn 被调 5 次、引擎事件 delivered=wake），第 6 窗起零 attemptWake、
 *    `resume-wake-deferred{reason:"resume-wake-cap"}` 恰一条、消息仍邮箱未读；
 * 4. 低于上限仍放行；env 覆盖；紧急回执场景同样受闸。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESUME_WAKE_MAX_DEFAULT,
  RESUME_WAKE_WINDOW_MS,
  countRecentResumeWakes,
  dispatchResumeCooldownMsFromEnv,
  resumeWakeMaxFromEnv,
  sweepMembersOnce,
  type WatchdogDeps,
} from "./watchdog.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import { writeSession, writeSessionWitness, consumeWakeTicketForSession } from "../core/registry.js";
import { wakeLifecycleFile } from "../core/paths.js";
import type { CapacitySample } from "../core/capacity.js";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli.js";
import type { Task, TeamState } from "../core/types.js";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];
const spawnCalls: SpawnResumeOptions[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wd-v0100r5-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-wd-v0100r5-peers-"));
  dirs.push(root, peerRoot);
  spawnCalls.length = 0;
});

afterAll(() => {
  for (const child of sleepers) child.kill();
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

function eventsOf(name: string): Array<Record<string, unknown>> {
  return readEngineEvents().filter((e) => e["event"] === name);
}

async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

/** lead a（活 peer 记录可寻址）+ 成员 b（引擎成员形态，peer 记录由各用例自定）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  team.members.push({ key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 });
  await writeTeam(root, team);
  const leadPid = await startSleeper();
  const { writePeerRecord } = await import("../core/peerregistry.js");
  const { localPidDomain } = await import("../core/peerdir.js");
  await writePeerRecord(peerRoot, {
    pid: leadPid,
    sessionId: "sess_a",
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v0100r5-lead-${leadPid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  });
}

/** 成员 b 的空闲形态：Stop 钩子后的 idle 自述 + 引擎证言 idle + 活宿主 pid（无在途回合）。 */
async function seedIdleMember(): Promise<void> {
  const now = Date.now();
  const livePid = await startSleeper();
  await writeSession(root, {
    sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 3_600_000, lastSeen: now - 60_000,
    pid: livePid, liveness: "idle", livenessTs: now - 60_000, lastEventTs: now - 60_000,
  });
  await writeSessionWitness(root, "sess_b", "idle", now - 60_000);
}

/** 板面一张 pending 未认领单（to=b；isCurrentMail 要求任务在场）。 */
async function seedPendingTask(title = "派给 b 的单"): Promise<string> {
  const team = (await readTeam(root, "default"))! as TeamState;
  const task: Task = {
    id: "t-1",
    title,
    prompt: "p",
    dependsOn: [],
    status: "pending",
    assignee: null,
    attempt: 0,
    attemptId: null,
    createdBy: "a",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastProgressTs: Date.now(),
    result: null,
    error: null,
    evidence: [],
    history: [],
    to: "b",
  } as Task;
  team.tasks.push(task);
  await writeTeam(root, team);
  return task.id;
}

/** 一条**未读派单**（task-assignment：带 taskId、无 readAt）——风暴的「始终不认领」消息。 */
async function seedUnreadDispatch(taskId: string): Promise<string> {
  const message = createMessage("a", "b", `派单 ${taskId}`, { taskId, deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

function greenSample(): CapacitySample {
  return {
    sampledAt: Date.now(),
    totalBytes: 32_000_000_000,
    freeBytes: 28_000_000_000,
    watermark: 0.875,
    steadyTreeBytes: 3_000_000_000,
    headlessTurnCount: 0,
    headlessTurnMaxRssBytes: null,
    degraded: null,
  };
}

/** fake spawn：模拟真实 helper——拉起唤醒子后经 onHelperSpawned 汇报 pid（启动确认立刻结算）。 */
function fakeSpawn(opts: SpawnResumeOptions): SpawnResumeResult {
  spawnCalls.push(opts);
  opts.onHelperSpawned?.(4242);
  return { pid: 4242, logFile: opts.logFile };
}

/** 真唤醒路径的 deps（唤醒闸开 + GREEN 容量 + fake spawn；生产路径三项都不传）。 */
function wakeDeps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    stateRoot: root,
    workspace: "D:\\ws",
    env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true" },
    capacitySample: greenSample(),
    spawn: fakeSpawn,
    ...overrides,
  };
}

// ───────────────── 1. env 口径 ─────────────────

describe("v0.10.0 集成员·R5：补醒防风暴 env 口径（与 urgent 回单上限同款）", () => {
  it("常量：10min 窗、缺省 5 次", () => {
    expect(RESUME_WAKE_WINDOW_MS).toBe(600_000);
    expect(RESUME_WAKE_MAX_DEFAULT).toBe(5);
  });

  it("resumeWakeMaxFromEnv：未设/空串 → 5；正整数按值；0/负/非数字 → 5（不接受「关闭用 0」）", () => {
    expect(resumeWakeMaxFromEnv({})).toBe(5);
    expect(resumeWakeMaxFromEnv({ XC_RESUME_WAKE_MAX: "" })).toBe(5);
    expect(resumeWakeMaxFromEnv({ XC_RESUME_WAKE_MAX: "   " })).toBe(5);
    expect(resumeWakeMaxFromEnv({ XC_RESUME_WAKE_MAX: "2" })).toBe(2);
    expect(resumeWakeMaxFromEnv({ XC_RESUME_WAKE_MAX: "12" })).toBe(12);
    expect(resumeWakeMaxFromEnv({ XC_RESUME_WAKE_MAX: "0" })).toBe(5);
    expect(resumeWakeMaxFromEnv({ XC_RESUME_WAKE_MAX: "-1" })).toBe(5);
    expect(resumeWakeMaxFromEnv({ XC_RESUME_WAKE_MAX: "soon" })).toBe(5);
    expect(resumeWakeMaxFromEnv({ XC_RESUME_WAKE_MAX: "2.5" })).toBe(5);
  });
});

// ───────────────── 2. 计数器纯函数 ─────────────────

describe("v0.10.0 集成员·R5：countRecentResumeWakes（有界尾读六条判据）", () => {
  const NOW = 1_700_000_000_000;

  function appendEvent(event: Record<string, unknown>): void {
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(join(root, "logs", "engine.jsonl"), `${JSON.stringify({ ts: NOW - 60_000, ...event })}\n`, "utf8");
  }

  it("只数 dispatch-resume / report-resume ∧ to 命中 ∧ delivered 非 mailbox ∧ 窗内", async () => {
    appendEvent({ event: "dispatch-resume", to: "b", delivered: "wake" });
    appendEvent({ event: "report-resume", to: "b", delivered: "wake", urgent: true });
    appendEvent({ event: "dispatch-resume", to: "b", delivered: "wake" });
    expect(await countRecentResumeWakes(root, "b", NOW)).toBe(3);
  });

  it("被闸挡下只落邮箱的行（delivered=mailbox）不占额度——防的是进程树风暴，不是尝试次数", async () => {
    appendEvent({ event: "dispatch-resume", to: "b", delivered: "mailbox" });
    appendEvent({ event: "report-resume", to: "b", delivered: "mailbox" });
    appendEvent({ event: "dispatch-resume", to: "b", delivered: "wake" });
    expect(await countRecentResumeWakes(root, "b", NOW)).toBe(1);
  });

  it("别人的 to / 别的补醒无关事件 / 窗外行 全部不数", async () => {
    appendEvent({ event: "dispatch-resume", to: "other", delivered: "wake" });
    appendEvent({ event: "member-dead", to: "b", delivered: "wake" });
    appendEvent({ event: "wake", to: "b", delivered: "wake" });
    appendEvent({ event: "dispatch-resume", to: "b", delivered: "wake", ts: NOW - RESUME_WAKE_WINDOW_MS - 1_000 });
    expect(await countRecentResumeWakes(root, "b", NOW)).toBe(0);
  });

  it("窗边界：恰在窗内（=600s）算、窗外（600s+1ms）不算", async () => {
    appendEvent({ event: "dispatch-resume", to: "b", delivered: "wake", ts: NOW - RESUME_WAKE_WINDOW_MS });
    appendEvent({ event: "report-resume", to: "b", delivered: "wake", ts: NOW - RESUME_WAKE_WINDOW_MS - 1 });
    expect(await countRecentResumeWakes(root, "b", NOW)).toBe(1);
  });

  it("坏行 / 半行 JSON 跳过不抛（返回已数到的部分）", async () => {
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(join(root, "logs", "engine.jsonl"), "{ 这不是 JSON\n", "utf8");
    appendEvent({ event: "dispatch-resume", to: "b", delivered: "wake" });
    expect(await countRecentResumeWakes(root, "b", NOW)).toBe(1);
  });

  it("engine.jsonl 不存在 / 不可读 → 0（fail-open：闸只防风暴，不拦投递）", async () => {
    expect(await countRecentResumeWakes(root, "b", NOW)).toBe(0);
    // 读一个目录当文件（EISDIR）→ 同样 0，不抛。
    mkdirSync(join(root, "logs", "engine.jsonl"), { recursive: true });
    expect(await countRecentResumeWakes(root, "b", NOW)).toBe(0);
  });
});

// ───────────────── 3. 集成：连扫 6 个冷却窗的风暴形态 ─────────────────

describe("v0.10.0 集成员·R5：补醒风暴形态——前 5 窗真唤醒，第 6 窗起被防风暴闸挡下", () => {
  it("连扫 6 个冷却窗：前 5 窗各恰 1 条 dispatch-resume（真唤醒），第 6 窗起零 attemptWake + resume-wake-deferred 恰一条 + 消息仍邮箱未读", async () => {
    // 时钟先钉住再播种（所有夹具时刻都相对 t0；plausibleLivenessTs 不接受未来值）。
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    try {
      await seedTeam();
      await seedIdleMember();
      const taskId = await seedPendingTask();
      const messageId = await seedUnreadDispatch(taskId);

      // 6 个冷却窗（每窗推进 121s > 120s 冷却）；成员始终 idle、消息始终未读（零动作）。
      for (let window = 1; window <= 6; window++) {
        const summary = await sweepMembersOnce(wakeDeps());
        if (window <= 5) {
          // 真唤醒：fake spawn 被调、引擎事件 delivered=wake（真起进程树的那类行）。
          expect(spawnCalls).toHaveLength(window);
          expect(summary.dispatchResumed).toHaveLength(1);
          expect(summary.dispatchResumed[0]!.delivered).toBe("wake");
          expect(summary.resumeWakeDeferred).toEqual([]);
          expect(eventsOf("resume-wake-deferred")).toHaveLength(0);
          // 模拟 SessionStart 钩子消费 nonce（唤醒子到位即消费）——否则在途唤醒会挡住下一轮，
          // 测的就不是「窗窗都补」而是「在途闸」了。
          await consumeWakeTicketForSession(root, { sid: "sess_b", teamId: "default", now: Date.now() });
        } else {
          // 第 6 窗：零 attemptWake（spawn 计数停在 5）、不进候选、只落审计。
          expect(spawnCalls).toHaveLength(5);
          expect(summary.dispatchResumed).toEqual([]);
          expect(summary.resumeWakeDeferred).toEqual([
            { key: "b", scene: "dispatch-resume", messageIds: [messageId], reason: "resume-wake-cap" },
          ]);
        }
        vi.setSystemTime(t0 + window * 120_000);
      }

      // 审计：dispatch-resume 恰 5 条且全为 delivered=wake；resume-wake-deferred 恰一条。
      const resumed = eventsOf("dispatch-resume");
      expect(resumed).toHaveLength(5);
      for (const event of resumed) {
        expect(event["to"]).toBe("b");
        expect(event["delivered"]).toBe("wake");
        expect(event["taskIds"]).toEqual([taskId]);
      }
      const deferred = eventsOf("resume-wake-deferred");
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!["to"]).toBe("b");
      expect(deferred[0]!["scene"]).toBe("dispatch-resume");
      expect(deferred[0]!["reason"]).toBe("resume-wake-cap");
      expect(deferred[0]!["resumeWakeMax"]).toBe(5);
      expect(deferred[0]!["messageIds"]).toEqual([messageId]);
      expect(String(deferred[0]!["note"])).toContain("pull 兜底不丢");
      // 消息仍在邮箱且**仍未读**（闸只挡唤醒，不动邮箱）。
      const box = await readMailbox(root, "default", "b");
      expect(box).toHaveLength(1);
      expect(box[0]!.id).toBe(messageId);
      expect(box[0]!.readAt).toBeUndefined();
      // 没有新的唤醒痕迹（第 6 窗零 attemptWake）：registry/wake/ 恰 5 张 nonce（前 5 窗各
      // 一张，无第 6 张）、logs/ 下生命周期账恰 5 份（scene=dispatch-resume 各一份）。
      expect(readdirSync(join(root, "registry", "wake")).filter((f) => f.endsWith(".json"))).toHaveLength(5);
      expect(readdirSync(join(root, "logs")).filter((f) => /^wake-lifecycle-b-\d+\.jsonl$/.test(f))).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("低于上限（4 次真唤醒）仍放行补醒——闸只在达上限后挡", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    try {
      await seedTeam();
      await seedIdleMember();
      const taskId = await seedPendingTask();
      await seedUnreadDispatch(taskId);
      for (let window = 1; window <= 4; window++) {
        const summary = await sweepMembersOnce(wakeDeps());
        expect(summary.dispatchResumed).toHaveLength(1);
        expect(summary.resumeWakeDeferred).toEqual([]);
        await consumeWakeTicketForSession(root, { sid: "sess_b", teamId: "default", now: Date.now() });
        vi.setSystemTime(t0 + window * 120_000);
      }
      // 第 5 窗（= 上限内最后一次）仍放行
      const fifth = await sweepMembersOnce(wakeDeps());
      expect(fifth.dispatchResumed).toHaveLength(1);
      expect(spawnCalls).toHaveLength(5);
      expect(eventsOf("resume-wake-deferred")).toHaveLength(0);
      // 第 6 窗起才挡
      vi.setSystemTime(t0 + 5 * 120_000);
      await consumeWakeTicketForSession(root, { sid: "sess_b", teamId: "default", now: Date.now() });
      const sixth = await sweepMembersOnce(wakeDeps());
      expect(sixth.dispatchResumed).toEqual([]);
      expect(sixth.resumeWakeDeferred).toHaveLength(1);
      expect(spawnCalls).toHaveLength(5); // 零新增 attemptWake
    } finally {
      vi.useRealTimers();
    }
  });

  it("env 覆盖：XC_RESUME_WAKE_MAX=2 → 第 3 窗起挡下（上限值进审计事件）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    try {
      await seedTeam();
      await seedIdleMember();
      const taskId = await seedPendingTask();
      await seedUnreadDispatch(taskId);
      const capped = wakeDeps({ env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true", XC_RESUME_WAKE_MAX: "2" } });
      for (let window = 1; window <= 2; window++) {
        expect((await sweepMembersOnce(capped)).dispatchResumed).toHaveLength(1);
        await consumeWakeTicketForSession(root, { sid: "sess_b", teamId: "default", now: Date.now() });
        vi.setSystemTime(t0 + window * 120_000);
      }
      const third = await sweepMembersOnce(capped);
      expect(third.dispatchResumed).toEqual([]);
      expect(third.resumeWakeDeferred).toHaveLength(1);
      const deferred = eventsOf("resume-wake-deferred");
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!["resumeWakeMax"]).toBe(2);
      expect(spawnCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("紧急回执场景同样受闸（report-resume）：达上限后零 urgent 补醒", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    try {
      await seedTeam();
      await seedIdleMember();
      // 板面要有这张单（未读真源 isCurrentMail 要求任务在场——与既有 urgent 回执用例同夹具）。
      const taskId = await seedPendingTask("紧急回执对应的单");
      const content = JSON.stringify({
        type: "task-receipt", teamId: "default", taskId, attemptId: "att-r",
        status: "in_progress", result: "半截要点", error: null, evidence: [],
      });
      const message = createMessage("a", "b", content, {
        taskId, sourceTaskId: taskId, sourceTaskStatus: "in_progress",
        deliveryClaimedAt: Date.now(), urgent: true,
      });
      await appendMailbox(root, "default", "b", message);
      const capped = wakeDeps({ env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true", XC_RESUME_WAKE_MAX: "1" } });
      // 第 1 窗：真唤醒（report-resume + urgent）
      const first = await sweepMembersOnce(capped);
      expect(first.dispatchResumed).toHaveLength(1);
      expect(first.dispatchResumed[0]!.scene).toBe("report-resume");
      expect(spawnCalls).toHaveLength(1);
      // urgent 真达唤醒面的证据：唤醒 prompt 带 URGENT 横幅（buildWakePrompt 的口径），
      // 且审计 note 明写「紧急回执」——scene=report-resume 本身即 urgent:true 的产物。
      expect(spawnCalls[0]!.prompt).toContain("URGENT");
      expect(String(eventsOf("report-resume")[0]!["note"])).toContain("紧急回执");
      await consumeWakeTicketForSession(root, { sid: "sess_b", teamId: "default", now: Date.now() });
      vi.setSystemTime(t0 + 120_000);
      // 第 2 窗：达上限 → 挡下（零 urgent 补醒）
      const second = await sweepMembersOnce(capped);
      expect(second.dispatchResumed).toEqual([]);
      expect(second.resumeWakeDeferred).toEqual([
        { key: "b", scene: "report-resume", messageIds: [message.id], reason: "resume-wake-cap" },
      ]);
      const deferred = eventsOf("resume-wake-deferred");
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!["scene"]).toBe("report-resume");
      expect(spawnCalls).toHaveLength(1);
      // 紧急回执仍在邮箱未读
      const box = await readMailbox(root, "default", "b");
      expect(box).toHaveLength(1);
      expect(box[0]!.urgent).toBe(true);
      expect(box[0]!.readAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail-open：engine.jsonl 不可读（计数 0）→ 不因观测面故障挡下补醒", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    try {
      await seedTeam();
      await seedIdleMember();
      const taskId = await seedPendingTask();
      await seedUnreadDispatch(taskId);
      // 先把 logs/engine.jsonl 变成目录 → 计数读失败（fail-open 到 0）。
      await sweepMembersOnce(wakeDeps()); // 真唤醒一次（顺带把 engine.jsonl 建出来）
      rmSync(join(root, "logs", "engine.jsonl"), { force: true });
      mkdirSync(join(root, "logs", "engine.jsonl"), { recursive: true });
      expect(await countRecentResumeWakes(root, "b", Date.now())).toBe(0);
      vi.setSystemTime(t0 + 120_000);
      await consumeWakeTicketForSession(root, { sid: "sess_b", teamId: "default", now: Date.now() });
      const summary = await sweepMembersOnce(wakeDeps());
      expect(summary.dispatchResumed).toHaveLength(1); // 观测面坏了也照样补（不打死投递）
      expect(summary.resumeWakeDeferred).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────────────── 4. 与既有判据的共存（回归护栏） ─────────────────

describe("v0.10.0 集成员·R5：防风暴闸不碰既有判据", () => {
  it("冷却窗优先于计数闸：窗内重复补醒仍记 dispatchResumed=[] 且不落 resume-wake-deferred", async () => {
    await seedTeam();
    await seedIdleMember();
    const taskId = await seedPendingTask();
    await seedUnreadDispatch(taskId);
    // 30s 前刚补醒过一次：只落生命周期账（scene=dispatch-resume）——冷却源。
    const spawnTs = Date.now() - 30_000;
    const lifecycle = wakeLifecycleFile(root, "b", spawnTs);
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(lifecycle, `${JSON.stringify({ ts: spawnTs, event: "wake-child-start", sid: "sess_b", to: "b", scene: "dispatch-resume" })}\n`, "utf8");

    const summary = await sweepMembersOnce({ stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } });
    expect(summary.dispatchResumed).toEqual([]);
    expect(summary.resumeWakeDeferred).toEqual([]); // 冷却挡下的不记防风暴审计（两件事）
    expect(eventsOf("resume-wake-deferred")).toHaveLength(0);
    expect(dispatchResumeCooldownMsFromEnv({})).toBe(120_000);
  });

  it("成员不在线（running 自述）→ 两个闸都不涉及的零形状", async () => {
    await seedTeam();
    const now = Date.now();
    const livePid = await startSleeper();
    await writeSession(root, {
      sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 600_000, lastSeen: now - 30_000,
      pid: livePid, liveness: "running", livenessTs: now - 30_000, lastEventTs: now - 30_000,
    });
    await writeSessionWitness(root, "sess_b", "running", now - 30_000);
    const taskId = await seedPendingTask();
    await seedUnreadDispatch(taskId);
    const summary = await sweepMembersOnce({ stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } });
    expect(summary.dispatchResumed).toEqual([]);
    expect(summary.resumeWakeDeferred).toEqual([]);
  });
});
