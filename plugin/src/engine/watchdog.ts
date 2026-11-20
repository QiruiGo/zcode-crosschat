/**
 * v0.9.2（A2，方案 §二 组A）：**成员看门狗**（推）——MCP server 进程内的轻量定时器。
 *
 * 背景（用户核心诉求「进程断了主控应当收到新消息」 + v0.9.1 对抗轮三处硬伤）：
 * 1. 唯一的既有监视器是每次 spawn 的 15min 有界生命周期监视（engine/wake.ts），且它
 *    **活在派发方进程里**——派发方（lead 的 MCP server）一死，唤醒子的生死、limbo
 *    降级、成员的进程死活全都失去推送面；
 * 2. 成员进程崩溃（pid-dead）此前只有僵尸清扫节拍（30min 起步）与 overview 拉取面能
 *    反映，主控空闲时**无人推**；
 * 3. 因此本模块把这三类判据收进一个**常驻轻量定时器**（XC_WATCHDOG_MS 缺省 60s，
 *    0=关；unref 不拖进程退出）：每轮扫在册成员 pid（复用 C8 offline 判据）、在途
 *    nonce 生命周期、limbo 判据。
 *
 * 硬口径（写死，验收常量）：
 * - **仅 alive→dead 迁移发一次**：状态真源是 `capacity/watchdog-state.json`
 *   （engine/watchdog-state.ts）——同一成员同一次死亡只发一次，换了进程（server 重启）
 *   也不重复；成员重新活过来才重新武装；
 * - **「发一次」由锁保证**（v0.9.2 打回第 1 轮 V092-01）：判据（读状态 → 判定迁移 →
 *   写状态）整段持有 `locks/watchdog-state.lock`（同进程队列 + 跨进程文件锁，与
 *   withTeamLock 同族双保险）。缺锁时两把重叠扫描会 last-writer-wins，同一次死亡发两
 *   套告警——生产可达性已核实：各会话的 MCP server 共享同一 stateRoot（mcp/core.ts
 *   resolveStateRoot(workspace)），而无头唤醒回合同样加载该 server ⇒ 每会话一把扫描；
 * - **发 = 三件套**：engine 事件 `member-dead` + lead 邮箱 urgent + **尝试唤醒 lead**
 *   （走 attemptWake 标准路径：分层闸/在途 nonce/容量闸全部照算，降级即记
 *   `watchdog-wake` 事件——「受容量闸约束，失败记事件」）；
 * - **lead 自己死 → 通知其余在册成员并唤醒**（复用 v0.8.1 C6-BUG-4 口径：不通知崩溃者
 *   自己的邮箱——无接收意义；无人可通知时只落审计，不抛、不回退）；
 * - **已判 pid-dead 的成员一律不作收件人**（v0.9.2 打回第 1 轮 V092-02）：含本轮刚死
 *   与往轮已死——给死会话写邮箱/唤醒死 sid 必然 sessionNotFound，只会制造 wake-failed
 *   + wake-retry-failed 双事件与双 urgent 噪音；
 * - 同类事故**按轮合并**：一轮里的成员死亡/limbo 降级/在途 nonce 孤儿合成一条 urgent
 *   告知（不按条轰炸 lead 邮箱）；limbo 告警另按 (messageId, 轮次) 节流（A4-c）。
 *
 * 进程模型（如实声明，v0.9.2 打回第 1 轮修正原表述）：定时器在**每个** MCP server 进程
 * 里都会起（server.ts 无法在启动时判定本会话是不是 lead——身份要等工具调用才绑定），
 * 这不是缺陷而是冗余：跨进程认领保证「同一次死亡只有一个通告者」，而 lead 的 server
 * 死亡时队友的 server 仍能接着看（与 A3 事故摘要兜底同一思路）。认领失败（锁忙）=
 * 本轮跳过，下一节拍再试。
 *
 * 边界（如实声明）：看门狗与它守护的对象同生共死——所有 MCP server 都死亡时本模块停止
 * 推送，那道缺口由 UserPromptSubmit 的**回合开始事故摘要**（core/incidents.ts，A3）
 * 兜底：只要还有人开回合，就看得见自上次回合以来的一切事故。同机伪造 consumedAt/
 * lastSeen/证言仍属威胁模型边界（个人/内部协作、不做对抗级防伪），本模块不做签名。
 *
 * @module engine/watchdog
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_TEAM_ID,
  memberState,
  type TeamMember,
  type TeamMessage,
  type TeamState,
} from '../core/types.js';
import { readTeam } from '../core/teamstate.js';
import { memberLiveness, type MemberLiveness } from '../core/offline.js';
import { scanPeers } from '../core/peerregistry.js';
import { peerRootFromEnv } from '../core/peerdir.js';
import { logEngineEvent } from '../core/log.js';
import { LockBusyError, withFileLock, withProcessLock, withTeamLock } from '../core/lock.js';
import { appendMailbox, createMessage, limboCandidateMessages, readMailbox, sweepLimboDeliveriesLocked } from '../core/mailbox.js';
import { findInflightWakeNonce } from '../core/registry.js';
import { wakeLifecycleFile } from '../core/paths.js';
import { attemptWake, limboTimeoutFromEnv, wakeNonceDigest } from './wake.js';
import type { CapacitySample } from '../core/capacity.js';
import {
  limboAlertAlreadySent,
  markLimboAlertSent,
  markNonceOrphanSent,
  nonceOrphanAlreadySent,
  readWatchdogState,
  writeWatchdogState,
  type WatchdogState,
} from './watchdog-state.js';

/** 看门狗轮询间隔缺省值（ms）。 */
export const WATCHDOG_INTERVAL_DEFAULT_MS = 60_000;

