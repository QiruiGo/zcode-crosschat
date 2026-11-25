/**
 * M1 core-store: state-root resolution and every on-disk path builder.
 *
 * Disk layout (DESIGN.md §2.2, 1:1 port of dsh state.js:4-12 layout):
 *
 *   <workspace>/.crosschat/
 *   ├── registry/sessions/<sessionId>.json
 *   ├── registry/names.json
 *   ├── registry/wake/<nonce>.json
 *   ├── teams/<teamId>/team.json
 *   ├── teams/<teamId>/inbox/<agentKey>.jsonl
 *   ├── teams/<teamId>/snapshot.json
 *   ├── locks/<name>.lock
 *   └── logs/engine.jsonl | wake-<to>-<ts>.json
 *
 * @module core/paths
 */
import { dirname, join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';

/** State directory name under the workspace. Code constant, not userConfig
 * (hooks processes cannot read userConfig; DESIGN.md §8.2-A note). */
export const STATE_DIR_NAME = '.crosschat';

/**
 * v0.10.0（C1 / R1 / G-27）：向上查找既存协作根的**最大层数**（含起点自身那一层）。
 *
 * 背景（G-27）：SessionStart 钩子按「会话当前工作目录」裸拼 `<cwd>/.crosschat`，
 * 会话 cd 进子目录（或 cwd 本身就是 `.crosschat`）后一旦重启，就在子目录里**另起一个
 * 协作根**——身份/邮箱/任务板裂成两半，幻影根里的 regToken 脱离主根可见范围。
 * 现在从起点逐级向上找**已存在**的协作根（命中判定见 {@link hasExistingStateRoot}），
 * 最近的祖先优先；起点自身在某个 `.crosschat` 里时直接解析到那个 `.crosschat`
 * （{@link StateRootVia} 的 `inside-root`）——绝不产生 `.crosschat\.crosschat` 嵌套根。
 *
 * 12 层对「仓库根 → 深层子目录」的真实形态宽裕（实测最深约 5 层），同时把
 * 单次解析的文件系统往返钉在有界范围（每层最多 1+3 次 existsSync）。
 */
export const STATE_ROOT_WALK_UP_MAX_LEVELS = 12;

/**
 * 既存协作根的判定标记：`<dir>/.crosschat/` 下存在其一即算「既有根」。
 * （空目录 `.crosschat/` 不算——那通常是半途创建的残留，不是可复用的协作状态。）
 */
const STATE_ROOT_MARKERS = ['registry', 'teams', 'logs'] as const;

/** 状态根解析走了哪条路径（C2 漂移审计事件的 `via` 字段）。 */
export type StateRootVia = 'bare' | 'ancestor' | 'inside-root';

/** {@link resolveStateRootWithDiscovery} 的解析结果（含来源，供漂移审计用）。 */
export interface StateRootResolution {
  /** 绝对状态根（`<workspace>/.crosschat`，或向上/向内发现的既存根）。 */
  root: string;
  /** 本次解析的路径：`bare` = 保持现状的裸拼；`ancestor` = 向上找到的既存根；`inside-root` = 起点就在某个 `.crosschat` 里。 */
  via: StateRootVia;
  /** `resolve()` 归一后的绝对工作区（调用方入参的词法归一，不等于 root 的父目录）。 */
  workspace: string;
}

/** `<dir>/.crosschat` 存在且含 registry/teams/logs 之一 → 算既存协作根。 */
function hasExistingStateRoot(dir: string): boolean {
  const base = join(dir, STATE_DIR_NAME);
  if (!existsSync(base)) return false;
  return STATE_ROOT_MARKERS.some((marker) => existsSync(join(base, marker)));
}

/**
 * 绝对路径切分：根前缀（盘符 / UNC / Windows 扩展前缀 / POSIX 根）与其余段。
 * 段判定必须按段做而不是整串正则——`A\.crosschat\.crosschat\B` 这类嵌套形态下，
 * 逐段扫才能取到**最近**的那个 `.crosschat`（整串正则会因前一个匹配吃掉分隔符
 * 而漏掉内层，v0.10.0 组 C 首轮实现即踩此坑）。
 */
function splitAbsolutePath(path: string): { prefix: string; segments: string[] } {
  let prefix = '';
  let rest = path;
  const extended = /^(?:\\\\\?\\|\\\\.\\)/.exec(path);
  if (extended !== null) {
    const body = path.slice(extended[0].length);
    const unc = /^UNC\\[^\\/]+[\\/][^\\/]+/i.exec(body);
    const drive = /^[a-zA-Z]:[\\/]?/.exec(body);
    prefix = unc !== null
      ? `${extended[0]}${unc[0]}\\`
      : drive !== null
        ? `${extended[0]}${drive[0].replace(/[\\/]$/, '\\')}`
        : extended[0];
    rest = path.slice(prefix.length);
  } else if (/^[a-zA-Z]:[\\/]/.test(path)) {
    prefix = path.slice(0, 3);
    rest = path.slice(3);
  } else if (path.startsWith('\\\\')) {
    const unc = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?/.exec(path);
    prefix = unc !== null ? unc[0] : '\\\\';
    rest = path.slice(prefix.length);
  } else if (path.startsWith('/')) {
    prefix = '/';
    rest = path.slice(1);
  }
  return { prefix, segments: rest.split(/[\\/]+/).filter((segment) => segment !== '') };
}

/** 段名是否是状态目录名（win32 大小写不敏感）。 */
function isStateDirSegment(segment: string): boolean {
  return process.platform === 'win32'
    ? segment.toLowerCase() === STATE_DIR_NAME
    : segment === STATE_DIR_NAME;
}

/** 根前缀对应的分隔符（POSIX 根 `/` → `/`；盘符/UNC/扩展前缀 → `\`）。 */
function separatorFor(prefix: string): string {
  if (prefix === '/') return '/';
  if (prefix === '') return process.platform === 'win32' ? '\\' : '/';
  return '\\';
}

/**
 * 起点自身是否位于某个 `.crosschat` 目录里（或正是它）→ 返回那个 `.crosschat`
 * （取**最近**的，即路径里最后一个该名字的段；`.crosschat\.crosschat` 嵌套形态下
 * 解析到内层，不再继续嵌套）。判定是纯词法的（不依赖目录存在）——「绝不产生嵌套
 * 根」这条不该因为目录尚未落盘而失效。
 */
function enclosingStateRoot(abs: string): string | undefined {
  const { prefix, segments } = splitAbsolutePath(abs);
  let lastIndex = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (isStateDirSegment(segments[index]!)) lastIndex = index;
  }
  if (lastIndex < 0) return undefined;
  return prefix + segments.slice(0, lastIndex + 1).join(separatorFor(prefix));
}

