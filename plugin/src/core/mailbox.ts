/**
 * M1 core-store: per-agent JSONL mailboxes + message freshness adjudication.
 *
 * Ports from dsh-agent-teams-0.1.29/lib/mailbox.js (file line numbers cited
 * in each function; all read this session):
 * - isCurrentMail: mailbox.js:6-17, 1:1 (attemptId is the message's
 *   capability token; after a reassignment old mail self-invalidates)
 * - readCurrentMailboxLocked: mailbox.js:29-40, 1:1 (tolerant read with
 *   onMalformed, stale mail discarded on disk)
 * - mailboxContent/mailboxBody/mailboxPrompt: mailbox.js:19-27/49-51 (the
 *   machine-parseable receipt prefix, re-branded per DESIGN.md §2.4)
 * - ack/discard/claim/release/append: state.js:371-519, JSONL append instead
 *   of whole-file rewrite (DESIGN.md §2.7-5)
 *
 * v0.2 (DESIGN-V0.2.md §7.4-I3, hardening G6): frame-type whitelist at READ
 * time, the 1:1 port of CC's "team_permission_update frames are dropped —
 * permission rules are never accepted from messages". Content that parses to
 * a JSON object carrying a `type` field is a NAMED frame; named frames outside
 * FRAME_TYPES are dropped from every read view and audited
 * `{event:"frame-rejected", frameType}`. Free text (and JSON without a type
 * field) stays a chat message — backward compatible with v0.1.0. The
 * whitelist lives here (the read side needs it); mcp/guards.ts re-exports it
 * per the §9.2 module contract. Enforced as data-plane structure, not
 * prompt discipline: no message can ever carry grant/permission semantics.
 *
 * Lock contract: the `*Locked` functions require the caller to hold the team
 * lock (in-process + cross-process, e.g. via lock.ts withTeamLock); the
 * non-Locked convenience wrappers take the locks themselves.
 *
 * @module core/mailbox
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendJsonl, readJsonl, rewriteJsonl, type MalformedLine } from './jsonl.js';
import { writeFileAtomic, stripLeadingBom } from './atomic.js';
import { sanitizeKey } from './sanitize.js';
import { isRecord, isTeamMessage, normalizeMessage, TERMINAL_TASK_STATUSES, type TeamMessage, type TeamState } from './types.js';
import { logEngineEvent } from './log.js';
import { withFileLock, withProcessLock } from './lock.js';
import { inboxFile, teamLockNames } from './paths.js';
import { readTeam } from './teamstate.js';

// ---------------------------------------------------------------------------
// Frame-type whitelist (v0.2 §7.4-I3; CC "permission rules are never accepted
// from messages", 11-cc逆向 §3b-1). Single definition point lives here; the
// mcp face re-exports FRAME_TYPES from guards.ts (§9.2 contract).
// ---------------------------------------------------------------------------

/** v0.2 协议帧白名单：未知具名帧一律拒收（W3 unblock-notice / W2 shutdown-request /
 * W4 idle-notification / W5 delivery-refused 均已列入）。
 * v0.5（DESIGN-V0.5 §3.1，M3 的白名单扩展 hunk）：第七值 lead-transfer——lead 移交/
 * 接管/释放的通知与回执帧（字段固定模板，R-15-4 可控字段纪律；只是通知，不带授权语义）。
 * v0.7（DESIGN-V0.7 §2.2，C6/C7 M1）：再扩 4 值——tool_request/tool_result（转办请求/
 * 回投）与 approval_request/approval_result（审批通知/回执）。E4 §7.1 实测：未加白的
 * 具名帧被读取面静默剔除（frame-rejected 审计），「传得到、收不到」——故 C6 帧型
 * 必须进本表。**新帧型只做通知/回执，不带授权语义**（授权只认审批文件，§2.3/C7）；
 * 混合版本降级（v0.6.1 端点收新帧）走 readMailboxDetailed 的剔除+审计路径，不崩。
 * v0.9（G-3）：再扩 1 值——withdrawal-notice（发送方撤回未读件后给收方的通知帧；
 * 纯通知，不带授权语义）。软中断（G-2）不走具名帧——它是 TeamMessage.interrupt
 * 元数据 + 读取面渲染横幅，正文保持原话（uservoice 盖章字节匹配不受影响）。 */
