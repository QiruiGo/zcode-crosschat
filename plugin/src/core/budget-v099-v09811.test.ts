/**
 * v0.9.9（V098-11，P3）定向单测：core/budget.ts 的**优先级面已删**（死代码清理）。
 *
 * 背景（v0.9.8 adv-2 F2）：v0.9.8 在 layoutInjectBlocks 里加了 `priority:true`
 * （interrupt/steer）优先级面（单独预留预算、置顶、绝不降级成摘要），但出厂包内
 * **没有任何生产路径构造优先级块**——本函数的三个生产调用面全是 peer 域（hooks
 * 面 A / mcp/peer-drain.ts 面 B / xc_read 的 peer scope 面 C），而 peer 轴不携带
 * interrupt/steer 元数据（PeerQueueItem 只有 urgent/refs）；队内域的纠错置顶在
 * **消费窗口**实现（mcp/tools-read.ts 的 xc_check_inbox：interruptFirst + 批次
 * 窗口先给纠错面开窗）——消费面「先消费后渲染」，若把已消费块交给本函数的摘要
 * 降级就是「已消费却没进上下文」（v0.5.2 SCALE-3 根因形态）。
 *
 * 方案 §二 组 M·V098-11 给的两条修法（「接入 priority:true 的 layout 路径」或
 * 「删除文案承诺」）里选后者，理由即上方架构边界；行为级验收（积压场景下纠错全文
 * 置顶、普通消息让位）在 mcp/tools-read-v099-v09811.test.ts 驱动生产路径。
 *
 * 本文件守住的回归面：
 * 1. 优先级面确实不存在：带 `priority` 键的块（旧调用方的残留形状）按**普通消息**
 *    处理——不预留预算、不置顶、可降级成摘要；
 * 2. 删除前后对**无优先级块**的输入逐字节同行为（v0.9.7 算法原样）。
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

const BUDGET = { item: 4000, total: 16000, scale: 1 };

describe('v0.9.9 V098-11：layoutInjectBlocks 无优先级面（死代码已删）', () => {
  it('带 priority 键的块按普通消息处理：不预留预算、不置顶、可降级成摘要', () => {
    // 旧调用方残留形状（InjectBlock 已无 priority 字段——经转型传入模拟「死代码复辟」）。
    const stale = { ...block({ msgId: 's-1', ts: 2, rendered: 'b'.repeat(100) }), priority: true } as unknown as InjectBlock;
    const normal = block({ msgId: 'n-1', ts: 1, rendered: 'a'.repeat(100) });
    // 总预算 150：新→旧花费（stale 100 先花，剩 50）⇒ 普通块降一行摘要（**不**为它硬切预留）。
    const result = layoutInjectBlocks([normal, stale], { item: 4000, total: 150, scale: 1 }, 'peer');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toBe(normal.summaryLine);   // 旧块降级成摘要（无优先级面时的既有语义）
    expect(result.blocks[1]).toBe(stale.rendered);       // 新块全文
    expect(result.budgetTruncated).toBe(true);
    expect(result.totalChars).toBeLessThanOrEqual(150);  // 总预算不被击穿
  });

  it('空输入与单块保底的形状不变（v0.9.7 等价）', () => {
    expect(layoutInjectBlocks([], BUDGET, 'peer')).toEqual({
      blocks: [], truncatedCount: 0, budgetTruncated: false, totalChars: 0,
    });
    const one = block({ msgId: 'm-1', ts: 1, rendered: 'x'.repeat(100) });
    expect(layoutInjectBlocks([one], { item: 4000, total: 40, scale: 1 }, 'peer')).toEqual({
      blocks: [`${'x'.repeat(40)}\n[消息已截断：显示 40/100 字符 —— 用 xc_read({scope:"peer-msg", id:"m-1"}) 取全文/分页]`],
      truncatedCount: 1,
      budgetTruncated: true,
      totalChars: expect.any(Number),
    });
  });

  it('输出保到达序、花费按 ts 新→旧（删除优先级面不改原算法）', () => {
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
  });
});
