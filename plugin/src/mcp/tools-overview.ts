/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T7）：xc_overview —— 全景观测（+容量/停滞挂载点）。
 *
 * 合并 xc_status / xc_peers / xc_agents 的调用面：
 * - view 缺省/"team" ≈ xc_status（core.xc_status 平移实现；teamId 参数随合并移除
 *   ——多团队从未启用，v0.1 遗留死参；snapshot.json 落盘、boardTruncated 分页指针
 *   全部保留）。任务板按 sortTasksForBoard（C2：priority → createdAt）排序呈现。
 * - view "peers" ≈ xc_peers（行格式与 rowsTruncated 分页原样；旧 kind 过滤参数
 *   不保留——一次列全三类，按行首 [self]/[member]/[session] 标记自行辨识）。
 * - view "panel" ≈ xc_agents（self+peers+members+tasks+入站策略）。
 * - 停滞挂载（C5，M5 core/stall.ts）：team/panel 附 stalled[]（XC_STALL_MINUTES，
 *   缺省 120min，小于 stale 阈值时钳制 + WARNING）；容量挂载（C3，M6）由
 *   core/capacity.ts 落位后在此追加 capacity 块（挂载点：overviewPayloadExtras）。
 * - 无需注册即可调用（只读纪律，SKILL §1 保留）。
 */

import { z } from "zod";
import { invalidParamsError, okResult, ToolError, type ToolResult } from "./protocol.js";
import {
  renderBoardTruncationNote,
  renderStatusTable,
  renderRegister as _unusedRenderRegister,
  statusTaskRowText,
  writeSnapshot,
  STATUS_TASK_TABLE_HEADER,
  BOARD_TRUNCATION_NOTE_MAX_CHARS,
  type StatusSnapshot,
} from "./render.js";
import { identityStore } from "./identity.js";
import { isValidTeamId } from "../core/paths.js";
import { readTeam } from "../core/teamstate.js";
import { sortTasksForBoard } from "../core/teamstate.js";
import { orphanTaskIds, readMailbox, staleCompletedReceiptTaskIds } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { receiverInjectBudget, contextCharsFromEnv, batchWindowCount, truncateField } from "../core/budget.js";
import { sha256Of } from "../core/msgstore.js";
import { lastTeamRecoveryNotice, teamRecoveryWarning } from "../core/teamstate.js";
import { stalledTasks, stallThresholdMs, stallSuggestion, type StallFlag } from "../core/stall.js";
import { staleThresholdMsFromEnv } from "./task-edges.js";
import { getPeerServices } from "./peer-services.js";
import { leadKeyOf } from "./tools-team.js";
import {
  capacityCacheFile,
  formatCapacityLines,
  judgeCapacity,
  sampleCapacity,
  type CapacitySample,
  type CapacityVerdict,
} from "../core/capacity.js";
import type { ToolDeps } from "./core.js";
import { runCore } from "./core.js";

const _unused = _unusedRenderRegister;
void _unused;
void invalidParamsError;

// ---------------------------------------------------------------------------
// C3 容量挂载（M6）：惰性采样 + 判定（DESIGN-V0.6.md §3.3）。
// 只在 overview 调用时采样（无定时器）；采样/判定任何意外都降级为「不挂载」——
// 观测面永不为难任务板（安全底线：不崩）。
// ---------------------------------------------------------------------------

interface CapacityMount {
  payload: Record<string, unknown>;
  lines: string[];
}

