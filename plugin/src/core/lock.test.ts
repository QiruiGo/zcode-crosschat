import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LockBusyError,
  acquireFileLock,
  pidAlive,
  withProcessLock,
  withRegistryThenTeamLocks,
  withTeamLock,
  UNPARSEABLE_LOCK_GRACE_MS,
} from './lock.js';
import { lockFile, teamLockNames } from './paths.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Spawn a detached-style child that holds the same lockfile, then exits. */
function spawnChildHolder(lockPath: string, holdMs: number): Promise<number> {
  const script = `
    const fs = require('node:fs');
    const content = JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'child-token' });
    let fd = null;
    while (fd === null) {
      try { fd = fs.openSync(${JSON.stringify(lockPath)}, 'wx'); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    setTimeout(() => { try { fs.unlinkSync(${JSON.stringify(lockPath)}); } catch {} }, ${holdMs});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('spawn', () => resolve(child.pid!));
  });
}

/** Wait until a predicate turns true (polling, test-only). */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid!));
    child.on('error', () => resolve(-1));
  });
}

describe('withProcessLock (in-process promise chains, dsh state.js:37-56 port)', () => {
  it('serializes concurrent mutations on one key', async () => {
    let counter = 0;
    let running = 0;
    let maxConcurrent = 0;
    await Promise.all(Array.from({ length: 8 }, () => withProcessLock('k', async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      counter += 1;
      running -= 1;
    })));
    expect(counter).toBe(8);
    expect(maxConcurrent).toBe(1);
  });

  it('different keys do not block each other', async () => {
    let running = 0;
    let maxConcurrent = 0;
    await Promise.all(['a', 'b', 'c'].map((key) => withProcessLock(key, async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
    })));
    expect(maxConcurrent).toBe(3);
  });

  it('a failing fn does not wedge the queue (settled cleanup discipline)', async () => {
    await expect(withProcessLock('k2', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let ran = false;
    await withProcessLock('k2', async () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe('acquireFileLock (cross-process lockfile, DESIGN §2.7-2)', () => {
  it('creates a {pid, ts, token} lock file and removes it on release', async () => {
    const lock = await acquireFileLock(dir, 'team-x');
    const raw = JSON.parse(readFileSync(lockFile(dir, 'team-x'), 'utf8'));
    expect(raw.pid).toBe(process.pid);
    expect(typeof raw.ts).toBe('number');
    expect(typeof raw.token).toBe('string');
    await lock.release();
    expect(existsSync(lockFile(dir, 'team-x'))).toBe(false);
  });

  it('waits for a REAL other-process holder and acquires after it exits (锁竞争)', async () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    const lockPath = lockFile(dir, 'contended');
    const childPid = await spawnChildHolder(lockPath, 250);
    // Wait until the child actually holds the lock (spawn returns before it runs).
    await until(() => existsSync(lockPath));
    const started = Date.now();
    const lock = await acquireFileLock(dir, 'contended', { waitMs: 5000, staleMs: 120000 });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(200); // had to wait for the child
    expect(childPid).not.toBe(process.pid);
    await lock.release();
  }, 15000);

  it('gives up with a structured busy error when the holder keeps the lock', async () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    const lockPath = lockFile(dir, 'busy');
    // Child holds for far longer than our budget.
    await spawnChildHolder(lockPath, 10_000);
    await until(() => existsSync(lockPath));
    const budget = 300;
    const error = await acquireFileLock(dir, 'busy', { waitMs: budget, staleMs: 120000 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LockBusyError);
    expect((error as LockBusyError).toStructured()).toEqual({ error: 'busy', lock: 'busy' });
  }, 15000);

  it('takes over a lock whose owning pid is dead', async () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    const dead = await deadPid();
    expect(pidAlive(dead)).toBe(false);
    writeFileSync(lockFile(dir, 'stale-pid'), JSON.stringify({ pid: dead, ts: Date.now(), token: 't' }), 'utf8');
    const lock = await acquireFileLock(dir, 'stale-pid', { waitMs: 1000, staleMs: 120000 });
    expect(JSON.parse(readFileSync(lockFile(dir, 'stale-pid'), 'utf8')).pid).toBe(process.pid);
    await lock.release();
  }, 15000);

  it('takes over a lock older than staleMs even when the pid looks alive', async () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    writeFileSync(lockFile(dir, 'stale-age'), JSON.stringify({
      pid: process.pid, ts: Date.now() - 121_000, token: 'old',
    }), 'utf8');
    const lock = await acquireFileLock(dir, 'stale-age', { waitMs: 1000, staleMs: 120_000 });
    const raw = JSON.parse(readFileSync(lockFile(dir, 'stale-age'), 'utf8'));
    expect(raw.token).not.toBe('old');
    await lock.release();
  }, 15000);

  it('release does NOT unlink a file it no longer owns (token guard)', async () => {
    const lock = await acquireFileLock(dir, 'owned');
    // Simulate a takeover by another process while we still hold the handle.
    writeFileSync(lockFile(dir, 'owned'), JSON.stringify({ pid: 999999, ts: Date.now(), token: 'someone-else' }), 'utf8');
    await lock.release();
    expect(existsSync(lockFile(dir, 'owned'))).toBe(true);
    expect(JSON.parse(readFileSync(lockFile(dir, 'owned'), 'utf8')).token).toBe('someone-else');
  });

  // ---- v0.5.1（故障注-6 修复）：不可解析残留锁的安全清除 ----

  it('safely clears an UNPARSEABLE residual lock (old mtime) and acquires (故障注-6)', async () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    const path = lockFile(dir, 'garbage');
    writeFileSync(path, '\u0000\u0001binary-garbage', 'utf8'); // 乱码：无法提取 pid/token
    // mtime 拨老（超过宽限期）→ 首轮即判定为无主残留并清除
    const old = new Date(Date.now() - UNPARSEABLE_LOCK_GRACE_MS * 2);
    utimesSync(path, old, old);
    const started = Date.now();
    const lock = await acquireFileLock(dir, 'garbage', { waitMs: 5000 });
    expect(Date.now() - started).toBeLessThan(2000); // 不再 15s busy
    // 锁文件已被本进程的合法内容替换
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.pid).toBe(process.pid);
    await lock.release();
    expect(existsSync(path)).toBe(false);
  }, 15000);

  it('clears a 0-byte residual lock (crash between openSync and writeSync)', async () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    const path = lockFile(dir, 'zero-byte');
    writeFileSync(path, '', 'utf8');
    const old = new Date(Date.now() - UNPARSEABLE_LOCK_GRACE_MS * 2);
    utimesSync(path, old, old);
    const lock = await acquireFileLock(dir, 'zero-byte', { waitMs: 5000 });
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
    await lock.release();
  }, 15000);

  it('a FRESH unparseable lock is respected within the grace window, cleared after it', async () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    const path = lockFile(dir, 'fresh-garbage');
    writeFileSync(path, '{}', 'utf8'); // 合法 JSON 但缺字段 → 不可解析
    const started = Date.now();
    const lock = await acquireFileLock(dir, 'fresh-garbage', { waitMs: 10_000 });
    // 宽限期内只重试不清除（不误删刚被合法持有的锁），约一个宽限期后自愈
    expect(Date.now() - started).toBeGreaterThanOrEqual(UNPARSEABLE_LOCK_GRACE_MS - 50);
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
    await lock.release();
  }, 15000);

  it('a VALID fresh lock with a live pid is never cleared (宽限不破坏正常竞争)', async () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    const path = lockFile(dir, 'valid-live');
    writeFileSync(path, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'live-holder' }), 'utf8');
    const error = await acquireFileLock(dir, 'valid-live', { waitMs: 300 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LockBusyError);
    // 锁未被清除：内容原样
    expect(JSON.parse(readFileSync(path, 'utf8')).token).toBe('live-holder');
  }, 15000);
});

describe('withTeamLock / withRegistryThenTeamLocks (fixed registry -> team order)', () => {
  it('withTeamLock composes the in-process chain with the file lock', async () => {
    const names = teamLockNames(dir, 'default');
    const seen: string[] = [];
    await Promise.all([
      withTeamLock(dir, 'default', async () => {
        seen.push('a');
        // While a holds, the lock file exists on disk.
        expect(existsSync(lockFile(dir, names.file))).toBe(true);
        await new Promise((r) => setTimeout(r, 15));
        seen.push('a2');
      }, { waitMs: 2000 }),
      withTeamLock(dir, 'default', async () => { seen.push('b'); }, { waitMs: 2000 }),
    ]);
    // Each critical section ran to completion inside the lock; b could not
    // interleave between a's two pushes because they share one key.
    expect(seen.indexOf('a')).toBeLessThan(seen.indexOf('a2'));
    expect(seen).toContain('b');
    // Both file locks were released afterwards.
    expect(existsSync(lockFile(dir, names.file))).toBe(false);
  });

  it('withRegistryThenTeamLocks runs fn once and releases both locks', async () => {
    let ran = 0;
    const value = await withRegistryThenTeamLocks(dir, 'default', async () => ++ran, { waitMs: 2000 });
    expect(value).toBe(1);
    expect(ran).toBe(1);
  });
});
