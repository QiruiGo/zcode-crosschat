/**
 * v0.8.0 A2（DESIGN-V0.8.md §4）：接手包（handoff packet）——七要素组装 + 4000 字符
 * 预算降级序列 + id 三视角过滤。**纯函数模块**：now 与全部数据由调用方（MCP 工具层
 * `xc_read({scope:"handoff"})`）注入，本模块无 I/O、无时钟、无 env 解析。
 *
 * 七要素（payload 键冻结，与方案 §2 A2 逐条对应）：identity / tasks / pool / unread /
 * capacity / checkpoint / suggestions。文本面 = 同构七章紧凑渲染（与 checkpoint 的
 * 七章同构便于对照），末行按预算披露截断（未超限不披露）。
 *
 * 预算纪律（§4.3，验收 AC2「超预算有截断标注」）：
 * - `HANDOFF_BUDGET_CHARS = 4000`（代码常量，不进配置）；
 * - 先按基础帽渲染（tasks ≤5 / pool ≤10 / unread.top ≤5 / suggestions ≤5 / subject
 *   80 字符），基础帽生效时文本内披露；
 * - 超限走**固定降级序列**（逐步重算、命中即停）：pool 整章 → unread 计数行 →
 *   tasks 首条 → suggestions 首条 → 整体硬截；
 * - 每级留名：payload `truncated: {budgetChars, shownChars, droppedSections,
 *   cappedItems}`——**静默丢弃 = 验收失败**。
 *
 * id 三视角七要素冻结语义（§4.1 表）：tasks 按视角过滤；pool/unread/capacity 的
 * self/task/member 口径差异由本模块的纯函数钉死（selectHandoffTasks /
 * handoffUnreadView），工具层只负责取数。
 *
 * @module core/handoff
 */
import type { MemberRole, MemberState, Task, TaskPriority, TaskStatus, TeamMessage, TeamState } from './types.js';
import { OPEN_TASK_STATUSES } from './types.js';
import { memberOpenTasks } from './teamstate.js';
import { urgentFirst } from './mailbox.js';
import { lastProgressTs, stallSuggestion, type StallFlag } from './stall.js';
import { COMPRESS_ADVICE_LINE } from './capacity.js';
import { sanitizeKey } from './sanitize.js';
import { checkpointUnreadRef, type CapacityLevel } from './checkpoint.js';

// ---------------------------------------------------------------------------
// 常量（代码常量，无 env——「不新增必填配置」纪律）
// ---------------------------------------------------------------------------

/** 接手包文本预算（§4.3；方案 §2 A2「默认预算 ≤4000 字符」）。 */
export const HANDOFF_BUDGET_CHARS = 4000;
/** 基础帽：文本面 tasks 章最多列几条（payload 仍给全量）。 */
export const HANDOFF_TASKS_MAX = 5;
/** 基础帽：待领池列前 N（数据源级，与 checkpoint 第 3 章同口径）。 */
export const HANDOFF_POOL_MAX = 10;
/** 基础帽：未读 top 条数（§4.2）。 */
export const HANDOFF_UNREAD_MAX = 5;
/** 基础帽：建议下一步条数（§4.2 ≤5）。 */
export const HANDOFF_SUGGESTIONS_MAX = 5;

// ---------------------------------------------------------------------------
// 类型（input = 工具层注入的数据；payload = 冻结的七要素面）
// ---------------------------------------------------------------------------

/** 视角（§4.1）：self=我自己的包；task=单任务视角；member=某成员的活儿视角。 */
export type HandoffFilter =
  | { kind: 'self' }
  | { kind: 'task'; id: string }
  | { kind: 'member'; id: string };

export interface HandoffIdentity {
  agentKey: string;
  teamId: string;
  /** null = 无显式 lead。 */
  leadKey: string | null;
  /** null = 不在花名册（identity 章如实记 (not on roster)）。 */
  role: MemberRole | null;
  memberState: MemberState | null;
  isLead: boolean;
}

