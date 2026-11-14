/**
 * W4 lead-face：队长面三个新工具 xc_team_init / xc_idle / xc_cancel
 * （DESIGN-V0.2.md §3.1/§3.2 L1、§5.1 E-c + §5.3、§7.3.3、§9.1/§9.2）。
 *
 * 分层对齐 tools.ts（v0.1.0 M3）：本模块自带与 SDK 无关的 core 函数（runLeadTool
 * 把 LockBusyError 映射为 {error:"busy"}、其余经 protocol.mapToolError，永不抛出），
 * registerLeadTools(server, deps) 只做 SDK 接线；单测直接驱动 core。
 *
 * 身份纪律（DESIGN §2.3-2 / §7.4-I5 来源校验矩阵）：
 * - 三个工具一律不接受 from/caller 参数；身份 ≡ identityStore.require(connectionKey)
 *   的连接绑定（未注册连接 → not_registered）。
 * - xc_team_init：已存在其他 lead → lead_exists，不得抢位（§3.2 L1）。
 * - xc_idle：任何在册成员可发；收件人 = team.leadKey（未设置则 founderKey，§5.3）；
 *   调用者自身 roster state ∈ {provisioning, failed} → 只入箱不唤醒（R1 门控，§5.1 E-c/§6.3）。
 * - xc_cancel：调用者 = lead（leadKey；未设置时 founder 视为 lead，与 §6.1 同语义）
 *   或任务 createdBy → 否则 not_lead（§7.3.3）。
 *
 * 并发纪律（§2.7）：变更一律 withTeamLock 内「重读 → 校验 → 变更 → 写盘」；
 * attemptWake 只准在团队锁外调用（M2 持锁调用会死锁，tools.ts:15 纪律）；
 * 唤醒失败 = mailbox 兜底，消息不丢（§2.5）。
 *
 * W2/W3 对接：team.json 的 leadKey、成员 state/identity 由 W2 落盘于 core/types.ts
 * （§9.1，可选字段；访问器 memberState()=§6.5 缺省 ready 语义），本模块直接消费；
 * snapshot 刷新走 W3 的 refreshSnapshot（best-effort，失败静默——快照是观测面，
 * 永不影响工具结果，§7.3.1）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectionKeyOf, identityStore } from "./identity.js";
import { leadKeyOf } from "./member-tools.js";
import {
  errorResult,
  invalidParamsError,
  mapToolError,
  okResult,
  ToolError,
  type ToolResult,
} from "./protocol.js";
import { refreshSnapshot } from "../core/snapshot.js";
import { LockBusyError, withTeamLock } from "../core/lock.js";
import { appendMailbox, createMessage } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { sanitizeKey } from "../core/sanitize.js";
import { DEFAULT_TEAM_ID, MAX_LEAD_HISTORY, TERMINAL_TASK_STATUSES, memberState } from "../core/types.js";
import type { LeadHistoryEntry, MemberState } from "../core/types.js";
import { getTask, newTeamState, readTeam, transitionTask, writeTeam } from "../core/teamstate.js";
import { cascadeDependencyDeadlockLocked } from "./task-edges.js";
import { attemptWake } from "../engine/wake.js";

/** v1 单队固定 default（DESIGN §2.2）。 */
const TEAM_ID = DEFAULT_TEAM_ID;

// ---------------------------------------------------------------------------
// R1 唤醒门控（§5.1 E-c / §6.3）
// ---------------------------------------------------------------------------

/** R1 唤醒门控（§5.1 E-c / §6.3）：供给中或失败的成员只入箱，不触发唤醒。 */
function blocksWake(provisionState: MemberState): boolean {
  return provisionState === "provisioning" || provisionState === "failed";
}

// ---------------------------------------------------------------------------
// zod 入参 schema
// ---------------------------------------------------------------------------

/** xc_idle 的 idleReason 取值约定（§5.3，对齐 11-cc逆向 §3c-4 idle_notification）。 */
export const IDLE_REASONS = ["no-claimable-task", "inbox-empty", "blocked-only"] as const;

export const TeamInitShape = {
  // v0.5（R-1 经 F-4）：第三种指派形态——接管现任 lead。默认（不带本参数）行为逐字节不变。
  takeover: z.boolean().optional().describe("接管现任 lead（仅在用户明确指令时使用）：通知旧 lead、写 leadHistory(reason=takeover)、全程审计"),
};
export const IdleShape = {
  summary: z.string().min(1).describe("最终答案/空闲原因摘要（守则 v2 第 3 条：必填）"),
  idleReason: z.enum(IDLE_REASONS).optional().describe("缺省 no-claimable-task"),
  completedTaskId: z.string().optional().describe("刚完成的任务 id（守则 v2：附上）"),
  completedStatus: z.string().optional().describe("刚完成任务的状态（completed/failed/…）"),
  failureReason: z.string().optional().describe("失败原因（对齐 CC idle_notification 结构）"),
  result: z.string().optional().describe("最终答案全文/结果摘要"),
};
export const CancelShape = {
  taskId: z.string().min(1).describe("要取消的任务 id"),
};

