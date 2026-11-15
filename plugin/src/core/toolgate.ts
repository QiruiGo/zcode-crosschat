/**
 * v0.7 C6/C7（DESIGN-V0.7 §2.7/§3，M2）：审批门（approval gate）——插件侧确定性
 * 校验 + 两个读取面共用的渲染门。
 *
 * 为什么门在读取面（E4 §7.1 实测「传得到、收不到」+ R2）：审批门下沉到插件侧后，
 * 挂在**两个读取面共用的帧渲染函数**上——inbox 消费（xc_read scope:"inbox"）与
 * mail 历史分页（xc_read scope:"mail"）都先过本模块的 {@link gateToolRequestRender}：
 * - 未放行的 tool_request 在两侧都被转成遮蔽占位，**原始帧全文不进模型注入面**
 *   （mail 路的原文旁路由此修掉：v0.6.1 的 xc_mail_read 直接 paginateText 原始
 *   content，无门）；
 * - tool_request 帧一律不唤醒投递（发送侧强制，tools-relay.ts）——wake prompt 的
 *   正文由调用方 ticket 原样携带（engine/wake.ts bodyText=req.ticket），任何
 *   delivered="wake" 的 relay 都把全文带进 prompt，只禁 urgent 挡不住（§2.2）；
 * - 台账缺失/不可读 → fail-closed 遮蔽（安全方向；审批原子写，丢失概率极低，
 *   遮蔽代价仅是「重新批准」）。
 *
 * 门只对 `type:"tool_request"` 帧生效；其他帧/chat 早返回原路径（零影响）。
 *
 * 侧效应纪律（§2.7）：首次门拒（状态迁移发生）才回投请求方 + 通知 lead + 审计；
 * 已处于拒绝态的复读只出遮蔽占位（mail 路可重复触发门，防回投风暴）。
 *
 * @module core/toolgate
 */
import { appendMailbox, createMessage } from './mailbox.js';
import { logEngineEvent } from './log.js';
import { leadKeyOf, readTeam } from './teamstate.js';
import {
  readToolRequest,
  updateToolRequest,
  type ToolRequestLedger,
  type ToolRequestState,
} from './toolledger.js';
import {
  checkApproval,
  readApprovalFile,
} from './toolapproval.js';
import {
  buildApprovalRequest,
  buildRefusedToolResult,
  parseToolFrameType,
  type ToolRequestFrame,
} from './toolrelay.js';
import { approvalsFile } from './paths.js';
import type { TeamMessage } from './types.js';

export interface ToolGateContext {
  stateRoot: string;
  teamId: string;
  /** 读取者成员键（执行方候选；必须 === 台账.to）。 */
  readerKey: string;
  now: number;
}

export type ToolGateOutcome = 'pass' | 'refuse';

export interface ToolGateRenderResult {
  gate: ToolGateOutcome;
  requestId?: string;
  /** 裁决时的台账状态；台账缺失/帧畸形时为 'unknown'（fail-closed）。 */
  state?: ToolRequestState | 'unknown';
  reason?: string;
  /** 两个读取面共用的最终渲染文本：遮蔽占位，或「APPROVAL VERIFIED」头 + 全文。 */
  text: string;
  /** 本次门是否发生了台账状态迁移（首次拒/首次放行记账）。 */
  transitioned: boolean;
}

// ---------------------------------------------------------------------------
// 渲染文本（单一事实源；mcp 面不重复实现）
// ---------------------------------------------------------------------------

/** 遮蔽占位（§2.7）：带 requestId/state/reason，请求方可自勘，不出正文。 */
export function maskedToolRequestText(requestId: string | undefined, state: ToolRequestState | 'unknown', reason: string): string {
  const id = requestId ?? '(unparseable)';
  return `[gated tool_request ${id}: state=${state} —— 未放行，正文不可见（${reason}）]`;
}

/** 放行头（§2.7）：APPROVAL VERIFIED + 台账事实，随后接请求全文。 */
export function approvedToolRequestText(requestId: string, tool: string, approvedBy: string | undefined, content: string): string {
  const by = approvedBy ?? '(file-track approval)';
  return [
    `[CrossChat APPROVAL VERIFIED requestId=${requestId} tool=${tool} approvedBy=${by} —— 以下为已放行的转办请求全文]`,
    content,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 帧形状的最小读取（门只需要 requestId/from/tool；完整校验在发送侧）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequestShape(content: string): ToolRequestFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value['type'] !== 'tool_request') return undefined;
  if (typeof value['requestId'] !== 'string' || typeof value['from'] !== 'string' || typeof value['tool'] !== 'string') {
    return undefined;
  }
  return value as unknown as ToolRequestFrame;
}

