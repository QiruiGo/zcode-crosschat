import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendJsonl, parseJsonl, readJsonl, rewriteJsonl } from './jsonl.js';
import { isTeamMessage, type TeamMessage } from './types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-jsonl-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function msg(id: string): TeamMessage {
  return { id, from: 'a', to: 'b', content: `c-${id}`, ts: 1 };
}

describe('parseJsonl', () => {
  it('parses lines and skips blanks', () => {
    const parsed = parseJsonl('{"a":1}\n\n{"b":2}\n');
    expect(parsed.values).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parsed.malformed).toEqual([]);
  });

  it('collects malformed lines with 1-based line numbers', () => {
    const parsed = parseJsonl('{"ok":1}\n{broken\n{"ok":2}');
    expect(parsed.values).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(parsed.malformed).toEqual([{ lineNo: 2, error: 'invalid JSON' }]);
  });
});

describe('readJsonl (半行 JSONL 跳过 + onMalformed)', () => {
  it('reads valid records and skips a half-written tail line', async () => {
    const file = join(dir, 'box.jsonl');
    // Simulate a crash mid-append: complete line + newline + incomplete fragment.
    writeFileSync(file, `${JSON.stringify(msg('1'))}\n{"id":"2","from":"a","to":"b","cont`, 'utf8');
    const malformed: string[] = [];
    const items = await readJsonl<TeamMessage>(file, isTeamMessage, (m) => malformed.push(`${m.lineNo}:${m.error}`));
    expect(items.map((m) => m.id)).toEqual(['1']);
    expect(malformed.length).toBeGreaterThanOrEqual(1);
  });

  it('reads as empty when the file does not exist', async () => {
    expect(await readJsonl(join(dir, 'nope.jsonl'), isTeamMessage)).toEqual([]);
  });

  it('reports wrong-shape values as malformed, without throwing', async () => {
    const file = join(dir, 'box.jsonl');
    writeFileSync(file, `${JSON.stringify({ unrelated: true })}\n${JSON.stringify(msg('1'))}\n`, 'utf8');
    const malformed: number[] = [];
    const items = await readJsonl<TeamMessage>(file, isTeamMessage, (m) => malformed.push(m.lineNo));
    expect(items.map((m) => m.id)).toEqual(['1']);
    expect(malformed).toEqual([1]);
  });
});

describe('appendJsonl (追加前尾行截断)', () => {
  it('creates the file and appends lines', async () => {
    const file = join(dir, 'box.jsonl');
    await appendJsonl(file, [JSON.stringify(msg('1')), JSON.stringify(msg('2'))]);
    const raw = readFileSync(file, 'utf8');
    expect(raw).toBe(`${JSON.stringify(msg('1'))}\n${JSON.stringify(msg('2'))}\n`);
  });

  it('appends after a complete line that lacks the trailing newline (separator rule)', async () => {
    const file = join(dir, 'box.jsonl');
    writeFileSync(file, JSON.stringify(msg('1')), 'utf8'); // no trailing \n
    await appendJsonl(file, [JSON.stringify(msg('2'))]);
    const raw = readFileSync(file, 'utf8');
    expect(raw).toBe(`${JSON.stringify(msg('1'))}\n${JSON.stringify(msg('2'))}\n`);
  });

  it('truncates an incomplete tail fragment before appending (DESIGN §2.7-5)', async () => {
    const file = join(dir, 'box.jsonl');
    const good = JSON.stringify(msg('1'));
    writeFileSync(file, `${good}\n{"id":"2","from":"a","to":"b","cont`, 'utf8');
    await appendJsonl(file, [JSON.stringify(msg('3'))]);
    const items = await readJsonl<TeamMessage>(file, isTeamMessage);
    // The unreadable fragment is gone; the good line and the new line remain.
    expect(items.map((m) => m.id)).toEqual(['1', '3']);
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  it('leaves nothing behind when appending to a missing nested directory', async () => {
    const file = join(dir, 'nested', 'deeper', 'box.jsonl');
    await appendJsonl(file, [JSON.stringify(msg('1'))]);
    expect(existsSync(file)).toBe(true);
  });
});

describe('rewriteJsonl', () => {
  it('rewrites selected lines and preserves malformed lines verbatim', async () => {
    const file = join(dir, 'box.jsonl');
    const broken = '{"id":"x" broken';
    writeFileSync(file, `${JSON.stringify(msg('1'))}\n${broken}\n${JSON.stringify(msg('2'))}\n`, 'utf8');
    await rewriteJsonl(file, (value) => {
      const record = value as Record<string, unknown>;
      return record['id'] === '1' ? JSON.stringify({ ...record, readAt: 42 }) : undefined;
    });
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('"readAt":42');
    expect(raw).toContain(broken); // kept for diagnostics
  });

  it('reports a missing file as unchanged (false)', async () => {
    expect(await rewriteJsonl(join(dir, 'nope.jsonl'), () => undefined)).toBe(false);
  });
});
