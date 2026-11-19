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
 * | handoff   | （新，v0.8.0 A2） | 只读   | 30 秒接手包（七要素：身份/我的任务/待领池/未读/容量/最近检查点/建议下一步）；
 *            文本 + JSON 双层，4000 字符预算按章截断并披露；id=<taskId|花名> 收窄视角 |
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
import { getTask, leadKeyOf, memberOpenTasks, readTeam, sortTasksForBoard, unsatisfiedDependencies } from "../core/teamstate.js";
import { memberState } from "../core/types.js";
import { lastProgressTs, stallThresholdMs, stalledTasks } from "../core/stall.js";
import { staleThresholdMsFromEnv } from "./task-edges.js";
import { capacityCacheFile, judgeCapacity, sampleCapacity } from "../core/capacity.js";
import { capacityViewOf, latestCheckpoint } from "../core/checkpoint.js";
import {
  assembleHandoff,
  handoffIdCandidates,
  handoffUnreadView,
  resolveHandoffFilter,
  selectHandoffTasks,
  HANDOFF_POOL_MAX,
  type HandoffCapacity,
  type HandoffCheckpoint,
  type HandoffPoolItem,
  type HandoffTask,
} from "../core/handoff.js";
import {
  acknowledgeMailbox,
  classifyFrame,
  discardMailboxMessages,
  isCurrentMail,
  markMailboxConsumed,
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
  queueItemToInjectBlock,
  renderPeerEnvelope,
  renderTeamEnvelope,
} from "../core/peerenvelope.js";
import { sha256Of } from "../core/msgstore.js";
import { peerRootFromEnv } from "../core/peerdir.js";
import { logPeerEvent, scanPeers } from "../core/peerregistry.js";
import { archiveJournalPath, taskJournalPath } from "../core/archive.js";
import { getPeerServices } from "./peer-services.js";
import type { ToolDeps } from "./core.js";
import { runCore } from "./core.js";

// ---------------------------------------------------------------------------
// zod 入参 schema（§1.2 T5）
// ---------------------------------------------------------------------------

export const ReadShape = {
  scope: z.enum(["inbox", "mail", "task", "peer", "peer-msg", "journal", "handoff"])
    .describe("inbox=读并消费本队邮箱；mail=邮箱历史单件分页；task=任务字段分页；peer=拉取跨会话消息（消费）；peer-msg=跨会话单件分页；journal=任务/留档日志；handoff=30 秒接手包（七要素，id 可收窄为任务 id 或花名）"),
  id: z.string().optional().describe("mail/peer-msg=消息 id；task=任务 id；journal=任务 id 或 \"archive:<成员名>\"；handoff=任务 id 或花名（缺省=我自己的接手包）"),
  field: z.enum(["result", "error", "prompt", "acceptance"]).optional().describe("仅 scope=task：要分页读的字段"),
  offset: z.number().int().min(0).optional().describe("起始偏移/条"),
  limit: z.number().int().min(1).optional().describe("本次返回上限（字符或条，随 scope）"),
} as const;