// ---------------------------------------------------------------------------
// 侧效应（首次拒 / lead 待批通知）
// ---------------------------------------------------------------------------

/** 回投请求方一帧 tool_result{refused,reason}（§2.6/§2.7；from=执行方）。 */
async function replyRefusal(
  ctx: ToolGateContext,
  ledger: ToolRequestLedger,
  reason: string,
): Promise<string> {
  const frame = buildRefusedToolResult(ledger.requestId, ledger.tool, ledger.to, reason, ctx.now);
  const msg = createMessage(ledger.to, ledger.from, JSON.stringify(frame), { deliveryClaimedAt: ctx.now });
  await appendMailbox(ctx.stateRoot, ctx.teamId, ledger.from, msg);
  return msg.id;
}

/** 无审批时向 lead 发待批通知（§3.1；只通知不带授权语义；一次性，approvalNotifiedAt 记档）。 */
async function notifyLeadApprovalRequest(
  ctx: ToolGateContext,
  ledger: ToolRequestLedger,
): Promise<string | undefined> {
  const team = await readTeam(ctx.stateRoot, ctx.teamId);
  const leadKey = team !== undefined ? leadKeyOf(team) : null;
  if (leadKey === null || leadKey === '') return undefined;
  const approveHow =
    `write the approval file ${approvalsFile(ctx.stateRoot, ledger.requestId)} `
    + `({requestId, decision:"approved", approvedBy, decidedAt, expiresAt, tool}) `
    + `or call xc_review({action:"approve", axis:"approval", id:"${ledger.requestId}"})`;
  const frame = buildApprovalRequest(ledger.requestId, ledger.from, ledger.tool, ledger.reason, ledger.expiresAt, approveHow);
  const msg = createMessage('engine', leadKey, JSON.stringify(frame), { deliveryClaimedAt: ctx.now });
  await appendMailbox(ctx.stateRoot, ctx.teamId, leadKey, msg);
  await logEngineEvent(ctx.stateRoot, {
    event: 'tool-approval-request',
    teamId: ctx.teamId,
    requestId: ledger.requestId,
    to: leadKey,
    messageId: msg.id,
  });
  return msg.id;
}

// ---------------------------------------------------------------------------
// 共享渲染门（inbox/mail 双路共用；纯帧类型早返回）
// ---------------------------------------------------------------------------

/**
 * 对一条邮箱消息跑审批门并给出渲染文本。
 *
 * - 非 tool_request 帧（chat/其他协议帧）→ 原样透传（gate:"pass", text=content）；
 * - tool_request → 按台账 state 裁决（§2.7 七步：台账缺失 → 目标不符 → 请求方
 *   不符 → 请求过期 → denied/refused/expired → 已终态放行 → 审批文件校验）；
 * - 首次拒绝发生状态迁移时回投请求方 +（无审批时）通知 lead + 审计 tool-decision；
 * - 放行：pending 且有有效审批文件 → 台账记 approved（门放行≥1 次，§2.5）。
 */