/**
 * 看门狗状态锁的锁文件名（`<stateRoot>/locks/watchdog-state.lock`）——v0.9.2 打回第 1 轮
 * V092-01：`capacity/watchdog-state.json` 是**跨进程共享**的台账（每个 MCP server 一把
 * 扫描），而它自己是整文件原子写、自身没有互斥；「同一成员同一次死亡只发一次」因此必须
 * 由一把显式锁把「读状态 → 判定迁移 → 写状态」包成原子段，否则两把重叠扫描
 * last-writer-wins，同一次 death 出两套告警（adv-1 TC-1 实测 3/3 复现）。
 *
 * 为什么新开一把锁而不复用团队锁：团队锁被邮箱读写高频持有（15s 等待预算），看门狗若
 * 排队其后会把 60s 节拍拖成分钟级；且本模块的临界段只碰状态文件，与团队锁无嵌套关系
 * （顺序恒为「先团队锁（limbo 降级）→ 再状态锁（认领）」，不成环）。
 */
export const WATCHDOG_STATE_LOCK_NAME = 'watchdog-state';

/** 状态锁等待预算（ms）：拿不到就跳过本轮——另一把扫描正在做，下个节拍再试。 */
export const WATCHDOG_LOCK_WAIT_MS = 2_000;

/** 同进程队列 + 跨进程文件锁的双保险（与 core/lock.ts withTeamLock 同族结构）。 */
function withWatchdogStateLock<T>(stateRoot: string, fn: () => Promise<T> | T): Promise<T> {
  return withProcessLock(`watchdog-state:${resolve(stateRoot)}`, () =>
    withFileLock(stateRoot, WATCHDOG_STATE_LOCK_NAME, fn, { waitMs: WATCHDOG_LOCK_WAIT_MS }));
}

/**
 * 看门狗轮询间隔 env：`XC_WATCHDOG_MS`。
 * - 未设/空串 → 缺省 60000；
 * - `0` → **关闭看门狗**（唯一关闭方式；A3 的事故摘要仍在，见其模块注释）；
 * - 负数/非有限/不可解析 → 回落缺省（不静默关闸：把「配错了」当成「关了」会让告警链
 *   无声消失，与 XC_OFFLINE_MINUTES 的 fellBack 披露同族口径）。
 */
export function watchdogIntervalMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['XC_WATCHDOG_MS'];
  if (raw === undefined || raw.trim() === '') return WATCHDOG_INTERVAL_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return WATCHDOG_INTERVAL_DEFAULT_MS;
  return n;
}

