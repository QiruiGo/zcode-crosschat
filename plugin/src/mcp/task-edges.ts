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
 *      failed/cancelled 不解除依赖（下游保持阻塞，lead 决定重派，§5.1 E-b ③）；
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
import type { ToolCore, ToolDeps } from "./tools.js";
import { findInflightWakeNonce } from "../core/registry.js";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { withTeamLock } from "../core/lock.js";
import { memberOpenTasks, readTeam, writeTeam } from "../core/teamstate.js";
import {
  collectDependencyOutputs,
  downstreamReady,
  findTaskRecipient,
  revokeAttempt,
  staleTasks,
} from "../core/graph.js";
import { refreshSnapshot } from "../core/snapshot.js";
import {
  DEFAULT_TEAM_ID,
  TERMINAL_TASK_STATUSES,
  type TeamMessage,
  type TeamState,
} from "../core/types.js";
import { attemptWake } from "../engine/wake.js";

// ─────────────────────────── 配置解析（V18 同款防御） ───────────────────────────

const DEFAULT_STALE_TASK_MINUTES = 30;

/** XC_STALE_TASK_MINUTES → 毫秒；非有限正数取默认 30min（§5.4 / plugin.json §10.1）。 */
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

export interface TaskEdgeOutcome {
  swept: SweptTaskInfo[];
  unblocked: UnblockedTaskInfo[];
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
 */
async function sweepStaleTasksLocked(
  stateRoot: string,
  team: TeamState,
  thresholdMs: number,
  now: number,
): Promise<{ swept: SweptTaskInfo[]; wakePlan: WakePlanItem[] }> {
  const teamId = team.teamId;
  const candidates = staleTasks(team.tasks, now, thresholdMs);
  const swept: SweptTaskInfo[] = [];
  const wakePlan: WakePlanItem[] = [];
  const seenRecipients = new Set<string>();
  for (const task of candidates) {
    // 豁免条件（§5.4）：该成员有在途 wake nonce → 本次跳过（唤醒回合可能仍在跑，
    // 其下一份 report/心跳会刷新 updatedAt）。
    if (task.assignee !== null) {
      const inflight = await findInflightWakeNonce(stateRoot, task.assignee, { teamId, now });
      if (inflight !== undefined) continue;
    }
    const assigneeBefore = task.assignee;
    const revokedAttemptId = task.attemptId;
    const staleMinutes = Math.max(1, Math.round((now - task.updatedAt) / 60_000));
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
  }
  return { swept, wakePlan };
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
      return { swept: 0, skipped: true };
    }
    const outcome = await withTeamLock(stateRoot, teamId, async () => {
      const team = await readTeam(stateRoot, teamId);
      if (team === undefined) return { swept: [] as SweptTaskInfo[], wakePlan: [] as WakePlanItem[] };
      const sweep = await sweepStaleTasksLocked(stateRoot, team, thresholdMs, now);
      if (sweep.swept.length > 0) await writeTeam(stateRoot, team);
      return sweep;
    });
    await runWakePlan(deps, outcome.wakePlan);
    if (outcome.swept.length > 0) await refreshSnapshotBestEffort(deps);
    return { swept: outcome.swept.length, skipped: false };
  } catch {
    // 永不抛出（withTaskEdges 同款纪律）：清扫面失败不影响任何工具结果，
    // 邮箱/团队真源兜底，下一轮节拍重算。
    return { swept: 0, skipped: true };
  }
}

/**
 * 启动周期清扫定时器（server.ts 在 main() 里调用；单测可直接驱动 sweepStaleTasksOnce）。
 * 节拍由 XC_STALE_TASK_MINUTES 推导（sweepTickMsFromThreshold）；定时器 unref——
 * 不改变进程退出语义（EOF 纪律的 shutdown 仍以 process.exit 收口）。
 */
export function startStaleSweeper(deps: ToolDeps, intervalMs?: number): NodeJS.Timeout {
  const tick = intervalMs ?? sweepTickMsFromThreshold(staleThresholdMsFromEnv(deps.env));
  const timer = setInterval(() => {
    void sweepStaleTasksOnce(deps);
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
      const outcome: TaskEdgeOutcome = { swept: [], unblocked: [] };
      try {
        if (TERMINAL_TASK_STATUSES.includes(status as (typeof TERMINAL_TASK_STATUSES)[number])) {
          // E-b 边沿：① 清扫 → ② 依赖解除（顺序按 §5.1 E-b）；唤醒统一锁外。
          const plan = await withTeamLock(stateRoot, teamId, async () => {
            const team = await readTeam(stateRoot, teamId);
            if (team === undefined) return [] as WakePlanItem[];
            const sweep = await sweepStaleTasksLocked(stateRoot, team, staleThresholdMsFromEnv(env), now);
            outcome.swept = sweep.swept;
            if (sweep.swept.length > 0) await writeTeam(stateRoot, team);
            if (status !== "completed") return sweep.wakePlan;
            const unblock = await unblockDependentsLocked(stateRoot, team, taskId, now);
            outcome.unblocked = unblock.unblocked;
            return [...sweep.wakePlan, ...unblock.wakePlan];
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
  downstreamReady,
  findTaskRecipient,
  revokeAttempt,
  staleTasks,
} from "../core/graph.js";
