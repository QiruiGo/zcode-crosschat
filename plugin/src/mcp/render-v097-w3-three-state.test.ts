/**
 * v0.9.7（W3/V096-01/24）定向测试：**回执三态的人可读措辞**（47-v097 方案 §一 组 W W3）。
 *
 * 缺陷形态：
 * - V096-01（adv-1 F-1）：`xc_dispatch`/`xc_report` 的 wake() 帮手把三态键全部结构性
 *   丢弃 → 两轮唤醒全失败时人可读行仍写 "dispatched via wake" / "wake back via wake"
 *   （把「发起了但失败了」读成成功）；
 * - V096-24（45b 补正）：`xc_relay` 面四键全文件零命中，只有 note 文本披露。
 *
 * 本文件覆盖 render 层的三态措辞（纯函数，逐字断言）：
 * 1. 失败态（wakeFailureSeen + failureEvidence）→ 失败措辞 + 邮箱兜底指引，
 *    **禁出现** "via wake" / "wake back via wake"；
 * 2. 未见启动证据态（startConfirmed:false）→ 「已发起但未见启动证据（非送达确认）」，
 *    且不与失败措辞混淆；
 * 3. 成功态（startConfirmed:true）→ 原措辞，不误报失败；
 * 4. 【硬回归】三个可选参缺省 → 与 v0.9.6 输出逐字节一致（旧调用方零行为变化）；
 * 5. wakeReceiptFailurePhrase 的无失败证据判据（undefined = 不渲染失败措辞）。
 */
import { describe, expect, it } from "vitest";
import {
  renderDispatch,
  renderMessage,
  renderReport,
  wakeReceiptFailurePhrase,
} from "./render.js";

const FAILURE = {
  startConfirmed: false,
  wakeFailureSeen: true,
  failureEvidence: "Error: Session not found: sess_deadbeef",
  wakeTiers: { spawnOk: "ok" as const, childAlive: "no" as const, consumed: "pending" as const },
};

describe("v0.9.7 W3：renderDispatch 三态措辞", () => {
  it("【W3 锚点】两轮唤醒全失败 → 失败措辞 + 禁写 via wake", () => {
    const line = renderDispatch("t1", "b", "wake", FAILURE);
    expect(line).toContain("唤醒失败");
    expect(line).toContain("Session not found");
    expect(line).toContain("pull 兜底");
    expect(line).not.toContain("via wake");
  });

  it("未见启动证据（startConfirmed:false）→ 如实两态，不混写失败", () => {
    const line = renderDispatch("t1", "b", "wake", { startConfirmed: false });
    expect(line).toContain("已发起但未见启动证据");
    expect(line).toContain("via wake");
    expect(line).not.toContain("唤醒失败");
  });

  it("成功态（startConfirmed:true）→ 原措辞、不误报失败", () => {
    expect(renderDispatch("t1", "b", "wake", { startConfirmed: true })).toBe(
      "Task t1 dispatched to b via wake.",
    );
    expect(renderDispatch("t1", "b", "wake", { startConfirmed: true })).not.toContain("失败");
  });

  it("mailbox 态 → 不受 wake 参数影响（未唤醒路径无三态可报）", () => {
    expect(renderDispatch("t1", "b", "mailbox", FAILURE)).toBe("Task t1 dispatched to b via mailbox.");
  });

  it("【硬回归】不传 wake → 与 v0.9.6 逐字节一致", () => {
    expect(renderDispatch("t1", "b", "mailbox")).toBe("Task t1 dispatched to b via mailbox.");
    expect(renderDispatch("t1", "b", "wake")).toBe("Task t1 dispatched to b via wake.");
  });
});

