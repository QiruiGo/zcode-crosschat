/**
 * v0.6 C1（M4）单测：xc_relay（DESIGN-V0.6.md §1.2-T6 / §3.1 / §4.2-M4）。
 *
 * 覆盖面：
 * - 队内轴：urgent 落箱（urgent:true 在 JSONL）、interrupt 蕴含 urgent、payload
 *   interrupt 请求/结果块（deferred-next-turn + E1 固定原因）、urgent 不豁免 dedup、
 *   urgent 唤醒透传（attemptWake spy）、普通件无 urgent 字段（v0.5 兼容）；
 * - 入站策略：hold 暂存件保留 urgent；refuse 回写 delivery-refused；
 * - 路由：轴后缀 [team]/[peer]、双轴同名 ambiguous、双轴都未命中 target_not_found、
 *   自发/成对校验/not_a_member；
 * - peer 轴：未注册拒、自发拒（self 行）、文件退化件携带 urgent（管道不可达 →
 *   stale_socket → fallback inbox 行 urgent:true）、管道帧不带 urgent（白名单冻结）；
 * - 迁移垫片：assertNoForwardOf / relayArgsFromLegacyMessage / relayArgsFromLegacyPeerSend
 *   （content→msg、message→msg 映射，未映射旧参 ignored 显式披露）；
 * - splitAxisSuffix 用例。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { payloadOf, type ToolResult } from './protocol.js';
import { identityStore } from './identity.js';
import { writeSession } from '../core/registry.js';
import { newTeamState, writeTeam, readTeam } from '../core/teamstate.js';
import { readMailbox, urgentFirst } from '../core/mailbox.js';
import { localPidDomain, peerInboxFile } from '../core/peerdir.js';
import { writePeerKeyFile, writePeerRecord } from '../core/peerregistry.js';
import { uservoiceWrite } from '../core/uservoice.js';
import {
  assertNoForwardOf,
  createTeamRelayCore,
  relayArgsFromLegacyMessage,
  relayArgsFromLegacyPeerSend,
  splitAxisSuffix,
  xcRelay,
  INTERRUPT_DEFERRED_REASON,
  type RelayArgs,
} from './tools-relay.js';
import { setPeerSessionContext, clearPeerSessionContext } from './peer-drain.js';
import type { WakeRequest } from '../engine/wake.js';

// attemptWake 换成 spy（实现委托真身——XC_WAKE_ENABLED 未设时立即 mailbox 降级，
// 不触 spawn；调用入参用于断言 urgent 透传）。
const attemptWakeSpy = vi.hoisted(() => vi.fn());
vi.mock('../engine/wake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/wake.js')>();
  attemptWakeSpy.mockImplementation(actual.attemptWake);
  return { ...actual, attemptWake: attemptWakeSpy };
});

let workDir: string;
let stateRoot: string;
let peerRoot: string;

beforeEach(() => {
  attemptWakeSpy.mockClear();
  workDir = mkdtempSync(join(tmpdir(), 'xc-relay-'));
  stateRoot = join(workDir, '.crosschat');
  peerRoot = mkdtempSync(join(tmpdir(), 'xc-relay-peers-'));
  clearPeerSessionContext();
});

afterEach(async () => {
  clearPeerSessionContext();
  rmSync(workDir, { recursive: true, force: true });
  rmSync(peerRoot, { recursive: true, force: true });
});

/** 建队：a（发起者，conn-a/sess_a）与 b（收件人）。 */
async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: 'default', founderKey: 'a', now });
  team.members.push(
    { key: 'a', sessionId: 'sess_a', role: 'peer', joinedAt: now, lastSeen: now },
    { key: 'b', sessionId: 'sess_b', role: 'worker', joinedAt: now, lastSeen: now },
  );
  await writeTeam(stateRoot, team);
}

function bindIdentity(conn = 'conn-a'): void {
  identityStore.bind(conn, {
    sessionKey: 'xc:default:a',
    teamId: 'default',
    name: 'a',
    agentKey: 'a',
    sessionId: 'sess_a',
    role: 'peer',
    boundAt: Date.now(),
  });
}

function relayDeps(env: Record<string, string> = {}) {
  return { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot, ...env } };
}

function core(env: Record<string, string> = {}) {
  return createTeamRelayCore(relayDeps(env));
}

function payloadOf_(r: ToolResult): Record<string, unknown> {
  return payloadOf(r) as Record<string, unknown>;
}

// ─────────────────────────── 队内轴 ───────────────────────────

