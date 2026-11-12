/**
 * 预算接入防回归单测（v0.5.1，预算修复员组）：
 *
 * - SCALE-1（裁决 #18，P1）：xc_check_inbox 批量消费无批次预算截断——300 条积压
 *   单次直灌 201,193 字符且无指针。修复 = 批次窗口（到达序前缀、JSON 面+信封面
 *   联合成本 ≤ budget.total、保底一条），窗口外消息保持未读，摘要行/JSON payload/
 *   信封尾行三处给「再调一次 xc_check_inbox」指针。
 * - SCALE-2（裁决 #19，P2）：xc_claim 全文回显 600KB prompt（600,234 字符响应）。
 *   修复 = prompt/acceptance 接入 item 预算截断 + promptTruncated{shown,total,sha256}
 *   + xc_task_read 分页指针（team.json 真源全文不动）。
 * - CONC-2 工具层腿（裁决 #7，P1）：≥10MiB 队内消息磁盘保真入队（传输层腿见
 *   transport/mcpstdio.test.ts——大帧拒收不杀进程）。
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { payloadOf } from "./protocol.js";
import { createToolCore, TaskReadShape, type ToolCore } from "./tools.js";
import { writeSession } from "../core/registry.js";
import { readMailbox } from "../core/mailbox.js";
import { readTeam } from "../core/teamstate.js";
import { inboxFile } from "../core/paths.js";
import { sha256Of } from "../core/msgstore.js";
import type { ToolResult } from "./protocol.js";

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-inj-budget-"));
  stateRoot = join(workDir, ".crosschat");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function coreWith(env: NodeJS.ProcessEnv = {}): ToolCore {
  return createToolCore({ stateRoot, workspace: workDir, env });
}

/** 注册辅助：模拟 SessionStart 钩子落盘 sessions/<sid>.json 后走 hook 路径。 */
async function hookRegister(core: ToolCore, conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

interface InboxPayload {
  messages: Array<{ id: string; content: string; contentTruncated?: { shown: number; total: number } }>;
  unreadCount: number;
  batchTruncated?: boolean;
  batchTotalUnread?: number;
  batchBudgetChars?: number;
}

describe("SCALE-1: xc_check_inbox 批次窗口（批量消费接入注入预算）", () => {
  it("40 条积压 + 小批次预算：单次只消费窗口前缀、响应有界、三处指针、其余保持未读", async () => {
    const core = coreWith({ XC_INJECT_ITEM_CHARS: "400", XC_INJECT_TOTAL_CHARS: "1500" });
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    for (let i = 0; i < 40; i += 1) {
      await core.xc_message({ to: "b", content: `msg-${String(i).padStart(2, "0")}-${"x".repeat(40)}` }, "conn-a");
    }

    const res = await core.xc_check_inbox({}, "conn-b");
    const payload = payloadOf(res) as unknown as InboxPayload;
    // 窗口前缀：cost≈(JSON面+信封面)≈500×N ≤ 1500 → 恰 3 条（保底纪律防 0）
    expect(payload.messages.length).toBeGreaterThanOrEqual(1);
    expect(payload.messages.length).toBeLessThan(40);
    expect(payload.batchTruncated).toBe(true);
    expect(payload.batchTotalUnread).toBe(40);
    expect(payload.unreadCount).toBe(40 - payload.messages.length);

    // 响应整体有界（两块文本 + JSON payload 全算上）
    const budgetTotal = 1500;
    expect(textOf(res).length).toBeLessThan(budgetTotal + 600);

    // 三处分页指针：摘要行、JSON payload、信封块尾行
    expect(res.content[0]?.text).toContain("xc_check_inbox");
    expect(res.content[0]?.text).toContain("注入预算");
    expect(textOf(res)).toContain("xc_check_inbox 继续消费");

    // 磁盘真源：40 行都在；窗口外消息保持未读（readAt 不盖章）
    const disk = await readMailbox(stateRoot, "default", "b");
    expect(disk).toHaveLength(40);
    const readCount = disk.filter((m) => m.readAt !== undefined).length;
    expect(readCount).toBe(payload.messages.length);
    // 到达序前缀：本批返回的是最老的若干条
    expect((payload.messages[0]?.content ?? "").startsWith("msg-00-")).toBe(true);

    // 连续消费直到排空：批间不重叠，总量对账 40/40
    const seen = new Set<string>(payload.messages.map((m) => m.id));
    let last = res;
    for (let guard = 0; guard < 40 && seen.size < 40; guard += 1) {
      last = await core.xc_check_inbox({}, "conn-b");
      const batch = payloadOf(last) as unknown as InboxPayload;
      for (const m of batch.messages) {
        expect(seen.has(m.id)).toBe(false); // 不重复注入
        seen.add(m.id);
      }
    }
    expect(seen.size).toBe(40);
    // 排空后再拉一次：空批、无批次截断字段
    const drained = payloadOf(await core.xc_check_inbox({}, "conn-b")) as unknown as InboxPayload;
    expect(drained.unreadCount).toBe(0);
    expect(drained.batchTruncated).toBeUndefined();
    expect(drained.messages).toHaveLength(0);
  });

  it("默认预算下小批量（3 条）行为不变：一次全消费、无 batchTruncated 字段", async () => {
    const core = coreWith();
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    for (let i = 0; i < 3; i += 1) {
      await core.xc_message({ to: "b", content: `short-${i}` }, "conn-a");
    }
    const res = await core.xc_check_inbox({}, "conn-b");
    const payload = payloadOf(res) as unknown as InboxPayload;
    expect(payload.messages).toHaveLength(3);
    expect(payload.batchTruncated).toBeUndefined();
    expect(payload.unreadCount).toBe(0);
    expect(payload.messages[0]?.content).toBe("short-0");
  });

  it("保底一条：单条超批次预算也返回（item 截断兜住单条上限）", async () => {
    const core = coreWith({ XC_INJECT_ITEM_CHARS: "300", XC_INJECT_TOTAL_CHARS: "200" });
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    const bigText = "B".repeat(5000);
    await core.xc_message({ to: "b", content: bigText }, "conn-a");

    const res = await core.xc_check_inbox({}, "conn-b");
    const payload = payloadOf(res) as unknown as InboxPayload;
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]?.content.length).toBeLessThanOrEqual(300);
    expect(payload.messages[0]?.contentTruncated).toEqual({ shown: 299, total: 5000 });
    // 单条消息超预算不算批次截断（全部现行消息都已在本批）
    expect(payload.batchTruncated).toBeUndefined();
    // 磁盘全文不动
    const disk = (await readMailbox(stateRoot, "default", "b")).find((m) => m.id === payload.messages[0]?.id);
    expect(disk?.content).toBe(bigText);
  });
});

