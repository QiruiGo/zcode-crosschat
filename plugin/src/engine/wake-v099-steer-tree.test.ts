/**
 * v0.9.9（组 W，E1）定向测试：**steer 终止带进程树**（方案 53-v099 §一组 W E1）。
 *
 * 缺陷（44-v098 real-smoke E §3.2 实测）：`stopTurnForSteer` 只杀会话宿主 pid
 * （`taskkill /PID <pid>`，无 /T），旧回合已拉起的工具子进程（150s powershell，
 * pid 37640）父死后继续存活到自然结束——旧工具副作用可能继续发生。
 *
 * 本文件覆盖（每条对应方案验收项「steer 后旧宿主与其工具子进程均死亡；无残留」）：
 * 1. 【E1 锚点·真实进程树】`platformSteerKill`/`stopTurnForSteer` 走 `taskkill /T`
 *    （优雅无 /F → 被拒/超时 → `/T /F`）：真实拉起「父 node + 子 node」两层树，
 *    终止后**父子均亡、无残存**，回执披露被终止的进程树（根 + 子 pid）；
 * 2. 【E1 锚点·纯函数】`windowsProcessTree` 枚举真实进程树（根 + 子孙，根在前）；
 * 3. 【E1 锚点·编排】优雅被拒 → 强杀两次 kill 的树快照**取并集**披露；树内残存
 *    （强杀后仍存活）如实进 treeSurvivors（不假装整树死绝）；
 * 4. 【E1 锚点·回执】`steerTreeClause` 三态措辞（无树/全灭/有残存）；
 * 5. 【E1 锚点·attemptWake 接线】注入 kill 回 tree → WakeResult.steer.stopped.tree
 *    在场 + steer-stopped/steer-turn-started 审计带 treePids/treeCount/treeSurvivors；
 * 6. 【E1 边界】注入 kill 不回 tree（v0.9.8 测试形态）→ 回执无 tree 键（不虚构披露）。
 *
 * 平台说明：用例 1/2 只在 Windows 上有完整判据（taskkill /T + CIM 枚举）；POSIX 下
 * `platformSteerKill` 走「信号 + 进程组 best-effort」，树披露退化为 [pid]（如实），
 * 用例按平台分流断言，不跨平台虚构。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSession } from "../core/registry.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import type { TeamMember } from "../core/types.js";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli.js";
import {
  attemptWake,
  platformSteerKill,
  steerTreeClause,
  stopTurnForSteer,
  windowsProcessTree,
  type WakeRequest,
} from "./wake.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v099-steer-tree-"));
  dirs.push(root);
});

afterEach(() => {
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

const greenCapacity = {
  sampledAt: Date.now(),
  totalBytes: 16 * 1024 ** 3,
  freeBytes: 8 * 1024 ** 3,
  watermark: 0.5,
  steadyTreeBytes: 1 * 1024 ** 3,
  headlessTurnCount: 0,
  headlessTurnMaxRssBytes: null,
  degraded: null,
};

function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "steer",
    receiptIds: [],
    ticket: "别删生产库，先跑 dry-run",
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\glm\\zcode.cjs" },
    capacitySample: greenCapacity,
    watchWindowMs: 0,
    limboTimeoutMs: 3_600_000,
    wakeSlowMs: 3_600_000,
    fakeSuccessMs: 3_600_000,
    lifecycleWindowMs: 100,
    ...overrides,
  };
}

async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: "default", founderKey: "a", now });
  const b: TeamMember = {
    key: "b", sessionId: "sess_b", role: "worker", joinedAt: now, lastSeen: now, identity: "engine",
  };
  team.members.push({ key: "a", sessionId: "sess_a", role: "peer", joinedAt: now, lastSeen: now });
  team.members.push(b);
  await writeTeam(root, team);
}

async function seedRunningSession(pid: number): Promise<void> {
  const now = Date.now();
  await writeSession(root, {
    sessionId: "sess_b", cwd: "D:\\ws", startedAt: now - 60_000, lastSeen: now,
    boundName: "b", liveness: "running", livenessTs: now - 30_000, pid,
  });
}

function spawnOk(captured: SpawnResumeOptions[]): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    opts.onHelperSpawned?.(7777);
    captured.push(opts);
    return { pid: 7777, logFile: opts.logFile };
  };
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** 尽力清理残留进程（测试边界：不留孤儿）。 */
function forceKillTree(pid: number): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

