/**
 * v0.9.3 组 C 契约测试（方案 §一 组 C / §三 L2）：
 *
 * 1. **C4**：`docs/PROTOCOL.md` §15.5 的 6 个 engine 事件 + 2 个 `message-limbo`
 *    生产者形状，按 `Object.keys` 与**实跑**事件对拍（对齐 §7/§15.2/§15.3 既有做法：
 *    键集冻结、行级 `ts` 除外、文档声明的可选键单独枚举）。文档改字段名 / 代码改键名
 *    任一側先红；
 * 2. **C2**：宿主归档不可见的**原句锁**——README 已知限制与 PROTOCOL §15.6 的声明句
 *    必须在场（措辞与代码事实一致：四判据全静默 → unknown，不冒充活跃）；
 * 3. **C1 跨面**：`xc_overview` team/panel/status 三视图成员行的 `livenessSources`
 *    （四判据来源）同源同形，且邮箱写入这一判据真的能进来源列表。
 *
 * 本文件只读文档 + 跑引擎面真实函数（attemptWake / sweepMembersOnce / handleOverview），
 * 不 import 其他组的测试文件；peer 注册表与状态根全部落系统 TEMP 临时目录。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { payloadOf } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import type { ToolDeps } from "./core.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { createWakeNonce, writeSession } from "../core/registry.js";
import { wakeLifecycleFile } from "../core/paths.js";
import { appendMailbox, createMessage, markMailboxDelivered } from "../core/mailbox.js";
import { pidAlive } from "../core/lock.js";
import { localPidDomain } from "../core/peerdir.js";
import { writePeerRecord, type PeerRecord } from "../core/peerregistry.js";
import type { CapacitySample } from "../core/capacity.js";
import { attemptWake, type WakeRequest } from "../engine/wake.js";
import type { SpawnResumeOptions, SpawnResumeResult } from "../engine/resume-cli.js";
import { sweepMembersOnce, type WatchdogDeps } from "../engine/watchdog.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROTOCOL = readFileSync(join(REPO_ROOT, "docs", "PROTOCOL.md"), "utf8");
// v0.9.4 B3：README 瘦身——已知限制/威胁模型搬 docs/LIMITATIONS.md、版本记录搬 CHANGELOG.md。
// 用户文档面口径锁改查并集（原句必须仍在用户可见文档中；条目搬家不丢锁）。
const README = ["README.md", "docs/LIMITATIONS.md", "CHANGELOG.md"]
  .map((rel) => readFileSync(join(REPO_ROOT, rel), "utf8"))
  .join("\n");

// ---------------------------------------------------------------------------
// 冻结块提取与键集对拍（与 protocol-frozen-contract-v090 / tools-relay-v091 同款）
// ---------------------------------------------------------------------------

/** 取 marker 之后的前 count 个 ```json 冻结块。 */
function frozenJsonBlocksAfter(doc: string, marker: string, count: number): Record<string, unknown>[] {
  const at = doc.indexOf(marker);
  if (at < 0) throw new Error(`PROTOCOL 冻结标记缺失：${marker}`);
  const rest = doc.slice(at);
  const blocks: Record<string, unknown>[] = [];
  const re = /```json\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null && blocks.length < count) {
    blocks.push(JSON.parse(m[1]!) as Record<string, unknown>);
  }
  if (blocks.length < count) throw new Error(`PROTOCOL 冻结块不足：${marker}（需 ${count}，得 ${blocks.length}）`);
  return blocks;
}

const sortedKeys = (value: Record<string, unknown>): string[] => Object.keys(value).sort();

/**
 * 键集对拍：实跑事件剔除 `ts`（logEngineEvent 统一盖）与**文档声明的可选键**后，
 * 必须恰等于冻结块键集（同样剔除可选键）；剩下的每个冻结键都必须在实跑事件中在场。
 * 可选键不在场也算合法（冻结块本来就不含它们）——「可选」由 §15.5 正文逐条声明，
 * 不在场的可选键由各用例用 `not.toHaveProperty` 单独钉死。
 */
function expectFrozenKeys(
  actual: Record<string, unknown>,
  frozen: Record<string, unknown>,
  label: string,
  optionalKeys: readonly string[] = [],
): void {
  const stripped = Object.keys(actual).filter((k) => k !== "ts" && !optionalKeys.includes(k)).sort();
  const frozenStripped = sortedKeys(frozen).filter((k) => !optionalKeys.includes(k));
  expect(stripped, `${label}：实跑键集（剔除 ts 与声明可选键）应等于冻结键集`).toEqual(frozenStripped);
  for (const key of frozenStripped) {
    expect(actual, `${label}：冻结键 "${key}" 应在实跑事件中在场`).toHaveProperty(key);
  }
}

/** §15.5 声明的可选键（watchdog-wake：note/wakeDeferred/retryAfterMs/detail）。 */
const WATCHDOG_WAKE_OPTIONAL = ["note", "wakeDeferred", "retryAfterMs", "detail"] as const;
/** §15.5 声明的可选键（message-limbo：生产者独有的 taskId）。 */
const LIMBO_OPTIONAL = ["taskId"] as const;

// ---------------------------------------------------------------------------
// 临时状态根 / peer 根
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const sleepers: ReturnType<typeof spawn>[] = [];
let root: string;
let peerRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-v093c-contract-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-v093c-contract-peers-"));
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

function engineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventsOf(name: string): Array<Record<string, unknown>> {
  return engineEvents().filter((e) => e["event"] === name);
}

/** 轮询等待谓词成立（判据可异步；deadline 后 false = 硬失败，不放宽用例）。 */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 起一个真活进程并落一条 peer 注册记录（pid-dead 是 C8 唯一进程死硬证据，不用假 pid）。 */
async function seedLivePeer(sessionId: string): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  const pid = child.pid!;
  const record: PeerRecord = {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-v093c-${pid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "bg",
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  };
  await writePeerRecord(peerRoot, record);
  return pid;
}

function killSyncPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

/** lead「a」+ 成员「b」的 team.json（founderKey=a → leadKeyOf=a）。 */
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
    // 唤醒闸关闭（env 层）：看门狗仍尝试唤醒，attemptWake 如实降级 mailbox 并留痕。
    env: { XC_MESSAGING_DIR: peerRoot },
    ...overrides,
  };
}

/** RED 容量样本（水位 8.9% 命中硬底）——让 attemptWake 在 spawn 前被挡，不拉真子进程。 */
function redSample(): CapacitySample {
  return {
    sampledAt: Date.now(),
    totalBytes: 16 * 1024 ** 3,
    freeBytes: 1_400_000_000,
    watermark: 0.089,
    steadyTreeBytes: 12 * 1024 ** 3,
    headlessTurnCount: 2,
    headlessTurnMaxRssBytes: 900 * 1024 * 1024,
    degraded: null,
  };
}

/** GREEN 容量样本（测试注入）——闸放行，让 attemptWake 走到 spawn（spawn 本身注入假实现）。 */
function greenSample(): CapacitySample {
  return {
    sampledAt: Date.now(),
    totalBytes: 16 * 1024 ** 3,
    freeBytes: 8 * 1024 ** 3,
    watermark: 0.5,
    steadyTreeBytes: 1 * 1024 ** 3,
    headlessTurnCount: 0,
    headlessTurnMaxRssBytes: null,
    degraded: null,
  };
}

/** 假 spawn：不汇报唤醒子 pid（无启动证据），pid 取本机不存在的大数（提前出口立即触发）。 */
function fakeSpawnSilent(pid = 424242): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => ({ pid, logFile: opts.logFile });
}

function baseWakeReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "message",
    receiptIds: ["m1"],
    ticket: "重踢：BD869",
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    capacitySample: greenSample(),
    ...overrides,
  };
}

/** 在当前临时 root 的 b 邮箱落一条消息，返回其 id。 */
async function seedMailbox(): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "重踢：BD869", { deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

/** 落一条「已盖章、未消费、已超时」的 limbo 候选消息。 */
async function seedLimboMessage(stampedAgoMs: number): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "回执待消费", { deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  await markMailboxDelivered(root, "default", "b", [message.id], Date.now() - stampedAgoMs);
  return message.id;
}

// ---------------------------------------------------------------------------
// C4：PROTOCOL §15.5 冻结块 ↔ 实跑 engine 事件
// ---------------------------------------------------------------------------

describe("v0.9.3 契约：PROTOCOL §15.5 冻结块 ↔ 实跑 engine 事件键集（C4）", () => {
  it("`wake-start-confirm`（confirmed）：键集对拍 + pid 仅确认时在场", async () => {
    const [frozen] = frozenJsonBlocksAfter(PROTOCOL, "**engine 事件 `wake-start-confirm`**（键集冻结", 1);
    await seedTeam();
    await writeSession(root, { sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now() });
    const messageId = await seedMailbox();

    // helper 同步汇报唤醒子 pid（启动证据）→ confirmed:true + pid 在场。
    await attemptWake(baseWakeReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: (opts) => {
        opts.onHelperSpawned?.(5150);
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    const confirmed = eventsOf("wake-start-confirm")[0]!;
    expectFrozenKeys(confirmed, frozen!, "wake-start-confirm(confirmed)");
    expect(confirmed["startConfirmed"]).toBe(true);
    expect(confirmed["pid"]).toBe(5150);
    expect(confirmed["to"]).toBe("b");
    expect(confirmed["thresholdMs"]).toBe(5_000); // XC_START_CONFIRM_MS 缺省
  });

  it("`wake-start-confirm`（unconfirmed）：无 pid 键，其余键集不变", async () => {
    const [frozen] = frozenJsonBlocksAfter(PROTOCOL, "**engine 事件 `wake-start-confirm`**（键集冻结", 1);
    await seedTeam();
    await writeSession(root, { sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: Date.now() });
    const messageId = await seedMailbox();

    await attemptWake(baseWakeReq({
      receiptIds: [messageId],
      watchWindowMs: 0,
      limboTimeoutMs: 3_600_000,
      wakeSlowMs: 3_600_000,
      lifecycleWindowMs: 1_000,
      spawn: fakeSpawnSilent(),
    }));
    const unconfirmed = eventsOf("wake-start-confirm")[0]!;
    // `pid` 是 §15.5 声明的「仅确认时在场」可选键：未确认形态剔除后再对拍。
    expectFrozenKeys(unconfirmed, frozen!, "wake-start-confirm(unconfirmed)", ["pid"]);
    expect(unconfirmed["startConfirmed"]).toBe(false);
    expect(unconfirmed).not.toHaveProperty("pid"); // 「pid 仅确认时在场」
  });

  it("`member-dead` + `watchdog-wake`：键集对拍（watchdog-wake 的四个可选键按 §15.5 声明）", async () => {
    const [frozenDead] = frozenJsonBlocksAfter(PROTOCOL, "**engine 事件 `member-dead`**（键集冻结", 1);
    const [frozenWake] = frozenJsonBlocksAfter(PROTOCOL, "**engine 事件 `watchdog-wake`**（键集冻结", 1);
    await seedTeam();
    await seedLivePeer("sess_a");
    const memberPid = await seedLivePeer("sess_b");
    await sweepMembersOnce(deps());
    // 成员 b 的进程真的死亡（kill 后 peer 记录仍在 = pid-dead 硬证据）。
    sleepers.splice(sleepers.findIndex((c) => c.pid === memberPid), 1);
    killSyncPid(memberPid);
    expect(await until(() => !pidAlive(memberPid), 10_000)).toBe(true);

    // 唤醒闸开启（env 层）+ 容量 RED：attemptWake 在 spawn 前被容量闸挡下（deferral 透出）。
    await sweepMembersOnce(deps({
      env: { XC_MESSAGING_DIR: peerRoot, XC_WAKE_ENABLED: "true" },
      capacitySample: redSample(),
    }));
    const dead = eventsOf("member-dead")[0]!;
    expectFrozenKeys(dead, frozenDead!, "member-dead");
    expect(dead["liveness"]).toBe("pid-dead");
    expect(dead["evidence"]).toBe("process-dead");
    expect(dead["via"]).toBe("watchdog");

    const wake = eventsOf("watchdog-wake")[0]!;
    expectFrozenKeys(wake, frozenWake!, "watchdog-wake", WATCHDOG_WAKE_OPTIONAL);
    expect(wake["to"]).toBe("a"); // lead 活着 → 通知 lead 并尝试唤醒
    expect(wake["delivered"]).toBe("mailbox"); // 容量 RED → 不 spawn，如实降级
    // 容量闸 deferral 的三个透出键属 §15.5 声明的可选键：在场即合法，且形态如实。
    expect(wake["wakeDeferred"]).toBe(true);
    expect(typeof wake["retryAfterMs"]).toBe("number");
  });

  it("`watchdog-notify-skipped`：无人可通知 → 只落审计（键集对拍）", async () => {
    const [frozen] = frozenJsonBlocksAfter(PROTOCOL, "**engine 事件 `watchdog-notify-skipped`**（无人可通知", 1);
    const team = newTeamState({
      teamId: "default",
      founderKey: "a",
      now: 1,
      founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
    });
    await writeTeam(root, team); // 花名册只有 lead 一名成员
    const leadPid = await seedLivePeer("sess_a");
    await sweepMembersOnce(deps());
    sleepers.splice(sleepers.findIndex((c) => c.pid === leadPid), 1);
    killSyncPid(leadPid);
    expect(await until(() => !pidAlive(leadPid), 10_000)).toBe(true);

    await sweepMembersOnce(deps());
    const skipped = eventsOf("watchdog-notify-skipped")[0]!;
    expectFrozenKeys(skipped, frozen!, "watchdog-notify-skipped");
    expect(skipped["reason"]).toBe("lead-dead-no-other-live-members");
    expect(eventsOf("watchdog-wake")).toHaveLength(0);
  });

  it("`wake-orphan-nonce`：在途 nonce 未消费而唤醒子已退出（键集对拍）", async () => {
    const [frozen] = frozenJsonBlocksAfter(PROTOCOL, "**engine 事件 `wake-orphan-nonce`**（在途 nonce 未消费", 1);
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    // 在途 nonce（未消费、新鲜）+ 唤醒子退出证据（生命周期账按 nonce.ts 命名）。
    const { token, nonce } = await createWakeNonce(root, { teamId: "default", agentKey: "b", sid: "sess_b" });
    const lifecycle = wakeLifecycleFile(root, "b", nonce.ts);
    mkdirSync(join(root, "logs"), { recursive: true });
    appendFileSync(lifecycle, `${JSON.stringify({ ts: Date.now(), event: "wake-child-start", nonce: "x" })}\n`);
    appendFileSync(lifecycle, `${JSON.stringify({ ts: Date.now(), event: "wake-child-exit", pid: 999, durationMs: 10, exitCode: null })}\n`);

    await sweepMembersOnce(deps());
    const orphan = eventsOf("wake-orphan-nonce")[0]!;
    expectFrozenKeys(orphan, frozen!, "wake-orphan-nonce");
    expect(orphan["to"]).toBe("b");
    expect(String(orphan["nonce"])).not.toBe(token); // 只落不可反查摘要
  });

  it("`watchdog-sweep-failed`：team.json 不可解析 → 定时器回调不抛、只留痕（键集对拍）", async () => {
    const [frozen] = frozenJsonBlocksAfter(PROTOCOL, "**engine 事件 `watchdog-sweep-failed`**（定时器回调纪律", 1);
    mkdirSync(join(root, "teams", "default"), { recursive: true });
    writeFileSync(join(root, "teams", "default", "team.json"), "{ 这不是 JSON", "utf8");

    await sweepMembersOnce(deps()); // 不得抛
    const failed = eventsOf("watchdog-sweep-failed")[0]!;
    expectFrozenKeys(failed, frozen!, "watchdog-sweep-failed");
    expect(typeof failed["error"]).toBe("string");
    expect(String(failed["error"]).length).toBeGreaterThan(0);
  });

  it("`message-limbo` 双生产者：看门狗面最小键 + per-spawn 全量键（键集对拍，taskId 为可选）", async () => {
    // 该标记之后的两个冻结块按文档顺序：① per-spawn 全量键；② 看门狗最小键 + via。
    const [frozenLimboPerSpawn, frozenLimboWatchdog] = frozenJsonBlocksAfter(
      PROTOCOL, "**`message-limbo` 双生产者形状**", 2,
    );
    // 看门狗面：只落最小键 + via:"watchdog"。
    await seedTeam();
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    const limboDeps = deps({ env: { XC_MESSAGING_DIR: peerRoot, XC_LIMBO_TIMEOUT_MS: "1000" } });
    await seedLimboMessage(2_000);
    await sweepMembersOnce(limboDeps);
    const watchdogLimbo = eventsOf("message-limbo")[0]!;
    expectFrozenKeys(watchdogLimbo, frozenLimboWatchdog!, "message-limbo(watchdog)", LIMBO_OPTIONAL);
    expect(watchdogLimbo["via"]).toBe("watchdog");

    // per-spawn 监视器面：落全量键（nonce/sid/scene/stampedAt/waitedMs 在场）。
    const messageId = await seedMailbox();
    await writeSession(root, { sessionId: "sess_b", cwd: "D:\\ws", startedAt: 1, lastSeen: 1 });
    await attemptWake(baseWakeReq({
      receiptIds: [messageId],
      reason: "dispatch", // prompt 不内嵌全文，隔离 limbo 本体
      now: Date.now() - 200,
      watchWindowMs: 0,
      limboTimeoutMs: 300,
      limboGraceMs: 700,
      lifecyclePollMs: 20,
      lifecycleWindowMs: 4_000,
      wakeSlowMs: 3_600_000,
      spawn: fakeSpawnSilent(),
    }));
    expect(await until(() => eventsOf("message-limbo").length >= 2, 5_000)).toBe(true);
    const perSpawn = eventsOf("message-limbo").at(-1)!;
    expectFrozenKeys(perSpawn, frozenLimboPerSpawn!, "message-limbo(per-spawn)", LIMBO_OPTIONAL);
    expect(perSpawn["sid"]).toBe("sess_b");
    expect(perSpawn["scene"]).toBe("dispatch");
    expect(perSpawn).not.toHaveProperty("via"); // per-spawn 面无 via——两形态可分辨
  });
});

// ---------------------------------------------------------------------------
// C2：宿主归档不可见的原句锁（README 已知限制 + PROTOCOL §15.6 附录）
// ---------------------------------------------------------------------------

describe("v0.9.3 契约：宿主归档不可见如实声明（C2，原句锁）", () => {
  it("README 已知限制：插件对宿主侧归档态零感知（G-21）+ 不冒充活跃 + 指向 §15.6", () => {
    expect(README).toContain("插件对宿主侧归档态零感知（G-21，v0.9.3 如实声明）");
    expect(README).toContain("活性四判据合判如实落「判据来源为空（unknown）」而**不冒充活跃**");
    // v0.9.5 B2：docs/LIMITATIONS.md 内两处 PROTOCOL 相对链接修复（41-v095 方案 §一 B2，
    // href docs/PROTOCOL.md → PROTOCOL.md；链接文本与语句语义不变）——原句锁随合法文档
    // 修复同步 href 形态，句子在场性判定不变。
    expect(README).toContain("平台反馈建议（`member-archived` 事件 / 归档态投递告警）见 [docs/PROTOCOL.md](PROTOCOL.md) §15.6");
    expect(README).toContain("本版不自造实现");
  });

  it("PROTOCOL §15.6：缺口事实 + 平台反馈建议两条 + 不自造实现声明", () => {
    expect(PROTOCOL).toContain("### 15.6 v0.9.3 增量：宿主归档态不可见（G-21）如实声明 + 平台反馈建议");
    expect(PROTOCOL).toContain("**缺口事实（G-21）**：插件对宿主侧的会话**归档/清理零感知**");
    expect(PROTOCOL).toContain("即 §12.4 四判据**全部无声**");
    // 产品侧如实处置：全静默 = unknown，不冒充 running（与代码事实同措辞）。
    expect(PROTOCOL).toContain("**「全静默 = unknown」**");
    expect(PROTOCOL).toContain("**不冒充 running**");
    // 平台反馈建议两条。
    expect(PROTOCOL).toContain("1. **`member-archived` 事件**");
    expect(PROTOCOL).toContain("2. **归档态投递告警**");
    expect(PROTOCOL).toContain("`delivery-refused{reason:\"archived\"}`");
    expect(PROTOCOL).toContain("**平台反馈建议**（给宿主，非本版实现；两条都可独立落地）");
    expect(PROTOCOL).toContain("**威胁模型口径不变**：同机进程持续伪造状态文件仍不防（不做签名/哈希链，§10/§11.5）");
  });

  it("§12.4 四判据合判口径与代码同措辞（livenessSources 固定序 + dead 只认 pid-dead）", () => {
    expect(PROTOCOL).toContain("endpointLive: boolean, livenessSources: string[]");
    expect(PROTOCOL).toContain("**四判据合判（v0.9.3 C1）**");
    expect(PROTOCOL).toContain("`hooks-pid`");
    expect(PROTOCOL).toContain("`registry-lastSeen`");
    expect(PROTOCOL).toContain("`engine-events`");
    expect(PROTOCOL).toContain("`mailbox-mtime`");
    expect(PROTOCOL).toContain("① **全静默 → unknown**");
    expect(PROTOCOL).toContain("② **`dead` 仍只认 pid-dead**");
    expect(PROTOCOL).toContain("③ **合判是展示面合成**");
  });
});

