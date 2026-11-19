/**
 * v0.8.0 A3（DESIGN-V0.8.md §5）：时间线视图——engine.jsonl **尾部窗口读** + 事件族
 * 归一化（ts/event/family/actor/taskId/summary）。新模块自持尾部窗口，**不改
 * core/jsonl.ts**（只复用其 {@link parseJsonl}）——jsonl.ts 零改动，G1/G3 不受影响。
 *
 * 为什么尾部窗口读：engine.jsonl 无上界（每次工具调用都追加，core/log.ts），
 * readJsonl 是全文件读；窗口 = TAIL_READ_MAX_BYTES（256 KiB），只读末段、按 \n 切行后
 * **丢弃窗口首行**（可能被截断的半行）。文件被窗口截断时**每页**都披露
 * tailWindowBytes/olderEventsOmitted——不假装看全了历史（R7；v0.8.1 C3-B6 修复：
 * 旧实现只在「窗口内事件 < limit+offset」的末页披露，默认首页看不到）。
 *
 * 归一化字段（冻结）：`{ts, event, family, actor, taskId, summary}`。family 是相对
 * 方案字面的增量（方案 §2 A3 自述「事件族」九类，没有字段承载就无法过滤与紧凑呈现，
 * R8-②）。事件族映射表照抄 DESIGN §5；不在表内 → `other`。
 *
 * v0.8.1（29-v080 红队 C3-B1…B8 修复，逐项对应 PROTOCOL §14.4）：
 * - **B1/M03 actor 链**：取值序补 `approvedBy`/`from`/`member`（v0.8.0 冻结链
 *   `agentKey>by>createdBy>assignee>to` 盲区——dispatch/message/tool-approval/
 *   tool-executed 等事件的 actor 落到接收方 `to` 或置空）；dispatch 族摘要的
 *   「by」位只认显式派单方键（createdBy/by/from），缺省时省略 by 子句——
 *   v0.8.0 的 actor 回退把 `dispatch-refused {to:carol}` 渲染成
 *   `dispatch → carol by carol`（自指废话）。
 * - **B2 排序**：按 `ts` 降序（稳定；同 ts 保反向文件序=后写者在前）——v0.8.0 按
 *   文件行位置反向，非单调日志（手改/合并/时钟漂移）下「newest-first」承诺不成立。
 * - **B3 跳过披露**：窗口内未能归一化的非空行（坏行 + 形状不符）计数进
 *   `skippedEvents`（>0 时随 payload/文本披露）——v0.8.0 静默丢弃、total 只计
 *   合法事件，审计者对照文件行数对不上且无从知晓原因。
 * - **B5 taskId 归一**：只接受非空字符串，非字符串类型（数字/布尔/对象/null）
 *   一律归一为 `null`（事件本身保留）——规则随 PROTOCOL §14.4 冻结式文档化。
 * - **B4 控制字符**：文本视图专用清洗助手 {@link timelineTextField}（C0/C1 折空格）；
 *   JSON payload 保持原值（JSON.stringify 正常转义，机器消费方不受影响）。
 *
 * 分页语义（R8-⑤）：limit 缺省 20/上限 100（超限钳制 + limitClamped 披露）；
 * offset = **自最新往回跳过 N 条**（与板面「自头部偏移」不同——工具描述已写明防误用；
 * v0.8.1 C3-B7：该指针是**位置游标**，日志实时追加时会漂移——跳号/重叠，语义在
 * PROTOCOL §14.4 与截断尾注文本双面披露）。
 * 预算：batchWindowCount 对 JSON.stringify(entry).length 开窗；超限给 truncated +
 * 续读指针 xc_overview({view:"timeline", offset:<shown+offset>})。
 * v0.8.1（C3-B8）：预算刻度优先取调用方经 identify 逐会话声明的 contextChars
 * （PROTOCOL §8「逐会话覆盖声明值」），回落 env XC_CONTEXT_CHARS/200k——
 * 解析在 mcp/tools-overview.ts 的 timelineView（本模块只收 budgetChars）。
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

/** 事件族（DESIGN §5 冻结表：九族 + v0.9 增量 liveness + other）。 */
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
  | 'liveness'
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
  // v0.9.1（V090-06）：活性豁免留痕（每任务每阈值周期一行）。
  'task-sweep-deferred': 'sweep',
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
  // v0.9（G-9，PROTOCOL §12.4）：会话活性迁移（core/liveness.ts 冻结命名）。
  'session-running': 'liveness',
  'session-idle': 'liveness',
  // v0.9.1（V090-01/06）：会话记录活性字段异常（伪造/损坏，不产生豁免，据实审计）。
  'session-record-anomaly': 'liveness',
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
  /**
   * 取值序（v0.8.1 冻结）：agentKey ?? by ?? createdBy ?? approvedBy ?? from ??
   * assignee ?? member ?? to ?? null。
   * v0.8.1（C3-B1/M03）补 approvedBy/from/member：v0.8.0 链盲区使
   * dispatch/message/tool-approval/tool-executed 的 actor 落到接收方 `to` 或置空。
   */
  actor: string | null;
  /**
   * 非空字符串原样取之；**非字符串类型（数字/布尔/对象/null/缺省）一律归一为 null**
   * （事件本身保留；规则见 PROTOCOL §14.4，v0.8.1 C3-B5 文档化）。
   */
  taskId: string | null;
  /** 族级确定性模板；缺字段退化到事件名本身——永不为空串。 */
  summary: string;
}

