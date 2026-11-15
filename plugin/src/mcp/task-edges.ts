/**
 * W3 task-flow —— 确定性任务边沿包装（DESIGN-V0.2.md §5.1 E-b 边沿、§5.4 僵尸清扫、
 * §7.3.1 事件粒度快照刷新；文件所有权表 §9.1 归 W3）。
 *
 * withTaskEdges(core, deps) 包装 v0.1.0 工具核心的 xc_report / xc_dispatch，
 * **只叠加、不替换**（D4/§11.1）：基座核心的校验、写盘与唤醒路径一字不动；
 * 包装层在基座成功返回后追加边沿动作——
 *
 * - xc_dispatch（E-a 派发边沿）：任务图真实变化（新任务入池）→ 刷新 snapshot.json。
 *   duplicate（无变化）不刷新。
 * - xc_report（E-b 终态报告边沿，任何一次成功 report 后）：
 *   ① 僵尸清扫（§5.4）：claimed/in_progress ∧ updatedAt 超过 XC_STALE_TASK_MINUTES
 *      （默认 30 分钟）∧ 该成员无在途 wake nonce → revokeAttempt（引擎特权重置回
 *      pending）+ 给派发方邮箱写 task-receipt(status:"failed", error:"stale-swept: …")
 *      回执 + 锁外唤醒派发方（lead 主导派发时即 §5.4 的「唤醒 lead」）；
 *   ② 依赖解除（status=completed 专属）：downstreamReady 的每个就绪下游任务 →
 *      findTaskRecipient 定位派发对象 → unblock-notice 帧（携 collectDependencyOutputs
 *      的 2000/12000 预算上游输出摘要）入其邮箱；收件人无开放任务且非
 *      provisioning/failed/removed → 锁外逃逸唤醒（scene "unblock"）。
 *   ②' 依赖死锁解除（v0.5.3 A3 修复，status=failed 专属）：failed/cancelled 不再
 *      让下游永久阻塞（adj052 A3：下游 pending 死锁、零通知，唯一出路是创建者
 *      手工 xc_cancel）——failed 上游的依赖闭包内 pending 下游**确定死锁**，自动
 *      置 cancelled（合法边，by=engine、history=dependency-deadlock）+ 回执/唤醒
 *      各任务创建者；cancelled 上游的同款解除由 xc_cancel 边沿（lead-tools）复用
 *      cascadeDependencyDeadlockLocked 完成；
 *   ③ 边沿后刷新 snapshot.json（§7.3.1「任务图每次真实变化都落盘一版快照」；
 *      in_progress 心跳更新 updatedAt，同样刷新——满足 §7.3.1 机制 3「每单 report
 *      至少触发一次边沿刷新」）。
 *
 * 并发纪律（§2.7-4 沿用）：变更动作一律 withTeamLock 内「重读 → 计算 → 变更 → 写盘」；
 * attemptWake 只准在团队锁外调用（持锁调用会死锁——wake.ts 内部会短暂重取锁补盖章），
 * 因此结构固定为「锁内收集计划 → 锁外执行唤醒」。锁内只做读邮箱/读 registry 等
 * 无锁 IO，不嵌套获取同一把团队锁。
 *
 * 永不抛出：基座结果之外的边沿动作全部 best-effort——任何异常（含 15s 锁等待超时）
 * 记 engine.jsonl `task-edges-failed` 审计后吞掉，工具结果保持基座原样（观测/联动
 * 面失败永不影响业务结果；锁忙导致的边沿跳过由邮箱真源兜底：下次终态边沿重算，
 * 收件人 pull 兜底）。
 *
 * W2 可选字段（成员 state/identity、leadKey）宽容读取：缺省 = §6.5 的 ready/self
 * 语义，W2 落盘前后两种形态都编译、都正确（字段唯一定义处 core/types.ts，W2）。
 */

import { payloadOf } from "./protocol.js";
import type { ToolCore, ToolDeps } from "./core.js";
import { findInflightWakeNonce } from "../core/registry.js";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { withTeamLock } from "../core/lock.js";
import { appendTaskHistory, leadKeyOf, memberOpenTasks, readTeam, writeTeam } from "../core/teamstate.js";
import {
  collectDependencyOutputs,
  deadlockedDependents,
  downstreamReady,
  findTaskRecipient,
  revokeAttempt,
  staleTasks,
} from "../core/graph.js";
import { refreshSnapshot } from "../core/snapshot.js";
import {
  DEFAULT_TEAM_ID,
  TERMINAL_TASK_STATUSES,
  type TaskStatus,
  type TeamMessage,
  type TeamState,
} from "../core/types.js";
import { attemptWake } from "../engine/wake.js";
// v0.7（C8，DESIGN-V0.7.md §4）：离线判定纯函数 + 只读 peer 扫描。
import { peerRootFromEnv } from "../core/peerdir.js";
import { scanPeers, type PeerScanResult } from "../core/peerregistry.js";
import { lastProgressTs } from "../core/stall.js";
import {
  memberLiveness,
  offlineSuggestion,
  offlineThresholdMsFromEnv,
  offlineVerdict,
  type MemberLiveness,
  type OfflineEvidence,
  type OfflineMember,
  type OfflineTaskInfo,
} from "../core/offline.js";
// v0.7（C6/C7，DESIGN-V0.7.md §2.5/§3.3）：转办台账过期节拍 + 终态清理。
import { cleanupToolArtifacts, expireToolRequests, TOOL_APPROVAL_KEEP_MS } from "../core/toolledger.js";
import { buildApprovalResult, buildRefusedToolResult } from "../core/toolrelay.js";

// ─────────────────────────── 配置解析（V18 同款防御） ───────────────────────────

