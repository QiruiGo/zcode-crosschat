/**
 * v0.9.0 组 C 定向单测：xc_relay 撤回原语（G-3，PROTOCOL §7.1）+ 软中断信封（G-2，PROTOCOL §7）。
 *
 * 覆盖面：
 * - 撤回成功流（unread-only）：整行删除 + withdrawal-notice 通知帧（键集/值）+
 *   engine 事件 message-withdrawn + 尽力唤醒（无 urgent）+ payload 键集；
 * - 整单拒绝：含已读/不存在/非本人/已作废件 → withdraw_rejected + items 逐条状态
 *   （unread/read/not_found/foreign/discarded）+ 邮箱一个字节不动 + message-withdraw-rejected 审计；
 * - 互斥与必填：撤回模式拒绝 msg/urgent/interrupt/summary/source*（withdraw_exclusive_params，
 *   冲突参数逐个点名）；无 withdraw 时 msg 必填；重复 id 去重；
 * - 轴界：peer 轴显式拒收 withdraw_peer_axis_unsupported；
 * - 软中断：interrupt:true → urgent:true ∧ interrupt:true 落箱（正文原话不动）；
 *   payload interrupt 块（delivered 带 envelope:"team-inbox"；duplicate 不带）；
 *   inbox 读取面信封渲染 interrupt="true" 属性 + TEAM_INTERRUPT_BANNER 横幅（正文前一行）；
 *   普通件无横幅无属性（回归）；
 * - withdrawal-notice 帧过读取面白名单（不被 frame-rejected 剔除）。
 *
 * 撤回/信封的形状冻结对拍（文档即测试）在 protocol-frozen-contract-v090.test.ts。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { payloadOf, type ToolResult } from './protocol.js';
import { identityStore } from './identity.js';
import { newTeamState, readTeam, writeTeam } from '../core/teamstate.js';
import {
  acknowledgeMailbox,
  appendMailbox,
  classifyFrame,
  createMessage,
  discardMailboxMessages,
  FRAME_TYPES,
  readMailbox,
} from '../core/mailbox.js';
import { TEAM_INTERRUPT_BANNER, renderTeamEnvelope } from '../core/peerenvelope.js';
import {
  buildWithdrawalNoticeFrame,
  createTeamRelayCore,
  INTERRUPT_DEFERRED_REASON,
  INTERRUPT_ENVELOPE_TEAM,
  xcRelay,
} from './tools-relay.js';
import { createMailboxReadCore } from './tools-read.js';
import { setPeerSessionContext, clearPeerSessionContext } from './peer-drain.js';
import type { WakeRequest } from '../engine/wake.js';

// attemptWake 换成 spy（实现委托真身——XC_WAKE_ENABLED 未设时立即 mailbox 降级，
// 不触 spawn；调用入参用于断言撤回唤醒不带 urgent）。
const attemptWakeSpy = vi.hoisted(() => vi.fn());
vi.mock('../engine/wake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/wake.js')>();
  attemptWakeSpy.mockImplementation(actual.attemptWake);
  return { ...actual, attemptWake: attemptWakeSpy };
});

let workDir: string;
let stateRoot: string;

beforeEach(() => {
  attemptWakeSpy.mockClear();
  workDir = mkdtempSync(join(tmpdir(), 'xc-relay-v090-'));
  stateRoot = join(workDir, '.crosschat');
  clearPeerSessionContext();
});

afterEach(async () => {
  clearPeerSessionContext();
  rmSync(workDir, { recursive: true, force: true });
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

function bindIdentity(conn = 'conn-a', agentKey = 'a', sessionId = 'sess_a'): void {
  identityStore.bind(conn, {
    sessionKey: `xc:default:${agentKey}`,
    teamId: 'default',
    name: agentKey,
    agentKey,
    sessionId,
    role: agentKey === 'a' ? 'peer' : 'worker',
    boundAt: Date.now(),
  });
}

function relayDeps(env: Record<string, string> = {}) {
  return { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: join(workDir, 'peers'), ...env } };
}

function core(env: Record<string, string> = {}) {
  return createTeamRelayCore(relayDeps(env));
}

function payloadOf_(r: ToolResult): Record<string, unknown> {
  return payloadOf(r) as Record<string, unknown>;
}

/** engine.jsonl 全行（含行级 ts）。 */
function engineLines(): Record<string, unknown>[] {
  const file = join(stateRoot, 'logs', 'engine.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ─────────────────────────── G-3 撤回原语 ───────────────────────────

describe('v0.9 G-3: xc_relay withdrawMessageIds（撤回未读件）', () => {
  it('成功流：整行删除 + withdrawal-notice 帧 + message-withdrawn 事件 + 尽力唤醒（无 urgent）+ payload 键集', async () => {
    await seedTeam();
    bindIdentity();
    const c = core();
    const m1 = payloadOf_(await c.xc_message({ to: 'b', msg: '第一条（将撤回）' }, 'conn-a'))['messageId'] as string;
    const m2 = payloadOf_(await c.xc_message({ to: 'b', msg: '第二条（将撤回）' }, 'conn-a'))['messageId'] as string;
    attemptWakeSpy.mockClear();

    const result = await c.xc_message({ to: 'b', withdrawMessageIds: [m1, m2] }, 'conn-a');
    expect(result.isError).toBeUndefined();
    const payload = payloadOf_(result);
    expect(payload['withdrawn']).toEqual([m1, m2]);
    expect(payload['withdrawnCount']).toBe(2);
    expect(typeof payload['noticeMessageId']).toBe('string');
    expect(payload['to']).toBe('b');
    expect(['wake', 'mailbox']).toContain(payload['delivered']);
    // 撤回唤醒不带 urgent（撤回本身不是插队请求）。
    expect(attemptWakeSpy).toHaveBeenCalledTimes(1);
    expect((attemptWakeSpy.mock.calls[0]![0] as WakeRequest).urgent).toBeUndefined();

    // 收方邮箱：被撤件整行删除，只剩 withdrawal-notice 通知帧（不带被撤正文）。
    const box = await readMailbox(stateRoot, 'default', 'b');
    expect(box).toHaveLength(1);
    const notice = box[0]!;
    expect(notice.id).toBe(payload['noticeMessageId']);
    expect(notice.from).toBe('a');
    expect(notice.to).toBe('b');
    const frame = JSON.parse(notice.content) as Record<string, unknown>;
    expect(frame['type']).toBe('withdrawal-notice');
    expect(frame['withdrawnMessageIds']).toEqual([m1, m2]);
    expect(frame['withdrawnCount']).toBe(2);
    expect(typeof frame['ts']).toBe('number');
    expect(notice.content).not.toContain('将撤回');

    // engine 事件（payload 字段；ts 由 logEngineEvent 统一加在行级）。
    const events = engineLines().filter((e) => e['event'] === 'message-withdrawn');
    expect(events).toHaveLength(1);
    const { ts: _ts, ...fields } = events[0]!;
    expect(fields['teamId']).toBe('default');
    expect(fields['from']).toBe('a');
    expect(fields['to']).toBe('b');
    expect(fields['messageIds']).toEqual([m1, m2]);
    expect(fields['count']).toBe(2);
    expect(fields['noticeMessageId']).toBe(payload['noticeMessageId']);
  });

  it('整单拒绝（含已读件）：withdraw_rejected + items 逐条状态 + 邮箱不动 + message-withdraw-rejected 审计', async () => {
    await seedTeam();
    bindIdentity();
    const c = core();
    const m1 = payloadOf_(await c.xc_message({ to: 'b', msg: '未读件' }, 'conn-a'))['messageId'] as string;
    const m2 = payloadOf_(await c.xc_message({ to: 'b', msg: '已读件' }, 'conn-a'))['messageId'] as string;
    await acknowledgeMailbox(stateRoot, 'default', 'b', [m2]);

    const result = await c.xc_message({ to: 'b', withdrawMessageIds: [m1, m2] }, 'conn-a');
    expect(result.isError).toBe(true);
    const payload = payloadOf_(result);
    expect(payload['error']).toBe('withdraw_rejected');
    expect(payload['to']).toBe('b');
    // items 覆盖请求的每一条（可撤的也报状态）。
    expect(payload['items']).toEqual([
      { messageId: m1, status: 'unread' },
      { messageId: m2, status: 'read' },
    ]);
    // 一个字节不动：两件都还在（m1 仍可撤）。
    const box = await readMailbox(stateRoot, 'default', 'b');
    expect(box.map((m) => m.id)).toEqual([m1, m2]);
    expect(engineLines().some((e) => e['event'] === 'message-withdraw-rejected')).toBe(true);
  });

  it('逐条状态词表：not_found / foreign / discarded（判定次序 found → 本人 → 未读 → 未作废）', async () => {
    await seedTeam();
    bindIdentity();
    const c = core();
    const mine = payloadOf_(await c.xc_message({ to: 'b', msg: '我的未读件' }, 'conn-a'))['messageId'] as string;
    // foreign：收方箱里来自第三者 c 的件。
    const team = await readTeam(stateRoot, 'default');
    team!.members.push({ key: 'c', sessionId: 'sess_c', role: 'worker', joinedAt: Date.now(), lastSeen: Date.now() });
    await writeTeam(stateRoot, team!);
    const foreign = createMessage('c', 'b', '别人发的件', {});
    await appendMailbox(stateRoot, 'default', 'b', foreign);
    // discarded：我的未读件就地作废。
    const stale = payloadOf_(await c.xc_message({ to: 'b', msg: '将被作废的件' }, 'conn-a'))['messageId'] as string;
    await discardMailboxMessages(stateRoot, 'default', 'b', [stale]);

    const result = await c.xc_message({ to: 'b', withdrawMessageIds: ['no-such-id', foreign.id, stale, mine] }, 'conn-a');
    expect(result.isError).toBe(true);
    const payload = payloadOf_(result);
    expect(payload['error']).toBe('withdraw_rejected');
    expect(payload['items']).toEqual([
      { messageId: 'no-such-id', status: 'not_found' },
      { messageId: foreign.id, status: 'foreign' },
      { messageId: stale, status: 'discarded' },
      { messageId: mine, status: 'unread' },
    ]);
    // 全单拒绝：连可撤的 mine 也没被删。
    const box = await readMailbox(stateRoot, 'default', 'b');
    expect(box.some((m) => m.id === mine)).toBe(true);
  });

  it('互斥：撤回模式携带 msg/urgent/interrupt/summary/source* → withdraw_exclusive_params 逐个点名', async () => {
    await seedTeam();
    bindIdentity();
    const c = core();
    const cases: Array<Record<string, unknown>> = [
      { msg: '正文' },
      { urgent: true },
      { interrupt: true },
      { summary: '摘要' },
      { sourceTaskId: 't', sourceAttemptId: 'at' },
    ];
    for (const extra of cases) {
      const result = await c.xc_message({ to: 'b', withdrawMessageIds: ['x'], ...extra } as never, 'conn-a');
      expect(result.isError, JSON.stringify(extra)).toBe(true);
      const payload = payloadOf_(result);
      expect(payload['error'], JSON.stringify(extra)).toBe('withdraw_exclusive_params');
      expect((payload['offenders'] as string[]).length).toBeGreaterThan(0);
    }
  });

  it('无 withdraw 时 msg 必填；撤回请求允许省略 msg；重复 id 去重为一次', async () => {
    await seedTeam();
    bindIdentity();
    const c = core();
    // 纯 to（无 msg 无 withdraw）→ invalid_params（msg 必填）。
    const bare = await c.xc_message({ to: 'b' } as never, 'conn-a');
    expect(bare.isError).toBe(true);
    expect(payloadOf_(bare)['error']).toBe('invalid_params');
    expect(String(payloadOf_(bare)['message'])).toContain('msg is required');
    // 重复 id：去重为一次成功撤回。
    const id = payloadOf_(await c.xc_message({ to: 'b', msg: '只此一件' }, 'conn-a'))['messageId'] as string;
    const payload = payloadOf_(await c.xc_message({ to: 'b', withdrawMessageIds: [id, id] }, 'conn-a'));
    expect(payload['withdrawn']).toEqual([id]);
    expect(payload['withdrawnCount']).toBe(1);
  });

  it('peer 轴显式拒收 withdraw_peer_axis_unsupported（不静默降级）', async () => {
    await seedTeam();
    bindIdentity();
    const result = await xcRelay(relayDeps(), core(), { to: 'nobody[peer]', withdrawMessageIds: ['x'] }, 'conn-a', false);
    expect(result.isError).toBe(true);
    expect(payloadOf_(result)['error']).toBe('withdraw_peer_axis_unsupported');
  });

  it('withdrawal-notice 帧过读取面白名单（不被 frame-rejected 剔除，进 inbox 消费面）', async () => {
    await seedTeam();
    bindIdentity();
    const c = core();
    const id = payloadOf_(await c.xc_message({ to: 'b', msg: '撤我' }, 'conn-a'))['messageId'] as string;
    await c.xc_message({ to: 'b', withdrawMessageIds: [id] }, 'conn-a');
    // 读取面白名单判定（readMailboxDetailed 同一道 classifyFrame 闸）：通知帧必须在白名单。
    const box = await readMailbox(stateRoot, 'default', 'b');
    const notice = box.find((m) => m.content.startsWith('{"type":"withdrawal-notice"'));
    expect(notice).toBeDefined();
    expect(classifyFrame(notice!.content)).toEqual({ kind: 'frame', frameType: 'withdrawal-notice', accepted: true });
  });

  it('组装链（withGuards）下撤回单绕过入站策略直通核心：hold 策略也照样撤（守卫旁路）', async () => {
    await seedTeam();
    bindIdentity();
    // 入站策略 hold：普通 chat 件会进隔离区，撤回单必须不被拦。
    const { composeCore } = await import('./core.js');
    const composed = composeCore(relayDeps({ XC_INBOUND_MODE: 'hold' }));
    // 先证明 hold 生效：普通件进隔离区（delivered=held）。
    const held = payloadOf_(await composed.xc_message({ to: 'b', msg: '会被隔离的件' }, 'conn-a'));
    expect(held['delivered']).toBe('held');
    // 待撤件直接落箱（不经 relay——hold 下发送必被隔离）。
    const seed = createMessage('a', 'b', '待撤件', { deliveryClaimedAt: Date.now() });
    await appendMailbox(stateRoot, 'default', 'b', seed);
    // 撤回单直通核心：成功撤回（不进隔离区、不被 hold 拦）。
    const result = await composed.xc_message({ to: 'b', withdrawMessageIds: [seed.id] }, 'conn-a');
    expect(result.isError).toBeUndefined();
    expect(payloadOf_(result)['withdrawn']).toEqual([seed.id]);
    // 组装链下缺 msg 且无 withdraw → 核心闸 invalid_params（守卫旁路后仍被拒）。
    const bare = await composed.xc_message({ to: 'b' } as never, 'conn-a');
    expect(bare.isError).toBe(true);
    expect(payloadOf_(bare)['error']).toBe('invalid_params');
  });

  it('buildWithdrawalNoticeFrame：纯函数键集与值域（契约对拍用）', () => {
    const frame = JSON.parse(buildWithdrawalNoticeFrame(['id-1', 'id-2'], 1234)) as Record<string, unknown>;
    expect(Object.keys(frame)).toEqual(['type', 'withdrawnMessageIds', 'withdrawnCount', 'ts']);
    expect(frame['type']).toBe('withdrawal-notice');
    expect(frame['withdrawnMessageIds']).toEqual(['id-1', 'id-2']);
    expect(frame['withdrawnCount']).toBe(2);
    expect(frame['ts']).toBe(1234);
  });
});

// ─────────────────────────── G-2 软中断信封 ───────────────────────────

describe('v0.9 G-2: xc_relay interrupt:true（软中断信封）', () => {
  it('interrupt:true：urgent ∧ interrupt 元数据落箱（正文原话不动）；payload interrupt 块带 envelope:"team-inbox"', async () => {
    await seedTeam();
    bindIdentity();
    const result = await core().xc_message({ to: 'b', msg: '打断请求正文', interrupt: true }, 'conn-a');
    const payload = payloadOf_(result);
    expect(payload['urgent']).toBe(true);
    const block = payload['interrupt'] as Record<string, unknown>;
    expect(block['requested']).toBe(true);
    expect(block['result']).toBe('deferred-next-turn');
    expect(block['reason']).toBe(INTERRUPT_DEFERRED_REASON);
    expect(block['envelope']).toBe(INTERRUPT_ENVELOPE_TEAM);
    expect(INTERRUPT_ENVELOPE_TEAM).toBe('team-inbox');
    const box = await readMailbox(stateRoot, 'default', 'b');
    const last = box[box.length - 1]!;
    expect(last.urgent).toBe(true);
    expect(last.interrupt).toBe(true);
    expect(last.content).toBe('打断请求正文'); // 正文原话不动（盖章字节匹配不受影响）
  });

  it('duplicate 路径：interrupt 块不带 envelope（重复的是既有消息，不得虚报信封）', async () => {
    await seedTeam();
    bindIdentity();
    const c = core();
    await c.xc_message({ to: 'b', msg: '同文打断', interrupt: true }, 'conn-a');
    const payload = payloadOf_(await c.xc_message({ to: 'b', msg: '同文打断', interrupt: true }, 'conn-a'));
    expect(payload['delivered']).toBe('duplicate');
    const block = payload['interrupt'] as Record<string, unknown>;
    expect(block['requested']).toBe(true);
    expect(block['envelope']).toBeUndefined();
  });

  it('inbox 读取面：interrupt 件信封带 interrupt="true" 属性 + TEAM_INTERRUPT_BANNER（正文前一行）；普通件无', async () => {
    await seedTeam();
    bindIdentity();
    await core().xc_message({ to: 'b', msg: '普通件' }, 'conn-a');
    await core().xc_message({ to: 'b', msg: '中断件', interrupt: true }, 'conn-a');

    // 收方视角（conn-b）消费 inbox：信封块逐条渲染（urgent-first：中断件在前）。
    bindIdentity('conn-b', 'b', 'sess_b');
    const readCore = createMailboxReadCore(relayDeps());
    const result = await readCore.xc_check_inbox({}, 'conn-b');
    const blocks = result.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
    expect(blocks).toContain('interrupt="true"');
    // 横幅恰出现 1 次（只有中断件带）。
    expect(blocks.split(TEAM_INTERRUPT_BANNER)).toHaveLength(2);
    expect(blocks).toContain('中断件');
    expect(blocks).toContain('普通件');
    // JSON payload entry 透传 interrupt 元数据。
    const payload = payloadOf_(result) as { messages: Array<Record<string, unknown>> };
    const interruptEntry = payload.messages.find((m) => m['content'] === '中断件');
    expect(interruptEntry?.['interrupt']).toBe(true);
    const normalEntry = payload.messages.find((m) => m['content'] === '普通件');
    expect(normalEntry?.['interrupt']).toBeUndefined();
  });

  it('渲染器回归：renderTeamEnvelope 普通输入无 interrupt 属性无横幅；横幅常量逐字节冻结', async () => {
    const plain = renderTeamEnvelope({ frameType: 'chat', from: 'a', content: '正文' });
    expect(plain).not.toContain('interrupt=');
    expect(plain).not.toContain('INTERRUPT');
    const flagged = renderTeamEnvelope({ frameType: 'chat', from: 'a', content: '正文', interrupt: true });
    expect(flagged).toContain('<crosschat-team-message type="chat" from="a" interrupt="true">');
    const lines = flagged.split('\n');
    // 横幅紧跟开标签（正文前一行）。
    const openIdx = lines.findIndex((l) => l.startsWith('<crosschat-team-message'));
    expect(lines[openIdx! + 1]).toBe(TEAM_INTERRUPT_BANNER);
    expect(TEAM_INTERRUPT_BANNER).toBe(
      '[INTERRUPT 软中断请求：完成当前原子操作、不开新步骤；先回确认（xc_relay 回发件人）再继续]',
    );
  });

  it('FRAME_TYPES：withdrawal-notice 加白且恰 12 类', () => {
    expect(FRAME_TYPES).toContain('withdrawal-notice');
    expect(FRAME_TYPES).toHaveLength(12);
  });
});