export const FRAME_TYPES = [
  'task-assignment',
  'task-receipt',
  'idle-notification',
  'unblock-notice',
  'shutdown-request',
  'delivery-refused',
  'lead-transfer',
  'tool_request',
  'tool_result',
  'approval_request',
  'approval_result',
  'withdrawal-notice',
] as const;
export type FrameType = (typeof FRAME_TYPES)[number];

const FRAME_TYPE_SET: ReadonlySet<string> = new Set<string>(FRAME_TYPES);

/**
 * One message content's frame classification (pure, test-facing):
 * - `{kind:"chat"}` — not a named frame: free text, non-object JSON, or a JSON
 *   object without a `type` field (v0.1.0 free-text compatibility, §11.1);
 * - `{kind:"frame"}` — JSON object with a `type` field; `accepted` is the
 *   whitelist verdict. A non-string `type` is still a named frame (its name
 *   can never match the whitelist -> rejected).
 */
export type FrameClassification =
  | { kind: 'chat' }
  | { kind: 'frame'; frameType: string; accepted: boolean };

export function classifyFrame(content: string): FrameClassification {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { kind: 'chat' };
  }
  if (!isRecord(value)) return { kind: 'chat' };
  if (!('type' in value)) return { kind: 'chat' };
  const raw = value['type'];
  const frameType = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '<non-string-type>';
  return { kind: 'frame', frameType, accepted: FRAME_TYPE_SET.has(frameType) };
}

/** A crashed delivery attempt becomes retryable after this interval (state.js:26). */
export const MAILBOX_DELIVERY_LEASE_MS = 60_000;

/** Machine-parseable wake-prompt receipt prefix (DESIGN.md §2.4; dsh mailbox.js:5). */
export const RECEIPT_PREFIX = '[CrossChat inbox receipt: ';
const RECEIPT_SUFFIX = ']';

/** Build a fresh message record (port of state.js:371-373 createMessage + extras).
 *  v0.5（M3 帧域契约）：extra 白名单扩含 origin/originSessionId（队内盖章写入，R-11/R-12；
 *  只有 'origin' | 'originSessionId' 两个新增键，其余白名单行逐字节不动）。
 *  v0.6（C1，DESIGN-V0.6.md §3.1 数据面）：白名单再扩含 urgent——xc_relay
 *  urgent/interrupt 写入侧唯一新增键，其余白名单行逐字节不动。
 *  v0.9（G-2）：白名单再扩含 interrupt——软中断信封元数据唯一新增键，其余白名单行
 *  逐字节不动。 */
export function createMessage(
  from: string,
  to: string,
  content: string,
  extra: Partial<Pick<TeamMessage, 'taskId' | 'attemptId' | 'sourceTaskId' | 'sourceAttemptId' | 'sourceTaskStatus' | 'deliveryClaimedAt' | 'origin' | 'originSessionId' | 'urgent' | 'interrupt'>> = {},
): TeamMessage {
  return { id: randomUUID(), from, to, content, ts: Date.now(), ...extra };
}

// ---------------------------------------------------------------------------
// v0.6（C1，DESIGN-V0.6.md §4.2-M3）：urgent-first 呈现序（唯一实现，读取面共用）
// ---------------------------------------------------------------------------

/**
 * urgent 消息在一切读取面排最前（DESIGN-V0.6.md §3.1 读取序）。
 *
 * 规则：urgent=true 在前；两类内部按 ts 升序（JSONL 到达序）；ts 相同按原下标
 * （stable）。**物序不动，只动呈现序**——邮箱 JSONL 追加真源纪律不受影响：
 * 本函数只对已读入内存的数组排序，不回写磁盘。
 *
 * 调用面（M3）：readCurrentMailboxLocked（xc_check_inbox 消费序）、
 * hooks/shared.ts unreadSummary（钩子未读摘要）、peermsg.ts 排空面
 * （drainPeerFile/readPeerQueue 同款规则）。engine/wake.ts buildWakePrompt 的
 * urgent 首位走 WakePromptInput.urgent 横幅（M4），不经本函数（单消息携带）。
 */
export function urgentFirst<T extends { ts: number; urgent?: boolean }>(items: readonly T[]): T[] {
  const rank = (m: T) => (m.urgent === true ? 0 : 1);
  return items
    .map((m, i) => ({ m, i, r: rank(m) }))
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.m.ts - b.m.ts || a.i - b.i))
    .map((x) => x.m);
}

