/**
 * v0.8.0 A1（DESIGN-V0.8.md §3 / §8 AC1）：checkpoint 单测。
 *
 * 覆盖（ACCEPT15-1 判据 → 测试落点）：
 * - stamp 形态与 Windows 合法性（无 ":"/"."，字典序=时间序）；
 * - front-matter **7 键恒现且逐行点数** + taskCounts 三键恒在（0 也写）；
 * - 七章标题/顺序/字段（含空态占位、依赖 `!` 尾缀、blocked 阻塞原因、按章截断披露）；
 * - 滚动 prune 纯函数 21→20 且 `.nudge` 不删；端到端 21 份后恰 20；
 * - `checkpointNudgeDecision` 五态矩阵（3 条负例）+ 两条命名 adjudication 用例
 *   （从未写过 → emit；从未写过但 30min 内提醒过 → rate-limited）；
 * - 容量 RED/GREEN/UNKNOWN 推导（handoff/status 三视图共用助手，防口径分裂）；
 * - 路径安全（段闸把穿越探针吸收成安全段，落点恒在 stateRoot 内）；
 * - 未读只抄索引不搬原文 + `tool_request` 帧 subject 遮蔽（R6 审批门不开侧门）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_JOURNAL_TAIL_LINES,
  CHECKPOINT_KEEP_MAX,
  CHECKPOINT_NOTE_MAX_CHARS,
  CHECKPOINT_STAMP_RE,
  capacityLevelOf,
  capacityViewOf,
  checkpointNudgeDecision,
  checkpointNudgeState,
  checkpointCreatedAtFromMarkdown,
  checkpointStamp,
  checkpointUnreadRef,
  frontMatterCapacityLine,
  journalDisplayPath,
  latestCheckpoint,
  normalizeCheckpointNote,
  planCheckpointPrune,
  readNudgeMarker,
  readTaskJournalTail,
  renderCheckpointNudgeLine,
  safeCheckpointSegment,
  sweepCheckpointTmpFiles,
  writeCheckpoint,
  writeNudgeMarker,
  buildCheckpointMarkdown,
  type CheckpointData,
  type CheckpointJournalTail,
} from './checkpoint.js';
import { checkpointDir, checkpointsDir } from './paths.js';
import { createMessage } from './mailbox.js';
import { newTeamState, writeTeam } from './teamstate.js';
import type { MemberState, Task, TeamMember } from './types.js';

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xc-checkpoint-'));
  dirs.push(root);
});
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
});

/** 固定时刻：2026-11-15T18:00:00.000Z。 */
const T = Date.UTC(2026, 10, 15, 18, 0, 0);
const MIN = 60_000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: '86e8b61a-t1',
    title: '落盘脚本改造',
    prompt: 'p',
    dependsOn: [],
    status: 'in_progress',
    assignee: 'alice',
    attempt: 2,
    attemptId: 'att-2',
    createdBy: 'lead',
    createdAt: T - 60 * MIN,
    updatedAt: T - 20 * MIN,
    lastProgressTs: T - 20 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: T - 20 * MIN, event: 'report', by: 'alice' }],
    ...overrides,
  };
}

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key,
    sessionId: `sess_${key}_0123456789`,
    role: 'worker',
    joinedAt: T - 120 * MIN,
    lastSeen: T - 2 * MIN,
    state: 'ready' as MemberState,
    identity: 'engine',
    ...overrides,
  };
}

function data(overrides: Partial<CheckpointData> = {}): CheckpointData {
  return {
    agentKey: 'alice',
    teamId: 'default',
    leadKey: 'lead',
    member: { role: 'worker', state: 'ready', sessionId: 'sess_alice_0123456789', lastSeen: T - 2 * MIN },
    openTasks: [task()],
    allTasks: [task()],
    pool: [],
    unread: [],
    unreadTotal: 0,
    capacity: { watermarkPct: 23.5, freeGb: 7.2, level: 'GREEN' },
    stallThresholdMs: 120 * MIN,
    journalTails: [],
    note: undefined,
    now: T,
    ...overrides,
  };
}

/** 取 front-matter 块（第一个 `---` 与第二个 `---` 之间的行）。 */
function frontMatterLines(markdown: string): string[] {
  const start = markdown.indexOf('---\n');
  const end = markdown.indexOf('\n---', start + 4);
  return markdown.slice(start + 4, end).split('\n').filter((l) => l.trim() !== '');
}

