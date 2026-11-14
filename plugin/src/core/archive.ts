/**
 * v0.6 C4：成员留档 archive/<name>/ 写入与读取（DESIGN-V0.6.md §3.4；E3 §④ 实证）。
 *
 * 磁盘形态（member-stop 且 archive:true（缺省 true）时由 mcp/tools-team 调用写入；
 * xc_read(scope:"journal", id:"archive:<name>") 读取）：
 *
 *   <.crosschat>/archive/<name>/
 *   ├── journal.md   # 三节聚合：负责任务 / 当前进度 / 交接注意（E3 §④ 读档三要素形态）
 *   └── meta.json    # {name, sessionId, archivedAt, reason, tasks[], unread[]}
 *
 * 任务侧日志（成员用纯文件工具写，工具不强制校验内容）：
 *   <.crosschat>/tasks/<taskId>/journal.md
 *
 * 路径安全（DESIGN §3.4/P0 条款 4-③）：`<name>`/`<taskId>` 一律先过 sanitizeKey
 * （core/sanitize.ts）再拼路径——清洗把一切非字母数字 run 折成 `-`，`..` 与路径
 * 分隔符在结构上不可能存活；safeSegment 再做一次断言级复核（防御纵深），任何
 * 残留分隔符/点号即抛错。**工具层必须经由本模块的路径构建器取路径，禁止自行 join**
 * ——`xc_read(scope:"journal", id:"../../etc")` 这类穿越探针由 sanitize 吸收为
 * 安全段（P0 对抗清单覆盖项）。
 *
 * 未读索引：stop 时把该成员邮箱未读消息的 id/from/ts/预览抄进 meta（preview 截
 * 200 字符）——只抄索引不搬运原文，邮箱 JSONL 真源不动。
 *
 * 捡起三步（E3 §④ 16s 实证；longtask skill §2）：①xc_identify({name}) ②
 * xc_read(scope:"journal", id:"archive:<name>") ③按 journal 指针 xc_read(scope:"task")。
 * 同名重加是全新生命周期（provision.ts:54），archive 读档是唯一续上下文路径。
 *
 * @module core/archive
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic, stripLeadingBom } from './atomic.js';
import { sanitizeKey } from './sanitize.js';
import type { TaskStatus } from './types.js';

/** meta.unread[].preview 上限（DESIGN §4.2-M7：preview ≤200 字符）。 */
export const ARCHIVE_PREVIEW_MAX_CHARS = 200;

/** 留档里引用的一个任务（tasks 列表行）。 */
export interface ArchiveTaskRef {
  taskId: string;
  title: string;
  status: TaskStatus;
}

/** 留档里引用的一条未读消息（只抄索引，不搬运原文）。 */
export interface ArchiveUnreadRef {
  msgId: string;
  from: string;
  ts: number;
  /** ≤200 字符的正文预览。 */
  preview: string;
}

/** meta.json 结构（DESIGN §4.2-M7）。 */
export interface ArchiveMeta {
  name: string;
  sessionId: string;
  archivedAt: number;
  reason: string;
  tasks: ArchiveTaskRef[];
  unread: ArchiveUnreadRef[];
}

// --- 路径构建（全部入口都在此过安全闸；调用方不得自行 join）-------------------

/**
 * 安全段闸：sanitizeKey 清洗后复核——非空、无 `.`、无路径分隔符。清洗链把一切
 * 非 \p{L}\p{N} run 折成 `-`（sanitize.ts:106-115），复核属防御纵深（结构性不可能
 * 触发；触发即说明清洗链被改，立即抛错防穿越）。
 */
function safeSegment(raw: string, what: string): string {
  const key = sanitizeKey(typeof raw === 'string' ? raw : '');
  if (key === '' || key.includes('.') || key.includes('/') || key.includes('\\')) {
    throw new Error(`archive_${what}_unsafe: "${String(raw).slice(0, 80)}" 清洗后（"${key}"）仍含路径敏感字符`);
  }
  return key;
}

/** `<.crosschat>/archive/<name>/`（name 过 sanitizeKey）。 */
export function archiveDirPath(stateRoot: string, name: string): string {
  return join(stateRoot, 'archive', safeSegment(name, 'name'));
}

/** 留档 journal：`<.crosschat>/archive/<name>/journal.md`（xc_read journal scope 的读点）。 */
export function archiveJournalPath(stateRoot: string, name: string): string {
  return join(archiveDirPath(stateRoot, name), 'journal.md');
}

/** 留档 meta：`<.crosschat>/archive/<name>/meta.json`。 */
export function archiveMetaPath(stateRoot: string, name: string): string {
  return join(archiveDirPath(stateRoot, name), 'meta.json');
}

