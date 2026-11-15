/**
 * v0.7 C6（M2）单测：core/toolledger.ts —— 转办台账读写/状态机/过期/清理。
 *
 * 覆盖面（DESIGN-V0.7 §2.5/§3.3）：
 * - createToolRequest：建账（pending + expiresAt=createdAt+ttl）；requestId 占用即拒
 *   （OS 独占创建 wx 的查建原子化）；
 * - readToolRequest：缺失 → undefined；坏 JSON/形状不符 → undefined + 审计（门 fail-closed）；
 * - updateToolRequest：读改写迁移；mutate 放弃 → 原样返回；
 * - expireToolRequests：pending/approved 超期标 expired；未到期不动；终态不动；
 * - cleanupToolArtifacts：终态保留 7 天后删台账+审批文件；在途不动；孤儿审批文件清；
 * - listPendingToolRequests / TERMINAL_TOOL_STATES / isGatePassState 词表。
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TOOL_APPROVAL_KEEP_MS,
  cleanupToolArtifacts,
  createToolRequest,
  expireToolRequests,
  isGatePassState,
  isTerminalToolState,
  listPendingToolRequests,
  listToolRequests,
  readToolRequest,
  transitionToolRequest,
  updateToolRequest,
  type ToolRequestLedger,
} from './toolledger.js';
import { approvalsFile, toolRequestFile } from './paths.js';
import { readJsonl } from './jsonl.js';

let stateRoot: string;

beforeEach(() => {
  stateRoot = join(mkdtempSync(join(tmpdir(), 'xc-tooledger-')), '.crosschat');
});

afterEach(() => {
  rmSync(join(stateRoot, '..'), { recursive: true, force: true });
});

function ledger(overrides: Partial<ToolRequestLedger> = {}): ToolRequestLedger {
  const now = 1_000_000;
  return {
    requestId: 'r-001',
    from: 'bee',
    to: 'aye',
    tool: 'mcp__probe__ping',
    reason: 'why',
    ttlMs: 3_600_000,
    maxResultChars: 64_000,
    state: 'pending',
    createdAt: now,
    expiresAt: now + 3_600_000,
    ...overrides,
  };
}

describe('toolledger v0.7: 建账与读取', () => {
  it('createToolRequest 落盘 pending + expiresAt；重复 requestId 占用即拒', async () => {
    await createToolRequest(stateRoot, ledger());
    const read = await readToolRequest(stateRoot, 'r-001');
    expect(read).toMatchObject({ requestId: 'r-001', from: 'bee', to: 'aye', state: 'pending', expiresAt: 1_000_000 + 3_600_000 });
    await expect(createToolRequest(stateRoot, ledger())).rejects.toThrow(/requestId-in-use/);
  });

  it('readToolRequest：缺失 → undefined；坏 JSON → undefined + 审计（fail-closed 数据面）', async () => {
    expect(await readToolRequest(stateRoot, 'nope')).toBeUndefined();
    mkdirSync(join(stateRoot, 'toolrequests'), { recursive: true });
    writeFileSync(toolRequestFile(stateRoot, 'r-bad'), '{truncated');
    expect(await readToolRequest(stateRoot, 'r-bad')).toBeUndefined();
    const events = await readJsonl<{ event: string }>(join(stateRoot, 'logs', 'engine.jsonl'), (v): v is { event: string } => typeof v === 'object' && v !== null && typeof (v as { event?: unknown }).event === 'string');
    expect(events.some((e) => e.event === 'tool-ledger-unreadable')).toBe(true);
  });

  it('形状不符（requestId 与文件名不一致）→ undefined', async () => {
    mkdirSync(join(stateRoot, 'toolrequests'), { recursive: true });
    writeFileSync(toolRequestFile(stateRoot, 'r-x'), JSON.stringify(ledger({ requestId: 'r-y' })));
    expect(await readToolRequest(stateRoot, 'r-x')).toBeUndefined();
  });

  it('listToolRequests / listPendingToolRequests 过滤', async () => {
    await createToolRequest(stateRoot, ledger({ requestId: 'r-1' }));
    await createToolRequest(stateRoot, ledger({ requestId: 'r-2', state: 'approved' }));
    mkdirSync(join(stateRoot, 'toolrequests'), { recursive: true });
    writeFileSync(toolRequestFile(stateRoot, 'r-3'), 'not-json');
    const all = await listToolRequests(stateRoot);
    expect(all.map((l) => l.requestId).sort()).toEqual(['r-1', 'r-2']);
    const pending = await listPendingToolRequests(stateRoot);
    expect(pending.map((l) => l.requestId)).toEqual(['r-1']);
  });
});

describe('toolledger v0.7: 状态迁移', () => {
  it('updateToolRequest 读改写；mutate 返回 undefined = 放弃写入', async () => {
    await createToolRequest(stateRoot, ledger());
    const next = await updateToolRequest(stateRoot, 'r-001', (l) => ({ ...l, state: 'approved', decidedBy: 'lead' }));
    expect(next).toMatchObject({ state: 'approved', decidedBy: 'lead' });
    const same = await updateToolRequest(stateRoot, 'r-001', () => undefined);
    expect(same).toMatchObject({ state: 'approved' });
    const disk = JSON.parse(readFileSync(toolRequestFile(stateRoot, 'r-001'), 'utf8')) as ToolRequestLedger;
    expect(disk.state).toBe('approved');
  });

  it('终态词表与放行态词表（§2.5/§2.7）', () => {
    expect(isTerminalToolState('executed')).toBe(true);
    expect(isTerminalToolState('error')).toBe(true);
    expect(isTerminalToolState('pending')).toBe(false);
    expect(isGatePassState('approved')).toBe(true);
    expect(isGatePassState('executed')).toBe(true);
    expect(isGatePassState('pending')).toBe(false);
    expect(isGatePassState('refused')).toBe(false);
  });
});

describe('toolledger v0.7: 过期节拍', () => {
  it('pending/approved 超 expiresAt → expired（decidedBy=engine）；未到期不动', async () => {
    await createToolRequest(stateRoot, ledger({ requestId: 'r-old', expiresAt: 500 }));
    await createToolRequest(stateRoot, ledger({ requestId: 'r-new', expiresAt: 9_999_999_999 }));
    const expired = await expireToolRequests(stateRoot, 1_000);
    expect(expired.map((l) => l.requestId)).toEqual(['r-old']);
    expect((await readToolRequest(stateRoot, 'r-old'))?.state).toBe('expired');
    expect((await readToolRequest(stateRoot, 'r-new'))?.state).toBe('pending');
  });

  it('终态（executed/denied/refused）不被过期改写', async () => {
    await createToolRequest(stateRoot, ledger({ requestId: 'r-done', state: 'executed', expiresAt: 500 }));
    expect(await expireToolRequests(stateRoot, 1_000)).toEqual([]);
    expect((await readToolRequest(stateRoot, 'r-done'))?.state).toBe('executed');
  });

  it('重复过期幂等（第二次无候选）', async () => {
    await createToolRequest(stateRoot, ledger({ requestId: 'r-old', expiresAt: 500 }));
    expect((await expireToolRequests(stateRoot, 1_000)).length).toBe(1);
    expect(await expireToolRequests(stateRoot, 1_001)).toEqual([]);
  });
});

describe('toolledger v0.7: 终态清理（7 天）', () => {
  it('终态台账 + 审批文件超 keepMs 删除；在途与窗口内不动；孤儿审批文件清', async () => {
    const now = 10_000_000;
    // 终态且超 7 天：台账 + 审批文件都删。
    await createToolRequest(stateRoot, ledger({ requestId: 'r-old', state: 'executed', decidedAt: now - TOOL_APPROVAL_KEEP_MS - 1 }));
    mkdirSync(join(stateRoot, 'approvals'), { recursive: true });
    writeFileSync(approvalsFile(stateRoot, 'r-old'), '{}');
    // 终态但窗口内（< 7 天）：不动。
    await createToolRequest(stateRoot, ledger({ requestId: 'r-fresh', state: 'refused', decidedAt: now - 1000 }));
    writeFileSync(approvalsFile(stateRoot, 'r-fresh'), '{}');
    // 在途：不动。
    await createToolRequest(stateRoot, ledger({ requestId: 'r-live' }));
    writeFileSync(approvalsFile(stateRoot, 'r-live'), '{}');
    // 孤儿审批文件（台账已不存在）：清。
    writeFileSync(approvalsFile(stateRoot, 'r-orphan'), '{}');

    const cleaned = await cleanupToolArtifacts(stateRoot, now);
    expect(cleaned.ledgers).toEqual(['r-old']);
    expect(cleaned.approvals.sort()).toEqual(['r-old', 'r-orphan']);
    expect(existsSync(toolRequestFile(stateRoot, 'r-old'))).toBe(false);
    expect(existsSync(approvalsFile(stateRoot, 'r-old'))).toBe(false);
    expect(existsSync(toolRequestFile(stateRoot, 'r-fresh'))).toBe(true);
    expect(existsSync(approvalsFile(stateRoot, 'r-fresh'))).toBe(true);
    expect(existsSync(toolRequestFile(stateRoot, 'r-live'))).toBe(true);
    expect(existsSync(approvalsFile(stateRoot, 'r-live'))).toBe(true);
    expect(existsSync(approvalsFile(stateRoot, 'r-orphan'))).toBe(false);
  });

  it('无目录时零成本（readdir 失败 → 空）', async () => {
    expect(await cleanupToolArtifacts(stateRoot, Date.now())).toEqual({ ledgers: [], approvals: [] });
    expect(await listToolRequests(stateRoot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v0.7.2 复验（P3 修复）：B-02 多进程 sweeper 竞态致过期回投重复
// ---------------------------------------------------------------------------

describe('toolledger v0.7.2 (B-02): 过期迁移只有一个赢家', () => {
  it('transitionToolRequest：闸命中才写才返回；未命中不写不返回', async () => {
    await createToolRequest(stateRoot, ledger());
    const first = await transitionToolRequest(stateRoot, 'r-001', ['pending'], (l) => ({ ...l, state: 'expired', decidedAt: 2_000_000 }));
    expect(first?.state).toBe('expired');
    // 竞态输家：状态已是 expired，闸（pending）不再命中 → undefined，调用方据此不回投。
    const second = await transitionToolRequest(stateRoot, 'r-001', ['pending'], (l) => ({ ...l, state: 'expired', decidedAt: 3_000_000 }));
    expect(second).toBeUndefined();
    // 落盘的 decidedAt 仍是赢家的值（输家没有覆盖写）。
    expect((await readToolRequest(stateRoot, 'r-001'))?.decidedAt).toBe(2_000_000);
  });

  it('transitionToolRequest：台账缺失 → undefined（不建文件）', async () => {
    expect(await transitionToolRequest(stateRoot, 'r-ghost', ['pending'], (l) => ({ ...l, state: 'expired' }))).toBeUndefined();
    expect(existsSync(toolRequestFile(stateRoot, 'r-ghost'))).toBe(false);
  });

  it('expireToolRequests：重复调用（sweeper 节拍重入）只第一次返回赢家', async () => {
    await createToolRequest(stateRoot, ledger());
    const now = 4_600_001; // > expiresAt（1_000_000 + 3_600_000）
    expect((await expireToolRequests(stateRoot, now)).map((l) => l.requestId)).toEqual(['r-001']);
    // 第二次（下一节拍/另一进程）：读到已 expired，闸不命中 → 空列表 → 不回投。
    expect(await expireToolRequests(stateRoot, now)).toEqual([]);
    expect((await readToolRequest(stateRoot, 'r-001'))?.state).toBe('expired');
  });

  it('updateToolRequest 旧契约不变（mutate 放弃 → 返回当前台账）', async () => {
    await createToolRequest(stateRoot, ledger());
    const same = await updateToolRequest(stateRoot, 'r-001', () => undefined);
    expect(same?.state).toBe('pending');
  });
});
