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
import { findInflightWakeNonce, readSession, readSessionWitness } from "../core/registry.js";
// v0.9（G-9/G-5）：清扫联动活性的纯判据（owner-running / 心跳代理豁免）。
// v0.9.1（V090-01/06）：可信度校验（未来值/无时刻的 running 不豁免）+ 异常检测与
// 豁免留痕（task-sweep-deferred / session-record-anomaly）。
// v0.9.1 r3（V090-01，V090-GUIDANCE-R3）：豁免输入收敛为**引擎证言**（witness），
// 自述记录仅展示；豁免有界（2× 阈值无证言照扫）。
import {
  sessionRecordLivenessAnomaly,
  sessionRecordWitnessMismatch,
  sweepOwnerGuard,
  sweepOwnerGuardReason,
  type SessionWitness,
  type SweepOwnerGuard,
} from "../core/liveness.js";
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
import {
  cleanupToolArtifacts,
  expireToolRequests,
  listToolRequests,
  transitionToolRequest,
  TOOL_APPROVAL_KEEP_MS,
  type ToolRequestLedger,
} from "../core/toolledger.js";
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
 * 发转交通知**（属主非 lead → 通知 lead；属主即 lead → 通知其他在册成员，v0.8.1
 * C6-BUG-4 修复）+ 唤醒计划，并进 `offline` 返回面 / `task-offline` 审计（两种属主
 * 身份都恒定落审计）。回池路径本身不新开：仍是 stale sweeper 的 revokeAttempt
 * （§4.2「复用 sweeper」）。`opts` 缺省 = 不产离线判定（旧调用点零行为变化）。
 *
 * v0.9（G-5 清扫联动活性，PROTOCOL §12.4）：wake-nonce 豁免之后新增**属主活性豁免**
 * ——属主会话 `running`（回合执行中）→ 暂停 stale 倒计时；属主在 stale 窗口内有过
 * 引擎事件（registry lastEventTs 心跳代理）→ 不要求手动 xc_report 打卡（GAP t1/t17
 * 误扫的两个模式）。判据纯函数在 core/liveness.ts（sweepOwnerGuard）；`dead`
 * （C8 pid-dead 硬证据）不豁免——崩溃成员照旧回池 + 转交通知；blocked 不在
 * SWEEPABLE 清扫域的旧口径不变。
 * v0.9.1（V090-06）：豁免逐周期留痕 `task-sweep-deferred`（epoch 去重）。
 * v0.9.1 r2（V090-01/05）：豁免要求**端点活性证词**（peer 注册表 live，单文件伪造
 * 60s 衰减失效）；豁免**不壅蔽 C8**——豁免任务仍算 offlineVerdict，命中即 lead
 * 转交通知（offlineNoticeAt 持久闸防逐节拍刷邮箱），豁免只暂停回池不遮蔽离线信号。
 */
