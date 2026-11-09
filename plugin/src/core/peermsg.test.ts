import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PEER_DEDUP_LIMIT,
  PEER_HOLD_CAPACITY,
  PEER_MAX_QUEUE_DEPTH,
  PEER_RATE_LIMIT,
  admitPeerMessage,
  appendPeerInbox,
  appendPeerQueue,
  countHeldPeerMessages,
  createRateBuckets,
  drainPeerInbox,
  drainPeerQueue,
  expireHeldPeerMessages,
  listHeldPeerMessages,
  peerQueueDepth,
  readPeerQueue,
  removeHeldPeerMessage,
  writeHeldPeerMessage,
} from './peermsg.js';
import { peerHeldFile, peerInboxFile, peerQueueFile } from './peerdir.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-peermsg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function item(overrides: Partial<Parameters<typeof appendPeerQueue>[2]> = {}): Parameters<typeof appendPeerQueue>[2] {
  return {
    msgId: 'm1',
    from: 'alice',
    fromSessionId: 'sess_a',
    hopChain: ['alice'],
    text: 'hello',
    ts: 1000,
    via: 'pipe',
    ...overrides,
  };
}

describe('queue io', () => {
  it('appends and drains the delivery queue', async () => {
    await appendPeerQueue(dir, 'sess_a', item({ msgId: 'm1' }));
    await appendPeerQueue(dir, 'sess_a', item({ msgId: 'm2', text: 'second' }));
    const drained = await drainPeerQueue(dir, 'sess_a');
    expect(drained.map((entry) => entry.msgId)).toEqual(['m1', 'm2']);
    expect(drained[1]!.text).toBe('second');
    expect(await peerQueueDepth(dir, 'sess_a')).toBe(0);
  });

  it('appends to and drains the transport inbox', async () => {
    await appendPeerInbox(dir, 'sess_a', item({ msgId: 'i1', via: 'file' }));
    const drained = await drainPeerInbox(dir, 'sess_a');
    expect(drained).toHaveLength(1);
    expect(drained[0]!.via).toBe('file');
  });

  it('keeps the leftovers in the file when a limit is hit', async () => {
    for (const id of ['m1', 'm2', 'm3']) await appendPeerQueue(dir, 'sess_a', item({ msgId: id }));
    const first = await drainPeerQueue(dir, 'sess_a', 2);
    expect(first.map((entry) => entry.msgId)).toEqual(['m1', 'm2']);
    expect((await readPeerQueue(dir, 'sess_a')).map((entry) => entry.msgId)).toEqual(['m3']);
    const second = await drainPeerQueue(dir, 'sess_a');
    expect(second.map((entry) => entry.msgId)).toEqual(['m3']);
  });

  it('writes a trailing half line back into the queue file', async () => {
    const file = peerQueueFile(dir, 'sess_a');
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(item({ msgId: 'm1' }))}\n{"msgId":"m2","from":"b`, 'utf8');
    const drained = await drainPeerQueue(dir, 'sess_a');
    expect(drained.map((entry) => entry.msgId)).toEqual(['m1']);
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('m2');
    // The fragment is kept as a half line: it is never delivered, and the next
    // append truncates it away (core/jsonl.ts contract) instead of merging it
    // into a good line.
    await appendPeerQueue(dir, 'sess_a', item({ msgId: 'm3' }));
    const second = await drainPeerQueue(dir, 'sess_a');
    expect(second.map((entry) => entry.msgId)).toEqual(['m3']);
  });

  it('never delivers a half line and reports it as malformed', async () => {
    const file = peerQueueFile(dir, 'sess_a');
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(file, `{"msgId":"m2","from":"b`, 'utf8');
    const drained = await drainPeerQueue(dir, 'sess_a');
    expect(drained).toHaveLength(0);
  });

  it('two concurrent drains consume every item exactly once', async () => {
    for (let i = 0; i < 20; i += 1) await appendPeerQueue(dir, 'sess_a', item({ msgId: `m${i}` }));
    const [a, b] = await Promise.all([drainPeerQueue(dir, 'sess_a'), drainPeerQueue(dir, 'sess_a')]);
    const all = [...a, ...b].map((entry) => entry.msgId);
    expect(all).toHaveLength(20);
    expect(new Set(all).size).toBe(20);
  });

  it('drains an empty / missing queue without throwing', async () => {
    expect(await drainPeerQueue(dir, 'sess_none')).toEqual([]);
  });

  it('skips malformed complete lines but keeps the good ones', async () => {
    const file = peerQueueFile(dir, 'sess_a');
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(file, `not json\n${JSON.stringify(item({ msgId: 'm1' }))}\n`, 'utf8');
    const drained = await drainPeerQueue(dir, 'sess_a');
    expect(drained.map((entry) => entry.msgId)).toEqual(['m1']);
  });
});

