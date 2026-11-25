/**
 * M4 hooks-and-face: plumbing shared by the three process hooks
 * (session-start / prompt-submit / stop).
 *
 * Responsibilities (DESIGN.md §7 M4): state-root resolution + hook output
 * JSON assembly + the M1 read paths the hooks reuse. Hooks import M1 ONLY
 * (no engine, no MCP — DESIGN.md §8.1 rule 1: M4 → M1).
 *
 * Hook process contract (verified this session against the zcode CLI bundle,
 * `_In` + `EMr` schema):
 * - stdin: one JSON object `{...run, agent_type, hook_event_name,
 *   permission_mode, session_id, transcript_path, ...}`; the runner writes it
 *   with `stdin.end(payload)` so reading to EOF always terminates. Empty or
 *   missing stdin is tolerated.
 * - env: `${CLAUDE_SESSION_ID}` and `${ZCODE_PROJECT_DIR}` are injected as
 *   environment variables too (diagnosing-hooks SKILL.md:35); env wins over
 *   stdin, process.cwd() is the last resort for the workspace.
 * - stdout: parsed against a STRICT per-event schema (extra keys fail
 *   validation). The top-level object recognizes `additionalContext`,
 *   `additional_context`, `continue`, `decision`, `hookSpecificOutput`,
 *   `reason`, `stopReason`, `suppressOutput`, `systemMessage`; SessionStart /
 *   UserPromptSubmit / Stop all push a top-level `additionalContext` into the
 *   conversation. We emit exactly `{"additionalContext": "..."}` — no other
 *   key, ever.
 * - exit codes: 0 = pass, 2 = block, anything else = error. These hooks are
 *   pull-path enhancements, never gates: they ALWAYS exit 0 and degrade to
 *   "no output" on any error (an engine.jsonl audit line keeps the failure
 *   observable, DESIGN.md §4.3).
 *
 * @module hooks/shared
 */
import { readFileSync } from 'node:fs';
import { isSameAbsolutePath, resolveStateRootWithDiscovery, workspaceFromEnv, type StateRootVia } from '../core/paths.js';
import { readNames, namesBoundToSession, readSession, refreshSessionLastSeen } from '../core/registry.js';
import { readUnreadMailbox, urgentFirst, markMailboxConsumed } from '../core/mailbox.js';
import { withRegistryLock, withTeamLock, LockBusyError } from '../core/lock.js';
import { logEngineEvent, type EngineEvent } from '../core/log.js';
import { DEFAULT_TEAM_ID, type NameBindings, type SessionRecord, type TeamMessage } from '../core/types.js';
import {
  provisionStaleAfterMsFromEnv,
  readTeam,
  sweepStaleProvisioningLocked,
  writeTeam,
} from '../core/teamstate.js';
import {
  peerRootFromEnv as resolvePeerRoot,
  readPeerBaseRecord,
  refreshPeerBaseRecord as refreshBase,
  writePeerBaseRecord as writeBase,
} from '../core/peerdir.js';

/**
 * Registry-lock budget inside a hook. The hook runner kills hooks at 10 s
 * (hooks.json timeoutMs), so the default 15 s LOCK_WAIT_MS must never apply
 * here: on busy we skip the lastSeen refresh (harmless — the next prompt
 * refreshes again) instead of timing out the whole hook.
 */
export const HOOK_LOCK_WAIT_MS = 2_000;

const NO_NAMES: NameBindings = {};

/** Parsed hook stdin payload (keys observed in the runner, snake + camel). */
export interface HookStdin {
  raw: Record<string, unknown>;
  /** Best-effort string field accessor (snake_case first, camelCase fallback). */
  str(keySnake: string, keyCamel: string): string | undefined;
}

export interface HookContext {
  /** Session workspace directory. */
  workspace: string;
  /** Absolute `<workspace>/.crosschat`. */
  stateRoot: string;
  /**
   * v0.10.0（C1 / R1 / G-27）：本回合状态根解析走了哪条路（undefined = 旧构造面
   * 或测试替手，读作 `'bare'`）。{@link auditStateRootResolution} 据此决定是否落
   * `state-root-resolved` 审计——正常路径（裸拼且无漂移）零新增日志。
   */
  stateRootVia?: StateRootVia;
  /** Session id from CLAUDE_SESSION_ID env or stdin; undefined when absent. */
  sessionId: string | undefined;
  /** Hook event name (diagnostics only). */
  event: string;
}

