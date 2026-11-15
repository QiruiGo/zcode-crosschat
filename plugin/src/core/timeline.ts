/**
 * v0.8.0 A3（DESIGN-V0.8.md §5）：时间线视图——engine.jsonl **尾部窗口读** + 事件族
 * 归一化（ts/event/family/actor/taskId/summary）。新模块自持尾部窗口，**不改
 * core/jsonl.ts**（只复用其 {@link parseJsonl}）——jsonl.ts 零改动，G1/G3 不受影响。
 *
 * 为什么尾部窗口读：engine.jsonl 无上界（每次工具调用都追加，core/log.ts），
 * readJsonl 是全文件读；窗口 = TAIL_READ_MAX_BYTES（256 KiB），只读末段、按 \n 切行后
 * **丢弃窗口首行**（可能被截断的半行）。窗口不足且文件确被窗口截断时披露
 * tailWindowBytes/olderEventsOmitted——不假装看全了历史（R7）。
 *
 * 归一化字段（冻结）：`{ts, event, family, actor, taskId, summary}`。family 是相对
 * 方案字面的增量（方案 §2 A3 自述「事件族」九类，没有字段承载就无法过滤与紧凑呈现，
 * R8-②）。事件族映射表照抄 DESIGN §5；不在表内 → `other`。
 *
 * 分页语义（R8-⑤）：limit 缺省 20/上限 100（超限钳制 + limitClamped 披露）；
 * offset = **自最新往回跳过 N 条**（与板面「自头部偏移」不同——工具描述已写明防误用）。
 * 预算：batchWindowCount 对 JSON.stringify(entry).length 开窗；超限给 truncated +
 * 续读指针 xc_overview({view:"timeline", offset:<shown+offset>})。
 *
 * @module core/timeline
 */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isRecord } from './types.js';
import { parseJsonl } from './jsonl.js';
import { batchWindowCount } from './budget.js';

/** 尾部窗口上限（256 KiB）：超过只读末段，杜绝无上界日志的全文件读。 */
export const TAIL_READ_MAX_BYTES = 256 * 1024;
/** timeline 缺省条数（方案 §2 A3「默认 20 条」）。 */
export const TIMELINE_DEFAULT_LIMIT = 20;
/** timeline 条数上限（方案 §2 A3「最大 100」；超限钳制并披露）。 */
export const TIMELINE_MAX_LIMIT = 100;

/** 事件族（DESIGN §5 冻结表：九族 + other）。 */
export type TimelineFamily =
  | 'dispatch'
  | 'claim'
  | 'report'
  | 'sweep'
  | 'offline'
  | 'approval'
  | 'tool'
  | 'lead'
  | 'member'
  | 'other';

/** 事件族映射表（照抄 DESIGN §5；不在表内 → other）。 */
export const TIMELINE_FAMILY_BY_EVENT: Readonly<Record<string, TimelineFamily>> = {
  // dispatch
  'dispatch': 'dispatch',
  'dispatch-refused': 'dispatch',
  // claim
  'claim': 'claim',
  // report
  'report': 'report',
  // sweep
  'task-swept': 'sweep',
  'revoked-stale': 'sweep',
  // offline
  'task-offline': 'offline',
  // approval
  'tool-approval-request': 'approval',
  'tool-approval': 'approval',
  'tool-expired': 'approval',
  // tool
  'tool-request': 'tool',
  'tool-executed': 'tool',
  'tool-result-rejected': 'tool',
  // lead
  'lead-set': 'lead',
  'lead-transfer': 'lead',
  'lead-release': 'lead',
  // member
  'member-added': 'member',
  'member-add-started': 'member',
  'member-add-failed': 'member',
  'member-stopped': 'member',
  'member-archive-written': 'member',
  'member-archive-failed': 'member',
  'member-provision-timeout': 'member',
  'member-takeover': 'member',
};

