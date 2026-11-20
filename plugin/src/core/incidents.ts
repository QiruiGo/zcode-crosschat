/**
 * v0.9.2（A3，方案 §二 组A）：**回合开始事故摘要**的计数真源与文案（M1 纯函数 + 只读投影）。
 *
 * 背景（用户核心诉求「进程断了主控应当收到新消息」）：看门狗（engine/watchdog.ts）只在
 * **lead 的 MCP server 进程活着**时才推得住；该进程与 lead 会话一同死亡时，成员死亡 /
 * limbo 降级 / 唤醒失败就再无推送面。A3 是这道缺口的总保险：UserPromptSubmit 钩子在
 * **每个回合开始**把「自上次回合（registry 的 lastTurnTs）至今」的事故计数注入置顶块——
 * 只要 lead 还愿意开下一个回合，就必然看见。
 *
 * 口径（写死，验收常量）：
 * - **窗口** = [上一回合的 lastTurnTs, 本回合开始]；无上一回合记录（存量会话首回合）
 *   → 无窗口 → **零注入**（不回归 v0.8.1 的零块 stdout 契约，也不虚报「无事故」）；
 * - **成员死亡** = `member-dead` 事件（看门狗的 alive→dead 迁移，杀伤一次）按成员键去重；
 * - **limbo 降级** = `message-limbo` 事件条数（一条事件 = 一条消息降级回 unread）；
 * - **唤醒失败** = `wake-failed` + `wake-retry-failed` 事件条数（spawn 同步失败 /
 *   唤醒子失败证据 / 重试再失败；容量闸 deferral 与唤醒跳过不计失败）；
 * - **零事故零注入**：三个计数全 0 → 不产块（数据即收口条件，与 G-14 未读提醒同口径）。
 *
 * 读法纪律：engine.jsonl 是 O_APPEND 明文审计账（同机可改写，威胁模型口径不作可信
 * 凭据）——本模块只做**观测投影**：只读尾部窗口（{@link INCIDENT_TAIL_BYTES_DEFAULT}
 * 字节，超限只取尾段并丢弃可能被截断的首行），永不改写、永不扫描全史；读取失败
 * （缺文件/IO）→ 零计数（钩子永不因观测面失败）。
 *
 * @module core/incidents
 */
import { open } from 'node:fs/promises';
import { engineLogFile } from './paths.js';

/** 事故窗口默认尾部读取上限（256 KiB）——钩子进程 10s 生存期内的读取预算。 */
export const INCIDENT_TAIL_BYTES_DEFAULT = 262_144;

/** 成员死亡事件名（engine/watchdog.ts 的唯一生产者；A3 只消费）。 */
export const MEMBER_DEAD_EVENT = 'member-dead';
/** limbo 降级事件名（engine/wake.ts / engine/watchdog.ts 的生产者）。 */
export const MESSAGE_LIMBO_EVENT = 'message-limbo';
/** 唤醒失败事件名（engine/wake.ts releaseOnFailure 的两种 event）。 */
export const WAKE_FAILED_EVENTS = ['wake-failed', 'wake-retry-failed'] as const;

/** 一次事故窗口的计数（A3 注入块与审计共用的单一形状）。 */
export interface IncidentCounts {
  /** 窗口起点（epoch ms；= 上一回合的 lastTurnTs）。 */
  since: number;
  /** 成员死亡数（按成员键去重）。 */
  memberDead: number;
  /** limbo 降级条数（message-limbo 事件数）。 */
  limboDowngraded: number;
  /** 唤醒失败次数（wake-failed + wake-retry-failed）。 */
  wakeFailed: number;
  /** 死亡成员键（去重、保序；注入块点名用）。 */
  deadMembers: string[];
  /** 总事故数（三个计数之和；0 = 零注入）。 */
  total: number;
}

/** 空计数（无文件/无事件/窗口外无事故）。 */
export function emptyIncidentCounts(since: number): IncidentCounts {
  return { since, memberDead: 0, limboDowngraded: 0, wakeFailed: 0, deadMembers: [], total: 0 };
}

/** engine.jsonl 的一行（本模块只认这三个字段；其余字段原样不管）。 */
export interface IncidentEventLine {
  ts: number;
  event: string;
  member?: unknown;
  to?: unknown;
}

/**
 * 计数（纯函数；事件由调用方喂进来——行级 `ts` 由 core/log.ts 盖写）。
 *
 * `member-dead` 的成员标识取 `member` 字段，缺省回退 `to`（看门狗恒写 member；回退
 * 只为容忍历史行形状）。去重按成员键：同一成员一次死亡只计一次（看门狗本身也只发一次，
 * 去重是防御纵深，防审计账被外部追加重复行时虚报）。
 */