describe('xc_relay 队内轴（urgent/interrupt）', () => {
  it('urgent=true：邮箱消息盖 urgent:true；payload urgent:true；attemptWake 收到 urgent:true（透传）', async () => {
    await seedTeam();
    bindIdentity();
    const result = await core().xc_message({ to: 'b', msg: '紧急：先看这条', urgent: true }, 'conn-a');
    const payload = payloadOf_(result);
    expect(payload['urgent']).toBe(true);
    expect(payload['delivered']).toBe('mailbox'); // XC_WAKE_ENABLED 未设 → 邮箱
    const box = await readMailbox(stateRoot, 'default', 'b');
    expect(box).toHaveLength(1);
    expect(box[0]!.urgent).toBe(true);
    expect(box[0]!.content).toBe('紧急：先看这条');
    // 透传断言：attemptWake 入参带 urgent（spy 委托真身，XC_WAKE_ENABLED 未设 → mailbox）。
    expect(attemptWakeSpy).toHaveBeenCalledTimes(1);
    expect((attemptWakeSpy.mock.calls[0]![0] as WakeRequest).urgent).toBe(true);
  });

  it('interrupt=true（urgent 未设）：蕴含 urgent；payload 携带 interrupt 请求/结果块（deferred-next-turn + E1 原因）', async () => {
    await seedTeam();
    bindIdentity();
    const result = await core().xc_message({ to: 'b', msg: '打断请求' }, 'conn-a');
    const plain = payloadOf_(result);
    expect(plain['urgent']).toBeUndefined();
    expect(plain['interrupt']).toBeUndefined();

    const result2 = await core().xc_message({ to: 'b', msg: '打断请求2', interrupt: true }, 'conn-a');
    const payload = payloadOf_(result2);
    expect(payload['urgent']).toBe(true);
    const interrupt = payload['interrupt'] as Record<string, unknown>;
    expect(interrupt['requested']).toBe(true);
    expect(interrupt['result']).toBe('deferred-next-turn');
    expect(interrupt['reason']).toBe(INTERRUPT_DEFERRED_REASON);
    const box = await readMailbox(stateRoot, 'default', 'b');
    expect(box[box.length - 1]!.urgent).toBe(true);
    // 不做任何 stop→send：本条 interrupt 调用只走唤醒路径一次（无第二次 stop/send 副作用调用）。
    expect(attemptWakeSpy).toHaveBeenCalledTimes(2); // 前面普通件 1 次 + 本条 interrupt 1 次
    expect((attemptWakeSpy.mock.calls[1]![0] as WakeRequest).urgent).toBe(true);
  });

  it('urgent 不豁免 dedup：同文重发 → delivered:"duplicate"，不追加、payload 带 duplicate 标记', async () => {
    await seedTeam();
    bindIdentity();
    const first = await core().xc_message({ to: 'b', msg: '同样的话', urgent: true }, 'conn-a');
    expect(payloadOf_(first)['delivered']).toBe('mailbox');
    const second = await core().xc_message({ to: 'b', msg: '同样的话', urgent: true }, 'conn-a');
    const payload = payloadOf_(second);
    expect(payload['delivered']).toBe('duplicate');
    expect(payload['duplicate']).toBe(true);
    const box = await readMailbox(stateRoot, 'default', 'b');
    expect(box).toHaveLength(1);
  });

  it('普通件（无 urgent/interrupt）：消息无 urgent 字段，payload 无 interrupt 块（v0.5 兼容）', async () => {
    await seedTeam();
    bindIdentity();
    const result = await core().xc_message({ to: 'b', msg: '普通消息' }, 'conn-a');
    const payload = payloadOf_(result);
    expect(payload['urgent']).toBeUndefined();
    expect(payload['interrupt']).toBeUndefined();
    const box = await readMailbox(stateRoot, 'default', 'b');
    expect(box[0]!.urgent).toBeUndefined();
    expect(attemptWakeSpy.mock.calls[0]![0] as WakeRequest).toEqual(
      expect.not.objectContaining({ urgent: true }),
    );
  });

  it('入站策略 hold：消息进暂存件且保留 urgent；主邮箱为空', async () => {
    await seedTeam();
    bindIdentity();
    const { writeInboundPolicy } = await import('../core/policy.js');
    await writeInboundPolicy(stateRoot, 'default', 'hold');
    const result = await core().xc_message({ to: 'b', msg: '被暂存', urgent: true }, 'conn-a');
    const payload = payloadOf_(result);
    expect(payload['delivered']).toBe('held');
    expect(payload['urgent']).toBe(true);
    const heldFile = join(stateRoot, 'teams', 'default', 'inbox', 'b.held.jsonl');
    expect(existsSync(heldFile)).toBe(true);
    const held = JSON.parse(readFileSync(heldFile, 'utf8').trim()) as Record<string, unknown>;
    expect(held['urgent']).toBe(true);
    const box = await readMailbox(stateRoot, 'default', 'b');
    expect(box).toHaveLength(0);
  });

  it('入站策略 refuse：不入目标邮箱；发送者收到 delivery-refused 回执；结构化错误 inbound_refused', async () => {
    await seedTeam();
    bindIdentity();
    const { writeInboundPolicy } = await import('../core/policy.js');
    await writeInboundPolicy(stateRoot, 'default', 'refuse');
    const result = await core().xc_message({ to: 'b', msg: '被拒', urgent: true }, 'conn-a');
    expect(result.isError).toBe(true);
    const payload = payloadOf_(result);
    expect(payload['error']).toBe('inbound_refused');
    const box = await readMailbox(stateRoot, 'default', 'a');
    expect(box).toHaveLength(1);
    expect(JSON.parse(box[0]!.content)).toMatchObject({ type: 'delivery-refused', to: 'b' });
  });

  it('origin=user 盖章：urgent 逐字引用用户原话 → origin=user；urgent 与 origin 正交', async () => {
    await seedTeam();
    bindIdentity();
    await writeSession(stateRoot, { sessionId: 'sess_a', cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
    await uservoiceWrite(peerRoot, 'sess_a', '用户亲述原话文本', Date.now());
    const result = await core().xc_message({ to: 'b', msg: '用户亲述原话文本', urgent: true }, 'conn-a');
    const payload = payloadOf_(result);
    expect(payload['urgent']).toBe(true);
    const box = await readMailbox(stateRoot, 'default', 'b');
    expect(box[0]!.origin).toBe('user');
    expect(box[0]!.originSessionId).toBe('sess_a');
    expect(box[0]!.urgent).toBe(true);
  });

  it('硬校验平移：自发拒、source 不成对拒、unknown 成员拒（错误→结构化信封，核心永不抛出）', async () => {
    await seedTeam();
    bindIdentity();
    const selfResult = await core().xc_message({ to: 'a', msg: 'self' }, 'conn-a');
    expect(selfResult.isError).toBe(true);
    expect(payloadOf_(selfResult)['error']).toBe('invalid_params');
    expect(String(payloadOf_(selfResult)['message'])).toContain('cannot message yourself');

    const pairResult = await core().xc_message(
      { to: 'b', msg: 'x', sourceTaskId: 't1' } as RelayArgs,
      'conn-a',
    );
    expect(pairResult.isError).toBe(true);
    expect(String(payloadOf_(pairResult)['message'])).toContain('must be provided together');

    const ghost = await core().xc_message({ to: 'ghost', msg: 'x' }, 'conn-a');
    expect(payloadOf_(ghost)['error']).toBe('not_a_member');
  });
});

// ─────────────────────────── 路由与编排（xcRelay） ───────────────────────────

describe('xc_relay 双轴路由', () => {
  it('[team] 后缀强制队内轴；[peer] 后缀强制 peer 轴（peer 未注册 → not_registered）', async () => {
    await seedTeam();
    bindIdentity();
    // b 是队内成员；带 [peer] 后缀 → 不查队内，直接 peer 轴 → 未注册错误（不是队内投递）。
    const peerResult = await xcRelay(relayDeps(), core(), { to: 'b[peer]', msg: 'x' }, 'conn-a', false);
    const peerPayload = payloadOf_(peerResult);
    expect(peerPayload['error']).toBe('not_registered');
    // 队内邮箱为空（未走队内）。
    expect(await readMailbox(stateRoot, 'default', 'b')).toHaveLength(0);

    // [team] 后缀 → 队内投递。
    const teamResult = await xcRelay(relayDeps(), core(), { to: 'b[team]', msg: '队内' }, 'conn-a', false);
    expect(payloadOf_(teamResult)['axis']).toBeUndefined(); // 队内核心 payload 无 axis（透传 xc_message）
    expect(await readMailbox(stateRoot, 'default', 'b')).toHaveLength(1);
  });

  it('双轴都未命中 → target_not_found（含两轴说明）', async () => {
    await seedTeam();
    bindIdentity();
    const result = await xcRelay(relayDeps(), core(), { to: 'nobody', msg: 'x' }, 'conn-a', false);
    const payload = payloadOf_(result);
    expect(payload['error']).toBe('target_not_found');
  });

  it('编排层 removed 硬拒：成员被移除后 relay → member_removed', async () => {
    await seedTeam();
    bindIdentity();
    const team = (await readTeam(stateRoot, 'default'))!;
    const me = team.members.find((m) => m.key === 'a')!;
    me.state = 'removed';
    await writeTeam(stateRoot, team);
    const result = await xcRelay(relayDeps(), core(), { to: 'b', msg: 'x' }, 'conn-a', false);
    expect(payloadOf_(result)['error']).toBe('member_removed');
  });
});

// ─────────────────────────── peer 轴 ───────────────────────────

function peerRecordFixture(pid: number, sessionId: string, name: string) {
  return {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\xc-relay-test-${pid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: 'interactive' as const,
    name,
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  };
}

describe('xc_relay peer 轴', () => {
  it('未注册 peer 轴 → not_registered（指向 xc_identify）', async () => {
    await seedTeam();
    bindIdentity();
    const result = await xcRelay(relayDeps(), core(), { to: 'p1[peer]', msg: 'x' }, 'conn-a', false);
    const payload = payloadOf_(result);
    expect(payload['error']).toBe('not_registered');
    expect(String(payload['message'])).toContain('xc_identify');
  });

  it('自发禁止：目标行是本会话（sessionId 相同）→ cannot_send_self', async () => {
    await seedTeam();
    bindIdentity();
    setPeerSessionContext({ sessionId: 'sess_a', name: 'selfp', pid: process.pid, root: peerRoot });
    await writePeerRecord(peerRoot, peerRecordFixture(process.pid, 'sess_a', 'selfp'));
    const result = await xcRelay(relayDeps(), core(), { to: 'selfp[peer]', msg: 'x' }, 'conn-a', false);
    const payload = payloadOf_(result);
    expect(payload['error']).toBe('cannot_send_self');
  });

  it('管道不可达（无监听端点）→ 文件退化：fallback inbox 行携带 urgent:true；payload urgent+via=file；管道帧本身不带 urgent', async () => {
    await seedTeam();
    bindIdentity();
    // 真实存活的外部进程（非本进程）：pid 活、端点无监听 → ENOENT → stale_socket → fallback。
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: false });
    const pid = child.pid!; // spawn 同步失败才为 undefined；此处进程已存活
    try {
      const targetSession = 'sess_peer_target';
      setPeerSessionContext({ sessionId: 'sess_a', name: 'alice', pid: process.pid, root: peerRoot });
      // 自记录（alice）与目标记录（bob）都落盘；key 文件发布目标令牌。
      await writePeerRecord(peerRoot, peerRecordFixture(process.pid, 'sess_a', 'alice'));
      await writePeerRecord(peerRoot, peerRecordFixture(pid, targetSession, 'bob'));
      await writePeerKeyFile(peerRoot, pid, `\\\\.\\pipe\\xc-relay-test-${pid}`, {
        peerToken: 'a'.repeat(32),
        pidDomain: localPidDomain(),
      });
      const result = await xcRelay(
        relayDeps(),
        core(),
        { to: 'bob[peer]', msg: '紧急介入', urgent: true },
        'conn-a',
        false,
      );
      const payload = payloadOf_(result);
      expect(payload['urgent']).toBe(true);
      expect(payload['via']).toBe('file');
      expect(payload['receipt']).toBe('delivered');
      expect(payload['axis']).toBe('peer');
      // 退化 inbox 行携带 urgent（M3 排空面据此插队）。
      const inboxFile = peerInboxFile(peerRoot, targetSession);
      expect(existsSync(inboxFile)).toBe(true);
      const line = JSON.parse(readFileSync(inboxFile, 'utf8').trim()) as Record<string, unknown>;
      expect(line['urgent']).toBe(true);
      expect(line['from']).toBe('alice');
    } finally {
      child.kill();
    }
  }, 20000);

  it('pipe 失败路径无 urgent 时：fallback 行不带 urgent 字段', async () => {
    await seedTeam();
    bindIdentity();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: false });
    const pid = child.pid!; // spawn 同步失败才为 undefined；此处进程已存活
    try {
      const targetSession = 'sess_peer_target2';
      setPeerSessionContext({ sessionId: 'sess_a', name: 'alice', pid: process.pid, root: peerRoot });
      await writePeerRecord(peerRoot, peerRecordFixture(process.pid, 'sess_a', 'alice'));
      await writePeerRecord(peerRoot, peerRecordFixture(pid, targetSession, 'bob'));
      await writePeerKeyFile(peerRoot, pid, `\\\\.\\pipe\\xc-relay-test-${pid}`, {
        peerToken: 'b'.repeat(32),
        pidDomain: localPidDomain(),
      });
      const result = await xcRelay(relayDeps(), core(), { to: 'bob[peer]', msg: '普通' }, 'conn-a', false);
      const payload = payloadOf_(result);
      expect(payload['via']).toBe('file');
      const line = JSON.parse(readFileSync(peerInboxFile(peerRoot, targetSession), 'utf8').trim()) as Record<string, unknown>;
      expect(line['urgent']).toBeUndefined();
    } finally {
      child.kill();
    }
  }, 20000);
});

