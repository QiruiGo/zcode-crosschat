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
import type { FileHandle } from "node:fs/promises";
import { open, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
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
  type DispatchDeferredState,
  type UrgentReportState,
  type WakeReceiptState,
} from "./render.js";
import { withTeamLock, withSessionTurnLock, SessionTurnBusyError } from "../core/lock.js";
import { attemptWake } from "../engine/wake.js";
import { identityStore } from "./identity.js";
import { sanitizeKey } from "../core/sanitize.js";
import { DEFAULT_TEAM_ID, memberState, TERMINAL_TASK_STATUSES, TASK_PRIORITIES, plausibleLivenessTs } from "../core/types.js";
import type { EvidenceItem, TeamMessage, TeamState } from "../core/types.js";
import {
  appendTaskHistory,
  applyReport,
  beginTaskAttempt,
  findActiveDuplicateTask,
  getTask,
  leadKeyOf,
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
import { engineLogFile } from "../core/paths.js";
import { findInflightWakeNonce, readSession } from "../core/registry.js";
import { receiverInjectBudget, contextCharsFromEnv, truncateField } from "../core/budget.js";
import { sha256Of } from "../core/msgstore.js";
import type { ToolDeps } from "./core.js";
import { runCore } from "./core.js";

/** v1 单队固定 default（DESIGN §2.2）。 */
const TEAM_ID = DEFAULT_TEAM_ID;

/** createMessage 可携带的投递快照字段（与 v0.5.3 一致）。
 * v0.10.0（R8）：白名单再扩含 urgent——插队回单的写入侧新增键（xc_relay 的 urgent
 * 写入侧同款，v0.6 C1 起 createMessage 即宽容接收），其余行逐字节不动。 */
type MessageExtras = Partial<
  Pick<TeamMessage, "taskId" | "attemptId" | "sourceTaskId" | "sourceAttemptId" | "sourceTaskStatus" | "deliveryClaimedAt" | "urgent">
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
  // v0.10.0（R8，用户点名）：插队回单（"半截回单"）——true 时本条按插队语义投递：
  // 回执消息带 urgent（排到收件人未读最前）、对任务创建者发起一次 urgent 唤醒尝试
  // （创建者不是 lead 时 lead 邮箱也落一份不唤醒的通知）、人可读行以【插队回单】开头。
  // 终态（completed/failed）与中间态（in_progress/blocked）都可带——中间态原本无回执，
  // urgent 时才建（成员半截把重要发现送出去、然后继续干）。防风暴：同一成员 10 分钟内
  // 最多 5 次 urgent（XC_URGENT_REPORT_MAX 可调），超出的自动降级为普通回单并在回执写明。
  urgent: z.boolean().optional().describe("插队回单（v0.10.0 R8）：true 时回执消息 urgent 置顶 + 对任务创建者 urgent 唤醒尝试；创建者非 lead 时 lead 邮箱落一份不唤醒的通知。半截（in_progress/blocked）也可用。防风暴：同一成员 10 分钟内最多 5 次（XC_URGENT_REPORT_MAX 可调），超出自动降级为普通回单"),
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
  /** v0.10.0（R8）：插队回单开关（可选；缺省/absent = 普通回单，行为与 v0.9.9 逐字节一致）。 */
  urgent?: boolean;
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
// v0.10.0（R8）：插队回单的**防风暴闸**（同一成员 10 分钟内 urgent 回单上限）
//
// 动机（用户令（R8））：半截回单是一等公民能力，
// 但「插队」语义（置顶 + 唤醒）被滥用时会反过来轰炸收件人——每次 urgent 回单都可能
// 唤醒创建者（甚至惊动 lead 邮箱），一个成员狂点 urgent 等于把普通进度升级成噪音。
// 上限用**环境变量** XC_URGENT_REPORT_MAX 覆盖（可选、带默认值，0 新增必填配置）。
//
// 计数真源 = engine.jsonl 的 `report-urgent` 审计事件（回单发生时落的那条），
// 有界尾读（不全文件读——日志无上界，core/timeline.ts 同款纪律）；读不到/解析失败
// → 0（fail-open：闸只防风暴，不拦投递，绝不因观测面故障把回单降级）。
// ---------------------------------------------------------------------------

/** 防风暴计数窗（ms）——同一成员 urgent 回单的滚动窗口。 */
export const URGENT_REPORT_WINDOW_MS = 10 * 60_000;

/** 窗内 urgent 回单上限缺省值（env XC_URGENT_REPORT_MAX 覆盖）。 */
export const URGENT_REPORT_MAX_DEFAULT = 5;

/** engine.jsonl 尾读窗口（字节）——覆盖 10min 窗所需的最新事件即止（约数千行）。 */
const URGENT_REPORT_TAIL_BYTES = 1024 * 1024;

/**
 * env `XC_URGENT_REPORT_MAX` 解析（正整数；未设/空串/非正/不可解析 → 缺省 5）。
 * 与 limbo/wake-slow 家族同口径：不接受「关闭用 0」——要停插队语义别传 urgent。
 */
export function urgentReportMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.XC_URGENT_REPORT_MAX;
  if (raw === undefined || raw.trim() === "") return URGENT_REPORT_MAX_DEFAULT;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : URGENT_REPORT_MAX_DEFAULT;
}