async function capacityMount(deps: ToolDeps): Promise<CapacityMount | null> {
  let sample: CapacitySample;
  let verdict: CapacityVerdict;
  try {
    sample = await sampleCapacity(deps.env, capacityCacheFile(deps.stateRoot), Date.now());
    verdict = judgeCapacity(sample, deps.env);
  } catch {
    return null;
  }
  return {
    payload: {
      capacity: {
        sampledAt: sample.sampledAt,
        totalBytes: sample.totalBytes,
        freeBytes: sample.freeBytes,
        watermark: sample.watermark,
        steadyTreeBytes: sample.steadyTreeBytes,
        headlessTurnCount: sample.headlessTurnCount,
        headlessTurnMaxRssBytes: sample.headlessTurnMaxRssBytes,
        degraded: sample.degraded,
        ...(sample.categoryCounts !== undefined ? { categoryCounts: sample.categoryCounts } : {}),
        red: verdict.red,
        violated: verdict.violated,
        detail: verdict.detail,
      },
    },
    lines: formatCapacityLines(sample, verdict),
  };
}

// ---------------------------------------------------------------------------
// zod 入参 schema（§1.2 T7）
// ---------------------------------------------------------------------------

export const OverviewShape = {
  view: z.enum(["team", "peers", "panel"]).optional().describe("缺省 team：任务板+成员+未读；peers：本机可寻址 peer 清单；panel：self+peers+members+tasks+入站策略+容量+停滞"),
  history: z.boolean().optional().describe("附 lead 角色变更史（R-7）"),
  offset: z.number().int().min(0).optional().describe("任务板/清单分页起点"),
} as const;

export type OverviewArgs = { view?: "team" | "peers" | "panel"; history?: boolean; offset?: number };

