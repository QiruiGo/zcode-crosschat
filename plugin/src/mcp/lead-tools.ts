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
import { DEFAULT_TEAM_ID, TERMINAL_TASK_STATUSES, memberState } from "../core/types.js";
import type { MemberState } from "../core/types.js";
import { getTask, newTeamState, readTeam, transitionTask, writeTeam } from "../core/teamstate.js";
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

export const TeamInitShape = {};
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

type IdleArgs = z.infer<z.ZodObject<typeof IdleShape>>;
type CancelArgs = z.infer<z.ZodObject<typeof CancelShape>>;

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
  xc_team_init(args: Record<string, never>, connectionKey: string): Promise<ToolResult>;
  xc_idle(args: IdleArgs, connectionKey: string): Promise<ToolResult>;
  xc_cancel(args: CancelArgs, connectionKey: string): Promise<ToolResult>;
}

export function createLeadToolCore(deps: ToolDepsLike): LeadToolCore {
  const { stateRoot, workspace } = deps;

  return {
    /**
     * xc_team_init（§3.2 L1）：把当前连接绑定的身份设为队 lead。
     * 已存在其他 lead → lead_exists（不得抢位）；已是 lead → 幂等成功。
     * 落盘：team.json.leadKey + engine.jsonl {event:"lead-set"}（§3.1）。
     */
    async xc_team_init(_args, connectionKey) {
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
          if (team.leadKey !== undefined && team.leadKey !== me.agentKey) {
            throw new ToolError({
              error: "lead_exists",
              leadKey: team.leadKey,
              message: `team "${me.teamId}" already has a lead ("${team.leadKey}"); a second lead cannot take over (§3.2 L1)`,
            });
          }
          const alreadyLead = team.leadKey === me.agentKey;
          if (!alreadyLead) {
            team.leadKey = me.agentKey;
            await writeTeam(stateRoot, team);
          }
          return { alreadyLead, leadKey: me.agentKey };
        });

        await refreshSnapshotBestEffort(stateRoot, me.teamId); // leadKey 影响全景 lead 行（§7.3.1）
        await logEngineEvent(stateRoot, {
          event: "lead-set",
          teamId: me.teamId,
          by: me.agentKey,
          alreadyLead: out.alreadyLead,
        });
        return okResult(renderTeamInit(me.teamId, out.leadKey, out.alreadyLead), {
          teamId: me.teamId,
          leadKey: out.leadKey,
          alreadyLead: out.alreadyLead,
        });
      });
    },

    /**
     * xc_idle（E-c 空闲边沿，§5.1/§5.3）：写 idle-notification 帧入 lead 邮箱 +
     * 唤醒 lead。唤醒门控（R1 修复）：调用者自身 roster state ∈ {provisioning,
     * failed} → 只入箱不唤醒。欢迎回合不发 idle 是守则纪律（§6.2 ③），工具不拦。
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
          // idle-notification 帧（§5.3 契约，字段逐一对应 CC idle_notification 结构）。
          const frame = JSON.stringify({
            type: "idle-notification",
            teamId: me.teamId,
            from: me.agentKey,
            idleReason: args.idleReason ?? "no-claimable-task",
            summary,
            completedTaskId: args.completedTaskId ?? null,
            completedStatus: args.completedStatus ?? null,
            failureReason: args.failureReason ?? null,
            result: args.result ?? null,
          });
          const message = createMessage(me.agentKey, to, frame, { deliveryClaimedAt: Date.now() });
          await appendMailbox(stateRoot, me.teamId, to, message);
          return {
            to,
            messageId: message.id,
            mailboxOnly,
            toSessionId: team.members.find((m) => m.key === to)?.sessionId ?? null,
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
        });
        return okResult(renderIdle(me.agentKey, prepared.to, delivered), {
          to: prepared.to,
          delivered,
          ...(prepared.mailboxOnly ? { mailboxOnly: true } : {}),
          ...(note !== undefined ? { note } : {}),
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
          return {
            taskId: task.id,
            createdBy: task.createdBy,
            messageId: message.id,
            createdBySessionId: team.members.find((m) => m.key === task.createdBy)?.sessionId ?? null,
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
        await refreshSnapshotBestEffort(stateRoot, me.teamId); // 任务图变化 → 落一版快照（§7.3.1 机制 1）
        await logEngineEvent(stateRoot, {
          event: "cancel",
          teamId: me.teamId,
          taskId: prepared.taskId,
          by: me.agentKey,
          receiptTo: prepared.createdBy,
          delivered,
        });
        return okResult(renderCancel(prepared.taskId, me.agentKey, prepared.createdBy, delivered), {
          taskId: prepared.taskId,
          status: "cancelled",
          cancelledBy: me.agentKey,
          receiptTo: prepared.createdBy,
          delivered,
          ...(note !== undefined ? { note } : {}),
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

/** 注册 W4 三个 lead 面工具（DESIGN-V0.2 §9.2 接口签名）。 */
export function registerLeadTools(server: McpServer, deps: ToolDepsLike): void {
  const core = createLeadToolCore(deps);

  server.tool(
    "xc_team_init",
    "Become the team lead (sets team.leadKey to this session's registered identity). Rejected with lead_exists when another lead already holds the role.",
    TeamInitShape,
    async (args, extra) => core.xc_team_init(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_idle",
    "Send an idle-notification frame to the lead (recipient = team.leadKey, else founderKey) and wake it. Callers that are still provisioning/failed mailbox-only (R1 gate).",
    IdleShape,
    async (args, extra) => core.xc_idle(args, connectionKeyOf(extra)),
  );
  server.tool(
    "xc_cancel",
    "Cancel a pending/claimed/in_progress task (lead or task creator only): activates the cancelled edge, writes a cancelled receipt to the creator's mailbox and wakes it.",
    CancelShape,
    async (args, extra) => core.xc_cancel(args, connectionKeyOf(extra)),
  );
}
