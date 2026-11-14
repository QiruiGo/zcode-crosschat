/**
 * v0.5.3（安全对-5 三番战 a10 修复）防回归：工具面告警——xc_mail_read /
 * xc_check_inbox 对磁盘篡改的检测+告警（adj052 a10 原样重放走协议面）。
 *
 * 场景：boss 派 TV1 → dev1 认领并 completed 回执 → 直接改 `inbox/boss.jsonl`
 * 的回执 result 文本 → 修复前 xc_mail_read 原样提供被篡改文本（零告警）；
 * 修复后文本面 WARNING + 载荷 integrity{status:"tampered"} + engine.jsonl
 * 审计 `{event:"mailbox-integrity-violation"}`。xc_check_inbox 消费面同规
 * （载荷 integrityViolations + 信封文本面 WARNING）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf } from "./protocol.js";
import { createToolCore, type ToolCore } from "./tools.js";
import { writeSession } from "../core/registry.js";
import { inboxFile, engineLogFile } from "../core/paths.js";
import { readMailbox } from "../core/mailbox.js";
import type { ToolResult } from "./protocol.js";

let workDir: string;
let stateRoot: string;
let core: ToolCore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-mailint-face-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({ stateRoot, workspace: workDir, env: {} }); // 无 XC_WAKE_ENABLED → mailbox
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function hookRegister(conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

/** adj052 a10 前置流：boss 派 TV1 → dev1 认领 → completed 回执（含证据）。 */
async function seedReceipt(): Promise<string> {
  await hookRegister("conn-a", "boss", "sess-a10-lead");
  await hookRegister("conn-b", "dev1", "sess-a10-worker");
  const rd = await core.xc_dispatch(
    { to: "dev1", title: "TV1", prompt: "produce tv1.txt", acceptance: "tv1.txt exists" },
    "conn-a",
  );
  const taskId = (payloadOf(rd) as { taskId: string }).taskId;
  const cl = await core.xc_claim({ taskId }, "conn-b");
  const attemptId = (payloadOf(cl) as { attemptId: string }).attemptId;
  const proof = join(workDir, "tv1.txt");
  await writeFile(proof, "TV1-CONTENT\n", "utf8");
  await core.xc_report({ taskId, attemptId, status: "in_progress" }, "conn-b");
  const rep = await core.xc_report(
    { taskId, attemptId, status: "completed", result: "TV1 done as specified", evidence: [{ path: proof }] },
    "conn-b",
  );
  expect(rep.isError).toBeUndefined();
  return taskId;
}

/** 把 boss 邮箱里含 taskId 的回执行 content 改写为伪造文本（adj052 原样篡改）。 */
async function tamperReceipt(taskId: string): Promise<void> {
  const file = inboxFile(stateRoot, "default", "boss");
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { id: string; content: string });
  const receipt = lines.find((l) => l.content.includes("task-receipt") && l.content.includes(taskId));
  expect(receipt).toBeDefined();
  const forged = lines.map((l) =>
    l.id === receipt!.id
      ? { ...l, content: l.content.replace(/"result":"[^"]*"/, '"result":"FORGED-RECEIPT-CONTENT-TASK-DONE"') }
      : l,
  );
  await writeFile(file, forged.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("xc_mail_read 完整性告警（a10 修复工具面）", () => {
  it("clean receipt: integrity ok, no WARNING, no audit", async () => {
    const taskId = await seedReceipt();
    const mail = await readMailbox(stateRoot, "default", "boss");
    const receipt = mail.find((m) => m.content.includes("task-receipt") && m.content.includes(taskId))!;
    const res = await core.xc_mail_read({ messageId: receipt.id }, "conn-a");
    const resText = res.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    expect(res.isError).toBeUndefined();
    expect(resText).not.toContain("WARNING");
    expect((payloadOf(res) as { integrity: { status: string } }).integrity.status).toBe("ok");
    expect((await engineEvents()).some((e) => e["event"] === "mailbox-integrity-violation")).toBe(false);
  });

  it("a10 replay: tampered receipt served WITH WARNING + integrity payload + audit", async () => {
    const taskId = await seedReceipt();
    await tamperReceipt(taskId);
    const mail = await readMailbox(stateRoot, "default", "boss");
    const receipt = mail.find((m) => m.content.includes("task-receipt") && m.content.includes(taskId))!;

    const res = await core.xc_mail_read({ messageId: receipt.id }, "conn-a");
    const resText = res.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    // 检测+告警口径：内容照常返回（不阻断只读分页），但告警必须显眼且机器可读。
    expect(resText).toContain("FORGED-RECEIPT-CONTENT-TASK-DONE");
    expect(resText).toContain("WARNING: mailbox integrity check FAILED");
    expect(resText).toContain("content-hash-mismatch");
    const payload = payloadOf(res) as { integrity: { status: string; reason: string } };
    expect(payload.integrity.status).toBe("tampered");
    expect(payload.integrity.reason).toBe("content-hash-mismatch");
    const violations = (await engineEvents()).filter((e) => e["event"] === "mailbox-integrity-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ face: "mail_read", messageId: receipt.id, reason: "content-hash-mismatch" });
  });

  it("clean non-receipt message (dispatch envelope) also reads with integrity ok", async () => {
    await seedReceipt();
    const mail = await readMailbox(stateRoot, "default", "dev1");
    const dispatch = mail[0]!;
    const res = await core.xc_mail_read({ messageId: dispatch.id }, "conn-b");
    expect(res.isError).toBeUndefined();
    expect((payloadOf(res) as { integrity: { status: string } }).integrity.status).toBe("ok");
  });
});

describe("xc_check_inbox 完整性告警（a10 修复消费面）", () => {
  it("a10 replay: tampered unread receipt → payload integrityViolations + envelope WARNING + audit", async () => {
    const taskId = await seedReceipt();
    await tamperReceipt(taskId);

    const res = await core.xc_check_inbox({}, "conn-a");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as { integrityViolations?: Array<{ id: string; reason: string }> };
    expect(payload.integrityViolations).toHaveLength(1);
    expect(payload.integrityViolations![0]!.reason).toBe("content-hash-mismatch");
    // 信封文本面（content 第 3 块）携带显著 WARNING
    const blocks = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(blocks).toContain("WARNING: 邮箱完整性校验失败");
    expect(blocks).toContain("content-hash-mismatch");
    expect(blocks).toContain("Do not trust");
    const violations = (await engineEvents()).filter((e) => e["event"] === "mailbox-integrity-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ face: "check_inbox" });
  });

  it("clean consumption: no integrityViolations key, no WARNING, receipt delivered normally", async () => {
    await seedReceipt();
    const res = await core.xc_check_inbox({}, "conn-a");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as { integrityViolations?: unknown; messages: Array<{ content: string }> };
    expect(payload.integrityViolations).toBeUndefined();
    expect(payload.messages.some((m) => m.content.includes("task-receipt"))).toBe(true);
    expect(res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")).not.toContain("WARNING: 邮箱完整性校验失败");
  });
});