// ---------------------------------------------------------------------------
describe('checkpointStamp：Windows 合法 + 字典序=时间序', () => {
  it('ISO8601 折叠 ":"/"." 为 "-"，形态匹配冻结正则', () => {
    const stamp = checkpointStamp(T);
    expect(stamp).toBe('2026-11-15T18-00-00-000Z');
    expect(stamp).toMatch(CHECKPOINT_STAMP_RE);
    expect(stamp).not.toContain(':');
    expect(stamp).not.toContain('.');
  });

  it('递增 now → 递增 stamp（滚动按文件名排序才等于按时间排序）', () => {
    const a = checkpointStamp(T);
    const b = checkpointStamp(T + 1);
    const c = checkpointStamp(T + 1000);
    expect([a, b, c]).toEqual([...([a, b, c] as string[])].sort());
    expect(a < b && b < c).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('容量推导（checkpoint/handoff/status 三视图共用同一助手）', () => {
  it('capacityLevelOf：red→RED，非 red→GREEN，缺失→UNKNOWN（不谎报水位）', () => {
    expect(capacityLevelOf({ red: true })).toBe('RED');
    expect(capacityLevelOf({ red: false })).toBe('GREEN');
    expect(capacityLevelOf(null)).toBe('UNKNOWN');
    expect(capacityLevelOf(undefined)).toBe('UNKNOWN');
  });

  it('capacityViewOf：按真源字段命名 + 位数钳制；任一侧缺失 → null', () => {
    const view = capacityViewOf({ watermark: 0.235, freeBytes: 7.2 * 1024 ** 3 }, { red: false });
    expect(view).toEqual({ watermarkPct: 23.5, freeGb: 7.2, level: 'GREEN' });
    expect(capacityViewOf(null, { red: false })).toBeNull();
    expect(capacityViewOf({ watermark: 0.2, freeBytes: 1 }, null)).toBeNull();
  });

  it('frontMatterCapacityLine：正常样本与 UNKNOWN 两态（7 键恒现的前提）', () => {
    expect(frontMatterCapacityLine({ watermarkPct: 23.5, freeGb: 7.2, level: 'RED' }))
      .toBe('capacity: {watermarkPct: 23.5, freeGb: 7.20, level: RED}');
    expect(frontMatterCapacityLine(null))
      .toBe('capacity: {watermarkPct: n/a, freeGb: n/a, level: UNKNOWN}');
  });
});

// ---------------------------------------------------------------------------
describe('front-matter：7 键恒现且逐行点数', () => {
  it('七行七键、顺序固定、键名逐一相符', () => {
    const lines = frontMatterLines(buildCheckpointMarkdown(data()));
    expect(lines).toHaveLength(7);
    expect(lines.map((l) => l.split(':')[0])).toEqual([
      'agent', 'team', 'lead', 'createdAt', 'taskCounts', 'unread', 'capacity',
    ]);
  });

  it('taskCounts 恒含三键（0 也写，键集合稳定可 grep）', () => {
    const md = buildCheckpointMarkdown(data({ openTasks: [] }));
    const line = frontMatterLines(md).find((l) => l.startsWith('taskCounts:'))!;
    expect(line).toBe('taskCounts: {claimed:0, in_progress:0, blocked:0}');
    const counted = buildCheckpointMarkdown(data({
      openTasks: [
        task({ id: 't-a', status: 'claimed' }),
        task({ id: 't-b', status: 'in_progress' }),
        task({ id: 't-c', status: 'blocked' }),
        task({ id: 't-d', status: 'blocked' }),
      ],
    }));
    expect(frontMatterLines(counted).find((l) => l.startsWith('taskCounts:')))
      .toBe('taskCounts: {claimed:1, in_progress:1, blocked:2}');
  });

  it('lead 缺失写 (none)（不写 null，保持标量）；值含换行/`---` 折成单行', () => {
    const md = buildCheckpointMarkdown(data({
      leadKey: null,
      teamId: 'de\nfault\n---\nx',
      note: '第一行\n---\n注入尝试',
    }));
    const lines = frontMatterLines(md);
    expect(lines.find((l) => l.startsWith('lead:'))).toBe('lead: (none)');
    expect(lines.find((l) => l.startsWith('team:'))).toBe('team: de fault --- x');
    // note 章单行（front-matter 与 note 都不被注入撑破）
    const noteSection = md.slice(md.indexOf('## 7. note'));
    expect(noteSection.split('\n').filter((l) => l.trim() !== '')).toEqual([
      '## 7. note', '第一行 --- 注入尝试',
    ]);
  });

  it('createdAt 用注入的 now；capacity 采样失败也写 UNKNOWN（写盘继续）', () => {
    const md = buildCheckpointMarkdown(data({ capacity: null }));
    const lines = frontMatterLines(md);
    expect(lines.find((l) => l.startsWith('createdAt:'))).toBe('createdAt: 2026-11-15T18:00:00.000Z');
    expect(lines.find((l) => l.startsWith('capacity:'))).toContain('level: UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
describe('七章标题/顺序/字段（冻结格式）', () => {
  const md = buildCheckpointMarkdown(data({
    openTasks: [
      task({ id: 't-a1', status: 'in_progress', title: '落盘脚本改造', lastProgressTs: T - 20 * MIN, history: [{ ts: T - 20 * MIN, event: 'report', by: 'alice' }] }),
      task({ id: 't-b2', status: 'blocked', title: '等审批文件', attempt: 1, blockedReason: '等用户落 approvals/', lastProgressTs: T - 120 * MIN, history: [{ ts: T - 120 * MIN, event: 'report', by: 'alice' }] }),
    ],
    pool: [
      task({ id: 't-c3', status: 'pending', assignee: null, priority: 'high', title: '补单测', dependsOn: [] }),
      task({ id: 't-d4', status: 'pending', assignee: null, priority: 'normal', title: '文档同步', dependsOn: ['t-c3'] }),
    ],
    allTasks: [
      task({ id: 't-a1', status: 'in_progress' }),
      task({ id: 't-b2', status: 'blocked' }),
      task({ id: 't-c3', status: 'pending', assignee: null, priority: 'high', title: '补单测', dependsOn: [] }),
      task({ id: 't-d4', status: 'pending', assignee: null, title: '文档同步', dependsOn: ['t-c3'] }),
    ],
    journalTails: [
      { taskId: 't-a1', displayPath: '.crosschat/tasks/t-a1/journal.md', lines: ['- 2026-11-15 17:40 | 完成骨架 | D:\\ws\\out\\a.txt'], status: 'ok' },
      { taskId: 't-b2', displayPath: '.crosschat/tasks/t-b2/journal.md', lines: [], status: 'missing' },
    ],
    unread: [
      { msgId: 'msg_1a2b3c4d', from: 'bob', urgent: true, subject: '记得先落盘再压缩' },
      { msgId: 'msg_3c4d5e6f', from: 'carol', urgent: false, subject: '文档我看完了' },
    ],
    unreadTotal: 7,
    note: '先落盘再压缩',
  }));

  it('七章编号标题、顺序固定', () => {
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      '## 1. 身份',
      '## 2. 我的进行中任务（claimed / in_progress / blocked）',
      '## 3. 待领池（前 10，priority → createdAt）',
      '## 4. 最近 journal（每任务末 5 行 + 路径）',
      '## 5. 未读摘要（urgent 优先，最多 5 条）',
      '## 6. 建议下一步',
      '## 7. note',
    ]);
  });

  it('第 1 章身份：花名/角色/状态/lead/team + sessionId 全量（v0.9.2 V090-15）+ lastSeen 相对分钟', () => {
    expect(md).toContain('- agent: alice | role: worker | state: ready | lead: lead | team: default');
    // v0.9.2（V090-15 P3）：全量渲染——与 team.json / xc_overview 成员行同口径
    // （v0.9.1 及以前 slice(0,8) 恒等退化：`sess_`/`sess_dwf-` 前缀下不同成员显示同一串）。
    expect(md).toContain('- sessionId: sess_alice_0123456789 | lastSeen: 2026-11-15T17:58:00.000Z（2min 前）');
    expect(md).not.toContain('- sessionId: sess_ali ');
  });

  it('第 2 章：ISO+相对分钟；blocked 追加阻塞原因；空态占位', () => {
    expect(md).toContain('| t-a1 | in_progress | 落盘脚本改造 | 2 | 2026-11-15T17:40:00.000Z（20min 前） |');
    expect(md).toContain('| t-b2 | blocked | 等审批文件 | 1 | 2026-11-15T16:00:00.000Z（120min 前）（阻塞原因：等用户落 approvals/） |');
    expect(buildCheckpointMarkdown(data({ openTasks: [] }))).toContain('（无进行中任务）');
  });

  it('第 3 章：依赖 `-`=无、尾缀 `!`=未终态；超 10 记「列前 10」', () => {
    expect(md).toContain('| t-c3 | high | 补单测 | - |');
    expect(md).toContain('| t-d4 | normal | 文档同步 | t-c3! |');
    const many = Array.from({ length: 12 }, (_, i) =>
      task({ id: `t-p${i}`, status: 'pending', assignee: null, title: `任务${i}` }));
    const bigMd = buildCheckpointMarkdown(data({ pool: many, allTasks: many }));
    expect(bigMd).toContain('（待领池共 12 个，列前 10）');
    expect(bigMd.match(/^\| t-p\d+ \|/gm)).toHaveLength(10);
    expect(buildCheckpointMarkdown(data({ pool: [] }))).toContain('（待领池为空）');
  });

  it('第 4 章：journal 末行在场 + 缺失不静默跳过（记「不存在」）', () => {
    expect(md).toContain('### t-a1（.crosschat/tasks/t-a1/journal.md）');
    expect(md).toContain('- 2026-11-15 17:40 | 完成骨架 | D:\\ws\\out\\a.txt');
    expect(md).toContain('（无 journal：.crosschat/tasks/t-b2/journal.md 不存在）');
  });

  it('第 5 章：urgent 优先、msgId 短 8 位、超出记「另有 N 条」；空态占位', () => {
    expect(md).toContain('- [urgent] bob | 记得先落盘再压缩（msg_1a2b）');
    expect(md).toContain('- carol | 文档我看完了（msg_3c4d）');
    expect(md).toContain('（另有 5 条未读，xc_read({scope:"inbox"}) 消费）');
    expect(buildCheckpointMarkdown(data({ unreadTotal: 0 }))).toContain('（无未读）');
  });

  it('第 5 章：未读读取失败如实记「（未读读取失败：…）」，不当成无未读（§3.6）', () => {
    const failed = buildCheckpointMarkdown(data({ unreadError: 'EACCES: permission denied' }));
    expect(failed).toContain('（未读读取失败：EACCES: permission denied）');
    expect(failed).not.toContain('（无未读）');
  });

  it('第 6 章建议下一步：blocked-long / 依赖未满足 / 容量 RED / 可认领 / 空态', () => {
    const blocked = buildCheckpointMarkdown(data({
      openTasks: [task({ id: 't-b2', status: 'blocked', blockedReason: '等审批', lastProgressTs: T - 200 * MIN, history: [{ ts: T - 200 * MIN, event: 'report', by: 'alice' }] })],
      allTasks: [task({ id: 't-b2', status: 'blocked' })],
      capacity: { watermarkPct: 9.9, freeGb: 3.1, level: 'RED' },
    }));
    expect(blocked).toContain('- t-b2：blocked 超 200min → 处理阻塞原因（xc_team unblock）或 cancel');
    expect(blocked).toContain('- 容量 RED → 先按 longtask checklist 落盘再接受压缩');

    const waiting = buildCheckpointMarkdown(data({
      openTasks: [task({ id: 't-x', dependsOn: ['t-dep'], lastProgressTs: T - 1 * MIN, history: [{ ts: T - 1 * MIN, event: 'report', by: 'alice' }] })],
      allTasks: [task({ id: 't-x', dependsOn: ['t-dep'] }), task({ id: 't-dep', status: 'pending', assignee: null })],
    }));
    expect(waiting).toContain('- t-x：依赖 t-dep 未终态 → 等待项（dependsOn 未满足）');

    const claimable = buildCheckpointMarkdown(data({
      openTasks: [],
      allTasks: [],
      pool: [task({ id: 't-c3', status: 'pending', assignee: null })],
    }));
    expect(claimable).toContain('- 无在途任务且有待领 → 可认领 t-c3（注意单在途任务规则：认领前先 xc_report 收尾当前任务）');

    expect(buildCheckpointMarkdown(data({ openTasks: [], allTasks: [], pool: [] })))
      .toContain('（暂无：按 journal 指针继续）');
  });

  it('第 7 章 note：缺省占位 + 500 字符钳 + 控制字符折空格', () => {
    expect(buildCheckpointMarkdown(data({ note: undefined }))).toContain('（未提供）');
    expect(normalizeCheckpointNote('a'.repeat(600))).toHaveLength(CHECKPOINT_NOTE_MAX_CHARS);
    expect(normalizeCheckpointNote('a\u0000b\u001fc')).toBe('a b c');
  });
});

// ---------------------------------------------------------------------------
describe('滚动 prune：纯函数 21→20 且 .nudge 不在删除域', () => {
  const stampAt = (i: number): string => checkpointStamp(T + i * 1000);

  it('21 份 → 删最旧 1 份；.nudge 与非 .md 不动', () => {
    const names = [...Array.from({ length: 21 }, (_, i) => `${stampAt(i)}.md`), '.nudge', 'notes.txt'];
    const doomed = planCheckpointPrune(names, CHECKPOINT_KEEP_MAX);
    expect(doomed).toEqual([`${stampAt(0)}.md`]);
    expect(doomed.some((n) => n === '.nudge' || !n.endsWith('.md'))).toBe(false);
  });

  it('≤20 份不删；25 份删最旧 5 份（升序）', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `${stampAt(i)}.md`);
    expect(planCheckpointPrune(twenty, CHECKPOINT_KEEP_MAX)).toEqual([]);
    const twentyFive = Array.from({ length: 25 }, (_, i) => `${stampAt(i)}.md`);
    const doomed = planCheckpointPrune(twentyFive, CHECKPOINT_KEEP_MAX);
    expect(doomed).toHaveLength(5);
    expect(doomed).toEqual([...doomed].sort());
  });
});

// ---------------------------------------------------------------------------
describe('writeCheckpoint → latestCheckpoint 往返（落盘 + 滚动）', () => {
  it('文件存在、以 \n 结尾、stamp 进文件名、结果字段齐全', async () => {
    const result = await writeCheckpoint(root, data());
    const text = readFileSync(result.path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(result.path).toBe(join(checkpointDir(root, 'alice'), `${result.stamp}.md`));
    expect(result.bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(result.openTasks).toBe(1);
    expect(result.unread).toBe(0);
    expect(result.capacity).toEqual({ watermarkPct: 23.5, freeGb: 7.2, level: 'GREEN' });
    expect(result.pruned).toBe(0);
    expect(text).toContain('## 1. 身份');
  });

  it('21 份后恰 20 份：最旧被删、最新在、.nudge 不被动', async () => {
    for (let i = 0; i < 21; i += 1) {
      await writeCheckpoint(root, data({ now: T + i * 1000 }));
    }
    await writeNudgeMarker(root, 'alice', T);
    const names = readdirSync(checkpointDir(root, 'alice'));
    const mds = names.filter((n) => n.endsWith('.md'));
    expect(mds).toHaveLength(CHECKPOINT_KEEP_MAX);
    expect(names).toContain('.nudge');
    expect(mds).toContain(`${checkpointStamp(T + 20 * 1000)}.md`); // 最新在
    expect(mds).not.toContain(`${checkpointStamp(T)}.md`); // 最旧被删

    const latest = await latestCheckpoint(root, 'alice', T + 21 * 1000);
    expect(latest?.stamp).toBe(checkpointStamp(T + 20 * 1000));
    expect(latest?.path).toBe(join(checkpointDir(root, 'alice'), `${checkpointStamp(T + 20 * 1000)}.md`));
  });

  it('同毫秒重复调用也各得一份文件（进位不改 stamp 形态）', async () => {
    const a = await writeCheckpoint(root, data({ now: T }));
    const b = await writeCheckpoint(root, data({ now: T }));
    expect(a.path).not.toBe(b.path);
    expect(b.stamp).toMatch(CHECKPOINT_STAMP_RE);
    expect(b.stamp > a.stamp).toBe(true);
    expect(readdirSync(checkpointDir(root, 'alice')).filter((n) => n.endsWith('.md'))).toHaveLength(2);
  });

  it('latestCheckpoint：空目录 → null；写入后返回最新一份的 stat', async () => {
    expect(await latestCheckpoint(root, 'alice', T)).toBeNull();
    const writtenAt = Date.now();
    await writeCheckpoint(root, data({ now: writtenAt }));
    const latest = await latestCheckpoint(root, 'alice', writtenAt + 5 * MIN);
    expect(latest).not.toBeNull();
    expect(latest!.bytes).toBeGreaterThan(0);
    expect(latest!.ageMin).toBe(5); // 年龄 = now - front-matter createdAt（v0.8.1：拷贝/还原不回退 mtime 口径）
  });

  it('latestCheckpoint：只认 stamp 形态的 *.md（stray 的 .md 不冒充分检点）', async () => {
    await writeCheckpoint(root, data({ now: Date.now() }));
    writeFileSync(join(checkpointDir(root, 'alice'), 'zzz-notes.md'), 'stray');
    const latest = await latestCheckpoint(root, 'alice', Date.now());
    expect(latest?.stamp).not.toBe('zzz-notes');
    expect(latest?.stamp).toMatch(CHECKPOINT_STAMP_RE);
  });

  it('写失败向上抛（checkpoints 路径被文件占用 → mkdir 失败）', async () => {
    writeFileSync(join(root, 'checkpoints'), 'not a directory');
    await expect(writeCheckpoint(root, data())).rejects.toThrow();
  });

  it('成员不在花名册仍可写，身份章如实记 (not on roster)', async () => {
    const result = await writeCheckpoint(root, data({ member: null }));
    expect(readFileSync(result.path, 'utf8'))
      .toContain('- agent: alice | role: (not on roster) | state: (not on roster) | lead: lead | team: default');
  });

  it('journalTails 缺省时自行读盘（末 5 个非空行）', async () => {
    const taskDir = join(root, 'tasks', '86e8b61a-t1');
    mkdirSync(taskDir, { recursive: true });
    const lines = Array.from({ length: 8 }, (_, i) => `- 行${i}`);
    writeFileSync(join(taskDir, 'journal.md'), `${lines.join('\n')}\n\n`);
    const result = await writeCheckpoint(root, data({ journalTails: undefined }));
    const text = readFileSync(result.path, 'utf8');
    for (const line of lines.slice(-CHECKPOINT_JOURNAL_TAIL_LINES)) expect(text).toContain(line);
    expect(text).not.toContain('- 行2\n');
  });
});

// ---------------------------------------------------------------------------
describe('readTaskJournalTail：末 N 行 / 缺失 / 读取失败都在场', () => {
  it('末 N 个非空行', async () => {
    const taskDir = join(root, 'tasks', 't-j');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'journal.md'), 'a\nb\nc\nd\ne\nf\ng\n');
    const tail = await readTaskJournalTail(root, 't-j');
    expect(tail.status).toBe('ok');
    expect(tail.lines).toEqual(['c', 'd', 'e', 'f', 'g']);
    expect(tail.displayPath).toBe('.crosschat/tasks/t-j/journal.md');
  });

  it('文件缺失 → missing（不得静默跳过）', async () => {
    const tail = await readTaskJournalTail(root, 't-nope');
    expect(tail.status).toBe('missing');
    expect(tail.lines).toEqual([]);
  });

  it('读取失败（journal.md 是目录 → EISDIR）→ error', async () => {
    mkdirSync(join(root, 'tasks', 't-x', 'journal.md'), { recursive: true });
    const tail = await readTaskJournalTail(root, 't-x');
    expect(tail.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
describe('checkpointNudgeDecision：五态矩阵（3 条负例 + 2 条命名 adjudication）', () => {
  const base = { env: {}, openTaskCount: 1, lastCheckpointAt: T - 40 * MIN, lastNudgeAt: null, now: T };

  it('disabled：XC_CHECKPOINT_NUDGE=0 可关（先命中先返回）', () => {
    const d = checkpointNudgeDecision({ ...base, env: { XC_CHECKPOINT_NUDGE: '0' } });
    expect(d).toEqual({ nudge: false, reason: 'disabled' });
  });

  it('负例 no-active-task：无活跃任务不被提醒（先于阈值/节流判据）', () => {
    const d = checkpointNudgeDecision({
      ...base, openTaskCount: 0, lastCheckpointAt: T - 1 * MIN, lastNudgeAt: T - 1 * MIN,
    });
    expect(d).toEqual({ nudge: false, reason: 'no-active-task' });
  });

  it('负例 within-threshold：刚写过（≤30min）不重复提醒', () => {
    const d = checkpointNudgeDecision({ ...base, lastCheckpointAt: T - 30 * MIN, lastNudgeAt: null });
    expect(d).toEqual({ nudge: false, reason: 'within-threshold' });
  });

  it('负例 rate-limited：30min 内提醒过 → 最多一次', () => {
    const d = checkpointNudgeDecision({ ...base, lastNudgeAt: T - 29 * MIN });
    expect(d).toEqual({ nudge: false, reason: 'rate-limited' });
  });

  it('emit：有活跃任务且距上次 >30min 且 30min 内没提醒过', () => {
    const d = checkpointNudgeDecision({ ...base, lastCheckpointAt: T - 32 * MIN });
    expect(d).toEqual({ nudge: true, reason: 'emit', ageMin: 32 });
  });

  it('边界：恰 30min 算「刚写过」；+1ms 才放行', () => {
    expect(checkpointNudgeDecision({ ...base, lastCheckpointAt: T - 30 * MIN, lastNudgeAt: null }).reason)
      .toBe('within-threshold');
    expect(checkpointNudgeDecision({ ...base, lastCheckpointAt: T - 30 * MIN - 1, lastNudgeAt: null }).reason)
      .toBe('emit');
    expect(checkpointNudgeDecision({ ...base, lastNudgeAt: T - 30 * MIN }).reason).toBe('rate-limited');
    expect(checkpointNudgeDecision({ ...base, lastNudgeAt: T - 30 * MIN - 1 }).reason).toBe('emit');
  });

  it('命名 adjudication①：从未写过检查点（lastCheckpointAt=null）→ 该提醒一次', () => {
    const d = checkpointNudgeDecision({ ...base, lastCheckpointAt: null, lastNudgeAt: null });
    expect(d.nudge).toBe(true);
    expect(d.reason).toBe('emit');
    expect(d.ageMin).toBeUndefined(); // 文案渲染「尚未落过」
  });

  it('命名 adjudication②：从未写过但 30min 内提醒过 → 仍受节流（不会每回合刷）', () => {
    const d = checkpointNudgeDecision({ ...base, lastCheckpointAt: null, lastNudgeAt: T });
    expect(d).toEqual({ nudge: false, reason: 'rate-limited' });
  });

  it('openTaskCount 非有限值按 0 处理（防御）', () => {
    expect(checkpointNudgeDecision({ ...base, openTaskCount: Number.NaN }).reason).toBe('no-active-task');
    expect(checkpointNudgeDecision({ ...base, openTaskCount: -3 }).reason).toBe('no-active-task');
  });
});

describe('renderCheckpointNudgeLine：注入文案（一行）', () => {
  it('有年龄 → 「距上次检查点 Nmin」', () => {
    const line = renderCheckpointNudgeLine(32);
    expect(line).toBe('[zcode-crosschat] 建议先 /xc-checkpoint（距上次检查点 32min）——长期任务随时可能被压缩，先落盘再继续；不需要可设 XC_CHECKPOINT_NUDGE=0。');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('从未写过 → 「尚未落过检查点」', () => {
    expect(renderCheckpointNudgeLine(undefined)).toContain('（尚未落过检查点）');
  });
});

// ---------------------------------------------------------------------------
describe('提醒节流标记 + checkpointNudgeState（钩子取数，纯读无锁）', () => {
  it('writeNudgeMarker → readNudgeMarker 往返；缺/坏文件 → null', async () => {
    expect(await readNudgeMarker(root, 'alice')).toBeNull();
    await writeNudgeMarker(root, 'alice', T);
    expect(await readNudgeMarker(root, 'alice')).toBe(T);
    writeFileSync(join(checkpointDir(root, 'alice'), '.nudge'), 'not-a-time');
    expect(await readNudgeMarker(root, 'alice')).toBeNull();
  });

  it('checkpointNudgeState：数我的开放任务 + 最新检查点 mtime + .nudge', async () => {
    const team = newTeamState({ teamId: 'default', name: 'default', founderKey: 'lead', founder: member('lead'), now: T });
    team.members.push(member('alice'), member('bob'));
    team.tasks = [
      task({ id: 't-a', assignee: 'alice', status: 'in_progress' }),
      task({ id: 't-b', assignee: 'bob', status: 'in_progress' }),
      task({ id: 't-c', assignee: 'alice', status: 'completed' }),
      task({ id: 't-d', assignee: 'alice', status: 'pending' }),
    ];
    await writeTeam(root, team);
    await writeCheckpoint(root, data({ now: T - 5 * MIN }));
    await writeNudgeMarker(root, 'alice', T - 3 * MIN);

    const state = await checkpointNudgeState(root, 'alice', {}, T);
    expect(state.openTaskCount).toBe(1); // 只数 alice 的 OPEN_TASK_STATUSES
    expect(state.lastCheckpointAt).not.toBeNull();
    expect(state.lastNudgeAt).toBe(T - 3 * MIN);
  });

  it('team.json 不存在 → openTaskCount 0（负例方向：没活干不提醒）', async () => {
    const state = await checkpointNudgeState(root, 'ghost', {}, T);
    expect(state).toEqual({ openTaskCount: 0, lastCheckpointAt: null, lastNudgeAt: null });
  });
});

// ---------------------------------------------------------------------------
describe('未读索引：只抄索引不搬原文 + tool_request 帧遮蔽（R6）', () => {
  it('正文首行截 80 字符 + urgent 标记 + msgId 短 8 位', () => {
    const long = createMessage('bob', 'alice', `${'x'.repeat(200)}\n第二行`);
    const ref = checkpointUnreadRef({ ...long, urgent: true });
    expect(ref.subject).toHaveLength(80);
    expect(ref.urgent).toBe(true);
    expect(ref.from).toBe('bob');
  });

  it('tool_request 帧 subject 一律遮蔽（不给审批门开侧门）', () => {
    const frame = createMessage('lead', 'alice', JSON.stringify({ type: 'tool_request', tool: 'xc_claim', args: { taskId: 't-1' } }));
    expect(checkpointUnreadRef(frame).subject).toBe('[tool_request 审批门控帧]');
    // 普通聊天消息原样（截断后）
    const chat = createMessage('bob', 'alice', '普通消息');
    expect(checkpointUnreadRef(chat).subject).toBe('普通消息');
  });
});

// ---------------------------------------------------------------------------
describe('路径安全：段闸把穿越探针吸收成安全段', () => {
  it('探针清洗后无分隔符/点号，落点恒在 stateRoot 内', () => {
    for (const probe of ['../../etc', '..\\..\\windows', 'a/b', 'a\\b', '.', '..', 'C:\\x', 'con.md']) {
      const seg = safeCheckpointSegment(probe);
      expect(seg).not.toMatch(/[\\/.]/);
      expect(checkpointDir(root, seg).startsWith(checkpointsDir(root))).toBe(true);
    }
  });

  it('合法花名原样通过', () => {
    expect(safeCheckpointSegment('alice')).toBe('alice');
    expect(safeCheckpointSegment('worker-2')).toBe('worker-2');
  });

  it('journalDisplayPath 与 archive.taskJournalPath 同源', () => {
    expect(journalDisplayPath(root, 't-1')).toBe('.crosschat/tasks/t-1/journal.md');
  });
});

// ---------------------------------------------------------------------------
describe('CheckpointJournalTail 形状（供 G2 接手包复用同一读取助手）', () => {
  it('ok 态的 lines 与 status 可直嵌第 4 章', () => {
    const tail: CheckpointJournalTail = { taskId: 't', displayPath: '.crosschat/tasks/t/journal.md', lines: ['- x'], status: 'ok' };
    const md = buildCheckpointMarkdown(data({ journalTails: [tail] }));
    expect(md).toContain('### t（.crosschat/tasks/t/journal.md）');
    expect(md).toContain('- x');
  });
});

// ---------------------------------------------------------------------------
// v0.8.1（29 红队 C1-B01 / C1-B02 修复）：同毫秒并发不再静默覆写 + .tmp 残留清扫。
// ---------------------------------------------------------------------------
describe('writeCheckpoint：同毫秒并发的排他落盘（C1-B01）', () => {
  it('8 个同刻并发调用各得一份文件、各自 note 幸存（无静默覆写、无路径共享）', async () => {
    const calls = Array.from({ length: 8 }, (_, i) =>
      writeCheckpoint(root, data({ now: T, note: `p${i}-note` })),
    );
    const results = await Promise.all(calls);
    const paths = results.map((r) => r.path);
    expect(new Set(paths).size).toBe(8); // 一次调用一份文件（旧实现：同刻探针稳定撞名）
    const names = readdirSync(checkpointDir(root, 'alice')).filter((n) => n.endsWith('.md'));
    expect(names).toHaveLength(8);
    for (const [i, r] of results.entries()) {
      const text = readFileSync(r.path, 'utf8');
      expect(text).toContain(`p${i}-note`); // 先发者的内容不被后发者吞掉
      expect(text.endsWith('\n')).toBe(true);
    }
    // 字典序=时间序：stamp 互异且整体有序（latest 取最后一份）
    const stamps = results.map((r) => r.stamp);
    expect(new Set(stamps).size).toBe(8);
    expect([...stamps].sort()).toEqual(stamps.sort());
  });

  it('排他写撞名的轮次记入 stampCollisions（并发下 >0 时调用方/审计可见）', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => writeCheckpoint(root, data({ now: T, note: `c${i}` }))),
    );
    for (const r of results) {
      if (r.stampCollisions !== undefined) expect(r.stampCollisions).toBeGreaterThanOrEqual(1);
    }
    // 无论是否撞名：六份文件、六个 note 全幸存（不变量）
    for (const [i, r] of results.entries()) {
      expect(readFileSync(r.path, 'utf8')).toContain(`c${i}`);
    }
  });
});

describe('writeCheckpoint：.tmp 残留清扫（C1-B02）', () => {
  it('60s 外的残留 .tmp 被清掉；刚建的在途 temp 不碰；.md 与 .nudge 不受影响', async () => {
    const dir = checkpointDir(root, 'alice');
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, '2026-11-15T17-00-00-000Z.md.999.deadbeef.tmp');
    const fresh = join(dir, '2026-11-15T18-00-00-000Z.md.999.inflight.tmp');
    const keep = join(dir, '.nudge');
    writeFileSync(stale, 'x'.repeat(1024), 'utf8');
    writeFileSync(fresh, 'y'.repeat(1024), 'utf8');
    writeFileSync(keep, '2026-11-15T18:00:00.000Z\n', 'utf8');
    const old = Date.now() - 10 * 60_000; // 10min 前 → 超 60s 阈值
    utimesSync(stale, new Date(old), new Date(old));

    const result = await writeCheckpoint(root, data({ now: T, note: 'after-sweep' }));
    expect(result.tmpRemoved).toBe(1); // 只清残留那份
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // 在途写（毫秒级生命周期）不误删
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(result.path)).toBe(true);
  });

  it('sweepCheckpointTmpFiles：目录不存在 → 不抛、记 error；非 .tmp 文件不在清扫域', async () => {
    const missing = join(root, 'no-such-dir');
    const r1 = await sweepCheckpointTmpFiles(missing);
    expect(r1.removed).toBe(0);
    expect(typeof r1.error).toBe('string');

    const dir = checkpointDir(root, 'bob');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep.md'), 'x', 'utf8');
    writeFileSync(join(dir, 'keep.md.tmp'), 'x', 'utf8'); // 也在 .tmp 域（按后缀口径）
    const old = Date.now() - 10 * 60_000;
    utimesSync(join(dir, 'keep.md.tmp'), new Date(old), new Date(old));
    const r2 = await sweepCheckpointTmpFiles(dir);
    expect(r2).toEqual({ removed: 1 });
    expect(existsSync(join(dir, 'keep.md'))).toBe(true);
    expect(existsSync(join(dir, 'keep.md.tmp'))).toBe(false);
  });
});



// ---------------------------------------------------------------------------
// v0.8.1 红队二十九番修复回归（本组：C2-B4 检查点年龄取数 = front-matter createdAt 优先）
// ---------------------------------------------------------------------------

describe('checkpoint v0.8.1: 年龄取数 front-matter createdAt 优先（C2-B4）', () => {
  it('checkpointCreatedAtFromMarkdown：有合法 createdAt → 取它；缺/坏 → 回退 mtime', () => {
    const mtime = Date.UTC(2026, 10, 15, 12, 0, 0);
    const fm = '---\nagent: alice\ncreatedAt: 2026-11-15T09:30:00.000Z\ntaskCounts: {claimed:0, in_progress:0, blocked:0}\n---\n';
    expect(checkpointCreatedAtFromMarkdown(fm, mtime)).toBe(Date.UTC(2026, 10, 15, 9, 30, 0));
    // 无 front-matter（手写/外部文件）→ mtime 口径（宽容，不升级成「无检查点」）
    expect(checkpointCreatedAtFromMarkdown('---\nagent: alice\n---\n', mtime)).toBe(mtime);
    // 坏值（不可解析）→ mtime 口径
    expect(checkpointCreatedAtFromMarkdown('---\ncreatedAt: not-a-time\n---\n', mtime)).toBe(mtime);
    // createdAt 行必须在 front-matter 区内且整行匹配（正文里的同名词不冒领）
    expect(checkpointCreatedAtFromMarkdown('## 1. 身份\ncreatedAt: 2020-01-01T00:00:00.000Z\n', mtime)).toBe(mtime);
  });

  it('latestCheckpoint：mtime 被外部拨到 3h 前 → 年龄仍按 front-matter createdAt（拷贝/还原不失真）', async () => {
    const writtenAt = Date.now();
    const result = await writeCheckpoint(root, data({ now: writtenAt }));
    const old = new Date(writtenAt - 3 * 60 * 60_000);
    utimesSync(result.path, old, old); // 模拟外部拷贝/同步工具重置 mtime
    const latest = await latestCheckpoint(root, 'alice', writtenAt + 5 * 60_000);
    expect(latest).not.toBeNull();
    expect(latest!.createdAt).toBe(writtenAt); // front-matter 优先，不用 mtime
    expect(latest!.ageMin).toBe(5); // 旧实现此处得 180（mtime 口径）
  });

  it('latestCheckpoint：无 front-matter 的手写文件 → 回退 mtime（既有宽容不回归）', async () => {
    const dir = checkpointDir(root, 'alice');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '2026-11-15T18-00-00-000Z.md');
    writeFileSync(path, '---\nagent: alice\n---\n', 'utf8');
    const mtime = new Date(Date.now() - 45 * 60_000);
    utimesSync(path, mtime, mtime);
    const latest = await latestCheckpoint(root, 'alice', Date.now());
    expect(latest!.ageMin).toBe(45);
    expect(latest!.createdAt).toBe(mtime.getTime());
  });
});
