/**
 * v0.5.2 防回归单测：锁文件打开的 Windows 共享冲突（红队二番战 并发与-2，
 * 裁决 #7 confirmed：团队锁 7/4828 次 verbatim EPERM 直冒 internal、消息未
 * 落盘、engine.jsonl 零审计；边界与-R2-1 同根因未复现项顺带加固——registry
 * 锁走同一条 acquireFileLock，一处修复两锁覆盖）。
 *
 * 注入点：lock.ts 的锁创建全仓仅经 openSync('wx')（grep openSync：lock.ts
 * 是唯一创建锁文件处；resume-cli/wake-helper 的 openSync('a') 是日志追加，
 * 与锁无关），故 mock 'node:fs' 的 openSync 即可精确复现红队错误形态。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** fs.openSync 的真实签名（重载解析取最后一致形态）；mock 转发与计数都按它来。 */
type OpenSyncFn = typeof import('node:fs').openSync;
type OpenSyncArgs = Parameters<OpenSyncFn>;

const real = vi.hoisted(() => ({ openSync: null as null | OpenSyncFn }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  real.openSync = actual.openSync;
  return {
    ...actual,
    openSync: vi.fn((...args: OpenSyncArgs) => real.openSync!(...args)),
  };
});

import { openSync } from 'node:fs';
import {
  LOCK_OPEN_CONFLICT_RETRIES,
  LOCK_OPEN_CONFLICT_RETRY_DELAY_MS,
  LockBusyError,
  acquireFileLock,
  withRegistryLock,
} from './lock.js';
import { engineLogFile, lockFile } from './paths.js';

const openSyncMock = vi.mocked(openSync);

/** 红队 verbatim 形态：`EPERM: operation not permitted, open '…locks/team-<hash>-default.lock'`。 */
function openError(code: string): NodeJS.ErrnoException {
  const error = new Error(
    `${code}: operation not permitted, open 'D:\\\\ws\\\\\\.crosschat\\\\locks\\\\team-d6d3f0d9-default.lock'`,
  ) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Poll until the engine audit log contains a matching line (logEngineEvent is best-effort async). */
async function untilEngineEvent(stateRoot: string, predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (existsSync(engineLogFile(stateRoot))) {
      const events = readFileSync(engineLogFile(stateRoot), 'utf8')
        .split('\n').filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (events.some(predicate)) return events;
    }
    if (Date.now() > deadline) throw new Error('untilEngineEvent: timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-lock-conflict-'));
  openSyncMock.mockReset();
  openSyncMock.mockImplementation((...args: OpenSyncArgs) => real.openSync!(...args));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('lock open sharing-conflict hardening (v0.5.2: 并发与-2 / 边界与-R2-1)', () => {
  it('retries transient EPERM/EBUSY on lock open and acquires — the flood message is no longer lost (并发与-2)', async () => {
    let calls = 0;
    openSyncMock.mockImplementation((...args: OpenSyncArgs) => {
      calls += 1;
      // 红队实测形态：前两次打开撞共享冲突（EPERM 后 EBUSY），第三次成功。
      if (calls === 1) throw openError('EPERM');
      if (calls === 2) throw openError('EBUSY');
      return real.openSync!(...args);
    });
    const started = Date.now();
    const lock = await acquireFileLock(dir, 'eperm-retry', { waitMs: 5000 });
    // 恰重试到第 3 次成功：不是一次成功（冲突真被重试），也没有重试满 3 次还失败。
    expect(calls).toBe(3);
    // 短退避确实发生（25ms + 50ms），且总耗时可接受（不是 15s busy 路径）。
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOCK_OPEN_CONFLICT_RETRY_DELAY_MS * 3);
    expect(Date.now() - started).toBeLessThan(2000);
    // 锁正常创建并可释放（业务函数随后才会写消息——修复保住的是这一步）。
    expect(existsSync(lockFile(dir, 'eperm-retry'))).toBe(true);
    expect(JSON.parse(readFileSync(lockFile(dir, 'eperm-retry'), 'utf8')).pid).toBe(process.pid);
    await lock.release();
    expect(existsSync(lockFile(dir, 'eperm-retry'))).toBe(false);
  }, 15000);

  it('a persistent open conflict ends in structured busy (never internal) and is audited (并发与-2)', async () => {
    openSyncMock.mockImplementation(() => { throw openError('EPERM'); });
    const error = await acquireFileLock(dir, 'eperm-busy', { waitMs: 400, staleMs: 120_000 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // 不再是裸 fs 错误（工具层会包成 internal）：而是 LockBusyError → {error:"busy", lock}。
    expect(error).toBeInstanceOf(LockBusyError);
    expect((error as LockBusyError).toStructured()).toEqual({ error: 'busy', lock: 'eperm-busy' });
    // 红队观测该失败 engine.jsonl 零记录：现在有 lock-open-conflict 审计行。
    const events = await untilEngineEvent(dir, (e) => e.event === 'lock-open-conflict');
    const conflicts = events.filter((e) => e.event === 'lock-open-conflict');
    expect(conflicts).toHaveLength(1); // 一次获取最多一行（退避风暴不刷屏）
    expect(conflicts[0]).toMatchObject({
      lock: 'eperm-busy',
      code: 'EPERM',
      retries: LOCK_OPEN_CONFLICT_RETRIES,
      outcome: 'busy',
    });
    // 没拿到锁就没有锁文件残留。
    expect(existsSync(lockFile(dir, 'eperm-busy'))).toBe(false);
  }, 15000);

  it('a conflict that clears during the wait still acquires, and audits outcome=acquired (并发与-2)', async () => {
    let calls = 0;
    openSyncMock.mockImplementation((...args: OpenSyncArgs) => {
      calls += 1;
      // 前 3 次（一次完整快速重试批次）持续冲突，之后杀软松手：主循环退避后夺得。
      if (calls <= LOCK_OPEN_CONFLICT_RETRIES) throw openError('EPERM');
      return real.openSync!(...args);
    });
    const lock = await acquireFileLock(dir, 'eperm-late', { waitMs: 5000 });
    expect(calls).toBe(LOCK_OPEN_CONFLICT_RETRIES + 1);
    await lock.release();
    const events = await untilEngineEvent(dir, (e) => e.event === 'lock-open-conflict' && e.outcome === 'acquired');
    expect(events.filter((e) => e.event === 'lock-open-conflict')).toHaveLength(1);
  }, 15000);

  it('does NOT retry non-conflict open errors (EACCES still surfaces unchanged)', async () => {
    openSyncMock.mockImplementation(() => { throw openError('EACCES'); });
    // 真实权限错误不被洗成「可重试冲突」：一次即抛，行为与 v0.5.1 一致。
    await expect(acquireFileLock(dir, 'eacces', { waitMs: 1000 })).rejects.toThrow(/EACCES/);
    expect(openSyncMock).toHaveBeenCalledTimes(1);
  });

  it('registry lock gets the same protection (边界与-R2-1: registry-<digest> lock, same code path)', async () => {
    openSyncMock.mockImplementation(() => { throw openError('EPERM'); });
    let ran = false;
    const error = await withRegistryLock(dir, async () => { ran = true; return 'ran'; }, { waitMs: 400 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LockBusyError);
    expect(ran).toBe(false); // 拿不到锁就不执行业务（与 team 锁同纪律）
    const events = await untilEngineEvent(dir, (e) => e.event === 'lock-open-conflict');
    expect(events.filter((e) => e.event === 'lock-open-conflict')).toHaveLength(1);
  }, 15000);
});
