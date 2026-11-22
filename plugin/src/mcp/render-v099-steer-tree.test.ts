/**
 * v0.9.9（组 W，E1）定向测试：**render.ts 的 steer 进程树披露短语**（方案 53-v099 E1）。
 *
 * 与 wake-v099-steer-tree.test.ts 的分工：那边测引擎侧（taskkill /T + 树枚举 + 审计），
 * 本文件测人可读面的措辞分流——三态（无树/全灭/有残存）与「不写全部终止当有残存」。
 */
import { describe, expect, it } from "vitest";
import { renderMessage, steerReceiptPhrase, steerTreePhrase, type SteerReceiptState } from "./render.js";

const preemptedWithTree: SteerReceiptState = {
  requested: true,
  result: "preempted",
  reason: "已终止旧回合（pid 4242，forced，等待 772ms，进程树 3 个（4242/37640/37644）全部终止）并以 steer 信封续跑新回合",
  stopped: { pid: 4242, graceful: false, waitedMs: 772, tree: [4242, 37640, 37644], treeSurvivors: [] },
  turn: { nonce: "wake-abcdef", startConfirmed: true },
};

describe("v0.9.9 E1：steerTreePhrase / steerReceiptPhrase 的进程树披露", () => {
  it("【E1 锚点】树全部终止 → 「进程树 N 个（pids）全部终止」", () => {
    expect(steerTreePhrase(preemptedWithTree)).toBe("进程树 3 个（4242/37640/37644）全部终止");
  });

  it("【E1 锚点】树内有残存 → 如实写「其中 M 个仍存活」（不假装整树死绝）", () => {
    const phrase = steerTreePhrase({
      ...preemptedWithTree,
      stopped: { pid: 4242, graceful: false, waitedMs: 772, tree: [4242, 37640], treeSurvivors: [37640] },
    });
    expect(phrase).toContain("进程树 2 个（4242/37640）");
    expect(phrase).toContain("其中 1 个仍存活（37640，强杀后未亡——请人工核查）");
    expect(phrase).not.toContain("全部终止");
  });

  it("【E1 边界】stopped 无 tree（注入 kill 未回树）→ 无树短语（不虚构披露）", () => {
    expect(steerTreePhrase(undefined)).toBeUndefined();
    expect(steerTreePhrase({
      requested: true,
      result: "preempted",
      reason: "已终止旧回合（pid 4242，graceful，等待 12ms）并以 steer 信封续跑新回合",
      stopped: { pid: 4242, graceful: true, waitedMs: 12 },
    })).toBeUndefined();
  });

  it("【E1 锚点】preempted 人可读行内联进程树披露（pid/forced/等待 + 树 + 新回合两态）", () => {
    const phrase = steerReceiptPhrase(preemptedWithTree)!;
    expect(phrase).toContain("⛔ steer 抢占成功");
    expect(phrase).toContain("终止 pid 4242，forced，等待 772ms");
    expect(phrase).toContain("进程树 3 个（4242/37640/37644）全部终止");
    expect(phrase).toContain("纠偏是新回合首条指令");
    expect(phrase).toContain("新回合已启动（start-confirmed）");
    expect(phrase).toContain("未落盘进度可能丢失");
    // renderMessage 主行同样带树披露。
    const line = renderMessage("msg-1234567890", "z", "b", "wake", undefined, true, undefined, preemptedWithTree);
    expect(line).toContain("进程树 3 个（4242/37640/37644）全部终止");
  });

  it("【E1 边界】无 tree 的 preempted 行与 v0.9.8 逐字节一致（树披露缺省不插入）", () => {
    const noTree: SteerReceiptState = {
      requested: true,
      result: "preempted",
      reason: "已终止旧回合（pid 4242，graceful，等待 12ms）并以 steer 信封续跑新回合",
      stopped: { pid: 4242, graceful: true, waitedMs: 12 },
      turn: { nonce: "wake-abcdef", startConfirmed: true },
    };
    expect(steerReceiptPhrase(noTree)).toBe(
      "⛔ steer 抢占成功（终止 pid 4242，graceful，等待 12ms）：旧回合已终止，纠偏是新回合首条指令；新回合已启动（start-confirmed）；旧回合未落盘进度可能丢失",
    );
  });
});
