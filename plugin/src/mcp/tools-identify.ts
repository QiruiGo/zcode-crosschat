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
import { readNames, readSession, unbindName, bindName, findInflightWakeNonce, WAKE_INFLIGHT_MS } from "../core/registry.js";
import { sanitizeKey, validateMemberName } from "../core/sanitize.js";
import { DEFAULT_TEAM_ID, TERMINAL_TASK_STATUSES } from "../core/types.js";
import type { MemberRole } from "../core/types.js";
import { memberOpenTasks, readTeam, writeTeam } from "../core/teamstate.js";
import { revokeAttempt } from "../core/graph.js";
import { peerRootFromEnv } from "../core/peerdir.js";
// v0.9.8（组 O D7 / V097-21）：未读判据收敛到 core/checkpoint.ts 单一真源
// currentUnreadMessages（未读 ∧ 未丢弃 ∧ isCurrentMail）——与 panel / status / team 板面 /
// checkpoint 第 5 章同一判据。改名守卫此前自带 readUnreadMailbox（只滤 readAt/discardedAt、
// 不过 isCurrentMail），同一邮箱观测四面报 0 而守卫报 2，成员被幽灵未读挡住改名。
import { carryCheckpointDir, currentUnreadMessages } from "../core/checkpoint.js";
// v0.6.1（安全对-1 修复）：findLiveSessionIdHolder 唯一实现移入 core/peerregistry.ts
// （队内轴 sid 归属校验也要用它；经 peer-services.ts import 会与 tools-team.ts 成环）。
import { findLivePeerByName, findLiveSessionIdHolder } from "../core/peerregistry.js";
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

/**
 * 队内花名换绑的「板面干净」判定。
 *
 * v0.8.1（29-v080 C6-BUG-6 修复）：判据从「名下**任何**任务引用」改为
 * 「名下**非终态**任务引用」——completed/cancelled/failed 是历史审计痕迹
 * （assignee/createdBy 永驻），旧判据下「做完手上的活再改名」这条错误文案
 * 指定的恢复动作全部做完也仍被 `team_rename_blocked`：有任务历史的成员永远
 * 无法改名（红队 lane-b6 实测死胡同；无任何工具能移除终态记录）。终态引用
 * 不再挡路，但**开放**引用照旧挡（开放任务换主会串号、pending 任务的指定
 * 受领人 `to` 换名会搁浅——他人 claim 得 not_assignee、pending 又不在
 * stale 清扫域内，与 member-stop 的停机任务同款 stranded 形态）。
 * 邮箱非空照旧挡（未读件会锁死在不再存在的花名箱里）。
 *
 * @returns clean + 挡路项明细（开放任务 id / 指定受领的 pending id / 邮箱条数）
 *  与保留的终态引用数（改名成功回执里披露，不静默）。
 */
