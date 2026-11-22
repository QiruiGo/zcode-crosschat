/**
 * v0.9.2 打回第 1 轮（V092-01 / V092-02）定向单测——看门狗**并发去重**与**通知收件人面**。
 *
 * 缺陷原文（裁决 confirmed）：
 * - **V092-01（P1）**：A2 硬口径「同一成员同一次死亡只发一次」被并发扫描打破——迁移判据在
 *   readWatchdogState 与 writeWatchdogState 之间不持任何锁（全函数唯一的 withTeamLock 只包
 *   limbo 段），而每个 MCP server 进程都起一把扫描、共享同一本无互斥的整文件原子写台账 ⇒
 *   两把重叠扫描 last-writer-wins，同一次 death 两套告警（adv-1 TC-1：3/3 复现，每次
 *   member-dead=2 / lead urgent=2 / watchdog-wake=2，设计恰 1/1/1）。
 * - **V092-02（P1）**：① 扇出放大（同根因）；② 独立缺陷——收件人过滤只排除 leadKey，不排除
 *   本轮/往轮已判 pid-dead 的成员 ⇒ 对已死会话仍发通知并 attemptWake，必然 sessionNotFound
 *   → wake-failed + wake-retry-failed 双事件、双 urgent，且 notifyLeadUrgent 把第二份 urgent
 *   写进已死 lead 无人读取的邮箱（adv-1 TC-2 C/C2 部分实测）。
 *
 * 本文件的锚点：
 * 1. **跨进程认领**：两个**真进程**（esbuild 打包 harness + node spawn）对同一 stateRoot 各跑
 *    一轮扫描 → 合起来 member-dead=1 / lead urgent=1 / watchdog-wake=1（不论两程是否真重叠）；
 * 2. **同进程并发**：Promise.all 四把扫描 → 同样恰一套（in-process 队列 + 文件锁双保险）；
 * 3. **锁真实存在且跨进程**：外部子进程持 `locks/watchdog-state.lock` → 本轮扫描直接跳过
 *    （不告警、不唤醒、不抛），释放后才告警——证明临界段确实拿了这把锁；
 * 4. **收件人排除已死成员**：lead+b 同轮双死 → 只通知/唤醒活成员（c/d），已死成员的邮箱零
 *    写入、零唤醒、零 wake-failed/wake-retry-failed；
 * 5. **lead 往轮已死 + 成员本轮死** → 不通知/不唤醒已死 lead，改投活成员（无失败风暴）。
 *
 * 依赖隔离：peer 注册表写临时目录（env XC_MESSAGING_DIR），pid 活性用真活进程（spawn node
 * sleeper——pid-dead 是 C8 唯一进程死硬证据，不能用假 pid 伪造）；唤醒不注入 spawn，靠
 * 「唤醒闸关闭」让 attemptWake 如实降级 mailbox 并留痕。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newTeamState, writeTeam } from "../core/teamstate";
import { localPidDomain } from "../core/peerdir";
import { readPeerRecord, removePeerRecord, writePeerRecord, type PeerRecord } from "../core/peerregistry";
import { pidAlive } from "../core/lock.js";
import {
  sweepMembersOnce,
  WATCHDOG_LOCK_WAIT_MS,
  WATCHDOG_STATE_LOCK_NAME,
  type WatchdogDeps,
} from "./watchdog";
import { readWatchdogState } from "./watchdog-state";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-watchdog-v092r1-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-watchdog-v092r1-peers-"));
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

/** 起一个真活进程并落一条 peer 注册记录（活性判据吃真 pid）。 */
async function seedLivePeer(sessionId: string): Promise<number> {
  const pid = await startSleeper();
  const record: PeerRecord = {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-wdr1-${pid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name: `wdr1-${pid}`,
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  };
  await writePeerRecord(peerRoot, record);
  return pid;
}

async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

/** 同步杀进程（peer 记录的 pid 必须真的死掉才是 pid-dead 硬证据）。 */
function killSync(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

/**
 * 死亡证据钉扎用的高位 pid 基址：**确定不存在、且测试窗口内不会被 OS 分配**。
 *
 * 为什么需要（实测，2026-11-20 全量负载复现）：Windows 会在进程退出后很快复用
 * pid 槽——本文件在「锁被外部进程持 2s + 释放后再扫」的 2.5s 窗口里就撞上过：
 * 被杀 sleeper 的 pid 归了别的进程，peer 记录因 `pidAlive && lastSeen 新鲜` 重回
 * `active`，死成员看起来又活了，扫描不认领（after.dead=[]，零告警）。本用例验证
 * 的是「alive→dead 迁移恰一次」的跨进程认领，不是 Windows pid 分配器；因此真杀
 * 成立后把会话记录钉到一个永远不可能被分配的高位 pid（与 core/offline.test.ts
 * 的 DEAD_PID 同款判据），死证据就不再受 pid 复用影响。
 */
const DEAD_PID_BASE = 2_147_483_000;
const DEAD_PID_LIMIT = 100;
let deadPidSeq = 0;

function nextDeadPid(): number {
  if (deadPidSeq >= DEAD_PID_LIMIT) throw new Error("nextDeadPid: 测试用死 pid 配额耗尽");
  const pid = DEAD_PID_BASE + deadPidSeq * 4;
  deadPidSeq += 1;
  return pid;
}

/**
 * 真杀一个 sleeper，并把它的 peer 记录钉成稳定的 pid-dead 证据。
 *
 * 1. 杀进程并等 `pidAlive` 转 false（真死已确认——alive→dead 迁移是真实的）；
 * 2. 删掉原 pid 名的记录，改写到 {@link nextDeadPid} 的高位 pid 名下（其余字段
 *    照旧）——从此扫描恒判 pid-dead，不会因 OS 复用原 pid 槽而「复活」。
 *
 * 每一步的死 pid 互不相同（多成员同轮死亡的用例不会互相覆盖记录文件）。
 */
async function killAndForget(pid: number): Promise<void> {
  sleepers.splice(sleepers.findIndex((c) => c.pid === pid), 1);
  killSync(pid);
  // 负载无关：等「OS 已回收该 pid」这一产品判据成立（pidAlive 转 false），不猜固定 60ms
  // ——负载下进程回收可能远超 60ms，固定等待会把活 pid 误当已死（g16 同款教训）。
  const ok = await until(() => !pidAlive(pid), 10_000);
  if (!ok) throw new Error(`killAndForget: pid ${pid} still alive after 10s`);
  const record = await readPeerRecord(peerRoot, pid);
  if (record === undefined) throw new Error(`killAndForget: no peer record for pid ${pid}`);
  await removePeerRecord(peerRoot, pid);
  const pinnedPid = nextDeadPid();
  await writePeerRecord(peerRoot, { ...record, pid: pinnedPid });
  // 自检：钉扎后的 pid 必须被判为死（否则后续断言会在错误的证据上跑）。
  if (pidAlive(pinnedPid)) throw new Error(`killAndForget: pinned pid ${pinnedPid} is unexpectedly alive`);
}

/** lead「a」+ 成员 b/c/d（founderKey=a；lead 与成员一样占花名册行）。 */
async function seedTeam(memberKeys: string[] = ["b", "c", "d"]): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "a",
    now: 1,
    founder: { key: "a", sessionId: "sess_a", role: "worker", joinedAt: 1, lastSeen: 1 },
  });
  for (const key of memberKeys) {
    team.members.push({ key, sessionId: `sess_${key}`, role: "worker", joinedAt: 1, lastSeen: 1 });
  }
  await writeTeam(root, team);
}