// ---------------------------------------------------------------------------
// E1：真实进程树终止（本文件核心判据）
// ---------------------------------------------------------------------------

describe("v0.9.9 E1：steer 终止带进程树（taskkill /T）", () => {
  it("【E1 锚点·真实进程树】真实「父+子」两层树：终止后父子均亡、无残存，回执披露进程树", async () => {
    // 真实拉起：父 node 长驻（模拟唤醒子宿主），其下再拉一个 node 子进程长驻
    // （模拟宿主已发起的工具子进程——非 detached，真实 CLI 产子进程形态）。
    const childPidFile = join(root, "child-pid.txt");
    const inner = [
      "const fs=require('fs');const{spawn}=require('child_process');",
      `const c=spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'});`,
      `fs.writeFileSync(${JSON.stringify(childPidFile)},String(c.pid));`,
      "c.unref();setInterval(()=>{},1000);",
    ].join("");
    const parent = spawn(process.execPath, ["-e", inner], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    parent.unref();
    try {
      // 等子进程真正起来（父先写 pid 文件再 setInterval 保活）。
      const deadline = Date.now() + 10_000;
      while ((!existsSync(childPidFile) || readFileSync(childPidFile, "utf8").trim() === "") && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      expect(existsSync(childPidFile)).toBe(true);
      const childPid = Number(readFileSync(childPidFile, "utf8").trim());
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      expect(pidAlive(parent.pid!)).toBe(true);
      expect(pidAlive(childPid)).toBe(true);

      // 走**真实**平台终止手段（无注入）：优雅（/T 无 /F）→ 被拒/超时 → /T /F。
      const stop = await stopTurnForSteer(parent.pid!, 400, {});
      expect(stop.stopped).toBe(true);
      expect(stop.pid).toBe(parent.pid!);
      if (process.platform === "win32") {
        // 披露面：被终止的进程树 = 根 + 枚举到的工具子进程（根在前）。
        expect(stop.tree).toBeDefined();
        expect(stop.tree![0]).toBe(parent.pid!);
        expect(stop.tree).toContain(childPid);
        expect(stop.tree!.length).toBeGreaterThanOrEqual(2);
        // 验收「无残留」：树内全部消亡（含旧实现下会存活的工具子进程）。
        expect(stop.treeSurvivors).toEqual([]);
      } else {
        // POSIX：枚举不可用 → 退化为只披露根（如实，不虚构树）。
        expect(stop.tree).toEqual([parent.pid!]);
      }
      // 实物判据：父子都真的死了（轮询有界确认，不等自然退出）。
      const dead = Date.now() + 5_000;
      while ((pidAlive(parent.pid!) || pidAlive(childPid)) && Date.now() < dead) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      expect(pidAlive(parent.pid!)).toBe(false);
      expect(pidAlive(childPid)).toBe(false);
    } finally {
      forceKillTree(parent.pid!);
      try {
        const childPid = existsSync(childPidFile) ? Number(readFileSync(childPidFile, "utf8").trim()) : NaN;
        if (Number.isSafeInteger(childPid) && childPid > 0) forceKillTree(childPid);
      } catch {
        /* 尽力而为 */
      }
    }
  }, 30_000);

  it("【E1 锚点·纯函数】windowsProcessTree 枚举真实树（根在前 + 递归子孙）", async () => {
    if (process.platform !== "win32") return; // CIM 枚举仅 Windows
    const childPidFile = join(root, "child-pid-2.txt");
    const inner = [
      "const fs=require('fs');const{spawn}=require('child_process');",
      `const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});`,
      `fs.writeFileSync(${JSON.stringify(childPidFile)},String(c.pid));`,
      "c.unref();setInterval(()=>{},1000);",
    ].join("");
    const parent = spawn(process.execPath, ["-e", inner], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    parent.unref();
    try {
      const deadline = Date.now() + 10_000;
      while ((!existsSync(childPidFile) || readFileSync(childPidFile, "utf8").trim() === "") && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      const childPid = Number(readFileSync(childPidFile, "utf8").trim());
      const tree = windowsProcessTree(parent.pid!);
      expect(tree[0]).toBe(parent.pid!);
      expect(tree).toContain(childPid);
      // 幂等稳定（同一快照窗口内两次枚举一致或仅差新起子进程，根恒在首）。
      expect(windowsProcessTree(parent.pid!)[0]).toBe(parent.pid!);
      // 非法/非 Windows 入参 → 退化为 [pid]（不猜）。
      expect(windowsProcessTree(0)).toEqual([0]);
      expect(windowsProcessTree(-1)).toEqual([-1]);
    } finally {
      forceKillTree(parent.pid!);
    }
  }, 30_000);

  it("【E1 锚点·编排】优雅被拒→强杀：两次树快照取并集；树内残存如实披露", async () => {
    const kills: Array<{ pid: number; force: boolean; tree?: number[] }> = [];
    const res = await stopTurnForSteer(4242, 8_000, {
      // 优雅被拒（返回优雅态快照）→ 强杀成功（返回新快照：多一个晚拉起的子进程）。
      kill: (pid, force) => {
        const tree = force ? [pid, 9001, 9002] : [pid, 9001];
        kills.push({ pid, force, tree });
        return force ? { ok: true, tree } : { ok: false, error: "只能强行终止（带 /F 选项）", tree };
      },
      alive: (p) => p !== 4242 && p !== 9001 && p !== 9002,
      sleep: async () => {},
    });
    expect(kills.map((k) => k.force)).toEqual([false, true]); // 先优雅、被拒即强杀
    expect(res.stopped).toBe(true);
    expect(res.graceful).toBe(false);
    expect(res.tree).toEqual([4242, 9001, 9002]); // 并集（根在前）
    expect(res.treeSurvivors).toEqual([]); // 全部消亡
  });

  it("【E1 锚点·编排】强杀后树内仍存活 → treeSurvivors 如实列出（不假装整树死绝）", async () => {
    const res = await stopTurnForSteer(4242, 8_000, {
      kill: (_pid, force) => (force ? { ok: true, tree: [4242, 9001] } : { ok: false, error: "refused", tree: [4242, 9001] }),
      alive: (p) => p === 9001, // 根已亡、子进程 9001 强杀后仍存活
      sleep: async () => {},
    });
    expect(res.stopped).toBe(true);
    expect(res.tree).toEqual([4242, 9001]);
    expect(res.treeSurvivors).toEqual([9001]);
    // 措辞同步披露残存（不写「全部终止」）。
    const clause = steerTreeClause({ tree: res.tree, treeSurvivors: res.treeSurvivors });
    expect(clause).toContain("其中 1 个仍存活（9001，强杀后未亡——请人工核查）");
  });

  it("【E1 边界】注入 kill 不回 tree（v0.9.8 测试形态）→ 回执无 tree/treeSurvivors 键", async () => {
    const res = await stopTurnForSteer(4242, 8_000, {
      kill: () => ({ ok: true }),
      alive: () => false,
      sleep: async () => {},
    });
    expect(res).toEqual({ pid: 4242, graceful: true, stopped: true, waitedMs: expect.any(Number) });
    expect("tree" in res).toBe(false);
    expect("treeSurvivors" in res).toBe(false);
  });

  it("【E1 锚点·措辞】steerTreeClause 三态：无树 / 全灭 / 有残存", () => {
    expect(steerTreeClause(undefined)).toBe("");
    expect(steerTreeClause({})).toBe("");
    expect(steerTreeClause({ tree: [1] })).toBe("，进程树 1 个（1）全部终止");
    expect(steerTreeClause({ tree: [1, 2, 3] })).toBe("，进程树 3 个（1/2/3）全部终止");
    const survivors = steerTreeClause({ tree: [1, 2, 3], treeSurvivors: [2] });
    expect(survivors).toContain("进程树 3 个（1/2/3）");
    expect(survivors).toContain("其中 1 个仍存活（2，强杀后未亡——请人工核查）");
  });
});

// ---------------------------------------------------------------------------
// E1：attemptWake 接线（树披露进回执 + 审计）
// ---------------------------------------------------------------------------

describe("v0.9.9 E1：attemptWake 的进程树披露接线", () => {
  it("【E1 锚点】注入 kill 回 tree → stopped.tree 在场 + steer-stopped 审计带 treePids/treeCount", async () => {
    await seedTeam();
    await seedRunningSession(4242);
    const captured: SpawnResumeOptions[] = [];
    // 状态化存活探询：分类期回合是活的（pid 4242 alive）；优雅被拒 → 强杀后根与子俱亡。
    let rootAlive = true;
    const res = await attemptWake(baseReq({
      spawn: spawnOk(captured),
      pidAliveProbe: (p) => (p === 4242 ? rootAlive : p !== 9001),
      steer: {
        by: "a",
        kill: (_pid, force) => {
          if (force) rootAlive = false;
          const tree = [4242, 9001];
          return force
            ? { ok: true, tree }
            : { ok: false, error: "只能强行终止（带 /F 选项）", tree };
        },
        sleep: async () => {},
      },
    }));
    expect(res.steer?.result).toBe("preempted");
    expect(res.steer?.stopped?.tree).toEqual([4242, 9001]);
    expect(res.steer?.stopped?.treeSurvivors).toEqual([]);
    // 回执 reason 行内联披露（人可读面同一事实）。
    expect(String(res.steer?.reason)).toContain("进程树 2 个（4242/9001）全部终止");
    const stopped = readEngineEvents().find((e) => e["event"] === "steer-stopped");
    expect(stopped).toBeDefined();
    expect(stopped!["treePids"]).toEqual([4242, 9001]);
    expect(stopped!["treeCount"]).toBe(2);
    expect(stopped!["treeSurvivors"]).toEqual([]);
    // 抢占成功事件同样落树（与 steer-stopped 可对拍）。
    const started = readEngineEvents().find((e) => e["event"] === "steer-turn-started");
    expect(started).toBeDefined();
    expect(started!["treePids"]).toEqual([4242, 9001]);
    expect(started!["treeCount"]).toBe(2);
  });

  it("【E1 边界】注入 kill 不回 tree → 审计与回执均无树键（不虚构披露）", async () => {
    await seedTeam();
    await seedRunningSession(4242);
    const captured: SpawnResumeOptions[] = [];
    // 优雅信号被接受且进程随即退出（v0.9.8 测试形态：kill 只回 {ok}）。
    let rootAlive = true;
    const res = await attemptWake(baseReq({
      spawn: spawnOk(captured),
      pidAliveProbe: (p) => (p === 4242 ? rootAlive : false),
      steer: {
        by: "a",
        kill: (_pid, force) => {
          if (!force) rootAlive = false;
          return { ok: true };
        },
        sleep: async () => {},
      },
    }));
    expect(res.steer?.result).toBe("preempted");
    expect(res.steer?.stopped).toEqual({ pid: 4242, graceful: true, waitedMs: expect.any(Number) });
    const stopped = readEngineEvents().find((e) => e["event"] === "steer-stopped");
    expect(stopped).toBeDefined();
    expect("treePids" in stopped!).toBe(false);
    expect("treeCount" in stopped!).toBe(false);
  });
});
