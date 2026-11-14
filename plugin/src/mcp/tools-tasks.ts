/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T2/T3/T4）：任务三件套 xc_dispatch / xc_claim /
 * xc_report 的核心实现——原 tools.ts 对应方法 1:1 平移（校验、锁、回执、唤醒路径
 * 逐行不变），差异只有三处（方案 §1-C2/§1-B）：
 * ① dispatch 增 `priority`（high/normal/low，缺省 normal；排序建议非抢占，§3.2）；
 * ② report status 增 `blocked`（认领者显式申报暂停；attempt 保留；core 层
 *    applyReport/applyReportBlocked 落 preBlockedStatus/blockedReason/blockedAt）；
 * ③ evidence 砍 sha256 现算复核（方案 §1-B「文件+摘要」）——保留文件存在门
 *    （evidence_file_missing）与工作区遏制门（evidence_path_outside_workspace，
 *    v0.5.2 bug-05 修复不回退）；旧调用方携带的 evidence[].sha256 忽略并在
 *    payload 以 `ignored:["evidence[].sha256"]` 披露（§1.3 迁移表行 xc_report）。
 *
 * 身份 = 连接绑定；并发纪律（§2.7）与 tools.ts 完全一致；attemptWake 只在锁外。
 */

import { z } from "zod";
import { resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import {
  invalidParamsError,
  okResult,
  staleAttemptError,
  ToolError,
  type ToolResult,
} from "./protocol.js";
import {
  renderClaim,
  renderDispatch,
  renderReport,
} from "./render.js";
import { withTeamLock } from "../core/lock.js";
import { attemptWake } from "../engine/wake.js";
import { identityStore } from "./identity.js";
import { sanitizeKey } from "../core/sanitize.js";
import { DEFAULT_TEAM_ID, TERMINAL_TASK_STATUSES, TASK_PRIORITIES } from "../core/types.js";
import type { EvidenceItem, TeamMessage, TeamState } from "../core/types.js";
import {
  appendTaskHistory,
  applyReport,
  beginTaskAttempt,
  getTask,
  makeTask,
  memberOpenTasks,
  newTeamState,
  noteTeamReset,
  readTeam,
  reportTransitionError,
  unsatisfiedDependencies,
  writeTeam,
} from "../core/teamstate.js";
import {
  appendMailbox,
  createMessage,
  isCurrentMail,
  orphanTaskIds,
  readMailbox,
  staleCompletedReceiptTaskIds,
} from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { receiverInjectBudget, contextCharsFromEnv, truncateField } from "../core/budget.js";
import { sha256Of } from "../core/msgstore.js";
import type { ToolDeps } from "./core.js";
import { runCore } from "./core.js";

/** v1 单队固定 default（DESIGN §2.2）。 */
const TEAM_ID = DEFAULT_TEAM_ID;

/** createMessage 可携带的投递快照字段（与 v0.5.3 一致）。 */
type MessageExtras = Partial<
  Pick<TeamMessage, "taskId" | "attemptId" | "sourceTaskId" | "sourceAttemptId" | "sourceTaskStatus" | "deliveryClaimedAt">
>;

// ---------------------------------------------------------------------------
// zod 入参 schema（§1.2 T2/T3/T4；无 from/caller 参数——身份≡连接绑定）
// ---------------------------------------------------------------------------

export const DispatchShape = {
  to: z.string().min(1).describe("目标成员名"),
  title: z.string().min(1).describe("任务标题"),
  prompt: z.string().min(1).describe("任务内容（要做什么）"),
  acceptance: z.string().optional().describe("验收标准（可检验）"),
  dependsOn: z.array(z.string()).optional().describe("依赖的任务 id 列表"),
  priority: z.enum(["high", "normal", "low"]).optional().describe("任务优先级；缺省 normal（影响展示/取单顺序，不做抢占）"),
} as const;
export const ClaimShape = { taskId: z.string().min(1).describe("要认领的任务 id") } as const;
export const ReportShape = {
  taskId: z.string().min(1),
  attemptId: z.string().min(1).describe("xc_claim 返回的 attempt 令牌；不匹配即硬拒"),
  status: z.enum(["in_progress", "completed", "failed", "blocked"]),
  result: z.string().optional().describe("completed 必填"),
  error: z.string().optional().describe("failed 建议填写；status=blocked 时必填=阻塞原因"),
  evidence: z
    .array(
      z.object({
        path: z.string().min(1).describe("证据文件绝对路径"),
        // v0.6（DESIGN-V0.6.md §1.2 T4）：sha256 复核已砍——字段仅为旧调用方兼容
        // 保留，值忽略并在 payload 以 ignored 披露。
        sha256: z.string().nullable().optional().describe("v0.6 起忽略（哈希复核已砍）；文件存在门与工作区内路径门不变"),
        note: z.string().optional().describe("一句话说明（文件+摘要，方案 §1-B）"),
      }),
    )
    .optional()
    .describe("completed 必须至少 1 条；每条文件必须真实存在且位于工作区内（evidence_file_missing / evidence_path_outside_workspace）"),
} as const;

export type DispatchArgs = { to: string; title: string; prompt: string; acceptance?: string; dependsOn?: string[]; priority?: (typeof TASK_PRIORITIES)[number] };
export type ClaimArgs = { taskId: string };
export type ReportArgs = {
  taskId: string;
  attemptId: string;
  status: "in_progress" | "completed" | "failed" | "blocked";
  result?: string;
  error?: string;
  evidence?: Array<{ path: string; note?: string; sha256?: string | null }>;
};

// ---------------------------------------------------------------------------
// 核心实现（SDK 无关；原 tools.ts 平移 + 三处 v0.6 增量）
// ---------------------------------------------------------------------------

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

function requireMember(team: TeamState, agentKey: string): void {
  if (!team.members.some((m) => m.key === agentKey)) {
    throw new ToolError({
      error: "not_a_member",
      agentKey,
      message: `"${agentKey}" is not a member of team "${team.teamId}"; register first (xc_register)`,
    });
  }
}

export interface TaskCore {
  xc_dispatch(args: DispatchArgs, connectionKey: string): Promise<ToolResult>;
  xc_claim(args: ClaimArgs, connectionKey: string): Promise<ToolResult>;
  xc_report(args: ReportArgs, connectionKey: string): Promise<ToolResult>;
}

export function createTaskCore(deps: ToolDeps): TaskCore {
  const { stateRoot, workspace } = deps;

  return {
    async xc_dispatch(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityRequire(connectionKey);
        const toKey = sanitizeKey(args.to);
        if (toKey === me.agentKey) throw invalidParamsError("cannot dispatch to yourself");
        const now = Date.now();

        const prepared = await withTeamLock(stateRoot, me.teamId, async () => {
          // 锁内重读重验（§2.7-4）。
          let team = await readTeam(stateRoot, me.teamId);
          let teamResetWarning: string | undefined;
          if (team === undefined) {
            // 防御分支：注册路径已建队；首个派发者自动建队并成为 founder（§2.2）。
            // v0.5.1（故障注-5 修复）：真源丢失后的自动建队不再静默。
            teamResetWarning = await noteTeamReset(stateRoot, me.teamId);
            team = newTeamState({ teamId: me.teamId, name: me.teamId, founderKey: me.agentKey, now });
          }
          requireMember(team, toKey); // §2.6：to 必须是已注册成员
          for (const dep of args.dependsOn ?? []) {
            const depTask = getTask(team, dep);
            if (depTask === undefined) {
              throw invalidParamsError(`dependsOn references unknown task "${dep}"`);
            }
            // v0.5.3（A3 修复）：终态 failed/cancelled 的依赖永远无法满足——派发面
            // 显式拒绝（fail-closed），指引重派新上游。
            if (depTask.status === "failed" || depTask.status === "cancelled") {
              throw invalidParamsError(
                `dependsOn references task "${dep}" which is ${depTask.status}; a failed/cancelled task can never complete, ` +
                  "so a task depending on it could never start (dependency deadlock) — " +
                  "re-dispatch a fresh upstream task and depend on that instead",
              );
            }
          }

          const ticket = ticketText(args);
          // duplicate 幂等判定（移植 dsh tools.js:2088-2093）。
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
          // v0.6（C2）：priority 透传（makeTask 防御性收敛，枚举外归 absent）。
          const task = makeTask(team, {
            title: args.title.trim(),
            prompt: args.prompt,
            acceptance: args.acceptance?.trim() || undefined,
            dependsOn: args.dependsOn,
            createdBy: me.agentKey,
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
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
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(prepared.teamResetWarning !== undefined ? { teamResetWarning: prepared.teamResetWarning } : {}),
          ...(sent.wakeLog ? { wakeLog: sent.wakeLog } : {}),
          ...(sent.note ? { note: sent.note } : {}),
        });
      });
    },

    async xc_claim(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityRequire(connectionKey);
        const out = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet; register first" });
          requireMember(team, me.agentKey); // 会籍有效（§2.6）
          if (team.phase === "halted") {
            throw new ToolError({ error: "team_halted", message: `team "${me.teamId}" is halted` });
          }
          const task = getTask(team, args.taskId);
          if (task === undefined) {
            // v0.5.1（故障注-2 修复）：unknown task 不再裸报——孤儿引用诊断富化。
            const orphans = orphanTaskIds(team, await readMailbox(stateRoot, team.teamId, me.agentKey));
            if (orphans.includes(args.taskId)) {
              throw new ToolError({
                error: "orphan_task_reference",
                taskId: args.taskId,
                message:
                  `unknown task "${args.taskId}"; your mailbox still holds envelope(s) referencing it — ` +
                  `the team state lost its task list (truncated or reset). ` +
                  `Check the xc_overview orphan warnings and ask the dispatcher to re-dispatch`,
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
          // v0.5.2（故障注-1 二番战修复）：回滚矛盾闸。
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
                  `(xc_overview shows the staleCompletedReceipts warning) and re-dispatch a fresh task`,
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
        // v0.5.1（SCALE-2 修复）：认领回显接入注入预算；真源全文经 xc_read(scope:"task") 分页。
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
            ? { promptTruncated: promptCut.truncated, promptPointer: "xc_read" }
            : {}),
          ...(acceptanceCut.truncated
            ? { acceptanceTruncated: acceptanceCut.truncated, acceptancePointer: "xc_read" }
            : {}),
        });
      });
    },

    async xc_report(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityRequire(connectionKey);
        // 慢操作在锁外：证据门（§1.2 T4）。v0.6 砍 sha256 现算复核；保留两道门：
        // 文件存在（evidence_file_missing）与工作区内路径（evidence_path_outside_workspace，
        // v0.5.2 bug-05 修复不回退——round1 #03/#16 重放面）。
        const evidence: EvidenceItem[] = [];
        const ignoredEvidenceSha256 = (args.evidence ?? []).some((e) => e.sha256 != null);
        const wsRoot = resolve(workspace);
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
              message: `evidence file "${e.path}" resolves outside the workspace (${wsRoot}); ` +
                `evidence must live inside the shared workspace (§2.6 evidence gate, v0.5.2 containment)`,
            });
          }
          try {
            await stat(abs);
          } catch {
            throw new ToolError({
              error: "evidence_file_missing",
              path: e.path,
              message: `evidence file "${e.path}" does not exist or is unreadable; the evidence gate requires a real file (§2.6)`,
            });
          }
          // v0.6：sha256 不再计算/复核（EvidenceItem.sha256 落 null，非文件证据同款）。
          evidence.push({ path: e.path, sha256: null, note: e.note ?? "" });
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

        // 锁外唤醒派发方（§2.9-2）；blocked 保留 attempt、无回执（暂停而非终态）。
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
          ...(ignoredEvidenceSha256 ? { ignored: ["evidence[].sha256"] } : {}),
        });
      });
    },
  };

  /** 推送唤醒（必须已在团队锁外；M2 决策 wake|mailbox 并 fire-and-forget，§2.5）。 */
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
}

