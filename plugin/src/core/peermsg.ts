/**
 * W5 msg-core: the cross-session message store.
 *
 * Three zones (DESIGN-V0.3.md §7.1):
 *
 * | file | role | writer | reader |
 * |---|---|---|---|
 * | `inbox/<sid>.jsonl` | transport level (degradation path, pre-gate) | sender (peer absent) | receiving MCP server |
 * | `queue/<sid>.jsonl` | delivery level (post-gate, model visible) | receiving MCP server | the three consumption faces |
 * | `held/<sid>/<msgId>.json` | hold quarantine | receiving MCP server | `xc_peer_review` |
 *
 * Drain protocol = rename swap-out (FEASIBILITY-V0.3 §4 T4, measured not to
 * lose messages):
 * 1. `rename(queue/<sid>.jsonl -> queue/<sid>.drain-<ts>-<rand>.jsonl)` — a
 *    concurrent appender keeps writing into the swapped-out file on Windows
 *    (T4 F3: 51 + 2 = 53 all consumed);
 * 2. parse; the trailing half line (no terminating `\n`) is written BACK to
 *    `queue/<sid>.jsonl` (T4 F4: a half line that straddles two drains is not
 *    recoverable, so it must be handled here);
 * 3. delete the swapped-out file after a successful parse;
 * 4. a failed rename (ENOENT) means another consumer drained it — silent
 *    success.
 *
 * Admission gates (DESIGN-V0.3 §6.5, four gates; CC gate vocabulary @2954304
 * and the admission gate `D()` @34186804):
 * | gate | v0.3 default |
 * |---|---|
 * | per-sender token bucket | 30 messages / 10 s |
 * | msgId de-duplication | last 256 msgIds on the receiving side |
 * | relay-depth guard | depth > 2 is dropped (zcode's stricter face) |
 * | in-flight queue cap | 1024 (v0.5.2 起；此前 64，可配 `XC_PEER_MAX_QUEUE_DEPTH`) |
 *
 * NOTE on the relay-depth gate and `selfSent`: CC's `k()` lets a self-sent
 * message through as the FIRST branch (`if(e?.selfSent) return {policy:"accept"}`
 * @34185568), so `selfSent` is NOT subject to the relay-depth gate (the
 * previous zcode design wrongly dropped it — DESIGN-V0.3 §6.5).
 *
 * @module core/peermsg
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic, stripLeadingBom } from './atomic.js';
import { appendJsonl } from './jsonl.js';
import {
  peerHeldDir,
  peerHeldFile,
  peerInboxFile,
  peerQueueFile,
} from './peerdir.js';

export { renderPeerReceipt, renderPeerEnvelope, parsePeerEnvelope } from './peerenvelope.js';
export type { PeerEnvelopeAttrs, PeerReceiptState } from './peerenvelope.js';

// ---------------------------------------------------------------------------
// 记录结构
// ---------------------------------------------------------------------------

/** One queued peer message (DESIGN-V0.3 §7.2; CC's flattened @36100801 entry). */
export interface PeerQueueItem {
  /** Idempotency key (de-duplication gate). */
  msgId: string;
  /** Sender peer name. */
  from: string;
  /** Sender session id. */
  fromSessionId?: string;
  /** Sender display name (CJK allowed; never used for addressing). */
  fromName?: string;
  /** Sender's asserted permission class. */
  fromMode?: 'bypass' | 'prompting';
  /** Relay chain (loop guard). */
  hopChain: string[];
  /** Free text — the only message body shape in this domain. */
  text: string;
  /** Optional summary (mirrors the SendMessage argument shape @34233387). */
  summary?: string;
  /** Timestamp. */
  ts: number;
  /** How the message arrived. */
  via: 'pipe' | 'file';
  /** v0.5（R-11）：作者身份标记（wire 帧 origin；absent = agent）。 */
  origin?: 'user' | 'agent';
  /** v0.5（R-11）：最初作者会话。 */
  originSessionId?: string;
  /** v0.5（R-15-2）：接收路径盖的可疑信封标记。 */
  forged?: boolean;
}

// ---------------------------------------------------------------------------
// 限额常量（§6.5）
// ---------------------------------------------------------------------------

