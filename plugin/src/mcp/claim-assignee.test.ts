/**
 * 红队四番战 安全对-3（P1）修复回归单测：xc_claim 受让人硬闸。
 *
 * 漏洞（裁决 sec345.mjs 复现）：leada dispatch 给 bob → eve（非受让人）xc_claim
 * 成功拿到 attemptId、team.json assignee 变 eve；正主 bob 再认领得
 * task_not_pending 被锁死——与 xc_report 的 not_assignee 硬闸自相矛盾。
 *
 * 修复：xc_dispatch 把受领人落盘为 task.to（v0.6.1 新增可选字段）；xc_claim 对
 * fresh pending 且已指派的任务校验「只有受领人本人可认领」（not_assignee，与
 * report 同口径）；引擎特权重置（清扫/停止/接管，graph.revokeAttempt）清除 to——
 * 回池即共享待领池（红队旧案「他人领不走」解除不回退）；旧记录（无 to）认领面
 * 保持兼容开放（§11.1 宽容增量纪律）。
 *
 * 驱动方式：createToolCore 对临时 stateRoot 走磁盘真源（与 tools.test.ts 同模式），
 * 三个成员 a/b/c 各占一个连接键；XC_MESSAGING_DIR 指临时目录（不写宿主 peers 根）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore } from "./core.js";
import { writeSession } from "../core/registry.js";
import { revokeAttempt } from "../core/graph.js";
import { makeTask, readTeam, writeTeam } from "../core/teamstate.js";

let workDir: string;
let stateRoot: string;
let core: ToolCore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-claim-assignee-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({
    stateRoot,
    workspace: workDir,
    // XC_MESSAGING_DIR 钉临时目录：注册路径的 peer 基记录盖章不得写宿主 peers 根。
    env: { XC_MESSAGING_DIR: join(workDir, "peers-root"), XC_WAKE_ENABLED: "false" },
  });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 注册辅助：先落 SessionStart 钩子锚点，再走 hook 路径注册（tools.test.ts 同款）。 */