export interface HandoffTask {
  taskId: string;
  title: string;
  status: TaskStatus;
  attempt: number;
  assignee: string | null;
  /** epoch ms（stall.ts lastProgressTs 口径）。 */
  lastProgressTs: number;
  blockedReason?: string;
  /** input-only：未终态依赖（建议下一步用；**不进 payload**）。 */
  unmetDependsOn: string[];
  /** input-only：派发受领人（claim 可达性用；**不进 payload**）。 */
  to?: string;
}

export interface HandoffPoolItem {
  taskId: string;
  title: string;
  /** absent = normal（旧记录兼容）。 */
  priority: TaskPriority | undefined;
  dependsOn: string[];
  unmetDependsOn: string[];
  /** input-only：派发受领人（认领可达性用；**不进 payload**）。 */
  to?: string;
}

export interface HandoffUnreadTop {
  msgId: string;
  from: string;
  subject: string;
  /** input-only：[urgent] 标记用；**不进 payload**（payload 只三键）。 */
  urgent: boolean;
}

export interface HandoffUnread {
  count: number;
  urgentCount: number;
  top: HandoffUnreadTop[];
  /** member 视角：主题不跨成员披露（§4.4），只给计数。 */
  withheld?: 'subjects';
}

/** 容量（level 由 core/checkpoint.ts 的推导助手产出——三视图同一口径）。 */
export interface HandoffCapacity {
  watermarkPct: number;
  freeGb: number;
  level: CapacityLevel;
  sampledAt: number;
}

export interface HandoffCheckpoint {
  path: string;
  /** 文件 mtime（epoch ms）。 */
  createdAt: number;
  ageMin: number;
  bytes: number;
}

export interface HandoffInput {
  /** 当前时刻（epoch ms；注入保持纯度）。 */
  now: number;
  filter: HandoffFilter;
  identity: HandoffIdentity;
  /** 已按视角过滤的任务（self=我的开放任务；task=该任务一条；member=该成员开放任务）。 */
  tasks: HandoffTask[];
  /** 待领池（pending ∧ sortTasksForBoard 序前 10；三视角同源）。 */
  pool: HandoffPoolItem[];
  /** pending 总数（披露「待领池共 M 个」用）。 */
  poolTotal: number;
  unread: HandoffUnread;
  /** null = 采样失败（不假装 GREEN；warnings 披露）。 */
  capacity: HandoffCapacity | null;
  /** null = 无检查点（视角内目标目录最新一份缺失）。 */
  checkpoint: HandoffCheckpoint | null;
  /** 视角内任务的停滞旗标（工具层按阈值算好注入）。 */
  stalled: StallFlag[];
  /** 我的在途任务 id（task 视角的单在途规则提示用；self 视角可为 null）。 */
  myOpenTaskId: string | null;
  /** 工具层披露（容量采样失败 / 花名漂移等）；原样进 payload。 */
  warnings?: string[];
}

export interface HandoffTruncation {
  budgetChars: number;
  shownChars: number;
  /** 因预算被略去/缩减的章名（pool/unread/tasks/suggestions/正文）——留名不静默。 */
  droppedSections: string[];
  /** 各章文本面 shown/total（基础帽与降级都记）。 */
  cappedItems: Record<string, { shown: number; total: number }>;
}

/** type 别名（非 interface）：使 payload 可直接赋给 ToolPayload=Record<string, unknown>。 */
export type HandoffPayload = {
  identity: HandoffIdentity;
  tasks: Array<{
    taskId: string;
    title: string;
    status: TaskStatus;
    attempt: number;
    assignee: string | null;
    lastProgressTs: number;
    blockedReason?: string;
  }>;
  pool: Array<{
    taskId: string;
    title: string;
    priority: TaskPriority | undefined;
    dependsOn: string[];
    unmetDependsOn: string[];
  }>;
  unread: { count: number; urgentCount: number; top: Array<{ msgId: string; from: string; subject: string }> };
  capacity: HandoffCapacity | null;
  checkpoint: HandoffCheckpoint | null;
  suggestions: string[];
  filter: HandoffFilter;
  truncated?: HandoffTruncation;
  warnings?: string[];
  /** member 视角在场（§4.4：未读只给计数）。 */
  unreadWithheld?: 'subjects';
};

