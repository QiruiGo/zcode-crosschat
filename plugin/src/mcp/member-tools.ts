/**
 * W2 member-engine —— xc_member_add / xc_member_stop（lead 专属，DESIGN-V0.2.md §6）。
 *
 * 身份模型（§3.1）：lead = team.leadKey（未设置时 founder 视为 lead）；engine 成员 =
 * 引擎程序化建会话（identity:"engine"）；v0.1.0 自注册成员 = peer（identity 缺省 "self"，
 * §6.5 兼容）。engine/peer 成员都不可建员——建员是 lead 专属能力（§6.1 step 1）。
 *
 * xc_member_add 流程（§6.1 七步）：
 *   1. lead 校验（not_lead）；2. 名校验（保留名 name_reserved / 重名 invalid_params，
 *      dsh tools.js:1206-1212 同序）；3. 名额（team_at_member_cap，dsh tools.js:1214-1215
 *      同文案同语义，removed 不计）；4. 锁内写 provisioning 记录（占名额防并发重复建）；
 *   5. 锁外供给（provision.ts 四步，失败 → state=failed+error + member_provision_failed，
 *      可同名重试）；6. registry→team 锁序内收尾（names.json 预绑定 issuedBy:"engine" +
 *      sessions/<sid>.json 代写 + roster state=ready）；7. 投产边沿 E-e：供给期间积压的
 *      未读 → 逃逸唤醒（scene "post-provision"）。
 *
 * xc_member_stop 流程（§6.1/§7.3.3）：state=removed + stopReason；开放任务（claimed/
 * in_progress）经引擎特权重置（W3 graph.revokeAttempt，非 TASK_TRANSITIONS 边——
 * §5.4 豁免声明同款）回 pending 池 + 回执 lead（dsh remove_member「revoke its current
 * attempts, return all unfinished owned tasks to the shared pending pool」对应物）；
 * shutdown-request 帧入其邮箱 + 尽力唤醒收尾（守则 7）。花名不释放（dsh members.js:979）。
 *
 * 锁纪律（§2.7 沿用）：慢操作（供给 ≤300s、唤醒 spawn）一律在团队锁外；收尾变更走
 * registry → team 固定锁序（§2.7-3，本文件是第二条双锁路径）。
 *
 * 回执唤醒说明：stop 产生的收回回执**不**唤醒 lead——调用者就是 lead 本人（工具结果
 * 已含 revokedTasks），与 §7.3.3 的「回执 lead + 唤醒」相比省去一次自我唤醒；回执仍落
 * 邮箱作持久审计。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { attemptWake } from "../engine/wake.js";
import { bootstrapTimeoutFromEnv, provisionMember, ProvisionError } from "../engine/provision.js";
import { LockBusyError, withRegistryThenTeamLocks, withTeamLock } from "../core/lock.js";
import { logEngineEvent } from "../core/log.js";
import { appendMailbox, createMessage, readUnreadMailbox } from "../core/mailbox.js";
import { bindName, writeSession } from "../core/registry.js";
import { sanitizeKey } from "../core/sanitize.js";
import { memberOpenTasks, readTeam, writeTeam } from "../core/teamstate.js";
import {
  DEFAULT_TEAM_ID,
  OPEN_TASK_STATUSES,
  RESERVED_MEMBER_KEYS,
  memberState,
  type TeamMember,
  type TeamState,
} from "../core/types.js";
// 引擎特权重置（claimed/in_progress → pending 池）由 W3 交付于 core/graph.ts
// （DESIGN-V0.2.md §9.1 依赖表：member-tools import graph.revokeAttempt）。
// W3 实际签名：revokeAttempt(task, {by?, now?, event?}) → boolean（terminal/pending 幂等 no-op）；
// 语义 = 原地置 status=pending、assignee=null、attemptId=null、attempt+1、清上代结果、history 记 event。
import { revokeAttempt } from "../core/graph.js";
import { errorResult, invalidParamsError, mapToolError, okResult, ToolError, type ToolResult } from "./protocol.js";
import { connectionKeyOf, identityStore, type BoundIdentity } from "./identity.js";
import type { ToolDeps } from "./tools.js";

const TEAM_ID = DEFAULT_TEAM_ID;

/** 结果/回执里 welcomeResponse 与错误详情的截断预算。 */
const RESPONSE_PREVIEW_CHARS = 400;

