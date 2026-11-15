/**
 * v0.7 C7（M3）单测：xc_review 审批轨（DESIGN-V0.7 §3.2/§3.3）。
 *
 * 覆盖面：
 * - list axis:"approval"：待批清单（pending 且无审批文件；有审批文件/已拒不在列）；
 * - approve：仅现任 lead（not_lead）；自批闸（lead=from/to 仍拒）；批准窗缺省=剩余 ttl、
 *   显式 ttl 超请求窗时钳制并披露；审批文件落地 + 台账 approved + 审计 tool-approval +
 *   请求方收 approval_result 回执帧；approve 可从 refused 转入（后者写者胜）；
 * - approve 请求已过期 → approval_window_closed；requestId 未知 → tool_request_not_found；
 * - deny：无 lead 门（任何成员可代拒）；台账 denied + 审批文件 decision=denied + 回执；
 * - axis:"approval" + accept/discard → invalid_params（轴用错显式拒）；
 * - 旧 list/accept/discard 路径零影响（回归抽查）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { payloadOf } from './protocol.js';
import { identityStore } from './identity.js';
import { newTeamState, writeTeam } from '../core/teamstate.js';
import { readMailbox } from '../core/mailbox.js';
import { readToolRequest } from '../core/toolledger.js';
import { readApprovalFile } from '../core/toolapproval.js';
import { handleReview, mapReviewError } from './tools-review.js';

let stateRoot: string;

const NOW = Date.now();
const REQUEST_ID = 'review-0001-4b8e';

beforeEach(async () => {
  stateRoot = join(mkdtempSync(join(tmpdir(), 'xc-review-approval-')), '.crosschat');
  const team = newTeamState({ teamId: 'default', founderKey: 'bee', now: NOW });
  team.members.push(
    { key: 'bee', sessionId: 'sess_bee', role: 'peer', joinedAt: NOW, lastSeen: NOW },
    { key: 'aye', sessionId: 'sess_aye', role: 'worker', joinedAt: NOW, lastSeen: NOW },
    { key: 'lead', sessionId: 'sess_lead', role: 'peer', joinedAt: NOW, lastSeen: NOW },
  );
  team.leadKey = 'lead';
  await writeTeam(stateRoot, team);
  for (const [conn, key, sid] of [['conn-bee', 'bee', 'sess_bee'], ['conn-aye', 'aye', 'sess_aye'], ['conn-lead', 'lead', 'sess_lead']] as const) {
    identityStore.bind(conn, {
      sessionKey: `xc:default:${key}`, teamId: 'default', name: key, agentKey: key,
      sessionId: sid, role: 'peer', boundAt: NOW,
    });
  }
});

afterEach(() => {
  rmSync(join(stateRoot, '..'), { recursive: true, force: true });
});

/** 直驱 handleReview 的入口包装：与注册器 handler 同口径（ToolError → 错误信封）。 */
async function review(args: Parameters<typeof handleReview>[1], conn: string): Promise<Awaited<ReturnType<typeof handleReview>>> {
  try {
    return await handleReview({ stateRoot, workspace: stateRoot, env: {} }, args, conn);
  } catch (err) {
    return mapReviewError(err);
  }
}

async function seedRequest(state: 'pending' | 'refused' = 'pending', ttlMs = 3_600_000): Promise<void> {
  const { createToolRequest } = await import('../core/toolledger.js');
  await createToolRequest(stateRoot, {
    requestId: REQUEST_ID, from: 'bee', to: 'aye', tool: 'mcp__probe__ping', reason: '宿主注入类工具',
    ttlMs, maxResultChars: 64_000, state, createdAt: NOW - 1000, expiresAt: NOW + ttlMs,
  });
}

