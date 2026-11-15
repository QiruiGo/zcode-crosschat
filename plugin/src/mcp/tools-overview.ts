/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T7）：xc_overview —— 全景观测（+容量/停滞挂载点）。
 *
 * 合并任务板 / peer 清单 / 面板三类观测的调用面：
 * - view 缺省/"team" ≈ 原任务板观测（内部方法平移实现；teamId 参数随合并移除
 *   ——多团队从未启用，v0.1 遗留死参；snapshot.json 落盘、boardTruncated 分页指针
 *   全部保留）。任务板按 sortTasksForBoard（C2：priority → createdAt）排序呈现。
 * - view "peers" ≈ 原 peer 清单（行格式与 rowsTruncated 分页原样；旧 kind 过滤参数
 *   不保留——一次列全三类，按行首 [self]/[member]/[session] 标记自行辨识）。
 * - view "panel" ≈ 原全景面板（self+peers+members+tasks+入站策略）。
 * - 停滞挂载（C5，M5 core/stall.ts）：team/panel 附 stalled[]（XC_STALL_MINUTES，
 *   缺省 120min，小于 stale 阈值时钳制 + WARNING）；容量挂载（C3，M6）由
 *   core/capacity.ts 落位后在此追加 capacity 块（挂载点：overviewPayloadExtras）。
 * - v0.7（C8，M4 core/offline.ts）：team 视图附 offlineMembers[]（离线成员 + 其名下
 *   待转交任务 + 证据；XC_OFFLINE_MINUTES 缺省 240min，钳制 ≥ stale + WARNING）。
 *   只读 peer 扫描失败 → 不挂载（观测面永不为难任务板，同 capacityMount 纪律）。
 * - v0.8.0（A3/A4，DESIGN-V0.8.md §5/§6）：view 增 "timeline"（引擎日志时间线，
 *   core/timeline.ts 尾部窗口读 + 事件族归一化；limit 缺省 20/上限 100，offset =
 *   自最新往回跳过）与 "status"（替代状态栏的紧凑视图——任务七态计数/stalled/
 *   容量色+水位/离线成员/checkpoint 年龄/未读数；复用 capacityMount /
 *   offlineMembersMount / stalledTasks / countUnreadFor / latestCheckpoint，
 *   零重复实现）。两者都是**纯派生视图**：免注册、不写 snapshot.json。
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
import { engineLogFile, isValidTeamId } from "../core/paths.js";
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
// v0.7（C8，M4）：离线成员挂载（DESIGN-V0.7.md §4.3）。
import { peerRootFromEnv } from "../core/peerdir.js";
import { scanPeers } from "../core/peerregistry.js";
import { offlineMemberLine, offlineMembers, offlineThresholdMsFromEnv, type OfflineMember } from "../core/offline.js";
import {
  capacityCacheFile,
  formatCapacityLines,
  judgeCapacity,
  sampleCapacity,
  type CapacitySample,
  type CapacityVerdict,
} from "../core/capacity.js";
// v0.8.0（A3/A4）：时间线尾部窗口读 + 事件族归一化；checkpoint 年龄/容量 level 推导助手。
import { readTimeline } from "../core/timeline.js";
import { capacityLevelOf, latestCheckpoint } from "../core/checkpoint.js";
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
// v0.7（C8，M4）离线成员挂载（DESIGN-V0.7.md §4.3）：只读 peer 扫描 + 离线判据。
// 与 capacityMount 同纪律：任何意外（peer 根不可读/扫描失败）→ 返回 null = 不挂载，
// 任务板与其余观测块不受影响（安全底线：不崩）。
// ---------------------------------------------------------------------------

interface OfflineMount {
  members: OfflineMember[];
  lines: string[];
  /** XC_OFFLINE_MINUTES 低于 stale 阈值被钳制（挂载面附 WARNING）。 */
  clamped: boolean;
  /**
   * v0.7.2（C8-B4 修复）：XC_OFFLINE_MINUTES 设了非法值（0/负数/非数字）——
   * 已按内置缺省 240min 回落，挂载面附 WARNING 披露（不再静默）。
   */
  fellBack: boolean;
}

