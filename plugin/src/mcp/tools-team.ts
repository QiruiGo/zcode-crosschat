/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T8）：xc_team —— 指挥族合一（action 分发）。
 *
 * 合并 init/transfer/release/member-add/member-stop/idle/cancel/unblock 各旧指挥
 * 工具的调用面；每个 action 的核心逻辑 = 现行对应工具原样平移（v0.5.3 的
 * core 函数整体迁入，
 * 权限矩阵不变：init/transfer/release/member-add/member-stop 仅 lead；cancel
 * 仅 lead 或任务创建者；idle 是成员自己上报；unblock 允许 lead、任务创建者或
 * 该任务认领者）。
 *
 * v0.6 增量：
 * - `unblock`（C2，§3.2）：blocked 任务解除——回 preBlockedStatus + unblock-notice
 *   帧回投认领者 + 尽力唤醒；core 半边 = teamstate.unblockTask（M2）。
 * - `member-stop` 增 `archive`（C4，§3.4，缺省 true）：停止前先写
 *   `.crosschat/archive/<name>/`（journal.md + meta.json，core/archive.ts）；
 *   写失败不阻断停止（任务照常回池 = 「不丢」），失败详情入 payload + 审计。
 *
 * 身份/并发纪律与 tools.ts 完全一致（identityStore.require(connectionKey)；
 * attemptWake 只在团队锁外）。
 *
 * v0.8.0（A1，DESIGN-V0.8.md §3）增量：`checkpoint` action——服务端直接落盘 7 章
 * 交接检查点到 `.crosschat/checkpoints/<me>/<ISO>.md`（core/checkpoint.ts；每 agent
 * 保留最近 20 份）。平台无 PreCompact 钩子，这是一键落盘的补偿入口；**无 lead 闸**
 * （每人只写自己的目录），读路径无锁，不碰 team.json/邮箱/锁/任务状态机。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { attemptWake } from "../engine/wake.js";
import { bootstrapTimeoutFromEnv, provisionMember, ProvisionError } from "../engine/provision.js";
import { LockBusyError, withRegistryThenTeamLocks, withTeamLock } from "../core/lock.js";
import { logEngineEvent } from "../core/log.js";
import { appendMailbox, createMessage, readMailbox, readUnreadMailbox, urgentFirst } from "../core/mailbox.js";
import { bindName, readSession, writeSession } from "../core/registry.js";
import { sanitizeKey, validateMemberName } from "../core/sanitize.js";
import { getTask, leadKeyOf, memberOpenTasks, newTeamState, readTeam, sortTasksForBoard, transitionTask, unblockTask, writeTeam, provisionStaleAfterMs, sweepStaleProvisioningLocked } from "../core/teamstate.js";
import { taskJournalPath, writeArchive } from "../core/archive.js";
// v0.8.0（A1，DESIGN-V0.8.md §3）：checkpoint 服务端落盘 + 容量水位推导（与 handoff/status 共用同一助手）。
import {
  capacityViewOf,
  checkpointStamp,
  checkpointUnreadRef,
  writeCheckpoint,
  type CapacityView,
  type CheckpointWriteResult,
} from "../core/checkpoint.js";
import { checkpointFile } from "../core/paths.js";
import { capacityCacheFile, judgeCapacity, sampleCapacity } from "../core/capacity.js";
import { stallThresholdMs } from "../core/stall.js";
import {
  DEFAULT_TEAM_ID,
  MAX_LEAD_HISTORY,
  OPEN_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  memberState,
} from "../core/types.js";
import type { LeadHistoryEntry, MemberState, TeamMember, TeamMessage, TeamState } from "../core/types.js";
import { revokeAttempt } from "../core/graph.js";
import { cascadeDependencyDeadlockLocked, staleThresholdMsFromEnv } from "./task-edges.js";
import { errorResult, invalidParamsError, mapToolError, okResult, ToolError, type ToolResult } from "./protocol.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import type { ToolDeps } from "./core.js";

const TEAM_ID = DEFAULT_TEAM_ID;

/** createMemberToolCore 的最小依赖形状（与 tools.ts ToolDeps 结构一致；测试可直接构造）。 */
export interface ToolDepsLike {
  stateRoot: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// R1 唤醒门控（§5.1 E-c / §6.3）
// ---------------------------------------------------------------------------

/** R1 唤醒门控（§5.1 E-c / §6.3）：供给中或失败的成员只入箱，不触发唤醒。 */
export function blocksWake(provisionState: MemberState): boolean {
  return provisionState === "provisioning" || provisionState === "failed";
}

// ---------------------------------------------------------------------------
// zod 入参 schema（§1.2 T8）
// ---------------------------------------------------------------------------

/** action=idle 的 idleReason 取值约定（§5.3，对齐 11-cc逆向 §3c-4 idle_notification）。 */
export const IDLE_REASONS = ["no-claimable-task", "inbox-empty", "blocked-only"] as const;

export const TeamShape = {
  action: z.enum(["init", "transfer", "release", "member-add", "member-stop", "idle", "cancel", "unblock", "checkpoint"]),
  takeover: z.boolean().optional().describe("仅 action=init：接管现任 lead（用户明确指令时；R-1/F-4）"),
  to: z.string().min(1).optional().describe("action=transfer：移交目标"),
  name: z.string().min(1).optional().describe("action=member-add/member-stop：成员名"),
  model: z.string().optional().describe("action=member-add：模型 id"),
  reasoningLevel: z.string().optional().describe("action=member-add：推理档位"),
  note: z.string().optional().describe("action=member-add：备注（仅审计）；action=checkpoint：写进检查点第 7 章的一句话"),
  contextChars: z.number().int().positive().optional().describe("action=member-add：该成员上下文字符数声明（预算刻度，R-18；缺省 XC_CONTEXT_CHARS/200k）"),
  reason: z.string().optional().describe("action=transfer/member-stop：原因（入审计）"),
  taskId: z.string().min(1).optional().describe("action=cancel/unblock：任务 id"),
  summary: z.string().min(1).optional().describe("action=idle：空闲摘要（守则 v2 第 3 条）"),
  idleReason: z.enum(IDLE_REASONS).optional().describe("action=idle：缺省 no-claimable-task"),
  completedTaskId: z.string().optional().describe("action=idle：刚完成任务 id"),
  completedStatus: z.string().optional().describe("action=idle：刚完成任务状态"),
  failureReason: z.string().optional().describe("action=idle：失败原因"),
  result: z.string().optional().describe("action=idle：最终答案全文"),
  archive: z.boolean().optional().describe("action=member-stop：停止前先写留档（缺省 true，C4）"),
  unblockNote: z.string().optional().describe("action=unblock：解除说明（回投给认领者）"),
} as const;

// 旧工具的独立 shape（createLeadToolCore / 单测直接驱动沿用旧形态）。
export const TeamInitShape = {
  takeover: z.boolean().optional().describe("接管现任 lead（仅在用户明确指令时使用）：通知旧 lead、写 leadHistory(reason=takeover)、全程审计"),
} as const;
export const IdleShape = {
  summary: z.string().min(1).describe("最终答案/空闲原因摘要（守则 v2 第 3 条：必填）"),
  idleReason: z.enum(IDLE_REASONS).optional().describe("缺省 no-claimable-task"),
  completedTaskId: z.string().optional().describe("刚完成的任务 id（守则 v2：附上）"),
  completedStatus: z.string().optional().describe("刚完成任务的状态（completed/failed/…）"),
  failureReason: z.string().optional().describe("失败原因（对齐 CC idle_notification 结构）"),
  result: z.string().optional().describe("最终答案全文/结果摘要"),
} as const;
export const CancelShape = { taskId: z.string().min(1).describe("要取消的任务 id") } as const;
export const LeadTransferShape = {
  to: z.string().min(1).describe("移交目标成员名（sanitizeKey 归一；须在册且未 removed）"),
  reason: z.string().optional().describe("移交原因（入 leadHistory 与审计，不参与逻辑）"),
} as const;
export const LeadReleaseShape = {} as const;
export const MemberAddShape = {
  name: z.string().min(1).describe("新成员名（须已是规范键形：字母/数字/单个连字符，≤48 字符；全角/同形/路径符/控制符等碰撞写法与保留名 lead/default/main/team-lead/user/system 拒绝）"),
  model: z.string().optional().describe("成员模型 id；缺省用 member_model 配置，再缺省用枚举首个"),
  reasoningLevel: z.string().optional().describe("成员推理档位；缺省用 member_reasoning 配置（默认 max）"),
  note: z.string().optional().describe("备注（仅入审计日志，不参与逻辑）"),
  contextChars: z.number().int().positive().optional().describe("该成员的上下文字符数声明（接收方注入预算刻度，R-18；不填=XC_CONTEXT_CHARS/200k）"),
} as const;
export const MemberStopShape = {
  name: z.string().min(1).describe("要停止的成员名"),
  reason: z.string().optional().describe("停止原因（记入 roster stopReason 与 shutdown 帧）"),
  archive: z.boolean().optional().describe("停止前先写留档 .crosschat/archive/<name>/（缺省 true，C4）"),
} as const;
export const UnblockShape = {
  taskId: z.string().min(1).describe("要解除阻塞的任务 id"),
  unblockNote: z.string().optional().describe("解除说明（回投给认领者）"),
} as const;

// ---------------------------------------------------------------------------
// 纯函数（导出供单元测试；V15「上限逻辑为纯插件侧」）
// ---------------------------------------------------------------------------

/**
 * XC_MAX_MEMBERS 解析（V18 防御：非有限正整数的任何值取默认值 8）。
 */
export function maxMembersFromEnv(env: NodeJS.ProcessEnv, fallback = 8): number {
  const raw = env["XC_MAX_MEMBERS"];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 占名额的成员数（v0.5.3 A12 修复口径：**lead、failed、removed 均不计**）。
 */
export function countActiveMembers(team: TeamState): number {
  const lead = leadKeyOf(team);
  return team.members.filter((m) => {
    if (m.key === lead) return false;
    const state = memberState(m);
    return state !== "removed" && state !== "failed";
  }).length;
}

/**
 * 写入（新建/幂等重供给）后的占名额成员数（v0.5.3 A12 修复）。
 */
export function activeMembersAfterUpsert(team: TeamState, existing: TeamMember | undefined): number {
  const stateBefore = existing !== undefined ? memberState(existing) : undefined;
  return (
    countActiveMembers(team)
    + (stateBefore === undefined || stateBefore === "removed" || stateBefore === "failed" ? 1 : 0)
  );
}

/**
 * lead 判定（§6.1 step 1）：team.leadKey，未设置时 founder 视为 lead。
 *
 * v0.7 集成收口：实现已在 core/teamstate.ts 提供单一事实源（core 侧审批门/台账清扫
 * 需要它而 core 不能 import mcp）；本文件改为转出同一实现，删除逐字节重复的第二份
 * （防未来两处漂移）。既有 `from "./tools-team.js"` 的导入方不受影响。
 */
export { leadKeyOf };

/**
 * 同名重调的分流（§6.4/§6.1）。
 *
 * v0.7.1（故障注-1 修复）：停滞口径改走 core 的 `provisionStaleAfterMs`
 * 单一事实源（与 provisioning deadline 清扫同值：超时 + 60s 宽限）。
 */
export function resolveReprovision(
  existing: TeamMember | undefined,
  now: number,
  bootstrapTimeoutMs: number,
): { kind: "fresh" | "auto" | "ready" | "in-progress" } {
  if (existing === undefined) return { kind: "fresh" };
  const state = memberState(existing);
  if (state === "ready") return { kind: "ready" };
  if (state === "removed") return { kind: "fresh" };
  if (state === "failed") return { kind: "auto" };
  const staleAfterMs = provisionStaleAfterMs(bootstrapTimeoutMs);
  const startedAt = existing.provisionedAt ?? existing.joinedAt;
  return now - startedAt > staleAfterMs ? { kind: "auto" } : { kind: "in-progress" };
}

/**
 * v0.5（R-15-4 系统通知可控字段纪律 / P9）：lead-transfer 的 reason 进帧/史前清洗。
 */
export function sanitizeLeadReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const cleaned = reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
  return cleaned === "" ? undefined : cleaned;
}

/** leadHistory 追加 + ≤32 条 FIFO 截尾（R-6）。 */
export function pushLeadHistory(
  team: { leadHistory?: LeadHistoryEntry[] },
  entry: LeadHistoryEntry,
): void {
  team.leadHistory = [...(team.leadHistory ?? []), entry].slice(-MAX_LEAD_HISTORY);
}

// ---------------------------------------------------------------------------
// 渲染（人可读一行摘要；机器负载在 okResult 第二块）
// ---------------------------------------------------------------------------

export function renderTeamInit(teamId: string, leadKey: string, alreadyLead: boolean): string {
  const head = alreadyLead ? `Already the lead of team "${teamId}".` : `Team "${teamId}" lead set.`;
  return `${head} lead=${leadKey}.`;
}

export function renderIdle(from: string, to: string, delivered: "wake" | "mailbox"): string {
  return `Idle notification from ${from} delivered to ${to} via ${delivered}.`;
}

export function renderCancel(taskId: string, cancelledBy: string, receiptTo: string, delivered: "wake" | "mailbox"): string {
  return `Task ${taskId} cancelled by ${cancelledBy}; receipt sent to ${receiptTo} (wake via ${delivered}).`;
}

export function renderLeadTransfer(from: string, to: string, delivered: "wake" | "mailbox"): string {
  return `Lead role transferred from ${from} to ${to}. This is a metadata role: no tasks, mailboxes or registrations moved (new lead notice via ${delivered}).`;
}

export function renderLeadRelease(released: boolean, teamId: string): string {
  return released
    ? `Lead role released. Team "${teamId}" is back to founder-fallback (no explicit lead); collaboration is unaffected.`
    : `No explicit lead to release (founder-fallback state).`;
}

// ---------------------------------------------------------------------------
// 工具核心（SDK 无关；原 lead-tools.ts / member-tools.ts 平移）
// ---------------------------------------------------------------------------

/** core 层统一入口：LockBusyError → {error:"busy"}，其余经 protocol.mapToolError。 */
async function runTeamTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LockBusyError) return errorResult(err.toStructured());
    return mapToolError(err);
  }
}

