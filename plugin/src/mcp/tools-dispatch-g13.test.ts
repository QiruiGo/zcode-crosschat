/**
 * v0.9.1（G-13）派单查重硬闸定向单测（方案 §二 组B 验收锚点）。
 *
 * 事故形态（G-13）：内存危机高压期，主控 58 秒内向同一成员连派 3 张重复票
 * （t85/t86/t87，15:40:46/15:41:43/15:41:44）。prompt/memory 纪律不在决策强制位
 * → 修法落工具层：xc_dispatch 对「同 assignee + 同票（标题+内容+验收标准指纹）+
 * 活任务（pending/claimed/in_progress）」硬闸，force:true 才放行并审计。
 *
 * 本文件覆盖：
 * 1. 58 秒三连派单复现——信封被消费后第二、三张被拒 duplicate_active_task（payload
 *    带既有 taskId），且**不建新单**；
 * 2. force:true 放行 + dispatch-force-duplicate 审计留痕；
 * 3. 与既有「未读信封幂等」两层并存（信封未读时仍走 delivered:"duplicate"，不报错）；
 * 4. 活任务域口径（blocked/completed 不挡、终态不挡、不同受领人不挡、不同票不挡）；
 * 5. 正常派单零回归（常规派单/认领/回报链路不受影响）。
 *
 * 驱动方式：createToolCore 对临时 stateRoot 走磁盘真源（与 claim-assignee.test.ts
 * 同模式）；XC_MESSAGING_DIR 钉临时目录，XC_WAKE_ENABLED=false 不 spawn。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore } from "./core.js";
import { writeSession } from "../core/registry.js";
import { engineLogFile } from "../core/paths.js";
import { readTeam } from "../core/teamstate.js";

let workDir: string;
let stateRoot: string;
let core: ToolCore;

/** 固定票面（三连派单复用同一张票——指纹必须逐字节相同才会被拦）。 */
const TICKET = {
  title: "修复 BD865 派单重踢",
  prompt: "重跑该单的构建并回报结果",
  acceptance: "构建通过且回执带证据",
} as const;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-g13-dispatch-"));
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
  await rm(workDir, { recursive: true, force: true });
});