/** 任务日志：`<.crosschat>/tasks/<taskId>/journal.md`（成员纯文件工具写；xc_read journal scope 读）。 */
export function taskJournalPath(stateRoot: string, taskId: string): string {
  return join(stateRoot, 'tasks', safeSegment(taskId, 'taskId'), 'journal.md');
}

// --- 三节聚合（E3 §④ 读档三要素：负责任务 / 当前进度 / 交接注意）-------------

export interface JournalSectionSource {
  /** 成员花名（经 sanitizeKey 后进标题；调用方一般已持 key）。 */
  name: string;
  /** 停机/留档原因（tools-team member-stop 的 reason）。 */
  reason: string;
  /** 留档时刻（ms epoch）。 */
  archivedAt: number;
  /** 名下任务清单（回池前快照）。 */
  tasks: readonly ArchiveTaskRef[];
  /** 各任务 journal.md 聚合正文（body 原样嵌入「当前进度」节）。 */
  taskJournals?: ReadonlyArray<{ taskId: string; body: string }>;
  /** 交接注意自定义补充；缺省用接手三步模板（恢复模板）。 */
  handoff?: string;
}

/** 缺省交接注意 = 恢复模板（捡起三步；E3 §④ + longtask skill §2）。 */
export function defaultHandoff(name: string, tasks: readonly ArchiveTaskRef[]): string {
  const lines = [
    '- 接手三步：①xc_identify({ "name": "' + name + '" })（原成员已 stop，须新会话重绑定；旧会话崩溃场景加 takeover:true）',
    '- ②xc_read({ "scope": "journal", "id": "archive:' + name + '" }) 读本留档（当前进度/交接注意）',
  ];
  if (tasks.length > 0) {
    lines.push(
      '- ③按下方任务清单逐个 xc_read({ "scope": "task", "id": "<taskId>", "field": "prompt" }) 取任务原文，'
      + '以新 attempt xc_claim 认领续作；接手后在对应任务 journal 记一行「接手」',
    );
  } else {
    lines.push('- ③本名无负责任务；如需新任务等 lead 派发或自行从 overview 取单');
  }
  lines.push('- 注意：同名重加是全新生命周期（不继承上下文），archive 读档是唯一续上下文路径');
  return lines.join('\n');
}

/**
 * 聚合三节 journal 全文（写档用）。三节标题顺序固定（E3 §④ 实证读档三要素全中的
 * 形态）：`## 负责任务` → `## 当前进度` → `## 交接注意`。
 */
export function buildJournalSections(src: JournalSectionSource): string {
  const name = safeSegment(src.name, 'name');
  const iso = new Date(src.archivedAt).toISOString();
  const out: string[] = [];
  out.push(`# ${name} 留档（${iso}，原因：${src.reason === '' ? '未注明' : src.reason}）`);
  out.push('');
  out.push('## 负责任务');
  const tasks = Array.isArray(src.tasks) ? src.tasks : [];
  if (tasks.length === 0) {
    out.push('（无负责任务）');
  } else {
    for (const t of tasks) {
      out.push(`- ${t.taskId} [${t.status}] ${t.title}`);
    }
  }
  out.push('');
  out.push('## 当前进度');
  const journals = Array.isArray(src.taskJournals) ? src.taskJournals : [];
  const present = journals.filter((j) => typeof j?.taskId === 'string' && j.taskId !== '');
  if (present.length === 0) {
    out.push('（无任务日志——接手请直接从任务 prompt 读起）');
  } else {
    for (const j of present) {
      const ref = tasks.find((t) => t.taskId === j.taskId);
      out.push(`### ${j.taskId}${ref ? ` ${ref.title}` : ''}`);
      out.push(typeof j.body === 'string' ? j.body.replace(/\s+$/, '') : '');
      out.push('');
    }
  }
  out.push('## 交接注意');
  out.push(typeof src.handoff === 'string' && src.handoff.trim() !== '' ? src.handoff.trim() : defaultHandoff(name, tasks));
  out.push('');
  return out.join('\n');
}

// --- 写入 / 读取 ---------------------------------------------------------------

export interface WriteArchiveInput {
  /** 停机/留档原因（入 meta.reason 与 journal 标题）。 */
  reason: string;
  /** 名下任务清单（member-stop 的回池前快照）。 */
  tasks?: ArchiveTaskRef[];
  /** 邮箱未读索引（member-stop 读取侧抄录；preview 截 200 字符）。 */
  unread?: ArchiveUnreadRef[];
  /** 三节正文；缺省由 buildJournalSections 聚合（tasks/taskJournals/handoff）。 */
  journalSections?: string;
  /** 各任务 journal 正文（journalSections 未提供时用于聚合）。 */
  taskJournals?: ReadonlyArray<{ taskId: string; body: string }>;
  /** 交接注意补充（journalSections 未提供时使用）。 */
  handoff?: string;
  /** 留档时刻；缺省 Date.now()（单测注入用）。 */
  now?: number;
}