describe("SCALE-2: xc_claim 回显接入注入预算（prompt/acceptance 截断 + xc_task_read 指针）", () => {
  it("600KB prompt 认领：响应有界、promptTruncated{shown,total,sha256}、真源全文不动、分页可拼回", async () => {
    const core = coreWith();
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    const prompt = "P".repeat(600_000);
    // v0.5.1（故障注-5 修复后）：任务 id 为 <era>-t<n> 形态，从派发回执动态取。
    const dispatched = payloadOf(await core.xc_dispatch({ to: "b", title: "big-prompt", prompt }, "conn-a")) as {
      taskId: string;
    };
    const taskId = dispatched.taskId;

    const res = await core.xc_claim({ taskId }, "conn-b");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as {
      taskId: string;
      prompt: string;
      promptTruncated?: { shown: number; total: number; sha256: string };
      promptPointer?: string;
      attemptId: string;
    };
    // 响应不再逐字节回显 600KB（红队实测 600,234 字符）
    expect(textOf(res).length).toBeLessThan(20_000);
    expect(payload.prompt.length).toBeLessThan(600_000);
    expect(payload.promptTruncated).toEqual({
      shown: 3999,
      total: 600_000,
      sha256: sha256Of(prompt),
    });
    expect(payload.promptPointer).toBe("xc_task_read");

    // 磁盘真源（team.json）全文不动（R-21）
    const team = await readTeam(stateRoot, "default");
    const task = team?.tasks.find((t) => t.id === taskId);
    expect(task?.prompt).toBe(prompt);

    // 指针可走通：xc_task_read 分页拼回全文 sha256 相等
    let offset = 0;
    let joined = "";
    for (let guard = 0; guard < 200; guard += 1) {
      const page = payloadOf(await core.xc_task_read({ taskId, field: "prompt", offset }, "conn-b")) as {
        total: number;
        offset: number;
        text: string;
        hasMore: boolean;
      };
      joined += page.text;
      if (!page.hasMore) break;
      offset = page.offset + page.text.length;
    }
    expect(joined).toBe(prompt);
    expect(joined.length).toBe(payload.promptTruncated?.total);
  });

  it("acceptance 超预算同样截断；未超预算时 payload 与 v0.5.0 形状一致（无截断字段）", async () => {
    const core = coreWith({ XC_INJECT_ITEM_CHARS: "500" });
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    const acceptance = "A".repeat(4000);
    const dispatched = payloadOf(await core.xc_dispatch({ to: "b", title: "with-acc", prompt: "short prompt", acceptance }, "conn-a")) as {
      taskId: string;
    };
    const taskId = dispatched.taskId;

    const res = await core.xc_claim({ taskId }, "conn-b");
    const payload = payloadOf(res) as {
      prompt: string;
      acceptance: string;
      acceptanceTruncated?: { shown: number; total: number; sha256: string };
      acceptancePointer?: string;
      promptTruncated?: unknown;
    };
    expect(payload.prompt).toBe("short prompt");
    expect(payload.promptTruncated).toBeUndefined();
    expect(payload.acceptance.length).toBeLessThanOrEqual(500);
    expect(payload.acceptanceTruncated).toEqual({ shown: 499, total: 4000, sha256: sha256Of(acceptance) });
    expect(payload.acceptancePointer).toBe("xc_task_read");

    // 新枚举值可分页取回 acceptance 全文
    const page = payloadOf(await core.xc_task_read({ taskId, field: "acceptance" }, "conn-b")) as {
      total: number;
      text: string;
      hasMore: boolean;
    };
    expect(page.total).toBe(4000);
    expect(page.text).toBe(acceptance.slice(0, page.text.length));
    expect(page.hasMore).toBe(true);
  });

  it("TaskReadShape 接受 acceptance 枚举值（schema 面回归锁定）", () => {
    expect(z.object(TaskReadShape).safeParse({ taskId: "t1", field: "acceptance" }).success).toBe(true);
    expect(z.object(TaskReadShape).safeParse({ taskId: "t1", field: "title" }).success).toBe(false);
  });
});