/** v0.5（R-2）：xc_lead_transfer 入参（lead-tools.ts 新增 core，DESIGN-V0.5 §3.1）。 */
export const LeadTransferShape = {
  to: z.string().min(1).describe("移交目标成员名（sanitizeKey 归一；须在册且未 removed）"),
  reason: z.string().optional().describe("移交原因（入 leadHistory 与审计，不参与逻辑）"),
};
/** v0.5（R-3）：xc_lead_release 入参。 */
export const LeadReleaseShape = {};

type TeamInitArgs = z.infer<z.ZodObject<typeof TeamInitShape>>;
type IdleArgs = z.infer<z.ZodObject<typeof IdleShape>>;
type CancelArgs = z.infer<z.ZodObject<typeof CancelShape>>;
type LeadTransferArgs = z.infer<z.ZodObject<typeof LeadTransferShape>>;
type LeadReleaseArgs = z.infer<z.ZodObject<typeof LeadReleaseShape>>;

/**
 * v0.5（R-15-4 系统通知可控字段纪律 / P9）：lead-transfer 的 reason 进帧/史前清洗——
 * 控制符 → 空格、trim、截 500 字符；空串归一为 undefined（不入史不入帧）。
 */
export function sanitizeLeadReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const cleaned = reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
  return cleaned === "" ? undefined : cleaned;
}

/** leadHistory 追加 + ≤32 条 FIFO 截尾（R-6；对齐 formerNames 同款上限口径）。 */
export function pushLeadHistory(
  team: { leadHistory?: LeadHistoryEntry[] },
  entry: LeadHistoryEntry,
): void {
  team.leadHistory = [...(team.leadHistory ?? []), entry].slice(-MAX_LEAD_HISTORY);
}

// ---------------------------------------------------------------------------
// 渲染（人可读一行摘要；机器负载在 okResult 第二块）
// ---------------------------------------------------------------------------

export function renderTeamInit(teamId: string, leadKey: string, alreadyLead: boolean): string {
  const head = alreadyLead ? `Already the lead of team "${teamId}".` : `Team "${teamId}" lead set.`;
  return `${head} lead=${leadKey}.`;
}

export function renderIdle(from: string, to: string, delivered: "wake" | "mailbox"): string {
  return `Idle notification from ${from} delivered to ${to} via ${delivered}.`;
}

export function renderCancel(taskId: string, cancelledBy: string, receiptTo: string, delivered: "wake" | "mailbox"): string {
  return `Task ${taskId} cancelled by ${cancelledBy}; receipt sent to ${receiptTo} (wake via ${delivered}).`;
}

/** v0.5（R-2）：移交成功的人可读一行。 */
export function renderLeadTransfer(from: string, to: string, delivered: "wake" | "mailbox"): string {
  return `Lead role transferred from ${from} to ${to}. This is a metadata role: no tasks, mailboxes or registrations moved (new lead notice via ${delivered}).`;
}

/** v0.5（R-3）：释放成功/无事可做的人可读一行。 */
export function renderLeadRelease(released: boolean, teamId: string): string {
  return released
    ? `Lead role released. Team "${teamId}" is back to founder-fallback (no explicit lead); collaboration is unaffected.`
    : `No explicit lead to release (founder-fallback state).`;
}

// ---------------------------------------------------------------------------
// 工具核心（SDK 无关）
// ---------------------------------------------------------------------------

/** core 层统一入口：LockBusyError → {error:"busy"}，其余经 protocol.mapToolError。 */
async function runLeadTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LockBusyError) return errorResult(err.toStructured());
    return mapToolError(err);
  }
}

/**
 * 快照刷新（观测面，best-effort，§7.3.1）：W3 refreshSnapshot 失败绝不能影响
 * 工具结果——这里再吞一层，快照新鲜度由 Stop 钩子/下一次刷新兜底。
 */
async function refreshSnapshotBestEffort(stateRoot: string, teamId: string): Promise<void> {
  try {
    await refreshSnapshot(stateRoot, teamId);
  } catch {
    /* 观测面失败静默降级（§7.3.1 快照纪律） */
  }
}