/** 从起点逐级向上找既存协作根（最近祖先优先；到盘符/网络根或层数上限止）。 */
function findAncestorStateRoot(abs: string): string | undefined {
  let current = abs;
  for (let level = 0; level < STATE_ROOT_WALK_UP_MAX_LEVELS; level += 1) {
    if (hasExistingStateRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined; // 盘符根 / 网络根：到顶
    current = parent;
  }
  return undefined;
}

/**
 * 两条绝对路径是否同一个目录（win32 大小写不敏感；两者都应已 resolve/join 归一、
 * 无尾部分隔符）。用于「命中起点自身那一层」与裸拼结果的等价判定。
 */
export function isSameAbsolutePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * v0.10.0（C1 / R1 / G-27）：解析状态根并回报**走了哪条路**。
 *
 * 顺序（先内后外，任一步命中即返回）：
 * 1. `inside-root`：起点自身在某个 `.crosschat` 里或其子目录里 → 直接解析到那个
 *    `.crosschat`（G-27 幻影根治口：cwd = `.crosschat` 的会话不再拼出嵌套根）；
 * 2. `ancestor`：起点目录**真实存在**时，逐级向上（≤12 层）找已存在的协作根，
 *    命中即以该根的父目录为工作区归属（主修：项目根/任意深度子目录/压缩重启后
 *    cd 都归并到同一主根）。**命中起点自身那一层**（`<cwd>/.crosschat` 已存在）时
 *    结果与裸拼逐字节相同 → 记 `bare`（正常路径，C2 据此零审计噪声）；
 * 3. `bare`：向上找不到 → 保持 v0.9.10 前行为（`<workspace>/.crosschat`，由调用方
 *    首启创建）。起点目录不存在时同样走这条——不存在的路径没有可发现的盘上状态，
 *    且旧行为（裸拼后创建）必须保留（paths.test.ts 的既有判据即此形态）。
 *
 * 显式传入的工程目录环境变量优先级不变（ZCODE_PROJECT_DIR/CLAUDE_PROJECT_DIR →
 * stdin cwd → process.cwd() 的选取链在 hooks/shared.ts，本函数只吃选定的工作区）。
 */
export function resolveStateRootWithDiscovery(workspace: string): StateRootResolution {
  const abs = resolve(workspace);
  const bare = join(abs, STATE_DIR_NAME);
  const inside = enclosingStateRoot(abs);
  if (inside !== undefined) {
    return { root: inside, via: 'inside-root', workspace: abs };
  }
  if (existsSync(abs)) {
    const ancestor = findAncestorStateRoot(abs);
    if (ancestor !== undefined) {
      const root = join(ancestor, STATE_DIR_NAME);
      return { root, via: isSameAbsolutePath(root, bare) ? 'bare' : 'ancestor', workspace: abs };
    }
  }
  return { root: bare, via: 'bare', workspace: abs };
}

/**
 * Resolve the absolute state root for one workspace.
 * @param workspace the session workspace directory (may be relative).
 *
 * v0.10.0（C1 / R1 / G-27）：不再裸拼——改为 {@link resolveStateRootWithDiscovery}
 * 的既存根发现（向上 ≤12 层 / 向内归一）；向上找不到时才退回裸拼。返回其中的
 * `root`；需要 `via` 做漂移审计的调用方（hooks/shared.ts）用带 provenance 的版本。
 */
export function resolveStateRoot(workspace: string): string {
  return resolveStateRootWithDiscovery(workspace).root;
}

/**
 * Resolve the workspace from the environment.
 * `ZCODE_PROJECT_DIR` is what the plugin manifest sets as the MCP server cwd
 * and what hooks read (DESIGN.md §2.3-1); fall back to process.cwd().
 */
export function workspaceFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['ZCODE_PROJECT_DIR'];
  return typeof dir === 'string' && dir.trim() !== '' ? dir : process.cwd();
}