export interface HandoffAssembly {
  text: string;
  payload: HandoffPayload;
}

// ---------------------------------------------------------------------------
// id 过滤纯函数（§4.1；顺序固定，命中即止）
// ---------------------------------------------------------------------------

/**
 * 解析 handoff 的 `id`（顺序固定）：① taskId 精确命中 → task 视角；
 * ② sanitizeKey(id) 命中花名册 → member 视角；③ 都不是 → undefined
 * （调用方抛 invalid_params 并附 {@link handoffIdCandidates} 候选）。
 */
export function resolveHandoffFilter(id: string | undefined, team: TeamState): HandoffFilter | undefined {
  if (id === undefined || id.trim() === '') return { kind: 'self' };
  if (team.tasks.some((t) => t.id === id)) return { kind: 'task', id };
  const key = sanitizeKey(id);
  if (team.members.some((m) => m.key === key)) return { kind: 'member', id };
  return undefined;
}

/** 非法 id 的可行动候选（至多 10 个 taskId + 至多 10 个花名，两组分列）。 */
export function handoffIdCandidates(team: TeamState): { taskIds: string[]; memberKeys: string[] } {
  return {
    taskIds: team.tasks.slice(0, 10).map((t) => t.id),
    memberKeys: team.members.slice(0, 10).map((m) => m.key),
  };
}

/**
 * 视角内任务选择（§4.1 冻结表）：
 * - self：我的开放任务（OPEN_TASK_STATUSES ∧ assignee=me）；
 * - task：**仅该任务一条**（不限 assignee、不限状态——终态任务也出，供复盘）；
 * - member：该成员的开放任务（OPEN_TASK_STATUSES ∧ assignee=该名）。
 */
export function selectHandoffTasks(filter: HandoffFilter, team: TeamState, me: string): Task[] {
  if (filter.kind === 'self') return memberOpenTasks(team.tasks, me);
  if (filter.kind === 'task') {
    const task = team.tasks.find((t) => t.id === filter.id);
    return task === undefined ? [] : [task];
  }
  return memberOpenTasks(team.tasks, sanitizeKey(filter.id));
}

/**
 * 视角内未读整形（§4.1/§4.2/§4.4）：
 * - self / task：给我的 top 5（task 视角按 `m.taskId === id` 过滤；urgent 优先）；
 * - member：只给 {count, urgentCount, top: []} + `withheld: "subjects"`
 *   （团队观测面本来就只公开各成员未读**计数**——tools-overview 同口径）。
 *
 * @param current 调用方已按新鲜度裁决的未读（未读 ∧ 未丢弃 ∧ isCurrentMail）。
 */
export function handoffUnreadView(filter: HandoffFilter, current: readonly TeamMessage[]): HandoffUnread {
  const scoped = filter.kind === 'task' ? current.filter((m) => m.taskId === filter.id) : current;
  const urgentCount = scoped.filter((m) => m.urgent === true).length;
  if (filter.kind === 'member') {
    return { count: scoped.length, urgentCount, top: [], withheld: 'subjects' };
  }
  const top = urgentFirst(scoped)
    .slice(0, HANDOFF_UNREAD_MAX)
    .map((m) => {
      const ref = checkpointUnreadRef(m); // subject 遮蔽 tool_request + 截 80 字符（与 checkpoint 第 5 章同源）
      return { msgId: ref.msgId, from: ref.from, subject: ref.subject, urgent: ref.urgent };
    });
  return { count: scoped.length, urgentCount, top };
}

// ---------------------------------------------------------------------------
// 建议下一步（§4.1 三视角语义；纯函数拼装，指令必须指向真实可达路径——C9-B5 纪律）
// ---------------------------------------------------------------------------

/** 池里第一个**可认领**项（pending 且依赖满足且无他人受领指定）；无则 null。 */
function firstClaimable(pool: readonly HandoffPoolItem[], me: string): string | null {
  for (const p of pool) {
    if (p.unmetDependsOn.length > 0) continue;
    if (p.to !== undefined && p.to !== me) continue;
    return p.taskId;
  }
  return null;
}