export interface LeadToolCore {
  xc_team_init(args: TeamInitArgs, connectionKey: string): Promise<ToolResult>;
  xc_idle(args: IdleArgs, connectionKey: string): Promise<ToolResult>;
  xc_cancel(args: CancelArgs, connectionKey: string): Promise<ToolResult>;
  /** v0.5（R-2）：lead 移交（元数据角色；任务/邮箱/注册一概不搬）。 */
  xc_lead_transfer(args: LeadTransferArgs, connectionKey: string): Promise<ToolResult>;
  /** v0.5（R-3）：lead 释放（回到 founder 兜底态）。 */
  xc_lead_release(args: LeadReleaseArgs, connectionKey: string): Promise<ToolResult>;
}

export function createLeadToolCore(deps: ToolDepsLike): LeadToolCore {
  const { stateRoot, workspace } = deps;

  return {
    /**
     * xc_team_init（§3.2 L1）：把当前连接绑定的身份设为队 lead。
     * 已存在其他 lead → lead_exists（不得抢位；v0.5 错误载荷补现任 lead 的 sessionId，
     * R-1）；已是 lead → 幂等成功。v0.5（F-4）：{takeover:true} 仅在用户明确指令时
     * 接管现任 lead——通知旧 lead、写 leadHistory(reason=takeover)、全程审计。
     * 落盘：team.json.leadKey/leadSince/leadHistory + engine.jsonl {event:"lead-set"}。
     */
    async xc_team_init(args, connectionKey) {
      return runLeadTool(async () => {
        const me = identityStore.require(connectionKey);
        const now = Date.now();

        const out = await withTeamLock(stateRoot, me.teamId, async () => {
          let team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) {
            // 防御分支：注册路径已建队；异常丢失时此处重建（founder=调用者，对齐 tools.ts:283-285）。
            team = newTeamState({
              teamId: me.teamId,
              name: me.teamId,
              founderKey: me.agentKey,
              founder: { key: me.agentKey, sessionId: me.sessionId, role: me.role, joinedAt: now, lastSeen: now },
              now,
            });
          }
          // ★R-1：lead_exists 错误载荷补现任 lead 的 sessionId（用户「指定某人当 lead」→
          // 让该会话跑 xc_team_init 或让现任移交；F-4 接管须显式传 {takeover:true}）。
          if (team.leadKey !== undefined && team.leadKey !== me.agentKey && args.takeover !== true) {
            throw new ToolError({
              error: "lead_exists",
              leadKey: team.leadKey,
              sessionId: team.members.find((m) => m.key === team.leadKey)?.sessionId ?? null,
              message: `team "${me.teamId}" already has a lead ("${team.leadKey}"); a second lead cannot take over (§3.2 L1); ` +
                "use {takeover:true} only on explicit user instruction (the old lead is notified; the takeover is audited)",
            });
          }
          const takeoverFrom = args.takeover === true && team.leadKey !== undefined && team.leadKey !== me.agentKey
            ? team.leadKey
            : undefined;
          const alreadyLead = team.leadKey === me.agentKey;
          if (!alreadyLead) {
            team.leadKey = me.agentKey;
            team.leadSince = now;
            // ★P9：set 枚举写入点——空位认领 from:null；接管 from:旧 lead（reason 固定 "takeover"，无自由文本）。
            pushLeadHistory(team, {
              event: "set",
              from: takeoverFrom ?? null,
              to: me.agentKey,
              ts: now,
              ...(takeoverFrom !== undefined ? { reason: "takeover" } : {}),
            });
            await writeTeam(stateRoot, team);
          }
          return { alreadyLead, leadKey: me.agentKey, takeoverFrom };
        });

        // 锁外（F-4 hunk ③）：接管时通知旧 lead（mailbox+唤醒；唤醒失败=mailbox 兜底）。
        if (out.takeoverFrom !== undefined) {
          const notice = createMessage(me.agentKey, out.takeoverFrom, JSON.stringify({
            type: "lead-transfer", teamId: me.teamId, from: me.agentKey, to: me.agentKey, status: "taken-over",
          }), { deliveryClaimedAt: Date.now() });
          await appendMailbox(stateRoot, me.teamId, out.takeoverFrom, notice);
          const oldSessionId = (await readTeam(stateRoot, me.teamId))?.members
            .find((m) => m.key === out.takeoverFrom)?.sessionId ?? null;
          if (oldSessionId !== null && oldSessionId !== "") {
            await attemptWake({
              stateRoot,
              teamId: me.teamId,
              toAgentKey: out.takeoverFrom,
              toSessionId: oldSessionId,
              workspace,
              reason: "lead-transfer",
              receiptIds: [notice.id],
              ticket: `CrossChat lead 变更：${me.agentKey} 已接管队长角色（用户指令）`,
              env: deps.env,
            });
          }
        }

        await refreshSnapshotBestEffort(stateRoot, me.teamId); // leadKey 影响全景 lead 行（§7.3.1）
        await logEngineEvent(stateRoot, {
          event: "lead-set",
          teamId: me.teamId,
          by: me.agentKey,
          alreadyLead: out.alreadyLead,
          ...(out.takeoverFrom !== undefined ? { takeover: true, from: out.takeoverFrom } : {}),
        });
        return okResult(renderTeamInit(me.teamId, out.leadKey, out.alreadyLead), {
          teamId: me.teamId,
          leadKey: out.leadKey,
          alreadyLead: out.alreadyLead,
          ...(out.takeoverFrom !== undefined ? { takeover: true, from: out.takeoverFrom } : {}),
        });
      });
    },

    /**
     * xc_idle（E-c 空闲边沿，§5.1/§5.3）：写 idle-notification 帧入 lead 邮箱 +
     * 唤醒 lead。唤醒门控（R1 修复）：调用者自身 roster state ∈ {provisioning,
     * failed} → 只入箱不唤醒。欢迎回合不发 idle 是守则纪律（§6.2 ③），工具不拦。
     * v0.5.3（安全对-4 a9 修复）：completedTaskId 必须存在且属于调用者
     * （unknown_task / not_task_owner 硬拒）；帧自称的完成状态与任务板矛盾或
     * completed 无证据时帧内附 integrityWarning（lead 侧机器可读告警+审计）。
     */
    async xc_idle(args, connectionKey) {
      return runLeadTool(async () => {
        const me = identityStore.require(connectionKey);
        const summary = args.summary.trim();
        if (summary === "") throw invalidParamsError("summary is required (§5.3 idle-notification)");

        const prepared = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) {
            throw new ToolError({ error: "no_team", message: "no team on disk yet; register first" });
          }
          if (!team.members.some((m) => m.key === me.agentKey)) {
            throw new ToolError({
              error: "not_a_member",
              agentKey: me.agentKey,
              message: `"${me.agentKey}" is not a member of team "${team.teamId}"; register first (xc_register)`,
            });
          }
          const withLead = team;
          const to = withLead.leadKey ?? team.founderKey;
          if (to === me.agentKey) {
            throw invalidParamsError("caller is the lead; there is no one to notify idle (§5.3 recipient=lead)");
          }
          // R1 门控：供给中/失败的调用者只入箱（§5.1 E-c；磁盘可检测，纯插件侧；
          // memberState = W2 访问器，v0.1.0 旧花名缺 state → "ready"，§6.5）。
          const mine = team.members.find((m) => m.key === me.agentKey);
          const mailboxOnly = mine !== undefined && blocksWake(memberState(mine));
          // v0.5.3（安全对-4 三番战 a9 修复）：completedTaskId 任务归属校验。
          // adj052 实测：任意成员可携他人任务 id 或纯捏造 id 发 idle 帧，帧内
          // completedStatus/result 全为调用者任意填写、无任何校验直投 lead 邮箱
          // （误导 lead 模型）。堵法（保持帧协议可用）：
          //   ① completedTaskId 非空 → 任务必须存在（unknown_task 硬拒）；
          //   ② 且必须属于发送者（assignee === 调用者，not_task_owner 硬拒）——
          //     idle 语义是「我刚做完自己的活」，引用他人任务即冒认他人成果；
          //   ③ 帧自称 completedStatus 但任务板对不上（状态不符，或自称 completed
          //     而板上无证据）→ 帧内附 integrityWarning + 审计（不硬拒：状态串
          //     自由文本、板/帧时序有合法窗口，但 lead 拿到机器可读的矛盾提示，
          //     不再只靠守约自觉核对）。
          let integrityWarning: string | undefined;
          const claimedTaskId = args.completedTaskId !== undefined && args.completedTaskId.trim() !== ""
            ? args.completedTaskId
            : undefined;
          if (claimedTaskId !== undefined) {
            const task = getTask(team, claimedTaskId);
            if (task === undefined) {
              throw new ToolError({
                error: "unknown_task",
                taskId: claimedTaskId,
                message: `idle frame references unknown task "${claimedTaskId}"; completedTaskId must be an existing task on the team board`,
              });
            }
            if (task.assignee !== me.agentKey) {
              throw new ToolError({
                error: "not_task_owner",
                taskId: task.id,
                assignee: task.assignee,
                message: `task ${task.id} is not yours (assignee=${task.assignee ?? "null"}); idle completedTaskId must reference a task assigned to you`,
              });
            }
            if (args.completedStatus !== undefined && args.completedStatus.trim() !== ""
              && (task.status !== args.completedStatus
                || (args.completedStatus === "completed" && task.evidence.length === 0))) {
              integrityWarning =
                `task ${task.id} board status="${task.status}" with ${task.evidence.length} evidence item(s) does not back the idle frame's claimed status "${args.completedStatus}" — verify with xc_status/xc_task_read before trusting`;
            }
          }
          // idle-notification 帧（§5.3 契约，字段逐一对应 CC idle_notification 结构）。
          const frame = JSON.stringify({
            type: "idle-notification",
            teamId: me.teamId,
            from: me.agentKey,
            idleReason: args.idleReason ?? "no-claimable-task",
            summary,
            completedTaskId: claimedTaskId ?? null,
            completedStatus: args.completedStatus ?? null,
            failureReason: args.failureReason ?? null,
            result: args.result ?? null,
            ...(integrityWarning !== undefined ? { integrityWarning } : {}),
          });
          const message = createMessage(me.agentKey, to, frame, { deliveryClaimedAt: Date.now() });
          await appendMailbox(stateRoot, me.teamId, to, message);
          return {
            to,
            messageId: message.id,
            mailboxOnly,
            toSessionId: team.members.find((m) => m.key === to)?.sessionId ?? null,
            integrityWarning,
          };
        });

        // 锁外唤醒（§2.7-4）：mailboxOnly 门控/无 sessionId → mailbox 兜底，消息不丢。
        let delivered: "wake" | "mailbox" = "mailbox";
        let note: string | undefined = prepared.mailboxOnly
          ? "caller is provisioning/failed: mailbox-only (R1 gate, §5.1 E-c)"
          : undefined;
        if (!prepared.mailboxOnly && prepared.toSessionId !== null) {
          const sent = await attemptWake({
            stateRoot,
            teamId: me.teamId,
            toAgentKey: prepared.to,
            toSessionId: prepared.toSessionId,
            workspace,
            reason: "idle",
            receiptIds: [prepared.messageId],
            ticket: `收到 CrossChat 空闲通知：from=${me.agentKey} summary=${summary}`,
            env: deps.env,
          });
          delivered = sent.delivered;
          note = sent.note ?? note;
        }
        await logEngineEvent(stateRoot, {
          event: "idle",
          teamId: me.teamId,
          from: me.agentKey,
          to: prepared.to,
          delivered,
          mailboxOnly: prepared.mailboxOnly,
          messageId: prepared.messageId,
          ...(prepared.integrityWarning !== undefined ? { integrityWarning: true } : {}),
        });
        return okResult(renderIdle(me.agentKey, prepared.to, delivered), {
          to: prepared.to,
          delivered,
          ...(prepared.mailboxOnly ? { mailboxOnly: true } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(prepared.integrityWarning !== undefined ? { integrityWarning: prepared.integrityWarning } : {}),
        });
      });
    },

    /**
     * xc_cancel（§7.3.3）：lead（未设 leadKey 时 founder 视为 lead，§6.1 同语义）
     * 或任务 createdBy 把 pending/claimed/in_progress 任务置 cancelled——激活
     * types.ts TASK_TRANSITIONS 保留的 cancelled 边（types.ts:9-11 自证 v1 无工具入口，
     * 本工具即 v2 的入口）+ history "cancelled" + 回执（status:"cancelled"）入
     * createdBy 邮箱 + 唤醒 createdBy。
     */
    async xc_cancel(args, connectionKey) {
      return runLeadTool(async () => {
        const me = identityStore.require(connectionKey);

        const prepared = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) {
            throw new ToolError({ error: "no_team", message: "no team on disk yet" });
          }
          if (!team.members.some((m) => m.key === me.agentKey)) {
            throw new ToolError({
              error: "not_a_member",
              agentKey: me.agentKey,
              message: `"${me.agentKey}" is not a member of team "${team.teamId}"`,
            });
          }
          const isLead = team.leadKey !== undefined
            ? team.leadKey === me.agentKey
            : team.founderKey === me.agentKey;
          const task = getTask(team, args.taskId);
          if (task === undefined) throw invalidParamsError(`unknown task "${args.taskId}"`);
          if (!isLead && task.createdBy !== me.agentKey) {
            throw new ToolError({
              error: "not_lead",
              taskId: task.id,
              leadKey: team.leadKey ?? null,
              message: `only the team lead ("${team.leadKey ?? team.founderKey}") or the task creator ("${task.createdBy}") can cancel task ${task.id} (§7.3.3)`,
            });
          }
          if (TERMINAL_TASK_STATUSES.includes(task.status)) {
            throw new ToolError({
              error: "task_already_terminal",
              taskId: task.id,
              status: task.status,
              message: `task ${task.id} is already ${task.status}; terminal tasks cannot be cancelled (§7.3.3)`,
            });
          }
          // pending/claimed/in_progress → cancelled 三条边均合法（types.ts:42-49）；
          // transitionTask 落 history "cancelled" + updatedAt（§7.3.3）。
          transitionTask(team, task.id, "cancelled", me.agentKey, { now: Date.now() });
          await writeTeam(stateRoot, team);

          // 回执（status:"cancelled"）入 createdBy 邮箱（§7.3.3；receiptText v0.1.0 同构，
          // attempt 关联保留在帧 JSON 内，不带 sourceAttemptId——与 xc_report 终态回执
          // 相同的新鲜性语义，见 tools.ts:538-543 注释）。
          const receipt = JSON.stringify({
            type: "task-receipt",
            teamId: me.teamId,
            taskId: task.id,
            attemptId: task.attemptId ?? "",
            status: "cancelled",
            result: task.result,
            error: task.error,
            evidence: task.evidence,
            cancelledBy: me.agentKey,
          });
          const message = createMessage(me.agentKey, task.createdBy, receipt, {
            taskId: task.id,
            sourceTaskId: task.id,
            sourceTaskStatus: "cancelled",
            deliveryClaimedAt: Date.now(),
          });
          await appendMailbox(stateRoot, me.teamId, task.createdBy, message);
          // v0.5.3（A3 修复）：cancelled 上游的依赖死锁解除——与 xc_report(failed)
          // 边沿共用同一条 cascadeDependencyDeadlockLocked 路径。人工取消上游后其
          // pending 下游同样永远无法满足依赖（adj052 A3 同款死锁的 cancelled 入口）：
          // 自动置 cancelled + 回执/唤醒各任务创建者，死锁不再无声。
          const deadlock = await cascadeDependencyDeadlockLocked(stateRoot, team, task.id, "cancelled", Date.now());
          if (deadlock.deadlocked.length > 0) await writeTeam(stateRoot, team);
          return {
            taskId: task.id,
            createdBy: task.createdBy,
            messageId: message.id,
            createdBySessionId: team.members.find((m) => m.key === task.createdBy)?.sessionId ?? null,
            deadlock,
          };
        });

        // 锁外唤醒 createdBy（§2.7-4）；取消者即 createdBy 时不自唤醒。
        let delivered: "wake" | "mailbox" = "mailbox";
        let note: string | undefined;
        if (prepared.createdBy !== me.agentKey && prepared.createdBySessionId !== null) {
          const sent = await attemptWake({
            stateRoot,
            teamId: me.teamId,
            toAgentKey: prepared.createdBy,
            toSessionId: prepared.createdBySessionId,
            workspace,
            reason: "cancel",
            receiptIds: [prepared.messageId],
            ticket: `收到 CrossChat 回执：task ${prepared.taskId} = cancelled（被 ${me.agentKey} 取消）`,
            env: deps.env,
          });
          delivered = sent.delivered;
          note = sent.note;
        }
        // v0.5.3（A3 修复）：锁外执行依赖死锁解除的唤醒计划（§2.7-4——attemptWake
        // 不准持团队锁调用）。创建者 = 取消者本人时不自唤醒（与主回执同纪律）。
        for (const item of prepared.deadlock?.wakePlan ?? []) {
          if (item.to === me.agentKey || item.sessionId === null) continue;
          try {
            await attemptWake({
              stateRoot,
              teamId: me.teamId,
              toAgentKey: item.to,
              toSessionId: item.sessionId,
              workspace,
              reason: "dependency-deadlock",
              receiptIds: item.receiptIds,
              ticket: `收到 CrossChat 回执：task 依赖的上游 ${prepared.taskId} = cancelled，其 pending 下游已被引擎解除（cancelled）`,
              env: deps.env,
            });
          } catch {
            // 唤醒失败不影响工具结果：邮箱回执兜底（attemptWake 自身降级语义同款）。
          }
        }
        const deadlockedCount = prepared.deadlock?.deadlocked.length ?? 0;
        await refreshSnapshotBestEffort(stateRoot, me.teamId); // 任务图变化 → 落一版快照（§7.3.1 机制 1）
        await logEngineEvent(stateRoot, {
          event: "cancel",
          teamId: me.teamId,
          taskId: prepared.taskId,
          by: me.agentKey,
          receiptTo: prepared.createdBy,
          delivered,
          ...(deadlockedCount > 0 ? { deadlocked: deadlockedCount } : {}),
        });
        return okResult(renderCancel(prepared.taskId, me.agentKey, prepared.createdBy, delivered), {
          taskId: prepared.taskId,
          status: "cancelled",
          cancelledBy: me.agentKey,
          receiptTo: prepared.createdBy,
          delivered,
          ...(deadlockedCount > 0
            ? { deadlocked: prepared.deadlock?.deadlocked.map((d) => ({ taskId: d.taskId, createdBy: d.createdBy, deadlockedBy: d.deadlockedBy, woken: d.woken })) }
            : {}),
          ...(note !== undefined ? { note } : {}),
        });
      });
    },

    /**
     * xc_lead_transfer（v0.5 R-2，DESIGN-V0.5 §3.1）：现任 lead 把 lead 角色移交给
     * 另一名在册未 removed 成员。lead 是元数据角色：任务、邮箱、注册一概不搬，
     * 派发/认领/消息完全不受影响。落盘（团队锁内同一事务）：team.leadKey=to、
     * leadSince=now、leadHistory 追加 transfer（≤32 FIFO）；锁外：lead-transfer 帧
     * 入新 lead 邮箱 + 回执帧入自己邮箱 + 唤醒新 lead（scene="lead-transfer"，
     * 不进 WAKE_RULES_SCENES——新 lead 不需守则重附）。
     */
    async xc_lead_transfer(args, connectionKey) {
      return runLeadTool(async () => {
        const me = identityStore.require(connectionKey);
        const to = sanitizeKey(args.to);
        if (to === "") throw invalidParamsError(`name ${JSON.stringify(args.to)} sanitizes to an empty key`);
        // P9：reason 进帧/史前清洗（控制符→空格、截 500）。
        const reason = sanitizeLeadReason(args.reason);
        if (to === me.agentKey) {
          // F-2（DESIGN D10）：R-2 的「to===me → invalid_params」与「to 已是现任 lead →
          // 幂等成功」在调用者=现任 lead 时同指；取 invalid_params——转给自己是无操作，
          // 不造假审计。
          throw invalidParamsError("transferring the lead role to yourself is a no-op");
        }
        const now = Date.now();

        const prepared = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet; register first" });
          if (!team.members.some((m) => m.key === me.agentKey)) {
            throw new ToolError({
              error: "not_a_member",
              agentKey: me.agentKey,
              message: `"${me.agentKey}" is not a member; register first`,
            });
          }
          // 资格：调用者 = 现任 lead（leadKeyOf 含 founder 兜底，member-tools.ts:101-104 同语义）。
          if (leadKeyOf(team) !== me.agentKey) {
            throw new ToolError({
              error: "not_lead",
              agentKey: me.agentKey,
              leadKey: leadKeyOf(team),
              message: `only the current lead ("${leadKeyOf(team)}") can transfer the role`,
            });
          }
          const target = team.members.find((m) => m.key === to);
          if (target === undefined || memberState(target) === "removed") {
            throw invalidParamsError(`transfer target "${to}" is not an active member of team "${team.teamId}"`);
          }
          // 落盘（同一事务）：leadKey + leadSince + leadHistory（≤32 FIFO）。
          team.leadKey = to;
          team.leadSince = now;
          pushLeadHistory(team, {
            event: "transfer",
            from: me.agentKey,
            to,
            ts: now,
            ...(reason === undefined ? {} : { reason }),
          });
          await writeTeam(stateRoot, team);
          // 通知帧（FRAME_TYPES 第七值 "lead-transfer"；字段固定模板，R-15-4 可控字段纪律）。
          const notice = createMessage(me.agentKey, to, JSON.stringify({
            type: "lead-transfer",
            teamId: me.teamId,
            from: me.agentKey,
            to,
            ...(reason === undefined ? {} : { reason }),
          }), { deliveryClaimedAt: now });
          await appendMailbox(stateRoot, me.teamId, to, notice);
          return { to, noticeId: notice.id, toSessionId: target.sessionId };
        });

        // 锁外：回执帧给旧 lead（自己查箱可见「已移交」），并唤醒新 lead。
        const receipt = createMessage(me.agentKey, me.agentKey, JSON.stringify({
          type: "lead-transfer", teamId: me.teamId, from: me.agentKey, to: prepared.to, status: "completed",
        }), { deliveryClaimedAt: Date.now() });
        await appendMailbox(stateRoot, me.teamId, me.agentKey, receipt);
        let delivered: "wake" | "mailbox" = "mailbox";
        let note: string | undefined;
        if (prepared.toSessionId !== null && prepared.toSessionId !== "") {
          const sent = await attemptWake({
            stateRoot,
            teamId: me.teamId,
            toAgentKey: prepared.to,
            toSessionId: prepared.toSessionId,
            workspace,
            reason: "lead-transfer",
            receiptIds: [prepared.noticeId],
            ticket: `收到 CrossChat lead 移交：${me.agentKey} → ${prepared.to}，你现在分别是本队的队长（元数据角色）`,
            env: deps.env,
          });
          delivered = sent.delivered;
          note = sent.note ?? note;
        }
        await refreshSnapshotBestEffort(stateRoot, me.teamId);
        await logEngineEvent(stateRoot, {
          event: "lead-transfer",
          teamId: me.teamId,
          from: me.agentKey,
          to: prepared.to,
          ...(reason === undefined ? {} : { reason }),
          messageId: prepared.noticeId,
        });
        return okResult(renderLeadTransfer(me.agentKey, prepared.to, delivered), {
          teamId: me.teamId,
          from: me.agentKey,
          to: prepared.to,
          leadSince: now,
          messageId: prepared.noticeId,
          delivered,
          ...(note !== undefined ? { note } : {}),
        });
      });
    },

    /**
     * xc_lead_release（v0.5 R-3，DESIGN-V0.5 §3.2）：现任 lead 主动卸任——团队锁内删
     * leadKey/leadSince（回到 founder 兜底态），leadHistory 追加 release；非 lead 调用
     * → not_lead。本就无显式 leadKey（founder 兜底态）→ released:false 幂等无操作。
     * 无通知面（SPEC R-3：无人可通知「没有 lead 了」）；后续 xc_idle 收件人自动回落
     * founder（lead-tools.ts:212 `leadKey ?? founderKey` 现状逻辑不动）。
     */
    async xc_lead_release(_args, connectionKey) {
      return runLeadTool(async () => {
        const me = identityStore.require(connectionKey);
        const now = Date.now();
        const out = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet" });
          if (leadKeyOf(team) !== me.agentKey) {
            throw new ToolError({
              error: "not_lead",
              agentKey: me.agentKey,
              leadKey: leadKeyOf(team),
              message: `only the current lead ("${leadKeyOf(team)}") can release the role`,
            });
          }
          if (team.leadKey === undefined) {
            return { released: false, alreadyDefault: true }; // founder 兜底态本就无显式 leadKey：无事可做
          }
          delete team.leadKey;
          delete team.leadSince; // 回到 founder 兜底态（types.ts 缺省语义）
          pushLeadHistory(team, { event: "release", from: me.agentKey, to: null, ts: now });
          await writeTeam(stateRoot, team);
          return { released: true, alreadyDefault: false };
        });
        await refreshSnapshotBestEffort(stateRoot, me.teamId);
        await logEngineEvent(stateRoot, {
          event: "lead-release",
          teamId: me.teamId,
          from: me.agentKey,
          released: out.released,
        });
        return okResult(renderLeadRelease(out.released, me.teamId), {
          teamId: me.teamId,
          from: me.agentKey,
          released: out.released,
          ...(out.alreadyDefault ? { alreadyDefault: true } : {}),
        });
      });
    },
  };
}