export function countIncidents(
  events: readonly IncidentEventLine[],
  since: number,
): IncidentCounts {
  const counts = emptyIncidentCounts(since);
  const seenDead = new Set<string>();
  for (const event of events) {
    if (!Number.isFinite(event.ts) || event.ts <= since) continue;
    if (event.event === MEMBER_DEAD_EVENT) {
      const key = typeof event.member === 'string' && event.member !== ''
        ? event.member
        : typeof event.to === 'string' ? event.to : null;
      if (key !== null && !seenDead.has(key)) {
        seenDead.add(key);
        counts.deadMembers.push(key);
      }
      counts.memberDead = seenDead.size;
      continue;
    }
    if (event.event === MESSAGE_LIMBO_EVENT) {
      counts.limboDowngraded += 1;
      continue;
    }
    if ((WAKE_FAILED_EVENTS as readonly string[]).includes(event.event)) {
      counts.wakeFailed += 1;
    }
  }
  counts.total = counts.memberDead + counts.limboDowngraded + counts.wakeFailed;
  return counts;
}

/** 解析尾部文本为事件行（坏行跳过——与 jsonl.ts 的宽容读取同口径，观测面永不为难）。 */
export function parseIncidentLines(text: string): IncidentEventLine[] {
  const out: IncidentEventLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // 截断的半行 / 坏行：跳过（不虚报、不抛）
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record['ts'] !== 'number' || typeof record['event'] !== 'string') continue;
    out.push({
      ts: record['ts'],
      event: record['event'],
      ...(typeof record['member'] === 'string' ? { member: record['member'] } : {}),
      ...(typeof record['to'] === 'string' ? { to: record['to'] } : {}),
    });
  }
  return out;
}

/**
 * 读 engine.jsonl 尾部并计数（有界读取；只读投影，永不改写）。
 *
 * 尾段起点之前的**首行可能被截断**（字节切分不问行边界）——直接丢弃该行，只从第一个
 * 完整换行之后算起：宁可少算窗口边界上的一条，也不把半行当坏行虚报/漏算。
 *
 * @param since 窗口起点（epoch ms）；事件 ts <= since 不计（「自上次回合」为左开右闭）。
 * @param maxBytes 尾部读取上限（缺省 {@link INCIDENT_TAIL_BYTES_DEFAULT}）。
 */
export async function readIncidentsSince(
  stateRoot: string,
  since: number,
  opts: { maxBytes?: number } = {},
): Promise<IncidentCounts> {
  const file = engineLogFile(stateRoot);
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return emptyIncidentCounts(since); // 缺文件/不可开：无事故可报（钩子永不失败）
  }
  try {
    const size = (await handle.stat()).size;
    const maxBytes = opts.maxBytes ?? INCIDENT_TAIL_BYTES_DEFAULT;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length === 0) return emptyIncidentCounts(since);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    return countIncidents(parseIncidentLines(text), since);
  } catch {
    return emptyIncidentCounts(since); // 读取意外：观测面尽力而为
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 事故摘要块（纯函数文案；置顶注入）。
 *
 * 三条硬口径（与 renderTurnStartReminder 同族）：
 * 1. **置顶**：调用方 unshift 进 blocks（先于未读强提醒与 peer 信封）；
 * 2. **如实计数与口径**：明写窗口起点（ISO + 相对分钟）与三个计数的来源事件名，
 *    点名死亡成员键——不笼统说「有异常」；
 * 3. **平台边界如实声明**：只能注入上下文，不能否决或拦截任何工具调用；本块是看门狗
 *    未覆盖时的**最后保险**，不是拦截器。
 *
 * 无事故时调用方不得调用本函数（零注入由计数收口，见 {@link readIncidentsSince}）。
 */
export function renderIncidentSummary(counts: IncidentCounts, now: number): string {
  const minutes = Math.max(0, Math.round((now - counts.since) / 60_000));
  const parts: string[] = [];
  if (counts.memberDead > 0) {
    parts.push(`${counts.memberDead} 个成员死亡（${counts.deadMembers.join('、')}）`);
  }
  if (counts.limboDowngraded > 0) {
    parts.push(`${counts.limboDowngraded} 条 limbo 降级`);
  }
  if (counts.wakeFailed > 0) {
    parts.push(`${counts.wakeFailed} 次唤醒失败`);
  }
  return (
    `[zcode-crosschat] ⚠ 协作事故摘要（自上次回合 ${new Date(counts.since).toISOString()}，约 ${minutes} 分钟前）：`
    + `${parts.join('；')}。`
    + '成员死亡与唤醒失败说明推送唤醒可能没有到达目标——相关消息仍在邮箱（pull 兜底不丢），'
    + '请用 xc_overview 看在册成员活性与未读，用 xc_dispatch 重派或 xc_team({action:"member-add"}) 幂等重供给。'
    + '平台边界（如实声明）：本块只能注入上下文，不能否决或拦截任何工具调用；'
    + '看门狗只在 lead 的 MCP server 存活期间推送，本摘要是它未覆盖时的最后保险。'
  );
}
