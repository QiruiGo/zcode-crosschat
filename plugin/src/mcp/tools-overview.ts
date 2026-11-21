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
 * - v0.8.1（29-v080 红队 C3 组修复）：timeline 的 actor 链补 approvedBy/from/member
 *   （M03）、按 ts 降序（B2）、skippedEvents 跳过披露（B3）、文本视图控制字符清洗
 *   （B4）、尾窗截断每页披露 olderEventsOmitted（M04）、续读 offset 位置游标语义
 *   披露（B7）、预算刻度接 identify 的 contextChars 逐会话声明（B8）——逐项对应
 *   PROTOCOL §14.4 冻结式同步。
 * - 无需注册即可调用（只读纪律，SKILL §1 保留）。
 */

import { stat } from "node:fs/promises";
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
import { engineLogFile, inboxFile, isValidTeamId } from "../core/paths.js";
// v0.9.3（A2）：唤醒三级指标（判据与取数的单一真源在 engine/wake.ts）。
import { readWakeTierCounts, wakeTierCountsLine } from "../engine/wake.js";
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
// v0.8.1（C3-B8）：调用方 peer 会话上下文（contextChars 逐会话声名的旁路解析）。
import { getPeerSessionContext } from "./peer-drain.js";
import { leadKeyOf } from "./tools-team.js";
// v0.7（C8，M4）：离线成员挂载（DESIGN-V0.7.md §4.3）。
import { peerRootFromEnv } from "../core/peerdir.js";
import { scanPeers, type PeerScanResult } from "../core/peerregistry.js";
// v0.9.5（A3/V094-14）：offlineMembers 接 pid 证据——与成员行（memberLivenessView）/判死
// 面（watchdog）同一派生点 deriveSessionPidEvidence + 同一存活探测 pidAlive。
import { deriveSessionPidEvidence, offlineMemberLine, offlineMembers, offlineThresholdMsFromEnv, type OfflineMember, type SessionPidEvidence } from "../core/offline.js";
import { pidAlive } from "../core/lock.js";
// v0.9（G-9，PROTOCOL §12.4）：成员活性视图（三视图统一口径，单一实现）。
import { readSession, readSessionWitness } from "../core/registry.js";
import { memberLivenessView, sweepOwnerGuard, type SessionLivenessView, type SweepOwnerGuard } from "../core/liveness.js";
import { SWEEPABLE_TASK_STATUSES, TASK_STATUSES, type SessionWitness, type SessionWitnessKind } from "../core/types.js";
// C3 容量挂载（M6）+ v0.8.1（C4-O1）：水位越界回落披露助手。
import {
  capacityCacheFile,
  formatCapacityLines,
  judgeCapacity,
  memWarnWatermarkInfoFromEnv,
  MEM_WATERMARK_FALLBACK_WARNING,
  resolveCapacityThresholds,
  sampleCapacity,
  type CapacitySample,
  type CapacityThresholds,
  type CapacityVerdict,
} from "../core/capacity.js";
// v0.9.3（B2）：闸状态读数（engine/wake.ts 容量闸段的单一真源——team/status/panel 同源）。
import { wakeGateStatus, type WakeGateStatus } from "../engine/wake.js";
// v0.8.0（A3/A4）：时间线尾部窗口读 + 事件族归一化；checkpoint 年龄/容量 level 推导助手。
// v0.8.1（C3-B4）：timelineTextField——文本视图控制字符清洗（JSON payload 不洗）。
import { readTimeline, timelineTextField } from "../core/timeline.js";
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
//
// v0.9.3（B2）：挂载补**闸状态**（唤醒闸读数 wakeGateStatus，engine/wake.ts 容量闸段）——
// 当前水位/单回合预估/阻塞原因（哪个条件命中）/下次重判时刻/本窗 wake-deferred 计数，
// team/status/panel 三视图同源（同一份读数进同一份 payload 与同一行文本）。
// 分层阈值（config.json capacity 段 > env > 缺省）同时进判定与展示——改文件即热生效。
// ---------------------------------------------------------------------------

interface CapacityMount {
  payload: Record<string, unknown>;
  lines: string[];
}