/**
 * Freshness adjudication, 1:1 port of mailbox.js:6-17.
 * A message is current when: not discarded; its source attempt (if any) is
 * still that task's current attempt held by the same sender in a compatible
 * status; and its delivery attempt (if any) is still the recipient's open
 * attempt. Anything else is stale -> discarded on disk, never delivered.
 */
export function isCurrentMail(team: TeamState, message: TeamMessage): boolean {
  if (message.discardedAt !== undefined) return false;
  if (message.sourceAttemptId !== undefined
    && !team.tasks.some((task) => task.id === message.sourceTaskId
      && task.attemptId === message.sourceAttemptId
      && task.assignee === message.from
      && (message.sourceTaskStatus === undefined
        || !['completed', 'failed', 'cancelled'].includes(task.status)
        || message.sourceTaskStatus === task.status))) {
    return false;
  }
  if (message.attemptId === undefined) {
    // v0.5.1（故障注-5 修复）：无 attemptId 的信封（分派/回执）此前无条件视为
    // 现行——真源丢失重建后，旧时代分派借残存邮箱「复活」注入且与新时代任务
    // 撞号。带 taskId 的信封必须仍指向存在的任务，否则判陈旧（就地丢弃并在
    // check_inbox 的 stale 计数中披露）；无 taskId 的纯聊天消息不受影响。
    if (message.taskId !== undefined && !team.tasks.some((task) => task.id === message.taskId)) {
      return false;
    }
    return true;
  }
  return team.tasks.some((task) => task.id === message.taskId
    && task.attemptId === message.attemptId
    && task.assignee === message.to
    && (task.status === 'claimed' || task.status === 'in_progress'));
}

/**
 * v0.5.1（故障注-2 修复）：孤儿任务引用检测（纯函数）。
 * 邮箱里仍有指向「team.tasks 中不存在的任务」的分派/回执信封时，说明真源
 * 任务段丢失（被清空/截断/整队重置）而在途工作无声蒸发。返回缺失的任务 id
 * 列表（去重、保序）；供 xc_status 告警与 xc_claim unknown-task 诊断富化。
 */
export function orphanTaskIds(team: TeamState, messages: readonly TeamMessage[]): string[] {
  const known = new Set(team.tasks.map((task) => task.id));
  const orphans: string[] = [];
  for (const message of messages) {
    const taskId = message.taskId;
    if (taskId === undefined || known.has(taskId) || orphans.includes(taskId)) continue;
    orphans.push(taskId);
  }
  return orphans;
}

/**
 * v0.5.2（故障注-1 二番战修复）：任务板与回执链的矛盾检测（纯函数）。
 * 邮箱里已有某任务的 **completed 回执**（sourceTaskStatus='completed' 的信封，
 * xc_report 终态时写给派发方），而 team.tasks 里该任务仍是未完成态
 * （pending/claimed/in_progress）= 真源被陈旧备份回滚/手工改坏——已完成工作
 * 静默退回。与 orphanTaskIds 互补：孤儿检测管「任务不存在」，本函数管
 * 「任务存在但状态倒退」。返回矛盾的任务 id 列表（去重、保序）。
 * 合法路径不可能命中：终态无出边（TASK_TRANSITIONS），僵尸清扫回退附的是
 * failed 回执而非 completed；completed 回执只能与「状态倒退」共存。
 */
export function staleCompletedReceiptTaskIds(team: TeamState, messages: readonly TeamMessage[]): string[] {
  const open = new Set(
    team.tasks
      .filter((task) => !TERMINAL_TASK_STATUSES.includes(task.status))
      .map((task) => task.id),
  );
  if (open.size === 0) return [];
  const stale: string[] = [];
  for (const message of messages) {
    const taskId = message.sourceTaskId;
    if (taskId === undefined || message.sourceTaskStatus !== 'completed') continue;
    if (open.has(taskId) && !stale.includes(taskId)) stale.push(taskId);
  }
  return stale;
}

/** Default malformed-line sink: skip + audit-log (DESIGN.md §2.7-5). */
function defaultOnMalformed(stateRoot: string, file: string): (malformed: MalformedLine) => void {
  return (malformed) => {
    void logEngineEvent(stateRoot, { event: 'malformed-line', file, lineNo: malformed.lineNo, error: malformed.error });
  };
}

function mailboxPath(stateRoot: string, teamId: string, agentKey: string): string {
  return inboxFile(stateRoot, teamId, sanitizeKey(agentKey));
}

