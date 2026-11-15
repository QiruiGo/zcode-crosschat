/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T5）：xc_read —— 统一分页读（6 个 scope）。
 *
 * 统一六个 scope 的读面（v0.6 收敛时合并五个旧读面工具；行为不改，只换入口；
 * 预算与分页口径全部沿用 core/budget.ts 的现行常数）：
 * | scope     | 消费性 | 说明 |
 * | inbox     | 消费   | urgent 消息排最前（C1 读取序，core/mailbox.urgentFirst）；坏行跳过+审计；批量按注入预算开窗 |
 * | mail      | 只读   | 邮箱历史单件分页（offset/limit 语义原样）|
 * | task      | 只读   | team.json 任务字段分页；field 缺省 result |
 * | peer      | 消费   | 跨会话队列排空；count=本次真实呈现数；urgent 优先 |
 * | peer-msg  | 只读   | 跨会话单件分页 |
 * | journal   | （新，C4）       | 只读   | id=<taskId> → tasks/<taskId>/journal.md；id="archive:<name>" → archive/<name>/journal.md |
 *
 * core 层方法名保留 v0.5.3 内部形态（旧测试直接驱动，非 MCP 工具名，不在 v0.7
 * 旧名移除范围）；v0.6 变化仅两处：邮箱哈希链校验砍除（§2.2 行 1）与 inbox
 * 读取序 urgent-first（C1 数据面，core/mailbox.ts urgentFirst）。
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { invalidParamsError, okResult, ToolError, type ToolResult } from "./protocol.js";
import { renderInbox } from "./render.js";
import { identityStore } from "./identity.js";
import { withTeamLock } from "../core/lock.js";
import { sanitizeKey } from "../core/sanitize.js";
import { getTask, readTeam } from "../core/teamstate.js";
import {
  acknowledgeMailbox,
  classifyFrame,
  discardMailboxMessages,
  isCurrentMail,
  readCurrentMailboxLocked,
  readMailbox,
  readUnreadMailbox,
  urgentFirst,
  type MailboxReadDiagnostics,
} from "../core/mailbox.js";
import { gateToolRequestRender, type ToolGateContext, type ToolGateRenderResult } from "../core/toolgate.js";
import { parseToolFrameType } from "../core/toolrelay.js";
import type { TeamMessage, TeamState } from "../core/types.js";
import { logEngineEvent } from "../core/log.js";
import {
  batchWindowCount,
  contextCharsFromEnv,
  layoutInjectBlocks,
  paginateText,
  receiverInjectBudget,
  truncateField,
  truncateNote,
  type LayoutResult,
} from "../core/budget.js";
import {
  isTeamEnvelopeRendered,
  queueItemToInjectBlock,
  renderPeerEnvelope,
  renderTeamEnvelope,
} from "../core/peerenvelope.js";
import { sha256Of } from "../core/msgstore.js";
import { peerRootFromEnv } from "../core/peerdir.js";
import { logPeerEvent } from "../core/peerregistry.js";
import { archiveJournalPath, taskJournalPath } from "../core/archive.js";
import { getPeerServices } from "./peer-services.js";
import type { ToolDeps } from "./core.js";
import { runCore } from "./core.js";

// ---------------------------------------------------------------------------
// zod 入参 schema（§1.2 T5）
// ---------------------------------------------------------------------------

export const ReadShape = {
  scope: z.enum(["inbox", "mail", "task", "peer", "peer-msg", "journal"])
    .describe("inbox=读并消费本队邮箱；mail=邮箱历史单件分页；task=任务字段分页；peer=拉取跨会话消息（消费）；peer-msg=跨会话单件分页；journal=任务/留档日志"),
  id: z.string().optional().describe("mail/peer-msg=消息 id；task=任务 id；journal=任务 id 或 \"archive:<成员名>\""),
  field: z.enum(["result", "error", "prompt", "acceptance"]).optional().describe("仅 scope=task：要分页读的字段"),
  offset: z.number().int().min(0).optional().describe("起始偏移/条"),
  limit: z.number().int().min(1).optional().describe("本次返回上限（字符或条，随 scope）"),
} as const;

export type ReadArgs = {
  scope: "inbox" | "mail" | "task" | "peer" | "peer-msg" | "journal";
  id?: string;
  field?: "result" | "error" | "prompt" | "acceptance";
  offset?: number;
  limit?: number;
};

