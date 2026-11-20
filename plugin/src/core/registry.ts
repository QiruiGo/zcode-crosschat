/**
 * M1 core-store: session registry — sessions/*.json, names.json and the
 * one-shot wake nonces (DESIGN.md §2.2/§2.3).
 *
 * - sessions: written/refreshed by the SessionStart + UserPromptSubmit hooks
 *   (M4) and written by the MCP server on the wakeToken path (M3 identity.ts,
 *   "服务端代写").
 * - names: name -> {sessionId, role, registeredAt}; mutated only under the
 *   registry lock (xc_register, §2.7-3 fixed order registry -> team).
 * - wake nonces: one-shot capability for a pushed wake (TTL = 15 min). The
 *   nonce file doubles as the in-flight-wake marker (§2.5): an unused, fresh
 *   nonce for a target means "do not spawn another --resume yet".
 *
 * Every writer here commits whole files via the atomic writer; callers doing
 * read-modify-write must hold the registry lock.
 *
 * @module core/registry
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { writeFileAtomic } from './atomic.js';
import { wakeDir, wakeFile, namesFile, sessionsDir, sessionFile, witnessFile, witnessDir } from './paths.js';
import { logEngineEvent } from './log.js';
import { withRegistryLock } from './lock.js';
import {
  SESSION_IDLE_EVENT,
  SESSION_RUNNING_EVENT,
  applyLivenessTransition,
  type LivenessTransition,
  type SessionWitness,
  type SessionWitnessKind,
  type StoredLiveness,
} from './liveness.js';
import {
  coerceNameBindings,
  coerceSessionRecord,
  coerceSessionWitness,
  coerceWakeNonce,
  type NameBinding,
  type NameBindings,
  type SessionRecord,
  type WakeNonce,
} from './types.js';

/**
 * Wake nonce TTL == in-flight wake window (DESIGN.md §2.5-3:
 * WAKE_INFLIGHT_MS = 15 minutes; headless turns routinely outlast the 60 s
 * mailbox lease, so the two timers must never be conflated).
 */
export const WAKE_INFLIGHT_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// sessions/<sessionId>.json
// ---------------------------------------------------------------------------

/** Read one session record; undefined when absent OR unparseable/corrupt
 * (hooks must not crash: a rejected hook path falls back to wakeToken). */