/**
 * 快照刷新（观测面，best-effort，§7.3.1）。
 */
async function refreshSnapshotBestEffort(stateRoot: string, teamId: string): Promise<void> {
  try {
    const { refreshSnapshot } = await import("../core/snapshot.js");
    await refreshSnapshot(stateRoot, teamId);
  } catch {
    /* 观测面失败静默降级（§7.3.1 快照纪律） */
  }
}

function truncate(text: string, budget = 400): string {
  return text.length <= budget ? text : `${text.slice(0, Math.max(0, budget - 1))}…`;
}

/** 供给期间的规格（Phase 1 锁内产出 → Phase 2/3/4 锁外消费）。 */
interface MemberAddPlan {
  key: string;
  mode: "fresh" | "auto";
  /** v0.7.1（故障注-1）：本次 Phase 1 清扫（超期 provisioning → failed）的成员键。 */
  swept: string[];
}

async function memberAdd(deps: ToolDeps, args: { name: string; model?: string; reasoningLevel?: string; note?: string; contextChars?: number }, me: BoundIdentity): Promise<ToolResult> {
  const { stateRoot, workspace, env } = deps;
  // v0.6.1（红队四番战 安全对-2/安全对-5 修复）：与 xc_identify 同一道花名闸
  // （validateMemberName：严格文法 + 保留名两轴一致）。此前这里只 sanitizeKey +
  // RESERVED_MEMBER_KEYS，全角/同形等碰撞写法可入册（"Ａｌｉｃｅ" → 键 alice，
  // 抢占/覆盖他人花名）。锁外快拒，零副作用。
  const nameCheck = validateMemberName(args.name);
  if (!nameCheck.ok) {
    throw new ToolError(
      { error: nameCheck.error, name: nameCheck.name, message: nameCheck.message },
      nameCheck.message,
    );
  }
  const key = nameCheck.key;
  const maxMembers = maxMembersFromEnv(env);
  const bootstrapTimeoutMs = bootstrapTimeoutFromEnv(env);
  const now = Date.now();

  // ---- Phase 1（团队锁内）：lead 校验 + 名额 + 写 provisioning 记录（§6.1 step 1-4）----
  // v0.7.1（故障注-1 修复）：provisioning 超时的落盘 deadline 与锁内清扫。
  const plan = await withTeamLock(stateRoot, me.teamId, async (): Promise<MemberAddPlan> => {
    const team = await readTeam(stateRoot, me.teamId);
    if (team === undefined) {
      throw new ToolError({
        error: "not_lead",
        agentKey: me.agentKey,
        message: 'no team on disk; register first (xc_identify) or run xc_team init to become lead',
      });
    }
    if (leadKeyOf(team) !== me.agentKey) {
      throw new ToolError({
        error: "not_lead",
        agentKey: me.agentKey,
        leadKey: leadKeyOf(team),
        message: `only the team lead ("${leadKeyOf(team)}") can add members`,
      });
    }
    // 锁内清扫：lead server 曾中途死亡（或欢迎回合从未完成）的 provisioning
    // 记录超期置 failed——释放名额并留下审计/回执，不再无限期卡死占位。
    const swept = sweepStaleProvisioningLocked(team, now, provisionStaleAfterMs(bootstrapTimeoutMs));
    const existing = team.members.find((m) => m.key === key);
    const reprovision = resolveReprovision(existing, now, bootstrapTimeoutMs);
    if (reprovision.kind === "ready") {
      throw invalidParamsError(
        `member name "${key}" has already been used in team "${team.teamId}" (dsh tools.js:1210-1212 同语义)`,
      );
    }
    if (reprovision.kind === "in-progress") {
      throw new ToolError({
        error: "member_provisioning",
        name: key,
        message: `member "${key}" is being provisioned right now; retry after it turns ready/failed`,
      });
    }
    const activeAfter = activeMembersAfterUpsert(team, existing);
    if (activeAfter > maxMembers) {
      // v0.7.1（规模压-B2）：报文自洽化。旧文案 `(max, active=activeAfter; lead/failed/removed 不计入)`
      // 把「本次写入后的名额数」报成 activeMembers——实际活成员只有 activeNow 个，读者
      // 按同句的「lead 不计入」反推只能得出「lead 被算进去了」的矛盾结论。
      // 现在两个数分开报：activeMembers = 当前活成员，activeAfterAdd = 本次写入后。
      const activeNow = countActiveMembers(team);
      throw new ToolError({
        error: "team_at_member_cap",
        teamId: team.teamId,
        maxMembers,
        activeMembers: activeNow,
        activeAfterAdd: activeAfter,
        name: key,
        message: `team "${team.teamId}" is at its member cap (max=${maxMembers}): adding "${key}" would make `
          + `${activeAfter} active members, over the cap (${activeNow} active now; lead/failed/removed 不计入) `
          + `(dsh tools.js:1214-1215 同语义)`,
      });
    }
    const record: TeamMember = existing !== undefined
      ? {
          ...existing,
          sessionId: "",
          role: "worker",
          state: "provisioning",
          identity: "engine",
          provisionedAt: now,
          // v0.7.1（故障注-1）：超时判据落盘——不依赖本进程存活（红队 fi1：
          // lead server 中途死亡时内存 deadline 随之蒸发，成员永久卡 provisioning）。
          provisionDeadlineAt: now + provisionStaleAfterMs(bootstrapTimeoutMs),
          lastSeen: now,
          error: undefined,
          stopReason: undefined,
          ...(args.contextChars !== undefined ? { contextChars: args.contextChars } : {}),
        }
      : {
          key,
          sessionId: "",
          role: "worker",
          state: "provisioning",
          identity: "engine",
          provisionedAt: now,
          provisionDeadlineAt: now + provisionStaleAfterMs(bootstrapTimeoutMs),
          joinedAt: now,
          lastSeen: now,
          ...(args.contextChars === undefined ? {} : { contextChars: args.contextChars }),
        };
    if (existing === undefined) team.members.push(record);
    else team.members[team.members.indexOf(existing)] = record;
    // 隐式成为 lead（§3.1）：leadKey 未设置时，本次建员动作把 founder 材料化为 leadKey。
    if (team.leadKey === undefined) team.leadKey = me.agentKey;
    await writeTeam(stateRoot, team);
    return {
      key,
      mode: reprovision.kind === "auto" ? "auto" : "fresh",
      // 本次调用把哪个（些）卡的 provisioning 记录清扫成了 failed（回执披露用）。
      swept: swept.map((s) => s.key),
    };
  });

  await logEngineEvent(stateRoot, {
    event: "member-add-started", teamId: me.teamId, name: plan.key, mode: plan.mode,
    note: args.note, by: me.agentKey,
  });
  // v0.7.1（故障注-1）：锁内清扫的逐条审计（「谁在何时因超时被置 failed」）。
  for (const sweptKey of plan.swept) {
    await logEngineEvent(stateRoot, {
      event: "member-provision-timeout", teamId: me.teamId, name: sweptKey, by: me.agentKey,
      via: "member-add",
    });
  }

  // ---- Phase 2（锁外）：供给四步（§6.1 step 5；失败 → state=failed + error）----
  try {
    const result = await provisionMember(deps, {
      key: plan.key,
      mode: plan.mode,
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.reasoningLevel === undefined ? {} : { reasoningLevel: args.reasoningLevel }),
    });

    // ---- Phase 3（registry→team 锁序）：收尾（§6.1 step 6）----
    const readyAt = Date.now();
    await withRegistryThenTeamLocks(stateRoot, me.teamId, async () => {
      await bindName(stateRoot, plan.key, {
        sessionId: result.sessionId,
        role: "worker",
        registeredAt: readyAt,
        issuedBy: "engine",
      });
      // sessions/<sid>.json 代写（identity.ts wakeToken 路径同形态）；v0.5.3（a6）：
      // 代写保留钩子已写的锚定令牌（v0.6 起令牌仅作钩子延续用，不再构成闸）。
      const prebound = await readSession(stateRoot, result.sessionId);
      await writeSession(stateRoot, {
        ...(prebound ?? {}),
        sessionId: result.sessionId,
        cwd: workspace,
        startedAt: prebound?.startedAt ?? readyAt,
        lastSeen: readyAt,
        boundName: plan.key,
        regToken: prebound?.regToken ?? randomUUID(),
      });
      const team = await readTeam(stateRoot, me.teamId);
      if (team !== undefined) {
        const idx = team.members.findIndex((m) => m.key === plan.key);
        if (idx >= 0) {
          team.members[idx] = {
            ...team.members[idx]!,
            sessionId: result.sessionId,
            state: "ready",
            provisionedAt: readyAt,
            lastSeen: readyAt,
            error: undefined,
          };
        }
        await writeTeam(stateRoot, team);
      }
    });
    await logEngineEvent(stateRoot, {
      event: "member-added", teamId: me.teamId, name: plan.key, sessionId: result.sessionId,
      providerId: result.providerId, modelId: result.modelId, reasoningLevel: result.reasoningLevel,
      reprovisioned: result.reprovisioned, by: me.agentKey,
    });

    // ---- Phase 4（锁外）：投产边沿 E-e（§5.1/§6.1 step 7）----
    const backlog = await readUnreadMailbox(stateRoot, me.teamId, plan.key);
    let delivered: "wake" | "mailbox" | "skipped" = "skipped";
    let wakeNote: string | undefined;
    if (backlog.length > 0) {
      const sent = await attemptWake({
        stateRoot,
        teamId: me.teamId,
        toAgentKey: plan.key,
        toSessionId: result.sessionId,
        workspace,
        reason: "post-provision",
        receiptIds: backlog.map((m) => m.id),
        ticket:
          `成员供给完成：你的邮箱有 ${backlog.length} 条未读消息。` +
          "请按成员守则开工：xc_read({scope:\"inbox\"}) 查收 → 有单则 claim/执行/report。",
        env,
      });
      delivered = sent.delivered;
      wakeNote = sent.note;
      await logEngineEvent(stateRoot, {
        event: "post-provision-wake", teamId: me.teamId, name: plan.key,
        backlog: backlog.length, delivered: sent.delivered,
      });
    }

    // v0.7.1（故障注-1）：本次供给接手了一个超期卡死的 provisioning 记录
    // （如 lead server 曾中途死亡）——回执如实披露，调用方知道旧尝试的结局。
    const recoveredFromTimeout = plan.swept.includes(plan.key);
    return okResult(
      `Member "${plan.key}" ready (session ${result.sessionId}, ` +
        `${result.providerId}/${result.modelId} reasoning ${result.reasoningLevel}` +
        `${result.reprovisioned ? ", reprovisioned" : ""}` +
        `${recoveredFromTimeout ? ", previous provisioning attempt had timed out (swept to failed)" : ""})` +
        `${backlog.length > 0 ? `; backlog ${backlog.length} message(s) → ${delivered}` : ""}.`,
      {
        name: plan.key,
        sessionId: result.sessionId,
        state: "ready",
        identity: "engine",
        model: { providerId: result.providerId, modelId: result.modelId, reasoningLevel: result.reasoningLevel },
        reprovisioned: result.reprovisioned,
        ...(recoveredFromTimeout ? { recovered: "provision-timeout" as const } : {}),
        welcomeResponse: truncate(result.welcomeResponse),
        ...(result.turnModelId === undefined ? {} : { turnModelId: result.turnModelId }),
        ...(result.turnProviderId === undefined ? {} : { turnProviderId: result.turnProviderId }),
        backlog: backlog.length,
        delivered,
        ...(wakeNote === undefined ? {} : { note: wakeNote }),
      },
    );
  } catch (err) {
    const detail = err instanceof ProvisionError
      ? `${err.step}: ${err.message}`
      : String(err instanceof Error ? err.message : err);
    try {
      await withTeamLock(stateRoot, me.teamId, async () => {
        const team = await readTeam(stateRoot, me.teamId);
        const idx = team?.members.findIndex((m) => m.key === plan.key) ?? -1;
        if (team !== undefined && idx >= 0) {
          team.members[idx] = {
            ...team.members[idx]!,
            state: "failed",
            error: truncate(detail, 500),
            lastSeen: Date.now(),
          };
          await writeTeam(stateRoot, team);
        }
      });
    } catch {
      /* 标记失败本身失败：engine.jsonl 仍留痕（下一行），状态可由下次 add 接管 */
    }
    await logEngineEvent(stateRoot, {
      event: "member-add-failed", teamId: me.teamId, name: plan.key, error: detail, by: me.agentKey,
    });
    throw new ToolError({
      error: "member_provision_failed",
      name: plan.key,
      detail: truncate(detail, 500),
      message:
        `member "${plan.key}" provisioning failed: ${detail} — ` +
        "roster state=failed; retry xc_team {action:\"member-add\"} with the same name (idempotent reprovision, §6.4)",
    });
  }
}

