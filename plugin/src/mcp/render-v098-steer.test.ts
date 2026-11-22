/**
 * v0.9.8（组 S）定向测试：**render.ts 的 steer 回执渲染**（方案 49-v098 §二 S5）——
 * steerReceiptPhrase 三态措辞 + renderMessage 的 steer 行 + 无 steer 时逐字节不变。
 *
 * 与 tools-relay-v098-steer.test.ts 的分工：那边测「payload 结构化键」，本文件测
 * 「人可读行措辞」——三态分流、失败/降级不写「抢占成功」、强杀副作用披露。
 */
import { describe, expect, it } from "vitest";
import {
  renderMessage,
  steerReceiptPhrase,
  type SteerReceiptState,
} from "./render.js";

const preempted: SteerReceiptState = {
  requested: true,
  result: "preempted",
  reason: "已终止旧回合（pid 4242，graceful，等待 12ms）并以 steer 信封续跑新回合",
  stopped: { pid: 4242, graceful: true, waitedMs: 12 },
  turn: { nonce: "wake-abcdef", startConfirmed: true },
};

const deferred: SteerReceiptState = {
  requested: true,
  result: "deferred-next-turn",
  reason: "引擎供给成员但当前无活唤醒回合——未执行终止，纠偏随本次投递送达",
};

const unsupported: SteerReceiptState = {
  requested: true,
  result: "unsupported",
  reason: "交互式会话无法被插件终止（steer 仅对引擎供给成员生效；中断交互式回合只有用户 Esc）——已降级为软中断",
};

describe("v0.9.8 S5：steerReceiptPhrase 三态", () => {
  it("【S5 锚点】preempted → ⛔ 抢占成功 + 终止实况 + 新回合两态 + 进度丢失披露", () => {
    const phrase = steerReceiptPhrase(preempted)!;
    expect(phrase).toContain("⛔ steer 抢占成功");
    expect(phrase).toContain("终止 pid 4242，graceful，等待 12ms");
    expect(phrase).toContain("纠偏是新回合首条指令");
    expect(phrase).toContain("新回合已启动（start-confirmed）");
    expect(phrase).toContain("未落盘进度可能丢失");
  });

  it("【S5 锚点】preempted + 未见启动证据 → 「已发起但未见启动证据」（不谎称起来了）", () => {
    const phrase = steerReceiptPhrase({
      ...preempted,
      turn: { nonce: "wake-abcdef", startConfirmed: false },
    })!;
    expect(phrase).toContain("新回合已发起但未见启动证据");
    expect(phrase).not.toContain("start-confirmed");
  });

  it("【S5 锚点】deferred → ⛔ 降级（未抢占），不写抢占成功", () => {
    const phrase = steerReceiptPhrase(deferred)!;
    expect(phrase).toContain("⛔ steer 降级（未抢占）");
    expect(phrase).not.toContain("抢占成功");
    expect(phrase).toContain("未执行终止");
  });

  it("【S5 锚点】unsupported → ⛔ 不支持抢占 + 「只有用户 Esc」指引", () => {
    const phrase = steerReceiptPhrase(unsupported)!;
    expect(phrase).toContain("⛔ steer 不支持抢占");
    expect(phrase).toContain("只有用户 Esc");
  });

  it("【S5 边界】无 steer（undefined）→ undefined（不渲染）", () => {
    expect(steerReceiptPhrase(undefined)).toBeUndefined();
  });
});

describe("v0.9.8 S5：renderMessage 的 steer 行", () => {
  it("【S5 锚点】wake + preempted → 投递行 + ⛔ steer 短语", () => {
    const line = renderMessage("msg-1234567890", "z", "b", "wake", undefined, true, undefined, preempted);
    expect(line).toContain("已发起唤醒（wake，非送达确认）");
    expect(line).toContain("⛔ steer 抢占成功");
  });

  it("【S5 锚点】mailbox + deferred（终止失败回退）→ 仅落邮箱行 + ⛔ 降级短语", () => {
    const line = renderMessage("msg-1234567890", "z", "b", "mailbox", "steer 终止失败（pid 4242 仍在存活）——未发起新回合", undefined, undefined, deferred);
    expect(line).toContain("仅落邮箱（未唤醒，pull 兜底）");
    expect(line).toContain("⛔ steer 降级（未抢占）");
    expect(line).toContain("steer 终止失败");
  });

  it("【S5 锚点】unsupported（交互式降级）→ 软中断投递行 + ⛔ 不支持短语", () => {
    const line = renderMessage("msg-1234567890", "z", "b", "mailbox", undefined, undefined, undefined, unsupported);
    expect(line).toContain("⛔ steer 不支持抢占");
    expect(line).toContain("只有用户 Esc");
  });

  it("【S5 边界】无 steer → 与 v0.9.7 逐字节一致（第八参数缺省）", () => {
    const withSteer = renderMessage("msg-1234567890", "z", "b", "wake", undefined, true, undefined, preempted);
    const without = renderMessage("msg-1234567890", "z", "b", "wake", undefined, true);
    expect(without).not.toContain("⛔");
    expect(withSteer.startsWith(without.slice(0, without.indexOf("。") + 1))).toBe(true);
  });
});