/** One mailbox read split into the deliverable view and the rejected frames. */
export interface MailboxRead {
  messages: TeamMessage[];
  /** Named frames outside the whitelist (§7.4-I3): dropped from every view. */
  rejected: TeamMessage[];
  /** v0.5.1（故障注-3 修复）：本次读取跳过的不可解析行（含行号与原因）。 */
  malformed: MalformedLine[];
}

/**
 * Detailed read: whole mailbox split into the whitelisted view and rejected
 * named frames. Rejected frames are audited `{event:"frame-rejected"}`
 * (best-effort) while not yet disposed on disk; after the team-locked sweep in
 * readCurrentMailboxLocked stamps them discardedAt, re-reads stay silent.
 * v0.5.1（故障注-3 修复）：不可解析行照旧跳过+走原 sink（缺省=审计），同时
 * 收集进返回值，让工具面能把「N 条不可读」披露给调用方而不是静默吞掉。
 */
async function readMailboxDetailed(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformed?: (malformed: MalformedLine) => void,
): Promise<MailboxRead> {
  const file = mailboxPath(stateRoot, teamId, agentKey);
  const sink = onMalformed ?? defaultOnMalformed(stateRoot, file);
  const malformed: MalformedLine[] = [];
  const collectingSink = (info: MalformedLine): void => {
    malformed.push(info);
    sink(info);
  };
  const messages = (await readJsonl<TeamMessage>(file, isTeamMessage, collectingSink)).map(normalizeMessage);
  const kept: TeamMessage[] = [];
  const rejected: TeamMessage[] = [];
  for (const message of messages) {
    const cls = classifyFrame(message.content);
    if (cls.kind === 'frame' && !cls.accepted) {
      rejected.push(message);
      if (message.discardedAt === undefined) {
        // await：读侧的「丢弃 + 审计」原子化——读返回时审计行已落盘（engine.jsonl
        // 是 O_APPEND 追加，await 的代价可控；malformed 汇报仍保持 v0.1.0 的尽力而为）。
        await logEngineEvent(stateRoot, {
          event: 'frame-rejected',
          teamId,
          recipient: agentKey,
          messageId: message.id,
          frameType: cls.frameType,
        });
      }
      continue;
    }
    kept.push(message);
  }
  return { messages: kept, rejected, malformed };
}

/**
 * Read one agent's whole mailbox, oldest first. Malformed lines are skipped
 * and reported (onMalformed; default = engine.jsonl audit entry). v0.2: named
 * frames outside the whitelist are dropped from the returned view (§7.4-I3).
 */
export async function readMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformed?: (malformed: MalformedLine) => void,
): Promise<TeamMessage[]> {
  return (await readMailboxDetailed(stateRoot, teamId, agentKey, onMalformed)).messages;
}

/** Read only messages neither read nor discarded (state.js:438-441). */
export async function readUnreadMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformed?: (malformed: MalformedLine) => void,
): Promise<TeamMessage[]> {
  return (await readMailbox(stateRoot, teamId, agentKey, onMalformed))
    .filter((message) => message.readAt === undefined && message.discardedAt === undefined);
}

/**
 * Unread mail eligible for a delivery attempt: never delivered, and either
 * unclaimed or whose delivery lease has expired (state.js:443-449).
 */
export async function readPendingMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  now: number = Date.now(),
): Promise<TeamMessage[]> {
  return (await readUnreadMailbox(stateRoot, teamId, agentKey))
    .filter((message) => message.deliveredAt === undefined
      && (message.deliveryClaimedAt === undefined
        || now - message.deliveryClaimedAt >= MAILBOX_DELIVERY_LEASE_MS));
}

/**
 * Append one message as the next JSONL line (cross-process O_APPEND write).
 * v0.6（DESIGN-V0.6.md §2.2 行 1）：邮箱哈希链 sidecar（`.jsonl.int`）已砍除——
 * 「不丢」底线由 JSONL 追加真源 + 坏行跳过审计（jsonl.ts）承担，防磁盘篡改的
 * 对抗件在个人/内部威胁模型下不成立。mailbox JSONL 追加语义与 v0.5.3 逐字节一致
 * （只是不再写 sidecar；存量 `.jsonl.int` 文件成为无害孤儿，不做迁移）。
 */
export async function appendMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  message: TeamMessage,
): Promise<void> {
  await appendJsonl(mailboxPath(stateRoot, teamId, agentKey), [JSON.stringify(message)]);
}