/** 事件名 → 族（不在表内 → other）。 */
export function timelineFamilyOf(event: string): TimelineFamily {
  return TIMELINE_FAMILY_BY_EVENT[event] ?? 'other';
}

/** 归一化时间线事件（字段冻结：ts/event/family/actor/taskId/summary）。 */
export interface TimelineEvent {
  ts: number;
  event: string;
  family: TimelineFamily;
  /** 取值序：agentKey ?? by ?? createdBy ?? assignee ?? to ?? null。 */
  actor: string | null;
  taskId: string | null;
  /** 族级确定性模板；缺字段退化到事件名本身——永不为空串。 */
  summary: string;
}

export interface TimelineResult {
  /** 本页事件（新→旧，已过 offset/limit/预算窗口）。 */
  events: TimelineEvent[];
  /** 本页真实呈现条数（= events.length；预算窗口后）。 */
  shown: number;
  /** 窗口内解析到的事件总数（offset/limit 之前）。 */
  total: number;
  offset: number;
  limit: number;
  /** limit > 100 被钳制（requested/applied）。 */
  limitClamped?: { requested: number; applied: number };
  /** 预算截断披露 + 续读指针（offset = shown + offset）。 */
  truncated?: { shown: number; total: number; offset: number; budgetChars: number };
  /** 文件被尾部窗口截断时的窗口字节数。 */
  tailWindowBytes?: number;
  /** 窗口内事件数 < limit+offset 且文件确被窗口截断——更早事件未读入。 */
  olderEventsOmitted?: boolean;
  budgetChars: number;
}

export interface TimelineReadOptions {
  limit?: number;
  offset?: number;
  /** 注入预算（字符；batchWindowCount 的窗）。 */
  budgetChars: number;
}

// ---------------------------------------------------------------------------
// 归一化（纯函数）
// ---------------------------------------------------------------------------

function strField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** actor 取值序（冻结）：agentKey ?? by ?? createdBy ?? assignee ?? to ?? null。 */
function actorOf(rec: Record<string, unknown>): string | null {
  return strField(rec['agentKey'])
    ?? strField(rec['by'])
    ?? strField(rec['createdBy'])
    ?? strField(rec['assignee'])
    ?? strField(rec['to'])
    ?? null;
}

/** 族级确定性模板（缺字段退化到事件名；永不为空串）。 */
function summarize(event: string, rec: Record<string, unknown>, actor: string | null): string {
  const family = timelineFamilyOf(event);
  switch (family) {
    case 'dispatch': {
      const target = strField(rec['to']) ?? strField(rec['assignee']);
      const by = strField(rec['createdBy']) ?? strField(rec['by']) ?? actor;
      if (target !== undefined && by !== null) return `dispatch → ${target} by ${by}`;
      return event;
    }
    case 'claim': {
      const who = strField(rec['assignee']) ?? actor;
      if (who === null) return event;
      const attempt = numField(rec['attempt']);
      return attempt === undefined ? `claim by ${who}` : `claim by ${who} (attempt ${attempt})`;
    }
    case 'report': {
      const status = strField(rec['status']);
      const who = strField(rec['agentKey']) ?? actor;
      if (who === null) return event;
      return status === undefined ? `report by ${who}` : `report ${status} by ${who}`;
    }
    case 'sweep':
    case 'offline': {
      const taskId = strField(rec['taskId']);
      return taskId === undefined ? event : `${event} ${taskId}`;
    }
    case 'approval':
    case 'tool': {
      const who = strField(rec['by']) ?? strField(rec['agentKey']) ?? actor;
      return who === null ? event : `${event} by ${who}`;
    }
    case 'lead': {
      if (event === 'lead-release') return 'lead released';
      const to = strField(rec['to']);
      return to === undefined ? event : `lead → ${to}`;
    }
    case 'member': {
      const key = strField(rec['agentKey']);
      if (key === undefined) return event;
      return event === 'member-stopped' ? `member stopped ${key}` : `${event} ${key}`;
    }
    default:
      return event;
  }
}