interface MemberStopOutcome {
  key: string;
  stopReason: string | undefined;
  revoked: { taskId: string; title: string; previousStatus: string }[];
  shutdownMessageId: string;
  toSessionId: string;
  archive?: { dir: string; journalPath: string; metaPath: string };
  archiveError?: string;
}

/** C4（§3.4）：停止前留档——任务清单 + 未读索引 + 各任务 journal 聚合（best-effort）。 */
async function archiveBeforeStop(deps: ToolDeps, key: string, sessionId: string, reason: string, now: number): Promise<MemberStopOutcome["archive"]> {
  const team = await readTeam(deps.stateRoot, TEAM_ID);
  const tasks = (team?.tasks ?? [])
    .filter((t) => t.assignee === key && OPEN_TASK_STATUSES.includes(t.status))
    .map((t) => ({ taskId: t.id, title: t.title, status: t.status }));
  const unread = (await readUnreadMailbox(deps.stateRoot, TEAM_ID, key)).map((m) => ({
    msgId: m.id,
    from: m.from,
    ts: m.ts,
    preview: m.content.slice(0, 200),
  }));
  const taskJournals: Array<{ taskId: string; body: string }> = [];
  for (const t of tasks) {
    try {
      taskJournals.push({ taskId: t.taskId, body: await readFile(taskJournalPath(deps.stateRoot, t.taskId), "utf8") });
    } catch {
      /* 无 journal 的任务照常留档（三节正文由 buildJournalSections 兜底） */
    }
  }
  const result = await writeArchive(deps.stateRoot, { name: key, sessionId }, {
    reason,
    tasks,
    unread,
    taskJournals,
    now,
  });
  return { dir: result.dir, journalPath: result.journalPath, metaPath: result.metaPath };
}