export interface TimelineResult {
  /** 本页事件（ts 降序，已过 offset/limit/预算窗口）。 */
  events: TimelineEvent[];
  /** 本页真实呈现条数（= events.length；预算窗口后）。 */
  shown: number;
  /** 窗口内解析到的事件总数（offset/limit 之前；只计归一化成功的事件）。 */
  total: number;
  offset: number;
  limit: number;
  /** limit > 100 被钳制（requested/applied）。 */
  limitClamped?: { requested: number; applied: number };
  /** 预算截断披露 + 续读指针（offset = shown + offset；位置游标，见 PROTOCOL §14.4）。 */
  truncated?: { shown: number; total: number; offset: number; budgetChars: number };
  /**
   * v0.8.1（C3-B3）：窗口内**非空行**中未能归一化的条数（坏 JSON 行 + 解析成功但
   * 形状不符：非对象/缺 event/ts 非有限数）。>0 时随 payload 披露——total 只计
   * 成功事件，两者相加才与窗口内非空行数对得上（空行按 parseJsonl 纪律不计）。
   */
  skippedEvents?: number;
  /** 文件被尾部窗口截断时的窗口字节数（= 文件实际大小）。 */
  tailWindowBytes?: number;
  /**
   * 文件确被尾部窗口截断（size > TAIL_READ_MAX_BYTES）⇒ **每页都为 true**：
   * 窗口外更早事件从未读入（v0.8.1 C3-B6/M04 修复——v0.8.0 只在远 offset
   * 末页披露，默认首页/limit=100 页看不到）。
   */
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

/**
 * actor 取值序（v0.8.1 冻结）：agentKey ?? by ?? createdBy ?? approvedBy ?? from ??
 * assignee ?? member ?? to ?? null。
 *
 * v0.8.1（C3-B1/M03）键位补全的依据（真实 engine.jsonl 事件形状）：
 * - `approvedBy`（tool-approval）：批准者，必须压过 `from`（请求方）；
 * - `from`（dispatch/message/lead-transfer/tool-request/tool-executed/…）：发送方/行为方，
 *   必须压过 `to`（接收方）——v0.8.0 链缺此键时这些事件的 actor 全落到 `to`；
 * - `member`（task-offline）：事件所涉成员（该事件无 from/to，v0.8.0 下 actor 置空）。
 * 既有键位语义不变：agentKey/by/createdBy 是显式自述，assignee 是任务属主，
 * `to` 退居末位（wake 族等只有收方的通知类事件）。
 */
function actorOf(rec: Record<string, unknown>): string | null {
  return strField(rec['agentKey'])
    ?? strField(rec['by'])
    ?? strField(rec['createdBy'])
    ?? strField(rec['approvedBy'])
    ?? strField(rec['from'])
    ?? strField(rec['assignee'])
    ?? strField(rec['member'])
    ?? strField(rec['to'])
    ?? null;
}

/** 族级确定性模板（缺字段退化到事件名；永不为空串）。 */
function summarize(event: string, rec: Record<string, unknown>, actor: string | null): string {
  const family = timelineFamilyOf(event);
  switch (family) {
    case 'dispatch': {
      const target = strField(rec['to']) ?? strField(rec['assignee']);
      // 「by」位只认显式派单方键（createdBy/by/from）——**不回退到 actor**：
      // v0.8.0 的 actor 回退在 dispatch-refused（只有 to）上渲染出
      // 「dispatch → carol by carol」的自指废话；缺派单方时省略 by 子句。
      const by = strField(rec['createdBy']) ?? strField(rec['by']) ?? strField(rec['from']);
      if (target === undefined) return event;
      return by === undefined ? `dispatch → ${target}` : `dispatch → ${target} by ${by}`;
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
    case 'liveness': {
      // 活性迁移的主角是会话（sessionId）：花名（name）优先呈现，无绑定名退 sid。
      // 不走 actor 链（sessionId 不在其中，v0.8.1 冻结链不动）。
      const who = strField(rec['name']) ?? strField(rec['sessionId']);
      return who === undefined ? event : `${event} ${who}`;
    }
    default:
      return event;
  }
}

/**
 * 一条引擎事件行 → 归一化事件（形状不符返回 undefined——调用方跳过并计入
 * skippedEvents）。taskId 归一（v0.8.1 C3-B5 文档化规则）：只接受非空字符串，
 * 非字符串类型（数字/布尔/对象/null/缺省）一律归一为 null——事件本身保留。
 */
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
 * 读时间线（ts 降序；offset 自最新往回跳过；limit 钳 100；预算开窗 + 截断披露）。
 * 文件不存在 → 空结果（total 0）。坏行/形状不符行跳过并计数披露（skippedEvents）；
 * 文件被尾窗截断 ⇒ 每页披露 tailWindowBytes + olderEventsOmitted（v0.8.1 C3-B6）。
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
  const { values, malformed } = parseJsonl(text);
  const normalized: TimelineEvent[] = [];
  let shapeSkipped = 0;
  for (const value of values) {
    const event = normalizeTimelineEvent(value);
    if (event === undefined) shapeSkipped += 1;
    else normalized.push(event);
  }
  // v0.8.1（C3-B3）：窗口内非空行的跳过计数（坏行 + 形状不符）——静默丢弃 = 审计者对不上账。
  const skippedEvents = malformed.length + shapeSkipped;
  // v0.8.1（C3-B2）：排序依据从「文件行位置」改为 ts 降序（稳定排序：同 ts 保
  // 反向文件序=后写者在前）。文件是追加序（旧→新）→ 先反转为新→旧再按 ts 稳定降序：
  // 产品自身追加时序下 ts 单调，结果与旧实现逐字一致（真实日志零逆序）；
  // 非单调日志（手改/合并/时钟漂移）下「newest-first」承诺仍然成立。
  normalized.reverse();
  normalized.sort((a, b) => b.ts - a.ts);
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
    ...(skippedEvents > 0 ? { skippedEvents } : {}),
    // v0.8.1（C3-B6/M04）：文件被尾窗截断即披露（不论页位）——窗口外更早事件从未读入。
    ...(tail.windowed
      ? {
          tailWindowBytes: tail.fileBytes,
          olderEventsOmitted: true,
        }
      : {}),
    budgetChars,
  };
}

// ---------------------------------------------------------------------------
// 文本视图清洗（v0.8.1 C3-B4）：C0/C1 控制字符折空格
// ---------------------------------------------------------------------------

/**
 * 文本观测面的控制字符清洗（C0 U+0000–U+001F + DEL/C1 U+007F–U+009F → 空格）。
 *
 * 只用于**文本视图**（mcp/tools-overview.ts 的 timeline 行渲染）：engine.jsonl 是
 * 追加型审计日志，外部构造/手改的行可能把裸 NUL/BEL 带进字段，v0.8.0 原样进终端
 * 渲染面（红队 C3-B4）。折空格与 README 证据 note「控制字符入库前清洗为空格」
 * 同口径，且保住单行行结构（\n/\r 一并折掉）。
 * JSON payload **不**走此清洗——JSON.stringify 正常转义，机器消费方拿原值。
 */
export const TIMELINE_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** 文本视图字段清洗（控制字符折空格；其余原样）。 */
export function timelineTextField(value: string): string {
  return value.replace(TIMELINE_CONTROL_CHARS_RE, ' ');
}