function buildHandoffSuggestions(input: HandoffInput): string[] {
  const me = input.identity.agentKey;
  const flagById = new Map(input.stalled.map((f) => [f.taskId, f]));
  const items: string[] = [];
  for (const t of input.tasks) {
    const flag = flagById.get(t.taskId);
    if (flag !== undefined) {
      items.push(`${t.taskId}：${flag.status} 超 ${flag.idleForMin}min → ${stallSuggestion(flag.kind, flag.status)}`);
    } else if (t.status === 'blocked') {
      items.push(`${t.taskId}：blocked → 处理阻塞原因（xc_team unblock）或 cancel`);
    }
    if (t.unmetDependsOn.length > 0) {
      items.push(`${t.taskId}：依赖 ${t.unmetDependsOn.join(', ')} 未终态 → 等待项（dependsOn 未满足）`);
    }
    if (input.filter.kind === 'task') {
      // 单任务视角：按任务真实状态给可达指引——不得给出走不通的指令（C9-B5）。
      if (OPEN_TASK_STATUSES.includes(t.status) && t.assignee !== null && t.assignee !== me) {
        items.push(
          `${t.taskId}：他人（${t.assignee}）${t.status} 中 → 需 xc_identify({takeover:true}) 接管`
          + `或等 stale 清扫回池后再 claim（现在 claim 会得 task_not_pending）`,
        );
      } else if (t.status === 'pending' && t.to !== undefined && t.to !== me) {
        items.push(`${t.taskId}：受领人为 ${t.to}（xc_dispatch 指定）——你 claim 会被拒（not_assignee）`);
      } else if (t.status === 'pending' && t.unmetDependsOn.length === 0) {
        const rule = input.myOpenTaskId !== null
          ? `（注意单在途任务规则：先 xc_report 收尾 ${input.myOpenTaskId}）`
          : '';
        items.push(`${t.taskId}：pending 且依赖已满足 → 可 xc_claim({taskId:"${t.taskId}"})${rule}`);
      }
    }
  }
  if (input.filter.kind === 'self') {
    if (input.capacity?.level === 'RED') items.push(COMPRESS_ADVICE_LINE);
    const claimable = firstClaimable(input.pool, me);
    if (input.tasks.length > 0) {
      if (claimable !== null) {
        items.push(`单在途任务规则：先 xc_report 收尾当前任务（${input.tasks[0]!.taskId}）再认领 ${claimable}`);
      }
    } else if (claimable !== null) {
      items.push(`无在途任务且有待领 → 可认领 ${claimable}（pending 且依赖已满足）`);
    }
  }
  if (input.filter.kind === 'member' && input.tasks.length === 0) {
    return ['（该成员无开放任务）'];
  }
  if (items.length === 0) return ['（暂无：按 journal 指针继续）'];
  const shown = items.slice(0, HANDOFF_SUGGESTIONS_MAX);
  if (items.length > shown.length) shown.push(`（另有 ${items.length - shown.length} 条建议略去）`);
  return shown;
}

// ---------------------------------------------------------------------------
// 小工具（折行 / 相对分钟 / ISO；与 checkpoint 渲染层同口径）
// ---------------------------------------------------------------------------

