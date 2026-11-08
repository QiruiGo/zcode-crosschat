/**
 * M1 core-store: Windows-safe atomic whole-file replacement.
 *
 * Port of dsh state.js:524-631 (verified by the 08 抽查 report §1.8/§4-1):
 * write a same-directory temp file, then `rename` over the target. On Windows
 * `rename` over an existing target throws EPERM (or EACCES/EBUSY variants)
 * while any other process keeps the target open without FILE_SHARE_DELETE
 * (editors, indexers, antivirus). Retry the rename a few times (transient
 * locks clear quickly), then degrade to a direct overwrite — content-equivalent
 * because the payload is already fully written at that point.
 *
 * Only used for whole files (team.json, names.json, sessions/*.json, wake
 * nonces, snapshot.json). JSONL append paths go through jsonl.ts instead.
 *
 * @module core/atomic
 */
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

/** Rename attempts before falling back to a direct overwrite. */
export const ATOMIC_RENAME_RETRIES = 3;
/** Pause between rename attempts, giving a briefly-locking owner time to finish. */
export const ATOMIC_RENAME_RETRY_DELAY_MS = 50;

/**
 * Rename error codes worth retrying before the direct-write fallback.
 * EEXIST/ENOTEMPTY cover other "target busy" edge shapes.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

export function isRetryableRenameError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && RETRYABLE_RENAME_CODES.has(String((error as NodeJS.ErrnoException).code ?? ''));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replace `file` with `content`, preferring an atomic same-directory rename of
 * an already-written temp file, degrading to a direct overwrite when the
 * rename cannot proceed. Every path removes the temp file; when both the
 * atomic rename and the direct write fail, the combined error surfaces as an
 * AggregateError.
 */
export async function replaceFileAtomicOrDirect(
  temporary: string,
  file: string,
  content: string,
  options: { retries?: number; retryDelayMs?: number } = {},
): Promise<void> {
  const retries = options.retries ?? ATOMIC_RENAME_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? ATOMIC_RENAME_RETRY_DELAY_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      if (isRetryableRenameError(error) && attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      let fallbackError: unknown;
      try {
        await writeFile(file, content, 'utf8');
      } catch (writeError) {
        fallbackError = writeError;
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      if (fallbackError !== undefined) {
        throw new AggregateError(
          [error, fallbackError],
          `failed to replace "${file}" atomically (${String(error)}) or by direct write (${String(fallbackError)})`,
        );
      }
      return;
    }
  }
}

/**
 * Atomically replace one UTF-8 state file from a same-directory temp file.
 * The temp file is `${file}.${pid}.${uuid}.tmp`, written with flag 'wx' so a
 * concurrent writer of the same name can never interleave.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await replaceFileAtomicOrDirect(temporary, file, content);
}

/** Remove the optional UTF-8 BOM some editors prepend to JSON text. */
export function stripLeadingBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** Alias of writeFileAtomic (module-3 call name). */
export const atomicWriteFile = writeFileAtomic;
