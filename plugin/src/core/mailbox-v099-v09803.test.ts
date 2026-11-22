/**
 * v0.9.9（V098-03，P2）定向单测：`refused` 态的**引擎凭据**判据。
 *
 * 背景（v0.9.8 adv-2 F1）：J4 的 refused 判据解析消息正文——任一成员在 msg 里塞
 * `{"type":"delivery-refused",…}` 即可让自己发出的消息恒报 refused（回执帧与普通
 * 消息在邮箱行上字节级不可区分），权威状态面（lead 据它判断投递结果）可说谎；
 * 工具面 carve-out（「回执收方本人可查」）被扩大成「任何消息的收方本人可查」。
 *
 * 修法（本组文件域内可实现的部分）：refused 只认引擎回执——对账 engine.jsonl 的
 * `inbound-refused` 审计事件（refuse 分支写回执的同一请求落账，带 messageId）；
 * 帧形状退化为**必要不充分**条件。工具面（权限 + 跨邮箱定位 + 收方 carve-out）
 * 的对抗在 mcp/tools-read-v099-v09803.test.ts 驱动。
 *
 * 全部驱动真 engine.jsonl（appendJsonl/logEngineEvent）——凭据对账不是 mock 能证明的。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDeliveryRefusedReceipt,
  messageStatusOf,
  REFUSAL_EVIDENCE_TAIL_BYTES,
  refusalReceiptEvidence,
} from "./mailbox.js";
import { logEngineEvent } from "./log.js";
import type { TeamMessage } from "./types.js";

const TEAM = "default";

function receipt(id: string, from = "bob", to = "alice"): TeamMessage {
  return {
    id,
    from,
    to,
    content: JSON.stringify({ type: "delivery-refused", teamId: TEAM, to: from, reason: "inbound policy refuse" }),
    ts: 1_000,
    deliveryClaimedAt: 1_100,
  };
}

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v099-v09803-"));
  stateRoot = join(workDir, ".crosschat");
  await mkdir(join(stateRoot, "logs"), { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("v0.9.9 V098-03：refusalReceiptEvidence（引擎凭据对账）", () => {
  it("inbound-refused 事件（同 team ∧ 同 messageId）⇒ true", async () => {
    await logEngineEvent(stateRoot, {
      event: "inbound-refused", teamId: TEAM, from: "alice", to: "bob", messageId: "r-1", policySource: "env",
    });
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-1")).toBe(true);
  });

  it("事件在、messageId 不符 ⇒ false（不能拿别人的凭据）", async () => {
    await logEngineEvent(stateRoot, {
      event: "inbound-refused", teamId: TEAM, from: "alice", to: "bob", messageId: "r-1", policySource: "env",
    });
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-2")).toBe(false);
  });

  it("事件在、teamId 不符 ⇒ false（跨队不互认）", async () => {
    await logEngineEvent(stateRoot, {
      event: "inbound-refused", teamId: "other", from: "alice", to: "bob", messageId: "r-1", policySource: "env",
    });
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-1")).toBe(false);
  });

  it("其他事件类型不充当凭据（含同 messageId 的普通事件）", async () => {
    await logEngineEvent(stateRoot, { event: "inbox-check", teamId: TEAM, messageId: "r-1", consumed: 1 });
    await logEngineEvent(stateRoot, { event: "inbound-held", teamId: TEAM, messageId: "r-1" });
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-1")).toBe(false);
  });

  it("engine.jsonl 缺失/空文件 ⇒ false（无凭据不猜）", async () => {
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-1")).toBe(false);
    await writeFile(join(stateRoot, "logs", "engine.jsonl"), "");
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-1")).toBe(false);
  });

  it("坏行/半行/非对象行不炸也不充当凭据", async () => {
    await writeFile(
      join(stateRoot, "logs", "engine.jsonl"),
      [
        "{ 这不是 json",
        '"just a string"',
        JSON.stringify({ event: "inbound-refused", messageId: "r-1" }),               // 缺 teamId：字段判不符
        JSON.stringify({ ts: 1, event: "inbound-refused", teamId: TEAM, from: "alice", to: "bob", messageId: "r-9", policySource: "env" }),
        "",
      ].join("\n") + "\n",
    );
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-9")).toBe(true);
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-1")).toBe(false);
  });

  // v0.9.9（集成员第 1 轮修红）：本例会顺序写 401 条引擎事件（真实 fs 追加），单跑约 430ms；
  // 全量套件（200 文件 / 2735 例）并行负载下超过 vitest 缺省 5000ms 超时（连超 4 次 = 初跑 +
  // retry:3），报 "Test timed out in 5000ms" 并连带 afterEach 的临时目录清理 ENOTEMPTY。
  // 这是**负载敏感**而非判据问题：单跑本文件 11 例 476ms 全绿。故按既有惯例给足显式超时，
  // 不放宽任何断言。
  it("尾部窗口之外的旧事件 ⇒ false（有界读取的已知限制，如实声明）", async () => {
    await logEngineEvent(stateRoot, {
      event: "inbound-refused", teamId: TEAM, from: "alice", to: "bob", messageId: "r-old", policySource: "env",
    });
    // 灌入远超窗口的后续事件，把旧凭据挤出窗口（tailBytes 覆盖避免写 2MiB）。
    for (let i = 0; i < 400; i += 1) {
      await logEngineEvent(stateRoot, { event: "inbox-check", teamId: TEAM, agentKey: "bob", consumed: i, note: "x".repeat(200) });
    }
    expect(REFUSAL_EVIDENCE_TAIL_BYTES).toBeGreaterThan(0);
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-old")).toBe(true);            // 缺省 2MiB 窗口仍覆盖
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-old", 4_096)).toBe(false);    // 小窗口：旧凭据已溢出
    expect(await refusalReceiptEvidence(stateRoot, TEAM, "r-old", 1024 * 1024)).toBe(true);
  }, 30_000);
});

describe("v0.9.9 V098-03：messageStatusOf 的 refused 门（形状必要不充分）", () => {
  it("无引擎凭据 ⇒ 回执形状件按印章态报 queued（正文不再伪造状态）", () => {
    const r = receipt("r-1");
    expect(isDeliveryRefusedReceipt(r)).toBe(true);      // 形状仍认得出来（必要 condition）
    expect(messageStatusOf(r, false)).toBe("queued");    // 但无凭据不判 refused
    expect(messageStatusOf(r, false, false)).toBe("queued");
  });

  it("有引擎凭据 ⇒ refused，且压过 delivered/read 等印章态", () => {
    const r = { ...receipt("r-1"), deliveredAt: 1_200, consumedAt: 1_300, readAt: 1_400 };
    expect(messageStatusOf(r, false, true)).toBe("refused");
  });

  it("held 仍压过 refused（隔离区命中恒 held）", () => {
    expect(messageStatusOf(receipt("r-1"), true, true)).toBe("held");
  });

  it("非回执形状的普通消息：凭据参数为真也不判 refused", () => {
    const plain: TeamMessage = { id: "m-1", from: "alice", to: "bob", content: "hello", ts: 1 };
    expect(messageStatusOf(plain, false, true)).toBe("queued");
  });
});