function deps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    stateRoot: root,
    workspace: "D:\\ws",
    // 唤醒闸关闭（env 层）：看门狗仍会**尝试**唤醒，attemptWake 如实降级 mailbox 并留痕。
    env: { XC_MESSAGING_DIR: peerRoot },
    ...overrides,
  };
}

/**
 * 被测模块的绝对路径——**从本测试文件自身位置推导，不用 process.cwd()**。
 *
 * 为什么（2026-11-20 全量单测两次红的根因）：harness 要用 esbuild 打包
 * `src/engine/watchdog.ts` 再起真进程，入口路径原先写成
 * `join(process.cwd(), "src", "engine", "watchdog.ts")`——这隐含「vitest 的 CWD 恒为
 * plugin/」。一旦调用方从仓库根跑（如 `npx vitest run --root plugin` / `--dir plugin/src`），
 * worker 的 CWD 是仓库根，拼出的 `…/zcode-crosschat/src/engine/watchdog.ts` 不存在 →
 * esbuild `Could not resolve` → 本用例（且仅本用例，全库唯一用 cwd 拼源码路径的文件）
 * 每次必红，retry 也救不了（确定性失败，不是 flake）。
 * 改为 `import.meta.url` 推导后与 CWD 无关，两种调用形态都通（与本仓其他测试定位 src 根的
 * 范式一致：a5-commands-docs / protocol-frozen-contract-v090 / legacy-removal 同款）。
 */
