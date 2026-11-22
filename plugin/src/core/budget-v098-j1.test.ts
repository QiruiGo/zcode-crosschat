/**
 * v0.9.8（组 M·J1）定向单测：注入排布的 **interrupt/steer 优先级面**。
 *
 * 锚点（方案 §二 J1 验收原文）：
 * - 「10 条普通 + 1 条 steer → steer 全文置顶；普通消息可截断」；
 * - interrupt/steer 块**单独预留预算、置顶、绝不降级成摘要**；
 * - 普通消息可让位（预算被纠错面占走后普通面可整面省略）。
 *
 * 回归锚点（v0.9.7 行为不减）：
 * - 无 priority 块的输入走原算法，输出与 v0.9.7 逐字节一致（budget.test.ts 的
 *   空输入 toEqual 形状、到达序、摘要降级、保底硬切全部不变）。
 */
import { describe, expect, it } from 'vitest';
import { layoutInjectBlocks, type InjectBlock } from './budget.js';

function block(overrides: Partial<InjectBlock> = {}): InjectBlock {
  return {
    msgId: 'm-1',
    from: 'bob',
    ts: 1,
    rendered: 'hello',
    summaryLine: '[已省略 bob 的消息 m-1（超注入预算）]',
    ...overrides,
  };
}

/** 一条「纠偏」块（J1 的 priority:true）。 */
function steer(id: string, ts: number, rendered: string): InjectBlock {
  return block({ msgId: id, from: 'lead', ts, rendered, priority: true, summaryLine: `[已省略 lead 的消息 ${id}]` });
}

const BUDGET = { item: 4000, total: 16000, scale: 1 };