export interface MailboxReadCore {
  xc_check_inbox(args: Record<string, never>, connectionKey: string): Promise<ToolResult>;
  xc_mail_read(args: { messageId: string; offset?: number; limit?: number }, connectionKey: string): Promise<ToolResult>;
  xc_task_read(args: { taskId: string; field: "result" | "error" | "prompt" | "acceptance"; offset?: number; limit?: number }, connectionKey: string): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// inbox 共用件（原 tools.ts 1:1 平移）
// ---------------------------------------------------------------------------

/** 当前未读（未读 ∧ 未丢弃 ∧ isCurrentMail）计数，xc_overview 与 inbox 共用。 */
export function countUnread(team: TeamState, messages: TeamMessage[]): number {
  return messages.filter((m) => !m.readAt && !m.discardedAt && isCurrentMail(team, m)).length;
}

/**
 * v0.5.1（SCALE-1 修复）：inbox 消费单条消息在本响应两个面的形态与成本——
 * `entry` = content[1] JSON payload 的逐条对象；`block` = content[2] 的信封块；
 * `cost` = 两个面的字符成本之和（批次窗口记账用）。磁盘 JSONL 全文不动。
 *
 * v0.7（C6，DESIGN-V0.7 §2.7）：`gate` 在场（tool_request 帧过了审批门）时，
 * 两个面都以门的渲染文本为准——遮蔽占位或「APPROVAL VERIFIED」头+全文；
 * 原始帧全文不进注入面（mail scope 的原文旁路同理由本 scope 的分页门修掉）。
 */
function inboxEntry(
  m: TeamMessage,
  budgetItem: number,
  gate?: ToolGateRenderResult,
): { entry: Record<string, unknown>; block: string; cost: number; truncated: boolean } {
  const source = gate?.text ?? m.content;
  const cut = truncateField(source, budgetItem, sha256Of);
  const entry: Record<string, unknown> = {
    ...m,
    content: cut.text,
    ...(cut.truncated
      ? {
          contentTruncated: { shown: cut.truncated.shown, total: cut.truncated.total },
          contentPointer: "xc_read",
        }
      : {}),
    ...(gate !== undefined
      ? {
          toolGate: {
            gate: gate.gate,
            ...(gate.requestId !== undefined ? { requestId: gate.requestId } : {}),
            ...(gate.state !== undefined ? { state: gate.state } : {}),
            ...(gate.reason !== undefined ? { reason: gate.reason } : {}),
          },
        }
      : {}),
  };
  let block: string;
  if (isTeamEnvelopeRendered(source)) {
    block = source; // 幂等守卫：已包裹原样返回
  } else {
    const body = cut.text + (cut.truncated ? `\n${truncateNote("mail", m.id, cut.truncated.shown, cut.truncated.total)}` : "");
    const cls = classifyFrame(m.content);
    block = renderTeamEnvelope({
      frameType: cls.kind === "frame" ? cls.frameType : "chat",
      from: m.from,
      content: body,
      ...(m.origin !== undefined ? { origin: m.origin } : {}),
    });
  }
  return { entry, block, cost: JSON.stringify(entry).length + block.length, truncated: cut.truncated !== undefined };
}

export function createMailboxReadCore(deps: ToolDeps): MailboxReadCore {
  const { stateRoot } = deps;
  return {
    async xc_check_inbox(_args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityStore.require(connectionKey);
        const now = Date.now();

        const teamBefore = await readTeam(stateRoot, me.teamId);
        if (teamBefore === undefined) {
          return okResult(renderInbox(0, 0, 0), { messages: [], unreadCount: 0 });
        }

        // 收件箱消费走 team 锁：锁内用 readCurrentMailboxLocked（陈旧消息就地
        // discarded 落盘并剔除），正当消息此刻即消费（acknowledgeMailbox，§2.8）。
        // v0.6（C1 读取序）：呈现序 urgent-first（物序不动——JSONL 追加真源纪律）。
        const diagnostics: MailboxReadDiagnostics = { malformed: [], discarded: 0 };
        const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
        const consumed = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = (await readTeam(stateRoot, me.teamId)) ?? teamBefore;
          const current = await readCurrentMailboxLocked(stateRoot, team, me.agentKey, undefined, diagnostics);
          const unread = urgentFirst(current.filter((m) => m.readAt === undefined));
          // v0.7（C6，DESIGN-V0.7 §2.7）：审批门（inbox 路）——tool_request 帧按台账
          // state 裁决：拒 → 遮蔽占位 + 标记 discarded（不进注入面；首拒已由门回投
          // 请求方并通知 lead）；放 → 「APPROVAL VERIFIED」头 + 全文。门只对
          // tool_request 生效，其他消息原路径（零影响）。
          const gateCtx: ToolGateContext = { stateRoot, teamId: me.teamId, readerKey: me.agentKey, now };
          const gated = new Map<string, ToolGateRenderResult>();
          for (const m of unread) {
            if (parseToolFrameType(m.content) === "tool_request") {
              gated.set(m.id, await gateToolRequestRender(m, gateCtx));
            }
          }
          const entries = unread.map((m) => inboxEntry(m, budget.item, gated.get(m.id)));
          const windowCount = batchWindowCount(entries.map((e) => e.cost), budget.total);
          const windowed = unread.slice(0, windowCount);
          await acknowledgeMailbox(
            stateRoot,
            me.teamId,
            me.agentKey,
            windowed.filter((m) => gated.get(m.id)?.gate !== "refuse").map((m) => m.id),
            now,
          );
          // 门拒的请求帧标记 discarded（§2.7「不进注入面」的落盘面）——复读时门已处
          // 拒绝态，渲染-only，不会重复回投。
          await discardMailboxMessages(
            stateRoot,
            me.teamId,
            me.agentKey,
            windowed.filter((m) => gated.get(m.id)?.gate === "refuse").map((m) => m.id),
            now,
          );
          const refusedCount = [...gated.values()].filter((g) => g.gate === "refuse").length;
          if (refusedCount > 0) {
            await logEngineEvent(stateRoot, {
              event: "inbox-check",
              teamId: me.teamId,
              agentKey: me.agentKey,
              consumed: windowed.length,
              unreadLeft: unread.length - windowed.length,
              gatedToolRequestsRefused: refusedCount,
            });
          }
          return {
            messages: windowed,
            entries: entries.slice(0, windowCount),
            totalUnread: unread.length,
            gatedRefused: [...gated.values()].filter((g) => g.gate === "refuse").length,
            gatedPassed: [...gated.values()].filter((g) => g.gate === "pass").length,
          };
        });

        // 消费后剩余未读（读路径无锁，§2.7-5 rename 原子写）——含本批窗口留在箱外的部分。
        const freshTeam = (await readTeam(stateRoot, me.teamId)) ?? teamBefore;
        const rest = await readUnreadMailbox(stateRoot, me.teamId, me.agentKey);
        const unreadCount = countUnread(freshTeam, rest);
        const batchTruncated = consumed.messages.length < consumed.totalUnread;
        await logEngineEvent(stateRoot, {
          event: "inbox-check",
          teamId: me.teamId,
          agentKey: me.agentKey,
          consumed: consumed.messages.length,
          unreadLeft: unreadCount,
          ...(diagnostics.malformed.length > 0 ? { malformedLines: diagnostics.malformed.length } : {}),
          ...(diagnostics.discarded > 0 ? { staleDiscarded: diagnostics.discarded } : {}),
          ...(batchTruncated ? { batchTotalUnread: consumed.totalUnread } : {}),
        });

        // v0.5（R-23 face inbox / R-16 队内信封）：磁盘 JSONL 行全文不动（acknowledgeMailbox
        // 只置 readAt），截断只发生在返回 payload；content[2] 追加逐条信封块。
        const truncatedCount = consumed.entries.filter((e) => e.truncated).length;
        const messages = consumed.entries.map((e) => e.entry);
        const envelopeBlocks = consumed.entries.map((e) => e.block);
        if (batchTruncated) {
          envelopeBlocks.push(
            `[批次已按注入预算截断：本批消费 ${consumed.messages.length}/${consumed.totalUnread} 条；`
            + "其余保持未读——再调一次 xc_read({scope:\"inbox\"}) 继续消费]",
          );
        }
        const envelopeText = envelopeBlocks.join("\n\n");
        if (consumed.messages.length > 0) {
          await logEngineEvent(stateRoot, {
            event: "inject-budget",
            face: "inbox",
            budget: budget.total,
            truncatedCount,
            totalChars: envelopeText.length,
            ...(batchTruncated ? { batchTotalUnread: consumed.totalUnread, batchReturned: consumed.messages.length } : {}),
          });
        }
        const result = okResult(
          renderInbox(
            consumed.messages.length,
            diagnostics.discarded,
            unreadCount,
            diagnostics.malformed.length,
            batchTruncated
              ? ` 本批按注入预算（${budget.total} 字符）截断：只消费 ${consumed.messages.length}/${consumed.totalUnread} 条，其余保持未读——再调一次 xc_read({scope:"inbox"}) 继续`
              : "",
          ),
          {
            messages,
            unreadCount,
            ...(diagnostics.malformed.length > 0 ? { malformedLines: diagnostics.malformed.length } : {}),
            ...(diagnostics.discarded > 0 ? { staleDiscarded: diagnostics.discarded } : {}),
            ...(batchTruncated ? { batchTruncated: true, batchTotalUnread: consumed.totalUnread, batchBudgetChars: budget.total } : {}),
            ...(consumed.gatedRefused > 0 || consumed.gatedPassed > 0
              ? { toolRequests: { gatedRefused: consumed.gatedRefused, gatedPassed: consumed.gatedPassed } }
              : {}),
          },
        );
        if (envelopeText !== "") {
          result.content.push({ type: "text", text: envelopeText });
        }
        return result;
      });
    },

    /**
     * scope:"mail"（v0.5 R-22 → v0.6 T5）：读本人邮箱 JSONL 历史件
     * （含已消费行）的全文分页——只读不消费。v0.6：哈希链校验砍除（§2.2 行 1）。
     *
     * v0.7（C6，§2.7）：mail 分页同受审批门——v0.6.1 的实现直接 paginateText
     * 原始 content（无门），是「mail scope 原文旁路」；现在 tool_request 帧先过
     * {@link gateToolRequestRender}（与 inbox 路同一个门）：未放行只出遮蔽占位，
     * 放行出「APPROVAL VERIFIED」头 + 全文。门可能带首拒侧效应（回投请求方）——
     * 门是唯一的门，读哪条路都过它。
     */
    async xc_mail_read(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityStore.require(connectionKey);
        const message = (await readMailbox(stateRoot, me.teamId, me.agentKey)).find((m) => m.id === args.messageId);
        if (message === undefined) {
          throw invalidParamsError(`unknown messageId "${args.messageId}"; xc_read({scope:"mail"}) only reads your own mailbox history`);
        }
        const itemBudget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env).item;
        const gate = parseToolFrameType(message.content) === "tool_request"
          ? await gateToolRequestRender(message, { stateRoot, teamId: me.teamId, readerKey: me.agentKey, now: Date.now() })
          : undefined;
        const source = gate?.text ?? message.content;
        const page = paginateText(source, args.offset, args.limit, itemBudget);
        return okResult(
          `Mailbox message ${message.id} from ${message.from}: ${page.total} chars (offset ${page.offset}, hasMore=${page.hasMore}).`,
          {
            messageId: message.id,
            total: page.total,
            offset: page.offset,
            text: page.text,
            hasMore: page.hasMore,
            ...(gate !== undefined
              ? {
                  toolGate: {
                    gate: gate.gate,
                    ...(gate.requestId !== undefined ? { requestId: gate.requestId } : {}),
                    ...(gate.state !== undefined ? { state: gate.state } : {}),
                    ...(gate.reason !== undefined ? { reason: gate.reason } : {}),
                  },
                }
              : {}),
          },
        );
      });
    },

    /**
     * scope:"task"（v0.5 R-22 → v0.6 T5）：分页读 team.json 任务字段
     * ——读路径无锁；xc_overview 观测面截断的全文拉取通道。
     */
    async xc_task_read(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityStore.require(connectionKey);
        const team = await readTeam(stateRoot, me.teamId);
        if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet" });
        const task = getTask(team, args.taskId);
        if (task === undefined) throw invalidParamsError(`unknown task "${args.taskId}"`);
        const text = args.field === "prompt" ? task.prompt : (task[args.field] ?? "");
        const itemBudget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env).item;
        const page = paginateText(text, args.offset, args.limit, itemBudget);
        return okResult(
          `Task ${task.id} field "${args.field}": ${page.total} chars (offset ${page.offset}, hasMore=${page.hasMore}).`,
          { taskId: task.id, field: args.field, total: page.total, offset: page.offset, text: page.text, hasMore: page.hasMore },
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// xc_read 工具层（scope 路由；peer 两轴经 PeerServices；journal 为 C4 新面）
// ---------------------------------------------------------------------------

/** journal 路径解析：id=<taskId> → 任务 journal；id="archive:<name>" → 留档 journal。 */
export function resolveJournalPath(stateRoot: string, id: string): string {
  if (id.startsWith("archive:")) {
    const name = sanitizeKey(id.slice("archive:".length));
    if (name === "") {
      throw invalidParamsError(`journal id "archive:${id.slice("archive:".length)}" sanitizes to an empty member key`);
    }
    return archiveJournalPath(stateRoot, name);
  }
  const taskId = sanitizeKey(id);
  if (taskId === "") {
    throw invalidParamsError(`journal id ${JSON.stringify(id)} sanitizes to an empty task segment`);
  }
  if (taskId.includes("..") || taskId.includes("/") || taskId.includes("\\")) {
    throw invalidParamsError(`journal id ${JSON.stringify(id)} contains path separators/traversal segments — refused`);
  }
  return taskJournalPath(stateRoot, taskId);
}

export async function handleRead(deps: ToolDeps, args: ReadArgs, connectionKey: string): Promise<ToolResult> {
  const core = createMailboxReadCore(deps);
  switch (args.scope) {
    case "inbox":
      return core.xc_check_inbox({}, connectionKey);
    case "mail":
      if (args.id === undefined || args.id === "") {
        throw new ToolError({ error: "invalid_params", message: "scope=mail requires \"id\" (message id)" });
      }
      return core.xc_mail_read({ messageId: args.id, ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) }, connectionKey);
    case "task":
      if (args.id === undefined || args.id === "") {
        throw new ToolError({ error: "invalid_params", message: "scope=task requires \"id\" (task id)" });
      }
      return core.xc_task_read({ taskId: args.id, field: args.field ?? "result", ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) }, connectionKey);
    case "peer":
      return readPeerScope(deps, args);
    case "peer-msg":
      if (args.id === undefined || args.id === "") {
        throw new ToolError({ error: "invalid_params", message: "scope=peer-msg requires \"id\" (msg id)" });
      }
      return readPeerMsgScope(deps, args, connectionKey);
    case "journal":
      return readJournalScope(deps, args);
  }
}