/** Read and parse the hook stdin payload; undefined when unavailable. */
export function readStdinPayload(): HookStdin | undefined {
  // Interactive manual runs (TTY stdin) must not block on readFileSync(0).
  if (process.stdin.isTTY) return undefined;
  let text: string;
  try {
    text = readFileSync(0, 'utf8');
  } catch {
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed === '' || !trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    return {
      raw,
      str(keySnake, keyCamel) {
        for (const key of [keySnake, keyCamel]) {
          const v = raw[key];
          if (typeof v === 'string' && v.trim() !== '') return v;
        }
        return undefined;
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve the hook context: workspace + state root + session id.
 * Env first (the documented hook variables), stdin as fallback.
 *
 * v0.10.0（C1 / R1 / G-27）：状态根解析不再裸拼——工作区选定链不变（显式传入的
 * 工程目录环境变量优先级原样保留：ZCODE_PROJECT_DIR/CLAUDE_PROJECT_DIR → stdin
 * cwd → process.cwd()），但 `<workspace>/.crosschat` 改经
 * {@link resolveStateRootWithDiscovery}：向上 ≤12 层找既存协作根（最近祖先优先）、
 * 起点在 `.crosschat` 里时向内归一，找不到才裸拼（首启）。`workspace` 仍记当轮
 * 来源目录本身（会话记录 cwd / peer 基记录 cwd 的既有口径不动），只有 stateRoot
 * 归并到主根。
 */
export function resolveHookContext(event: string, stdin: HookStdin | undefined): HookContext {
  const env = process.env;
  const envWorkspace = env['ZCODE_PROJECT_DIR'] ?? env['CLAUDE_PROJECT_DIR'];
  const workspace = envWorkspace !== undefined && envWorkspace.trim() !== ''
    ? envWorkspace
    : stdin?.str('cwd', 'cwd') ?? workspaceFromEnv(env);
  const sessionId = env['CLAUDE_SESSION_ID']?.trim() || stdin?.str('session_id', 'sessionId');
  const resolution = resolveStateRootWithDiscovery(workspace);
  return {
    workspace,
    stateRoot: resolution.root,
    stateRootVia: resolution.via,
    sessionId,
    event,
  };
}

/**
 * v0.10.0（C2 / R1 / G-27）：状态根解析的**漂移可观测**——钩子回合边界落审计事件，
 * 让「某会话跑去别处起了根」在主根 engine.jsonl 里看得见（G-27 影响面第 3 条）。
 *
 * 两条事件（R1 建议修法 4）：
 * 1. `state-root-resolved{root, via}`：解析结果**不是**裸拼的 `<cwd>/.crosschat`
 *    时落（via = `ancestor` | `inside-root`）——记录本次归并到了哪个主根、怎么归并的；
 * 2. `state-root-drift{registered, resolved}`：同一会话解析出的根与它**注册表记录
 *    里的根**（会话记录 cwd 经同一解析规则算出的根）不一致时再落——幻影根/换项目
 *    导致的根漂移由此显式化，而不是静默裂成两个根。漂移**持续期间每次 SessionStart
 *    复读**（只读审计不改记录）；另一端（幻影根）被清除后，记录 cwd 经同一规则
 *    归并回主根，事件自愈停止。
 *
 * 纪律：
 * - 正常路径（裸拼且无漂移）**零新增日志**；
 * - 只读（不写注册表、不改任何状态）——刷新路径会在记录缺 cwd 时补写本回合
 *   workspace，故漂移审计必须排在会话记录刷新**之前**读旧值（调用方 session-start.ts
 *   已按此排序）；
 * - 尽力而为：任何 IO/解析失败只吞掉（观测面增强不许把钩子拖失败）。
 */
export async function auditStateRootResolution(ctx: HookContext): Promise<void> {
  try {
    const via = ctx.stateRootVia ?? 'bare';
    if (via !== 'bare') {
      await logEngineEvent(ctx.stateRoot, {
        event: 'state-root-resolved',
        via,
        root: ctx.stateRoot,
        ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      });
    }
    if (ctx.sessionId === undefined) return;
    const record = await readSession(ctx.stateRoot, ctx.sessionId).catch(() => undefined);
    if (record === undefined || typeof record.cwd !== 'string' || record.cwd.trim() === '') return;
    const registered = resolveStateRootWithDiscovery(record.cwd).root;
    if (isSameAbsolutePath(registered, ctx.stateRoot)) return;
    await logEngineEvent(ctx.stateRoot, {
      event: 'state-root-drift',
      registered,
      resolved: ctx.stateRoot,
      sessionId: ctx.sessionId,
    });
  } catch {
    // 漂移审计是观测面增强：失败静默（正常路径本来就不该有日志）。
  }
}

/** Emit the hook's context injection: exactly one strict-schema key. */
export function emitAdditionalContext(text: string): void {
  process.stdout.write(`${JSON.stringify({ additionalContext: text })}\n`);
}

/** Best-effort engine.jsonl audit line (log.ts already swallows IO errors). */
export async function logHookEvent(stateRoot: string, event: EngineEvent): Promise<void> {
  await logEngineEvent(stateRoot, event);
}

/**
 * Standard hook failure path: audit the error (engine.jsonl when the state
 * root is known, stderr preview otherwise) and let the hook degrade silently
 * — hooks are pull-path enhancements and must never fail the session.
 */
export async function auditHookFailure(
  stateRoot: string | undefined,
  hook: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (stateRoot !== undefined) {
    await logEngineEvent(stateRoot, { event: `hook-${hook}-error`, hook, error: message });
  } else {
    // No state root -> nowhere to audit; stderr is what the runner previews.
    process.stderr.write(`[zcode-crosschat] hook ${hook} failed: ${message}\n`);
  }
}

/**
 * Refresh the session record under the registry lock (DESIGN.md §2.3-1:
 * SessionStart writes/refreshes; UserPromptSubmit refreshes lastSeen on every
 * prompt). Busy lock or missing session id -> skip silently: losing one
 * refresh is harmless, timing out the hook is not.
 *
 * v0.5.3（安全对-1/a6 修复）：SessionStart 路径（ensureRegToken=true）会在记录缺
 * regToken 时铸造锚定令牌并随记录返回，调用方把它同步写进机器全局基记录并注入
 * 本会话上下文。锁忙（超 2s）时返回 undefined——本回合拿不到令牌就不注入，
 * 下次 SessionStart 再补，hook 永不因它失败。
 *
 * v0.9.4（A1）：`options.pid`（SessionStart 传入的宿主进程 pid）透传给
 * refreshSessionLastSeen——成员 pid 证据与 lastSeen/活性状态同一原子写落盘
 * （core/registry.ts / core/offline.ts 的 pid 判据）。undefined = 不写。
 */
export async function refreshSessionRegistration(
  stateRoot: string,
  sessionId: string,
  cwd: string,
  options: { ensureRegToken?: boolean; pid?: number } = {},
): Promise<SessionRecord | undefined> {
  let upserted: SessionRecord | undefined;
  await withRegistryLock(
    stateRoot,
    async () => {
      upserted = await refreshSessionLastSeen(stateRoot, sessionId, {
        cwd,
        ensureRegToken: options.ensureRegToken,
        ...(options.pid !== undefined ? { pid: options.pid } : {}),
      });
    },
    { waitMs: HOOK_LOCK_WAIT_MS },
  );
  return upserted;
}

/**
 * Names currently bound to this session id: names.json is authoritative
 * (written by xc_register, M3 identity.ts), the session record's `boundName`
 * is a compatibility fallback for readers racing the binding write. A corrupt
 * names.json degrades to "no bindings" — hooks must not crash (§2.3-1).
 */
export async function boundNamesForSession(stateRoot: string, sessionId: string): Promise<string[]> {
  const [names, session] = await Promise.all([
    readNames(stateRoot).catch(() => NO_NAMES),
    readSession(stateRoot, sessionId).catch(() => undefined),
  ]);
  const bound = namesBoundToSession(names, sessionId);
  if (bound.length > 0) return bound;
  return session?.boundName !== undefined ? [session.boundName] : [];
}

export interface UnreadSummary {
  count: number;
  /** Distinct senders, newest-first order. */
  senders: string[];
  /** Newest-first unread messages (for callers that want previews). */
  messages: TeamMessage[];
  /**
   * v0.6（C1，DESIGN-V0.6.md §3.1 读取序 2）：urgent 未读数单列——钩子注入与
   * 预算排布据此可给 urgent 全文优先（计数口径 = urgent===true 的未读件）。
   */
  urgentCount: number;
}

/**
 * Read-only unread summary for the UserPromptSubmit injection. Pure read —
 * freshness adjudication/discarding stays the property of the MCP tool that
 * actually returns the mail to the model (DESIGN.md §2.8 xc_check_inbox), so
 * the hook count can over-count stale mail but never destroys anything.
 * Malformed JSONL lines are skipped + audited by the M1 reader.
 *
 * v0.6（C1，DESIGN-V0.6.md §3.1 读取序 2）：messages 改为 urgentFirst 排序
 * （urgent 在前、类内 ts 升序）——消费方按序渲染时 urgent 全文优先占预算；
 * senders 的「最新优先」口径不变（对全体未读按 ts 降序去重）。
 */
export async function unreadSummary(stateRoot: string, name: string): Promise<UnreadSummary> {
  const messages = urgentFirst(await readUnreadMailbox(stateRoot, DEFAULT_TEAM_ID, name));
  const senders: string[] = [];
  for (const message of [...messages].sort((a, b) => b.ts - a.ts)) {
    if (!senders.includes(message.from)) senders.push(message.from);
  }
  const urgentCount = messages.filter((message) => message.urgent === true).length;
  return { count: messages.length, senders, messages, urgentCount };
}

/**
 * v0.9.1（G-12v3 机制 B）：hook 未读注入的**消费确认回写**（consumedAt，best-effort）。
 *
 * 语义：UserPromptSubmit 钩子把「你有 N 条未读」注入进成员回合 = 该会话**实际开跑
 * 并被知会**——不是 limbo（limbo 的生产形态是唤醒子进程在成员回合消费前死亡，钩子
 * 从未运行）。盖章（deliveredAt）与消费确认自此在数据面分离：limbo 降级 sweep 以
 * consumedAt 为放行判据（engine/wake.ts startWakeLifecycleWatch）。
 *
 * 纪律：团队锁 2s 预算（HOOK_LOCK_WAIT_MS）——锁忙即跳过（丢失一次回写无害：下回合
 * 再写；消息仍在未读态，钩子每回合重复提醒，不会丢）；无未读/全部已回写 → 不碰盘。
 * readAt 不动（消费动作仍归 xc_read；本回写只证明「会话活着且被知会」）。
 *
 * @returns 本次回写的消息 id 数（0 = 无需回写或锁忙跳过）。
 */
export async function markInjectedConsumed(
  stateRoot: string,
  agentKey: string,
  now: number = Date.now(),
): Promise<number> {
  try {
    let marked = 0;
    await withTeamLock(
      stateRoot,
      DEFAULT_TEAM_ID,
      async () => {
        const team = await readTeam(stateRoot, DEFAULT_TEAM_ID);
        if (team === undefined) return;
        const ids = (await readUnreadMailbox(stateRoot, DEFAULT_TEAM_ID, agentKey))
          .filter((m) => m.consumedAt === undefined)
          .map((m) => m.id);
        if (ids.length === 0) return;
        await markMailboxConsumed(stateRoot, DEFAULT_TEAM_ID, agentKey, ids, now);
        marked = ids.length;
      },
      { waitMs: HOOK_LOCK_WAIT_MS },
    );
    return marked;
  } catch {
    return 0; // 锁忙/IO：尽力而为（钩子永不因它失败）
  }
}

/**
 * v0.7.1（红队四番战 故障注-1 修复）：provisioning 超时清扫（钩子面）。
 *
 * 背景：建员欢迎回合的超时原只存在于 lead MCP server 进程的内存里——server
 * 中途死亡则成员 roster 永久卡 provisioning（无回执/无审计/占名额，红队 fi1）。
 * v0.7.1 起 deadline 随记录落盘（member-add Phase 1 写 `provisionDeadlineAt`），
 * 本函数让任一存活会话的 UserPromptSubmit 回合都能把过期记录清扫成 failed：
 *   锁内 read-modify-write（团队锁，HOOK_LOCK_WAIT_MS 预算；锁忙即跳过——
 *   丢失一次清扫无害，下回合再扫）+ engine.jsonl `member-provision-timeout` 审计。
 * 存量记录（无 deadline 字段）按 `provisionedAt/joinedAt + 超时口径` 现算兜底
 * （钩子进程无 userConfig env，用内置默认 300s + 60s 宽限——保守方向）。
 *
 * M4 → M1 纪律：只 import core（teamstate/lock/log），不碰 engine/MCP。
 * @returns 本次清扫掉的成员键（空 = 无可清扫或锁忙跳过）。
 */
export async function sweepStaleProvisioning(stateRoot: string): Promise<string[]> {
  const sweptKeys: string[] = [];
  try {
    await withTeamLock(
      stateRoot,
      DEFAULT_TEAM_ID,
      async () => {
        const team = await readTeam(stateRoot, DEFAULT_TEAM_ID);
        if (team === undefined) return;
        const swept = sweepStaleProvisioningLocked(team, Date.now(), provisionStaleAfterMsFromEnv(process.env));
        if (swept.length === 0) return;
        await writeTeam(stateRoot, team);
        for (const entry of swept) {
          sweptKeys.push(entry.key);
          await logEngineEvent(stateRoot, {
            event: 'member-provision-timeout',
            teamId: DEFAULT_TEAM_ID,
            name: entry.key,
            deadline: entry.deadline,
            via: 'hook',
          });
        }
      },
      { waitMs: HOOK_LOCK_WAIT_MS },
    );
  } catch (error) {
    // 锁忙：跳过本次清扫（下回合再试），不当错误上抛。
    if (error instanceof LockBusyError) return [];
    throw error;
  }
  return sweptKeys;
}

/**
 * v0.3：机器全局 peer 根目录（FEASIBILITY-V0.3 §1.2：ZCODE_PLUGIN_DATA 在钩子进程
 * 与 MCP server 进程都存在，且是用户级绝对路径 ⇒ 跨工作区可见）。
 */
export function peerRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePeerRoot(env);
}

/**
 * v0.3：钩子载荷里的权限档（CC 的 bypass/prompting 类）。
 * 实测载荷含 permission_mode 与 mode 两个键（"yolo"），这里取其一并映射：
 * yolo（或等价跳权限配置）→ bypass；其余 → prompting；取不到 → undefined
 * （收方档类未知时按 mode-unknown 暂存，fail-closed，CC H() 的 R()===null 分支）。
 */
export function readHookPermissionMode(stdin: HookStdin | undefined): 'bypass' | 'prompting' | undefined {
  const raw = stdin?.str('permission_mode', 'mode') ?? stdin?.str('mode', 'mode');
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'yolo' || v === 'bypass' || v === 'acceptEdits') return 'bypass';
  return 'prompting';
}

/** v0.3：写机器全局 peer 基记录（薄封装，落盘逻辑在 core/peerdir.ts）。
 *  v0.5.3（a6/a8）：记录形状放宽到含锚定令牌 regToken 与队内绑定标记 boundName。 */
export async function writePeerBaseRecord(
  root: string,
  record: {
    sessionId: string;
    cwd: string;
    permissionMode?: 'bypass' | 'prompting';
    source: string | null;
    startedAt: number;
    lastSeen: number;
    regToken?: string;
    boundName?: string;
  },
): Promise<void> {
  await writeBase(root, record);
}

/** v0.5.3（a6/a8）：读机器全局 peer 基记录（SessionStart 合并既有令牌/绑定标记用）。 */
export { readPeerBaseRecord };

/**
 * v0.3：刷新基记录的档类与 lastSeen（UserPromptSubmit 每次调用）。
 * 会话中途改权限模式时，自动档判定吃的是本回合的档类而不是 SessionStart 快照。
 */
export async function refreshPeerBaseRecord(
  root: string,
  sessionId: string,
  patch: { permissionMode?: 'bypass' | 'prompting'; lastSeen: number },
): Promise<void> {
  await refreshBase(root, sessionId, patch);
}
