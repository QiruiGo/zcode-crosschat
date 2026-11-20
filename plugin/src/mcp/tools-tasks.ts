/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T2/T3/T4）：任务三件套 xc_dispatch / xc_claim /
 * xc_report 的核心实现——原 tools.ts 对应方法 1:1 平移（校验、锁、回执、唤醒路径
 * 逐行不变），差异只有三处（方案 §1-C2/§1-B）：
 * ① dispatch 增 `priority`（high/normal/low，缺省 normal；排序建议非抢占，§3.2）；
 * ② report status 增 `blocked`（认领者显式申报暂停；attempt 保留；core 层
 *    applyReport/applyReportBlocked 落 preBlockedStatus/blockedReason/blockedAt）；
 * ③ evidence 的 sha256 由工具现算并与调用方声明值复核（v0.7.1 边界-7 恢复 v0.5 语义：
 *    v0.6 砍复核后 `ignored` 披露 + 回执 sha256=null 使 DEMO 文档化的核对流程无法完成）；
 *    文件存在门（evidence_file_missing）、工作区遏制门（evidence_path_outside_workspace，
 *    v0.5.2 bug-05 修复不回退）与「必须是普通文件」门（evidence_not_a_file，v0.7.1 边界-8）
 *    三道并存。
 *
 * 身份 = 连接绑定；并发纪律（§2.7）与 tools.ts 完全一致；attemptWake 只在锁外。
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import { checkLinkContainment } from "../core/paths.js";
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
import { withTeamLock, withSessionTurnLock, SessionTurnBusyError } from "../core/lock.js";
import { attemptWake } from "../engine/wake.js";
import { identityStore } from "./identity.js";
import { sanitizeKey } from "../core/sanitize.js";
import { DEFAULT_TEAM_ID, memberState, TERMINAL_TASK_STATUSES, TASK_PRIORITIES } from "../core/types.js";
import type { EvidenceItem, TeamMessage, TeamState } from "../core/types.js";
import {
  appendTaskHistory,
  applyReport,
  beginTaskAttempt,
  findActiveDuplicateTask,
  getTask,
  makeTask,
  memberOpenTasks,
  newTeamState,
  noteTeamReset,
  readTeam,
  reportTransitionError,
  taskTicketFingerprint,
  unsatisfiedDependencies,
  writeTeam,
} from "../core/teamstate.js";
import {
  appendMailbox,
  createMessage,
  isCurrentMail,
  markMailboxConsumed,
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
  // v0.9.1（G-13）：查重硬闸的显式越权开关——同一受领人已有同票活任务时默认拒绝
  // （duplicate_active_task），传 true 才放行并落审计。**只**越过任务板查重这一层，
  // 不越过「未读信封幂等」（那一层不建新单，无需越权）。缺省 absent = 不放行。
  force: z.boolean().optional().describe("同一受领人已有同票活任务时强制建单（默认拒绝；审计留痕 dispatch-force-duplicate）"),
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
        path: z.string().min(1).describe("证据文件路径（绝对或相对工作区；必须在工作区内）"),
        // v0.7.1（边界-7）：恢复 v0.5 复核语义——缺省或 null = 未声明（工具现算后落库）；
        // 提供时必须与工具现算的 sha256 一致，不符整单拒绝（evidence_checksum_mismatch）。
        sha256: z.string().nullable().optional().describe("可选：调用方自算的 sha256（hex，大小写不敏感）；缺省/null=由工具现算，提供时必须与现算值一致否则 evidence_checksum_mismatch"),
        // v0.7.1（边界-8）：note 可选性显式——省略按空串入库；控制字符清洗为空格、超长截断。
        note: z.string().optional().describe("可选的一句话摘要；省略按空串入库，控制字符会被清洗为空格"),
      }),
    )
    .optional()
    .describe("completed 必须至少 1 条；每条必须是工作区内真实存在的普通文件（evidence_not_a_file / evidence_file_missing / evidence_path_outside_workspace），sha256 由工具现算复核"),
} as const;

export type DispatchArgs = { to: string; title: string; prompt: string; acceptance?: string; dependsOn?: string[]; priority?: (typeof TASK_PRIORITIES)[number]; force?: boolean };
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
// 证据门纯函数（v0.7.1 边界-7/边界-8；锁外现算，导出供单测）
// ---------------------------------------------------------------------------

/** evidence note 的最大入库长度（超长截断；防 JSONL 真源被单条摘要撑爆）。 */
export const EVIDENCE_NOTE_MAX_LENGTH = 500;

