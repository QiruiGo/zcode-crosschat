/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T1）：xc_identify —— 注册/重绑/改名/接管（两轴合一）。
 *
 * 合并 xc_register + xc_peer_register + xc_peer_rename 的调用面；两轴存储不合并
 * （SKILL §9 独立性边界不变）——本文件只把两次注册合为一次调用：
 * - 队内轴 = xcRegister（identity.ts，软身份校验：name_taken / session_already_bound /
 *   removed 门 / wakeToken 路径；regToken 硬闸已随 §2.2-P1 砍除）。
 * - peer 轴 = PeerServices.register（peer-services.ts；session_id_in_use 活性冲突、
 *   session_not_anchored 锚定存在性、name_taken 先到者为准）。
 *
 * 改名（T1 #4）：连接已有身份且 name 与现名不同 → peer 轴 rename（formerNames +
 * control:rename 通知，xc_peer_rename 现状行为）；队内花名换绑仅在该成员
 * 「板面干净」（名下无任何任务引用且邮箱为空）时执行 member key 换绑——有在途
 * 引用时显式拒（team_rename_blocked），不串号不丢信。
 *
 * 接管（T1 #5）：name 已在队内花名册但绑定 sid ≠ 本次 sessionId 时，缺省
 * name_taken（不猜测旧持有者死活）；`takeover:true`（显式，对齐 xc_team takeover
 * 的 R-1/F-4 先例）过两道活信号闸（在途唤醒标记 15min 内 → takeover_inflight；
 * peer 轴活 sid 冲突 → session_id_in_use）后立即换绑 + 名下 OPEN 任务（含
 * blocked）revokeAttempt 回池 + 给创建者回执 + 审计 + leadHistory（lead 名被
 * 接管时 reason=member-rebind-takeover）。误判可恢复：被接管者的下份 report 得
 * stale_attempt 硬拒，按守则停手重取单（README 威胁模型声明）。
 */

import { z } from "zod";
import { okResult, ToolError, type ToolResult } from "./protocol.js";
import { renderRegister } from "./render.js";
import { connectionKeyOf, identityStore, xcRegister } from "./identity.js";
import { withTeamLock, withRegistryThenTeamLocks } from "../core/lock.js";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { readNames, unbindName, findInflightWakeNonce, WAKE_INFLIGHT_MS } from "../core/registry.js";
import { sanitizeKey } from "../core/sanitize.js";
import { DEFAULT_TEAM_ID } from "../core/types.js";
import { memberOpenTasks, readTeam, writeTeam } from "../core/teamstate.js";
import { revokeAttempt } from "../core/graph.js";
import { peerRootFromEnv } from "../core/peerdir.js";
import { getPeerServices, findLiveSessionIdHolder, type PeerRegisterResult } from "./peer-services.js";
import { getPeerSessionContext } from "./peer-drain.js";
import { pushLeadHistory } from "./tools-team.js";
import type { ToolDeps } from "./core.js";
import { runCore } from "./core.js";

const TEAM_ID = DEFAULT_TEAM_ID;

// ---------------------------------------------------------------------------
// zod 入参 schema（§1.2 T1；regToken 不设替代物——硬闸随 §2.2-P1 砍除）
// ---------------------------------------------------------------------------

export const IdentifyShape = {
  name: z.string().min(1).describe("要注册的名字（sanitizeKey 归一；保留名 lead/default 拒绝）"),
  sessionId: z.string().min(1).describe(
    "本会话的 sessionId——交互会话取 SessionStart 钩子注入的值；wake 回合取唤醒 prompt 显式给出的值。不要编造",
  ),
  role: z.enum(["peer", "worker"]).optional().describe("队内角色；缺省 peer"),
  takeover: z.boolean().optional().describe(
    "显式接管：name 在册但绑定旧 sid 已死（进程被杀/崩溃）时立即换绑并回池其未完任务。缺省 false=同名校验与现行一致（name_taken）。误判可恢复",
  ),
  wakeToken: z.string().optional().describe("无头唤醒回合的引擎令牌；缺省走钩子锚定路径"),
  displayName: z.string().optional().describe("展示名（可含中文，不参与寻址）"),
  kind: z.enum(["interactive", "bg"]).optional().describe("会话类别；缺省 interactive"),
  modeClass: z.enum(["bypass", "prompting"]).optional().describe("权限档类兜底；仅钩子基记录无档类时生效"),
  contextChars: z.number().int().positive().optional().describe("上下文字符数声明（注入预算刻度，R-18；缺省 XC_CONTEXT_CHARS/200k）"),
} as const;

