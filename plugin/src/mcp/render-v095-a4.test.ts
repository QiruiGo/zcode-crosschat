/**
 * v0.9.5（A4/V094-06）：xc_relay / xc_message 主消息路径**文案如实**定向测试
 * （41-v095 方案 §一 组A A4）。
 *
 * 背景（40-v094验收.md §7.3.2 V094-06）：xc_relay 的 wake-skipped 回执仍写
 * "Message … delivered via mailbox."，note/mailboxOnlyNote 被整体丢弃——默认
 * XC_WAKE_ENABLED=false 下每次 xc_relay 都走此路径，用户可见承诺失实。
 * 修法：renderMessage 按 renderDeliveryOutcome 分流（mailbox → 仅落邮箱（未唤醒）；
 * duplicate → 未重发；wake → 已发起唤醒（非送达确认）），note 透传到人可读行与
 * payload `note` 字段。
 *
 * 方案验收原文：「wake 关闭时 relay 回执含『仅落邮箱（未唤醒）』，无『已送达』」。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolCore, type ToolCore, type ToolDeps } from "./core.js";
import { renderDeliveryOutcome, renderMessage } from "./render.js";
import { payloadOf, type ToolResult } from "./protocol.js";
import { writeSession } from "../core/registry.js";

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-relay-a4-"));
  stateRoot = join(workDir, ".crosschat");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function coreWith(env: NodeJS.ProcessEnv = {}): ToolCore {
  const deps: ToolDeps = { stateRoot, workspace: workDir, env };
  return createToolCore(deps);
}

async function hookRegister(core: ToolCore, conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

/** 人可读行 = content[0]（okResult 的第二个 text 块是 payload JSON，含机器字段名）。 */
function humanLine(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

describe("v0.9.5 A4：renderMessage 三态文案（纯函数）", () => {
  it("mailbox 态：写「仅落邮箱（未唤醒）」，无 delivered/已送达；note 透传进行尾", () => {
    const line = renderMessage("1a2b3c4d5e6f", "a", "b", "mailbox", "wake-disabled: 未开启（来源 env-default）——仅落邮箱（未唤醒）：消息未送达也未消费");
    expect(line).toContain("仅落邮箱（未唤醒");
    expect(line).toContain("Message 1a2b3c4d a → b");
    expect(line).toContain("wake-disabled");
    expect(line).not.toContain("delivered");
    expect(line).not.toContain("已送达");
    expect(line).not.toContain("已消费");
    // 无 note：仍写仅落邮箱（不裸奔）
    expect(renderMessage("1a2b3c4d5e6f", "a", "b", "mailbox")).toContain("仅落邮箱（未唤醒");
  });

  it("duplicate 态：写「未重发」（去重命中不是投递），无 delivered 宣称", () => {
    const line = renderMessage("1a2b3c4d5e6f", "a", "b", "duplicate");
    expect(line).toContain("未重发");
    expect(line).toContain("duplicate");
    expect(line).not.toContain("delivered");
    expect(line).not.toContain("已送达");
  });

  it("wake 态：写「已发起唤醒（非送达确认）」——不谎称送达（对齐 tools-team renderDeliveryOutcome）", () => {
    expect(renderMessage("1a2b3c4d5e6f", "a", "b", "wake")).toContain("已发起唤醒");
    expect(renderMessage("1a2b3c4d5e6f", "a", "b", "wake")).toContain("非送达确认");
    expect(renderMessage("1a2b3c4d5e6f", "a", "b", "wake")).not.toContain("已送达");
    // 与 tools-team.ts 同名函数措辞逐字一致（两处文案漂移锁定）
    expect(renderDeliveryOutcome("mailbox")).toBe("仅落邮箱（未唤醒，pull 兜底）");
    expect(renderDeliveryOutcome("wake")).toBe("已发起唤醒（wake，非送达确认）");
  });
});

describe("v0.9.5 A4：主消息路径端到端（wake 关闭 → 回执含仅落邮箱、payload 带 note）", () => {
  // 注：xc_relay 的队内轴路由到与本测试同一实现（tools-relay.ts registerRelay →
  // teamRelay.xc_message 的双轴编排），xc_message 是同一 handler 的 ToolCore 直入面
  // ——文案与 payload 断言对两个入口同值。
  it("【方案验收锚点】wake 关闭（默认档，交互式成员）→ 文本含「仅落邮箱（未唤醒）」、无「已送达/delivered」；payload.note = mailboxOnlyNote 原文", async () => {
    const core = coreWith({}); // 无 XC_WAKE_ENABLED → 交互式成员按默认 false → wake-skipped
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");

    const res = await core.xc_message({ to: "b", msg: "检查一下 t1 的验收标准" }, "conn-a");
    expect(res.isError).toBeUndefined();
    const line = humanLine(res);
    expect(line).toContain("仅落邮箱（未唤醒");
    expect(line).not.toContain("已送达");
    expect(line).not.toContain("已消费");
    // 人可读行不再有 "delivered via mailbox" 谎话（payload 的机器字段 `delivered` 不算文案）
    expect(line).not.toContain("delivered");
    // payload：delivered=mailbox（机器可读字段）+ note 透传（mailboxOnlyNote 原文）
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("mailbox");
    const note = String(payload["note"]);
    expect(note).toContain("仅落邮箱（未唤醒）：消息未送达也未消费");
    expect(note).toContain("xc_read({scope:\"inbox\"})"); // pull 兜底路径在 note 里
    expect(note).toContain("wake-disabled");
  });

  it("urgent 标记与 note 并存不冲突（urgent 不改变 mailbox 态的如实文案）", async () => {
    const core = coreWith({});
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");

    const res = await core.xc_message({ to: "b", msg: "urgent 提醒", urgent: true }, "conn-a");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(humanLine(res)).toContain("仅落邮箱（未唤醒");
    expect(payload["delivered"]).toBe("mailbox");
    expect(payload["urgent"]).toBe(true);
    expect(String(payload["note"])).toContain("仅落邮箱（未唤醒）：消息未送达也未消费");
  });

  it("duplicate 去重命中 → 文本写「未重发」、payload.duplicate=true", async () => {
    const core = coreWith({});
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    await core.xc_message({ to: "b", msg: "重复内容" }, "conn-a");
    const res = await core.xc_message({ to: "b", msg: "重复内容" }, "conn-a");
    expect(res.isError).toBeUndefined();
    const line = humanLine(res);
    expect(line).toContain("未重发");
    expect(line).not.toContain("delivered");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["duplicate"]).toBe(true);
    expect(payload["note"]).toBeUndefined(); // duplicate 无 note
  });
});