// --- registry ---------------------------------------------------------------

export function sessionsDir(root: string): string {
  return join(root, 'registry', 'sessions');
}
export function sessionFile(root: string, sessionId: string): string {
  return join(root, 'registry', 'sessions', `${sessionId}.json`);
}
/**
 * v0.9.1 r3（V090-01）：会话活性**引擎证言**文件（`registry/witness/<sid>.json`）。
 * 与 sessions/<sid>.json 分路：后者含自述字段（liveness/livenessTs/lastEventTs），
 * 一次本地文件写即可伪造（裁决 case1r3/case7br3 实证）；本文件只由引擎进程写
 * （hooks 回合边界 + MCP 工具调用心跳），是清扫豁免的唯一活性输入。
 */
export function witnessDir(root: string): string {
  return join(root, 'registry', 'witness');
}
export function witnessFile(root: string, sessionId: string): string {
  return join(root, 'registry', 'witness', `${sessionId}.json`);
}
export function namesFile(root: string): string {
  return join(root, 'registry', 'names.json');
}
export function wakeDir(root: string): string {
  return join(root, 'registry', 'wake');
}
export function wakeFile(root: string, nonce: string): string {
  return join(root, 'registry', 'wake', `${nonce}.json`);
}

// --- teams ------------------------------------------------------------------