export interface WriteArchiveResult {
  dir: string;
  journalPath: string;
  metaPath: string;
  meta: ArchiveMeta;
}

/**
 * 写留档（member-stop 停机通知之前调用；DESIGN §3.4）。同名重复 stop → 原子覆盖
 * （留档是「该名最新一次休眠」的快照，不是历史累积）。preview 截 200 字符为
 * 结构性保证——调用方超长也安全。写失败向上抛（调用方据此走「不丢任务回池」
 * 的失败路径，P0 条款 4-⑦）。
 */
export async function writeArchive(
  stateRoot: string,
  member: { name: string; sessionId: string },
  input: WriteArchiveInput,
): Promise<WriteArchiveResult> {
  const key = safeSegment(member.name, 'name');
  const now = typeof input.now === 'number' && Number.isFinite(input.now) && input.now >= 0 ? Math.floor(input.now) : Date.now();
  const reason = typeof input.reason === 'string' ? input.reason : '';
  const tasks = normalizeTasks(input.tasks);
  const unread = normalizeUnread(input.unread);
  const sections =
    typeof input.journalSections === 'string' && input.journalSections.trim() !== ''
      ? input.journalSections
      : buildJournalSections({ name: key, reason, archivedAt: now, tasks, taskJournals: input.taskJournals, handoff: input.handoff });
  const dir = archiveDirPath(stateRoot, key);
  await mkdir(dir, { recursive: true });
  const meta: ArchiveMeta = { name: key, sessionId: typeof member.sessionId === 'string' ? member.sessionId : '', archivedAt: now, reason, tasks, unread };
  const journalPath = join(dir, 'journal.md');
  const metaPath = join(dir, 'meta.json');
  await writeFileAtomic(journalPath, sections.endsWith('\n') ? sections : `${sections}\n`);
  await writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { dir, journalPath, metaPath, meta };
}

export interface ArchiveReadResult {
  dir: string;
  /** journal.md 全文。 */
  journal: string;
  /** meta.json 解析结果；缺文件/损坏时 null（journal 仍在——留档正文优先可读）。 */
  meta: ArchiveMeta | null;
}

/**
 * 读留档（xc_read scope:"journal" id:"archive:<name>" 的取数函数）。目录不存在
 * → null；journal 在而 meta 损坏 → meta:null（不因索引坏而丢正文）。
 */
export async function readArchive(stateRoot: string, name: string): Promise<ArchiveReadResult | null> {
  const key = safeSegment(name, 'name');
  const dir = archiveDirPath(stateRoot, key);
  let journal: string;
  try {
    journal = await readFile(archiveJournalPath(stateRoot, key), 'utf8');
  } catch {
    return null;
  }
  let meta: ArchiveMeta | null = null;
  try {
    const parsed = JSON.parse(stripLeadingBom(await readFile(archiveMetaPath(stateRoot, key), 'utf8'))) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as ArchiveMeta;
    }
  } catch {
    meta = null;
  }
  return { dir, journal, meta };
}

// --- 防御归一（调用方字段容错 + preview 上限结构性保证）-----------------------

function normalizeTasks(tasks: readonly ArchiveTaskRef[] | undefined): ArchiveTaskRef[] {
  const list = Array.isArray(tasks) ? tasks : [];
  return list
    .filter((t) => t !== null && typeof t === 'object' && typeof t.taskId === 'string' && t.taskId !== '')
    .map((t) => ({
      taskId: t.taskId,
      title: typeof t.title === 'string' ? t.title : '',
      status: t.status,
    }));
}

function normalizeUnread(unread: readonly ArchiveUnreadRef[] | undefined): ArchiveUnreadRef[] {
  const list = Array.isArray(unread) ? unread : [];
  return list
    .filter((u) => u !== null && typeof u === 'object' && typeof u.msgId === 'string' && u.msgId !== '')
    .map((u) => ({
      msgId: u.msgId,
      from: typeof u.from === 'string' ? u.from : '',
      ts: Number.isFinite(Number(u.ts)) ? Number(u.ts) : 0,
      preview: typeof u.preview === 'string' ? u.preview.slice(0, ARCHIVE_PREVIEW_MAX_CHARS) : '',
    }));
}