/** 控制字符清洗（与 tools-team.ts sanitizeLeadReason 同口径：C0/DEL → 空格）。 */
const EVIDENCE_NOTE_CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/**
 * v0.7.1（边界-8）：note 清洗——可选性显式化 + 控制字符不原样入库。
 *
 * `undefined`/空串按「未写摘要」处理返回 `""`（note 仍是可选的，省略不等于拒绝）；
 * 其余值先剥控制字符（含 `\n` `\t` `\u0000`，一律降为空格）、去首尾空白、再钳长度。
 */
export function sanitizeEvidenceNote(note: string | undefined): string {
  if (typeof note !== "string") return "";
  return note
    .replace(EVIDENCE_NOTE_CONTROL_RE, " ")
    .trim()
    .slice(0, EVIDENCE_NOTE_MAX_LENGTH);
}

/**
 * v0.7.1（边界-7）：证据文件 sha256 现算（流式，不整文件读进内存）。
 * 不可读/不是普通文件 → `null`（调用方转 evidence_file_missing / evidence_not_a_file）。
 */
export async function sha256File(path: string): Promise<string | null> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// v0.9.2（B3）：id 类入参的长度闸（≤512）与错误回显截断
// ---------------------------------------------------------------------------

/**
 * v0.9.2（B3）：id 类入参（xc_read 的 id / xc_claim·xc_report 的 taskId …）长度上限。
 *
 * 这些 id 全是**短句柄**（`<era>-t<n>` 任务号 / uuid / 花名 / `archive:<name>`），
 * 512 字符已远超一切合法形态。动机：它们会被工具原样回显进错误消息与结构化
 * payload（`unknown task "<id>"`、`journal_not_found {id}`、`handoff id <id>` …）——
 * 调用方塞进 1 MiB 垃圾串时，错误回显把整段吐回注入面：既烧注入预算，又是把
 * 调用方输入放大回显的通道。长度闸在入口处硬拒，回显只留前 512 字符 + 长度标注。
 */
export const TOOL_ID_MAX_LENGTH = 512;

/** 错误回显截断：超长只留前 {@link TOOL_ID_MAX_LENGTH} 字符 + `…[truncated, N chars total]` 标注。 */
export function truncateIdEcho(id: string): string {
  return id.length <= TOOL_ID_MAX_LENGTH
    ? id
    : `${id.slice(0, TOOL_ID_MAX_LENGTH)}…[truncated, ${id.length} chars total]`;
}

/**
 * v0.9.2（B3）：长度闸——超限即结构化拒绝（`id_too_long`，invalid_params 族，
 * 与 withdraw_exclusive_params 同款的显式错误码口径），回显截断不整段回吐。
 */
export function assertToolIdWithinLimit(id: string, field: string): void {
  if (id.length <= TOOL_ID_MAX_LENGTH) return;
  throw invalidParamsError(
    `${field} exceeds the ${TOOL_ID_MAX_LENGTH}-char id limit (got ${id.length} chars); `
      + "ids are short handles (task id / message id / member key) — echo truncated: "
      + JSON.stringify(truncateIdEcho(id)),
    { error: "id_too_long", field, length: id.length, limit: TOOL_ID_MAX_LENGTH },
  );
}

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

/**
 * v0.7.1（规模压-B3）：派发幂等去重键的唯一定义（工具面、回执披露、单测共用）。
 *
 * 键 = `to=<受领成员键>|ticket=<任务票文本 sha256 前 16 hex>`。
 * **不含发送方**、不含 taskId（新 taskId 不可预知）、不含 attempt 快照：
 * 「同一张票、同一个收方、还没被读过」即视为重复派发。完整定义见
 * README「重复派发幂等」与 docs/PROTOCOL.md §4。
 */
export function dispatchDedupKey(toKey: string, ticket: string): string {
  return `to=${toKey}|ticket=${sha256Of(ticket).slice(0, 16)}`;
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
      message: `"${agentKey}" is not a member of team "${team.teamId}"; register first (xc_identify)`,
    });
  }
}

