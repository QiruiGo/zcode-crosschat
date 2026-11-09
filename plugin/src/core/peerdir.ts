/**
 * W1 peer-registry: machine-global peer root resolution + every peer path builder.
 *
 * Layout (DESIGN-V0.3.md §3.1):
 *
 *   ${ZCODE_PLUGIN_DATA}/peers/
 *   ├── sessions/<pid>.json          ← peer 注册记录（文件名即 pid）
 *   ├── keys/<pid>.<sha256(sock)>.key← 传输令牌发布文件
 *   ├── base/<sessionId>.json        ← 钩子写的会话基记录（档类真源）
 *   ├── inbox/<sessionId>.jsonl      ← 传输级收件箱（退化投递目标）
 *   ├── queue/<sessionId>.jsonl      ← 投递级队列（过闸后，模型可见）
 *   ├── held/<sessionId>/<msgId>.json← hold 隔离区
 *   └── logs/peer.jsonl              ← 跨会话域审计
 *
 * 根目录解析优先级（§3.1）：`XC_MESSAGING_DIR` > `ZCODE_PLUGIN_DATA` + `/peers`
 * > `~/.zcode/cli/plugins/data/<pluginId>@<marketplace>/peers`。
 *
 * 本模块只管「路径 + 基记录 IO」；记录的 schema、扫描、活性判定、清扫、名字占用
 * 在 peerregistry.ts（§10.1 所有权表）。
 *
 * @module core/peerdir
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic, stripLeadingBom } from './atomic.js';

/** Peer 根目录名（挂在插件数据目录下）。 */
export const PEER_ROOT_DIR_NAME = 'peers';

/** 本插件的默认插件 id（回退路径用；marketplace 名见 marketplace.json）。 */
export const PEER_DEFAULT_PLUGIN_ID = 'zcode-crosschat';
/** 本插件的默认 marketplace 名（回退路径用）。 */
export const PEER_DEFAULT_MARKETPLACE = 'dev-zcode-crosschat';

/**
 * 机器全局 peer 根目录（DESIGN-V0.3 §3.1）。
 *
 * - `XC_MESSAGING_DIR`：显式覆盖（用户自定的绝对路径，SPEC R-1）。
 * - `ZCODE_PLUGIN_DATA`：插件数据目录（实测在 MCP server 进程与钩子进程都存在，
 *   FEASIBILITY-V0.3 §1.2），peer 根 = 其下的 `peers/`。
 * - 回退：`~/.zcode/cli/plugins/data/<pluginId>@<marketplace>/peers`。
 *
 * 该根目录跨工作区可见——这是「跨会话」轴的构造性前提（SPEC R-1）。
 */
export function peerRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['XC_MESSAGING_DIR'];
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim());
  const pluginData = env['ZCODE_PLUGIN_DATA'];
  if (typeof pluginData === 'string' && pluginData.trim() !== '') {
    return join(resolve(pluginData.trim()), PEER_ROOT_DIR_NAME);
  }
  const pluginId = env['ZCODE_PLUGIN_ID']?.trim() || PEER_DEFAULT_PLUGIN_ID;
  return join(
    homedir(),
    '.zcode',
    'cli',
    'plugins',
    'data',
    `${pluginId}@${PEER_DEFAULT_MARKETPLACE}`,
    PEER_ROOT_DIR_NAME,
  );
}

// ---------------------------------------------------------------------------
// 路径构造（§3.1 布局）
// ---------------------------------------------------------------------------

/** `sessions/`：peer 注册记录目录。 */
export function peerSessionsDir(root: string): string {
  return join(root, 'sessions');
}

/** `sessions/<pid>.json`：单个 peer 的注册记录（文件名即 pid）。 */
export function peerRecordFile(root: string, pid: number): string {
  return join(peerSessionsDir(root), `${pid}.json`);
}

/** `keys/`：传输令牌（key 文件）目录。 */
export function peerKeysDir(root: string): string {
  return join(root, 'keys');
}

/**
 * `keys/<pid>.<sha256(规范管道路径)>.key`（SPEC R-6 / §3.1）。
 * 摘要对规范化的管道路径取：Windows 下大小写不敏感 ⇒ 先转小写再摘要。
 */
export function peerKeyFile(root: string, pid: number, socketPath: string): string {
  return join(peerKeysDir(root), `${pid}.${canonicalSocketDigest(socketPath)}.key`);
}

/** 管道路径的规范摘要（key 文件名 + 令牌查找共用）。 */
export function canonicalSocketDigest(socketPath: string): string {
  const canonical = process.platform === 'win32' ? socketPath.replaceAll('\\', '/').toLowerCase() : socketPath;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** `base/`：钩子写的会话基记录目录。 */
export function peerBaseDir(root: string): string {
  return join(root, 'base');
}

/** `base/<sessionId>.json`：会话基记录（permissionMode 真源 + 兜底身份）。 */
export function peerBaseFile(root: string, sessionId: string): string {
  return join(peerBaseDir(root), `${sessionId}.json`);
}

/** `inbox/`：传输级收件箱目录。 */
export function peerInboxDir(root: string): string {
  return join(root, 'inbox');
}

/** `inbox/<sessionId>.jsonl`：传输级收件箱（退化投递落点）。 */
export function peerInboxFile(root: string, sessionId: string): string {
  return join(peerInboxDir(root), `${sessionId}.jsonl`);
}

/** `queue/`：投递级队列目录。 */
export function peerQueueDir(root: string): string {
  return join(root, 'queue');
}

/** `queue/<sessionId>.jsonl`：投递级队列（过闸后、模型可见）。 */
export function peerQueueFile(root: string, sessionId: string): string {
  return join(peerQueueDir(root), `${sessionId}.jsonl`);
}

/** `held/<sessionId>/`：hold 隔离区目录。 */
export function peerHeldDir(root: string, sessionId: string): string {
  return join(root, 'held', sessionId);
}

/**
 * `held/<sessionId>/<msgId>.json`：单条 hold 消息的隔离文件。
 *
 * The msgId comes from the peer (untrusted input), so it is folded into ONE
 * safe path segment: a readable id is kept as is, anything else (`..`, path
 * separators, over-long) becomes a digest name. The true msgId always lives
 * inside the file content; readers enumerate the directory instead of guessing
 * file names.
 */
export function peerHeldFile(root: string, sessionId: string, msgId: string): string {
  return join(peerHeldDir(root, sessionId), `${peerHeldFileSegment(msgId)}.json`);
}

/** Fold a msgId into one safe path segment (readable ids are kept). */
export function peerHeldFileSegment(msgId: string): string {
  const value = msgId.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) return value;
  return `m-${createHash('sha256').update(msgId, 'utf8').digest('hex').slice(0, 24)}`;
}

