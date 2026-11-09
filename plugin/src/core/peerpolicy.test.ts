/**
 * W4 单测：core/peerpolicy.ts —— 跨会话入站三态（accept/hold/refuse）。
 *
 * 覆盖矩阵（DESIGN-V0.3 §9.3 硬验收 3 + §6.1/§6.2 的算法）：
 * 1. 层取值分类（未设 / 合法 / 非法，含未展开模板串）；
 * 2. 显式三态 → 裁决（accept / hold(cause) / refuse(opt-out)）+ kill-switch；
 * 3. 最严胜（三个显式层取 f 最大者；非法 → fail-closed hold）；
 * 4. 自动档 mode-parity：3 态 × 2 档类 × 发方是否断言（含 selfSent 放行、
 *    mode-unknown / mode-mismatch / no-mode-asserted 三个 cause）；
 * 5. 会话级查询面（CC `H()` 的 bypass-default，与消息路径不同）；
 * 6. 层解析（项目文件 sessions 优先于 mode、最严胜、审计、kill-switch）；
 * 7. hold 缓冲（落位、同 cause 只播一次、cause 变化再播、容量逐出、TTL 过期、
 *    释放路径的三种裁决、丢弃与会话结束清扫）；
 * 8. 收方档类读取（基记录 / modeClass 兜底 / 未知）与路径约定。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HOLD_TTL_MS,
  HOLD_CAPACITY,
  classifyLayerValue,
  decideAutoMode,
  decideInboundPolicy,
  decideSessionInboundPolicy,
  discardAllHeldMessages,
  discardHeldMessages,
  expireHeldMessages,
  holdPeerMessage,
  holdTtlMsFromEnv,
  isKillSwitchOn,
  listHeldPeerMessages,
  peerAuditLogFile,
  peerBaseRecordFile,
  peerHeldDir,
  peerHeldFile,
  peerInboundSettingsFile,
  readPeerInboundPolicy,
  readReceiverModeClass,
  releaseHeldMessages,
  resolveInboundDecision,
  type PeerHeldItem,
} from './peerpolicy.js';

let ws: string;
let root: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'xc-peer-ws-'));
  root = mkdtempSync(join(tmpdir(), 'xc-peer-root-'));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function item(msgId: string, from = 'alice'): PeerHeldItem {
  return { msgId, from, text: `hello ${msgId}`, ts: 1000, via: 'pipe', hopChain: [] };
}

function writeRepoSettings(value: unknown): void {
  const file = peerInboundSettingsFile(ws);
  mkdirSync(join(ws, '.crosschat', 'peer'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function engineLog(): string {
  try {
    return readFileSync(join(ws, '.crosschat', 'logs', 'engine.jsonl'), 'utf8');
  } catch {
    return '';
  }
}

function peerLog(): string {
  try {
    return readFileSync(peerAuditLogFile(root), 'utf8');
  } catch {
    return '';
  }
}

describe('classifyLayerValue（未设 / 合法 / 非法）', () => {
  it('未设：undefined、空串、纯空白、"unset"、未展开的 ${user_config.*} 模板串', () => {
    expect(classifyLayerValue(undefined).state).toBe('unset');
    expect(classifyLayerValue('').state).toBe('unset');
    expect(classifyLayerValue('   ').state).toBe('unset');
    expect(classifyLayerValue('unset').state).toBe('unset');
    const template = classifyLayerValue('${user_config.cross_session_inbound}');
    expect(template.state).toBe('unset');
    expect(template.reason).toBe('unexpanded-template');
  });

  it('合法：accept/hold/refuse（大小写不敏感）；其余 → 非法', () => {
    expect(classifyLayerValue('accept')).toEqual({ state: 'valid', mode: 'accept' });
    expect(classifyLayerValue('hold')).toEqual({ state: 'valid', mode: 'hold' });
    expect(classifyLayerValue('refuse')).toEqual({ state: 'valid', mode: 'refuse' });
    expect(classifyLayerValue('ACCEPT')).toEqual({ state: 'valid', mode: 'accept' });
    const bad = classifyLayerValue('maybe');
    expect(bad.state).toBe('invalid');
    expect(bad.mode).toBeUndefined();
  });
});

describe('decideInboundPolicy · 显式三态与 kill-switch', () => {
  it('accept → accept；hold → hold(cause=归因)；refuse → refuse(opt-out)', () => {
    expect(decideInboundPolicy({ explicit: 'accept' })).toEqual({ policy: 'accept' });
    expect(decideInboundPolicy({ explicit: 'hold' })).toEqual({ policy: 'hold', cause: 'explicit-setting' });
    expect(decideInboundPolicy({ explicit: 'hold', explicitSource: 'repo-setting' })).toEqual({
      policy: 'hold',
      cause: 'repo-setting',
    });
    expect(decideInboundPolicy({ explicit: 'refuse' })).toEqual({ policy: 'refuse', cause: 'opt-out' });
  });

  it('kill-switch 压过一切设置与自动档（CC `_()`）', () => {
    expect(decideInboundPolicy({ managedOff: true })).toEqual({ policy: 'refuse', cause: 'kill-switch' });
    expect(decideInboundPolicy({ managedOff: true, explicit: 'accept' })).toEqual({
      policy: 'refuse',
      cause: 'kill-switch',
    });
    expect(decideInboundPolicy({ managedOff: true, explicit: 'hold', recvClass: 'bypass' })).toEqual({
      policy: 'refuse',
      cause: 'kill-switch',
    });
  });

  it('isKillSwitchOn：只有 off 命中；空串/其他值不算', () => {
    expect(isKillSwitchOn({ XC_PEER_RECEIVE: 'off' })).toBe(true);
    expect(isKillSwitchOn({ XC_PEER_RECEIVE: 'OFF' })).toBe(true);
    expect(isKillSwitchOn({ XC_PEER_RECEIVE: 'on' })).toBe(false);
    expect(isKillSwitchOn({ XC_PEER_RECEIVE: '' })).toBe(false);
    expect(isKillSwitchOn({})).toBe(false);
  });
});

describe('decideInboundPolicy · 最严胜（DESIGN §6.1 第 3 步）', () => {
  it('用户层 hold + 会话层 accept → hold（项目层不能放松用户层）', () => {
    expect(decideInboundPolicy({ explicit: 'accept', env: 'hold' })).toEqual({
      policy: 'hold',
      cause: 'explicit-setting',
    });
  });

  it('会话层 refuse 压过用户层 hold → refuse(opt-out)', () => {
    expect(decideInboundPolicy({ explicit: 'hold', env: 'refuse' })).toEqual({
      policy: 'refuse',
      cause: 'opt-out',
    });
  });

  it('非法枚举 → fail-closed 到 hold(invalid-setting)', () => {
    expect(decideInboundPolicy({ env: 'maybe' })).toEqual({ policy: 'hold', cause: 'invalid-setting' });
  });

  it('会话层未设（空串/unset）→ 不参与最严胜', () => {
    expect(decideInboundPolicy({ explicit: 'accept', env: '' })).toEqual({ policy: 'accept' });
    expect(decideInboundPolicy({ explicit: 'accept', env: 'unset' })).toEqual({ policy: 'accept' });
  });

  it('托管层只允许收紧：refuse/hold 生效，accept 视为非法（fail-closed）', () => {
    expect(decideInboundPolicy({ managed: 'refuse' })).toEqual({ policy: 'refuse', cause: 'opt-out' });
    expect(decideInboundPolicy({ managed: 'hold' })).toEqual({ policy: 'hold', cause: 'managed-setting' });
    expect(decideInboundPolicy({ managed: 'accept' })).toEqual({ policy: 'hold', cause: 'invalid-setting' });
  });
});

describe('decideInboundPolicy · 自动档 mode-parity（CC k() 的 3×2 矩阵）', () => {
  it('自发消息放行（CC k()② —— 是放行不是丢弃）', () => {
    expect(decideInboundPolicy({ selfSent: true })).toEqual({ policy: 'accept' });
    expect(decideInboundPolicy({ selfSent: true, recvClass: undefined })).toEqual({ policy: 'accept' });
  });

  it('收方档类未知 → hold(mode-unknown)（fail-closed）', () => {
    expect(decideInboundPolicy({})).toEqual({ policy: 'hold', cause: 'mode-unknown' });
    expect(decideInboundPolicy({ recvClass: undefined, senderClass: 'bypass' })).toEqual({
      policy: 'hold',
      cause: 'mode-unknown',
    });
  });

  it('发方断言档类：同档 accept / 异档 hold(mode-mismatch)', () => {
    expect(decideInboundPolicy({ recvClass: 'bypass', senderClass: 'bypass' })).toEqual({ policy: 'accept' });
    expect(decideInboundPolicy({ recvClass: 'prompting', senderClass: 'prompting' })).toEqual({
      policy: 'accept',
    });
    expect(decideInboundPolicy({ recvClass: 'bypass', senderClass: 'prompting' })).toEqual({
      policy: 'hold',
      cause: 'mode-mismatch',
    });
    expect(decideInboundPolicy({ recvClass: 'prompting', senderClass: 'bypass' })).toEqual({
      policy: 'hold',
      cause: 'mode-mismatch',
    });
  });

  it('发方未断言档类：收方 bypass → hold(no-mode-asserted)；收方 prompting → accept', () => {
    expect(decideInboundPolicy({ recvClass: 'bypass' })).toEqual({
      policy: 'hold',
      cause: 'no-mode-asserted',
    });
    expect(decideInboundPolicy({ recvClass: 'prompting' })).toEqual({ policy: 'accept' });
  });

  it('trustSenderClass=false → 退化为 CC 的门关闭分支（不采信发方档类）', () => {
    expect(
      decideInboundPolicy({ recvClass: 'bypass', senderClass: 'bypass', trustSenderClass: false }),
    ).toEqual({ policy: 'hold', cause: 'no-mode-asserted' });
    expect(
      decideInboundPolicy({ recvClass: 'prompting', senderClass: 'bypass', trustSenderClass: false }),
    ).toEqual({ policy: 'accept' });
  });

  it('发方断言了不可识别的档类 → hold(mode-unknown)（SPEC R-19）', () => {
    expect(decideInboundPolicy({ recvClass: 'prompting', senderClass: 'weird' })).toEqual({
      policy: 'hold',
      cause: 'mode-unknown',
    });
  });

  it('decideAutoMode 是同一条路径的独立入口', () => {
    expect(decideAutoMode({ recvClass: 'bypass', senderClass: 'bypass' })).toEqual({ policy: 'accept' });
  });
});

describe('decideSessionInboundPolicy（CC H() 的会话级查询面，DV-2）', () => {
  it('显式值优先；收方 bypass 且无显式设置 → hold(bypass-default)', () => {
    expect(decideSessionInboundPolicy({ explicit: 'hold', explicitSource: 'repo-setting' })).toEqual({
      policy: 'hold',
      cause: 'repo-setting',
    });
    expect(decideSessionInboundPolicy({ recvClass: 'bypass' })).toEqual({
      policy: 'hold',
      cause: 'bypass-default',
    });
    expect(decideSessionInboundPolicy({ recvClass: 'prompting' })).toEqual({ policy: 'accept' });
    expect(decideSessionInboundPolicy({ managedOff: true })).toEqual({
      policy: 'refuse',
      cause: 'kill-switch',
    });
  });

  it('与消息路径的差异：发方断言同档时，消息路径 accept、查询面仍 bypass-default', () => {
    expect(decideInboundPolicy({ recvClass: 'bypass', senderClass: 'bypass' })).toEqual({ policy: 'accept' });
    expect(decideSessionInboundPolicy({ recvClass: 'bypass' })).toEqual({
      policy: 'hold',
      cause: 'bypass-default',
    });
  });
});

describe('readPeerInboundPolicy · 四层解析与最严胜', () => {
  it('三层全未设 → 自动档（decidedBy=mode-parity，无显式取值）', async () => {
    const resolution = await readPeerInboundPolicy(ws, 'sess-1', {});
    expect(resolution.auto).toBe(true);
    expect(resolution.decidedBy).toBe('mode-parity');
    expect(resolution.explicit).toBeUndefined();
    expect(resolution.mode).toBe('accept');
    expect(resolution.killSwitch).toBe(false);
    expect(resolution.layers).toEqual({});
  });

  it('用户层（env 注入的 userConfig）→ explicit-setting', async () => {
    const resolution = await readPeerInboundPolicy(ws, 'sess-1', { XC_CROSSCHAT_INBOUND: 'hold' });
    expect(resolution.explicit).toBe('hold');
    expect(resolution.decidedBy).toBe('explicit-setting');
    expect(resolution.auto).toBe(false);
    expect(resolution.layers.user).toBe('hold');
  });

  it('项目层：sessions[sid] 优先于 mode；归因 repo-setting', async () => {
    writeRepoSettings({ mode: 'accept', sessions: { 'sess-1': 'hold' } });
    const scoped = await readPeerInboundPolicy(ws, 'sess-1', {});
    expect(scoped.explicit).toBe('hold');
    expect(scoped.decidedBy).toBe('repo-setting');

    const other = await readPeerInboundPolicy(ws, 'sess-2', {});
    expect(other.explicit).toBe('accept');
    expect(other.decidedBy).toBe('repo-setting');
  });

  it('最严胜：项目层 accept + 用户层 hold → hold（不放松）', async () => {
    writeRepoSettings({ mode: 'accept' });
    const resolution = await readPeerInboundPolicy(ws, 'sess-1', { XC_CROSSCHAT_INBOUND: 'hold' });
    expect(resolution.explicit).toBe('hold');
    expect(resolution.decidedBy).toBe('explicit-setting');
  });

  it('非法枚举 → fail-closed 到 hold + decidedBy=invalid-setting + 审计', async () => {
    const resolution = await readPeerInboundPolicy(ws, 'sess-1', { XC_CROSSCHAT_INBOUND: 'maybe' });
    expect(resolution.explicit).toBe('hold');
    expect(resolution.decidedBy).toBe('invalid-setting');
    expect(resolution.invalid).toBe(true);
    expect(engineLog()).toContain('peer-policy-invalid');
  });

  it('未展开的 ${user_config.*} 模板串 → 视为未设 + 审计 peer-policy-unset-expansion', async () => {
    const resolution = await readPeerInboundPolicy(ws, 'sess-1', {
      XC_CROSSCHAT_INBOUND: '${user_config.cross_session_inbound}',
    });
    expect(resolution.auto).toBe(true);
    expect(resolution.decidedBy).toBe('mode-parity');
    expect(resolution.audits).toContain('peer-policy-unset-expansion');
    expect(engineLog()).toContain('peer-policy-unset-expansion');
  });

  it('kill-switch：XC_PEER_RECEIVE=off → 压过一切（mode=refuse，killSwitch=true）', async () => {
    const resolution = await readPeerInboundPolicy(ws, 'sess-1', {
      XC_PEER_RECEIVE: 'off',
      XC_CROSSCHAT_INBOUND: 'accept',
    });
    expect(resolution.killSwitch).toBe(true);
    expect(resolution.mode).toBe('refuse');
    expect(resolution.strictest).toBe('accept');
  });

  it('项目层文件损坏 → 该层按非法计入（fail-closed 到 hold）+ 审计', async () => {
    writeRepoSettings('{broken');
    const resolution = await readPeerInboundPolicy(ws, 'sess-1', { XC_CROSSCHAT_INBOUND: 'hold' });
    // 损坏的项目层 → 非法取值 → fail-closed 到 hold，归因 invalid-setting
    expect(resolution.explicit).toBe('hold');
    expect(resolution.decidedBy).toBe('invalid-setting');
    expect(resolution.invalid).toBe(true);
    expect(engineLog()).toContain('peer-policy-invalid');
  });

  it('项目层文件不存在 → 该层未设（不是非法）', async () => {
    const resolution = await readPeerInboundPolicy(ws, 'sess-1', {});
    expect(resolution.invalid).toBe(false);
    expect(resolution.auto).toBe(true);
  });

  it('resolveInboundDecision：层解析 + 裁决一步到位', async () => {
    const { decision, resolution } = await resolveInboundDecision({
      workspace: ws,
      sessionId: 'sess-1',
      env: {},
      recvClass: 'bypass',
      senderClass: 'bypass',
    });
    expect(resolution.auto).toBe(true);
    expect(decision).toEqual({ policy: 'accept' });

    const refused = await resolveInboundDecision({
      workspace: ws,
      sessionId: 'sess-1',
      env: { XC_PEER_RECEIVE: 'off' },
    });
    expect(refused.decision).toEqual({ policy: 'refuse', cause: 'kill-switch' });
  });
});

describe('hold 缓冲（暂存、播报、容量、终态）', () => {
  it('暂存落位 held/<sid>/<msgId>.json + peer_message_hold{state:held}', async () => {
    const result = await holdPeerMessage(root, 'sess-1', item('m1'), 'repo-setting');
    expect(result.announced).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toBe(join(root, 'held', 'sess-1', 'm1.json'));

    const held = await listHeldPeerMessages(root, 'sess-1');
    expect(held).toHaveLength(1);
    expect(held[0]!.cause).toBe('repo-setting');
    expect(held[0]!.item.text).toBe('hello m1');

    const log = peerLog();
    expect(log).toContain('peer_message_hold');
    expect(log).toContain('"state":"held"');
    expect(log).toContain('"cause":"repo-setting"');
  });

  it('同一消息同一 cause 只播一次；cause 变化再播（CC @2901183）', async () => {
    await holdPeerMessage(root, 'sess-1', item('m1'), 'repo-setting');
    const again = await holdPeerMessage(root, 'sess-1', item('m1'), 'repo-setting');
    expect(again.announced).toBe(false);
    const changed = await holdPeerMessage(root, 'sess-1', item('m1'), 'mode-mismatch');
    expect(changed.announced).toBe(true);

    const events = peerLog()
      .split('\n')
      .filter((line) => line.includes('peer_message_hold'));
    expect(events).toHaveLength(2);
    const held = await listHeldPeerMessages(root, 'sess-1');
    expect(held[0]!.announcedCauses.sort()).toEqual(['mode-mismatch', 'repo-setting']);
  });

  it('缓冲容量 100（对齐 CC Q=100）；满则逐出最旧者并记 expired', async () => {
    expect(HOLD_CAPACITY).toBe(100);
    const evicted: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await holdPeerMessage(root, 'sess-1', item(`m${i}`), 'repo-setting', {
        now: 1000 + i,
        capacity: 2,
        onEvict: (held) => {
          evicted.push(held.item.msgId);
        },
      });
      if (i === 2) expect(result.evicted?.item.msgId).toBe('m0');
    }
    expect(evicted).toEqual(['m0']);
    const held = await listHeldPeerMessages(root, 'sess-1');
    expect(held.map((h) => h.item.msgId)).toEqual(['m1', 'm2']);
    expect(peerLog()).toContain('"outcome":"expired"');
  });

  it('审批期限到期 → 终态 expired（XC_HOLD_TTL_MS 覆盖默认 12 h）', async () => {
    expect(holdTtlMsFromEnv({})).toBe(DEFAULT_HOLD_TTL_MS);
    expect(holdTtlMsFromEnv({ XC_HOLD_TTL_MS: '1000' })).toBe(1000);
    expect(holdTtlMsFromEnv({ XC_HOLD_TTL_MS: 'not-a-number' })).toBe(DEFAULT_HOLD_TTL_MS);

    await holdPeerMessage(root, 'sess-1', item('m1'), 'repo-setting', { now: 0, ttlMs: 100 });
    const expired = await expireHeldMessages(root, 'sess-1', { now: 200 });
    expect(expired).toHaveLength(1);
    expect(expired[0]!.outcome).toBe('expired');
    expect(expired[0]!.receipt).toBe('expired');
    expect(await listHeldPeerMessages(root, 'sess-1')).toHaveLength(0);
  });

  it('释放路径按当前策略重裁（CC A()）：refuse → refused / hold → 仍暂存 / accept → delivered', async () => {
    await holdPeerMessage(root, 'sess-1', item('m1'), 'repo-setting');
    await holdPeerMessage(root, 'sess-1', item('m2'), 'repo-setting');
    await holdPeerMessage(root, 'sess-1', item('m3'), 'repo-setting');

    const refused = await releaseHeldMessages(root, 'sess-1', ['m1'], {
      adjudicate: () => ({ policy: 'refuse', cause: 'opt-out' }),
    });
    expect(refused[0]).toMatchObject({ outcome: 'refused', receipt: 'refused' });

    const stillHeld = await releaseHeldMessages(root, 'sess-1', ['m2'], {
      adjudicate: () => ({ policy: 'hold', cause: 'repo-setting' }),
    });
    expect(stillHeld[0]).toMatchObject({ outcome: 'still-held' });

    const delivered = await releaseHeldMessages(root, 'sess-1', ['m3'], {
      adjudicate: () => ({ policy: 'accept' }),
      deliver: () => true,
    });
    expect(delivered[0]).toMatchObject({ outcome: 'delivered', receipt: 'delivered' });

    expect((await listHeldPeerMessages(root, 'sess-1')).map((h) => h.item.msgId)).toEqual(['m2']);
    expect(peerLog()).toContain('"state":"released"');
  });

  it('放行但被入队闸弃 → 终态 dropped', async () => {
    await holdPeerMessage(root, 'sess-1', item('m1'), 'repo-setting');
    const dropped = await releaseHeldMessages(root, 'sess-1', ['m1'], {
      adjudicate: () => ({ policy: 'accept' }),
      deliver: () => ({ ok: false, reason: 'rate limit' }),
    });
    expect(dropped[0]).toMatchObject({ outcome: 'dropped', receipt: 'dropped', detail: 'rate limit' });
    expect(await listHeldPeerMessages(root, 'sess-1')).toHaveLength(0);
  });

  it('不给 adjudicate → 保持暂存（fail-closed，不放行）', async () => {
    await holdPeerMessage(root, 'sess-1', item('m1'), 'repo-setting');
    const results = await releaseHeldMessages(root, 'sess-1', ['m1']);
    expect(results[0]).toMatchObject({ outcome: 'still-held' });
    expect(await listHeldPeerMessages(root, 'sess-1')).toHaveLength(1);
  });

  it('审阅丢弃 → 回执 denied；会话结束清扫 → 终态 discarded 且无回执', async () => {
    await holdPeerMessage(root, 'sess-1', item('m1'), 'repo-setting');
    await holdPeerMessage(root, 'sess-1', item('m2'), 'repo-setting');
    const denied = await discardHeldMessages(root, 'sess-1', ['m1']);
    expect(denied[0]).toMatchObject({ outcome: 'discarded', receipt: 'denied' });

    const discarded = await discardAllHeldMessages(root, 'sess-1');
    expect(discarded[0]).toMatchObject({ outcome: 'discarded' });
    expect(discarded[0]!.receipt).toBeUndefined();
    expect(existsSync(peerHeldDir(root, 'sess-1'))).toBe(false);
  });

  it('坏文件跳过不崩；msgId 不可读时折成摘要文件名', async () => {
    mkdirSync(peerHeldDir(root, 'sess-1'), { recursive: true });
    writeFileSync(join(peerHeldDir(root, 'sess-1'), 'broken.json'), '{not json', 'utf8');
    const result = await holdPeerMessage(root, 'sess-1', item('../evil'), 'repo-setting');
    expect(result.path).toBe(peerHeldFile(root, 'sess-1', '../evil'));
    expect(result.path.startsWith(peerHeldDir(root, 'sess-1'))).toBe(true);
    const held = await listHeldPeerMessages(root, 'sess-1');
    expect(held.map((h) => h.item.msgId)).toEqual(['../evil']);
  });

  it('跨写入方兼容：别的写入方落的简形记录（缺 expiresAt/announcedCauses）能被读出并释放', async () => {
    // W5 的 core/peermsg.ts 也写 held 隔离区，落盘形状是 {item, cause, heldAt}
    // 且文件名用原始 msgId（W1 的 peerHeldFile）。本文件必须能读它、删它。
    const dir = peerHeldDir(root, 'sess-1');
    mkdirSync(dir, { recursive: true });
    const foreign = join(dir, 'm-foreign.json');
    writeFileSync(
      foreign,
      JSON.stringify({ item: { msgId: 'm-foreign', from: 'bob', text: 'hi', ts: 5 }, cause: 'repo-setting', heldAt: 5 }),
      'utf8',
    );

    const held = await listHeldPeerMessages(root, 'sess-1');
    expect(held).toHaveLength(1);
    expect(held[0]!.cause).toBe('repo-setting');
    expect(held[0]!.announcedCauses).toEqual(['repo-setting']);
    // 缺 expiresAt → 按 heldAt + 默认 TTL 补齐
    expect(held[0]!.expiresAt).toBe(5 + DEFAULT_HOLD_TTL_MS);

    const released = await releaseHeldMessages(root, 'sess-1', ['m-foreign'], {
      adjudicate: () => ({ policy: 'accept' }),
      deliver: () => true,
    });
    expect(released[0]).toMatchObject({ outcome: 'delivered', receipt: 'delivered' });
    // 释放后不留孤儿文件（按实际文件名删）
    expect(existsSync(foreign)).toBe(false);
    expect(await listHeldPeerMessages(root, 'sess-1')).toHaveLength(0);
  });

  it('对已存在的记录再次暂存 → 原地更新，不产生第二份文件', async () => {
    const first = await holdPeerMessage(root, 'sess-1', item('m1'), 'repo-setting');
    const second = await holdPeerMessage(root, 'sess-1', item('m1'), 'mode-mismatch');
    expect(second.path).toBe(first.path);
    expect(await listHeldPeerMessages(root, 'sess-1')).toHaveLength(1);
  });
});

describe('收方档类（基记录 / modeClass 兜底 / 未知）', () => {
  it('基记录 permissionMode → base-record', async () => {
    const file = peerBaseRecordFile(root, 'sess-1');
    mkdirSync(join(root, 'base'), { recursive: true });
    writeFileSync(file, JSON.stringify({ sessionId: 'sess-1', permissionMode: 'bypass' }), 'utf8');
    expect(await readReceiverModeClass(root, 'sess-1')).toEqual({ cls: 'bypass', source: 'base-record' });
  });

  it('缺 permissionMode → modeClass 兜底 + 审计 peer-mode-class-fallback', async () => {
    const file = peerBaseRecordFile(root, 'sess-1');
    mkdirSync(join(root, 'base'), { recursive: true });
    writeFileSync(file, JSON.stringify({ sessionId: 'sess-1', modeClass: 'prompting' }), 'utf8');
    expect(await readReceiverModeClass(root, 'sess-1')).toEqual({
      cls: 'prompting',
      source: 'mode-class-fallback',
    });
    expect(peerLog()).toContain('peer-mode-class-fallback');
  });

  it('都没有 → none（调用方按 mode-unknown fail-closed）', async () => {
    expect(await readReceiverModeClass(root, 'sess-1')).toEqual({ source: 'none' });
  });
});

describe('路径约定（DESIGN §3.1 的 peer 根相对布局）', () => {
  it('held / base / logs / 项目层策略文件', () => {
    expect(peerHeldDir(root, 'sess-1')).toBe(join(root, 'held', 'sess-1'));
    expect(peerHeldFile(root, 'sess-1', 'm1')).toBe(join(root, 'held', 'sess-1', 'm1.json'));
    expect(peerBaseRecordFile(root, 'sess-1')).toBe(join(root, 'base', 'sess-1.json'));
    expect(peerAuditLogFile(root)).toBe(join(root, 'logs', 'peer.jsonl'));
    expect(peerInboundSettingsFile(ws)).toBe(join(ws, '.crosschat', 'peer', 'inbound.json'));
  });
});