async function teamMemberCleanForRename(
  stateRoot: string,
  teamId: string,
  agentKey: string,
): Promise<{
  clean: boolean;
  reason?: string;
  openTaskIds: string[];
  designatedPendingIds: string[];
  mailboxCount: number;
  terminalRefCount: number;
}> {
  const team = await readTeam(stateRoot, teamId);
  if (team === undefined) {
    return { clean: true, openTaskIds: [], designatedPendingIds: [], mailboxCount: 0, terminalRefCount: 0 };
  }
  const openTaskIds = team.tasks
    .filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status) && t.assignee === agentKey)
    .map((t) => t.id);
  const designatedPendingIds = team.tasks
    .filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status) && t.assignee !== agentKey && t.to === agentKey)
    .map((t) => t.id);
  const createdOpenIds = team.tasks
    .filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status) && t.createdBy === agentKey)
    .map((t) => t.id);
  const terminalRefCount = team.tasks.filter(
    (t) => TERMINAL_TASK_STATUSES.includes(t.status) && (t.assignee === agentKey || t.createdBy === agentKey),
  ).length;
  // 邮箱判据用**未读**（未读 ∧ 未丢弃 ∧ isCurrentMail——v0.9.8 组 O D7/V097-21 起
  // 统一到 core/checkpoint.ts 单一真源 currentUnreadMessages，与 panel/status/板面/
  // checkpoint 第 5 章同一判据）。已读历史只是留痕，换名后照旧躺在旧花名的 inbox
  // 文件里，没有功能路径会再读它；会锁死的是**现行未读**件（换名后旧箱不再被任何
  // 工具面引用——成员视角按花名册键寻址，旧键已不在册）。v0.8.1 修正：旧实现用
  // readMailbox 全史判定，「收到过任何消息」与「有未读」混同；v0.9.8 D7：再修掉
  // 「陈旧件也算未读」——观测四面 0 而守卫 2 的矛盾（成员被幽灵未读挡住改名）。
  const unread = currentUnreadMessages(team, await readMailbox(stateRoot, teamId, agentKey));
  if (openTaskIds.length > 0 || createdOpenIds.length > 0 || designatedPendingIds.length > 0) {
    const parts: string[] = [];
    if (openTaskIds.length > 0) parts.push(`open task(s) assigned to you: ${openTaskIds.join(", ")}`);
    if (createdOpenIds.length > 0) parts.push(`open task(s) you created: ${createdOpenIds.join(", ")}`);
    if (designatedPendingIds.length > 0) parts.push(`pending task(s) dispatched to you: ${designatedPendingIds.join(", ")}`);
    return {
      clean: false,
      reason: parts.join("; "),
      openTaskIds,
      designatedPendingIds,
      mailboxCount: unread.length,
      terminalRefCount,
    };
  }
  if (unread.length > 0) {
    return {
      clean: false,
      reason: `mailbox still holds ${unread.length} unread message(s) — drain with xc_read({scope:"inbox"}) first`,
      openTaskIds,
      designatedPendingIds,
      mailboxCount: unread.length,
      terminalRefCount,
    };
  }
  return { clean: true, openTaskIds, designatedPendingIds, mailboxCount: unread.length, terminalRefCount };
}

/**
 * v0.7.1（红队四番战 边界-6 修复）：把「已落地的队内改名」逆回原名。
 *
 * 改名是两轴合一操作：队内轴换键（unbind 旧名 → member key 换绑）之后才做 peer
 * 轴改名。v0.7.0 及以前 peer 轴改名失败（典型：新花名在 peer 轴被另一个活会话
 * 占着 → name_taken）时，队内轴已经换成新键而 peer 轴还是旧名——同一会话两个
 * 身份，正是边界-6 在另一个方向上的同一根因（多轴操作不原子）。本函数与改名路径
 * 里的队内正操作一一对应（unbind 新名 → 重绑旧名 → member key 换回 → leadKey/
 * founderKey 换回 → 连接绑定换回），把队内轴改回原状。
 *
 * 永不抛：内部 IO 失败只审计并返回 `{ok:false,error}`，由调用方在错误信封里如实
 * 披露（`teamAxis.rolledBack:false` + `rollbackError`）。
 */
