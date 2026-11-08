/**
 * M1 core-store: two-level locking.
 *
 * Real difference from dsh (DESIGN.md §2.7): dsh runs every mutation inside
 * ONE host process, so a promise-chain lock suffices (state.js:37-56). zcode
 * runs one MCP server process per session — several processes write the same
 * `<workspace>/.crosschat` — so a cross-process lockfile is added on top:
 *
 * 1. In-process: per-key promise chains, port of withTeamLock including the
 *    settled-cleanup discipline (state.js:49-55).
 * 2. Cross-process: `locks/<name>.lock` created with O_EXCL ('wx'), content
 *    `{pid, ts, token}`. Acquisition retries with exponential backoff for a
 *    total of LOCK_WAIT_MS (15 s); on timeout the caller gets a structured
 *    `{error:"busy", lock}` error and MUST return that to the model instead of
 *    leaving half-applied state. Stale takeover when the owning pid is dead OR
 *    the lock file is older than LOCK_STALE_MS (120 s). The random `token`
 *    guards release: we only ever unlink the exact file we created (the design
 *    sketches `{pid, ts}`; the token is a safety addition, documented here).
 * 3. Global lock order: registry -> team. The only path that ever holds both
 *    is xc_register (bind name, then join team, rollback on failure, §2.7-3).
 *    No path may acquire team before registry (deadlock rule I8).
 *
 * @module core/lock
 */
import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { lockFile, locksDir, registryLockNames, teamLockNames } from './paths.js';

// ---------------------------------------------------------------------------
// 1. In-process promise chains (port of state.js:29-63)
// ---------------------------------------------------------------------------

/** In-process mutation queues (promise chains), keyed by lock identity. */
const processLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize mutations of one scope across the whole process.
 * Port of dsh withTeamLock(key, fn) with its settled-cleanup discipline.
 */
export async function withProcessLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = processLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate, () => gate);
  processLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    // Drop this key's queue entry once we are still its tail, so settled
    // scopes do not leave one resolved promise chained forever. A successor
    // that already appended itself owns the map slot; keep its entry.
    if (processLocks.get(key) === tail) processLocks.delete(key);
  }
}

/** Keys with an in-process lock queue (held or waiting), for diagnostics. */
export function processLockQueueKeys(): string[] {
  return [...processLocks.keys()];
}

// ---------------------------------------------------------------------------
// 2. Cross-process lockfile
// ---------------------------------------------------------------------------

/** Total wait before a changed-tool call gives up with a busy error (§2.7-2). */
export const LOCK_WAIT_MS = 15_000;
/** Lock files older than this are taken over even when the pid looks alive. */
export const LOCK_STALE_MS = 120_000;
/** First backoff pause between acquisition retries. */
export const LOCK_BACKOFF_START_MS = 25;
/** Backoff cap. */
export const LOCK_BACKOFF_MAX_MS = 500;

/** Structured busy error: `toStructured()` is what the tool layer returns. */
export class LockBusyError extends Error {
  readonly lock: string;

  constructor(lock: string, message?: string) {
    super(message ?? `lock "${lock}" is busy`);
    this.name = 'LockBusyError';
    this.lock = lock;
  }

  toStructured(): { error: 'busy'; lock: string } {
    return { error: 'busy', lock: this.lock };
  }
}

interface LockContent {
  pid: number;
  ts: number;
  token: string;
}

function parseLockContent(raw: string): LockContent | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record['pid'] !== 'number' || typeof record['ts'] !== 'number'
      || typeof record['token'] !== 'string') {
      return undefined;
    }
    return { pid: record['pid'], ts: record['ts'], token: record['token'] };
  } catch {
    return undefined;
  }
}

/** Whether a pid is alive. EPERM counts as alive (system process). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export interface FileLockOptions {
  /** Total acquisition budget in ms (default LOCK_WAIT_MS). */
  waitMs?: number;
  /** Stale threshold in ms (default LOCK_STALE_MS). */
  staleMs?: number;
}

