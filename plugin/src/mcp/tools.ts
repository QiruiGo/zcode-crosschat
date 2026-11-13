/**
 * M3 tools：7 个 xc_* MCP 工具（DESIGN.md §2.8）+ §2.6 全部硬校验。
 *
 * 分层：createToolCore(deps) 返回与 SDK 无关的 7 个操作（单测直接驱动，内部经
 * runCore 映射一切异常为 ToolResult 信封，永不抛出）；registerTools(server, deps)
 * 把它们接到 @modelcontextprotocol/sdk 的 stdio server。
 *
 * 身份 = 连接绑定（identity.ts）：所有工具一律不接受 from/caller 参数；身份类
 * 工具（dispatch/claim/report/message/check_inbox）未注册即结构化报错
 * {error:"not_registered"}；仅 xc_status 豁免（未注册调用省略个人字段）。
 *
 * 并发纪律（§2.7）：变更操作一律 withTeamLock(stateRoot, teamId, fn)（M1 组合锁 =
 * 进程内 promise 链 + 跨进程 O_EXCL lockfile，15s 等待 → LockBusyError）内
 * 「重读 → 校验 → 变更 → 写盘」；慢操作（证据 sha256、唤醒 spawn）在锁外；
 * attemptWake 只准在团队锁外调用（M2 内部会短暂重取锁补盖章，持锁调用会死锁）；
 * 推送唤醒失败只降级 mailbox，不丢消息（§2.5 邮箱为真、唤醒为优化）。
 *
 * 硬校验分工：M1 teamstate 提供纯函数校验（reportTransitionError/applyReport/
 * unsatisfiedDependencies/memberOpenTasks），本模块按 §2.6 硬校验表先做带结构化
 * 错误码的前置检查，再调用 M1 纯函数兜底复核。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectionKeyOf, identityStore, xcRegister } from "./identity.js";
import {
  invalidParamsError,
  errorResult,
  mapToolError,
  okResult,
  staleAttemptError,
  ToolError,
  type ToolResult,
} from "./protocol.js";
import {
  renderClaim,
  renderDispatch,
  renderInbox,
  renderMessage,
  renderRegister,
  renderReport,
  renderStatusTable,
  renderBoardTruncationNote,
  statusTaskRowText,
  writeSnapshot,
  STATUS_TASK_TABLE_HEADER,
  BOARD_TRUNCATION_NOTE_MAX_CHARS,
  type StatusSnapshot,
} from "./render.js";
import { isValidTeamId, resolveStateRoot } from "../core/paths.js";
import { LockBusyError, withTeamLock } from "../core/lock.js";
import { sanitizeKey } from "../core/sanitize.js";
import { DEFAULT_TEAM_ID, TERMINAL_TASK_STATUSES } from "../core/types.js";
import type { EvidenceItem, MemberRole, TeamMessage, TeamState } from "../core/types.js";
import {
  appendTaskHistory,
  applyReport,
  beginTaskAttempt,
  getTask,
  lastTeamRecoveryNotice,
  makeTask,
  memberOpenTasks,
  newTeamState,
  noteTeamReset,
  readTeam,
  reportTransitionError,
  teamRecoveryWarning,
  unsatisfiedDependencies,
  writeTeam,
} from "../core/teamstate.js";
import {
  acknowledgeMailbox,
  appendMailbox,
  classifyFrame,
  createMessage,
  isCurrentMail,
  orphanTaskIds,
  readCurrentMailboxLocked,
  readMailbox,
  readUnreadMailbox,
  staleCompletedReceiptTaskIds,
} from "../core/mailbox.js";
import type { MailboxReadDiagnostics } from "../core/mailbox.js";
import { auditDegradationWarning, logEngineEvent } from "../core/log.js";
import { attemptWake, findDuplicateMail } from "../engine/wake.js";
// v0.5（M6 轴②③接线）：预算/分页（M1）、队内信封（M3）、盖章链（M4）、全文 sha256（M4）。
import { batchWindowCount, contextCharsFromEnv, paginateText, receiverInjectBudget, truncateField, truncateNote } from "../core/budget.js";
import { isTeamEnvelopeRendered, renderTeamEnvelope } from "../core/peerenvelope.js";
import { uservoiceMatchAndConsume, verifyUservoiceStampAuthority } from "../core/uservoice.js";
import { sha256Of } from "../core/msgstore.js";
import { peerRootFromEnv } from "../core/peerdir.js";
import { leadKeyOf } from "./member-tools.js";

/** v1 单队固定 default（DESIGN §2.2）。 */
const TEAM_ID = DEFAULT_TEAM_ID;

/** createMessage 可携带的投递快照字段。 */
type MessageExtras = Partial<
  Pick<TeamMessage, "taskId" | "attemptId" | "sourceTaskId" | "sourceAttemptId" | "sourceTaskStatus" | "deliveryClaimedAt">
>;

