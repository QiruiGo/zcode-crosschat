/**
 * M1 core-store: fault-tolerant JSONL primitives.
 *
 * JSONL files (inbox/*.jsonl, logs/engine.jsonl) are cross-process APPEND
 * writes (O_APPEND, never rename) and therefore read-tolerant by contract
 * (DESIGN.md §2.7-5): a crash can leave a half-written tail line; parse
 * failures are skipped and reported through an onMalformed callback, and an
 * incomplete tail is newline-separated before the next append (v0.9.3 P0:
 * bounded tail probe, never a whole-file read). This is the dsh original
 * behavior (readMailbox's onMalformed callback, mailbox.js:29-40;
 * appendMailbox separator handling, state.js:381-395), made explicit.
 *
 * Mutations that rewrite existing lines (ack/discard/lease) go through
 * rewriteJsonl, which preserves malformed lines verbatim for diagnostics and
 * commits via the whole-file atomic writer.
 *
 * @module core/jsonl
 */
import { mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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
 * `appendJsonl` 尾行探针窗口（字节）：只读文件末尾这么多字节判断是否以 `\n`
 * 结尾。v0.9.3（P0，审计洪泛 OOM）：追加成本必须与文件大小无关——旧实现每次
 * 追加前 `readFile` 整个文件，一条审计 = 一次全文件读，M 条坏行 × 每拍 sweep
 * 就能把 MCP server 进程打到 heap limit。
 */
const APPEND_TAIL_PROBE_BYTES = 4096;

/**
 * 尾部是否需要先补一个 `\n` 分隔符：open + fstat 取 size，定点 read 末尾
 * ≤{@link APPEND_TAIL_PROBE_BYTES} 字节，只看最后一个字节。文件不存在/为空/
 * 以 `\n` 结尾 → false（无需分隔符）。只读有界尾窗，绝不整文件读。
 */
async function tailNeedsSeparator(file: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const length = Math.min(APPEND_TAIL_PROBE_BYTES, size);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    if (bytesRead === 0) return false;
    return buffer[bytesRead - 1] !== 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * Append records as JSON lines (constant / bounded cost).
 *
 * Tail handling before appending:
 * - probe only the last ≤4 KiB via open+fstat+positional read (v0.9.3 P0);
 *   the file size never enters memory and the cost does not grow with it;
 * - file missing, empty, or ending with `\n` -> plain O_APPEND of the new lines;
 * - tail lacks the trailing newline (half-written fragment, or a complete line
 *   written without its separator) -> write a separating `\n` first, then the
 *   new lines. The fragment stays on disk as an unparseable line: readers skip
 *   it and the (throttled) malformed audit reports it; it is NOT truncated
 *   away anymore, because deciding "truncate vs separate" would require the
 *   whole-file read this change removes (dsh appendMailbox separator rule,
 *   state.js:393, preserved).
 *
 * The O_APPEND write itself is unchanged: one atomic write of prefix+payload.
 */
export async function appendJsonl(file: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dirname(file), { recursive: true });
  const prefix = (await tailNeedsSeparator(file)) ? '\n' : '';
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