async function undoTeamRename(
  deps: ToolDeps,
  connectionKey: string,
  from: { teamId: string; agentKey: string; sessionId: string; name: string; role: MemberRole },
  to: { agentKey: string; name: string },
  followed: { leadKey: boolean; founderKey: boolean },
): Promise<{ ok: boolean; error?: string }> {
  try {
    await withRegistryThenTeamLocks(deps.stateRoot, from.teamId, async () => {
      await unbindName(deps.stateRoot, to.agentKey, from.sessionId);
      await bindName(deps.stateRoot, from.agentKey, {
        sessionId: from.sessionId,
        role: from.role,
        registeredAt: Date.now(),
      });
      const team = await readTeam(deps.stateRoot, from.teamId);
      if (team === undefined) return;
      const idx = team.members.findIndex((m) => m.key === to.agentKey);
      if (idx >= 0) {
        team.members[idx] = { ...team.members[idx]!, key: from.agentKey, lastSeen: Date.now() };
        if (followed.leadKey && team.leadKey === to.agentKey) team.leadKey = from.agentKey;
        if (followed.founderKey && team.founderKey === to.agentKey) team.founderKey = from.agentKey;
        await writeTeam(deps.stateRoot, team);
      }
    });
    identityStore.bind(connectionKey, {
      sessionKey: `xc:${from.teamId}:${from.agentKey}`,
      teamId: from.teamId,
      name: from.name,
      agentKey: from.agentKey,
      sessionId: from.sessionId,
      role: from.role,
      boundAt: Date.now(),
    });
    await logEngineEvent(deps.stateRoot, {
      event: "register-rename-rolled-back",
      teamId: from.teamId,
      from: to.agentKey,
      to: from.agentKey,
      sessionId: from.sessionId,
      reason: "peer-axis-rename-failed",
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEngineEvent(deps.stateRoot, {
      event: "register-rename-rollback-failed",
      teamId: from.teamId,
      from: to.agentKey,
      to: from.agentKey,
      sessionId: from.sessionId,
      error: message,
    });
    return { ok: false, error: message };
  }
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
      // ---- v0.8.1（29-v080 M01 修复，P1）：改名两轴**前置校验**（零副作用）----
      // M01 根因：队内轴花名换绑先落地（roster 成员键直接换成 newKey），peer 轴
      // 改名随后才做，且落地前不问「newKey 是不是已经有人」。两种碰撞都把队内轴
      // 写成损坏态：
      // ① newKey 已是队内花名册另一位成员 → members 出现重复键 → readTeam 拒读
      //    （duplicate member keys）、.bak 被同一份坏内容镜像中毒 → 全队 team-axis
      //    工具 internal；undoTeamRename 自己也要 readTeam，回滚随之失败。
      // ② newKey 在 peer 轴被另一个活会话占着 → peer rename name_taken，同样的
      //    「落地→失败→回滚失败」链（红队 C2-B1/C6-BUG-2，含 plain identify 变体）。
      // 修复 = 任何状态变更之前两轴各问一次：队内占用 → team_rename_blocked；
      // peer 占用 → peer_axis_failed（预检形态：teamAxis.registered:false，
      // 两轴都没动，调用方可直接重试）。
      const teamForRename = await readTeam(deps.stateRoot, existing.teamId);
      const rosterHolder = teamForRename?.members.find((m) => m.key === newKey);
      if (rosterHolder !== undefined) {
        throw new ToolError(
          {
            error: "team_rename_blocked",
            agentKey: existing.agentKey,
            requestedName: rawArgs.name,
            reason:
              `name "${newKey}" is held by another member on the team roster ` +
              `(session ${rosterHolder.sessionId})`,
            renamed: { peer: false, team: false },
            message:
              `rename refused on BOTH axes: "${newKey}" is already a member of team "${existing.teamId}" ` +
              `(held by session ${rosterHolder.sessionId}), so renaming you onto it would corrupt the roster ` +
              `(duplicate member keys) — neither axis was changed and this session keeps its single identity ` +
              `"${existing.agentKey}". Pick a free name and re-run xc_identify. Taking over that member's ` +
              `identity is a different operation: it requires a session that does not already hold an ` +
              `identity (fresh xc_identify({name:"${newKey}", sessionId:<your own sid>, takeover:true})), ` +
              `or the lead runs xc_team member-stop/transfer.`,
          },
          `rename refused on both axes: "${newKey}" is held by another roster member; peer axis unchanged`,
        );
      }
      // peer 轴预检：只读扫描（不惰性清扫——死记录是 C8 离线判据的进程死证据），
      // 本进程自己的记录豁免（幂等重认领不构成冲突）。仅当本会话**在 peer 轴在册**
      // 时问这一句——wake 回合身份从不上 peer 轴（改名也只会动队内轴），不替它加闸
      // （保持 v0.8.0 对 wake 会话的既有行为）；在册会话的 peer 改名随后才会真发生，
      // 预检正是要把它的 name_taken 从「落地后失败」提前成「落地前拒绝」。
      const peerContextForCheck = getPeerSessionContext();
      const peerHolder = peerContextForCheck === undefined
        ? undefined
        : await findLivePeerByName(peerRootFromEnv(deps.env), newKey);
      if (peerHolder !== undefined) {
        const holderName = peerHolder.name ?? `pid-${peerHolder.pid}`;
        throw new ToolError(
          {
            error: "peer_axis_failed",
            peer: {
              error: "name_taken",
              name: newKey,
              boundName: holderName,
              boundPid: peerHolder.pid,
              message:
                `peer name "${newKey}" is already registered on this machine by a live session ` +
                `(pid ${peerHolder.pid}, name "${holderName}")`,
            },
            teamAxis: { registered: false, rolledBack: false, agentKey: existing.agentKey, teamId: existing.teamId },
            renamed: { peer: false, team: false },
            message:
              `rename refused on BOTH axes: the peer axis already holds "${newKey}" (live session pid ` +
              `${peerHolder.pid}, name "${holderName}"), so the team-axis rename was never applied — this ` +
              `session keeps its single identity "${existing.agentKey}" and the call had no side effect. ` +
              `Resolve the peer-axis conflict (that session renames or exits) and re-run xc_identify.`,
          },
          `peer-axis rename refused by pre-check (name_taken); team-axis rename not applied`,
        );
      }
      const teamRename = await teamMemberCleanForRename(deps.stateRoot, existing.teamId, existing.agentKey);
      let peerRename: Awaited<ReturnType<typeof services.rename>> | undefined;
      let formerName: string | undefined;
      // 边界-1 修复（P1）：本次队内 key 换绑是否带动了 leadKey/founderKey（审计/回显用）。
      let leadKeyFollowed = false;
      let founderKeyFollowed = false;
      // v0.7.1（红队四番战 边界-6 修复）：改名两轴**原子**。
      // v0.7.0 及以前：队内轴被守卫阻止（板面不干净）时仍继续做 peer 轴改名，
      // 回执还是成功（`renamed:{peer:true,team:false}`）——同一会话于是有两个
      // 身份：队内旧名（派单/读箱照旧认它）+ peer 新名（寻址认它）。红队 b678
      // 复放：`xc_dispatch{to:"tm-b2"}` → not_a_member，而 `to:"tm-b"` 照常投递。
      // 修复 = 队内轴拒了就**两轴都不动**（显式错误、零副作用），不再给「半边
      // 改名」的成功回执。
      if (!teamRename.clean) {
        throw new ToolError(
          {
            error: "team_rename_blocked",
            agentKey: existing.agentKey,
            requestedName: rawArgs.name,
            reason: teamRename.reason,
            renamed: { peer: false, team: false },
            openTaskIds: teamRename.openTaskIds,
            designatedPendingIds: teamRename.designatedPendingIds,
            mailboxCount: teamRename.mailboxCount,
            terminalTaskRefs: teamRename.terminalRefCount,
            message:
              `rename refused on BOTH axes: the team axis blocks the rename (${teamRename.reason}), ` +
              `so the peer axis was left unchanged too — this session keeps its single identity ` +
              `"${existing.agentKey}". Finish or cancel the open task(s), or ask the dispatcher/lead to ` +
              `redispatch/cancel the ones designated to you, and drain the mailbox ` +
              `(xc_read({scope:"inbox"})), then re-run xc_identify; if the identity must move now, ask the ` +
              `lead to run xc_team member-stop/transfer. ` +
              (teamRename.terminalRefCount > 0
                ? `Note: ${teamRename.terminalRefCount} completed/cancelled/failed record(s) still reference ` +
                  `"${existing.agentKey}" — those are historical audit entries and do NOT block the rename.`
                : ""),
          },
          `rename refused on both axes: team-axis rename blocked (${teamRename.reason}); peer axis unchanged`,
        );
      }
      {
        // 队内花名换绑（registry 锁内：unbind 旧名 → member key 换绑）。
        // v0.7.2（红队五番战 CB-01 修复）：换绑后**写新花名的 names.json 绑定**。
        // v0.7.0~v0.7.1 这里只解绑旧名、不为新名写绑定（「既有语义」）——names.json
        // 于是既无旧键也无新键，而 SessionStart 钩子的「已注册花名」判定就读
        // names.json（hooks/shared.ts boundNamesForSession）：改名成功的会话下一轮
        // 钩子注入误报「尚未注册跨会话花名」（红队 capbug1 实测；功能路由不受影响、
        // 无冒名窗口，但观测面自相矛盾）。names.json 是 name→{sessionId,role,
        // registeredAt} 的索引——本会话确实已绑到新名，写进去才与事实一致；
        // undoTeamRename 的「解绑新名 + 重绑旧名」也从此与正操作严格互逆。
        // 冲突保护：新键已被**别的 sid** 绑定（陈旧死绑定）时不覆盖——那属于
        // 接管语义（takeover/claim 路径），改名面不越权改别人的索引行。
        await withRegistryThenTeamLocks(deps.stateRoot, existing.teamId, async () => {
          const namesNow = await readNames(deps.stateRoot);
          await unbindName(deps.stateRoot, existing.agentKey, existing.sessionId);
          const foreign = namesNow[newKey];
          if (foreign === undefined || foreign.sessionId === existing.sessionId) {
            await bindName(deps.stateRoot, newKey, {
              sessionId: existing.sessionId,
              role: existing.role,
              registeredAt: now,
            });
          }
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
        try {
          peerRename = await services.rename(rawArgs.name);
          formerName = peerRename.formerName;
        } catch (err) {
          // v0.7.1（边界-6 同根因的反方向）：队内轴已换键而 peer 轴改名失败
          // （典型：新花名在 peer 轴被另一个活会话占着 → name_taken）——不留下
          // 「队内新名 + peer 旧名」的半个改名，把队内轴逆回原键后如实报错。
          const peerError = err instanceof ToolError
            ? { error: String(err.payload["error"] ?? "peer_rename_failed"), message: err.message }
            : { error: "peer_rename_failed", message: err instanceof Error ? err.message : String(err) };
          const undo = await undoTeamRename(
            deps,
            connectionKey,
            {
              teamId: existing.teamId,
              agentKey: existing.agentKey,
              sessionId: existing.sessionId,
              name: existing.name,
              role: existing.role,
            },
            { agentKey: newKey, name: rawArgs.name },
            { leadKey: leadKeyFollowed, founderKey: founderKeyFollowed },
          );
          throw new ToolError(
            {
              error: "peer_axis_failed",
              peer: peerError,
              teamAxis: {
                registered: !undo.ok,
                rolledBack: undo.ok,
                ...(undo.error !== undefined ? { rollbackError: undo.error } : {}),
                agentKey: undo.ok ? existing.agentKey : newKey,
                teamId: existing.teamId,
              },
              renamed: { peer: false, team: !undo.ok },
              message:
                `team-axis rename landed but peer-axis rename failed: ${peerError.error} — ${peerError.message}. ` +
                (undo.ok
                  ? `The team-axis rename was rolled back to "${existing.agentKey}" (no identity split; both axes still say "${existing.agentKey}"). `
                  : `The team-axis rollback FAILED (${undo.error ?? "unknown"}): the board now says "${newKey}" while the peer axis still says "${existing.agentKey}" — resolve the peer-axis conflict, then re-run xc_identify. `) +
                `Resolve the peer-axis conflict (rename or reclaim) and re-run xc_identify.`,
            },
            `peer-axis rename failed (${peerError.error}); team-axis rename ${undo.ok ? "rolled back" : "rollback failed"}`,
          );
        }
      }
      const roleFollowed = leadKeyFollowed || founderKeyFollowed;
      // v0.8.1（29-v080 C2-B3 修复）：改名连续性——检查点目录随花名换绑搬迁
      // （best-effort：搬失败不阻断已成功的两轴改名，只在回执里披露旧路径）。
      // 此前改名只换 roster 键，`checkpoints/<旧名>/` 原地成孤儿：默认 self
      // 接手包七要素之一「最近检查点」静默变 null，旧目录不再被任何工具面引用
      // （红队 adj-b3 实测：改名前后 handoff checkpoint present→null 无 warning）。
      // 放在 peer 轴改名成功之后：任一轴失败都会走回滚，目录不该先搬。
      const carried = await carryCheckpointDir(deps.stateRoot, existing.agentKey, newKey);
      if (carried.carried) {
        await logEngineEvent(deps.stateRoot, {
          event: "register-rename-checkpoint-carried",
          teamId: existing.teamId,
          from: existing.agentKey,
          to: newKey,
        });
      } else if (carried.error !== undefined) {
        await logEngineEvent(deps.stateRoot, {
          event: "register-rename-checkpoint-carry-failed",
          teamId: existing.teamId,
          from: existing.agentKey,
          to: newKey,
          error: carried.error,
        });
      }
      return okResult(
        `Renamed to ${rawArgs.name}${formerName !== undefined ? ` (former: ${formerName})` : ""} on both axes; ` +
          `roster key is now "${newKey}".` +
          (roleFollowed ? ` leadKey/founderKey updated to "${newKey}" (role follows this session).` : "") +
          (carried.carried ? ` Checkpoint history carried over from "${existing.agentKey}".` : "") +
          (carried.error !== undefined
            ? ` WARNING: checkpoint directory could not be carried over (${carried.error}) — the old files stay at checkpoints/${existing.agentKey}/ and the default handoff packet will not show them.`
            : "") +
          (teamRename.terminalRefCount > 0
            ? ` Note: ${teamRename.terminalRefCount} terminal task record(s) still name "${existing.agentKey}" as assignee/creator — kept as historical audit (they no longer block renames).`
            : ""),
        {
          renamed: { peer: peerContext !== undefined, team: true },
          ...(peerRename !== undefined ? { peer: peerRename } : {}),
          teamId: existing.teamId,
          agentKey: newKey,
          ...(leadKeyFollowed ? { leadKeyFollowed: true } : {}),
          ...(founderKeyFollowed ? { founderKeyFollowed: true } : {}),
          ...(carried.carried ? { checkpointCarried: { from: existing.agentKey, to: newKey } } : {}),
          ...(carried.error !== undefined
            ? { warnings: [`checkpoint directory could not be carried over: ${carried.error}`] }
            : {}),
          ...(teamRename.terminalRefCount > 0 ? { terminalTaskRefs: teamRename.terminalRefCount } : {}),
        },
      );
    }

    // ---- 接管（T1 #5）：name 已在队内花名册但绑定 sid ≠ 本次 sessionId ----
    const names = await readNames(deps.stateRoot);
    const heldByOther = names[newKey] !== undefined && names[newKey]!.sessionId !== rawArgs.sessionId;
    const teamNow = await readTeam(deps.stateRoot, TEAM_ID);
    const rosterMember = teamNow?.members.find((m) => m.key === newKey);
    if (heldByOther && rawArgs.takeover === true && rosterMember !== undefined && rosterMember.sessionId !== rawArgs.sessionId) {
      // ---- v0.8.1（29-v080 C6-BUG-1 修复，P2）：takeover **先验后改** ----
      // xcRegister 的 hook 路径会在 bindName/joinTeam **之前**校验 sessionId
      // （锚定存在性 → session_not_anchored；sid 未被别的花名绑 → session_already_bound），
      // 但 takeover 路径此前先做 `takeoverRevokeTasks`（在途 attempt 撤销、任务回池、
      // 创建者回执）与 `unbindName`（摘 names 绑定）才走到 xcRegister——一个未锚定
      // sid 的失败调用于是带着全部副作用返回，违反 §10「失败=无副作用、可直接重试」
      // （红队 lane-b1-repro 实测：attempt 1→2、任务 claimed→pending、names 丢绑定）。
      // 修复 = 同一批校验前置到任何状态变更之前；错误码/文案与 xcRegister 逐字一致。
      const anchored = await readSession(deps.stateRoot, rawArgs.sessionId);
      if (anchored === undefined) {
        throw new ToolError({
          error: "session_not_anchored",
          sessionId: rawArgs.sessionId,
          message:
            `no session record for "${rawArgs.sessionId}": the SessionStart hook did not anchor this session; ` +
            "use a wakeToken (headless rounds) or verify the hook ran",
        });
      }
      const sidBoundElsewhere = Object.entries(names).find(
        ([otherName, binding]) => otherName !== newKey && binding.sessionId === rawArgs.sessionId,
      );
      if (sidBoundElsewhere !== undefined) {
        throw new ToolError({
          error: "session_already_bound",
          sessionId: rawArgs.sessionId,
          boundName: sidBoundElsewhere[0],
          message: `session "${rawArgs.sessionId}" is already bound to name "${sidBoundElsewhere[0]}"`,
        });
      }
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
      // v0.7.1（红队四番战 边界-4 修复）：peer 轴失败**回滚队内轴**。
      // v0.7.0 及以前这里只透出错误，队内轴的 names.json 绑定 / team.json 成员行
      // / 连接绑定全部留在盘上，回执还写着 `teamAxis.registered:true`——调用方
      // 不能把错误当「无副作用」，且重跑会撞上自己刚建的状态（红队 g3-b4 复放：
      // 一次 peer name_taken 的 identify 之后，names.json 已绑、roster 已入、
      // 甚至当上 founderKey）。回滚后错误信封如实报告 `teamAxis.registered:false`
      // + `rolledBack:true`；回滚自身失败也如实（registered 仍 true）。
      peerError = err instanceof ToolError
        ? { error: String(err.payload["error"] ?? "peer_register_failed"), message: err.message }
        : { error: "peer_register_failed", message: err instanceof Error ? err.message : String(err) };
      const undo = await teamOutcome.rollback();
      if (!undo.ok) {
        // 回滚自身失败：状态仍在，payload 必须如实（不能把没回滚成的说成回滚了）。
        await logEngineEvent(deps.stateRoot, {
          event: "identify-peer-axis-rollback-failed",
          teamId: teamOutcome.teamId,
          agentKey: newKey,
          sessionId: rawArgs.sessionId,
          error: undo.error ?? "unknown",
        });
      }
      if (peerError !== undefined) {
        throw new ToolError({
          error: "peer_axis_failed",
          peer: peerError,
          teamAxis: {
            registered: !undo.ok,
            rolledBack: undo.ok,
            ...(undo.error !== undefined ? { rollbackError: undo.error } : {}),
            sessionKey: teamOutcome.sessionKey,
            teamId: teamOutcome.teamId,
            via: teamOutcome.via,
          },
          message: `peer-axis registration failed: ${peerError.error} — ${peerError.message}. ` +
            (undo.ok
              ? `The team-axis registration was rolled back (no team-side identity was left behind: ` +
                `${teamOutcome.sessionKey} unbound, roster entry removed), so this call had no lasting ` +
                `side effect. `
              : `The team-axis rollback FAILED (${undo.error ?? "unknown"}): the team-side registration ` +
                `is still in place (${teamOutcome.sessionKey}); resolve the peer-axis conflict and re-run ` +
                `xc_identify (the exact-pair rebind is idempotent). `) +
            `Resolve the peer-axis conflict (rename or reclaim) and re-run xc_identify.`,
        });
      }
    }
    // peer 轴注册成功：两轴身份都在场（catch 分支已在上面抛错，走到这里即成功路径）。
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
    "The name is the address on each axis; sessionId comes from the SessionStart hook (interactive) or the wake prompt (headless) - never invent it: a sessionId already held by another live session is refused (session_id_in_use, team axis included; the payload's sameSessionId flag tells a duplicate process claiming the SAME id apart from someone else's id). " +
    "Names must already be in canonical key form (letters/digits/single dashes, ≤48 chars); silently-normalizing spellings (fullwidth, homoglyphs, path/control characters, spaces, underscores) are refused - same strict grammar as the peer axis. " +
    "Both-axis atomicity: if the peer axis fails (register or rename), the team axis is rolled back and the error receipt reports teamAxis.rolledBack - a failed call leaves no half-applied identity, so you can retry directly; a rename blocked by the team-axis board guard (open task references / a non-empty mailbox) is refused on BOTH axes (team_rename_blocked) instead of renaming only the peer axis. " +
    "takeover:true (explicit) rebinds a dead holder's name and requeues its open tasks with receipts; it refuses while an in-flight wake round exists or the old holder is still live (takeover_live_holder). " +
    "Soft validation only: name_taken on live conflicts, session_id_in_use on live sid clashes, idempotent exact-pair rebind. No regToken (removed in v0.6).";
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> =>
    handleIdentify(deps, args as unknown as IdentifyArgs, connectionKeyOf(extra));
  server.tool("xc_identify", description, IdentifyShape, handler);
  registry.set("xc_identify", { description, shape: IdentifyShape, handler });
}