/**
 * Rewrite the lines whose parsed message id is selected, preserving malformed
 * lines verbatim (state.js:450-479 mutateMailbox, atomic whole-file commit).
 * Caller holds the team lock.
 */
export async function mutateMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
  mutate: (message: TeamMessage) => TeamMessage,
): Promise<void> {
  if (messageIds.length === 0) return;
  const selected = new Set(messageIds);
  await rewriteJsonl(mailboxPath(stateRoot, teamId, agentKey), (value) => {
    if (!isTeamMessage(value) || !selected.has(value.id)) return undefined;
    return JSON.stringify(mutate(normalizeMessage(value)));
  });
}

/** Lease selected messages to one delivery path (state.js:481-487). */
export async function claimMailboxDelivery(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[], now: number = Date.now(),
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => ({ ...message, deliveryClaimedAt: now }));
}

/** Release a failed delivery lease so delivery can retry later (state.js:489-494). */
export async function releaseMailboxDelivery(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[],
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => {
    const { deliveryClaimedAt: _released, ...rest } = message;
    return rest;
  });
}

/** Mark selected messages delivered (host accepted; not yet read) (state.js:511-516). */
export async function markMailboxDelivered(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[], now: number = Date.now(),
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => {
    const { deliveryClaimedAt: _claimed, ...rest } = message;
    return { ...rest, deliveredAt: message.deliveredAt ?? now };
  });
}

/**
 * Acknowledge selected messages as read. This happens at the instant the tool
 * returns the messages to the model — host acceptance is NOT consumption
 * (DESIGN.md §2.1; dsh state.js:500-509).
 *
 * v0.9.1（G-12v3 机制 B）：readAt 落盘的同时回写 **consumedAt**（消费确认）——
 * xc_read({scope:"inbox"}) 把消息实体交到模型手上即「成员回合实际消费」；投递盖章
 * （deliveredAt）与消费确认自此分离，limbo 降级 sweep 以 consumedAt 为放行判据。
 */
export async function acknowledgeMailbox(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[], now: number = Date.now(),
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => {
    const { deliveryClaimedAt: _claimed, ...rest } = message;
    return {
      ...rest,
      deliveredAt: message.deliveredAt ?? now,
      readAt: message.readAt ?? now,
      consumedAt: message.consumedAt ?? now,
    };
  });
}

/**
 * v0.9.1（G-12v3 机制 B）：**只回写消费确认**（consumedAt），不动 readAt。
 *
 * 用于「消息被某会话知悉/处置但尚未（或不必）走 readAt 路径」的消费面：
 * - hook 未读注入（hooks/shared.ts）：成员回合实际开跑并被提示有未读 ⇒ 该会话活着，
 *   不是 limbo（唤醒子进程在消费前死亡的形态）；
 * - xc_claim 读件（mcp/tools-tasks.ts）：认领任务 = 消费了对应派单信封。
 * 幂等：已有 consumedAt 的消息值不被改写。
 */
export async function markMailboxConsumed(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  ids: readonly string[],
  now: number = Date.now(),
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => ({
    ...message,
    consumedAt: message.consumedAt ?? now,
  }));
}

/**
 * v0.9.1（G-12v3 机制 B）：**limbo 降级**——把「已盖投递章但超时无消费确认」的消息
 * 打回可重新投递态（清 deliveredAt + deliveryClaimedAt；readAt/consumedAt 不动）。
 *
 * 生产形态（G-12 修正 v3 邮箱文件级实锤）：wake 路径 spawn 成功瞬间即盖 deliveredAt
 * （fire-and-forget），子进程在成员回合消费内容前死亡（内存红线 OOM / 宿主重启杀
 * 无头子进程）→ 消息已盖章、从未被读、且不再是可投递态，死会话永不 pull，实质丢失
 * 直至人工发现（4/4 收方零动作）。降级后消息重新可注入（未读钩子按 readAt 判）/
 * 可 pull（xc_read）/ 可重新 push（投递面对 deliveredAt 的条件）。
 *
 * 幂等（同一消息一个投递轮次只降级一次）：判据要求 deliveredAt 在场，而降级恰好清掉
 * 它——第二遍扫不到同一条；重投后再超时构成**新的**轮次（正确语义，非重复降级）。
 * 竞态：调用方持团队锁，与消费回写（acknowledgeMailbox / markMailboxConsumed）互斥；
 * 锁内复判 deliveredAt 仍在场才降级——消费先到则跳过（已被读，不是 limbo）。
 *
 * @returns 本次降级的消息（降级后形状；空 = 无 limbo 或锁内复判已被消费/已陈旧）。
 */
