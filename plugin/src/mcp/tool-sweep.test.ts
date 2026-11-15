/**
 * v0.7 C6/C7（M3）单测：sweepToolRequestsOnce——转办台账节拍（DESIGN-V0.7 §2.5/§2.6/§3.3）。
 *
 * 覆盖面：
 * - 过期：pending/approved 超期 → 台账 expired + 回投请求方 tool_result{refused,
 *   "request expired"} + 审计 tool-expired；
 * - lead 收过 approval_request 通知（approvalNotifiedAt 在场）→ 补 approval_result
 *   {decision:"expired"} 收尾；
 * - 未到期/终态不动；
 * - 清理：终态超 7 天删台账 + 审批文件；窗口内不动（审计 tool-artifacts-cleaned）；
 * - 永不抛出：坏状态根 → 零计数（与 sweepStaleTasksOnce 同纪律）。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepToolRequestsOnce } from './task-edges.js';
import { createToolRequest, readToolRequest, TOOL_APPROVAL_KEEP_MS, type ToolRequestLedger } from '../core/toolledger.js';
import { writeApprovalFile } from '../core/toolapproval.js';
import { newTeamState, writeTeam } from '../core/teamstate.js';
import { readMailbox } from '../core/mailbox.js';
import { approvalsFile, engineLogFile, toolRequestFile } from '../core/paths.js';
import { readJsonl } from '../core/jsonl.js';

let stateRoot: string;

const NOW = 5_000_000;

beforeEach(async () => {
  stateRoot = join(mkdtempSync(join(tmpdir(), 'xc-tool-sweep-')), '.crosschat');
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

function ledger(overrides: Partial<ToolRequestLedger>): ToolRequestLedger {
  return {
    requestId: 'r',
    from: 'bee',
    to: 'aye',
    tool: 'mcp__probe__ping',
    reason: 'why',
    ttlMs: 3_600_000,
    maxResultChars: 64_000,
    state: 'pending',
    createdAt: NOW,
    expiresAt: NOW + 3_600_000,
    ...overrides,
  };
}

const deps = () => ({ stateRoot, workspace: stateRoot, env: {} });

async function events(): Promise<Array<Record<string, unknown>>> {
  return readJsonl<Record<string, unknown>>(engineLogFile(stateRoot), (v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

describe('sweepToolRequestsOnce v0.7: 过期', () => {
  it('pending 超期 → expired + 回投请求方 + 审计', async () => {
    await createToolRequest(stateRoot, ledger({ requestId: 'r-old', expiresAt: NOW - 1 }));
    const out = await sweepToolRequestsOnce(deps(), NOW);
    expect(out.expired).toBe(1);
    expect((await readToolRequest(stateRoot, 'r-old'))?.state).toBe('expired');
    const beeMail = await readMailbox(stateRoot, 'default', 'bee');
    expect(beeMail).toHaveLength(1);
    expect(JSON.parse(beeMail[0]!.content)).toMatchObject({ type: 'tool_result', status: 'refused', reason: 'request expired', from: 'aye' });
    const log = await events();
    expect(log.some((e) => e['event'] === 'tool-expired' && e['requestId'] === 'r-old')).toBe(true);
  });

  it('lead 收过待批通知 → approval_result{expired} 收尾', async () => {
    await createToolRequest(stateRoot, ledger({ requestId: 'r-notified', expiresAt: NOW - 1, approvalNotifiedAt: NOW - 5000 }));
    await sweepToolRequestsOnce(deps(), NOW);
    const leadMail = await readMailbox(stateRoot, 'default', 'lead');
    expect(leadMail).toHaveLength(1);
    expect(JSON.parse(leadMail[0]!.content)).toMatchObject({ type: 'approval_result', decision: 'expired' });
    const log = await events();
    expect(log.some((e) => e['event'] === 'tool-approval-request' && e['closedAs'] === 'expired')).toBe(true);
  });

  it('未通知过 lead 的不发收尾帧', async () => {
    await createToolRequest(stateRoot, ledger({ requestId: 'r-quiet', expiresAt: NOW - 1 }));
    await sweepToolRequestsOnce(deps(), NOW);
    expect(await readMailbox(stateRoot, 'default', 'lead')).toHaveLength(0);
  });

  it('approved 超期同样过期（执行窗随请求窗关闭）；未到期不动；终态不动', async () => {
    await createToolRequest(stateRoot, ledger({ requestId: 'r-appr', state: 'approved', expiresAt: NOW - 1 }));
    await createToolRequest(stateRoot, ledger({ requestId: 'r-live' }));
    await createToolRequest(stateRoot, ledger({ requestId: 'r-done', state: 'executed', expiresAt: NOW - 1 }));
    const out = await sweepToolRequestsOnce(deps(), NOW);
    expect(out.expired).toBe(1);
    expect((await readToolRequest(stateRoot, 'r-appr'))?.state).toBe('expired');
    expect((await readToolRequest(stateRoot, 'r-live'))?.state).toBe('pending');
    expect((await readToolRequest(stateRoot, 'r-done'))?.state).toBe('executed');
  });
});

describe('sweepToolRequestsOnce v0.7: 终态清理', () => {
  it('终态超 7 天删台账+审批文件并审计；窗口内不动', async () => {
    const old = NOW - TOOL_APPROVAL_KEEP_MS - 1;
    await createToolRequest(stateRoot, ledger({ requestId: 'r-old', state: 'executed', decidedAt: old }));
    await writeApprovalFile(stateRoot, {
      requestId: 'r-old', decision: 'approved', approvedBy: 'lead', decidedAt: old, expiresAt: old + 1, tool: 'mcp__probe__ping',
    });
    await createToolRequest(stateRoot, ledger({ requestId: 'r-fresh', state: 'refused', decidedAt: NOW - 1000 }));
    const out = await sweepToolRequestsOnce(deps(), NOW);
    expect(out.cleanedLedgers).toBe(1);
    expect(out.cleanedApprovals).toBe(1);
    expect(existsSync(toolRequestFile(stateRoot, 'r-old'))).toBe(false);
    expect(existsSync(approvalsFile(stateRoot, 'r-old'))).toBe(false);
    expect(existsSync(toolRequestFile(stateRoot, 'r-fresh'))).toBe(true);
    const log = await events();
    expect(log.some((e) => e['event'] === 'tool-artifacts-cleaned')).toBe(true);
  });

  it('无台账目录 → 零成本（不炸）', async () => {
    expect(await sweepToolRequestsOnce(deps(), NOW)).toEqual({ expired: 0, cleanedLedgers: 0, cleanedApprovals: 0 });
  });

  it('永不抛出：状态根不可用（目录被文件占用）→ 零计数', async () => {
    const broken = join(mkdtempSync(join(tmpdir(), 'xc-tool-sweep-broken-')), '.crosschat');
    writeFileSync(broken, 'not a directory');
    const out = await sweepToolRequestsOnce({ stateRoot: broken, workspace: broken, env: {} }, NOW);
    expect(out).toEqual({ expired: 0, cleanedLedgers: 0, cleanedApprovals: 0 });
    rmSync(join(broken, '..'), { recursive: true, force: true });
  });
});

// 编译期引用守卫：approvalsDir 未直接用于本测试（经 approvalsFile 间接覆盖）。
void mkdirSync;