/** `logs/`：跨会话域审计目录。 */
export function peerLogsDir(root: string): string {
  return join(root, 'logs');
}

/** `logs/peer.jsonl`：跨会话域审计日志（机器全局）。 */
export function peerAuditLogFile(root: string): string {
  return join(peerLogsDir(root), 'peer.jsonl');
}

// ---------------------------------------------------------------------------
// 机器域标识（pidDomain，§3.1）
// ---------------------------------------------------------------------------

/**
 * 本机域标识摘要（16 hex）。
 *
 * CC 的 `pidDomain` 是「机器域标识」（@4328914），异域记录不进本机发现集
 * （`ne()` @9603429）。zcode 的取值口径是**自定的稳定摘要**（§3.1）：
 * 机器名 + 用户名 的 sha256 前 16 hex。
 *
 * ⚠ 一致性要求（跨模块硬约束）：**写入方与判定方必须算出同一个值**，否则
 * 本机写下的记录会被判成「异域」而从发现集里消失（peer 互相看不见）。
 * W6 的 `mcp/peer-tools.ts` 用了同一口径（COMPUTERNAME:USERNAME 的 sha256
 * 前 16 hex），本函数是它的规范实现；{@link localPidDomains} 另外保留一份
 * 历史口径并以「两者都算本机」的方式判定，避免并行实现期间出现假异域。
 */
export function localPidDomain(): string {
  const material = `${process.env['COMPUTERNAME'] ?? 'unknown'}:${process.env['USERNAME'] ?? 'unknown'}`;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

/** 已知等价的本机域口径（规范口径 + 历史口径）。 */
export function localPidDomains(): string[] {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = '';
  }
  const legacy = createHash('sha256')
    .update([hostname(), user, homedir(), process.platform].join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, 16);
  const canonical = localPidDomain();
  return legacy === canonical ? [canonical] : [canonical, legacy];
}

/** Whether a domain digest belongs to this machine. */
export function isLocalPidDomain(domain: string): boolean {
  return localPidDomains().includes(domain);
}

// ---------------------------------------------------------------------------
// 基记录 IO（钩子写；§11.2 / §11.4 的落盘逻辑落在这里）
// ---------------------------------------------------------------------------

/** 会话基记录（`base/<sessionId>.json`）——档类真源。 */
export interface PeerBaseRecord {
  sessionId: string;
  cwd: string;
  /** 收方权限档类：bypass / prompting；缺失 = 未知（fail-closed）。 */
  permissionMode?: 'bypass' | 'prompting';
  /** 宿主会话来源（钩子载荷的 source）。 */
  source: string | null;
  startedAt: number;
  lastSeen: number;
}

function isPeerBaseRecord(value: unknown): value is PeerBaseRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record['sessionId'] === 'string'
    && typeof record['cwd'] === 'string'
    && typeof record['startedAt'] === 'number'
    && typeof record['lastSeen'] === 'number';
}

/**
 * 写会话基记录（钩子 SessionStart / UserPromptSubmit 调用）。
 * 原子写（core/atomic.ts 的 tmp+rename，Windows EPERM 重试降级）。
 */
export async function writePeerBaseRecord(root: string, record: PeerBaseRecord): Promise<void> {
  const file = peerBaseFile(root, record.sessionId);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * 刷新基记录的档类与 lastSeen（读-改-写合并，CC `xn()` 语义 @4332192）。
 * 基记录不存在时**不**凭空创建（缺基记录 = 档类未知 = fail-closed hold，
 * §6.2 ③），调用方需要创建时走 writePeerBaseRecord。
 */
export async function refreshPeerBaseRecord(
  root: string,
  sessionId: string,
  patch: { permissionMode?: 'bypass' | 'prompting'; lastSeen: number },
): Promise<void> {
  const file = peerBaseFile(root, sessionId);
  let current: PeerBaseRecord | undefined;
  try {
    const raw = stripLeadingBom(await readFile(file, 'utf8'));
    const parsed: unknown = JSON.parse(raw);
    if (isPeerBaseRecord(parsed)) current = parsed;
  } catch {
    current = undefined;
  }
  if (current === undefined) return;
  const next: PeerBaseRecord = {
    ...current,
    ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
    lastSeen: patch.lastSeen,
  };
  await writePeerBaseRecord(root, next);
}

/** 读会话基记录；缺失或坏记录返回 undefined（不抛）。 */
export async function readPeerBaseRecord(root: string, sessionId: string): Promise<PeerBaseRecord | undefined> {
  try {
    const raw = stripLeadingBom(await readFile(peerBaseFile(root, sessionId), 'utf8'));
    const parsed: unknown = JSON.parse(raw);
    return isPeerBaseRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
