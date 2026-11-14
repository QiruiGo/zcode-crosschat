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
