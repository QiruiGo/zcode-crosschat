/**
 * v0.8.0 A1（DESIGN-V0.8.md §3）：交接检查点（checkpoint）——聚合纯函数 + 服务端落盘
 * + 滚动清理 + 提醒判据。
 *
 * 平台事实（方案 §1）：zcode 3.18.2 **无 PreCompact/PostCompact 钩子**，插件不能
 * 在压缩前自动写检查点。本模块是两级降级方案的第一级「一键落盘」：
 * `xc_team({action:"checkpoint"})` 由 MCP server **服务端直接落盘**（不依赖模型
 * 写文件——模型写文件在上下文一压缩就断，C4 已证明不可靠）；第二级「提醒」见本模块
 * 的 checkpointNudgeDecision / checkpointNudgeState（UserPromptSubmit 钩子注入）。
 *
 * 磁盘形态（§3.2）：
 *
 *   <.crosschat>/checkpoints/<agentKey>/
 *   ├── 2026-11-15T18-00-00-000Z.md   ← 检查点（stamp=ISO8601，"："与 "." 折成 "-"：
 *   │                                   Windows 合法且字典序=时间序）
 *   └── .nudge                         ← 提醒节流标记（内容=上次提醒 ISO 时间）
 *
 * 文件格式（§3.3 冻结）：front-matter **7 键恒现** + 七章固定编号标题。
 *
 * 安全纪律（§3.2/§10 R1）：
 * - `<agentKey>` 一律先过 `sanitizeKey` 再过断言级复核（safeCheckpointSegment，
 *   archive.ts safeSegment 同款防御纵深，自带一份不修改 archive.ts）；路径只许经
 *   core/paths.ts 的四个构建器取出，调用方禁止自行 join。
 * - **checkpoint 文件不自动发给任何会话**：无工具读它、无帧载它、唤醒票据不带它；
 *   未读只抄索引不搬原文（第 5 章），`tool_request` 帧只记门控标记不进原文（R6）。
 *   该目录按项目权限管理（README 威胁模型明示）。
 * - 只写 `<root>/checkpoints/<me>/`：不写 team.json、不进邮箱、不唤醒、不碰锁、
 *   不改任务状态机。
 *
 * 复用点（防三视图口径分裂）：容量 RED/GREEN/UNKNOWN 推导只此一份
 * （capacityViewOf / capacityLevelOf；capacity.ts:283-286 的 CapacityVerdict 没有
 * `level` 字段，handoff/status 视图都 import 本模块的推导助手）；checkpoint 路径与
 * latestCheckpoint 只此一处出，G2 不自行 join。
 *
 * @module core/checkpoint
 */
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { writeFileAtomic, writeFileExclusive } from './atomic.js';
import { sanitizeKey } from './sanitize.js';
import { taskJournalPath } from './archive.js';
import { memberOpenTasks, readTeam, unsatisfiedDependencies } from './teamstate.js';
import { stalledTasks, stallSuggestion, lastProgressTs, type StallFlag } from './stall.js';
import { parseToolFrameType } from './toolrelay.js';
import {
  checkpointDir,
  checkpointFile,
  checkpointNudgeFile,
} from './paths.js';
import { DEFAULT_TEAM_ID, type MemberRole, type MemberState, type Task, type TeamMessage } from './types.js';

// --- 常量（代码常量，不进 userConfig；仅提醒开关走一个 env）--------------------

/** 每 agent 保留的检查点份数（§3.2：超出滚动删除最旧）。 */
export const CHECKPOINT_KEEP_MAX = 20;

/** 提醒阈值与节流窗同值（§3.5：30min；阈值不 env 化，只做「可关」）。 */
export const CHECKPOINT_NUDGE_MINUTES = 30;

/** 第 7 章 note 上限（与证据 note 的 500 字符钳同口径，README.md:209）。 */
export const CHECKPOINT_NOTE_MAX_CHARS = 500;

/** 第 5 章未读条数上限。 */
export const CHECKPOINT_UNREAD_MAX = 5;

/** 第 5 章单条 subject 截断（正文首行）。 */
export const CHECKPOINT_SUBJECT_MAX_CHARS = 80;

/** 第 3 章待领池条数上限。 */
export const CHECKPOINT_POOL_MAX = 10;

/** 第 4 章每任务 journal 末行数。 */
export const CHECKPOINT_JOURNAL_TAIL_LINES = 5;

/** 第 4 章覆盖任务数上限。 */
export const CHECKPOINT_JOURNAL_MAX_TASKS = 10;

/** 第 6 章建议条数上限（超出披露「另有 N 条」，不静默丢）。 */
export const CHECKPOINT_SUGGESTIONS_MAX = 5;

/** 关闭提醒的 env 值（§3.5：仅此一个 env，不是必填配置项）。 */
export const CHECKPOINT_NUDGE_ENV = 'XC_CHECKPOINT_NUDGE';
export const CHECKPOINT_NUDGE_OFF = '0';

/** stamp 形态（ISO8601，"："与 "." 折成 "-"）：Windows 合法文件名 + 字典序=时间序。 */
export const CHECKPOINT_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** stamp 同毫秒撞名时的最大进位次数（稳健措施；进位后仍是合法 stamp）。 */
export const CHECKPOINT_STAMP_COLLISION_MAX = 1000;

/**
 * .tmp 残留的清扫年龄阈值（v0.8.1 C1-B02 修复）：被杀进程会在检查点目录留下
 * `<ISO>.md.<pid>.<uuid>.tmp`（SIGKILL 落在「temp 已写、rename/link 未成」之间；
 * 红队 10 次击杀 6 次残留，且旧实现永不清扫、无披露）。在途写的生命周期是毫秒级
 * （写 temp → link → rm temp 同回合完成），60s 之外的 `.tmp` 不可能是活写在途——
 * 阈值同时保证**并发写者的 temp 不被误删**（那是竞态自杀）。
 */
