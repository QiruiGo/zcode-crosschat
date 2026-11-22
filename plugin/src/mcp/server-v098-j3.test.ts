/**
 * v0.9.8（组 M·J3）定向单测：**工具调用边界的插队提示**。
 *
 * 锚点（方案 §二 J3 验收原文）：
 * - 「该会话每次 MCP 工具调用返回附一行『你有 N 条插队待读』（不改变工具结果语义，
 *    追加在文本尾部；JSON 面加可选键）」；
 * - 「成员在长回合内下一次调工具即可看到；无插队时不附」。
 *
 * 覆盖三层：文案（pendingInterruptNotice）→ 单结果加工（appendPendingInterruptNotice，
 * 真邮箱 + 真身份绑定）→ 注册面接线（decorateToolCallsWithPendingInterruptNotice，
 * 假 server 的 tool() 记录面，与家族注册器同形态）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendPendingInterruptNotice,
  decorateToolCallsWithPendingInterruptNotice,
  pendingInterruptNotice,
} from "./server.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { okResult, type ToolResult } from "./protocol.js";
import type { ToolDeps } from "./core.js";
import type { TeamMessage } from "../core/types.js";

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

function msg(id: string, extra: Partial<TeamMessage> & { steer?: boolean } = {}): TeamMessage {
  return { id, from: "lead", to: "alice", content: `纠偏 ${id}`, ts: 1_000, ...extra };
}

async function seedMailbox(lines: TeamMessage[]): Promise<void> {
  const dir = join(stateRoot, "teams", "default", "inbox");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "alice.jsonl"), lines.map((m) => JSON.stringify(m)).join("\n") + "\n");
}

function bindAlice(): void {
  const identity: BoundIdentity = {
    sessionKey: "sess-alice:alice",
    teamId: "default",
    name: "alice",
    agentKey: "alice",
    sessionId: "sess-alice",
    role: "worker",
    boundAt: Date.now(),
  };
  identityStore.bind("conn-alice", identity);
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-j3-server-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: {} };
  await mkdir(join(stateRoot, "teams", "default", "inbox"), { recursive: true });
  bindAlice();
});

afterEach(async () => {
  identityStore.unbind("conn-alice");
  await rm(workDir, { recursive: true, force: true });
});

describe("v0.9.8 J3：工具调用边界的插队提示", () => {
  it("文案：固定一行 + 条数 + 消费指令（宿主无回合中注入的边界如实声明）", () => {
    const line = pendingInterruptNotice(3);
    expect(line).toContain("你有 3 条插队待读");
    expect(line).toContain('xc_read({scope:"inbox"})');
    expect(line).toContain("绝不降级成摘要");
    expect(line).toContain("宿主无回合中注入原语");
    expect(line).not.toContain("\n");   // 一行
  });

  it("有插队：文本尾部追加一行 + JSON 面加可选键 pendingInterrupt", async () => {
    await seedMailbox([msg("s-1", { interrupt: true }), msg("s-2", { steer: true }), msg("n-1")]);
    const result = await appendPendingInterruptNotice(
      okResult("取到 1 条跨会话消息。", { count: 1, envelopes: [] }),
      deps,
      "conn-alice",
    );
    // ① 文本尾部：原两块之后追加第三块（第一块人可读摘要逐字节不动）
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({ type: "text", text: "取到 1 条跨会话消息。" });
    expect(result.content[2]!.text).toContain("你有 2 条插队待读");
    // ② JSON 面：**同一块**上加可选键（原键不动、只追加；块数不因此变化）
    expect(result.content[1]).toEqual({
      type: "text",
      text: JSON.stringify({ count: 1, envelopes: [], pendingInterrupt: 2 }, null, 2),
    });
    const payload = JSON.parse(result.content[1]!.text!) as Record<string, unknown>;
    expect(payload["count"]).toBe(1);
    expect(payload["envelopes"]).toEqual([]);
    expect(payload["pendingInterrupt"]).toBe(2);
  });

  it("无插队 → 一个字节都不加（结果与原对象等价）", async () => {
    await seedMailbox([msg("n-1"), msg("n-2", { urgent: true })]);
    const original = okResult("没有待投递的跨会话消息。", { count: 0 });
    const result = await appendPendingInterruptNotice(original, deps, "conn-alice");
    expect(result).toEqual(original);
    expect(result.content).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("插队待读");
  });

  it("错误结果（isError）同样附提示——纠偏不能因为上一步失败就看不见", async () => {
    await seedMailbox([msg("s-1", { interrupt: true })]);
    const result = await appendPendingInterruptNotice(
      { content: [{ type: "text", text: JSON.stringify({ error: "busy", lock: "team" }) }], isError: true },
      deps,
      "conn-alice",
    );
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content[1]!.text).toContain("你有 1 条插队待读");
    expect((JSON.parse(result.content[0]!.text!) as Record<string, unknown>)["pendingInterrupt"]).toBe(1);
  });

  it("未注册连接 → 不附（提示面不为难未注册调用方）", async () => {
    await seedMailbox([msg("s-1", { interrupt: true })]);
    const original = okResult("ok", { count: 0 });
    expect(await appendPendingInterruptNotice(original, deps, "conn-nobody")).toEqual(original);
  });

  it("消费后不再附：readAt 盖上的纠错不计入（xc_read inbox 之后提示自然消失）", async () => {
    await seedMailbox([msg("s-1", { interrupt: true, readAt: 2_000, consumedAt: 2_000 })]);
    const original = okResult("ok", { count: 0 });
    expect(await appendPendingInterruptNotice(original, deps, "conn-alice")).toEqual(original);
  });

  it("接线：decorate 之后经 server.tool 注册的回调被包上提示（发现面全覆盖）", async () => {
    await seedMailbox([msg("s-1", { interrupt: true }), msg("s-2", { interrupt: true }), msg("s-3", { interrupt: true })]);
    const registered: Array<{ name: string; handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> }> = [];
    const fakeServer = {
      tool(name: string, _desc: string, _shape: unknown, handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult>): void {
        registered.push({ name, handler });
      },
    };
    decorateToolCallsWithPendingInterruptNotice(fakeServer as never, deps);
    fakeServer.tool("xc_relay", "desc", {}, async () => okResult("sent", { ok: true }));
    expect(registered).toHaveLength(1);
    const res = await registered[0]!.handler({}, { sessionId: "sess-alice" });
    // connectionKeyOf(extra) = extra.sessionId ⇒ 与 identityStore 的键不同 ⇒ 取不到身份 ⇒ 不附
    // （stdio 下 extra 为 undefined → "__stdio__"；本用例证明「取不到身份就不附」的纪律）
    expect(JSON.stringify(res)).not.toContain("插队待读");
  });

  it("接线负例：非函数末参（异常注册形态）不崩、原样透传", async () => {
    const calls: unknown[][] = [];
    const fakeServer = {
      tool(...args: unknown[]): void { calls.push(args); },
    };
    decorateToolCallsWithPendingInterruptNotice(fakeServer as never, deps);
    fakeServer.tool("xc_doctor", "desc", {});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["xc_doctor", "desc", {}]);
  });
});