const WATCHDOG_TS = fileURLToPath(new URL("./watchdog.ts", import.meta.url));

/**
 * 把一个小 harness 用 esbuild 打包成 ESM，然后用 node 起**真进程**跑 sweepMembersOnce。
 * 返回两个子进程的 stdout（各一行 JSON：sweep 摘要）。
 */
async function runSweepInTwoProcesses(): Promise<Array<Record<string, unknown>>> {
  const bundleDir = mkdtempSync(join(tmpdir(), "xc-watchdog-v092r1-bundle-"));
  dirs.push(bundleDir);
  const entry = join(bundleDir, "harness.ts");
  const harness = `
    import { sweepMembersOnce } from ${JSON.stringify(WATCHDOG_TS)};
    const [stateRoot, peerRoot] = process.argv.slice(2);
    const summary = await sweepMembersOnce({
      stateRoot,
      workspace: "D:\\\\ws",
      env: { XC_MESSAGING_DIR: peerRoot },
    });
    process.stdout.write(JSON.stringify(summary) + "\\n");
  `;
  writeFileSync(entry, harness, "utf8");
  const outfile = join(bundleDir, "harness.mjs");
  await build({ entryPoints: [entry], bundle: true, outfile, platform: "node", format: "esm", logLevel: "error" });
  const runs = [0, 1].map(() => new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, [outfile, root, peerRoot], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    let errText = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { text += chunk; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { errText += chunk; });
    child.once("error", reject);
    // 用 close（stdio 已全部排空）而不是 exit：Node 文档明确 exit 触发时 stdio 可能仍打开，
    // 负载下 stdout 管道数据可能晚于 exit 送达 —— 在 exit 上解析会拿到半截/空串（假失败）。
    child.once("close", (code) => {
      const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        const stderr = errText !== "" ? ` | stderr: ${errText.slice(0, 400)}` : "";
        reject(new Error(`harness close ${code}: ${text.slice(0, 400)}${stderr}`));
      }
    });
  }));
  return Promise.all(runs);
}

// ─────────────────────── V092-01：并发去重（锁） ───────────────────────

