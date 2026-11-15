/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T9）：xc_review —— 入站审阅（两轴合一）。
 *
 * 合并队内 held 队列审阅（原 guards.ts 死码注册器主体）
 * + 跨会话 hold 队列审阅（peer-services.review）的调用面：
 * - list 合并展示两轴 held 队列，每行标注 axis；两轴消息 id 命名空间不同，
 *   accept/discard 的 ids 按形态自动路由（队内 id=UUID；歧义时按 axis 参数裁决）。
 * - hold 的默认态不变：DEFAULT_INBOUND_MODE='accept'（core/policy.ts）——审阅面
 *   保留但日常路径不出现（方案 §1-A 行 7；入站三态实现与配置完整保留）。
 * - 权限纪律不变：审阅的是**本连接身份自己**的 held 队列（无跨人审阅面）。
 *
 * v0.7 C7（DESIGN-V0.7 §3.2，M3）：审批入口并入本工具（不新增工具——工具面维持
 * 恰 10）：
 * - `action:"approve"|"deny"` + `axis:"approval"` + `id:<requestId>`：对 tool_request
 *   台账的批准/拒绝。**approve 仅限现任 lead**（not_lead 闸；lead 恰为请求双方时
 *   走文件轨——自批闸）；deny 不设 lead 门（拒绝无放行效力，任何成员可代拒）。
 * - 落地 = 写同一格式审批文件（core/toolapproval.ts）+ 台账迁移 + 审计 +
 *   向请求方回投 approval_result 通知帧（授权效力在审批文件里，帧只做回执）。
 * - `list axis:"approval"`：待批清单（台账 pending 且无审批文件的请求）。
 */

import { z } from "zod";
import { invalidParamsError, okResult, ToolError, type ToolResult } from "./protocol.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { errorResult, mapToolError } from "./protocol.js";
import { LockBusyError, withTeamLock } from "../core/lock.js";
import { logEngineEvent } from "../core/log.js";
import { acceptHeldMessages, discardHeldMessages, readHeldMessages } from "../core/policy.js";
import { appendMailbox, createMessage } from "../core/mailbox.js";
import { leadKeyOf, readTeam } from "../core/teamstate.js";
import { approvalsFile } from "../core/paths.js";
import { listPendingToolRequests, readToolRequest, updateToolRequest } from "../core/toolledger.js";
import {
  approvalFileExists,
  buildApprovalFile,
  writeApprovalFile,
} from "../core/toolapproval.js";
import { buildApprovalResult } from "../core/toolrelay.js";
import { renderReviewSummary } from "./peer-services.js";
import { getPeerServices } from "./peer-services.js";
import type { ToolDeps } from "./core.js";
import { runCore } from "./core.js";
import type { TeamMessage } from "../core/types.js";

// ---------------------------------------------------------------------------
// zod 入参 schema（§1.2 T9 + v0.7 C7 §3.2 审批增量）
// ---------------------------------------------------------------------------

export const ReviewShape = {
  action: z.enum(["list", "accept", "discard", "approve", "deny"]).optional().describe("缺省 list；approve/deny 仅对 axis:\"approval\" 的转办请求生效"),
  axis: z.enum(["team", "peer", "approval", "all"]).optional().describe("缺省 all：两轴隔离件一起列出；approval=转办待批清单"),
  ids: z.array(z.string()).optional().describe("accept/discard 的消息 id；缺省全部"),
  id: z.string().optional().describe("approve/deny：tool_request 的 requestId"),
  ttlMs: z.number().int().positive().optional().describe("仅 action=approve：批准窗（缺省=请求剩余 ttl；钳制 ≤ 请求窗）"),
  note: z.string().max(512).optional().describe("approve/deny 的批注（进审批文件与审计）"),
} as const;