/**
 * v0.7.2（红队五番战 C8-B3 修复）：派单目标的**生命周期**闸。
 *
 * 红队实测（c8b3）：`xc_team member-stop` 后成员 state=removed（花名不释放、
 * roster 记录保留），`xc_dispatch({to:"m1"})` 仍返回「dispatched to m1 via
 * mailbox.」——任务建单成功但永久搁浅：他人 claim 得 `not_assignee`、removed
 * 成员自身无法认领、pending 不在 SWEEPABLE 清扫域、创建者收不到任何回执。
 * 与 §5.4「member-stop 对在途（claimed/in_progress）任务回池」相邻，但
 * pending 派单从未被任何既有闸覆盖。
 *
 * 修法 = 派发面显式拒绝 + 指引（不静默建单）：removed 成员的重新启用只有
 * lead 的 `xc_team member-add`（幂等重供给，§6.4）或改派活成员两条路。
 * 会籍存在性校验（requireMember）之后做——错误码区分「不在册」与「已停机」。
 */
async function requireDispatchTarget(stateRoot: string, team: TeamState, agentKey: string): Promise<void> {
  const member = team.members.find((m) => m.key === agentKey);
  if (member !== undefined && memberState(member) === "removed") {
    // 观测面留痕：谁在何时试图给已停机成员派单（与 peer-name-taken-refused 同族）。
    await logEngineEvent(stateRoot, {
      event: "dispatch-refused",
      teamId: team.teamId,
      to: agentKey,
      reason: "member_removed",
    });
    throw new ToolError({
      error: "member_removed",
      agentKey,
      teamId: team.teamId,
      message:
        `member "${agentKey}" was removed from team "${team.teamId}" (xc_team member-stop); dispatch refused — ` +
        `dispatching to a stopped member would strand the task forever (nobody can claim it: others get ` +
        `not_assignee, the stopped member cannot claim, and pending tasks are outside the stale-sweep domain). ` +
        `Re-dispatch to an active member, or ask the lead to re-enable "${agentKey}" via xc_team ` +
        `{action:"member-add"} (idempotent reprovision; the archive under .crosschat/archive/${agentKey}/ ` +
        `holds its handover context)`,
    });
  }
}

export interface TaskCore {
  xc_dispatch(args: DispatchArgs, connectionKey: string): Promise<ToolResult>;
  xc_claim(args: ClaimArgs, connectionKey: string): Promise<ToolResult>;
  xc_report(args: ReportArgs, connectionKey: string): Promise<ToolResult>;
}

/**
 * v0.9.1（G-16）：变更类写操作（派单/认领/回报）的同 sessionId 互斥入口。
 *
 * 锁序固定 **turn(sid) → team**：turn 锁在最外层（既有 team 锁路径从不持 turn，
 * 无环）。互斥原语与让位语义在 core/lock.ts 的 withSessionTurnLock（复用既有
 * acquireFileLock：同一 O_EXCL/pid 死判/陈旧接管/token 释放）。
 *
 * 让位回执 `busy_interactive_turn`：结构化错误（isError），不阻塞、不自动重试；
 * 文案给两条出路（稍后重试 / 改道 xc_relay）并明确「不要紧循环重试」。同时落
 * engine.jsonl `turn-conflict-yield` 审计（谁在什么时候给哪个 sid 让过位）。
 */
async function withSessionTurnGuard<T>(
  stateRoot: string,
  me: { agentKey: string; teamId: string; sessionId: string },
  tool: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withSessionTurnLock(stateRoot, me.sessionId, fn);
  } catch (error) {
    if (!(error instanceof SessionTurnBusyError)) throw error;
    await logEngineEvent(stateRoot, {
      event: "turn-conflict-yield",
      teamId: me.teamId,
      agentKey: me.agentKey,
      sessionId: me.sessionId,
      tool,
      holderPid: error.holderPid,
      holderAgeMs: error.holderAgeMs,
    });
    throw new ToolError({
      error: "busy_interactive_turn",
      tool,
      sessionId: me.sessionId,
      holderPid: error.holderPid,
      holderAgeMs: error.holderAgeMs,
      message:
        `another live turn is already writing session ${me.sessionId}; this ${tool} call yields ` +
        `(busy_interactive_turn) instead of blocking or retrying. ` +
        `Wait for the other turn to finish and call ${tool} again shortly, or route the work another way ` +
        `(xc_relay for a plain message); do not retry in a tight loop.`,
    });
  }
}