async function offlineMembersMount(deps: ToolDeps, team: TeamState, now: number): Promise<OfflineMount | null> {
  try {
    const staleMs = staleThresholdMsFromEnv(deps.env);
    const threshold = offlineThresholdMsFromEnv(deps.env, staleMs);
    // 只读扫描（sweep:false）：查询路径不得有清扫副作用（peerregistry.ts 的 hazard 自载）。
    const scan = await scanPeers(peerRootFromEnv(deps.env), now, { sweep: false });
    const members = offlineMembers(team, scan, now, threshold.ms);
    if (members.length === 0 && !threshold.clamped && !threshold.fellBack) return null;
    return { members, lines: members.map(offlineMemberLine), clamped: threshold.clamped, fellBack: threshold.fellBack };
  } catch {
    return null;
  }
}

export const OverviewShape = {
  view: z.enum(["team", "peers", "panel", "timeline", "status"]).optional().describe(
    "缺省 team：任务板+成员+未读；peers：本机可寻址 peer 清单；panel：self+peers+members+tasks+入站策略+容量+停滞；"
    + "timeline：引擎日志时间线（新→旧；limit 缺省 20 上限 100，offset=自最新往回跳过 N 条，预算截断披露+续读指针）；"
    + "status：紧凑状态视图（任务七态计数/stalled/容量色+水位/离线成员/checkpoint 年龄/未读数，替代状态栏）",
  ),
  history: z.boolean().optional().describe("附 lead 角色变更史（R-7）"),
  offset: z.number().int().min(0).optional().describe(
    "分页起点：team=任务板自头部偏移；peers=清单自头部偏移；timeline=自最新往回跳过 N 条（语义不同，防误用）",
  ),
  limit: z.number().int().min(1).optional().describe("仅 view=timeline：单页事件条数（缺省 20，上限 100，超限钳制并披露 limitClamped）"),
} as const;

export type OverviewArgs = {
  view?: "team" | "peers" | "panel" | "timeline" | "status";
  history?: boolean;
  offset?: number;
  limit?: number;
};