export type ReviewArgs = {
  action?: "list" | "accept" | "discard" | "approve" | "deny";
  axis?: "team" | "peer" | "approval" | "all";
  ids?: string[];
  id?: string;
  ttlMs?: number;
  note?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ids → 两轴路由（队内 id 与 peer msgId 同为 UUID；axis 显式时以其裁决）。 */
function routeIds(args: ReviewArgs, teamIds: readonly string[], peerIds: readonly string[]): { teamIds: string[]; peerIds: string[] } {
  if (args.axis === "team") return { teamIds: args.ids ?? [...teamIds], peerIds: [] };
  if (args.axis === "peer") return { teamIds: [], peerIds: args.ids ?? [...peerIds] };
  if (args.ids === undefined) return { teamIds: [...teamIds], peerIds: [...peerIds] };
  const teamSet = new Set(teamIds);
  const peerSet = new Set(peerIds);
  const out = { teamIds: [] as string[], peerIds: [] as string[] };
  for (const id of args.ids) {
    // 自动路由：两轴集合各自的成员直接归轴；同 id 双轴在场且未给 axis → 歧义报错。
    const inTeam = teamSet.has(id);
    const inPeer = peerSet.has(id);
    if (inTeam && inPeer) {
      throw new ToolError({
        error: "ambiguous_id",
        id,
        message: `id "${id}" exists on both axes; pass axis:"team"|"peer" to disambiguate`,
      });
    }
    if (inTeam) out.teamIds.push(id);
    else if (inPeer) out.peerIds.push(id);
    else {
      // 不在任何轴的集合里：按形态猜测（UUID → 队内），由对应轴的 unknown-id 错误兜底。
      if (UUID_RE.test(id)) out.teamIds.push(id);
      else out.peerIds.push(id);
    }
  }
  return out;
}

/**
 * v0.7 C7（DESIGN-V0.7 §3.2）：审批轨执行体——approve/deny。
 *
 * approve：**仅现任 lead**（not_lead 闸，与 tools-team.ts 建员闸同口径；无 lead 时
 * 同拒并指引「先立 lead 或走文件轨」）；自批闸（lead 恰为 from/to 仍拒，§2.3——
 * 此时只能走文件轨）；批准窗缺省=请求剩余 ttl 且钳制 ≤ 请求窗。落地 = 写审批文件
 * （core/toolapproval.ts 同格式）+ 台账 approved + 审计 tool-approval + 向请求方
 * 回投 approval_result 通知帧（帧只做回执，授权效力在审批文件里）。
 *
 * deny：不设 lead 门（拒绝无放行效力，任何成员可代拒；审计留痕）。
 *
 * 状态迁移口径（§3.1 同一套枚举）：approve 可从 pending/refused/denied/approved
 * 转入（后者写者胜，§10.3-4）；deny 从 pending/approved/refused 转入；终态
 * （executed/error/expired）不被审批动作改写（请求已有结果或已过期）。
 */
async function handleApprovalDecision(
  deps: ToolDeps,
  me: BoundIdentity,
  args: ReviewArgs,
  action: "approve" | "deny",
): Promise<ToolResult> {
  const { stateRoot } = deps;
  const requestId = args.id;
  if (requestId === undefined || requestId === "") {
    throw invalidParamsError(`action "${action}" requires "id" (the tool_request requestId)`);
  }
  const now = Date.now();
  const ledger = await readToolRequest(stateRoot, requestId);
  if (ledger === undefined) {
    throw new ToolError({
      error: "tool_request_not_found",
      requestId,
      message: `no tool_request ledger for "${requestId}" — the request may have expired and been cleaned up`,
    });
  }

  if (action === "approve") {
    // lead 闸（§3.2）。
    const team = await readTeam(stateRoot, me.teamId);
    const leadKey = team !== undefined ? leadKeyOf(team) : null;
    if (leadKey === null || leadKey === "" || leadKey !== me.agentKey) {
      throw new ToolError({
        error: "not_lead",
        leadKey,
        message: `only the current team lead can approve tool-transfer requests (lead=${leadKey ?? "none"}); `
          + 'ask the lead to run xc_review({action:"approve", axis:"approval", id:"' + requestId + '"}), '
          + "or write the approval file yourself (file track: .crosschat/approvals/" + requestId + ".json)",
      });
    }
    // 自批闸（§2.3/§3.2）：lead 恰为请求双方时仍拒——只能走文件轨（用户落盘）。
    if (me.agentKey === ledger.from || me.agentKey === ledger.to) {
      throw new ToolError({
        error: "self-approval refused",
        requestId,
        message: `you are the requester ("${ledger.from}") or the executor ("${ledger.to}") of this request; `
          + "an approval must come from the user or a third party (write the approval file directly)",
      });
    }
    const remaining = ledger.expiresAt - now;
    if (remaining <= 0) {
      throw new ToolError({
        error: "approval_window_closed",
        requestId,
        expiresAt: ledger.expiresAt,
        message: `request "${requestId}" already expired at ${new Date(ledger.expiresAt).toISOString()}; `
          + "ask the requester to send a fresh request",
      });
    }
    const requestedTtl = args.ttlMs;
    const ttlMs = requestedTtl === undefined ? remaining : Math.min(requestedTtl, remaining);
    const clamped = requestedTtl !== undefined && requestedTtl > remaining;
    const expiresAt = now + ttlMs;
    const approval = buildApprovalFile({
      requestId,
      decision: "approved",
      approvedBy: me.agentKey,
      decidedAt: now,
      expiresAt,
      tool: ledger.tool,
      ...(args.note !== undefined ? { note: args.note } : {}),
    });
    const file = await writeApprovalFile(stateRoot, approval, ledger.approvalFile);
    const next = await updateToolRequest(stateRoot, requestId, (l) =>
      l.state === "pending" || l.state === "refused" || l.state === "denied" || l.state === "approved"
        ? { ...l, state: "approved", decidedAt: now, decidedBy: me.agentKey, decisionReason: args.note ?? "approved via xc_review" }
        : undefined,
    );
    const receiptFrame = buildApprovalResult(requestId, "approved", me.agentKey, now, expiresAt);
    const receipt = createMessage("engine", ledger.from, JSON.stringify(receiptFrame), { deliveryClaimedAt: now });
    await appendMailbox(stateRoot, me.teamId, ledger.from, receipt);
    await logEngineEvent(stateRoot, {
      event: "tool-approval",
      teamId: me.teamId,
      requestId,
      decision: "approved",
      approvedBy: me.agentKey,
      from: ledger.from,
      to: ledger.to,
      tool: ledger.tool,
      expiresAt,
      approvalFile: file,
      ledgerState: next?.state ?? ledger.state,
      receiptMessageId: receipt.id,
      ...(clamped ? { approvalWindowClamped: true } : {}),
    });
    return okResult(
      `Tool-transfer request ${requestId} approved by lead "${me.agentKey}" (window ${ttlMs}ms until ${new Date(expiresAt).toISOString()}); `
        + `an approval_result receipt was sent to "${ledger.from}".`,
      {
        action,
        axis: "approval",
        requestId,
        decision: "approved",
        approvedBy: me.agentKey,
        expiresAt,
        approvalFile: file,
        ledgerState: next?.state ?? ledger.state,
        receiptMessageId: receipt.id,
        ...(clamped ? { approvalWindowClamped: true, requestedTtlMs: requestedTtl, requestRemainingMs: remaining } : {}),
      },
    );
  }

  // deny：无 lead 门（§3.2）。
  const approval = buildApprovalFile({
    requestId,
    decision: "denied",
    approvedBy: me.agentKey,
    decidedAt: now,
    expiresAt: now,
    tool: ledger.tool,
    ...(args.note !== undefined ? { note: args.note } : {}),
  });
  const file = await writeApprovalFile(stateRoot, approval, ledger.approvalFile);
  const next = await updateToolRequest(stateRoot, requestId, (l) =>
    l.state === "pending" || l.state === "approved" || l.state === "refused"
      ? { ...l, state: "denied", decidedAt: now, decidedBy: me.agentKey, decisionReason: args.note ?? "denied via xc_review" }
      : undefined,
  );
  const receiptFrame = buildApprovalResult(requestId, "denied", me.agentKey, now);
  const receipt = createMessage("engine", ledger.from, JSON.stringify(receiptFrame), { deliveryClaimedAt: now });
  await appendMailbox(stateRoot, me.teamId, ledger.from, receipt);
  await logEngineEvent(stateRoot, {
    event: "tool-approval",
    teamId: me.teamId,
    requestId,
    decision: "denied",
    approvedBy: me.agentKey,
    from: ledger.from,
    to: ledger.to,
    tool: ledger.tool,
    approvalFile: file,
    ledgerState: next?.state ?? ledger.state,
    receiptMessageId: receipt.id,
  });
  return okResult(
    `Tool-transfer request ${requestId} denied by "${me.agentKey}"; an approval_result receipt was sent to "${ledger.from}".`,
    {
      action,
      axis: "approval",
      requestId,
      decision: "denied",
      approvedBy: me.agentKey,
      approvalFile: file,
      ledgerState: next?.state ?? ledger.state,
      receiptMessageId: receipt.id,
    },
  );
}

/** v0.7 C7（§3.2）：axis:"approval" 待批清单——台账 pending 且无审批文件的请求。
 *  身份闸已由 handleReview 的 identityStore.require 承担（本清单不跨人）。 */
async function listApprovalQueue(deps: ToolDeps): Promise<ToolResult> {
  const now = Date.now();
  const rows: Array<Record<string, unknown>> = [];
  for (const l of await listPendingToolRequests(deps.stateRoot)) {
    if (await approvalFileExists(deps.stateRoot, l.requestId, l.approvalFile)) continue;
    rows.push({
      requestId: l.requestId,
      from: l.from,
      to: l.to,
      tool: l.tool,
      reason: l.reason,
      createdAt: l.createdAt,
      expiresAt: l.expiresAt,
      remainingTtlMs: Math.max(0, l.expiresAt - now),
      approveHow:
        'xc_review({action:"approve", axis:"approval", id:"' + l.requestId + '"}) (lead only), '
        + "or write the approval file " + approvalsFile(deps.stateRoot, l.requestId),
    });
  }
  rows.sort((a, b) => (a["createdAt"] as number) - (b["createdAt"] as number));
  const lines = rows.map((r) =>
    `- ${r["requestId"]} from ${r["from"]} → ${r["to"]} tool=${r["tool"]} 剩余 ${Math.round((r["remainingTtlMs"] as number) / 1000)}s：${r["reason"]}`,
  );
  return okResult(
    rows.length === 0
      ? "没有待批准的转办请求（tool_request ledger pending 且无审批文件）。"
      : `转办待批清单（${rows.length} 条）：\n${lines.join("\n")}`,
    { action: "list", axis: "approval", count: rows.length, rows },
  );
}

/** xc_review 主处理器（注册器由 registerReviewTools 挂进 server + dispatcher）。 */
export async function handleReview(deps: ToolDeps, args: ReviewArgs, connectionKey: string): Promise<ToolResult> {
  const action = args.action ?? "list";
  const axis = args.axis ?? "all";
  const services = getPeerServices(deps);
  // 身份闸（§2.8）：审阅的是**本连接身份自己**的 held 队列——未注册连接一律
  // not_registered（与旧入站审阅契约一致；peer 轴 services.review
  // 内部同样要求已注册）。审批面的 lead 闸是 v0.7 新增的唯一角色约束（§3.2）。
  const me = identityStore.require(connectionKey);

  // v0.7 C7（§3.2）：审批轨——approve/deny 与 axis:"approval" 待批清单。
  if (action === "approve" || action === "deny") {
    return await handleApprovalDecision(deps, me, args, action);
  }
  if (axis === "approval") {
    // axis:"approval" 只服务 list（待批清单）与 approve/deny（上面已分支）——
    // accept/discard 走错轴显式报错，不静默按空队列执行。
    if (action !== "list") {
      throw invalidParamsError(`axis:"approval" only supports action:"list"|"approve"|"deny" (got ${JSON.stringify(action)})`);
    }
    return await listApprovalQueue(deps);
  }

  // 两轴 held 清单（list/路由都需要）。
  let teamHeld: TeamMessage[] = [];
  let teamError: { error: string; message: string } | undefined;
  if (axis === "all" || axis === "team") {
    try {
      teamHeld = await readHeldMessages(deps.stateRoot, me.teamId, me.agentKey);
    } catch (err) {
      teamError = { error: "team_review_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }
  let peerView: Awaited<ReturnType<typeof services.review>> | undefined;
  let peerError: { error: string; message: string } | undefined;
  if (axis === "all" || axis === "peer") {
    try {
      peerView = await services.review({ action: "list" });
    } catch (err) {
      // peer 轴未注册（同连接只注册了队内轴）→ not_registered：正常态，
      // 队内侧照常给出（两轴存储独立）。
      peerError = {
        error: err instanceof ToolError ? String((err as ToolError).payload["error"] ?? "peer_review_failed") : "peer_review_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (action === "list") {
    const teamRows = teamHeld.map((m) => ({ axis: "team" as const, msgId: m.id, from: m.from, ts: m.ts }));
    const peerRows = (peerView?.held ?? []).map((h) => ({ axis: "peer" as const, msgId: h.msgId, from: h.from, ts: h.ts }));
    const rows = [...teamRows, ...peerRows];
    const lines = rows.length === 0
      ? []
      : rows.map((r) => `- [${r.axis}] ${r.msgId} from ${r.from}${r.ts !== undefined ? ` @ ${new Date(r.ts).toISOString()}` : ""}`);
    const corruptedNote = (peerView?.corrupted?.length ?? 0) > 0
      ? `；⚠ peer 暂存区 ${peerView!.corrupted!.length} 条损坏（structured.corrupted）`
      : "";
    return okResult(
      `Held inbox: ${teamHeld.length} team message(s), ${peerView?.held.length ?? 0} peer message(s) awaiting review.${corruptedNote}`,
      {
        action,
        axis,
        count: rows.length,
        rows,
        // 兼容键（旧入站审阅的 list 形状：count + messages）。
        messages: rows,
        team: { count: teamHeld.length, messages: teamHeld },
        peer: peerView !== undefined ? { held: peerView.held, ...(peerView.corrupted !== undefined ? { corrupted: peerView.corrupted } : {}) } : undefined,
        ...(peerError !== undefined ? { peerError } : {}),
        ...(teamError !== undefined ? { teamError } : {}),
      },
    );
  }

  // accept/discard：ids 路由到两轴分别执行；摘要行按各轴结果如实合并。
  const routed = routeIds(
    { ...args, ids: args.ids },
    teamHeld.map((m) => m.id),
    (peerView?.held ?? []).map((h) => h.msgId),
  );
  let teamResult: { action: string; count: number; messages: TeamMessage[] } | undefined;
  let teamActionResult: ToolResult | undefined;
  if (axis === "team" || args.ids === undefined || routed.teamIds.length > 0) {
    try {
      const moved = await withTeamLock(deps.stateRoot, me.teamId, async () =>
        action === "accept"
          ? acceptHeldMessages(deps.stateRoot, me.teamId, me.agentKey, routed.teamIds, Date.now())
          : discardHeldMessages(deps.stateRoot, me.teamId, me.agentKey, routed.teamIds),
      );
      await logEngineEvent(deps.stateRoot, {
        event: "inbound-review",
        teamId: me.teamId,
        agentKey: me.agentKey,
        action,
        count: moved.length,
      });
      teamResult = { action, count: moved.length, messages: moved as TeamMessage[] };
    } catch (err) {
      teamError = { error: err instanceof LockBusyError ? "busy" : "team_review_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }
  let peerActionResult: Awaited<ReturnType<typeof services.review>> | undefined;
  if (axis === "peer" || args.ids === undefined || routed.peerIds.length > 0) {
    try {
      peerActionResult = await services.review({
        action,
        ...(args.ids !== undefined ? { ids: routed.peerIds } : {}),
      });
    } catch (err) {
      const code = err instanceof ToolError ? String((err as ToolError).payload["error"] ?? "peer_review_failed") : "peer_review_failed";
      // peer 轴未注册 = 信息性跳过（本连接只注册了队内轴；两轴存储独立）——
      // 不算失败（旧入站审阅只碰队内轴，accept/discard 语义不回退）。
      peerError = code === "not_registered"
        ? { error: code, message: "peer axis not registered on this connection; skipped" }
        : { error: code, message: err instanceof Error ? err.message : String(err) };
    }
  }

  const teamMovedCount = teamResult?.count ?? 0;
  const peerSummary = peerActionResult !== undefined ? renderReviewSummary(peerActionResult) : "peer 轴不可用";
  const failNotes: string[] = [];
  if (teamError !== undefined) failNotes.push(`team 轴失败：${teamError.error}（${teamError.message}）`);
  if (peerError !== undefined && peerError.error !== "not_registered") {
    failNotes.push(`peer 轴失败：${peerError.error}（${peerError.message}）`);
  }
  if (failNotes.length > 0) {
    return errorResult({ error: "review_partial_failure", team: teamResult, peer: peerActionResult, failures: failNotes });
  }
  return okResult(
    `Held inbox: ${teamMovedCount} team message(s) ${action === "accept" ? "accepted into your mailbox" : "discarded"}; peer axis: ${peerSummary}`,
    {
      action,
      axis,
      // 兼容键（旧入站审阅的 accept/discard 形状：count + messages）。
      count: teamMovedCount,
      messages: teamResult?.messages ?? [],
      team: teamResult ?? { action, count: 0, messages: [] },
      peer: peerActionResult,
    },
  );
}

/** 兼容出口：runCore 错误映射（旧 guards.test 直接驱动的同款口径）。 */
export function mapReviewError(err: unknown): ToolResult {
  if (err instanceof LockBusyError) return errorResult(err.toStructured());
  return mapToolError(err);
}

void runCore;


// ---------------------------------------------------------------------------
// SDK 接线（FamilyRegistrar 形态；server.ts 持有 PrimaryRegistry）
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCore } from "./core.js";
import type { ToolDeps as _TD, PrimaryRegistry } from "./core.js";
import { connectionKeyOf } from "./identity.js";

/** 注册 xc_review（入站审阅两轴合一；hold 是可选配置，日常路径不出现）。 */
export function registerReviewTools(
  server: McpServer,
  deps: _TD,
  _core: ToolCore,
  registry: PrimaryRegistry,
): void {
  const description =
    "Review this session's inbound-held messages on both axes (team axis and peer axis in one surface). " +
    "list (default) shows the team held queue and the peer hold quarantine with axis tags; accept/discard route ids by shape (pass axis to disambiguate). " +
    'v0.7 approval track (C7): axis:"approval" lists pending tool-transfer requests awaiting authorization; ' +
    'action:"approve"|"deny" with id:<requestId> writes the approval file (lead only for approve; anyone may deny) and receipts the requester. ' +
    "Hold is an optional configuration (XC_INBOUND_MODE / XC_CROSSCHAT_INBOUND) - the default mode is accept, so this surface stays out of the daily path.";
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> => {
    // 与旧 registerSecurityTools 同口径：handler 边界永不抛出（ToolError/LockBusy
    // 一律映射为 isError 信封——guards.test 的未注册断言依赖此契约）。
    try {
      return await handleReview(deps, args as unknown as ReviewArgs, connectionKeyOf(extra));
    } catch (err) {
      return mapReviewError(err);
    }
  };
  server.tool("xc_review", description, ReviewShape, handler);
  registry.set("xc_review", { description, shape: ReviewShape, handler });
}