async function sweepStaleTasksLocked(
  stateRoot: string,
  team: TeamState,
  thresholdMs: number,
  now: number,
  opts: { scan?: PeerScanResult; offlineThresholdMs?: number } = {},
): Promise<{ swept: SweptTaskInfo[]; wakePlan: WakePlanItem[]; offline: OfflineMember[]; exemptOfflineNotified: boolean }> {
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
  // v0.9.1（V090-05 r2）：豁免任务的 C8 转交通知是否落过（写 team 的依据之一——
  // offlineNoticeAt 字段随通知落盘，豁免不清扫也要持久化）。
  let exemptOfflineNotified = false;
  for (const task of candidates) {
    // 豁免条件（§5.4）：该成员有在途 wake nonce → 本次跳过（唤醒回合可能仍在跑，
    // 其下一份 report/心跳会刷新 updatedAt）。进程死证据**不绕过**豁免（nonce 有
    // TTL，保守优先；§4.2 边界）。
    if (task.assignee !== null) {
      const inflight = await findInflightWakeNonce(stateRoot, task.assignee, { teamId, now });
      if (inflight !== undefined) continue;
    }
    // 豁免条件（v0.9 G-5）：属主会话活性（running / stale 窗口内心跳代理）→ 跳过。
    // v0.9.1（V090-06）：豁免**必须留痕**——每任务每阈值周期一行 `task-sweep-deferred`
    // （epoch 去重，进程内台账；running 保护下的长任务不逐 60s 节拍刷日志，但 lead 在
    // 时间线/审计里看得到「这单被活性豁免到第 N 个周期」+ 证言年龄），伪造/损坏自述
    // 的异常另落 `session-record-anomaly`（ownerSweepGuard 内）。
    // v0.9.1（V090-05 r2）：豁免**不壅蔽 C8**——豁免任务仍算 offlineVerdict，命中
    // （process-dead / idle-timeout）即照常 lead 转交通知（持久闸防逐节拍刷邮箱）；
    // 豁免只暂停回池，不再遮蔽离线信号。v0.9.1 r3（V090-02）：豁免任务的通知文案
    // 如实写「未回池、仍滞留属主名下」（requeued:false），不再谎称已回待领池。
    if (task.assignee !== null) {
      const exempt = await ownerSweepGuard(stateRoot, team, task.assignee, opts.scan, now, thresholdMs);
      if (exempt !== null) {
        const member = team.members.find((m) => m.key === task.assignee);
        if (
          member !== undefined
          && opts.scan !== undefined
          && opts.offlineThresholdMs !== undefined
          && now - (task.offlineNoticeAt ?? 0) >= opts.offlineThresholdMs
        ) {
          const liveness = memberLiveness(member, opts.scan, now);
          const verdict = offlineVerdict(task, member, liveness, now, opts.offlineThresholdMs);
          if (verdict.offline && verdict.evidence !== null) {
            const entry = offlineHits.get(task.assignee) ?? {
              member,
              liveness,
              evidence: verdict.evidence,
              tasks: [],
            };
            entry.tasks.push({
              taskId: task.id,
              title: task.title,
              status: task.status,
              idleForMin: Math.max(1, Math.round((now - lastProgressTs(task)) / 60_000)),
              requeued: false, // r3（V090-02）：活性豁免滞留，未回池
            });
            offlineHits.set(task.assignee, entry);
            task.offlineNoticeAt = now;
            exemptOfflineNotified = true;
          }
        }
        await auditSweepDeferred(stateRoot, teamId, task, exempt.guard, exempt.peerLiveness, exempt.witnessAgeMin, now, thresholdMs);
        continue;
      }
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
      entry.tasks.push({
        taskId: task.id,
        title: task.title,
        status: offlineHit.status,
        idleForMin: offlineHit.idleForMin,
        requeued: true, // r3（V090-02）：真回池（本任务刚被 revokeAttempt 重置回 pending）
      });
      offlineHits.set(assigneeBefore, entry);
    }
  }
  const offline = await notifyOfflineLeadLocked(stateRoot, team, offlineHits, wakePlan, now);
  return { swept, wakePlan, offline, exemptOfflineNotified };
}

/**
 * v0.9（G-5）：属主活性豁免的取数薄封装——会话记录（registry lastSeen 同源读，
 * 只读不加锁）+ C8 peer 扫描交给 core/liveness.ts 的纯判据 sweepOwnerGuard。
 * 成员不在册（派发后被 member-stop 回池等瞬态）→ 不豁免（null）。读失败按无
 * 记录处理（保守：不豁免，真僵尸照扫）。
 *
 * v0.9.1（V090-06）：异常记录审计——活性字段违反自写不变式（running 无可信
 * livenessTs / 时间戳在未来值域，core/liveness.ts sessionRecordLivenessAnomaly）
 * 的记录**不产生豁免**（纯判据已按保守口径降级），此处据实落 `session-record-anomaly`
 * 审计（进程内按「状态根 × 会话 × 字段」去重一次；engine.jsonl 是跨进程权威）。
 * v0.9.1 r2（V090-01/05）：返回值带 peerLiveness（C8 四态）——豁免审计据此区分
 * 「有端点证词的豁免」与不可辨形态；纯判据内部已强制 endpointLive 闸。
 */
