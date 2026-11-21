/**
 * v0.9.5（A6/V094-04/V094-03）：票据**两面判据统一**与**回滚原语**定向测试
 * （41-v095 方案 §一 组A A6）。
 *
 * V094-04：钩子面 consumeWakeTicketForSession 要求 `sid ∧ (issuedToSid ?? sid)` 双双
 * 指向本会话，MCP 面 consumeWakeNonce 只校验 teamId/agentKey/sid 不读 issuedToSid——
 * 手置 `{agentKey:member-a, sid:sess-rogue, issuedToSid:sess-victim}` 的 nonce 两个钩子
 * 都拒、MCP 面放行 rogue 消费。修法：MCP 面补同款 issuedToSid 判据（两面一致）。
 * V094-03：钩子绑定失败回滚票据（restoreWakeNonce）——回滚后 MCP 面可消费（兜底可用），
 * TTL 不因回滚重置（过期票回滚后仍拒）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeWakeNonce,
  createWakeNonce,
  readWakeNonce,
  restoreWakeNonce,
  writeWakeNonce,
  WAKE_INFLIGHT_MS,
} from './registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-registry-v095a6-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v0.9.5 A6：consumeWakeNonce（MCP 面）与钩子面判据统一', () => {
  it('【锚点】issuedToSid 指向别的会话 → MCP 面拒（与钩子面同判据，V094-04 两张面孔收口）', async () => {
    // V094-05 修复后的生产形状：attemptWake 签发点恒填 issuedToSid/name。
    const { token } = await createWakeNonce(dir, {
      teamId: 'default', agentKey: 'member-a', sid: 'sess-victim', issuedToSid: 'sess-victim', name: 'member-a',
    });
    // rogue 以「member-a 的花名 + 自己的 sid」出示：agentKey/sid 判据里 sid 不匹配先行拒——
    // issuedToSid 判据保证即使 sid 伪造为受害者 sid，issuedToSid ≠ 本会话也拒。
    expect(await consumeWakeNonce(dir, token, { teamId: 'default', agentKey: 'member-a', sid: 'sess-rogue' })).toBeUndefined();
    expect((await readWakeNonce(dir, token))?.used).toBeUndefined(); // 票未消耗
  });

  it('手置 issuedToSid 指向第三会话 → 两面都拒（MCP 面补判后与钩子面同形）', async () => {
    // V094-04 的 TC5 形态：nonce 的 sid 与 issuedToSid 不一致（恶意/损坏票据）。
    const { token } = await createWakeNonce(dir, {
      teamId: 'default', agentKey: 'member-a', sid: 'sess-rogue', issuedToSid: 'sess-victim', name: 'member-a',
    });
    // sid 匹配 rogue（字段全对得上）但 issuedToSid ≠ rogue → 拒（旧 MCP 面放行）。
    expect(await consumeWakeNonce(dir, token, { teamId: 'default', agentKey: 'member-a', sid: 'sess-rogue' })).toBeUndefined();
    expect((await readWakeNonce(dir, token))?.used).toBeUndefined();
  });

  it('issuedToSid === sid 的合法票照常消费；旧 nonce（缺 issuedToSid）按 sid 兜底兼容', async () => {
    const fresh = await createWakeNonce(dir, {
      teamId: 'default', agentKey: 'b', sid: 'sess_b', issuedToSid: 'sess_b', name: 'b',
    });
    const consumed = await consumeWakeNonce(dir, fresh.token, { teamId: 'default', agentKey: 'b', sid: 'sess_b' });
    expect(consumed?.used).toBe(true);
    expect(consumed?.issuedToSid).toBe('sess_b');
    expect(consumed?.name).toBe('b');

    const legacy = await createWakeNonce(dir, { teamId: 'default', agentKey: 'c', sid: 'sess_c' });
    const legacyConsumed = await consumeWakeNonce(dir, legacy.token, { teamId: 'default', agentKey: 'c', sid: 'sess_c' });
    expect(legacyConsumed?.used).toBe(true); // 兼容 v0.9.3 及以前签发（sid 兜底）
  });
});

describe('v0.9.5 A6：restoreWakeNonce（钩子绑定失败的票据回滚，保 wakeToken 兜底可用）', () => {
  it('【锚点】used 票回滚 → 未用；回滚后 MCP 面可正常消费（V094-03 兜底不断裂）', async () => {
    const { token, nonce } = await createWakeNonce(dir, {
      teamId: 'default', agentKey: 'b', sid: 'sess_b', issuedToSid: 'sess_b', name: 'b',
    });
    const consumed = await consumeWakeNonce(dir, token, { teamId: 'default', agentKey: 'b', sid: 'sess_b' });
    expect(consumed).toBeDefined(); // 钩子面消费成功（used=true）
    expect((await readWakeNonce(dir, token))?.used).toBe(true);

    // 绑定失败 → 回滚
    await restoreWakeNonce(dir, { token, nonce: consumed! });
    const restored = await readWakeNonce(dir, token);
    expect(restored?.used).toBeUndefined(); // 恢复未用形态
    expect(restored?.teamId).toBe('default'); // 签发字段原样保留
    expect(restored?.issuedToSid).toBe('sess_b');
    expect(restored?.name).toBe('b');

    // 兜底路径：模型回合用同一 token 走 MCP 面 xc_identify 的消费原语 → 成功
    const reConsumed = await consumeWakeNonce(dir, token, { teamId: 'default', agentKey: 'b', sid: 'sess_b' });
    expect(reConsumed?.used).toBe(true);
  });

  it('回滚不重置 TTL：过期票回滚后仍拒（一次性语义不放松）', async () => {
    const staleTs = Date.now() - WAKE_INFLIGHT_MS - 1;
    const { token } = await createWakeNonce(dir, {
      teamId: 'default', agentKey: 'b', sid: 'sess_b', now: staleTs, issuedToSid: 'sess_b', name: 'b',
    });
    // 直接把过期票手工置 used（模拟「钩子消费时已临期」形态）
    const stored = (await readWakeNonce(dir, token))!;
    await writeWakeNonce(dir, token, { ...stored, used: true });
    await restoreWakeNonce(dir, { token, nonce: { ...stored, used: true } });
    expect((await readWakeNonce(dir, token))?.used).toBeUndefined();
    // TTL 判据按 ts：回滚不续命 → 消费仍拒
    expect(await consumeWakeNonce(dir, token, { teamId: 'default', agentKey: 'b', sid: 'sess_b' })).toBeUndefined();
  });
});