async function memberStop(deps: ToolDeps, args: { name: string; reason?: string; archive?: boolean }, me: BoundIdentity): Promise<ToolResult> {
  const { stateRoot, workspace, env } = deps;
  const key = sanitizeKey(args.name);
  if (key === "") throw invalidParamsError(`name ${JSON.stringify(args.name)} sanitizes to an empty key`);
  const now = Date.now();

  // ---- 停止前留档（C4，缺省 true；写失败不阻断停止——任务照常回池，「不丢」）----
  let archiveOutcome: MemberStopOutcome["archive"];
  let archiveError: string | undefined;
  if (args.archive !== false) {
    try {
      archiveOutcome = await archiveBeforeStop(deps, key, "", args.reason ?? "", now);
      await logEngineEvent(stateRoot, { event: "member-archive-written", teamId: me.teamId, name: key, by: me.agentKey });
    } catch (err) {
      archiveError = err instanceof Error ? err.message : String(err);
      await logEngineEvent(stateRoot, {
        event: "member-archive-failed", teamId: me.teamId, name: key, by: me.agentKey, error: archiveError,
      });
    }
  }

  // ---- 团队锁内：removed + 收回开放任务 + 回执 + shutdown 帧（§6.1/§7.3.3）----
  const out = await withTeamLock(stateRoot, me.teamId, async (): Promise<MemberStopOutcome> => {
    const team = await readTeam(stateRoot, me.teamId);
    if (team === undefined) {
      throw new ToolError({ error: "no_team", message: "no team on disk yet" });
    }
    if (leadKeyOf(team) !== me.agentKey) {
      throw new ToolError({
        error: "not_lead",
        agentKey: me.agentKey,
        leadKey: leadKeyOf(team),
        message: `only the team lead ("${leadKeyOf(team)}") can stop members`,
      });
    }
    const member = team.members.find((m) => m.key === key);
    if (member === undefined) {
      throw invalidParamsError(`no member "${key}" in team "${team.teamId}"`);
    }
    if (memberState(member) === "removed") {
      throw new ToolError({
        error: "member_removed",
        name: key,
        message: `member "${key}" is already removed`,
      });
    }
    if (memberState(member) === "provisioning") {
      throw invalidParamsError(
        `member "${key}" is provisioning right now; retry after it turns ready/failed`,
      );
    }

    // 开放任务收回（§7.3.3，dsh remove_member 对应物）：引擎特权重置回 pending 池。
    const revoked: { taskId: string; title: string; previousStatus: string }[] = [];
    for (const task of memberOpenTasks(team.tasks, key)) {
      const previousStatus = task.status;
      revokeAttempt(task, { event: "revoked-member-stop", by: me.agentKey, now });
      revoked.push({ taskId: task.id, title: task.title, previousStatus });
      const receipt = createMessage(
        key,
        task.createdBy,
        JSON.stringify({
          type: "task-receipt",
          teamId: me.teamId,
          taskId: task.id,
          status: "failed",
          error: `revoked: member "${key}" stopped by lead; task returned to the pending pool`,
          title: task.title,
        }),
        { taskId: task.id, sourceTaskId: task.id, sourceTaskStatus: task.status, deliveryClaimedAt: now },
      );
      await appendMailbox(stateRoot, me.teamId, task.createdBy, receipt);
    }

    // shutdown-request 帧（§6.1：成员按守则 7 收尾；FRAME_TYPES 白名单类型）。
    const shutdown = createMessage(
      me.agentKey,
      key,
      JSON.stringify({
        type: "shutdown-request",
        teamId: me.teamId,
        from: me.agentKey,
        reason: args.reason ?? "",
      }),
      { deliveryClaimedAt: now },
    );
    await appendMailbox(stateRoot, me.teamId, key, shutdown);

    const idx = team.members.findIndex((m) => m.key === key);
    team.members[idx] = {
      ...team.members[idx]!,
      state: "removed",
      ...(args.reason === undefined ? {} : { stopReason: args.reason }),
      lastSeen: now,
    };
    await writeTeam(stateRoot, team);
    return {
      key,
      stopReason: args.reason,
      revoked,
      shutdownMessageId: shutdown.id,
      toSessionId: member.sessionId,
      ...(archiveOutcome !== undefined ? { archive: archiveOutcome } : {}),
      ...(archiveError !== undefined ? { archiveError } : {}),
    };
  });

  await logEngineEvent(stateRoot, {
    event: "member-stopped", teamId: me.teamId, name: out.key, by: me.agentKey,
    stopReason: out.stopReason ?? null, revokedTasks: out.revoked.map((r) => r.taskId),
  });

  // ---- 锁外：尽力唤醒成员收尾（§6.1「尽力唤醒（成员按守则 7 收尾）」）----
  let delivered: "wake" | "mailbox" | "skipped" = "skipped";
  let wakeNote: string | undefined;
  if (out.toSessionId.trim() !== "") {
    const sent = await attemptWake({
      stateRoot,
      teamId: me.teamId,
      toAgentKey: out.key,
      toSessionId: out.toSessionId,
      workspace,
      reason: "shutdown",
      receiptIds: [out.shutdownMessageId],
      ticket:
        `成员 "${out.key}" 已被 lead 停止：不要再领取新任务；如手头仍有单，其 attempt 已被引擎收回，` +
        "直接结束回合即可。",
      env,
    });
    delivered = sent.delivered;
    wakeNote = sent.note;
  }

  return okResult(
    `Member "${out.key}" removed (state removed` +
      `${out.stopReason === undefined ? "" : `, reason: ${out.stopReason}`}); ` +
      `requeued tasks: ${out.revoked.map((r) => r.taskId).join(", ") || "none"}; ` +
      `shutdown notice → ${delivered}` +
      `${out.archive !== undefined ? `; archive → ${out.archive.dir}` : ""}` +
      `${out.archiveError !== undefined ? `; ARCHIVE FAILED: ${out.archiveError}` : ""}.`,
    {
      name: out.key,
      state: "removed",
      ...(out.stopReason === undefined ? {} : { stopReason: out.stopReason }),
      revokedTasks: out.revoked,
      shutdownMessageId: out.shutdownMessageId,
      shutdownWake: delivered,
      ...(out.archive !== undefined ? { archive: out.archive } : {}),
      ...(out.archiveError !== undefined ? { archiveError: out.archiveError } : {}),
      ...(wakeNote === undefined ? {} : { note: wakeNote }),
    },
  );
}

/** 队内成员工具核心（原 member-tools.ts 的 registerMemberTools 两个 handler 主体）。 */
export interface MemberToolCore {
  xc_member_add(args: { name: string; model?: string; reasoningLevel?: string; note?: string; contextChars?: number }, connectionKey: string): Promise<ToolResult>;
  xc_member_stop(args: { name: string; reason?: string; archive?: boolean }, connectionKey: string): Promise<ToolResult>;
}

export function createMemberToolCore(deps: ToolDeps): MemberToolCore {
  return {
    async xc_member_add(args, connectionKey) {
      return runTeamTool(async () => {
        const me = identityStore.require(connectionKey);
        return memberAdd(deps, args, me);
      });
    },
    async xc_member_stop(args, connectionKey) {
      return runTeamTool(async () => {
        const me = identityStore.require(connectionKey);
        return memberStop(deps, args, me);
      });
    },
  };
}

/** 队内 lead 工具核心（原 lead-tools.ts createLeadToolCore 1:1 平移）。 */
export interface LeadToolCore {
  xc_team_init(args: { takeover?: boolean }, connectionKey: string): Promise<ToolResult>;
  xc_idle(args: {
    summary: string;
    idleReason?: (typeof IDLE_REASONS)[number];
    completedTaskId?: string;
    completedStatus?: string;
    failureReason?: string;
    result?: string;
  }, connectionKey: string): Promise<ToolResult>;
  xc_cancel(args: { taskId: string }, connectionKey: string): Promise<ToolResult>;
  xc_lead_transfer(args: { to: string; reason?: string }, connectionKey: string): Promise<ToolResult>;
  xc_lead_release(args: Record<string, never>, connectionKey: string): Promise<ToolResult>;
}