// ─────────────────────────── 迁移垫片 ───────────────────────────

describe('迁移垫片（xc_message / xc_peer_send → xc_relay）', () => {
  it('relayArgsFromLegacyMessage：content→msg；未映射旧参 ignored 显式披露', () => {
    const mapped = relayArgsFromLegacyMessage({ to: 'b', content: '正文', sourceTaskId: 't1', sourceAttemptId: 'at1' });
    expect(mapped.args).toEqual({ to: 'b', msg: '正文', sourceTaskId: 't1', sourceAttemptId: 'at1' });
    expect(mapped.ignored).toEqual([]);
    const withExtra = relayArgsFromLegacyMessage({ to: 'b', content: 'x', regToken: 'tok', mysterious: 1 });
    expect(withExtra.ignored).toEqual(['regToken', 'mysterious']);
  });

  it('relayArgsFromLegacyPeerSend：message→msg；summary 透传', () => {
    const mapped = relayArgsFromLegacyPeerSend({ to: 'p', message: '正文', summary: '摘要' });
    expect(mapped.args).toEqual({ to: 'p', msg: '正文', summary: '摘要' });
    expect(mapped.ignored).toEqual([]);
  });

  it('forwardOf：两个垫片都显式拒绝（forwardOf_removed），不静默丢参', () => {
    expect(() => assertNoForwardOf({ forwardOf: 'm1' })).toThrow(/forwardOf_removed/);
    expect(() => relayArgsFromLegacyMessage({ to: 'b', forwardOf: 'm1' })).toThrow(/forwardOf_removed/);
    expect(() => relayArgsFromLegacyPeerSend({ to: 'p', forwardOf: 'm1' })).toThrow(/forwardOf_removed/);
  });

  it('splitAxisSuffix：[team]/[peer] 大小写不敏感、仅串尾；无后缀原样', () => {
    expect(splitAxisSuffix('b[team]')).toEqual({ target: 'b', axis: 'team' });
    expect(splitAxisSuffix('bob [PEER]')).toEqual({ target: 'bob', axis: 'peer' });
    expect(splitAxisSuffix('  plain  ')).toEqual({ target: 'plain', axis: undefined });
    expect(splitAxisSuffix('a[b]x[team]')).toEqual({ target: 'a[b]x', axis: 'team' });
    expect(splitAxisSuffix('weird [ref] name')).toEqual({ target: 'weird [ref] name', axis: undefined });
  });
});