const DEFAULT_STALE_TASK_MINUTES = 30;

/**
 * XC_STALE_TASK_MINUTES → 毫秒；非有限正数取默认 30min（§5.4 / plugin.json §10.1）。
 *
 * v0.7.1（红队四番战 边界-10 修复）：`0` 的语义**显式化**。红队实测（`b10.mjs`）：
 * `=1` 时 claimed 任务 ~64s 被清扫回 pending；`=0` 时 104s 仍 claimed——因为 0 走到
 * 这里和非数字/负数同路，一律回落缺省 30min，而这个回落此前**没有任何文档说过**
 * （对照 `XC_PEER_MAX_QUEUE_DEPTH` 的 PROTOCOL §9「0=内置 1024」）。本版不改变
 * 该行为（0 = 缺省 30min，与 peer 队列深度的「0=默认」口径一致；把 0 当成「立即
 * 清扫」会让所有在途任务瞬间回池，当成「关闭清扫」又会违背 README L215 的清扫
 * 承诺），只把口径写进代码注释、PROTOCOL §9 的 env 表与 README，并配防回归单测
 * 锁死 `0 / -1 / 空串 / 非数字` 全部回落 30min。
 */
export function staleThresholdMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env["XC_STALE_TASK_MINUTES"];
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  const minutes = Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_TASK_MINUTES;
  return minutes * 60_000;
}

// ─────────────────────────── W2 可选字段的宽容桥接（§6.5） ───────────────────────────

type MemberWithProvisionState = { state?: string; identity?: string };

/** 成员供给状态宽容读取 = W2 访问器 memberState(m) 的 §6.5 语义（m.state ?? "ready"）。 */
function memberProvisionState(member: TeamState["members"][number] | undefined): string {
  return (member as MemberWithProvisionState | undefined)?.state ?? "ready";
}

/** 唤醒门控（§6.3 双向门控 + §7.3.3）：provisioning/failed/removed 一律不唤醒（只入箱）。 */
function blocksWake(provisionState: string): boolean {
  return (
    provisionState === "provisioning" || provisionState === "failed" || provisionState === "removed"
  );
}