/** scope=peer（v0.5.3 peer 排空面 1:1）：排空跨会话队列；count=真实呈现数。
 *  v0.7.1（红队四番战 故障注-4 修复）：排空时跳过的坏行条数随结果披露
 *  （`malformedLines`，与队内 inbox 的 malformedLines、held 的 corrupted
 *  三方口径一致——此前 peer 队列坏行被静默跳过且不计数）。 */
async function readPeerScope(deps: ToolDeps, args: ReadArgs): Promise<ToolResult> {
  const services = getPeerServices(deps);
  const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
  const result = await services.inbox(args.limit ?? 10, budget);
  // v0.6（C1 读取序）：urgent 队列项排最前（core/peermsg 排空面已按 urgentFirst
  // 开窗；此处呈现序与排空序一致，不再重排）。
  const injectBlocks = result.items
    .map((item, i) => queueItemToInjectBlock(item, result.rendered[i] ?? renderPeerEnvelopeText(item)))
    .filter((b) => b.rendered !== "");
  const layout = layoutInjectBlocks(injectBlocks, budget, "peer");
  if (result.items.length > 0) {
    await logPeerInject(deps, budget.total, layout);
  }
  // v0.7.1（故障注-4）：坏行计数披露 + 跨会话域审计（与 inbox 的 malformedLines 同口径）。
  const malformed = result.malformed ?? 0;
  if (malformed > 0) {
    await logPeerEvent(peerRootFromEnv(deps.env), {
      event: "peer-queue-malformed",
      malformed,
      consumed: result.items.length,
    });
  }
  const malformedNote = malformed > 0
    ? `；⚠ ${malformed} 条队列坏行已跳过（不可解析/形状非法——存储损坏痕迹，发送方如需可达请重发）`
    : "";
  return okResult(
    result.items.length === 0
      ? (malformed > 0 ? `没有待投递的跨会话消息${malformedNote}。` : "没有待投递的跨会话消息。")
      : `取到 ${result.items.length} 条跨会话消息（已消费）${result.remaining > 0 ? `；另有 ${result.remaining} 条待投递——再调一次 xc_read({scope:"peer"}) 继续拉取` : ""}${malformedNote}。`,
    {
      count: result.items.length,
      envelopes: layout.blocks,
      remaining: result.remaining,
      ...(malformed > 0 ? { malformedLines: malformed } : {}),
      ...(layout.budgetTruncated ? { budgetTruncated: true } : {}),
    },
  );
}