describe("CONC-2 工具层腿：≥10MiB 队内消息磁盘保真入队（传输层腿见 transport/mcpstdio.test.ts）", () => {
  it("12MiB content 的 xc_message（红队自退出档位）→ delivered 且磁盘行全文保真", async () => {
    const core = coreWith();
    await hookRegister(core, "conn-a", "a", "sess-a");
    await hookRegister(core, "conn-b", "b", "sess-b");
    const big = "X".repeat(12 * 1024 * 1024) + "-END-MARKER";

    const res = await core.xc_message({ to: "b", content: big }, "conn-a");
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain("delivered via mailbox");

    // 磁盘真源逐字节保真（README「磁盘态任意大文件可入队」承诺）
    const raw = await readFile(inboxFile(stateRoot, "default", "b"), "utf8");
    expect(raw).toContain("-END-MARKER");
    expect(raw.length).toBeGreaterThan(12 * 1024 * 1024);

    // 消费面：注入预算单条截断 + 指针，磁盘仍全文
    const inbox = await core.xc_check_inbox({}, "conn-b");
    const payload = payloadOf(inbox) as { messages: Array<{ content: string; contentTruncated?: { total: number } }> };
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]?.content.length).toBeLessThanOrEqual(4000);
    expect(payload.messages[0]?.contentTruncated?.total).toBe(big.length);
  });
});