/** 注册辅助：先落 SessionStart 钩子锚点，再走 hook 路径注册。 */
async function hookRegister(conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

/** 派单并断言成功，返回 taskId。 */
async function dispatchOk(args: Record<string, unknown>, conn = "conn-a"): Promise<string> {
  const res = await core.xc_dispatch(args as never, conn);
  const payload = payloadOf(res);
  expect(payload["error"], JSON.stringify(payload)).toBeUndefined();
  expect(res.isError).toBeFalsy();
  return payload["taskId"] as string;
}

/** 读 engine.jsonl 全量事件（审计留痕断言用；文件不存在 → 空）。 */
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

/** 任务板上的任务条数（断言「被拒时不建新单」）。 */
async function taskCount(): Promise<number> {
  return (await readTeam(stateRoot, "default"))?.tasks.length ?? 0;
}

describe("v0.9.1 G-13：派单查重硬闸（同 assignee 同票活任务）", () => {
  it("58 秒三连派单复现：信封被消费后，第二、三张同票派单被拒 duplicate_active_task", async () => {
    // 第一张：正常建单（事故里的 t85）。
    const first = await dispatchOk({ to: "b", ...TICKET });
    expect(await taskCount()).toBe(1);

    // 成员把派发信封读掉（消费）——此后「未读信封幂等」这一层不再兜底，
    // 重复派单只能由任务板查重硬闸拦（这正是生产里三连票能建成三单的原因）。
    const inbox = await core.xc_check_inbox({}, "conn-b");
    expect(payloadOf(inbox)["unreadCount"]).toBe(0);

    // 第二张（t86）：拒绝 + payload 指向既有那一单，且不建新单。
    const second = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(second.isError).toBe(true);
    const secondPayload = payloadOf(second);
    expect(secondPayload["error"]).toBe("duplicate_active_task");
    expect(secondPayload["taskId"]).toBe(first);
    expect(secondPayload["status"]).toBe("pending");
    expect(secondPayload["assignee"]).toBe("b");
    expect(typeof secondPayload["ticketFingerprint"]).toBe("string");
    expect(String(secondPayload["message"])).toContain("force:true");
    expect(await taskCount()).toBe(1);

    // 第三张（t87，1 秒后）：同样被拒，任务板仍只有一单。
    const third = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(third.isError).toBe(true);
    expect(payloadOf(third)["error"]).toBe("duplicate_active_task");
    expect(payloadOf(third)["taskId"]).toBe(first);
    expect(await taskCount()).toBe(1);

    // 审计：两次拒绝各留一行 dispatch-refused{reason:"duplicate_active_task"}。
    const refusals = (await engineEvents()).filter(
      (event) => event["event"] === "dispatch-refused" && event["reason"] === "duplicate_active_task",
    );
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatchObject({ to: "b", taskId: first });
  });

  it("活任务域含 claimed/in_progress：认领后、进行中再派同票同样被拒", async () => {
    const first = await dispatchOk({ to: "b", ...TICKET });
    await core.xc_check_inbox({}, "conn-b");
    const claimed = await core.xc_claim({ taskId: first }, "conn-b");
    expect(claimed.isError).toBeFalsy();
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    await core.xc_report({ taskId: first, attemptId, status: "in_progress" }, "conn-b");

    const again = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(payloadOf(again)["error"]).toBe("duplicate_active_task");
    expect(payloadOf(again)["status"]).toBe("in_progress");
    expect(await taskCount()).toBe(1);
  });

  it("force:true 放行并审计 dispatch-force-duplicate（含既有 taskId）", async () => {
    const first = await dispatchOk({ to: "b", ...TICKET });
    await core.xc_check_inbox({}, "conn-b");

    const forced = await dispatchOk({ to: "b", ...TICKET, force: true });
    expect(forced).not.toBe(first);
    expect(await taskCount()).toBe(2);
    await core.xc_check_inbox({}, "conn-b"); // 消费掉 force 建单写下的信封，让判据只可能是任务板

    const forcedEvents = (await engineEvents()).filter((event) => event["event"] === "dispatch-force-duplicate");
    expect(forcedEvents).toHaveLength(1);
    expect(forcedEvents[0]).toMatchObject({ from: "a", to: "b", existingTaskId: first, existingStatus: "pending" });

    // force 之后板上两单同票并存（显式越权的后果），第三张不带 force 仍被拦。
    const third = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(payloadOf(third)["error"]).toBe("duplicate_active_task");
    expect(await taskCount()).toBe(2);
  });

  it("与「未读信封幂等」两层并存：信封未读时仍走 duplicate（不建新单、不报错）", async () => {
    const first = await dispatchOk({ to: "b", ...TICKET });
    // 不读 inbox：信封仍未读 → 既有幂等层命中（delivered:"duplicate"），
    // 与查重硬闸是不同的层——此处证明两层可以并存且旧契约不回归。
    const dup = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(dup.isError).toBeFalsy();
    const payload = payloadOf(dup);
    expect(payload["delivered"]).toBe("duplicate");
    expect(payload["taskId"]).toBe(first);
    expect(await taskCount()).toBe(1);
  });

  it("force 不越过信封幂等层：信封未读时带 force 也只回 duplicate（不建第二单）", async () => {
    await dispatchOk({ to: "b", ...TICKET });
    const dup = await core.xc_dispatch({ to: "b", ...TICKET, force: true }, "conn-a");
    expect(payloadOf(dup)["delivered"]).toBe("duplicate");
    expect(await taskCount()).toBe(1);
  });

  it("不同票不被拦：标题/内容/验收标准任一不同即放行", async () => {
    const first = await dispatchOk({ to: "b", ...TICKET });
    await core.xc_check_inbox({}, "conn-b");
    const otherTitle = await dispatchOk({ to: "b", ...TICKET, title: "修复 BD865 派单重踢（第二版）" });
    expect(otherTitle).not.toBe(first);
    const otherPrompt = await dispatchOk({ to: "b", ...TICKET, prompt: "重跑该单的构建并回报结果（补充：带日志）" });
    expect(otherPrompt).not.toBe(first);
    const otherAcceptance = await dispatchOk({ to: "b", ...TICKET, acceptance: "构建通过且回执带证据与日志" });
    expect(otherAcceptance).not.toBe(first);
    expect(await taskCount()).toBe(4);
    await core.xc_check_inbox({}, "conn-b");

    // acceptance 省略与显式空串视为同一张票（指纹归一）：先派显式空验收，再派省略
    // 验收 → 后者被拦（否则「同一个意思两种写法」会成为查重漏洞）。
    await dispatchOk({ to: "b", title: "归一化探针", prompt: "p", acceptance: "" });
    await core.xc_check_inbox({}, "conn-b");
    const omitted = await core.xc_dispatch({ to: "b", title: "归一化探针", prompt: "p" }, "conn-a");
    expect(payloadOf(omitted)["error"]).toBe("duplicate_active_task");
    expect(await taskCount()).toBe(5);
  });

  it("活任务域口径：blocked 不挡（合法暂停的恢复手段）", async () => {
    const first = await dispatchOk({ to: "b", ...TICKET });
    await core.xc_check_inbox({}, "conn-b");
    const claimed = await core.xc_claim({ taskId: first }, "conn-b");
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    const blocked = await core.xc_report(
      { taskId: first, attemptId, status: "blocked", error: "等外部裁决" },
      "conn-b",
    );
    expect(blocked.isError).toBeFalsy();

    // blocked 是合法暂停（有属主、attempt 保留、unblock 可续）：同票再派是恢复手段，
    // 不在 ACTIVE_DUPLICATE_TASK_STATUSES 域内 → 放行。
    const afterBlocked = await dispatchOk({ to: "b", ...TICKET });
    expect(afterBlocked).not.toBe(first);
    expect(await taskCount()).toBe(2);
  });

  it("活任务域口径：completed 不挡（终态不挡新派）", async () => {
    const first = await dispatchOk({ to: "b", ...TICKET });
    await core.xc_check_inbox({}, "conn-b");
    const claimed = await core.xc_claim({ taskId: first }, "conn-b");
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    await core.xc_report({ taskId: first, attemptId, status: "in_progress" }, "conn-b");
    await writeFile(join(workDir, "evidence.txt"), "done", "utf8");
    const done = await core.xc_report(
      {
        taskId: first,
        attemptId,
        status: "completed",
        result: "ok",
        evidence: [{ path: join(workDir, "evidence.txt") }],
      },
      "conn-b",
    );
    expect(done.isError).toBeFalsy();
    await core.xc_check_inbox({}, "conn-b"); // 消费掉派发信封，让判据只可能是任务板

    const afterCompleted = await dispatchOk({ to: "b", ...TICKET });
    expect(afterCompleted).not.toBe(first);
    expect(await taskCount()).toBe(2);
  });

  it("不同受领人不拦：同票派给 c 照常建单", async () => {
    const toB = await dispatchOk({ to: "b", ...TICKET });
    await core.xc_check_inbox({}, "conn-b");
    const toC = await dispatchOk({ to: "c", ...TICKET });
    expect(toC).not.toBe(toB);
    expect(await taskCount()).toBe(2);
  });

  it("正常派单零回归：常规派单→认领→回报链路与回执面不受硬闸影响", async () => {
    const taskId = await dispatchOk({ to: "b", ...TICKET, acceptance: "done" });
    const team = (await readTeam(stateRoot, "default"))!;
    const task = team.tasks.find((t) => t.id === taskId)!;
    expect(task.to).toBe("b");
    expect(task.status).toBe("pending");

    await core.xc_check_inbox({}, "conn-b");
    const claimed = await core.xc_claim({ taskId }, "conn-b");
    const attemptId = payloadOf(claimed)["attemptId"] as string;
    await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-b");
    await writeFile(join(workDir, "result.txt"), "391", "utf8");
    const reported = await core.xc_report(
      { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: join(workDir, "result.txt") }] },
      "conn-b",
    );
    expect(reported.isError).toBeFalsy();
    expect(payloadOf(reported)["status"]).toBe("completed");

    // 派发方收到 completed 回执（G-14 的「未接力」判据来源，此处只验证不回回归）。
    const receipts = (await readTeam(stateRoot, "default"))!.tasks.find((t) => t.id === taskId)!;
    expect(receipts.status).toBe("completed");
  });
});