export async function sweepLimboDeliveriesLocked(
  stateRoot: string,
  team: TeamState,
  agentKey: string,
  now: number,
  timeoutMs: number,
): Promise<TeamMessage[]> {
  const all = await readMailbox(stateRoot, team.teamId, agentKey);
  const limbo = all.filter((message) =>
    message.deliveredAt !== undefined
    && message.consumedAt === undefined
    && message.readAt === undefined
    && message.discardedAt === undefined
    && now - message.deliveredAt >= timeoutMs
    && isCurrentMail(team, message));
  if (limbo.length === 0) return [];
  await mutateMailbox(stateRoot, team.teamId, agentKey, limbo.map((m) => m.id), (message) => {
    const { deliveryClaimedAt: _claimed, deliveredAt: _delivered, ...rest } = message;
    return rest;
  });
  return limbo.map((message) => {
    const { deliveryClaimedAt: _claimed, deliveredAt: _delivered, ...rest } = message;
    return rest;
  });
}

/** Mark selected messages discarded (stale on arrival) (state.js:517-519). */
export async function discardMailboxMessages(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[], now: number = Date.now(),
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => ({
    ...message,
    discardedAt: message.discardedAt ?? now,
  }));
}

/**
 * v0.9（G-3 撤回原语）：把选中 id 的消息行从邮箱 JSONL **整行删除**（非打标）——
 * mutateMailbox 只能改写行、无法删行，撤回的语义是收方永远读不到（连 readAt 历史都不留）。
 * 原子整文件提交（writeFileAtomic，与 rewriteJsonl 同纪律）：坏行/空行逐字节保留，
 * 只删「解析为 TeamMessage 且 id 命中」的行；命中数返回给调用方对账。
 * 调用方必须已持团队锁（与一切邮箱变更同规）。撤回的其余语义（未读校验、整单拒绝、
 * 给收方投 withdrawal-notice 帧、engine 事件）在 xc_relay 的队内轴核心实现。
 */
export async function deleteMailboxMessages(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const selected = new Set(ids);
  const file = mailboxPath(stateRoot, teamId, agentKey);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  const lines = raw.split('\n').filter((rawLine) => {
    const line = stripLeadingBom(rawLine);
    if (line.trim() === '') return true;
    try {
      const value: unknown = JSON.parse(line);
      if (isTeamMessage(value) && selected.has(value.id)) {
        removed += 1;
        return false;
      }
    } catch {
      // 坏行不是撤回对象——逐字节保留（readMailboxDetailed 会在读取面披露）。
    }
    return true;
  });
  if (removed > 0) await writeFileAtomic(file, lines.join('\n'));
  return removed;
}

/**
 * Read current (non-stale) unread mail while the caller holds the team lock:
 * stale messages are discarded on disk and not returned. 1:1 port of
 * mailbox.js:29-40 readCurrentMailboxLocked. v0.2: whitelist-rejected frames
 * are additionally stamped discardedAt on disk under the lock (the only place
 * a mailbox mutation may run), so later lockless reads stop re-auditing them.
 */
/** v0.5.1：读取诊断收集器（故障注-3/5）——不可解析行明细 + 就地丢弃的陈旧件数。 */
export interface MailboxReadDiagnostics {
  malformed: MalformedLine[];
  discarded: number;
}

export async function readCurrentMailboxLocked(
  stateRoot: string,
  team: TeamState,
  recipient: string,
  onMalformed?: (malformed: MalformedLine) => void,
  // v0.5.1（故障注-3 修复）：调用方可选诊断收集器——本次读取跳过的不可解析行
  // 与就地丢弃的陈旧件数（工具面据此在响应中披露，不再静默当空箱/静默清扫）。
  diagnostics?: MailboxReadDiagnostics,
): Promise<TeamMessage[]> {
  const read = await readMailboxDetailed(stateRoot, team.teamId, recipient, onMalformed);
  if (diagnostics !== undefined) diagnostics.malformed.push(...read.malformed);
  const current: TeamMessage[] = [];
  const staleIds: string[] = read.rejected.map((message) => message.id);
  for (const message of read.messages) {
    if (isCurrentMail(team, message)) current.push(message);
    else staleIds.push(message.id);
  }
  await discardMailboxMessages(stateRoot, team.teamId, recipient, staleIds);
  if (diagnostics !== undefined) diagnostics.discarded = staleIds.length;
  // v0.6（C1，DESIGN-V0.6.md §3.1 读取序 1）：消费面 urgent-first——urgent 消息排到
  // 一切未读之前（类内 ts 升序，stable）。xc_check_inbox 的批次窗口（batchWindowCount
  // 按到达序前缀开窗）据此先消费 urgent；JSONL 物理序不动（追加真源纪律）。
  // 生产调用面唯一（mcp/tools.ts xc_check_inbox）；mail_read 历史分页走 readMailbox
  // （到达序），不受本排序影响。
  return urgentFirst(current);
}

