/**
 * M4 hooks-and-face: SessionStart hook — identity anchoring.
 *
 * Behavior (DESIGN.md §2.3-1, §7 M4): write/refresh
 * `registry/sessions/<sessionId>.json`, then inject the session's identity
 * into the conversation via strict-schema `additionalContext`, so the model
 * knows its own sessionId (the input xc_register needs; /xc-work reads it
 * from here too).
 *
 * matcher is omitted in hooks.json -> fires for startup/resume/clear/compact;
 * every firing refreshes lastSeen (a resumed or compacted session stays
 * "fresh" for xc_register's age checks, §2.3-3).
 *
 * Degrade rules: no sessionId anywhere -> no anchoring possible (the
 * wakeToken path covers headless turns, §2.3-4) -> silent exit 0. Any error
 * -> engine.jsonl audit line -> silent exit 0. Never blocks the session.
 *
 * Build entry: dist/hooks/session-start.mjs (scripts/build.mjs).
 */
import {
  auditHookFailure,
  boundNamesForSession,
  emitAdditionalContext,
  logHookEvent,
  readStdinPayload,
  refreshSessionRegistration,
  resolveHookContext,
} from './shared.js';

async function main(): Promise<void> {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('SessionStart', stdin);

  // No session id -> nothing to anchor; the wakeToken register path covers
  // headless turns (DESIGN.md §2.3-4). Silent pass keeps the hook invisible.
  if (ctx.sessionId === undefined) return;

  try {
    await refreshSessionRegistration(ctx.stateRoot, ctx.sessionId, ctx.workspace);
  } catch (error) {
    // Busy lock / refresh failure must not suppress the identity injection.
    await auditHookFailure(ctx.stateRoot, 'session-start-refresh', error);
  }

  let names: string[] = [];
  try {
    names = await boundNamesForSession(ctx.stateRoot, ctx.sessionId);
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'session-start-names', error);
  }

  const registered = names.length > 0
    ? `已注册花名：${names.join('、')}。`
    : '尚未注册跨会话花名：用 /xc-work <名字> 注册（或调用 xc_register，name=花名，sessionId=上方值）。';
  const lines = [
    `[zcode-crosschat] 本会话 sessionId：${ctx.sessionId}（已登记进协作注册表）。`,
    registered,
    '注册后可用：xc_dispatch 派发任务、xc_check_inbox 查收、xc_claim/xc_report 认领与回报、xc_status 看任务板。工作区协作状态根：' + ctx.stateRoot + '。',
  ];
  emitAdditionalContext(lines.join('\n'));
  await logHookEvent(ctx.stateRoot, { event: 'hook-session-start', sessionId: ctx.sessionId, names });
}

main().catch(async (error: unknown) => {
  // Final guard: a hook must never exit non-zero (would mark the run failed).
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('SessionStart', stdin);
  await auditHookFailure(ctx.stateRoot, 'session-start', error);
});