/** 一条引擎事件行 → 归一化事件（形状不符返回 undefined——调用方跳过）。 */
export function normalizeTimelineEvent(value: unknown): TimelineEvent | undefined {
  if (!isRecord(value)) return undefined;
  const event = strField(value['event']);
  const ts = numField(value['ts']);
  if (event === undefined || ts === undefined) return undefined;
  const actor = actorOf(value);
  return {
    ts,
    event,
    family: timelineFamilyOf(event),
    actor,
    taskId: strField(value['taskId']) ?? null,
    summary: summarize(event, value, actor),
  };
}

// ---------------------------------------------------------------------------
// 尾部窗口读（I/O 只在本节；窗口首行丢弃防半行）
// ---------------------------------------------------------------------------

interface TailRead {
  text: string;
  /** 文件是否被窗口截断（size > TAIL_READ_MAX_BYTES）。 */
  windowed: boolean;
  fileBytes: number;
}

async function readTail(file: string): Promise<TailRead | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null; // ENOENT 等 → 无日志
  }
  try {
    const size = (await handle.stat()).size;
    if (size <= TAIL_READ_MAX_BYTES) {
      const text = await handle.readFile({ encoding: 'utf8' });
      return { text, windowed: false, fileBytes: size };
    }
    const start = size - TAIL_READ_MAX_BYTES;
    const buffer = Buffer.alloc(TAIL_READ_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TAIL_READ_MAX_BYTES, start);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), windowed: true, fileBytes: size };
  } finally {
    await handle.close();
  }
}

/**
 * 读时间线（新→旧；offset 自最新往回跳过；limit 钳 100；预算开窗 + 截断披露）。
 * 文件不存在 → 空结果（total 0）。坏行跳过（parseJsonl 纪律）。
 */
export async function readTimeline(file: string, options: TimelineReadOptions): Promise<TimelineResult> {
  const budgetChars = Math.max(1, Math.trunc(options.budgetChars));
  const requestedLimit = options.limit === undefined
    ? TIMELINE_DEFAULT_LIMIT
    : Math.max(1, Math.trunc(options.limit));
  const limit = Math.min(requestedLimit, TIMELINE_MAX_LIMIT);
  const limitClamped = requestedLimit > TIMELINE_MAX_LIMIT
    ? { requested: requestedLimit, applied: TIMELINE_MAX_LIMIT }
    : undefined;
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));

  const tail = await readTail(file);
  if (tail === null) {
    return {
      events: [], shown: 0, total: 0, offset, limit, budgetChars,
      ...(limitClamped !== undefined ? { limitClamped } : {}),
    };
  }
  // 窗口截断时丢弃首行（可能被截断的半行）；整文件读时保留全部。
  const text = tail.windowed ? tail.text.slice(tail.text.indexOf('\n') + 1) : tail.text;
  const { values } = parseJsonl(text);
  const normalized: TimelineEvent[] = [];
  for (const value of values) {
    const event = normalizeTimelineEvent(value);
    if (event !== undefined) normalized.push(event);
  }
  normalized.reverse(); // 文件是追加序（旧→新）→ 反转为新→旧
  const total = normalized.length;

  const page = normalized.slice(offset, offset + limit);
  const costs = page.map((e) => JSON.stringify(e).length);
  const shown = batchWindowCount(costs, budgetChars);
  const events = page.slice(0, shown);
  const truncated = shown < page.length
    ? { shown: offset + shown, total, offset, budgetChars }
    : undefined;
  return {
    events,
    shown: events.length,
    total,
    offset,
    limit,
    ...(limitClamped !== undefined ? { limitClamped } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(tail.windowed
      ? {
          tailWindowBytes: tail.fileBytes,
          ...(total < limit + offset ? { olderEventsOmitted: true } : {}),
        }
      : {}),
    budgetChars,
  };
}