export function createTaskCore(deps: ToolDeps): TaskCore {
  const { stateRoot, workspace } = deps;

  return {
    async xc_dispatch(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityRequire(connectionKey);
        // v0.9.1（G-16）：turn 互斥在 team 锁之外（锁序 turn → team）。
        return withSessionTurnGuard(stateRoot, me, "xc_dispatch", async () => {
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
            // v0.7.2（C8-B3 修复）：已停机（removed）成员不接受派单（显式拒绝，不建单）。
            await requireDispatchTarget(stateRoot, team, toKey);
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
            // duplicate 幂等判定（v0.7.1 规模压-B3：去重键**不含发送方**）。
            //
            // 去重键（文档化口径，README/PROTOCOL §dispatch 幂等）：
            //   duplicateKey = (to, ticket) ∧ 该派发信封未被读过 ∧ isCurrentMail
            // 即「收方邮箱里是否已有一条同票、未读、仍现行的派发信封」——谁派的无关。
            // 旧实现把 `m.from === me.agentKey` 与「发送方当前开放 attempt 快照」也算进键，
            // 于是两个会话把同一张票派给同一目标各建一单、各投一条（红队 b3scale 实测
            // team.json 2 单 / inbox 2 行）；同发送方换一条在途任务重派也会漏判。
            const existing = await readMailbox(stateRoot, me.teamId, toKey);
            // 发送方当前开放 attempt 快照（source 字段透传；**不参与**去重键——见上）。
            const myOpen = memberOpenTasks(team.tasks, me.agentKey)[0];
            const dup = existing.find(
              (m) =>
                m.to === toKey &&
                m.content === ticket &&
                m.attemptId === undefined &&
                isCurrentMail(team, m) &&
                m.readAt === undefined,
            );
            if (dup !== undefined) {
              const task = getTask(team, dup.taskId ?? "");
              return {
                kind: "duplicate" as const,
                taskId: dup.taskId ?? "",
                status: task?.status ?? "pending",
                duplicateKey: dispatchDedupKey(toKey, ticket),
                originalCreatedBy: task?.createdBy,
              };
            }

            // v0.9.1（G-13）：派单查重硬闸——**任务板**上的同票活任务。
            //
            // 与上方「未读信封幂等」是两层、并存（不是替代）：信封层回答「投递面
            // 还有没有一条同票未读信封」，本层回答「任务板上还有没有同一张票的活
            // 任务」。信封一旦被消费（readAt 落下）就不再参与幂等——此时若无本层，
            // 同一张票会被反复建成新单（G-13 的生产形态：58 秒内对同一
            // 成员连派三张重复票）。
            //
            // 判据与 force 语义见 core/teamstate.ts 的 findActiveDuplicateTask /
            // ACTIVE_DUPLICATE_TASK_STATUSES；force 只越本层，不越信封层。
            const ticketFingerprint = taskTicketFingerprint({
              title: args.title,
              prompt: args.prompt,
              acceptance: args.acceptance,
            });
            const activeDup = findActiveDuplicateTask(team, {
              to: toKey,
              title: args.title,
              prompt: args.prompt,
              acceptance: args.acceptance,
            });
            if (activeDup !== undefined && args.force !== true) {
              // 观测面留痕：谁在何时试图给同一成员派同一张票（与 dispatch-refused
              // member_removed 同族同事件名、不同 reason）。
              await logEngineEvent(stateRoot, {
                event: "dispatch-refused",
                teamId: me.teamId,
                to: toKey,
                taskId: activeDup.id,
                reason: "duplicate_active_task",
              });
              throw new ToolError({
                error: "duplicate_active_task",
                taskId: activeDup.id,
                status: activeDup.status,
                assignee: toKey,
                ticketFingerprint,
                duplicateKey: dispatchDedupKey(toKey, ticket),
                message:
                  `member "${toKey}" already has active task ${activeDup.id} (${activeDup.status}) for the exact same ticket ` +
                  `(title+prompt+acceptance fingerprint ${ticketFingerprint}); dispatch refused to prevent duplicate work. ` +
                  `Continue that task instead (xc_read({scope:"task", id:"${activeDup.id}"})), or nudge the member with xc_relay. ` +
                  `If you really need a second identical ticket, re-dispatch with force:true (audited as dispatch-force-duplicate).`,
              });
            }
            if (activeDup !== undefined) {
              // force 放行 = 显式越权，必须留痕（事件名与拒绝路径区分，便于审计
              // 「谁在什么时候绕过过查重硬闸」）。
              await logEngineEvent(stateRoot, {
                event: "dispatch-force-duplicate",
                teamId: me.teamId,
                from: me.agentKey,
                to: toKey,
                existingTaskId: activeDup.id,
                existingStatus: activeDup.status,
                ticketFingerprint,
              });
            }

            // 建任务（pending，M1 makeTask 推进 seq 并入队）+ 写 to 邮箱（§2.8）。
            // v0.6（C2）：priority 透传（makeTask 防御性收敛，枚举外归 absent）。
            // v0.6.1（红队四番战 安全对-3 修复）：受领人 toKey 落盘——xc_claim 只
            // 允许受领人本人认领（与 xc_report 的 not_assignee 硬闸对齐），防他人
            // 抢认 pending 任务把正主锁死在 task_not_pending。
            const task = makeTask(team, {
              title: args.title.trim(),
              prompt: args.prompt,
              acceptance: args.acceptance?.trim() || undefined,
              dependsOn: args.dependsOn,
              to: toKey,
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
            // v0.7.1（规模压-B3）：回执披露去重键与首派方——键不含发送方，命中时调用方
            // 看到的可能是**别人**派的那一单，必须能看出「这一单已经有人派过了」。
            const by = prepared.originalCreatedBy;
            return okResult(
              `Task ${prepared.taskId} already dispatched (duplicate); no new task created.`
                + (by !== undefined && by !== me.agentKey ? ` (first dispatched by "${by}")` : ""),
              {
                taskId: prepared.taskId,
                status: prepared.status,
                delivered: "duplicate",
                duplicateKey: prepared.duplicateKey,
                ...(by !== undefined ? { originalCreatedBy: by } : {}),
              },
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
      });
    },

    async xc_claim(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityRequire(connectionKey);
        // v0.9.2（B3）：id 长度闸在 turn 锁外——超长输入（回显放大面）不必惊动锁。
        assertToolIdWithinLimit(args.taskId, "taskId");
        // v0.9.1（G-16）：turn 互斥在 team 锁之外（锁序 turn → team）。
        return withSessionTurnGuard(stateRoot, me, "xc_claim", async () => {
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
            // v0.6.1（红队四番战 安全对-3 修复）：受让人硬闸——fresh pending 且已
            // 指派（dispatch 带 to）的任务只有受领人本人可认领，与 xc_report 的
            // not_assignee 同一口径（修复前任何成员可抢认别人的 pending 任务，把正主
            // 锁死在 task_not_pending）。absent = 旧记录（v0.6.1 前落盘）或已被引擎
            // 回池的任务（revokeAttempt 清 to = 共享待领池，红队旧案「他人领不走」
            // 解除不回退）→ 认领面兼容开放。
            if (task.to !== undefined && task.to !== me.agentKey) {
              throw new ToolError({
                error: "not_assignee",
                taskId: task.id,
                assignee: task.to,
                message: `task ${task.id} is assigned to "${task.to}", not you`,
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
            // v0.9.1（G-12v3 机制 B）：认领 = 读件——把本邮箱里指向该任务的派单信封
            // 回写 consumedAt（消费确认）。防的是「wake 盖章 → 成员直接 xc_claim 开工
            // （守则 v2 的 a/b 步）→ 从不等 inbox」的形态被 limbo 误判成「盖章未消费」
            // （10min 后误降级 + 误告警）。readAt 不动（历史留痕语义不变）。
            const assignmentIds = (await readMailbox(stateRoot, team.teamId, me.agentKey))
              .filter((m) => m.taskId === task.id && m.consumedAt === undefined && m.discardedAt === undefined)
              .map((m) => m.id);
            if (assignmentIds.length > 0) {
              await markMailboxConsumed(stateRoot, team.teamId, me.agentKey, assignmentIds);
            }
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
      });
    },

    async xc_report(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const me = identityRequire(connectionKey);
        // v0.9.2（B3）：id 长度闸在 turn 锁外（与 xc_claim 同口径；attemptId 是工具
        // 铸造的短令牌，不回显调用方原值，不设闸）。
        assertToolIdWithinLimit(args.taskId, "taskId");
        // v0.9.1（G-16）：turn 互斥在 team 锁之外（锁序 turn → team）。证据门是锁外
        // 慢操作（sha256 现算），一并纳入 turn 临界区——「回报」这个写操作从校验到
        // 落盘对同一 sessionId 只允许一个回合在做。
        return withSessionTurnGuard(stateRoot, me, "xc_report", async () => {
          // 慢操作在锁外：证据门（§1.2 T4）。三道门全在锁外现算/现查：
          // ① 工作区内路径（evidence_path_outside_workspace，v0.5.2 bug-05 修复不回退）；
          // ② 必须是**普通文件**（evidence_not_a_file，v0.7.1 边界-8：目录/设备文件不得充证据）；
          // ③ sha256 由工具现算并与调用方声明值复核（evidence_checksum_mismatch，v0.7.1 边界-7
          //    恢复 v0.5 语义——v0.6 砍复核后 `ignored` 披露与回执 sha256=null 使 DEMO 文档化的
          //    「回执含 sha256 → 与文件核对一致」流程无法完成）。缺省/显式 null = 未声明，落库存现算值。
          const evidence: EvidenceItem[] = [];
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
            // v0.9.2（B2）：符号链接/junction 逃逸闸——词法 containment 之后、stat 之前。
            // stat 跟随链接，词法前缀判定看不出 `<ws>/escape → 外部目录` 这种形态；
            // realpath 归一后越界即拒（错误码与词法闸相同，message 如实说明经链接逃逸）。
            // 闸本体在 core/paths.ts（V092-10 起 journal 读取面/检查点同用，锚点=工作区）。
            const linkGate = await checkLinkContainment(wsRoot, abs);
            if (linkGate.escaped) {
              throw new ToolError({
                error: "evidence_path_outside_workspace",
                path: e.path,
                workspace: wsRoot,
                message: `evidence file "${e.path}" escapes the workspace via `
                  + `${linkGate.viaLink ? "symlink/junction" : "resolved path"}: it resolves to `
                  + `"${linkGate.real}", outside "${wsRoot}" — `
                  + "evidence must be a real file under the shared workspace (§2.6 evidence gate, v0.9.2 B2 link containment)",
              });
            }
            let stats;
            try {
              stats = await stat(abs);
            } catch {
              throw new ToolError({
                error: "evidence_file_missing",
                path: e.path,
                message: `evidence file "${e.path}" does not exist or is unreadable; the evidence gate requires a real file (§2.6)`,
              });
            }
            // v0.7.1（边界-8）：目录/套接字/设备文件不得作证据——`stat` 存在≠是文件。
            if (!stats.isFile()) {
              throw new ToolError({
                error: "evidence_not_a_file",
                path: e.path,
                message: `evidence "${e.path}" is not a regular file (${stats.isDirectory() ? "directory" : "non-regular file"}); ` +
                  `the evidence gate requires a real file inside the workspace (§2.6)`,
              });
            }
            const computed = await sha256File(abs);
            if (computed === null) {
              throw new ToolError({
                error: "evidence_file_missing",
                path: e.path,
                message: `evidence file "${e.path}" does not exist or is unreadable; the evidence gate requires a real file (§2.6)`,
              });
            }
            // 声明值（非 null）与现算值不符 → 整单拒绝（hex 大小写不敏感、首尾空白忽略）。
            const claimed = typeof e.sha256 === "string" ? e.sha256.trim().toLowerCase() : "";
            if (claimed !== "" && claimed !== computed.toLowerCase()) {
              throw new ToolError({
                error: "evidence_checksum_mismatch",
                path: e.path,
                claimed: e.sha256 as string,
                computed,
                message: `evidence sha256 mismatch for "${e.path}": claimed ${e.sha256}, computed ${computed}`,
              });
            }
            // v0.7.1（边界-8）：note 可选性显式化——省略按空串入库；控制字符一律清洗为空格
            // （与 sanitizeLeadReason 同口径），长度钳制，防原样入库污染 JSONL 真源。
            evidence.push({ path: e.path, sha256: computed, note: sanitizeEvidenceNote(e.note) });
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
            ...(evidence.length > 0
              ? { evidenceSha256: evidence.map((e) => ({ path: e.path, sha256: e.sha256 })) }
              : {}),
          });
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
    "Atomically claim a pending task; returns the attempt token required by xc_report. Only the member the task was dispatched to may claim it (not_assignee otherwise, same gate as xc_report). Refuses with rollback_conflict when the dispatcher's mailbox already holds a completed receipt for this task (team state was rolled back by a stale backup restore).",
    ClaimShape,
    async (args, extra) => taskCore.xc_claim(args as unknown as ClaimArgs, connectionKeyOf(extra)),
  );
  reg(
    "xc_report",
    "Report task progress/completion/failure/blocked with the current attempt token; completion requires result and >=1 evidence (each entry must be a real regular file inside the workspace; the tool computes its sha256 and rejects a carried evidence[].sha256 that does not match - evidence_checksum_mismatch). status=blocked pauses the task keeping the attempt alive and requires a non-blank error as the blocking reason.",
    ReportShape,
    async (args, extra) => taskCore.xc_report(args as unknown as ReportArgs, connectionKeyOf(extra)),
  );
}
