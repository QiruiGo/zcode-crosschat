/**
 * v0.5.3（安全对-5 三番战 a10 修复）防回归：邮箱回执完整性——哈希链 sidecar。
 *
 * adj052 攻击原样（a10-receipttamper.mjs）：worker 完成任务 → 回执入 lead 邮箱；
 * 直接编辑 `inbox/boss.jsonl` 改写 result → `xc_mail_read` 原样提供被篡改文本，
 * 无任何告警（对照：任务板回滚有 rollback_conflict 硬拒）。
 *
 * 本文件覆盖 core 机制（appendMailbox 落链 / verifyMailboxIntegrity 判定）；
 * 工具面（xc_mail_read / xc_check_inbox 告警）见 mail-integrity-face.test.ts。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAIL_CHAIN_GENESIS,
  mailLineHash,
  mailboxIntegrityPath,
  readMailIntegrityRecords,
  verifyMailboxIntegrity,
} from "./mailintegrity.js";
import { appendJsonl, readJsonl } from "./jsonl.js";
import { acknowledgeMailbox, appendMailbox, readMailbox } from "./mailbox.js";
import { inboxFile } from "./paths.js";
import type { TeamMessage } from "./types.js";

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-mailint-"));
  stateRoot = join(workDir, ".crosschat");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function msg(overrides: Partial<TeamMessage> = {}): TeamMessage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    from: "dev1",
    to: "boss",
    content: '["task-receipt"] TV1 done as specified',
    ts: 1000,
    ...overrides,
  };
}

describe("appendMailbox 落链（a10 机制）", () => {
  it("writes one chain record per message; verify reports clean", async () => {
    const m1 = msg();
    const m2 = msg({ id: "22222222-2222-4222-8222-222222222222", content: "second" });
    await appendMailbox(stateRoot, "default", "boss", m1);
    await appendMailbox(stateRoot, "default", "boss", m2);

    const records = await readMailIntegrityRecords(stateRoot, "default", "boss");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ v: 1, id: m1.id, seq: 0, prev: MAIL_CHAIN_GENESIS });
    expect(records[1]).toMatchObject({ v: 1, id: m2.id, seq: 1, prev: records[0]!.h });
    // 链步进 = sha256(prev + "\n" + 白名单 JSON)
    expect(records[0]!.h).toBe(mailLineHash(MAIL_CHAIN_GENESIS, m1));
    expect(records[1]!.h).toBe(mailLineHash(records[0]!.h, m2));

    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toEqual([]);
    expect(report.unverifiedIds).toEqual([]);
    expect(report.recordCount).toBe(2);
  });

  it("legitimate volatile mutation (acknowledge readAt) does NOT break verification", async () => {
    const m1 = msg();
    await appendMailbox(stateRoot, "default", "boss", m1);
    await acknowledgeMailbox(stateRoot, "default", "boss", [m1.id], 9999);
    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toEqual([]);
    expect(report.unverifiedIds).toEqual([]);
  });

  it("concurrent appends stay chained (no forked prev → no false alarm)", async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg({ id: `33333333-0000-4000-8000-${String(i).padStart(12, "0")}`, content: `msg-${i}` }));
    await Promise.all(messages.map((m) => appendMailbox(stateRoot, "default", "boss", m)));
    const records = await readMailIntegrityRecords(stateRoot, "default", "boss");
    expect(records).toHaveLength(12);
    expect(records.map((r) => r.seq)).toEqual([...Array(12).keys()]);
    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toEqual([]);
  });
});

describe("verifyMailboxIntegrity 篡改判定（a10 攻击重放）", () => {
  it("a10 replay: on-disk content tamper → content-hash-mismatch", async () => {
    const m1 = msg();
    await appendMailbox(stateRoot, "default", "boss", m1);

    // 攻击者直接改邮箱 JSONL（adj052 原样：改 result 文本）
    const file = inboxFile(stateRoot, "default", "boss");
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as TeamMessage);
    const forged = lines.map((l) => (l.id === m1.id ? { ...l, content: '["task-receipt"] FORGED-RECEIPT-CONTENT-TASK-DONE' } : l));
    await writeFile(file, forged.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toEqual([{ id: m1.id, reason: "content-hash-mismatch" }]);
  });

  it("sidecar hash tamper → content-hash-mismatch", async () => {
    const m1 = msg();
    await appendMailbox(stateRoot, "default", "boss", m1);
    const sidecar = mailboxIntegrityPath(stateRoot, "default", "boss");
    const records = (await readFile(sidecar, "utf8")).trim().split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    records[0]!["h"] = "f".repeat(64);
    await writeFile(sidecar, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toContainEqual({ id: m1.id, reason: "content-hash-mismatch" });
  });

  it("sidecar middle record removal → chain-broken on the successor", async () => {
    const m1 = msg();
    const m2 = msg({ id: "22222222-2222-4222-8222-222222222222" });
    const m3 = msg({ id: "33333333-3333-4333-8333-333333333333" });
    for (const m of [m1, m2, m3]) await appendMailbox(stateRoot, "default", "boss", m);
    const sidecar = mailboxIntegrityPath(stateRoot, "default", "boss");
    const lines = (await readFile(sidecar, "utf8")).trim().split("\n");
    await writeFile(sidecar, [lines[0], lines[2]].join("\n") + "\n", "utf8"); // 删中间记录

    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toContainEqual({ id: m3.id, reason: "chain-broken" });
  });

  it("missing sidecar / legacy lines → unverified, NOT alarmed (upgrade compat)", async () => {
    // 旧件：绕过 appendMailbox 直接写邮箱行（v0.5.2 存量邮箱）
    await appendJsonl(inboxFile(stateRoot, "default", "boss"), [JSON.stringify(msg())]);
    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toEqual([]);
    expect(report.unverifiedIds).toEqual([msg().id]);
    expect(report.recordCount).toBe(0);
  });

  it("mixed legacy + chained mailbox: only legacy is unverified", async () => {
    await appendJsonl(inboxFile(stateRoot, "default", "boss"), [JSON.stringify(msg())]); // 存量
    const fresh = msg({ id: "44444444-4444-4444-8444-444444444444" });
    await appendMailbox(stateRoot, "default", "boss", fresh);
    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toEqual([]);
    expect(report.unverifiedIds).toEqual([msg().id]);
  });

  it("duplicate sidecar record for one message → duplicate-record", async () => {
    const m1 = msg();
    await appendMailbox(stateRoot, "default", "boss", m1);
    const sidecar = mailboxIntegrityPath(stateRoot, "default", "boss");
    const raw = await readFile(sidecar, "utf8");
    await writeFile(sidecar, raw + raw, "utf8");
    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toContainEqual({ id: m1.id, reason: "duplicate-record" });
  });

  it("non-task immutable field tamper (origin stamp) is caught too", async () => {
    const m1 = msg({ origin: "user", originSessionId: "sess-dev1" });
    await appendMailbox(stateRoot, "default", "boss", m1);
    const file = inboxFile(stateRoot, "default", "boss");
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as TeamMessage);
    const forged = lines.map((l) => (l.id === m1.id ? { ...l, originSessionId: "sess-attacker" } : l));
    await writeFile(file, forged.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    const mail = await readMailbox(stateRoot, "default", "boss");
    const report = await verifyMailboxIntegrity(stateRoot, "default", "boss", mail);
    expect(report.violations).toEqual([{ id: m1.id, reason: "content-hash-mismatch" }]);
  });

  it("mailLineHash is field-order-stable and content-sensitive", async () => {
    const a = msg();
    const b = msg({ content: "tampered" });
    expect(mailLineHash(MAIL_CHAIN_GENESIS, a)).not.toBe(mailLineHash(MAIL_CHAIN_GENESIS, b));
    // 字段白名单外的易变字段不参与
    const withReadAt = { ...a, readAt: 12345 };
    expect(mailLineHash(MAIL_CHAIN_GENESIS, a)).toBe(mailLineHash(MAIL_CHAIN_GENESIS, withReadAt));
  });
});
