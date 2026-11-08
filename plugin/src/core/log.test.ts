import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logEngineEvent } from './log.js';
import { engineLogFile } from './paths.js';
import { readJsonl } from './jsonl.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-log-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('logEngineEvent (logs/engine.jsonl)', () => {
  it('appends {ts, event, ...fields} lines and creates the logs dir', async () => {
    await logEngineEvent(dir, { event: 'dispatch', taskId: 't1', delivered: 'mailbox' });
    await logEngineEvent(dir, { event: 'wake', pid: 4242 });
    const entries = await readJsonl<Record<string, unknown>>(engineLogFile(dir), (v) => typeof v === 'object' && v !== null);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.event).toBe('dispatch');
    expect(entries[0]!.taskId).toBe('t1');
    expect(typeof entries[0]!.ts).toBe('number');
    expect(entries[1]!.event).toBe('wake');
    expect(existsSync(join(dir, 'logs', 'engine.jsonl'))).toBe(true);
  });

  it('never throws when the state root cannot be created (best-effort audit)', async () => {
    // A path where a FILE occupies the directory slot -> mkdir must fail.
    const filePath = join(dir, 'blocking');
    await import('node:fs/promises').then((fs) => fs.writeFile(filePath, 'x', 'utf8'));
    await expect(logEngineEvent(join(filePath, 'impossible'), { event: 'x' })).resolves.toBeUndefined();
    // Nothing was written anywhere:
    expect(readFileSync(filePath, 'utf8')).toBe('x');
  });

  it('records the malformed-line audit shape used by mailbox reads', async () => {
    await logEngineEvent(dir, { event: 'malformed-line', file: 'inbox/b.jsonl', lineNo: 3, error: 'invalid JSON' });
    const entries = await readJsonl<Record<string, unknown>>(engineLogFile(dir), (v) => typeof v === 'object' && v !== null);
    expect(entries[0]!.lineNo).toBe(3);
    expect(entries[0]!.file).toBe('inbox/b.jsonl');
  });
});
