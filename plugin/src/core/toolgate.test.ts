/**
 * v0.7 C6/C7（M2）单测：core/toolgate.ts —— 审批门七步校验 + 共享渲染门。
 *
 * 覆盖面（DESIGN-V0.7 §2.7 + E4 §6.4 失败模式全表）：
 * - 非 tool_request 帧早返回原路径（零影响）；
 * - 台账缺失（fail-closed）/ 目标不符 / 请求方不符 → 遮蔽 + 审计；
 * - 请求过期 → expired 迁移 + 回投请求方；
 * - denied/refused 既往态 → 渲染-only（不重复回投）；
 * - executed/error → 放行（带头全文）；
 * - pending + 审批缺失 → 首拒侧效应三连（回投 + 台账 refused + lead 待批通知）；
 * - pending + 有效审批文件（文件轨）→ 放行 + 台账 approved；
 * - pending + 自批/畸形/过期/工具不符审批 → 对应 reason 首拒；
 * - approved 后审批失效 → 渲染-only（不迁移不重复回投）；
 * - 遮蔽占位不含请求正文（安全方向）；复读不产生第二张回执（防回投风暴）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateToolRequestRender, maskedToolRequestText, approvedToolRequestText } from './toolgate.js';
import { createToolRequest, readToolRequest, type ToolRequestLedger } from './toolledger.js';
import { writeApprovalFile, type ApprovalFile } from './toolapproval.js';
import { newTeamState, writeTeam } from './teamstate.js';
import { appendMailbox, createMessage, readMailbox } from './mailbox.js';
import { readJsonl } from './jsonl.js';
import type { TeamMessage } from './types.js';

let stateRoot: string;

const NOW = 1_000_000;
const REQUEST_ID = 'r-001';
const SECRET_ARG = 'SUPER-SECRET-ARG-VALUE';

beforeEach(async () => {
  stateRoot = join(mkdtempSync(join(tmpdir(), 'xc-toolgate-')), '.crosschat');
  const team = newTeamState({ teamId: 'default', founderKey: 'bee', now: NOW });
  team.members.push(
    { key: 'bee', sessionId: 'sess_bee', role: 'peer', joinedAt: NOW, lastSeen: NOW },
    { key: 'aye', sessionId: 'sess_aye', role: 'worker', joinedAt: NOW, lastSeen: NOW },
    { key: 'lead', sessionId: 'sess_lead', role: 'peer', joinedAt: NOW, lastSeen: NOW },
  );
  team.leadKey = 'lead';
  await writeTeam(stateRoot, team);
});

afterEach(() => {
  rmSync(join(stateRoot, '..'), { recursive: true, force: true });
});

function toolRequestMessage(overrides: Record<string, unknown> = {}): TeamMessage {
  return createMessage('bee', 'aye', JSON.stringify({
    type: 'tool_request',
    requestId: REQUEST_ID,
    from: 'bee',
    tool: 'mcp__probe__ping',
    args: { token: SECRET_ARG },
    reason: '宿主注入类工具，B 侧不可达',
    approval: { required: true },
    ...overrides,
  }));
}

async function seedLedger(overrides: Partial<ToolRequestLedger> = {}): Promise<void> {
  await createToolRequest(stateRoot, {
    requestId: REQUEST_ID,
    from: 'bee',
    to: 'aye',
    tool: 'mcp__probe__ping',
    reason: '宿主注入类工具，B 侧不可达',
    ttlMs: 3_600_000,
    maxResultChars: 64_000,
    state: 'pending',
    createdAt: NOW - 10_000,
    expiresAt: NOW + 3_600_000,
    ...overrides,
  });
}

function ctx(now = NOW, readerKey = 'aye') {
  return { stateRoot, teamId: 'default', readerKey, now };
}

async function approvalFile(overrides: Partial<ApprovalFile> = {}): Promise<void> {
  await writeApprovalFile(stateRoot, {
    requestId: REQUEST_ID,
    decision: 'approved',
    approvedBy: 'lead',
    decidedAt: NOW - 5_000,
    expiresAt: NOW + 60_000,
    tool: 'mcp__probe__ping',
    ...overrides,
  });
}

async function receiptsIn(mailbox: string): Promise<Array<Record<string, unknown>>> {
  return (await readMailbox(stateRoot, 'default', mailbox))
    .map((m) => { try { return JSON.parse(m.content) as Record<string, unknown>; } catch { return {}; } })
    .filter((f) => f['type'] === 'tool_result' || f['type'] === 'approval_result' || f['type'] === 'approval_request');
}

describe('toolgate v0.7: 早返回与 fail-closed', () => {
  it('非 tool_request 帧原样透传（chat/其他协议帧零影响）', async () => {
    const chat = createMessage('bee', 'aye', '普通消息');
    const result = await gateToolRequestRender(chat, ctx());
    expect(result).toEqual({ gate: 'pass', text: '普通消息', transitioned: false });
    const otherFrame = createMessage('bee', 'aye', JSON.stringify({ type: 'task-receipt', taskId: 't1' }));
    expect((await gateToolRequestRender(otherFrame, ctx())).text).toContain('task-receipt');
  });

  it('台账缺失 → 遮蔽 + 回投信封 from + 审计（fail-closed）', async () => {
    const message = toolRequestMessage({ requestId: 'r-ghost' });
    const result = await gateToolRequestRender(message, ctx());
    expect(result.gate).toBe('refuse');
    expect(result.reason).toBe('request ledger missing');
    expect(result.text).not.toContain(SECRET_ARG);
    const receipts = await receiptsIn('bee');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ type: 'tool_result', status: 'refused', reason: 'request ledger missing', from: 'aye' });
    const events = await readJsonl<{ event: string }>(join(stateRoot, 'logs', 'engine.jsonl'), (v): v is { event: string } => typeof v === 'object' && v !== null && typeof (v as { event?: unknown }).event === 'string');
    expect(events.some((e) => e.event === 'tool-decision')).toBe(true);
  });

  it('读取者不是台账指定的执行方 → ledger target mismatch（无回投）', async () => {
    await seedLedger();
    const result = await gateToolRequestRender(toolRequestMessage(), ctx(NOW, 'bee'));
    expect(result.reason).toBe('ledger target mismatch');
    expect(await receiptsIn('bee')).toHaveLength(0);
  });

  it('帧 from 与台账 from 不符 → request from mismatch（防篡改）', async () => {
    await seedLedger();
    const result = await gateToolRequestRender(toolRequestMessage({ from: 'ghost' }), ctx());
    expect(result.reason).toBe('request from mismatch');
    expect(result.text).not.toContain(SECRET_ARG);
  });

  it('帧畸形（不可解析/缺字段）→ 遮蔽 + 审计', async () => {
    const broken = createMessage('bee', 'aye', JSON.stringify({ type: 'tool_request', requestId: 42 }));
    const result = await gateToolRequestRender(broken, ctx());
    expect(result.gate).toBe('refuse');
    expect(result.reason).toBe('request frame malformed (unparseable JSON)');
  });
});

describe('toolgate v0.7: 过期与既往拒绝态', () => {
  it('请求过期 → expired 迁移 + 回投 request expired', async () => {
    await seedLedger({ expiresAt: NOW - 1 });
    const result = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(result.gate).toBe('refuse');
    expect(result.reason).toBe('request expired');
    expect(result.state).toBe('expired');
    expect((await readToolRequest(stateRoot, REQUEST_ID))?.state).toBe('expired');
    const receipts = await receiptsIn('bee');
    expect(receipts[0]).toMatchObject({ type: 'tool_result', status: 'refused', reason: 'request expired' });
  });

  it('denied → approval denied（渲染-only）', async () => {
    await seedLedger({ state: 'denied' });
    const result = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(result.gate).toBe('refuse');
    expect(result.reason).toBe('approval denied');
    expect(result.transitioned).toBe(false);
    expect(await receiptsIn('bee')).toHaveLength(0);
  });

  it('refused → 用台账 decisionReason 复述（渲染-only，不重复回投）', async () => {
    await seedLedger({ state: 'refused', decisionReason: 'approval expired' });
    const result = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(result.reason).toBe('approval expired');
    expect(await receiptsIn('bee')).toHaveLength(0);
  });

  it('executed/error → 放行（带头全文；回投已发生）', async () => {
    await seedLedger({ state: 'executed', decidedBy: 'lead' });
    const result = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(result.gate).toBe('pass');
    expect(result.text).toContain('APPROVAL VERIFIED');
    expect(result.text).toContain(SECRET_ARG);
    expect(result.transitioned).toBe(false);
  });
});

describe('toolgate v0.7: 审批缺失首拒三连', () => {
  it('pending + 无审批文件 → 回投 + 台账 refused + lead 待批通知（一次性）', async () => {
    await seedLedger();
    const first = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(first.gate).toBe('refuse');
    expect(first.reason).toBe('approval missing');
    expect(first.state).toBe('refused');
    expect(first.transitioned).toBe(true);
    expect(first.text).not.toContain(SECRET_ARG);

    const ledger = await readToolRequest(stateRoot, REQUEST_ID);
    expect(ledger?.state).toBe('refused');
    expect(ledger?.decidedBy).toBe('gate');
    expect(ledger?.approvalNotifiedAt).toBe(NOW);

    // 回执给 bee（tool_result refused），通知给 lead（approval_request）。
    const beeReceipts = await receiptsIn('bee');
    expect(beeReceipts).toHaveLength(1);
    expect(beeReceipts[0]).toMatchObject({ type: 'tool_result', status: 'refused', reason: 'approval missing', from: 'aye' });
    const leadNotes = await receiptsIn('lead');
    expect(leadNotes).toHaveLength(1);
    expect(leadNotes[0]).toMatchObject({ type: 'approval_request', requestId: REQUEST_ID, from: 'bee', tool: 'mcp__probe__ping' });
    expect(String(leadNotes[0]!['approveHow'])).toContain('xc_review');

    // 复读（mail 路可重复触发）：渲染-only，无第二张回执、无第二个 lead 通知。
    const second = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(second.gate).toBe('refuse');
    expect(second.transitioned).toBe(false);
    expect(await receiptsIn('bee')).toHaveLength(1);
    expect(await receiptsIn('lead')).toHaveLength(1);
  });

  it('自批（approvedBy=from）→ self-approval refused 首拒', async () => {
    await seedLedger();
    await approvalFile({ approvedBy: 'bee' });
    const result = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(result.reason).toBe('self-approval refused');
    expect((await readToolRequest(stateRoot, REQUEST_ID))?.state).toBe('refused');
  });

  it('畸形审批（截断 JSON）→ approval file malformed (unparseable JSON)', async () => {
    await seedLedger();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { approvalsFile } = await import('./paths.js');
    mkdirSync(join(stateRoot, 'approvals'), { recursive: true });
    writeFileSync(approvalsFile(stateRoot, REQUEST_ID), '{"requestId":"r-001","decisi');
    const result = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(result.reason).toBe('approval file malformed (unparseable JSON)');
  });

  it('审批过期 / 工具不符 → 对应 reason', async () => {
    await seedLedger();
    await approvalFile({ expiresAt: NOW - 1 });
    expect((await gateToolRequestRender(toolRequestMessage(), ctx())).reason).toBe('approval expired');
    await approvalFile({ expiresAt: NOW + 60_000, tool: 'mcp__other__x' });
    // 上一次已 refused；重置台账再测工具不符。
    const { createToolRequest } = await import('./toolledger.js');
    await createToolRequest(stateRoot, {
      requestId: 'r-002', from: 'bee', to: 'aye', tool: 'mcp__probe__ping', reason: 'x',
      ttlMs: 3_600_000, maxResultChars: 64_000, state: 'pending', createdAt: NOW, expiresAt: NOW + 3_600_000,
    });
    await writeApprovalFile(stateRoot, {
      requestId: 'r-002', decision: 'approved', approvedBy: 'lead', decidedAt: NOW, expiresAt: NOW + 60_000, tool: 'mcp__other__x',
    });
    const result = await gateToolRequestRender(toolRequestMessage({ requestId: 'r-002' }), ctx());
    expect(result.reason).toBe('approval tool mismatch');
  });
});

describe('toolgate v0.7: 文件轨放行', () => {
  it('pending + 有效审批文件 → 放行 + 台账 approved（门放行≥1 次）', async () => {
    await seedLedger();
    await approvalFile();
    const result = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(result.gate).toBe('pass');
    expect(result.state).toBe('approved');
    expect(result.transitioned).toBe(true);
    expect(result.text).toContain('APPROVAL VERIFIED');
    expect(result.text).toContain('approvedBy=lead');
    expect(result.text).toContain(SECRET_ARG);
    const ledger = await readToolRequest(stateRoot, REQUEST_ID);
    expect(ledger?.state).toBe('approved');
    expect(ledger?.decidedBy).toBe('lead');
    expect(await receiptsIn('bee')).toHaveLength(0);
  });

  it('approved 后审批文件过期 → 渲染-only 拒绝（不迁移、不重复回投）', async () => {
    await seedLedger({ state: 'approved', decidedBy: 'lead' });
    await approvalFile({ expiresAt: NOW - 1 });
    const result = await gateToolRequestRender(toolRequestMessage(), ctx());
    expect(result.gate).toBe('refuse');
    expect(result.reason).toBe('approval expired');
    expect(result.transitioned).toBe(false);
    expect((await readToolRequest(stateRoot, REQUEST_ID))?.state).toBe('approved');
    expect(await receiptsIn('bee')).toHaveLength(0);
  });

  it('复读放行态 → 不再迁移（transitioned=false）', async () => {
    await seedLedger();
    await approvalFile();
    expect((await gateToolRequestRender(toolRequestMessage(), ctx())).transitioned).toBe(true);
    expect((await gateToolRequestRender(toolRequestMessage(), ctx())).transitioned).toBe(false);
  });
});

describe('toolgate v0.7: 渲染文本构建器', () => {
  it('遮蔽占位带 requestId/state/reason 且不含正文', () => {
    const text = maskedToolRequestText('r-1', 'refused', 'approval missing');
    expect(text).toBe('[gated tool_request r-1: state=refused —— 未放行，正文不可见（approval missing）]');
    expect(text).not.toContain(SECRET_ARG);
  });

  it('放行头 + 全文', () => {
    const text = approvedToolRequestText('r-1', 'mcp__probe__ping', 'lead', 'BODY');
    expect(text.startsWith('[CrossChat APPROVAL VERIFIED requestId=r-1 tool=mcp__probe__ping approvedBy=lead')).toBe(true);
    expect(text.endsWith('BODY')).toBe(true);
  });

  it('自定义审批文件路径（同状态根）被门采纳', async () => {
    await seedLedger();
    const custom = join(stateRoot, 'approvals', 'custom-name.json');
    await writeApprovalFile(stateRoot, {
      requestId: 'r-003', decision: 'approved', approvedBy: 'lead', decidedAt: NOW, expiresAt: NOW + 60_000, tool: 'mcp__probe__ping',
    }, custom);
    await createToolRequest(stateRoot, {
      requestId: 'r-003', from: 'bee', to: 'aye', tool: 'mcp__probe__ping', reason: 'x',
      ttlMs: 3_600_000, maxResultChars: 64_000, approvalFile: custom,
      state: 'pending', createdAt: NOW, expiresAt: NOW + 3_600_000,
    });
    const result = await gateToolRequestRender(toolRequestMessage({ requestId: 'r-003' }), ctx());
    expect(result.gate).toBe('pass');
  });
});

// 供 receiptsIn 兜底：确认邮箱追加助手未被误用（编译期引用）。
void appendMailbox;