// ---------------------------------------------------------------------------
// C1 跨面：overview 三视图成员行的判据来源（含邮箱写入 mtime 判据）
// ---------------------------------------------------------------------------

describe("v0.9.3 契约：xc_overview 三视图成员行 livenessSources 同源同形（C1 跨面）", () => {
  function bindIdentity(name: string, sessionId: string): BoundIdentity {
    return {
      sessionKey: `${sessionId}:${name}`,
      teamId: "default",
      name,
      agentKey: name,
      sessionId,
      role: "peer" as const,
      boundAt: Date.now(),
    };
  }

  it("邮箱刚被写过（其余判据无声）→ mailbox-mtime 单独进来源；三视图同值", async () => {
    const team = newTeamState({
      teamId: "default",
      founderKey: "lead",
      now: Date.now(),
      founder: { key: "lead", sessionId: "sess-lead", role: "worker", joinedAt: Date.now(), lastSeen: 1 },
    });
    team.leadKey = "lead";
    team.members.push({ key: "mate", sessionId: "sess-mate", role: "worker", joinedAt: Date.now(), lastSeen: 1 });
    await writeTeam(root, team);
    // 会话记录：无 liveness 自述、lastSeen 远古（第①②判据无声）；无 peer 记录、无证言。
    await writeSession(root, { sessionId: "sess-mate", cwd: "D:\\ws", startedAt: 1, lastSeen: 1 });
    // 第④判据：邮箱文件此刻被写（投递即写 inbox/<key>.jsonl）。
    mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
    const message = createMessage("lead", "mate", "归档后还有人找你", { deliveryClaimedAt: Date.now() });
    await appendMailbox(root, "default", "mate", message);

    const deps: ToolDeps = { stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } };
    identityStore.bind("conn-v093c", bindIdentity("lead", "sess-lead"));
    try {
      const teamPayload = payloadOf(await handleOverview(deps, { view: "team" }, "conn-v093c")) as Record<string, unknown>;
      const panelPayload = payloadOf(await handleOverview(deps, { view: "panel" }, "conn-v093c")) as Record<string, unknown>;
      const statusPayload = payloadOf(await handleOverview(deps, { view: "status" }, "conn-v093c")) as Record<string, unknown>;

      const teamRows = teamPayload["members"] as Array<{ key: string; liveness?: Record<string, unknown> }>;
      const panelRows = panelPayload["members"] as Array<{ key: string; liveness?: Record<string, unknown> }>;
      const statusLiveness = statusPayload["liveness"] as { byMember: Record<string, Record<string, unknown>> };

      const teamRow = teamRows.find((m) => m.key === "mate")!.liveness!;
      expect(teamRow["livenessSources"]).toEqual(["mailbox-mtime"]);
      // 三视图同源同形（跨面一致性）。
      expect(panelRows.find((m) => m.key === "mate")!.liveness).toEqual(teamRow);
      expect(statusLiveness.byMember["mate"]).toEqual(teamRow);
      // 邮箱写入不是「回合在跑」：state 仍保守 idle（合判不改 state 语义）。
      expect(teamRow["state"]).toBe("idle");
    } finally {
      identityStore.bind("__discard__", bindIdentity("ghost", "sess-ghost")); // 防 require 泄漏
    }
  });

  it("四判据全静默 → 来源为空（unknown）；dead 仍只认 pid-dead", async () => {
    const team = newTeamState({
      teamId: "default",
      founderKey: "lead",
      now: Date.now(),
      founder: { key: "lead", sessionId: "sess-lead", role: "worker", joinedAt: Date.now(), lastSeen: 1 },
    });
    team.leadKey = "lead";
    team.members.push({ key: "mate", sessionId: "sess-mate", role: "worker", joinedAt: Date.now(), lastSeen: 1 });
    await writeTeam(root, team);
    await writeSession(root, { sessionId: "sess-mate", cwd: "D:\\ws", startedAt: 1, lastSeen: 1 });

    const deps: ToolDeps = { stateRoot: root, workspace: "D:\\ws", env: { XC_MESSAGING_DIR: peerRoot } };
    identityStore.bind("conn-v093c", bindIdentity("lead", "sess-lead"));
    try {
      const payload = payloadOf(await handleOverview(deps, { view: "team" }, "conn-v093c")) as Record<string, unknown>;
      const rows = payload["members"] as Array<{ key: string; liveness?: Record<string, unknown> }>;
      expect(rows.find((m) => m.key === "mate")!.liveness!["livenessSources"]).toEqual([]);
      // 计数口径不变（三态文本行/计数字符串不受新字段影响）。
      expect(payload["liveness"]).toEqual({ running: 0, idle: 2, dead: 0 });
    } finally {
      identityStore.bind("__discard__", bindIdentity("ghost", "sess-ghost"));
    }
  });
});