describe("v0.9.2 打回 V092-01：看门狗认领的跨进程互斥", () => {
  it("【锚点·跨进程】两个真进程各扫一轮 → 合起来 member-dead=1 / lead urgent=1 / watchdog-wake=1", async () => {
    await seedTeam(["b", "c", "d"]);
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    await seedLivePeer("sess_c");
    await seedLivePeer("sess_d");
    // 先跑一轮把全员记成 alive（两把扫描都看到「曾经活着」）
    await sweepMembersOnce(deps());
    expect(eventsOf("member-dead")).toHaveLength(0);

    const bPid = await pidOf("sess_b");
    await killAndForget(bPid);

    const [first, second] = await runSweepInTwoProcesses();
    const childSummaries = JSON.stringify({ first, second });
    // 恰一套告警（不论两程是否真重叠：赢家认领，输家看到 dead 什么都不发）
    expect(eventsOf("member-dead"), childSummaries).toHaveLength(1);
    expect(eventsOf("member-dead")[0]!["member"]).toBe("b");
    expect(eventsOf("watchdog-wake")).toHaveLength(1);
    expect(await readMailboxLen("a")).toBe(1);
    // 两个进程都正常跑完（无 sweep-failed），且只有一个报告了 death
    expect([first, second].filter((s) => Array.isArray(s["dead"]) && (s["dead"] as string[]).length === 1)).toHaveLength(1);
    expect([first, second].every((s) => s["skipped"] === undefined || s["skipped"] === "state-lock-busy")).toBe(true);
    // 状态台账只记一次
    const state = await readWatchdogState(root);
    expect(state.members["b|sess_b"]?.state).toBe("dead");
  }, 60_000);

  it("【锚点·同进程并发】Promise.all 四把扫描 → 恰一套告警（in-process 队列 + 文件锁）", async () => {
    await seedTeam(["b", "c", "d"]);
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    await seedLivePeer("sess_c");
    await seedLivePeer("sess_d");
    await sweepMembersOnce(deps());

    const bPid = await pidOf("sess_b");
    await killAndForget(bPid);

    const results = await Promise.all([
      sweepMembersOnce(deps()),
      sweepMembersOnce(deps()),
      sweepMembersOnce(deps()),
      sweepMembersOnce(deps()),
    ]);
    expect(eventsOf("member-dead")).toHaveLength(1);
    expect(eventsOf("watchdog-wake")).toHaveLength(1);
    expect(await readMailboxLen("a")).toBe(1);
    // 恰一个扫描报告了 death，其余要么跳过（锁忙）要么空手
    expect(results.filter((r) => r.dead.length === 1)).toHaveLength(1);
    expect(results.filter((r) => r.skipped === "state-lock-busy").length).toBeLessThanOrEqual(3);
  }, 60_000);

  it("【锚点·锁真实存在且跨进程】外部子进程持 locks/watchdog-state.lock → 本轮跳过，不告警不唤醒不抛", async () => {
    await seedTeam(["b"]);
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    await sweepMembersOnce(deps());

    const bPid = await pidOf("sess_b");
    await killAndForget(bPid);

    // 外部进程持锁 30s（远大于 WATCHDOG_LOCK_WAIT_MS=2s）——若临界段不拿这把锁，扫描会照常告警。
    // 持锁时长随下方「等锁文件到场」预算一起放到 30s/10s：子进程 spawn + 建锁在负载下会慢
    // （g16 同款竞态），持锁时长必须覆盖「等锁 + 一轮扫描的 2s 锁等待」，否则锁先释放、扫描
    // 反而不 skip 了。finally 里即杀持有者，30s 不拉长用例时长。
    const lockPath = join(root, "locks", `${WATCHDOG_STATE_LOCK_NAME}.lock`);
    mkdirSync(join(root, "locks"), { recursive: true });
    const holder = spawnLockHolder(lockPath, 30_000);
    try {
      // spawn 返回不等于子进程已建锁（core/lock.test.ts 同款竞态）——等到锁文件真的在场。
      const lockReady = await until(() => existsSync(lockPath), 10_000);
      expect(lockReady).toBe(true);
      const summary = await sweepMembersOnce(deps());
      expect(summary.skipped).toBe("state-lock-busy");
      expect(summary.dead).toEqual([]);
      expect(eventsOf("member-dead")).toHaveLength(0);
      expect(eventsOf("watchdog-wake")).toHaveLength(0);
      expect(await readMailboxLen("a")).toBe(0);
      expect(eventsOf("watchdog-sweep-failed")).toHaveLength(0); // 跳过不是失败
    } finally {
      holder.kill();
      rmSync(lockPath, { force: true });
    }

    // 锁释放后恢复认领
    const after = await sweepMembersOnce(deps());
    expect(after.skipped).toBeUndefined();
    expect(after.dead).toEqual(["b"]);
    expect(eventsOf("member-dead")).toHaveLength(1);
  }, 60_000);

  it("锁等待预算是一个短常量（不把 60s 节拍拖成分钟级）", () => {
    expect(WATCHDOG_LOCK_WAIT_MS).toBe(2_000);
    expect(WATCHDOG_LOCK_WAIT_MS).toBeLessThan(60_000);
  });
});

// ─────────────────────── V092-02：通知收件人面 ───────────────────────

