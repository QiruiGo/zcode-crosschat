import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WAKE_INFLIGHT_MS,
  bindName,
  consumeWakeNonce,
  createWakeNonce,
  findInflightWakeNonce,
  findNameBinding,
  isWakeNonceFresh,
  namesBoundToSession,
  readNames,
  readSession,
  readWakeNonce,
  refreshSessionLastSeen,
  unbindName,
  writeSession,
} from './registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-registry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sessions/<sessionId>.json', () => {
  it('upserts lastSeen while preserving startedAt (hook refresh path)', async () => {
    const first = await refreshSessionLastSeen(dir, 'sess_a', { cwd: 'D:\\ws', now: 1000 });
    expect(first.startedAt).toBe(1000);
    expect(first.lastSeen).toBe(1000);
    const second = await refreshSessionLastSeen(dir, 'sess_a', { now: 2000 });
    expect(second.startedAt).toBe(1000);
    expect(second.lastSeen).toBe(2000);
    expect(second.cwd).toBe('D:\\ws');
    expect((await readSession(dir, 'sess_a'))?.lastSeen).toBe(2000);
  });

  it('preserves boundName across refreshes', async () => {
    await refreshSessionLastSeen(dir, 'sess_a', { now: 1 });
    await writeSession(dir, { sessionId: 'sess_a', cwd: '', startedAt: 1, lastSeen: 2, boundName: 'a' });
    const refreshed = await refreshSessionLastSeen(dir, 'sess_a', { now: 3 });
    expect(refreshed.boundName).toBe('a');
  });

  it('reads a corrupt session file as undefined (hooks must not crash)', async () => {
    const { sessionFile, sessionsDir } = await import('./paths.js');
    mkdirSync(sessionsDir(dir), { recursive: true });
    writeFileSync(sessionFile(dir, 'sess_bad'), '{broken', 'utf8');
    expect(await readSession(dir, 'sess_bad')).toBeUndefined();
  });

  it('reads a missing session as undefined', async () => {
    expect(await readSession(dir, 'sess_none')).toBeUndefined();
  });
});

describe('names.json', () => {
  it('binds, finds and rolls back names', async () => {
    await bindName(dir, 'a', { sessionId: 'sess_a', role: 'peer', registeredAt: 1 });
    await bindName(dir, 'b', { sessionId: 'sess_b', role: 'worker', registeredAt: 2 });
    expect(findNameBinding(await readNames(dir), 'a')?.sessionId).toBe('sess_a');
    expect(namesBoundToSession(await readNames(dir), 'sess_b')).toEqual(['b']);
    // Rollback: only removes when the binding still points at our session.
    expect(await unbindName(dir, 'a', 'sess_wrong')).toBe(false);
    expect(await unbindName(dir, 'a', 'sess_a')).toBe(true);
    expect(findNameBinding(await readNames(dir), 'a')).toBeUndefined();
  });

  it('throws a diagnostic on a corrupt names.json', async () => {
    const { namesFile, sessionsDir } = await import('./paths.js');
    mkdirSync(sessionsDir(dir), { recursive: true });
    writeFileSync(namesFile(dir), '[1,2,3]', 'utf8');
    await expect(readNames(dir)).rejects.toThrow(/invalid names\.json/);
  });

  // v0.7.1（红队四番战 故障注-2 修复）：不可解析字节（红队 fi26 同款
  // 'corrupt names \x00\x01'）此前裸抛 SyntaxError——无路径、无恢复指引。
  // 现在必须带文件绝对路径 + 可执行恢复动作（删文件重置 / 从备份恢复）。
  it('unparseable names.json throws with the file path + recovery guidance (fault-injection 2)', async () => {
    const { namesFile, sessionsDir } = await import('./paths.js');
    mkdirSync(sessionsDir(dir), { recursive: true });
    writeFileSync(namesFile(dir), 'corrupt names \x00\x01', 'utf8');
    await expect(readNames(dir)).rejects.toThrow(/invalid names\.json/);
    const err = await readNames(dir).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(namesFile(dir));                 // 文件路径（运维能定位）
    expect(message).toMatch(/not valid JSON/);                 // 损坏原因（不再是裸 token 错）
    expect(message).toMatch(/delete the file to reset/);       // 恢复动作 1
    expect(message).toMatch(/xc_identify|member-add/);         // 恢复动作 2（重建入口）
    // 形状非法（可解析但结构错）同样带路径 + 指引（与 team.json 文案同族）
    writeFileSync(namesFile(dir), '{"a": {"sessionId": 5}}', 'utf8');
    const err2 = await readNames(dir).catch((e: Error) => e);
    expect((err2 as Error).message).toContain(namesFile(dir));
    expect((err2 as Error).message).toMatch(/delete the file to reset/);
  });
});