/** scope=peer-msg（v0.5.3 peer 单件读 1:1）：跨会话单件分页（只读不消费）。 */
async function readPeerMsgScope(deps: ToolDeps, args: ReadArgs, connectionKey: string): Promise<ToolResult> {
  void connectionKey;
  const services = getPeerServices(deps);
  const result = await services.read({
    msgId: args.id!,
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  return okResult(
    `消息 ${result.msgId}：显示 ${result.text.length}/${result.total} 字符（offset=${result.offset}${result.hasMore ? "，还有更多（翻页读 offset 之后的内容）" : "，已到末尾"}）。`,
    result as unknown as Record<string, unknown>,
  );
}

/** scope=journal（C4 新面）：任务/留档日志全文分页（只读；文件缺失给可行动错误）。 */
async function readJournalScope(deps: ToolDeps, args: ReadArgs): Promise<ToolResult> {
  if (args.id === undefined || args.id === "") {
    throw new ToolError({
      error: "invalid_params",
      message: "scope=journal requires \"id\": a task id, or \"archive:<member name>\" for the member handover journal",
    });
  }
  const file = resolveJournalPath(deps.stateRoot, args.id);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ToolError({
      error: "journal_not_found",
      id: args.id,
      path: file,
      message: `no journal at "${file}" — task journals are written by members (longtask skill); ` +
        'member handover journals exist after xc_team {action:"member-stop", archive:true}',
    });
  }
  const itemBudget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env).item;
  const page = paginateText(text, args.offset, args.limit, itemBudget);
  return okResult(
    `Journal ${args.id}: ${page.total} chars (offset ${page.offset}, hasMore=${page.hasMore}).`,
    { id: args.id, path: file, total: page.total, offset: page.offset, text: page.text, hasMore: page.hasMore },
  );
}