export interface TeamOverviewCore {
  /** 队内全景（原任务板核心 1:1 平移；teamId 死参移除；板面按优先级排序）。 */
  xc_status(args: { history?: boolean; offset?: number }, connectionKey: string): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// 队内全景核心（原 tools.ts 平移；差异：teamId 移除 + 板面 priority 排序 + stalled 挂载）
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
        // v0.7（C8，M4）离线成员挂载：同 capacity 纪律（扫描失败只丢观测块）。
        const offlineMount = team !== undefined ? await offlineMembersMount(deps, team, now) : null;
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
          // v0.7（C8，M4）挂载点：offlineMembers 块（离线成员 + 名下待转交任务 + 证据）。
          ...(offlineMount !== null && (offlineMount.members.length > 0 || offlineMount.clamped || offlineMount.fellBack)
            ? {
                offlineMembers: offlineMount.members,
                ...(offlineMount.clamped ? { offlineThresholdClamped: true } : {}),
                ...(offlineMount.fellBack ? { offlineThresholdFallback: true } : {}),
              }
            : {}),
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
        if (offlineMount !== null && offlineMount.clamped) {
          rollbackWarnings.push(
            "WARNING XC_OFFLINE_MINUTES 低于僵尸清扫阈值（XC_STALE_TASK_MINUTES）——离线阈值已按 stale 阈值钳制（无进展任务会先被 stale 回收，idle-timeout 分支轮不到展示）",
          );
        }
        // v0.7.2（C8-B4 修复）：非法值（0/负数/非数字）不再静默回落——明示已按缺省 240min 接管。
        if (offlineMount !== null && offlineMount.fellBack) {
          rollbackWarnings.push(
            "WARNING XC_OFFLINE_MINUTES 非法（须为有限正数；0/负数/非数字不被接受）——已回落内置缺省 240min（安全方向：取最保守的离线阈值）；如只想用缺省值请取消该 env 设置",
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
          + (offlineMount !== null && offlineMount.members.length > 0
            ? `\nOffline: ${offlineMount.lines.join(", ")}`
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
  if (view === "timeline") {
    return timelineView(deps, args);
  }
  if (view === "status") {
    return statusView(deps, connectionKey);
  }
  return overviewPanel(deps);
}

/** view:"peers"（原 peer 清单 1:1；kind 过滤参数不保留——一次列全三类）。 */
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

/** view:"panel"（原全景面板 1:1）+ C5 stalled 计数挂载。 */
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
// v0.8.0（A3/A4，DESIGN-V0.8.md §5/§6）：timeline / status 两个纯派生视图
// （免注册、不写 snapshot.json；timeline 读 engine.jsonl 尾部窗口，status 复用
//  capacityMount / offlineMembersMount / stalledTasks / countUnreadFor /
//  latestCheckpoint——C9 采样、C8 活性、C5 停滞判定零重复实现）
// ---------------------------------------------------------------------------

/**
 * view:"timeline"：引擎日志时间线（新→旧）。core/timeline.ts 自持尾部窗口读
 * （256 KiB，窗口首行丢弃防半行；坏行跳过）；limit 缺省 20/上限 100（钳制披露
 * limitClamped）；offset = 自最新往回跳过 N 条（与板面偏移语义不同，describe 已写明）；
 * 预算开窗超限给 truncated + 续读指针；窗口不足披露 tailWindowBytes/olderEventsOmitted。
 */
export async function timelineView(deps: ToolDeps, args: OverviewArgs): Promise<ToolResult> {
  return runCore(deps.stateRoot, async () => {
    const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
    const result = await readTimeline(engineLogFile(deps.stateRoot), {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      budgetChars: budget.total,
    });
    const lines = result.events.map(
      (e) =>
        `${new Date(e.ts).toISOString()} | ${e.event} | ${e.family} | ${e.actor ?? "-"} | ${e.taskId ?? "-"} | ${e.summary}`,
    );
    const parts: string[] = [
      result.total === 0
        ? "引擎日志暂无事件（engine.jsonl 空或不在尾部窗口内）。"
        : `引擎事件（窗口内 ${result.total} 条，新→旧；本页 ${result.events.length} 条，offset ${result.offset}）：`,
    ];
    if (lines.length > 0) parts.push(lines.join("\n"));
    if (result.truncated !== undefined) {
      parts.push(
        `[时间线已按注入预算（${budget.total} 字符）截断：本页 ${result.truncated.shown}/${result.truncated.total} 条`
        + `——用 xc_overview({view:"timeline", offset:${result.truncated.shown}}) 续读]`,
      );
    }
    if (result.olderEventsOmitted === true) {
      parts.push(
        `[尾部窗口 ${result.tailWindowBytes ?? 0} 字节：更早事件未读入（olderEventsOmitted）`
        + `——引擎日志无上界，时间线只保最近窗口]`,
      );
    }
    return okResult(parts.join("\n"), {
      count: result.events.length,
      events: result.events,
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      ...(result.limitClamped !== undefined ? { limitClamped: result.limitClamped } : {}),
      ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
      ...(result.tailWindowBytes !== undefined ? { tailWindowBytes: result.tailWindowBytes } : {}),
      ...(result.olderEventsOmitted !== undefined ? { olderEventsOmitted: result.olderEventsOmitted } : {}),
    });
  });
}

/** latestCheckpoint 的安全包装：段闸抛错按「无检查点」降级（观测面永不为难任务板）。 */
async function latestCheckpointAgeSafe(
  stateRoot: string,
  agentKey: string,
  now: number,
): Promise<{ ageMin: number | null; path: string | null }> {
  try {
    const latest = await latestCheckpoint(stateRoot, agentKey, now);
    return latest === null ? { ageMin: null, path: null } : { ageMin: latest.ageMin, path: latest.path };
  } catch {
    return { ageMin: null, path: null };
  }
}

/** 检查点年龄展示：<60min → Nmin前；<24h → Nh前；否则 Nd前。 */
function formatCheckpointAge(ageMin: number | null): string {
  if (ageMin === null) return "(none)";
  if (ageMin < 60) return `${ageMin}min前`;
  if (ageMin < 1440) return `${Math.floor(ageMin / 60)}h前`;
  return `${Math.floor(ageMin / 1440)}d前`;
}

/** status 视图降级级（0=全量；1=unread 行；2=checkpoint 行；3=offline/stalled 明细；4=容量明细；5=硬截）。 */
type StatusDegradeLevel = 0 | 1 | 2 | 3 | 4 | 5;

interface StatusRenderInput {
  team: TeamState;
  leadKey: string;
  counts: Record<string, number>;
  stalledCount: number;
  /** null = 离线挂载失败（扫描意外）——不猜。 */
  offlineCount: number | null;
  /** 容量挂载行（capacityMount.lines[0]）；null = 挂载失败。 */
  capacityLine: string | null;
  capacityLevel: string;
  capacityAdvice: string | null;
  checkpointEntries: Array<{ key: string; ageMin: number | null }>;
  unreadEntries: Array<{ key: string; count: number }>;
  budgetChars: number;
}

function renderStatusLines(input: StatusRenderInput, level: StatusDegradeLevel): { lines: string[]; dropped: string[] } {
  const droppedSet = new Set<string>();
  const lines: string[] = [];
  const lead = input.leadKey;
  lines.push(
    `team: ${input.team.teamId} | lead: ${lead} | members: ${input.team.members.length}`
    + (level >= 3 || input.offlineCount === null
      ? ""
      : ` (offline ${input.offlineCount})`),
  );
  if (level >= 3 && input.offlineCount !== null) droppedSet.add("offline");
  const countsText = ["pending", "claimed", "in_progress", "blocked", "completed", "failed", "cancelled"]
    .map((s) => `${s} ${input.counts[s] ?? 0}`)
    .join(" / ");
  lines.push(
    `tasks: ${countsText}`
    + (level >= 3 ? "" : ` | stalled ${input.stalledCount}`),
  );
  if (level >= 3 && input.stalledCount > 0) droppedSet.add("stalled");
  if (level >= 4 || input.capacityLine === null) {
    const detail = level >= 4 ? "（明细按预算略去）" : " | 采样失败（不按 GREEN 呈现）";
    lines.push(`capacity: ${input.capacityLevel}${detail}`);
    if (level >= 4) droppedSet.add("capacity-details");
  } else {
    lines.push(input.capacityLine);
  }
  if (level >= 2) {
    lines.push(`checkpoint: （按 ${input.budgetChars} 字符预算略去）`);
    droppedSet.add("checkpoint");
  } else {
    const entries = input.checkpointEntries.map((e) => `${e.key}=${formatCheckpointAge(e.ageMin)}`);
    lines.push(`checkpoint: ${entries.length > 0 ? entries.join(", ") : "(none)"}`);
  }
  if (level >= 1) {
    lines.push(`unread: （按 ${input.budgetChars} 字符预算略去）`);
    droppedSet.add("unread");
  } else {
    const entries = input.unreadEntries.map((e) => `${e.key}=${e.count}`);
    lines.push(`unread: ${entries.length > 0 ? entries.join(", ") : "(none)"}`);
  }
  if (input.capacityAdvice !== null && level < 4) lines.push(input.capacityAdvice);
  // droppedSections 按**固定降级序**排列（不是行序）：unread 行 → checkpoint 行 →
  // offline/stalled 明细 → capacity 明细（DESIGN §6）。
  const STATUS_DROP_ORDER = ["unread", "checkpoint", "offline", "stalled", "capacity-details"];
  const dropped = STATUS_DROP_ORDER.filter((name) => droppedSet.has(name));
  return { lines, dropped };
}

/**
 * view:"status"（A4，替代状态栏）：单块紧凑文本，**行序冻结**——
 *   team / tasks / capacity / checkpoint / unread
 * 字段口径与真实状态一致（AC4）：七态计数全量；stalled = stalledTasks 计数；
 * offline = offlineMembersMount 成员数；capacity 复用 capacityMount（挂载 null → UNKNOWN，
 * 不谎报 GREEN；RED 附 C9 原句 COMPRESS_ADVICE_LINE）；checkpoint 年龄按 mtime；
 * unread 与板面同口径 countUnreadFor。预算超限走固定降级序（unread 行 → checkpoint 行
 * → offline/stalled 明细 → capacity 明细），每级留名披露 truncated。
 */
export async function statusView(deps: ToolDeps, connectionKey: string): Promise<ToolResult> {
  return runCore(deps.stateRoot, async () => {
    const teamId = "default"; // v1 单队固定 default
    const me = identityStore.get(connectionKey); // 豁免注册：未注册省略个人字段
    const team = await readTeam(deps.stateRoot, teamId);
    const now = Date.now();
    const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);

    if (team === undefined) {
      return okResult("team: (none) — 尚无团队（xc_identify 建队后本视图才有内容）", {
        teamId,
        phase: "none",
        taskCounts: { pending: 0, claimed: 0, in_progress: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0 },
        members: { total: 0, offline: null },
        stalled: 0,
        capacity: null,
        checkpoints: {},
        unread: {},
      });
    }

    // C3 容量挂载（复用；挂载失败 → UNKNOWN，不写 GREEN）
    const capacity = await capacityMount(deps);
    const capacityPayload = capacity?.payload["capacity"] as Record<string, unknown> | undefined;
    const capacityLevel = capacityLevelOf(
      capacityPayload === undefined ? null : { red: capacityPayload["red"] === true },
    );
    const capacityLine = capacity?.lines[0] ?? null;
    const capacityAdvice = capacity !== null && capacityPayload?.["red"] === true
      ? capacity.lines[capacity.lines.length - 1] ?? null
      : null;

    // C8 离线成员挂载（复用；null = 扫描意外，不猜）
    const offlineMount = await offlineMembersMount(deps, team, now);
    const offlineCount = offlineMount === null ? null : offlineMount.members.length;

    // C5 停滞（复用 stalledTasks；钳制披露）
    const stall = stallThresholdMs(deps.env, staleThresholdMsFromEnv(deps.env));
    const stalled = stalledTasks(team.tasks, now, stall.ms);

    // 七态计数（一个不漏）
    const counts: Record<string, number> = {
      pending: 0, claimed: 0, in_progress: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0,
    };
    for (const t of team.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

    // 未读（与板面同口径 countUnreadFor——观测面自洽）
    const unreadEntries: Array<{ key: string; count: number }> = [];
    const unreadMap: Record<string, number> = {};
    for (const m of team.members) {
      const msgs = await readMailbox(deps.stateRoot, teamId, m.key);
      const count = countUnreadFor(team, msgs);
      unreadMap[m.key] = count;
      unreadEntries.push({ key: m.key, count });
    }

    // 检查点年龄：me（已注册时）+ 全部花名册成员（无检查点记 (none)）
    const checkpointKeys: string[] = [];
    if (me !== undefined && !team.members.some((m) => m.key === me.agentKey)) checkpointKeys.push(me.agentKey);
    for (const m of team.members) checkpointKeys.push(m.key);
    const checkpointEntries: Array<{ key: string; ageMin: number | null }> = [];
    const checkpointMap: Record<string, { ageMin: number | null; path: string | null }> = {};
    for (const key of checkpointKeys) {
      const entry = await latestCheckpointAgeSafe(deps.stateRoot, key, now);
      checkpointMap[key] = entry;
      checkpointEntries.push({ key, ageMin: entry.ageMin });
    }

    const renderInput: StatusRenderInput = {
      team,
      leadKey: leadKeyOf(team),
      counts,
      stalledCount: stalled.length,
      offlineCount,
      capacityLine,
      capacityLevel,
      capacityAdvice,
      checkpointEntries,
      unreadEntries,
      budgetChars: budget.total,
    };
    // 预算降级序列：逐步重算、命中即停（L5 硬截必然命中）。
    const levels: StatusDegradeLevel[] = [0, 1, 2, 3, 4, 5];
    let chosen: { level: StatusDegradeLevel; text: string; dropped: string[] } | undefined;
    for (const level of levels) {
      const { lines, dropped } = renderStatusLines(renderInput, level);
      let text = lines.join("\n");
      if (level >= 1) {
        const names = level === 5 ? [...dropped, "正文"] : dropped;
        const marker =
          `[已按 ${budget.total} 字符预算截断：略去/缩减 ${names.join("、")}；`
          + "全文用 xc_overview({view:\"team\"}) / xc_read({scope:\"inbox\"}) 取]";
        if (level === 5) {
          const keep = Math.max(0, budget.total - marker.length - 1);
          text = `${text.slice(0, keep)}\n${marker}`;
        } else {
          text = `${text}\n${marker}`;
        }
      }
      if (text.length <= budget.total || level === 5) {
        chosen = { level, text, dropped };
        break;
      }
    }
    const final = chosen!;

    const extraWarnings: string[] = [];
    if (offlineMount !== null && offlineMount.clamped) {
      extraWarnings.push(
        "WARNING XC_OFFLINE_MINUTES 低于僵尸清扫阈值（XC_STALE_TASK_MINUTES）——离线阈值已按 stale 阈值钳制（无进展任务会先被 stale 回收，idle-timeout 分支轮不到展示）",
      );
    }
    if (offlineMount !== null && offlineMount.fellBack) {
      extraWarnings.push(
        "WARNING XC_OFFLINE_MINUTES 非法（须为有限正数；0/负数/非数字不被接受）——已回落内置缺省 240min（安全方向：取最保守的离线阈值）；如只想用缺省值请取消该 env 设置",
      );
    }
    if (extraWarnings.length > 0) final.text = `${final.text}\n${extraWarnings.join("\n")}`;

    return okResult(final.text, {
      teamId,
      phase: team.phase,
      leadKey: renderInput.leadKey,
      members: { total: team.members.length, offline: offlineCount },
      taskCounts: counts,
      stalled: stalled.length,
      ...(stall.clamped ? { stalledThresholdClamped: true } : {}),
      capacity: capacityPayload === undefined
        ? null
        : { ...capacityPayload, level: capacityLevel },
      checkpoints: checkpointMap,
      unread: unreadMap,
      ...(final.level >= 1
        ? {
            truncated: {
              budgetChars: budget.total,
              shownChars: final.text.length,
              droppedSections: final.level === 5 ? [...final.dropped, "正文"] : [...final.dropped],
            },
          }
        : {}),
    });
  });
}

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
    "Observation snapshot (task board / members / peers / capacity / stall in one tool). view=team (default): members with isLead, priority-ordered task board (budget-windowed with boardTruncated pointer), unread counts, orphan/stale-receipt warnings, stalled flags (C5); " +
    "history:true appends leadHistory; view=peers: addressable cross-session peers (self/member/session rows, rowsTruncated pointer); " +
    "view=panel: self + peers + members + task counts + inbound policy; " +
    "view=timeline: engine.jsonl timeline newest-first (limit defaults 20, max 100 with limitClamped disclosure; offset skips back N from the newest event; budget window with truncated pointer); " +
    "view=status: compact status block (task counts by status / stalled / capacity level + watermark / offline members / checkpoint ages / unread counts — the no-statusline substitute). Does not require registration; writes snapshot.json (always the full board) only for view=team.";
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> =>
    handleOverview(deps, args as unknown as OverviewArgs, connectionKeyOf(extra));
  server.tool("xc_overview", description, OverviewShape, handler);
  registry.set("xc_overview", { description, shape: OverviewShape, handler });
}
