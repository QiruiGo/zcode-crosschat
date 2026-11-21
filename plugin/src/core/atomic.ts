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
import { link, rename, rm, writeFile } from 'node:fs/promises';

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

/**
 * Atomically **create** `file` with `content`, failing when it already exists.
 *
 * v0.8.1（29 能力反向检验 C1-B01 修复）：checkpoint 的同毫秒并发覆写根因是
 * 「stat 预检 → 原子写」两步之间的竞态——两个同刻调用都看到候选位不存在，随后
 * 都 rename 过去，先发者的内容被静默吞掉（双方均报成功、同一路径）。排他创建把
 * 「占位」变成**单次原子操作**：同目录 temp（flag 'wx'）落内容后 `link` 到目标
 * ——`link` 在目标已存在时以 EEXIST 失败（CreateHardLink 语义），输家拿不到
 * 「写了个寂寞还报成功」的结果，改由调用方换 stamp 重试。
 *
 * 为什么不直接 `open(target,'wx')` 写正文：被杀进程会在目标留下**半截 .md**
 * （产品「0 半截 .md」的原子写纪律破功）；temp+link 下被杀只留 .tmp 残留
 * （由 checkpoint 侧的 sweepCheckpointTmpFiles 按年龄清理）。
 *
 * 返回 false = 目标已存在（什么都没写，temp 已清）；抛错 = 真失败（含卷不支持
 * 硬链的非 EEXIST 错误——由调用方映射为结构化失败，不假装落盘）。
 */
export async function writeFileExclusive(file: string, content: string): Promise<boolean> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await link(temporary, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
