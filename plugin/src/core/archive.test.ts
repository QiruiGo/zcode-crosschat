/**
 * C4 archive 单测（DESIGN-V0.6.md §3.4 / §4.2-M7；P0 条款 4-③ 穿越探针覆盖）：
 * - writeArchive/readArchive 往返（journal 三节 + meta 全字段）；
 * - 路径安全：name/taskId 的 `..`、分隔符、混合穿越探针一律被 sanitize 吸收，
 *   落点恒在 stateRoot 内（P0「越权写」对抗项的模块级断言）；
 * - preview ≤200 截断、损坏 meta 降级、覆盖语义、CJK 名往返；
 * - buildJournalSections 三节顺序/自定义 handoff/缺省恢复模板。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ARCHIVE_PREVIEW_MAX_CHARS,
  archiveDirPath,
  archiveJournalPath,
  archiveMetaPath,
  buildJournalSections,
  defaultHandoff,
  readArchive,
  taskJournalPath,
  writeArchive,
} from './archive.js';
import type { ArchiveUnreadRef } from './archive.js';

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xc-archive-'));
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

const T = 1731568920000; // 固定时刻（2026-11-14T07:22:00Z 附近），ISO 断言用

function unread(msgId: string, preview = '正文预览'): ArchiveUnreadRef {
  return { msgId, from: 'lead', ts: 1, preview };
}

describe('writeArchive → readArchive 往返', () => {
  it('journal 三节在场 + meta 全字段；preview 截 200', async () => {
    const longPreview = '甲'.repeat(300);
    const res = await writeArchive(
      root,
      { name: 'builder', sessionId: 'sess_x1' },
      {
        reason: '容量预警休眠',
        tasks: [
          { taskId: '86e8b61a-t1', title: '平方表', status: 'in_progress' },
          { taskId: '86e8b61a-t2', title: '求和', status: 'blocked' },
        ],
        unread: [unread('m1', longPreview), unread('m2')],
        taskJournals: [{ taskId: '86e8b61a-t1', body: '- 2026-11-14 15:02 | 完成 X | D:\\ws\\out\\x.txt' }],
        now: T,
      },
    );
    expect(res.dir).toBe(join(root, 'archive', 'builder'));
    expect(res.meta.name).toBe('builder');
    expect(res.meta.sessionId).toBe('sess_x1');
    expect(res.meta.archivedAt).toBe(T);
    expect(res.meta.reason).toBe('容量预警休眠');
    expect(res.meta.tasks).toHaveLength(2);
    expect(res.meta.tasks[0]).toMatchObject({ taskId: '86e8b61a-t1', status: 'in_progress' });
    expect(res.meta.unread[0].preview).toHaveLength(ARCHIVE_PREVIEW_MAX_CHARS); // 300 → 200
    expect(res.meta.unread[1].preview).toBe('正文预览');

    const journal = readFileSync(res.journalPath, 'utf8');
    const i1 = journal.indexOf('## 负责任务');
    const i2 = journal.indexOf('## 当前进度');
    const i3 = journal.indexOf('## 交接注意');
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(journal).toContain('- 86e8b61a-t1 [in_progress] 平方表');
    expect(journal).toContain('- 86e8b61a-t2 [blocked] 求和');
    expect(journal).toContain('完成 X');
    expect(journal).toContain(defaultHandoff('builder', res.meta.tasks).slice(0, 30)); // 缺省恢复模板在场

    const metaOnDisk = JSON.parse(readFileSync(res.metaPath, 'utf8')) as { name: string; unread: unknown[] };
    expect(metaOnDisk.name).toBe('builder');
    expect(metaOnDisk.unread).toHaveLength(2);

    const back = await readArchive(root, 'builder');
    expect(back).not.toBeNull();
    expect(back?.journal).toBe(journal);
    expect(back?.meta?.archivedAt).toBe(T);
    expect(back?.dir).toBe(res.dir);
  });

  it('同名覆盖：第二次写入生效（留档=最新一次休眠快照）', async () => {
    await writeArchive(root, { name: 'a', sessionId: 's1' }, { reason: 'r1', tasks: [], unread: [], now: T });
    const second = await writeArchive(root, { name: 'a', sessionId: 's2' }, { reason: 'r2', tasks: [], unread: [], now: T + 5 });
    const back = await readArchive(root, 'a');
    expect(back?.meta?.sessionId).toBe('s2');
    expect(back?.meta?.reason).toBe('r2');
    expect(back?.meta?.archivedAt).toBe(T + 5);
    expect(second.metaPath).toBe(join(root, 'archive', 'a', 'meta.json'));
  });

  it('CJK 名往返：\p{L} 字母保留，路径与读档一致', async () => {
    const res = await writeArchive(root, { name: '测试员一', sessionId: 's' }, { reason: '休眠', tasks: [], unread: [], now: T });
    expect(res.dir).toBe(join(root, 'archive', '测试员一'));
    expect(existsSync(join(root, 'archive', '测试员一', 'journal.md'))).toBe(true);
    const back = await readArchive(root, '测试员一');
    expect(back?.meta?.name).toBe('测试员一');
  });

  it('空输入容错：无任务/无未读 → 三节仍在、空列表归一', async () => {
    const res = await writeArchive(root, { name: 'idle-one', sessionId: 's' }, { reason: '', now: T });
    expect(res.meta.tasks).toEqual([]);
    expect(res.meta.unread).toEqual([]);
    expect(res.meta.reason).toBe('');
    const journal = readFileSync(res.journalPath, 'utf8');
    expect(journal).toContain('（无负责任务）');
    expect(journal).toContain('（无任务日志——接手请直接从任务 prompt 读起）');
    expect(journal).toContain('原因：未注明');
  });
});

describe('路径安全（P0 条款 4-③：穿越探针不越 stateRoot）', () => {
  it("name='../../etc' → 落 archive/etc，绝不逃出 stateRoot", async () => {
    const res = await writeArchive(root, { name: '../../etc', sessionId: 's' }, { reason: 'probe', tasks: [], unread: [], now: T });
    expect(res.dir).toBe(join(root, 'archive', 'etc')); // sanitize 把 ../ 折掉
    const resolvedRoot = resolve(root);
    expect(resolve(res.dir).startsWith(resolvedRoot)).toBe(true);
    expect(existsSync(join(resolvedRoot, '..', 'etc'))).toBe(false); // stateRoot 之侧未出现新 etc
    const back = await readArchive(root, '../../etc'); // 读路径同样吸收
    expect(back?.dir).toBe(res.dir);
  });

  it("taskId='..\\\\..\\\\windows' 与 id='../../etc' 读点均落在 tasks/ 与 archive/ 内", () => {
    expect(taskJournalPath(root, '..\\..\\windows')).toBe(join(root, 'tasks', 'windows', 'journal.md'));
    expect(taskJournalPath(root, '../../../x')).toBe(join(root, 'tasks', 'x', 'journal.md'));
    expect(archiveJournalPath(root, '../peer')).toBe(join(root, 'archive', 'peer', 'journal.md'));
    expect(archiveMetaPath(root, 'a/b')).toBe(join(root, 'archive', 'a-b', 'meta.json')); // 分隔符折成 -
    for (const p of [taskJournalPath(root, '..\\..\\windows'), archiveJournalPath(root, '../peer')]) {
      expect(resolve(p).startsWith(resolve(root))).toBe(true);
    }
  });

  it('绝对盘符路径探针（C:\\evil）同样被清洗吸收', () => {
    expect(taskJournalPath(root, 'C:\\evil')).toBe(join(root, 'tasks', 'c-evil', 'journal.md'));
  });

  it('盘点：探针执行后 stateRoot 外无新建目录', async () => {
    const before = existsSync(join(root, 'tasks'));
    await writeArchive(root, { name: '../../outside', sessionId: 's' }, { reason: 'probe', tasks: [], unread: [], now: T });
    void taskJournalPath(root, '../../outside2');
    expect(existsSync(join(root, 'tasks'))).toBe(false); // taskJournalPath 只算不写
    expect(before).toBe(false);
    // 真实落点只在内
    expect(existsSync(join(root, 'archive', 'outside'))).toBe(true);
    expect(existsSync(join(root, 'archive'))).toBe(true);
  });
});

describe('readArchive 降级', () => {
  it('留档不存在 → null', async () => {
    expect(await readArchive(root, 'nobody')).toBeNull();
  });

  it('meta.json 损坏 → meta:null 但 journal 仍返回（正文优先可读）', async () => {
    await writeArchive(root, { name: 'half', sessionId: 's' }, { reason: 'r', tasks: [], unread: [], now: T });
    writeFileSync(archiveMetaPath(root, 'half'), '{corrupt', 'utf8');
    const back = await readArchive(root, 'half');
    expect(back).not.toBeNull();
    expect(back?.journal).toContain('# half 留档');
    expect(back?.meta).toBeNull();
  });

  it('meta.json 缺失 → journal 仍返回', async () => {
    await writeArchive(root, { name: 'nometa', sessionId: 's' }, { reason: 'r', tasks: [], unread: [], now: T });
    rmSync(archiveMetaPath(root, 'nometa'));
    const back = await readArchive(root, 'nometa');
    expect(back?.meta).toBeNull();
    expect(back?.journal.length).toBeGreaterThan(0);
  });

  it('meta.json 为数组（形状不对）→ meta:null', async () => {
    await writeArchive(root, { name: 'arrmeta', sessionId: 's' }, { reason: 'r', tasks: [], unread: [], now: T });
    writeFileSync(archiveMetaPath(root, 'arrmeta'), '[]', 'utf8');
    const back = await readArchive(root, 'arrmeta');
    expect(back?.meta).toBeNull();
  });
});

describe('buildJournalSections（三节聚合）', () => {
  it('自定义 handoff 替换缺省模板；taskJournals 按任务分节嵌入', () => {
    const text = buildJournalSections({
      name: 'a',
      reason: '休眠',
      archivedAt: T,
      tasks: [{ taskId: 't1', title: '任务一', status: 'claimed' }],
      taskJournals: [{ taskId: 't1', body: '- 11-14 | 做了一半\n- 11-14 | 产物 D:\\x' }],
      handoff: '不要调 xc_idle；先看 D:\\x 再续作',
    });
    const i1 = text.indexOf('## 负责任务');
    const i2 = text.indexOf('## 当前进度');
    const i3 = text.indexOf('## 交接注意');
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(text).toContain('### t1 任务一');
    expect(text).toContain('产物 D:\\x');
    expect(text).toContain('不要调 xc_idle');
    expect(text).not.toContain('接手三步'); // 自定义 handoff 时不混入缺省模板
  });

  it('缺省恢复模板含三步与全新生命周期警告', () => {
    const h = defaultHandoff('w1', [{ taskId: 't1', title: 'x', status: 'in_progress' }]);
    expect(h).toContain('xc_identify({ "name": "w1" })');
    expect(h).toContain('archive:w1');
    expect(h).toContain('"scope": "task"');
    expect(h).toContain('全新生命周期');
    const hEmpty = defaultHandoff('w2', []);
    expect(hEmpty).toContain('无负责任务');
  });

  it('超长 journal body 尾部空白被收拢；taskJournals 与 tasks 不匹配也安全', () => {
    const text = buildJournalSections({
      name: 'b',
      reason: 'r',
      archivedAt: T,
      tasks: [],
      taskJournals: [{ taskId: 'ghost-task', body: '行\n\n\n' }],
    });
    expect(text).toContain('### ghost-task'); // 孤儿 journal 仍列出（信息不丢）
    expect(text).not.toMatch(/\n{4,}/);
  });
});