export const CHECKPOINT_TMP_MAX_AGE_MS = 60_000;

/** front-matter 块（文件开头的首个 `---` 与第二个 `---` 之间；§3.3 冻结格式）。 */
const FRONT_MATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
/** front-matter `createdAt:` 行（§3.3 冻结 7 键之一；年龄取数以此为准）。 */
const FRONT_MATTER_CREATED_AT_RE = /^createdAt:\s*(\S+)\s*$/m;

// --- 段闸（防御纵深：sanitizeKey + 断言级复核；调用方禁止自行 join）------------

/**
 * `<agentKey>` 段闸：sanitizeKey 清洗后复核——非空、无 `.`、无路径分隔符。
 * 清洗链把一切非 \p{L}\p{N} run 折成 `-`（sanitize.ts:181-191），复核属防御纵深
 * （结构性不可能触发；触发即说明清洗链被改，立即抛错防穿越）。
 */
export function safeCheckpointSegment(raw: string, what = 'agentKey'): string {
  const key = sanitizeKey(typeof raw === 'string' ? raw : '');
  if (key === '' || key.includes('.') || key.includes('/') || key.includes('\\')) {
    throw new Error(`checkpoint_${what}_unsafe: "${String(raw).slice(0, 80)}" 清洗后（"${key}"）仍含路径敏感字符`);
  }
  return key;
}