/** 看门狗依赖（与 ToolDeps 结构兼容；不 import mcp 面——M2 不依赖 M3）。 */
export interface WatchdogDeps {
  stateRoot: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  /**
   * v0.9.2（A2）测试注入：容量样本（缺省=attemptWake 真采样）——与 wake.ts 的
   * `req.capacitySample` 同一注入纪律：注入即信任，生产路径永不传。看门狗自己不判容量，
   * 只把它透给 attemptWake（容量闸的唯一判据在 core/capacity.ts）。
   */
  capacitySample?: CapacitySample;
}

/** 一轮扫描的结算（审计/测试用）。 */
export interface WatchdogSweepSummary {
  /** false = 无团队（team.json 缺失），本轮跳过。 */
  team: boolean;
  /** 参与判定的在册成员数（有 sessionId 且非 removed）。 */
  scannedMembers: number;
  /** 本轮新判死的成员键（alive→dead 迁移，恰发一次的那些）。 */
  dead: string[];
  /** lead 是否在本轮被判死（决定通知收件人面）。 */
  leadDead: boolean;
  /** lead 当前是否 pid-dead（含往轮已死）——通知改投队友的依据。 */
  leadCurrentlyDead: boolean;
  /** 本轮降级的 messageId（不论是否节流）。 */
  limboDowngraded: string[];
  /** 本轮**实际告警**的 messageId（节流后；合并进 urgent 的那些）。 */
  limboAlerted: string[];
  /** 本轮新发现的在途 nonce 孤儿（不可反查摘要）。 */
  orphanNonces: string[];
  /** 本轮尝试过的唤醒（含降级）。 */
  wakes: Array<{ to: string; delivered: string; note?: string }>;
  /** 本轮跳过的原因（认领锁忙 = 另一把扫描正在做；undefined = 正常跑完）。 */
  skipped?: 'state-lock-busy';
}

/** 一条待通知的事故（按轮合并成一条 urgent 告知）。 */
interface RoundIncident {
  kind: 'member-dead' | 'limbo' | 'orphan-nonce';
  text: string;
}