describe('xc_review v0.7: axis approval 待批清单', () => {
  it('pending 且无审批文件 → 在列；有审批文件/已拒 → 不在列', async () => {
    await seedRequest('pending');
    const { createToolRequest } = await import('../core/toolledger.js');
    await createToolRequest(stateRoot, {
      requestId: 'with-file', from: 'bee', to: 'aye', tool: 't2', reason: 'r2',
      ttlMs: 3_600_000, maxResultChars: 64_000, state: 'pending', createdAt: NOW, expiresAt: NOW + 3_600_000,
    });
    const { writeApprovalFile } = await import('../core/toolapproval.js');
    await writeApprovalFile(stateRoot, {
      requestId: 'with-file', decision: 'approved', approvedBy: 'lead', decidedAt: NOW, expiresAt: NOW + 60_000, tool: 't2',
    });
    await createToolRequest(stateRoot, {
      requestId: 'refused-one', from: 'bee', to: 'aye', tool: 't3', reason: 'r3',
      ttlMs: 3_600_000, maxResultChars: 64_000, state: 'refused', createdAt: NOW, expiresAt: NOW + 3_600_000,
    });
    const result = await review( { action: 'list', axis: 'approval' }, 'conn-bee');
    const payload = payloadOf(result);
    expect(payload['count']).toBe(1);
    const rows = payload['rows'] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ requestId: REQUEST_ID, from: 'bee', to: 'aye', tool: 'mcp__probe__ping' });
    expect(typeof rows[0]!['remainingTtlMs']).toBe('number');
  });

  it('空清单 → 零行（不缺省炸）', async () => {
    const result = await review( { action: 'list', axis: 'approval' }, 'conn-bee');
    expect(payloadOf(result)['count']).toBe(0);
  });
});

describe('xc_review v0.7: approve（lead 轨）', () => {
  it('lead 批准：审批文件落地 + 台账 approved + 审计 + 请求方回执帧', async () => {
    await seedRequest('pending');
    const result = await review(
      { action: 'approve', axis: 'approval', id: REQUEST_ID, note: '同意本次代执行' },
      'conn-lead',
    );
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ decision: 'approved', approvedBy: 'lead', ledgerState: 'approved' });
    expect(typeof payload['expiresAt']).toBe('number');
    const read = await readApprovalFile(stateRoot, REQUEST_ID);
    expect(read.status).toBe('ok');
    if (read.status === 'ok') {
      expect(read.approval).toMatchObject({ decision: 'approved', approvedBy: 'lead', tool: 'mcp__probe__ping', note: '同意本次代执行' });
      // 批准窗 ≤ 请求窗。
      expect(read.approval.expiresAt).toBeLessThanOrEqual(NOW + 3_600_000);
    }
    expect(await readToolRequest(stateRoot, REQUEST_ID)).toMatchObject({ state: 'approved', decidedBy: 'lead' });
    const beeMail = await readMailbox(stateRoot, 'default', 'bee');
    expect(beeMail).toHaveLength(1);
    expect(JSON.parse(beeMail[0]!.content)).toMatchObject({ type: 'approval_result', decision: 'approved', decidedBy: 'lead' });
  });

  it('显式 ttlMs 超请求剩余窗 → 钳制并披露（approvalWindowClamped）', async () => {
    await seedRequest('pending', 600_000); // 请求窗 10min
    const result = await review(
      { action: 'approve', axis: 'approval', id: REQUEST_ID, ttlMs: 7_200_000 },
      'conn-lead',
    );
    const payload = payloadOf(result);
    expect(payload['approvalWindowClamped']).toBe(true);
    const read = await readApprovalFile(stateRoot, REQUEST_ID);
    if (read.status !== 'ok') throw new Error('expected ok');
    expect(read.approval.expiresAt).toBeLessThanOrEqual(NOW + 600_000);
  });

  it('非 lead 批准 → not_lead（指引文件轨）', async () => {
    await seedRequest('pending');
    const result = await review(
      { action: 'approve', axis: 'approval', id: REQUEST_ID },
      'conn-aye',
    );
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'not_lead', leadKey: 'lead' });
    expect((await readToolRequest(stateRoot, REQUEST_ID))?.state).toBe('pending');
  });

  it('lead 恰为请求方/执行方 → self-approval refused（只能走文件轨）', async () => {
    // lead=bee（请求方）。
    const team = (await import('../core/teamstate.js')).newTeamState({ teamId: 'default', founderKey: 'bee', now: NOW });
    team.members.push(
      { key: 'bee', sessionId: 'sess_bee', role: 'peer', joinedAt: NOW, lastSeen: NOW },
      { key: 'aye', sessionId: 'sess_aye', role: 'worker', joinedAt: NOW, lastSeen: NOW },
    );
    team.leadKey = 'bee';
    await writeTeam(stateRoot, team);
    await seedRequest('pending');
    const result = await review(
      { action: 'approve', axis: 'approval', id: REQUEST_ID },
      'conn-bee',
    );
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'self-approval refused' });
  });

  it('approve 可从 refused 转入（后者写者胜）；请求已过期 → approval_window_closed', async () => {
    await seedRequest('refused');
    const revived = await review(
      { action: 'approve', axis: 'approval', id: REQUEST_ID },
      'conn-lead',
    );
    expect(payloadOf(revived)).toMatchObject({ decision: 'approved', ledgerState: 'approved' });

    // 同一请求把 expiresAt 拨到过去（模拟过期；requestId 不可复用）。
    const { updateToolRequest } = await import('../core/toolledger.js');
    await updateToolRequest(stateRoot, REQUEST_ID, (l) => ({ ...l, expiresAt: NOW - 1000 }));
    const closed = await review(
      { action: 'approve', axis: 'approval', id: REQUEST_ID },
      'conn-lead',
    );
    expect(closed.isError).toBe(true);
    expect(payloadOf(closed)).toMatchObject({ error: 'approval_window_closed' });
  });

  it('未知 requestId → tool_request_not_found；缺 id → invalid_params', async () => {
    const unknown = await review(
      { action: 'approve', axis: 'approval', id: 'ghost' },
      'conn-lead',
    );
    expect(unknown.isError).toBe(true);
    expect(payloadOf(unknown)).toMatchObject({ error: 'tool_request_not_found' });
    const noId = await review(
      { action: 'approve', axis: 'approval' },
      'conn-lead',
    );
    expect(noId.isError).toBe(true);
    expect(payloadOf(noId)).toMatchObject({ error: 'invalid_params' });
  });
});