/** stamp = ISO8601 折叠 ":" 与 "." 为 "-"（字典序保持时间序）。 */
export function checkpointStamp(now: number): string {
  const ms = Number.isFinite(now) && now >= 0 ? Math.floor(now) : Date.now();
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

// --- 容量推导（三视图共用同一助手；capacity.ts:283-286 无 level 字段）---------

/** 容量水位色（checkpoint 第 front-matter / handoff / status 共用同一推导）。 */
export type CapacityLevel = 'RED' | 'GREEN' | 'UNKNOWN';

/** 推导后的容量视图（字段名按采样真源命名，不用方案草案的 `available`——歧义）。 */
export interface CapacityView {
  /** watermark*100，保留 1 位。 */
  watermarkPct: number;
  /** freeBytes/1024^3，保留 2 位。 */
  freeGb: number;
  level: CapacityLevel;
}

/** 采样输入（core/capacity.ts CapacitySample 的结构子集；单测可直构）。 */
export interface CapacitySampleLike {
  watermark: number;
  freeBytes: number;
}

/** 判定输入（CapacityVerdict 的结构子集：只有 red 参与 level 推导）。 */
export interface CapacityVerdictLike {
  red: boolean;
}

/** red → RED；非 red → GREEN；采样/判定缺失 → UNKNOWN（不谎报水位）。 */
export function capacityLevelOf(verdict: CapacityVerdictLike | null | undefined): CapacityLevel {
  if (verdict === null || verdict === undefined) return 'UNKNOWN';
  return verdict.red === true ? 'RED' : 'GREEN';
}

/**
 * 容量视图推导（handoff/status/checkpoint 三处共用；sample 或 verdict 缺失 → null，
 * 由调用方按各自契约映射——checkpoint 的 front-matter 把 null 渲染成 UNKNOWN）。
 */
export function capacityViewOf(
  sample: CapacitySampleLike | null | undefined,
  verdict: CapacityVerdictLike | null | undefined,
): CapacityView | null {
  if (sample === null || sample === undefined || verdict === null || verdict === undefined) return null;
  return {
    watermarkPct: round1(sample.watermark * 100),
    freeGb: round2(sample.freeBytes / 1024 ** 3),
    level: capacityLevelOf(verdict),
  };
}

/** front-matter 的 capacity 值（§3.3 冻结：7 键恒现，采样失败也写 UNKNOWN）。 */
export function frontMatterCapacityLine(view: CapacityView | null): string {
  if (view === null) return 'capacity: {watermarkPct: n/a, freeGb: n/a, level: UNKNOWN}';
  return `capacity: {watermarkPct: ${view.watermarkPct.toFixed(1)}, freeGb: ${view.freeGb.toFixed(2)}, level: ${view.level}}`;
}

// --- 聚合输入（工具层取数后注入；now 一律外部注入保持纯度）-----------------------

/** 第 5 章的一条未读索引（只抄索引不搬原文；subject 由渲染层遮蔽 tool_request）。 */
export interface CheckpointUnreadRef {
  msgId: string;
  from: string;
  urgent: boolean;
  /** 正文首行（渲染层截 80 字符；tool_request 帧整条遮蔽）。 */
  subject: string;
}

/** 第 4 章的一个任务 journal 尾部（读取失败/缺失都在场，不静默跳过）。 */
export interface CheckpointJournalTail {
  taskId: string;
  /** 相对 stateRoot 的展示路径（.crosschat/tasks/<taskId>/journal.md）。 */
  displayPath: string;
  /** 末 N 个非空行；缺失/失败时为空。 */
  lines: string[];
  /** missing=文件不存在；error=读取失败。 */
  status: 'ok' | 'missing' | 'error';
}

/** 身份章的花名册记录快照（null = 不在册——仍可写，如实记 (not on roster)）。 */
export interface CheckpointMember {
  role: MemberRole;
  state: MemberState;
  sessionId: string;
  lastSeen: number;
}

/** 检查点聚合输入（工具层读 team.json/邮箱/journal/容量后注入）。 */
export interface CheckpointData {
  agentKey: string;
  teamId: string;
  /** null = 无显式 lead（front-matter 写 `(none)`）。 */
  leadKey: string | null;
  /** 花名册记录；null = 不在花名册（不阻断写盘）。 */
  member: CheckpointMember | null;
  /** 我的开放任务（OPEN_TASK_STATUSES ∧ assignee=me；调用方已过滤）。 */
  openTasks: readonly Task[];
  /** 全量任务（供停滞检测与依赖解析）。 */
  allTasks: readonly Task[];
  /** pending 池（调用方已按 sortTasksForBoard 排序；渲染取前 10）。 */
  pool: readonly Task[];
  /** 未读（调用方已按 urgentFirst 排序；渲染取前 5）。 */
  unread: readonly CheckpointUnreadRef[];
  /** 未读总数（用于「另有 N 条」披露）。 */
  unreadTotal: number;
  /** 未读读取失败原因（§3.6：第 5 章记「（未读读取失败）」，payload warnings[] 披露）。 */
  unreadError?: string;
  /** 容量视图；null = 采样失败（front-matter 记 UNKNOWN，payload 记 null）。 */
  capacity: CapacityView | null;
  /** 停滞阈值（毫秒；调用方从 env 解析后传入，core 不解析 env）。 */
  stallThresholdMs: number;
  /** 第 4 章 journal 尾部；缺省时 writeCheckpoint 自行读盘。 */
  journalTails?: readonly CheckpointJournalTail[];
  /** 第 7 章一句话备注；缺省记「（未提供）」。 */
  note?: string;
  /** 检查点时刻（ms epoch；单测注入用）。 */
  now: number;
}

export interface CheckpointWriteResult {
  /** 落盘文件绝对路径。 */
  path: string;
  /** 检查点时刻（= 注入的 now）。 */
  createdAt: number;
  /** 文件名 stamp（折叠后的 ISO8601）。 */
  stamp: string;
  /** 文件字节数（UTF-8）。 */
  bytes: number;
  /** 我的开放任务数。 */
  openTasks: number;
  /** 未读数。 */
  unread: number;
  /** 容量视图；null = 采样失败。 */
  capacity: CapacityView | null;
  /** 本次滚动删除份数。 */
  pruned: number;
  /** 滚动删除失败原因（写盘事实保持成功）。 */
  pruneError?: string;
  /**
   * v0.8.1（C1-B01）：排他落盘实际撞名并进位重选的轮次（0 = 无碰撞）。同毫秒并发
   * 下 >0——工具层审计 `checkpoint-stamp-collision`，调用方与运维都能看见。
   */
  stampCollisions?: number;
  /** v0.8.1（C1-B02）：本次清扫掉的残留 `.tmp` 份数（0 = 无残留）。 */
  tmpRemoved?: number;
  /** v0.8.1（C1-B02）：.tmp 清扫失败原因（写盘事实保持成功；best-effort 卫生）。 */
  tmpSweepError?: string;
}

// --- 小工具 -------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 折成单行 + 去控制字符（front-matter/表格单元格防注入撑破）。 */
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

/** note 清洗：控制字符折空格 + 500 字符钳（§3.3）。 */
export function normalizeCheckpointNote(note: string | undefined): string {
  if (typeof note !== 'string') return '';
  return foldLine(note).slice(0, CHECKPOINT_NOTE_MAX_CHARS);
}

// --- front-matter + 七章聚合（纯函数）------------------------------------------

/**
 * 组装检查点全文（§3.3 冻结格式）：front-matter 7 键恒现 + 七章固定编号标题。
 *
 * 冻结字段规则（实现逐字遵守，验收据此走查）：
 * - front-matter：agent/team/lead/createdAt/taskCounts/unread/capacity **七个键每行必现**；
 *   `taskCounts` 恒含 claimed/in_progress/blocked 三键（0 也写，键集合稳定可 grep）；
 *   值含换行/`---` 的折成单行；`lead` 无值时写 `(none)`（不写 null，保持标量）。
 * - 章标题：`## 1. 身份` … `## 7. note` 七章、顺序固定、编号固定。
 */
export function buildCheckpointMarkdown(data: CheckpointData): string {
  const now = data.now;
  const key = safeCheckpointSegment(data.agentKey);
  const counts = { claimed: 0, in_progress: 0, blocked: 0 };
  for (const t of data.openTasks) {
    if (t.status === 'claimed' || t.status === 'in_progress' || t.status === 'blocked') counts[t.status] += 1;
  }
  const out: string[] = [];
  out.push('---');
  out.push(`agent: ${key}`);
  out.push(`team: ${foldLine(data.teamId)}`);
  out.push(`lead: ${data.leadKey === null ? '(none)' : foldLine(data.leadKey)}`);
  out.push(`createdAt: ${isoTs(now)}`);
  out.push(`taskCounts: {claimed:${counts.claimed}, in_progress:${counts.in_progress}, blocked:${counts.blocked}}`);
  out.push(`unread: ${data.unreadTotal}`);
  out.push(frontMatterCapacityLine(data.capacity));
  out.push('---');
  out.push('');

  // 1. 身份
  const role = data.member?.role ?? '(not on roster)';
  const state = data.member?.state ?? '(not on roster)';
  const lead = data.leadKey === null ? '(none)' : foldLine(data.leadKey);
  out.push('## 1. 身份');
  out.push(`- agent: ${key} | role: ${role} | state: ${state} | lead: ${lead} | team: ${foldLine(data.teamId)}`);
  const sid = data.member?.sessionId;
  const lastSeen = data.member?.lastSeen;
  out.push(
    `- sessionId: ${sid === undefined || sid === '' ? '(unknown)' : `${shortId(sid)}`}`
    + ` | lastSeen: ${lastSeen === undefined ? '(unknown)' : `${isoTs(lastSeen)}（${relMinutes(now, lastSeen)}min 前）`}`,
  );
  out.push('');

  // 2. 我的进行中任务（claimed / in_progress / blocked）
  out.push('## 2. 我的进行中任务（claimed / in_progress / blocked）');
  out.push('| taskId | 状态 | 标题 | attempt | 最后进展 |');
  if (data.openTasks.length === 0) {
    out.push('（无进行中任务）');
  } else {
    for (const t of data.openTasks) {
      const progress = `${isoTs(lastProgressTs(t))}（${relMinutes(now, lastProgressTs(t))}min 前）`;
      const reason = t.status === 'blocked' && typeof t.blockedReason === 'string' && t.blockedReason.trim() !== ''
        ? `（阻塞原因：${foldLine(t.blockedReason)}）`
        : '';
      out.push(`| ${t.id} | ${t.status} | ${foldLine(t.title)} | ${t.attempt} | ${progress}${reason} |`);
    }
  }
  out.push('');

  // 3. 待领池（前 10，priority → createdAt）
  const pool = data.pool.slice(0, CHECKPOINT_POOL_MAX);
  out.push('## 3. 待领池（前 10，priority → createdAt）');
  out.push('| taskId | 优先级 | 标题 | 依赖 |');
  if (data.pool.length === 0) {
    out.push('（待领池为空）');
  } else {
    const unmet = new Map<string, string[]>();
    for (const t of pool) unmet.set(t.id, unsatisfiedDependencies(data.allTasks, t.dependsOn));
    for (const t of pool) {
      const deps = t.dependsOn ?? [];
      const depCell = deps.length === 0
        ? '-'
        : deps.map((d) => (unmet.get(t.id)?.includes(d) ? `${d}!` : d)).join(', ');
      out.push(`| ${t.id} | ${t.priority ?? 'normal'} | ${foldLine(t.title)} | ${depCell} |`);
    }
    if (data.pool.length > pool.length) {
      out.push(`（待领池共 ${data.pool.length} 个，列前 ${CHECKPOINT_POOL_MAX}）`);
    }
  }
  out.push('');

  // 4. 最近 journal（每任务末 5 行 + 路径）
  out.push('## 4. 最近 journal（每任务末 5 行 + 路径）');
  const tails = data.journalTails ?? [];
  const shown = tails.slice(0, CHECKPOINT_JOURNAL_MAX_TASKS);
  if (shown.length === 0) {
    out.push('（无任务 journal 可列：当前无进行中任务）');
  } else {
    for (const tail of shown) {
      out.push(`### ${tail.taskId}（${tail.displayPath}）`);
      if (tail.status === 'missing') {
        out.push(`（无 journal：${tail.displayPath} 不存在）`);
      } else if (tail.status === 'error') {
        out.push(`（journal 读取失败：${tail.displayPath}）`);
      } else if (tail.lines.length === 0) {
        out.push('（journal 为空）');
      } else {
        for (const line of tail.lines) out.push(`- ${line}`);
      }
    }
    if (tails.length > shown.length) {
      out.push(`（另有 ${tails.length - shown.length} 个任务 journal 未列入）`);
    }
  }
  out.push('');

  // 5. 未读摘要（urgent 优先，最多 5 条）
  out.push('## 5. 未读摘要（urgent 优先，最多 5 条）');
  if (data.unreadError !== undefined) {
    // 读取失败如实记（§3.6），不当成「无未读」
    out.push(`（未读读取失败：${foldLine(data.unreadError)}）`);
  } else {
    const unreadShown = data.unread.slice(0, CHECKPOINT_UNREAD_MAX);
    if (data.unreadTotal === 0) {
      out.push('（无未读）');
    } else if (unreadShown.length === 0) {
      out.push(`（未读 ${data.unreadTotal} 条，无可展示索引）`);
    } else {
      for (const m of unreadShown) {
        const urgent = m.urgent ? '[urgent] ' : '';
        out.push(`- ${urgent}${m.from} | ${m.subject}（${shortId(m.msgId)}）`);
      }
      if (data.unreadTotal > unreadShown.length) {
        out.push(`（另有 ${data.unreadTotal - unreadShown.length} 条未读，xc_read({scope:"inbox"}) 消费）`);
      }
    }
  }
  out.push('');

  // 6. 建议下一步
  out.push('## 6. 建议下一步');
  const suggestions = buildCheckpointSuggestions(data);
  for (const s of suggestions) out.push(`- ${s}`);
  out.push('');

  // 7. note
  out.push('## 7. note');
  out.push(normalizeCheckpointNote(data.note) === '' ? '（未提供）' : normalizeCheckpointNote(data.note));

  return `${out.join('\n')}\n`;
}

/**
 * 建议下一步拼装（§3.3）：stallSuggestion（stall.ts:120）+ 依赖未满足项 + 单在途
 * 任务规则提示 + 容量 RED 建议行；无项时记「（暂无：按 journal 指针继续）」。
 * 上限 5 条，超出披露「另有 N 条建议略去」——不静默丢。
 */
function buildCheckpointSuggestions(data: CheckpointData): string[] {
  const now = data.now;
  const flags: StallFlag[] = stalledTasks(data.openTasks, now, data.stallThresholdMs);
  const flagById = new Map(flags.map((f) => [f.taskId, f]));
  const items: string[] = [];
  for (const t of data.openTasks) {
    const flag = flagById.get(t.id);
    if (flag !== undefined) {
      items.push(`${t.id}：${flag.status} 超 ${flag.idleForMin}min → ${stallSuggestion(flag.kind, flag.status)}`);
    }
    const unmet = unsatisfiedDependencies(data.allTasks, t.dependsOn);
    if (unmet.length > 0) {
      items.push(`${t.id}：依赖 ${unmet.join(', ')} 未终态 → 等待项（dependsOn 未满足）`);
    }
  }
  if (data.capacity?.level === 'RED') {
    items.push('容量 RED → 先按 longtask checklist 落盘再接受压缩');
  }
  if (data.openTasks.length === 0 && data.pool.length > 0) {
    items.push(
      `无在途任务且有待领 → 可认领 ${data.pool[0]!.id}（注意单在途任务规则：认领前先 xc_report 收尾当前任务）`,
    );
  }
  if (items.length === 0) return ['（暂无：按 journal 指针继续）'];
  const shown = items.slice(0, CHECKPOINT_SUGGESTIONS_MAX);
  if (items.length > shown.length) {
    shown.push(`（另有 ${items.length - shown.length} 条建议略去）`);
  }
  return shown;
}

// --- 滚动清理（纯函数 + 落盘执行）---------------------------------------------

/**
 * 滚动删除计划（纯函数）：`*.md` 按文件名升序（=时间升序），删除最旧的
 * `len - keepMax` 个；`.nudge` 与非 `.md` 文件不在删除域。返回待删文件名（升序）。
 */
export function planCheckpointPrune(names: readonly string[], keepMax: number): string[] {
  const keep = Number.isFinite(keepMax) && keepMax >= 0 ? Math.floor(keepMax) : CHECKPOINT_KEEP_MAX;
  const candidates = names
    .filter((name) => name.endsWith('.md') && name !== '.md')
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return candidates.length > keep ? candidates.slice(0, candidates.length - keep) : [];
}

/** 执行滚动删除（best-effort）：任何失败都不阻断已成功的写入。 */
export async function pruneCheckpointFiles(
  dir: string,
  keepMax: number = CHECKPOINT_KEEP_MAX,
): Promise<{ pruned: number; error?: string }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    return { pruned: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const doomed = planCheckpointPrune(names, keepMax);
  let pruned = 0;
  let firstError: string | undefined;
  for (const name of doomed) {
    try {
      await rm(join(dir, name), { force: true });
      pruned += 1;
    } catch (error) {
      if (firstError === undefined) firstError = error instanceof Error ? error.message : String(error);
    }
  }
  return firstError === undefined ? { pruned } : { pruned, error: firstError };
}

/**
 * v0.8.1（C1-B02 修复）：清扫检查点目录里的**残留** `.tmp` 文件。
 *
 * 产物原子写（core/atomic.ts）的临时文件命名 = `<目标>.<pid>.<uuid>.tmp`；进程在
 * 「temp 已写、rename/link 未成」之间被杀（SIGKILL/断电）就会留下它，而旧实现只删
 * 超帽的 `*.md`，残留无限积存、无披露（红队：击杀 10 次 6 次残留；手工放入的
 * `*.md.tmp` 原样永存）。本函数按**年龄**清：`now - mtime > maxAgeMs`（缺省 60s）
 * 才删——在途写是毫秒级生命周期，60s 外的 `.tmp` 不可能是活写在途，并发写者的
 * temp 因此不会被误删。`.nudge` 与非 `.tmp` 文件不在清扫域（20 帽另按 `*.md` 口径）。
 *
 * best-effort：任何单文件失败不阻断其余（首个错误记入 `error`，由调用方只审计）。
 */
export async function sweepCheckpointTmpFiles(
  dir: string,
  now: number = Date.now(),
  maxAgeMs: number = CHECKPOINT_TMP_MAX_AGE_MS,
): Promise<{ removed: number; error?: string }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    return { removed: 0, error: error instanceof Error ? error.message : String(error) };
  }
  let removed = 0;
  let firstError: string | undefined;
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    try {
      const info = await stat(join(dir, name));
      if (!info.isFile()) continue;
      if (now - info.mtimeMs <= maxAgeMs) continue; // 可能是另一进程的在途写——不碰
      await rm(join(dir, name), { force: true });
      removed += 1;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue; // 并发清扫/竞争删除已拿走——不算失败
      if (firstError === undefined) firstError = error instanceof Error ? error.message : String(error);
    }
  }
  return firstError === undefined ? { removed } : { removed, error: firstError };
}