/**
 * teamId 段合法性（v0.5.1 BND-1 修复：xc_status.teamId 路径穿越）。
 *
 * teamId 会被直接拼进 `teams/<teamId>/…` 各路径构建器（join 不中和 `..` 段），
 * 调用方传入的 teamId 必须先经本闸验证为**单个安全路径段**，否则
 * `../../evil` 这类穿越串可逃出状态根建目录/写 snapshot.json。产品自身
 * 创建的 teamId 只有 `default`（types.ts DEFAULT_TEAM_ID）；白名单放宽到
 * 常见段字符（字母/数字开头，字母数字._-，≤128），覆盖操作者手工放置的
 * 观测目标，同时结构性排除分隔符、`..`、盘符与 Windows 保留语法。
 */
export function isValidTeamId(teamId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(teamId);
}

export function teamDir(root: string, teamId: string): string {
  return join(root, 'teams', teamId);
}
export function teamFile(root: string, teamId: string): string {
  return join(root, 'teams', teamId, 'team.json');
}
// v0.5.1（故障注-1 修复）：team.json 的 last-known-good 镜像与损坏现场保全件。
// writeTeam 每次成功落盘后原子镜像同一内容到 .bak；readTeam 遇不可解析真源时
// 先尝试从 .bak 自愈，无可用备份则带修复指引显式报错（不再裸抛 JSON 解析错误）。
export function teamBackupFile(root: string, teamId: string): string {
  return join(root, 'teams', teamId, 'team.json.bak');
}
export function teamCorruptFile(root: string, teamId: string): string {
  return join(root, 'teams', teamId, 'team.json.corrupt');
}
export function inboxDir(root: string, teamId: string): string {
  return join(root, 'teams', teamId, 'inbox');
}
export function inboxFile(root: string, teamId: string, agentKey: string): string {
  return join(root, 'teams', teamId, 'inbox', `${agentKey}.jsonl`);
}
// v0.6（DESIGN-V0.6.md §2.2 行 1）：`inboxIntegrityFile`（`.jsonl.int` sidecar）随
// 邮箱哈希链一并砍除；存量 sidecar 文件不再读写，成为无害孤儿。
export function snapshotFile(root: string, teamId: string): string {
  return join(root, 'teams', teamId, 'snapshot.json');
}

// --- v0.7 C6/C7：转办台账与审批文件（状态根级，不随 teamId） -----------------

/**
 * v0.7（DESIGN-V0.7 §2.5/§3.1）：tool_request 台账目录
 * （`.crosschat/toolrequests/<requestId>.json`）。requestId 同时是审批文件名
 * （approvals/<requestId>.json）——天然可检索（E4 §5）。requestId 的路径段
 * 合法性由 toolrelay.ts 的 REQUEST_ID_RE 在帧入口校验（防穿越）。
 */
export function toolRequestsDir(root: string): string {
  return join(root, 'toolrequests');
}
export function toolRequestFile(root: string, requestId: string): string {
  return join(root, 'toolrequests', `${requestId}.json`);
}

/** v0.7（DESIGN-V0.7 §2.3/§3.1）：审批授权文件目录（`.crosschat/approvals/<requestId>.json`）。
 *  授权锚点：用户/lead 落盘（文件轨）或 xc_review approve 代写（工具轨，同格式）。 */
export function approvalsDir(root: string): string {
  return join(root, 'approvals');
}
export function approvalsFile(root: string, requestId: string): string {
  return join(root, 'approvals', `${requestId}.json`);
}

// --- v0.8.0 A1：交接检查点（状态根级，不随 teamId） --------------------------