// ---------------------------------------------------------------------------
// zod 入参 schema（DESIGN-V0.2.md §6.1 契约）
// ---------------------------------------------------------------------------

export const MemberAddShape = {
  name: z.string().min(1).describe("新成员名（sanitizeKey 归一；保留名 lead/default 拒绝）"),
  model: z.string().optional().describe("成员模型 id；缺省用 member_model 配置，再缺省用枚举首个"),
  reasoningLevel: z.string().optional().describe("成员推理档位；缺省用 member_reasoning 配置（默认 max）"),
  note: z.string().optional().describe("备注（仅入审计日志，不参与逻辑）"),
};
export const MemberStopShape = {
  name: z.string().min(1).describe("要停止的成员名"),
  reason: z.string().optional().describe("停止原因（记入 roster stopReason 与 shutdown 帧）"),
};

type MemberAddArgs = z.infer<z.ZodObject<typeof MemberAddShape>>;
type MemberStopArgs = z.infer<z.ZodObject<typeof MemberStopShape>>;

// ---------------------------------------------------------------------------
// 纯函数（导出供单元测试；V15「上限逻辑为纯插件侧（单元测试覆盖）」）
// ---------------------------------------------------------------------------

/**
 * XC_MAX_MEMBERS 解析（V18 防御：非有限正整数的任何值取默认值 8；
 * dsh index.js:100 maxMembers 默认 8 同源）。
 */
export function maxMembersFromEnv(env: NodeJS.ProcessEnv, fallback = 8): number {
  const raw = env["XC_MAX_MEMBERS"];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 占名额的成员数：state!=="removed"（dsh tools.js:1214 同过滤；供给失败/provisioning 都占位）。 */
export function countActiveMembers(team: TeamState): number {
  return team.members.filter((m) => memberState(m) !== "removed").length;
}

/** lead 判定（§6.1 step 1）：team.leadKey，未设置时 founder 视为 lead。 */
export function leadKeyOf(team: TeamState): string {
  return team.leadKey ?? team.founderKey;
}

/**
 * 同名重调的分流（§6.4/§6.1）：
 * - 无记录 → 全新供给（"fresh"）；
 * - state=ready → 已在册（调用方拒绝）；
 * - state=failed / 停滞 provisioning → 幂等重供给，走 §6.4 探针（"auto"）；
 * - state=removed → 停止是显式生命周期终点，重加 = 全新会话（"fresh"）。
 * provisioning 停滞判定：provisionedAt 距今超过 供给超时 + 60s 余量 视为前次 add 已死。
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
  // provisioning：另一进程可能在供（in-progress），超过超时+余量则视为死供给可接管。
  const staleAfterMs = bootstrapTimeoutMs + 60_000;
  const startedAt = existing.provisionedAt ?? existing.joinedAt;
  return now - startedAt > staleAfterMs ? { kind: "auto" } : { kind: "in-progress" };
}

// ---------------------------------------------------------------------------
// 工具核心
// ---------------------------------------------------------------------------

/** core 层统一入口：LockBusyError → {error:"busy"}，其余经 protocol.mapToolError。 */
async function runMemberTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LockBusyError) return errorResult(err.toStructured());
    return mapToolError(err);
  }
}

function truncate(text: string, budget = RESPONSE_PREVIEW_CHARS): string {
  return text.length <= budget ? text : `${text.slice(0, Math.max(0, budget - 1))}…`;
}

/** 供给期间的规格（Phase 1 锁内产出 → Phase 2/3/4 锁外消费）。 */
interface MemberAddPlan {
  key: string;
  mode: "fresh" | "auto";
}

