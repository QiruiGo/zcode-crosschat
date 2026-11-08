/**
 * M4 hooks-and-face: Stop hook — v1 is a V3 probe only.
 *
 * DESIGN.md §8.2-F note + §9 V3: the Stop event MAY request continuation
 * (up to three times), but the exact continuation key names are unconfirmed
 * (bundle schema candidates: `continue`, `decision`, `hookSpecificOutput`
 * with `hookEventName:"Stop"`, `stopReason`). Until verified, this hook
 * outputs NOTHING on stdout (an empty output is valid) and exits 0 — zero
 * behavioral risk, no wrap-up function.
 *
 * What it does instead: one engine.jsonl probe line, so V3 verification and
 * the Phase 2 evidence trail can prove the hook fired without digging
 * through zcode logs (DESIGN.md §4.3 lists zcode logs for hook runs; the
 * disk probe is the M5-checkable equivalent).
 *
 * Build entry: dist/hooks/stop.mjs (scripts/build.mjs).
 */
import {
  auditHookFailure,
  logHookEvent,
  readStdinPayload,
  resolveHookContext,
} from './shared.js';

async function main(): Promise<void> {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('Stop', stdin);
  await logHookEvent(ctx.stateRoot, {
    event: 'hook-stop-probe',
    sessionId: ctx.sessionId ?? null,
    note: 'v1 probe: no continuation output until V3 key names are verified (DESIGN.md §9 V3)',
  });
  // No stdout at all: valid per the strict schema (empty output is fine) —
  // the exact contract the V3 probe is meant to keep.
}

main().catch(async (error: unknown) => {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('Stop', stdin);
  await auditHookFailure(ctx.stateRoot, 'stop', error);
});