export interface FileLock {
  readonly name: string;
  release(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the lock file exclusively; returns the token written, or undefined
 * when somebody else won the race.
 */
function tryCreateLockFile(path: string): string | undefined {
  const content: LockContent = { pid: process.pid, ts: Date.now(), token: randomUUID() };
  let fd: number;
  try {
    // 'wx' = O_CREAT|O_EXCL|O_WRONLY: creation is the mutual exclusion.
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(content), null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return content.token;
}

/**
 * Acquire one cross-process lock, retrying with exponential backoff within
 * `waitMs`. Stale locks (owner pid dead, or file older than `staleMs`) are
 * taken over after a re-read confirms the same content (shrinks the takeover
 * race window; the release-time token check closes it).
 */
export async function acquireFileLock(stateRoot: string, name: string, options: FileLockOptions = {}): Promise<FileLock> {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  await mkdir(locksDir(stateRoot), { recursive: true });
  const path = lockFile(stateRoot, name);
  const deadline = Date.now() + waitMs;
  let backoff = LOCK_BACKOFF_START_MS;
  for (;;) {
    const token = tryCreateLockFile(path);
    if (token !== undefined) {
      return {
        name,
        release: async () => {
          // Only unlink the exact file we created (token match). If our lock
          // was taken over meanwhile, the file on disk is somebody else's.
          try {
            const current = parseLockContent(await readFile(path, 'utf8'));
            if (current?.token === token) await unlink(path);
          } catch {
            // Missing file or unreadable content: nothing to clean up.
          }
        },
      };
    }
    // Held by someone: judge staleness from the current content.
    let holder: LockContent | undefined;
    try {
      holder = parseLockContent(await readFile(path, 'utf8'));
    } catch {
      holder = undefined; // vanished or unreadable -> retry immediately
    }
    if (holder !== undefined) {
      const stale = !pidAlive(holder.pid) || Date.now() - holder.ts > staleMs;
      if (stale) {
        // Re-read: only take over when the very same stale content is still
        // there (another waiter may have already replaced it).
        const again = await readFile(path, 'utf8').then(
          (raw) => parseLockContent(raw),
          () => undefined,
        );
        if (again !== undefined && again.token === holder.token
          && (!pidAlive(again.pid) || Date.now() - again.ts > staleMs)) {
          try {
            unlinkSync(path);
          } catch {
            // Lost the unlink race -> loop and retry normally.
          }
        }
      }
    }
    if (Date.now() >= deadline) throw new LockBusyError(name);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, LOCK_BACKOFF_MAX_MS);
  }
}

/** Run `fn` under one cross-process lock, releasing on every exit path. */
export async function withFileLock<T>(
  stateRoot: string,
  name: string,
  fn: () => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  const lock = await acquireFileLock(stateRoot, name, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// 3. Composite helpers with the fixed registry -> team order (§2.7-3)
// ---------------------------------------------------------------------------

/** Standard registry lock. */
export function withRegistryLock<T>(
  stateRoot: string,
  fn: () => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  const names = registryLockNames(stateRoot);
  return withProcessLock(names.processKey, () => withFileLock(stateRoot, names.file, fn, options));
}

/**
 * Hold registry then team, in that fixed order (the only legal two-lock path,
 * used by xc_register: bind name -> join team -> rollback binding on failure).
 * Deadlock rule: no path may take team before registry.
 */
export function withRegistryThenTeamLocks<T>(
  stateRoot: string,
  teamId: string,
  fn: () => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  const registry = registryLockNames(stateRoot);
  const team = teamLockNames(stateRoot, teamId);
  return withProcessLock(registry.processKey, () =>
    withProcessLock(team.processKey, () =>
      withFileLock(stateRoot, registry.file, () =>
        withFileLock(stateRoot, team.file, fn, options), options)));
}

// ---------------------------------------------------------------------------
// 4. Compatibility layer for the module-2/3 call shapes (dsh-style)
// ---------------------------------------------------------------------------

/** Parse a `team:<abs stateRoot>:<teamId>` process key back into its parts. */
function teamLockNamesFromKey(key: string): { processKey: string; file: string; stateRoot: string } | undefined {
  if (!key.startsWith('team:')) return undefined;
  const rest = key.slice('team:'.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon <= 0) return undefined;
  const stateRoot = rest.slice(0, lastColon);
  const teamId = rest.slice(lastColon + 1);
  if (stateRoot === '' || teamId === '') return undefined;
  const names = teamLockNames(stateRoot, teamId);
  return { ...names, stateRoot };
}

/**
 * The dsh-style team lock key: `team:<abs stateRoot>:<teamId>` (§2.7-2).
 * Feed it to the withTeamLock(key, fn) overload below.
 */
export function teamLockKey(stateRoot: string, teamId: string): string {
  return teamLockNames(stateRoot, teamId).processKey;
}

/**
 * Overloaded team lock:
 * - `withTeamLock(key, fn, options?)` — dsh call shape; `key` from teamLockKey().
 *   Team keys also take the cross-process file lock (zcode has one MCP process
 *   per session, §2.7); non-team keys degrade to the in-process chain only.
 * - `withTeamLock(stateRoot, teamId, fn, options?)` — convenience spelling.
 */
export function withTeamLock<T>(
  keyOrStateRoot: string,
  teamIdOrFn: string | (() => Promise<T> | T),
  fnOrOptions?: (() => Promise<T> | T) | FileLockOptions,
  maybeOptions?: FileLockOptions,
): Promise<T> {
  if (typeof teamIdOrFn === 'function') {
    const run = teamIdOrFn;
    const options = (fnOrOptions ?? {}) as FileLockOptions;
    const parsed = teamLockNamesFromKey(keyOrStateRoot);
    if (parsed === undefined) return withProcessLock(keyOrStateRoot, run);
    return withProcessLock(parsed.processKey, () => withFileLock(parsed.stateRoot, parsed.file, run, options));
  }
  if (typeof fnOrOptions !== 'function') {
    throw new TypeError('withTeamLock: missing runner function');
  }
  const run = fnOrOptions as () => Promise<T> | T;
  return withProcessLock(teamLockNames(keyOrStateRoot, teamIdOrFn).processKey, () =>
    withFileLock(keyOrStateRoot, teamLockNames(keyOrStateRoot, teamIdOrFn).file, run, maybeOptions ?? {}));
}

/**
 * Cross-process lock addressed by lock FILE PATH (module-3 call shape):
 * `withCrossProcessLock(paths.lock(name), fn)`. The path is canonicalized back
 * to the standard scopes so every caller contends on the SAME physical lock
 * file (e.g. any `locks/registry.lock` spelling maps to the canonical
 * `registry-<digest>` lock, identical to withRegistryLock).
 */
export async function withCrossProcessLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  const normalized = lockPath.replaceAll('\\', '/');
  const marker = '/locks/';
  const at = normalized.lastIndexOf(marker);
  let name: string;
  let stateRoot: string;
  if (at >= 0) {
    stateRoot = normalized.slice(0, at);
    name = normalized.slice(at + marker.length).replace(/\.lock$/, '');
  } else {
    stateRoot = lockPath; // nonstandard path: treat the whole path as the scope
    name = lockPath;
  }
  // Canonical scope names (§2.7-2: 锁粒度 = team 与 registry).
  if (name === 'registry') {
    const registry = registryLockNames(stateRoot);
    name = registry.file;
  } else if (name.startsWith('team')) {
    // `team-<digest>-<teamId>` files are already canonical; `team:<abs>:<id>`
    // spellings map through the key parser.
    const parsed = teamLockNamesFromKey(name);
    if (parsed !== undefined) name = parsed.file;
  }
  return withFileLock(stateRoot, name, fn, options);
}