/**
 * 检查点根目录（`.crosschat/checkpoints/`；DESIGN-V0.8.md §3.2）。
 *
 * 与 `teams/<teamId>/` 无交集：checkpoint 只写调用方自己的
 * `checkpoints/<agentKey>/`，不碰 team.json、不碰任务状态机——「不改任务
 * 状态机」纪律的结构性保证。目录名与 `<agentKey>` 段的合法性由
 * core/checkpoint.ts 的段闸（sanitizeKey + 断言复核，archive.ts safeSegment
 * 同款防御纵深）负责；本构建器与 paths.ts 其余构建器一样只做 join，
 * 调用方（core/checkpoint.ts）必须经段闸后才准取路径。
 */
export function checkpointsDir(root: string): string {
  return join(root, 'checkpoints');
}

/** 单成员检查点目录：`<.crosschat>/checkpoints/<agentKey>/`（agentKey 已过段闸）。 */
export function checkpointDir(root: string, agentKey: string): string {
  return join(root, 'checkpoints', agentKey);
}

/** 单个检查点文件：`<.crosschat>/checkpoints/<agentKey>/<stamp>.md`（stamp 见 checkpointStamp）。 */
export function checkpointFile(root: string, agentKey: string, stamp: string): string {
  return join(checkpointDir(root, agentKey), `${stamp}.md`);
}

/** 提醒节流标记：`<.crosschat>/checkpoints/<agentKey>/.nudge`（滚动删除只认 `*.md`，两者互不干扰）。 */
export function checkpointNudgeFile(root: string, agentKey: string): string {
  return join(checkpointDir(root, agentKey), '.nudge');
}

// --- locks & logs -----------------------------------------------------------

export function locksDir(root: string): string {
  return join(root, 'locks');
}
export function lockFile(root: string, name: string): string {
  return join(root, 'locks', `${name}.lock`);
}
export function logsDir(root: string): string {
  return join(root, 'logs');
}
export function engineLogFile(root: string): string {
  return join(root, 'logs', 'engine.jsonl');
}
export function wakeLogFile(root: string, to: string, ts: number): string {
  return join(root, 'logs', `wake-${to}-${ts}.json`);
}

/**
 * v0.9.1（G-12v3）：wake-child **生命周期日志**（JSONL，与唤醒子的 stdout 日志
 * `wakeLogFile` 分文件——互不干扰：失败证据侦听只解析后者，本文件只记引擎侧观察到
 * 的 spawn 生命周期）。
 * 行形态：`{event:"wake-child-start", nonce, sid, to, scene, ts}`（spawn 即写）与
 * `{event:"wake-child-exit", pid, durationMs, exitCode, evidence?}`（观察到子进程
 * 消失时写）。孤儿化唤醒子（V9）的退出码对引擎进程不可观测，exitCode 如实记 null，
 * 失败语义由 evidence（findWakeFailureEvidence 的快照）承载。
 */
export function wakeLifecycleFile(root: string, to: string, ts: number): string {
  return join(root, 'logs', `wake-lifecycle-${to}-${ts}.jsonl`);
}

// --- lock identity ----------------------------------------------------------

import { createHash } from 'node:crypto';

/** Longest workspace digest fragment embedded in lock file names. */
const LOCK_ROOT_DIGEST_LENGTH = 8;

