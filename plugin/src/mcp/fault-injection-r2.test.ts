/**
 * v0.5.2 故障注入二番战组（故障注-1~4）防回归单测——红队
 * evidence/adversarial/故障注入/cases.md（三番战版）中四个新发现的可自动化部分。
 *
 * 覆盖：
 * - 故障注-1（FI-1）：陈旧 .bak 回滚——xc_status 强制披露（staleCompletedReceipts
 *   + stateRecovery + WARNING 行），xc_claim 对「completed 回执在手却看着 pending」
 *   的任务硬拒 rollback_conflict；恢复态与回执链无矛盾时只提示验证；真源被
 *   writeTeam 重写后恢复披露清除（矛盾披露按磁盘态持续）。
 * - 故障注-2（FI-2）：锁路径被目录占用——目录占位被安全移除重建（含非空目录），
 *   变更类工具不再 15s→busy 永久饥饿；审计 lock-repaired(reason=lock-path-is-dir)。
 * - 故障注-3（FI-3）：engine.jsonl 不可写——logEngineEvent 吞错但记进程内降级
 *   台账，工具响应末尾内联 WARNING（此前零诊断）；恢复可写后告警自动消失。
 * - 故障注-4（FI-4）：held 暂存件损坏——listHeldPeerMessagesDetailed 透出
 *   corrupted 明细，xc_peer_review 摘要披露 `corrupted N 条`（此前静默跳过，
 *   审阅者看到空暂存区）。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf } from "./protocol.js";
import { createToolCore } from "./core.js";
import type { ToolCore } from "./core.js";
import type { ToolResult } from "./protocol.js";
import { writeSession } from "../core/registry.js";
import { readTeam, teamRecoveryWarning, writeTeam } from "../core/teamstate.js";
import { engineLogFile, lockFile, teamBackupFile, teamFile } from "../core/paths.js";
import { acquireFileLock } from "../core/lock.js";
import { auditDegradation, auditDegradationWarning, logEngineEvent } from "../core/log.js";
import { writePeerBaseRecord } from "../core/peerdir.js";
import { renderReviewSummary } from "./peer-services.js";
import {
  holdPeerMessage,
  listHeldPeerMessages,
  listHeldPeerMessagesDetailed,
  releaseHeldMessages,
} from "../core/peerpolicy.js";
import { stopPeerEndpoint } from "../transport/pipe.js";
import { createDefaultPeerServices } from "./peer-services.js";

let workDir: string;
let stateRoot: string;
let core: ToolCore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-fi-r2-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({ stateRoot, workspace: workDir, env: {} }); // wake 关 → mailbox
});

afterEach(async () => {
  await stopPeerEndpoint();
  await rm(workDir, { recursive: true, force: true });
});

async function hookRegister(conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

// ---------------------------------------------------------------------------
// 故障注-1：陈旧 .bak 回滚（completed 任务静默退回 pending）
// ---------------------------------------------------------------------------

describe("故障注-1 陈旧 .bak 回滚（FI-1 二番战）", () => {
  /** 红队 FI-1d 时序：t1 走完 completed（回执入 a 邮箱）→ t2 派发并被 b 认领。 */
  async function seedCompletedThenClaimed(): Promise<{ t1: string; t2: string }> {
    await hookRegister("conn-a", "a", "sess-a");
    await hookRegister("conn-b", "b", "sess-b");
    const t1 = (payloadOf(await core.xc_dispatch({ to: "b", title: "t1 compute", prompt: "p" }, "conn-a")) as { taskId: string }).taskId;
    const claim = payloadOf(await core.xc_claim({ taskId: t1 }, "conn-b")) as { attemptId: string };
    await writeFile(join(workDir, "r1.txt"), "391", "utf8");
    await core.xc_report({ taskId: t1, attemptId: claim.attemptId, status: "in_progress" }, "conn-b");
    await core.xc_report({
      taskId: t1, attemptId: claim.attemptId, status: "completed", result: "391",
      evidence: [{ path: join(workDir, "r1.txt"), note: "" }],
    }, "conn-b");
    const t2 = (payloadOf(await core.xc_dispatch({ to: "b", title: "t2 followup", prompt: "p" }, "conn-a")) as { taskId: string }).taskId;
    await core.xc_claim({ taskId: t2 }, "conn-b");
    return { t1, t2 };
  }

  /** 把 .bak 换成陈旧态（t1 pending、无 t2）再截断 team.json（红队注入形态）。 */
  async function injectStaleBackup(t1: string): Promise<void> {
    const team = (await readTeam(stateRoot, "default"))!;
    const stale = {
      ...team,
      tasks: team.tasks
        .filter((task) => task.id !== team.tasks[1]?.id)
        .map((task) => (task.id === t1
          ? { ...task, status: "pending", assignee: null, attempt: 0, attemptId: null, history: [] }
          : task)),
    };
    await writeFile(teamBackupFile(stateRoot, "default"), JSON.stringify(stale, null, 2), "utf8");
    const raw = await readFile(teamFile(stateRoot, "default"), "utf8");
    await writeFile(teamFile(stateRoot, "default"), raw.slice(0, Math.floor(raw.length * 0.55)), "utf8");
  }

  it("回滚后 xc_status 强制披露矛盾 + 恢复来源；xc_claim 硬拒 rollback_conflict", async () => {
    const { t1, t2 } = await seedCompletedThenClaimed();
    await injectStaleBackup(t1);

    // xc_status：不再零告警（红队 FI-1d 的判定面）
    const status = await core.xc_status({}, "conn-a");
    expect(status.isError).toBeUndefined();
    const snap = payloadOf(status) as {
      staleCompletedReceipts?: Record<string, string[]>;
      stateRecovery?: { rolledBackTaskIds: string[]; defect: string };
      orphanTasks?: Record<string, string[]>;
      tasks: Array<{ id: string; status: string }>;
    };
    expect(snap.staleCompletedReceipts).toBeDefined();
    expect(Object.values(snap.staleCompletedReceipts ?? {}).flat()).toContain(t1);
    expect(snap.stateRecovery).toBeDefined();
    expect(snap.stateRecovery?.rolledBackTaskIds).toContain(t1);
    // 任务板如实呈现回滚态（t1 pending、t2 消失成孤儿）——披露不改写状态
    expect(snap.tasks.find((task) => task.id === t1)?.status).toBe("pending");
    expect(snap.tasks.find((task) => task.id === t2)).toBeUndefined();
    expect(Object.values(snap.orphanTasks ?? {}).flat()).toContain(t2);
    const statusText = textOf(status);
    expect(statusText).toContain("WARNING board/receipt contradiction");
    expect(statusText).toContain("rolled back");

    // xc_claim：回滚任务不再可被静默重新认领（红队 FI-1e 的判定面）
    const claim = await core.xc_claim({ taskId: t1 }, "conn-b");
    expect(claim.isError).toBe(true);
    const err = payloadOf(claim) as { error: string; message: string };
    expect(err.error).toBe("rollback_conflict");
    expect(err.message).toContain("holds a completed receipt");

    // 审计：恢复事件带回滚明细
    const events = await engineEvents();
    const recovered = events.find((e) => e["event"] === "team-state-recovered");
    expect(recovered).toBeDefined();
    expect(recovered?.["rolledBackTaskIds"]).toContain(t1);
    expect(recovered?.["rollbackConflict"]).toBe(true);
  }, 20000);

  it("恢复态与回执链无矛盾 → 只提示验证任务板，不误报矛盾；claim 正常", async () => {
    await hookRegister("conn-a", "a", "sess-a");
    await hookRegister("conn-b", "b", "sess-b");
    const t1 = (payloadOf(await core.xc_dispatch({ to: "b", title: "t1", prompt: "p" }, "conn-a")) as { taskId: string }).taskId;
    // fresh .bak（writeTeam 刚镜像过）→ 只截断主文件 = 无回滚的普通自愈
    const raw = await readFile(teamFile(stateRoot, "default"), "utf8");
    await writeFile(teamFile(stateRoot, "default"), raw.slice(0, Math.floor(raw.length * 0.55)), "utf8");

    const status = await core.xc_status({}, "conn-a");
    expect(status.isError).toBeUndefined();
    const snap = payloadOf(status) as {
      staleCompletedReceipts?: Record<string, string[]>;
      stateRecovery?: { rolledBackTaskIds: string[] };
    };
    expect(snap.staleCompletedReceipts).toBeUndefined();
    expect(snap.stateRecovery?.rolledBackTaskIds).toEqual([]);
    expect(textOf(status)).toContain("recovered from the last-known-good backup");
    expect(textOf(status)).not.toContain("board/receipt contradiction");
    // 自愈态上认领照常（新纪元任务无回执矛盾）
    const claim = await core.xc_claim({ taskId: t1 }, "conn-b");
    expect(claim.isError).toBeUndefined();
  });

  it("真源被 writeTeam 重写后恢复披露清除；矛盾披露按磁盘态持续到回执链一致", async () => {
    const { t1 } = await seedCompletedThenClaimed();
    await injectStaleBackup(t1);
    await core.xc_status({}, "conn-a"); // 触发恢复 + 台账
    expect(teamRecoveryWarning(stateRoot, "default")).toBeDefined();

    // 任意变更工具落盘（writeTeam）→ 恢复披露清除
    await core.xc_dispatch({ to: "b", title: "t3 after", prompt: "p" }, "conn-a");
    expect(teamRecoveryWarning(stateRoot, "default")).toBeUndefined();
    const snap = payloadOf(await core.xc_status({}, "conn-a")) as { stateRecovery?: unknown; staleCompletedReceipts?: Record<string, string[]> };
    expect(snap.stateRecovery).toBeUndefined();
    // t1 仍看着 pending 而 completed 回执在 a 邮箱 → 矛盾披露与 claim 闸持续
    expect(Object.values(snap.staleCompletedReceipts ?? {}).flat()).toContain(t1);
    const claim = await core.xc_claim({ taskId: t1 }, "conn-b");
    expect((payloadOf(claim) as { error: string }).error).toBe("rollback_conflict");
  }, 20000);
});