/** 唤醒子的退出证据是否已落生命周期账（同步小文件读；取不到 = 无从判断）。 */
async function wakeChildExited(lifecycleFile: string): Promise<boolean> {
  try {
    if (!existsSync(lifecycleFile)) return false;
    const text = await readFile(lifecycleFile, 'utf8');
    return text.split(/\r?\n/).some((line) => {
      if (line.trim() === '') return false;
      try {
        return (JSON.parse(line) as Record<string, unknown>)['event'] === 'wake-child-exit';
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * 通知 + 尽力唤醒（锁外执行——attemptWake 必须持无团队锁，§2.7-4）。
 *
 * 邮箱帧先落盘（O_APPEND 原子追加，与 engine 信号的 notifyLeadUrgent 同纪律），再对每个
 * 有 sessionId 的收件人走标准唤醒路径。唤醒被任何一道闸挡下（分层闸/在途 nonce/容量闸/
 * 成员状态）都如实记 `watchdog-wake` 事件——「尝试唤醒」与「唤醒成功」是两件事，回执不混写。
 */
async function notifyAndWake(
  deps: WatchdogDeps,
  teamId: string,
  recipients: ReadonlyArray<{ key: string; sessionId: string | null }>,
  text: string,
  scene: string,
  summary: WatchdogSweepSummary,
): Promise<void> {
  const { stateRoot, workspace, env } = deps;
  const now = Date.now();
  const messageIds: string[] = [];
  for (const recipient of recipients) {
    const message = createMessage('engine', recipient.key, text, { urgent: true, deliveryClaimedAt: now });
    await appendMailbox(stateRoot, teamId, recipient.key, message);
    messageIds.push(message.id);
  }
  for (const [index, recipient] of recipients.entries()) {
    if (recipient.sessionId === null || recipient.sessionId === '') continue; // 无 sid：邮箱兜底
    const messageId = messageIds[index];
    if (messageId === undefined) continue;
    const sent = await attemptWake({
      stateRoot,
      teamId,
      toAgentKey: recipient.key,
      toSessionId: recipient.sessionId,
      workspace,
      reason: scene,
      receiptIds: [messageId],
      ticket: text,
      urgent: true,
      env,
      ...(deps.capacitySample !== undefined ? { capacitySample: deps.capacitySample } : {}),
    });
    summary.wakes.push({
      to: recipient.key,
      delivered: sent.delivered,
      ...(sent.note !== undefined ? { note: sent.note } : {}),
    });
    await logEngineEvent(stateRoot, {
      event: 'watchdog-wake',
      teamId,
      to: recipient.key,
      delivered: sent.delivered,
      ...(sent.note !== undefined ? { note: sent.note } : {}),
      ...(sent.wakeDeferred !== undefined
        ? { wakeDeferred: true, retryAfterMs: sent.wakeDeferred.retryAfterMs, detail: sent.wakeDeferred.detail }
        : {}),
    });
  }
}

/** 本轮事故的合并文案（按 incident 顺序编号；无事故返回 undefined）。 */
function renderRoundIncidents(
  incidents: readonly RoundIncident[],
  opts: { leadKey: string; leadCurrentlyDead: boolean },
): string | undefined {
  if (incidents.length === 0) return undefined;
  const head = opts.leadCurrentlyDead
    ? `[zcode-crosschat 看门狗] ⚠ lead "${opts.leadKey}" 进程已亡（pid-dead）——其会话与 MCP server 已不存在，队内推送面随之中断；本轮共检出 ${incidents.length} 项协作事故：`
    : `[zcode-crosschat 看门狗] ⚠ 本轮共检出 ${incidents.length} 项协作事故：`;
  const lines = incidents.map((incident, index) => `${index + 1}) ${incident.text}`);
  return (
    `${head}\n${lines.join('\n')}\n`
    + '消息不丢：以上事项均以邮箱为兜底（pull 可读、降级后可重投）。'
    + '请用 xc_overview 看在册成员活性与未读，用 xc_dispatch 重派，'
    + '或用 xc_team({action:"member-add"}) 幂等重供给崩溃成员。'
    + '本告警来自 MCP server 内的看门狗定时器（XC_WATCHDOG_MS 缺省 60s，0=关；每会话一把扫描，'
    + '跨进程认领保证同一次事故只有一个通告者）；看门狗全部随进程死亡时，由 UserPromptSubmit 的回合开始事故摘要兜底。'
  );
}

/**
 * 收件人规划（v0.9.2 打回第 1 轮 V092-02 修正；锁外调用，纯函数）。
 *
 * 规则（写死）：
 * 1. **已判 pid-dead 的成员一律不收**——含本轮刚死的、也含往轮已死的。给一个已崩会话写
 *    邮箱没有接收意义，attemptWake 一个死 sid 必然 sessionNotFound → wake-failed +
 *    wake-retry-failed 双事件 + 双 urgent，且 notifyLeadUrgent 还会把第二份 urgent 写进
 *    那个死邮箱（adv-1 TC-2 C/C2 部分实测）。这与 C6-BUG-4「不通知崩溃者自己的邮箱」
 *    是同一条口径——原实现只排除了 leadKey 一个键，同轮/往轮已死的其他成员漏排；
 * 2. 出事成员不是 lead ∧ lead 可寻址（在册 ∧ 有 sid ∧ 非 pid-dead）→ 通知 lead（原口径）；
 * 3. 否则（出事的是 lead，或 lead 已死/不可寻址）→ 通知**其余可寻址的活成员**；
 * 4. 无 sid 的成员不收（邮箱兜底可以写，但唤醒无处可打——与原实现一致只走邮箱的实现
 *    在这里统一为「不收」，避免「只写邮箱不唤醒」的半套件）；
 * 5. 一个都找不到 → 调用方只落 `watchdog-notify-skipped`（不抛、不回退）。
 */
function planRecipients(input: {
  team: TeamState;
  leadKey: string;
  livenessByKey: ReadonlyMap<string, MemberLiveness>;
  leadCurrentlyDead: boolean;
}): Array<{ key: string; sessionId: string }> {
  // 可寻址的**活**成员（型收窄后必有 sid，唤醒才有的打；pid-dead 一律排除——V092-02）
  const liveMembers = input.team.members.filter(
    (m): m is TeamMember & { sessionId: string } =>
      m.key !== input.leadKey
      && typeof m.sessionId === 'string' && m.sessionId !== ''
      && input.livenessByKey.get(m.key) !== 'pid-dead',
  );
  if (!input.leadCurrentlyDead) {
    const lead = input.team.members.find((m) => m.key === input.leadKey);
    if (lead !== undefined && typeof lead.sessionId === 'string' && lead.sessionId !== ''
      && input.livenessByKey.get(lead.key) !== 'pid-dead') {
      return [{ key: lead.key, sessionId: lead.sessionId }];
    }
  }
  return liveMembers.map((m) => ({ key: m.key, sessionId: m.sessionId }));
}

/**
 * 跑一轮看门狗扫描（永不抛——定时器回调的纪律；任何意外只落 `watchdog-sweep-failed`）。
 */
export async function sweepMembersOnce(
  deps: WatchdogDeps,
  now: number = Date.now(),
): Promise<WatchdogSweepSummary> {
  const summary: WatchdogSweepSummary = {
    team: true,
    scannedMembers: 0,
    dead: [],
    leadDead: false,
    leadCurrentlyDead: false,
    limboDowngraded: [],
    limboAlerted: [],
    orphanNonces: [],
    wakes: [],
  };
  const { stateRoot, env } = deps;
  const teamId = DEFAULT_TEAM_ID;
  try {
    const team = await readTeam(stateRoot, teamId);
    if (team === undefined) {
      summary.team = false;
      return summary; // 无团队：无成员可扫（不是错误）
    }
    const leadKey = team.leadKey ?? team.founderKey;
    // 只读 peer 扫描（查询路径无清扫副作用，peerregistry.ts sweep:false 契约）——pid 活性
    // 判据复用 C8 offline 的 memberLiveness（pid-dead 是唯一进程死硬证据）。
    const scan = await scanPeers(peerRootFromEnv(env), now, { sweep: false });

    // ── 1. 无锁预计算：活性表 + 两类认领候选（都是只读投影，不碰状态文件）──
    const livenessByKey = new Map<string, MemberLiveness>();
    const deathCandidates: Array<{ key: string; sessionId: string }> = [];
    for (const member of team.members) {
      if (memberState(member) === 'removed') continue; // 显式终态不是「死亡」
      const sessionId = typeof member.sessionId === 'string' && member.sessionId !== '' ? member.sessionId : null;
      if (sessionId === null) continue; // 无 sid：无从判定 pid 归属
      summary.scannedMembers += 1;
      const liveness = memberLiveness(member, scan, now);
      livenessByKey.set(member.key, liveness);
      if (liveness === 'pid-dead') deathCandidates.push({ key: member.key, sessionId });
    }
    summary.leadCurrentlyDead = livenessByKey.get(leadKey) === 'pid-dead';
    // 在途 nonce 孤儿候选（未消费 ∧ 未过期 ∧ 唤醒子已退出）——查账与读文件都在锁外。
    const nonceCandidates: Array<{ key: string; digest: string; nonceTs: number; sid: string }> = [];
    for (const member of team.members) {
      const inflight = await findInflightWakeNonce(stateRoot, member.key, { teamId, now });
      if (inflight === undefined) continue;
      if (!(await wakeChildExited(wakeLifecycleFile(stateRoot, member.key, inflight.nonce.ts)))) continue;
      nonceCandidates.push({
        key: member.key,
        digest: wakeNonceDigest(inflight.token),
        nonceTs: inflight.nonce.ts,
        sid: inflight.nonce.sid,
      });
    }

    const incidents: RoundIncident[] = [];

    // ── 2. 状态锁内认领（V092-01：读状态→判迁移→写状态必须原子，否则重叠扫描各发一套）──
    let state: WatchdogState;
    try {
      state = await withWatchdogStateLock(stateRoot, async () => {
        const locked = await readWatchdogState(stateRoot);
        for (const hit of deathCandidates) {
          // 首见只记录不告警——没有「曾经活着」的证据就不惊动 lead（启动期存量死记录不当事故）。
          if (locked.members[hit.key]?.state !== 'alive') continue;
          locked.members[hit.key] = { state: 'dead', at: now, liveness: 'pid-dead', evidence: 'process-dead' };
          summary.dead.push(hit.key);
          if (hit.key === leadKey) summary.leadDead = true;
          await logEngineEvent(stateRoot, {
            event: 'member-dead',
            teamId,
            member: hit.key,
            sessionId: hit.sessionId,
            liveness: 'pid-dead',
            evidence: 'process-dead',
            via: 'watchdog',
          });
          incidents.push({
            kind: 'member-dead',
            text: hit.key === leadKey
              ? `lead "${hit.key}" 进程已亡（pid-dead）——其会话与 MCP server 已不存在，队内推送面随之中断；`
                + '在册队友已收到本通知，请接手指令：用 xc_dispatch 重派其名下任务，或用 xc_team({action:"member-add"}) 幂等重供给。'
              : `成员 "${hit.key}" 进程已亡（pid-dead，sid ${hit.sessionId}）——其会话/无头回合已不存在；`
                + '名下任务请用 xc_overview 核对后用 xc_dispatch 重派，或用 xc_team({action:"member-add"}) 幂等重供给。',
          });
        }
        // 非迁移成员刷新快照：活过来即重新武装；往轮已死者保持 dead（不因一次扫描抖动重新武装）。
        for (const [key, liveness] of livenessByKey) {
          const previous = locked.members[key];
          if (previous === undefined) {
            locked.members[key] = { state: liveness === 'pid-dead' ? 'dead' : 'alive', at: now, liveness };
            continue;
          }
          if (previous.state === 'dead' && liveness !== 'pid-dead') {
            locked.members[key] = { state: 'alive', at: now, liveness };
          }
        }
        for (const candidate of nonceCandidates) {
          if (nonceOrphanAlreadySent(locked, candidate.digest)) continue;
          markNonceOrphanSent(locked, candidate.digest, now);
          summary.orphanNonces.push(candidate.digest);
          await logEngineEvent(stateRoot, {
            event: 'wake-orphan-nonce',
            teamId,
            to: candidate.key,
            nonce: candidate.digest,
            nonceTs: candidate.nonceTs,
            sid: candidate.sid,
            note: '在途 nonce 未消费而唤醒子已退出——该轮唤醒疑似无声死亡（消息仍在邮箱，pull 兜底不丢）',
          });
          incidents.push({
            kind: 'orphan-nonce',
            text: `在途唤醒子已退出而未完成唤醒握手（目标 "${candidate.key}"，nonce 摘要 ${candidate.digest}）——`
              + '该轮唤醒疑似无声死亡；消息仍在邮箱（pull 兜底不丢），可重发。',
          });
        }
        // 先写后通知：告警通道失败也不该让「已告警」的事实丢失。
        await writeWatchdogState(stateRoot, locked);
        return locked;
      });
    } catch (error) {
      if (error instanceof LockBusyError) {
        // 另一把扫描正在认领（同进程排队或别的 MCP server 持锁）——本轮跳过，下节拍再试。
        summary.skipped = 'state-lock-busy';
        return summary;
      }
      throw error;
    }

    // ── 3. limbo 判据（看门狗面）：锁外预读候选 → 团队锁内降级 → 事件 + 节流 + 合并告知。
    //    与 engine/wake.ts 的 per-spawn 监视器共用 core/mailbox.ts 的候选判据与
    //    watchdog-state 的 (messageId, 轮次) 节流台账。降级在团队锁内且判据自销
    //    （deliveredAt 被清）⇒ 同一次失效恰一次降级，告警随降级 1:1，不被重叠扫描放大。
    const limboTimeoutMs = limboTimeoutFromEnv(env);
    const candidates = new Map<string, Map<string, number | undefined>>();
    for (const member of team.members) {
      if (memberState(member) === 'removed') continue;
      try {
        const hits = limboCandidateMessages(
          await readMailbox(stateRoot, teamId, member.key),
          team,
          now,
          limboTimeoutMs,
        );
        if (hits.length === 0) continue;
        candidates.set(member.key, new Map(hits.map((m) => [m.id, m.deliveredAt])));
      } catch {
        /* 该成员邮箱读失败：本轮不判（不猜，下轮再看） */
      }
    }
    if (candidates.size > 0) {
      const downgraded = new Map<string, TeamMessage[]>();
      try {
        await withTeamLock(stateRoot, teamId, async () => {
          const locked = await readTeam(stateRoot, teamId);
          if (locked === undefined) return;
          for (const key of candidates.keys()) {
            const hits = await sweepLimboDeliveriesLocked(stateRoot, locked, key, now, limboTimeoutMs);
            if (hits.length > 0) downgraded.set(key, hits);
          }
        });
      } catch {
        /* 锁忙/IO：本轮不判（下轮再看；判据自销，不会重复降级） */
      }
      const freshIds: string[] = [];
      for (const [key, messages] of downgraded) {
        for (const message of messages) {
          const stampedAt = candidates.get(key)?.get(message.id);
          summary.limboDowngraded.push(message.id);
          await logEngineEvent(stateRoot, {
            event: 'message-limbo',
            teamId,
            to: key,
            from: message.from,
            messageId: message.id,
            ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
            downgradedAt: now,
            timeoutMs: limboTimeoutMs,
            via: 'watchdog',
          });
          if (limboAlertAlreadySent(state, message.id, stampedAt)) continue;
          markLimboAlertSent(state, message.id, stampedAt, now);
          freshIds.push(message.id);
        }
      }
      if (freshIds.length > 0) {
        summary.limboAlerted.push(...freshIds);
        const waitedMin = Math.round(limboTimeoutMs / 60_000);
        incidents.push({
          kind: 'limbo',
          text: `${freshIds.length} 条消息盖投递章后 ${waitedMin} 分钟无消费确认，已自动降级回 unread`
            + `（重新可注入/可 pull）：${freshIds.join(', ')}。`,
        });
      }
      // ── 4. 状态锁内补记 limbo 节流（第二段短临界段）──
      //    锁忙则放弃记账：降级已发生、告警已发出，最坏后果是罕见的一条重复，绝不漏报。
      try {
        await withWatchdogStateLock(stateRoot, async () => {
          const locked = await readWatchdogState(stateRoot);
          for (const id of freshIds) {
            const stampedAt = [...candidates.values()].find((m) => m.has(id))?.get(id);
            if (limboAlertAlreadySent(locked, id, stampedAt)) continue;
            markLimboAlertSent(locked, id, stampedAt, now);
          }
          await writeWatchdogState(stateRoot, locked);
        });
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error;
      }
    }

    // ── 5. 锁外通知 + 唤醒（attemptWake 必须持无团队锁，§2.7-4）──
    if (incidents.length > 0) {
      const recipients = planRecipients({ team, leadKey, livenessByKey, leadCurrentlyDead: summary.leadCurrentlyDead });
      const text = renderRoundIncidents(incidents, { leadKey, leadCurrentlyDead: summary.leadCurrentlyDead });
      if (text !== undefined) {
        if (recipients.length === 0) {
          // 无人可通知（lead 死且无其他活成员 / 全员不可寻址）→ 只落审计，不抛、不回退。
          await logEngineEvent(stateRoot, {
            event: 'watchdog-notify-skipped',
            teamId,
            reason: summary.leadCurrentlyDead ? 'lead-dead-no-other-live-members' : 'no-live-recipients',
            incidents: incidents.length,
            deadThisRound: summary.dead,
          });
        } else {
          await notifyAndWake(deps, teamId, recipients, text, 'message', summary);
        }
      }
    }
    return summary;
  } catch (error) {
    // 定时器回调纪律：永不抛。扫描意外只留痕（下轮再试——判据都从落盘真源现算）。
    await logEngineEvent(stateRoot, {
      event: 'watchdog-sweep-failed',
      teamId,
      error: error instanceof Error ? error.message : String(error),
    });
    return summary;
  }
}

/**
 * 启动成员看门狗（unref 定时器；引擎进程退出即停，观测面不拖进程）。
 *
 * @param intervalMs 测试注入的轮询间隔；缺省 env `XC_WATCHDOG_MS`（0 = 关，返回 undefined）。
 */
export function startMemberWatchdog(
  deps: WatchdogDeps,
  intervalMs?: number,
): NodeJS.Timeout | undefined {
  const interval = intervalMs ?? watchdogIntervalMsFromEnv(deps.env);
  if (!Number.isFinite(interval) || interval <= 0) return undefined;
  const timer = setInterval(() => {
    void sweepMembersOnce(deps).catch(() => undefined); // sweepMembersOnce 自带兜底，双保险
  }, interval);
  timer.unref?.();
  return timer;
}
