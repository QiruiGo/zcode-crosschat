/**
 * v0.9.3 打回第 1 轮（**V093-04**，adv-3/C7）定向单测——
 * 看门狗「同一成员同一次死亡只发一次」告警链的**永久静音**失效模式。
 *
 * 锚点（裁决书原文）：
 * ① 认领（锁内 writeWatchdogState）与通知（锁外 notifyAndWake）**非原子**——进程崩在两者
 *    之间即台账已写 dead 而通知未发，之后每轮都因「非 alive→dead 迁移」跳过，重新武装还要
 *    liveness≠pid-dead（崩溃进程永不满足）⇒ 告警**永久丢失**，且零错误面
 *    （watchdog-sweep-failed / watchdog-notify-skipped 均为 0）。
 * ② 台账损坏/缺失按设计视为「无历史」，叠加「首见只记录不告警」⇒ 首扫前已死的成员**永不
 *    被告警**（C6 证明 A3 回合摘要也不能覆盖）。
 * ③ （控制项，既有 watchdog-v092r1-concurrency.test.ts 覆盖）跨进程单通告者锁本身成立。
 *
 * 修复口径（本文件锁死）：
 * - **两段式告知**：锁内认领只写 `notify:'pending'`，通知落地后才改 `'sent'`；pending 且
 *   认领已久（≥ WATCHDOG_NOTIFY_RETRY_MS）的条目由下一轮**重发**（次数上限内），达上限置
 *   `'failed'` 并落 `watchdog-notify-failed` 事件（把静音变成可见错误面）。
 * - **首见即死按新鲜度分流**：台账无历史时，peer 心跳 lastSeen 落在 WATCHDOG_FRESH_DEATH_MS
 *   窗内 ⇒ 刚发生的死亡，照常告警（文案注明台账无历史）；窗外 ⇒ 存量死记录，只记录不告警
 *   （v0.9.2 A2「启动期存量死记录不当事故」原口径保留）。
 * - 旧格式行（无 notify 字段）按 `'pending'` 读：无从证明通知发过就按没发过处理，补发一次
 *   后转 `'sent'`（V093-04 起口径；下方「旧格式/陈旧备份」例锁死该行为——集成重冻轮修正：
 *   本行原与代码/测试例矛盾的 `'sent'` 旧注释作废）。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot；进程死用**真**进程（spawn node sleeper 后 kill，
 * 等 OS 回收 pid——pid-dead 是 C8 唯一进程死硬证据，不用假 pid 伪造）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readMailbox } from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { logEngineEvent } from "../core/log";
import { readIncidentsSince } from "../core/incidents";
import { pidAlive } from "../core/lock.js";
import { localPidDomain } from "../core/peerdir";
import { writePeerRecord, type PeerRecord } from "../core/peerregistry";
import {
  sweepMembersOnce,
  WATCHDOG_FRESH_DEATH_MS,
  WATCHDOG_NOTIFY_MAX_ATTEMPTS,
  WATCHDOG_NOTIFY_RETRY_MS,
  type WatchdogDeps,
} from "./watchdog";
import { readWatchdogState, writeWatchdogState, type WatchdogState } from "./watchdog-state";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-a4-notify-v093-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-a4-notify-v093-peers-"));
  dirs.push(root, peerRoot);
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

/** lead「a」+ 成员「b」（founder 也占花名册行——lead 才可寻址）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  team.members.push({ key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 });
  await writeTeam(root, team);
}

function deps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    stateRoot: root,
    workspace: "D:\\ws",
    env: { XC_MESSAGING_DIR: peerRoot },
    ...overrides,
  };
}

async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

/** 落一条 peer 注册记录（lastSeen 可指定——「近期存活证据」的输入）。 */
async function seedPeerRecord(sessionId: string, pid: number, lastSeen: number): Promise<void> {
  const record: PeerRecord = {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-a4-${pid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name: `a4-${pid}`,
    formerNames: [],
    startedAt: lastSeen,
    lastSeen,
  };
  await writePeerRecord(peerRoot, record);
}

/** 起真进程 → 落 peer 记录 → kill → 等 OS 回收（返回死 pid）。 */
async function seedDeadPeer(sessionId: string, lastSeen: number): Promise<number> {
  const pid = await startSleeper();
  await seedPeerRecord(sessionId, pid, lastSeen);
  sleepers.splice(sleepers.findIndex((c) => c.pid === pid), 1);
  killSync(pid);
  expect(await until(() => !pidAlive(pid), 10_000)).toBe(true);
  return pid;
}

/** 同步杀进程（测试辅助：peer 记录的 pid 必须真的死掉才是 pid-dead 硬证据）。 */
function killSync(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

function until(check: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async (): Promise<boolean> => {
    for (;;) {
      if (check()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  })();
}

// ─────────────────────── 常量与两段式状态 ───────────────────────

describe("V093-04：看门狗告知两段式（常量与台账形状）", () => {
  it("常量：重发间隔 60s / 次数上限 3 / 新鲜死亡窗 10min", () => {
    expect(WATCHDOG_NOTIFY_RETRY_MS).toBe(60_000);
    expect(WATCHDOG_NOTIFY_MAX_ATTEMPTS).toBe(3);
    expect(WATCHDOG_FRESH_DEATH_MS).toBe(600_000);
  });

  it("主路径：alive→dead 迁移认领写 notify:'pending'，通知落地后转 'sent'（后续轮不重发）", async () => {
    await seedTeam();
    await seedPeerRecord("sess_a", process.pid, Date.now()); // lead 活着（本进程）
    await seedDeadPeer("sess_b", Date.now());

    const first = await sweepMembersOnce(deps());
    expect(first.dead).toEqual(["b"]);
    expect(eventsOf("member-dead")).toHaveLength(1);
    // 通知已发出 ⇒ 台账 'sent'
    const afterFirst = await readWatchdogState(root);
    expect(afterFirst.members["b"]?.notify).toBe("sent");
    // 三件套齐（既有契约不回归）
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.content).toContain('成员 "b" 进程已亡');
    expect(eventsOf("watchdog-wake")).toHaveLength(1);

    // 后续轮：dead 且已 sent ⇒ 不重发、不重复告警
    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual([]);
    expect(second.renotified).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(1);
    expect((await readMailbox(root, "default", "a")).length).toBe(1);
  });
});

// ─────────────────────── ① 认领与通知非原子 → 永久静音 ───────────────────────

describe("V093-04①：认领了但通知未落地 → 下一轮重发（不再永久静音）", () => {
  it("【锚点】台账 pending 且认领已久（模拟崩在认领与通知之间）→ 重发 + 台账转 sent + 恰一条", async () => {
    await seedTeam();
    await seedPeerRecord("sess_a", process.pid, Date.now()); // lead 活着，通知有着落
    const now = Date.now();
    await seedDeadPeer("sess_b", now);

    // 模拟「进程崩在锁内认领之后、锁外通知之前」的终局：台账已 dead，notify 仍 pending，
    // 认领时刻早在重发间隔之外（旧代码在这里永久静音：之后每轮都跳过，零错误面）。
    const crashed: WatchdogState = {
      version: 1,
      members: {
        a: { state: "alive", at: now, liveness: "live" },
        b: {
          state: "dead", at: now - 5 * 60_000, liveness: "pid-dead",
          evidence: "process-dead", notify: "pending",
        },
      },
      limbo: {},
      nonces: {},
    };
    await writeWatchdogState(root, crashed);

    const summary = await sweepMembersOnce(deps());
    // 重发：不重复认领（dead 不新增），但把告知补上
    expect(summary.renotified).toEqual(["b"]);
    expect(summary.dead).toEqual([]);
    // v0.9.3 打回第 2 轮（V093-01 残留①）：engine.jsonl 里本没有 member-dead 行（这条
    // 死亡从未跑过告警链）⇒ 条件式补发一条，键集与首认领时逐字一致（§15.5 冻结键集）。
    const dead = eventsOf("member-dead");
    expect(dead).toHaveLength(1);
    expect(dead[0]!["member"]).toBe("b");
    expect(Object.keys(dead[0]!).filter((k) => k !== "ts").sort()).toEqual(
      ["event", "evidence", "liveness", "member", "sessionId", "teamId", "via"],
    );
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.urgent).toBe(true);
    expect(leadBox[0]!.content).toContain("通知未落地");
    expect(leadBox[0]!.content).toContain("现重发");
    // 台账转 sent ⇒ 下一轮不再重发（不轰炸）
    const after = await readWatchdogState(root);
    expect(after.members["b"]?.notify).toBe("sent");
    expect(after.members["b"]?.notifyAttempts).toBe(1);

    const second = await sweepMembersOnce(deps());
    expect(second.renotified).toEqual([]);
    expect((await readMailbox(root, "default", "a")).length).toBe(1);
    // 补发后不再补（已有事件 ⇒ 条件式不重复落）
    expect(eventsOf("member-dead")).toHaveLength(1);
  });

  it("事件已在账（真崩在认领与通知之间）→ 重发告知但**不补发** member-dead（一次死亡一条事件）", async () => {
    await seedTeam();
    await seedPeerRecord("sess_a", process.pid, Date.now()); // lead 活着，通知有着落
    const now = Date.now();
    await seedDeadPeer("sess_b", now);

    // 真实崩溃形态：锁内认领时 member-dead 事件已落（logEngineEvent 先于台账写），
    // 进程死在锁外通知之前 ⇒ 台账 pending、事件已在账。
    await logEngineEvent(root, {
      event: "member-dead",
      teamId: "default",
      member: "b",
      sessionId: "sess_b",
      liveness: "pid-dead",
      evidence: "process-dead",
      via: "watchdog",
    });
    await writeWatchdogState(root, {
      version: 1,
      members: {
        a: { state: "alive", at: now, liveness: "live" },
        b: {
          state: "dead", at: now - 5 * 60_000, liveness: "pid-dead",
          evidence: "process-dead", notify: "pending",
        },
      },
      limbo: {},
      nonces: {},
    });

    const summary = await sweepMembersOnce(deps());
    expect(summary.renotified).toEqual(["b"]);
    // 告知补发（邮箱 + watchdog-wake）但事件不重复落
    expect(eventsOf("member-dead")).toHaveLength(1);
    expect(eventsOf("watchdog-notify-resent")).toHaveLength(1);
    expect((await readMailbox(root, "default", "a")).length).toBe(1);
    // A3 回合摘要口径（core/incidents.ts 按成员键去重）也不会因这次重发双计
    const counts = await readIncidentsSince(root, now - 10 * 60_000);
    expect(counts.deadMembers).toEqual(["b"]);
    expect(counts.memberDead).toBe(1);
  });

  it("宽限：同一轮认领的 pending（at = 本轮 now）当轮不重发——只发当轮那一条", async () => {
    await seedTeam();
    await seedPeerRecord("sess_a", process.pid, Date.now());
    await seedDeadPeer("sess_b", Date.now());

    // 第一轮：b 首见即死（peer 心跳新鲜）⇒ 认领 + 当轮通知一条
    const first = await sweepMembersOnce(deps());
    expect(first.dead).toEqual(["b"]);
    expect(first.renotified).toEqual([]); // 宽限内不重发
    expect((await readMailbox(root, "default", "a")).length).toBe(1);

    // 紧跟着的第二轮（同一时刻语义）：已 sent ⇒ 仍不重发
    const second = await sweepMembersOnce(deps());
    expect(second.renotified).toEqual([]);
    expect((await readMailbox(root, "default", "a")).length).toBe(1);
  });

  it("旧格式/陈旧备份：台账行无 notify 字段（无从证明通知发过）→ 补发一次，随后转 sent 不再发", async () => {
    await seedTeam();
    await seedPeerRecord("sess_a", process.pid, Date.now());
    const now = Date.now();
    await seedDeadPeer("sess_b", now);
    await writeWatchdogState(root, {
      version: 1,
      members: {
        a: { state: "alive", at: now, liveness: "live" },
        b: { state: "dead", at: now - 5 * 60_000, liveness: "pid-dead", evidence: "process-dead" },
      },
      limbo: {},
      nonces: {},
    });

    // 第一轮：补发（adv-3 C7.1 的形态：台账说 dead 而通知从未发出）
    const first = await sweepMembersOnce(deps());
    expect(first.renotified).toEqual(["b"]);
    // 打回第 2 轮（V093-01 残留①）：该形态下 engine.jsonl 也没有 member-dead 行 ⇒ 补发一条
    expect(eventsOf("member-dead")).toHaveLength(1);
    expect(eventsOf("member-dead")[0]!["member"]).toBe("b");
    expect(first.dead).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(1); // 条件式补发：恰一条（不再增长）
    expect(eventsOf("watchdog-notify-resent")).toHaveLength(1);
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.content).toContain("通知未落地");

    // 第二轮：已 sent ⇒ 不再补发（事件不增长、邮箱不增长）
    const second = await sweepMembersOnce(deps());
    expect(second.renotified).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(1);
    expect((await readMailbox(root, "default", "a")).length).toBe(1);
    expect((await readWatchdogState(root)).members["b"]?.notify).toBe("sent");
  });

  it("上限：无人可通知（lead 死 + 无其他活成员）→ 计数增长，达上限置 failed + watchdog-notify-failed 事件", async () => {
    // 只有 lead 一个成员：lead 死 ⇒ 无人可通知（planRecipients 空）
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now: 1,
      founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
    });
    await writeTeam(root, team);
    const now = Date.now();
    await seedDeadPeer("sess_a", now);
    await writeWatchdogState(root, {
      version: 1,
      members: {
        a: {
          state: "dead", at: now - 5 * 60_000, liveness: "pid-dead",
          evidence: "process-dead", notify: "pending",
        },
      },
      limbo: {},
      nonces: {},
    });

    // 三次重发尝试（每次都无人可通知）→ 第三次置 failed 并落错误面事件
    for (let i = 0; i < WATCHDOG_NOTIFY_MAX_ATTEMPTS; i += 1) {
      await sweepMembersOnce(deps());
    }
    const after = await readWatchdogState(root);
    expect(after.members["a"]?.notify).toBe("failed");
    expect(after.members["a"]?.notifyAttempts).toBe(WATCHDOG_NOTIFY_MAX_ATTEMPTS);
    expect(eventsOf("watchdog-notify-failed")).toHaveLength(1);
    expect(eventsOf("watchdog-notify-failed")[0]!["member"]).toBe("a");

    // failed 之后不再重发（有界，不会无限重试）
    const summary = await sweepMembersOnce(deps());
    expect(summary.renotified).toEqual([]);
    expect(eventsOf("watchdog-notify-failed")).toHaveLength(1);
  });
});

