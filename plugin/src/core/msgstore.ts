/**
 * v0.5 轴③+轴②：消息全文 store（DESIGN-V0.5.md §5.5；SPEC R-21 经 F-3）。
 * peers/messages/<msgId>.json = {msgId, storedAt, bytes, sha256, text, from?, origin?,
 * originSessionId?, hopChain?}；msgId 即键，无索引文件。
 *
 * 写入时机（F-3，复核 P2）：**接收入队即幂等落盘**（pipe 接受路径与 held 晋升路径两个
 * appendPeerQueue 落点后各写一次，M5 接线 §6.3-11）——排空即消费（drainPeerFile rename
 * 换出 peermsg.ts:177-226）后 queue/inbox/held 皆空，forwardOf 与 xc_peer_read 必须
 * 仍能解析原文与 origin 元数据；若按 R-21 原文「首次截断前」才落，普通消息消费后
 * 四处皆空（forwardOf 必败）、超大用户亲述的 store 又缺元数据（溯源恰在转发路径被剥）。
 * R-21 的「队列文件 text 保留全文、截断只在渲染层」原则不变；磁盘代价=每消息一个小
 * JSON，无 TTL 清理（A5-L10）。
 *
 * @module core/msgstore
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic, stripLeadingBom } from './atomic.js';
import { peerMessagesFile, peerQueueFile, peerInboxFile, peerHeldDir } from './peerdir.js';

export interface StoredMessage {
  msgId: string; storedAt: number; bytes: number; sha256: string; text: string;
  /** 溯源元数据（复核 P2）：forwardOf 保真与 xc_peer_read 依赖；from 队列项拷贝。 */
  from?: string;
  fromSessionId?: string;
  origin?: 'user' | 'agent';
  originSessionId?: string;
  hopChain?: string[];
}

/** store 的输入 = PeerQueueItem 的超集切片（msgId/text 必填，元数据可选）。 */
export type StoreInput = Pick<StoredMessage, 'msgId' | 'text'> &
  Partial<Pick<StoredMessage, 'from' | 'fromSessionId' | 'origin' | 'originSessionId' | 'hopChain'>>;

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 幂等落盘：同 msgId 且 sha256 相同 → 跳过（元数据不更新——入队即落已是完整形态）；否则覆写。 */
export async function storePeerMessageFull(
  root: string, item: StoreInput, now = Date.now(),
): Promise<{ stored: boolean }> {
  const file = peerMessagesFile(root, item.msgId);
  const digest = sha256Of(item.text);
  const existing = await readStored(root, item.msgId);
  if (existing !== undefined && existing.sha256 === digest) return { stored: false };
  const record: StoredMessage = {
    msgId: item.msgId, storedAt: now, bytes: Buffer.byteLength(item.text, 'utf8'),
    sha256: digest, text: item.text,
    ...(item.from !== undefined ? { from: item.from } : {}),
    ...(item.fromSessionId !== undefined ? { fromSessionId: item.fromSessionId } : {}),
    ...(item.origin !== undefined ? { origin: item.origin } : {}),
    ...(item.originSessionId !== undefined ? { originSessionId: item.originSessionId } : {}),
    ...(item.hopChain !== undefined ? { hopChain: item.hopChain } : {}),
  };
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(record)}\n`);
  return { stored: true };
}

export async function readStored(root: string, msgId: string): Promise<StoredMessage | undefined> {
  try {
    const parsed: unknown = JSON.parse(stripLeadingBom(await readFile(peerMessagesFile(root, msgId), 'utf8')));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const r = parsed as Record<string, unknown>;
    if (typeof r['msgId'] !== 'string' || typeof r['text'] !== 'string') return undefined;
    return r as unknown as StoredMessage;
  } catch {
    return undefined;
  }
}

/** 扫描 JSONL 队列/收件箱文件尾部的消息记录（msgId → 记录）；cap 行数防大文件全读。 */
async function scanJsonlForMsgId(file: string, msgId: string, tailLines = 2048): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = stripLeadingBom(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  for (const line of lines.slice(-tailLines)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['msgId'] === msgId) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* 半行/坏行跳过（T4 F4 语义） */ }
  }
  return undefined;
}

/** 解析结果：原文 + 完整溯源元组（forwardOf 直接消费）。 */
export interface ResolvedPeerMessage {
  text: string;
  from?: string;
  fromSessionId?: string;
  origin?: 'user' | 'agent';
  originSessionId?: string;
  hopChain?: string[];
}

/**
 * 解析一条本会话可引用的消息（forwardOf 与 xc_peer_read 的查找序，R-22）：
 * messages store（入队即落，主路径）→ held 隔离区 → queue → inbox（后三者兜底，尾部 2048 行）。
 */
export async function resolvePeerMessage(
  root: string, sessionId: string, msgId: string,
): Promise<ResolvedPeerMessage | undefined> {
  const stored = await readStored(root, msgId);
  if (stored !== undefined) return toResolved(stored);       // P2 修复：store 分支回传完整元组
  const { readdir, readFile: rf } = await import('node:fs/promises');
  try {
    for (const name of await readdir(peerHeldDir(root, sessionId))) {
      try {
        const parsed: unknown = JSON.parse(stripLeadingBom(await rf(`${peerHeldDir(root, sessionId)}/${name}`, 'utf8')));
        const item = (parsed as { item?: Record<string, unknown> })?.item ?? (parsed as Record<string, unknown>);
        if (item?.['msgId'] === msgId && typeof item['text'] === 'string') return toResolved(item);
      } catch { /* 坏文件跳过 */ }
    }
  } catch { /* held 目录不存在 */ }
  const fromQueue = await scanJsonlForMsgId(peerQueueFile(root, sessionId), msgId);
  if (fromQueue !== undefined && typeof fromQueue['text'] === 'string') return toResolved(fromQueue);
  const fromInbox = await scanJsonlForMsgId(peerInboxFile(root, sessionId), msgId);
  if (fromInbox !== undefined && typeof fromInbox['text'] === 'string') return toResolved(fromInbox);
  return undefined;
}

function toResolved(item: StoredMessage | Record<string, unknown>): ResolvedPeerMessage {
  return {
    text: item['text'] as string,
    ...(typeof item['from'] === 'string' ? { from: item['from'] as string } : {}),
    ...(typeof item['fromSessionId'] === 'string' ? { fromSessionId: item['fromSessionId'] as string } : {}),
    ...(item['origin'] === 'user' ? { origin: 'user' as const } : item['origin'] === 'agent' ? { origin: 'agent' as const } : {}),
    ...(typeof item['originSessionId'] === 'string' ? { originSessionId: item['originSessionId'] as string } : {}),
    ...(Array.isArray(item['hopChain']) ? { hopChain: item['hopChain'] as string[] } : {}),
  };
}
