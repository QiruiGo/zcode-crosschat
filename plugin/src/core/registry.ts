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
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { wakeDir, wakeFile, namesFile, sessionsDir, sessionFile, witnessFile, witnessDir } from './paths.js';
import { logEngineEvent } from './log.js';
import { withRegistryLock } from './lock.js';
import {
  SESSION_DEAD_EVENT,
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
 *
 * v0.9.4（A1）：`options.pid`（SessionStart 钩子传入的宿主进程 pid）在同一点落盘
 * （成员 pid 证据；core/offline.ts memberLiveness 的 pid 判据吃它）。显式传入才写，
 * undefined = 不动既有值——UserPromptSubmit/心跳等非 SessionStart 路径不刷新 pid。
 */
export async function refreshSessionLastSeen(
  stateRoot: string,
  sessionId: string,
  options: { cwd?: string; now?: number; ensureRegToken?: boolean; liveness?: StoredLiveness | 'none'; pid?: number } = {},
): Promise<SessionRecord> {
  const now = options.now ?? Date.now();
  const existing = await readSession(stateRoot, sessionId);
  const base: SessionRecord = existing === undefined
    ? { sessionId, cwd: options.cwd ?? '', startedAt: now, lastSeen: now }
    : { ...existing, lastSeen: now, ...(options.cwd !== undefined && existing.cwd === '' ? { cwd: options.cwd } : {}) };
  // v0.9.4（A1）：pid 证据读改写同点落盘（与 lastEventTs 同一原子写）。
  if (options.pid !== undefined) base.pid = options.pid;
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
  // v0.10.0（组 A / R6）：StoredLiveness 放开到含 `dead` 后，证言仍只收
  // running/idle——证言是「引擎亲见的**活动**」记录，判亡翻转（markSessionDead）
  // 不是活动，不往证言里写死亡（sweepOwnerGuard 以证言为唯一豁免输入，多一种
  // 形态就多一条攻击/误判面）。'none' 与 'dead' 都不写证言。
  if (liveness === 'running' || liveness === 'idle') {
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
 *
 * v0.10.0（组 A / R6）：新增第三迁移目标 **`session-dead`**（v0.10.0 新事件名，
 * 既有 session-running/session-idle 键集与语义逐字节不动）——running/idle → dead
 * 的判亡翻转（markSessionDead）与 dead → running/idle 的复活迁移（重新 register /
 * 重新武装）都落它，prev 如实记来源态。此后 engine.jsonl 里「注册表活性翻过一次」
 * 可逐条对账（member-dead 是死亡告警事件、session-dead 是注册表翻转事件，一次判亡
 * 两条、同成员同 sid，双写一致由此可验证）。
 */
async function logLivenessTransition(
  stateRoot: string,
  sessionId: string,
  record: SessionRecord,
  transition: LivenessTransition | null,
): Promise<void> {
  if (transition === null) return;
  // v0.9.9（V098-01）：审计名兜底链 = boundName（member-add 供给代写的无头持有者标）
  // → wakeTicketBound（票据消费记账标记，v0.9.9 起票据路径改写它）→ null。票据路径
  // 不再写 boundName 后，唤醒绑定会话的活性迁移审计仍可命名——安全修复不丢观测面。
  const name = record.boundName ?? record.wakeTicketBound?.name ?? null;
  await logEngineEvent(stateRoot, {
    event: transition.to === 'running'
      ? SESSION_RUNNING_EVENT
      : transition.to === 'dead'
        ? SESSION_DEAD_EVENT
        : SESSION_IDLE_EVENT,
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

/**
 * v0.10.0（组 A / R6/G-24）：**判亡后注册表活性翻转**（member-dead 的注册表侧双写）。
 *
 * 缺陷形态（G-24，监督侧实测）：看门狗发 member-dead 后 registry 仍标 running
 * （今日 xingtai、m7 等被判亡多次而 sessions/<sid>.json 的 Running 不翻）——
 * 「engine 事件说亡、注册表说活」，R3 若要改判据，这个前置不修则换了 pid 来源也未必准。
 *
 * 口径（写死）：
 * - 只把记录从 running/idle 翻成 `dead`（含 livenessTs/lastEventTs 同刻刷新）；
 *   同态（已 dead / 无记录 / 无 liveness 字段）→ 零写入零事件（不制造翻转噪音）；
 * - 迁移落 engine.jsonl `session-dead` 事件（与 session-running/session-idle 同族
 *   的活性迁移审计；best-effort，写失败不影响记录本身）；
 * - **不写证言**：registry/witness/<sid>.json 是引擎亲见的活动证据，判亡不是活动，
 *   不往证言里写死亡（证言只由 hooks/工具心跳写，core/liveness.ts sweepOwnerGuard
 *   以它为唯一豁免输入——写 death 会让豁免面多一种形态）；
 * - 自带 registry 锁（waitMs 预算同 markSessionIdle）；锁忙即放弃——下一次判亡
 *   周期会再翻（看门狗每轮对 confirmed 死亡调用，丢失一次无害）。
 *
 * 翻回由另外两个写入点保证：重新 register（{@link anchorSessionForRegister}）与
 * 下一回合边界（{@link refreshSessionLastSeen} 默认 running）——「member-dead 之后
 * 翻 dead、重新 register 后翻回 running 或 idle」闭环。
 */
export async function markSessionDead(
  stateRoot: string,
  sessionId: string,
  options: { now?: number; waitMs?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  await withRegistryLock(
    stateRoot,
    async () => {
      const existing = await readSession(stateRoot, sessionId);
      // 无记录 / 已是 dead / 从未标过活性（存量最小记录）→ 无从翻转（不猜、不写）
      if (existing === undefined) return;
      if (existing.liveness !== 'running' && existing.liveness !== 'idle') return;
      const applied = applyLivenessTransition(existing, 'dead', now);
      await writeSession(stateRoot, applied.record);
      await logLivenessTransition(stateRoot, sessionId, applied.record, applied.transition);
    },
    { waitMs: options.waitMs ?? 2_000 },
  );
}

/**
 * v0.10.0（组 A / R6）：**判亡翻回的清除面**——记录自述 `dead` 时翻回 `idle`。
 *
 * 两个调用方：
 * 1. 看门狗「重新武装」路径（台账 dead→alive 迁移）：成员不再 pid-dead（新 peer
 *    记录 / 新 pid 写回）而注册表还挂着上一次判亡的 `dead`——清掉，让注册表与
 *    「已重新武装」的台账一致（选 idle 而非 running：此刻没有回合中的引擎证据，
 *    下一回合边界会标回 running）；
 * 2. 记录缺失 / 非 dead → 零写入（含 running/idle 原样保留——不与钩子写入抢写）。
 */
export async function clearSessionDead(
  stateRoot: string,
  sessionId: string,
  options: { now?: number; waitMs?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  await withRegistryLock(
    stateRoot,
    async () => {
      const existing = await readSession(stateRoot, sessionId);
      if (existing === undefined) return;
      if (existing.liveness !== 'dead') return;
      const applied = applyLivenessTransition(existing, 'idle', now);
      await writeSession(stateRoot, applied.record);
      await logLivenessTransition(stateRoot, sessionId, applied.record, applied.transition);
    },
    { waitMs: options.waitMs ?? 2_000 },
  );
}

/**
 * v0.10.0（组 A / R6）：**wakeToken 注册路径的会话记录锚定**（mcp/identity.ts 专用；
 * 「服务端代写」的单一写入点）。
 *
 * 缺陷形态：旧实现整体 spread 旧记录后只改 sessionId/cwd/startedAt/lastSeen/regToken
 * （identity.ts 原 :611-619）——上一次化身的陈旧 `liveness`（含判亡翻转的 `dead`、
 * 或崩溃前悬停的 `running`）被原样带回来，「重新 register 后立即翻回 running 或
 * idle」不成立（R6 验收口径第二句）。
 *
 * 口径（写死）：注册发生在**回合内**（模型刚发起 xc_identify 工具调用）——记录锚定
 * 的同时把活性翻回 `running`（迁移落 session-running 事件，prev 如实记 dead/idle/
 * null）；其余字段逐字节保持旧实现形状（cwd 覆盖、startedAt 保留、regToken 缺省
 * 补铸）。不写证言（与旧实现一致：证言由钩子/心跳路径写，注册本身不伪造活动证据）。
 */
export async function anchorSessionForRegister(
  stateRoot: string,
  sessionId: string,
  options: { cwd?: string; now?: number } = {},
): Promise<SessionRecord> {
  const now = options.now ?? Date.now();
  const existing = await readSession(stateRoot, sessionId);
  const record: SessionRecord = {
    ...(existing ?? {}),
    sessionId,
    cwd: options.cwd ?? existing?.cwd ?? '',
    startedAt: existing?.startedAt ?? now,
    lastSeen: now,
    regToken: existing?.regToken ?? randomUUID(),
  };
  const applied = applyLivenessTransition(record, 'running', now);
  await writeSession(stateRoot, applied.record);
  await logLivenessTransition(stateRoot, sessionId, applied.record, applied.transition);
  return applied.record;
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
 *
 * v0.9.4（A6）：`issuedToSid`/`name`（可选）——票据签发目标 sid 与队内花名。
 * attemptWake 恒填（= sid/agentKey）：SessionStart 钩子据此做「非目标 sid 拒」的
 * 自动绑定（一次性消费，见 {@link consumeWakeTicketForSession}）。
 */
export function newWakeNonce(input: {
  teamId: string; agentKey: string; sid: string; now?: number; voiceOwner?: string;
  issuedToSid?: string; name?: string;
}): { token: string; nonce: WakeNonce } {
  const token = randomUUID();
  return {
    token,
    nonce: {
      teamId: input.teamId,
      agentKey: input.agentKey,
      sid: input.sid,
      ts: input.now ?? Date.now(),
      ...(input.voiceOwner !== undefined ? { voiceOwner: input.voiceOwner } : {}),
      ...(input.issuedToSid !== undefined ? { issuedToSid: input.issuedToSid } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
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
 * v0.9.4（A6）：`issuedToSid`/`name` 透传（见 newWakeNonce）。
 */
export async function createWakeNonce(
  stateRoot: string,
  input: {
    teamId: string; agentKey: string; sid: string; now?: number; voiceOwner?: string;
    issuedToSid?: string; name?: string;
  },
): Promise<{ token: string; nonce: WakeNonce }> {
  const { token, nonce } = newWakeNonce(input);
  await writeWakeNonce(stateRoot, token, nonce);
  return { token, nonce };
}

/**
 * Read one wake nonce by token; undefined when absent.
 *
 * v0.9.7（W4/V096-02）：**坏票守卫**——`JSON.parse` 失败（票据文件被写坏/截断/手改）
 * 不再向上抛 SyntaxError，改为**跳过该票** + 审计 `wake-ticket-corrupt{path}`（指向
 * 坏文件本身，运维可直读定位）后返回 undefined。
 *
 * 缺陷形态（adv-1 F-2 实测）：registry/wake/ 里一个不可解析的 JSON 文件令
 * {@link consumeWakeTicketForSession} / {@link findLiveInflightWakeNonce} /
 * {@link revokeWakeNonceForProvisionFailure} 三个扫描点全部抛错 → 所有 dispatch 与
 * relay 整单报 opaque internal（无自愈、无诊断、不知是哪个文件坏）。本守卫把
 * 「一张坏票」降级成「一张被跳过的票」：其余票据照常参与判定，审计指向坏文件。
 * 与 {@link coerceWakeNonce} 的宽容读取同族（形状不合法早已按 undefined 跳过），
 * 差别只在 JSON 语法层——此前它走的是 throw 分支。
 *
 * v0.9.8（D4/V097-12）：**读取错误也按坏票处理**。旧实现的 readFile catch 只放行
 * ENOENT，其余 errno（票据路径被换成**目录**的 EISDIR、权限被收的 EACCES/EPERM 等）
 * 原样上抛 → 同样把三个扫描点整单选成 internal（形态与 F-2 同族：一张问题票拖垮
 * 所有 dispatch/relay，且回执不知指向哪个文件）。现在非 ENOENT 读取失败与坏 JSON
 * 同口径：跳过该票 + 审计 `wake-ticket-corrupt{path,error}`（error 带 errno 与原文，
 * 运维可分辨「写坏了」与「读不了」），返回 undefined。ENOENT（真缺席）语义不变。
 */
export async function readWakeNonce(stateRoot: string, token: string): Promise<WakeNonce | undefined> {
  let raw: string;
  try {
    raw = await readFile(wakeFile(stateRoot, token), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // v0.9.8（D4/V097-12）：ENOENT = 票据真缺席（语义不变、无审计）；其余读取错误
    // （EISDIR/EACCES/EPERM…）= 问题票：跳过 + 审计指向文件，不再整单 internal。
    if (code === 'ENOENT') return undefined;
    await logEngineEvent(stateRoot, {
      event: 'wake-ticket-corrupt',
      path: wakeFile(stateRoot, token),
      error: `${code ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`,
      reason: 'read-failed',
    });
    return undefined;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    // 坏票：跳过 + 审计指向文件（不阻断其他票据；logEngineEvent 自身吞写失败）。
    await logEngineEvent(stateRoot, {
      event: 'wake-ticket-corrupt',
      path: wakeFile(stateRoot, token),
      error: error instanceof Error ? error.message : String(error),
      reason: 'parse-failed',
    });
    return undefined;
  }
  const parsed = coerceWakeNonce(parsedJson);
  return parsed.ok ? parsed.nonce : undefined;
}

/**
 * Consume one nonce on the xc_register wakeToken path: marks `used` when the
 * stored nonce matches the given teamId/agentKey/sid and is still fresh.
 * @returns the consumed nonce, or undefined when missing/mismatched/used/expired.
 *
 * v0.9.5（A6/V094-04）：**MCP 面与钩子面判据统一**——本面此前只校验
 * teamId/agentKey/sid（registry.ts 旧 :450），不读 `issuedToSid`；钩子面
 * {@link consumeWakeTicketForSession} 却要求 `sid ∧ (issuedToSid ?? sid)` 双双指向
 * 本会话——同一张票两面判据分裂（手置 issuedToSid 的 nonce 钩子拒、MCP 放行）。
 * 现在两面同判据：`sid === match.sid ∧ (issuedToSid ?? sid) === match.sid`。
 * issuedToSid 缺省兜底 = sid（v0.9.5 起生产三签发点恒填 issuedToSid/name，A6；
 * 旧 nonce 缺字段仍按 sid 兜底，兼容 v0.9.3 及以前签发）。
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
  // v0.9.5（A6）：与钩子面同判据——issuedToSid（缺省 = sid）也必须指向本会话。
  if ((existing.issuedToSid ?? existing.sid) !== match.sid) return undefined;
  const used: WakeNonce = { ...existing, used: true };
  await writeFileAtomic(wakeFile(stateRoot, token), JSON.stringify(used, null, 2));
  return used;
}

/** Whether a nonce is unused and inside its TTL window. */
export function isWakeNonceFresh(nonce: WakeNonce, now: number = Date.now()): boolean {
  return nonce.used !== true && now - nonce.ts <= WAKE_INFLIGHT_MS;
}

/**
 * v0.9.4（A6）：SessionStart 钩子的**一次性票据消费**（唤醒一次到位的自动绑定入口）。
 *
 * 与 {@link consumeWakeNonce}（xc_identify 的 wakeToken 路径，调用方已知 token）不同：
 * 钩子只拿得到自己的 sid，因此本函数**按 sid 找票**——扫 registry/wake/ 里新鲜未用、
 * 且 `sid === sid ∧ (issuedToSid ?? sid) === sid` 的 nonce（票据只可能签发给它的
 * 目标会话；`issuedToSid` 缺失的旧 nonce 按 sid 兜底，兼容 v0.9.3 及以前签发）。
 * **非目标 sid 一律拒**：别个 sid 的票据不出现在候选里，钩子无法替别人消费。
 *
 * 一次性：命中即在 registry 锁内置 `used`（读-判-写原子段；两个进程同时跑同一 sid
 * 的钩子时只有一方拿到 nonce，另一方得 undefined——同一张票不会被绑定两次）。
 * 多张命中（同 sid 多轮唤醒在途）取 **ts 最新**的一张（与 findInflightWakeNonce
 * 同口径：在途标记认最新一轮）。
 *
 * 威胁模型口径（PROTOCOL §10/§11.5，同机信任域）：票据消费不做签名/哈希链——同机
 * 进程可读写 registry/wake/ 状态文件是本产品明文声明的边界（README 已知限制 12
 * 同族）；本机制的定位是「把唤醒身份绑定从模型回合前移到钩子」，不是防同机伪造。
 *
 * @returns 消费掉的 nonce 与其 token；无命中返回 undefined。
 */
export async function consumeWakeTicketForSession(
  stateRoot: string,
  options: { sid: string; teamId?: string; now?: number },
): Promise<StoredWakeNonce | undefined> {
  const now = options.now ?? Date.now();
  // 快路径（无锁）：registry/wake/ 不存在或没有任何 nonce 文件 → 直接返回，不为
  // 「从来没有唤醒过的状态根」白拿一次 registry 锁（SessionStart 钩子每回合都走本
  // 函数；锁预算 2s，能省则省）。TOCTOU 无害：attemptWake 先落 nonce 再 spawn 唤醒
  // 子（钩子在其后跑），钩子执行时票据必已在盘上。
  try {
    const entries = await readdir(wakeDir(stateRoot));
    if (!entries.some((entry) => entry.endsWith('.json'))) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let claimed: StoredWakeNonce | undefined;
  await withRegistryLock(
    stateRoot,
    async () => {
      let entries: string[];
      try {
        entries = await readdir(wakeDir(stateRoot));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      let found: StoredWakeNonce | undefined;
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const token = entry.slice(0, -'.json'.length);
        const nonce = await readWakeNonce(stateRoot, token);
        if (nonce === undefined) continue;
        if (!isWakeNonceFresh(nonce, now)) continue;
        // 非目标 sid 拒：sid 与 issuedToSid（缺省 = sid）都必须指向本会话。
        if (nonce.sid !== options.sid) continue;
        if ((nonce.issuedToSid ?? nonce.sid) !== options.sid) continue;
        if (options.teamId !== undefined && nonce.teamId !== options.teamId) continue;
        if (found === undefined || nonce.ts > found.nonce.ts) found = { token, nonce };
      }
      if (found === undefined) return;
      // 锁内原子置 used（整文件覆写；另一钩子进程此时进不来）。
      const used: WakeNonce = { ...found.nonce, used: true };
      await writeFileAtomic(wakeFile(stateRoot, found.token), JSON.stringify(used, null, 2));
      claimed = { token: found.token, nonce: used };
    },
    { waitMs: 2_000 },
  );
  return claimed;
}

/**
 * v0.9.5（A1/V094-02）：**ppid 身份采纳开关**（唯一解析点；缺省 off）。
 *
 * V094-02 的形态：ppid 采纳在「本会话记录因锁预算失败而缺失 + 同宿主多会话」时会把
 * 同宿主另一成员的记录当唯一命中，未 identify 的连接即以他人身份开工（串号）。
 * v0.9.5 起 **默认关闭**：`XC_ADOPT_BY_PPID=1` 才启用整条「唤醒一次到位」链
 * （SessionStart 钩子消费票据+自动绑定、MCP 连接按 ppid 采纳、唤醒 prompt 的
 * 「已自动绑定」口径）；默认走**唤醒票据兜底**——票据留给模型回合的 wakeToken
 * xc_identify 消费（2 次调用：identify + claim），宁可多一次调用，不许错绑身份。
 *
 * 解析纪律（与 offlineThresholdMsFromEnv 同族）：只认字面量 `"1"`（显式开启），
 * 其余一切取值（未设/空串/0/true/on）都按**关闭**处理——开关方向是「多一次调用」，
 * 误开比误关危险，取最保守解析。
 */
export function adoptByPpidEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["XC_ADOPT_BY_PPID"] === "1";
}

/**
 * v0.9.6 r2（V096-12）：绑定锚时窗常量（采纳护栏 6 的锚新鲜度判据）。
 *
 * - {@link ADOPT_ANCHOR_MAX_PREBIRTH_MS}：锚的 ts 允许早于本 server 进程诞生时刻的
 *   上限。正常形态下钩子（写锚方）与 server 是宿主同时拉起的子进程，锚 ts ≥ server
 *   诞生时刻（实测桌面宿主：插件 server 在宿主启动 +6.7s 拉起、钩子按会话启动触发，
 *   锚恒晚于 server 诞生）；窗口只为「钩子先于 server 拉起」的启动序留余量（钩子侧
 *   另有 ≤2.4s 轮询兜底，见 hooks/session-start.ts）。超过窗口的锚 = 前任 server 的
 *   残锚（server pid 被复用且本会话钩子未写锚的复合形态）→ 不猜。
 * - {@link ADOPT_ANCHOR_MAX_CLOCK_SKEW_MS}：锚 ts 落在未来超过此值 = 时钟异常/伪造
 *   → 不猜。
 */
export const ADOPT_ANCHOR_MAX_PREBIRTH_MS = 30_000;
export const ADOPT_ANCHOR_MAX_CLOCK_SKEW_MS = 5_000;

// ---------------------------------------------------------------------------
// 宿主唤醒子事实（V096-21）：宿主 cmdline 的 --resume <sid> 自证
// ---------------------------------------------------------------------------

/** 宿主进程唤醒子探测结果（v0.9.6 r3，V096-21）。 */
export interface HostResumeProbe {
  /** false = 宿主 cmdline 不可读（枚举失败）——fail-closed，不猜。 */
  available: boolean;
  /** 宿主 cmdline 里 `--resume` 后的 sid token；非唤醒子宿主（桌面 app-server/交互
   * CLI）没有该 token → undefined。 */
  resumeSid?: string;
}

/**
 * 读一个进程的完整命令行。两条可达通道（「可及则做，不可及如实声明」——V098-08）：
 * 1. **Linux `/proc/<pid>/cmdline`**（NUL 分隔的 argv；存在即读，零子进程开销）；
 * 2. **Windows PowerShell Get-CimInstance**（wmic 在新 Win11 已移除——实测本机
 *    26300 不可用，单拍实测 ~0.74s）。
 * 两条都不可达（非 Linux 无 /proc ∧ CIM 失败/超时/权限）→ undefined（fail-closed：
 * 调用方按「未核验」处理，不许当成已核验）。
 */
function readProcessCommandLine(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  // 通道 1：Linux /proc（本机实测之外的移植面；Windows 上该路径不存在，零成本跳过）。
  try {
    const procRaw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const joined = procRaw.split('\u0000').filter((part) => part !== '').join(' ').trim();
    if (joined !== '') return joined;
  } catch {
    /* 非 Linux 或不可读：落通道 2 */
  }
  // 通道 2：Windows CIM。
  try {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine`,
      ],
      { timeout: 6_000, encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0) return undefined;
    const out = (result.stdout ?? '').trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * v0.9.6 r3（V096-21）：探测一个进程是否是**针对某会话的唤醒子 CLI**。
 *
 * 唤醒子由引擎以 `<zcodeExe> <zcodeCjs> --resume <sessionId> --prompt …` 拉起
 * （engine/resume-cli.ts spawnDirect），其 cmdline 自带目标 sid。桌面 app-server
 * /交互 CLI 的 cmdline 没有该 token。
 *
 * **为什么这是绑定锚的归属判据**：锚写入缺陷（回二实测 R4）的根因是钩子枚举宿主
 * 子进程时无法区分「唯一的本插件 server 子进程属于哪个会话」——任意先于钩子在位的
 * 外来 server 子进程都会被误绑。宿主 cmdline 的 `--resume <sid>` 是**宿主自身的
 * 派生命令**：钩子（其 stdin payload 也带同一 sid）只有在本宿主 cmdline 的 resume
 * sid 与本会话 sid 一致时，才能断定「本宿主是为本会话拉起的单会话唤醒子」，此时
 * 宿主下唯一本插件 server 子进程才可归属到本会话；桌面多会话宿主（非 --resume）
 * 一律不写锚（该拓扑归属不可判定 → 采纳面拒绝，回落 wakeToken 票据兜底）。
 *
 * options.readCommandLine 供测试注入（生产走 {@link readProcessCommandLine}）。
 */
export function probeHostResumeSidSync(
  hostPid: number,
  options: { readCommandLine?: (pid: number) => string | undefined } = {},
): HostResumeProbe {
  // pid 自身非法即无从探测（fail-closed）——注入读取器也先过本闸（防御纵深）。
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0) return { available: false };
  const commandLine = (options.readCommandLine ?? readProcessCommandLine)(hostPid);
  if (commandLine === undefined) return { available: false };
  const normalized = commandLine.replaceAll('\\', '/');
  const match = /--resume\s+(\S+)/.exec(normalized);
  if (match === null || match[1] === undefined) return { available: true };
  return { available: true, resumeSid: match[1].replace(/^"|"$/g, '') };
}

/**
 * v0.9.9（V098-08）：pid 的**身份**判据——进程命令行是否自证「本会话的唤醒子」
 * （`--resume <sid>`，引擎 spawnDirect 的拉起形态）。
 *
 * 修什么：pid 只验存活不验身份（`process.kill(pid,0)`）——OS pid 复用后，一个与会话
 * 毫无关系的旁观进程会被当成「成员的活回合宿主」（adv-1 G2/F2：陈旧记录 + pid 复用
 * → steer 强杀旁观进程）。本函数补身份轴：活 ∧ 命令行正是本会话的唤醒子，才认。
 *
 * 三态返回（可及则做，不可及如实声明）：
 * - `confirmed`：cmdline 可读且 `--resume` 的 sid 正是 `sessionId`；
 * - `refuted`：cmdline 可读，但 resume sid 是别的值或没有该 token（桌面 app-server、
 *   交互 CLI、别的会话的唤醒子）——**不是**本会话的唤醒子；
 * - `unknown`：cmdline 不可读（枚举失败/超时/权限/pid 非法）——调用方必须按「未核验」
 *   如实披露（回落既有判据并说明），不得当成 confirmed 也不得当成 refuted。
 *
 * 消费面（engine/wake.ts classifySteerTarget 的唤醒子佐证注入，属组 W 文件域）：
 * 与 wakeTicketBound 记账标记、pid 存活、livenessTs 陈旧上限（types.ts
 * LIVENESS_TS_STALE_MS）共同构成「活回合 ∧ 可终止」的多重判据；本函数是其中的
 * 身份轴原语，注入面由 steer 分类调用方接线（测试经 options.readCommandLine 注入）。
 */
export function probePidResumeClaim(
  pid: number,
  sessionId: string,
  options: { readCommandLine?: (pid: number) => string | undefined } = {},
): 'confirmed' | 'refuted' | 'unknown' {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return 'refuted';
  const probe = probeHostResumeSidSync(pid, options);
  if (!probe.available) return 'unknown';
  return probe.resumeSid === sessionId ? 'confirmed' : 'refuted';
}

/**
 * v0.9.5（A6/V094-03）：**回滚一次性票据**（SessionStart 钩子专用）——票据已置
 * `used` 而随后的身份绑定失败（锁忙/花名被别人持有/本会话已有别的 boundName）时，
 * 把票据恢复为未用形态，保住 wake prompt 承诺的 **wakeToken 兜底路径**可用
 * （否则模型回合用同一 token 走 xc_identify 必撞 "already used"，兜底断裂）。
 *
 * 只写回「去掉 used 标记的同一 nonce」——签发字段（teamId/agentKey/sid/issuedToSid/
 * name/voiceOwner/ts）原样保留，TTL 判据（isWakeNonceFresh 按 ts）不因回滚重置：
 * 回滚不续命，过期票回滚后仍然过期（一次性语义不放松）。原子整文件写。
 */
export async function restoreWakeNonce(stateRoot: string, stored: StoredWakeNonce): Promise<void> {
  const { used: _omit, ...nonce } = stored.nonce;
  await writeWakeNonce(stateRoot, stored.token, nonce as WakeNonce);
}

/**
 * v0.9.4（A6）：按**宿主进程 pid** 找会话记录（MCP 连接自动采纳身份的读取面）。
 *
 * 链路：SessionStart 钩子把宿主进程 pid 写进 sessions/<sid>.json（A1），而 MCP server
 * 与钩子同父进程（都是宿主会话拉的子进程）——server 读自己的 `process.ppid` 即可
 * 定位「本连接所属会话」的记录，无需宿主注入 sid。多条记录同 pid（一个宿主进程跑
 * 多个会话）→ 返回 undefined（歧义不猜，回落 not_registered 让调用方显式 identify）。
 *
 * v0.9.6（A1/V095-01）：**不可解析记录计入歧义面**——本目录里任何「有文件但解析不出
 * 会话记录」的条目（JSON 坏/结构不符/读得了名字读不了内容）都可能是一个 pid 命中的
 * 第二会话（V095-01 的 C3.b 实测：损坏的兄弟记录被跳过 → 恰一条可解析命中 → 歧义闸
 * 被旁路 → 采纳他人身份）。现在损坏条目 >0 时一律不采纳（宁可 2 次调用兜底）；记录
 * 是可重建状态（下个 SessionStart 重锚），删除损坏文件即恢复。列表在册但读取时
 * ENOENT（列表→读取间隙被删）按真缺席处理，不计入。
 */
export async function readSessionByHostPid(stateRoot: string, pid: number): Promise<SessionRecord | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  let entries: string[];
  try {
    entries = await readdir(sessionsDir(stateRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let found: SessionRecord | undefined;
  let unparseable = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const sessionId = entry.slice(0, -'.json'.length);
    let raw: string;
    try {
      raw = await readFile(sessionFile(stateRoot, sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      unparseable++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      unparseable++;
      continue;
    }
    const coerced = coerceSessionRecord(parsed, sessionId);
    if (!coerced.ok) {
      unparseable++;
      continue;
    }
    if (coerced.record.pid !== pid) continue;
    if (found !== undefined) return undefined; // 歧义：一个 pid 对多个会话，不猜
    found = coerced.record;
  }
  if (unparseable > 0) return undefined; // v0.9.6（A1）：损坏记录在场 → 歧义面不干净，不采纳
  return found;
}

/**
 * v0.9.4（A6）：{@link readSessionByHostPid} 的**同步**变体——MCP 工具面的身份解析
 * （identity.ts IdentityStore.require）是同步函数，不能改 async（调用面遍布
 * tools-tasks/tools-relay/peer-services/guards）。同步小文件读只在「连接首次要求
 * 身份」时发生一次（采纳后进内存缓存），与钩子的 readFileSync(0) 同族口径。
 * 判据与异步版逐字一致：恰一条 pid 命中才返回，多条/零条 → undefined。
 *
 * v0.9.6（A1/V095-01）：**不可解析记录计入歧义面**（与异步版同步修）——目录里任何
 * 「有文件但解析不出会话记录」的条目（JSON 坏/结构不符/读得了名字读不了内容）都可能
 * 是一个 pid 命中的第二会话；V095-01 的 C3.b 实测：损坏的兄弟记录被 `continue` 跳过
 * （旧注释「坏行/坏文件不拦判据」正是被利用的旁路）→ 恰一条可解析命中 → 「恰一条才
 * 采纳」只在可解析记录上成立 → 歧义闸失效 → 采纳他人身份。现在损坏条目 >0 时一律
 * 返回 undefined（宁可 2 次调用兜底，不许错绑）；记录是可重建状态（下个 SessionStart
 * 重锚），删除损坏文件即恢复。列表在册但读取时 ENOENT（列表→读取间隙被删）按真缺席
 * 处理，不计入。
 */
export function readSessionByHostPidSync(stateRoot: string, pid: number): SessionRecord | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir(stateRoot));
  } catch {
    return undefined; // 无 sessions 目录/不可读：无证据（不猜）
  }
  let found: SessionRecord | undefined;
  let unparseable = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const sessionId = entry.slice(0, -'.json'.length);
    let raw: string;
    try {
      raw = readFileSync(sessionFile(stateRoot, sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // 列表→读取间隙被删：真缺席
      unparseable++; // 读得了名字读不了内容：证据在场但不可解析 → 计入歧义面
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      unparseable++; // 坏 JSON：可能是被隐藏的第二会话 → 计入歧义面（V095-01 C3.b）
      continue;
    }
    const coerced = coerceSessionRecord(parsed, sessionId);
    if (!coerced.ok) {
      unparseable++; // 结构不符：同上，不猜
      continue;
    }
    if (coerced.record.pid !== pid) continue;
    if (found !== undefined) return undefined; // 歧义：一个 pid 对多个会话，不猜
    found = coerced.record;
  }
  if (unparseable > 0) return undefined; // v0.9.6（A1）：损坏记录在场 → 歧义面不干净，不采纳
  return found;
}

export interface StoredWakeNonce {
  /** Token the nonce is stored under. */
  token: string;
  nonce: WakeNonce;
}

// ---------------------------------------------------------------------------
// registry/adopt-anchor/<serverPid>.json —— 会话↔server 进程绑定锚（V096-12）
// ---------------------------------------------------------------------------

/**
 * v0.9.6 r2（V096-12）：**会话↔server 进程绑定锚**——ppid 采纳的第 6 道护栏的数据源。
 *
 * 缺陷形态（回二 V096-12，P1）：开启档下本连接的 sessions/<sid>.json 与 peers/base/
 * <sid>.json 双缺时，round-1 的基记录佐证面只剩受害者一条（恰等于 pid 命中记录的
 * sid），唯一性判据无法区分「本连接就是该会话」与「本连接是另一个零痕迹会话」→
 * 未注册连接零凭据采纳受害者身份（领单+冒名 completed 实测）。根因：盘上一切证据都
 * 绑定在 sid 上，server 进程没有任何「我就是这个会话」的自证通道。
 *
 * 修法：SessionStart 钩子消费唤醒票据后，枚举宿主进程的直接子进程里**本插件的
 * MCP server**（cmdline 匹配 <pluginRoot>/dist/mcp/server.mjs，实测宿主同时携带多个
 * 插件的 server.mjs，必须按插件根路径限定），把「本会话 ↔ 该 server 进程 pid」写成
 * 绑定锚。server 进程的 pid 是**活进程事实**（状态文件伪造不了「我的 pid 被本会话
 * 钩子锚定」这一条——除非伪造者连锚一起写，那属 README 已知限制 12 同机伪造边界）；
 * 采纳面读自己的 pid 对应的锚，恰一条且 sid/宿主 pid/时窗全部吻合才采纳。
 *
 * 写入纪律（hooks/session-start.ts）：
 * - 仅开启档票据路径（bindWakeTicketIdentity，票据消费成功后）——采纳人群就是被唤醒
 *   成员；普通会话不写（默认档行为逐字节不变）；
 * - 恰一个 server 子进程才写（宿主挂多个本插件 server 连接时无法归属 → 不写，采纳
 *   面 refuse）；零个（枚举失败/未起）→ 不写；两者都审计（adopt-anchor-written /
 *   adopt-anchor-skipped）；
 * - 锁外原子写、尽力而为，失败只审计钩子不失败——锚缺失时采纳面一律拒绝（fail-
 *   closed，回落 wakeToken 票据兜底 2 次调用）。
 */
export interface AdoptAnchor {
  /** 写锚的钩子所锚定的会话（= 票据的 sid）。 */
  sessionId: string;
  /** 写锚的钩子的父进程 = 宿主进程 pid（与 hookSessionPid 同值）。 */
  hostPid: number;
  /** 被绑定的本插件 MCP server 进程 pid（锚文件名）。 */
  serverPid: number;
  /** 写锚时刻（钩子运行时刻）。 */
  ts: number;
}

/** `registry/adopt-anchor/`：会话↔server 进程绑定锚目录（workspace 状态根内）。 */
export function adoptAnchorDir(stateRoot: string): string {
  return join(stateRoot, 'registry', 'adopt-anchor');
}

/** `registry/adopt-anchor/<serverPid>.json`：单个 server 进程的绑定锚。 */
export function adoptAnchorFile(stateRoot: string, serverPid: number): string {
  return join(adoptAnchorDir(stateRoot), `${serverPid}.json`);
}

/** 写一条绑定锚（整文件原子写；调用方 best-effort，失败只审计）。 */
export async function writeAdoptAnchor(stateRoot: string, anchor: AdoptAnchor): Promise<void> {
  await mkdir(adoptAnchorDir(stateRoot), { recursive: true });
  await writeFileAtomic(adoptAnchorFile(stateRoot, anchor.serverPid), JSON.stringify(anchor, null, 2));
}

/**
 * 读一条绑定锚（同步——采纳面 IdentityStore.require 是同步函数；undefined = 不存在
 * 或不可解析/结构不符，**两种都按「无锚」拒绝**，fail-closed 不猜）。
 */
export function readAdoptAnchorSync(stateRoot: string, serverPid: number): AdoptAnchor | undefined {
  if (!Number.isSafeInteger(serverPid) || serverPid <= 0) return undefined;
  let raw: string;
  try {
    raw = readFileSync(adoptAnchorFile(stateRoot, serverPid), 'utf8');
  } catch {
    return undefined; // 缺失/不可读：无锚证据（不猜，采纳面拒绝）
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // 坏 JSON：无锚证据（不猜）
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  const sessionId = rec['sessionId'];
  const hostPid = rec['hostPid'];
  const anchorServerPid = rec['serverPid'];
  const ts = rec['ts'];
  if (
    typeof sessionId !== 'string' || sessionId.trim() === '' ||
    typeof hostPid !== 'number' || !Number.isSafeInteger(hostPid) || hostPid <= 0 ||
    typeof anchorServerPid !== 'number' || !Number.isSafeInteger(anchorServerPid) || anchorServerPid <= 0 ||
    typeof ts !== 'number' || !Number.isFinite(ts)
  ) {
    return undefined; // 结构不符：无锚证据（不猜）
  }
  return { sessionId, hostPid, serverPid: anchorServerPid, ts };
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