export function createLeadToolCore(deps: ToolDepsLike): LeadToolCore {
  const { stateRoot, workspace } = deps;

  return {
    async xc_team_init(args, connectionKey) {
      return runTeamTool(async () => {
        const me = identityStore.require(connectionKey);
        const now = Date.now();

        const out = await withTeamLock(stateRoot, me.teamId, async () => {
          let team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) {
            // 防御分支：注册路径已建队；异常丢失时此处重建（founder=调用者）。
            team = newTeamState({
              teamId: me.teamId,
              name: me.teamId,
              founderKey: me.agentKey,
              founder: { key: me.agentKey, sessionId: me.sessionId, role: me.role, joinedAt: now, lastSeen: now },
              now,
            });
          }
          // ★R-1：lead_exists 错误载荷补现任 lead 的 sessionId；F-4 接管须显式传 {takeover:true}。
          if (team.leadKey !== undefined && team.leadKey !== me.agentKey && args.takeover !== true) {
            throw new ToolError({
              error: "lead_exists",
              leadKey: team.leadKey,
              sessionId: team.members.find((m) => m.key === team.leadKey)?.sessionId ?? null,
              message: `team "${me.teamId}" already has a lead ("${team.leadKey}"); a second lead cannot take over (§3.2 L1); ` +
                "use {takeover:true} only on explicit user instruction (the old lead is notified; the takeover is audited)",
            });
          }
          const takeoverFrom = args.takeover === true && team.leadKey !== undefined && team.leadKey !== me.agentKey
            ? team.leadKey
            : undefined;
          const alreadyLead = team.leadKey === me.agentKey;
          if (!alreadyLead) {
            team.leadKey = me.agentKey;
            team.leadSince = now;
            // ★P9：set 枚举写入点——空位认领 from:null；接管 from:旧 lead（reason 固定 "takeover"）。
            pushLeadHistory(team, {
              event: "set",
              from: takeoverFrom ?? null,
              to: me.agentKey,
              ts: now,
              ...(takeoverFrom !== undefined ? { reason: "takeover" } : {}),
            });
            await writeTeam(stateRoot, team);
          }
          return { alreadyLead, leadKey: me.agentKey, takeoverFrom };
        });

        // 锁外（F-4 hunk ③）：接管时通知旧 lead（mailbox+唤醒；唤醒失败=mailbox 兜底）。
        if (out.takeoverFrom !== undefined) {
          const notice = createMessage(me.agentKey, out.takeoverFrom, JSON.stringify({
            type: "lead-transfer", teamId: me.teamId, from: me.agentKey, to: me.agentKey, status: "taken-over",
          }), { deliveryClaimedAt: Date.now() });
          await appendMailbox(stateRoot, me.teamId, out.takeoverFrom, notice);
          const oldSessionId = (await readTeam(stateRoot, me.teamId))?.members
            .find((m) => m.key === out.takeoverFrom)?.sessionId ?? null;
          if (oldSessionId !== null && oldSessionId !== "") {
            await attemptWake({
              stateRoot,
              teamId: me.teamId,
              toAgentKey: out.takeoverFrom,
              toSessionId: oldSessionId,
              workspace,
              reason: "lead-transfer",
              receiptIds: [notice.id],
              ticket: `CrossChat lead 变更：${me.agentKey} 已接管队长角色（用户指令）`,
              env: deps.env,
            });
          }
        }

        await refreshSnapshotBestEffort(stateRoot, me.teamId);
        await logEngineEvent(stateRoot, {
          event: "lead-set",
          teamId: me.teamId,
          by: me.agentKey,
          alreadyLead: out.alreadyLead,
          ...(out.takeoverFrom !== undefined ? { takeover: true, from: out.takeoverFrom } : {}),
        });
        return okResult(renderTeamInit(me.teamId, out.leadKey, out.alreadyLead), {
          teamId: me.teamId,
          leadKey: out.leadKey,
          alreadyLead: out.alreadyLead,
          ...(out.takeoverFrom !== undefined ? { takeover: true, from: out.takeoverFrom } : {}),
        });
      });
    },

    async xc_idle(args, connectionKey) {
      return runTeamTool(async () => {
        const me = identityStore.require(connectionKey);
        const summary = args.summary.trim();
        if (summary === "") throw invalidParamsError("summary is required (§5.3 idle-notification)");

        const prepared = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) {
            throw new ToolError({ error: "no_team", message: "no team on disk yet; register first" });
          }
          if (!team.members.some((m) => m.key === me.agentKey)) {
            throw new ToolError({
              error: "not_a_member",
              agentKey: me.agentKey,
              message: `"${me.agentKey}" is not a member of team "${team.teamId}"; register first (xc_identify)`,
            });
          }
          const to = team.leadKey ?? team.founderKey;
          if (to === me.agentKey) {
            throw invalidParamsError("caller is the lead; there is no one to notify idle (§5.3 recipient=lead)");
          }
          // R1 门控：供给中/失败的调用者只入箱（§5.1 E-c）。
          const mine = team.members.find((m) => m.key === me.agentKey);
          const mailboxOnly = mine !== undefined && blocksWake(memberState(mine));
          // v0.5.3（安全对-4 a9 修复）：completedTaskId 任务归属校验。
          let integrityWarning: string | undefined;
          const claimedTaskId = args.completedTaskId !== undefined && args.completedTaskId.trim() !== ""
            ? args.completedTaskId
            : undefined;
          if (claimedTaskId !== undefined) {
            const task = getTask(team, claimedTaskId);
            if (task === undefined) {
              throw new ToolError({
                error: "unknown_task",
                taskId: claimedTaskId,
                message: `idle frame references unknown task "${claimedTaskId}"; completedTaskId must be an existing task on the team board`,
              });
            }
            if (task.assignee !== me.agentKey) {
              throw new ToolError({
                error: "not_task_owner",
                taskId: task.id,
                assignee: task.assignee,
                message: `task ${task.id} is not yours (assignee=${task.assignee ?? "null"}); idle completedTaskId must reference a task assigned to you`,
              });
            }
            if (args.completedStatus !== undefined && args.completedStatus.trim() !== ""
              && (task.status !== args.completedStatus
                || (args.completedStatus === "completed" && task.evidence.length === 0))) {
              integrityWarning =
                `task ${task.id} board status="${task.status}" with ${task.evidence.length} evidence item(s) does not back the idle frame's claimed status "${args.completedStatus}" — verify with xc_overview/xc_read before trusting`;
            }
          }
          // idle-notification 帧（§5.3 契约）。
          const frame = JSON.stringify({
            type: "idle-notification",
            teamId: me.teamId,
            from: me.agentKey,
            idleReason: args.idleReason ?? "no-claimable-task",
            summary,
            completedTaskId: claimedTaskId ?? null,
            completedStatus: args.completedStatus ?? null,
            failureReason: args.failureReason ?? null,
            result: args.result ?? null,
            ...(integrityWarning !== undefined ? { integrityWarning } : {}),
          });
          const message = createMessage(me.agentKey, to, frame, { deliveryClaimedAt: Date.now() });
          await appendMailbox(stateRoot, me.teamId, to, message);
          return {
            to,
            messageId: message.id,
            mailboxOnly,
            toSessionId: team.members.find((m) => m.key === to)?.sessionId ?? null,
            integrityWarning,
          };
        });

        // 锁外唤醒（§2.7-4）：mailboxOnly 门控/无 sessionId → mailbox 兜底，消息不丢。
        let delivered: "wake" | "mailbox" = "mailbox";
        let note: string | undefined = prepared.mailboxOnly
          ? "caller is provisioning/failed: mailbox-only (R1 gate, §5.1 E-c)"
          : undefined;
        if (!prepared.mailboxOnly && prepared.toSessionId !== null) {
          const sent = await attemptWake({
            stateRoot,
            teamId: me.teamId,
            toAgentKey: prepared.to,
            toSessionId: prepared.toSessionId,
            workspace,
            reason: "idle",
            receiptIds: [prepared.messageId],
            ticket: `收到 CrossChat 空闲通知：from=${me.agentKey} summary=${summary}`,
            env: deps.env,
          });
          delivered = sent.delivered;
          note = sent.note ?? note;
        }
        await logEngineEvent(stateRoot, {
          event: "idle",
          teamId: me.teamId,
          from: me.agentKey,
          to: prepared.to,
          delivered,
          mailboxOnly: prepared.mailboxOnly,
          messageId: prepared.messageId,
          ...(prepared.integrityWarning !== undefined ? { integrityWarning: true } : {}),
        });
        return okResult(renderIdle(me.agentKey, prepared.to, delivered), {
          to: prepared.to,
          delivered,
          ...(prepared.mailboxOnly ? { mailboxOnly: true } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(prepared.integrityWarning !== undefined ? { integrityWarning: prepared.integrityWarning } : {}),
        });
      });
    },

    async xc_cancel(args, connectionKey) {
      return runTeamTool(async () => {
        const me = identityStore.require(connectionKey);

        const prepared = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) {
            throw new ToolError({ error: "no_team", message: "no team on disk yet" });
          }
          if (!team.members.some((m) => m.key === me.agentKey)) {
            throw new ToolError({
              error: "not_a_member",
              agentKey: me.agentKey,
              message: `"${me.agentKey}" is not a member of team "${team.teamId}"`,
            });
          }
          const isLead = team.leadKey !== undefined
            ? team.leadKey === me.agentKey
            : team.founderKey === me.agentKey;
          const task = getTask(team, args.taskId);
          if (task === undefined) throw invalidParamsError(`unknown task "${args.taskId}"`);
          if (!isLead && task.createdBy !== me.agentKey) {
            throw new ToolError({
              error: "not_lead",
              taskId: task.id,
              // v0.8.1（M05 收口）：与 isLead 门闸、message 文案、其余 lead 闸错误信封
              // （member-add/stop/transfer 等均用 leadKeyOf）同源——直读 team.leadKey
              // 会在无显式 lead 时给 null，而同一报文里门闸按 founder 兜底判 isLead、
              // message 也展示 founder，payload 键自相矛盾。
              leadKey: leadKeyOf(team) ?? null,
              message: `only the team lead ("${team.leadKey ?? team.founderKey}") or the task creator ("${task.createdBy}") can cancel task ${task.id} (§7.3.3)`,
            });
          }
          if (TERMINAL_TASK_STATUSES.includes(task.status)) {
            throw new ToolError({
              error: "task_already_terminal",
              taskId: task.id,
              status: task.status,
              message: `task ${task.id} is already ${task.status}; terminal tasks cannot be cancelled (§7.3.3)`,
            });
          }
          transitionTask(team, task.id, "cancelled", me.agentKey, { now: Date.now() });
          await writeTeam(stateRoot, team);

          const receipt = JSON.stringify({
            type: "task-receipt",
            teamId: me.teamId,
            taskId: task.id,
            attemptId: task.attemptId ?? "",
            status: "cancelled",
            result: task.result,
            error: task.error,
            evidence: task.evidence,
            cancelledBy: me.agentKey,
          });
          const message = createMessage(me.agentKey, task.createdBy, receipt, {
            taskId: task.id,
            sourceTaskId: task.id,
            sourceTaskStatus: "cancelled",
            deliveryClaimedAt: Date.now(),
          });
          await appendMailbox(stateRoot, me.teamId, task.createdBy, message);
          // v0.5.3（A3 修复）：cancelled 上游的依赖死锁解除。
          const deadlock = await cascadeDependencyDeadlockLocked(stateRoot, team, task.id, "cancelled", Date.now());
          if (deadlock.deadlocked.length > 0) await writeTeam(stateRoot, team);
          return {
            taskId: task.id,
            createdBy: task.createdBy,
            messageId: message.id,
            createdBySessionId: team.members.find((m) => m.key === task.createdBy)?.sessionId ?? null,
            deadlock,
          };
        });

        // 锁外唤醒 createdBy（§2.7-4）；取消者即 createdBy 时不自唤醒。
        let delivered: "wake" | "mailbox" = "mailbox";
        let note: string | undefined;
        if (prepared.createdBy !== me.agentKey && prepared.createdBySessionId !== null) {
          const sent = await attemptWake({
            stateRoot,
            teamId: me.teamId,
            toAgentKey: prepared.createdBy,
            toSessionId: prepared.createdBySessionId,
            workspace,
            reason: "cancel",
            receiptIds: [prepared.messageId],
            ticket: `收到 CrossChat 回执：task ${prepared.taskId} = cancelled（被 ${me.agentKey} 取消）`,
            env: deps.env,
          });
          delivered = sent.delivered;
          note = sent.note;
        }
        for (const item of prepared.deadlock?.wakePlan ?? []) {
          if (item.to === me.agentKey || item.sessionId === null) continue;
          try {
            await attemptWake({
              stateRoot,
              teamId: me.teamId,
              toAgentKey: item.to,
              toSessionId: item.sessionId,
              workspace,
              reason: "dependency-deadlock",
              receiptIds: item.receiptIds,
              ticket: `收到 CrossChat 回执：task 依赖的上游 ${prepared.taskId} = cancelled，其 pending 下游已被引擎解除（cancelled）`,
              env: deps.env,
            });
          } catch {
            // 唤醒失败不影响工具结果：邮箱回执兜底。
          }
        }
        const deadlockedCount = prepared.deadlock?.deadlocked.length ?? 0;
        await refreshSnapshotBestEffort(stateRoot, me.teamId);
        await logEngineEvent(stateRoot, {
          event: "cancel",
          teamId: me.teamId,
          taskId: prepared.taskId,
          by: me.agentKey,
          receiptTo: prepared.createdBy,
          delivered,
          ...(deadlockedCount > 0 ? { deadlocked: deadlockedCount } : {}),
        });
        return okResult(renderCancel(prepared.taskId, me.agentKey, prepared.createdBy, delivered), {
          taskId: prepared.taskId,
          status: "cancelled",
          cancelledBy: me.agentKey,
          receiptTo: prepared.createdBy,
          delivered,
          ...(deadlockedCount > 0
            ? { deadlocked: prepared.deadlock?.deadlocked.map((d) => ({ taskId: d.taskId, createdBy: d.createdBy, deadlockedBy: d.deadlockedBy, woken: d.woken })) }
            : {}),
          ...(note !== undefined ? { note } : {}),
        });
      });
    },

    async xc_lead_transfer(args, connectionKey) {
      return runTeamTool(async () => {
        const me = identityStore.require(connectionKey);
        const to = sanitizeKey(args.to);
        if (to === "") throw invalidParamsError(`name ${JSON.stringify(args.to)} sanitizes to an empty key`);
        const reason = sanitizeLeadReason(args.reason);
        if (to === me.agentKey) {
          throw invalidParamsError("transferring the lead role to yourself is a no-op");
        }
        const now = Date.now();

        const prepared = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet; register first" });
          if (!team.members.some((m) => m.key === me.agentKey)) {
            throw new ToolError({
              error: "not_a_member",
              agentKey: me.agentKey,
              message: `"${me.agentKey}" is not a member; register first`,
            });
          }
          if (leadKeyOf(team) !== me.agentKey) {
            throw new ToolError({
              error: "not_lead",
              agentKey: me.agentKey,
              leadKey: leadKeyOf(team),
              message: `only the current lead ("${leadKeyOf(team)}") can transfer the role`,
            });
          }
          const target = team.members.find((m) => m.key === to);
          if (target === undefined || memberState(target) === "removed") {
            throw invalidParamsError(`transfer target "${to}" is not an active member of team "${team.teamId}"`);
          }
          team.leadKey = to;
          team.leadSince = now;
          pushLeadHistory(team, {
            event: "transfer",
            from: me.agentKey,
            to,
            ts: now,
            ...(reason === undefined ? {} : { reason }),
          });
          await writeTeam(stateRoot, team);
          const notice = createMessage(me.agentKey, to, JSON.stringify({
            type: "lead-transfer",
            teamId: me.teamId,
            from: me.agentKey,
            to,
            ...(reason === undefined ? {} : { reason }),
          }), { deliveryClaimedAt: now });
          await appendMailbox(stateRoot, me.teamId, to, notice);
          return { to, noticeId: notice.id, toSessionId: target.sessionId };
        });

        const receipt = createMessage(me.agentKey, me.agentKey, JSON.stringify({
          type: "lead-transfer", teamId: me.teamId, from: me.agentKey, to: prepared.to, status: "completed",
        }), { deliveryClaimedAt: Date.now() });
        await appendMailbox(stateRoot, me.teamId, me.agentKey, receipt);
        let delivered: "wake" | "mailbox" = "mailbox";
        let note: string | undefined;
        if (prepared.toSessionId !== null && prepared.toSessionId !== "") {
          const sent = await attemptWake({
            stateRoot,
            teamId: me.teamId,
            toAgentKey: prepared.to,
            toSessionId: prepared.toSessionId,
            workspace,
            reason: "lead-transfer",
            receiptIds: [prepared.noticeId],
            ticket: `收到 CrossChat lead 移交：${me.agentKey} → ${prepared.to}，你现在分别是本队的队长（元数据角色）`,
            env: deps.env,
          });
          delivered = sent.delivered;
          note = sent.note ?? note;
        }
        await refreshSnapshotBestEffort(stateRoot, me.teamId);
        await logEngineEvent(stateRoot, {
          event: "lead-transfer",
          teamId: me.teamId,
          from: me.agentKey,
          to: prepared.to,
          ...(reason === undefined ? {} : { reason }),
          messageId: prepared.noticeId,
        });
        return okResult(renderLeadTransfer(me.agentKey, prepared.to, delivered), {
          teamId: me.teamId,
          from: me.agentKey,
          to: prepared.to,
          leadSince: now,
          messageId: prepared.noticeId,
          delivered,
          ...(note !== undefined ? { note } : {}),
        });
      });
    },

    async xc_lead_release(_args, connectionKey) {
      return runTeamTool(async () => {
        const me = identityStore.require(connectionKey);
        const now = Date.now();
        const out = await withTeamLock(stateRoot, me.teamId, async () => {
          const team = await readTeam(stateRoot, me.teamId);
          if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet" });
          if (leadKeyOf(team) !== me.agentKey) {
            throw new ToolError({
              error: "not_lead",
              agentKey: me.agentKey,
              leadKey: leadKeyOf(team),
              message: `only the current lead ("${leadKeyOf(team)}") can release the role`,
            });
          }
          if (team.leadKey === undefined) {
            return { released: false, alreadyDefault: true };
          }
          delete team.leadKey;
          delete team.leadSince;
          pushLeadHistory(team, { event: "release", from: me.agentKey, to: null, ts: now });
          await writeTeam(stateRoot, team);
          return { released: true, alreadyDefault: false };
        });
        await refreshSnapshotBestEffort(stateRoot, me.teamId);
        await logEngineEvent(stateRoot, {
          event: "lead-release",
          teamId: me.teamId,
          from: me.agentKey,
          released: out.released,
        });
        return okResult(renderLeadRelease(out.released, me.teamId), {
          teamId: me.teamId,
          from: me.agentKey,
          released: out.released,
          ...(out.alreadyDefault ? { alreadyDefault: true } : {}),
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// xc_team：action 分发（§1.2 T8）
// ---------------------------------------------------------------------------

/** xc_team 的 action 载荷（按 action 收窄；未用字段忽略）。 */
export type TeamActionArgs = {
  action: "init" | "transfer" | "release" | "member-add" | "member-stop" | "idle" | "cancel" | "unblock" | "checkpoint";
  takeover?: boolean;
  to?: string;
  name?: string;
  model?: string;
  reasoningLevel?: string;
  note?: string;
  contextChars?: number;
  reason?: string;
  taskId?: string;
  summary?: string;
  idleReason?: (typeof IDLE_REASONS)[number];
  completedTaskId?: string;
  completedStatus?: string;
  failureReason?: string;
  result?: string;
  archive?: boolean;
  unblockNote?: string;
};

/**
 * v0.8.0（A1，DESIGN-V0.8.md §3）：`xc_team({action:"checkpoint", note?})`——服务端
 * 直接落盘 7 章检查点（front-matter + 身份/我的任务/待领池/journal/未读/建议下一步/note）。
 *
 * 权限：`identityStore.require`（未注册连接拒，与所有成员动作一致）；**不设 lead 闸**——
 * 每个成员只能写自己的 `<root>/checkpoints/<自己>/` 目录，没有越权面。
 * 前置：team.json 不存在 → `no_team`（tools-read.ts 同族）；成员不在花名册 → 仍可写，
 * 「身份」章如实记 `(not on roster)`（不阻断——检查点的价值是落盘）。
 * 副作用面：**只写 `checkpoints/<me>/`**——不写 team.json、不进邮箱、不唤醒、不碰锁、
 * 不改任务状态机。读路径无锁（§2.7-5 纪律）。
 * 容量采样失败 → payload `capacity: null` + front-matter `level: UNKNOWN`（不谎报水位）。
 */
export async function handleTeamCheckpoint(deps: ToolDeps, args: { note?: string }, connectionKey: string): Promise<ToolResult> {
  return runTeamTool(async () => {
    const me = identityStore.require(connectionKey);
    const team = await readTeam(deps.stateRoot, me.teamId);
    if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet" });
    const now = Date.now();
    const member = team.members.find((m) => m.key === me.agentKey);
    const openTasks = memberOpenTasks(team.tasks, me.agentKey);
    const pool = sortTasksForBoard(team.tasks.filter((t) => t.status === "pending"));
    // 未读读取失败 → 第 5 章如实记「（未读读取失败）」+ payload warnings[]（§3.6），
    // 不让邮箱读取问题毁掉整份检查点。
    const warnings: string[] = [];
    let unreadMessages: TeamMessage[];
    let unreadError: string | undefined;
    try {
      unreadMessages = urgentFirst(await readUnreadMailbox(deps.stateRoot, me.teamId, me.agentKey));
    } catch (err) {
      unreadMessages = [];
      unreadError = err instanceof Error ? err.message : String(err);
      warnings.push(`unread read failed: ${unreadError}`);
    }
    const unread = unreadMessages.map(checkpointUnreadRef);
    // C3 容量采样（与 overview 同款惰性采样 + 判定；失败只降级为 UNKNOWN，不阻断写盘）。
    let capacity: CapacityView | null = null;
    try {
      const sample = await sampleCapacity(deps.env, capacityCacheFile(deps.stateRoot), now);
      capacity = capacityViewOf(sample, judgeCapacity(sample, deps.env));
    } catch {
      capacity = null;
    }
    const stallMs = stallThresholdMs(deps.env, staleThresholdMsFromEnv(deps.env)).ms;

    let result: CheckpointWriteResult;
    try {
      result = await writeCheckpoint(deps.stateRoot, {
        agentKey: me.agentKey,
        teamId: me.teamId,
        // v0.8.1（29 红队 M05 修复）：lead 渲染跨面同源——team.leadKey 缺省时 founder
        // 读作 lead（core/teamstate.ts leadKeyOf；types.ts 的 TeamState.leadKey 注释
        // 与 DESIGN-V0.2 §6.1 的公开口径）。此前直读 team.leadKey ?? null，无显式 lead
        // 时 front-matter/身份章渲染 `(none)`，而 status/team 视图展示 founder——
        // 同一团队两个答案（且 handoff 同时 isLead:true 自相矛盾）。
        leadKey: leadKeyOf(team) ?? null,
        member: member === undefined
          ? null
          : { role: member.role, state: memberState(member), sessionId: member.sessionId, lastSeen: member.lastSeen },
        openTasks,
        allTasks: team.tasks,
        pool,
        unread,
        unreadTotal: unread.length,
        ...(unreadError !== undefined ? { unreadError } : {}),
        capacity,
        stallThresholdMs: stallMs,
        ...(args.note !== undefined ? { note: args.note } : {}),
        now,
      });
    } catch (err) {
      // 写盘失败不得假装成功（§3.6）：结构化错误 + 审计，payload 附 path 与首因错误。
      const message = err instanceof Error ? err.message : String(err);
      let path: string | undefined;
      try {
        path = checkpointFile(deps.stateRoot, me.agentKey, checkpointStamp(now));
      } catch {
        path = undefined; // 段闸拒绝（防御纵深）→ 不带 path
      }
      await logEngineEvent(deps.stateRoot, {
        event: "checkpoint-write-failed",
        teamId: me.teamId,
        agentKey: me.agentKey,
        ...(path !== undefined ? { path } : {}),
        error: message,
      });
      throw new ToolError({
        error: "checkpoint_write_failed",
        message,
        ...(path !== undefined ? { path } : {}),
      });
    }

    await logEngineEvent(deps.stateRoot, {
      event: "checkpoint",
      teamId: me.teamId,
      agentKey: me.agentKey,
      path: result.path,
      bytes: result.bytes,
      openTasks: result.openTasks,
      unread: result.unread,
      pruned: result.pruned,
    });
    if (result.pruneError !== undefined) {
      // 滚动删除失败不阻断已成功的写入：写盘事实保持成功，删除失败单独审计 + payload 披露。
      await logEngineEvent(deps.stateRoot, {
        event: "checkpoint-prune-failed",
        teamId: me.teamId,
        agentKey: me.agentKey,
        path: result.path,
        pruned: result.pruned,
        pruneError: result.pruneError,
      });
    }
    // v0.8.1（C1-B01）：排他落盘实际撞名进位——同毫秒并发的可见信号（payload 不加键：
    // §14.1 冻结形状不增不减，披露走审计事件）。
    if (result.stampCollisions !== undefined && result.stampCollisions > 0) {
      await logEngineEvent(deps.stateRoot, {
        event: "checkpoint-stamp-collision",
        teamId: me.teamId,
        agentKey: me.agentKey,
        path: result.path,
        stamp: result.stamp,
        bumped: result.stampCollisions,
      });
    }
    // v0.8.1（C1-B02）：被杀进程残留 .tmp 的清扫披露（清到才记；失败同样只审计）。
    if (result.tmpRemoved !== undefined && result.tmpRemoved > 0) {
      await logEngineEvent(deps.stateRoot, {
        event: "checkpoint-tmp-swept",
        teamId: me.teamId,
        agentKey: me.agentKey,
        removed: result.tmpRemoved,
      });
    }
    if (result.tmpSweepError !== undefined) {
      await logEngineEvent(deps.stateRoot, {
        event: "checkpoint-tmp-sweep-failed",
        teamId: me.teamId,
        agentKey: me.agentKey,
        error: result.tmpSweepError,
      });
    }
    const level = result.capacity?.level ?? "UNKNOWN";
    return okResult(
      `Checkpoint written: ${result.path} (${result.bytes} bytes, ${result.openTasks} open task(s), ${result.unread} unread, capacity ${level}).`,
      {
        path: result.path,
        createdAt: result.createdAt,
        tasks: openTasks.map((t) => ({ taskId: t.id, status: t.status })),
        unread: result.unread,
        capacity: result.capacity,
        bytes: result.bytes,
        pruned: result.pruned,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(result.pruneError !== undefined ? { pruneError: result.pruneError } : {}),
      },
    );
  });
}

/** unblock 权限闸：lead、任务创建者或该任务认领者（§1.2 T8 权限矩阵）。 */
export async function handleTeamUnblock(deps: ToolDeps, args: { taskId: string; unblockNote?: string }, connectionKey: string): Promise<ToolResult> {
  return runTeamTool(async () => {
    const me = identityStore.require(connectionKey);
    const now = Date.now();
    const prepared = await withTeamLock(deps.stateRoot, me.teamId, async () => {
      const team = await readTeam(deps.stateRoot, me.teamId);
      if (team === undefined) throw new ToolError({ error: "no_team", message: "no team on disk yet" });
      if (!team.members.some((m) => m.key === me.agentKey)) {
        throw new ToolError({
          error: "not_a_member",
          agentKey: me.agentKey,
          message: `"${me.agentKey}" is not a member of team "${team.teamId}"`,
        });
      }
      const task = getTask(team, args.taskId);
      if (task === undefined) throw invalidParamsError(`unknown task "${args.taskId}"`);
      const isLead = team.leadKey !== undefined ? team.leadKey === me.agentKey : team.founderKey === me.agentKey;
      const isCreator = task.createdBy === me.agentKey;
      const isClaimant = task.assignee === me.agentKey;
      if (!isLead && !isCreator && !isClaimant) {
        throw new ToolError({
          error: "not_authorized",
          taskId: task.id,
          // v0.8.1（M05 收口）：同 cancel 闸——payload leadKey 与 isLead 门闸（founder
          // 兜底）及 message 文案同源，不再无显式 lead 时给 null 而门闸认 founder。
          leadKey: leadKeyOf(team) ?? null,
          createdBy: task.createdBy,
          assignee: task.assignee,
          message: `unblock is allowed for the lead ("${team.leadKey ?? team.founderKey}"), the task creator ("${task.createdBy}") or the claimant ("${task.assignee ?? "none"}") only`,
        });
      }
      const back = task.preBlockedStatus ?? "pending";
      const err = unblockTask(task, now, { by: me.agentKey });
      if (err !== undefined) {
        throw new ToolError({
          error: err,
          taskId: task.id,
          status: task.status,
          message: `task ${task.id} is ${task.status}; only blocked tasks can be unblocked`,
        });
      }
      await writeTeam(deps.stateRoot, team);
      // unblock-notice 帧回投认领者（复用既有帧型；认领者缺席（防御边回 pending）时不投）。
      const assignee = task.assignee;
      let messageId: string | undefined;
      if (assignee !== null && back !== "pending") {
        const notice = createMessage(me.agentKey, assignee, JSON.stringify({
          type: "unblock-notice",
          teamId: me.teamId,
          taskId: task.id,
          unblockedBy: me.agentKey,
          ...(args.unblockNote !== undefined ? { unblockNote: args.unblockNote } : {}),
        }), { taskId: task.id, deliveryClaimedAt: now });
        await appendMailbox(deps.stateRoot, me.teamId, assignee, notice);
        messageId = notice.id;
      }
      return {
        taskId: task.id,
        status: task.status,
        unblockedBy: me.agentKey,
        assignee,
        messageId,
        toSessionId: assignee !== null ? (team.members.find((m) => m.key === assignee)?.sessionId ?? null) : null,
      };
    });

    // 锁外尽力唤醒认领者（无开放任务/供给中/removed → 只入箱）。
    let delivered: "wake" | "mailbox" | "skipped" = "skipped";
    if (prepared.assignee !== null && prepared.messageId !== undefined && prepared.toSessionId !== null) {
      const team = await readTeam(deps.stateRoot, me.teamId);
      const memberRecord = team?.members.find((m) => m.key === prepared.assignee);
      if (memberOpenTasks(team?.tasks ?? [], prepared.assignee).length === 0 && !blocksWake(memberState(memberRecord!))) {
        const sent = await attemptWake({
          stateRoot: deps.stateRoot,
          teamId: me.teamId,
          toAgentKey: prepared.assignee,
          toSessionId: prepared.toSessionId,
          workspace: deps.workspace,
          reason: "unblock",
          receiptIds: [prepared.messageId],
          ticket: `收到 CrossChat 解除通知：task ${prepared.taskId} 已解除阻塞（by ${me.agentKey}）${args.unblockNote !== undefined ? `——${args.unblockNote}` : ""}`,
          env: deps.env,
        });
        delivered = sent.delivered;
      }
    }
    await logEngineEvent(deps.stateRoot, {
      event: "unblock",
      teamId: me.teamId,
      taskId: prepared.taskId,
      by: me.agentKey,
      status: prepared.status,
      delivered,
    });
    return okResult(
      `Task ${prepared.taskId} unblocked (status=${prepared.status}); notice delivered via ${delivered}.`,
      {
        taskId: prepared.taskId,
        status: prepared.status,
        unblockedBy: me.agentKey,
        delivered,
        ...(args.unblockNote !== undefined ? { unblockNote: args.unblockNote } : {}),
      },
    );
  });
}

/** xc_team 工具层（action 分发到对应核心实现；无 lead/成员等调用者限制之外的重排）。 */
export async function handleTeam(deps: ToolDeps, args: TeamActionArgs, connectionKey: string): Promise<ToolResult> {
  const core = createLeadToolCore(deps);
  const memberCore = createMemberToolCore(deps);
  switch (args.action) {
    case "init":
      return core.xc_team_init({ ...(args.takeover !== undefined ? { takeover: args.takeover } : {}) }, connectionKey);
    case "transfer":
      if (args.to === undefined) throw new ToolError({ error: "invalid_params", message: "action=transfer requires \"to\"" });
      return core.xc_lead_transfer({ to: args.to, ...(args.reason !== undefined ? { reason: args.reason } : {}) }, connectionKey);
    case "release":
      return core.xc_lead_release({}, connectionKey);
    case "member-add":
      if (args.name === undefined) throw new ToolError({ error: "invalid_params", message: "action=member-add requires \"name\"" });
      return memberCore.xc_member_add({
        name: args.name,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.reasoningLevel !== undefined ? { reasoningLevel: args.reasoningLevel } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.contextChars !== undefined ? { contextChars: args.contextChars } : {}),
      }, connectionKey);
    case "member-stop":
      if (args.name === undefined) throw new ToolError({ error: "invalid_params", message: "action=member-stop requires \"name\"" });
      return memberCore.xc_member_stop({
        name: args.name,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(args.archive !== undefined ? { archive: args.archive } : {}),
      }, connectionKey);
    case "idle":
      if (args.summary === undefined) throw new ToolError({ error: "invalid_params", message: "action=idle requires \"summary\"" });
      return core.xc_idle({
        summary: args.summary,
        ...(args.idleReason !== undefined ? { idleReason: args.idleReason } : {}),
        ...(args.completedTaskId !== undefined ? { completedTaskId: args.completedTaskId } : {}),
        ...(args.completedStatus !== undefined ? { completedStatus: args.completedStatus } : {}),
        ...(args.failureReason !== undefined ? { failureReason: args.failureReason } : {}),
        ...(args.result !== undefined ? { result: args.result } : {}),
      }, connectionKey);
    case "cancel":
      if (args.taskId === undefined) throw new ToolError({ error: "invalid_params", message: "action=cancel requires \"taskId\"" });
      return core.xc_cancel({ taskId: args.taskId }, connectionKey);
    case "unblock":
      if (args.taskId === undefined) throw new ToolError({ error: "invalid_params", message: "action=unblock requires \"taskId\"" });
      return handleTeamUnblock(deps, { taskId: args.taskId, ...(args.unblockNote !== undefined ? { unblockNote: args.unblockNote } : {}) }, connectionKey);
    case "checkpoint":
      return handleTeamCheckpoint(deps, { ...(args.note !== undefined ? { note: args.note } : {}) }, connectionKey);
  }
}

// ---------------------------------------------------------------------------
// SDK 接线（FamilyRegistrar 形态；server.ts 持有 PrimaryRegistry）
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCore } from "./core.js";
import type { ToolDeps as _TD, PrimaryRegistry } from "./core.js";
import { connectionKeyOf } from "./identity.js";

/** 注册 xc_team（指挥族合一；action 分发）。 */
export function registerTeamTools(
  server: McpServer,
  deps: _TD,
  _core: ToolCore,
  registry: PrimaryRegistry,
): void {
  const description =
    "Command family in one tool (actions: init/transfer/release/member-add/member-stop/idle/cancel/unblock/checkpoint). " +
    "action=init becomes lead (takeover:true ONLY on explicit user instruction); transfer/release move/drop the metadata lead role; " +
    "member-add provisions an engine member (lead only); member-stop removes a member, requeues its open tasks with receipts and (default archive:true) writes .crosschat/archive/<name>/ first (C4); " +
    "idle reports idleness to the lead; cancel cancels a task (lead or creator); unblock releases a blocked task back to its preBlocked status (lead/creator/claimant) with an unblock-notice to the claimant; " +
    "checkpoint writes a 7-section handoff checkpoint to .crosschat/checkpoints/<you>/<ISO>.md server-side (keeps the newest 20 per member; note goes into section 7); " +
    "there is no PreCompact hook on this platform, so use it before accepting compression or handing over.";
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> =>
    handleTeam(deps, args as unknown as TeamActionArgs, connectionKeyOf(extra));
  server.tool("xc_team", description, TeamShape, handler);
  registry.set("xc_team", { description, shape: TeamShape, handler });
}