/**
 * v0.9（G-5）：属主活性豁免的取数薄封装——读引擎证言（registry/witness/<sid>.json，
 * 只读不加锁）交给 core/liveness.ts 的纯判据 sweepOwnerGuard。
 * 成员不在册（派发后被 member-stop 回池等瞬态）→ 不豁免（null）。
 *
 * v0.9.1 r3（V090-01，V090-GUIDANCE-R3）：豁免输入**只有引擎证言**——自述记录
 * （sessions/<sid>.json 的 liveness/lastEventTs）可被一次本地文件写伪造，且成员自有
 * MCP server 全会话常驻使端点活性证词（r2 修法）同样可被攻击者满足；证言由引擎进程
 * 分路写（hooks 回合边界 + 工具调用心跳），伪造自述造不出证言。
 * 自述 vs 证言的不一致（记录声称 running 而无证言/证言止于 idle）与未来值异常一并落
 * `session-record-anomaly`（进程内按状态根×会话×字段去重一次；engine.jsonl 权威）。
 */
async function ownerSweepGuard(
  stateRoot: string,
  team: TeamState,
  assignee: string,
  scan: PeerScanResult | undefined,
  now: number,
  thresholdMs: number,
): Promise<{ guard: SweepOwnerGuard; peerLiveness: MemberLiveness; witnessAgeMin: number } | null> {
  const member = team.members.find((m) => m.key === assignee);
  if (member === undefined) return null;
  let witness: SessionWitness | undefined;
  try {
    witness = await readSessionWitness(stateRoot, member.sessionId);
  } catch {
    witness = undefined;
  }
  // 审计：自述异常（未来值 / 自述 running 而无证言）——不阻断豁免判定（证言已是唯一输入）。
  try {
    const record = await readSession(stateRoot, member.sessionId);
    const anomaly = sessionRecordLivenessAnomaly(record, now) ?? sessionRecordWitnessMismatch(record, witness, now);
    if (anomaly !== null) {
      const memoKey = `${stateRoot}:${member.sessionId}:${anomaly.field}`;
      if (!anomalyAuditMemo.has(memoKey)) {
        memoAddBounded(anomalyAuditMemo, memoKey, ANOMALY_AUDIT_MEMO_LIMIT);
        await logEngineEvent(stateRoot, {
          event: "session-record-anomaly",
          sessionId: member.sessionId,
          member: assignee,
          field: anomaly.field,
          detail: anomaly.detail,
        });
      }
    }
  } catch {
    /* 记录读失败：证言判定不受影响（自述本就只作展示） */
  }
  // 端点活性仅展示（r3 起非豁免输入）：成员自有 server 常驻，live 不构成安全证据；
  // 但 pid-dead 仍是 C8 immediacy 的硬开关（见下）。
  const peerLiveness: MemberLiveness = scan !== undefined ? memberLiveness(member, scan, now) : "no-record";
  const guard = sweepOwnerGuard(witness, now, thresholdMs);
  if (guard === null) return null;
  // C8 immediacy（§4.1 口径不变）：pid-dead 硬证据在场 → 活性豁免立即失效（不等证言
  // 衰减到阈值）——崩溃成员名下任务照旧回池 + 转交通知。证言只对活成员有意义。
  if (peerLiveness === "pid-dead") return null;
  return {
    guard,
    peerLiveness,
    witnessAgeMin: Math.max(0, Math.round((now - (witness?.ts ?? now)) / 60_000)),
  };
}