/** Per-sender token bucket: messages per window. */
export const PEER_RATE_LIMIT = 30;
/** Token bucket window. */
export const PEER_RATE_WINDOW_MS = 10_000;
/** De-duplication window size (recently accepted msgIds). */
export const PEER_DEDUP_LIMIT = 256;
/**
 * In-flight queue cap per session.
 *
 * v0.5.2（SCALE-2 修复）：默认 64 → **1024**。红队二番战实测（10 发送方 ×10 条、
 * 不 drain）队列在第 64/65 条起以 `queue-full` 永久丢弃，而队内邮箱同规模
 * （1,000 条）全部入队——peer 轴这道闸既未文档化又与队内行为不一致。
 * 提高默认值后 fan-in 突发（红队 300 条扇入）不再丢消息；上限本身保留
 * （无界队列 = 接收方磁盘无界增长），且改为可配（`XC_PEER_MAX_QUEUE_DEPTH`）。
 */
export const PEER_MAX_QUEUE_DEPTH = 1024;

/**
 * 入站队列深度上限（可配：env `XC_PEER_MAX_QUEUE_DEPTH`）。
 * 口径与 `XC_INJECT_*` 一致：未设 / 空串 / 非正 / 非安全整数 = 未设 → 内置默认。
 */
export function peerMaxQueueDepthFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env['XC_PEER_MAX_QUEUE_DEPTH'];
  if (raw === undefined || raw.trim() === '') return PEER_MAX_QUEUE_DEPTH;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : PEER_MAX_QUEUE_DEPTH;
}
/** Relay depth above which a message is dropped. */
export const PEER_MAX_HOP_DEPTH = 2;
/** Hold quarantine capacity (CC `Q` = 100, @34182692). */
export const PEER_HOLD_CAPACITY = 100;
/** Default hold TTL (12 h — zcode's own value, CC's is unmeasured, SPEC R-21). */
export const PEER_HOLD_TTL_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/** Append one item to the transport-level inbox (degradation path). */
export async function appendPeerInbox(root: string, sessionId: string, item: PeerQueueItem): Promise<void> {
  await appendPeerQueueFile(peerInboxFile(root, sessionId), item);
}

/** Append one item to the delivery-level queue (post-gate, model visible). */
export async function appendPeerQueue(root: string, sessionId: string, item: PeerQueueItem): Promise<void> {
  await appendPeerQueueFile(peerQueueFile(root, sessionId), item);
}

async function appendPeerQueueFile(file: string, item: PeerQueueItem): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendJsonl(file, [JSON.stringify(item)]);
}

// ---------------------------------------------------------------------------
// 排空（rename 换出 + 半行写回）
// ---------------------------------------------------------------------------

/** Outcome of one drain. */
export interface PeerDrainResult {
  /** Consumed items (already valid). */
  items: PeerQueueItem[];
  /** Number of malformed lines that were skipped. */
  malformed: number;
}

/** Whether a value looks like a queue item. */
export function isPeerQueueItem(value: unknown): value is PeerQueueItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item['msgId'] === 'string'
    && typeof item['from'] === 'string'
    && typeof item['text'] === 'string'
    && typeof item['ts'] === 'number'
    && (item['via'] === 'pipe' || item['via'] === 'file')
    && Array.isArray(item['hopChain']);
}

/**
 * Write the leftovers back to the head of the target file.
 *
 * The leftovers are the complete lines that exceeded `limit` plus the trailing
 * half line. They logically precede anything a concurrent writer appended
 * after the swap-out, so they are PREPENDED. A fragment (no terminating `\n`)
 * gets a newline terminator so it can never merge with the line that follows
 * it — it then reads back as one malformed line (T4 F4 semantics) instead of
 * corrupting a good message.
 */
async function writeBackLeftovers(file: string, leftoverLines: string[], fragment: string): Promise<void> {
  const payload = leftoverLines.length > 0
    ? `${leftoverLines.join('\n')}\n${fragment}`
    : fragment;
  if (payload === '') return;
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    existing = '';
  }
  const needsSeparator = existing !== '' && !payload.endsWith('\n');
  const next = payload + (needsSeparator ? '\n' : '') + existing;
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, next);
}