// 局部依赖（与原 tools.ts 同一语义）。
function identityRequire(connectionKey: string): { agentKey: string; teamId: string; sessionId: string; role: "peer" | "worker" } {
  return identityStore.require(connectionKey);
}

// ---------------------------------------------------------------------------
// SDK 接线（FamilyRegistrar 形态；server.ts 持有 PrimaryRegistry）
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCore } from "./core.js";
import type { ToolDeps as _TD, PrimaryRegistry } from "./core.js";
import { connectionKeyOf } from "./identity.js";

/** 注册 xc_dispatch / xc_claim / xc_report（同名保留工具，无弃用警告）。 */
export function registerTaskTools(
  server: McpServer,
  deps: _TD,
  core: ToolCore,
  registry: PrimaryRegistry,
): void {
  const taskCore = core.xc_dispatch !== undefined ? core : createTaskCore(deps);
  const reg = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>,
  ): void => {
    server.tool(name, description, shape, handler);
    registry.set(name, { description, shape, handler });
  };
  reg(
    "xc_dispatch",
    "Dispatch a verifiable task to a registered member (creates pending task + mailbox message, then optionally wakes the target). priority (high/normal/low, default normal) only orders presentation/claim suggestions - it never preempts.",
    DispatchShape,
    async (args, extra) => taskCore.xc_dispatch(args as unknown as DispatchArgs, connectionKeyOf(extra)),
  );
  reg(
    "xc_claim",
    "Atomically claim a pending task; returns the attempt token required by xc_report. Refuses with rollback_conflict when the dispatcher's mailbox already holds a completed receipt for this task (team state was rolled back by a stale backup restore).",
    ClaimShape,
    async (args, extra) => taskCore.xc_claim(args as unknown as ClaimArgs, connectionKeyOf(extra)),
  );
  reg(
    "xc_report",
    "Report task progress/completion/failure/blocked with the current attempt token; completion requires result and >=1 evidence (file must exist inside the workspace; the v0.5 sha256 re-check was removed - a carried evidence[].sha256 is ignored and disclosed). status=blocked pauses the task keeping the attempt alive and requires a non-blank error as the blocking reason.",
    ReportShape,
    async (args, extra) => taskCore.xc_report(args as unknown as ReportArgs, connectionKeyOf(extra)),
  );
}