/**
 * 统计窗内该成员**已生效**的 urgent 回单数（engine.jsonl 有界尾读；只数
 * `report-urgent` 且 from 命中、时刻落在窗内的行——降级 Attempt 不落本事件，
 * 不占额度，见 xc_report 内注释）。
 *
 * 纯观测面计数：读失败/坏行一律跳过（返回已数到的部分），绝不因此抛错。
 */
export async function countRecentUrgentReports(
  stateRoot: string,
  from: string,
  now: number,
  windowMs: number = URGENT_REPORT_WINDOW_MS,
): Promise<number> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(engineLogFile(stateRoot), "r");
    const size = (await handle.stat()).size;
    const length = Math.min(size, URGENT_REPORT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    // 窗口首行可能是被截断的半行（size > length 时才有）——丢弃，防半个 JSON 误解析。
    if (size > length) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }
    let count = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof value !== "object" || value === null) continue;
      const event = value as Record<string, unknown>;
      if (event.event !== "report-urgent") continue;
      if (event.from !== from) continue;
      const ts = event.ts;
      if (typeof ts !== "number" || !plausibleLivenessTs(ts, now)) continue;
      if (now - ts > windowMs) continue;
      count++;
    }
    return count;
  } catch {
    // 审计日志不可读（不存在/占用/权限）→ 不挡（fail-open：cap 是防风暴不是投递闸）。
    return 0;
  } finally {
    await handle?.close();
  }
}

// ---------------------------------------------------------------------------
// v0.10.0（R8 补充，用户追加裁决）：紧急回单的**收方回合进行中**闸
//
// 裁决原文要义：紧急回单不得把回合正在进行的主控拉成无头分身（R5 同款事故的
// 回单面复现——17:42 主控正等用户答选项卡时被 urgent 唤醒成无头分身）。该裁决
// **优先于 R8 原文里「唤醒收方」的字面**：收件人回合进行中时紧急回单不发起唤醒，
// 消息照常 urgent 落邮箱 + 打待补醒标记，补醒交给看门狗（组 A）在回合结束后做。
//
// 判据与派单忙闲闸（B1）同源并多一项：
// ① 会话记录 liveness='running' ∧ livenessTs 可信（最近的引擎事件是 session-running
//    且之后没有 session-idle 的落盘投影）；
// ② **有在途唤醒也算进行中**——registry/wake/ 里有该成员新鲜未消费的 wake nonce
//    （WAKE_INFLIGHT_MS=15min 窗；spawn 已发起、回合尚未开跑的形态）。
// 只在有**正向证据**时挡唤醒：读不到证据（ENOENT/读盘失败）按「不在跑」放行
// （与忙闲闸同方向——闸挡的是「已被证明在跑」的收方，不是「查不到状态」的收方）。
// ---------------------------------------------------------------------------

/** 待补醒标记的唯一取值（消息 content 的 wakeDeferred 键 / 审计 reason 键共用）。 */
export const RECIPIENT_TURN_RUNNING = "recipient-turn-running";

/**
 * 收件人回合是否正在进行（紧急回单唤醒闸的判据；无盘外副作用，读盘失败按不在跑）。
 *
 * @param agentKey 收件人成员键（在途唤醒 nonce 按它匹配）
 * @param sessionId 收件人在花名册上的 sessionId（无 sid → 只查在途唤醒）
 * @param now 时钟注入（测试用）
 */
