/**
 * v0.9.1（G-16）双回合并发互斥定向单测（方案 §二 组B 验收锚点）。
 *
 * 背景（G-16，与 G-11 同根）：wake-resume 无头回合与桌面交互回合共享同一
 * sessionId——两个 MCP server 进程可能同时对这一个 sid 发起变更类写操作（生产形态：
 * 15:40:46/15:41:43/15:41:44 三连重复派单）。修法 = 派单/认领/回报走团队文件锁之外，
 * 再加一层同 sessionId 的 turn 互斥（core/lock.ts withSessionTurnLock，复用既有
 * acquireFileLock 原语）：被**另一个活进程**挡住时让位（busy_interactive_turn 回执），
 * 不阻塞、不自动重试。
 *
 * 覆盖（任务书验收锚点「并发 dispatch 恰一成功一让位」）：
 * 1. 并发：另一活进程持锁 → 让位（回执带 sessionId/holderPid/holderAgeMs）且零副作用；
 * 2. 不阻塞：让位在毫秒级返回（远小于 LOCK_WAIT_MS 的 15s）；
 * 3. 恰一成功一让位：同一笔派单在持锁方退出后成功；
 * 4. 同进程并行工具调用（一条消息多个 tool_use）**不**误让位；
 * 5. claim/report 同受互斥；不同 sessionId 互不干扰；
 * 6. 持锁进程已死（崩溃残留）→ 下笔写操作照常放行（不自锁）；
 * 7. 审计 turn-conflict-yield 留痕。
 *
 * 「另一个活进程」用真实 spawn 的 node 子进程充当（持自己 pid 的 turn 锁）——不是
 * 进程内假造，pid 死活判据（pidAlive）走的是真实系统调用。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore } from "./core.js";
import { writeSession } from "../core/registry.js";
import { engineLogFile, lockFile } from "../core/paths.js";
import { sessionTurnLockName } from "../core/lock.js";
import { readTeam } from "../core/teamstate.js";

let workDir: string;
let stateRoot: string;
let core: ToolCore;
/** 本文件 spawn 的替身进程（afterEach 统一回收，不留孤儿）。 */
const children: ChildProcess[] = [];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-g16-turn-mutex-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({
    stateRoot,
    workspace: workDir,
    env: { XC_MESSAGING_DIR: join(workDir, "peers-root"), XC_WAKE_ENABLED: "false" },
  });
  await hookRegister("conn-a", "a", "sess-a");
  await hookRegister("conn-b", "b", "sess-b");
  await hookRegister("conn-c", "c", "sess-c");
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill();
    } catch {
      // 已退出
    }
  }
  await rm(workDir, { recursive: true, force: true });
});

