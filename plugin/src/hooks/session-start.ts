/**
 * M4 hooks-and-face: SessionStart hook — identity anchoring + v0.3 peer 基记录。
 *
 * v0.2 behavior（DESIGN.md §2.3-1、§7 M4）：写/刷新 registry/sessions/<sessionId>.json，
 * 再用严格单键 additionalContext 注入会话身份。
 *
 * v0.3 增量（DESIGN-V0.3.md §3.1、§10.1）：
 * 1. 额外写**机器全局**的 peer 基记录 peers/base/<sessionId>.json：
 *    { sessionId, cwd, permissionMode, source, startedAt, lastSeen }。
 *    permissionMode 来自钩子 stdin 载荷的 permission_mode/mode（实测载荷含
 *    "permission_mode":"yolo" / "mode":"yolo"，FEASIBILITY-V0.3 §1.2）；
 *    它是 mode-parity 自动档的档类真源（收方档类 + 发方档类都出自这里）。
 * 2. 注入文案追加一行 peer 注册指引（xc_peer_register）。
 *
 * 降级规则不变：无 sessionId → 不锚定（静默 exit 0）；任何异常 → engine.jsonl 审计 → exit 0。
 *
 * Build entry: dist/hooks/session-start.mjs (scripts/build.mjs).
 */
import {
  auditHookFailure,
  boundNamesForSession,
  emitAdditionalContext,
  logHookEvent,
  peerRootFromEnv,
  readHookPermissionMode,
  readStdinPayload,
  refreshSessionRegistration,
  resolveHookContext,
  writePeerBaseRecord,
} from './shared.js';

async function main(): Promise<void> {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('SessionStart', stdin);

  if (ctx.sessionId === undefined) return;

  try {
    await refreshSessionRegistration(ctx.stateRoot, ctx.sessionId, ctx.workspace);
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'session-start-refresh', error);
  }

  // v0.3：机器全局 peer 基记录（跨会话域的档类真源 + 兜底身份来源）。
  try {
    await writePeerBaseRecord(peerRootFromEnv(process.env), {
      sessionId: ctx.sessionId,
      cwd: ctx.workspace,
      permissionMode: readHookPermissionMode(stdin),
      source: stdin?.str('source', 'source') ?? null,
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'session-start-peer-base', error);
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
    `[zcode-crosschat] 跨会话消息轴（peer）：如需与本机其他会话直接对话，调用 xc_peer_register（name=<短小写英文名>，sessionId=${ctx.sessionId}）；之后用 xc_peers 找地址、xc_peer_send 发信。`,
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
