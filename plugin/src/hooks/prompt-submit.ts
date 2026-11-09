/**
 * M4 hooks-and-face: UserPromptSubmit hook — lastSeen refresh + inbox pull.
 *
 * v0.2 behavior（DESIGN.md §2.3-1、§7 M4）：刷新 registry/sessions/<sid>.json 的
 * lastSeen；有未读队内邮件时用 additionalContext 提示「有 N 条未读，先 xc_check_inbox」。
 *
 * v0.3 增量（DESIGN-V0.3.md §7.1 面 A、§6.2 档类新鲜度）：
 * - 跨会话 peer 消息的信封注入：排空机器全局 peers/queue/<sid>.jsonl，把每条渲染成
 *   <crosschat-peer-message> 信封块（含标签外的归因尾注）。
 * - 顺带刷新 peers/base/<sid>.json 的 permissionMode（载荷现成）。
 * - **一次调用一次输出**：队内提示与 peer 信封块合并成一段文本后 emit 一次。
 *
 * Build entry: dist/hooks/prompt-submit.mjs (scripts/build.mjs).
 */
import {
  auditHookFailure,
  boundNamesForSession,
  emitAdditionalContext,
  logHookEvent,
  peerRootFromEnv,
  readHookPermissionMode,
  readStdinPayload,
  refreshPeerBaseRecord,
  refreshSessionRegistration,
  resolveHookContext,
  unreadSummary,
} from './shared.js';
import { drainPeerQueue } from '../core/peermsg.js';
// 信封渲染的属主是 core/peerenvelope.ts（DESIGN-V0.3 §10.2）；W5 的 peermsg.ts
// 目前只转出了 renderPeerReceipt，故这里直接向属主模块取 renderPeerEnvelope。
import { renderPeerEnvelope } from '../core/peerenvelope.js';

async function main(): Promise<void> {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('UserPromptSubmit', stdin);

  if (ctx.sessionId !== undefined) {
    try {
      await refreshSessionRegistration(ctx.stateRoot, ctx.sessionId, ctx.workspace);
    } catch (error) {
      await auditHookFailure(ctx.stateRoot, 'prompt-submit-refresh', error);
    }
  }

  if (ctx.sessionId === undefined) return;

  const blocks: string[] = [];

  // --- v0.3：跨会话 peer 信封注入（面 A：保证路径）---
  try {
    const root = peerRootFromEnv(process.env);
    // 档类刷新：会话中途改权限模式时，自动档判定不吃陈旧快照。
    const mode = readHookPermissionMode(stdin);
    if (mode !== undefined) {
      await refreshPeerBaseRecord(root, ctx.sessionId, { permissionMode: mode, lastSeen: Date.now() });
    }
    const items = await drainPeerQueue(root, ctx.sessionId, 20);
    if (items.length > 0) {
      blocks.push(items.map((item) => renderPeerEnvelope(item)).join('\n\n'));
      await logHookEvent(ctx.stateRoot, {
        event: 'hook-peer-inbound',
        sessionId: ctx.sessionId,
        count: items.length,
        from: items.map((i) => i.from),
      });
    }
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'prompt-submit-peer-inbound', error);
  }

  // --- v0.2：队内未读提示（原样保留）---
  let names: string[] = [];
  try {
    names = await boundNamesForSession(ctx.stateRoot, ctx.sessionId);
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'prompt-submit-names', error);
    names = [];
  }
  if (names.length > 0) {
    try {
      const summary = await unreadSummary(ctx.stateRoot, names[0]!);
      if (summary.count > 0) {
        const senders = summary.senders.length > 0 ? `，来自 ${summary.senders.join('、')}` : '';
        blocks.push(
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

  // 一次 emit、一次输出（stdout 严格单键单行，hooks/shared.ts 契约）。
  if (blocks.length > 0) emitAdditionalContext(blocks.join('\n\n'));
}

main().catch(async (error: unknown) => {
  // Final guard: a hook must never exit non-zero (would mark the run failed).
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('UserPromptSubmit', stdin);
  await auditHookFailure(ctx.stateRoot, 'prompt-submit', error);
});
