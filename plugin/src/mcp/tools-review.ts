/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T9）：xc_review —— 入站审阅（两轴合一）。
 *
 * 合并 xc_inbound_review（队内 held 队列，原 guards.ts registerSecurityTools 主体）
 * + xc_peer_review（跨会话 hold 队列，peer-services.review）的调用面：
 * - list 合并展示两轴 held 队列，每行标注 axis；两轴消息 id 命名空间不同，
 *   accept/discard 的 ids 按形态自动路由（队内 id=UUID；歧义时按 axis 参数裁决）。
 * - hold 的默认态不变：DEFAULT_INBOUND_MODE='accept'（core/policy.ts）——审阅面
 *   保留但日常路径不出现（方案 §1-A 行 7；入站三态实现与配置完整保留）。
 * - 权限纪律不变：审阅的是**本连接身份自己**的 held 队列（无跨人审阅面）。
 */

import { z } from "zod";
import { okResult, ToolError, type ToolResult } from "./protocol.js";
import { identityStore } from "./identity.js";
import { errorResult, mapToolError } from "./protocol.js";
import { LockBusyError, withTeamLock } from "../core/lock.js";
import { logEngineEvent } from "../core/log.js";
import { acceptHeldMessages, discardHeldMessages, readHeldMessages } from "../core/policy.js";
import { renderReviewSummary } from "./peer-services.js";
import { getPeerServices } from "./peer-services.js";
import type { ToolDeps } from "./core.js";
import { runCore } from "./core.js";
import type { TeamMessage } from "../core/types.js";

// ---------------------------------------------------------------------------
// zod 入参 schema（§1.2 T9）
// ---------------------------------------------------------------------------

export const ReviewShape = {
  action: z.enum(["list", "accept", "discard"]).optional().describe("缺省 list"),
  axis: z.enum(["team", "peer", "all"]).optional().describe("缺省 all：两轴隔离件一起列出"),
  ids: z.array(z.string()).optional().describe("accept/discard 的消息 id；缺省全部"),
} as const;

export type ReviewArgs = { action?: "list" | "accept" | "discard"; axis?: "team" | "peer" | "all"; ids?: string[] };

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

/** xc_review 主处理器（注册器由 registerReviewTools 挂进 server + dispatcher）。 */
export async function handleReview(deps: ToolDeps, args: ReviewArgs, connectionKey: string): Promise<ToolResult> {
  const action = args.action ?? "list";
  const axis = args.axis ?? "all";
  const services = getPeerServices(deps);
  // 身份闸（§2.8）：审阅的是**本连接身份自己**的 held 队列——未注册连接一律
  // not_registered（与旧 xc_inbound_review 契约一致；peer 轴 services.review
  // 内部同样要求已注册）。
  const me = identityStore.require(connectionKey);

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
        // 兼容键（旧 xc_inbound_review 的 list 形状：count + messages）。
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
      // 不算失败（旧 xc_inbound_review 只碰队内轴，accept/discard 语义不回退）。
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
      // 兼容键（旧 xc_inbound_review 的 accept/discard 形状：count + messages）。
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
    "Review this session's inbound-held messages on both axes (replaces xc_inbound_review + xc_peer_review). " +
    "list (default) shows the team held queue and the peer hold quarantine with axis tags; accept/discard route ids by shape (pass axis to disambiguate). " +
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