function foldLine(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function relMinutes(now: number, then: number): number {
  return Math.max(0, Math.round((now - then) / 60_000));
}

function isoTs(ts: number): string {
  return new Date(ts).toISOString();
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// 七章渲染 + 预算降级序列（§4.3）
// ---------------------------------------------------------------------------

type DegradeLevel = 0 | 1 | 2 | 3 | 4 | 5;

interface RenderedBody {
  body: string;
  dropped: string[];
  capped: Record<string, { shown: number; total: number }>;
}

function viewLine(filter: HandoffFilter): string {
  if (filter.kind === 'task') return `视角：task ${filter.id}`;
  if (filter.kind === 'member') return `视角：member ${filter.id}`;
  return '视角：self';
}

function chapter2Title(filter: HandoffFilter): string {
  if (filter.kind === 'task') return `## 2. 任务 ${filter.id}`;
  if (filter.kind === 'member') return `## 2. 成员 ${filter.id} 的开放任务`;
  return '## 2. 我的任务';
}

function emptyTasksLine(filter: HandoffFilter): string {
  if (filter.kind === 'member') return '（该成员无开放任务）';
  if (filter.kind === 'task') return '（该任务不存在——不应到达：resolveHandoffFilter 已命中）';
  return '（无进行中任务）';
}

function taskRow(t: HandoffTask, now: number): string {
  const progress = `${isoTs(t.lastProgressTs)}（${relMinutes(now, t.lastProgressTs)}min 前）`;
  const reason = t.status === 'blocked' && typeof t.blockedReason === 'string' && t.blockedReason.trim() !== ''
    ? `（阻塞原因：${foldLine(t.blockedReason)}）`
    : '';
  return `- ${t.taskId} | ${t.status} | ${foldLine(t.title)} | attempt ${t.attempt} | 最后进展 ${progress}${reason}`;
}

function poolRow(p: HandoffPoolItem): string {
  const deps = p.dependsOn.length === 0
    ? '-'
    : p.dependsOn.map((d) => (p.unmetDependsOn.includes(d) ? `${d}!` : d)).join(', ');
  return `- ${p.taskId} | ${p.priority ?? 'normal'} | ${foldLine(p.title)} | 依赖 ${deps}`;
}

function unreadRow(top: HandoffUnreadTop): string {
  return `- ${top.urgent ? '[urgent] ' : ''}${top.from} | ${top.subject}（${shortId(top.msgId)}）`;
}

function checkpointEmptyLine(input: HandoffInput): string {
  if (input.filter.kind === 'task') {
    const assignee = input.tasks[0]?.assignee ?? null;
    if (assignee === null) return '（该任务无受领人：无检查点可引）';
    return `（受领人 ${assignee} 尚无检查点：/xc-checkpoint 可一键落盘）`;
  }
  if (input.filter.kind === 'member') return '（该成员尚无检查点：/xc-checkpoint 可一键落盘）';
  return '（无检查点：/xc-checkpoint 可一键落盘）';
}

/** 固定降级序列的某一级渲染（body 不含截断尾行；尾行由 compose 拼）。 */
function renderBody(input: HandoffInput, level: DegradeLevel, suggestions: readonly string[]): RenderedBody {
  const droppedSet = new Set<string>();
  const capped: Record<string, { shown: number; total: number }> = {};
  const lines: string[] = [];

  lines.push(viewLine(input.filter));

  // 1. 身份（最小集，永不被降级）
  const id = input.identity;
  lines.push('## 1. 身份');
  lines.push(
    `- agent: ${id.agentKey} | team: ${id.teamId} | lead: ${id.leadKey ?? '(none)'}`
    + ` | role: ${id.role ?? '(not on roster)'} | state: ${id.memberState ?? '(not on roster)'} | isLead: ${id.isLead}`,
  );

  // 2. 任务（L3 降级：只留第 1 条）
  lines.push(chapter2Title(input.filter));
  if (input.tasks.length === 0) {
    lines.push(emptyTasksLine(input.filter));
  } else {
    const shownCount = level >= 3 ? 1 : Math.min(HANDOFF_TASKS_MAX, input.tasks.length);
    for (const t of input.tasks.slice(0, shownCount)) lines.push(taskRow(t, input.now));
    const omitted = input.tasks.length - shownCount;
    if (omitted > 0) lines.push(`（另有 ${omitted} 条任务略去）`);
    capped.tasks = { shown: shownCount, total: input.tasks.length };
    if (level >= 3) droppedSet.add('tasks');
  }

  // 3. 待领池（L1 降级：整章一行）
  if (level >= 1) {
    lines.push('## 3. 待领池');
    lines.push(`（待领池按 ${HANDOFF_BUDGET_CHARS} 字符预算略去：xc_overview 看板）`);
    droppedSet.add('pool');
    capped.pool = { shown: 0, total: input.poolTotal };
  } else {
    lines.push('## 3. 待领池（前 10，priority → createdAt）');
    const shown = input.pool.slice(0, HANDOFF_POOL_MAX);
    if (input.pool.length === 0) {
      lines.push('（待领池为空）');
    } else {
      for (const p of shown) lines.push(poolRow(p));
      if (input.poolTotal > shown.length) {
        lines.push(`（待领池共 ${input.poolTotal} 个，列前 ${shown.length}）`);
      }
      if (input.poolTotal > shown.length) capped.pool = { shown: shown.length, total: input.poolTotal };
    }
  }

  // 4. 未读（L2 降级：计数行；top 防御性截到基础帽——调用方理应已截）
  const topShown = input.unread.top.slice(0, HANDOFF_UNREAD_MAX);
  if (level >= 2) {
    lines.push('## 4. 未读');
    lines.push(
      `- 未读 ${input.unread.count} 条（urgent ${input.unread.urgentCount}）`
      + `——主题按 ${HANDOFF_BUDGET_CHARS} 字符预算略去，用 xc_read({scope:"inbox"}) 取`,
    );
    droppedSet.add('unread');
    capped.unreadTop = { shown: 0, total: input.unread.count };
  } else {
    lines.push('## 4. 未读');
    if (input.unread.count === 0) {
      lines.push(input.filter.kind === 'task' ? '（我的箱里没有该任务的未读）' : '（无未读）');
    } else if (topShown.length === 0) {
      lines.push(`- 未读 ${input.unread.count} 条（urgent ${input.unread.urgentCount}）（主题不跨成员披露）`);
    } else {
      for (const t of topShown) lines.push(unreadRow(t));
      if (input.unread.count > topShown.length) {
        lines.push(`（另有 ${input.unread.count - topShown.length} 条未读，xc_read({scope:"inbox"}) 消费）`);
        capped.unreadTop = { shown: topShown.length, total: input.unread.count };
      }
    }
  }

  // 5. 容量（永不被降级——「接手」最小集）
  lines.push('## 5. 容量');
  if (input.capacity === null) {
    lines.push('- （容量采样失败——不按 GREEN 呈现；warnings 见 payload）');
  } else {
    const c = input.capacity;
    lines.push(
      `- ${c.level} | 水位 ${c.watermarkPct.toFixed(1)}% 可用 | free ${c.freeGb.toFixed(2)} GB`
      + ` | sampledAt ${isoTs(c.sampledAt)}`,
    );
  }

  // 6. 最近检查点（永不被降级）
  lines.push('## 6. 最近检查点');
  if (input.checkpoint === null) {
    lines.push(checkpointEmptyLine(input));
  } else {
    const cp = input.checkpoint;
    lines.push(`- ${isoTs(cp.createdAt)}（${cp.ageMin}min 前，${cp.bytes} bytes）: ${cp.path}`);
  }

  // 7. 建议下一步（L4 降级：只留第 1 条）
  lines.push('## 7. 建议下一步');
  if (level >= 4) {
    lines.push(`- ${suggestions[0] ?? '（暂无：按 journal 指针继续）'}`);
    droppedSet.add('suggestions');
    capped.suggestions = { shown: 1, total: suggestionsTotal(input, suggestions) };
  } else {
    for (const s of suggestions) lines.push(`- ${s}`);
    const raw = suggestionsTotal(input, suggestions);
    const shownCount = suggestions.length - (hasSuggestionDisclosure(suggestions) ? 1 : 0);
    if (shownCount < raw) capped.suggestions = { shown: shownCount, total: raw };
  }

  // droppedSections 按**固定降级序**排列（不是章序）：pool → unread → tasks → suggestions。
  const DROP_ORDER = ['pool', 'unread', 'tasks', 'suggestions'] as const;
  const dropped = DROP_ORDER.filter((name) => droppedSet.has(name));
  return { body: lines.join('\n'), dropped, capped };
}

/** suggestions 的原始条数（含被基础帽/披露行吃掉的部分；用于 cappedItems.total）。 */
function hasSuggestionDisclosure(displayed: readonly string[]): boolean {
  return displayed.some((s) => /^（另有 \d+ 条建议略去）$/.test(s));
}

function suggestionsTotal(input: HandoffInput, displayed: readonly string[]): number {
  // 展示列表可能含「（另有 N 条建议略去）」披露行——total 还原为原始条数。
  const disclosure = displayed.find((s) => /^（另有 \d+ 条建议略去）$/.test(s));
  if (disclosure !== undefined) {
    const m = /^（另有 (\d+) 条建议略去）$/.exec(disclosure);
    const extra = m === null ? 0 : Number(m[1]);
    return displayed.length - 1 + extra;
  }
  if (input.filter.kind === 'member' && input.tasks.length === 0) return 0;
  return displayed.length;
}

/** 截断尾行（§4.3 冻结文案）；L5 = 整体硬截。 */
function compose(body: string, level: DegradeLevel, dropped: readonly string[]): string {
  if (level === 0) return body;
  const names = level === 5 ? [...dropped, '正文'] : [...dropped];
  const marker =
    `[已按 ${HANDOFF_BUDGET_CHARS} 字符预算截断：略去/缩减 ${names.join('、')}；`
    + '全文用 xc_read(scope:"inbox") / xc_overview / xc_read(scope:"task") 取]';
  if (level < 5) return `${body}\n${marker}`;
  const keep = Math.max(0, HANDOFF_BUDGET_CHARS - marker.length - 1);
  return `${body.slice(0, keep)}\n${marker}`;
}

// ---------------------------------------------------------------------------
// 组装入口（纯函数；工具层取数后调用）
// ---------------------------------------------------------------------------

/**
 * 组装接手包（文本 + JSON 双层）。先按基础帽渲染七章；超 4000 字符走固定降级序列
 * （逐步重算、命中即停）：pool → unread → tasks → suggestions → 整体硬截。
 * 每级留名进 payload `truncated`——不静默丢要素（AC2）。
 */
export function assembleHandoff(input: HandoffInput): HandoffAssembly {
  const suggestions = buildHandoffSuggestions(input);
  const levels: DegradeLevel[] = [0, 1, 2, 3, 4, 5];
  let chosen: { level: DegradeLevel; text: string; rendered: RenderedBody } | undefined;
  for (const level of levels) {
    const rendered = renderBody(input, level, suggestions);
    const text = compose(rendered.body, level, rendered.dropped);
    if (text.length <= HANDOFF_BUDGET_CHARS || level === 5) {
      chosen = { level, text, rendered };
      break;
    }
  }
  // levels 非空且 level=5 必然命中 → chosen 一定被赋值（TS 收窄用非空断言）。
  const final = chosen!;
  const { level, text, rendered } = final;

  const unreadTop = input.unread.top
    .slice(0, HANDOFF_UNREAD_MAX)
    .map((t) => ({ msgId: t.msgId, from: t.from, subject: t.subject }));
  const payload: HandoffPayload = {
    identity: input.identity,
    tasks: input.tasks.map((t) => ({
      taskId: t.taskId,
      title: t.title,
      status: t.status,
      attempt: t.attempt,
      assignee: t.assignee,
      lastProgressTs: t.lastProgressTs,
      ...(t.blockedReason !== undefined ? { blockedReason: t.blockedReason } : {}),
    })),
    pool: input.pool.map((p) => ({
      taskId: p.taskId,
      title: p.title,
      priority: p.priority,
      dependsOn: p.dependsOn,
      unmetDependsOn: p.unmetDependsOn,
    })),
    unread: { count: input.unread.count, urgentCount: input.unread.urgentCount, top: unreadTop },
    capacity: input.capacity,
    checkpoint: input.checkpoint,
    suggestions: [...suggestions],
    filter: input.filter,
    ...(level >= 1
      ? {
          truncated: {
            budgetChars: HANDOFF_BUDGET_CHARS,
            shownChars: text.length,
            droppedSections: level === 5 ? [...rendered.dropped, '正文'] : [...rendered.dropped],
            cappedItems: rendered.capped,
          },
        }
      : {}),
    ...(input.warnings !== undefined && input.warnings.length > 0 ? { warnings: [...input.warnings] } : {}),
    ...(input.unread.withheld !== undefined ? { unreadWithheld: input.unread.withheld } : {}),
  };
  return { text, payload };
}
