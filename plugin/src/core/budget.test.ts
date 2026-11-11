/**
 * v0.5 M1 单测：接收方注入预算与分页原语（DESIGN-V0.5.md §5.1/§6.3-1）。
 *
 * 覆盖（验收 A3f 预算面）：
 * - receiverInjectBudget 表驱动：scale/item/total 的 clamp 边界、env 覆盖、非法 env；
 * - layoutInjectBlocks：新→旧花费、最旧降一行摘要、保底一条硬切、空输入、budgetTruncated；
 * - paginateText：offset 0/中/越界、limit 缺省/上限 64000；
 * - truncateField / truncateNote / contextCharsFromEnv。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INJECT_DEFAULT_CONTEXT_CHARS,
  READ_PAGE_MAX_CHARS,
  contextCharsFromEnv,
  layoutInjectBlocks,
  paginateText,
  receiverInjectBudget,
  truncateField,
  truncateNote,
  type InjectBlock,
} from './budget.js';

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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

describe('receiverInjectBudget（R-17 预算函数）', () => {
  it('缺省 200k → scale=1 / item=4000 / total=16000（CC G9/LLi 基准）', () => {
    expect(receiverInjectBudget(INJECT_DEFAULT_CONTEXT_CHARS)).toEqual({ item: 4000, total: 16000, scale: 1 });
  });

  it('表驱动：clamp 边界（0.25× 与 4×）', () => {
    // 50k → scale 0.25 → item 1000 / total 4000（下限）
    expect(receiverInjectBudget(50_000)).toEqual({ item: 1000, total: 4000, scale: 0.25 });
    // 1M → scale 4 → item 16000 / total 64000（上限）
    expect(receiverInjectBudget(1_000_000)).toEqual({ item: 16000, total: 64000, scale: 4 });
    // 2M → scale 仍钳在 4
    expect(receiverInjectBudget(2_000_000).scale).toBe(4);
    // 100k → scale 0.5 → item 2000 / total 8000
    expect(receiverInjectBudget(100_000)).toEqual({ item: 2000, total: 8000, scale: 0.5 });
    // 400k → scale 2 → item 8000 / total 32000
    expect(receiverInjectBudget(400_000)).toEqual({ item: 8000, total: 32000, scale: 2 });
  });

  it('非法 contextChars（0/负数/NaN/Infinity）按缺省 200k 处理', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(receiverInjectBudget(bad)).toEqual({ item: 4000, total: 16000, scale: 1 });
    }
  });

  it('XC_INJECT_ITEM_CHARS / XC_INJECT_TOTAL_CHARS 覆盖生效（R-25）', () => {
    const budget = receiverInjectBudget(200_000, {
      XC_INJECT_ITEM_CHARS: '2000',
      XC_INJECT_TOTAL_CHARS: '8000',
    });
    expect(budget.item).toBe(2000);
    expect(budget.total).toBe(8000);
  });

  it('env 极大值 = v0.4 回退通道（不 clamp env 覆盖）', () => {
    const budget = receiverInjectBudget(200_000, {
      XC_INJECT_ITEM_CHARS: '99999999',
      XC_INJECT_TOTAL_CHARS: '99999999',
    });
    expect(budget.item).toBe(99_999_999);
    expect(budget.total).toBe(99_999_999);
  });

  it('构造保证 total ≥ item（env 各自覆盖时也强保）', () => {
    const budget = receiverInjectBudget(200_000, { XC_INJECT_ITEM_CHARS: '32000' });
    expect(budget.item).toBe(32000);
    expect(budget.total).toBe(32000);
  });

  it('非法 env 值（0/负数/非数字/空白）= 未设', () => {
    for (const bad of ['0', '-1', 'abc', '  ', '1e999']) {
      expect(receiverInjectBudget(200_000, { XC_INJECT_ITEM_CHARS: bad })).toEqual({ item: 4000, total: 16000, scale: 1 });
      expect(receiverInjectBudget(200_000, { XC_INJECT_TOTAL_CHARS: bad })).toEqual({ item: 4000, total: 16000, scale: 1 });
    }
  });
});

describe('contextCharsFromEnv（R-18 声明值）', () => {
  it('未设 → 200000', () => {
    expect(contextCharsFromEnv({})).toBe(INJECT_DEFAULT_CONTEXT_CHARS);
  });

  it('合法值原样返回', () => {
    expect(contextCharsFromEnv({ XC_CONTEXT_CHARS: '50000' })).toBe(50000);
  });

  it('非法值（0/负数/非数字/空白）→ 200000', () => {
    for (const bad of ['0', '-1', 'abc', '  ']) {
      expect(contextCharsFromEnv({ XC_CONTEXT_CHARS: bad })).toBe(INJECT_DEFAULT_CONTEXT_CHARS);
    }
  });
});

describe('layoutInjectBlocks（R-17 排布，对齐 CC gca）', () => {
  it('空输入 → 空输出、无截断', () => {
    const result = layoutInjectBlocks([], { item: 4000, total: 16000, scale: 1 }, 'peer');
    expect(result).toEqual({ blocks: [], truncatedCount: 0, budgetTruncated: false, totalChars: 0 });
  });

  it('预算充足 → 全部保留且输出保持到达序（花费序是新→旧）', () => {
    const blocks = [
      block({ msgId: 'm-old', ts: 1, rendered: 'old-text' }),
      block({ msgId: 'm-new', ts: 2, rendered: 'new-text' }),
    ];
    const result = layoutInjectBlocks(blocks, { item: 4000, total: 16000, scale: 1 }, 'peer');
    expect(result.blocks).toEqual(['old-text', 'new-text']);
    expect(result.truncatedCount).toBe(0);
    expect(result.budgetTruncated).toBe(false);
    expect(result.totalChars).toBe('old-text'.length + 'new-text'.length);
  });

  it('超 item 的条目截断 + 指针尾注（peer 指针）', () => {
    const rendered = 'x'.repeat(5000);
    const result = layoutInjectBlocks(
      [block({ rendered })],
      { item: 4000, total: 16000, scale: 1 },
      'peer',
    );
    expect(result.truncatedCount).toBe(1);
    expect(result.budgetTruncated).toBe(true);
    expect(result.blocks).toHaveLength(1);
    const text = result.blocks[0]!;
    expect(text.startsWith('x'.repeat(3999) + '\n')).toBe(true);
    expect(text).toContain('xc_peer_read({msgId:"m-1"})');
    expect(text).toContain('显示 3999/5000');
  });

  it('超支的最旧条目降一行摘要（保留 msgId/from；新条完整）', () => {
    const budget = { item: 4000, total: 40, scale: 1 };
    const blocks = [
      block({ msgId: 'm-new', ts: 2, rendered: 'new-text' }),           // 8 chars
      block({ msgId: 'm-old', ts: 1, rendered: 'o'.repeat(100), summaryLine: '[已省略 bob 的消息 m-old（超注入预算）]' }),      // 花不完 → 摘要
    ];
    const result = layoutInjectBlocks(blocks, budget, 'peer');
    expect(result.blocks).toEqual(['new-text', '[已省略 bob 的消息 m-old（超注入预算）]']);
    expect(result.budgetTruncated).toBe(true);
    expect(result.truncatedCount).toBe(0);   // 无条目超 item；降级发生在 total 层
  });

  it('一行摘要也装不下 → 整条省略（blocks.length < 输入数，budgetTruncated 仍真）', () => {
    const budget = { item: 4000, total: 5, scale: 1 };
    const result = layoutInjectBlocks(
      [block({ msgId: 'm-a', ts: 1, rendered: 'aaaaaaaaaaaaaaaa' })],
      budget,
      'peer',
    );
    // 保底一条：硬切到 total
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.length).toBe(5 + '\n'.length + truncateNote('peer', 'm-a', 5, 16).length);
    expect(result.budgetTruncated).toBe(true);
  });

  it('保底一条：total 装不下新块的 item 截断 → 硬切到 total + 尾注', () => {
    const budget = { item: 4000, total: 20, scale: 1 };
    const rendered = 'y'.repeat(1000);
    const result = layoutInjectBlocks([block({ rendered })], budget, 'peer');
    expect(result.blocks).toHaveLength(1);
    const text = result.blocks[0]!;
    expect(text.startsWith('y'.repeat(20) + '\n')).toBe(true);
    expect(text).toContain('显示 20/1000');
  });

  it('mail 指针分叉：xc_mail_read 尾注', () => {
    const rendered = 'z'.repeat(5000);
    const result = layoutInjectBlocks([block({ rendered })], { item: 4000, total: 16000, scale: 1 }, 'mail');
    expect(result.blocks[0]).toContain('xc_mail_read({messageId:"m-1"})');
  });

  it('user origin 的摘要行（调用方装配的 summaryLine 原样使用）', () => {
    const budget = { item: 4000, total: 50, scale: 1 };
    const blocks = [
      block({ msgId: 'm-new', ts: 2, rendered: 'new-text' }),
      block({ msgId: 'm-voice', ts: 1, rendered: 'v'.repeat(100), summaryLine: '[已省略 bob 的消息 m-voice（用户亲述）（超注入预算）]' }),
    ];
    const result = layoutInjectBlocks(blocks, budget, 'peer');
    expect(result.blocks).toEqual(['new-text', '[已省略 bob 的消息 m-voice（用户亲述）（超注入预算）]']);
    expect(result.budgetTruncated).toBe(true);
  });
});

describe('truncateField（R-23）', () => {
  it('预算内原样返回、无 truncated', () => {
    expect(truncateField('hello', 10, digest)).toEqual({ text: 'hello' });
  });

  it('超预算截断并附 sha256', () => {
    const text = 'a'.repeat(500);
    const result = truncateField(text, 100, digest);
    expect(result.text).toBe('a'.repeat(99));
    expect(result.truncated).toEqual({ shown: 99, total: 500, sha256: digest(text) });
  });
});

describe('paginateText（R-22 分页原语）', () => {
  const text = '0123456789'.repeat(10); // 100 chars

  it('offset 0 + 缺省 limit', () => {
    const page = paginateText(text, undefined, undefined, 30);
    expect(page).toEqual({ total: 100, offset: 0, text: text.slice(0, 30), hasMore: true });
  });

  it('中部 offset 翻页', () => {
    const page = paginateText(text, 60, 30, 30);
    expect(page.offset).toBe(60);
    expect(page.text).toBe(text.slice(60, 90));
    expect(page.hasMore).toBe(true);
  });

  it('最后一页 hasMore=false', () => {
    const page = paginateText(text, 90, 30, 30);
    expect(page.text).toBe(text.slice(90));
    expect(page.hasMore).toBe(false);
  });

  it('越界 offset → 空文本 + hasMore:false（幂等安全）', () => {
    expect(paginateText(text, 100, 30, 30)).toEqual({ total: 100, offset: 100, text: '', hasMore: false });
    expect(paginateText(text, 500, 30, 30)).toEqual({ total: 100, offset: 500, text: '', hasMore: false });
  });

  it('limit 上限 64000；非法 limit（0/负）→ 1', () => {
    const big = 'a'.repeat(70_000);
    expect(paginateText(big, 0, 999_999, 4000).text).toHaveLength(READ_PAGE_MAX_CHARS);
    expect(paginateText(text, 0, 0, 30).text).toHaveLength(1);
    expect(paginateText(text, 0, -5, 30).text).toHaveLength(1);
  });
});

describe('truncateNote（R-20 指针格式）', () => {
  it('peer 指针', () => {
    expect(truncateNote('peer', 'm-1', 100, 9000))
      .toBe('[消息已截断：显示 100/9000 字符 —— 用 xc_peer_read({msgId:"m-1"}) 取全文/分页]');
  });

  it('mail 指针', () => {
    expect(truncateNote('mail', 'm-2', 7, 12))
      .toBe('[消息已截断：显示 7/12 字符 —— 用 xc_mail_read({messageId:"m-2"}) 取全文/分页]');
  });
});
