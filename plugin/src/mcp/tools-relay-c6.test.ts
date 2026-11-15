/**
 * v0.7 C6（M1）单测：xc_relay 的 C6 帧发送侧（DESIGN-V0.7 §2.2/§2.4/§2.6/§2.7）。
 *
 * 覆盖面：
 * - tool_request：合法发送 → 台账 pending + 审计 tool-request + delivered=mailbox +
 *   payload wake 抑制标注 + **attemptWake 零调用**（禁唤醒投递）+ uservoice 盖章豁免
 *   （B 的 prompt 逐字含帧文本也不盖 origin=user，E4 §7.3）；
 * - tool_request 非法：args 超 64K（args_too_large）/ requestId 占用 / from 冒充 /
 *   帧畸形 → 发送侧即拒、不落箱不建账；
 * - tool_request 免入站策略（XC_INBOUND_MODE=hold 时chat 被暂存、C6 帧直投邮箱）；
 * - tool_result：合法回投 → 台账 executed + 审计 tool-executed + 落箱 + 正常唤醒路径；
 *   error 回投 → 台账 error；refused 辞谢 → 台账 refused 终态（v0.7.2 B-04，一请求一结果）；伪造 from（≠台账.to）→ tool-result-rejected 拒收；
 *   请求未放行（pending）→ request_not_approved；结果超 maxResultChars → result_too_large；
 * - C6/C7 帧走 peer 轴 → tool_frame_peer_axis_unsupported（最小链路=队内轴）；
 * - 旧行为回归：普通 chat 照旧（attemptWake 被调用、无台账副作用）。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { payloadOf, type ToolResult } from './protocol.js';
import { identityStore } from './identity.js';
import { writeSession } from '../core/registry.js';
import { newTeamState, writeTeam, readTeam } from '../core/teamstate.js';
import { readMailbox } from '../core/mailbox.js';
import { readToolRequest } from '../core/toolledger.js';
import { uservoiceWrite } from '../core/uservoice.js';
import { createTeamRelayCore, xcRelay, type RelayArgs } from './tools-relay.js';
import type { WakeRequest } from '../engine/wake.js';
import { engineLogFile } from '../core/paths.js';
import { readJsonl } from '../core/jsonl.js';

// attemptWake spy：委托真身（XC_WAKE_ENABLED 未设 → 立即 mailbox 降级，不 spawn）。
const attemptWakeSpy = vi.hoisted(() => vi.fn());
vi.mock('../engine/wake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/wake.js')>();
  attemptWakeSpy.mockImplementation(actual.attemptWake);
  return { ...actual, attemptWake: attemptWakeSpy };
});

let stateRoot: string;

const REQUEST_ID = 'c6-0001-4f2a-9b31-7c6d5e8f0a12';

beforeEach(() => {
  attemptWakeSpy.mockClear();
  stateRoot = join(mkdtempSync(join(tmpdir(), 'xc-relay-c6-')), '.crosschat');
});

afterEach(() => {
  rmSync(join(stateRoot, '..'), { recursive: true, force: true });
});

async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: 'default', founderKey: 'a', now });
  team.members.push(
    { key: 'a', sessionId: 'sess_a', role: 'peer', joinedAt: now, lastSeen: now },
    { key: 'b', sessionId: 'sess_b', role: 'worker', joinedAt: now, lastSeen: now },
  );
  await writeTeam(stateRoot, team);
}

function bindIdentity(conn = 'conn-a', key = 'a', sid = 'sess_a'): void {
  identityStore.bind(conn, {
    sessionKey: `xc:default:${key}`,
    teamId: 'default',
    name: key,
    agentKey: key,
    sessionId: sid,
    role: 'peer',
    boundAt: Date.now(),
  });
}

function relayArgs(overrides: Partial<RelayArgs>): RelayArgs {
  return { to: 'b', msg: '正文', ...overrides } as RelayArgs;
}

function toolRequestMsg(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'tool_request',
    requestId: REQUEST_ID,
    from: 'a',
    tool: 'mcp__plugin_zcx-probe_zcxprobe__probe_ping',
    args: { echo: 'hi' },
    reason: 'B 缺宿主注入类 MCP，请 A 代执行',
    approval: { required: true },
    ...overrides,
  });
}

function toolResultMsg(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'tool_result',
    requestId: REQUEST_ID,
    from: 'b',
    status: 'ok',
    tool: 'mcp__plugin_zcx-probe_zcxprobe__probe_ping',
    result: { pid: 27168, ppid: 40988 },
    ts: 1794681345958,
    ...overrides,
  });
}

async function events(): Promise<Array<Record<string, unknown>>> {
  return readJsonl<Record<string, unknown>>(engineLogFile(stateRoot), (v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

describe('xc_relay v0.7 C6: tool_request 发送侧', () => {
  it('合法请求：台账 pending + 审计 + 禁唤醒 + payload 标注 + 不落 origin=user', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await core.xc_message(relayArgs({ msg: toolRequestMsg(), to: 'b' }), 'conn-a');
    const payload = payloadOf(result);
    expect(payload['delivered']).toBe('mailbox');
    expect(payload['frame']).toBe('tool_request');
    expect(payload['requestId']).toBe(REQUEST_ID);
    expect(payload['wake']).toBe('suppressed (approval-gate bypass guard)');
    expect(typeof payload['expiresAt']).toBe('number');
    // 禁唤醒投递（§2.2）：attemptWake 零调用。
    expect(attemptWakeSpy).not.toHaveBeenCalled();

    const ledger = await readToolRequest(stateRoot, REQUEST_ID);
    expect(ledger).toMatchObject({ from: 'a', to: 'b', state: 'pending', ttlMs: 3_600_000, maxResultChars: 64_000 });
    expect(ledger!.expiresAt).toBeGreaterThan(Date.now());

    const mail = await readMailbox(stateRoot, 'default', 'b');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.origin).toBeUndefined(); // 机器帧无用户亲述语义

    const log = await events();
    expect(log.some((e) => e['event'] === 'tool-request' && e['requestId'] === REQUEST_ID && e['tool'] === 'mcp__plugin_zcx-probe_zcxprobe__probe_ping')).toBe(true);
    expect(log.some((e) => e['event'] === 'wake-skipped' && e['scene'] === 'tool-request')).toBe(true);
    expect(log.some((e) => e['event'] === 'uservoice-hit')).toBe(false);
  });

  it('urgent tool_request：仅排序不回醒（attemptWake 仍零调用，消息带 urgent）', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    await core.xc_message(relayArgs({ msg: toolRequestMsg(), urgent: true }), 'conn-a');
    expect(attemptWakeSpy).not.toHaveBeenCalled();
    const mail = await readMailbox(stateRoot, 'default', 'b');
    expect(mail[0]!.urgent).toBe(true);
  });

  it('uservoice 豁免：prompt 逐字包含请求帧文本也不盖章（E4 §7.3 实测缺口）', async () => {
    await seedTeam();
    bindIdentity();
    const frame = toolRequestMsg();
    await writeSession(stateRoot, { sessionId: 'sess_a', cwd: stateRoot, startedAt: Date.now(), lastSeen: Date.now() });
    await uservoiceWrite(stateRoot, 'sess_a', frame, Date.now());
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    await core.xc_message(relayArgs({ msg: frame }), 'conn-a');
    const mail = await readMailbox(stateRoot, 'default', 'b');
    expect(mail[0]!.origin).toBeUndefined();
    const log = await events();
    expect(log.some((e) => e['event'] === 'uservoice-hit')).toBe(false);
  });

  it('args 超 64KB → args_too_large（发送侧即拒，不落箱不建账）', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const big = toolRequestMsg({ args: { blob: 'x'.repeat(70_000) } });
    const result = await core.xc_message(relayArgs({ msg: big }), 'conn-a');
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'args_too_large' });
    expect(await readToolRequest(stateRoot, REQUEST_ID)).toBeUndefined();
    expect(await readMailbox(stateRoot, 'default', 'b')).toHaveLength(0);
  });

  it('requestId 占用 → requestId_in_use', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    await core.xc_message(relayArgs({ msg: toolRequestMsg() }), 'conn-a');
    const again = await core.xc_message(relayArgs({ msg: toolRequestMsg() }), 'conn-a');
    expect(again.isError).toBe(true);
    expect(payloadOf(again)).toMatchObject({ error: 'requestId_in_use', requestId: REQUEST_ID });
  });

  it('帧 from 冒充他人 → tool_request_from_mismatch', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await core.xc_message(relayArgs({ msg: toolRequestMsg({ from: 'ghost' }) }), 'conn-a');
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'tool_request_from_mismatch' });
  });

  it('requestId 路径穿越 → invalid_request_id', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await core.xc_message(relayArgs({ msg: toolRequestMsg({ requestId: '../../evil' }) }), 'conn-a');
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'invalid_request_id' });
  });

  it('approval.file 逃出状态根 → approval_file_outside_state_root', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await core.xc_message(
      relayArgs({ msg: toolRequestMsg({ approval: { required: true, file: 'C:/Windows/evil.json' } }) }),
      'conn-a',
    );
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'approval_file_outside_state_root' });
  });

  it('C6 帧免入站策略：XC_INBOUND_MODE=hold 时 chat 被暂存、tool_request 直投邮箱', async () => {
    await seedTeam();
    bindIdentity();
    const deps = { stateRoot, workspace: stateRoot, env: { XC_INBOUND_MODE: 'hold' } };
    const core = createTeamRelayCore(deps);
    const held = await core.xc_message(relayArgs({ msg: '自由消息' }), 'conn-a');
    expect(payloadOf(held)['delivered']).toBe('held');
    const frame = await core.xc_message(relayArgs({ msg: toolRequestMsg() }), 'conn-a');
    expect(payloadOf(frame)['delivered']).toBe('mailbox');
    expect(await readToolRequest(stateRoot, REQUEST_ID)).toMatchObject({ state: 'pending' });
    // 主邮箱里只有豁免入站策略的 tool_request 帧；chat 件仍在 held 隔离区。
    const mail = await readMailbox(stateRoot, 'default', 'b');
    expect(mail).toHaveLength(1);
    expect(JSON.parse(mail[0]!.content)).toMatchObject({ type: 'tool_request', requestId: REQUEST_ID });
    expect(existsSync(join(stateRoot, 'teams', 'default', 'inbox', 'b.held.jsonl'))).toBe(true);
  });
});

describe('xc_relay v0.7 C6: tool_result 发送侧', () => {
  async function seedApproved(): Promise<void> {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    await core.xc_message(relayArgs({ msg: toolRequestMsg() }), 'conn-a');
    // 文件轨批准（实验员/用户手写）+ 台账迁移由门完成；这里直接推台账模拟门已放行。
    const { updateToolRequest } = await import('../core/toolledger.js');
    await updateToolRequest(stateRoot, REQUEST_ID, (l) => ({ ...l, state: 'approved', decidedBy: 'lead', decidedAt: Date.now() }));
    identityStore.bind('conn-b', {
      sessionKey: 'xc:default:b', teamId: 'default', name: 'b', agentKey: 'b',
      sessionId: 'sess_b', role: 'worker', boundAt: Date.now(),
    });
  }

  it('合法回投：台账 executed + 审计 tool-executed + 落 B 箱 + 唤醒路径照旧', async () => {
    await seedApproved();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await core.xc_message(relayArgs({ msg: toolResultMsg(), to: 'a' }), 'conn-b');
    expect(payloadOf(result)).toMatchObject({ delivered: 'mailbox', frame: 'tool_result', requestId: REQUEST_ID });
    expect(attemptWakeSpy).toHaveBeenCalledTimes(1); // 回投走正常唤醒路径（与请求的禁令互不干涉）
    const ledger = await readToolRequest(stateRoot, REQUEST_ID);
    expect(ledger).toMatchObject({ state: 'executed', decidedBy: 'b' });
    expect(typeof ledger!.resultChars).toBe('number');
    expect(typeof ledger!.resultMessageId).toBe('string');
    const mail = await readMailbox(stateRoot, 'default', 'a');
    expect(mail).toHaveLength(1);
    expect(JSON.parse(mail[0]!.content)).toMatchObject({ type: 'tool_result', status: 'ok', result: { pid: 27168, ppid: 40988 } });
    const log = await events();
    expect(log.some((e) => e['event'] === 'tool-executed' && e['status'] === 'ok')).toBe(true);
  });

  it('error 回投：台账 error；平台错误原文不伪造', async () => {
    await seedApproved();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    await core.xc_message(
      relayArgs({ msg: toolResultMsg({ status: 'error', result: undefined, error: 'No such tool available: mcp__x__no_such_tool' }), to: 'a' }),
      'conn-b',
    );
    expect(await readToolRequest(stateRoot, REQUEST_ID)).toMatchObject({ state: 'error' });
    const mail = await readMailbox(stateRoot, 'default', 'a');
    expect(JSON.parse(mail[0]!.content)).toMatchObject({ status: 'error', error: 'No such tool available: mcp__x__no_such_tool' });
  });

  it('执行方辞谢（status:"refused"）→ 台账落 refused 终态；再回投 ok 被拒（一请求一结果）', async () => {
    // 红队裁决 b04.jsonl：辞谢后台账停留 approved，之后仍可回投 ok 被接受（台账 executed）。
    await seedApproved();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const declined = await core.xc_message(
      relayArgs({ msg: toolResultMsg({ status: 'refused', result: undefined, reason: 'not my job' }) , to: 'a' }),
      'conn-b',
    );
    expect(payloadOf(declined)).toMatchObject({ delivered: 'mailbox', frame: 'tool_result' });
    const afterRefusal = await readToolRequest(stateRoot, REQUEST_ID);
    expect(afterRefusal).toMatchObject({ state: 'refused', decidedBy: 'b', decisionReason: 'tool_result:refused' });
    // 请求方确实收到了辞谢帧。
    const mail = await readMailbox(stateRoot, 'default', 'a');
    expect(JSON.parse(mail[mail.length - 1]!.content)).toMatchObject({ type: 'tool_result', status: 'refused', reason: 'not my job' });
    // 迟到的 ok 回投被拒（不再二次结果）。
    const late = await core.xc_message(relayArgs({ msg: toolResultMsg({ result: 'late pong' }), to: 'a' }), 'conn-b');
    expect(late.isError).toBe(true);
    expect(payloadOf(late)).toMatchObject({ error: 'tool_result_rejected', errorClass: 'request_not_approved' });
    expect((await readToolRequest(stateRoot, REQUEST_ID))?.state).toBe('refused');
    // 审计留痕两种 status。
    const log = await events();
    expect(log.filter((e) => e['event'] === 'tool-executed').map((e) => e['status'])).toEqual(['refused']);
  });

  it('error 回投仍是终态（error），且不再接受第二次回投', async () => {
    await seedApproved();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    await core.xc_message(
      relayArgs({ msg: toolResultMsg({ status: 'error', result: undefined, error: 'No such tool available: x' }), to: 'a' }),
      'conn-b',
    );
    expect((await readToolRequest(stateRoot, REQUEST_ID))?.state).toBe('error');
    const again = await core.xc_message(relayArgs({ msg: toolResultMsg() , to: 'a' }), 'conn-b');
    expect(again.isError).toBe(true);
    expect(payloadOf(again)).toMatchObject({ errorClass: 'request_already_finalized' });
  });

  it('ok 回投的 resultChars 按有效载荷计（字符串不再 +2 引号）', async () => {
    await seedApproved();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    await core.xc_message(relayArgs({ msg: toolResultMsg({ result: 'x'.repeat(500) }), to: 'a' }), 'conn-b');
    const ledger = await readToolRequest(stateRoot, REQUEST_ID);
    expect(ledger?.resultChars).toBe(500);
    const log = await events();
    expect(log.find((e) => e['event'] === 'tool-executed')?.resultChars).toBe(500);
  });

  it('伪造回投：发送者不是执行方 → tool-result-rejected（不落箱不终填）', async () => {
    await seedApproved();
    // 第三方成员 ghost 冒名执行方回投（帧 from 写对了也不是执行方本人）。
    const team = (await readTeam(stateRoot, 'default'))!;
    team.members.push({ key: 'ghost', sessionId: 'sess_g', role: 'peer', joinedAt: Date.now(), lastSeen: Date.now() });
    await writeTeam(stateRoot, team);
    identityStore.bind('conn-g', {
      sessionKey: 'xc:default:ghost', teamId: 'default', name: 'ghost', agentKey: 'ghost',
      sessionId: 'sess_g', role: 'peer', boundAt: Date.now(),
    });
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await core.xc_message(relayArgs({ msg: toolResultMsg(), to: 'a' }), 'conn-g');
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'tool_result_rejected', errorClass: 'tool_result_from_mismatch' });
    expect(await readToolRequest(stateRoot, REQUEST_ID)).toMatchObject({ state: 'approved' });
    expect(await readMailbox(stateRoot, 'default', 'a')).toHaveLength(0);
    const log = await events();
    expect(log.some((e) => e['event'] === 'tool-result-rejected')).toBe(true);
  });

  it('请求未放行（pending）→ request_not_approved', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    await core.xc_message(relayArgs({ msg: toolRequestMsg() }), 'conn-a');
    identityStore.bind('conn-b', {
      sessionKey: 'xc:default:b', teamId: 'default', name: 'b', agentKey: 'b', sessionId: 'sess_b', role: 'worker', boundAt: Date.now(),
    });
    const result = await core.xc_message(relayArgs({ msg: toolResultMsg(), to: 'a' }), 'conn-b');
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'tool_result_rejected', errorClass: 'request_not_approved' });
  });

  it('未知 requestId → request_not_found（审计 tool-result-rejected）', async () => {
    await seedTeam();
    bindIdentity();
    identityStore.bind('conn-b', {
      sessionKey: 'xc:default:b', teamId: 'default', name: 'b', agentKey: 'b', sessionId: 'sess_b', role: 'worker', boundAt: Date.now(),
    });
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await core.xc_message(relayArgs({ msg: toolResultMsg({ requestId: 'ghost-id' }), to: 'a' }), 'conn-b');
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ errorClass: 'request_not_found' });
  });

  it('结果超 maxResultChars → result_too_large', async () => {
    await seedApproved();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const big = toolResultMsg({ result: { blob: 'x'.repeat(70_000) } });
    const result = await core.xc_message(relayArgs({ msg: big, to: 'a' }), 'conn-b');
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ errorClass: 'result_too_large' });
  });

  it('重复回投（台账已 executed）→ request_already_finalized', async () => {
    await seedApproved();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    await core.xc_message(relayArgs({ msg: toolResultMsg(), to: 'a' }), 'conn-b');
    const again = await core.xc_message(relayArgs({ msg: toolResultMsg(), to: 'a' }), 'conn-b');
    expect(again.isError).toBe(true);
    expect(payloadOf(again)).toMatchObject({ errorClass: 'request_already_finalized' });
  });

  it('tool 不匹配 → tool_mismatch', async () => {
    await seedApproved();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await core.xc_message(relayArgs({ msg: toolResultMsg({ tool: 'mcp__other__x' }), to: 'a' }), 'conn-b');
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ errorClass: 'tool_mismatch' });
  });
});

describe('xc_relay v0.7 C6: peer 轴与回归', () => {
  it('C6 帧显式 [peer] 后缀 → tool_frame_peer_axis_unsupported（最小链路=队内轴）', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await xcRelay(
      { stateRoot, workspace: stateRoot, env: {} },
      core,
      relayArgs({ msg: toolRequestMsg(), to: 'b[peer]' }),
      'conn-a',
      true,
    );
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'tool_frame_peer_axis_unsupported', axis: 'peer' });
  });

  it('普通 chat 回归：attemptWake 照旧调用、无台账副作用', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result = await core.xc_message(relayArgs({ msg: '你好' }), 'conn-a');
    expect(payloadOf(result)).toMatchObject({ delivered: 'mailbox' });
    expect(attemptWakeSpy).toHaveBeenCalledTimes(1);
    const log = await events();
    expect(log.some((e) => e['event'] === 'tool-request')).toBe(false);
    expect((await readMailbox(stateRoot, 'default', 'b')).length).toBe(1);
  });

  it('目标不是成员 → not_a_member（先于帧逻辑的队内闸不受影响）', async () => {
    await seedTeam();
    bindIdentity();
    const core = createTeamRelayCore({ stateRoot, workspace: stateRoot, env: {} });
    const result: ToolResult = await core.xc_message(relayArgs({ msg: toolRequestMsg(), to: 'ghost' }), 'conn-a');
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'not_a_member' });
    expect(await readToolRequest(stateRoot, REQUEST_ID)).toBeUndefined();
  });
});