/**
 * v0.9.2（B1）：锁身份的**物理目录归一**——teamLockNames/registryLockNames 的 digest
 * 输入必须先把工作区拼法归一到同一物理目录。
 *
 * 背景：锁名 = `sha256(<abs root> 小写)` 前 8 hex。B1 之前直接吃 `resolve(root)`，
 * 于是同一台机器上两个进程用不同拼法指向**同一个** `.crosschat`（junction 别名、
 * 8.3 短名、UNC 管理共享、`\\?\` 扩展前缀、盘符/目录大小写差异）会算出**不同的
 * 锁文件名**：跨进程互斥形同虚设（各锁各的，team.json 读改写并发无保护），
 * in-process key 也分裂成两条链（同进程内也失去串行）。
 *
 * 归一手段（按序）：
 * 1. 剥 Windows 扩展长度/设备前缀（`\\?\C:\x` / `\\.\C:\x` → `C:\x`；
 *    `\\?\UNC\host\share\x` → `\\host\share\x`）；
 * 2. 本机 UNC 管理共享拼法映射回盘符（`\\localhost\C$\x`、`\\127.0.0.1\C$\x`、
 *    `\\<计算机名>\C$\x` → `C:\x`）。host 不是本机、或共享名不是 `<盘符>$` 时
 *    原样保留——远端 UNC 不在同一台机器的锁域内，不猜测映射；
 * 3. `realpathSync.native`：junction/符号链接、8.3 短名、盘符与目录大小写全部
 *    归一到磁盘真值。**必须用 .native 形态**：实测（Node v24 / Windows 10）
 *    普通 realpathSync 对 8.3 短名原样返回（短名仍是短名），只有 native 形态
 *    （底层 GetFinalPathNameByHandle）才展开成长名；UNC 拼法两种形态都不映射
 *    （故有第 2 步的事前改写）；
 * 4. 目标不存在（首启时状态根尚未落盘）→ 回退 resolve（与 v0.9.1 前行为一致，
 *    不把「目录还没建」升级成锁名计算失败）。
 *
 * 成功的归一结果按输入串 memo（进程内）：锁名在热路径上取（mailbox 读路径也走
 * teamLockNames），realpath 是文件系统往返。**只缓存成功归一**——「路径不存在」
 * 的结论不缓存（状态根随后会被创建，下次必须重新归一，否则首启前后锁名分裂）。
 */
const canonicalRootMemo = new Map<string, string>();
/** memo 上限（防御性：异常调用方拿无限多种拼法来敲门时不清空会无界增长）。 */
const CANONICAL_ROOT_MEMO_MAX = 128;

/** 剥 Windows 扩展长度/设备前缀：`\\?\C:\x`→`C:\x`、`\\?\UNC\h\s\x`→`\\h\s\x`、`\\.\C:\x`→`C:\x`。 */
function stripWindowsPathPrefix(path: string): string {
  if (path.startsWith('\\\\?\\')) {
    const rest = path.slice(4);
    return rest.slice(0, 4).toLowerCase() === 'unc\\' ? `\\\\${rest.slice(4)}` : rest;
  }
  if (path.startsWith('\\\\.\\')) return path.slice(4);
  return path;
}

/** 本机回环/本机名集合（UNC 拼法判定用；COMPUTERNAME 大小写不敏感）。 */
function localHostAliases(): Set<string> {
  const aliases = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const computerName = process.env['COMPUTERNAME'];
  if (typeof computerName === 'string' && computerName.trim() !== '') {
    aliases.add(computerName.trim().toLowerCase());
  }
  return aliases;
}

/**
 * `\\<本机>\<盘符>$\rest` → `<盘符>:\rest`（管理共享的本机拼法归一回盘符形态）；
 * 其余 UNC 拼法（非本机 host / 非管理共享）原样返回。
 */
function localUncToDriveLetter(path: string): string {
  if (!path.startsWith('\\\\')) return path;
  const body = path.slice(2);
  const hostEnd = body.indexOf('\\');
  if (hostEnd <= 0) return path;
  const host = body.slice(0, hostEnd).toLowerCase();
  const rest = body.slice(hostEnd + 1);
  const shareEnd = rest.indexOf('\\');
  if (shareEnd <= 0) return path;
  const share = rest.slice(0, shareEnd);
  const tail = rest.slice(shareEnd + 1);
  const drive = /^([a-zA-Z])\$$/.exec(share);
  if (drive === null) return path;
  if (!localHostAliases().has(host)) return path;
  return `${drive[1]!.toUpperCase()}:\\${tail}`;
}

/** 去尾部分隔符（`C:\ws\` → `C:\ws`；盘根 `C:\` 长度 3 不动）。 */
function stripTrailingSeparators(path: string): string {
  return path.length > 3 ? path.replace(/[\\/]+$/, '') : path;
}

/**
 * v0.9.2（B1）：工作区/状态根拼法的物理归一（口径见上方注释）。
 * 导出供单测与诊断面直接对拍；生产路径只有 teamLockNames/registryLockNames。
 */