/** 闸状态摘要行片段（拼在 capacity 行尾；GREEN 不显示阻塞——只报未阻塞与计数）。 */
function wakeGateLineSuffix(gate: WakeGateStatus): string {
  const estimate = `单回合预估 ${formatBytesShort(gate.thresholds.turnEstimateBytes)}`;
  const count = `本窗 wake-deferred ${gate.deferredWindowCount}/${gate.deferredAlertThreshold}`;
  if (!gate.enabled) {
    return ` | 唤醒闸 关闭（wake_gate 生效值 false）| ${estimate}`;
  }
  let suffix: string;
  if (gate.blocked && gate.nextRetryAt !== null) {
    const conditions = gate.conditions.length > 0 ? gate.conditions.join(", ") : "原因见 wake-deferred 记录";
    suffix = ` | 唤醒闸 阻塞（${conditions}）下次重判 ${new Date(gate.nextRetryAt).toISOString()} | ${estimate} | ${count}`;
  } else {
    suffix = ` | 唤醒闸 开启·未阻塞 | ${estimate} | ${count}`;
  }
  // B3②：wake 关闭持续态（与容量闸正交的另一维度）在行尾披露，不另起行。
  if (gate.wakeOffSince !== null) {
    const offMin = Math.max(0, Math.round((Date.now() - gate.wakeOffSince) / 60_000));
    suffix += ` | wake 关闭持续 ${offMin}min（阈值 ${Math.round(gate.wakeOffAlertMs / 60_000)}min）`;
  }
  return suffix;
}