describe('wake nonces (一次性唤醒 nonce, DESIGN §2.3-4 / §2.5-3)', () => {
  it('create -> read -> consume roundtrip', async () => {
    const { token, nonce } = await createWakeNonce(dir, { teamId: 'default', agentKey: 'b', sid: 'sess_b' });
    expect(token).toMatch(/[0-9a-f-]{36}/);
    const stored = await readWakeNonce(dir, token);
    expect(stored?.agentKey).toBe('b');
    expect(stored?.sid).toBe('sess_b');
    expect(stored?.used).toBeUndefined();
    const consumed = await consumeWakeNonce(dir, token, { teamId: 'default', agentKey: 'b', sid: 'sess_b' });
    expect(consumed?.used).toBe(true);
    // One-shot: the second consume fails.
    expect(await consumeWakeNonce(dir, token, { teamId: 'default', agentKey: 'b', sid: 'sess_b' })).toBeUndefined();
    expect(nonce.ts).toBeTypeOf('number');
  });

  it('consume rejects a nonce whose fields do not match the register call', async () => {
    const { token } = await createWakeNonce(dir, { teamId: 'default', agentKey: 'b', sid: 'sess_b' });
    expect(await consumeWakeNonce(dir, token, { teamId: 'default', agentKey: 'impostor', sid: 'sess_b' })).toBeUndefined();
    expect((await readWakeNonce(dir, token))?.used).toBeUndefined(); // left intact
  });

  it('an expired nonce is neither consumed nor in-flight (TTL=15min)', async () => {
    const { token, nonce } = await createWakeNonce(dir, { teamId: 'default', agentKey: 'b', sid: 'sess_b', now: Date.now() - WAKE_INFLIGHT_MS - 1 });
    expect(isWakeNonceFresh(nonce)).toBe(false);
    expect(await consumeWakeNonce(dir, token, { teamId: 'default', agentKey: 'b', sid: 'sess_b' })).toBeUndefined();
    expect(await findInflightWakeNonce(dir, 'b')).toBeUndefined();
  });

  it('findInflightWakeNonce matches by agent and skips used/expired/other-agent nonces', async () => {
    const { writeWakeNonce } = await import('./registry.js');
    // Other agent: must not match.
    await createWakeNonce(dir, { teamId: 'default', agentKey: 'a', sid: 'sess_a' });
    // Fresh 'b' nonce: the expected in-flight hit.
    const { token: freshToken } = await createWakeNonce(dir, { teamId: 'default', agentKey: 'b', sid: 'sess_b' });
    // Used 'b' nonce: skipped.
    const { token: usedToken } = await createWakeNonce(dir, { teamId: 'default', agentKey: 'b', sid: 'sess_used' });
    const used = await readWakeNonce(dir, usedToken);
    await writeWakeNonce(dir, usedToken, { ...used!, used: true });
    // Expired 'b' nonce: skipped.
    await createWakeNonce(dir, { teamId: 'default', agentKey: 'b', sid: 'sess_old', now: Date.now() - WAKE_INFLIGHT_MS - 1 });
    const inflight = await findInflightWakeNonce(dir, 'b');
    expect(inflight).toBeDefined();
    expect(inflight!.token).toBe(freshToken);
    expect(inflight!.nonce.sid).toBe('sess_b');
    expect(inflight!.nonce.used).toBeFalsy();
    expect(await findInflightWakeNonce(dir, 'nobody')).toBeUndefined();
    expect(existsSync(join(dir, 'registry', 'wake'))).toBe(true);
  });
});