export function canonicalStateRoot(root: string): string {
  const memoized = canonicalRootMemo.get(root);
  if (memoized !== undefined) return memoized;
  const candidate = stripTrailingSeparators(localUncToDriveLetter(stripWindowsPathPrefix(root)));
  try {
    const real = stripTrailingSeparators(realpathSync.native(candidate));
    if (canonicalRootMemo.size >= CANONICAL_ROOT_MEMO_MAX) canonicalRootMemo.clear();
    canonicalRootMemo.set(root, real);
    return real;
  } catch {
    // 不存在/不可解析：回退 resolve（首启窗口；结论不 memo）。
    return resolve(candidate);
  }
}

/**
 * Cross-process + in-process lock identity for one team.
 * The in-process key keeps the dsh spelling `team:<abs stateRoot>:<teamId>`
 * (mailbox.js:44); the file name cannot contain `:` on Windows, so it uses a
 * workspace digest instead: `team-<digest8>-<teamId>`.
 *
 * v0.9.2（B1）：`abs` 经 {@link canonicalStateRoot} 物理归一——junction/8.3/UNC/
 * 大小写等拼法归一到同一锁名与同一条 in-process 链（详见该函数注释）。
 */
export function teamLockNames(root: string, teamId: string): { processKey: string; file: string } {
  const abs = canonicalStateRoot(root);
  const digest = createHash('sha256').update(abs.toLowerCase()).digest('hex').slice(0, LOCK_ROOT_DIGEST_LENGTH);
  return { processKey: `team:${abs}:${teamId}`, file: `team-${digest}-${teamId}` };
}

/** Registry lock identity (fixed acquisition order: registry -> team, §2.7-3).
 *  v0.9.2（B1）：同 teamLockNames——root 先经 canonicalStateRoot 物理归一。 */
export function registryLockNames(root: string): { processKey: string; file: string } {
  const abs = canonicalStateRoot(root);
  const digest = createHash('sha256').update(abs.toLowerCase()).digest('hex').slice(0, LOCK_ROOT_DIGEST_LENGTH);
  return { processKey: `registry:${abs}`, file: `registry-${digest}` };
}

/**
 * Bundle of path builders addressed as one object (module-3 call shape):
 * `const paths = statePaths(root); paths.lock('registry')`.
 */
export function statePaths(root: string): {
  root: string;
  lock(name: string): string;
  session(sessionId: string): string;
  names(): string;
  wake(token: string): string;
  team(teamId: string): string;
  teamFile(teamId: string): string;
  inbox(teamId: string, agentKey: string): string;
  snapshot(teamId: string): string;
  engineLog(): string;
} {
  return {
    root,
    lock: (name: string) => lockFile(root, name),
    session: (sessionId: string) => sessionFile(root, sessionId),
    names: () => namesFile(root),
    wake: (token: string) => wakeFile(root, token),
    team: (teamId: string) => teamDir(root, teamId),
    teamFile: (teamId: string) => teamFile(root, teamId),
    inbox: (teamId: string, agentKey: string) => inboxFile(root, teamId, agentKey),
    snapshot: (teamId: string) => snapshotFile(root, teamId),
    engineLog: () => engineLogFile(root),
  };
}

// --- v0.9.2（B2 → V092-10）：链接逃逸遏制闸（lstat + realpath） ------------------