// --- 落盘 ---------------------------------------------------------------------

/** 读一个任务 journal 的末 N 个非空行（缺失/失败都在场——不得静默跳过）。 */
export async function readTaskJournalTail(
  stateRoot: string,
  taskId: string,
  tailLines: number = CHECKPOINT_JOURNAL_TAIL_LINES,
): Promise<CheckpointJournalTail> {
  // 段闸异常（taskId 清洗后仍不安全——结构性不可能，防御纵深）与读失败都归 error，
  // 不向上抛：单任务 journal 坏不该毁掉整份检查点（§3.6）。
  let displayPath = `.crosschat/tasks/${foldLine(taskId)}/journal.md`;
  let raw: string;
  try {
    displayPath = journalDisplayPath(stateRoot, taskId);
    raw = await readFile(taskJournalPath(stateRoot, taskId), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { taskId, displayPath, lines: [], status: code === 'ENOENT' ? 'missing' : 'error' };
  }
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .slice(-tailLines);
  return { taskId, displayPath, lines, status: 'ok' };
}

/**
 * 写检查点（服务端落盘，§3.2/§3.4）。
 *
 * 顺序：段闸 → mkdir → 读 journal 尾部 → 选 stamp + **排他落盘** → 滚动删除 → .tmp 清扫。
 * 写失败向上抛（调用方映射 `checkpoint_write_failed`，不返回成功——不得假装落盘）；
 * 滚动删除/.tmp 清扫失败**不阻断**已成功的写入（结果附 `pruneError`/`tmpSweepError`，
 * 分别审计 checkpoint-prune-failed / checkpoint-tmp-sweep-failed）。
 *
 * v0.8.1（29 能力反向检验 C1-B01 修复）：同毫秒并发的**静默覆写**根因是「stat 预检
 * →  rename 落盘」两步之间的竞态——两个同刻调用都看到候选位不存在，随后都写同一
 * 路径，先发者的快照被吞掉且双方均报成功（红队同刻探针 6/10 + 11/25 轮稳定复现，
 * 20 次成功调用只落 14 文件）。现在占位改为**单次原子操作**：`writeFileExclusive`
 * （temp + link，EEXIST 即让位）——输家换 stamp 进位重试，「一次调用一份文件」
 * 的不变量成立；候选位全部占满（同毫秒并发上限 1000）才抛错，绝不静默覆写。
 * 实际撞名的轮次记入 `stampCollisions`（工具层审计 checkpoint-stamp-collision）。
 */
export async function writeCheckpoint(stateRoot: string, data: CheckpointData): Promise<CheckpointWriteResult> {
  const key = safeCheckpointSegment(data.agentKey);
  const dir = checkpointDir(stateRoot, key);
  await mkdir(dir, { recursive: true });

  const journalTails = data.journalTails
    ?? await Promise.all(
      data.openTasks.slice(0, CHECKPOINT_JOURNAL_MAX_TASKS).map((t) => readTaskJournalTail(stateRoot, t.id)),
    );

  // stamp 选择 + 排他落盘：存在性预检是快路径（顺序同毫秒调用即够），排他写是竞态
  // 防线（并发同毫秒调用）；进位不改 stamp 形态（仍是折叠 ISO，字典序=时间序）。
  let effectiveNow = Number.isFinite(data.now) && data.now >= 0 ? Math.floor(data.now) : Date.now();
  let stamp = checkpointStamp(effectiveNow);
  let path = checkpointFile(stateRoot, key, stamp);
  let markdown = '';
  let created = false;
  let collisions = 0;
  for (let i = 0; i < CHECKPOINT_STAMP_COLLISION_MAX; i += 1) {
    if (!(await fileExists(path))) {
      markdown = buildCheckpointMarkdown({ ...data, now: effectiveNow, journalTails });
      created = await writeFileExclusive(path, markdown); // EEXIST → false（让位重选）
      if (created) break;
      collisions += 1;
    }
    effectiveNow += 1;
    stamp = checkpointStamp(effectiveNow);
    path = checkpointFile(stateRoot, key, stamp);
  }
  if (!created) {
    throw new Error(
      `checkpoint_stamp_collision: ${CHECKPOINT_STAMP_COLLISION_MAX} 个候选 stamp 全部被占`
      + '（同毫秒并发上限）——重试即可，绝不静默覆写',
    );
  }
  const bytes = Buffer.byteLength(markdown, 'utf8');

  const prune = await pruneCheckpointFiles(dir, CHECKPOINT_KEEP_MAX);
  // v0.8.1（C1-B02）：被杀进程残留的 .tmp 按年龄清扫（在途写只毫秒级，60s 阈值安全）。
  const tmp = await sweepCheckpointTmpFiles(dir);
  return {
    path,
    createdAt: effectiveNow,
    stamp,
    bytes,
    openTasks: data.openTasks.length,
    unread: data.unreadTotal,
    capacity: data.capacity,
    pruned: prune.pruned,
    ...(prune.error !== undefined ? { pruneError: prune.error } : {}),
    ...(collisions > 0 ? { stampCollisions: collisions } : {}),
    ...(tmp.removed > 0 ? { tmpRemoved: tmp.removed } : {}),
    ...(tmp.error !== undefined ? { tmpSweepError: tmp.error } : {}),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- 读取（handoff/status/提醒共用；纯读无锁）----------------------------------

/**
 * 检查点年龄取数（v0.8.1 修复 C2-B4）：**front-matter `createdAt` 优先**，缺失/不可解析
 * 才回退文件 mtime。
 *
 * 根因：旧实现只取 stat 的 mtime，而 mtime 是「文件最后一次被写」的机器事实，不是
 * 「这份检查点声称自己写于何时」的产品事实——外部拷贝/还原/同步工具重置 mtime 后，
 * 一份 26h 前的检查点会读成 0min 前（handoff/status/提醒三面同时失真）。front-matter
 * 的 `createdAt` 由 writeCheckpoint 自己写入（stamp 同源），拷贝不改变它。
 *
 * 只在**开头的 front-matter 块**（首个 `---` 与第二个 `---` 之间）里认 `createdAt:` 行——
 * 正文章节里的同名词（journal 摘录等外来内容）不冒领。纯函数（文本进、epoch ms 出）
 * 便于单测钉死两种输入；无法解析时返回 mtimeMs，由调用方按「无 front-matter 的老文件」
 * 宽容处理（不升级成「无检查点」）。
 */
export function checkpointCreatedAtFromMarkdown(text: string, mtimeMs: number): number {
  const block = FRONT_MATTER_BLOCK_RE.exec(text);
  if (block !== null) {
    const match = FRONT_MATTER_CREATED_AT_RE.exec(block[1]!);
    if (match !== null) {
      const parsed = Date.parse(match[1]!);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return mtimeMs;
}

/** 最新一份检查点的 stat 快照（无 → null）。文件名升序取最新（stamp 字典序=时间序）。
 *  `createdAt` = front-matter createdAt（回退 mtime，见 checkpointCreatedAtFromMarkdown）。 */
export async function latestCheckpoint(
  stateRoot: string,
  agentKey: string,
  now: number = Date.now(),
): Promise<{ path: string; stamp: string; createdAt: number; ageMin: number; bytes: number } | null> {
  const key = safeCheckpointSegment(agentKey);
  const dir = checkpointDir(stateRoot, key);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  // 只认 stamp 形态的 `*.md`（ stray 的 `.md` 不冒充分检点；滚动删除域另按 `*.md` 口径）。
  const files = names
    .map((name) => (name.endsWith('.md') ? name.slice(0, -'.md'.length) : undefined))
    .filter((stamp): stamp is string => stamp !== undefined && CHECKPOINT_STAMP_RE.test(stamp))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const latest = files.length > 0 ? files[files.length - 1]! : undefined;
  if (latest === undefined) return null;
  const path = checkpointFile(stateRoot, key, latest);
  try {
    const info = await stat(path);
    let createdAt = info.mtimeMs;
    try {
      createdAt = checkpointCreatedAtFromMarkdown(await readFile(path, 'utf8'), info.mtimeMs);
    } catch {
      // 读失败（权限/竞态删除）→ 保持 mtime 口径，不把「取数失败」升级成「无检查点」。
    }
    return { path, stamp: latest, createdAt, ageMin: relMinutes(now, createdAt), bytes: info.size };
  } catch {
    return null;
  }
}

/**
 * v0.8.1（29 红队 C2-B3 修复）：改名时把检查点目录**随花名搬过去**
 * （`checkpoints/<旧名>/` → `checkpoints/<新名>/`，含 `.nudge` 节流标记）。
 *
 * 根因：改名只换 roster 成员键，检查点目录原地成孤儿——默认 self 接手包七要素
 * 之一「最近检查点」静默变 null（旧目录不再被任何工具面引用；红队 adj-b3 实测
 * 改名前后 handoff checkpoint present→null 且无 warning）。改名守卫已保证板面
 * 干净、邮箱为空，检查点目录是该成员仅存的每名状态，搬过去即「要素不丢」。
 *
 * best-effort：整目录 rename 失败（目标已存在/权限）时逐文件搬迁；仍失败只返回
 * error 由调用方披露（改名本身已成功，不阻断、不谎报）。无旧目录 = 无可搬
 * （`carried:false` 且无 error——不是失败）。
 */
export async function carryCheckpointDir(
  stateRoot: string,
  fromKey: string,
  toKey: string,
): Promise<{ carried: boolean; error?: string }> {
  const from = checkpointDir(stateRoot, safeCheckpointSegment(fromKey));
  const to = checkpointDir(stateRoot, safeCheckpointSegment(toKey));
  let entries: string[];
  try {
    entries = await readdir(from);
  } catch {
    return { carried: false }; // 无旧目录 = 没有检查点可搬
  }
  if (entries.length === 0) return { carried: false };
  try {
    await rename(from, to);
    return { carried: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { carried: false };
    // 目标已存在（旧名曾搬回过/并发）等：逐文件搬迁，目标已存在则保留新方的文件。
    try {
      await mkdir(to, { recursive: true });
      let moved = 0;
      const failures: string[] = [];
      for (const entry of entries) {
        try {
          await rename(join(from, entry), join(to, entry));
          moved += 1;
        } catch (entryError) {
          failures.push(`${entry}: ${entryError instanceof Error ? entryError.message : String(entryError)}`);
        }
      }
      if (moved === 0) {
        return { carried: false, error: failures.join("; ") || String(error) };
      }
      return failures.length > 0 ? { carried: true, error: failures.join("; ") } : { carried: true };
    } catch (fallbackError) {
      return {
        carried: false,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      };
    }
  }
}

/** 读提醒节流标记（`.nudge` 内容 = 上次提醒 ISO 时间；缺/坏 → null）。 */
export async function readNudgeMarker(stateRoot: string, agentKey: string): Promise<number | null> {
  const key = safeCheckpointSegment(agentKey);
  try {
    const text = (await readFile(checkpointNudgeFile(stateRoot, key), 'utf8')).trim();
    const ts = Date.parse(text);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/** 写提醒节流标记（原子写，best-effort；失败由调用方只审计不阻断）。 */
export async function writeNudgeMarker(stateRoot: string, agentKey: string, now: number): Promise<void> {
  const key = safeCheckpointSegment(agentKey);
  const path = checkpointNudgeFile(stateRoot, key);
  await mkdir(checkpointDir(stateRoot, key), { recursive: true });
  await writeFileAtomic(path, `${new Date(now).toISOString()}\n`);
}

// --- 提醒判据（§3.5 五态；纯函数便于负例单测）----------------------------------

export type NudgeReason =
  | 'disabled'              // XC_CHECKPOINT_NUDGE=0
  | 'no-active-task'        // 无活跃任务 → 不该提醒
  | 'within-threshold'      // 距上次 checkpoint ≤30min → 不该提醒
  | 'rate-limited'          // 距上次提醒 ≤30min → 不该提醒
  | 'emit';                 // 该提醒

export interface NudgeDecisionInput {
  env: NodeJS.ProcessEnv;
  /** 我的 OPEN_TASK_STATUSES 任务数。 */
  openTaskCount: number;
  /** 该 agent 目录内最新检查点的 createdAt（front-matter 优先，回退 mtime；无则 null）。 */
  lastCheckpointAt: number | null;
  /** .nudge 内容解析值（无则 null）。 */
  lastNudgeAt: number | null;
  now: number;
}

export interface NudgeDecision {
  nudge: boolean;
  reason: NudgeReason;
  /** emit 时的检查点年龄（分钟）；从未写过为 undefined（文案渲染「尚未落过」）。 */
  ageMin?: number;
}

/**
 * 提醒判据（判定顺序固定，先命中先返回，保证负例可逐条单测）：
 *   1. `XC_CHECKPOINT_NUDGE === "0"` → disabled（可关）；
 *   2. `openTaskCount === 0` → no-active-task（**负例**：没活干的成员不被提醒）；
 *   3. `lastCheckpointAt !== null && now - lastCheckpointAt <= 30min` → within-threshold
 *      （**负例**：刚写过不重复提醒）；
 *   4. `lastNudgeAt !== null && now - lastNudgeAt <= 30min` → rate-limited
 *      （**负例**：30min 内最多一次）；
 *   5. 其余 → emit。
 *
 * `lastCheckpointAt === null`（从未写过）按 age=∞ 处理 = 该提醒一次（adjudication：
 * 功能目的就是「压缩前盘上已有一份」；从不落盘的成员更该被提醒一次。噪声由第 4 条
 * 钳在每 30min 一次）。
 */
export function checkpointNudgeDecision(input: NudgeDecisionInput): NudgeDecision {
  const thresholdMs = CHECKPOINT_NUDGE_MINUTES * 60_000;
  if (input.env[CHECKPOINT_NUDGE_ENV] === CHECKPOINT_NUDGE_OFF) {
    return { nudge: false, reason: 'disabled' };
  }
  const openTaskCount = Number.isFinite(input.openTaskCount) ? Math.max(0, Math.floor(input.openTaskCount)) : 0;
  if (openTaskCount === 0) {
    return { nudge: false, reason: 'no-active-task' };
  }
  if (input.lastCheckpointAt !== null && input.now - input.lastCheckpointAt <= thresholdMs) {
    return { nudge: false, reason: 'within-threshold' };
  }
  if (input.lastNudgeAt !== null && input.now - input.lastNudgeAt <= thresholdMs) {
    return { nudge: false, reason: 'rate-limited' };
  }
  return {
    nudge: true,
    reason: 'emit',
    ...(input.lastCheckpointAt !== null ? { ageMin: relMinutes(input.now, input.lastCheckpointAt) } : {}),
  };
}

/**
 * 钩子侧取数（纯读无锁，与 hooks/shared.ts unreadSummary 同纪律）：数我的开放任务
 * + 列最新 `*.md` 的 createdAt（front-matter 优先，回退 mtime）+ 读 `.nudge`。team.json 不存在 → 无活跃任务（负例方向）。
 *
 * env 形参预留给未来阈值 env 化（当前提醒阈值是代码常量 CHECKPOINT_NUDGE_MINUTES，
 * 只有一个可关 env，不新增必填配置）。
 */
export async function checkpointNudgeState(
  stateRoot: string,
  agentKey: string,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<{ openTaskCount: number; lastCheckpointAt: number | null; lastNudgeAt: number | null }> {
  void env;
  const key = safeCheckpointSegment(agentKey);
  let openTaskCount = 0;
  const team = await readTeam(stateRoot, DEFAULT_TEAM_ID).catch(() => undefined);
  if (team !== undefined) {
    openTaskCount = memberOpenTasks(team.tasks, key).length;
  }
  const latest = await latestCheckpoint(stateRoot, key, now);
  const lastNudgeAt = await readNudgeMarker(stateRoot, key);
  return { openTaskCount, lastCheckpointAt: latest?.createdAt ?? null, lastNudgeAt };
}

/** 注入文案（一行；§3.5）。 */
export function renderCheckpointNudgeLine(ageMin: number | undefined): string {
  const tail = '——长期任务随时可能被压缩，先落盘再继续；不需要可设 XC_CHECKPOINT_NUDGE=0。';
  const head = ageMin === undefined
    ? '[zcode-crosschat] 建议先 /xc-checkpoint（尚未落过检查点）'
    : `[zcode-crosschat] 建议先 /xc-checkpoint（距上次检查点 ${ageMin}min）`;
  return `${head}${tail}`;
}

// --- 第 5 章索引构建（工具层/钩子共用：只抄索引不搬原文）------------------------

/**
 * 未读索引行（§3.3/R6）：`[urgent?] <from> | <正文首行截 80 字符>（<msgId 短 8 位>`；
 * `tool_request` 帧的 subject 一律遮蔽为门控标记——观测面包漏原文等于给审批门开侧门。
 */
export function checkpointUnreadRef(message: TeamMessage): CheckpointUnreadRef {
  const subject = parseToolFrameType(message.content) === 'tool_request'
    ? '[tool_request 审批门控帧]'
    : foldLine(message.content.split('\n')[0] ?? '').slice(0, CHECKPOINT_SUBJECT_MAX_CHARS);
  return { msgId: message.id, from: message.from, urgent: message.urgent === true, subject };
}

/** 展示路径助手（第 4 章标题用；`.crosschat/tasks/<taskId>/journal.md`，与 archive.taskJournalPath 同源）。 */
export function journalDisplayPath(stateRoot: string, taskId: string): string {
  const rel = relative(stateRoot, taskJournalPath(stateRoot, taskId)).split('\\').join('/');
  return `.crosschat/${rel}`;
}