describe('admission gates', () => {
  const base = {
    now: 1_000,
    sender: 'alice',
    msgId: 'm1',
    hopChain: ['alice'],
    selfSent: false,
    queueDepth: 0,
    buckets: createRateBuckets(),
  };

  it('admits a normal message', () => {
    expect(admitPeerMessage(base)).toEqual({ ok: true });
  });

  it('drops a duplicate msgId', () => {
    const buckets = createRateBuckets();
    expect(admitPeerMessage({ ...base, buckets }).ok).toBe(true);
    expect(admitPeerMessage({ ...base, buckets })).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('drops over the per-sender rate limit', () => {
    const buckets = createRateBuckets();
    for (let i = 0; i < PEER_RATE_LIMIT; i += 1) {
      expect(admitPeerMessage({ ...base, buckets, msgId: `m${i}` }).ok).toBe(true);
    }
    expect(admitPeerMessage({ ...base, buckets, msgId: 'overflow' })).toEqual({ ok: false, reason: 'rate-limited' });
  });

  it('drops a relay chain deeper than 2', () => {
    const buckets = createRateBuckets();
    const verdict = admitPeerMessage({ ...base, buckets, hopChain: ['a', 'b', 'c'] });
    expect(verdict).toEqual({ ok: false, reason: 'loop-depth' });
  });

  it('does NOT drop a self-sent message on the relay gate (CC k() first branch)', () => {
    const buckets = createRateBuckets();
    const verdict = admitPeerMessage({ ...base, buckets, selfSent: true, hopChain: ['a', 'b', 'c'] });
    expect(verdict.ok).toBe(true);
  });

  it('drops when the in-flight queue is full', () => {
    const buckets = createRateBuckets();
    const verdict = admitPeerMessage({ ...base, buckets, queueDepth: PEER_MAX_QUEUE_DEPTH });
    expect(verdict).toEqual({ ok: false, reason: 'queue-full' });
  });

  it('keeps the de-duplication window at 256 msgIds', () => {
    const buckets = createRateBuckets();
    for (let i = 0; i < PEER_DEDUP_LIMIT + 20; i += 1) {
      admitPeerMessage({ ...base, buckets, msgId: `m${i}`, now: 10_000 + i, sender: `s${i}` });
    }
    expect(buckets.byMsgId.size).toBe(PEER_DEDUP_LIMIT);
  });
});

describe('hold quarantine', () => {
  it('writes, lists, counts and removes held messages', async () => {
    await writeHeldPeerMessage(dir, 'sess_a', item({ msgId: 'h1' }), 'mode-mismatch', 1000);
    await writeHeldPeerMessage(dir, 'sess_a', item({ msgId: 'h2' }), 'mode-unknown', 2000);
    const held = await listHeldPeerMessages(dir, 'sess_a');
    expect(held.map((entry) => entry.item.msgId)).toEqual(['h1', 'h2']);
    expect(held[0]!.cause).toBe('mode-mismatch');
    expect(await countHeldPeerMessages(dir, 'sess_a')).toBe(2);
    await removeHeldPeerMessage(dir, 'sess_a', 'h1');
    expect(await countHeldPeerMessages(dir, 'sess_a')).toBe(1);
    expect(existsSync(peerHeldFile(dir, 'sess_a', 'h1'))).toBe(false);
  });

  it('evicts the oldest entry when the buffer is full (cap 100, CC Q)', async () => {
    for (let i = 0; i < PEER_HOLD_CAPACITY; i += 1) {
      const result = await writeHeldPeerMessage(dir, 'sess_a', item({ msgId: `h${i}` }), 'mode-unknown', 1000 + i);
      expect(result.evicted).toBeUndefined();
    }
    const overflow = await writeHeldPeerMessage(dir, 'sess_a', item({ msgId: 'overflow' }), 'mode-unknown', 9999);
    expect(overflow.evicted?.item.msgId).toBe('h0');
    expect(await countHeldPeerMessages(dir, 'sess_a')).toBe(PEER_HOLD_CAPACITY);
  });

  it('expires the messages whose TTL elapsed', async () => {
    await writeHeldPeerMessage(dir, 'sess_a', item({ msgId: 'old' }), 'mode-unknown', 1000, 5000);
    await writeHeldPeerMessage(dir, 'sess_a', item({ msgId: 'fresh' }), 'mode-unknown', 9000, 5000);
    const expired = await expireHeldPeerMessages(dir, 'sess_a', 5000, 10_000);
    expect(expired.map((entry) => entry.item.msgId)).toEqual(['old']);
    expect(await countHeldPeerMessages(dir, 'sess_a')).toBe(1);
  });
});