export type ReadArgs = {
  scope: "inbox" | "mail" | "task" | "peer" | "peer-msg" | "journal" | "handoff";
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
  // v0.9.1（V090-13 P1 修复）：不再「已渲染原样透传」——原守卫只查闭合标签+页脚
  // marker 两个子串，纯文本伪造的完整信封（含 interrupt="true"+横幅+页脚+回信指引）
  // 会被当已渲染工件原样升级进注入面。现在恒走 renderTeamEnvelope 的「恒由消息
  // 元数据重建」路径（正文先剥伪造标记再重包，from/横幅/interrupt 属性只随元数据）。
  // 伪造标记只活在磁盘真源与 JSON entry 原文（下方 entry 不动，保留真值层）。
  {
    const body = cut.text + (cut.truncated ? `\n${truncateNote("mail", m.id, cut.truncated.shown, cut.truncated.total)}` : "");
    const cls = classifyFrame(m.content);
    block = renderTeamEnvelope({
      frameType: cls.kind === "frame" ? cls.frameType : "chat",
      from: m.from,
      content: body,
      ...(m.origin !== undefined ? { origin: m.origin } : {}),
      // v0.9（G-2）：软中断信封——元数据驱动，正文不动（PROTOCOL §3 冻结形态）。
      ...(m.interrupt === true ? { interrupt: true } : {}),
      // v0.9.1（G-10）：文件引用块——元数据驱动，正文内嵌的伪造引用块由渲染面剥离
      // （PROTOCOL §15.1 冻结形态；「用 Read 打开该路径」提示在信封内渲染一次）。
      ...(m.refs !== undefined ? { refs: m.refs } : {}),
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
        // v0.9.1（G-12v3 机制 B）：mail scope 读件 = 成员回合实际消费——回写
        // consumedAt（best-effort 团队锁，2s 预算；锁忙跳过，下条/下回合再写）。
        // 防的是「只翻历史不读 inbox」的形态被 limbo 误判成「盖章未消费」。
        // readAt 不动：本 scope 是历史分页通道（§2.8 读路径无锁纪律保留）。
        if (message.consumedAt === undefined && message.discardedAt === undefined) {
          try {
            await withTeamLock(stateRoot, me.teamId, async () => {
              await markMailboxConsumed(stateRoot, me.teamId, me.agentKey, [message.id]);
            }, { waitMs: 2_000 });
          } catch {
            /* 锁忙/IO：消费回写尽力而为（inbox scope 的 acknowledge 仍会写） */
          }
        }
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
    case "handoff":
      return readHandoffScope(deps, args, connectionKey);
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

// ---------------------------------------------------------------------------
// scope=handoff（v0.8.0 A2）：30 秒接手包（DESIGN-V0.8.md §4）
// ---------------------------------------------------------------------------

/** latestCheckpoint 的安全包装：段闸抛错（agentKey 清洗后仍不安全）按「无检查点」降级 + 披露。
 *  v0.8.1（C2-B8 修复）：只回冻结形状的四键（path/createdAt/ageMin/bytes）——latestCheckpoint
 *  额外带的 `stamp` 是读取面内部字段，漏进 payload 会多出冻结形状外的键。 */
async function latestCheckpointSafe(
  stateRoot: string,
  agentKey: string,
  now: number,
  warnings: string[],
): Promise<HandoffCheckpoint | null> {
  try {
    const latest = await latestCheckpoint(stateRoot, agentKey, now);
    return latest === null ? null : { path: latest.path, createdAt: latest.createdAt, ageMin: latest.ageMin, bytes: latest.bytes };
  } catch (error) {
    warnings.push(`checkpoint lookup failed for ${JSON.stringify(agentKey)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 连续性指针最多点几个不在场成员（建议行长度有界；其余只计数）。 */
const HANDOFF_CONTINUITY_HOLDERS_MAX = 3;

/** 一位「不在场但持有状态」的花名册成员（连续性指针的一行）。 */
interface AbsentStateHolder {
  key: string;
  openTasks: number;
  unread: number;
  hasCheckpoint: boolean;
}

/**
 * v0.8.1（29 红队 C2-B3 修复）：找出「会话已不在场、却持有开放任务/未读/检查点」的
 * 花名册成员（≠ 调用方）。默认 self 接手包三要素全空时，这些正是「本会话可能在延续
 * 的前任」——数据仍可经成员视角寻址，但默认面必须给指针，不得静默白纸。
 *
 * 活性判据 = **只读** peer 扫描（`sweep:false`——死记录是 C8 离线判据的进程死硬证据，
 * 查询不得惰性清扫）：成员的 roster sessionId 或其花名都不在活记录里 = 不在场。
 * peer 根取不到/扫描失败按「无法判定」处理（保守方向：仍披露，不静默）。
 */
async function absentStateHolders(
  deps: ToolDeps,
  team: TeamState,
  meKey: string,
  now: number,
): Promise<AbsentStateHolder[]> {
  let liveSids: Set<string> | null = null;
  let liveNames: Set<string> | null = null;
  try {
    const scan = await scanPeers(peerRootFromEnv(deps.env), now, { sweep: false });
    liveSids = new Set(scan.active.map((r) => r.sessionId));
    liveNames = new Set(scan.active.map((r) => r.name).filter((n): n is string => typeof n === "string"));
  } catch {
    liveSids = null; // 无法判定活性 → 下面按「不在场」处理（保守披露）
    liveNames = null;
  }
  const holders: AbsentStateHolder[] = [];
  for (const m of team.members) {
    if (m.key === meKey) continue;
    const openTasks = memberOpenTasks(team.tasks, m.key).length;
    const box = await readMailbox(deps.stateRoot, team.teamId, m.key);
    const unread = countUnread(
      team,
      box.filter((msg) => msg.readAt === undefined && msg.discardedAt === undefined),
    );
    const hasCheckpoint = (await latestCheckpointSafe(deps.stateRoot, m.key, now, [])) !== null;
    if (openTasks === 0 && unread === 0 && !hasCheckpoint) continue; // 无状态可继承
    const present = liveSids !== null
      && (liveSids.has(m.sessionId) || (liveNames !== null && liveNames.has(m.key)));
    if (present) continue; // 会话还在场——它的活它自己干，不需要指针
    holders.push({ key: m.key, openTasks, unread, hasCheckpoint });
  }
  // 确定性排序：开放任务多者优先，其次未读，最后花名（跨调用稳定）。
  holders.sort((a, b) => b.openTasks - a.openTasks || b.unread - a.unread || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return holders;
}

/**
 * scope:"handoff"：七要素接手包（身份/我的任务/待领池/未读/容量/最近检查点/建议下一步），
 * 文本 + JSON 双层，4000 字符预算按章截断并披露（core/handoff.ts 纯函数组装）。
 *
 * id 三视角（§4.1 冻结表，resolveHandoffFilter 解析）：
 * - 缺省 self：我的开放任务 + 我的箱未读 + 我的检查点目录；
 * - id=<taskId>：仅该任务一条（不限 assignee/状态，供复盘）+ 我的箱里该任务的件 +
 *   该任务受领人的检查点目录；
 * - id=<花名>：该成员的开放任务 + 该成员箱的未读**计数**（主题不跨成员披露，§4.4）+
 *   该成员的检查点目录（花名清洗后与原文不同 → null + warnings，不猜路径）。
 */
async function readHandoffScope(deps: ToolDeps, args: ReadArgs, connectionKey: string): Promise<ToolResult> {
  // 与 core 层方法同纪律：整面包 runCore——not_registered / no_team / invalid_params
  // 都映射为结构化错误信封（而非裸抛），审计降级告警同链路内联。
  return runCore(deps.stateRoot, async () => {
    const me = identityStore.require(connectionKey);
  const now = Date.now();
  const team = await readTeam(deps.stateRoot, me.teamId);
  if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet" });
  const filter = resolveHandoffFilter(args.id, team);
  if (filter === undefined) {
    const candidates = handoffIdCandidates(team);
    throw invalidParamsError(
      `handoff id ${JSON.stringify(args.id)} matches no task id and no member key; `
      + `valid forms: a task id or a member key `
      + `(task ids: ${candidates.taskIds.join(", ") || "(none)"}; member keys: ${candidates.memberKeys.join(", ") || "(none)"})`,
    );
  }
  const warnings: string[] = [];

  // 1. 身份（三视角都是调用方自己；受领人信息在 tasks[].assignee）
  // v0.8.1（M02 修复）：memberState 走 teamstate 的 W2 访问器（m.state ?? 'ready'，
  // DESIGN-V0.2 §6.5）——identify 入册的成员记录本就不落 state 字段，旧实现直接
  // 取 member?.state ?? null，使 identity 章对**在册**成员恒报 (not on roster)/
  // memberState:null，与 team.json / status / identify roster / checkpoint 身份章
  // （同一成员同时刻报 state: ready）四面真源相反。判据改为花名册成员身份：
  // 在册 → 访问器给出的生命周期态（缺省 ready）；不在册 → null（如实 not on roster）。
  const member = team.members.find((m) => m.key === me.agentKey);
  const identity = {
    agentKey: me.agentKey,
    teamId: team.teamId,
    // v0.8.1（29 红队 M05 修复）：lead 渲染跨面同源——team.leadKey 缺省时 founder
    // 读作 lead（core/teamstate.ts leadKeyOf；types.ts 的 TeamState.leadKey 注释与
    // DESIGN-V0.2 §6.1 公开口径）。此前直读 team.leadKey ?? null：无显式 lead 时
    // handoff 渲染 `lead: (none)` 而 status/team 视图展示 founder（leadKey=bob），
    // 且同一 payload 的 isLead 又按 founder 兜底算成 true——自相矛盾。
    leadKey: leadKeyOf(team) ?? null,
    role: member?.role ?? null,
    memberState: member === undefined ? null : memberState(member),
    isLead: me.agentKey === leadKeyOf(team),
  };

  // 2. 任务（视角内；unmetDependsOn/to 为 input-only，不进 payload）
  const selected = selectHandoffTasks(filter, team, me.agentKey);
  const tasks: HandoffTask[] = selected.map((t) => ({
    taskId: t.id,
    title: t.title,
    status: t.status,
    attempt: t.attempt,
    assignee: t.assignee,
    lastProgressTs: lastProgressTs(t),
    ...(t.blockedReason !== undefined ? { blockedReason: t.blockedReason } : {}),
    unmetDependsOn: unsatisfiedDependencies(team.tasks, t.dependsOn),
    ...(t.to !== undefined ? { to: t.to } : {}),
  }));

  // 3. 待领池（pending ∧ sortTasksForBoard 前 10；三视角同源——接手决策需要备选池）
  const pendingAll = team.tasks.filter((t) => t.status === "pending");
  const pool: HandoffPoolItem[] = sortTasksForBoard(pendingAll)
    .slice(0, HANDOFF_POOL_MAX)
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      priority: t.priority,
      dependsOn: t.dependsOn,
      unmetDependsOn: unsatisfiedDependencies(team.tasks, t.dependsOn),
      ...(t.to !== undefined ? { to: t.to } : {}),
    }));

  // 4. 未读（分视角；freshness 裁决与 overview 板面同口径：未读 ∧ 未丢弃 ∧ isCurrentMail）
  const unreadBoxKey = filter.kind === "member" ? sanitizeKey(filter.id) : me.agentKey;
  const boxMessages = await readMailbox(deps.stateRoot, me.teamId, unreadBoxKey);
  const current = boxMessages.filter(
    (m) => m.readAt === undefined && m.discardedAt === undefined && isCurrentMail(team, m),
  );
  const unread = handoffUnreadView(filter, current);

  // 5. 容量（C9 采样/判定原样复用；level 由 core/checkpoint.ts 推导助手产出——三视图同口径）
  let capacity: HandoffCapacity | null = null;
  try {
    const sample = await sampleCapacity(deps.env, capacityCacheFile(deps.stateRoot), now);
    const view = capacityViewOf(sample, judgeCapacity(sample, deps.env));
    capacity = view === null ? null : { ...view, sampledAt: sample.sampledAt };
  } catch {
    capacity = null;
  }
  if (capacity === null) {
    warnings.push(
      "capacity sampling failed — capacity reported as null (not GREEN; xc_overview view:status 同口径记 UNKNOWN)",
    );
  }

  // 6. 最近检查点（视角内目标目录最新一份 *.md 的 stat）
  let checkpoint: HandoffCheckpoint | null = null;
  if (filter.kind === "member") {
    const cleaned = sanitizeKey(filter.id);
    if (cleaned !== filter.id) {
      warnings.push(
        `member id ${JSON.stringify(filter.id)} sanitizes to ${JSON.stringify(cleaned)} — checkpoint lookup refused (path drift; 不猜路径)`,
      );
    } else {
      checkpoint = await latestCheckpointSafe(deps.stateRoot, cleaned, now, warnings);
    }
  } else if (filter.kind === "task") {
    const assignee = tasks[0]?.assignee ?? null;
    checkpoint = assignee === null ? null : await latestCheckpointSafe(deps.stateRoot, assignee, now, warnings);
  } else {
    checkpoint = await latestCheckpointSafe(deps.stateRoot, me.agentKey, now, warnings);
  }

  // 7. 建议下一步的数据面：视角内任务按 C5 停滞阈值算旗标 + 我的在途任务（单在途规则提示）
  const stalled = stalledTasks(selected, now, stallThresholdMs(deps.env, staleThresholdMsFromEnv(deps.env)).ms);
  const myOpenTaskId = filter.kind === "member"
    ? null
    : (memberOpenTasks(team.tasks, me.agentKey)[0]?.id ?? null);

  // v0.8.1（29 红队 C2-B3 修复）：**连续性指针**——默认 self 包三要素全空
  // （无我的任务/无未读/无检查点）而花名册里有成员的会话已不在场、却持有这三类
  // 状态时，旧实现给一张静默的白纸（`（暂无：按 journal 指针继续）`）：按 README
  // 恢复路径「新花名 identify 接手」落地的会话，接手包对其旧身份的任务/未读/
  // 检查点零提示（数据仍可经成员视角寻址，但默认面不指路）。此处补一条置顶
  // 建议（文本面可见）+ payload warning。活性判据用只读 peer 扫描（不惰性清扫
  // ——死记录是 C8 离线判据的进程死证据）；取不到 peer 根时按「无法判定活性」
  // 处理（保守方向：照常披露，不静默）。
  let continuityHint: string | undefined;
  if (
    filter.kind === "self"
    && tasks.length === 0
    && unread.count === 0
    && checkpoint === null
  ) {
    const holders = await absentStateHolders(deps, team, me.agentKey, now);
    if (holders.length > 0) {
      const shown = holders.slice(0, HANDOFF_CONTINUITY_HOLDERS_MAX);
      const more = holders.length - shown.length;
      const detail = shown
        .map((h) => `${h.key}（${h.openTasks} 开放任务/${h.unread} 未读/${h.hasCheckpoint ? "有检查点" : "无检查点"}）`)
        .join("、");
      continuityHint =
        `continuity: 你的接手包为空，但花名册有不在场成员持有状态：${detail}`
        + (more > 0 ? ` 等 ${holders.length} 人` : "")
        + `——若本会话是其中某位的延续，先 xc_read({scope:"handoff", id:"<该成员名>"}) 寻回其任务/未读/检查点`
        + `（其开放任务可按 xc_overview 板面建议重派或等 stale 清扫回池后再 claim；花名册清理由 lead xc_team member-stop）`;
      warnings.push(
        `handoff self packet is empty while absent roster member(s) hold state: ${detail}`
        + (more > 0 ? ` (+${more} more)` : "")
        + " — read the member view xc_read({scope:\"handoff\", id:\"<member>\"}) for continuity",
      );
    }
  }

  const assembled = assembleHandoff({
    now,
    filter,
    identity,
    tasks,
    pool,
    poolTotal: pendingAll.length,
    unread,
    capacity,
    checkpoint,
    stalled,
    myOpenTaskId,
    ...(continuityHint !== undefined ? { continuityHint } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  return okResult(assembled.text, assembled.payload);
  });
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
    "Unified paged reader (scopes: inbox/mail/task/peer/peer-msg/journal/handoff). " +
    "scope=inbox reads and consumes your team mailbox (urgent messages first, budgeted batches, leftover stays unread); " +
    "scope=mail pages one mailbox history item; scope=task pages one team.json task field (field defaults to result); " +
    "scope=peer drains cross-session messages (count = what this response actually presents; leftover stays queued and remaining tells you to poll again); scope=peer-msg pages one cross-session item; " +
    'scope=journal reads a task journal (.crosschat/tasks/<id>/journal.md) or a member handover archive (id="archive:<name>"); ' +
    "scope=handoff returns the 30-second handoff packet (identity / my tasks / pending pool / unread digest / capacity / latest checkpoint / next-step suggestions, text + JSON, 4000-char budget with per-section truncation disclosure; id narrows the view to one task id or member key, omitted = your own packet).";
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> =>
    handleRead(deps, args as unknown as ReadArgs, connectionKeyOf(extra));
  server.tool("xc_read", description, ReadShape, handler);
  registry.set("xc_read", { description, shape: ReadShape, handler });
}
