import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-atomic-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates a new file with exact content', async () => {
    const file = join(dir, 'x.json');
    await writeFileAtomic(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
  });

  it('replaces an existing file completely (no residue of the old content)', async () => {
    const file = join(dir, 'x.json');
    writeFileSync(file, 'x'.repeat(5000), 'utf8');
    await writeFileAtomic(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
  });

  it('leaves no .tmp files behind after success', async () => {
    const file = join(dir, 'x.json');
    for (let i = 0; i < 3; i++) await writeFileAtomic(file, `{"i":${i}}`);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('{"i":2}');
  });

  it('is usable as the whole-file writer for registry/team files (roundtrip)', async () => {
    const file = join(dir, 'names.json');
    for (const round of [1, 2, 3]) {
      await writeFileAtomic(file, JSON.stringify({ round, map: { a: 'sess_a' } }, null, 2));
      expect(JSON.parse(readFileSync(file, 'utf8'))['round']).toBe(round);
    }
    expect(existsSync(file)).toBe(true);
  });
});