// v0.9.1（V090-06）：豁免/异常审计的进程内去重台账（engine.jsonl 是跨进程权威）。
// deferred：任务 → 已审计的超阈周期（epoch）——每任务每阈值周期一行，不逐 60s 节拍刷；
// anomaly：状态根×会话×字段——伪造/损坏字段一次留痕即可（之后同异常不重复刷）。
const deferredAuditMemo = new Map<string, number>();
const anomalyAuditMemo = new Set<string>();
const DEFERRED_AUDIT_MEMO_LIMIT = 1024;
const ANOMALY_AUDIT_MEMO_LIMIT = 1024;

/** 有界台账写入（超限丢最早插入的键；Map 保序）。 */
function memoAddBounded(set: Set<string>, key: string, limit: number): void {
  set.add(key);
  if (set.size > limit) {
    const oldest = set.values().next();
    if (!oldest.done) set.delete(oldest.value);
  }
}

/** 任务的超阈周期序（1 起）：floor(超阈时长 / 阈值)——豁免审计的去重刻度。 */
function sweepDeferredEpoch(task: { updatedAt: number }, now: number, thresholdMs: number): number {
  return Math.max(1, Math.floor((now - task.updatedAt) / thresholdMs));
}

/**
 * v0.9.1（V090-06）：活性豁免的审计留痕 `task-sweep-deferred`（family=sweep）。
 * 去重刻度 = 超阈周期（epoch）：豁免从第 N 个周期跨到 N+1 时再落一行——一条被
 * running 保护 2h 的任务留 ~4 行（而非每个清扫节拍 120 行），时间线（timeline 视图）
 * 与审计从此能回答「这单为什么一直没被扫」。
 * v0.9.1 r2（V090-01/05）：事件带 `peerLiveness`（C8 四态）——豁免必然伴随端点
 * 活性证词（sweepOwnerGuard 的 endpointLive 闸），`reason=owner-running ∧
 * peerLiveness=live`（有证词）与无证词形态在审计上可辨。
 */
async function auditSweepDeferred(
  stateRoot: string,
  teamId: string,
  task: { id: string; assignee: string | null; updatedAt: number },
  guard: SweepOwnerGuard,
  peerLiveness: MemberLiveness,
  witnessAgeMin: number,
  now: number,
  thresholdMs: number,
): Promise<void> {
  const epoch = sweepDeferredEpoch(task, now, thresholdMs);
  const memoKey = `${stateRoot}:${task.id}`;
  const prior = deferredAuditMemo.get(memoKey) ?? 0;
  if (epoch <= prior) return;
  deferredAuditMemo.delete(memoKey);
  deferredAuditMemo.set(memoKey, epoch);
  if (deferredAuditMemo.size > DEFERRED_AUDIT_MEMO_LIMIT) {
    const oldest = deferredAuditMemo.keys().next();
    if (!oldest.done) deferredAuditMemo.delete(oldest.value);
  }
  await logEngineEvent(stateRoot, {
    event: "task-sweep-deferred",
    teamId,
    taskId: task.id,
    assignee: task.assignee,
    reason: guard,
    peerLiveness,
    witnessAgeMin,
    staleMinutes: Math.max(1, Math.round((now - task.updatedAt) / 60_000)),
    epoch,
    note: sweepOwnerGuardReason(guard),
  });
}