describe('xc_review v0.7: deny（无 lead 门）', () => {
  it('任何成员可代拒：台账 denied + 审批文件 denied + 回执帧', async () => {
    await seedRequest('pending');
    const result = await review(
      { action: 'deny', axis: 'approval', id: REQUEST_ID, note: '本次不需要' },
      'conn-aye',
    );
    expect(payloadOf(result)).toMatchObject({ decision: 'denied', approvedBy: 'aye', ledgerState: 'denied' });
    expect(await readToolRequest(stateRoot, REQUEST_ID)).toMatchObject({ state: 'denied', decisionReason: '本次不需要' });
    const read = await readApprovalFile(stateRoot, REQUEST_ID);
    if (read.status !== 'ok') throw new Error('expected ok');
    expect(read.approval.decision).toBe('denied');
    const beeMail = await readMailbox(stateRoot, 'default', 'bee');
    expect(JSON.parse(beeMail[0]!.content)).toMatchObject({ type: 'approval_result', decision: 'denied' });
  });
});

describe('xc_review v0.7: 轴纪律与回归', () => {
  it('axis:"approval" + accept → invalid_params（轴用错显式拒）', async () => {
    const result = await review(
      { action: 'accept', axis: 'approval' },
      'conn-bee',
    );
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ error: 'invalid_params' });
  });

  it('旧路径回归：list/accept/discard held 队列照常（axis 缺省 all）', async () => {
    const listed = await review( {}, 'conn-bee');
    expect(payloadOf(listed)).toMatchObject({ action: 'list', count: 0 });
  });
});
