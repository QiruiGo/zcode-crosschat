/**
 * M4 hooks-and-face: UserPromptSubmit hook — lastSeen refresh + inbox pull.
 *
 * Behavior (DESIGN.md §2.3-1, §7 M4):
 * 1. Refresh `registry/sessions/<sessionId>.json` lastSeen on EVERY user
 *    prompt — a session open for hours must not be failed by freshness
 *    checks right when the user finally says "继续".
 * 2. When the session has a bound name and unread mail, inject a
 *    "you have N unread" hint via strict-schema `additionalContext`, driving
 *    the model to xc_check_inbox (the pull path of the channel, §2.1).
 *
 * Read-only over the mailbox: no messages are marked read here — ack stays
 * the instant the tool returns them to the model (§2.8 xc_check_inbox).
 * Silent exit 0 when there is nothing to say; never blocks, never errors.
 *
 * Build entry: dist/hooks/prompt-submit.mjs (scripts/build.mjs).
 */
import {
  auditHookFailure,
  boundNamesForSession,
  emitAdditionalContext,
  logHookEvent,
  readStdinPayload,
  refreshSessionRegistration,
  resolveHookContext,
  unreadSummary,
} from './shared.js';

async function main(): Promise<void> {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('UserPromptSubmit', stdin);

  // lastSeen refresh is the primary duty; it needs the session id.
  if (ctx.sessionId !== undefined) {
    try {
      await refreshSessionRegistration(ctx.stateRoot, ctx.sessionId, ctx.workspace);
    } catch (error) {
      await auditHookFailure(ctx.stateRoot, 'prompt-submit-refresh', error);
    }
  }

  // No session id -> no binding lookup possible; stay silent.
  if (ctx.sessionId === undefined) return;

  let names: string[] = [];
  try {
    names = await boundNamesForSession(ctx.stateRoot, ctx.sessionId);
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'prompt-submit-names', error);
    return;
  }
  if (names.length === 0) return; // not registered: SessionStart already onboarded; stay silent

  try {
    const summary = await unreadSummary(ctx.stateRoot, names[0]!);
    if (summary.count > 0) {
      const senders = summary.senders.length > 0 ? `，来自 ${summary.senders.join('、')}` : '';
      emitAdditionalContext(
        `[zcode-crosschat] 你（${names[0]}）有 ${summary.count} 条未读协作消息${senders}。`
        + '先调用 xc_check_inbox 查看并处理，再继续当前工作；任务回执先核对证据再向用户汇报。',
      );
      await logHookEvent(ctx.stateRoot, {
        event: 'hook-prompt-submit-unread',
        sessionId: ctx.sessionId,
        name: names[0],
        unread: summary.count,
        senders: summary.senders,
      });
    }
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'prompt-submit-inbox', error);
  }
}

main().catch(async (error: unknown) => {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('UserPromptSubmit', stdin);
  await auditHookFailure(ctx.stateRoot, 'prompt-submit', error);
});
