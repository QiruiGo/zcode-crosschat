/**
 * v0.5 M4 单测：消息全文 store（core/msgstore.ts；DESIGN-V0.5.md §5.5/§6.3-9；
 * SPEC R-21 经 F-3）。覆盖验收 A3f 中归属 store 的用例：幂等（同 sha256 跳过、
 * 不同覆写）、文件名段消毒（怪 msgId → 摘要名）、resolvePeerMessage 查找序
 * （store → held → queue → inbox，P2 元数据完整回传）、坏行/坏文件宽容。
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readStored,
  resolvePeerMessage,
  sha256Of,
  storePeerMessageFull,
} from './msgstore.js';
import { peerHeldDir, peerInboxFile, peerMessagesDir, peerQueueFile } from './peerdir.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-msgstore-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('storePeerMessageFull（接收入队即落，F-3）', () => {
  it('落盘形态：msgId/storedAt/bytes/sha256/text + 溯源元数据', async () => {
    const text = '你好，这是一条带中文与换行的消息\n第二行';
    const out = await storePeerMessageFull(dir, {
      msgId: 'm-1', text,
      from: 'alice', fromSessionId: 'sess-a',
      origin: 'user', originSessionId: 'sess-a', hopChain: ['alice'],
    }, 1234);
    expect(out).toEqual({ stored: true });

    const file = join(peerMessagesDir(dir), 'm-1.json');
    expect(existsSync(file)).toBe(true);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(record['msgId']).toBe('m-1');
    expect(record['storedAt']).toBe(1234);
    expect(record['bytes']).toBe(Buffer.byteLength(text, 'utf8'));
    expect(record['sha256']).toBe(sha256Of(text));
    expect(record['text']).toBe(text);
    expect(record['origin']).toBe('user');
    expect(record['originSessionId']).toBe('sess-a');
    expect(record['hopChain']).toEqual(['alice']);
  });

  it('无元数据时不写空键（缺省形态与 v0.4 兼容）', async () => {
    await storePeerMessageFull(dir, { msgId: 'm-2', text: 'plain' }, 1);
    const record = JSON.parse(readFileSync(join(peerMessagesDir(dir), 'm-2.json'), 'utf8')) as Record<string, unknown>;
    expect('from' in record).toBe(false);
    expect('origin' in record).toBe(false);
    expect('hopChain' in record).toBe(false);
  });

  it('幂等：同 msgId 同 sha256 → stored:false 跳过；不同 text → 覆写', async () => {
    await storePeerMessageFull(dir, { msgId: 'm-3', text: 'v1', from: 'alice' }, 100);
    const again = await storePeerMessageFull(dir, { msgId: 'm-3', text: 'v1', from: 'bob' }, 200);
    expect(again).toEqual({ stored: false });
    // sha256 相同即跳过：元数据不被覆写（入队即落已是完整形态）。
    expect(await readStored(dir, 'm-3')).toMatchObject({ text: 'v1', from: 'alice', storedAt: 100 });

    const rewritten = await storePeerMessageFull(dir, { msgId: 'm-3', text: 'v2-longer-body' }, 300);
    expect(rewritten).toEqual({ stored: true });
    expect(await readStored(dir, 'm-3')).toMatchObject({ text: 'v2-longer-body', storedAt: 300 });
  });

  it('文件名段消毒：路径穿越/超长/怪字符 msgId → 摘要名且不越界（A3f）', async () => {
    for (const bad of ['../evil', 'a/b', '', 'x'.repeat(300), '..']) {
      await storePeerMessageFull(dir, { msgId: bad, text: `body of ${JSON.stringify(bad)}` }, 1);
    }
    const listed = readdirSync(peerMessagesDir(dir));
    expect(listed.length).toBe(5);
    for (const name of listed) {
      expect(name).toMatch(/^[\w.-]+\.json$/);     // 全部是安全段
      expect(name).not.toContain('..');
    }
    // 消毒后仍能按原 msgId 读回（文件名折叠规则与读取侧一致）。
    expect(await readStored(dir, '../evil')).toMatchObject({ msgId: '../evil' });
    expect(await readStored(dir, 'x'.repeat(300))).toMatchObject({ msgId: 'x'.repeat(300) });
  });

  it('readStored：缺文件/坏 JSON/缺 text → undefined', async () => {
    expect(await readStored(dir, 'missing')).toBeUndefined();
    mkdirSync(peerMessagesDir(dir), { recursive: true });
    writeFileSync(join(peerMessagesDir(dir), 'm-bad.json'), 'not json', 'utf8');
    expect(await readStored(dir, 'm-bad')).toBeUndefined();
    writeFileSync(join(peerMessagesDir(dir), 'm-bad2.json'), JSON.stringify({ msgId: 'm-bad2' }), 'utf8');
    expect(await readStored(dir, 'm-bad2')).toBeUndefined();
  });
});

describe('resolvePeerMessage（forwardOf/xc_peer_read 的查找序，R-22）', () => {
  it('主路径：store 命中并回传完整溯源元组（P2 修复断言）', async () => {
    await storePeerMessageFull(dir, {
      msgId: 'm-10', text: 'store 命中正文',
      from: 'alice', fromSessionId: 'sess-a',
      origin: 'user', originSessionId: 'sess-a', hopChain: ['alice'],
    }, 1);
    const resolved = await resolvePeerMessage(dir, 'sess-b', 'm-10');
    expect(resolved).toEqual({
      text: 'store 命中正文',
      from: 'alice', fromSessionId: 'sess-a',
      origin: 'user', originSessionId: 'sess-a', hopChain: ['alice'],
    });
  });

  it('store 缺失 → held 兜底（held 文件的 {item,…} 包裹与裸队列项两形态都认）', async () => {
    const heldDir = peerHeldDir(dir, 'sess-b');
    mkdirSync(heldDir, { recursive: true });
    const item = { msgId: 'm-held', text: 'held 正文', from: 'carol', hopChain: ['carol'] };
    writeFileSync(join(heldDir, 'm-held.json'), JSON.stringify({ item, reason: 'hold' }), 'utf8');
    const wrapped = await resolvePeerMessage(dir, 'sess-b', 'm-held');
    expect(wrapped).toMatchObject({ text: 'held 正文', from: 'carol', hopChain: ['carol'] });

    writeFileSync(join(heldDir, 'm-held2.json'), JSON.stringify({ msgId: 'm-held2', text: '裸形态正文' }), 'utf8');
    const bare = await resolvePeerMessage(dir, 'sess-b', 'm-held2');
    expect(bare).toMatchObject({ text: '裸形态正文' });
  });

  it('store/held 缺失 → queue JSONL 尾部扫描兜底；坏行跳过', async () => {
    const queue = peerQueueFile(dir, 'sess-b');
    mkdirSync(join(dir, 'queue'), { recursive: true });
    const good = { msgId: 'm-q', text: 'queue 正文', from: 'dave', ts: 1, via: 'pipe' };
    writeFileSync(queue, `${JSON.stringify({ msgId: 'other' })}\nnot-a-json-line\n${JSON.stringify(good)}\n`, 'utf8');
    const resolved = await resolvePeerMessage(dir, 'sess-b', 'm-q');
    expect(resolved).toMatchObject({ text: 'queue 正文', from: 'dave' });
  });

  it('store/held/queue 缺失 → inbox JSONL 兜底', async () => {
    const inbox = peerInboxFile(dir, 'sess-b');
    mkdirSync(join(dir, 'inbox'), { recursive: true });
    const item = { msgId: 'm-i', text: 'inbox 正文', from: 'erin' };
    writeFileSync(inbox, `${JSON.stringify(item)}\n`, 'utf8');
    const resolved = await resolvePeerMessage(dir, 'sess-b', 'm-i');
    expect(resolved).toMatchObject({ text: 'inbox 正文', from: 'erin' });
  });

  it('四处皆无 → undefined；text 缺失的 queue/inbox 行不算命中', async () => {
    expect(await resolvePeerMessage(dir, 'sess-b', 'nope')).toBeUndefined();
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(peerQueueFile(dir, 'sess-b'), `${JSON.stringify({ msgId: 'm-notext' })}\n`, 'utf8');
    expect(await resolvePeerMessage(dir, 'sess-b', 'm-notext')).toBeUndefined();
  });

  it('origin 缺省（旧消息）→ 元组无 origin 键（=agent 兼容）', async () => {
    await storePeerMessageFull(dir, { msgId: 'm-old', text: '旧消息', from: 'alice' }, 1);
    const resolved = await resolvePeerMessage(dir, 'sess-b', 'm-old');
    expect(resolved).toMatchObject({ text: '旧消息' });
    expect('origin' in (resolved ?? {})).toBe(false);
  });
});
