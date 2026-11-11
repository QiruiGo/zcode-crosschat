/**
 * v0.5 轴②：用户原话记录与盖章匹配（DESIGN-V0.5.md §4.3；SPEC R-12）。
 *
 * 机理对齐 CC「归属由 harness 从服务端归属生成，绝不依据消息内容」@8685923：
 * origin=user 的唯一产生路径 = 钩子（harness 侧）记录用户原始提示 + 工具落盘前
 * 逐字节匹配。工具没有 origin 参数；正文自称无效。
 *
 * 记录形态（复核 P4 改环形）：{sessionId, updatedAt, prompts:[{ts,text,uses}]×≤8}——
 * 用户第一条转达指令不被后续 prompt 覆盖；窗口外/超长的原话不参与匹配（A5-L8）。
 *
 * 威胁模型边界（V-2，如实声明）：同机模型主动伪造本记录文件可绕过匹配。不做密码学
 * 防御（与 CC verifiedPeerPid 同级）；防线=①钩子进程独写+uservoice-hit 事件与消息
 * 事件交叉审计、②接收侧永不因 origin=user 放宽任何权限、③本条公开声明。
 *
 * 并发声明：钩子进程写与 MCP 进程消费是两个进程，uses 读改写有丢更新窗口；
 * uses 只是节流阀（≤3 次），最坏多一次使用，可接受，不做跨进程锁。
 *
 * @module core/uservoice
 */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic, stripLeadingBom } from './atomic.js';
import { peerUservoiceFile } from './peerdir.js';

/** 单条原话上限（R-12：钩子记录不是消息本体）。 */
export const USERVOICE_TEXT_MAX_CHARS = 64 * 1024;
/** 单条使用上限（R-12：每记录 ≤3 次）。 */
export const USERVOICE_MAX_USES = 3;
/** 环形容量（复核 P4）：保留最近 8 条用户 prompt。 */
export const USERVOICE_RING_CAPACITY = 8;
export const USERVOICE_TTL_DEFAULT_MS = 600_000;

export interface UservoiceEntry { ts: number; text: string; uses: number }
export interface UservoiceRecord { sessionId: string; updatedAt: number; prompts: UservoiceEntry[] }

function ttlFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env['XC_USERVOICE_TTL_MS'];
  if (raw === undefined || raw.trim() === '') return USERVOICE_TTL_DEFAULT_MS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : USERVOICE_TTL_DEFAULT_MS;
}

/** 钩子侧：记录本轮用户原始提示（追加进环形、超容挤掉最旧；与最新一条相同文本则只刷 ts）。 */
export async function uservoiceWrite(
  root: string, sessionId: string, text: string, now: number,
): Promise<void> {
  const capped = text.length > USERVOICE_TEXT_MAX_CHARS
    ? `${text.slice(0, USERVOICE_TEXT_MAX_CHARS)}\n[uservoice truncated at ${USERVOICE_TEXT_MAX_CHARS} chars]`
    : text;
  const file = peerUservoiceFile(root, sessionId);
  await mkdirFor(file);
  const prev = await readRecord(root, sessionId);
  const prompts = [...(prev?.prompts ?? [])];
  const last = prompts[prompts.length - 1];
  if (last !== undefined && last.text === capped) {
    prompts[prompts.length - 1] = { ...last, ts: now };   // 同文本重发：刷新时间窗，不重复占位
  } else {
    prompts.push({ ts: now, text: capped, uses: 0 });
  }
  const record: UservoiceRecord = {
    sessionId, updatedAt: now, prompts: prompts.slice(-USERVOICE_RING_CAPACITY),
  };
  await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
}

async function mkdirFor(file: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(file), { recursive: true });
}

async function readRecord(root: string, sessionId: string): Promise<UservoiceRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(stripLeadingBom(await readFile(peerUservoiceFile(root, sessionId), 'utf8')));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const r = parsed as Record<string, unknown>;
    if (typeof r['sessionId'] !== 'string' || !Array.isArray(r['prompts'])) return undefined;
    const prompts: UservoiceEntry[] = [];
    for (const raw of r['prompts']) {
      if (typeof raw !== 'object' || raw === null) continue;
      const e = raw as Record<string, unknown>;
      if (typeof e['ts'] !== 'number' || typeof e['text'] !== 'string' || typeof e['uses'] !== 'number') continue;
      prompts.push({ ts: e['ts'], text: e['text'], uses: e['uses'] });
    }
    return { sessionId: r['sessionId'], updatedAt: typeof r['updatedAt'] === 'number' ? r['updatedAt'] : 0, prompts };
  } catch {
    return undefined;
  }
}

export type UservoiceMatch =
  | { hit: true; uses: number }
  | { hit: false; reason: 'no-record' | 'expired' | 'uses-exhausted' | 'no-match' };

/**
 * 工具侧：待发正文与本会话环形记录逐条匹配（新→旧，首个命中即用）；命中 → 该条 uses+1 原子覆写。
 * 匹配方向（复核 P5 澄清，R-12 原文语义）：outgoing 是用户 prompt 的**一段**——
 * `outgoing.trim() === entry.text`（全文相等）或 `outgoing.trim().length >= 8 && entry.text.includes(outgoing.trim())`。
 * 「原话拼进自产内容」不构成 prompt 的连续子串 → includes 失败 → origin=agent（piggyback 不可行，§4.3）。
 * 单条目过期/耗尽 → 跳过；全部过期 → 'expired'，全部耗尽 → 'uses-exhausted'；未命中不消耗 uses。
 */
export async function uservoiceMatchAndConsume(
  root: string, sessionId: string, outgoingText: string, now: number, env: NodeJS.ProcessEnv = process.env,
): Promise<UservoiceMatch> {
  const record = await readRecord(root, sessionId);
  if (record === undefined || record.prompts.length === 0) return { hit: false, reason: 'no-record' };
  const ttl = ttlFromEnv(env);
  const trimmed = outgoingText.trim();
  if (trimmed === '') return { hit: false, reason: 'no-match' };
  const live = record.prompts.filter((e) => now - e.ts <= ttl);
  if (live.length === 0) return { hit: false, reason: 'expired' };
  const available = live.filter((e) => e.uses < USERVOICE_MAX_USES);
  if (available.length === 0) return { hit: false, reason: 'uses-exhausted' };
  let matchedIndex = -1;
  for (let i = available.length - 1; i >= 0; i -= 1) {          // 新→旧
    const e = available[i]!;
    if (trimmed === e.text || (trimmed.length >= 8 && e.text.includes(trimmed))) {
      matchedIndex = record.prompts.indexOf(e);
      break;
    }
  }
  if (matchedIndex < 0) return { hit: false, reason: 'no-match' };
  const prompts = [...record.prompts];
  const matched = prompts[matchedIndex]!;
  prompts[matchedIndex] = { ...matched, uses: matched.uses + 1 };
  await writeFileAtomic(peerUservoiceFile(root, sessionId),
    `${JSON.stringify({ ...record, prompts }, null, 2)}\n`);
  return { hit: true, uses: matched.uses + 1 };
}