async function recipientTurnInProgress(
  stateRoot: string,
  agentKey: string,
  sessionId: string | null,
  now: number,
): Promise<boolean> {
  if (sessionId !== null) {
    try {
      const record = await readSession(stateRoot, sessionId);
      if (record?.liveness === "running" && plausibleLivenessTs(record.livenessTs, now)) return true;
    } catch {
      // 读盘失败 → 证据不足，按不在跑（见本节注释：只在有正向证据时挡唤醒）
    }
  }
  try {
    // findInflightWakeNonce 内部已按 isWakeNonceFresh（未用 ∧ 15min 窗）过滤，
    // 并取 ts 最新的一张；按 agentKey 匹配（票据只可能签发给它的目标成员）。
    const inflight = await findInflightWakeNonce(stateRoot, agentKey, { teamId: TEAM_ID, now });
    if (inflight !== undefined) return true;
  } catch {
    // 同上：观测面故障不改唤醒决策
  }
  return false;
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

/** 回执消息内容：机器可解析 JSON，attempt 关联保留在此（见 xc_report 内注释）。
 * v0.10.0（R8 补充）：`wakeDeferred` 可选键——紧急回单的唤醒被「收方回合进行中」
 * 挡下时打在回执帧上（待补醒标记；看门狗侧据此认「这条 urgent 回单还欠一次唤醒」）。
 * 缺省不传 = 与 v0.9.9 逐字节一致（旧帧无该键）。 */
function receiptText(
  taskId: string,
  attemptId: string,
  status: string,
  task: TeamState["tasks"][number],
  wakeDeferred?: string,
): string {
  return JSON.stringify({
    type: "task-receipt",
    teamId: TEAM_ID,
    taskId,
    attemptId,
    status,
    result: task.result,
    error: task.error,
    evidence: task.evidence,
    ...(wakeDeferred !== undefined ? { wakeDeferred } : {}),
  });
}

/**
 * v0.10.0（R8）：插队回单给 lead 的通知里的**要点摘录**子句（result / error 各截
 * 300 字符；都缺省 → 空串）。半截报送的价值在「重要发现」本身，只给指针主控还要再
 * 去读邮箱——摘录让通知自带信息量（仍以回执消息为完整真源）。
 */
function pickExcerpt(result: string | undefined, error: string | undefined): string {
  const r = result?.trim() ?? "";
  if (r !== "") return `；要点：${r.slice(0, 300)}`;
  const e = error?.trim() ?? "";
  if (e !== "") return `；阻塞原因：${e.slice(0, 300)}`;
  return "";
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
 * v0.9.7（W3/V096-01）：本模块 wake() 助手的返回形状——`delivered` 之外全量携带
 * attemptWake 的**三态键**（startConfirmed/wakeTiers/wakeFailureSeen/failureEvidence，
 * 语义见 render.ts 的 {@link WakeReceiptState}）。旧形状只有
 * `{delivered, wakeLog, note}`，四键在 dispatch/report 回执面被结构性丢弃。
 */
interface WakeReceipt extends WakeReceiptState {
  delivered: "wake" | "mailbox";
  wakeLog?: string;
  note?: string;
}

/** 目标无 sessionId 时的 mailbox 降级 note（wake() 助手与忙闲闸共用，防两处文案漂移）。 */
const NO_SESSION_NOTE = "target has no sessionId on file";

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
 *
 * v0.9.7（W2/R1）：**failed 成员同闸**。41-v095 real-smoke C 实测形态：member-add
 * 失败（如 setModel 档位不被支持）后成员 state=failed ∧ sessionId=""，此时
 * `xc_dispatch` 旧实现照样建单——任务永久 pending：failed 成员无法认领、他人得
 * `not_assignee`、pending 不在清扫域，而唤醒侧只给 mailbox 降级（没有会话可 pull）。
 * 修法同 removed：显式拒绝、不建单、审计留痕、回执给下一步（同名幂等重供给 / 改派）。
 * 正常成员派单不受影响——provisioning 成员仍可收单（供给完成后投产唤醒 E-e 补投）。
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
  if (member !== undefined && memberState(member) === "failed") {
    // v0.9.7（W2）：failed 成员显式拒绝（不建单）——原因词汇与唤醒侧
    // `member-state:failed` 同源，运营面两面对得上；回执附 roster 上的失败原文。
    const rosterError = typeof member.error === "string" && member.error.trim() !== ""
      ? member.error.trim()
      : undefined;
    await logEngineEvent(stateRoot, {
      event: "dispatch-refused",
      teamId: team.teamId,
      to: agentKey,
      reason: "member-state:failed",
      memberState: "failed",
      ...(rosterError !== undefined ? { rosterError } : {}),
    });
    throw new ToolError({
      error: "member-state:failed",
      agentKey,
      teamId: team.teamId,
      memberState: "failed",
      ...(rosterError !== undefined ? { rosterError } : {}),
      message:
        `member "${agentKey}" is in state=failed on team "${team.teamId}" (provisioning failed` +
        `${rosterError !== undefined ? `: ${rosterError}` : ""}); dispatch refused (reason=member-state:failed) — ` +
        "a failed member has no live session, so the task could never be claimed or pulled " +
        "(stranded pending: others get not_assignee, the failed member cannot claim, and pending tasks are " +
        "outside the stale-sweep domain). Fix the provisioning root cause and re-enable with " +
        `xc_team({action:"member-add", name:"${agentKey}"}) (idempotent reprovision, §6.4), or re-dispatch ` +
        "to an active member",
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
            // v0.10.0（R2/G-28）：**忙闲闸判据采集**（锁内一次读盘；判据本身在锁外
            // wake 之前生效，采集放锁内是为了与建单用同一份 team 快照——两次读盘之间
            // 成员认领了任务会造成「以为不忙 → 还是 spawn 了第二路」的竞态）。
            //
            // 忙 = 任一成立：
            // ① 任务板上有它 **claimed/in_progress** 的任务（blocked 不算——那是
            //    认领者显式申报的暂停，不是回合在跑；claim 侧 already_has_open_task
            //    同款口径的收方侧投影）；
            // ② 注册表里它最近的引擎事件是 session-running 而之后没有 session-idle
            //    （会话记录 liveness 字段正是该事件流的落盘投影，registry.ts
            //    applyLivenessTransition/markSessionIdle 维护）——须带可信 livenessTs
            //    （plausibleLivenessTs：未来值/缺失 = 伪造或损坏，按不忙，core/liveness.ts
            //    runningTrusted 同口径）。
            //
            // R2 建议修法里的第三条备用判据（15min 窗内未消费 wake nonce）**未**纳入：
            // 需求 B1 的忙定义只含上述两条，且实测中 nonce 已被 SessionStart 钩子
            // 消费（不能单独依赖，纳入只会误挡）。
            const toSessionId = team.members.find((m) => m.key === toKey)?.sessionId ?? null;
            const openTaskIds = team.tasks
              .filter((t) => t.assignee === toKey && (t.status === "claimed" || t.status === "in_progress"))
              .map((t) => t.id);
            let sessionRunning = false;
            if (toSessionId !== null) {
              try {
                const record = await readSession(stateRoot, toSessionId);
                sessionRunning = record?.liveness === "running" && plausibleLivenessTs(record.livenessTs, now);
              } catch {
                // 读盘失败 → 按不忙（fail-open：闸的失败方向是「多唤醒一次」而不是
                // 「丢单/永不唤醒」，观测面故障不得让派单退化成只落邮箱）。
                sessionRunning = false;
              }
            }
            return {
              kind: "created" as const,
              taskId: task.id,
              status: "pending" as const,
              messageId: message.id,
              toSessionId,
              teamResetWarning,
              busy: openTaskIds.length > 0 || sessionRunning,
              openTaskIds,
              sessionRunning,
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
          // v0.10.0（R2/G-28）：**忙闲闸**——收方在途（在途任务/回合在跑）则跳过 spawn、
          // 只落邮箱：成员已有在途回合时再唤醒一路无头回合，同一会话两路并发会互相抢
          // 信箱、重复劳动（今日 17:38/17:44 m8 双路实测，GAP 第十六批）。
          // 邮箱机制保证不丢单（收方下个 prompt 读未读/可 pull），补醒由看门狗侧负责。
          // 收方不忙时本闸不生效——wake 调用、审计、回执三面逐字节不变。
          let sent: WakeReceipt;
          if (prepared.busy) {
            // 无 sid 的忙成员沿用 wake() 助手的同款 note（「没有会话」是比「在途」
            // 更硬的事实，不能因为忙就把这条事实从回执里抹掉）。
            sent = prepared.toSessionId === null
              ? { delivered: "mailbox", note: NO_SESSION_NOTE }
              : { delivered: "mailbox" };
            await logEngineEvent(stateRoot, {
              event: "dispatch-deferred-busy",
              teamId: me.teamId,
              to: toKey,
              taskId: prepared.taskId,
              openTaskIds: prepared.openTaskIds,
              sessionRunning: prepared.sessionRunning,
            });
          } else {
            sent = await wake(toKey, prepared.toSessionId, "dispatch", [prepared.messageId], ticketText(args));
          }
          await logEngineEvent(stateRoot, {
            event: "dispatch",
            teamId: me.teamId,
            taskId: prepared.taskId,
            from: me.agentKey,
            to: toKey,
            delivered: sent.delivered,
            messageId: prepared.messageId,
            // v0.9.7（W3/V096-01）：三态键进审计（与 tools-team 六处回执点同口径）。
            ...(sent.startConfirmed !== undefined ? { startConfirmed: sent.startConfirmed } : {}),
            ...(sent.wakeFailureSeen === true ? { wakeFailureSeen: true } : {}),
          });
          // v0.9.7（W3/V096-01）：人可读行与 payload 都带三态——两轮唤醒全失败时行内写
          // 失败措辞（不再 "dispatched via wake"），payload 给 startConfirmed/wakeTiers/
          // wakeFailureSeen/failureEvidence 四键。
          // v0.10.0（R2）：忙闲闸降级时行内写「成员在途，已落邮箱，回合结束后补醒」+
          // payload 给 deferred{reason:"busy", openTaskIds}（不忙时两键均缺席）。
          const deferred: DispatchDeferredState | undefined = prepared.busy
            ? { reason: "busy", openTaskIds: prepared.openTaskIds }
            : undefined;
          return okResult(renderDispatch(prepared.taskId, toKey, sent.delivered, sent, deferred), {
            taskId: prepared.taskId,
            status: prepared.status,
            delivered: sent.delivered,
            ...(deferred !== undefined ? { deferred } : {}),
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
            ...(prepared.teamResetWarning !== undefined ? { teamResetWarning: prepared.teamResetWarning } : {}),
            ...(sent.wakeLog ? { wakeLog: sent.wakeLog } : {}),
            ...(sent.note ? { note: sent.note } : {}),
            ...(sent.startConfirmed !== undefined ? { startConfirmed: sent.startConfirmed } : {}),
            ...(sent.wakeTiers !== undefined ? { wakeTiers: sent.wakeTiers } : {}),
            ...(sent.wakeFailureSeen === true ? { wakeFailureSeen: true } : {}),
            ...(sent.failureEvidence !== undefined ? { failureEvidence: sent.failureEvidence } : {}),
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

          // v0.10.0（R8）：插队回单的**防风暴闸**（team 锁外——engine.jsonl 尾读是慢
          // I/O；放在证据门之后：被证据门整单拒绝的调用不算一次 urgent 回单，不占额度）。
          //
          // 计数真源 = engine.jsonl 的 report-urgent 审计事件（只数已生效的；降级
          // Attempt 不落该事件、不占额度——否则一次超限会把成员连续锁死 10 分钟）。
          // 读失败 → 0（fail-open，见 countRecentUrgentReports）。
          const urgentRequested = args.urgent === true;
          let urgentHonored = urgentRequested;
          let urgentDowngradedReason: string | undefined;
          if (urgentRequested) {
            const max = urgentReportMaxFromEnv(deps.env);
            const recent = await countRecentUrgentReports(stateRoot, me.agentKey, Date.now());
            if (recent >= max) {
              urgentHonored = false;
              urgentDowngradedReason = `10 分钟内 urgent 回单已达上限 ${max} 次（XC_URGENT_REPORT_MAX 可调）`;
            }
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

            // 回执消息落创建者邮箱（§2.9-1）。
            // v0.10.0（R8）：回执条件从「仅终态」扩为「终态 ∨ 插队回单生效」——中间态
            // （in_progress/blocked）普通回报仍**无回执、不唤醒**（硬回归不变），但
            // urgent 生效时半截也要把重要发现送出去：建一条 urgent 回执（排到创建者
            // 未读最前）+ 一次 urgent 唤醒尝试。用户令的本体。
            let receipt: { to: string; messageId: string } | null = null;
            // v0.10.0（R8 补充）：收方回合进行中 → 不发起唤醒（用户追加裁决，优先于
            // R8 原文「唤醒收方」）。判据锁内现读（与回执帧上的待补醒标记同一次
            // 判定——标记与唤醒决策必须同源，不能「标记说不醒、实际却醒了」）。
            let recipientTurnRunning = false;
            // v0.10.0（R8）：创建者不是 lead 时，lead 邮箱也落一份**不唤醒**的通知
            // （插队信息对主控可见，又不把主控强行拉起——R5 同款纪律）。
            let leadNotified = false;
            // v0.10.0（R8 补充）：lead 通知同样遵守回合进行中闸——进行中的 lead 不被
            // 唤醒（通知本来就不唤醒），消息上打同一个待补醒标记。
            let leadDeferred = false;
            // 收件人（创建者）在花名册上的 sessionId——回合进行中判据与唤醒目标同源。
            const toSessionId = team.members.find((m) => m.key === task.createdBy)?.sessionId ?? null;
            if (TERMINAL_TASK_STATUSES.includes(args.status) || urgentHonored) {
              const to = task.createdBy;
              if (urgentHonored) {
                recipientTurnRunning = await recipientTurnInProgress(stateRoot, to, toSessionId, Date.now());
              }
              const extras: MessageExtras = {
                taskId: task.id,
                sourceTaskId: task.id,
                sourceTaskStatus: args.status,
                deliveryClaimedAt: Date.now(),
                ...(urgentHonored ? { urgent: true } : {}),
              };
              const msg = createMessage(
                me.agentKey,
                to,
                receiptText(
                  task.id,
                  args.attemptId,
                  args.status,
                  task,
                  // v0.10.0（R8 补充）：待补醒标记打在回执帧 content 上（Top-level
                  // 消息字段白名单在 core/types.ts，非本组文件域；content 帧是既有
                  // 机器可读形态，unblock-notice 同款纪律）。
                  recipientTurnRunning ? RECIPIENT_TURN_RUNNING : undefined,
                ),
                extras,
              );
              await appendMailbox(stateRoot, me.teamId, to, msg);
              receipt = { to, messageId: msg.id };
              if (urgentHonored) {
                const leadKey = leadKeyOf(team);
                if (leadKey !== "" && leadKey !== to) {
                  // 通知内容 = 指针 + 半截要点摘录（in_progress 的 result / blocked 的
                  // error，各截 300 字符）——「快速获取重要信息」是 R8 的用户原话，
                  // 只给一句「有人插队了」对主控没有信息量。
                  const excerpt = pickExcerpt(args.result, args.error);
                  const leadSessionId = team.members.find((m) => m.key === leadKey)?.sessionId ?? null;
                  leadDeferred = await recipientTurnInProgress(stateRoot, leadKey, leadSessionId, Date.now());
                  await appendMailbox(
                    stateRoot,
                    me.teamId,
                    leadKey,
                    createMessage(
                      me.agentKey,
                      leadKey,
                      `插队回单（半截报送）：${me.agentKey} 在任务 ${task.id}（${args.status}）中途发出 urgent 回单`
                        + `${excerpt}；创建者 ${to} 已收到回执消息。本条只作通知，未唤醒 lead。`
                        // ③：lead 通知同样打待补醒标记（同一标记词汇，便于单一口径识别）。
                        + (leadDeferred ? ` wakeDeferred:"${RECIPIENT_TURN_RUNNING}"` : ""),
                      { urgent: true },
                    ),
                  );
                  leadNotified = true;
                }
              }
            }
            return {
              taskId: task.id,
              status: args.status,
              reportedAt: Date.now(),
              receipt,
              recipientTurnRunning,
              leadNotified,
              leadDeferred,
              leadKey: leadDeferred ? leadKeyOf(team) : null,
              toSessionId: receipt
                ? (team.members.find((m) => m.key === receipt.to)?.sessionId ?? null)
                : null,
            };
          });

          // 锁外唤醒派发方（§2.9-2）；blocked 保留 attempt、无回执（暂停而非终态）。
          let wakeBack: "wake" | "mailbox" = "mailbox";
          // v0.9.7（W3/V096-01）：回执唤醒的三态键（与 dispatch 面同口径；旧实现丢掉）。
          let wakeReceipt: WakeReceiptState | undefined;
          // v0.10.0（R8 补充）：收方回合进行中 → **不调用 attemptWake**（用户追加裁决：
          // 不得把在跑的主控拉成无头分身）。回执消息已在邮箱（urgent + 待补醒标记），
          // 补醒由看门狗（组 A）在回合结束后做。
          if (out.receipt !== null && !out.recipientTurnRunning) {
            const sent = await wake(
              out.receipt.to,
              out.toSessionId,
              "report",
              [out.receipt.messageId],
              `收到 CrossChat 回执：task ${out.taskId} = ${out.status}`,
              // v0.10.0（R8）：插队回单 → urgent 唤醒尝试（唤醒 prompt 首位 URGENT
              // 横幅；闸不豁免——容量闸/交互会话默认不唤醒照旧挡，挡下时回执明说）。
              urgentHonored,
            );
            wakeBack = sent.delivered;
            wakeReceipt = sent;
          }
          await logEngineEvent(stateRoot, {
            event: "report",
            teamId: me.teamId,
            taskId: out.taskId,
            status: out.status,
            by: me.agentKey,
            attemptId: args.attemptId,
            wakeBack,
            // v0.9.7（W3/V096-01）：三态键进审计（dispatch 面同口径）。
            ...(wakeReceipt?.startConfirmed !== undefined ? { startConfirmed: wakeReceipt.startConfirmed } : {}),
            ...(wakeReceipt?.wakeFailureSeen === true ? { wakeFailureSeen: true } : {}),
            // v0.10.0（R8）：urgent 请求事实进常规 report 事件（honored 与否 + 降级原因）
            // ——降级 Attempt 不落 report-urgent（不占防风暴额度），在此留痕。
            ...(urgentRequested ? { urgent: urgentHonored } : {}),
            ...(urgentDowngradedReason !== undefined
              ? { urgentDowngraded: true, urgentDowngradedReason }
              : {}),
            // v0.10.0（R8 补充）：唤醒被「收方回合进行中」挡下（未发起）——与容量闸的
            // wakeBack=mailbox 同结果不同因，审计面上必须可分辨。
            ...(out.recipientTurnRunning ? { wakeDeferred: RECIPIENT_TURN_RUNNING } : {}),
          });
          // v0.10.0（R8）：插队回单生效 → 专项审计 report-urgent{taskId, from, to, woke}
          // （woke = 本次是否真的发起了唤醒；被闸挡下时 false，原因见 report 事件的
          // wakeBack/note 与人可读行的「已落邮箱、未唤醒」）。
          if (urgentHonored) {
            await logEngineEvent(stateRoot, {
              event: "report-urgent",
              teamId: me.teamId,
              taskId: out.taskId,
              from: me.agentKey,
              to: out.receipt?.to ?? null,
              woke: wakeBack === "wake",
              status: out.status,
              // v0.10.0（R8 补充）：收方回合进行中 → reason 写明，woke=false。
              ...(out.recipientTurnRunning ? { reason: RECIPIENT_TURN_RUNNING } : {}),
              ...(out.leadNotified === true ? { leadNotified: true } : {}),
              ...(out.leadDeferred === true ? { leadDeferred: true } : {}),
              ...(wakeReceipt?.startConfirmed !== undefined ? { startConfirmed: wakeReceipt.startConfirmed } : {}),
            });
            // v0.10.0（R8 补充）：**每个被挡下的唤醒目标**各落一条 report-urgent-deferred
            // （创建者唤醒目标；创建者≠lead 且 lead 回合进行中时，lead 通知目标同样
            // 落一条 to=lead）——看门狗（组 A）按它认「谁欠一次补醒」。
            if (out.recipientTurnRunning) {
              await logEngineEvent(stateRoot, {
                event: "report-urgent-deferred",
                teamId: me.teamId,
                taskId: out.taskId,
                from: me.agentKey,
                to: out.receipt?.to ?? null,
                reason: RECIPIENT_TURN_RUNNING,
                status: out.status,
              });
            }
            if (out.leadDeferred && out.leadKey !== null) {
              await logEngineEvent(stateRoot, {
                event: "report-urgent-deferred",
                teamId: me.teamId,
                taskId: out.taskId,
                from: me.agentKey,
                to: out.leadKey,
                reason: RECIPIENT_TURN_RUNNING,
                status: out.status,
                target: "lead-notice",
              });
            }
          }
          // v0.9.7（W3/V096-01）：人可读行与 payload 都带三态——两轮唤醒全失败时不再写
          // "wake back via wake"（V096-01 实测形态），改写失败措辞 + 邮箱兜底指引。
          // v0.10.0（R8）：插队回单人可读行以【插队回单】开头；被防风暴闸降级时行尾
          // 附降级条款（payload urgentDowngraded/urgentDowngradedReason）；被「收方
          // 回合进行中」闸挡下时明说「已落邮箱、未唤醒：收方回合进行中，回合结束后送达」。
          const urgentState: UrgentReportState | undefined = urgentRequested
            ? {
                honored: urgentHonored,
                ...(urgentDowngradedReason !== undefined ? { downgradedReason: urgentDowngradedReason } : {}),
                ...(out.recipientTurnRunning ? { deferredReason: RECIPIENT_TURN_RUNNING } : {}),
              }
            : undefined;
          return okResult(renderReport(out.taskId, out.status, out.receipt?.to ?? null, wakeBack, wakeReceipt, urgentState), {
            taskId: out.taskId,
            status: out.status,
            reportedAt: out.reportedAt,
            wakeBack,
            ...(urgentHonored ? { urgent: true } : {}),
            ...(urgentDowngradedReason !== undefined
              ? { urgentDowngraded: true, urgentDowngradedReason }
              : {}),
            ...(wakeReceipt?.startConfirmed !== undefined ? { startConfirmed: wakeReceipt.startConfirmed } : {}),
            ...(wakeReceipt?.wakeTiers !== undefined ? { wakeTiers: wakeReceipt.wakeTiers } : {}),
            ...(wakeReceipt?.wakeFailureSeen === true ? { wakeFailureSeen: true } : {}),
            ...(wakeReceipt?.failureEvidence !== undefined ? { failureEvidence: wakeReceipt.failureEvidence } : {}),
            ...(evidence.length > 0
              ? { evidenceSha256: evidence.map((e) => ({ path: e.path, sha256: e.sha256 })) }
              : {}),
          });
        });
      });
    },
  };

  /**
   * 推送唤醒（必须已在团队锁外；M2 决策 wake|mailbox 并 fire-and-forget，§2.5）。
   *
   * v0.9.7（W3/V096-01）：**三态键全量透传**——旧实现只转 delivered/wakeLog/note，
   * 把 WakeResult 的 startConfirmed/wakeTiers/wakeFailureSeen/failureEvidence 结构性
   * 丢掉（adv-1 F-1 实测：两轮唤醒全失败的回执仍写 "dispatched via wake"，且无任何
   * 失败面结构化键）。现在四键随结果原样转交调用方进回执 payload + 人可读行措辞。
   *
   * v0.10.0（R8）：`urgent` 参数——true 时透传 attemptWake 的 urgent 档位（唤醒 prompt
   * 正文首位插 URGENT 横幅）；不改变三态决策（decideDelivery 三重条件对 urgent 不
   * 豁免，与 xc_relay urgent 同口径）。缺省 false = v0.9.9 逐字节不变。
   */
  async function wake(
    toAgentKey: string,
    toSessionId: string | null,
    reason: string,
    receiptIds: readonly string[],
    ticket: string,
    urgent = false,
  ): Promise<WakeReceipt> {
    if (toSessionId === null) {
      return { delivered: "mailbox", note: NO_SESSION_NOTE };
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
      ...(urgent ? { urgent: true } : {}),
    });
    return {
      delivered: res.delivered,
      wakeLog: res.wakeLog,
      note: res.note,
      ...(res.startConfirmed !== undefined ? { startConfirmed: res.startConfirmed } : {}),
      ...(res.wakeTiers !== undefined ? { wakeTiers: res.wakeTiers } : {}),
      ...(res.wakeFailureSeen === true ? { wakeFailureSeen: true } : {}),
      ...(res.failureEvidence !== undefined ? { failureEvidence: res.failureEvidence } : {}),
    };
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
    "Report task progress/completion/failure/blocked with the current attempt token; completion requires result and >=1 evidence (each entry must be a real regular file inside the workspace; the tool computes its sha256 and rejects a carried evidence[].sha256 that does not match - evidence_checksum_mismatch). status=blocked pauses the task keeping the attempt alive and requires a non-blank error as the blocking reason. urgent:true (v0.10.0 R8) sends the receipt as a priority report: the receipt message is urgent (jumps to the front of the recipient's unread), one urgent wake attempt is made on the task creator (when the creator is not the lead, the lead's mailbox also gets a non-waking notice), and the summary line starts with 【插队回单】. The wake is skipped when the recipient's session turn is in progress (urgent reports never pull a running lead into a headless clone): the receipt still lands in the mailbox marked for a post-turn re-wake, and the receipt says so. Anti-storm: at most 5 urgent reports per member per 10 minutes (XC_URGENT_REPORT_MAX overrides); extra ones are downgraded to a plain receipt and say so in the receipt.",
    ReportShape,
    async (args, extra) => taskCore.xc_report(args as unknown as ReportArgs, connectionKeyOf(extra)),
  );
}
