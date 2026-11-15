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
 * 2. 注入文案追加一行 peer 注册指引（xc_identify）。
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
  readPeerBaseRecord,
  readStdinPayload,
  refreshSessionRegistration,
  resolveHookContext,
  writePeerBaseRecord,
} from './shared.js';

async function main(): Promise<void> {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('SessionStart', stdin);

  if (ctx.sessionId === undefined) return;

  // v0.5.3（安全对-1/a6 修复）：SessionStart 铸造/延续锚定令牌 regToken——
  // (name, sessionId) 对可经 xc_overview 公开读到，不构成凭据；重绑队内身份或
  // 认领已绑定队内身份的 sid（xc_identify）时必须出示本令牌。令牌只进
  // 本会话上下文（additionalContext）与两份锚定记录，不出现在任何工具输出里。
  let regToken: string | undefined;
  try {
    const upserted = await refreshSessionRegistration(ctx.stateRoot, ctx.sessionId, ctx.workspace, {
      ensureRegToken: true,
    });
    regToken = upserted?.regToken;
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'session-start-refresh', error);
  }

  // v0.3：机器全局 peer 基记录（跨会话域的档类真源 + 兜底身份来源）。
  // v0.5.3（a6/a8）：同步锚定令牌（与 workspace 侧 sessions/<sid>.json 同值），
  // 并保留既有 boundName（xc_identify 盖的队内绑定标记）——基记录每次
  // SessionStart 全量重写，不保留就会把绑定标记抹掉。
  try {
    const peerRoot = peerRootFromEnv(process.env);
    const existing = await readPeerBaseRecord(peerRoot, ctx.sessionId);
    // 令牌取值：本回合 workspace 侧铸造/延续的 regToken 优先；锁忙没拿到时回退
    // 基记录既有值（跨记录两处必须同值）。
    const baseToken = regToken ?? existing?.regToken;
    await writePeerBaseRecord(peerRoot, {
      sessionId: ctx.sessionId,
      cwd: ctx.workspace,
      permissionMode: readHookPermissionMode(stdin),
      source: stdin?.str('source', 'source') ?? null,
      startedAt: Date.now(),
      lastSeen: Date.now(),
      ...(baseToken !== undefined ? { regToken: baseToken } : {}),
      ...(existing?.boundName !== undefined ? { boundName: existing.boundName } : {}),
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
    : '尚未注册跨会话花名：用 /xc-work <名字> 注册（或调用 xc_identify，name=花名，sessionId=上方值）。';
  const lines = [
    `[zcode-crosschat] 本会话 sessionId：${ctx.sessionId}（已登记进协作注册表）。`,
    registered,
    '注册后可用：xc_dispatch 派发任务、xc_read({scope:"inbox"}) 查收、xc_claim/xc_report 认领与回报、xc_overview 看任务板。工作区协作状态根：' + ctx.stateRoot + '。',
    `[zcode-crosschat] 跨会话消息轴（peer）：如需与本机其他会话直接对话，调用 xc_identify（name=<短小写英文名>，sessionId=${ctx.sessionId}）；之后用 xc_overview({view:"peers"}) 找地址、xc_relay 发信。`,
  ];
  // v0.5.3（a6/a8）：把锚定令牌注入本会话上下文——这是攻击者拿不到的唯一凭据面
  //（注册表文件里的令牌需要文件读权限，超出「纯 MCP API」威胁模型，README 限制 5/12）。
  if (regToken !== undefined) {
    lines.push(
      `[zcode-crosschat] 本会话锚定令牌 regToken=${regToken}：xc_identify 重绑身份（队内轴与 peer 轴同一入口）时须原样携带；它只属于本会话，不外传。`,
    );
  }
  emitAdditionalContext(lines.join('\n'));
  await logHookEvent(ctx.stateRoot, { event: 'hook-session-start', sessionId: ctx.sessionId, names });
}

main().catch(async (error: unknown) => {
  // Final guard: a hook must never exit non-zero (would mark the run failed).
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('SessionStart', stdin);
  await auditHookFailure(ctx.stateRoot, 'session-start', error);
});
