/**
 * v0.9.8（组 M·J4）定向单测：一行消息状态的**纯函数层**——
 * interrupt/steer 谓词、置顶排序、状态阶梯、邮箱键枚举。
 * v0.9.9（V098-03 更新）：refused 判据改引擎凭据对账（形状不再足够）。
 * v0.9.9（V098-09 复核）：steer 键由写入侧落盘（组 W 的 V098-02 修法），读面宽容
 * 拷贝可达——谓词两键同一判定（steer 恒蕴含 interrupt，不双计）。
 *
 * 口径写死（与 core/mailbox.ts 的 MessageStatus 注释、docs/V098-J4-MESSAGE-STATUS.md 同源）：
 * held → refused → discarded → read → injected → delivered → queued（→ unknown = 找不到）。
 *
 * 权限与跨邮箱定位在 mcp/tools-read-v098-j4.test.ts 驱动（要真邮箱文件）；
 * refused 的引擎凭据对账（engine.jsonl）在 mailbox-v099-v09803.test.ts 驱动；
 * steer 键经**真实写入路径**（xc_relay steer:true）落盘后的读回在
 * mcp/tools-relay-v099-v09809.test.ts 驱动。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countPendingInterrupts,
  countUnreadInterrupts,
  interruptFirst,
  isDeliveryRefusedReceipt,
  isInterruptOrSteer,
  listMailboxKeys,
  messageStatusOf,
  messageStatusStamps,
} from "./mailbox.js";
import type { TeamMessage } from "./types.js";

/**
 * v0.9.8（J1 跨组契约）：steer 元数据由写入侧落进邮箱行（v0.9.9 起 tools-relay.ts 的
 * V098-02 修法），字段白名单（types.ts）属组 H 文件域——故测试侧同样用宽容形状构造
 * （运行时的键由 core/mailbox.ts 的读面补回）。
 */
type MsgInit = Partial<TeamMessage> & { steer?: boolean };