function formatBytesShort(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.round(n)}B`;
}

async function capacityMount(deps: ToolDeps): Promise<CapacityMount | null> {
  let sample: CapacitySample;
  let verdict: CapacityVerdict;
  let gate: WakeGateStatus;
  let thresholds: CapacityThresholds;
  try {
    // v0.9.3（B1）：分层阈值现读（config.json capacity 段 > env > 内置默认）——判定与
    // 展示同源；闸状态读数同源（engine/wake.ts wakeGateStatus：活跃冷却 + 累积窗）。
    thresholds = resolveCapacityThresholds(deps.stateRoot, deps.env);
    sample = await sampleCapacity(deps.env, capacityCacheFile(deps.stateRoot), Date.now());
    verdict = judgeCapacity(sample, deps.env, thresholds);
    gate = await wakeGateStatus(deps.stateRoot, deps.env, Date.now());
  } catch {
    return null;
  }
  // v0.8.1（29 红队 C4-O1 修复）：XC_MEM_WARN_WATERMARK 越界（0/负数/≥1/非数字）
  // 不再静默按缺省判定——payload 附 memWarnWatermarkFallback + 文本附 WARNING
  // （与 offline/stall 家族的回落披露同款两级）。
  const watermark = memWarnWatermarkInfoFromEnv(deps.env);
  const baseLines = formatCapacityLines(sample, verdict);
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
        ...(watermark.fellBack ? { memWarnWatermarkFallback: true } : {}),
        // v0.9.3（B2）：闸状态块（键集冻结见 PROTOCOL §15.6；三视图同源）。
        wakeGate: {
          enabled: gate.enabled,
          blocked: gate.blocked,
          conditions: gate.conditions,
          blockedScopes: gate.blockedScopes,
          nextRetryAt: gate.nextRetryAt,
          deferredWindowCount: gate.deferredWindowCount,
          deferredAlertThreshold: gate.deferredAlertThreshold,
          wakeOffSince: gate.wakeOffSince,
          wakeOffAlertMs: gate.wakeOffAlertMs,
          thresholds: gate.thresholds,
          thresholdSources: gate.thresholdSources,
          ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),
        },
      },
    },
    // 闸摘要拼在容量行尾（status 视图只取 lines[0]——并入首行三视图才都看得见；
    // 不加新行：status 行序冻结 team/tasks/capacity/checkpoint/unread）。
    lines: [
      `${baseLines[0]}${wakeGateLineSuffix(gate)}`,
      ...baseLines.slice(1),
      ...(watermark.fellBack ? [MEM_WATERMARK_FALLBACK_WARNING] : []),
      // 分层畸形/越界披露（file 键畸形 + env 非法；wakeGate.warnings 同内容进 payload）。
      ...(thresholds.warnings.length > 0 ? [...new Set(thresholds.warnings)] : []),
    ],
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

async function offlineMembersMount(deps: ToolDeps, team: TeamState, now: number, scan: PeerScanResult | null): Promise<OfflineMount | null> {
  try {
    const staleMs = staleThresholdMsFromEnv(deps.env);
    const threshold = offlineThresholdMsFromEnv(deps.env, staleMs);
    // 只读扫描（sweep:false）由调用方传入（team/status/liveness 三处共用一次扫描）；
    // 扫描失败（null）= 观测块不挂载（同 capacityMount 纪律：观测面永不为难任务板）。
    if (scan === null) return null;
    // v0.9.5（A3/V094-14）：按成员派生会话记录 pid 证据（读 sessions/<sid>.json 一次 +
    // deriveSessionPidEvidence 单一派生点 + pidAlive 探测）注入 offlineMembers——与成员
    // 行（memberLivenessView）/判死面（watchdog）同判据。旧实现不传 pid：成员行判 dead
    // 而本清单报 null 的三面自相矛盾（V094-14）由此收口。读失败 = 无证据（判据不参与，
    // 保守方向，不猜）。
    const pidEvidence = new Map<string, SessionPidEvidence | undefined>();
    for (const member of team.members) {
      try {
        const record = await readSession(deps.stateRoot, member.sessionId);
        pidEvidence.set(member.key, deriveSessionPidEvidence(record, now, pidAlive));
      } catch {
        pidEvidence.set(member.key, undefined);
      }
    }
    const members = offlineMembers(team, scan, now, threshold.ms, {
      sessionPidFor: (member) => pidEvidence.get(member.key),
    });
    if (members.length === 0 && !threshold.clamped && !threshold.fellBack) return null;
    return { members, lines: members.map(offlineMemberLine), clamped: threshold.clamped, fellBack: threshold.fellBack };
  } catch {
    return null;
  }
}

/**
 * v0.9（G-9，PROTOCOL §12.4）：成员活性挂载——xc_overview team/panel/status 三视图
 * 共用的取数与计数（单一实现保证跨面口径一致）。会话记录逐成员只读（失败按无记录
 * = idle 保守呈现）；peer 扫描（dead 判据）由调用方传入（与 offline 挂载共用同一
 * 次只读扫描，扫描不可用 = 不判 dead，观测面降级不崩）。
 *
 * v0.9.1 r4（V090-01 观测 + 口径统一）：挂载同时读**引擎证言**（registry/witness/<sid>.json，
 * 与清扫豁免同一读取路径），成员行展示 `liveness.witness`——「自述 state」与「豁免真实
 * 输入」在同一行并列，lead 一眼看出「展示 running 但证言缺失/陈旧」的异常长豁免形态。
 *
 * v0.9.3（C1 活性四判据合判）：挂载补第③④判据的落盘读取——证言（已有，witnessMap）
 * 与**成员邮箱文件写入 mtime**（inboxFile 的 stat；读失败 = 该判据无声），一并注入
 * memberLivenessView 的合判输入，成员行新增 `liveness.livenessSources`（四判据各自
 * 可判活；空 = 全静默）。新鲜窗按 env 解析后注入（core 不解析 env），与 stale 阈值同源。
 */
interface LivenessMount {
  /** 成员键 → 活性视图（三视图同形；r4 起含 witness 快照，v0.9.3 起含判据来源）。 */
  views: Map<string, MemberLivenessRow>;
  /** 成员键 → 引擎证言（豁免判定的真实输入；undefined = 无证言）。 */
  witness: Map<string, SessionWitness | undefined>;
  /** 三态计数（文本行紧凑呈现用）。 */
  counts: { running: number; idle: number; dead: number };
}

/** 三视图成员行的活性块（r4：自述视图 + 引擎证言快照；v0.9.3 C1：+ 判据来源）。 */
interface MemberLivenessRow extends SessionLivenessView {
  /** 引擎证言快照（清扫豁免的真实输入）；null = 无证言（不豁免）。 */
  witness: { kind: SessionWitnessKind; ageMin: number } | null;
}

async function livenessMount(deps: ToolDeps, team: TeamState, now: number, scan: PeerScanResult | null): Promise<LivenessMount> {
  const views = new Map<string, MemberLivenessRow>();
  const witnessMap = new Map<string, SessionWitness | undefined>();
  const counts = { running: 0, idle: 0, dead: 0 };
  // v0.9.3（C1）：四判据新鲜窗 = stale 清扫阈值的生效值（core 纯函数不解析 env）。
  const freshMs = staleThresholdMsFromEnv(deps.env);
  for (const member of team.members) {
    let record;
    try {
      record = await readSession(deps.stateRoot, member.sessionId);
    } catch {
      record = undefined; // 记录读失败 = 无记录（保守 idle，不崩观测面）
    }
    let witness: SessionWitness | undefined;
    try {
      witness = await readSessionWitness(deps.stateRoot, member.sessionId);
    } catch {
      witness = undefined; // 证言读失败 = 无证言（保守：不豁免）
    }
    witnessMap.set(member.key, witness);
    // 第④判据：成员邮箱文件写入 mtime（投递/消费确认都在动它）。读失败/文件缺失 =
    // 该判据无声（不猜）——stat 失败与「很久没写」是两件事，只有前者静默。
    let mailboxMtimeMs: number | undefined;
    try {
      mailboxMtimeMs = (await stat(inboxFile(deps.stateRoot, team.teamId, member.key))).mtimeMs;
    } catch {
      mailboxMtimeMs = undefined;
    }
    const view = memberLivenessView(member, record, scan ?? undefined, now, {
      freshMs,
      ...(witness !== undefined ? { witness } : {}),
      ...(mailboxMtimeMs !== undefined ? { mailboxMtimeMs } : {}),
    });
    views.set(member.key, {
      ...view,
      witness: witness === undefined
        ? null
        : { kind: witness.kind, ageMin: Math.max(0, Math.round((now - witness.ts) / 60_000)) },
    });
    counts[view.state] += 1;
  }
  return { views, counts, witness: witnessMap };
}

/** 只读 peer 扫描的安全封装（offline/liveness 挂载共用；失败 → null = 观测块降级）。 */
async function scanPeersSafe(deps: ToolDeps, now: number): Promise<PeerScanResult | null> {
  try {
    return await scanPeers(peerRootFromEnv(deps.env), now, { sweep: false });
  } catch {
    return null;
  }
}

/** 紧凑活性文本行（team/panel 文本面统一格式；status 文本行序冻结，活性只在 payload）。 */
function livenessTextLine(counts: LivenessMount["counts"]): string {
  return `liveness: running ${counts.running} / idle ${counts.idle} / dead ${counts.dead}`;
}

// ---------------------------------------------------------------------------
// v0.9.3（A2）：唤醒三级指标挂载（spawn-ok / child-alive / consumed）。
// 判据与实现单一真源在 engine/wake.ts（readWakeTierCounts 读 engine.jsonl 尾部窗口）——
// 本文件只做**统计行**（取数 + payload 块 + 文本行），不复制任何判据。
// 与 capacityMount/offlineMembersMount 同纪律：任何读取意外 → null = 不挂载
// （观测面永不为难任务板）。全零 = 不挂载（没有唤醒发生过，不必占一行）。
// ---------------------------------------------------------------------------

interface WakeTierMount {
  payload: Record<string, unknown>;
  line: string;
}

async function wakeTierMount(deps: ToolDeps): Promise<WakeTierMount | null> {
  try {
    const counts = await readWakeTierCounts(deps.stateRoot);
    if (counts.spawnOk === 0 && counts.childAlive === 0 && counts.consumed === 0) return null;
    return {
      payload: {
        wake: {
          spawnOk: counts.spawnOk,
          childAlive: counts.childAlive,
          consumed: counts.consumed,
          windowBytes: counts.windowBytes,
          windowMs: counts.windowMs,
        },
      },
      line: wakeTierCountsLine(counts),
    };
  } catch {
    return null;
  }
}

export const OverviewShape = {
  view: z.enum(["team", "peers", "panel", "timeline", "status"]).optional().describe(
    "缺省 team：任务板+成员+未读；peers：本机可寻址 peer 清单；panel：self+peers+members+tasks+入站策略+容量+停滞；"
    + "timeline：引擎日志时间线（ts 降序；limit 缺省 20 上限 100，offset=自最新往回跳过 N 条的位置游标，预算截断披露+续读指针，跳过行计 skippedEvents，尾窗截断每页披露 olderEventsOmitted）；"
    + "status：紧凑状态视图（任务七态计数/stalled/容量色+水位/离线成员/checkpoint 年龄/未读数，替代状态栏）",
  ),
  history: z.boolean().optional().describe("附 lead 角色变更史（R-7）"),
  offset: z.number().int().min(0).optional().describe(
    "分页起点：team=任务板自头部偏移；peers=清单自头部偏移；timeline=自最新往回跳过 N 条的位置游标（语义不同，防误用；实时追加下会漂移）",
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
        // v0.8.1（C4-F2）：阈值解析三态一次算完（clamped 钳制 / fellBack 非法回落），
        // 与 offline 家族同款两级披露（payload 键 + WARNING）——0/负数/非数字不再静默。
        const stall = stallThresholdMs(deps.env, staleThresholdMsFromEnv(deps.env));
        const stalled = team !== undefined ? stalledTasks(team.tasks, now, stall.ms) : [];
        const stallClamped = team !== undefined && stall.clamped;
        const stallFellBack = team !== undefined && stall.fellBack;

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
        // v0.9（G-9）：只读 peer 扫描一次（offline 判死 + 成员活性两处共用），
        // 成员活性挂载同纪律（读失败只丢观测块）。
        const peerScan = team !== undefined ? await scanPeersSafe(deps, now) : null;
        const offlineMount = team !== undefined ? await offlineMembersMount(deps, team, now, peerScan) : null;
        const liveness = team !== undefined ? await livenessMount(deps, team, now, peerScan) : null;
        // v0.9.3（A2）：唤醒三级指标计数（engine.jsonl 尾部窗口；无唤醒不挂载）。
        const wakeTiers = await wakeTierMount(deps);
        // v0.9.1 r4（V090-01 观测，V090-GUIDANCE-R4）：清扫豁免连续 defer 的**累计期数**
        // （「豁免 N×阈值」）——与 sweepOwnerGuard 同一证言读取路径（livenessMount.witness），
        // lead 在任务板可见异常长豁免（自述 running 但证言缺失/陈旧另在豁免审计留痕）。
        // 只对 SWEEPABLE 且已超阈的任务计算；无豁免任务的板面形状不变。
        const exemptPeriods = new Map<string, { periods: number; reason: SweepOwnerGuard }>();
        if (team !== undefined && liveness !== null) {
          const staleMs = staleThresholdMsFromEnv(deps.env);
          for (const t of team.tasks) {
            if (!SWEEPABLE_TASK_STATUSES.includes(t.status)) continue;
            if (t.assignee === null || now - t.updatedAt <= staleMs) continue;
            const guard = sweepOwnerGuard(liveness.witness.get(t.assignee), now, staleMs);
            if (guard === null) continue;
            exemptPeriods.set(t.id, {
              periods: Math.max(1, Math.floor((now - t.updatedAt) / staleMs)),
              reason: guard,
            });
          }
        }
        const rollbackWarnings: string[] = [];
        const payload = {
          ...snapshot,
          // r4（V090-01 观测）：豁免期数进任务板行（机器可读；仅被豁免的超阈任务带）。
          tasks: windowedTasks.map((t) => {
            const exempt = exemptPeriods.get(t.id);
            return exempt === undefined
              ? t
              : { ...t, sweepExemptPeriods: exempt.periods, sweepExemptReason: exempt.reason };
          }),
          ...(args.history === true && team !== undefined
            ? {
                // v0.8.1（M05 收口）：与同一 payload 的 members[].isLead（leadKeyOf 兜底）
                // 及 status 视图的 leadKey 同源——直读 team.leadKey 会在无显式 lead 时
                // 给 null，而 isLead 又按 founder 判 true，同一块自相矛盾（29 红队 M05
                // 的同类形态）。leadSince/leadHistory 仍是原始字段（无显式 lead 时
                // leadSince=null，属「角色未显式移交」的真实事实）。
                leadKey: leadKeyOf(team) ?? null,
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
          members: team !== undefined
            ? snapshot.members.map((m) => ({
                ...m,
                isLead: m.key === leadKeyOf(team),
                // v0.9（G-9）：成员行暴露活性（三视图统一口径 {state, stateAgeMin, lastEventAgeMin}）。
                ...(liveness?.views.get(m.key) !== undefined ? { liveness: liveness.views.get(m.key) } : {}),
              }))
            : snapshot.members,
          // v0.9（G-9）挂载点：liveness 三态计数（成员行已逐个带 liveness 细节）。
          ...(liveness !== null ? { liveness: { ...liveness.counts } } : {}),
          // C5 挂载点：stalled / 建议行 / 阈值钳制 WARNING / v0.8.1（C4-F2）非法回落披露。
          ...(stalled.length > 0 || stallClamped || stallFellBack
            ? {
                stalled: stalled.map((flag) => ({ ...flag, suggestion: stallSuggestion(flag.kind, flag.status) })),
                ...(stallClamped ? { stalledThresholdClamped: true } : {}),
                ...(stallFellBack ? { stalledThresholdFallback: true } : {}),
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
          // v0.9.3（A2）挂载点：唤醒三级指标计数（spawn-ok / child-alive / consumed）。
          ...(wakeTiers !== null ? wakeTiers.payload : {}),
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
        // v0.8.1（C4-F2 修复）：非法值（0/负数/非数字）不再静默回落——与 offline 家族
        // （v0.7.2 C8-B4）同款两级披露：payload stalledThresholdFallback + 本 WARNING。
        if (stallFellBack) {
          rollbackWarnings.push(
            "WARNING XC_STALL_MINUTES 非法（须为有限正数；0/负数/非数字不被接受）——已回落内置缺省 120min（stall 检测本身按缺省值正常交付）；如只想用缺省值请取消该 env 设置",
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
          // v0.9（G-9）：活性计数行（成员细节在 payload members[].liveness）。
          + (liveness !== null ? `\n${livenessTextLine(liveness.counts)}` : "")
          // v0.9.3（A2）：唤醒三级指标计数行（spawn-ok / child-alive / consumed）。
          + (wakeTiers !== null ? `\n${wakeTiers.line}` : "")
          // r4（V090-01 观测）：豁免期数文本行（任务板对人可见「豁免 N×阈值」）。
          + (exemptPeriods.size > 0
            ? `\nExempt: ${[...exemptPeriods].map(([id, ex]) => `${id}(${ex.reason}, 豁免 ${ex.periods}×阈值)`).join(", ")}`
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
    return timelineView(deps, args, connectionKey);
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
  // v0.9（G-9）：team 读数与活性只读扫描**先于** services.agents()——agents() 的
  // 花名解析走全量 scanPeers（惰性清扫死记录），其后补扫会让 pid-dead 判据因记录
  // 刚被清掉而失真（先扫 = panel 与 team/status 在同一份注册表快照上判死）。
  const team = await readTeam(deps.stateRoot, "default");
  const now = Date.now();
  const peerScanPre = team !== undefined ? await scanPeersSafe(deps, now) : null;
  const liveness = team !== undefined ? await livenessMount(deps, team, now, peerScanPre) : null;
  const services = getPeerServices(deps);
  const panel = await services.agents();
  // v0.5.2（SCALE-1 修复）：观测面板接入注入预算（peers 行窗口化 + 续读指针）。
  const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
  const fixed = JSON.stringify({ ...panel, peers: [] }).length + 64;
  const peerCosts = panel.peers.map((row) => JSON.stringify(row).length);
  const shownPeers = batchWindowCount(peerCosts, Math.max(0, budget.total - fixed));
  const peersTruncated = shownPeers < panel.peers.length;
  const windowed = { ...panel, peers: panel.peers.slice(0, shownPeers) };
  // C5 挂载：panel 附 stalled 摘要（team 视图同源计算；team/now 即方法头的同一读数）。
  const stalled = team !== undefined
    ? stalledTasks(team.tasks, now, stallThresholdMs(deps.env, staleThresholdMsFromEnv(deps.env)).ms)
    : [];
  const stalledLine = stalled.length > 0
    ? `stalled: ${stalled.map((f) => `${f.taskId}(${f.kind}, idle ${f.idleForMin}min → ${stallSuggestion(f.kind, f.status)})`).join(", ")}`
    : "stalled: (none)";
  // v0.9（G-9）：panel 成员行同样暴露活性（与 team 视图同一 livenessMount 口径；
  // dead 判据不可用时降级为记录状态呈现——观测面永不崩）。
  const panelWithLiveness = {
    ...panel,
    members: panel.members.map((m) => ({
      ...m,
      ...(liveness?.views.get(m.key) !== undefined ? { liveness: liveness.views.get(m.key) } : {}),
    })),
  };
  // C3 挂载（M6）：panel 同样携带 capacity 块（采样失败只丢观测块）。
  const capacity = await capacityMount(deps);
  // v0.9.3（A2）：唤醒三级指标计数（panel 与 team/status 同源同形）。
  const wakeTiers = await wakeTierMount(deps);
  // v0.9.2（C4）：任务计数文本与 payload **同源**——同一份 `panel.tasks` 七态计数渲染，
  // 不再有「文本三桶 / payload 七态」两套口径（与 status 视图 tasks 行同格式，可对账）。
  const tasksLine = `tasks: ${TASK_STATUSES.map((s) => `${s} ${panel.tasks[s] ?? 0}`).join(' / ')}`;
  const panelLines = [
    panel.self !== undefined ? `self: ${panel.self.name} (${panel.self.status ?? "unknown"})` : "self: 未注册",
    `peers: ${panel.peers.length}${peersTruncated ? `（本页列 ${shownPeers}，其余用 xc_overview({view:"peers", offset:${shownPeers}}) 续读）` : ""}`,
    `members: ${panel.members.length}`,
    tasksLine,
    stalledLine,
    // v0.9（G-9）：活性计数行（成员细节在 payload members[].liveness）。
    ...(liveness !== null ? [livenessTextLine(liveness.counts)] : []),
    // v0.9.3（A2）：唤醒三级指标计数行（spawn-ok / child-alive / consumed）。
    ...(wakeTiers !== null ? [wakeTiers.line] : []),
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
      members: panelWithLiveness.members,
      ...(liveness !== null ? { liveness: { ...liveness.counts } } : {}),
      ...(wakeTiers !== null ? wakeTiers.payload : {}),
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
 * view:"timeline"：引擎日志时间线（ts 降序）。core/timeline.ts 自持尾部窗口读
 * （256 KiB，窗口首行丢弃防半行；坏行/形状不符行跳过并计数披露 skippedEvents）；
 * limit 缺省 20/上限 100（钳制披露 limitClamped）；offset = 自最新往回跳过 N 条
 * （与板面偏移语义不同，describe 已写明；**位置游标**——实时追加下会漂移，截断
 * 尾注与 PROTOCOL §14.4 双面披露）；预算开窗超限给 truncated + 续读指针；
 * 文件被尾窗截断 ⇒ 每页披露 tailWindowBytes/olderEventsOmitted。
 * v0.8.1（C3-B8）：预算刻度优先取调用方经 identify 逐会话声名的 contextChars
 * （PROTOCOL §8 逐会话覆盖），回落 env XC_CONTEXT_CHARS/200k。
 */
export async function timelineView(deps: ToolDeps, args: OverviewArgs, connectionKey: string): Promise<ToolResult> {
  return runCore(deps.stateRoot, async () => {
    const budget = receiverInjectBudget(
      (await callerDeclaredContextChars(deps, connectionKey)) ?? contextCharsFromEnv(deps.env),
      deps.env,
    );
    const result = await readTimeline(engineLogFile(deps.stateRoot), {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      budgetChars: budget.total,
    });
    // v0.8.1（C3-B4）：文本视图控制字符清洗（JSON payload 保持原值）。
    const lines = result.events.map(
      (e) =>
        `${new Date(e.ts).toISOString()} | ${timelineTextField(e.event)} | ${e.family} | ${timelineTextField(e.actor ?? "-")} | ${timelineTextField(e.taskId ?? "-")} | ${timelineTextField(e.summary)}`,
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
        + `——用 xc_overview({view:"timeline", offset:${result.truncated.shown}}) 续读]`
        // v0.8.1（C3-B7）：位置游标语义披露——offset 是「自最新往回跳过 N 条」，
        // 日志实时追加时跳号/重叠都可能发生（静态日志下精确）。
        + `[续读 offset 为位置游标（自最新往回跳过 N 条）：期间若有新事件追加，可能跳号或重叠]`,
      );
    }
    if (result.olderEventsOmitted === true) {
      parts.push(
        `[尾部窗口 ${result.tailWindowBytes ?? 0} 字节：更早事件未读入（olderEventsOmitted）`
        + `——引擎日志无上界，时间线只保最近窗口]`,
      );
    }
    // v0.8.1（C3-B3）：跳过披露——坏行/形状不符行不计入 total，此处显式留数。
    if (result.skippedEvents !== undefined && result.skippedEvents > 0) {
      parts.push(
        `[窗口内 ${result.skippedEvents} 行未能归一化（坏行/缺 ts/缺 event）已跳过——total 只计成功事件]`,
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
      ...(result.skippedEvents !== undefined ? { skippedEvents: result.skippedEvents } : {}),
      ...(result.tailWindowBytes !== undefined ? { tailWindowBytes: result.tailWindowBytes } : {}),
      ...(result.olderEventsOmitted !== undefined ? { olderEventsOmitted: result.olderEventsOmitted } : {}),
    });
  });
}

/**
 * v0.8.1（C3-B8）：调用方经 xc_identify 逐会话声名的 contextChars（落 peer 注册
 * 记录的 `contextChars` 字段）——timeline 预算刻度优先取它，取不到回落
 * env XC_CONTEXT_CHARS/200k（PROTOCOL §8「成员/peer 可在 identify 时用 contextChars
 * 逐会话覆盖声明值」；v0.8.0 的 timeline 只认 env，逐会话声明被忽略）。
 *
 * 解析：连接绑定身份的 sessionId（队内轴）→ 本进程 peer 会话上下文（peer 轴）
 * → 只读扫描 peer 注册表（sweep:false）按 sessionId 取记录。任何意外
 * （未注册/扫描失败/记录无声明）→ undefined（回落 env；误声明只影响刻度，
 * 安全方向 = 多截断，观测面永不为难）。
 */
async function callerDeclaredContextChars(deps: ToolDeps, connectionKey: string): Promise<number | undefined> {
  try {
    const sessionId = identityStore.get(connectionKey)?.sessionId ?? getPeerSessionContext()?.sessionId;
    if (sessionId === undefined) return undefined;
    const scan = await scanPeers(peerRootFromEnv(deps.env), Date.now(), { sweep: false });
    const rows = [...scan.active, ...scan.dead.map((row) => row.record)];
    const mine = rows.find((record) => record.sessionId === sessionId);
    const declared = mine?.contextChars;
    return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0
      ? declared
      : undefined;
  } catch {
    return undefined;
  }
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

/**
 * 检查点年龄展示：**精确分钟**（`Nmin前`；无检查点 → `(none)`）。
 * v0.8.1（C5-BUG-C5-02 修复）：旧实现按 min/h/d 阶梯向下取整（26h → 「1d前」=1440min），
 * 与 handoff 文本面的精确 ageMin（「1560min 前」）跨面粒度不一致——同一事实两种粒度。
 * PROTOCOL §14.5 散文本就承诺「年龄 min 前」；现在 status 文本 / handoff 文本 / 两视图
 * payload 的 ageMin 三者同值同粒度。
 */
function formatCheckpointAge(ageMin: number | null): string {
  if (ageMin === null) return "(none)";
  return `${ageMin}min前`;
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
 * 不谎报 GREEN；RED 附 C9 原句 COMPRESS_ADVICE_LINE）；checkpoint 年龄 = now − front-matter
 * createdAt（缺失/不可解析回退 mtime——C2-B4：外部拷贝/还原后 mtime 与产品事实分歧），
 * 文本按精确分钟渲染（C5-BUG-C5-02：与 handoff 同粒度，不再按天向下取整）；
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
        liveness: { running: 0, idle: 0, dead: 0, byMember: {} },
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
    // C9 建议行按前缀定位（不取末行）：v0.8.1（C4-O1）起水位越界 WARNING 也可能挂在
    // 容量行之后，末行不再恒为 compress-advice。
    const capacityAdvice = capacity !== null && capacityPayload?.["red"] === true
      ? capacity.lines.find((line) => line.startsWith("compress-advice:")) ?? null
      : null;
    // v0.8.1（C4-O1）：水位阈值越界回落标记（capacityMount 已附 WARNING 行；status 的
    // 紧凑容量行只取 lines[0]，故 WARNING 走 extraWarnings 通道，文本层不丢）。
    const watermarkFellBack = capacityPayload?.["memWarnWatermarkFallback"] === true;

    // C8 离线成员挂载（复用；null = 扫描意外，不猜）
    // v0.9（G-9）：同一只读扫描供成员活性挂载（dead 判据同源；文本行序冻结——
    // status 的活性只在 payload liveness 块，成员级细节在 byMember）。
    const peerScan = await scanPeersSafe(deps, now);
    const offlineMount = await offlineMembersMount(deps, team, now, peerScan);
    const offlineCount = offlineMount === null ? null : offlineMount.members.length;
    const liveness = await livenessMount(deps, team, now, peerScan);
    // v0.9.3（A2）：唤醒三级指标计数。status 的文本行序归 render.ts（本组只碰统计行），
    // 故此处**只进 payload**（team/panel 两视图的文本行已挂，三视图 payload 同源同形）。
    const wakeTiers = await wakeTierMount(deps);

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
    // v0.8.1（C4-F1 修复）：offline 家族的阈值披露补齐 payload 键（team 视图早有；
    // status 此前只有文本 WARNING——两视图机器可读面不对称）。
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
    // v0.8.1（C4-F2 修复）：stall 家族两级披露拉齐——钳制/非法回落都附 WARNING
    // （此前 status 只有 payload 键、无 WARNING；offline 反之——现在两家族同形）。
    if (stall.clamped) {
      extraWarnings.push(
        "WARNING XC_STALL_MINUTES 低于僵尸清扫阈值（XC_STALE_TASK_MINUTES）——stall 阈值已按 stale 阈值钳制（无在途唤醒的死任务会先被清扫回池，stall 面轮不到展示）",
      );
    }
    if (stall.fellBack) {
      extraWarnings.push(
        "WARNING XC_STALL_MINUTES 非法（须为有限正数；0/负数/非数字不被接受）——已回落内置缺省 120min（stall 检测本身按缺省值正常交付）；如只想用缺省值请取消该 env 设置",
      );
    }
    // v0.8.1（C4-O1 修复）：容量水位预警线越界的回落披露（与 capacityMount 同句）。
    if (watermarkFellBack) extraWarnings.push(MEM_WATERMARK_FALLBACK_WARNING);
    if (extraWarnings.length > 0) final.text = `${final.text}\n${extraWarnings.join("\n")}`;

    return okResult(final.text, {
      teamId,
      phase: team.phase,
      leadKey: renderInput.leadKey,
      members: { total: team.members.length, offline: offlineCount },
      // v0.9（G-9）：活性块（三视图统一口径；byMember = status 无成员行文本的
      // 成员行等价物，值形状与 team/panel 的 members[].liveness 完全一致）。
      liveness: {
        ...liveness.counts,
        byMember: Object.fromEntries(liveness.views),
      },
      taskCounts: counts,
      stalled: stalled.length,
      // v0.9.3（A2）：唤醒三级指标计数块（team/panel 文本行同源；status 文本行序归 render.ts）。
      ...(wakeTiers !== null ? wakeTiers.payload : {}),
      ...(stall.clamped ? { stalledThresholdClamped: true } : {}),
      ...(stall.fellBack ? { stalledThresholdFallback: true } : {}),
      ...(offlineMount !== null && offlineMount.clamped ? { offlineThresholdClamped: true } : {}),
      ...(offlineMount !== null && offlineMount.fellBack ? { offlineThresholdFallback: true } : {}),
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
    "Observation snapshot (task board / members / peers / capacity / stall in one tool). view=team (default): members with isLead + session liveness (running/idle/dead + livenessSources 四判据来源, PROTOCOL §12.4), priority-ordered task board (budget-windowed with boardTruncated pointer), unread counts, orphan/stale-receipt warnings, stalled flags (C5); " +
    "history:true appends leadHistory; view=peers: addressable cross-session peers (self/member/session rows, rowsTruncated pointer); " +
    "view=panel: self + peers + members (+ liveness per member row, 含 livenessSources) + task counts + inbound policy; " +
    "view=timeline: engine.jsonl timeline ordered by ts descending (limit defaults 20, max 100 with limitClamped disclosure; offset is a positional cursor skipping back N from the newest event — drifts under live appends; budget window with truncated pointer; skippedEvents counts unnormalizable lines; olderEventsOmitted disclosed on every page when the tail window truncates the file); " +
    "view=status: compact status block (task counts by status / stalled / capacity level + watermark / offline members / member liveness in payload liveness block / checkpoint ages / unread counts — the no-statusline substitute). Does not require registration; writes snapshot.json (always the full board) only for view=team.";
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> =>
    handleOverview(deps, args as unknown as OverviewArgs, connectionKeyOf(extra));
  server.tool("xc_overview", description, OverviewShape, handler);
  registry.set("xc_overview", { description, shape: OverviewShape, handler });
}