/**
 * Drain one JSONL peer file with the rename swap-out protocol.
 * @param file the inbox/queue file
 * @param limit maximum number of items to return; the rest stay in the file
 */
export async function drainPeerFile(file: string, limit?: number): Promise<PeerDrainResult> {
  const swapped = `${file}.drain-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(file, swapped);
  } catch (error) {
    // ENOENT = another consumer drained it -> silent success.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], malformed: 0 };
    throw error;
  }

  let raw: string;
  try {
    raw = await readFile(swapped, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], malformed: 0 };
    throw error;
  }

  const lastNewline = raw.lastIndexOf('\n');
  const head = lastNewline >= 0 ? raw.slice(0, lastNewline) : '';
  const fragment = lastNewline >= 0 ? raw.slice(lastNewline + 1) : raw;
  const lines = head.split('\n').filter((line) => stripLeadingBom(line).trim() !== '');

  const items: PeerQueueItem[] = [];
  let malformed = 0;
  const validLines: { line: string; item: PeerQueueItem }[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripLeadingBom(line));
    } catch {
      malformed += 1;
      continue;
    }
    if (!isPeerQueueItem(parsed)) {
      malformed += 1;
      continue;
    }
    validLines.push({ line, item: parsed });
  }

  // Complete but malformed lines are dropped (they are garbage); the trailing
  // HALF line is written back below — only a half line can still be completed.
  const take = limit === undefined ? validLines.length : Math.min(limit, validLines.length);
  for (const entry of validLines.slice(0, take)) items.push(entry.item);
  const leftoverLines = validLines.slice(take).map((entry) => entry.line);
  await writeBackLeftovers(file, leftoverLines, fragment);
  await rm(swapped, { force: true });
  return { items, malformed };
}

/** Drain the delivery-level queue of one session. */
export async function drainPeerQueue(root: string, sessionId: string, limit?: number): Promise<PeerQueueItem[]> {
  const result = await drainPeerFile(peerQueueFile(root, sessionId), limit);
  return result.items;
}

/** Drain the transport-level inbox of one session. */
export async function drainPeerInbox(root: string, sessionId: string, limit?: number): Promise<PeerQueueItem[]> {
  const result = await drainPeerFile(peerInboxFile(root, sessionId), limit);
  return result.items;
}

/** Read the queue without consuming it (observation only). */
export async function readPeerQueue(root: string, sessionId: string): Promise<PeerQueueItem[]> {
  const file = peerQueueFile(root, sessionId);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const items: PeerQueueItem[] = [];
  for (const line of raw.split('\n')) {
    if (stripLeadingBom(line).trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(stripLeadingBom(line));
      if (isPeerQueueItem(parsed)) items.push(parsed);
    } catch {
      // Malformed lines are ignored by the read-only view.
    }
  }
  return items;
}

/** Number of items currently queued for one session. */
export async function peerQueueDepth(root: string, sessionId: string): Promise<number> {
  return (await readPeerQueue(root, sessionId)).length;
}

// ---------------------------------------------------------------------------
// 入队闸（四闸）
// ---------------------------------------------------------------------------

/** One sender's token bucket. */
export interface RateBucket {
  count: number;
  windowStart: number;
}

/** Rate + de-duplication state (owned by the caller, passed into the gate). */
export interface RateBuckets {
  /** Per-sender buckets. */
  bySender: Map<string, RateBucket>;
  /** Recently accepted msgIds (insertion ordered). */
  byMsgId: Map<string, number>;
}

/** Fresh rate/de-duplication state. */
export function createRateBuckets(): RateBuckets {
  return { bySender: new Map(), byMsgId: new Map() };
}

/** Admission input (DESIGN-V0.3 §10.2, W5 block). */
export interface PeerAdmissionInput {
  /** Current time. */
  now: number;
  /** Sender name (bucket key). */
  sender: string;
  /** Message id (de-duplication key). */
  msgId: string;
  /** Relay chain. */
  hopChain: string[];
  /** Whether the message was sent by this session itself. */
  selfSent: boolean;
  /** Current in-flight queue depth. */
  queueDepth: number;
  /**
   * Queue cap override (v0.5.2 SCALE-2：`XC_PEER_MAX_QUEUE_DEPTH` 可配)。
   * 缺省 = {@link PEER_MAX_QUEUE_DEPTH}。
   */
  maxQueueDepth?: number;
  /** Rate + de-duplication state (mutated on admission). */
  buckets: RateBuckets;
}

/** Admission verdict. */
export interface PeerAdmissionVerdict {
  ok: boolean;
  /** Machine-readable drop reason. */
  reason?: 'rate-limited' | 'duplicate' | 'loop-depth' | 'queue-full';
}

/** Whether a msgId was already accepted inside the de-duplication window. */
export function peerMsgIdSeen(buckets: RateBuckets, msgId: string): boolean {
  return buckets.byMsgId.has(msgId);
}

/** Remember an accepted msgId, keeping the window at {@link PEER_DEDUP_LIMIT}. */
export function rememberPeerMsgId(buckets: RateBuckets, msgId: string): void {
  buckets.byMsgId.set(msgId, Date.now());
  while (buckets.byMsgId.size > PEER_DEDUP_LIMIT) {
    const oldest = buckets.byMsgId.keys().next();
    if (oldest.done === true) break;
    buckets.byMsgId.delete(oldest.value);
  }
}

/**
 * Consume one token from a sender's bucket.
 * @returns false when the sender is over the limit.
 */
export function consumePeerRate(buckets: RateBuckets, sender: string, now: number): boolean {
  const bucket = buckets.bySender.get(sender);
  if (bucket === undefined || now - bucket.windowStart >= PEER_RATE_WINDOW_MS) {
    buckets.bySender.set(sender, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= PEER_RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}

/**
 * The four admission gates (DESIGN-V0.3 §6.5).
 * Order: rate limit -> de-duplication -> relay depth -> queue depth.
 * `selfSent` skips the relay-depth gate (CC `k()` first branch).
 */
export function admitPeerMessage(input: PeerAdmissionInput): PeerAdmissionVerdict {
  const { now, sender, msgId, hopChain, selfSent, queueDepth, buckets } = input;
  const maxQueueDepth = input.maxQueueDepth ?? PEER_MAX_QUEUE_DEPTH;

  if (!consumePeerRate(buckets, sender, now)) {
    return { ok: false, reason: 'rate-limited' };
  }
  if (peerMsgIdSeen(buckets, msgId)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (!selfSent && hopChain.length > PEER_MAX_HOP_DEPTH) {
    return { ok: false, reason: 'loop-depth' };
  }
  if (queueDepth >= maxQueueDepth) {
    return { ok: false, reason: 'queue-full' };
  }
  rememberPeerMsgId(buckets, msgId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// hold 隔离区（W4 的语义层调用这里的 IO 原语）
// ---------------------------------------------------------------------------

/**
 * One quarantined (held) message.
 *
 * The on-disk shape is the one W4's reader understands
 * (`{item, cause, announcedCauses, heldAt, expiresAt}`); W4's reader is
 * tolerant, so a file written here is readable there and vice versa.
 */
export interface HeldPeerMessage {
  item: PeerQueueItem;
  /** The most recent hold cause. */
  cause: string;
  /** Causes already announced for this message (CC @2901183). */
  announcedCauses: string[];
  /** When it was held. */
  heldAt: number;
  /** When the approval window ends. */
  expiresAt: number;
  /** Absolute path of the quarantine file (the file name is not derivable from
   *  the msgId alone — the segment is sanitized). */
  file: string;
}

/** Read one quarantine file (tolerant: a broken file reads as undefined). */
async function readHeldFile(file: string): Promise<HeldPeerMessage | undefined> {
  try {
    const parsed: unknown = JSON.parse(stripLeadingBom(await readFile(file, 'utf8')));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (!isPeerQueueItem(record['item'])) return undefined;
    const cause = typeof record['cause'] === 'string' ? record['cause'] : 'unknown';
    const heldAt = typeof record['heldAt'] === 'number' ? record['heldAt'] : 0;
    const announcedCauses = Array.isArray(record['announcedCauses'])
      ? (record['announcedCauses'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : [cause];
    const expiresAt = typeof record['expiresAt'] === 'number' ? record['expiresAt'] : heldAt + PEER_HOLD_TTL_MS;
    return { item: record['item'], cause, announcedCauses, heldAt, expiresAt, file };
  } catch {
    return undefined;
  }
}

/** Write one message into the hold quarantine. */
export async function writeHeldPeerMessage(
  root: string,
  sessionId: string,
  item: PeerQueueItem,
  cause: string,
  now: number = Date.now(),
  ttlMs: number = PEER_HOLD_TTL_MS,
): Promise<{ evicted?: HeldPeerMessage }> {
  const dir = peerHeldDir(root, sessionId);
  await mkdir(dir, { recursive: true });
  const file = peerHeldFile(root, sessionId, item.msgId);
  // Fast path: only the target file is read (the quarantine is a flat
  // directory; a full enumeration on every write is O(n) per write).
  const current = await readHeldFile(file);
  if (current !== undefined) {
    // Same message, new cause: keep the announced-cause history (CC @2901183).
    const announcedCauses = current.announcedCauses.includes(cause)
      ? current.announcedCauses
      : [...current.announcedCauses, cause];
    const updated: HeldPeerMessage = { ...current, cause, announcedCauses };
    await writeFileAtomic(current.file, `${JSON.stringify(updated, null, 2)}\n`);
    return { evicted: undefined };
  }
  let evicted: HeldPeerMessage | undefined;
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }
  if (entries.filter((name) => name.endsWith('.json')).length >= PEER_HOLD_CAPACITY) {
    // CC evicts the OLDEST entry when the buffer is full (@34187621) and
    // reports it as `expired`.
    const all = await listHeldPeerMessages(root, sessionId);
    const oldest = all[0];
    if (oldest !== undefined) {
      evicted = oldest;
      await rm(oldest.file, { force: true });
    }
  }
  const held: HeldPeerMessage = {
    item,
    cause,
    announcedCauses: [cause],
    heldAt: now,
    expiresAt: now + ttlMs,
    file,
  };
  await writeFileAtomic(file, `${JSON.stringify(held, null, 2)}\n`);
  return { evicted };
}

/** List the held messages of one session (oldest first). */
export async function listHeldPeerMessages(root: string, sessionId: string): Promise<HeldPeerMessage[]> {
  const dir = peerHeldDir(root, sessionId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const held: HeldPeerMessage[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const message = await readHeldFile(join(dir, entry));
    if (message !== undefined) held.push(message);
  }
  held.sort((a, b) => (a.heldAt - b.heldAt) || a.item.msgId.localeCompare(b.item.msgId));
  return held;
}

/** Remove one held message (released or discarded) by its msgId. */
export async function removeHeldPeerMessage(root: string, sessionId: string, msgId: string): Promise<void> {
  const entries = await listHeldPeerMessages(root, sessionId);
  const target = entries.find((entry) => entry.item.msgId === msgId);
  if (target !== undefined) {
    await rm(target.file, { force: true });
    return;
  }
  await rm(peerHeldFile(root, sessionId, msgId), { force: true });
}

/** Number of held messages of one session. */
export async function countHeldPeerMessages(root: string, sessionId: string): Promise<number> {
  return (await listHeldPeerMessages(root, sessionId)).length;
}

/**
 * Drop the held messages whose TTL expired.
 * @returns the expired messages (the caller turns them into `expired` receipts).
 */
export async function expireHeldPeerMessages(
  root: string,
  sessionId: string,
  ttlMs: number = PEER_HOLD_TTL_MS,
  now: number = Date.now(),
): Promise<HeldPeerMessage[]> {
  const held = await listHeldPeerMessages(root, sessionId);
  const expired: HeldPeerMessage[] = [];
  for (const message of held) {
    const deadline = message.expiresAt > 0 ? message.expiresAt : message.heldAt + ttlMs;
    if (now < deadline) continue;
    expired.push(message);
    await rm(message.file, { force: true });
  }
  return expired;
}

/** Whether the queue file exists and is non-empty (used by the drain faces). */
export async function peerQueueHasContent(root: string, sessionId: string): Promise<boolean> {
  try {
    const info = await stat(peerQueueFile(root, sessionId));
    return info.size > 0;
  } catch {
    return false;
  }
}