describe("v0.9.7 W3：renderReport 三态措辞", () => {
  it("【W3 锚点】两轮唤醒全失败 → 失败措辞 + 禁写 wake back via wake", () => {
    const line = renderReport("t1", "completed", "a", "wake", FAILURE);
    expect(line).toContain("唤醒失败");
    expect(line).toContain("pull 兜底");
    expect(line).not.toContain("wake back via wake");
  });

  it("未见启动证据 → 如实两态", () => {
    const line = renderReport("t1", "completed", "a", "wake", { startConfirmed: false });
    expect(line).toContain("已发起但未见启动证据");
    expect(line).toContain("wake back via wake");
  });

  it("【硬回归】不传 wake → 与 v0.9.6 逐字节一致", () => {
    expect(renderReport("t1", "completed", "a", "wake")).toBe(
      "Task t1 completed; receipt sent to a; wake back via wake.",
    );
    expect(renderReport("t2", "in_progress", null, "mailbox")).toContain("no receipt (non-terminal)");
  });
});

describe("v0.9.7 W3：renderMessage 三态措辞（relay 面）", () => {
  it("【W3 锚点】两轮唤醒全失败 → 失败措辞 + 保留 note 原文", () => {
    const line = renderMessage("1a2b3c4d5e6f", "a", "b", "wake", "spawned: 无头 --resume 已发起", false, FAILURE);
    expect(line).toContain("唤醒失败");
    expect(line).toContain("Session not found");
    expect(line).toContain("无头 --resume 已发起"); // note 仍透传
    expect(line).not.toContain("已发起唤醒（wake，非送达确认）");
  });

  it("未见启动证据 → 两态措辞（v0.9.6 已有行为不减）", () => {
    const line = renderMessage("1a2b3c4d5e6f", "a", "b", "wake", undefined, false);
    expect(line).toContain("已发起唤醒但未见启动证据");
  });

  it("成功态 → 不误报失败", () => {
    const line = renderMessage("1a2b3c4d5e6f", "a", "b", "wake", undefined, true);
    expect(line).toContain("已发起唤醒（wake，非送达确认）");
    expect(line).not.toContain("失败");
  });

  it("【硬回归】不传 startConfirmed/wake → 与 v0.9.5/v0.9.6 逐字节一致", () => {
    expect(renderMessage("1a2b3c4d5e6f", "a", "b", "duplicate")).toBe(
      "Message 1a2b3c4d a → b 未重发（已存在同文未读件，duplicate；pull 兜底可读）.",
    );
    expect(renderMessage("1a2b3c4d5e6f", "a", "b", "mailbox", "note-x")).toBe(
      "Message 1a2b3c4d a → b 仅落邮箱（未唤醒，pull 兜底）：note-x.",
    );
    expect(renderMessage("1a2b3c4d5e6f", "a", "b", "wake", "note-y")).toBe(
      "Message 1a2b3c4d a → b 已发起唤醒（wake，非送达确认）：note-y.",
    );
  });
});

describe("v0.9.7 W3：wakeReceiptFailurePhrase 判据", () => {
  it("无失败证据（wakeFailureSeen 缺省/false）→ undefined（不渲染失败措辞）", () => {
    expect(wakeReceiptFailurePhrase(undefined)).toBeUndefined();
    expect(wakeReceiptFailurePhrase({ startConfirmed: true })).toBeUndefined();
    expect(wakeReceiptFailurePhrase({ startConfirmed: false })).toBeUndefined();
    expect(wakeReceiptFailurePhrase({ wakeFailureSeen: false })).toBeUndefined();
  });

  it("有失败证据但缺 failureEvidence → 失败措辞仍成立（不依赖证据原文）", () => {
    const phrase = wakeReceiptFailurePhrase({ wakeFailureSeen: true });
    expect(phrase).toContain("唤醒失败");
    expect(phrase).toContain("pull 兜底");
  });

  it("失败证据原文截断到 160 字符（防回执刷屏）", () => {
    const long = "x".repeat(400);
    const phrase = wakeReceiptFailurePhrase({ wakeFailureSeen: true, failureEvidence: long })!;
    expect(phrase).toContain("x".repeat(160));
    expect(phrase).not.toContain("x".repeat(161));
  });
});