/** 解析一帧消息的 JSON content；非对象/不可解析 → undefined。 */
function parseFrame(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 边沿动作返回形状（进工具结构化负载） ───────────────────────────

export interface SweptTaskInfo {
  taskId: string;
  assignee: string | null;
  /** 被重置前的 attemptId（回执 JSON 内保留关联）。 */
  revokedAttemptId: string | null;
  staleMinutes: number;
}

export interface UnblockedTaskInfo {
  taskId: string;
  recipient: string;
  messageId: string;
  /** 已对该收件人发起逃逸唤醒（false = 有开放任务/供给中/removed → 只入箱）。 */
  woken: boolean;
}

/**
 * v0.5.3（A3 修复）：依赖死锁被引擎解除的下游任务。
 * 上游 failed/cancelled 后其 pending 下游永远无法满足依赖——自动置 cancelled
 * 并回执/唤醒各任务创建者，死锁从「无声永久阻塞」变为「显式终态 + 可行动通知」。
 */
export interface DeadlockedTaskInfo {
  taskId: string;
  createdBy: string;
  messageId: string;
  /** 死锁根因的上游任务 id（状态 failed/cancelled）。 */
  deadlockedBy: string;
  /** 已对该创建者发起逃逸唤醒（false = 有开放任务/供给中/failed/removed → 只入箱）。 */
  woken: boolean;
}

export interface TaskEdgeOutcome {
  swept: SweptTaskInfo[];
  unblocked: UnblockedTaskInfo[];
  /** v0.5.3（A3 修复）：随终态报告被解除的死锁下游。 */
  deadlocked: DeadlockedTaskInfo[];
  /**
   * v0.7（C8，DESIGN-V0.7.md §4.2）：本轮被判「成员离线」的属主及其名下被扫任务
   * （进程死硬证据 / 空闲超时兜底）。进工具 payload 与 engine.jsonl `task-offline`
   * 审计；lead 另收一条转交通知（邮箱 + 唤醒计划）。空数组 = 无离线命中。
   */
  offline: OfflineMember[];
}

/** 锁内收集、锁外执行的唤醒计划项。 */
interface WakePlanItem {
  to: string;
  sessionId: string | null;
  reason: string;
  receiptIds: string[];
  ticket: string;
}

// ─────────────────────────── ① 僵尸清扫（§5.4，随 E-b 边沿执行） ───────────────────────────

/**
 * 清扫 + 回执（调用方持团队锁）。回执路由 = task.createdBy（派发方）——§5.4 的
 * 「lead 邮箱」在 lead 主导派发流中即 createdBy（与 v0.1.0 回执路由 tools.ts §2.9-1
 * 一致）。唤醒计划返回给调用方在锁外执行。
 *
 * v0.7（C8，DESIGN-V0.7.md §4.1/§4.2）：`opts.scan` 给出时（调用方锁外做好的**只读**
 * peer 扫描）对本轮被扫任务逐条算 offlineVerdict——`process-dead`（进程死硬证据，
 * 免空闲阈值）或 `idle-timeout`（240min 兜底）命中的属主，除 createdBy 回执外**额外
 * 通知 lead**（一条成员级转交通知 + 唤醒计划），并进 `offline` 返回面 / `task-offline`
 * 审计。回池路径本身不新开：仍是 stale sweeper 的 revokeAttempt（§4.2「复用 sweeper」）。
 * `opts` 缺省 = 不产离线判定（旧调用点零行为变化）。
 */
async function sweepStaleTasksLocked(
  stateRoot: string,
  team: TeamState,
  thresholdMs: number,
  now: number,
  opts: { scan?: PeerScanResult; offlineThresholdMs?: number } = {},
): Promise<{ swept: SweptTaskInfo[]; wakePlan: WakePlanItem[]; offline: OfflineMember[] }> {
  const teamId = team.teamId;
  const candidates = staleTasks(team.tasks, now, thresholdMs);
  const swept: SweptTaskInfo[] = [];
  const wakePlan: WakePlanItem[] = [];
  const seenRecipients = new Set<string>();
  // C8：本轮离线命中的属主（按成员聚合——一名成员多任务只通知 lead 一次）。
  const offlineHits = new Map<
    string,
    { member: TeamState["members"][number]; liveness: MemberLiveness; evidence: OfflineEvidence; tasks: OfflineTaskInfo[] }
  >();
  for (const task of candidates) {
    // 豁免条件（§5.4）：该成员有在途 wake nonce → 本次跳过（唤醒回合可能仍在跑，
    // 其下一份 report/心跳会刷新 updatedAt）。进程死证据**不绕过**豁免（nonce 有
    // TTL，保守优先；§4.2 边界）。
    if (task.assignee !== null) {
      const inflight = await findInflightWakeNonce(stateRoot, task.assignee, { teamId, now });
      if (inflight !== undefined) continue;
    }
    const assigneeBefore = task.assignee;
    const revokedAttemptId = task.attemptId;
    const staleMinutes = Math.max(1, Math.round((now - task.updatedAt) / 60_000));
    // C8（§4.1）：活性 + 离线判据。必须在 revokeAttempt **之前**取（重置后 assignee
    // 置 null、status 回 pending，判据就归不到属主名下了）。
    let offlineHit:
      | { liveness: MemberLiveness; evidence: OfflineEvidence; idleForMin: number; status: TaskStatus }
      | undefined;
    if (opts.scan !== undefined && opts.offlineThresholdMs !== undefined && assigneeBefore !== null) {
      const member = team.members.find((m) => m.key === assigneeBefore);
      if (member !== undefined) {
        const liveness = memberLiveness(member, opts.scan, now);
        const verdict = offlineVerdict(task, member, liveness, now, opts.offlineThresholdMs);
        if (verdict.offline && verdict.evidence !== null) {
          offlineHit = {
            liveness,
            evidence: verdict.evidence,
            idleForMin: Math.max(1, Math.round((now - lastProgressTs(task)) / 60_000)),
            status: task.status,
          };
        }
      }
    }
    if (!revokeAttempt(task, { by: "engine", now, event: "revoked-stale" })) continue;
    swept.push({ taskId: task.id, assignee: assigneeBefore, revokedAttemptId, staleMinutes });
    // 回执帧：attempt 关联保留在 JSON 内容（与 tools.ts receiptText 同构；不带
    // sourceAttemptId——重置后任务已无当前 attempt，带它会让回执落地即被判 stale）。
    const receipt = JSON.stringify({
      type: "task-receipt",
      teamId,
      taskId: task.id,
      attemptId: revokedAttemptId,
      status: "failed",
      result: null,
      error: `stale-swept: no update for ${staleMinutes} min`,
      evidence: [],
    });
    const msg = createMessage("engine", task.createdBy, receipt, {
      taskId: task.id,
      sourceTaskId: task.id,
      sourceTaskStatus: "failed",
      deliveryClaimedAt: now,
    });
    await appendMailbox(stateRoot, teamId, task.createdBy, msg);
    if (!seenRecipients.has(task.createdBy)) {
      seenRecipients.add(task.createdBy);
      wakePlan.push({
        to: task.createdBy,
        sessionId: team.members.find((m) => m.key === task.createdBy)?.sessionId ?? null,
        reason: "stale-sweep",
        receiptIds: [msg.id],
        ticket: receipt,
      });
    }
    await logEngineEvent(stateRoot, {
      event: "task-swept",
      teamId,
      taskId: task.id,
      assignee: assigneeBefore,
      staleMinutes,
      revokedAttemptId,
      receiptTo: task.createdBy,
    });
    if (offlineHit !== undefined && assigneeBefore !== null) {
      const entry = offlineHits.get(assigneeBefore) ?? {
        member: team.members.find((m) => m.key === assigneeBefore)!,
        liveness: offlineHit.liveness,
        evidence: offlineHit.evidence,
        tasks: [],
      };
      entry.tasks.push({ taskId: task.id, title: task.title, status: offlineHit.status, idleForMin: offlineHit.idleForMin });
      offlineHits.set(assigneeBefore, entry);
    }
  }
  const offline = await notifyOfflineLeadLocked(stateRoot, team, offlineHits, wakePlan, now);
  return { swept, wakePlan, offline };
}

/**
 * C8（§4.2）：离线属主的 lead 转交通知（调用方持团队锁；邮箱帧 + 唤醒计划项）。
 *
 * 帧型 = `task-receipt`（W5 白名单既有成员，任务域引擎回执；**不新添帧型**——帧型属
 * M1 的 mailbox.ts，且 C6/C7 的四个新帧型都是转办/审批语义，与离线转交无关）。载荷在
 * stale-swept 回执之外多带一个 `offline` 块（属主/证据/活性/任务清单/转交建议），
 * status 仍为 "failed"——不触发 mailbox.staleCompletedReceiptTaskIds 的
 * 「completed 回执 vs 未完成任务板矛盾」检测（该检测只认 completed）。
 *
 * 两条跳过规则（保守，避免惊动与自娱）：
 * 1. 离线属主**就是 lead 自己**——通知 lead「你没了」没有行动意义（其任务照常回池 +
 *    createdBy 回执 + overview 行仍在，信息不丢）；
 * 2. 该属主本轮没有被扫任务（无 offlineHits 条目）——本函数只被命中路径调用。
 *
 * 通知按**成员**聚合：一名成员名下多任务只发一条（任务 id 全列在帧里），
 * 唤醒计划同一形态（reason "task-offline"，非守则场景）。
 */
async function notifyOfflineLeadLocked(
  stateRoot: string,
  team: TeamState,
  offlineHits: Map<
    string,
    { member: TeamState["members"][number]; liveness: MemberLiveness; evidence: OfflineEvidence; tasks: OfflineTaskInfo[] }
  >,
  wakePlan: WakePlanItem[],
  now: number,
): Promise<OfflineMember[]> {
  const out: OfflineMember[] = [];
  if (offlineHits.size === 0) return out;
  const teamId = team.teamId;
  // lead 判定走 core 单一事实源（teamstate.leadKeyOf，v0.7 C7 落位；与 mcp/tools-team.ts
  // 的同名判断同口径）——本模块不 import mcp 面，避免 tools-team ↔ task-edges 模块环。
  const leadKey = leadKeyOf(team);
  for (const [key, hit] of offlineHits) {
    const idleForMin = hit.tasks.reduce((max, t) => (t.idleForMin > max ? t.idleForMin : max), 0);
    out.push({
      key,
      sessionId: hit.member.sessionId ?? null,
      liveness: hit.liveness,
      evidence: hit.evidence,
      idleForMin,
      tasks: hit.tasks,
    });
    if (key === leadKey) continue; // 规则 1：不通知 lead 关于它自己
    const notice = JSON.stringify({
      type: "task-receipt",
      teamId,
      taskId: hit.tasks[0]!.taskId,
      attemptId: null,
      status: "failed",
      result: null,
      error: `offline-handover: member "${key}" looks gone (${hit.evidence}) — open task(s) requeued to the pending pool`,
      evidence: [],
      offline: {
        member: key,
        evidence: hit.evidence,
        liveness: hit.liveness,
        idleForMin,
        taskIds: hit.tasks.map((t) => t.taskId),
        suggestion: offlineSuggestion(hit.evidence),
      },
    });
    const msg = createMessage("engine", leadKey, notice, { deliveryClaimedAt: now });
    await appendMailbox(stateRoot, teamId, leadKey, msg);
    wakePlan.push({
      to: leadKey,
      sessionId: team.members.find((m) => m.key === leadKey)?.sessionId ?? null,
      reason: "task-offline",
      receiptIds: [msg.id],
      ticket: notice,
    });
    await logEngineEvent(stateRoot, {
      event: "task-offline",
      teamId,
      member: key,
      evidence: hit.evidence,
      liveness: hit.liveness,
      idleForMin,
      taskIds: hit.tasks.map((t) => t.taskId),
      noticeTo: leadKey,
    });
  }
  return out;
}

// ─────────────────────────── ② 依赖解除（E-b ②，completed 专属） ───────────────────────────

/**
 * 对 completedTaskId 的就绪下游写 unblock-notice 帧（调用方持团队锁）。
 * 帧载荷（W5 FRAME_TYPES 白名单成员；§3.4-6「unblock-notice 里也会带上游结果摘要」）：
 * `{type:"unblock-notice", teamId, taskId, unblockedBy, dependencyOutputs}`。
 * 信封不带 attemptId（不做 freshness 绑定——收件人完成手头单之后该帧仍须可被消费，
 * 守则 v2 2a「优先看收件箱未读的 unblock-notice」才成立）。重复解除幂等：收件箱
 * 已有同任务的未读 notice 时不重发。
 * 唤醒条件（§5.1 E-b ②）：收件人无开放任务 ∧ 状态不在 {provisioning, failed, removed}。
 */
async function unblockDependentsLocked(
  stateRoot: string,
  team: TeamState,
  completedTaskId: string,
  now: number,
): Promise<{ unblocked: UnblockedTaskInfo[]; wakePlan: WakePlanItem[] }> {
  const teamId = team.teamId;
  const ready = downstreamReady(team.tasks, completedTaskId);
  if (ready.length === 0) return { unblocked: [], wakePlan: [] };

  // 扫描各成员邮箱定位派发对象（§9.1 findTaskRecipient 扫描辅助的调用侧；
  // 邮箱消息自带 .to，跨成员拼接后按 taskId 找 task-assignment 帧）。
  const mailboxes = new Map<string, TeamMessage[]>();
  const messagesOf = async (key: string): Promise<TeamMessage[]> => {
    const cached = mailboxes.get(key);
    if (cached !== undefined) return cached;
    const msgs = await readMailbox(stateRoot, teamId, key);
    mailboxes.set(key, msgs);
    return msgs;
  };
  const allMessages: TeamMessage[] = [];
  for (const m of team.members) allMessages.push(...(await messagesOf(m.key)));

  // 同一收件人的多张 notice 合并为一次唤醒（receiptIds 聚合；票面取最后一帧——
  // 唤醒回合首动作 xc_check_inbox 整体消费全部未读，tools.ts:389-394）。
  const perRecipient = new Map<string, { sessionId: string | null; ids: string[]; ticket: string; woken: boolean }>();
  const unblocked: UnblockedTaskInfo[] = [];

  for (const task of ready) {
    const recipient = findTaskRecipient(allMessages, task.id);
    if (recipient === undefined) continue; // 未派发过（无 task-assignment 帧）：不投
    const box = await messagesOf(recipient);
    const alreadyNoticed = box.some((m) => {
      if (m.readAt !== undefined || m.discardedAt !== undefined) return false;
      const frame = parseFrame(m.content);
      return frame?.["type"] === "unblock-notice" && frame?.["taskId"] === task.id;
    });
    if (alreadyNoticed) continue; // 幂等：该任务已有一张未读解除通知
    const notice = JSON.stringify({
      type: "unblock-notice",
      teamId,
      taskId: task.id,
      unblockedBy: completedTaskId,
      dependencyOutputs: collectDependencyOutputs(team.tasks, task.id),
    });
    const msg = createMessage("engine", recipient, notice, {
      taskId: task.id,
      sourceTaskId: completedTaskId,
      deliveryClaimedAt: now,
    });
    await appendMailbox(stateRoot, teamId, recipient, msg);

    // 唤醒判定：无开放任务 + 非供给中/失败/移除（§6.3 / §7.3.3）。
    const memberRecord = team.members.find((m) => m.key === recipient);
    const woken =
      memberOpenTasks(team.tasks, recipient).length === 0 && !blocksWake(memberProvisionState(memberRecord));
    const entry = perRecipient.get(recipient) ?? {
      sessionId: memberRecord?.sessionId ?? null,
      ids: [],
      ticket: notice,
      woken: false,
    };
    entry.ids.push(msg.id);
    entry.woken = entry.woken || woken;
    perRecipient.set(recipient, entry);
    unblocked.push({ taskId: task.id, recipient, messageId: msg.id, woken });
    await logEngineEvent(stateRoot, {
      event: "unblock-notice",
      teamId,
      taskId: task.id,
      unblockedBy: completedTaskId,
      to: recipient,
      woken,
    });
  }

  const wakePlan: WakePlanItem[] = [];
  for (const [to, entry] of perRecipient) {
    if (!entry.woken) continue;
    wakePlan.push({ to, sessionId: entry.sessionId, reason: "unblock", receiptIds: entry.ids, ticket: entry.ticket });
  }
  return { unblocked, wakePlan };
}

// ─────────────────────────── ②' 依赖死锁解除（A3 修复，failed/cancelled 专属） ───────────────────────────

/**
 * v0.5.3（A3 修复）：deadTaskId 进入 failed/cancelled 后，解除其全部死锁下游
 * （调用方持团队锁）。
 *
 * 旧约（§5.1 E-b ③）「failed/cancelled 不解除依赖，lead 决定重派」造成 adj052
 * A3 死锁：下游 pending 永久阻塞、零通知，唯一出路是创建者碰巧知道去手工
 * xc_cancel。新约：终态非 completed 的上游 = 其依赖闭包内的 pending 下游**确定
 * 死锁**（依赖解除只认 completed，终态无出边）——引擎自动把它们置 cancelled
 * （pending→cancelled 是 types.ts TASK_TRANSITIONS 的合法边；by="engine"、
 * history 记 `dependency-deadlock`，与人工 xc_cancel 的 "cancelled" 事件区分），
 * `task.error` 写明根因（观测面可见），回执（status:"cancelled"）入各任务
 * createdBy 邮箱并收集创建者唤醒计划（锁外执行，§2.7-4）。
 *
 * 幂等：deadlockedDependents 只收 pending，已解除/终态的下游天然跳过；无下游
 * （绝大多数 failed 任务）零成本返回。
 *
 * @param deadStatus 上游终态（回执与审计里写明根因链）。
 */
async function cascadeDependencyDeadlockLocked(
  stateRoot: string,
  team: TeamState,
  deadTaskId: string,
  deadStatus: "failed" | "cancelled",
  now: number,
): Promise<{ deadlocked: DeadlockedTaskInfo[]; wakePlan: WakePlanItem[] }> {
  const teamId = team.teamId;
  const tasks = deadlockedDependents(team.tasks, deadTaskId);
  if (tasks.length === 0) return { deadlocked: [], wakePlan: [] };

  const deadlocked: DeadlockedTaskInfo[] = [];
  const perCreator = new Map<string, { sessionId: string | null; ids: string[]; ticket: string; woken: boolean }>();
  for (const task of tasks) {
    // 引擎特权解除：走合法边 pending→cancelled，但根因是依赖死锁而非人工取消——
    // history 记 dependency-deadlock（区别于 xc_cancel 的 "cancelled" 事件）。
    task.status = "cancelled";
    task.error = `dependency-deadlock: upstream task ${deadTaskId} ${deadStatus} — this task can never start`;
    appendTaskHistory(task, "dependency-deadlock", "engine", undefined, now);
    // 回执（与 xc_cancel 的 cancelled 回执同构；cancelledBy=engine 表明自动解除）。
    const receipt = JSON.stringify({
      type: "task-receipt",
      teamId,
      taskId: task.id,
      attemptId: task.attemptId ?? "",
      status: "cancelled",
      result: null,
      error: task.error,
      evidence: [],
      cancelledBy: "engine",
    });
    const msg = createMessage("engine", task.createdBy, receipt, {
      taskId: task.id,
      sourceTaskId: deadTaskId,
      sourceTaskStatus: deadStatus,
      deliveryClaimedAt: now,
    });
    await appendMailbox(stateRoot, teamId, task.createdBy, msg);
    deadlocked.push({ taskId: task.id, createdBy: task.createdBy, messageId: msg.id, deadlockedBy: deadTaskId, woken: false });
    const memberRecord = team.members.find((m) => m.key === task.createdBy);
    const woken =
      memberOpenTasks(team.tasks, task.createdBy).length === 0
      && !blocksWake(memberProvisionState(memberRecord));
    const entry = perCreator.get(task.createdBy) ?? {
      sessionId: memberRecord?.sessionId ?? null,
      ids: [],
      ticket: receipt,
      woken: false,
    };
    entry.ids.push(msg.id);
    entry.woken = entry.woken || woken;
    perCreator.set(task.createdBy, entry);
    await logEngineEvent(stateRoot, {
      event: "dependency-deadlock",
      teamId,
      taskId: task.id,
      createdBy: task.createdBy,
      deadlockedBy: deadTaskId,
      deadStatus,
    });
  }

  const wakePlan: WakePlanItem[] = [];
  for (const [to, entry] of perCreator) {
    if (!entry.woken) continue;
    wakePlan.push({ to, sessionId: entry.sessionId, reason: "dependency-deadlock", receiptIds: entry.ids, ticket: entry.ticket });
  }
  // woken 结果回填进 deadlocked（唤醒判定在收集后统一完成）。
  for (const info of deadlocked) {
    info.woken = perCreator.get(info.createdBy)?.woken ?? false;
  }
  return { deadlocked, wakePlan };
}

// ─────────────────────────── 模块级边沿助手（E-b 边沿与周期清扫共用） ───────────────────────────

/** 边沿/清扫后的快照刷新：best-effort，失败审计（观测面失败永不影响工具结果，§7.3.1）。 */
async function refreshSnapshotBestEffort(deps: ToolDeps): Promise<void> {
  try {
    await refreshSnapshot(deps.stateRoot, DEFAULT_TEAM_ID);
  } catch (err) {
    await logEngineEvent(deps.stateRoot, {
      event: "snapshot-refresh-failed",
      teamId: DEFAULT_TEAM_ID,
      where: "task-edges",
      error: String(err instanceof Error ? err.message : err),
    });
  }
}

/** 锁内计划的锁外唤醒执行（attemptWake 必须在团队锁外，§2.7-4）。 */
async function runWakePlan(deps: ToolDeps, plan: readonly WakePlanItem[]): Promise<void> {
  for (const item of plan) {
    if (item.sessionId === null) continue; // 无 sessionId：mailbox 兜底（不 spawn）
    try {
      await attemptWake({
        stateRoot: deps.stateRoot,
        teamId: DEFAULT_TEAM_ID,
        toAgentKey: item.to,
        toSessionId: item.sessionId,
        workspace: deps.workspace,
        reason: item.reason,
        receiptIds: item.receiptIds,
        ticket: item.ticket,
        env: deps.env,
      });
    } catch (err) {
      // attemptWake 自身永不抛（信封内降级）；防御一层，保持边沿永不抛的约定。
      await logEngineEvent(deps.stateRoot, {
        event: "task-edges-failed",
        where: "wake-plan",
        to: item.to,
        error: String(err instanceof Error ? err.message : err),
      });
    }
  }
}

// ─────────────────────────── 周期清扫（故障注-8 修复：README L215 承诺兑现） ───────────────────────────

/**
 * 清扫节拍（毫秒）＝ 由阈值推导：threshold/6，钳制在 [10s, 60s]。
 * 阈值可配（XC_STALE_TASK_MINUTES）：阈值 1min → 10s 节拍（阈值到期后 ≤10s 内被清扫）；
 * 缺省 30min → 60s 节拍。下限保证极小阈值下不空转，上限保证大文件 team.json 不被高频重读。
 */
export function sweepTickMsFromThreshold(thresholdMs: number): number {
  return Math.max(10_000, Math.min(thresholdMs / 6, 60_000));
}

export interface StaleSweepSummary {
  swept: number;
  skipped: boolean;
  /** v0.7（C8，§4.2）：本轮被判离线的属主数（0 = 无离线命中；通知/审计细节在 engine.jsonl `task-offline`）。 */
  offline: number;
}

/**
 * 一轮独立清扫（与 E-b 边沿内的清扫同一条实现路径，只是触发源不同）：
 * 读盘预检（无锁、零候选即返回）→ 锁内重读 → 清扫 + 回执 + 审计 → 锁外唤醒 → 刷快照。
 *
 * 存在理由（故障注-8）：E-b 边沿清扫只在「有成员成功报告终态」时运行——成员死后
 * 再无报告，僵尸任务永不清扫。本函数由 MCP server 进程的周期定时器驱动
 * （startStaleSweeper），使「在途任务超阈值无更新」无论是否有其他成员活动都会被
 * 引擎兑现为「清扫回待领并回执派发方（lead 主导派发流中即队长）」。
 *
 * 永不抛出：team.json 缺失/损坏、锁忙（15s 等待超时）、IO 失败一律吞掉返回
 * skipped（损坏状态由故障注-1 的错误信封面负责，清扫面静默让路、下轮重试）。
 */
export async function sweepStaleTasksOnce(deps: ToolDeps, now: number = Date.now()): Promise<StaleSweepSummary> {
  const { stateRoot, env } = deps;
  const teamId = DEFAULT_TEAM_ID;
  try {
    const thresholdMs = staleThresholdMsFromEnv(env);
    // 无锁预检：没有僵尸候选就不碰锁（常态节拍的零成本路径）。
    const probe = await readTeam(stateRoot, teamId);
    if (probe === undefined || staleTasks(probe.tasks, now, thresholdMs).length === 0) {
      return { swept: 0, skipped: true, offline: 0 };
    }
    // v0.7（C8，§4.1/§4.2）：只读 peer 扫描在锁外做（查询路径无清扫副作用，
    // peerregistry.ts scanPeers 的 sweep:false 契约），活性/离线判据在锁内纯函数完成。
    const scan = await scanPeers(peerRootFromEnv(env), now, { sweep: false });
    const offlineThresholdMs = offlineThresholdMsFromEnv(env, thresholdMs).ms;
    const outcome = await withTeamLock(stateRoot, teamId, async () => {
      const team = await readTeam(stateRoot, teamId);
      if (team === undefined) {
        return { swept: [] as SweptTaskInfo[], wakePlan: [] as WakePlanItem[], offline: [] as OfflineMember[] };
      }
      const sweep = await sweepStaleTasksLocked(stateRoot, team, thresholdMs, now, { scan, offlineThresholdMs });
      if (sweep.swept.length > 0) await writeTeam(stateRoot, team);
      return sweep;
    });
    await runWakePlan(deps, outcome.wakePlan);
    if (outcome.swept.length > 0) await refreshSnapshotBestEffort(deps);
    return { swept: outcome.swept.length, skipped: false, offline: outcome.offline.length };
  } catch {
    // 永不抛出（withTaskEdges 同款纪律）：清扫面失败不影响任何工具结果，
    // 邮箱/团队真源兜底，下一轮节拍重算。
    return { swept: 0, skipped: true, offline: 0 };
  }
}

/**
 * v0.7 C6/C7（DESIGN-V0.7 §2.5/§2.6/§3.3，M3）：转办台账节拍——过期标记 + 回投 +
 * 终态清理。与 {@link sweepStaleTasksOnce} 同一个 setInterval 节拍（无新定时器），
 * 锁外 best-effort（台账/邮箱追加的原子性由 JSONL O_APPEND + 原子 rename 承担；
 * 失败不影响任务清扫，下轮重算）：
 *
 * 1. **过期**（§2.6 R5）：pending/approved 且 now ≥ expiresAt 的台账标 expired，
 *    回投请求方 `tool_result{status:"refused", reason:"request expired"}`（A 不在线
 *    躺箱的场景由本节拍收口——队内轴无活性闸，E4 §6.4）；lead 收过 approval_request
 *    通知的，补一条 `approval_result{decision:"expired"}` 收尾（§3.3）。
 * 2. **清理**（§3.3）：终态（executed/error/refused/denied/expired）台账与审批文件
 *    保留 TOOL_APPROVAL_KEEP_MS（7 天，常量不新增 env）后删除；邮箱帧不预清理
 *    （JSONL 追加真源纪律，v0.6 起不做 TTL）。
 *
 * 永不抛出：任何 IO 失败吞掉返回零计数（与 sweepStaleTasksOnce 同纪律）。
 */
export async function sweepToolRequestsOnce(deps: ToolDeps, now: number = Date.now()): Promise<{ expired: number; cleanedLedgers: number; cleanedApprovals: number }> {
  const { stateRoot } = deps;
  const empty = { expired: 0, cleanedLedgers: 0, cleanedApprovals: 0 };
  try {
    const expiredList = await expireToolRequests(stateRoot, now);
    for (const ledger of expiredList) {
      const frame = buildRefusedToolResult(ledger.requestId, ledger.tool, ledger.to, "request expired", now);
      const msg = createMessage(ledger.to, ledger.from, JSON.stringify(frame), { deliveryClaimedAt: now });
      await appendMailbox(stateRoot, DEFAULT_TEAM_ID, ledger.from, msg);
      await logEngineEvent(stateRoot, {
        event: "tool-expired",
        teamId: DEFAULT_TEAM_ID,
        requestId: ledger.requestId,
        from: ledger.from,
        to: ledger.to,
        tool: ledger.tool,
        expiresAt: ledger.expiresAt,
        receiptMessageId: msg.id,
      });
      // §3.3：lead 收过待批通知 → approval_result{expired} 收尾。
      if (ledger.approvalNotifiedAt !== undefined) {
        const team = await readTeam(stateRoot, DEFAULT_TEAM_ID);
        const leadKey = team !== undefined ? leadKeyOf(team) : null;
        if (leadKey !== null && leadKey !== "") {
          const closeFrame = buildApprovalResult(ledger.requestId, "expired", "engine", now);
          const closeMsg = createMessage("engine", leadKey, JSON.stringify(closeFrame), { deliveryClaimedAt: now });
          await appendMailbox(stateRoot, DEFAULT_TEAM_ID, leadKey, closeMsg);
          await logEngineEvent(stateRoot, {
            event: "tool-approval-request",
            teamId: DEFAULT_TEAM_ID,
            requestId: ledger.requestId,
            to: leadKey,
            closedAs: "expired",
            messageId: closeMsg.id,
          });
        }
      }
    }
    const cleaned = await cleanupToolArtifacts(stateRoot, now);
    if (cleaned.ledgers.length > 0 || cleaned.approvals.length > 0) {
      await logEngineEvent(stateRoot, {
        event: "tool-artifacts-cleaned",
        teamId: DEFAULT_TEAM_ID,
        ledgers: cleaned.ledgers.length,
        approvals: cleaned.approvals.length,
        keepMs: TOOL_APPROVAL_KEEP_MS,
      });
    }
    return { expired: expiredList.length, cleanedLedgers: cleaned.ledgers.length, cleanedApprovals: cleaned.approvals.length };
  } catch {
    // 永不抛出（清扫面纪律）：下轮节拍重算。
    return empty;
  }
}

/**
 * 启动周期清扫定时器（server.ts 在 main() 里调用；单测可直接驱动 sweepStaleTasksOnce）。
 * 节拍由 XC_STALE_TASK_MINUTES 推导（sweepTickMsFromThreshold）；定时器 unref——
 * 不改变进程退出语义（EOF 纪律的 shutdown 仍以 process.exit 收口）。
 * v0.7（C6/C7）：同一节拍顺带扫转办台账（过期标记+回投+7 天终态清理）——无新定时器。
 */
export function startStaleSweeper(deps: ToolDeps, intervalMs?: number): NodeJS.Timeout {
  const tick = intervalMs ?? sweepTickMsFromThreshold(staleThresholdMsFromEnv(deps.env));
  const timer = setInterval(() => {
    void sweepStaleTasksOnce(deps);
    void sweepToolRequestsOnce(deps);
  }, tick);
  timer.unref();
  return timer;
}

// ─────────────────────────── 包装器 ───────────────────────────

/**
 * W3 边沿包装（§9.2 签名）：base → withTaskEdges(base, deps)。
 * 只包装 xc_report / xc_dispatch，其余工具原样透传（同一函数引用）。
 */
export function withTaskEdges(core: ToolCore, deps: ToolDeps): ToolCore {
  const { stateRoot, env } = deps;

  return {
    ...core,
    async xc_dispatch(args, connectionKey) {
      const result = await core.xc_dispatch(args, connectionKey);
      // 边沿动作只追加在基座**成功**返回之后；错误信封原样透传（§11.1 不触碰校验路径）。
      if (result.isError === true) return result;
      const payload = payloadOf(result);
      if (typeof payload["taskId"] !== "string") return result;
      if (payload["delivered"] === "duplicate") return result; // 无状态变化，不刷快照
      await refreshSnapshotBestEffort(deps);
      return result;
    },

    async xc_report(args, connectionKey) {
      const result = await core.xc_report(args, connectionKey);
      if (result.isError === true) return result; // 错误信封：原样透传
      const payload = payloadOf(result);
      const taskId = payload["taskId"];
      const status = payload["status"];
      if (typeof taskId !== "string" || typeof status !== "string") return result;

      const teamId = DEFAULT_TEAM_ID;
      const now = Date.now();
      const outcome: TaskEdgeOutcome = { swept: [], unblocked: [], deadlocked: [], offline: [] };
      try {
        if (TERMINAL_TASK_STATUSES.includes(status as (typeof TERMINAL_TASK_STATUSES)[number])) {
          // E-b 边沿：① 清扫 → ② 依赖解除（completed）→ ②' 依赖死锁解除（failed）
          // （v0.5.3 A3 修复）；唤醒统一锁外。
          // v0.7（C8，§4.2）：离线判定的 peer 扫描在**锁外**做（只读 scanPeers，
          // 不持团队锁），结果随 sweepStaleTasksLocked 进锁内判据。
          const scan = await scanPeers(peerRootFromEnv(env), now, { sweep: false });
          const plan = await withTeamLock(stateRoot, teamId, async () => {
            const team = await readTeam(stateRoot, teamId);
            if (team === undefined) return [] as WakePlanItem[];
            const sweep = await sweepStaleTasksLocked(
              stateRoot,
              team,
              staleThresholdMsFromEnv(env),
              now,
              { scan, offlineThresholdMs: offlineThresholdMsFromEnv(env, staleThresholdMsFromEnv(env)).ms },
            );
            outcome.swept = sweep.swept;
            outcome.offline = sweep.offline;
            if (sweep.swept.length > 0) await writeTeam(stateRoot, team);
            if (status === "completed") {
              const unblock = await unblockDependentsLocked(stateRoot, team, taskId, now);
              outcome.unblocked = unblock.unblocked;
              return [...sweep.wakePlan, ...unblock.wakePlan];
            }
            if (status === "failed") {
              // v0.5.3（A3 修复）：failed 上游的 pending 下游确定死锁——自动解除
              // （置 cancelled）+ 回执/唤醒各任务创建者。cancelled 不经 xc_report
              // 产生（transitionTable 无此入边），此分支不处理。
              const deadlock = await cascadeDependencyDeadlockLocked(stateRoot, team, taskId, "failed", now);
              outcome.deadlocked = deadlock.deadlocked;
              if (deadlock.deadlocked.length > 0) await writeTeam(stateRoot, team);
              return [...sweep.wakePlan, ...deadlock.wakePlan];
            }
            return sweep.wakePlan;
          });
          await runWakePlan(deps, plan);
        }
        await refreshSnapshotBestEffort(deps);
      } catch (err) {
        // 永不抛出：边沿失败审计后吞掉，工具结果保持基座原样（邮箱真源兜底）。
        await logEngineEvent(stateRoot, {
          event: "task-edges-failed",
          teamId,
          taskId,
          reportStatus: status,
          error: String(err instanceof Error ? err.message : err),
        });
        return result;
      }

      // 成功信封追加边沿结果（第二 text 块机器可读；人可读首块保持基座原样）。
      const edges: Record<string, unknown> = {};
      if (outcome.swept.length > 0) edges["swept"] = outcome.swept;
      if (outcome.unblocked.length > 0) edges["unblocked"] = outcome.unblocked;
      if (outcome.deadlocked.length > 0) edges["deadlocked"] = outcome.deadlocked;
      if (outcome.offline.length > 0) edges["offline"] = outcome.offline; // v0.7（C8，§4.2）
      if (Object.keys(edges).length === 0) return result;
      return {
        ...result,
        content: [
          result.content[0]!,
          { type: "text", text: JSON.stringify({ ...payload, edges }, null, 2) },
        ],
      };
    },
  };
}

// §9.2 对外接口：W3 的图计算件经本模块再出口（W2/W4 也可直接 import core/graph.js）。
export {
  collectDependencyOutputs,
  deadlockedDependents,
  downstreamReady,
  findTaskRecipient,
  revokeAttempt,
  staleTasks,
} from "../core/graph.js";

// v0.5.3（A3 修复）：依赖死锁解除的锁内实现——xc_report(failed) 边沿（本模块）
// 与 xc_cancel 边沿（lead-tools.ts）共用同一条解除路径。
export { cascadeDependencyDeadlockLocked };
