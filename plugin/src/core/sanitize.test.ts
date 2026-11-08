import { describe, expect, it } from 'vitest';
import { sanitizeKey } from './sanitize.js';

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