/**
 * Standalone current-mail read: takes the in-process chain AND the
 * cross-process team lock itself (for hook/engine callers outside a tool
 * transaction). Tools that already hold the lock must call
 * readCurrentMailboxLocked instead (nesting the same lock deadlocks).
 */
export async function readCurrentMailbox(
  stateRoot: string,
  teamId: string,
  recipient: string,
  onMalformed?: (malformed: MalformedLine) => void,
  options: { waitMs?: number; diagnostics?: MailboxReadDiagnostics } = {},
): Promise<TeamMessage[]> {
  const names = teamLockNames(stateRoot, teamId);
  return withProcessLock(names.processKey, async () => {
    return withFileLock(stateRoot, names.file, async () => {
      const team = await readTeam(stateRoot, teamId);
      if (team === undefined) return [];
      return readCurrentMailboxLocked(stateRoot, team, recipient, onMalformed, options.diagnostics);
    }, options);
  });
}

// ---------------------------------------------------------------------------
// Receipt prefix + human body (port of mailbox.js:19-27/49-70, re-branded)
// ---------------------------------------------------------------------------

export interface MailReceipt {
  teamId: string;
  recipient: string;
  ids: string[];
}

/** Serialize the receipt payload the wake prompt carries (DESIGN.md §2.4). */
export function formatReceipt(teamId: string, recipient: string, ids: readonly string[]): string {
  return `${RECEIPT_PREFIX}${JSON.stringify({ teamId, recipient, ids: [...ids] })}${RECEIPT_SUFFIX}`;
}

/** Parse one text block's receipt line; undefined when the text is not one. */
export function parseReceipt(text: string): MailReceipt | undefined {
  if (!text.startsWith(RECEIPT_PREFIX)) return undefined;
  try {
    const body = text.slice(RECEIPT_PREFIX.length).split('\n')[0];
    const parsed = JSON.parse(body.endsWith(RECEIPT_SUFFIX) ? body.slice(0, -RECEIPT_SUFFIX.length) : body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const raw = parsed as Record<string, unknown>;
    if (typeof raw['teamId'] !== 'string' || typeof raw['recipient'] !== 'string'
      || !Array.isArray(raw['ids']) || !raw['ids'].every((id) => typeof id === 'string')) {
      return undefined;
    }
    return { teamId: raw['teamId'], recipient: raw['recipient'], ids: raw['ids'] as string[] };
  } catch {
    return undefined;
  }
}

/** Structured provenance header for task-sourced messages (mailbox.js:19-22). */
export function mailboxContent(message: TeamMessage): string {
  return (message.sourceTaskId === undefined
    ? ''
    : `[Source task ${message.sourceTaskId}, attempt_id ${message.sourceAttemptId ?? ''}${message.sourceTaskStatus === undefined ? '' : `, status=${message.sourceTaskStatus}`}]\n`)
    + message.content;
}

/** Human-readable body for a batch of messages (mailbox.js:23-27, no captain branch). */
export function mailboxBody(recipient: string, messages: readonly TeamMessage[]): string {
  return messages.map((message) => `CrossChat message from ${message.from}${message.attemptId === undefined ? '' : ` for task ${message.taskId ?? ''}, attempt_id ${message.attemptId}`}:\n\n${mailboxContent(message)}`).join('\n\n');
}

/** Full wake-prompt mail section: receipt line first, then the body (mailbox.js:49-51). */
export function mailboxPrompt(teamId: string, recipient: string, messages: readonly TeamMessage[]): string {
  return `${formatReceipt(teamId, recipient, messages.map((message) => message.id))}\n\n${mailboxBody(recipient, messages)}`;
}