// ─────────────────────── ② 台账无历史 + 首扫前已死 ───────────────────────

describe("V093-04②：台账无历史时的首见即死（新鲜死亡告警 / 存量死记录只记录）", () => {
  it("【锚点】台账被删 + 成员首扫前已死 + peer 心跳新鲜 → 照常告警（firstSightDead + 三件套）", async () => {
    await seedTeam();
    await seedPeerRecord("sess_a", process.pid, Date.now()); // lead 活着
    const now = Date.now();
    // b 的进程 1 分钟前才亡（peer lastSeen 新鲜）——「引擎只是没有它的台账历史」
    await seedDeadPeer("sess_b", now - 60_000);
    // 台账文件缺失（fresh state root / lost file）
    expect(existsSync(join(root, "capacity", "watchdog-state.json"))).toBe(false);

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual(["b"]);
    expect(summary.firstSightDead).toEqual(["b"]);
    const dead = eventsOf("member-dead");
    expect(dead).toHaveLength(1);
    // 键集冻结不变（PROTOCOL §15.5 契约测试同款对拍）
    expect(Object.keys(dead[0]!).filter((k) => k !== "ts").sort()).toEqual(
      ["event", "evidence", "liveness", "member", "sessionId", "teamId", "via"],
    );
    // 文案如实注明「台账无历史」，免得 lead 以为是普通迁移
    const leadBox = await readMailbox(root, "default", "a");
    expect(leadBox).toHaveLength(1);
    expect(leadBox[0]!.content).toContain("台账无该成员历史");
    // 不重复：第二轮起已是 dead 且已 sent
    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(1);
  });

  it("存量死记录：台账被删 + 成员早死（peer 心跳在窗外）→ 只记录不告警（v0.9.2 A2 原口径保留）", async () => {
    await seedTeam();
    await seedPeerRecord("sess_a", process.pid, Date.now());
    const now = Date.now();
    // b 20 分钟前就亡了（超出 10min 新鲜窗）——启动期/台账丢失后的存量死记录
    await seedDeadPeer("sess_b", now - 20 * 60_000);

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual([]);
    expect(summary.firstSightDead).toEqual([]);
    expect(eventsOf("member-dead")).toHaveLength(0);
    expect((await readMailbox(root, "default", "a")).length).toBe(0);
    // 仍落账（往轮已死，不因一次扫描抖动重新武装）且不给重发队列留条目
    const after = await readWatchdogState(root);
    expect(after.members["b"]?.state).toBe("dead");
    expect(after.members["b"]?.notify).toBe("sent");
    expect((await sweepMembersOnce(deps())).renotified).toEqual([]);
  });
});