export interface TeamOverviewCore {
  /** 队内全景（原 xc_status 核心 1:1 平移；teamId 死参移除；板面按优先级排序）。 */
  xc_status(args: { history?: boolean; offset?: number }, connectionKey: string): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// core.xc_status（原 tools.ts 平移；差异：teamId 移除 + 板面 priority 排序 + stalled 挂载）
// ---------------------------------------------------------------------------

export function createTeamOverviewCore(deps: ToolDeps): TeamOverviewCore {
  const { stateRoot } = deps;
  return {
    async xc_status(args, connectionKey) {
      return runCore(stateRoot, async () => {
        const teamId = "default"; // v1 单队固定 default（v0.6：teamId 调用面参数移除）
        const me = identityStore.get(connectionKey); // 豁免注册（§2.8）：未注册省略个人字段
        const team = await readTeam(stateRoot, teamId);
        const now = Date.now();
        // v0.5（R-23）：任务 result/error 观测面截断（磁盘真源 team.json 不动，xc_read scope:"task" 拉全文）。
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
          // v0.6（C2）：板面按 sortTasksForBoard（priority → createdAt，stable）排序呈现。
          tasks: sortTasksForBoard(team?.tasks ?? []).map((t) => {
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
          // 读路径无锁（§2.7-5）：孤儿引用 + 回执矛盾检测（故障注-1/2 修复口径不变）。
          const orphanTasks: Record<string, string[]> = {};
          const staleReceipts: Record<string, string[]> = {};
          for (const m of team.members) {
            const msgs = await readMailbox(stateRoot, teamId, m.key);
            snapshot.unread[m.key] = countUnreadFor(team, msgs);
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
        const recoveryNotice = lastTeamRecoveryNotice(stateRoot, teamId);
        if (recoveryNotice !== undefined) {
          snapshot.stateRecovery = {
            at: recoveryNotice.at,
            defect: recoveryNotice.defect,
            backup: recoveryNotice.backup,
            rolledBackTaskIds: recoveryNotice.rolledBackTaskIds,
          };
        }

        // 快照落盘仅限**已存在**的团队（v0.5.3 A2 修复口径不变）。
        if (team !== undefined) {
          await writeSnapshot(stateRoot, teamId, snapshot);
        }
        const orphanTasks = snapshot.orphanTasks;
        const staleCompletedReceipts = snapshot.staleCompletedReceipts;

        // v0.5.2（SCALE-1 修复）：板面接入注入预算（窗口 + boardTruncated 指针）。
        const allTasks = snapshot.tasks;
        const boardOffset = Math.max(0, Math.trunc(args.offset ?? 0));
        const page = allTasks.slice(boardOffset);
        const historyEntries = args.history === true && team !== undefined ? (team.leadHistory ?? []) : [];
        const historyCosts = historyEntries.map((entry) => JSON.stringify(entry).length + 2);
        const fixedChars =
          renderStatusTable({ ...snapshot, tasks: [], ...(allTasks.length > 0 ? { boardTotal: allTasks.length } : {}) }).length
          + STATUS_TASK_TABLE_HEADER.length
          + JSON.stringify({ ...snapshot, tasks: [] }).length
          + BOARD_TRUNCATION_NOTE_MAX_CHARS;
        const nonTaskBudget = Math.max(0, budget.total - fixedChars);
        const historyShown = args.history === true
          ? batchWindowCount(historyCosts, nonTaskBudget)
          : 0;
        const historySpent = historyCosts.slice(0, historyShown).reduce((sum, cost) => sum + cost, 0);
        const boardCosts = page.map((t) => statusTaskRowText(t).length + JSON.stringify(t).length);
        const boardShown = batchWindowCount(boardCosts, Math.max(0, nonTaskBudget - historySpent));
        const windowedTasks = page.slice(0, boardShown);
        const historyTruncated = historyShown < historyEntries.length;
        const boardTruncated = boardOffset + boardShown < allTasks.length;

        // v0.6（C5）：停滞挂载（team 视图；blocked 超阈以 blocked-long 单列）。
        const stalled = team !== undefined
          ? stalledTasks(team.tasks, now, stallThresholdMs(deps.env, staleThresholdMsFromEnv(deps.env)).ms)
          : [];
        const stallClamped = team !== undefined
          ? stallThresholdMs(deps.env, staleThresholdMsFromEnv(deps.env)).clamped
          : false;

        await logEngineEvent(stateRoot, {
          event: "status",
          teamId,
          agentKey: me?.agentKey ?? null,
          tasks: snapshot.tasks.length,
          ...(orphanTasks !== undefined ? { orphanAgents: Object.keys(orphanTasks).length } : {}),
          ...(boardTruncated ? { boardShown: boardShown, boardOffset: boardOffset, boardBudgetChars: budget.total } : {}),
          ...(stalled.length > 0 ? { stalled: stalled.length } : {}),
        });

        // C3 挂载（M6）：容量采样在 payload 组装前做；采样失败只丢观测块，任务板不受影响。
        const capacity = await capacityMount(deps);
        const rollbackWarnings: string[] = [];
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
          // C5 挂载点：stalled / 建议行 / 阈值钳制 WARNING。
          ...(stalled.length > 0 || stallClamped
            ? {
                stalled: stalled.map((flag) => ({ ...flag, suggestion: stallSuggestion(flag.kind, flag.status) })),
                ...(stallClamped ? { stalledThresholdClamped: true } : {}),
              }
            : {}),
          // C3 挂载（M6）：capacity 块（采样失败则不挂载，任务板不受影响）。
          ...(capacity !== null ? capacity.payload : {}),
        };
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
        if (stallClamped) {
          rollbackWarnings.push(
            "WARNING XC_STALL_MINUTES 低于僵尸清扫阈值（XC_STALE_TASK_MINUTES）——stall 阈值已按 stale 阈值钳制（无在途唤醒的死任务会先被清扫回池，stall 面轮不到展示）",
          );
        }
        const text = renderStatusTable({
          ...snapshot,
          tasks: windowedTasks,
          ...(windowedTasks.length !== allTasks.length
            ? { boardTotal: allTasks.length }
            : {}),
        })
          + (boardTruncated
            ? `\n${renderBoardTruncationNote(boardOffset + boardShown, allTasks.length, budget.total)}`
            : "")
          + (rollbackWarnings.length > 0 ? `\n${rollbackWarnings.join("\n")}` : "")
          + (stalled.length > 0
            ? `\nStalled: ${stalled.map((f) => `${f.taskId}(${f.kind}, idle ${f.idleForMin}min → ${stallSuggestion(f.kind, f.status)})`).join(", ")}`
            : "")
          + (capacity !== null ? `\n${capacity.lines.join("\n")}` : "");
        return okResult(text, payload);
      });
    },
  };
}

/** 当前未读（未读 ∧ 未丢弃 ∧ isCurrentMail）计数（与 tools-read 的 countUnread 同口径）。 */
function countUnreadFor(team: TeamState, messages: readonly TeamMessage[]): number {
  return messages.filter((m) => !m.readAt && !m.discardedAt && isCurrentMailFor(team, m)).length;
}
import { isCurrentMail as isCurrentMailFor } from "../core/mailbox.js";
import type { TeamMessage, TeamState } from "../core/types.js";

// ---------------------------------------------------------------------------
// xc_overview 工具层（view 路由；peers/panel 两轴经 PeerServices）
// ---------------------------------------------------------------------------

/** xc_overview 主处理器（注册器由 registerOverviewTools 挂进 server + dispatcher）。 */
export async function handleOverview(deps: ToolDeps, args: OverviewArgs, connectionKey: string): Promise<ToolResult> {
  const view = args.view ?? "team";
  if (view === "team") {
    return createTeamOverviewCore(deps).xc_status(
      { ...(args.history !== undefined ? { history: args.history } : {}), ...(args.offset !== undefined ? { offset: args.offset } : {}) },
      connectionKey,
    );
  }
  if (view === "peers") {
    return overviewPeers(deps, args);
  }
  return overviewPanel(deps);
}

/** view:"peers"（原 xc_peers 1:1；kind 过滤参数不保留——一次列全三类）。 */
export async function overviewPeers(deps: ToolDeps, args: OverviewArgs): Promise<ToolResult> {
  const services = getPeerServices(deps);
  const all = await services.list(undefined);
  // v0.5.2（SCALE-1 配套）：清单行接入注入预算（窗口 + rowsTruncated 指针）。
  const offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const page = all.slice(offset);
  const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
  const { formatPeerRows } = await import("../core/peeraddr.js");
  const lines = formatPeerRows(page);
  const rowCosts = page.map((row, i) => (lines[i]?.length ?? 0) + JSON.stringify(row).length);
  const shown = batchWindowCount(rowCosts, budget.total);
  const windowedRows = page.slice(0, shown);
  const windowedLines = lines.slice(0, shown);
  const rowsTruncated = offset + shown < all.length;
  const text = all.length === 0
    ? "本机没有可寻址的跨会话 peer。"
    : `可寻址 peer ${all.length} 个${rowsTruncated ? `（本页 ${offset + shown}/${all.length}）` : ""}：\n${windowedLines.join("\n")}`
      + (rowsTruncated
        ? `\n[清单已按注入预算（${budget.total} 字符）截断：其余 ${all.length - offset - shown} 行用 xc_overview({view:"peers", offset:${offset + shown}}) 续读]`
        : "");
  return okResult(
    text,
    {
      count: windowedRows.length,
      rows: windowedRows,
      total: all.length,
      offset,
      ...(rowsTruncated
        ? { rowsTruncated: { shown: offset + shown, total: all.length, offset, budgetChars: budget.total } }
        : {}),
    },
  );
}

/** view:"panel"（原 xc_agents 1:1）+ C5 stalled 计数挂载。 */
export async function overviewPanel(deps: ToolDeps): Promise<ToolResult> {
  const services = getPeerServices(deps);
  const panel = await services.agents();
  // v0.5.2（SCALE-1 修复）：观测面板接入注入预算（peers 行窗口化 + 续读指针）。
  const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
  const fixed = JSON.stringify({ ...panel, peers: [] }).length + 64;
  const peerCosts = panel.peers.map((row) => JSON.stringify(row).length);
  const shownPeers = batchWindowCount(peerCosts, Math.max(0, budget.total - fixed));
  const peersTruncated = shownPeers < panel.peers.length;
  const windowed = { ...panel, peers: panel.peers.slice(0, shownPeers) };
  // C5 挂载：panel 附 stalled 摘要（team 视图同源计算）。
  const team = await readTeam(deps.stateRoot, "default");
  const now = Date.now();
  const stalled = team !== undefined
    ? stalledTasks(team.tasks, now, stallThresholdMs(deps.env, staleThresholdMsFromEnv(deps.env)).ms)
    : [];
  const stalledLine = stalled.length > 0
    ? `stalled: ${stalled.map((f) => `${f.taskId}(${f.kind}, idle ${f.idleForMin}min → ${stallSuggestion(f.kind, f.status)})`).join(", ")}`
    : "stalled: (none)";
  // C3 挂载（M6）：panel 同样携带 capacity 块（采样失败只丢观测块）。
  const capacity = await capacityMount(deps);
  const panelLines = [
    panel.self !== undefined ? `self: ${panel.self.name} (${panel.self.status ?? "unknown"})` : "self: 未注册",
    `peers: ${panel.peers.length}${peersTruncated ? `（本页列 ${shownPeers}，其余用 xc_overview({view:"peers", offset:${shownPeers}}) 续读）` : ""}`,
    `members: ${panel.members.length}`,
    `tasks: pending ${panel.tasks.pending} / in_progress ${panel.tasks.inProgress} / done ${panel.tasks.done}`,
    stalledLine,
    panel.inboundPolicy !== undefined
      ? `inboundPolicy: ${panel.inboundPolicy.mode} (${panel.inboundPolicy.decidedBy})`
        + (panel.inboundPolicy.sessionLevelQuery !== undefined
          ? `；会话级查询: ${panel.inboundPolicy.sessionLevelQuery.policy}`
            + (panel.inboundPolicy.sessionLevelQuery.holdCause !== undefined
              ? ` (${panel.inboundPolicy.sessionLevelQuery.holdCause})`
              : "")
          : "")
      : "inboundPolicy: 未知",
    ...(capacity !== null ? capacity.lines : []),
  ];
  return okResult(
    panelLines.join("\n"),
    {
      ...windowed,
      ...(stalled.length > 0 ? { stalled: stalled.map((flag) => ({ ...flag, suggestion: stallSuggestion(flag.kind, flag.status) })) } : {}),
      ...(peersTruncated
        ? { peersTruncated: { shown: shownPeers, total: panel.peers.length, budgetChars: budget.total } }
        : {}),
      ...(capacity !== null ? capacity.payload : {}),
    },
  );
}

export type { StallFlag };
void ToolError;

// ---------------------------------------------------------------------------
// SDK 接线（FamilyRegistrar 形态；server.ts 持有 PrimaryRegistry）
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCore } from "./core.js";
import type { ToolDeps as _TD, PrimaryRegistry } from "./core.js";
import { connectionKeyOf } from "./identity.js";

/** 注册 xc_overview（缺省 team；peers/panel 视图；无需注册即可调用）。 */
export function registerOverviewTools(
  server: McpServer,
  deps: _TD,
  _core: ToolCore,
  registry: PrimaryRegistry,
): void {
  const description =
    "Observation snapshot (replaces xc_status + xc_peers + xc_agents). view=team (default): members with isLead, priority-ordered task board (budget-windowed with boardTruncated pointer), unread counts, orphan/stale-receipt warnings, stalled flags (C5); " +
    "history:true appends leadHistory; view=peers: addressable cross-session peers (self/member/session rows, rowsTruncated pointer); " +
    "view=panel: self + peers + members + task counts + inbound policy. Does not require registration; writes snapshot.json (always the full board).";
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> =>
    handleOverview(deps, args as unknown as OverviewArgs, connectionKeyOf(extra));
  server.tool("xc_overview", description, OverviewShape, handler);
  registry.set("xc_overview", { description, shape: OverviewShape, handler });
}
