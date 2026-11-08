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
import { wakeDir, wakeFile, namesFile, sessionsDir, sessionFile } from './paths.js';
import {
  coerceNameBindings,
  coerceSessionRecord,
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
 */
export async function refreshSessionLastSeen(
  stateRoot: string,
  sessionId: string,
  options: { cwd?: string; now?: number } = {},
): Promise<SessionRecord> {
  const now = options.now ?? Date.now();
  const existing = await readSession(stateRoot, sessionId);
  const record: SessionRecord = existing === undefined
    ? { sessionId, cwd: options.cwd ?? '', startedAt: now, lastSeen: now }
    : { ...existing, lastSeen: now, ...(options.cwd !== undefined && existing.cwd === '' ? { cwd: options.cwd } : {}) };
  await writeSession(stateRoot, record);
  return record;
}

// ---------------------------------------------------------------------------
// names.json
// ---------------------------------------------------------------------------

/** Read the whole name-binding map; ENOENT -> {}. Corrupt data throws. */
export async function readNames(stateRoot: string): Promise<NameBindings> {
  let raw: string;
  try {
    raw = await readFile(namesFile(stateRoot), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = coerceNameBindings(JSON.parse(raw));
  if (!parsed.ok) throw new Error(`invalid names.json: ${parsed.defect}`);
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
 */
export function newWakeNonce(input: { teamId: string; agentKey: string; sid: string; now?: number }): { token: string; nonce: WakeNonce } {
  const token = randomUUID();
  return { token, nonce: { teamId: input.teamId, agentKey: input.agentKey, sid: input.sid, ts: input.now ?? Date.now() } };
}

/** Persist one wake nonce under its token (atomic; also the in-flight marker). */
export async function writeWakeNonce(stateRoot: string, token: string, nonce: WakeNonce): Promise<void> {
  await mkdir(wakeDir(stateRoot), { recursive: true });
  await writeFileAtomic(wakeFile(stateRoot, token), JSON.stringify(nonce, null, 2));
}

/**
 * Generate + persist a wake nonce in one step.
 * @returns the token (carry it into the wake prompt) and the stored nonce.
 */
export async function createWakeNonce(
  stateRoot: string,
  input: { teamId: string; agentKey: string; sid: string; now?: number },
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
