/**
 * M3 tools 单测：7 工具 schema 校验 + 未注册连接拒绝 + 闭环主流程
 * （DESIGN §7 M3 产出判据）。
 *
 * 依赖：需 M1（core）与 M2（engine）真实模块在场才能运行——本测试直接对临时
 * stateRoot 走磁盘真源；XC_WAKE_ENABLED 不设 → M2 判定 delivered=mailbox（不 spawn）。
 * M1/M2 未落盘时本文件跳过（describe.skipIf 由文件存在性开关控制不便，直接让
 * import 失败前先由构建/集成方确认依赖在场；用 tryImport 不可行于静态 TS，
 * 故以 VITEST 环境变量 XC_SKIP_TOOLS_TESTS=1 支持显式跳过）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { payloadOf } from "./protocol.js";
import { createToolCore, DispatchShape, RegisterShape, ReportShape } from "./tools.js";
import { writeSession } from "../core/registry.js";
import type { ToolCore } from "./tools.js";
import type { ToolResult } from "./protocol.js";

const SKIP = process.env.XC_SKIP_TOOLS_TESTS === "1";
const d = SKIP ? describe.skip : describe;

let workDir: string;
let stateRoot: string;
let core: ToolCore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-m3-test-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({ stateRoot, workspace: workDir, env: {} }); // 无 XC_WAKE_ENABLED → mailbox
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 注册辅助：先模拟 SessionStart 钩子落盘 sessions/<sid>.json，再走 hook 路径。 */
async function hookRegister(conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

describe("tools: zod schema 校验（7 工具）", () => {
  it("合法入参全部通过", () => {
    expect(z.object(RegisterShape).safeParse({ name: "a", sessionId: "s" }).success).toBe(true);
    expect(z.object(DispatchShape).safeParse({ to: "b", title: "T", prompt: "P" }).success).toBe(true);
    expect(
      z.object(ReportShape).safeParse({ taskId: "t1", attemptId: "x", status: "in_progress" }).success,
    ).toBe(true);
    expect(
      z.object(ReportShape).safeParse({
        taskId: "t1",
        attemptId: "x",
        status: "completed",
        result: "391",
        evidence: [{ path: "C:\\e.txt" }],
      }).success,
    ).toBe(true);
  });

  it("缺必填/错枚举/空串一律拒绝", () => {
    expect(z.object(DispatchShape).safeParse({ title: "T", prompt: "P" }).success).toBe(false); // 缺 to
    expect(z.object(DispatchShape).safeParse({ to: "", title: "T", prompt: "P" }).success).toBe(false);
    expect(z.object(ReportShape).safeParse({ taskId: "t1", attemptId: "x", status: "done" }).success).toBe(false);
    expect(z.object(ReportShape).safeParse({ taskId: "t1", attemptId: "x", status: "completed", evidence: [{ path: "" }] }).success).toBe(false);
  });
});

describe("tools: 未注册连接拒绝（§2.8）", () => {
  it("身份类工具返回 {error:'not_registered'}；xc_status 豁免", async () => {
    for (const call of [
      () => core.xc_dispatch({ to: "b", title: "T", prompt: "P" }, "ghost"),
      () => core.xc_check_inbox({}, "ghost"),
      () => core.xc_claim({ taskId: "t1" }, "ghost"),
      () => core.xc_report({ taskId: "t1", attemptId: "x", status: "failed" }, "ghost"),
      () => core.xc_message({ to: "b", content: "hi" }, "ghost"),
    ]) {
      const res = await call();
      expect(res.isError).toBe(true);
      expect(payloadOf(res).error).toBe("not_registered");
    }
    const status = await core.xc_status({}, "ghost");
    expect(status.isError).toBeUndefined(); // 只读观测豁免
  });
});

describe("tools: 闭环主流程（register→dispatch→claim→report→inbox）", () => {
  it("全链路落盘并回传", async () => {
    const ra = await hookRegister("conn-a", "a", "sess-a");
    expect(ra.isError).toBeUndefined();
    const rb = await hookRegister("conn-b", "b", "sess-b");
    const roster = payloadOf(rb) as { roster: Array<{ key: string }>; protocolDigest: string };
    expect(roster.roster.map((m) => m.key).sort()).toEqual(["a", "b"]);
    expect(roster.protocolDigest).toMatch(/^[0-9a-f]{12}$/);

    const rd = await core.xc_dispatch(
      { to: "b", title: "计算 17*23", prompt: "把结果只写数字到 result-a2b.txt", acceptance: "文件内容为 391" },
      "conn-a",
    );
    const dispatch = payloadOf(rd) as { taskId: string; delivered: string; status: string };
    expect(dispatch).toMatchObject({ taskId: "t1", status: "pending", delivered: "mailbox" }); // wake 关闭的预期值

    const dup = payloadOf(await core.xc_dispatch(
      { to: "b", title: "计算 17*23", prompt: "把结果只写数字到 result-a2b.txt", acceptance: "文件内容为 391" },
      "conn-a",
    )) as { delivered: string; taskId: string };
    expect(dup.delivered).toBe("duplicate");
    expect(dup.taskId).toBe("t1");

    const inbox = payloadOf(await core.xc_check_inbox({}, "conn-b")) as { messages: Array<{ taskId?: string }>; unreadCount: number };
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.taskId).toBe("t1");
    expect(inbox.unreadCount).toBe(0);

    const claim = payloadOf(await core.xc_claim({ taskId: "t1" }, "conn-b")) as { attemptId: string };
    expect(claim.attemptId).toMatch(/\S/);

    // 派发方重复认领同一 pending 任务 → task_not_pending
    const second = await core.xc_claim({ taskId: "t1" }, "conn-b");
    expect(payloadOf(second).error).toBe("task_not_pending");

    // stale attempt 硬拒
    const stale = await core.xc_report(
      { taskId: "t1", attemptId: "wrong", status: "completed", result: "391", evidence: [{ path: join(workDir, "result-a2b.txt") }] },
      "conn-b",
    );
    expect(payloadOf(stale).error).toBe("stale_attempt");

    // completed 缺证据硬拒
    const noEv = await core.xc_report(
      { taskId: "t1", attemptId: claim.attemptId, status: "completed", result: "391" },
      "conn-b",
    );
    expect(payloadOf(noEv).error).toBe("incomplete_completion");

    // 进度更新：claimed→in_progress 合法
    const prog = await core.xc_report({ taskId: "t1", attemptId: claim.attemptId, status: "in_progress" }, "conn-b");
    expect(prog.isError).toBeUndefined();

    // 完成 + 证据（工具现算 sha256）
    await writeFile(join(workDir, "result-a2b.txt"), "391", "utf8");
    const rep = payloadOf(await core.xc_report(
      {
        taskId: "t1",
        attemptId: claim.attemptId,
        status: "completed",
        result: "391",
        evidence: [{ path: join(workDir, "result-a2b.txt"), note: "结果文件" }],
      },
      "conn-b",
    )) as { status: string; wakeBack: string };
    expect(rep.status).toBe("completed");
    expect(rep.wakeBack).toBe("mailbox");

    // 派发方收回执
    const aInbox = payloadOf(await core.xc_check_inbox({}, "conn-a")) as {
      messages: Array<{ sourceTaskId?: string; content: string }>;
    };
    expect(aInbox.messages).toHaveLength(1);
    expect(aInbox.messages[0]?.sourceTaskId).toBe("t1");
    const receipt = JSON.parse(aInbox.messages[0]?.content ?? "{}") as { evidence: Array<{ sha256: string | null }> };
    expect(receipt.evidence[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    // xc_status 快照落盘
    const st = await core.xc_status({}, "conn-a");
    expect(st.isError).toBeUndefined();
    const snap = JSON.parse(await readFile(join(stateRoot, "teams", "default", "snapshot.json"), "utf8")) as {
      tasks: Array<{ id: string; status: string; evidenceCount: number }>;
    };
    expect(snap.tasks[0]).toMatchObject({ id: "t1", status: "completed", evidenceCount: 1 });
  });

  it("依赖未满足/自派发/非成员/双线认领均被硬拒", async () => {
    await hookRegister("conn-a", "a", "sess-a");
    await hookRegister("conn-b", "b", "sess-b");

    const self = await core.xc_dispatch({ to: "a", title: "T", prompt: "P" }, "conn-a");
    expect(payloadOf(self).error).toBe("invalid_params");

    const unknownTo = await core.xc_dispatch({ to: "nobody", title: "T", prompt: "P" }, "conn-a");
    expect(payloadOf(unknownTo).error).toBe("not_a_member");

    // 未知依赖在派发时即拒绝（不建任务）
    const badDep = await core.xc_dispatch({ to: "b", title: "T3", prompt: "P3", dependsOn: ["t9"] }, "conn-a");
    expect(payloadOf(badDep).error).toBe("invalid_params");

    // 两个无依赖任务
    await core.xc_dispatch({ to: "b", title: "T1", prompt: "P1" }, "conn-a");
    await core.xc_dispatch({ to: "b", title: "T2", prompt: "P2" }, "conn-a");
    await core.xc_check_inbox({}, "conn-b");

    const c1 = await core.xc_claim({ taskId: "t1" }, "conn-b");
    expect(c1.isError).toBeUndefined();

    // 一人双线（memberOpenTask 约束）
    const double = await core.xc_claim({ taskId: "t2" }, "conn-b");
    expect(payloadOf(double).error).toBe("already_has_open_task");

    // 依赖未满足（t1 已认领未完成）
    await core.xc_dispatch({ to: "b", title: "T3", prompt: "P3", dependsOn: ["t1"] }, "conn-a");
    const claimDep = await core.xc_claim({ taskId: "t3" }, "conn-b");
    expect(payloadOf(claimDep).error).toBe("dependencies_unmet");
  });
});