async function hookRegister(conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

/**
 * 起一个**真实活进程**持住某 sessionId 的 turn 锁（模拟并发的无头回合）。
 * @param holdMs 持锁时长；传 0 = 写完锁文件立即退出（制造「pid 已死」的残留锁）。
 */
async function foreignTurnHolder(
  sessionId: string,
  holdMs: number,
): Promise<{ pid: number; lockPath: string }> {
  const script = join(workDir, "turn-holder.cjs");
  await writeFile(
    script,
    [
      "const fs = require('fs');",
      "const lockPath = process.argv[2];",
      "const holdMs = Number(process.argv[3]);",
      "fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'foreign-headless-turn' }));",
      "if (holdMs > 0) setTimeout(() => process.exit(0), holdMs);",
    ].join("\n"),
    "utf8",
  );
  const lockPath = lockFile(stateRoot, sessionTurnLockName(sessionId));
  const child = spawn(process.execPath, [script, lockPath, String(holdMs)], { stdio: "ignore" });
  children.push(child);
  // 等锁文件落盘 = 替身进程已持锁（否则测的是「还没开始并发」）。
  for (let i = 0; i < 200 && !existsSync(lockPath); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(lockPath)) throw new Error("foreignTurnHolder: lock file never appeared");
  return { pid: child.pid!, lockPath };
}

async function taskCount(): Promise<number> {
  return (await readTeam(stateRoot, "default"))?.tasks.length ?? 0;
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("v0.9.1 G-16：同 sessionId 双回合并发互斥（派单/认领/回报）", () => {
  it("并发 dispatch：另一活进程持锁 → 让位 busy_interactive_turn，零副作用且不阻塞", async () => {
    // 先建一单打底（不同票面，隔离 G-13 查重硬闸——本文件只测 G-16）。
    const first = await core.xc_dispatch({ to: "b", title: "第一张", prompt: "p1" }, "conn-a");
    expect(payloadOf(first)["error"]).toBeUndefined();
    expect(await taskCount()).toBe(1);

    const holder = await foreignTurnHolder("sess-a", 4000);
    const started = Date.now();
    const yielded = await core.xc_dispatch({ to: "b", title: "第二张", prompt: "p2" }, "conn-a");
    const elapsed = Date.now() - started;

    expect(yielded.isError).toBe(true);
    const payload = payloadOf(yielded);
    expect(payload["error"]).toBe("busy_interactive_turn");
    expect(payload["tool"]).toBe("xc_dispatch");
    expect(payload["sessionId"]).toBe("sess-a");
    expect(payload["holderPid"]).toBe(holder.pid);
    expect(typeof payload["holderAgeMs"]).toBe("number");
    expect(String(payload["message"])).toContain("yields");
    expect(String(payload["message"])).toContain("do not retry in a tight loop");
    // 不阻塞：让位是即时判定，远小于 LOCK_WAIT_MS（15s）。
    expect(elapsed).toBeLessThan(2000);
    // 零副作用：让位那一笔没有建单、没有投递。
    expect(await taskCount()).toBe(1);
  });

  it("恰一成功一让位：持锁方退出后，同一笔派单成功", async () => {
    await core.xc_dispatch({ to: "b", title: "第一张", prompt: "p1" }, "conn-a");
    const holder = await foreignTurnHolder("sess-a", 4000);

    const yielded = await core.xc_dispatch({ to: "b", title: "第二张", prompt: "p2" }, "conn-a");
    expect(payloadOf(yielded)["error"]).toBe("busy_interactive_turn");
    expect(await taskCount()).toBe(1);

    // 替身进程退出（锁文件成无主残留）→ 同一笔派单这次成功。
    await rm(holder.lockPath, { force: true });
    const ok = await core.xc_dispatch({ to: "b", title: "第二张", prompt: "p2" }, "conn-a");
    expect(payloadOf(ok)["error"]).toBeUndefined();
    expect(payloadOf(ok)["delivered"]).toBe("mailbox");
    expect(await taskCount()).toBe(2);
  });

  it("同进程并行工具调用不误让位：两个并发 dispatch 都成功（一条消息多个 tool_use 是合法形态）", async () => {
    const results = await Promise.all([
      core.xc_dispatch({ to: "b", title: "并行甲", prompt: "p" }, "conn-a"),
      core.xc_dispatch({ to: "c", title: "并行乙", prompt: "p" }, "conn-a"),
    ]);
    for (const result of results) {
      expect(payloadOf(result)["error"]).toBeUndefined();
    }
    expect(await taskCount()).toBe(2);
    // 没有让位审计（同进程竞争走了「排队等」分支，不是冲突）。
    expect((await engineEvents()).filter((event) => event["event"] === "turn-conflict-yield")).toHaveLength(0);
  });

  it("claim / report 同受互斥（写操作三类一体）", async () => {
    const taskId = payloadOf(await core.xc_dispatch({ to: "b", title: "待认领", prompt: "p" }, "conn-a"))["taskId"] as string;
    await core.xc_check_inbox({}, "conn-b");
    const holder = await foreignTurnHolder("sess-b", 4000);

    const claim = await core.xc_claim({ taskId }, "conn-b");
    expect(payloadOf(claim)["error"]).toBe("busy_interactive_turn");
    expect(payloadOf(claim)["tool"]).toBe("xc_claim");

    // claim 让位后任务仍 pending → report 同样让位（attemptId 是占位串，走不到业务校验）。
    const report = await core.xc_report({ taskId, attemptId: "n/a", status: "in_progress" }, "conn-b");
    expect(payloadOf(report)["error"]).toBe("busy_interactive_turn");
    expect(payloadOf(report)["tool"]).toBe("xc_report");

    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.tasks.find((t) => t.id === taskId)!.status).toBe("pending"); // 零副作用
  });

  it("不同 sessionId 互不干扰：a 的回合被挡，b 的派单照常成功", async () => {
    await foreignTurnHolder("sess-a", 4000);
    const ok = await core.xc_dispatch({ to: "c", title: "b 派给 c", prompt: "p" }, "conn-b");
    expect(payloadOf(ok)["error"]).toBeUndefined();
    expect(await taskCount()).toBe(1);
  });

  it("持锁进程已死（崩溃残留）→ 下笔写操作照常放行，不把残留锁当永久互斥", async () => {
    await foreignTurnHolder("sess-a", 0); // 写完锁文件立即退出：pid 死、文件残留
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等子进程退出
    const ok = await core.xc_dispatch({ to: "b", title: "崩溃后恢复", prompt: "p" }, "conn-a");
    expect(payloadOf(ok)["error"]).toBeUndefined();
    expect(await taskCount()).toBe(1);
  });

  it("审计：每次让位落一行 turn-conflict-yield（tool/sessionId/holderPid/holderAgeMs）", async () => {
    const holder = await foreignTurnHolder("sess-a", 4000);
    await core.xc_dispatch({ to: "b", title: "被让位的派单", prompt: "p" }, "conn-a");
    await rm(holder.lockPath, { force: true });
    await core.xc_dispatch({ to: "b", title: "放行后的派单", prompt: "p2" }, "conn-a");

    const yields = (await engineEvents()).filter((event) => event["event"] === "turn-conflict-yield");
    expect(yields).toHaveLength(1);
    expect(yields[0]).toMatchObject({ agentKey: "a", sessionId: "sess-a", tool: "xc_dispatch", holderPid: holder.pid });
    expect(typeof yields[0]!["holderAgeMs"]).toBe("number");
  });
});
