/**
 * M1 core-store: fault-tolerant JSONL primitives.
 *
 * JSONL files (inbox/*.jsonl, logs/engine.jsonl) are cross-process APPEND
 * writes (O_APPEND, never rename) and therefore read-tolerant by contract
 * (DESIGN.md §2.7-5): a crash can leave a half-written tail line; parse
 * failures are skipped and reported through an onMalformed callback, and an
 * incomplete tail is truncated before the next append. This is the dsh
 * original behavior (readMailbox's onMalformed callback, mailbox.js:29-40;
 * appendMailbox separator handling, state.js:381-395), made explicit.
 *
 * Mutations that rewrite existing lines (ack/discard/lease) go through
 * rewriteJsonl, which preserves malformed lines verbatim for diagnostics and
 * commits via the whole-file atomic writer.
 *
 * @module core/jsonl
 */
import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic, stripLeadingBom } from './atomic.js';

/** One skipped (malformed) JSONL line, 1-based like an editor gutter. */
export interface MalformedLine {
  lineNo: number;
  error: string;
}

/** One 1-based line entry: either a parsed value or a parse error. */
export interface ParsedJsonlEntry {
  lineNo: number;
  value?: unknown;
  error?: string;
}

export interface ParsedJsonl {
  values: unknown[];
  malformed: MalformedLine[];
  /** All non-blank lines with their 1-based numbers (value or error). */
  entries: ParsedJsonlEntry[];
}

/** Parse one raw JSONL buffer, skipping blank lines and collecting failures. */
export function parseJsonl(raw: string): ParsedJsonl {
  const entries: ParsedJsonlEntry[] = [];
  for (const [index, rawLine] of raw.split('\n').entries()) {
    const line = stripLeadingBom(rawLine);
    if (line.trim() === '') continue;
    try {
      entries.push({ lineNo: index + 1, value: JSON.parse(line) });
    } catch {
      entries.push({ lineNo: index + 1, error: 'invalid JSON' });
    }
  }
  const values = entries.filter((entry) => entry.error === undefined).map((entry) => entry.value!);
  const malformed = entries
    .filter((entry) => entry.error !== undefined)
    .map((entry) => ({ lineNo: entry.lineNo, error: entry.error! }));
  return { values, malformed, entries };
}

/**
 * Read one JSONL file as parsed values; ENOENT reads as empty.
 * `isItem` filters by shape: parse failures AND non-matching values count as
 * malformed lines (skipped + reported with their true 1-based line number),
 * never crash the reader.
 */
export async function readJsonl<T>(
  file: string,
  isItem: (value: unknown) => boolean,
  onMalformed?: (malformed: MalformedLine) => void,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const { entries } = parseJsonl(raw);
  const items: T[] = [];
  for (const entry of entries) {
    if (entry.error !== undefined) {
      onMalformed?.({ lineNo: entry.lineNo, error: entry.error });
      continue;
    }
    if (isItem(entry.value)) items.push(entry.value as T);
    else onMalformed?.({ lineNo: entry.lineNo, error: `invalid item shape: ${JSON.stringify(entry.value)}` });
  }
  return items;
}

/**
 * Append records as JSON lines.
 *
 * Tail handling before appending:
 * - file missing or ends with `\n` -> plain O_APPEND of the new lines;
 * - tail is a complete JSON object line without trailing newline -> append a
 *   separating `\n` first (dsh appendMailbox separator rule, state.js:393);
 * - tail is an incomplete (unparseable) fragment -> truncate it away first
 *   (DESIGN.md §2.7-5: "追加前若尾行不完整先截断").
 */
export async function appendJsonl(file: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dirname(file), { recursive: true });
  let raw = '';
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let prefix = '';
  if (raw !== '' && !raw.endsWith('\n')) {
    const tail = stripLeadingBom(raw.slice(raw.lastIndexOf('\n') + 1));
    let tailIsCompleteLine = false;
    try {
      tailIsCompleteLine = JSON.parse(tail) !== null && typeof JSON.parse(tail) === 'object';
    } catch {
      tailIsCompleteLine = false;
    }
    if (tailIsCompleteLine) {
      prefix = '\n';
    } else {
      const keepUpTo = raw.lastIndexOf('\n') + 1; // 0 when the whole file is the fragment
      if (keepUpTo !== raw.length) await truncate(file, Buffer.byteLength(raw.slice(0, keepUpTo), 'utf8'));
    }
  }
  const payload = lines.map((line) => `${line}\n`).join('');
  const handle = await open(file, 'a');
  try {
    await handle.write(prefix + payload, null, 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Rewrite selected lines of one JSONL file in place (whole-file atomic commit).
 * `mutate` receives each parsed value; return the replacement line to replace
 * it, `undefined` to keep the original line verbatim. Malformed lines are
 * always preserved verbatim (dsh mutateMailbox discipline, state.js:464-478).
 *
 * @returns whether the file existed (false: nothing was changed).
 */
export async function rewriteJsonl(
  file: string,
  mutate: (value: unknown) => string | undefined,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const lines = raw.split('\n').map((rawLine) => {
    const line = stripLeadingBom(rawLine);
    if (line.trim() === '') return rawLine;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return rawLine;
    }
    return mutate(value) ?? rawLine;
  });
  await writeFileAtomic(file, lines.join('\n'));
  return true;
}
