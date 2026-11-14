import { describe, expect, it } from 'vitest';
import { foldHomoglyphs, sanitizeKey } from './sanitize.js';

describe('sanitizeKey (port of dsh state.js:88-99)', () => {
  it('keeps plain ascii names', () => {
    expect(sanitizeKey('alice')).toBe('alice');
    expect(sanitizeKey('  Bob_01 ')).toBe('bob-01');
  });

  it('keeps CJK letters distinct and readable (中文花名)', () => {
    expect(sanitizeKey('小明')).toBe('小明');
    expect(sanitizeKey('小明')).not.toBe(sanitizeKey('小红'));
  });

  it('folds spaces/punctuation/path separators to single dashes', () => {
    expect(sanitizeKey('a b')).toBe('a-b');
    expect(sanitizeKey('a/b\\c')).toBe('a-b-c');
    expect(sanitizeKey('a!!b??c')).toBe('a-b-c');
    expect(sanitizeKey('--a--b--')).toBe('a-b');
  });

  it('lowercases', () => {
    expect(sanitizeKey('Alice')).toBe('alice');
  });

  it('normalizes NFC', () => {
    const nfd = 'e\u0301'; // e + combining acute
    expect(sanitizeKey(nfd)).toBe(sanitizeKey('é'));
  });

  it('maps a no-letter-no-digit name to a digest key, not a shared constant', () => {
    const a = sanitizeKey('🚀');
    const b = sanitizeKey('🎉');
    expect(a).toMatch(/^k-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it('truncates over-long names and appends a digest to stay distinct', () => {
    const longA = `${'a'.repeat(60)}-suffix-a`;
    const longB = `${'a'.repeat(60)}-suffix-b`;
    const keyA = sanitizeKey(longA);
    const keyB = sanitizeKey(longB);
    expect([...keyA].length).toBeLessThanOrEqual(48 + 1 + 8);
    expect(keyA.startsWith('a'.repeat(48))).toBe(true);
    expect(keyA).not.toBe(keyB);
  });
});

// ─────────────────────────── v0.5.3（A11 修复）：同形字归一 ───────────────────────────

describe('sanitizeKey 同形字归一（v0.5.3 A11：西里尔/希腊混淆字母 + 全角拉丁）', () => {
  it('adj052 A11 攻击重放：西里尔 с 混入 victim 归一到同一 key（注册面因此 name_taken）', () => {
    const victim = 'victim';
    const homoglyph = `vi${String.fromCodePoint(0x0441)}tim`; // viсtim（с = U+0441）
    expect(sanitizeKey(homoglyph)).toBe(sanitizeKey(victim));
    expect(sanitizeKey(homoglyph)).toBe('victim');
    // 大写西里尔（С U+0421）经 lowercase 后同样归一。
    expect(sanitizeKey(`vi${String.fromCodePoint(0x0421)}TIM`)).toBe('victim');
  });

  it('西里尔形近子集全表归一（а в е з ѕ і ј к м н о р т у х һ ԁ）', () => {
    expect(sanitizeKey('\u0430\u0432\u0435')).toBe('abe');
    expect(sanitizeKey('\u0437')).toBe('3'); // з → 数字 3
    expect(sanitizeKey('\u0455\u0456\u0458')).toBe('sij');
    expect(sanitizeKey('\u043a\u043c\u043d')).toBe('kmh');
    expect(sanitizeKey('\u043e\u0440\u0441\u0442')).toBe('opct');
    expect(sanitizeKey('\u0443\u0445')).toBe('yx');
    expect(sanitizeKey('\u04bb\u0501')).toBe('hd');
  });

  it('希腊形近子集归一（α ε η ι κ μ ν ο ρ ς σ τ υ χ）', () => {
    expect(sanitizeKey('\u03b1\u03b5\u03b9')).toBe('aei');
    expect(sanitizeKey('\u03ba\u03bc\u03bd')).toBe('kmv');
    expect(sanitizeKey('\u03bf\u03c1')).toBe('op');
    expect(sanitizeKey('\u03c2\u03c3')).toBe('ss');
    expect(sanitizeKey('\u03c4\u03c5\u03c7')).toBe('tux');
    expect(sanitizeKey('\u03b7')).toBe('h');
  });

  it('全角拉丁（U+FF01–U+FF5E）折回 ASCII：ｖｉｃｔｉｍ ≡ victim', () => {
    const fullwidth = String.fromCodePoint(0xff56, 0xff49, 0xff43, 0xff54, 0xff49, 0xff4d); // ｖｉｃｔｉｍ
    expect(sanitizeKey(fullwidth)).toBe('victim');
    expect(sanitizeKey('Ｂｏｂ－０１')).toBe('bob-01');
  });

  it('非形近字母原样保留（映射逐字符生效：б г д ж 等不在混淆子集）', () => {
    // борис：б и 保持西里尔，о р с 是形近字母被折成拉丁（文档声明的行为）。
    expect(sanitizeKey('борис')).toBe('бopиc');
    expect(sanitizeKey('γδ')).toBe('γδ'); // γ δ 非形近，原样保留
    // 折叠后的西里尔混排键与纯拉丁名不撞键（б и 仍在）。
    expect(sanitizeKey('борис')).not.toBe(sanitizeKey('boris'));
  });

  it('归一幂等：已是 key 的字符串再清洗一次结果不变（mailbox 二次清洗安全）', () => {
    const key = sanitizeKey('viсtim');
    expect(sanitizeKey(key)).toBe(key);
    expect(foldHomoglyphs(foldHomoglyphs('viсtim'))).toBe(foldHomoglyphs('viсtim'));
  });

  it('CJK 名不受影响（中文花名仍可读且互异）', () => {
    expect(sanitizeKey('小明')).toBe('小明');
    expect(sanitizeKey('小明')).not.toBe(sanitizeKey('小红'));
  });
});

// ─────────────────── v0.6.1（红队四番战 安全对-2 修复）：花名严格校验闸 ───────────────────
//
// sanitizeKey 的折叠本身保留（mailbox 路径等既有调用不变）；新增的
// validateMemberName 是**注册/改名入口闸**：凡会被 sanitizeKey 静默归一到
// 碰撞键的写法一律拒（全角/同形字/路径符/控制符/空白/下划线/连字符变形/超长），
// 与 peer 轴严格文法同一口径；CJK 等规范键形不受影响。
import { MEMBER_NAME_MAX_LENGTH, validateMemberName } from './sanitize.js';

describe('validateMemberName（v0.6.1 安全对-2：注册/改名/member-add 同一道闸）', () => {
  it('规范键形放行；返回值即 sanitizeKey 结果（幂等）', () => {
    for (const name of ['alice', 'alice-2', '1bot', '小明', 'café', 'a', 'x'.repeat(MEMBER_NAME_MAX_LENGTH)]) {
      const checked = validateMemberName(name);
      expect(checked.ok, name).toBe(true);
      if (checked.ok) {
        expect(checked.key).toBe(sanitizeKey(name));
        expect(sanitizeKey(checked.key)).toBe(checked.key);
      }
    }
    // 大小写折叠是既有文档化行为（队内键大小写不敏感）——放行但键为小写。
    const upper = validateMemberName('Alice');
    expect(upper.ok && upper.key).toBe('alice');
  });

  it('碰撞归一写法一律 invalid_name（全角/同形字/路径符/控制符/空白/下划线/连字符变形）', () => {
    const cases: Array<[string, string]> = [
      ['fullwidth', String.fromCodePoint(0xff41, 0xff4c, 0xff49, 0xff43, 0xff45)], // ＡＬＩＣＥ
      ['cyrillic-homoglyph', `vi${String.fromCodePoint(0x0441)}tim`], // viсtim
      ['slash', 'a/b'],
      ['backslash', 'a\b'],
      ['dotdot', '..'],
      ['dot', 'a.b'],
      ['space', 'a b'],
      ['nul', 'a\u0000b'],
      ['tab', 'a\tb'],
      ['underscore', 'a_b'],
      ['double-dash', 'a--b'],
      ['edge-dash', '-a'],
      ['trailing-dash', 'a-'],
      ['punctuation-only', '!!!'],
      ['empty-after-trim', '   '],
    ];
    for (const [label, name] of cases) {
      const checked = validateMemberName(name);
      expect(checked.ok, `${label} must be refused`).toBe(false);
      if (!checked.ok) expect(checked.error).toBe('invalid_name');
    }
  });

  it('超长 → name_too_long（键长上限，不再静默截断+摘要）', () => {
    const checked = validateMemberName('x'.repeat(MEMBER_NAME_MAX_LENGTH + 1));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toBe('name_too_long');
  });

  it('保留名（两轴并集）→ name_reserved', () => {
    for (const name of ['lead', 'default', 'main', 'team-lead', 'user', 'system']) {
      const checked = validateMemberName(name);
      expect(checked.ok, name).toBe(false);
      if (!checked.ok) expect(checked.error).toBe('name_reserved');
    }
    // 大小写/空白变体归一到同一把保留键后同样拒。
    expect(validateMemberName('LEAD').ok).toBe(false);
    expect(validateMemberName(' team-lead ').ok).toBe(false);
  });

  it('拒绝信息可操作（指出会被归一成哪把键）', () => {
    const checked = validateMemberName('Ａｌｉｃｅ');
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.message).toContain('alice');
      expect(checked.message).toContain('normalized');
    }
  });
});