/**
 * C8（§4.2）：离线属主的转交通知（调用方持团队锁；邮箱帧 + 唤醒计划项）。
 *
 * 帧型 = `task-receipt`（W5 白名单既有成员，任务域引擎回执；**不新添帧型**——帧型属
 * M1 的 mailbox.ts，且 C6/C7 的四个新帧型都是转办/审批语义，与离线转交无关）。载荷在
 * stale-swept 回执之外多带一个 `offline` 块（属主/证据/活性/任务清单/转交建议），
 * status 仍为 "failed"——不触发 mailbox.staleCompletedReceiptTaskIds 的
 * 「completed 回执 vs 未完成任务板矛盾」检测（该检测只认 completed）。
 *
 * 收件人规则（v0.8.1，29 红队 C6-BUG-4 修复）：
 * - 离线属主**不是** lead → 通知 lead（原口径：lead 用 xc_dispatch 重派）；
 * - 离线属主**就是** lead 自己（ founder 兜底同判）→ 原实现整体跳过「通知 + 审计」，
 *   而「lead 崩溃」恰是 C8 最该留信号的场景（红队 lane-b4：presweep status 已能检出
 *   pid-dead，sweep 却零 task-offline；lane-b4c 对照组非 lead 崩溃五件套齐全）。
 *   通知崩溃者自己的邮箱无接收意义（C6 裁决原话），故改投**其他在册成员**（有
 *   sessionId 的可寻址队友）——队友才能认领回池的任务 / 接手指引；无人可通知时
 *   只落审计（noticeTo:null）。
 * - `task-offline` 审计**恒定落地**（两种属主身份都不再缺席），noticeTo 记实际收件人
 *   （多个 = 逗号连接；无 = null）。
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
    // v0.9.1 r3（V090-02）：通知文案分流——真回池（任务已 revokeAttempt 重置回 pending）
    // 与活性豁免滞留（任务仍在属主名下、未回池）是两种事实，旧文案一律声称「requeued to
    // the pending pool」对豁免任务是谎报：lead 按通知去待领池找不到任务。豁免版如实写
    // 「仍滞留 <成员> 名下（活性豁免），未回池」并附处置指引（cancel / xc_dispatch 改派）。
    const lodged = hit.tasks.filter((t) => t.requeued === false);
    const requeued = hit.tasks.filter((t) => t.requeued !== false);
    const disposition = lodged.length === 0
      ? 'open task(s) requeued to the pending pool'
      : requeued.length === 0
        ? `open task(s) still held by "${key}" under liveness exemption — NOT requeued; cancel via xc_team({action:"cancel"}) or reassign via xc_dispatch`
        : `open task(s) split: ${requeued.length} requeued to the pending pool, ${lodged.length} still held by "${key}" under liveness exemption (NOT requeued)`;
    const error = `offline-handover: member "${key}" looks gone (${hit.evidence}) — ${disposition}`;
    // 收件人：属主非 lead → lead 本人；属主即 lead → 其他在册成员（可寻址队友）。
    const recipients: Array<{ key: string; sessionId: string | null }> = key === leadKey
      ? team.members
        .filter((m) => m.key !== leadKey && typeof m.sessionId === 'string' && m.sessionId !== '')
        .map((m) => ({ key: m.key, sessionId: m.sessionId ?? null }))
      : [{ key: leadKey, sessionId: team.members.find((m) => m.key === leadKey)?.sessionId ?? null }];
    const notice = JSON.stringify({
      type: "task-receipt",
      teamId,
      taskId: hit.tasks[0]!.taskId,
      attemptId: null,
      status: "failed",
      result: null,
      error,
      evidence: [],
      offline: {
        member: key,
        evidence: hit.evidence,
        liveness: hit.liveness,
        idleForMin,
        taskIds: hit.tasks.map((t) => t.taskId),
        // r3（V090-02）：逐任务回池事实（豁免滞留 = false），机器可读。
        tasks: hit.tasks.map((t) => ({ taskId: t.taskId, status: t.status, idleForMin: t.idleForMin, requeued: t.requeued !== false })),
        suggestion: offlineSuggestion(hit.evidence),
      },
    });
    for (const recipient of recipients) {
      const msg = createMessage("engine", recipient.key, notice, { deliveryClaimedAt: now });
      await appendMailbox(stateRoot, teamId, recipient.key, msg);
      wakePlan.push({
        to: recipient.key,
        sessionId: recipient.sessionId,
        reason: "task-offline",
        receiptIds: [msg.id],
        ticket: notice,
      });
    }
    await logEngineEvent(stateRoot, {
      event: "task-offline",
      teamId,
      member: key,
      evidence: hit.evidence,
      liveness: hit.liveness,
      idleForMin,
      taskIds: hit.tasks.map((t) => t.taskId),
      noticeTo: recipients.length === 0
        ? null
        : recipients.length === 1
          ? recipients[0]!.key
          : recipients.map((r) => r.key).join(","),
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
    // v0.9（G-5）：无锁预检延伸——候选全部被属主活性豁免（running / 心跳代理，
    // t17 长任务模式的常态）也不碰锁。无属主候选（异常记录）不走豁免（照旧进锁
    // 清扫）；锁内 sweepStaleTasksLocked 仍按锁内状态重算豁免（竞态安全：预检只
    // 省锁周期，不放行任何清扫）。v0.9.1（V090-06）：全豁免跳过同样逐任务留痕
    // （task-sweep-deferred，epoch 去重——不留痕则全保护盘面在 engine.jsonl 零痕迹）。
    // v0.9.1 r2（V090-05）：豁免不壅蔽 C8——预检对豁免候选同样算 offlineVerdict，
    // 命中（通知闸开启时）→ 不跳过、进锁走正式通知路径（预检无锁不写 team，通知
    // 与 offlineNoticeAt 落盘都在锁内完成）。
    const probeCandidates = staleTasks(probe.tasks, now, thresholdMs);
    const probeOfflineThresholdMs = offlineThresholdMsFromEnv(env, thresholdMs).ms;
    let allProtected = probeCandidates.length > 0 && probeCandidates.every((t) => t.assignee !== null);
    let protectedOfflineHit = false;
    if (allProtected) {
      for (const candidate of probeCandidates) {
        const exempt = await ownerSweepGuard(stateRoot, probe, candidate.assignee!, scan, now, thresholdMs);
        if (exempt === null) {
          allProtected = false;
          break;
        }
        await auditSweepDeferred(stateRoot, teamId, candidate, exempt.guard, exempt.peerLiveness, exempt.witnessAgeMin, now, thresholdMs);
        // 豁免候选的 C8 兜底：通知闸开启（从未通知 / 距上次 ≥ 阈值窗口）且
        // idle-timeout 命中 → 不跳过，进锁由 sweepStaleTasksLocked 正式通知。
        const member = probe.members.find((m) => m.key === candidate.assignee);
        if (
          member !== undefined
          && now - (candidate.offlineNoticeAt ?? 0) >= probeOfflineThresholdMs
        ) {
          const verdict = offlineVerdict(candidate, member, exempt.peerLiveness, now, probeOfflineThresholdMs);
          if (verdict.offline && verdict.evidence !== null) protectedOfflineHit = true;
        }
      }
      if (allProtected && !protectedOfflineHit) return { swept: 0, skipped: true, offline: 0 };
    }
    const offlineThresholdMs = offlineThresholdMsFromEnv(env, thresholdMs).ms;
    const outcome = await withTeamLock(stateRoot, teamId, async () => {
      const team = await readTeam(stateRoot, teamId);
      if (team === undefined) {
        return { swept: [] as SweptTaskInfo[], wakePlan: [] as WakePlanItem[], offline: [] as OfflineMember[], exemptOfflineNotified: false };
      }
      const sweep = await sweepStaleTasksLocked(stateRoot, team, thresholdMs, now, { scan, offlineThresholdMs });
      if (sweep.swept.length > 0 || sweep.exemptOfflineNotified) await writeTeam(stateRoot, team);
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
 * 2. **通知收尾**（§11.4，v0.7.2 C7-B5 修复）：lead 收过待批通知、但请求停在
 *    refused/denied（门拒后始终无人批准）且窗口已关闭的，补一条
 *    `approval_result{decision:"expired"}`——只通知不改台账（拒绝态已有结论）。
 *    旧实现只有第 1 步的收尾，而「被通知⇒已读⇒门拒⇒永不被扫」使该分支不可达
 *    （裁决日志 c7b5b.jsonl：lead 邮箱只有 approval_request、无任何过期回执）。
 * 3. **清理**（§3.3）：终态（executed/error/refused/denied/expired）台账与审批文件
 *    保留 TOOL_APPROVAL_KEEP_MS（7 天，常量不新增 env）后删除；邮箱帧不预清理
 *    （JSONL 追加真源纪律，v0.6 起不做 TTL）。
 *
 * 多进程幂等（v0.7.2 B-02 修复）：过期迁移在**团队锁内**完成，且
 * {@link expireToolRequests} 只把「本调用真正落盘」的台账算进 expired 列表——
 * 同相位竞态的其它进程读到已 expired（闸不命中）→ 不进列表 → 不回投。
 *
 * 永不抛出：任何 IO 失败吞掉返回零计数（与 sweepStaleTasksOnce 同纪律）。
 */