/** realpath 归一（失败——不存在 / dangling 链——回退 resolve 的词法路径）。 */
async function realPathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * v0.9.2（B2）：realpath 归一后的**包含根**包含判定（win32 大小写不敏感，与各面既有
 * 词法 containment 同口径；尾分隔符由 realpath 归一掉——卷根 `C:\` 例外不误伤）。
 */
export function isUnderRootReal(rootReal: string, absReal: string): boolean {
  const root = rootReal.length > 3 ? rootReal.replace(/[\\/]+$/, '') : rootReal;
  if (process.platform === 'win32') {
    const abs = absReal.toLowerCase();
    const base = root.toLowerCase();
    return abs === base || abs.startsWith(base.endsWith('\\') ? base : base + '\\');
  }
  return absReal === root || absReal.startsWith(root.endsWith('/') ? root : root + '/');
}

/** {@link checkLinkContainment} 的判定结果（调用方按面抛各自的错误 / 降级）。 */
export interface LinkContainmentGate {
  /** realpath 归一后的目标（不存在时 = resolve 词法路径）。 */
  real: string;
  /** true = 归一结果越出包含根（经 symlink/junction 逃逸）。 */
  escaped: boolean;
  /** true = 条目自身或其任一上级目录是符号链接（Windows 上 junction 亦被 libuv 报为 symlink）。 */
  viaLink: boolean;
}

/**
 * v0.9.2（B2）：从条目向上逐级 lstat——判定逃逸是否**经链接**发生。junction 内部的
 * 文件条目自身是常规文件（实测 `lstat(<junc>/file.txt).isSymbolicLink() === false`），
 * 只看条目本身会把「junction 逃逸」误报成普通越界；逐级上到卷根为止。
 */
async function linkEscapeVia(abs: string): Promise<boolean> {
  let current = abs;
  for (let depth = 0; depth < 64; depth += 1) {
    const lst = await lstat(current).catch(() => undefined);
    if (lst?.isSymbolicLink() === true) return true;
    const parent = dirname(current);
    if (parent === current) return false; // 到达卷根/网络根
    current = parent;
  }
  return false;
}

/**
 * v0.9.2（B2，V092-10 扩展到 journal 读取面）：**链接逃逸遏制闸**——各面「真实文件」
 * 判定共用（evidence 门 / refs 门 / journal 读取面 / 检查点 journal 尾部读）。
 *
 * 背景：各面的工作区/状态根遏制门都是**词法**判定（resolve 后比前缀），而
 * `stat`/`readFile` 都**跟随**符号链接——于是包含根内一个指向外部的 symlink/junction
 * 可把根外文件包装成「根内真实文件」通过全部闸门（sha256 照算、全文照读、照进共享
 * 检查点）。Windows 上 junction 无需提权即可创建（`mklink /J`），是最现实的逃逸形态；
 * 红队实测（V092-10）：预置 `.crosschat/tasks/<id>` junction 可让
 * `xc_read({scope:"journal"})`（**不需身份**）把工作区外任意文件（≤8 MiB）全文读进
 * 任一会话模型上下文，并经 `readTaskJournalTail` 落进团队共享检查点。
 *
 * 口径（对齐 peer-services R-33「key 文件禁跟随符号链接」的既有防御，但只挡**逃逸**）：
 * - realpath 归一后越出包含根 → `escaped:true`，调用方拒绝/降级；
 * - 链接目标仍在包含根内 → 放行（根内部引用不是逃逸）。包含根自身经 junction 搬迁
 *   （如 `.crosschat` → 另一磁盘）时两侧都按 realpath 归一，合法形态不受误伤。
 *
 * @param anchorRoot 包含根：evidence/refs 传**工作区**（用户文件契约），journal 读取面
 *   与检查点传**状态根**（`.crosschat` 内部文件；容状态根整体搬迁）。
 *
 * 边界（威胁模型明示不防）：同机敌对进程可在本闸与读取之间换链（TOCTOU）——与
 * consumedAt/lastSeen 伪造同属「同机敌对进程」边界，不做签名/哈希链。本闸防的是
 * **静态放置**的逃逸链接（攻击者预置、调用方/引擎误用）。
 */
export async function checkLinkContainment(anchorRoot: string, abs: string): Promise<LinkContainmentGate> {
  const rootReal = await realPathOrResolve(anchorRoot);
  const real = await realPathOrResolve(abs);
  const escaped = !isUnderRootReal(rootReal, real);
  const viaLink = escaped ? await linkEscapeVia(abs) : false;
  return { real, escaped, viaLink };
}