// 局部助手（与旧 peer-tools 面等价的最小形态）。
function renderPeerEnvelopeText(item: Parameters<typeof renderPeerEnvelope>[0]): string {
  return renderPeerEnvelope(item);
}
async function logPeerInject(deps: ToolDeps, budget: number, layout: LayoutResult): Promise<void> {
  await logPeerEvent(peerRootFromEnv(deps.env), {
    event: "inject-budget",
    face: "C",
    budget,
    truncatedCount: layout.truncatedCount,
    totalChars: layout.totalChars,
  });
}

// ---------------------------------------------------------------------------
// SDK 接线（FamilyRegistrar 形态；server.ts 持有 PrimaryRegistry）
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCore } from "./core.js";
import type { ToolDeps as _TD, PrimaryRegistry } from "./core.js";
import { connectionKeyOf } from "./identity.js";

/** 注册 xc_read（统一分页读；scope 路由见 handleRead）。 */
export function registerReadTools(
  server: McpServer,
  deps: _TD,
  _core: ToolCore,
  registry: PrimaryRegistry,
): void {
  const description =
    "Unified paged reader (scopes: inbox/mail/task/peer/peer-msg/journal). " +
    "scope=inbox reads and consumes your team mailbox (urgent messages first, budgeted batches, leftover stays unread); " +
    "scope=mail pages one mailbox history item; scope=task pages one team.json task field (field defaults to result); " +
    "scope=peer drains cross-session messages (count = what this response actually presents; leftover stays queued and remaining tells you to poll again); scope=peer-msg pages one cross-session item; " +
    'scope=journal reads a task journal (.crosschat/tasks/<id>/journal.md) or a member handover archive (id="archive:<name>").';
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> =>
    handleRead(deps, args as unknown as ReadArgs, connectionKeyOf(extra));
  server.tool("xc_read", description, ReadShape, handler);
  registry.set("xc_read", { description, shape: ReadShape, handler });
}