export interface ToolDeps {
  /** 状态根 <workspace>/.crosschat（§2.2；server.ts 用 process.cwd() 解析）。 */
  stateRoot: string;
  /** 工作区绝对路径（传给 M2 作为 --cwd）。 */
  workspace: string;
  /** 进程环境（XC_WAKE_ENABLED 等，V7：仅 "true" 视为开启）。 */
  env: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// zod 入参 schema（§2.8 参数表；无 from/caller 参数——身份≡连接绑定）
// ---------------------------------------------------------------------------

export const RegisterShape = {
  name: z.string().min(1).describe("要注册的名字（sanitizeKey 归一为 agentKey）"),
  sessionId: z.string().min(1).describe("本会话的 sessionId（hook 注入的上下文里有）"),
  role: z.enum(["peer", "worker"]).optional().describe("缺省 peer；worker=值班执行"),
  wakeToken: z.string().optional().describe("无头回合的唤醒令牌；缺省走 hook 锚定路径"),
};
export const DispatchShape = {
  to: z.string().min(1).describe("目标成员名"),
  title: z.string().min(1).describe("任务标题"),
  prompt: z.string().min(1).describe("任务内容（要做什么）"),
  acceptance: z.string().optional().describe("验收标准（可检验）"),
  dependsOn: z.array(z.string()).optional().describe("依赖的任务 id 列表"),
};
export const ClaimShape = { taskId: z.string().min(1).describe("要认领的任务 id") };
export const ReportShape = {
  taskId: z.string().min(1),
  attemptId: z.string().min(1).describe("xc_claim 返回的 attempt 令牌；不匹配即硬拒"),
  status: z.enum(["in_progress", "completed", "failed"]),
  result: z.string().optional().describe("completed 必填"),
  error: z.string().optional().describe("failed 建议填写"),
  evidence: z
    .array(
      z.object({
        path: z.string().min(1).describe("证据文件绝对路径"),
        sha256: z.string().nullable().optional().describe("缺省或 null 时由工具对文件现算；提供时与现算值复核，不符即整单拒绝"),
        note: z.string().optional(),
      }),
    )
    .optional()
    .describe("completed 必须至少 1 条；每条文件必须真实存在且位于工作区内（v0.5.2 遏制）、sha256 与工具现算值一致，否则拒绝（evidence_path_outside_workspace / evidence_file_missing / evidence_checksum_mismatch）"),
};
export const MessageShape = {
  to: z.string().min(1),
  content: z.string().min(1).optional().describe("消息正文；forwardOf 转发时不可携带（批注另发一条，R-13）"),
  sourceTaskId: z.string().optional().describe("与 sourceAttemptId 必须成对出现"),
  sourceAttemptId: z.string().optional(),
  forwardOf: z.string().min(1).optional().describe("转发已收到的队内消息 id：from=转发者、origin/originSessionId 保留原值；不可与 content 混用（批注另发一条）"),
};
export const StatusShape = {
  teamId: z.string().optional(),
  history: z.boolean().optional().describe("附 lead 角色变更史（leadKey/leadSince/leadHistory，R-7；锁外只读 team.json）"),
  // v0.5.2（SCALE-1 修复）：任务板分页起点。板面按注入预算开窗口（默认从第 0 条
  // 起），窗口外的任务不进响应；截断时 payload 给 boardTruncated 与人可读面给
  // 指针行，按此偏移继续读后续任务（snapshot.json 落盘的仍是全量）。
  offset: z.number().int().min(0).optional().describe("任务板分页起点（条）；板面超注入预算时用 boardTruncated 指针续读"),
};
/** v0.5（R-22）：xc_mail_read 入参——读本人邮箱历史件（含已消费），只读不消费。 */
export const MailReadShape = {
  messageId: z.string().min(1).describe("要读取的邮箱消息 id（xc_check_inbox payload 的 message.id；含已消费行）"),
  offset: z.number().int().min(0).optional().describe("起始字符偏移；缺省 0"),
  limit: z.number().int().min(1).optional().describe("本次返回字符数上限；缺省=本会话 item 预算，硬上限 64000"),
};
/** v0.5（R-22）：xc_task_read 入参——分页读 team.json 任务字段（锁外只读）。 */
export const TaskReadShape = {
  taskId: z.string().min(1).describe("要读取的任务 id"),
  // v0.5.1（SCALE-2 修复）：增 "acceptance"——claim 回显截断后验收标准的全文分页取回通道。
  field: z.enum(["result", "error", "prompt", "acceptance"]).describe("要分页读取的字段"),
  offset: z.number().int().min(0).optional().describe("起始字符偏移；缺省 0"),
  limit: z.number().int().min(1).optional().describe("本次返回字符数上限；缺省=本会话 item 预算，硬上限 64000"),
};

type RegisterArgs = z.infer<z.ZodObject<typeof RegisterShape>>;
type DispatchArgs = z.infer<z.ZodObject<typeof DispatchShape>>;
type ClaimArgs = z.infer<z.ZodObject<typeof ClaimShape>>;
type ReportArgs = z.infer<z.ZodObject<typeof ReportShape>>;
type MessageArgs = z.infer<z.ZodObject<typeof MessageShape>>;
type StatusArgs = z.infer<z.ZodObject<typeof StatusShape>>;
type MailReadArgs = z.infer<z.ZodObject<typeof MailReadShape>>;
type TaskReadArgs = z.infer<z.ZodObject<typeof TaskReadShape>>;

// ---------------------------------------------------------------------------
// 工具核心公共件
// ---------------------------------------------------------------------------

/** core 层统一入口：LockBusyError → {error:"busy"}，其余经 protocol.mapToolError。
 *
 * v0.5.2（故障注-3 修复）：响应附带审计降级告警——engine.jsonl 不可写（被目录
 * 占用/权限缺失）时此前全部工具照常成功、审计静默全丢、工具面零诊断。现在每次
 * 工具响应都以末尾 text 块内联披露 `auditDegradationWarning(stateRoot)`（健康时
 * 零开销、零结构变化），与 inbox 坏行的 `N unreadable line(s) skipped` 同一披露
 * 口径；审计写成功即自动清除，告警随之消失。 */
async function runCore(stateRoot: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  let result: ToolResult;
  try {
    result = await fn();
  } catch (err) {
    if (err instanceof LockBusyError) result = errorResult(err.toStructured());
    else result = mapToolError(err);
  }
  // v0.5.2（故障注-3 修复）：审计不可写时在响应末尾内联告警（健康时零开销）。
  const auditWarning = auditDegradationWarning(stateRoot);
  if (auditWarning !== undefined) {
    result.content.push({ type: "text", text: auditWarning });
  }
  return result;
}

function requireMember(team: TeamState, agentKey: string): void {
  if (!team.members.some((m) => m.key === agentKey)) {
    throw new ToolError({
      error: "not_a_member",
      agentKey,
      message: `"${agentKey}" is not a member of team "${team.teamId}"; register first (xc_register)`,
    });
  }
}

/** 任务票文本：派发消息/唤醒 prompt 共用的稳定载荷（不含 taskId，保证重复派发幂等可判）。 */
function ticketText(args: DispatchArgs): string {
  return JSON.stringify({
    type: "task-assignment",
    teamId: TEAM_ID,
    title: args.title.trim(),
    prompt: args.prompt,
    acceptance: args.acceptance?.trim() || "",
  });
}

/** 回执消息内容：机器可解析 JSON，attempt 关联保留在此（见 xc_report 内注释）。 */
function receiptText(taskId: string, attemptId: string, status: string, task: TeamState["tasks"][number]): string {
  return JSON.stringify({
    type: "task-receipt",
    teamId: TEAM_ID,
    taskId,
    attemptId,
    status,
    result: task.result,
    error: task.error,
    evidence: task.evidence,
  });
}

/** 文件类证据现算 sha256（§2.8：极简版 artifacts 思路；文件缺失 → null）。 */
async function sha256File(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/** 当前未读（未读 ∧ 未丢弃 ∧ isCurrentMail）计数，xc_status 与 inbox 共用。 */
function countUnread(team: TeamState, messages: TeamMessage[]): number {
  return messages.filter((m) => !m.readAt && !m.discardedAt && isCurrentMail(team, m)).length;
}

/**
 * v0.5.1（SCALE-1 修复）：xc_check_inbox 单条消息在本响应两个面的形态与成本——
 * `entry` = content[1] JSON payload 的逐条对象（content 超 item 预算截断 +
 * contentTruncated/contentPointer，R-23 同款）；`block` = content[2] 的信封块
 * （超预算尾部拼 xc_mail_read 指针）；`cost` = 两个面的字符成本之和（批次窗口
 * 记账用）。磁盘 JSONL 全文不动（acknowledgeMailbox 只置 readAt，R-21）。
 */
function inboxEntry(
  m: TeamMessage,
  budgetItem: number,
): { entry: Record<string, unknown>; block: string; cost: number; truncated: boolean } {
  const cut = truncateField(m.content, budgetItem, sha256Of);
  const entry: Record<string, unknown> = {
    ...m,
    content: cut.text,
    ...(cut.truncated
      ? {
          contentTruncated: { shown: cut.truncated.shown, total: cut.truncated.total },
          contentPointer: "xc_mail_read",
        }
      : {}),
  };
  let block: string;
  if (isTeamEnvelopeRendered(m.content)) {
    block = m.content; // 幂等守卫：已包裹原样返回
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

// ---------------------------------------------------------------------------
// 工具核心（SDK 无关，供 registerTools 与单测共用）
// ---------------------------------------------------------------------------

export interface ToolCore {
  xc_register(args: RegisterArgs, connectionKey: string): Promise<ToolResult>;
  xc_dispatch(args: DispatchArgs, connectionKey: string): Promise<ToolResult>;
  xc_check_inbox(args: Record<string, never>, connectionKey: string): Promise<ToolResult>;
  xc_claim(args: ClaimArgs, connectionKey: string): Promise<ToolResult>;
  xc_report(args: ReportArgs, connectionKey: string): Promise<ToolResult>;
  xc_message(args: MessageArgs, connectionKey: string): Promise<ToolResult>;
  xc_status(args: StatusArgs, connectionKey: string): Promise<ToolResult>;
  /** v0.5（R-22）：邮箱历史全文分页（只读不消费，含已消费行）。 */
  xc_mail_read(args: MailReadArgs, connectionKey: string): Promise<ToolResult>;
  /** v0.5（R-22）：team.json 任务字段全文分页（锁外只读）。 */
  xc_task_read(args: TaskReadArgs, connectionKey: string): Promise<ToolResult>;
}

export function createToolCore(deps: ToolDeps): ToolCore {
  const { stateRoot, workspace } = deps;

  /**
   * 推送唤醒（必须已在团队锁外；M2 决策 wake|mailbox 并 fire-and-forget，§2.5）。
   * 目标无 sessionId（理论上注册路径必有）→ 直接 mailbox 兜底。
   */
  async function wake(
    toAgentKey: string,
    toSessionId: string | null,
    reason: string,
    receiptIds: readonly string[],
    ticket: string,
  ): Promise<{ delivered: "wake" | "mailbox"; wakeLog?: string; note?: string }> {
    if (toSessionId === null) {
      return { delivered: "mailbox", note: "target has no sessionId on file" };
    }
    const res = await attemptWake({
      stateRoot,
      teamId: TEAM_ID,
      toAgentKey,
      toSessionId,
      workspace,
      reason,
      receiptIds,
      ticket,
      env: deps.env,
    });
    return { delivered: res.delivered, wakeLog: res.wakeLog, note: res.note };
  }

  return {
    async xc_register(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const outcome = await xcRegister(stateRoot, args, connectionKey);
        return okResult(
          renderRegister(sanitizeKey(args.name), args.sessionId, outcome.teamId, outcome.roster, outcome.warnings),
          {
            sessionKey: outcome.sessionKey,
            teamId: outcome.teamId,
            roster: outcome.roster,
            protocolDigest: outcome.protocolDigest,
            via: outcome.via,
            ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
          },
        );
      });
    },

    async xc_dispatch(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityStore.require(connectionKey);
        const toKey = sanitizeKey(args.to);
        if (toKey === me.agentKey) throw invalidParamsError("cannot dispatch to yourself");
        const now = Date.now();

        const prepared = await withTeamLock(stateRoot, me.teamId, async () => {
          // 锁内重读重验（§2.7-4）。
          let team = await readTeam(stateRoot, me.teamId);
          let teamResetWarning: string | undefined;
          if (team === undefined) {
            // 防御分支：注册路径已建队；首个派发者自动建队并成为 founder（§2.2）。
            // v0.5.1（故障注-5 修复）：真源丢失后的自动建队不再静默——有残迹
            // （邮箱/快照）即审计 `team-reset-detected` 并在响应负载里带告警。
            teamResetWarning = await noteTeamReset(stateRoot, me.teamId);
            team = newTeamState({ teamId: me.teamId, name: me.teamId, founderKey: me.agentKey, now });
          }
          requireMember(team, toKey); // §2.6：to 必须是已注册成员
          for (const dep of args.dependsOn ?? []) {
            if (getTask(team, dep) === undefined) {
              throw invalidParamsError(`dependsOn references unknown task "${dep}"`);
            }
          }

          const ticket = ticketText(args);
          // duplicate 幂等判定（移植 dsh tools.js:2088-2093）。与 M2 findDuplicateMail
          // 的差异：派发消息带新 taskId（重试时无法预知，t2≠t1），故幂等键不含 taskId
          // 比较——同 from+同票+同源字段+仍在效期+未被消费 即判重复。
          const existing = await readMailbox(stateRoot, me.teamId, toKey);
          const myOpen = memberOpenTasks(team.tasks, me.agentKey)[0];
          const dup = existing.find(
            (m) =>
              m.from === me.agentKey &&
              m.to === toKey &&
              m.content === ticket &&
              m.attemptId === undefined &&
              m.sourceTaskId === myOpen?.id &&
              m.sourceAttemptId === myOpen?.attemptId &&
              isCurrentMail(team, m) &&
              m.readAt === undefined,
          );
          if (dup !== undefined) {
            const task = getTask(team, dup.taskId ?? "");
            return {
              kind: "duplicate" as const,
              taskId: dup.taskId ?? "",
              status: task?.status ?? "pending",
            };
          }

          // 建任务（pending，M1 makeTask 推进 seq 并入队）+ 写 to 邮箱（§2.8）。
          const task = makeTask(team, {
            title: args.title.trim(),
            prompt: args.prompt,
            acceptance: args.acceptance?.trim() || undefined,
            dependsOn: args.dependsOn,
            createdBy: me.agentKey,
          }, now);
          appendTaskHistory(task, "created", me.agentKey, undefined, now);

          // source 字段快照（移植 dsh tools.js:2111-2114：发送者当前开放 attempt）。
          const extras: MessageExtras = {
            taskId: task.id,
            deliveryClaimedAt: now,
            ...(myOpen?.attemptId != null
              ? { sourceTaskId: myOpen.id, sourceAttemptId: myOpen.attemptId, sourceTaskStatus: myOpen.status }
              : {}),
          };
          const message = createMessage(me.agentKey, toKey, ticket, extras);
          await appendMailbox(stateRoot, me.teamId, toKey, message);
          await writeTeam(stateRoot, team);
          return {
            kind: "created" as const,
            taskId: task.id,
            status: "pending" as const,
            messageId: message.id,
            toSessionId: team.members.find((m) => m.key === toKey)?.sessionId ?? null,
            teamResetWarning,
          };
        });

        if (prepared.kind === "duplicate") {
          return okResult(
            `Task ${prepared.taskId} already dispatched (duplicate); no new task created.`,
            { taskId: prepared.taskId, status: prepared.status, delivered: "duplicate" },
          );
        }

        // 锁外投递（§2.5 三重启用条件由 M2 判定；wake 失败=mailbox，不丢消息）。
        const sent = await wake(toKey, prepared.toSessionId, "dispatch", [prepared.messageId], ticketText(args));
        await logEngineEvent(stateRoot, {
          event: "dispatch",
          teamId: me.teamId,
          taskId: prepared.taskId,
          from: me.agentKey,
          to: toKey,
          delivered: sent.delivered,
          messageId: prepared.messageId,
        });
        return okResult(renderDispatch(prepared.taskId, toKey, sent.delivered), {
          taskId: prepared.taskId,
          status: prepared.status,
          delivered: sent.delivered,
          ...(prepared.teamResetWarning !== undefined ? { teamResetWarning: prepared.teamResetWarning } : {}),
          ...(sent.wakeLog ? { wakeLog: sent.wakeLog } : {}),
          ...(sent.note ? { note: sent.note } : {}),
        });
      });
    },

    async xc_check_inbox(_args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityStore.require(connectionKey);
        const now = Date.now();

        const teamBefore = await readTeam(stateRoot, me.teamId);
        if (teamBefore === undefined) {
          return okResult(renderInbox(0, 0, 0), { messages: [], unreadCount: 0 });
        }

        // 收件箱消费走 team 锁：锁内用 M1 readCurrentMailboxLocked（陈旧消息就地
        // discarded 落盘并剔除），正当消息此刻即消费（acknowledgeMailbox，§2.8）。
        // v0.5.1（故障注-4 修复）：只消费未读——README 承诺「读取并消费自己邮箱的
        // 未读消息」，此前 current 含已读件（readAt 已盖章）被无条件重注入，重注入
        // 量随邮箱历史无界增长。陈旧清扫仍作用于全部现行消息（含已读），但注入面
        // 只承载 readAt 缺省的未读件：第二次起 `0 message(s) consumed`。
        // v0.5.1（故障注-3 修复）：不可解析坏行经诊断收集器透出，摘要行披露
        // `N unreadable line(s) skipped`（此前静默当空箱/吞行，只有审计留痕）；
        // 就地丢弃的陈旧件数一并接入摘要行（此前 renderInbox 的 discarded 恒为
        // 硬编码 0，陈旧清扫不可见）。
        const diagnostics: MailboxReadDiagnostics = { malformed: [], discarded: 0 };
        // v0.5.1（SCALE-1 修复）：批次注入预算接入消费路径——单次只消费「JSON 面 +
        // 信封面」联合成本 ≤ 批次预算（budget.total）的**到达序前缀**（保底一条）；
        // 其余正当消息**保持未读**（留在邮箱，下一次 xc_check_inbox 继续消费）。
        // 此前 300 条积压单次直灌 201,193 字符（裁决 #18，>批次上限 3.1 倍）且无指针；
        // 修复后单次响应有界（≈16k 基准），分页指针 = 批次截断提示 + unreadCount。
        const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
        const consumed = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = (await readTeam(stateRoot, me.teamId)) ?? teamBefore;
          const current = await readCurrentMailboxLocked(stateRoot, team, me.agentKey, undefined, diagnostics);
          const unread = current.filter((m) => m.readAt === undefined);
          const entries = unread.map((m) => inboxEntry(m, budget.item));
          const windowCount = batchWindowCount(entries.map((e) => e.cost), budget.total);
          await acknowledgeMailbox(stateRoot, me.teamId, me.agentKey, unread.slice(0, windowCount).map((m) => m.id), now);
          return { messages: unread.slice(0, windowCount), entries: entries.slice(0, windowCount), totalUnread: unread.length };
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
        // 只置 readAt），截断只发生在返回 payload；content[2] 追加逐条信封块（content[0]
        // renderInbox 摘要与 content[1] JSON payload 契约不变）。
        const truncatedCount = consumed.entries.filter((e) => e.truncated).length;
        const messages = consumed.entries.map((e) => e.entry);
        const envelopeBlocks = consumed.entries.map((e) => e.block);
        if (batchTruncated) {
          envelopeBlocks.push(
            `[批次已按注入预算截断：本批消费 ${consumed.messages.length}/${consumed.totalUnread} 条；`
            + "其余保持未读——再调一次 xc_check_inbox 继续消费]",
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
              ? ` 本批按注入预算（${budget.total} 字符）截断：只消费 ${consumed.messages.length}/${consumed.totalUnread} 条，其余保持未读——再调一次 xc_check_inbox 继续`
              : "",
          ),
          {
            messages,
            unreadCount,
            ...(diagnostics.malformed.length > 0 ? { malformedLines: diagnostics.malformed.length } : {}),
            ...(diagnostics.discarded > 0 ? { staleDiscarded: diagnostics.discarded } : {}),
            ...(batchTruncated ? { batchTruncated: true, batchTotalUnread: consumed.totalUnread, batchBudgetChars: budget.total } : {}),
          },
        );
        if (envelopeText !== "") {
          result.content.push({ type: "text", text: envelopeText });
        }
        return result;
      });
    },

    async xc_claim(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityStore.require(connectionKey);
        const out = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet; register first" });
          requireMember(team, me.agentKey); // 会籍有效（§2.6）
          if (team.phase === "halted") {
            throw new ToolError({ error: "team_halted", message: `team "${me.teamId}" is halted` });
          }
          const task = getTask(team, args.taskId);
          if (task === undefined) {
            // v0.5.1（故障注-2 修复）：unknown task 不再裸报。若本人邮箱仍有指向
            // 该任务的分派/回执信封（孤儿引用），说明真源任务段丢失（被清空/
            // 截断/整队重置）而在途凭证无声蒸发——给出可行动诊断与恢复指引。
            const orphans = orphanTaskIds(team, await readMailbox(stateRoot, team.teamId, me.agentKey));
            if (orphans.includes(args.taskId)) {
              throw new ToolError({
                error: "orphan_task_reference",
                taskId: args.taskId,
                message:
                  `unknown task "${args.taskId}"; your mailbox still holds envelope(s) referencing it — ` +
                  `the team state lost its task list (truncated or reset). ` +
                  `Check the xc_status orphan warnings and ask the dispatcher to re-dispatch`,
              });
            }
            throw invalidParamsError(`unknown task "${args.taskId}"`);
          }
          if (task.status !== "pending") {
            throw new ToolError({
              error: "task_not_pending",
              taskId: task.id,
              status: task.status,
              message: `task ${task.id} is ${task.status}; only pending tasks can be claimed`,
            });
          }
          // v0.5.2（故障注-1 二番战修复）：回滚矛盾闸。任务看着 pending，但派发方
          // 邮箱已持有它的 completed 回执 = 真源被陈旧备份回滚/手工改坏，已完成
          // 工作被静默退回。认领会重复执行已完成工作且与已发回执矛盾——硬拒并给
          // 可行动指引（合成回执无法越过闸：回执信封由 xc_report 终态写入，收件人
          // 恒为 task.createdBy；僵尸清扫回退附 failed 回执，不命中本闸）。
          {
            const createdByMail = await readMailbox(stateRoot, team.teamId, task.createdBy);
            const stale = staleCompletedReceiptTaskIds(team, createdByMail);
            if (stale.includes(task.id)) {
              throw new ToolError({
                error: "rollback_conflict",
                taskId: task.id,
                message:
                  `task ${task.id} looks pending but the mailbox of its dispatcher "${task.createdBy}" ` +
                  `holds a completed receipt for it — the team state was rolled back (stale backup restore or manual edit). ` +
                  `Claiming would silently re-execute completed work; ask the dispatcher to reconcile the board ` +
                  `(xc_status shows the staleCompletedReceipts warning) and re-dispatch a fresh task`,
              });
            }
          }
          const unmet = unsatisfiedDependencies(team.tasks, task.dependsOn);
          if (unmet.length > 0) {
            throw new ToolError({
              error: "dependencies_unmet",
              taskId: task.id,
              unmet,
              message: `task ${task.id} depends on [${unmet.join(", ")}] which are not completed`,
            });
          }
          const open = memberOpenTasks(team.tasks, me.agentKey)[0];
          if (open !== undefined) {
            // 防一人双线（§2.6，移植 dsh memberOpenTask 约束）。
            throw new ToolError({
              error: "already_has_open_task",
              taskId: open.id,
              message: `you already have open task ${open.id}; report it (xc_report) before claiming another`,
            });
          }
          const attemptId = beginTaskAttempt(task, me.agentKey, Date.now()); // attempt+1/assignee/pending→claimed
          await writeTeam(stateRoot, team);
          return {
            taskId: task.id,
            attemptId,
            attempt: task.attempt,
            title: task.title,
            prompt: task.prompt,
            acceptance: task.acceptance ?? "",
            dependsOn: task.dependsOn,
          };
        });
        await logEngineEvent(stateRoot, {
          event: "claim",
          teamId: me.teamId,
          taskId: out.taskId,
          by: me.agentKey,
          attemptId: out.attemptId,
        });
        // v0.5.1（SCALE-2 修复）：认领回显接入注入预算——600KB prompt 此前全文回显
        // （600,234 字符响应，裁决 #19）。截断只作用于响应 payload（team.json 真源
        // 全文不动，R-21）；分页指针 = xc_task_read（prompt/acceptance 字段，R-22）。
        // promptTruncated 携带全文 sha256（与 xc_status resultTruncated 同款，分页
        // 拼回可终验）；未截断时 payload 形状与 v0.5.0 逐字段一致。
        const claimBudget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
        const promptCut = truncateField(out.prompt, claimBudget.item, sha256Of);
        const acceptanceCut = truncateField(out.acceptance, claimBudget.item, sha256Of);
        return okResult(renderClaim(out.taskId, out.attempt, out.attemptId), {
          taskId: out.taskId,
          attemptId: out.attemptId,
          attempt: out.attempt,
          title: out.title,
          dependsOn: out.dependsOn,
          prompt: promptCut.text,
          acceptance: acceptanceCut.text,
          ...(promptCut.truncated
            ? { promptTruncated: promptCut.truncated, promptPointer: "xc_task_read" }
            : {}),
          ...(acceptanceCut.truncated
            ? { acceptanceTruncated: acceptanceCut.truncated, acceptancePointer: "xc_task_read" }
            : {}),
        });
      });
    },

    async xc_report(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityStore.require(connectionKey);
        // 慢操作在锁外：证据门（§2.8 evidence 格式；note 必填，缺省空串）。
        // 每条证据文件必须真实存在，sha256 一律由工具现算复核（边界与-3/边界与-4 修复）：
        // 文件缺失/不可读 → evidence_file_missing；调用方声明值（非 null）与现算值
        // 不符 → evidence_checksum_mismatch。声明值缺省或显式 null 均视为未声明，
        // 落库存现算值（工具描述承诺「缺省时由工具对文件现算」，不再落 sha256:null）。
        // v0.5.2（边界与-R2-5 修复，集成环节补）：证据路径工作区遏制——`../` 穿越与
        // 绝对路径此前均可指向工作区外的任意可读文件（路径+现算 sha256 入库并随回执
        // 分发，红队二番战 r2-5 实测完成入库）。证据必须落在工作区内（resolve 后前缀
        // 比对，Windows 按大小写不敏感；路径边界用分隔符防同前缀兄弟目录绕过）。
        const evidence: EvidenceItem[] = [];
        const wsRoot = resolve(deps.workspace);
        const wsPrefix = wsRoot.endsWith(sep) ? wsRoot : wsRoot + sep;
        const samePath = (a: string, b: string): boolean =>
          process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
        const underWorkspace = (abs: string): boolean =>
          samePath(abs, wsRoot)
          || (process.platform === "win32"
            ? abs.toLowerCase().startsWith(wsPrefix.toLowerCase())
            : abs.startsWith(wsPrefix));
        for (const e of args.evidence ?? []) {
          const abs = resolve(e.path);
          if (!underWorkspace(abs)) {
            throw new ToolError({
              error: "evidence_path_outside_workspace",
              path: e.path,
              workspace: wsRoot,
              message: `evidence file "${e.path}" resolves outside the workspace (${wsRoot}); `
                + `evidence must live inside the shared workspace (§2.6 evidence gate, v0.5.2 containment)`,
            });
          }
          const computed = await sha256File(e.path);
          if (computed === null) {
            throw new ToolError({
              error: "evidence_file_missing",
              path: e.path,
              message: `evidence file "${e.path}" does not exist or is unreadable; the evidence gate requires a real file (§2.6)`,
            });
          }
          if (e.sha256 != null && e.sha256 !== computed) {
            throw new ToolError({
              error: "evidence_checksum_mismatch",
              path: e.path,
              claimed: e.sha256,
              computed,
              message: `evidence sha256 mismatch for "${e.path}": claimed ${e.sha256}, computed ${computed}`,
            });
          }
          evidence.push({ path: e.path, sha256: computed, note: e.note ?? "" });
        }

        const out = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet" });
          requireMember(team, me.agentKey);
          const task = getTask(team, args.taskId);
          if (task === undefined) throw invalidParamsError(`unknown task "${args.taskId}"`);
          // ---- §2.6 硬校验（结构化错误码优先，M1 纯函数兜底复核）----
          if (task.assignee !== null && task.assignee !== me.agentKey) {
            throw new ToolError({
              error: "not_assignee",
              taskId: task.id,
              assignee: task.assignee,
              message: `task ${task.id} is assigned to "${task.assignee}", not you`,
            });
          }
          if (task.attemptId !== null && args.attemptId !== task.attemptId) {
            throw staleAttemptError(task.id, task.attemptId); // attempt 令牌不匹配 = 硬拒
          }
          if (args.status === "completed" && (!(args.result ?? "").trim() || evidence.length < 1)) {
            throw new ToolError({
              error: "incomplete_completion",
              taskId: task.id,
              message: "status=completed requires non-empty result and at least one evidence entry (§2.6)",
            });
          }
          const m1Reject = reportTransitionError(
            task,
            { status: args.status, attemptId: args.attemptId, result: args.result, error: args.error, evidence },
            me.agentKey,
          );
          if (m1Reject !== undefined) {
            throw new ToolError({
              error: "illegal_transition",
              taskId: task.id,
              from: task.status,
              to: args.status,
              message: m1Reject,
            });
          }

          applyReport(task, {
            status: args.status,
            attemptId: args.attemptId,
            result: args.result,
            error: args.error,
            evidence: evidence.length > 0 ? evidence : undefined,
          }, me.agentKey, Date.now());
          await writeTeam(stateRoot, team);

          // 终态 → 给派发方邮箱写回执消息（§2.9-1）。
          // 注意：回执不带 sourceAttemptId（attempt 关联保留在回执 JSON 内容里，
          // receiptText）。M1 applyReport 在终态保留 attemptId（dsh parity，
          // teamstate.ts "attemptId is NOT cleared on terminal"），因此回执即使带
          // sourceAttemptId 也能通过 isCurrentMail（终态快照与 sourceTaskStatus
          // 一致即放行）；不带它让回执的新鲜性只由任务终态承担，语义更简单——
          // attempt 作废语义由任务 history 承担（重派换代后旧回执随旧 attempt 失效）。
          let receipt: { to: string; messageId: string } | null = null;
          if (TERMINAL_TASK_STATUSES.includes(args.status)) {
            const to = task.createdBy;
            const extras: MessageExtras = {
              taskId: task.id,
              sourceTaskId: task.id,
              sourceTaskStatus: args.status,
              deliveryClaimedAt: Date.now(),
            };
            const msg = createMessage(
              me.agentKey,
              to,
              receiptText(task.id, args.attemptId, args.status, task),
              extras,
            );
            await appendMailbox(stateRoot, me.teamId, to, msg);
            receipt = { to, messageId: msg.id };
          }
          return {
            taskId: task.id,
            status: args.status,
            reportedAt: Date.now(),
            receipt,
            toSessionId: receipt
              ? (team.members.find((m) => m.key === receipt.to)?.sessionId ?? null)
              : null,
          };
        });

        // 锁外唤醒派发方（§2.9-2）。
        let wakeBack: "wake" | "mailbox" = "mailbox";
        if (out.receipt !== null) {
          const sent = await wake(
            out.receipt.to,
            out.toSessionId,
            "report",
            [out.receipt.messageId],
            `收到 CrossChat 回执：task ${out.taskId} = ${out.status}`,
          );
          wakeBack = sent.delivered;
        }
        await logEngineEvent(stateRoot, {
          event: "report",
          teamId: me.teamId,
          taskId: out.taskId,
          status: out.status,
          by: me.agentKey,
          attemptId: args.attemptId,
          wakeBack,
        });
        return okResult(renderReport(out.taskId, out.status, out.receipt?.to ?? null, wakeBack), {
          taskId: out.taskId,
          status: out.status,
          reportedAt: out.reportedAt,
          wakeBack,
        });
      });
    },

    async xc_message(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityStore.require(connectionKey);
        const toKey = sanitizeKey(args.to);
        if (toKey === me.agentKey) throw invalidParamsError("cannot message yourself");
        if ((args.sourceTaskId === undefined) !== (args.sourceAttemptId === undefined)) {
          // dsh 同款：source 两字段必须成对。
          throw invalidParamsError("sourceTaskId and sourceAttemptId must be provided together");
        }
        // v0.5（R-13）：forwardOf 与自定义正文互斥——批注/原文分两条。
        if (args.forwardOf !== undefined && args.content !== undefined) {
          throw invalidParamsError("forwardOf cannot be combined with content; send the annotation as a separate message (R-13)");
        }
        // v0.5（R-13 语义分界）：转发不携带任务溯源（source* 不继承）；任务关联的批注另发一条。
        if (args.forwardOf !== undefined && (args.sourceTaskId !== undefined || args.sourceAttemptId !== undefined)) {
          throw invalidParamsError("forwardOf carries no task attribution; send the task-related annotation as a separate message (R-13)");
        }
        if (args.forwardOf === undefined && args.content === undefined) {
          throw invalidParamsError("content is required (or pass forwardOf to forward a received message)");
        }
        const now = Date.now();

        // v0.5（R-12 盖章链）：落盘前把待发正文与本会话用户原话环形记录逐字节匹配——
        // 命中 → 消息带 origin:"user" + originSessionId（唯一 origin=user 产生路径；
        // 工具 schema 无 origin 参数，正文自称无效）。转发分支跳过（origin 来自被转消息）。
        // v0.5.2（二番战 SEC-1 修复）：盖章前先验会话归属（verifyUservoiceStampAuthority，
        // 与 peer 轴同一道闸）——uservoice/注册表锚均机器全局或可跨工作区共享，冒充
        // 他人 sid 的会话此前能逐字节命中**受害者**的原话记录并偷走 origin=user
        // 权威标记。未锚定或 sid 被别的活进程持有时拒绝盖章（消息照发，origin 缺省
        // =agent，fail-closed），并落 uservoice-stamp-refused 审计。
        const stamp = args.forwardOf === undefined && args.content !== undefined
          ? await (async () => {
              const authority = await verifyUservoiceStampAuthority(peerRootFromEnv(deps.env), stateRoot, me.sessionId);
              if (!authority.ok) {
                await logEngineEvent(stateRoot, {
                  event: "uservoice-stamp-refused",
                  sessionId: me.sessionId,
                  reason: authority.reason,
                });
                return { hit: false as const, reason: authority.reason };
              }
              return await uservoiceMatchAndConsume(peerRootFromEnv(deps.env), me.sessionId, args.content!, now, deps.env);
            })()
          : { hit: false as const, reason: "no-match" as const };

        const out = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet" });
          const recipient = team.members.find((m) => m.key === toKey);
          if (recipient === undefined) {
            throw new ToolError({
              error: "not_a_member",
              agentKey: toKey,
              message: `"${toKey}" is not a member of team "${team.teamId}"`,
            });
          }

          // v0.5（R-13 转发保真，队内版）：在本人邮箱 JSONL（含已读行）按 id 查找被转消息——
          // 新 TeamMessage：from=转发者（如实署名）、origin/originSessionId 保留原值、
          // content=原 content；source* 任务字段不继承（那是任务溯源，不是说话人溯源）。
          let content: string;
          let forwardedOrigin: { origin?: "user" | "agent"; originSessionId?: string } = {};
          const src: MessageExtras = {};
          if (args.forwardOf !== undefined) {
            const orig = (await readMailbox(stateRoot, me.teamId, me.agentKey)).find((m) => m.id === args.forwardOf);
            if (orig === undefined) {
              throw invalidParamsError(`unknown messageId "${args.forwardOf}"; only messages in your own mailbox can be forwarded`);
            }
            content = orig.content;
            forwardedOrigin = {
              ...(orig.origin !== undefined ? { origin: orig.origin } : {}),
              ...(orig.originSessionId !== undefined ? { originSessionId: orig.originSessionId } : {}),
            };
          } else {
            content = args.content!;
            // source 解析（移植 dsh send_message：显式成对字段，否则取发送者开放 attempt）。
            if (args.sourceTaskId !== undefined) {
              const task = getTask(team, args.sourceTaskId);
              if (task === undefined) throw invalidParamsError(`unknown sourceTaskId "${args.sourceTaskId}"`);
              if (task.assignee !== me.agentKey || task.attemptId !== args.sourceAttemptId) {
                throw new ToolError({
                  error: "stale_source_attempt",
                  sourceTaskId: args.sourceTaskId,
                  message: "stale or foreign source attempt; stop sending results from the revoked task",
                });
              }
              src.sourceTaskId = task.id;
              src.sourceAttemptId = args.sourceAttemptId;
              src.sourceTaskStatus = task.status;
            } else {
              const myOpen = memberOpenTasks(team.tasks, me.agentKey)[0];
              if (myOpen?.attemptId != null) {
                src.sourceTaskId = myOpen.id;
                src.sourceAttemptId = myOpen.attemptId;
                src.sourceTaskStatus = myOpen.status;
              }
            }
          }

          // 收件人开放 attempt 快照（§2.4：attemptId=收件人当前开放 attempt）。
          const rec: MessageExtras = {};
          const owned = memberOpenTasks(team.tasks, toKey)[0];
          if (owned?.attemptId != null) {
            rec.taskId = owned.id;
            rec.attemptId = owned.attemptId;
          }

          // duplicate 去重（M2 findDuplicateMail，逐条件对应 dsh tools.js:2088-2093）。
          const existing = await readMailbox(stateRoot, me.teamId, toKey);
          const dup = findDuplicateMail(existing, team, {
            from: me.agentKey,
            content,
            taskId: rec.taskId,
            attemptId: rec.attemptId,
            sourceTaskId: src.sourceTaskId,
            sourceAttemptId: src.sourceAttemptId,
            sourceTaskStatus: src.sourceTaskStatus,
          });
          if (dup !== undefined) {
            return { delivered: "duplicate" as const, messageId: dup.id, toSessionId: recipient.sessionId };
          }

          const msg = createMessage(me.agentKey, toKey, content, {
            ...src,
            ...rec,
            deliveryClaimedAt: now,
            // v0.5（R-11）：盖章命中 → origin=user；forwardOf → 被转消息的 origin 原值透传
            //（两分支互斥——转发跳过盖章）。absent = agent 缺省（wire/渲染层同规）。
            ...(stamp.hit ? { origin: "user" as const, originSessionId: me.sessionId } : forwardedOrigin),
          });
          await appendMailbox(stateRoot, me.teamId, toKey, msg);
          return { delivered: null, messageId: msg.id, toSessionId: recipient.sessionId, content };
        });

        if (stamp.hit) {
          await logEngineEvent(stateRoot, {
            event: "uservoice-hit",
            teamId: me.teamId,
            msgId: out.messageId,
            uses: stamp.uses,
          });
        }

        let delivered: "wake" | "mailbox" | "duplicate";
        if (out.delivered === "duplicate") {
          delivered = "duplicate";
        } else {
          const sent = await wake(toKey, out.toSessionId, "message", [out.messageId], out.content);
          delivered = sent.delivered;
        }
        await logEngineEvent(stateRoot, {
          event: "message",
          teamId: me.teamId,
          messageId: out.messageId,
          from: me.agentKey,
          to: toKey,
          delivered,
        });
        return okResult(renderMessage(out.messageId, me.agentKey, toKey, delivered), {
          messageId: out.messageId,
          delivered,
        });
      });
    },

    async xc_status(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const teamId = args.teamId?.trim() || TEAM_ID;
        // v0.5.1（BND-1 修复）：调用方可控 teamId 在触碰任何路径构建器前先过
        // 段合法性闸——`../../evil` 之类穿越串此前会经 join 逃出状态根建目录并
        // 写 snapshot.json（且可控字符串进 engine.jsonl 审计）。缺省 teamId
        // （default）与产品自建队恒为安全段，不受影响。
        if (!isValidTeamId(teamId)) {
          throw invalidParamsError(
            `teamId ${JSON.stringify(teamId)} is not a valid team name ` +
              "(single path segment: starts with a letter/digit, then letters/digits/._-, max 128 chars); " +
              "path separators, traversal segments and drive syntax are rejected",
          );
        }
        const me = identityStore.get(connectionKey); // 豁免注册（§2.8）：未注册省略个人字段
        const team = await readTeam(stateRoot, teamId);
        const now = Date.now();
        // v0.5（R-23）：任务 result/error 观测面截断（磁盘真源 team.json 不动，xc_task_read 拉全文）。
        const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);

        const snapshot: StatusSnapshot = {
          teamId,
          generatedAt: now,
          phase: team?.phase ?? "none",
          founderKey: team?.founderKey ?? "(no team yet)",
          members: (team?.members ?? []).map((m) => ({
            key: m.key,
            sessionId: m.sessionId,
            role: m.role,
            lastSeen: m.lastSeen,
          })),
          tasks: (team?.tasks ?? []).map((t) => {
            const result = t.result === null ? null : truncateField(t.result, budget.item, sha256Of);
            const error = t.error === null ? null : truncateField(t.error, budget.item, sha256Of);
            return {
              id: t.id,
              title: t.title,
              status: t.status,
              assignee: t.assignee,
              attempt: t.attempt,
              attemptId: t.attemptId,
              dependsOn: t.dependsOn,
              createdBy: t.createdBy,
              result: result === null ? null : result.text,
              ...(result !== null && result.truncated ? { resultTruncated: result.truncated } : {}),
              error: error === null ? null : error.text,
              ...(error !== null && error.truncated ? { errorTruncated: error.truncated } : {}),
              evidenceCount: t.evidence.length,
              updatedAt: t.updatedAt,
            };
          }),
          unread: {},
        };

        if (team !== undefined) {
          // 读路径无锁（§2.7-5：rename 原子写保证读者看到完整文件）。
          // v0.5.1（故障注-2 修复）：同一批邮箱读取顺带计算孤儿任务引用——
          // 邮箱信封指向 team.tasks 中不存在的任务 = 真源任务段丢失（被清空/
          // 截断/整队重置）而在途工作无声蒸发。非空时披露进快照与渲染行，
          // 静默丢任务变为可观测。
          // v0.5.2（故障注-1 二番战修复）：同一批读取再顺带检测「任务板与回执链
          // 矛盾」——邮箱已有某任务的 completed 回执而任务板上它仍是未完成态 =
          // 真源被陈旧备份回滚（已完成工作静默退回，可被重复认领）。非空时披露
          // 进快照（staleCompletedReceipts）与渲染 WARNING，矛盾持续可观测
          // （含 server 重启后，纯磁盘态计算）。
          const orphanTasks: Record<string, string[]> = {};
          const staleReceipts: Record<string, string[]> = {};
          for (const m of team.members) {
            const msgs = await readMailbox(stateRoot, teamId, m.key);
            snapshot.unread[m.key] = countUnread(team, msgs);
            const orphans = orphanTaskIds(team, msgs);
            if (orphans.length > 0) orphanTasks[m.key] = orphans;
            const stale = staleCompletedReceiptTaskIds(team, msgs);
            if (stale.length > 0) staleReceipts[m.key] = stale;
          }
          if (Object.keys(orphanTasks).length > 0) {
            snapshot.orphanTasks = orphanTasks;
          }
          if (Object.keys(staleReceipts).length > 0) {
            snapshot.staleCompletedReceipts = staleReceipts;
          }
          if (me !== undefined) {
            snapshot.me = { agentKey: me.agentKey, unread: snapshot.unread[me.agentKey] ?? 0 };
          }
        }
        // v0.5.2（故障注-1 二番战修复）：备份恢复披露——恢复态疑似陈旧（含回滚
        // 矛盾明细）时在快照带 stateRecovery；台账在真源被任意变更工具重写后清除。
        const recoveryNotice = lastTeamRecoveryNotice(stateRoot, teamId);
        if (recoveryNotice !== undefined) {
          snapshot.stateRecovery = {
            at: recoveryNotice.at,
            defect: recoveryNotice.defect,
            backup: recoveryNotice.backup,
            rolledBackTaskIds: recoveryNotice.rolledBackTaskIds,
          };
        }

        await writeSnapshot(stateRoot, teamId, snapshot); // §2.8/§4.3：每次调用刷新 snapshot.json
        const orphanTasks = snapshot.orphanTasks;
        const staleCompletedReceipts = snapshot.staleCompletedReceipts;

        // v0.5.2（SCALE-1 修复）：板面接入注入预算。此前 snapshot.tasks 全量进
        // 响应（人可读表格 + JSON tasks 双份），700 任务 = 279,678 字符、1,000 任务
        // = 399,382 字符，且 XC_CONTEXT_CHARS 声明 4× 预算输出不变（预算根本没被
        // 查询）——README「注入面（钩子信封/工具响应/快照）按接收方声明的上下文
        // 预算自适应截断」在板面失效。现在按「人可读行 + JSON 条目」联合成本开
        // 到达序窗口（保底一条），窗口外任务不进响应、由 boardTruncated 指针 +
        // xc_status{offset} 分页续读；**snapshot.json 落盘仍是全量**（R-21）。
        const allTasks = snapshot.tasks;
        const boardOffset = Math.max(0, Math.trunc(args.offset ?? 0));
        const page = allTasks.slice(boardOffset);
        // 固定面成本（表头/成员/孤儿告警/DAG 之外的非任务行人可读面 + JSON 面元数据
        // + leadHistory + 截断指针行）先从批次预算里扣，剩余才给任务窗口。
        const historyEntries = args.history === true && team !== undefined ? (team.leadHistory ?? []) : [];
        const historyCosts = historyEntries.map((entry) => JSON.stringify(entry).length + 2);
        const fixedChars =
          renderStatusTable({ ...snapshot, tasks: [] }).length
          + STATUS_TASK_TABLE_HEADER.length
          + JSON.stringify({ ...snapshot, tasks: [] }).length
          + BOARD_TRUNCATION_NOTE_MAX_CHARS;
        const nonTaskBudget = Math.max(0, budget.total - fixedChars);
        // history 面先花（通常很小），剩余给板面；两侧都保底一条（batchWindowCount 纪律）。
        const historyShown = args.history === true
          ? batchWindowCount(historyCosts, nonTaskBudget)
          : 0;
        const historySpent = historyCosts.slice(0, historyShown).reduce((sum, cost) => sum + cost, 0);
        const boardCosts = page.map((t) => statusTaskRowText(t).length + JSON.stringify(t).length);
        const boardShown = batchWindowCount(boardCosts, Math.max(0, nonTaskBudget - historySpent));
        const windowedTasks = page.slice(0, boardShown);
        const historyTruncated = historyShown < historyEntries.length;
        const boardTruncated = boardOffset + boardShown < allTasks.length;

        await logEngineEvent(stateRoot, {
          event: "status",
          teamId,
          agentKey: me?.agentKey ?? null,
          tasks: snapshot.tasks.length,
          ...(orphanTasks !== undefined ? { orphanAgents: Object.keys(orphanTasks).length } : {}),
          // v0.5.2（SCALE-1）：板面窗口化后，审计同时记本页呈现条数（截断时可观测）。
          ...(boardTruncated ? { boardShown: boardShown, boardOffset: boardOffset, boardBudgetChars: budget.total } : {}),
        });

        // v0.5（R-7）：落盘 snapshot 与返回 payload 分离——持久化对象不含 isLead/leadHistory，
        // payload 在其上现算叠加（isLead 不入盘不入快照；history:true 附 lead 变更史）。
        const payload = {
          ...snapshot,
          tasks: windowedTasks,
          members: team !== undefined
            ? snapshot.members.map((m) => ({ ...m, isLead: m.key === leadKeyOf(team) }))
            : snapshot.members,
          ...(args.history === true && team !== undefined
            ? {
                leadKey: team.leadKey ?? null,
                leadSince: team.leadSince ?? null,
                leadHistory: historyEntries.slice(0, historyShown),
                ...(historyTruncated
                  ? { leadHistoryTruncated: { shown: historyShown, total: historyEntries.length, budgetChars: budget.total } }
                  : {}),
              }
            : {}),
          ...(boardTruncated
            ? {
                boardTruncated: {
                  shown: boardShown,
                  total: allTasks.length,
                  offset: boardOffset,
                  budgetChars: budget.total,
                },
              }
            : {}),
        };
        // v0.5.2（故障注-1 二番战修复）：回滚矛盾与备份恢复的人可读 WARNING 行
        // （与孤儿告警同款披露口径；结构化面已带 staleCompletedReceipts/stateRecovery）。
        const rollbackWarnings: string[] = [];
        if (staleCompletedReceipts !== undefined) {
          const parts = Object.entries(staleCompletedReceipts)
            .map(([agentKey, ids]) => `${agentKey}: ${ids.join(", ")}`)
            .join("; ");
          rollbackWarnings.push(
            `WARNING board/receipt contradiction (tasks show unfinished but a completed receipt is on file — state was rolled back, claiming those tasks is refused): ${parts}`,
          );
        }
        const recoveryWarning = teamRecoveryWarning(stateRoot, teamId);
        if (recoveryWarning !== undefined) rollbackWarnings.push(recoveryWarning);
        const text = renderStatusTable({ ...snapshot, tasks: windowedTasks })
          + (boardTruncated
            ? `\n${renderBoardTruncationNote(boardOffset + boardShown, allTasks.length, budget.total)}`
            : "")
          + (rollbackWarnings.length > 0 ? `\n${rollbackWarnings.join("\n")}` : "");
        return okResult(text, payload);
      });
    },

    /**
     * xc_mail_read（v0.5 R-22，DESIGN-V0.5 §5.5）：读本人邮箱 JSONL 历史件（含已消费行）
     * 的全文分页——只读不消费；邮箱行全文保留（acknowledgeMailbox 只置 readAt），
     * xc_check_inbox 截断视图的超读通道。
     */
    async xc_mail_read(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityStore.require(connectionKey);
        const message = (await readMailbox(stateRoot, me.teamId, me.agentKey)).find((m) => m.id === args.messageId);
        if (message === undefined) {
          throw invalidParamsError(`unknown messageId "${args.messageId}"; xc_mail_read only reads your own mailbox history`);
        }
        const itemBudget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env).item;
        const page = paginateText(message.content, args.offset, args.limit, itemBudget);
        return okResult(
          `Mailbox message ${message.id} from ${message.from}: ${page.total} chars (offset ${page.offset}, hasMore=${page.hasMore}).`,
          { messageId: message.id, total: page.total, offset: page.offset, text: page.text, hasMore: page.hasMore },
        );
      });
    },

    /**
     * xc_task_read（v0.5 R-22）：分页读 team.json 任务字段（result/error/prompt）——
     * 读路径无锁（tools.ts:397 读纪律同款）；xc_status 观测面截断的全文拉取通道。
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
// SDK 接线：把 ToolCore 挂到 stdio MCP server（工具实名 mcp__plugin_zcode-crosschat_crosschat__xc_*）
// ---------------------------------------------------------------------------

/** 注册全部 7 个工具（DESIGN §2.8）。coreOverride 供 v0.2 组装链注入包装后的核心（DESIGN-V0.2 §10.3）。 */
export function registerTools(server: McpServer, deps: ToolDeps, coreOverride?: ToolCore): void {
  const core = coreOverride ?? createToolCore(deps);

  server.tool(
    "xc_register",
    "Register this connection's session identity into the crosschat team (hook path or wakeToken path).",
    RegisterShape,
    async (args, extra) => core.xc_register(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_dispatch",
    "Dispatch a verifiable task to a registered member (creates pending task + mailbox message, then optionally wakes the target).",
    DispatchShape,
    async (args, extra) => core.xc_dispatch(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_check_inbox",
    "Read and consume this session's mailbox: current messages are marked read; stale ones discarded.",
    {},
    async (_args, extra) => core.xc_check_inbox({}, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_claim",
    "Atomically claim a pending task; returns the attempt token required by xc_report. Refuses with rollback_conflict when the dispatcher's mailbox already holds a completed receipt for this task (team state was rolled back by a stale backup restore).",
    ClaimShape,
    async (args, extra) => core.xc_claim(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_report",
    "Report task progress/completion/failure with the current attempt token; completion requires result and >=1 evidence.",
    ReportShape,
    async (args, extra) => core.xc_report(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_message",
    "Send a free-form message to a member (peer communication; duplicate-deduplicated). forwardOf=<messageId> forwards a message from your own mailbox verbatim (origin preserved; mutually exclusive with content — send annotations as a separate message).",
    MessageShape,
    async (args, extra) => core.xc_message(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_status",
    "Team snapshot: members (with isLead), task board (oversized result/error truncated with resultTruncated markers), unread counts. history:true appends the lead role change history. The task board itself is windowed to the receiver's declared injection budget (v0.5.2): when the board does not fit, the response carries only the window prefix plus boardTruncated{shown,total,offset,budgetChars} — page the rest with xc_status({offset}). Does not require registration; writes snapshot.json (always the full board).",
    StatusShape,
    async (args, extra) => core.xc_status(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_mail_read",
    "Read-only pager for your own mailbox history (messages already consumed included): returns the full text of one message, paginated. Does not consume.",
    MailReadShape,
    async (args, extra) => core.xc_mail_read(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_task_read",
    "Read-only pager for one task's result/error/prompt field from team.json (oversized fields are truncated in xc_status; read them back here in pages). Does not consume.",
    TaskReadShape,
    async (args, extra) => core.xc_task_read(args, connectionKeyOf(extra)),
  );
}

/** 解析状态根的便捷出口（server.ts / 测试共用；M1 paths.ts 的薄封装）。 */
export function resolveDeps(cwd: string, env: NodeJS.ProcessEnv = process.env): ToolDeps {
  const workspace = cwd;
  return { stateRoot: resolveStateRoot(workspace), workspace, env };
}

export type { MemberRole };