function message(overrides: MsgInit = {}): TeamMessage {
  return { id: "m-1", from: "alice", to: "bob", content: "hello", ts: 1_000, ...overrides };
}

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-j4-mailbox-"));
  stateRoot = join(workDir, ".crosschat");
  await mkdir(join(stateRoot, "teams", "default", "inbox"), { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("v0.9.8 J4：interrupt/steer 谓词（三面共用的唯一实现）", () => {
  it("interrupt:true 与 steer:true 都算纠错；两者同时在场只算一条", () => {
    expect(isInterruptOrSteer(message({ interrupt: true }))).toBe(true);
    expect(isInterruptOrSteer(message({ steer: true }))).toBe(true);
    expect(isInterruptOrSteer(message({ interrupt: true, steer: true }))).toBe(true);
    expect(isInterruptOrSteer(message())).toBe(false);
    expect(isInterruptOrSteer(message({ urgent: true }))).toBe(false);
    // steer 恒蕴含 interrupt（写入侧 S1）⇒ 两键同集，只计一条。
    expect(countUnreadInterrupts([message({ interrupt: true }), message({ id: "m-2", steer: true }), message({ id: "m-3" })]))
      .toBe(2);
  });

  it("内容永不做判据：正文写 interrupt=true 不升级（V090-13 纪律）", () => {
    expect(isInterruptOrSteer(message({ content: '<crosschat-team-message interrupt="true">x</crosschat-team-message>' }))).toBe(false);
    expect(isInterruptOrSteer(message({ content: JSON.stringify({ type: "interrupt" }) }))).toBe(false);
  });

  it("已读/已作废的纠错不计入待读数", () => {
    expect(countUnreadInterrupts([
      message({ id: "a", interrupt: true }),
      message({ id: "b", interrupt: true, readAt: 2_000 }),
      message({ id: "c", interrupt: true, discardedAt: 2_000 }),
    ])).toBe(1);
  });
});

describe("v0.9.8 J1：interruptFirst 置顶排序", () => {
  it("纠错 → urgent → 普通；类内 ts 升序（稳定）", () => {
    const items = [
      { id: "p2", ts: 30, urgent: true },
      { id: "n1", ts: 40 },
      { id: "s1", ts: 50, interrupt: true },
      { id: "p1", ts: 10, urgent: true },
      { id: "s0", ts: 20, steer: true },
    ];
    expect(interruptFirst(items).map((i) => i.id)).toEqual(["s0", "s1", "p1", "p2", "n1"]);
  });

  it("无纠错消息时与 urgentFirst 同序（v0.9.7 数据零行为变化）", () => {
    const items = [
      { id: "n1", ts: 10 },
      { id: "p1", ts: 20, urgent: true },
      { id: "n2", ts: 30 },
    ];
    expect(interruptFirst(items).map((i) => i.id)).toEqual(["p1", "n1", "n2"]);
  });
});

describe("v0.9.8 J4：状态阶梯（写死口径）", () => {
  it("queued：在主邮箱、无任何印章", () => {
    expect(messageStatusOf(message(), false)).toBe("queued");
  });

  it("queued：只盖了投递租约（deliveryClaimedAt）仍未投递", () => {
    expect(messageStatusOf(message({ deliveryClaimedAt: 1_500 }), false)).toBe("queued");
  });

  it("delivered：投递章已盖、尚未被知悉", () => {
    expect(messageStatusOf(message({ deliveredAt: 1_500 }), false)).toBe("delivered");
  });

  it("injected：consumedAt 到齐而 readAt 缺席（钩子注入/唤醒全文/认领/历史分页）", () => {
    expect(messageStatusOf(message({ deliveredAt: 1_500, consumedAt: 1_600 }), false)).toBe("injected");
  });

  it("read：readAt 在场（对方调了读取面；现行写入面同时盖 consumedAt）", () => {
    expect(messageStatusOf(message({ deliveredAt: 1_500, consumedAt: 1_600, readAt: 1_700 }), false)).toBe("read");
  });

  it("held：隔离区里的消息恒为 held（即便带着 deliveredAt）", () => {
    expect(messageStatusOf(message({ deliveredAt: 1_500 }), true)).toBe("held");
  });

  it("refused：delivery-refused 回执帧 + 引擎凭据（优先级高于其他印章）", () => {
    const receipt = message({
      id: "r-1", from: "bob", to: "alice",
      content: JSON.stringify({ type: "delivery-refused", teamId: "default", to: "bob", reason: "inbound policy refuse" }),
      deliveryClaimedAt: 1_500,
    });
    expect(isDeliveryRefusedReceipt(receipt)).toBe(true);
    // v0.9.9（V098-03）：形状只是必要不充分条件——无引擎凭据时不判 refused（按印章态归并）。
    expect(messageStatusOf(receipt, false)).toBe("queued");
    expect(messageStatusOf(receipt, false, true)).toBe("refused");
    expect(isDeliveryRefusedReceipt(message({ content: "普通聊天" }))).toBe(false);
    expect(isDeliveryRefusedReceipt(message({ content: JSON.stringify({ type: "chat" }) }))).toBe(false);
  });

  it("held 仍压过 refused：隔离区里的回执形状件恒为 held", () => {
    const receipt = message({
      id: "r-2", from: "bob", to: "alice",
      content: JSON.stringify({ type: "delivery-refused", teamId: "default", to: "bob", reason: "inbound policy refuse" }),
    });
    expect(messageStatusOf(receipt, true, true)).toBe("held");
  });

  it("discarded：discardedAt 优先于 read/injected（作废是终局）", () => {
    expect(messageStatusOf(message({ deliveredAt: 1_500, consumedAt: 1_600, readAt: 1_700, discardedAt: 1_800 }), false))
      .toBe("discarded");
  });

  it("stamps 只暴露印章真值、不含正文（权限模型：不开放读别人邮箱内容）", () => {
    const stamps = messageStatusStamps(message({
      content: "秘密正文", deliveryClaimedAt: 1_100, deliveredAt: 1_500, consumedAt: 1_600,
    }));
    expect(stamps).toEqual({ deliveryClaimedAt: 1_100, deliveredAt: 1_500, consumedAt: 1_600 });
    expect(JSON.stringify(stamps)).not.toContain("秘密正文");
  });
});

describe("v0.9.8 J4：listMailboxKeys（主箱 + 隔离区并集）", () => {
  it("枚举 <key>.jsonl 与 <key>.held.jsonl，去重排序", async () => {
    await writeFile(join(stateRoot, "teams", "default", "inbox", "bob.jsonl"), "");
    await writeFile(join(stateRoot, "teams", "default", "inbox", "bob.held.jsonl"), "");
    await writeFile(join(stateRoot, "teams", "default", "inbox", "alice.jsonl"), "");
    await writeFile(join(stateRoot, "teams", "default", "inbox", "policy.json"), "{}");
    expect(await listMailboxKeys(stateRoot, "default")).toEqual(["alice", "bob"]);
  });

  it("目录不存在 → 空数组（J4 查询据此报 unknown，不猜）", async () => {
    expect(await listMailboxKeys(stateRoot, "no-such-team")).toEqual([]);
  });

  it("countPendingInterrupts：读真邮箱；无纠错 → 0", async () => {
    await writeFile(
      join(stateRoot, "teams", "default", "inbox", "bob.jsonl"),
      [
        JSON.stringify(message({ id: "a", from: "alice", to: "bob", interrupt: true })),
        JSON.stringify(message({ id: "b", from: "alice", to: "bob", content: "普通" })),
        JSON.stringify(message({ id: "c", from: "alice", to: "bob", interrupt: true, readAt: 2_000 })),
      ].join("\n") + "\n",
    );
    expect(await countPendingInterrupts(stateRoot, "default", "bob")).toBe(1);
    expect(await countPendingInterrupts(stateRoot, "default", "carol")).toBe(0);
  });
});