export async function readSession(stateRoot: string, sessionId: string): Promise<SessionRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(sessionFile(stateRoot, sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = coerceSessionRecord(value, sessionId);
  return parsed.ok ? parsed.record : undefined;
}

/** Write/replace one session record (whole-file atomic; caller locks). */
export async function writeSession(stateRoot: string, record: SessionRecord): Promise<void> {
  await mkdir(sessionsDir(stateRoot), { recursive: true });
  await writeFileAtomic(sessionFile(stateRoot, record.sessionId), JSON.stringify(record, null, 2));
}

/**
 * Refresh one session's lastSeen, creating the record when the hook has not
 * written one yet (UserPromptSubmit path, DESIGN.md §2.3-1). Returns the
 * upserted record. Caller holds the registry lock when racing others.
 *
 * v0.5.3（安全对-1/a6 修复）：`ensureRegToken: true` 时（SessionStart 路径），
 * 记录缺 `regToken` 就铸造一枚并落盘——锚定令牌是重绑 (name, sid) 对的属主凭据，
 * 只注入到本会话上下文（见 hooks/session-start.ts）。已存在则原样保留（令牌在
 * 会话生命周期内稳定，--resume 的新回合照常出示同一枚）。
 *
 * v0.9（G-9 活性状态机，PROTOCOL §12.4）：本函数的全部调用点（SessionStart /
 * UserPromptSubmit 钩子）都是**回合开始**时刻——默认把记录标为 `running`
 * （`options.liveness` 可显式覆盖；`'none'` = 只刷新不动状态）。凡触到 registry
 * 的引擎事件都刷新 `lastEventTs`（G-5 心跳代理的数据基础）。状态**迁移**（含
 * 无状态 → running 的首标）写 engine.jsonl `session-running` / `session-idle`
 * 事件（core/liveness.ts 冻结命名；best-effort，写失败不影响记录本身）。
 * v0.9.2（A3）：同一点盖写 `lastTurnTs`（回合开始时刻）——UserPromptSubmit 的
 * 「回合开始事故摘要」以此为窗口起点，见函数体末与 hooks/prompt-submit.ts。
 */
export async function refreshSessionLastSeen(
  stateRoot: string,
  sessionId: string,
  options: { cwd?: string; now?: number; ensureRegToken?: boolean; liveness?: StoredLiveness | 'none' } = {},
): Promise<SessionRecord> {
  const now = options.now ?? Date.now();
  const existing = await readSession(stateRoot, sessionId);
  const base: SessionRecord = existing === undefined
    ? { sessionId, cwd: options.cwd ?? '', startedAt: now, lastSeen: now }
    : { ...existing, lastSeen: now, ...(options.cwd !== undefined && existing.cwd === '' ? { cwd: options.cwd } : {}) };
  const liveness = options.liveness ?? 'running';
  const applied = liveness === 'none'
    ? { record: { ...base, lastEventTs: now }, transition: null }
    : applyLivenessTransition(base, liveness, now);
  const record = applied.record;
  if (options.ensureRegToken === true && record.regToken === undefined) {
    record.regToken = randomUUID();
  }
  // v0.9.2（A3）：回合开始时刻——本函数的全部调用点（SessionStart / UserPromptSubmit
  // 钩子，hooks/shared.ts refreshSessionRegistration）都是回合边界，因此「盖写
  // lastTurnTs」在此单点完成，不需要新的写入面。A3 的 UserPromptSubmit 事故摘要在
  // 盖写**之前**读旧值当窗口起点（hooks/prompt-submit.ts），故「自上次回合」的口径
  // 由数据本身保证，不依赖调用序记忆。存量记录首回合写入后即具备窗口。
  record.lastTurnTs = now;
  await writeSession(stateRoot, record);
  await logLivenessTransition(stateRoot, sessionId, record, applied.transition);
  // v0.9.1 r3（V090-01）：同步写引擎证言（豁免输入与自述记录分路）。
  if (liveness !== 'none') {
    await writeSessionWitness(stateRoot, sessionId, liveness, now);
  }
  return record;
}

// ---------------------------------------------------------------------------
// registry/witness/<sessionId>.json —— 活性引擎证言（V090-01 r3）
// ---------------------------------------------------------------------------

/** 证言节流窗：与心跳同口径（工具突发下不逐调用重写）。 */
export const WITNESS_HEARTBEAT_THROTTLE_MS = 30_000;

/**
 * 读一个会话的引擎证言（undefined = 从未被引擎进程见过 / 文件损坏）。
 * 与 readSession 分路：本文件不含任何自述字段，只由引擎写（hooks + 工具心跳），
 * 因此「一次外部写 sessions/<sid>.json」造不出证言——清扫豁免以此为唯一输入。
 */
export async function readSessionWitness(stateRoot: string, sessionId: string): Promise<SessionWitness | undefined> {
  let raw: string;
  try {
    raw = await readFile(witnessFile(stateRoot, sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = coerceSessionWitness(JSON.parse(raw), sessionId);
  return parsed.ok ? parsed.witness : undefined;
}

/**
 * 写引擎证言（整文件原子覆写；调用方持 registry 锁——与 writeSession 同纪律）。
 * `heartbeat` 类在节流窗内不重写（lastTs 已在窗内时跳过，由调用方判定）。
 */
export async function writeSessionWitness(
  stateRoot: string,
  sessionId: string,
  kind: SessionWitnessKind,
  now: number,
): Promise<SessionWitness> {
  const witness: SessionWitness = { sessionId, kind, ts: now };
  await mkdir(witnessDir(stateRoot), { recursive: true });
  await writeFileAtomic(witnessFile(stateRoot, sessionId), JSON.stringify(witness, null, 2));
  return witness;
}

/**
 * v0.9（G-9）：活性迁移写 engine.jsonl（`session-running` / `session-idle`，
 * PROTOCOL §12.4 冻结示例）。transition=null（同态刷新）→ 不写事件——每个 prompt
 * 只刷记录、不刷日志。审计行携带 prev/state/name（boundName 兜底）——刻意不用
 * `from`/`to` 键名（它们在时间线 actor 取值链上，状态字符串会被误当行为方）。
 * best-effort：logEngineEvent 自吞 IO 失败（core/log.ts 纪律），本函数不再包 try。
 */
async function logLivenessTransition(
  stateRoot: string,
  sessionId: string,
  record: SessionRecord,
  transition: LivenessTransition | null,
): Promise<void> {
  if (transition === null) return;
  const name = record.boundName ?? null;
  await logEngineEvent(stateRoot, {
    event: transition.to === 'running' ? SESSION_RUNNING_EVENT : SESSION_IDLE_EVENT,
    sessionId,
    prev: transition.from,
    state: transition.to,
    ...(name !== null ? { name } : {}),
  });
}

/**
 * v0.9（G-9）：Stop 钩子的回合结束标记——记录标 `idle` + 迁移事件（idle→idle
 * 同态静默）。自带 registry 锁（waitMs 预算：钩子进程 10s 生存期，锁忙即放弃——
 * 丢失一次 idle 标记无害，下个回合边界会再校准）。记录不存在（会话从未被钩子
 * 锚定）→ no-op 返回 null。hook 永不因它失败（调用方包 auditHookFailure）。
 */
export async function markSessionIdle(
  stateRoot: string,
  sessionId: string,
  options: { now?: number; waitMs?: number } = {},
): Promise<LivenessTransition | null> {
  const now = options.now ?? Date.now();
  let transition: LivenessTransition | null = null;
  await withRegistryLock(
    stateRoot,
    async () => {
      const existing = await readSession(stateRoot, sessionId);
      if (existing === undefined) return;
      const applied = applyLivenessTransition(existing, 'idle', now);
      await writeSession(stateRoot, applied.record);
      await logLivenessTransition(stateRoot, sessionId, applied.record, applied.transition);
      // v0.9.1 r3（V090-01）：回合结束同步写证言（豁免输入）。
      await writeSessionWitness(stateRoot, sessionId, 'idle', now);
      transition = applied.transition;
    },
    { waitMs: options.waitMs ?? 2_000 },
  );
  return transition;
}

/**
 * v0.9（G-9/G-5）：MCP 工具调用心跳（peer-drain 包装层每次队内工具调用后触发）。
 * 工具调用=成员引擎事件 → 刷新 `lastEventTs`；记录停留在 idle（钩子标记丢失等
 * 罕见情形）时顺带标回 running（工具调用只能在回合内发生）。30s 节流：工具突发
 * 下不逐调用重写记录文件（心跳窗 30min，秒级偏移无意义）。锁忙 / 记录缺失 →
 * 静默跳过（心跳丢失无害，下次调用再试）；hook/工具永不因心跳失败。
 *
 * v0.9.1 r3（V090-01）：证言（registry/witness/<sid>.json）与自述记录**同源同刻**
 * 写——豁免只读证言（引擎亲见），自述记录的 liveness 降级为仅展示。节流以证言
 * lastTs 判定（锁内无竞态）；证言缺失（存量会话首次工具调用）立即补写。
 */
export async function markSessionHeartbeat(
  stateRoot: string,
  sessionId: string,
  options: { now?: number; waitMs?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  await withRegistryLock(
    stateRoot,
    async () => {
      const witness = await readSessionWitness(stateRoot, sessionId);
      // 节流：30s 内已有证言 → 不重写（锁内判定，竞态安全）。
      if (witness !== undefined && now - witness.ts < WITNESS_HEARTBEAT_THROTTLE_MS) return;
      const existing = await readSession(stateRoot, sessionId);
      if (existing !== undefined) {
        const applied = applyLivenessTransition(existing, 'running', now);
        await writeSession(stateRoot, applied.record);
        await logLivenessTransition(stateRoot, sessionId, applied.record, applied.transition);
      }
      await writeSessionWitness(stateRoot, sessionId, 'heartbeat', now);
    },
    { waitMs: options.waitMs ?? 2_000 },
  );
}

// ---------------------------------------------------------------------------
// names.json
// ---------------------------------------------------------------------------

/**
 * Read the whole name-binding map; ENOENT -> {}. Corrupt data throws a
 * diagnostic carrying the file path + recovery guidance.
 *
 * v0.7.1（红队四番战 故障注-2 修复）：不可解析的 names.json 此前裸抛
 * `SyntaxError`（`Unexpected token 'c', "corrupt names \x00\x01" is not valid
 * JSON`）——无文件路径、无恢复指引，与 team.json 损坏时「带路径 + 修复指引」
 * 的友好文案不一致（fi26 实测：注册硬失败 internal，运维只能猜）。现在与
 * readTeam 同族：显式诊断 = 文件绝对路径 + 损坏原因 + 恢复动作（names.json
 * 是**可重建索引**：删文件即重置，下次 xc_identify / xc_team member-add
 * 自然重建；会话记录里的 boundName 兼容兜底不受影响）。
 */
export async function readNames(stateRoot: string): Promise<NameBindings> {
  const file = namesFile(stateRoot);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid names.json "${file}": not valid JSON (${error instanceof Error ? error.message : String(error)}) — ` +
        'it is a rebuildable index: delete the file to reset (name bindings re-establish on the next ' +
        'xc_identify / xc_team member-add), or restore it from a backup',
    );
  }
  const parsed = coerceNameBindings(value);
  if (!parsed.ok) {
    throw new Error(
      `invalid names.json "${file}": ${parsed.defect} — ` +
        'it is a rebuildable index: delete the file to reset (name bindings re-establish on the next ' +
        'xc_identify / xc_team member-add), or restore it from a backup',
    );
  }
  return parsed.bindings;
}

/** Replace the whole name-binding map (whole-file atomic; caller locks). */
export async function writeNames(stateRoot: string, bindings: NameBindings): Promise<void> {
  await mkdir(sessionsDir(stateRoot), { recursive: true });
  await writeFileAtomic(namesFile(stateRoot), JSON.stringify(bindings, null, 2));
}

/** The binding for one name, if any. */
export function findNameBinding(bindings: NameBindings, name: string): NameBinding | undefined {
  return bindings[name];
}

/** All names currently bound to one session id. */
export function namesBoundToSession(bindings: NameBindings, sessionId: string): string[] {
  return Object.entries(bindings)
    .filter(([, binding]) => binding.sessionId === sessionId)
    .map(([name]) => name);
}

/**
 * Bind one name (caller validated collisions; caller holds the registry lock).
 * Rollback helper: unbindName undoes exactly this when the team join fails.
 */
export async function bindName(
  stateRoot: string,
  name: string,
  binding: NameBinding,
): Promise<NameBindings> {
  const bindings = await readNames(stateRoot);
  bindings[name] = binding;
  await writeNames(stateRoot, bindings);
  return bindings;
}

/**
 * Remove a name binding, but only when it still points at `sessionId`
 * (protects against clobbering a newer binding during rollback).
 * @returns whether a binding was removed.
 */
export async function unbindName(stateRoot: string, name: string, sessionId: string): Promise<boolean> {
  const bindings = await readNames(stateRoot);
  if (bindings[name] === undefined || bindings[name].sessionId !== sessionId) return false;
  delete bindings[name];
  await writeNames(stateRoot, bindings);
  return true;
}

// ---------------------------------------------------------------------------
// registry/wake/<nonce>.json
// ---------------------------------------------------------------------------

/**
 * Generate a wake token and its nonce record. The token doubles as the file
 * name (`wake/<token>.json`), so a prompt-carried wakeToken alone is enough
 * for xc_register to look the nonce up (DESIGN.md §2.3-4).
 *
 * v0.9.1（G-11）：`voiceOwner`（可选）——本次唤醒续跑的原会话（= sid）。attemptWake
 * 恒填；xc_identify 消费 nonce 时转记到连接身份，uservoice 盖章面据此放宽「sid 被
 * elsewhere 活进程持有」的拒章（共享 sid 的无头回合要能转达用户原话）。
 */
export function newWakeNonce(input: { teamId: string; agentKey: string; sid: string; now?: number; voiceOwner?: string }): { token: string; nonce: WakeNonce } {
  const token = randomUUID();
  return {
    token,
    nonce: {
      teamId: input.teamId,
      agentKey: input.agentKey,
      sid: input.sid,
      ts: input.now ?? Date.now(),
      ...(input.voiceOwner !== undefined ? { voiceOwner: input.voiceOwner } : {}),
    },
  };
}

/** Persist one wake nonce under its token (atomic; also the in-flight marker). */
export async function writeWakeNonce(stateRoot: string, token: string, nonce: WakeNonce): Promise<void> {
  await mkdir(wakeDir(stateRoot), { recursive: true });
  await writeFileAtomic(wakeFile(stateRoot, token), JSON.stringify(nonce, null, 2));
}

/**
 * Generate + persist a wake nonce in one step.
 * @returns the token (carry it into the wake prompt) and the stored nonce.
 * v0.9.1（G-11）：`voiceOwner` 透传（见 newWakeNonce）。
 */
export async function createWakeNonce(
  stateRoot: string,
  input: { teamId: string; agentKey: string; sid: string; now?: number; voiceOwner?: string },
): Promise<{ token: string; nonce: WakeNonce }> {
  const { token, nonce } = newWakeNonce(input);
  await writeWakeNonce(stateRoot, token, nonce);
  return { token, nonce };
}

/** Read one wake nonce by token; undefined when absent. */
export async function readWakeNonce(stateRoot: string, token: string): Promise<WakeNonce | undefined> {
  let raw: string;
  try {
    raw = await readFile(wakeFile(stateRoot, token), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = coerceWakeNonce(JSON.parse(raw));
  return parsed.ok ? parsed.nonce : undefined;
}

/**
 * Consume one nonce on the xc_register wakeToken path: marks `used` when the
 * stored nonce matches the given teamId/agentKey/sid and is still fresh.
 * @returns the consumed nonce, or undefined when missing/mismatched/used/expired.
 */
export async function consumeWakeNonce(
  stateRoot: string,
  token: string,
  match: { teamId: string; agentKey: string; sid: string },
  now: number = Date.now(),
): Promise<WakeNonce | undefined> {
  const existing = await readWakeNonce(stateRoot, token);
  if (existing === undefined) return undefined;
  if (existing.used === true) return undefined;
  if (!isWakeNonceFresh(existing, now)) return undefined;
  if (existing.teamId !== match.teamId || existing.agentKey !== match.agentKey || existing.sid !== match.sid) {
    return undefined;
  }
  const used: WakeNonce = { ...existing, used: true };
  await writeFileAtomic(wakeFile(stateRoot, token), JSON.stringify(used, null, 2));
  return used;
}

/** Whether a nonce is unused and inside its TTL window. */
export function isWakeNonceFresh(nonce: WakeNonce, now: number = Date.now()): boolean {
  return nonce.used !== true && now - nonce.ts <= WAKE_INFLIGHT_MS;
}

export interface StoredWakeNonce {
  /** Token the nonce is stored under. */
  token: string;
  nonce: WakeNonce;
}

/**
 * Find the freshest unused, fresh nonce for one target agent — the in-flight
 * wake marker (§2.5-3): a hit means "skip pushing, one is already on its way".
 */
export async function findInflightWakeNonce(
  stateRoot: string,
  agentKey: string,
  options: { teamId?: string; sid?: string; now?: number } = {},
): Promise<StoredWakeNonce | undefined> {
  const now = options.now ?? Date.now();
  let entries: string[];
  try {
    entries = await readdir(wakeDir(stateRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let found: StoredWakeNonce | undefined;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const token = entry.slice(0, -'.json'.length);
    const nonce = await readWakeNonce(stateRoot, token);
    if (nonce === undefined) continue;
    if (!isWakeNonceFresh(nonce, now)) continue;
    if (nonce.agentKey !== agentKey) continue;
    if (options.teamId !== undefined && nonce.teamId !== options.teamId) continue;
    if (options.sid !== undefined && nonce.sid !== options.sid) continue;
    if (found === undefined || nonce.ts > found.nonce.ts) {
      found = { token, nonce };
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Compatibility aliases for the module-3 identity flow (src/mcp/identity.ts)
// ---------------------------------------------------------------------------

/** Alias of readSession (module-3 call name). */
export const readSessionFile = readSession;

/** Alias of writeSession (module-3 call name). */
export const writeSessionFile = writeSession;

/**
 * Unconditionally mark one nonce as used, by token. The xc_register flow
 * validates freshness/match itself, then consumes; missing nonces are a no-op
 * returning false.
 */
export async function markWakeNonceUsed(stateRoot: string, token: string, now: number = Date.now()): Promise<boolean> {
  const existing = await readWakeNonce(stateRoot, token);
  if (existing === undefined || existing.used === true) return false;
  await writeWakeNonce(stateRoot, token, { ...existing, used: true, ts: existing.ts });
  void now;
  return true;
}
