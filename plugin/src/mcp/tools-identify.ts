/**
 * v0.6 M1（DESIGN-V0.6.md §1.2 T1）：xc_identify —— 注册/重绑/改名/接管（两轴合一）。
 *
 * 合并队内注册 + peer 注册 + 改名的调用面；两轴存储不合并
 * （SKILL §9 独立性边界不变）——本文件只把两次注册合为一次调用：
 * - 队内轴 = xcRegister（identity.ts，软身份校验：name_taken / session_already_bound /
 *   removed 门 / wakeToken 路径；regToken 硬闸已随 §2.2-P1 砍除）。
 * - peer 轴 = PeerServices.register（peer-services.ts；session_id_in_use 活性冲突、
 *   session_not_anchored 锚定存在性、name_taken 先到者为准）。
 *
 * 改名（T1 #4）：连接已有身份且 name 与现名不同 → peer 轴 rename（formerNames +
 * control:rename 通知，peer 轴改名现状行为）；队内花名换绑仅在该成员
 * 「板面干净」（名下无任何任务引用且邮箱为空）时执行 member key 换绑——有在途
 * 引用时显式拒（team_rename_blocked），不串号不丢信。
 *
 * 接管（T1 #5）：name 已在队内花名册但绑定 sid ≠ 本次 sessionId 时，缺省
 * name_taken（不猜测旧持有者死活）；`takeover:true`（显式，对齐 xc_team takeover
 * 的 R-1/F-4 先例）过三道活信号闸（在途唤醒标记 15min 内 → takeover_inflight；
 * 接管方新 sid 活冲突 → session_id_in_use；**v0.6.1 安全对-4：旧持有者 sid 仍被
 * 活进程持有 → takeover_live_holder**——真实活信号，不依赖默认关闭的
 * wake_enabled）后立即换绑 + 名下 OPEN 任务（含 blocked）revokeAttempt 回池 +
 * 给创建者回执 + 审计 + leadHistory（lead 名被接管时 reason=member-rebind-takeover）。
 * 误判可恢复：被接管者的下份 report 得 stale_attempt 硬拒，按守则停手重取单
 * （README 威胁模型声明）。
 *
 * v0.6.1（安全对-2/边界-2）：花名严格校验（validateMemberName）覆盖注册/改名/
 * 接管全路径——拒绝会被 sanitizeKey 静默归一到碰撞键的写法（全角/同形字/路径符/
 * 控制符/空白/连字符变形），与 peer 轴严格文法同一口径；保留名（lead/default +
 * peer 保留集）两轴一致（安全对-5）。
 */

import { z } from "zod";
import { okResult, ToolError, type ToolResult } from "./protocol.js";
import { renderRegister } from "./render.js";
import { connectionKeyOf, identityStore, xcRegister } from "./identity.js";
import { withTeamLock, withRegistryThenTeamLocks } from "../core/lock.js";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { readNames, unbindName, findInflightWakeNonce, WAKE_INFLIGHT_MS } from "../core/registry.js";
import { sanitizeKey, validateMemberName } from "../core/sanitize.js";
import { DEFAULT_TEAM_ID } from "../core/types.js";
import { memberOpenTasks, readTeam, writeTeam } from "../core/teamstate.js";
import { revokeAttempt } from "../core/graph.js";
import { peerRootFromEnv } from "../core/peerdir.js";
// v0.6.1（安全对-1 修复）：findLiveSessionIdHolder 唯一实现移入 core/peerregistry.ts
// （队内轴 sid 归属校验也要用它；经 peer-services.ts import 会与 tools-team.ts 成环）。
import { findLiveSessionIdHolder } from "../core/peerregistry.js";
import { getPeerServices, type PeerRegisterResult } from "./peer-services.js";
import { getPeerSessionContext } from "./peer-drain.js";
import { pushLeadHistory } from "./tools-team.js";
import type { ToolDeps } from "./core.js";
import { runCore } from "./core.js";

const TEAM_ID = DEFAULT_TEAM_ID;

// ---------------------------------------------------------------------------
// zod 入参 schema（§1.2 T1；regToken 不设替代物——硬闸随 §2.2-P1 砍除）
// ---------------------------------------------------------------------------