export async function sweepToolRequestsOnce(deps: ToolDeps, now: number = Date.now()): Promise<{ expired: number; cleanedLedgers: number; cleanedApprovals: number }> {
  const { stateRoot } = deps;
  const empty = { expired: 0, cleanedLedgers: 0, cleanedApprovals: 0 };
  try {
    // 锁内过期：跨进程只有一个赢家能迁移并拿到回投清单（B-02）。
    const expiredList = await withTeamLock(stateRoot, DEFAULT_TEAM_ID, () => expireToolRequests(stateRoot, now));
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
        await closeLeadApprovalRequest(stateRoot, ledger, now, "expired");
      }
    }
    // §11.4（C7-B5）：通知过但停在拒绝态、窗口已关闭 → 收尾（不迁移台账）。
    for (const ledger of await listToolRequests(stateRoot)) {
      if (ledger.approvalNotifiedAt === undefined || ledger.approvalClosedAt !== undefined) continue;
      if (ledger.state !== "refused" && ledger.state !== "denied") continue;
      if (now < ledger.expiresAt) continue;
      const closed = await transitionToolRequest(stateRoot, ledger.requestId, ["refused", "denied"], (l) => ({
        ...l,
        approvalClosedAt: now,
      }));
      if (closed !== undefined) await closeLeadApprovalRequest(stateRoot, closed, now, "expired");
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
 * 向现任 lead 补一条 `approval_result` 收尾帧（§3.3/§11.4）：lead 收过待批通知的
 * 请求走到窗口关闭时，给通知方一个终态信号。只发通知，不带授权语义；无 lead 时
 * 静默跳过（审计已由 tool-expired / tool-approval-request 留痕）。
 */
async function closeLeadApprovalRequest(stateRoot: string, ledger: ToolRequestLedger, now: number, decision: "expired"): Promise<void> {
  const team = await readTeam(stateRoot, DEFAULT_TEAM_ID);
  const leadKey = team !== undefined ? leadKeyOf(team) : null;
  if (leadKey === null || leadKey === "") return;
  const closeFrame = buildApprovalResult(ledger.requestId, decision, "engine", now);
  const closeMsg = createMessage("engine", leadKey, JSON.stringify(closeFrame), { deliveryClaimedAt: now });
  await appendMailbox(stateRoot, DEFAULT_TEAM_ID, leadKey, closeMsg);
  await logEngineEvent(stateRoot, {
    event: "tool-approval-request",
    teamId: DEFAULT_TEAM_ID,
    requestId: ledger.requestId,
    to: leadKey,
    closedAs: decision,
    messageId: closeMsg.id,
  });
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
            // v0.9.1 r2（V090-05）：豁免任务的 C8 转交通知落盘（offlineNoticeAt）也触发写盘。
            if (sweep.swept.length > 0 || sweep.exemptOfflineNotified) await writeTeam(stateRoot, team);
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