export async function gateToolRequestRender(message: TeamMessage, ctx: ToolGateContext): Promise<ToolGateRenderResult> {
  if (parseToolFrameType(message.content) !== 'tool_request') {
    return { gate: 'pass', text: message.content, transitioned: false };
  }
  const frame = readRequestShape(message.content);
  if (frame === undefined) {
    const reason = 'request frame malformed (unparseable JSON)';
    await logEngineEvent(ctx.stateRoot, {
      event: 'tool-decision',
      teamId: ctx.teamId,
      decision: 'refused',
      reason,
      recipient: ctx.readerKey,
      messageId: message.id,
    });
    return { gate: 'refuse', state: 'unknown', reason, text: maskedToolRequestText(undefined, 'unknown', reason), transitioned: false };
  }

  const ledger = await readToolRequest(ctx.stateRoot, frame.requestId);
  if (ledger === undefined) {
    // fail-closed：台账缺失（从未建立/被清/损坏）——遮蔽 + 回投信封 from + 审计。
    const reason = 'request ledger missing';
    const receiptFrame = buildRefusedToolResult(frame.requestId, frame.tool, message.to, reason, ctx.now);
    const receipt = createMessage(message.to, message.from, JSON.stringify(receiptFrame), { deliveryClaimedAt: ctx.now });
    await appendMailbox(ctx.stateRoot, ctx.teamId, message.from, receipt);
    await logEngineEvent(ctx.stateRoot, {
      event: 'tool-decision',
      teamId: ctx.teamId,
      requestId: frame.requestId,
      decision: 'refused',
      reason,
      from: message.from,
      to: message.to,
      tool: frame.tool,
      receiptMessageId: receipt.id,
    });
    return {
      gate: 'refuse',
      requestId: frame.requestId,
      state: 'unknown',
      reason,
      text: maskedToolRequestText(frame.requestId, 'unknown', reason),
      transitioned: false,
    };
  }

  // ① 执行方身份：读取者必须就是台账指定的执行方（防错投/越权读取）。
  if (ledger.to !== ctx.readerKey) {
    const reason = 'ledger target mismatch';
    await logEngineEvent(ctx.stateRoot, {
      event: 'tool-decision',
      teamId: ctx.teamId,
      requestId: ledger.requestId,
      decision: 'refused',
      reason,
      from: ledger.from,
      to: ledger.to,
      reader: ctx.readerKey,
      tool: ledger.tool,
    });
    return { gate: 'refuse', requestId: ledger.requestId, state: ledger.state, reason, text: maskedToolRequestText(ledger.requestId, ledger.state, reason), transitioned: false };
  }

  // ② 请求方身份：帧 from 必须与台账 from 一致（防篡改）。
  if (frame.from !== ledger.from) {
    const reason = 'request from mismatch';
    await logEngineEvent(ctx.stateRoot, {
      event: 'tool-decision',
      teamId: ctx.teamId,
      requestId: ledger.requestId,
      decision: 'refused',
      reason,
      from: ledger.from,
      frameFrom: frame.from,
      to: ledger.to,
      tool: ledger.tool,
    });
    return { gate: 'refuse', requestId: ledger.requestId, state: ledger.state, reason, text: maskedToolRequestText(ledger.requestId, ledger.state, reason), transitioned: false };
  }

  // ③ 请求过期（ttl 超期；sweeper 亦会标 expired——同一迁移，幂等）。
  if (ctx.now > ledger.expiresAt) {
    const reason = 'request expired';
    let transitioned = false;
    if (ledger.state === 'pending' || ledger.state === 'approved') {
      const next = await updateToolRequest(ctx.stateRoot, ledger.requestId, (l) =>
        l.state === 'pending' || l.state === 'approved'
          ? { ...l, state: 'expired', decidedAt: ctx.now, decidedBy: 'engine', decisionReason: reason }
          : undefined,
      );
      transitioned = next?.state === 'expired';
      if (transitioned) {
        const receiptId = await replyRefusal(ctx, next!, reason);
        await logEngineEvent(ctx.stateRoot, {
          event: 'tool-decision',
          teamId: ctx.teamId,
          requestId: ledger.requestId,
          decision: 'refused',
          reason,
          from: ledger.from,
          to: ledger.to,
          tool: ledger.tool,
          receiptMessageId: receiptId,
        });
      }
    }
    const state: ToolRequestState = transitioned ? 'expired' : ledger.state;
    return { gate: 'refuse', requestId: ledger.requestId, state, reason, text: maskedToolRequestText(ledger.requestId, state, reason), transitioned };
  }

  // ④ 显式拒绝 / 既往门拒 / 已过期：渲染-only（B 已在动作当时收到通知）。
  if (ledger.state === 'denied' || ledger.state === 'refused' || ledger.state === 'expired') {
    const reason: string = ledger.state === 'denied'
      ? 'approval denied'
      : ledger.state === 'expired'
        ? 'request expired'
        : ledger.decisionReason ?? 'approval refused';
    await logEngineEvent(ctx.stateRoot, {
      event: 'tool-decision',
      teamId: ctx.teamId,
      requestId: ledger.requestId,
      decision: 'refused',
      reason,
      from: ledger.from,
      to: ledger.to,
      tool: ledger.tool,
    });
    return { gate: 'refuse', requestId: ledger.requestId, state: ledger.state, reason, text: maskedToolRequestText(ledger.requestId, ledger.state, reason), transitioned: false };
  }

  // ⑤ 已终态（executed/error）：回投已发生，请求帧保持可见（带头全文）。
  if (ledger.state === 'executed' || ledger.state === 'error') {
    return {
      gate: 'pass',
      requestId: ledger.requestId,
      state: ledger.state,
      text: approvedToolRequestText(ledger.requestId, ledger.tool, ledger.decidedBy, message.content),
      transitioned: false,
    };
  }

  // ⑥⑦ 审批文件校验（state ∈ pending/approved；授权只认文件，§2.3）。
  const read = await readApprovalFile(ctx.stateRoot, ledger.requestId, ledger.approvalFile);
  const verdict = checkApproval(
    read,
    { requestId: ledger.requestId, tool: ledger.tool, from: ledger.from, to: ledger.to, expiresAt: ledger.expiresAt },
    ctx.now,
  );
  if (verdict.ok) {
    // 放行：pending → approved（门放行≥1 次，§2.5）；approved 保持。
    let transitioned = false;
    if (ledger.state === 'pending') {
      const decidedBy = read.status === 'ok' ? read.approval.approvedBy : undefined;
      const decidedAt = read.status === 'ok' ? read.approval.decidedAt : undefined;
      const next = await updateToolRequest(ctx.stateRoot, ledger.requestId, (l) =>
        l.state === 'pending'
          ? {
              ...l,
              state: 'approved',
              decidedAt: decidedAt ?? ctx.now,
              decidedBy: decidedBy ?? '(file-track approval)',
            }
          : undefined,
      );
      transitioned = next?.state === 'approved';
    }
    await logEngineEvent(ctx.stateRoot, {
      event: 'tool-decision',
      teamId: ctx.teamId,
      requestId: ledger.requestId,
      decision: 'approved',
      from: ledger.from,
      to: ledger.to,
      tool: ledger.tool,
      ...(transitioned ? { firstPass: true } : {}),
    });
    const approvedBy = ledger.decidedBy ?? (read.status === 'ok' ? read.approval.approvedBy : undefined);
    return {
      gate: 'pass',
      requestId: ledger.requestId,
      state: 'approved',
      text: approvedToolRequestText(ledger.requestId, ledger.tool, approvedBy, message.content),
      transitioned,
    };
  }

  // 拒绝：仅 pending → refused 的首次迁移带侧效应（回投 + lead 待批通知 + 审计）。
  const reason = verdict.reason;
  if (ledger.state === 'pending') {
    const notifyLead = reason === 'approval missing' && ledger.approvalNotifiedAt === undefined;
    const next = await updateToolRequest(ctx.stateRoot, ledger.requestId, (l) =>
      l.state === 'pending'
        ? {
            ...l,
            state: 'refused',
            decidedAt: ctx.now,
            decidedBy: 'gate',
            decisionReason: reason,
          }
        : undefined,
    );
    if (next !== undefined && next.state === 'refused') {
      const receiptId = await replyRefusal(ctx, next, reason);
      let notified: string | undefined;
      if (notifyLead) {
        notified = await notifyLeadApprovalRequest(ctx, next);
        if (notified !== undefined) {
          await updateToolRequest(ctx.stateRoot, ledger.requestId, (l) =>
            l.state === 'refused' ? { ...l, approvalNotifiedAt: ctx.now } : undefined,
          );
        }
      }
      await logEngineEvent(ctx.stateRoot, {
        event: 'tool-decision',
        teamId: ctx.teamId,
        requestId: ledger.requestId,
        decision: 'refused',
        reason,
        from: ledger.from,
        to: ledger.to,
        tool: ledger.tool,
        receiptMessageId: receiptId,
        ...(notified !== undefined ? { leadNotified: true } : {}),
      });
      return { gate: 'refuse', requestId: ledger.requestId, state: 'refused', reason, text: maskedToolRequestText(ledger.requestId, 'refused', reason), transitioned: true };
    }
  }

  // 渲染-only 拒绝（approved 后审批失效/复读）：只审计不出新回执。
  await logEngineEvent(ctx.stateRoot, {
    event: 'tool-decision',
    teamId: ctx.teamId,
    requestId: ledger.requestId,
    decision: 'refused',
    reason,
    from: ledger.from,
    to: ledger.to,
    tool: ledger.tool,
  });
  return {
    gate: 'refuse',
    requestId: ledger.requestId,
    state: ledger.state,
    reason,
    text: maskedToolRequestText(ledger.requestId, ledger.state, reason),
    transitioned: false,
  };
}