export const IdentifyShape = {
  name: z.string().min(1).describe(
    "要注册的名字（须已是规范键形：字母/数字/单个连字符，≤48 字符；全角/同形字/路径符/控制符/空格/下划线等会被静默归一的写法一律拒绝；保留名 lead/default/main/team-lead/user/system 拒绝）",
  ),
  sessionId: z.string().min(1).describe(
    "本会话的 sessionId——交互会话取 SessionStart 钩子注入的值；wake 回合取唤醒 prompt 显式给出的值。不要编造",
  ),
  role: z.enum(["peer", "worker"]).optional().describe("队内角色；缺省 peer"),
  takeover: z.boolean().optional().describe(
    "显式接管：name 在册但绑定旧 sid 已死（进程被杀/崩溃）时立即换绑并回池其未完任务。缺省 false=同名校验与现行一致（name_taken）。旧持有者仍活着（peer 轴活记录）时拒（takeover_live_holder）——真实活信号，与 wake_enabled 无关。误判可恢复",
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
  /** 队内轴注册（原注册核心 1:1 平移；regToken 已砍）。 */
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

/**
 * takeover 的活信号闸（T1 #5；v0.6.1 红队四番战 安全对-4 修复后为三道）。
 *
 * 安全对-4（P1，confirmed）：`takeover:true` 可夺走**活着**的成员的队内身份与
 * lead——唯一实质闸门是在途唤醒标记，而它依赖默认关闭的 wake_enabled
 * （XC_WAKE_ENABLED=false 时永不落盘）；原 ② 查的是**接管方自己的新 sid**，
 * 对旧持有者死活完全不设防。修复 = 补第三道闸：旧持有者 sid 仍被活进程持有
 * （peer 轴活记录：pid 存活 + 15s 心跳）即拒——真实活信号，不依赖 wake_enabled，
 * 也与 peer 轴 reclaim 语义对齐（死记录被惰性清扫后才可接管）。
 */
async function takeoverGates(
  deps: ToolDeps,
  agentKey: string,
  sessionId: string,
  oldSessionId: string,
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
  // ② 接管方自己的新 sid 已被别的活进程持有 → 拒。放在换绑前：否则 unbindName
  //    已发生而随后的注册才失败，花名会卡在「已解绑未重绑」的中间态。
  const newHolder = await findLiveSessionIdHolder(peerRootFromEnv(deps.env), sessionId);
  if (newHolder !== undefined) {
    throw new ToolError({
      error: "session_id_in_use",
      sessionId,
      boundName: newHolder.name ?? `pid-${newHolder.pid}`,
      boundPid: newHolder.pid,
      message: `sessionId "${sessionId}" is already registered by another live session — takeover refused`,
    });
  }
  // ③ v0.6.1（安全对-4 修复）：旧持有者活性闸——旧 sid 仍被**活进程**持有
  //    （peer 轴活记录）→ 接管拒。takeover 的文档语义是「接管已死持有者的花名」
  //    （进程被杀/崩溃后）；旧持有者还活着时必须走正常流程（它自己改名、或
  //    lead 的 member-stop / xc_team transfer）。死持有者的记录不在 active
  //    （惰性清扫）→ 合法 dead-sid 接管不受影响。
  if (oldSessionId !== "") {
    const oldHolder = await findLiveSessionIdHolder(peerRootFromEnv(deps.env), oldSessionId);
    if (oldHolder !== undefined) {
      const boundName = oldHolder.name ?? `pid-${oldHolder.pid}`;
      throw new ToolError({
        error: "takeover_live_holder",
        agentKey,
        sessionId: oldSessionId,
        boundName,
        boundPid: oldHolder.pid,
        message: `member "${agentKey}" is still held by a live session (sid "${oldSessionId}", name "${boundName}") — ` +
          "takeover refused: wait for the old holder to exit (its process dead), or use the normal flows " +
          "(the holder renames itself; the lead runs xc_team transfer / member-stop)",
      });
    }
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
    // ---- v0.6.1（红队四番战 安全对-2 / 边界-2 修复）：花名严格校验 ----
    // 注册/改名/接管全路径同一道闸（改名路径此前只 sanitizeKey、不验保留名也不
    // 验文法——"LEAD" 可改名成 roster 键 lead 并自任 founder/lead，边界-2）。
    // 校验在任何状态变更（unbindName / 成员 key 换绑 / 注册）之前，拒绝即零副作用。
    const nameCheck = validateMemberName(rawArgs.name);
    if (!nameCheck.ok) {
      throw new ToolError(
        { error: nameCheck.error, name: nameCheck.name, message: nameCheck.message },
        nameCheck.message,
      );
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
      // 边界-1 修复（P1）：本次队内 key 换绑是否带动了 leadKey/founderKey（审计/回显用）。
      let leadKeyFollowed = false;
      let founderKeyFollowed = false;
      if (teamRename.clean) {
        // 队内花名换绑（registry 锁内：unbind 旧名 → bind 新名 → member key 换绑）。
        await withRegistryThenTeamLocks(deps.stateRoot, existing.teamId, async () => {
          await unbindName(deps.stateRoot, existing.agentKey, existing.sessionId);
          const team = await readTeam(deps.stateRoot, existing.teamId);
          if (team !== undefined) {
            const idx = team.members.findIndex((m) => m.key === existing.agentKey);
            if (idx >= 0) {
              team.members[idx] = { ...team.members[idx]!, key: newKey, lastSeen: now };
              // 边界-1 修复（P1）：lead/founder 花名随动——成员 key 换绑而
              // leadKey/founderKey 不随动会悬空，把现任 lead 锁死在
              // transfer/release/init 之外（not_lead / lead_exists），且 idle
              // 收件人与 overview 的 founder 行指向不存在的成员。角色跟随会话
              // 本人（同一 sid），不改变 lead 归属语义。
              if (team.leadKey === existing.agentKey) {
                team.leadKey = newKey;
                leadKeyFollowed = true;
              }
              if (team.founderKey === existing.agentKey) {
                team.founderKey = newKey;
                founderKeyFollowed = true;
              }
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
          ...(leadKeyFollowed ? { leadKeyFollowed: true } : {}),
          ...(founderKeyFollowed ? { founderKeyFollowed: true } : {}),
        });
      }
      // peer 轴改名（已注册时）：formerNames + control:rename 通知（peer 轴改名现状行为）。
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
      const roleFollowed = leadKeyFollowed || founderKeyFollowed;
      return okResult(
        `Renamed to ${rawArgs.name}${formerName !== undefined ? ` (former: ${formerName})` : ""} on both axes; ` +
          `roster key is now "${newKey}".` +
          (roleFollowed ? ` leadKey/founderKey updated to "${newKey}" (role follows this session).` : ""),
        {
          renamed: { peer: peerContext !== undefined, team: true },
          ...(peerRename !== undefined ? { peer: peerRename } : {}),
          teamId: existing.teamId,
          agentKey: newKey,
          ...(leadKeyFollowed ? { leadKeyFollowed: true } : {}),
          ...(founderKeyFollowed ? { founderKeyFollowed: true } : {}),
        },
      );
    }

    // ---- 接管（T1 #5）：name 已在队内花名册但绑定 sid ≠ 本次 sessionId ----
    const names = await readNames(deps.stateRoot);
    const heldByOther = names[newKey] !== undefined && names[newKey]!.sessionId !== rawArgs.sessionId;
    const teamNow = await readTeam(deps.stateRoot, TEAM_ID);
    const rosterMember = teamNow?.members.find((m) => m.key === newKey);
    if (heldByOther && rawArgs.takeover === true && rosterMember !== undefined && rosterMember.sessionId !== rawArgs.sessionId) {
      // 三道活信号闸（在途唤醒 / 接管方新 sid 活冲突 / v0.6.1 安全对-4：旧持有者活性）。
      await takeoverGates(deps, newKey, rawArgs.sessionId, rosterMember.sessionId, now);
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
    "Register/rebind/rename/take over this session's identity on BOTH axes in one call (team axis and peer axis unified). " +
    "The name is the address on each axis; sessionId comes from the SessionStart hook (interactive) or the wake prompt (headless) - never invent it: a sessionId already held by another live session is refused (session_id_in_use, team axis included). " +
    "Names must already be in canonical key form (letters/digits/single dashes, ≤48 chars); silently-normalizing spellings (fullwidth, homoglyphs, path/control characters, spaces, underscores) are refused - same strict grammar as the peer axis. " +
    "takeover:true (explicit) rebinds a dead holder's name and requeues its open tasks with receipts; it refuses while an in-flight wake round exists or the old holder is still live (takeover_live_holder). " +
    "Soft validation only: name_taken on live conflicts, session_id_in_use on live sid clashes, idempotent exact-pair rebind. No regToken (removed in v0.6).";
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> =>
    handleIdentify(deps, args as unknown as IdentifyArgs, connectionKeyOf(extra));
  server.tool("xc_identify", description, IdentifyShape, handler);
  registry.set("xc_identify", { description, shape: IdentifyShape, handler });
}