/** createLeadToolCore 的最小依赖形状（与 tools.ts ToolDeps 结构一致；测试可直接构造）。 */
export interface ToolDepsLike {
  stateRoot: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// SDK 接线
// ---------------------------------------------------------------------------

/** 注册 lead 面工具（DESIGN-V0.2 §9.2 接口签名；v0.5 增 xc_lead_transfer/xc_lead_release，共 5 个）。 */
export function registerLeadTools(server: McpServer, deps: ToolDepsLike): void {
  const core = createLeadToolCore(deps);

  server.tool(
    "xc_team_init",
    "Become the team lead (sets team.leadKey). Rejected with lead_exists when another lead holds the role — use {takeover:true} ONLY on explicit user instruction to take over a dead/unresponsive/refusing lead (the old lead is notified and the takeover is audited). Lead is a metadata role.",
    TeamInitShape,
    async (args, extra) => core.xc_team_init(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_idle",
    "Send an idle-notification frame to the lead (recipient = team.leadKey, else founderKey) and wake it. Callers that are still provisioning/failed mailbox-only (R1 gate). completedTaskId must reference an existing task assigned to you (unknown_task/not_task_owner hard-reject); a frame claiming completedStatus that the task board does not back (wrong status, or completed with no evidence) is delivered with an integrityWarning for the lead.",
    IdleShape,
    async (args, extra) => core.xc_idle(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_cancel",
    "Cancel a pending/claimed/in_progress task (lead or task creator only): activates the cancelled edge, writes a cancelled receipt to the creator's mailbox and wakes it.",
    CancelShape,
    async (args, extra) => core.xc_cancel(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_lead_transfer",
    "Transfer the team lead role to another member (metadata role only: no tasks, mailboxes or registrations move; dispatch/claim/messaging are unaffected). Current lead only; the target must be an active member.",
    LeadTransferShape,
    async (args, extra) => core.xc_lead_transfer(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_lead_release",
    "Release the team lead role (current lead only): team.json drops leadKey and falls back to founder-fallback; collaboration and dispatch/claim/messaging are unaffected. No-op (released:false) when there is no explicit lead.",
    LeadReleaseShape,
    async (args, extra) => core.xc_lead_release(args, connectionKeyOf(extra)),
  );
}
