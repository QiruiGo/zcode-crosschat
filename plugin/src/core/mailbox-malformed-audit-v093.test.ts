/**
 * v0.9.3 对抗轮 P0 回归：邮箱坏行审计限流。
 *
 * 缺陷形态（adv-1/R3 F-06）：`readMailboxDetailed` 的缺省 malformed sink 是
 * per-line `void logEngineEvent(...)`（fire-and-forget）⇒ 邮箱里 M 条坏行、每拍
 * sweep 一次读取 = M 条审计/拍，且永不停止（坏行原地保留）；叠加 appendJsonl 的
 * 旧全文件读，2000 坏行单拍 RSS +1.7~2.9GB，3000 坏行 OOM。
 *
 * 判据：一次读取（sweep）对同一文件只发一条汇总审计（count + firstLineNo），
 * 同一文件同一分钟重复 sweep 不再新增；分钟滚动后允许再发一条。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCurrentMailboxLocked, type MailboxReadDiagnostics } from './mailbox.js';
import { newTeamState, writeTeam } from './teamstate.js';
import type { TeamState } from './types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-malformed-audit-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function team(): TeamState {
  return newTeamState({ teamId: 'default', founderKey: 'a' });
}

/** 写 200 条不可解析行到 b 的邮箱（目录布局与生产一致）。 */
function writeBadMailbox(count: number): string {
  const inbox = join(dir, 'teams', 'default', 'inbox');
  mkdirSync(inbox, { recursive: true });
  const file = join(inbox, 'b.jsonl');
  const lines = Array.from({ length: count }, (_, i) => `{"broken":${i}`);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

interface RawEvent {
  event?: unknown;
  [field: string]: unknown;
}

function engineEvents(): RawEvent[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, 'logs', 'engine.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RawEvent);
}

function malformedAuditEvents(): RawEvent[] {
  return engineEvents().filter((event) => event.event === 'malformed-lines');
}

describe('邮箱坏行审计限流（v0.9.3 P0）', () => {
  it('200 条坏行：一次 sweep 恰 1 条汇总审计（count=200/firstLineNo=1），同分钟再 sweep 不新增', async () => {
    const state = team();
    await writeTeam(dir, state);
    const file = writeBadMailbox(200);

    const diagnostics: MailboxReadDiagnostics = { malformed: [], discarded: 0 };
    const messages = await readCurrentMailboxLocked(dir, state, 'b', undefined, diagnostics);
    expect(messages).toEqual([]);
    // 诊断面仍逐行披露（工具面「N 条不可读」不受影响）。
    expect(diagnostics.malformed).toHaveLength(200);
    expect(diagnostics.malformed[0]?.lineNo).toBe(1);

    const firstSweep = malformedAuditEvents();
    expect(firstSweep).toHaveLength(1);
    expect(firstSweep[0]!.count).toBe(200);
    expect(firstSweep[0]!.firstLineNo).toBe(1);
    expect(firstSweep[0]!.file).toBe(file);
    expect(String(firstSweep[0]!.firstError)).toContain('invalid JSON');
    // 旧形态（每行一条 malformed-line）不再出现。
    expect(engineEvents().filter((event) => event.event === 'malformed-line')).toHaveLength(0);

    // 同一分钟第二次 sweep：坏行仍在盘上，但审计被节流。
    const second = await readCurrentMailboxLocked(dir, state, 'b');
    expect(second).toEqual([]);
    expect(malformedAuditEvents()).toHaveLength(1);

    // 分钟滚动后允许再发一条（持续性坏行仍保持可观测，只是不每拍刷）。
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await readCurrentMailboxLocked(dir, state, 'b');
    expect(malformedAuditEvents()).toHaveLength(2);
    expect(malformedAuditEvents()[1]!.count).toBe(200);
  });
});
