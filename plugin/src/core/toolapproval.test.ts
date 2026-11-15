/**
 * v0.7 C7（M3）单测：core/toolapproval.ts —— 审批授权文件读写与校验纯函数。
 *
 * 覆盖面（DESIGN-V0.7 §2.3 + E4 §6.4 实测三形态的确定性化）：
 * - readApprovalFile：missing / malformed（不可解析 JSON 与形状不符）/ ok；
 * - override 路径逃出状态根 → malformed（fail-closed）；
 * - checkApproval 全矩阵：缺失/畸形/denied/自批（from 或 to）/工具不符/过期/
 *   批准窗超出请求窗 → 放行；
 * - writeApprovalFile：原子落地 + 返回路径；approvalFileExists；
 * - isWithinStateRoot  containment。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalFileExists,
  buildApprovalFile,
  checkApproval,
  isWithinStateRoot,
  readApprovalFile,
  writeApprovalFile,
  type ApprovalFile,
  type ApprovalRequestView,
} from './toolapproval.js';
import { approvalsFile } from './paths.js';

let stateRoot: string;

beforeEach(() => {
  stateRoot = resolve(join(mkdtempSync(join(tmpdir(), 'xc-toolapproval-')), '.crosschat'));
});

afterEach(() => {
  rmSync(join(stateRoot, '..'), { recursive: true, force: true });
});

const NOW = 1_000_000;

const request: ApprovalRequestView = {
  requestId: 'r-001',
  tool: 'mcp__probe__ping',
  from: 'bee',
  to: 'aye',
  expiresAt: NOW + 3_600_000,
};

function approval(overrides: Partial<ApprovalFile> = {}): ApprovalFile {
  return {
    requestId: 'r-001',
    decision: 'approved',
    approvedBy: 'lead',
    decidedAt: NOW - 1000,
    expiresAt: NOW + 60_000,
    tool: 'mcp__probe__ping',
    ...overrides,
  };
}

async function writeRaw(content: string, requestId = 'r-001'): Promise<void> {
  mkdirSync(join(stateRoot, 'approvals'), { recursive: true });
  writeFileSync(approvalsFile(stateRoot, requestId), content);
}

describe('toolapproval v0.7: 读取三态', () => {
  it('missing → {status:"missing"}', async () => {
    expect(await readApprovalFile(stateRoot, 'r-001')).toEqual({ status: 'missing' });
  });

  it('不可解析 JSON → malformed (unparseable JSON)（E4 §6.4 实测形态）', async () => {
    await writeRaw('{"requestId":"r-001","decisi');
    const read = await readApprovalFile(stateRoot, 'r-001');
    expect(read).toEqual({ status: 'malformed', reason: 'approval file malformed (unparseable JSON)' });
  });

  it('可解析但形状不符 / requestId 与文件名不一致 → malformed', async () => {
    await writeRaw(JSON.stringify({ requestId: 'r-001' }));
    expect((await readApprovalFile(stateRoot, 'r-001')).status).toBe('malformed');
    await writeRaw(JSON.stringify(approval({ requestId: 'r-other' })));
    expect((await readApprovalFile(stateRoot, 'r-001')).status).toBe('malformed');
  });

  it('ok 态原样返回', async () => {
    await writeRaw(JSON.stringify(approval()));
    const read = await readApprovalFile(stateRoot, 'r-001');
    expect(read.status).toBe('ok');
    if (read.status === 'ok') expect(read.approval.approvedBy).toBe('lead');
  });

  it('override 路径逃出状态根 → malformed（fail-closed；授予理由见词表）', async () => {
    const outside = join(stateRoot, '..', 'evil.json');
    writeFileSync(outside, JSON.stringify(approval()));
    const read = await readApprovalFile(stateRoot, 'r-001', outside);
    expect(read).toEqual({ status: 'malformed', reason: 'approval file outside state root' });
  });

  it('override 路径在状态根内正常读', async () => {
    const inside = join(stateRoot, 'approvals', 'custom.json');
    mkdirSync(join(stateRoot, 'approvals'), { recursive: true });
    writeFileSync(inside, JSON.stringify(approval()));
    expect((await readApprovalFile(stateRoot, 'r-001', inside)).status).toBe('ok');
  });
});

describe('toolapproval v0.7: 校验全矩阵', () => {
  it('有效批准 → ok', () => {
    expect(checkApproval({ status: 'ok', approval: approval() }, request, NOW)).toEqual({ ok: true });
  });

  it('缺失 / 畸形 / denied / 自批 / 工具不符 / 过期 / 窗口越界', () => {
    const cases: Array<[Parameters<typeof checkApproval>[0], string]> = [
      [{ status: 'missing' }, 'approval missing'],
      [{ status: 'malformed', reason: 'approval file malformed (unparseable JSON)' }, 'approval file malformed (unparseable JSON)'],
      [{ status: 'ok', approval: approval({ decision: 'denied' }) }, 'approval denied'],
      [{ status: 'ok', approval: approval({ approvedBy: 'bee' }) }, 'self-approval refused'],
      [{ status: 'ok', approval: approval({ approvedBy: 'aye' }) }, 'self-approval refused'],
      [{ status: 'ok', approval: approval({ tool: 'mcp__other__x' }) }, 'approval tool mismatch'],
      [{ status: 'ok', approval: approval({ expiresAt: NOW }) }, 'approval expired'],
      [{ status: 'ok', approval: approval({ expiresAt: NOW - 1 }) }, 'approval expired'],
      [{ status: 'ok', approval: approval({ expiresAt: request.expiresAt + 1 }) }, 'approval window exceeds request ttl'],
    ];
    for (const [read, reason] of cases) {
      const verdict = checkApproval(read, request, NOW);
      expect(verdict.ok, reason).toBe(false);
      if (!verdict.ok) expect(verdict.reason, reason).toBe(reason);
    }
  });

  it('批准窗恰等于请求窗边界 → ok（≤ 请求窗）', () => {
    expect(checkApproval({ status: 'ok', approval: approval({ expiresAt: request.expiresAt }) }, request, NOW).ok).toBe(true);
  });
});

describe('toolapproval v0.7: 写入与 containment', () => {
  it('writeApprovalFile 原子落地 + 返回路径；approvalFileExists', async () => {
    const file = await writeApprovalFile(stateRoot, approval());
    expect(file).toBe(approvalsFile(stateRoot, 'r-001'));
    expect(existsSync(file)).toBe(true);
    expect(await approvalFileExists(stateRoot, 'r-001')).toBe(true);
    expect(await approvalFileExists(stateRoot, 'r-zzz')).toBe(false);
    expect(await approvalFileExists(stateRoot, 'r-001', join(stateRoot, 'approvals', 'custom.json'))).toBe(false);
  });

  it('buildApprovalFile 字段与 note 可选', () => {
    expect(buildApprovalFile({ requestId: 'r', decision: 'denied', approvedBy: 'x', decidedAt: 1, expiresAt: 2, tool: 't' }))
      .toEqual({ requestId: 'r', decision: 'denied', approvedBy: 'x', decidedAt: 1, expiresAt: 2, tool: 't' });
    expect(buildApprovalFile({ requestId: 'r', decision: 'approved', approvedBy: 'x', decidedAt: 1, expiresAt: 2, tool: 't', note: 'n' }).note).toBe('n');
  });

  it('isWithinStateRoot：根内/根自身/相对路径/逃逸', () => {
    expect(isWithinStateRoot(stateRoot, approvalsFile(stateRoot, 'r'))).toBe(true);
    expect(isWithinStateRoot(stateRoot, stateRoot)).toBe(true);
    expect(isWithinStateRoot(stateRoot, 'approvals/r.json')).toBe(false);
    expect(isWithinStateRoot(stateRoot, join(stateRoot, '..', 'evil.json'))).toBe(false);
  });
});
