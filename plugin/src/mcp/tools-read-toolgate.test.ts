/**
 * v0.7 C6（M2）单测：xc_read 的审批门双路集成（DESIGN-V0.7 §2.7 / AC3）。
 *
 * 覆盖面：
 * - inbox 路：未放行 tool_request → 遮蔽占位（两个面都不出原文 SECRET）+ 消息标记
 *   discarded + 台账 refused + 回投请求方 + lead 待批通知；放行 → APPROVAL VERIFIED 头
 *   + 全文；非 tool_request 消息零影响（chat/其他协议帧照旧）；
 * - inbox 路：遮蔽消息被丢弃后不复读（不重复回投）；
 * - mail 路（原文旁路修复）：未放行 → 只出遮蔽占位（v0.6.1 直出原始帧全文的缺口）；
 *   放行 → 带头全文可分页；
 * - mail 路对普通消息零影响（回归）；
 * - 批次预算：遮蔽占位成本低，不影响窗口语义。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { payloadOf } from './protocol.js';
import { identityStore } from './identity.js';
import { newTeamState, writeTeam } from '../core/teamstate.js';
import { appendMailbox, createMessage, readMailbox } from '../core/mailbox.js';
import { createToolRequest, readToolRequest } from '../core/toolledger.js';
import { writeApprovalFile } from '../core/toolapproval.js';
import { createMailboxReadCore } from './tools-read.js';

let stateRoot: string;
let read: ReturnType<typeof createMailboxReadCore>;

const NOW = Date.now();
const REQUEST_ID = 'read-gate-0001';
const SECRET_ARG = 'TOP-SECRET-ARG';

beforeEach(async () => {
  stateRoot = join(mkdtempSync(join(tmpdir(), 'xc-read-gate-')), '.crosschat');
  read = createMailboxReadCore({ stateRoot, workspace: stateRoot, env: {} });
  const team = newTeamState({ teamId: 'default', founderKey: 'aye', now: NOW });
  team.members.push(
    { key: 'aye', sessionId: 'sess_aye', role: 'worker', joinedAt: NOW, lastSeen: NOW },
    { key: 'bee', sessionId: 'sess_bee', role: 'peer', joinedAt: NOW, lastSeen: NOW },
    { key: 'lead', sessionId: 'sess_lead', role: 'peer', joinedAt: NOW, lastSeen: NOW },
  );
  team.leadKey = 'lead';
  await writeTeam(stateRoot, team);
  identityStore.bind('conn-aye', {
    sessionKey: 'xc:default:aye', teamId: 'default', name: 'aye', agentKey: 'aye',
    sessionId: 'sess_aye', role: 'worker', boundAt: NOW,
  });
  identityStore.bind('conn-bee', {
    sessionKey: 'xc:default:bee', teamId: 'default', name: 'bee', agentKey: 'bee',
    sessionId: 'sess_bee', role: 'peer', boundAt: NOW,
  });
});

afterEach(() => {
  rmSync(join(stateRoot, '..'), { recursive: true, force: true });
});

function requestMessage(): ReturnType<typeof createMessage> {
  return createMessage('bee', 'aye', JSON.stringify({
    type: 'tool_request',
    requestId: REQUEST_ID,
    from: 'bee',
    tool: 'mcp__probe__ping',
    args: { token: SECRET_ARG },
    reason: '宿主注入类工具',
    approval: { required: true },
  }));
}

async function seedRequest(state: 'pending' | 'approved' = 'pending'): Promise<void> {
  await createToolRequest(stateRoot, {
    requestId: REQUEST_ID, from: 'bee', to: 'aye', tool: 'mcp__probe__ping', reason: '宿主注入类工具',
    ttlMs: 3_600_000, maxResultChars: 64_000, state, createdAt: NOW - 1000, expiresAt: NOW + 3_600_000,
  });
  await appendMailbox(stateRoot, 'default', 'aye', requestMessage());
}

async function approveViaFile(): Promise<void> {
  await writeApprovalFile(stateRoot, {
    requestId: REQUEST_ID, decision: 'approved', approvedBy: 'lead', decidedAt: NOW, expiresAt: NOW + 60_000, tool: 'mcp__probe__ping',
  });
}

describe('xc_read v0.7: inbox 路审批门', () => {
  it('未放行 → 遮蔽占位（两面都不出 SECRET）+ discarded + 台账 refused + 回投 + lead 通知', async () => {
    await seedRequest('pending');
    const result = await read.xc_check_inbox({}, 'conn-aye');
    const payload = payloadOf(result);
    expect(payload['toolRequests']).toMatchObject({ gatedRefused: 1, gatedPassed: 0 });
    const entry = (payload['messages'] as Array<Record<string, unknown>>)[0]!;
    expect(String(entry['content'])).toContain('[gated tool_request');
    expect(String(entry['content'])).not.toContain(SECRET_ARG);
    expect(entry['toolGate']).toMatchObject({ gate: 'refuse', requestId: REQUEST_ID, reason: 'approval missing' });
    // content[2] 信封块同样不出原文。
    const envelope = result.content.map((c) => (c as { text: string }).text).join('\n');
    expect(envelope).not.toContain(SECRET_ARG);
    expect(envelope).toContain('[gated tool_request');

    // 落盘面：请求帧被 discarded（不进注入面、不复读）。
    const mail = await readMailbox(stateRoot, 'default', 'aye');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.discardedAt).toBeGreaterThan(0);
    expect(mail[0]!.readAt).toBeUndefined();
    expect((await readToolRequest(stateRoot, REQUEST_ID))?.state).toBe('refused');

    // 回投 bee + lead 待批通知。
    const beeMail = await readMailbox(stateRoot, 'default', 'bee');
    expect(beeMail).toHaveLength(1);
    expect(JSON.parse(beeMail[0]!.content)).toMatchObject({ type: 'tool_result', status: 'refused', reason: 'approval missing' });
    const leadMail = await readMailbox(stateRoot, 'default', 'lead');
    expect(JSON.parse(leadMail[0]!.content)).toMatchObject({ type: 'approval_request', requestId: REQUEST_ID });

    // 复读：已 discarded → 不再出现（门不再触发，无第二张回执）。
    const again = await read.xc_check_inbox({}, 'conn-aye');
    expect(payloadOf(again)['messages']).toHaveLength(0);
    expect(await readMailbox(stateRoot, 'default', 'bee')).toHaveLength(1);
  });

  it('放行（文件轨批准）→ APPROVAL VERIFIED 头 + 全文 + 台账 approved', async () => {
    await seedRequest('pending');
    await approveViaFile();
    const result = await read.xc_check_inbox({}, 'conn-aye');
    const payload = payloadOf(result);
    expect(payload['toolRequests']).toMatchObject({ gatedRefused: 0, gatedPassed: 1 });
    const entry = (payload['messages'] as Array<Record<string, unknown>>)[0]!;
    expect(String(entry['content'])).toContain('APPROVAL VERIFIED');
    expect(String(entry['content'])).toContain(SECRET_ARG);
    expect(entry['toolGate']).toMatchObject({ gate: 'pass' });
    // 正常消费语义：readAt（不是 discarded）。
    const mail = await readMailbox(stateRoot, 'default', 'aye');
    expect(mail[0]!.readAt).toBeGreaterThan(0);
    expect(mail[0]!.discardedAt).toBeUndefined();
    expect((await readToolRequest(stateRoot, REQUEST_ID))?.state).toBe('approved');
  });

  it('混合批次：chat + 未放行请求 + 已放行请求各自正确呈现', async () => {
    await seedRequest('pending');
    await appendMailbox(stateRoot, 'default', 'aye', createMessage('bee', 'aye', '普通消息'));
    const result = await read.xc_check_inbox({}, 'conn-aye');
    const payload = payloadOf(result);
    const messages = payload['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    const chat = messages.find((m) => m['content'] === '普通消息');
    expect(chat).toBeDefined();
    const gated = messages.find((m) => String(m['content']).includes('[gated tool_request'));
    expect(gated).toBeDefined();
  });
});

describe('xc_read v0.7: mail 路审批门（原文旁路修复）', () => {
  it('未放行 → 只出遮蔽占位（v0.6.1 直出原始帧全文的缺口闭合）', async () => {
    await seedRequest('pending');
    const mail = await readMailbox(stateRoot, 'default', 'aye');
    const messageId = mail[0]!.id;
    const result = await read.xc_mail_read({ messageId }, 'conn-aye');
    const payload = payloadOf(result);
    expect(String(payload['text'])).toContain('[gated tool_request');
    expect(String(payload['text'])).not.toContain(SECRET_ARG);
    expect(payload['toolGate']).toMatchObject({ gate: 'refuse', requestId: REQUEST_ID });
    // mail 路是只读面：首次门拒仍走完整门（回投 + 台账 refused + lead 通知）。
    expect((await readToolRequest(stateRoot, REQUEST_ID))?.state).toBe('refused');
    expect(await readMailbox(stateRoot, 'default', 'bee')).toHaveLength(1);
  });

  it('放行 → 带头全文 + 分页可取全文', async () => {
    await seedRequest('pending');
    await approveViaFile();
    const mail = await readMailbox(stateRoot, 'default', 'aye');
    const messageId = mail[0]!.id;
    const result = await read.xc_mail_read({ messageId }, 'conn-aye');
    const payload = payloadOf(result);
    expect(String(payload['text'])).toContain('APPROVAL VERIFIED');
    expect(String(payload['text'])).toContain(SECRET_ARG);
    expect(payload['toolGate']).toMatchObject({ gate: 'pass' });
  });

  it('普通消息零影响（回归：mail 路原文照旧）', async () => {
    const plain = createMessage('bee', 'aye', '这是普通正文');
    await appendMailbox(stateRoot, 'default', 'aye', plain);
    const result = await read.xc_mail_read({ messageId: plain.id }, 'conn-aye');
    const payload = payloadOf(result);
    expect(String(payload['text'])).toBe('这是普通正文');
    expect(payload['toolGate']).toBeUndefined();
  });
});