async function memberAdd(deps: ToolDeps, args: MemberAddArgs, me: BoundIdentity): Promise<ToolResult> {
  const { stateRoot, workspace, env } = deps;
  const key = sanitizeKey(args.name);
  if (key === "") throw invalidParamsError(`name ${JSON.stringify(args.name)} sanitizes to an empty key`);
  if ((RESERVED_MEMBER_KEYS as readonly string[]).includes(key)) {
    throw new ToolError({
      error: "name_reserved",
      name: key,
      message: `member name "${key}" is reserved (${RESERVED_MEMBER_KEYS.join("/")})`,
    });
  }
  const maxMembers = maxMembersFromEnv(env);
  const bootstrapTimeoutMs = bootstrapTimeoutFromEnv(env);
  const now = Date.now();

  // ---- Phase 1（团队锁内）：lead 校验 + 名额 + 写 provisioning 记录（§6.1 step 1-4）----
  const plan = await withTeamLock(stateRoot, me.teamId, async (): Promise<MemberAddPlan> => {
    const team = await readTeam(stateRoot, me.teamId);
    if (team === undefined) {
      throw new ToolError({
        error: "not_lead",
        agentKey: me.agentKey,
        message: 'no team on disk; register first (xc_register) or run xc_team_init to become lead',
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
    const existing = team.members.find((m) => m.key === key);
    const reprovision = resolveReprovision(existing, now, bootstrapTimeoutMs);
    if (reprovision.kind === "ready") {
      throw invalidParamsError(
        `member name "${key}" has already been used in team "${team.teamId}" (dsh tools.js:1210-1212 同语义)`,
      );
    }
    if (reprovision.kind === "in-progress") {
      throw new ToolError({
        // §6.1 step 4「防并发重复建」的拒绝面（设计错误码表未给该守卫命名，沿用同风格补码）。
        error: "member_provisioning",
        name: key,
        message: `member "${key}" is being provisioned right now; retry after it turns ready/failed`,
      });
    }
    // 名额：写入后的占名额成员数不得超上限（removed 重加/新建都净 +1；failed 重供给净 0）。
    const activeAfter =
      countActiveMembers(team)
      + (existing !== undefined && memberState(existing) === "removed" ? 1 : 0)
      + (existing === undefined ? 1 : 0);
    if (activeAfter > maxMembers) {
      throw new ToolError({
        error: "team_at_member_cap",
        teamId: team.teamId,
        maxMembers,
        message: `team "${team.teamId}" is at its member cap (${maxMembers}) (dsh tools.js:1214-1215 同文案同语义)`,
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
          lastSeen: now,
          error: undefined,
          stopReason: undefined,
        }
      : {
          key,
          sessionId: "",
          role: "worker",
          state: "provisioning",
          identity: "engine",
          provisionedAt: now,
          joinedAt: now,
          lastSeen: now,
        };
    if (existing === undefined) team.members.push(record);
    else team.members[team.members.indexOf(existing)] = record;
    // 隐式成为 lead（§3.1）：leadKey 未设置时，本次建员动作把 founder 材料化为 leadKey。
    if (team.leadKey === undefined) team.leadKey = me.agentKey;
    await writeTeam(stateRoot, team);
    return { key, mode: reprovision.kind === "auto" ? "auto" : "fresh" };
  });

  await logEngineEvent(stateRoot, {
    event: "member-add-started", teamId: me.teamId, name: plan.key, mode: plan.mode,
    note: args.note, by: me.agentKey,
  });

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
      // sessions/<sid>.json 代写（identity.ts:162-163 wakeToken 路径同形态）。
      await writeSession(stateRoot, {
        sessionId: result.sessionId,
        cwd: workspace,
        startedAt: readyAt,
        lastSeen: readyAt,
        boundName: plan.key,
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
          "请按成员守则开工：xc_check_inbox 查收 → 有单则 claim/执行/report。",
        env,
      });
      delivered = sent.delivered;
      wakeNote = sent.note;
      await logEngineEvent(stateRoot, {
        event: "post-provision-wake", teamId: me.teamId, name: plan.key,
        backlog: backlog.length, delivered: sent.delivered,
      });
    }

    return okResult(
      `Member "${plan.key}" ready (session ${result.sessionId}, ` +
        `${result.providerId}/${result.modelId} reasoning ${result.reasoningLevel}` +
        `${result.reprovisioned ? ", reprovisioned" : ""})` +
        `${backlog.length > 0 ? `; backlog ${backlog.length} message(s) → ${delivered}` : ""}.`,
      {
        name: plan.key,
        sessionId: result.sessionId,
        state: "ready",
        identity: "engine",
        model: { providerId: result.providerId, modelId: result.modelId, reasoningLevel: result.reasoningLevel },
        reprovisioned: result.reprovisioned,
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
    // §6.1 step 5 / §6.4：供给失败标记 failed（名额保留，同名重试 = 幂等重供给）。
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
        "roster state=failed; retry xc_member_add with the same name (idempotent reprovision, §6.4)",
    });
  }
}

interface MemberStopOutcome {
  key: string;
  stopReason: string | undefined;
  revoked: { taskId: string; title: string; previousStatus: string }[];
  shutdownMessageId: string;
  toSessionId: string;
}

async function memberStop(deps: ToolDeps, args: MemberStopArgs, me: BoundIdentity): Promise<ToolResult> {
  const { stateRoot, workspace, env } = deps;
  const key = sanitizeKey(args.name);
  if (key === "") throw invalidParamsError(`name ${JSON.stringify(args.name)} sanitizes to an empty key`);
  const now = Date.now();

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
      // 回执 lead（§7.3.3；§5.4 stale-sweep 回执同形态：status=failed + 说明）。
      // 不带 sourceAttemptId：收回后 task.attemptId 已置空，携带旧 attempt 反而会被
      // isCurrentMail 判陈旧（mailbox.ts:54-70）。
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

    // shutdown-request 帧（§6.1：成员按守则 7 收尾；FRAME_TYPES 白名单类型，W5 契约）。
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
      `shutdown notice → ${delivered}.`,
    {
      name: out.key,
      state: "removed",
      ...(out.stopReason === undefined ? {} : { stopReason: out.stopReason }),
      revokedTasks: out.revoked,
      shutdownMessageId: out.shutdownMessageId,
      shutdownWake: delivered,
      ...(wakeNote === undefined ? {} : { note: wakeNote }),
    },
  );
}

// ---------------------------------------------------------------------------
// SDK 接线
// ---------------------------------------------------------------------------

/** 注册 W2 成员管理工具（DESIGN-V0.2.md §9.2 钉死签名）。 */
export function registerMemberTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "xc_member_add",
    "Add a new engine-provisioned team member (lead only): creates an independent zcode session via the " +
      "app-server protocol, sets its model, runs the welcome turn (the member registers itself with an " +
      "engine-issued wakeToken), then wakes it to consume any backlog. Counts against max_members " +
      "(default 8). Re-adding a failed/removed name reprovisions idempotently.",
    MemberAddShape,
    async (args, extra) => runMemberTool(async () => {
      const me = identityStore.require(connectionKeyOf(extra));
      return memberAdd(deps, args, me);
    }),
  );
  server.tool(
    "xc_member_stop",
    "Stop a team member (lead only): marks it removed, revokes its open tasks back to the shared pending " +
      "pool with receipts to the lead, delivers a shutdown request, and best-effort wakes it to wind down. " +
      "The roster record is kept (name is not released); re-adding the same name provisions a fresh session.",
    MemberStopShape,
    async (args, extra) => runMemberTool(async () => {
      const me = identityStore.require(connectionKeyOf(extra));
      return memberStop(deps, args, me);
    }),
  );
}
