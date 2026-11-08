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
import { resolveStateRoot, workspaceFromEnv } from '../core/paths.js';
import { readNames, namesBoundToSession, readSession, refreshSessionLastSeen } from '../core/registry.js';
import { readUnreadMailbox } from '../core/mailbox.js';
import { withRegistryLock } from '../core/lock.js';
import { logEngineEvent, type EngineEvent } from '../core/log.js';
import { DEFAULT_TEAM_ID, type NameBindings, type TeamMessage } from '../core/types.js';

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
 */
export function resolveHookContext(event: string, stdin: HookStdin | undefined): HookContext {
  const env = process.env;
  const envWorkspace = env['ZCODE_PROJECT_DIR'] ?? env['CLAUDE_PROJECT_DIR'];
  const workspace = envWorkspace !== undefined && envWorkspace.trim() !== ''
    ? envWorkspace
    : stdin?.str('cwd', 'cwd') ?? workspaceFromEnv(env);
  const sessionId = env['CLAUDE_SESSION_ID']?.trim() || stdin?.str('session_id', 'sessionId');
  return { workspace, stateRoot: resolveStateRoot(workspace), sessionId, event };
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
 */
export async function refreshSessionRegistration(
  stateRoot: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  await withRegistryLock(
    stateRoot,
    () => refreshSessionLastSeen(stateRoot, sessionId, { cwd }),
    { waitMs: HOOK_LOCK_WAIT_MS },
  );
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
}

/**
 * Read-only unread summary for the UserPromptSubmit injection. Pure read —
 * freshness adjudication/discarding stays the property of the MCP tool that
 * actually returns the mail to the model (DESIGN.md §2.8 xc_check_inbox), so
 * the hook count can over-count stale mail but never destroys anything.
 * Malformed JSONL lines are skipped + audited by the M1 reader.
 */
export async function unreadSummary(stateRoot: string, name: string): Promise<UnreadSummary> {
  const messages = await readUnreadMailbox(stateRoot, DEFAULT_TEAM_ID, name);
  const senders: string[] = [];
  for (const message of [...messages].sort((a, b) => b.ts - a.ts)) {
    if (!senders.includes(message.from)) senders.push(message.from);
  }
  return { count: messages.length, senders, messages };
}