async function hookRegister(conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

/** 派发并返回 taskId（a 派给 b）。 */
async function dispatchAToB(title: string): Promise<string> {
  const res = await core.xc_dispatch({ to: "b", title, prompt: "do work", acceptance: "done" }, "conn-a");
  const payload = payloadOf(res);
  expect(payload["error"], JSON.stringify(payload)).toBeUndefined();
  return payload["taskId"] as string;
}

describe("红队四番战 安全对-3（P1）：xc_claim 受让人硬闸", () => {
  beforeEach(async () => {
    await hookRegister("conn-a", "a", "sess-a");
    await hookRegister("conn-b", "b", "sess-b");
    await hookRegister("conn-c", "c", "sess-c");
  });

  it("dispatch 把受领人落盘（task.to），非受让人 claim → not_assignee 硬拒且不改状态", async () => {
    const taskId = await dispatchAToB("job-one");

    // 落盘面：受领人在场（红队复现里 team.json 只有 assignee，无受领人信息）。
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    expect(task.to).toBe("b");
    expect(task.assignee).toBeNull();
    expect(task.status).toBe("pending");

    // 非受让人 c 抢认：硬拒，错误码与 xc_report 的 not_assignee 同口径。
    const stolen = await core.xc_claim({ taskId }, "conn-c");
    expect(stolen.isError).toBe(true);
    const stolenPayload = payloadOf(stolen);
    expect(stolenPayload["error"]).toBe("not_assignee");
    expect(stolenPayload["taskId"]).toBe(taskId);
    expect(stolenPayload["assignee"]).toBe("b");
    expect(String(stolenPayload["message"])).toContain('assigned to "b"');

    // 状态未被改写：仍 pending、无 assignee、无 attemptId（抢认零副作用）。
    const after = (await readTeam(stateRoot, "default"))!;
    const afterTask = after.tasks.find((t) => t.id === taskId)!;
    expect(afterTask.status).toBe("pending");
    expect(afterTask.assignee).toBeNull();
    expect(afterTask.attemptId).toBeNull();
    expect(afterTask.attempt).toBe(0);
  });

  it("正主认领成功；其后第三人再认领得 task_not_pending（不是 not_assignee）", async () => {
    const taskId = await dispatchAToB("job-one");
    const claimed = await core.xc_claim({ taskId }, "conn-b");
    expect(claimed.isError).toBeFalsy();
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    expect(typeof attemptId).toBe("string");

    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.tasks.find((t) => t.id === taskId)!.assignee).toBe("b");

    // 已被正主领走：状态闸先于受让人闸（task_not_pending），语义不变。
    const late = await core.xc_claim({ taskId }, "conn-c");
    expect(late.isError).toBe(true);
    expect(payloadOf(late)["error"]).toBe("task_not_pending");
  });

  it("report 侧对照不变：非受让人持正主 attemptId → not_assignee（红队 control 面）", async () => {
    const taskId = await dispatchAToB("job-one");
    const claimed = await core.xc_claim({ taskId }, "conn-b");
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    const report = await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-c");
    expect(report.isError).toBe(true);
    expect(payloadOf(report)["error"]).toBe("not_assignee");
  });

  it("引擎回池（清扫/停止/接管语义）后进共享待领池：他人可认领、to 已清除（旧案不回退）", async () => {
    const taskId = await dispatchAToB("job-one");
    expect((await core.xc_claim({ taskId }, "conn-b")).isError).toBeFalsy();

    // 引擎特权重置回池（graph.revokeAttempt：清扫/停止/接管共用；to 一并清除）。
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    expect(revokeAttempt(task, { by: "engine", event: "revoked-stale", now: Date.now() })).toBe(true);
    await writeTeam(stateRoot, team);

    // 回池面：受领人预留已清、状态回 pending、无 assignee。
    const pooled = (await readTeam(stateRoot, "default"))!.tasks.find((t) => t.id === taskId)!;
    expect(pooled.to).toBeUndefined();
    expect(pooled.status).toBe("pending");
    expect(pooled.assignee).toBeNull();

    // 红队旧案「他人领不走」解除不回退：第三人 c 可认领（attempt 换代）。
    const reclaim = await core.xc_claim({ taskId }, "conn-c");
    expect(reclaim.isError).toBeFalsy();
    const payload = payloadOf(reclaim);
    expect(payload["attempt"]).toBe(3);
    expect(typeof payload["attemptId"]).toBe("string");
    const after = (await readTeam(stateRoot, "default"))!;
    expect(after.tasks.find((t) => t.id === taskId)!.assignee).toBe("c");
  });

  it("旧记录无 to 字段（v0.6.1 前落盘/手写 team.json）→ 认领面兼容开放", async () => {
    // 直接造一枚无 to 的 pending 任务（legacy 形状）。
    const team = (await readTeam(stateRoot, "default"))!;
    const legacy = makeTask(team, { title: "legacy", prompt: "p", createdBy: "a" }, Date.now());
    await writeTeam(stateRoot, team);
    expect(legacy.to).toBeUndefined();

    const claimed = await core.xc_claim({ taskId: legacy.id }, "conn-c");
    expect(claimed.isError).toBeFalsy();
    const after = (await readTeam(stateRoot, "default"))!;
    expect(after.tasks.find((t) => t.id === legacy.id)!.assignee).toBe("c");
  });

  it("to 宽容读取：非法值（非字符串）丢弃而非整文件拒绝，读回后按无受领人处理", async () => {
    const team = (await readTeam(stateRoot, "default"))!;
    const task = makeTask(team, { title: "weird-to", prompt: "p", createdBy: "a" }, Date.now());
    await writeTeam(stateRoot, team);
    // 手工把 to 写成非法值（模拟外部编辑/旧写入器）。
    const raw = JSON.parse(JSON.stringify(team)) as Record<string, unknown>;
    const tasks = raw["tasks"] as Array<Record<string, unknown>>;
    tasks.find((t) => t["id"] === task.id)!["to"] = 123;
    await writeTeam(stateRoot, raw as unknown as typeof team);

    const reread = (await readTeam(stateRoot, "default"))!;
    expect(reread.tasks.find((t) => t.id === task.id)!.to).toBeUndefined();
    // 非法 to 被丢弃 → 认领面兼容开放（不因单字段非法把全队锁死）。
    const claimed = await core.xc_claim({ taskId: task.id }, "conn-c");
    expect(claimed.isError).toBeFalsy();
  });
});