// ---------------------------------------------------------------------------
// 故障注-2：锁路径被目录占用（永久 busy 饥饿）
// ---------------------------------------------------------------------------

describe("故障注-2 锁路径被目录占用（FI-2 二番战）", () => {
  function teamLockPath(): string {
    const digest = createHash("sha256").update(stateRoot.toLowerCase()).digest("hex").slice(0, 8);
    return lockFile(stateRoot, `team-${digest}-default`);
  }

  it("空目录占位：dispatch 自愈成功（不再 15s busy），审计 lock-repaired(lock-path-is-dir)", async () => {
    await hookRegister("conn-a", "a", "sess-a");
    await hookRegister("conn-b", "b", "sess-b");
    const lockPath = teamLockPath();
    await mkdir(lockPath, { recursive: true }); // 红队注入形态：锁路径上是目录

    const started = Date.now();
    const res = await core.xc_dispatch({ to: "b", title: "after dir repair", prompt: "p" }, "conn-a");
    expect(res.isError).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
    const events = await engineEvents();
    expect(events.find((e) => e["event"] === "lock-repaired")).toMatchObject({
      lock: `team-${createHash("sha256").update(stateRoot.toLowerCase()).digest("hex").slice(0, 8)}-default`,
      reason: "lock-path-is-dir",
    });
    // 操作完成后锁正常释放，锁位恢复为「无文件」
    expect(existsSync(lockPath)).toBe(false);
  }, 20000);

  it("非空目录占位（unit 级）：递归移除后照常夺取", async () => {
    const lockPath = lockFile(stateRoot, "nested-dir-lock");
    await mkdir(join(lockPath, "junk"), { recursive: true });
    writeFileSync(join(lockPath, "junk", "x.txt"), "junk", "utf8");
    const started = Date.now();
    const lock = await acquireFileLock(stateRoot, "nested-dir-lock", { waitMs: 5000 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(JSON.parse(await readFile(lockPath, "utf8") as string).pid).toBe(process.pid);
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  }, 20000);
});

// ---------------------------------------------------------------------------
// 故障注-3：engine.jsonl 不可写（审计静默全丢）
// ---------------------------------------------------------------------------

describe("故障注-3 审计不可写降级披露（FI-3 二番战）", () => {
  it("unit：台账计数 + 告警文案 + 恢复自动清除", async () => {
    expect(auditDegradationWarning(stateRoot)).toBeUndefined();
    const engineLog = engineLogFile(stateRoot);
    await mkdir(engineLog, { recursive: true }); // 路径被目录占用（红队 FI-9a 形态）

    await logEngineEvent(stateRoot, { event: "x" });
    await logEngineEvent(stateRoot, { event: "y" });
    expect(auditDegradation(stateRoot)?.dropped).toBe(2);
    const warning = auditDegradationWarning(stateRoot);
    expect(warning).toContain("WARNING engine audit log is not writable");
    expect(warning).toContain("2 audit event(s) dropped");
    expect(warning).toContain(engineLog);

    // 恢复可写 → 下一次写成功即清除
    await rm(engineLog, { recursive: true });
    await logEngineEvent(stateRoot, { event: "z" });
    expect(auditDegradationWarning(stateRoot)).toBeUndefined();
    expect(existsSync(engineLog)).toBe(true);
  });

  it("工具面：engine.jsonl 是目录时响应末尾内联 WARNING（此前零诊断）", async () => {
    await hookRegister("conn-a", "a", "sess-a");
    await hookRegister("conn-b", "b", "sess-b");
    // 基线：健康时响应无额外告警块
    const healthy = await core.xc_status({}, "conn-a");
    expect(healthy.content).toHaveLength(2);

    await rm(engineLogFile(stateRoot), { force: true });
    await mkdir(engineLogFile(stateRoot), { recursive: true });

    const degraded = await core.xc_status({}, "conn-a");
    expect(degraded.isError).toBeUndefined(); // 业务不受影响（fail-open 方向）
    expect(degraded.content.length).toBe(3); // 末尾多一个告警块
    const last = degraded.content[degraded.content.length - 1];
    expect(last?.type).toBe("text");
    expect(last?.text).toContain("WARNING engine audit log is not writable");

    // 恢复后告警消失
    await rm(engineLogFile(stateRoot), { recursive: true });
    const recovered = await core.xc_status({}, "conn-a");
    expect(recovered.content).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 故障注-4：held 暂存件损坏（审阅者不可见）
// ---------------------------------------------------------------------------

describe("故障注-4 held 暂存件损坏披露（FI-4 二番战）", () => {
  it("unit：detailed 扫描透出 corrupted；listHeldPeerMessages 仍 fail-closed 跳过", async () => {
    const root = await mkdtemp(join(tmpdir(), "xc-held-r2-"));
    try {
      await holdPeerMessage(root, "s1", { msgId: "m1", from: "bob", text: "hi", ts: 1 }, "repo-setting");
      const heldFile = join(root, "held", "s1", "m1.json");
      await writeFile(heldFile, "{corrupt json", "utf8");

      const detail = await listHeldPeerMessagesDetailed(root, "s1");
      expect(detail.held).toHaveLength(0);
      expect(detail.corrupted).toHaveLength(1);
      expect(detail.corrupted[0]?.file).toBe("m1.json");

      // 旧入口行为不变（fail-closed 跳过，不崩）
      expect(await listHeldPeerMessages(root, "s1")).toHaveLength(0);
      const released = await releaseHeldMessages(root, "s1", ["m1"], {
        adjudicate: () => ({ policy: "accept" }),
        deliver: () => true,
      });
      expect(released).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("工具面：损坏暂存件在 xc_peer_review 摘要披露 corrupted N 条（红队 FI-9d 判定面）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xc-held-r2-svc-"));
    try {
      const deps = {
        stateRoot: join(root, "ws", ".crosschat"),
        workspace: join(root, "ws"),
        env: {
          XC_MESSAGING_DIR: root,
          XC_MESSAGING_SOCKET_PATH: `\\\\.\\pipe\\LOCAL\\xcc-fi-r2-${Math.random().toString(16).slice(2)}`,
        } as NodeJS.ProcessEnv,
      };
      const services = createDefaultPeerServices(deps);
      // v0.5.3（a8）：peer 注册新锚定闸——先落钩子基记录。
      await writePeerBaseRecord(root, { sessionId: "sess-r2", cwd: join(root, "ws"), source: "startup", startedAt: Date.now(), lastSeen: Date.now() });
      const registered = await services.register({ name: "r2review", sessionId: "sess-r2" });
      const heldDir = join(root, "held", registered.sessionId);
      await holdPeerMessage(root, registered.sessionId, { msgId: "m-corrupt", from: "bob", text: "hi", ts: 1 }, "repo-setting");
      await writeFile(join(heldDir, "m-corrupt.json"), "not json at all", "utf8");

      const review = await services.review({ action: "list" });
      expect(review.held).toHaveLength(0);
      expect(review.corrupted).toHaveLength(1);
      const summary = renderReviewSummary(review);
      expect(summary).toContain("暂存区 0 条");
      expect(summary).toContain("1 条暂存件损坏");
    } finally {
      await stopPeerEndpoint();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renderReviewSummary：accept/discard 动作同样带损坏计数", () => {
    const corrupted = [{ file: "m-x.json", error: "bad json" }];
    const base = { held: [], affected: [], receipts: [], corrupted } as const;
    expect(renderReviewSummary({ action: "accept", ...base })).toContain("1 条暂存件损坏");
    expect(renderReviewSummary({ action: "discard", ...base })).toContain("1 条暂存件损坏");
    expect(renderReviewSummary({ action: "list", held: [], affected: [], receipts: [] })).not.toContain("损坏");
  });
});

// ---------------------------------------------------------------------------
// writeTeam 镜像纪律回归（FI-1 的根基不回退）
// ---------------------------------------------------------------------------

describe("FI-1 根基回归：writeTeam 仍镜像 .bak", () => {
  it("成功落盘后 team.json 与 .bak 逐字节一致", async () => {
    await hookRegister("conn-a", "a", "sess-a");
    await hookRegister("conn-b", "b", "sess-b");
    await core.xc_dispatch({ to: "b", title: "mirror", prompt: "p" }, "conn-a");
    const team = (await readTeam(stateRoot, "default"))!;
    await writeTeam(stateRoot, team);
    const primary = await readFile(teamFile(stateRoot, "default"), "utf8");
    const backup = await readFile(teamBackupFile(stateRoot, "default"), "utf8");
    expect(backup).toBe(primary);
  });
});
