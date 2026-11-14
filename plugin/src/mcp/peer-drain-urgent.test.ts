/**
 * v0.6 C1（M3）单测：面 B（tool-round 间隙）urgent-first 注入排布
 * （DESIGN-V0.6.md §3.1/§4.2-M3——urgent 块置首且优先全文，普通件维持现有形态）。
 *
 * 硬约束延续（peer-drain.test.ts 回归断言不变）：
 * - 无待投递消息 → 返回值逐字节不变；
 * - 有消息 → content[0]/content[1] 不变，信封块追加为末尾 text 块；
 * - 无 urgent 项 → 排布与 v0.5 逐字节一致（两段式退化为单段）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendPeerEnvelopes,
  clearPeerSessionContext,
  setPeerSessionContext,
  type PeerDrainBackend,
} from './peer-drain.js';
import { okResult, type ToolResult } from './protocol.js';
import type { PeerQueueItem } from '../core/peermsg.js';

const deps = { stateRoot: '<stateRoot>', workspace: '<workspace>', env: {} };

beforeEach(() => {
  clearPeerSessionContext();
  setPeerSessionContext({ sessionId: 'sess-a', root: '/peers' });
});

function item(partial: Partial<PeerQueueItem> & { msgId: string; ts: number; text: string }): PeerQueueItem {
  return { from: 'bob', hopChain: ['bob'], via: 'pipe', ...partial };
}

function baseResult(): ToolResult {
  return okResult('操作完成', { ok: true });
}

/** 渲染定长正文的后端（预算控制用）。 */
function sizedBackend(items: unknown[]): PeerDrainBackend {
  return {
    drain: async () => items,
    render: (raw) => {
      const text = (raw as PeerQueueItem).text;
      return `<crosschat-peer-message from="bob">\n${text}\n</crosschat-peer-message>`;
    },
  };
}

describe('面 B urgent-first（两段式排布）', () => {
  it('urgent 块排在普通块之前（输出置首），content[0]/content[1] 不变', async () => {
    const items = [
      item({ msgId: 'n1', ts: 1, text: 'normal-one' }),
      item({ msgId: 'u1', ts: 2, text: 'urgent-one', urgent: true }),
    ];
    const result = await appendPeerEnvelopes(baseResult(), { ...deps, peerDrain: sizedBackend(items) });
    expect(result.content).toHaveLength(3);
    const block = result.content[2]!.text;
    const urgentIdx = block.indexOf('urgent-one');
    const normalIdx = block.indexOf('normal-one');
    expect(urgentIdx).toBeGreaterThanOrEqual(0);
    expect(normalIdx).toBeGreaterThan(urgentIdx);
    // 信封块仍是末尾追加：前两块逐字节不变。
    expect(result.content[0]).toEqual(baseResult().content[0]);
    expect(result.content[1]).toEqual(baseResult().content[1]);
  });

  it('urgent 优先全文：小预算下 urgent 先花 → 较旧普通块降级为省略摘要行', async () => {
    // 预算 env：item=4000、total=6000。urgent 块（ts 最新）item 截断后 ≈4080 先花，
    // 剩余 ≈1900：普通 n1（小、ts 次新）全文在场，n2（大、最旧）降「已省略」摘要行。
    const env = { XC_INJECT_ITEM_CHARS: '4000', XC_INJECT_TOTAL_CHARS: '6000' };
    const items = [
      item({ msgId: 'n2', ts: 1, text: 'Z'.repeat(3000) }),
      item({ msgId: 'n1', ts: 2, text: 'A'.repeat(200) }),
      item({ msgId: 'u-big', ts: 3, text: 'U'.repeat(5500), urgent: true }),
    ];
    const result = await appendPeerEnvelopes(baseResult(), { ...deps, env, peerDrain: sizedBackend(items) });
    const block = result.content[2]!.text;
    // urgent 优先全文（item 截断内尽可能是全文）。
    expect(block).toContain('U'.repeat(3900));
    // 普通件维持现有形态：能装的全文在场；装不下的降省略摘要行（含 msgId）。
    expect(block).toContain('A'.repeat(200));
    expect(block).toContain('已省略');
    expect(block).toContain('n2');
    expect(block).not.toContain('Z'.repeat(3000));
  });

  it('无 urgent 项：与 v0.5 单段排布逐字节一致（到达序输出）', async () => {
    const items = [
      item({ msgId: 'n1', ts: 1, text: 'normal-one' }),
      item({ msgId: 'n2', ts: 2, text: 'normal-two' }),
    ];
    const withUrgentOff = await appendPeerEnvelopes(baseResult(), { ...deps, peerDrain: sizedBackend(items) });
    expect(withUrgentOff.content).toHaveLength(3);
    const block = withUrgentOff.content[2]!.text;
    const oneIdx = block.indexOf('normal-one');
    const twoIdx = block.indexOf('normal-two');
    // 花费新→旧、输出保到达序（R-23 既有口径）。
    expect(oneIdx).toBeGreaterThanOrEqual(0);
    expect(twoIdx).toBeGreaterThan(oneIdx);
  });

  it('无待投递消息：返回值逐字节不变（v0.2 硬约束回归）', async () => {
    const result = await appendPeerEnvelopes(baseResult(), { ...deps, peerDrain: sizedBackend([]) });
    expect(result.content).toHaveLength(2);
    expect(result.content).toEqual(baseResult().content);
  });
});
