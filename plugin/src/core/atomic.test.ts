import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic, writeFileExclusive } from './atomic.js';

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

// v0.8.1（29 红队 C1-B01 修复）：排他创建原语——checkpoint 同毫秒并发不再静默覆写。
describe('writeFileExclusive', () => {
  it('目标不存在 → 创建成功（返回 true，内容逐字节落地）', async () => {
    const file = join(dir, 'ck.md');
    expect(await writeFileExclusive(file, 'snapshot-a')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('snapshot-a');
  });

  it('目标已存在 → 返回 false 且**不改写**既有内容（竞态输家让位，不覆写）', async () => {
    const file = join(dir, 'ck.md');
    writeFileSync(file, 'first-writer', 'utf8');
    expect(await writeFileExclusive(file, 'second-writer')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('first-writer');
  });

  it('成功/失败两条路径都不留 .tmp 残留', async () => {
    const file = join(dir, 'ck.md');
    await writeFileExclusive(file, 'a');
    await writeFileExclusive(file, 'b'); // 输家路径
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dir)).toEqual(['ck.md']);
  });

  it('并发同目标：恰一个 true、其余全 false，内容不串（原子占位的竞态防线）', async () => {
    const file = join(dir, 'race.md');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => writeFileExclusive(file, `writer-${i}`)),
    );
    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(7);
    expect(readFileSync(file, 'utf8')).toMatch(/^writer-\d$/);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