// ─────────────────────────── 回归：urgent 与邮箱消费面联动 ───────────────────────────

describe('C1 联动回归：relay urgent → 消费面插队（端到端时序）', () => {
  it('普通件先落箱，urgent 后到：readCurrentMailboxLocked（xc_check_inbox 消费序）urgent 先出', async () => {
    await seedTeam();
    bindIdentity();
    await core().xc_message({ to: 'b', msg: '先发的普通件' }, 'conn-a');
    await core().xc_message({ to: 'b', msg: '后发的紧急件', urgent: true }, 'conn-a');
    // 物理序：普通在前、urgent 在后。
    const raw = readFileSync(join(stateRoot, 'teams', 'default', 'inbox', 'b.jsonl'), 'utf8');
    expect(raw.indexOf('先发的普通件')).toBeLessThan(raw.indexOf('后发的紧急件'));
    // 消费序：urgent 插队第一。
    const team = (await readTeam(stateRoot, 'default'))!;
    const { readCurrentMailboxLocked } = await import('../core/mailbox.js');
    const current = await readCurrentMailboxLocked(stateRoot, team, 'b');
    expect(current.map((m) => m.content)).toEqual(['后发的紧急件', '先发的普通件']);
    // 原语直证（urgentFirst）。
    expect(urgentFirst(current).map((m) => m.urgent ?? false)).toEqual([true, false]);
  });
});