describe("v0.9.2 打回 V092-02：已判 pid-dead 的成员一律不作收件人", () => {
  it("【锚点·同轮双死】lead+b 同轮 pid-dead → 只通知/唤醒活成员 c/d；已死成员邮箱零写入、零唤醒失败", async () => {
    await seedTeam(["b", "c", "d"]);
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    await seedLivePeer("sess_c");
    await seedLivePeer("sess_d");
    await sweepMembersOnce(deps());

    const aPid = await pidOf("sess_a");
    const bPid = await pidOf("sess_b");
    await killAndForget(aPid);
    await killAndForget(bPid);

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead.sort()).toEqual(["a", "b"]);
    expect(summary.leadCurrentlyDead).toBe(true);
    // 收件人只有活成员
    expect(summary.wakes.map((w) => w.to).sort()).toEqual(["c", "d"]);
    // 已死成员的邮箱一个字都不写（原缺陷：b 被告知 + 已死 lead 邮箱堆积 urgent）
    expect(await readMailboxLen("a")).toBe(0);
    expect(await readMailboxLen("b")).toBe(0);
    // 活成员各收一条
    expect(await readMailboxLen("c")).toBe(1);
    expect(await readMailboxLen("d")).toBe(1);
    // 零唤醒失败风暴（原缺陷：对死 sid attemptWake → wake-failed + wake-retry-failed）
    expect(eventsOf("wake-failed")).toHaveLength(0);
    expect(eventsOf("wake-retry-failed")).toHaveLength(0);
    expect(eventsOf("watchdog-wake")).toHaveLength(2);
  }, 60_000);

  it("【锚点·lead 往轮已死】lead 上轮已死、b 本轮死 → 不通知/不唤醒已死 lead，改投活成员", async () => {
    await seedTeam(["b", "c"]);
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    await seedLivePeer("sess_c");
    await sweepMembersOnce(deps());

    // 第 1 轮：lead 死 → 通知 b/c（原 C6-BUG-4 行为保持）
    const aPid = await pidOf("sess_a");
    await killAndForget(aPid);
    const first = await sweepMembersOnce(deps());
    expect(first.dead).toEqual(["a"]);
    expect(first.wakes.map((w) => w.to).sort()).toEqual(["b", "c"]);
    expect(await readMailboxLen("a")).toBe(0);

    // 第 2 轮：b 也死了 —— 出事成员不是 lead，但 lead 已死 ⇒ 必须改投活成员 c，
    // 不能把通知/唤醒打到已死 lead 上（原缺陷：wake-failed + wake-retry-failed + 死邮箱堆积）。
    const bPid = await pidOf("sess_b");
    await killAndForget(bPid);
    const second = await sweepMembersOnce(deps());
    expect(second.dead).toEqual(["b"]);
    expect(second.leadCurrentlyDead).toBe(true);
    expect(second.wakes.map((w) => w.to)).toEqual(["c"]);
    expect(await readMailboxLen("a")).toBe(0); // 已死 lead 的邮箱仍然零写入
    expect(eventsOf("wake-failed")).toHaveLength(0);
    expect(eventsOf("wake-retry-failed")).toHaveLength(0);
  }, 60_000);

  it("【锚点·无人可通知】lead 死且其余成员全死 → 只落审计（watchdog-notify-skipped），零唤醒零邮箱写入", async () => {
    await seedTeam(["b"]);
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    await sweepMembersOnce(deps());

    const aPid = await pidOf("sess_a");
    const bPid = await pidOf("sess_b");
    await killAndForget(aPid);
    await killAndForget(bPid);

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead.sort()).toEqual(["a", "b"]);
    expect(summary.wakes).toEqual([]);
    const skipped = eventsOf("watchdog-notify-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!["reason"]).toBe("lead-dead-no-other-live-members");
    expect(await readMailboxLen("a")).toBe(0);
    expect(await readMailboxLen("b")).toBe(0);
  }, 60_000);

  it("【回归】出事成员不是 lead ∧ lead 活着 → 仍通知 lead 本人（原口径不回归）", async () => {
    await seedTeam(["b", "c"]);
    await seedLivePeer("sess_a");
    await seedLivePeer("sess_b");
    await seedLivePeer("sess_c");
    await sweepMembersOnce(deps());

    const bPid = await pidOf("sess_b");
    await killAndForget(bPid);

    const summary = await sweepMembersOnce(deps());
    expect(summary.dead).toEqual(["b"]);
    expect(summary.leadCurrentlyDead).toBe(false);
    expect(summary.wakes.map((w) => w.to)).toEqual(["a"]);
    expect(await readMailboxLen("a")).toBe(1);
    expect(await readMailboxLen("c")).toBe(0); // 不扇出给无关活成员
  }, 60_000);
});

// ─────────────────────── 测试辅助 ───────────────────────

async function readMailboxLen(agentKey: string): Promise<number> {
  const { readMailbox } = await import("../core/mailbox.js");
  return (await readMailbox(root, "default", agentKey)).length;
}

/** 取某个 sid 当前对应的活进程 pid（从 peer 注册表反查）。 */
async function pidOf(sessionId: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(join(peerRoot, "sessions"));
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    const record = await readPeerRecord(peerRoot, Number.parseInt(entry.slice(0, -5), 10));
    if (record?.sessionId === sessionId) return record.pid;
  }
  throw new Error(`no live peer record for ${sessionId}`);
}

/** 起一个子进程持 `<lockPath>` 若干毫秒（core/lock.test.ts spawnChildHolder 同款）。 */
function spawnLockHolder(lockPath: string, holdMs: number): ReturnType<typeof spawn> {  const script = `
    const fs = require('node:fs');
    const content = JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'holder-token' });
    let fd = null;
    while (fd === null) {
      try { fd = fs.openSync(${JSON.stringify(lockPath)}, 'wx'); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    setTimeout(() => { try { fs.unlinkSync(${JSON.stringify(lockPath)}); } catch {} }, ${holdMs});
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  child.unref();
  return child;
}

/** 轮询等待谓词成立（测试辅助；core/lock.test.ts `until` 同款）。 */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}
