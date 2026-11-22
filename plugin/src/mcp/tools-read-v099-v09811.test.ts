/**
 * v0.9.9（V098-11，P3）定向测试：**行为级**验收「积压场景下 steer 全文置顶、
 * 普通消息让位」——驱动生产路径（xc_read scope:inbox 的消费窗口）。
 *
 * 与 core/budget-v099-v09811.test.ts 的分工：那件守「layoutInjectBlocks 优先级面
 * 已删」（死代码不复辟）；本件守「纠错置顶的行为承诺仍成立」——承诺的真实实现处
 * 是 mcp/tools-read.ts 的 xc_check_inbox（interruptFirst 排序 + 批次窗口先给纠错
 * 面开窗、普通面用剩余预算），不是被删掉的 layout 分支。
 *
 * steer 的落盘形态 = `interrupt:true`（v0.9.9 V098-09 写死：写入侧 steer⇒interrupt，
 * 邮箱行无 steer 键）——故本测试用 interrupt 消息代表「一条 steer 请求」。
 *
 * 全部驱动真邮箱文件、真预算 env、真团队状态。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRead } from "./tools-read.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { payloadOf, type ToolResult } from "./protocol.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import type { ToolDeps } from "./core.js";
import type { TeamMember } from "../core/types.js";

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

function member(key: string, sid: string): TeamMember {
  return { key, sessionId: sid, role: "worker", joinedAt: 1, lastSeen: 1 };
}

function bind(name: string, conn: string, sid: string): void {
  const identity: BoundIdentity = {
    sessionKey: `${sid}:${name}`,
    teamId: "default",
    name,
    agentKey: name,
    sessionId: sid,
    role: "peer",
    boundAt: Date.now(),
  };
  identityStore.bind(conn, identity);
}

async function inbox(conn = "conn-bob"): Promise<{
  messages: Array<Record<string, unknown>>;
  unreadCount: number;
  batchTruncated?: boolean;
  text: string;
}> {
  const res: ToolResult = await handleRead(deps, { scope: "inbox" }, conn);
  expect(res.isError).toBeFalsy();
  const payload = payloadOf(res) as {
    messages: Array<Record<string, unknown>>;
    unreadCount: number;
    batchTruncated?: boolean;
  };
  return {
    messages: payload.messages,
    unreadCount: payload.unreadCount,
    ...(payload.batchTruncated !== undefined ? { batchTruncated: payload.batchTruncated } : {}),
    text: (res.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n"),
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v099-v09811-"));
  stateRoot = join(workDir, ".crosschat");
  // 小批次预算：10 条 × ~1500 字符的普通积压装不进 9000 ⇒ 必然有「让位」。
  deps = { stateRoot, workspace: workDir, env: { XC_INJECT_ITEM_CHARS: "4000", XC_INJECT_TOTAL_CHARS: "9000" } };
  await mkdir(join(stateRoot, "teams", "default", "inbox"), { recursive: true });
  const team = newTeamState({
    teamId: "default",
    founderKey: "alice",
    now: 1,
    founder: member("alice", "sess-alice"),
  });
  team.members.push(member("bob", "sess-bob"));
  team.members.push(member("carol", "sess-carol"));
  await writeTeam(stateRoot, team);
  bind("alice", "conn-alice", "sess-alice");
  bind("bob", "conn-bob", "sess-bob");
  bind("carol", "conn-carol", "sess-carol");
});

afterEach(async () => {
  for (const conn of ["conn-alice", "conn-bob", "conn-carol"]) identityStore.unbind(conn);
  await rm(workDir, { recursive: true, force: true });
});

describe("v0.9.9 V098-11：积压场景 steer（落盘为 interrupt）全文置顶、普通消息让位", () => {
  it("10 条普通积压 + 1 条后到的纠错 → 纠错第一条且全文；普通条被预算留在箱外", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      const normal = createMessage("carol", "bob", `普通积压 ${i} ${"x".repeat(1500)}`);
      await appendMailbox(stateRoot, "default", "bob", { ...normal, ts: now + i });
    }
    // steer 请求的落盘形态：interrupt:true（写入侧 steer⇒interrupt）；最后到达（ts 最大）。
    const correction = createMessage("alice", "bob", "纠偏：别动 site-a 的生产配置", { interrupt: true });
    await appendMailbox(stateRoot, "default", "bob", { ...correction, ts: now + 100 });

    const result = await inbox();
    // ① 置顶：第一条就是纠错（它到达序最后——置顶来自优先级，不是新近度）
    expect(result.messages[0]!["id"]).toBe(correction.id);
    // ② 全文：未被 item 截断（无 contentTruncated 键）、信封面第一块也是它
    expect(result.messages[0]!["contentTruncated"]).toBeUndefined();
    expect(String(result.messages[0]!["content"])).toContain("纠偏：别动 site-a 的生产配置");
    expect(result.text.indexOf("纠偏：别动 site-a 的生产配置")).toBeGreaterThanOrEqual(0);
    // ③ 让位：普通条装不进 9000 ⇒ 有剩余未读，且箱里剩下的都是普通条
    expect(result.unreadCount).toBeGreaterThan(0);
    expect(result.batchTruncated).toBe(true);
    const left = (await readMailbox(stateRoot, "default", "bob")).filter((m) => m.readAt === undefined);
    expect(left.some((m) => m.id === correction.id)).toBe(false);
    expect(left.length).toBe(result.unreadCount);
    expect(left.every((m) => m.id !== correction.id)).toBe(true);
  });

  it("极端让位：纠错单独吃满批次预算 ⇒ 普通面只剩保底第一条，其余全部留箱", async () => {
    // 300 字符总预算：纠错一项就超支（保底第一条仍进），普通面剩余预算 0。
    deps = { stateRoot, workspace: workDir, env: { XC_INJECT_ITEM_CHARS: "250", XC_INJECT_TOTAL_CHARS: "300" } };
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      const normal = createMessage("carol", "bob", `普通 ${i}`);
      await appendMailbox(stateRoot, "default", "bob", { ...normal, ts: now + i });
    }
    const correction = createMessage("alice", "bob", "纠偏：立刻停手", { interrupt: true });
    await appendMailbox(stateRoot, "default", "bob", { ...correction, ts: now + 100 });

    const result = await inbox();
    // ① 纠错仍排第一（置顶来自优先级，不是新近度）
    expect(result.messages[0]!["id"]).toBe(correction.id);
    // ② 普通面预算 0：batchWindowCount 的「保底第一条」纪律仍放进 1 条普通消息
    //    （消费面不零消费），其余 4 条全部让位（保持未读，下批继续）。
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]!["id"]).not.toBe(correction.id);
    expect(result.unreadCount).toBe(4);
    expect(result.batchTruncated).toBe(true);
    const left = (await readMailbox(stateRoot, "default", "bob")).filter((m) => m.readAt === undefined);
    expect(left.length).toBe(4);
    expect(left.some((m) => m.id === correction.id)).toBe(false);
  });

  it("无纠错时与 v0.9.7 等价：按 urgent-first 前缀开窗（优先级面缺席不改变普通路径）", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      const normal = createMessage("carol", "bob", `普通 ${i}`);
      await appendMailbox(stateRoot, "default", "bob", { ...normal, ts: now + i });
    }
    const result = await inbox();
    expect(result.messages.map((m) => String(m["content"]))).toEqual(["普通 0", "普通 1", "普通 2"]);
    expect(result.unreadCount).toBe(0);
    expect(result.batchTruncated).toBeUndefined();
  });
});
