/**
 * M4 hooks-and-face: Stop hook — v0.1.0 V3 probe + v0.2 turn-end snapshot refresh
 * (DESIGN-V0.2.md §7.3.1 机制 2, W4 scope).
 *
 * v0.1.0 behavior kept verbatim: NO stdout at all (an empty output is valid per
 * the strict hook schema — the exact contract the V3 probe keeps) and always
 * exit 0. One engine.jsonl probe line (`hook-stop-probe`) stays so V3
 * verification and the evidence trail can prove the hook fired.
 *
 * v0.2 addition (turn-granularity snapshot refresh, "等效定时刷新"): when the
 * session ending its turn is in the roster — including the lead, which is a
 * roster member too; the check is "readNames hits this sid" via
 * boundNamesForSession (shared.ts) — refresh snapshot.json through W3's
 * refreshSnapshot. Best-effort: any failure goes through auditHookFailure and
 * the hook still exits 0 (hooks are pull-path enhancements, never gates —
 * hooks/shared.ts discipline). Every session's turn end fires Stop, so the
 * snapshot gets refreshed at least once per turn without any timer (D0: no
 * daemon process).
 *
 * Build entry: dist/hooks/stop.mjs (scripts/build.mjs).
 */
import { refreshSnapshot } from '../core/snapshot.js';
import {
  auditHookFailure,
  boundNamesForSession,
  logHookEvent,
  readStdinPayload,
  resolveHookContext,
} from './shared.js';

/**
 * One Stop-hook run: probe line + conditional snapshot refresh.
 * Exported for tests; the process entry below wraps it with the failure path.
 * Throws are intentional — the guarded wrapper turns them into audits.
 */
export async function runStopHook(): Promise<void> {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('Stop', stdin);
  await logHookEvent(ctx.stateRoot, {
    event: 'hook-stop-probe',
    sessionId: ctx.sessionId ?? null,
    note: 'v1 probe: no continuation output until V3 key names are verified (DESIGN.md §9 V3)',
  });
  if (ctx.sessionId === undefined) return; // unregistered/unanchored session: nothing to refresh for
  const names = await boundNamesForSession(ctx.stateRoot, ctx.sessionId);
  if (names.length === 0) return; // not in the roster (neither member nor lead): skip silently
  // W3 refreshSnapshot(stateRoot, teamId?) — teamId omitted = default team.
  // A throw here propagates to the guarded wrapper -> audit + exit 0.
  await refreshSnapshot(ctx.stateRoot);
}

/**
 * Guarded process entry: same failure contract as v0.1.0 — audit (engine.jsonl
 * when the state root is known, stderr preview otherwise) and swallow; the
 * process then exits 0 naturally. No stdout is ever written.
 */
export async function runStopHookGuarded(): Promise<void> {
  try {
    await runStopHook();
  } catch (error: unknown) {
    const stdin = readStdinPayload();
    const ctx = resolveHookContext('Stop', stdin);
    await auditHookFailure(ctx.stateRoot, 'stop', error);
  }
}

void runStopHookGuarded();