export type IdentifyArgs = {
  name: string;
  sessionId: string;
  role?: "peer" | "worker";
  takeover?: boolean;
  wakeToken?: string;
  displayName?: string;
  kind?: "interactive" | "bg";
  modeClass?: "bypass" | "prompting";
  contextChars?: number;
};

export interface IdentifyCore {
  /** 队内轴注册（原 xc_register 核心 1:1 平移；regToken 已砍）。 */
  xc_register(args: { name: string; sessionId: string; role?: "peer" | "worker"; wakeToken?: string }, connectionKey: string): Promise<ToolResult>;
}

export function createIdentifyCore(deps: ToolDeps): IdentifyCore {
  const { stateRoot } = deps;
  return {
    async xc_register(args, connectionKey) {
      return runCore(stateRoot, async () => {
        // v0.5.3（a8）：把机器全局 peer 根传进注册路径——成功后盖 boundName 队内
        // 绑定标记到 peers/base/<sid>.json（v0.6 起仅作观测标记，不再触发验令牌闸）。
        const outcome = await xcRegister(stateRoot, args, connectionKey, {
          peerRoot: peerRootFromEnv(deps.env),
        });
        return okResult(
          renderRegister(sanitizeKey(args.name), args.sessionId, outcome.teamId, outcome.roster, outcome.warnings),
          {
            sessionKey: outcome.sessionKey,
            teamId: outcome.teamId,
            roster: outcome.roster,
            protocolDigest: outcome.protocolDigest,
            via: outcome.via,
            ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
          },
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// xc_identify 工具层（两轴合一 + 改名 + 接管）
// ---------------------------------------------------------------------------

/** 队内花名换绑的「板面干净」判定：名下无任何任务引用（assignee/createdBy）且邮箱为空。 */
async function teamMemberCleanForRename(
  stateRoot: string,
  teamId: string,
  agentKey: string,
): Promise<{ clean: boolean; reason?: string }> {
  const team = await readTeam(stateRoot, teamId);
  if (team === undefined) return { clean: true };
  const referenced = team.tasks.some((t) => t.assignee === agentKey || t.createdBy === agentKey);
  if (referenced) {
    return { clean: false, reason: "task references (assignee/createdBy) exist on the board" };
  }
  const mail = await readMailbox(stateRoot, teamId, agentKey);
  if (mail.length > 0) {
    return { clean: false, reason: "mailbox still holds message(s)" };
  }
  return { clean: true };
}

/** takeover 的两道活信号闸（T1 #5）。 */
async function takeoverGates(
  deps: ToolDeps,
  agentKey: string,
  sessionId: string,
  now: number,
): Promise<void> {
  // ① 在途唤醒标记：磁盘可跨进程读；15min 内命中 → 旧持有者可能正跑长回合。
  const inflight = await findInflightWakeNonce(deps.stateRoot, agentKey, { teamId: TEAM_ID, now });
  if (inflight !== undefined) {
    throw new ToolError({
      error: "takeover_inflight",
      agentKey,
      inflightSince: inflight.nonce.ts,
      windowMs: WAKE_INFLIGHT_MS,
      message: `member "${agentKey}" has an in-flight wake round (since ${new Date(inflight.nonce.ts).toISOString()}, ` +
        `window ${WAKE_INFLIGHT_MS} ms) — takeover refused: the old holder may still be running a long turn`,
    });
  }
  // ② peer 轴活 sid 冲突（本进程可判定的活连接冲突）。
  const holder = await findLiveSessionIdHolder(peerRootFromEnv(deps.env), sessionId);
  if (holder !== undefined) {
    throw new ToolError({
      error: "session_id_in_use",
      sessionId,
      boundName: holder.name ?? `pid-${holder.pid}`,
      boundPid: holder.pid,
      message: `sessionId "${sessionId}" is already registered by another live session — takeover refused`,
    });
  }
}

/** 接管执行：名下 OPEN（含 blocked）任务 revokeAttempt 回池 + 创建者回执（team 锁内）。 */
async function takeoverRevokeTasks(
  stateRoot: string,
  agentKey: string,
  by: string,
  now: number,
): Promise<Array<{ taskId: string; title: string; previousStatus: string }>> {
  const revoked: Array<{ taskId: string; title: string; previousStatus: string }> = [];
  await withTeamLock(stateRoot, TEAM_ID, async () => {
    const team = await readTeam(stateRoot, TEAM_ID);
    if (team === undefined) return;
    for (const task of memberOpenTasks(team.tasks, agentKey)) {
      const previousStatus = task.status;
      revokeAttempt(task, { event: "revoked-rebind-takeover", by, now });
      revoked.push({ taskId: task.id, title: task.title, previousStatus });
      // 创建者回执（复用僵尸清扫/成员停止的回执形态；不带 sourceAttemptId——
      // 收回后任务无当前 attempt，携带旧 token 会被 isCurrentMail 判陈旧）。
      const receipt = createMessage(
        agentKey,
        task.createdBy,
        JSON.stringify({
          type: "task-receipt",
          teamId: TEAM_ID,
          taskId: task.id,
          status: "failed",
          error: `revoked: member "${agentKey}" was taken over by a new session (xc_identify takeover); task returned to the pending pool`,
          title: task.title,
        }),
        { taskId: task.id, sourceTaskId: task.id, sourceTaskStatus: task.status, deliveryClaimedAt: now },
      );
      await appendMailbox(stateRoot, TEAM_ID, task.createdBy, receipt);
    }
    // 被接管名 == leadKey：追加 leadHistory（reason=member-rebind-takeover，L-n2）。
    if (team.leadKey === agentKey) {
      pushLeadHistory(team, {
        event: "transfer",
        from: agentKey,
        to: agentKey,
        ts: now,
        reason: "member-rebind-takeover",
      });
    }
    await writeTeam(stateRoot, team);
  });
  return revoked;
}

/**
 * xc_identify 主处理器（注册器由 registerIdentifyTools 挂进 server + dispatcher）。
 */
export async function handleIdentify(deps: ToolDeps, rawArgs: IdentifyArgs, connectionKey: string): Promise<ToolResult> {
  return runCore(deps.stateRoot, async () => {
    const services = getPeerServices(deps);
    const now = Date.now();
    const existing = identityStore.get(connectionKey);
    const newKey = sanitizeKey(rawArgs.name);
    if (newKey === "") {
      throw new ToolError({
        error: "invalid_params",
        name: rawArgs.name,
        message: `name ${JSON.stringify(rawArgs.name)} sanitizes to an empty key`,
      });
    }

    // ---- wake 回合（wakeToken 在场）：只绑队内轴（唤醒回合不监听 peer 管道）----
    if (rawArgs.wakeToken !== undefined && rawArgs.wakeToken.trim() !== "") {
      const outcome = await xcRegister(deps.stateRoot, {
        name: rawArgs.name,
        sessionId: rawArgs.sessionId,
        role: rawArgs.role,
        wakeToken: rawArgs.wakeToken,
      }, connectionKey, { peerRoot: peerRootFromEnv(deps.env) });
      return okResult(
        renderRegister(newKey, rawArgs.sessionId, outcome.teamId, outcome.roster, outcome.warnings),
        {
          sessionKey: outcome.sessionKey,
          teamId: outcome.teamId,
          roster: outcome.roster,
          protocolDigest: outcome.protocolDigest,
          via: outcome.via,
          ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
          takeoverApplied: [],
        },
      );
    }

    // ---- 改名（T1 #4）：连接已有身份且 name 与现名不同 ----
    if (existing !== undefined && existing.agentKey !== newKey) {
      const teamRename = await teamMemberCleanForRename(deps.stateRoot, existing.teamId, existing.agentKey);
      let peerRename: Awaited<ReturnType<typeof services.rename>> | undefined;
      let formerName: string | undefined;
      if (teamRename.clean) {
        // 队内花名换绑（registry 锁内：unbind 旧名 → bind 新名 → member key 换绑）。
        await withRegistryThenTeamLocks(deps.stateRoot, existing.teamId, async () => {
          await unbindName(deps.stateRoot, existing.agentKey, existing.sessionId);
          const team = await readTeam(deps.stateRoot, existing.teamId);
          if (team !== undefined) {
            const idx = team.members.findIndex((m) => m.key === existing.agentKey);
            if (idx >= 0) {
              team.members[idx] = { ...team.members[idx]!, key: newKey, lastSeen: now };
              await writeTeam(deps.stateRoot, team);
            }
          }
        });
        identityStore.bind(connectionKey, {
          ...existing,
          name: rawArgs.name,
          agentKey: newKey,
        });
        await logEngineEvent(deps.stateRoot, {
          event: "register-renamed",
          teamId: existing.teamId,
          from: existing.agentKey,
          to: newKey,
          sessionId: existing.sessionId,
        });
      }
      // peer 轴改名（已注册时）：formerNames + control:rename 通知（xc_peer_rename 现状行为）。
      const peerContext = getPeerSessionContext();
      if (peerContext !== undefined) {
        peerRename = await services.rename(rawArgs.name);
        formerName = peerRename.formerName;
      }
      if (!teamRename.clean) {
        // 队内轴板面不干净：不换绑（不串号不丢信），如实披露；peer 轴改名照常。
        return okResult(
          `Renamed (peer axis) to ${rawArgs.name}${formerName !== undefined ? ` (former: ${formerName})` : ""}; ` +
            `team-axis rename blocked: ${teamRename.reason} — board identity stays "${existing.agentKey}".`,
          {
            renamed: { peer: true, team: false },
            teamRenameBlocked: teamRename.reason,
            ...(peerRename !== undefined ? { peer: peerRename } : {}),
            teamId: existing.teamId,
            agentKey: existing.agentKey,
          },
        );
      }
      return okResult(
        `Renamed to ${rawArgs.name}${formerName !== undefined ? ` (former: ${formerName})` : ""} on both axes; ` +
          `roster key is now "${newKey}".`,
        {
          renamed: { peer: peerContext !== undefined, team: true },
          ...(peerRename !== undefined ? { peer: peerRename } : {}),
          teamId: existing.teamId,
          agentKey: newKey,
        },
      );
    }

    // ---- 接管（T1 #5）：name 已在队内花名册但绑定 sid ≠ 本次 sessionId ----
    const names = await readNames(deps.stateRoot);
    const heldByOther = names[newKey] !== undefined && names[newKey]!.sessionId !== rawArgs.sessionId;
    const teamNow = await readTeam(deps.stateRoot, TEAM_ID);
    const rosterMember = teamNow?.members.find((m) => m.key === newKey);
    if (heldByOther && rawArgs.takeover === true && rosterMember !== undefined && rosterMember.sessionId !== rawArgs.sessionId) {
      // 两道活信号闸（在途唤醒 / peer 轴活 sid 冲突）。
      await takeoverGates(deps, newKey, rawArgs.sessionId, now);
      // 名下 OPEN（含 blocked）任务回池 + 创建者回执 + lead 追加审计。
      const revoked = await takeoverRevokeTasks(deps.stateRoot, newKey, `takeover-by:${rawArgs.sessionId}`, now);
      // 花名换绑：unbind 旧 sid 绑定，交给 xcRegister 重新绑定（registry→team 锁序）。
      await withRegistryThenTeamLocks(deps.stateRoot, TEAM_ID, async () => {
        await unbindName(deps.stateRoot, newKey, rosterMember.sessionId);
      });
      const outcome = await xcRegister(deps.stateRoot, {
        name: rawArgs.name,
        sessionId: rawArgs.sessionId,
        role: rawArgs.role,
      }, connectionKey, { peerRoot: peerRootFromEnv(deps.env) });
      await logEngineEvent(deps.stateRoot, {
        event: "member-takeover",
        teamId: TEAM_ID,
        agentKey: newKey,
        fromSessionId: rosterMember.sessionId,
        toSessionId: rawArgs.sessionId,
        revokedTasks: revoked.map((r) => r.taskId),
      });
      // takeover 只作用于队内轴（peer 轴同名仍「先到者为准」拒）。
      return okResult(
        renderRegister(newKey, rawArgs.sessionId, outcome.teamId, outcome.roster, outcome.warnings) +
          ` takeover applied: ${revoked.length} open task(s) requeued with receipts to their creators.`,
        {
          sessionKey: outcome.sessionKey,
          teamId: outcome.teamId,
          roster: outcome.roster,
          protocolDigest: outcome.protocolDigest,
          via: outcome.via,
          ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
          takeover: true,
          takeoverApplied: ["team"],
          revokedTasks: revoked,
        },
      );
    }

    // ---- 常规注册：两轴合一（T1 #1）----
    const teamOutcome = await xcRegister(deps.stateRoot, {
      name: rawArgs.name,
      sessionId: rawArgs.sessionId,
      role: rawArgs.role,
    }, connectionKey, { peerRoot: peerRootFromEnv(deps.env) });
    let peerOutcome: PeerRegisterResult | undefined;
    let peerError: { error: string; message: string } | undefined;
    try {
      peerOutcome = await services.register({
        name: rawArgs.name,
        sessionId: rawArgs.sessionId,
        ...(rawArgs.displayName !== undefined ? { displayName: rawArgs.displayName } : {}),
        ...(rawArgs.kind !== undefined ? { kind: rawArgs.kind } : {}),
        ...(rawArgs.modeClass !== undefined ? { modeClass: rawArgs.modeClass } : {}),
        ...(rawArgs.contextChars !== undefined ? { contextChars: rawArgs.contextChars } : {}),
      });
    } catch (err) {
      // peer 轴失败不回滚队内轴（两轴存储独立；与旧两步调用「先注册成功后失败」
      // 的中间态一致），错误如实透出、队内注册事实在 payload 披露。
      peerError = err instanceof ToolError
        ? { error: String(err.payload["error"] ?? "peer_register_failed"), message: err.message }
        : { error: "peer_register_failed", message: err instanceof Error ? err.message : String(err) };
    }
    if (peerError !== undefined) {
      throw new ToolError({
        error: "peer_axis_failed",
        peer: peerError,
        teamAxis: {
          registered: true,
          sessionKey: teamOutcome.sessionKey,
          teamId: teamOutcome.teamId,
          via: teamOutcome.via,
        },
        message: `team-axis registration succeeded (${teamOutcome.sessionKey}) but peer-axis registration failed: ` +
          `${peerError.error} — ${peerError.message}. Resolve the peer-axis conflict (rename or reclaim) and re-run xc_identify.`,
      });
    }
    return okResult(
      renderRegister(newKey, rawArgs.sessionId, teamOutcome.teamId, teamOutcome.roster, teamOutcome.warnings) +
        ` Peer axis registered: ${peerOutcome!.name} (pid=${peerOutcome!.pid}, endpoint=${peerOutcome!.socketPath}).`,
      {
        sessionKey: teamOutcome.sessionKey,
        teamId: teamOutcome.teamId,
        roster: teamOutcome.roster,
        protocolDigest: teamOutcome.protocolDigest,
        via: teamOutcome.via,
        ...(teamOutcome.warnings.length ? { warnings: teamOutcome.warnings } : {}),
        peer: peerOutcome,
        takeoverApplied: [],
      },
    );
  });
}


// ---------------------------------------------------------------------------
// SDK 接线（FamilyRegistrar 形态；server.ts 持有 PrimaryRegistry）
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCore } from "./core.js";
import type { ToolDeps as _TD, PrimaryRegistry } from "./core.js";

/** 注册 xc_identify（tools/list 发现面 + dispatcher 分发面，双入口单实现）。 */
export function registerIdentifyTools(
  server: McpServer,
  deps: _TD,
  _core: ToolCore,
  registry: PrimaryRegistry,
): void {
  const description =
    "Register/rebind/rename/take over this session's identity on BOTH axes in one call (replaces xc_register + xc_peer_register + xc_peer_rename). " +
    "The name is the address on each axis; sessionId comes from the SessionStart hook (interactive) or the wake prompt (headless) - never invent it. " +
    "takeover:true (explicit) rebinds a dead holder's name and requeues its open tasks with receipts; it refuses while an in-flight wake round exists. " +
    "Soft validation only: name_taken on live conflicts, session_id_in_use on live sid clashes, idempotent exact-pair rebind. No regToken (removed in v0.6).";
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> =>
    handleIdentify(deps, args as unknown as IdentifyArgs, connectionKeyOf(extra));
  server.tool("xc_identify", description, IdentifyShape, handler);
  registry.set("xc_identify", { description, shape: IdentifyShape, handler });
}