describe('v0.9.8 J1：interrupt/steer 优先级排布', () => {
  it('【方案验收锚点】10 条普通 + 1 条 steer → steer 全文置顶、普通消息让位后可截断', () => {
    const normal = Array.from({ length: 10 }, (_, i) =>
      block({ msgId: `n-${i}`, ts: 100 + i, rendered: `普通消息-${i}-${'x'.repeat(3000)}` }));
    const correction = steer('s-1', 50, `纠偏：别动 site-a 的生产配置${'y'.repeat(2000)}`);
    // 到达序：普通在前、纠偏在后（模拟「先积压、后插队」）
    const result = layoutInjectBlocks([...normal, correction], BUDGET, 'peer');
    expect(result.blocks).toHaveLength(11);
    // ① 置顶：第一块就是纠偏全文（未被截断、未被降级）
    expect(result.blocks[0]).toBe(correction.rendered);
    expect(result.blocks[0]).not.toContain('已省略');
    expect(result.blocks[0]).not.toContain('消息已截断');
    // ② 绝不降级成摘要：纠偏块的 summaryLine 任何形态都不出现
    expect(result.blocks.join('\n')).not.toContain('[已省略 lead 的消息 s-1]');
    // ③ 普通消息可让位：本例总量 10×~3010 + ~2060 ≈ 32160 > 16000 ⇒ 有降级/截断
    expect(result.budgetTruncated).toBe(true);
    // ④ 总预算不被击穿：纠偏面 + 普通面的花费 ≤ budget.total
    expect(result.totalChars).toBeLessThanOrEqual(BUDGET.total);
  });

  it('纠偏块单独预留预算：普通面只用剩余额度（纠偏 2060 → 普通 13940）', () => {
    const correction = steer('s-1', 50, 'y'.repeat(2000));
    const normal = [block({ msgId: 'n-1', ts: 100, rendered: 'n'.repeat(5000) })];
    const result = layoutInjectBlocks([...normal, correction], BUDGET, 'peer');
    expect(result.blocks[0]).toBe(correction.rendered);            // 纠偏全文
    // 普通块被 item 截到 3999 + 尾注（仍进得去，因为纠偏只占了 2000）
    expect(result.blocks[1]).toContain('消息已截断');
    expect(result.blocks[1]).toContain('显示 3999/5000');
    expect(result.totalChars).toBe(2000 + result.blocks[1]!.length);
  });

  it('纠偏块绝不降级成摘要：预留不足时硬切到剩余预算 + 指针（不是 summaryLine）', () => {
    const budget = { item: 4000, total: 300, scale: 1 };
    const correction = steer('s-1', 50, 'z'.repeat(5000));
    const normal = block({ msgId: 'n-1', ts: 100, rendered: 'n'.repeat(4000) });
    const result = layoutInjectBlocks([normal, correction], budget, 'peer');
    // 纠偏：硬切到 300 字符 + 尾注（有可读开头 + 取全文指针）
    expect(result.blocks[0]!.startsWith('z'.repeat(300) + '\n')).toBe(true);
    expect(result.blocks[0]).toContain('xc_read({scope:"peer-msg", id:"s-1"})');
    expect(result.blocks[0]).toContain('显示 300/5000');
    // 普通面预算 0 → 整面让位（一条都不放），且不产出「已省略」占位
    expect(result.blocks).toHaveLength(1);
    expect(result.budgetTruncated).toBe(true);
  });

  it('多条纠偏：按到达序置顶、类内共享预留；预留用尽后续纠偏整条省略并如实计数', () => {
    const budget = { item: 4000, total: 1000, scale: 1 };
    const corrections = [
      steer('s-1', 10, 'a'.repeat(600)),
      steer('s-2', 20, 'b'.repeat(600)),
      steer('s-3', 30, 'c'.repeat(600)),
    ];
    const normal = block({ msgId: 'n-1', ts: 99, rendered: 'n'.repeat(600) });
    const result = layoutInjectBlocks([normal, ...corrections], budget, 'peer');
    // 预留 1000：s-1（600）进，s-2（600）装不下 → 硬切到 400 + 指针，s-3 整条省略
    expect(result.blocks[0]).toBe('a'.repeat(600));
    expect(result.blocks[1]!.startsWith('b'.repeat(400) + '\n')).toBe(true);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.join('\n')).not.toContain('已省略');       // 没有任何摘要降级
    expect(result.budgetTruncated).toBe(true);
  });

  it('纠偏块的 item 截断仍算截断（truncatedCount 如实上报）', () => {
    const budget = { item: 4000, total: 16000, scale: 1 };
    const correction = steer('s-1', 10, 'q'.repeat(9000));
    const result = layoutInjectBlocks([correction], budget, 'peer');
    expect(result.truncatedCount).toBe(1);
    expect(result.budgetTruncated).toBe(true);
    expect(result.blocks[0]).toContain('显示 3999/9000');
    expect(result.blocks[0]).not.toContain('已省略');
  });

  it('无纠偏消息时与 v0.9.7 逐字节同路（ urgentFirst 无关、形状不变）', () => {
    const blocks = [
      block({ msgId: 'm-old', ts: 1, rendered: 'old-text' }),
      block({ msgId: 'm-new', ts: 2, rendered: 'new-text' }),
    ];
    expect(layoutInjectBlocks(blocks, BUDGET, 'peer')).toEqual({
      blocks: ['old-text', 'new-text'],
      truncatedCount: 0,
      budgetTruncated: false,
      totalChars: 16,
    });
    expect(layoutInjectBlocks([], BUDGET, 'peer')).toEqual({
      blocks: [], truncatedCount: 0, budgetTruncated: false, totalChars: 0,
    });
  });

  it('priority=false/undefined 都算普通消息（不触发优先级面）', () => {
    const plain = block({ msgId: 'n-1', ts: 1, rendered: 'a'.repeat(100), priority: false });
    const result = layoutInjectBlocks([plain], { item: 4000, total: 40, scale: 1 }, 'peer');
    // 走原算法：超 total 且无别的块 ⇒ 保底一条硬切到 40 + 尾注
    expect(result.blocks[0]!.startsWith('a'.repeat(40) + '\n')).toBe(true);
  });
});
