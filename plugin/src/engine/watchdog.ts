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
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import {
  DEFAULT_TEAM_ID,
  memberState,
  plausibleLivenessTs,
  type TeamMember,
  type TeamMessage,
  type TeamState,
} from '../core/types.js';
import { memberUnclaimedTasks, readTeam, repoolUnclaimedTasksForFailedMember } from '../core/teamstate.js';
// v0.10.0（组 A / R3）：sessionDeathGuard——判亡前四道校验之前三道的纯判据（第④道
// 二次确认的跨周期账在本模块的 watchdog-state 台账）。
import {
  DEATH_GUARD_LIFECYCLE_INFLIGHT_MS,
  deriveSessionPidEvidence,
  memberLiveness,
  sessionDeathGuard,
  type MemberLiveness,
} from '../core/offline.js';
import { scanPeers, type PeerRecord, type PeerScanResult } from '../core/peerregistry.js';
import { peerRootFromEnv } from '../core/peerdir.js';
import { logEngineEvent } from '../core/log.js';
// v0.9.3 打回第 2 轮（V093-01 残留①）：重发路径补发 member-dead 事件前的「是否已有」判据，
// 复用 M1 的 engine.jsonl 尾部窗口读单一实现（不复制一套 tail 读）。
import { readIncidentsSince } from '../core/incidents.js';
import { LockBusyError, pidAlive, withFileLock, withProcessLock, withTeamLock } from '../core/lock.js';
import {
  appendMailbox,
  createMessage,
  deliveryLeaseMsFromEnv,
  expiredDeliveryClaimMessages,
  limboCandidateMessages,
  readMailbox,
  sweepExpiredDeliveryClaimsLocked,
  sweepLimboDeliveriesLocked,
} from '../core/mailbox.js';
// v0.9.5（A2）：readSessionWitness——首见死亡的新鲜度三源合判补引擎证言（V094-13）。
// v0.10.0（组 A / R6）：clearSessionDead / markSessionDead——判亡后注册表活性翻转与
// 重新武装时的翻回清除（member-dead 的注册表侧双写，G-24 修法）。
import {
  clearSessionDead,
  findInflightWakeNonce,
  markSessionDead,
  readSession,
  readSessionWitness,
} from '../core/registry.js';
import { memberLivenessView, type SessionLivenessView } from '../core/liveness.js';
import type { SessionRecord } from '../core/types.js';
import { engineLogFile, logsDir, wakeLifecycleFile } from '../core/paths.js';
// v0.10.0（组 A / R2 后半）：未读判据收敛到 checkpoint 的单一真源（与 overview/panel/
// status/改名守卫同判据——「未读派单」不另立一套）。
import { currentUnreadMessages } from '../core/checkpoint.js';
// v0.10.0（组 A / R3）：findLiveInflightWakeNonce——在途唤醒的活体证据判据（R1 同款），
// 判亡路径与 limbo 候选路径从此共用同一份「在途」定义。
import {
  attemptWake,
  deliveryAttemptVerdict,
  findLiveInflightWakeNonce,
  limboTimeoutFromEnv,
  readDeliveryAttemptLedger,
  wakeNonceDigest,
  type WakeRequest,
} from './wake.js';
import type { CapacitySample } from '../core/capacity.js';
import {
  limboAlertAlreadySent,
  markLimboAlertSent,
  markNonceOrphanSent,
  nonceOrphanAlreadySent,
  readWatchdogState,
  watchdogStateFile,
  writeWatchdogState,
  type WatchdogState,
} from './watchdog-state.js';
// v0.9.3（A4）：needs-continuation 台账（独立状态文件 + 独立锁；见该模块注释）。
import {
  readContinuationState,
  writeContinuationState,
  type ContinuationMemberRecord,
  type ContinuationState,
} from './continuation-state.js';

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

/** v0.9.3（A4）：needs-continuation 台账锁名（`<stateRoot>/locks/continuation-state.lock`）——
 * 与 watchdog-state.lock 同族理由（跨进程共享的整文件原子写台账必须配显式锁），
 * 锁名独立：两本台账的临界段从不嵌套（见 withContinuationStateLock 的锁序纪律）。 */
export const CONTINUATION_STATE_LOCK_NAME = 'continuation-state';

/** v0.9.3（A4）：continuation 台账锁等待预算（ms）——与看门狗状态锁同值。 */
export const CONTINUATION_LOCK_WAIT_MS = 2_000;

/** 状态锁等待预算（ms）：拿不到就跳过本轮——另一把扫描正在做，下个节拍再试。 */
export const WATCHDOG_LOCK_WAIT_MS = 2_000;

/**
 * v0.9.3 打回第 1 轮（V093-04）：死亡告警的**重发间隔**（ms）——认领（锁内写台账）与
 * 通知（锁外 notifyAndWake）非原子，进程崩在两者之间时台账已是 dead 而通知从未发出；
 * 下一轮扫到 `notify:'pending'` 且认领已久（≥ 本常量）的条目就重发。取值 = 一个缺省节拍：
 * 同一轮内认领的条目 `now - at === 0` 不会被误重发，跨轮才重发。
 */
export const WATCHDOG_NOTIFY_RETRY_MS = 60_000;

/** v0.9.3 打回第 1 轮（V093-04）：重发次数上限——超过即置 `notify:'failed'` 并落
 * `watchdog-notify-failed` 事件（把「告知通道持续不通」变成可见的错误面，而不是无限重试）。 */
export const WATCHDOG_NOTIFY_MAX_ATTEMPTS = 3;

/**
 * v0.9.3 打回第 1 轮（V093-04）：**首见即死**的「新鲜死亡」窗（ms）。
 *
 * 台账无历史（全新状态根 / 状态文件损坏被删）时，「首见只记录不告警」会把**首扫前就已死**
 * 的成员永久静音（重新武装还要正向复活证据——记录不再自述 dead 或有 live/heartbeat-stale，
 * 崩溃进程永不满足；v0.10.0 集成员·第 7 轮起用视图的 dead 判，见下方重新武装处注释）。
 * 本常量给出判别：
 * peer 注册记录的心跳 lastSeen 落在窗内 ⇒ 这是**刚发生**的死亡（引擎只是没有它的历史），
 * 照常告警；窗外 ⇒ 存量死记录（启动期噪声），只记录不告警（v0.9.2 A2 原口径保留）。
 * 心跳形态见 core/peerregistry.ts PEER_STALE_MS（60s）：活成员 lastSeen 最多几十秒前。
 *
 * v0.9.5（A2/V094-13）：新鲜度判据**不只看 peer 记录**——见 {@link recentLifeEvidence}
 * 的 registry 会话记录 lastEventTs 与引擎证言 witness ts 增量；本窗是三证据共用的窗。
 */
export const WATCHDOG_FRESH_DEATH_MS = 10 * 60_000;

/**
 * v0.9.5（A7）：**补扫上界**（ms，7 天）——休眠/停机恢复后的死亡补扫只追窗内死亡，
 * 防超长 hiatus（月级停机）把远古死记录整批翻出来轰炸 lead（误报防线；方案 A7
 * 「补扫上界（如 ≤7 天）防误报」）。
 */
export const WATCHDOG_RESUME_CATCHUP_MAX_MS = 7 * 24 * 60 * 60_000;

/**
 * v0.9.6（A4/V095-13）：恢复判据的**下界钳制**（ms，60s）——扫描间隔必须同时超过
 * `2×周期` 与本下界才判恢复。为什么必须有下界：事件循环的同步停顿（GC / 杀毒扫描 /
 * 磁盘冻结 / Atomics.wait，实测 3.56s）会让定时器错过若干节拍，间隔远超 2×周期
 * （周期配小时以内时）——v0.9.5 的判据把这类停顿误判成「休眠恢复」，不仅落误报
 * `watchdog-resume` 事件，还会把补扫窗收缩到 gapMs 造成窗内死亡静音（V095-13）。
 * 真实休眠/挂起/停机是分钟级形态；本下界以下的一律按正常节拍处理（常规 10min
 * 新鲜窗照常覆盖窗内死亡，无静音面）。
 */
export const WATCHDOG_RESUME_GAP_FLOOR_MS = 60_000;

/**
 * v0.9.5（A7）：恢复事件的**去重窗**（ms）——多把扫描（每 MCP server 一把）同刻恢复时
 * 只让第一把落 `watchdog-resume` 事件（共享台账记 lastResumeAt；窗内后来的不再记）。
 * 与节拍同量级（2×周期、60s 兜底）：真第二次休眠恢复间隔远大于此，不会被误吞。
 */
export const WATCHDOG_RESUME_DEDUP_MS = 120_000;

/** 同进程队列 + 跨进程文件锁的双保险（与 core/lock.ts withTeamLock 同族结构）。 */
function withWatchdogStateLock<T>(stateRoot: string, fn: () => Promise<T> | T): Promise<T> {
  return withProcessLock(`watchdog-state:${resolve(stateRoot)}`, () =>
    withFileLock(stateRoot, WATCHDOG_STATE_LOCK_NAME, fn, { waitMs: WATCHDOG_LOCK_WAIT_MS }));
}

/**
 * v0.9.6（A2/V095-06）：看门狗台账的成员键 = `(成员名, sessionId)` **复合键**。
 *
 * 为什么必须复合：v0.9.5 及之前台账按键（成员名）记账，**不含 sid**——同名重供给
 * （xc_team member-add 幂等重供给，换新会话 = 新化身）后，新化身死在首个扫描节拍内时
 * `previous.state==='dead'` 直接把告警吞掉（V095-06 实测：零事件零告警，且死亡文案
 * 自荐的正是这条重供给路径——「按它说的做，下一次死亡就被静音」）。复合键让每个
 * 化身独立记账：旧化身（旧 sid）的死亡已认领不影响新化身（新 sid）的死亡照常告警。
 *
 * 形态：`${memberKey}|${sessionId}`。成员名经 sanitizeKey 只含字母/数字/连字符、
 * sessionId 由插件生成，两者都不含 `|`——复合键可无歧义识别；**不含 `|` 的键是
 * v0.9.5 及之前的旧格式条目**（见 sweepMembersOnce 内的 legacy 迁移）。
 */
export function watchdogLedgerKey(memberKey: string, sessionId: string): string {
  return `${memberKey}|${sessionId}`;
}

/**
 * v0.9.6（A4/V095-10+13）：**补扫窗口**（ms）= `min(max(gapMs, 常规新鲜窗), 7 天上界)`。
 *
 * v0.9.5 的取值是 `min(gapMs, 7d)`——短恢复（gap 130s）会把新鲜窗从常规 10min **收缩**
 * 到 gapMs，死亡证据年龄 ≈ gapMs 恰落窗外 → 补扫比常规更聋的静音（V095-10 实测）。
 * 修法：窗取 `max(gapMs, WATCHDOG_FRESH_DEATH_MS)`（补扫只许**放宽**不许收缩常规窗），
 * 再钳 7 天上界（A7 防误报原口径保留：月级停机不翻远古死记录）。
 */
export function watchdogCatchupWindowMs(gapMs: number): number {
  return Math.min(Math.max(gapMs, WATCHDOG_FRESH_DEATH_MS), WATCHDOG_RESUME_CATCHUP_MAX_MS);
}

/**
 * v0.9.3（A4）：needs-continuation 台账锁（`<stateRoot>/locks/continuation-state.lock`）——
 * 与看门狗状态锁同族双保险（同进程队列 + 跨进程文件锁）。为什么必须显式加锁：
 * 「同一 idle episode 只通知一次」的判据同样是「读状态 → 判定 → 写状态」，而每个 MCP
 * server 都有一把扫描共享同一本无互斥的整文件原子写台账——不加锁就是 V092-01 的
 * last-writer-wins 复刻（两把重叠扫描各发一条 needs-continuation）。
 *
 * 锁序纪律：本锁与 watchdog-state.lock **从不嵌套**（各自独立短临界段，顺序恒为
 * 「状态锁（成员死亡认领）→ continuation 锁（待续跑认领）→ 团队锁（limbo/A1 降级）」，
 * 任一时刻只持一把，不成环）。
 */
function withContinuationStateLock<T>(stateRoot: string, fn: () => Promise<T> | T): Promise<T> {
  return withProcessLock(`continuation-state:${resolve(stateRoot)}`, () =>
    withFileLock(stateRoot, CONTINUATION_STATE_LOCK_NAME, fn, { waitMs: CONTINUATION_LOCK_WAIT_MS }));
}

/**
 * v0.9.3（A4）：needs-continuation 阈值 env（`XC_CONTINUATION_MS`，缺省 1800000=30min）。
 * 口径与 XC_WATCHDOG_MS / XC_LIMBO_TIMEOUT_MS 同族：未设/空串 → 缺省；负数/非有限/
 * 不可解析 → 回落缺省（不静默关闸——把「配错了」当成「关了」会让 G-22 的兜底通知无声消失）。
 */
export const CONTINUATION_THRESHOLD_DEFAULT_MS = 30 * 60_000;

export function continuationThresholdMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['XC_CONTINUATION_MS'];
  if (raw === undefined || raw.trim() === '') return CONTINUATION_THRESHOLD_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return CONTINUATION_THRESHOLD_DEFAULT_MS;
  return n;
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

/**
 * v0.10.0（组 A / R5）：member-dead（及其它看门狗 urgent 告警）是否**尝试唤醒 lead**
 * 的 env 开关：`XC_WATCHDOG_WAKE_LEAD`。
 *
 * 缺陷（R5，用户点 2）：看门狗每次 member-dead 给主控写 urgent 邮箱并**立即唤醒
 * 主控**，主控被拉成无头分身（今日 5 次 urgent=true 唤醒各紧随一条 member-dead；
 * 17:42:12 那次打断了「正在等用户答的选项卡」）。修法（方案 C）：对 lead 类收件人
 * **只写 urgent 邮箱、不调用 attemptWake**——主控仍在自己回合看到告警，只是不被
 * 强行拉起；真正掉线的检测与任务回池不受影响。
 *
 * 口径（与 adoptByPpidEnabledFromEnv 同族）：只认字面量 `"1"`（显式恢复旧行为），
 * 其余一切取值（未设/空串/0/true/on）都按**不唤醒**处理——开关方向是「少拉一次
 * 无头分身」，误开比误关烦人，取最保守解析。队友收件人（lead 已死时的转移通知）
 * 与派单/回执/普通唤醒路径一律不受本开关影响。
 */
export const WATCHDOG_WAKE_LEAD_ENV = 'XC_WATCHDOG_WAKE_LEAD';

export function watchdogWakeLeadFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WATCHDOG_WAKE_LEAD_ENV] === '1';
}

/**
 * v0.10.0（组 A / R2 后半）：dispatch-resume **补醒冷却窗**缺省值（ms，120s）——与
 * 容量闸的分域冷却同窗长（engine/wake.ts WAKE_CAPACITY_COOLDOWN_MS_DEFAULT），
 * 「同一成员一个冷却窗内最多补醒一次」。env `XC_DISPATCH_RESUME_COOLDOWN_MS` 覆盖
 * （可选、带默认值，0 新增必填配置）：未设/空串 → 缺省；负数/非有限/不可解析 →
 * 回落缺省（不静默关闸——把「配错了」当成「关了」会让补醒每分钟重试）；`0` = 不冷却
 * （每个扫描周期都可补醒，运维显式选择）。
 */
export const DISPATCH_RESUME_COOLDOWN_DEFAULT_MS = 120_000;

export function dispatchResumeCooldownMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['XC_DISPATCH_RESUME_COOLDOWN_MS'];
  if (raw === undefined || raw.trim() === '') return DISPATCH_RESUME_COOLDOWN_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DISPATCH_RESUME_COOLDOWN_DEFAULT_MS;
  return n;
}

// ---------------------------------------------------------------------------
// v0.10.0（集成员·第 5 轮 / 对抗 ADV-02）：补醒**防风暴总次数上限**
//
// 缺口（裁决维持 P1）：冷却窗只防「一个窗内重复补醒」，不防「每个窗都补一次」——成员
// 空闲、无在途唤醒、收件箱有未读派单/未读紧急回执而**始终不认领**时，看门狗每过一个
// 120s 冷却窗就补醒一次，无总次数上限（实测 t0 / t0+121s / t0+242s 三次真唤醒）。
// 每次补醒 = 一整棵无头进程树（集成口径约 1GB/棵），收方零动作的生产形态已实证
// （实测 4/4 limbo）⇒ 构成慢速唤醒风暴。
//
// 修法（仿 mcp/tools-tasks.ts 的 urgent 回单防风暴上限，同族同纪律）：
// - 计数真源 = engine.jsonl 有界尾读里 `event ∈ {dispatch-resume, report-resume}`
//   ∧ `to` = 该成员 ∧ `delivered !== 'mailbox'`（真起进程树的行；被容量闸/唤醒闸挡下
//   只落邮箱的行不占额度）∧ 时刻落在 10min 窗内；
// - 读失败/坏行 → 0（**fail-open**：闸只防风暴、不拦投递，绝不因观测面故障把消息打死）；
// - 命中上限 → 本轮不进 dispatchResumeCandidates（判据落在 phase 1 冷却判据之后），
//   只落 `resume-wake-deferred` 审计；**邮箱消息不动**（pull 兜底不变）。
//
// 事件名为什么不是 `wake-deferred`：§15.2 把 `wake-deferred` 的键集冻结为容量闸专属
// （watermark / freeBytes / detail / cooldownMs / retryAfterMs / cooldownActive /
// wakeGateEnabled / gateEnv / urgent 恒在，且 tools-relay-v091.test.ts 按 Object.keys
// 与实跑事件对拍）。用同名落一个 5 键子集会破坏该冻结面（任务书同一句也要求
// 「事件名与键集先与冻结面核对、不越界」）⇒ 按 §16「新事件用新名、不动冻结键集」的
// 既定纪律起新名 `resume-wake-deferred`（键集：teamId/to/sessionId/scene/reason/
// taskIds/messageIds/resumeWakeMax/note）。
// ---------------------------------------------------------------------------

/** 防风暴计数窗（ms）——同一成员补醒的滚动窗口（与 urgent 回单上限同窗长）。 */
export const RESUME_WAKE_WINDOW_MS = 10 * 60_000;

/** 窗内真唤醒补醒上限缺省值（env XC_RESUME_WAKE_MAX 覆盖）。 */
export const RESUME_WAKE_MAX_DEFAULT = 5;

/** engine.jsonl 尾读窗口（字节）——覆盖 10min 窗所需的最新事件即止（约数千行）。 */
const RESUME_WAKE_TAIL_BYTES = 1024 * 1024;

/** 补醒被防风暴闸挡下的审计事件名（新事件名；§15.2 的 wake-deferred 键集不动）。 */
export const RESUME_WAKE_DEFERRED_EVENT = 'resume-wake-deferred';

/** 防风暴闸挡下的原因值（审计 reason 键的唯一取值）。 */
export const RESUME_WAKE_CAP_REASON = 'resume-wake-cap';

/**
 * env `XC_RESUME_WAKE_MAX` 解析（正整数；未设/空串/非正/不可解析 → 缺省 5）。
 * 与 urgentReportMaxFromEnv 逐字同口径：**不接受「关闭用 0」**——要停补醒语义
 * 应把冷却设成正数的大值或关看门狗，把「配错了」当成「关了」会让风暴重新出现。
 */
export function resumeWakeMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['XC_RESUME_WAKE_MAX'];
  if (raw === undefined || raw.trim() === '') return RESUME_WAKE_MAX_DEFAULT;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : RESUME_WAKE_MAX_DEFAULT;
}

/**
 * 统计窗内该成员**已生效**的补醒次数（engine.jsonl 有界尾读；只数
 * `dispatch-resume` / `report-resume` ∧ `to` 命中 ∧ `delivered !== 'mailbox'`
 * ∧ 时刻落窗内的行——被闸挡下只落邮箱的行不占额度）。
 *
 * 纯观测面计数：读失败/坏行一律跳过（返回已数到的部分），绝不因此抛错（fail-open）。
 */
export async function countRecentResumeWakes(
  stateRoot: string,
  to: string,
  now: number,
  windowMs: number = RESUME_WAKE_WINDOW_MS,
): Promise<number> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(engineLogFile(stateRoot), 'r');
    const size = (await handle.stat()).size;
    const length = Math.min(size, RESUME_WAKE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    // 窗口首行可能是被截断的半行（size > length 时才有）——丢弃，防半个 JSON 误解析。
    if (size > length) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
    }
    let count = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof value !== 'object' || value === null) continue;
      const event = value as Record<string, unknown>;
      if (event['event'] !== RESUME_SCENE_DISPATCH && event['event'] !== RESUME_SCENE_REPORT) continue;
      if (event['to'] !== to) continue;
      // 「真起进程树」= delivered 非 mailbox（容量闸/唤醒闸挡下只落邮箱的行不占额度）。
      if (event['delivered'] === 'mailbox') continue;
      const ts = event['ts'];
      if (typeof ts !== 'number' || !plausibleLivenessTs(ts, now)) continue;
      if (now - ts > windowMs) continue;
      count++;
    }
    return count;
  } catch {
    // 审计日志不可读（不存在/占用/权限）→ 不挡（fail-open：闸只防风暴，不拦投递）。
    return 0;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
  /**
   * v0.10.0（集成员·第 5 轮 / 对抗 ADV-02）测试注入：spawn 实现（缺省=attemptWake 真 spawn
   * `spawnResume`）——与 `capacitySample` 同一注入纪律：注入即信任，生产路径永不传。
   * 只透给**补醒路径**（§4.7 的 attemptWake，本轮防风暴闸的被测面：需要「真唤醒」才能让
   * 引擎事件带 delivered≠mailbox，计数闸才看得到它）；其余 attemptWake 调用点形状不变。
   */
  spawn?: WakeRequest['spawn'];
}

/** 一轮扫描的结算（审计/测试用）。 */
export interface WatchdogSweepSummary {
  /** false = 无团队（team.json 缺失），本轮跳过。 */
  team: boolean;
  /** 参与判定的在册成员数（有 sessionId 且非 removed）。 */
  scannedMembers: number;
  /** 本轮新判死的成员键（alive→dead 迁移，恰发一次的那些）。 */
  dead: string[];
  /**
   * v0.9.3 打回第 1 轮（V093-04）：其中**首见即死**的成员（台账无历史 + 近期存活证据）——
   * 与「armed 后迁移」区分：前者是台账丢失/全新状态根下的新鲜死亡，告警文案如实注明。
   */
  firstSightDead: string[];
  /** v0.9.3 打回第 1 轮（V093-04）：本轮**重发**死亡告警的成员（往轮认领了但通知未落地）。 */
  renotified: string[];
  /** lead 是否在本轮被判死（决定通知收件人面）。 */
  leadDead: boolean;
  /** lead 当前是否 pid-dead（含往轮已死）——通知改投队友的依据。 */
  leadCurrentlyDead: boolean;
  /** 本轮降级的 messageId（不论是否节流）。 */
  limboDowngraded: string[];
  /** 本轮**实际告警**的 messageId（节流后；合并进 urgent 的那些）。 */
  limboAlerted: string[];
  /** v0.9.3（A1）：本轮释放租约的 messageId（claimed 无 delivered 且超时）。 */
  leaseExpired: string[];
  /** v0.9.3（A4）：本轮**实际通知**的待续跑成员（一条 episode 一次；状态变化才重置）。 */
  needsContinuation: Array<{ key: string; taskId: string; idleForMin: number }>;
  /**
   * v0.9.9（V098-07）：本轮由**判死路径**回池的未认领单（成员键 → 任务 id 清单）——
   * pid-dead 成员名下 pending ∧ assignee 空 ∧ to 命中的派单，判死即回共享待领池
   * （创建者已收到 task-receipt、审计 `member-unclaimed-repooled`）。修复前这些单
   * 不在任何回池域（stale 清扫只含 claimed/in_progress）而永久搁浅。空 = 本轮无此类
   * 回池（无 pid-dead 成员 / 无未认领单 / 回池失败——失败落 `watchdog-repool-failed`）。
   *
   * v0.10.0（组 A / R3）：回池随**二次确认**后移——首次判死的成员本轮只记 suspect
   * （见 {@link deathSuspects}），不回池；连续第二个扫描周期仍判死才认领死亡并回池。
   * 已被往轮认领的死者（台账 state='dead'）仍每轮自愈回池（停机后新派给死者的单）。
   */
  unclaimedRepooled: Array<{ key: string; taskIds: string[] }>;
  /**
   * v0.10.0（组 A / R3/G-29）：本轮判 pid-dead 但被**判亡前四道校验**豁免的成员
   * （不发 member-dead、不回池、不告警；落 `suspect-dead` 审计）。reasons = 命中的
   * 校验名：inflight-wake（在途唤醒/启动窗/唤醒子 pid 活着）、open-tasks（名下
   * claimed/in_progress 在途任务）、newer-pid（注册表已有更新的活 pid）。
   */
  deathExempt: Array<{ key: string; reasons: Array<'inflight-wake' | 'open-tasks' | 'newer-pid'> }>;
  /**
   * v0.10.0（组 A / R3）：本轮**首次**判死（四道校验全过）而进入二次确认等待的成员
   * ——台账记 suspect（state 仍 alive、liveness=pid-dead），连续第二个扫描周期仍判死
   * 才发 member-dead 并回池。落 `suspect-dead` 审计（reasons 为空版）。
   */
  deathSuspects: string[];
  /**
   * v0.10.0（组 A / R2 后半；补充·R8 联动）：本轮**补醒**的未读消息（scene 二选一）——
   * 成员空闲 ∧ 无在途唤醒 ∧ 收件箱有两类未读之一时按对应场景补一次唤醒：未读派单
   * （task-assignment）→ scene `dispatch-resume`；未读紧急回执（task-receipt ∧ urgent/
   * 待补醒标记）→ scene `report-resume` 且 urgent:true。两类都照常经过容量闸（紧急不豁免），
   * 同一成员一个冷却窗内最多一次。落与 scene 同名的审计事件。
   */
  dispatchResumed: Array<{ key: string; scene: string; messageIds: string[]; delivered: string; note?: string }>;
  /**
   * v0.10.0（集成员·第 5 轮 / 对抗 ADV-02）：本轮因**防风暴总次数上限**而未补醒的成员
   * （冷却窗已过、其余判据全中，但同一成员 10min 窗内真唤醒补醒已达
   * {@link RESUME_WAKE_MAX_DEFAULT} / `XC_RESUME_WAKE_MAX`）——不调 attemptWake、不动邮箱，
   * 只落 `resume-wake-deferred` 审计。空 = 本轮无此类挡下。
   */
  resumeWakeDeferred: Array<{ key: string; scene: string; messageIds: string[]; reason: string }>;
  /** 本轮新发现的在途 nonce 孤儿（不可反查摘要）。 */
  orphanNonces: string[];
  /** 本轮尝试过的唤醒（含降级）。 */
  wakes: Array<{ to: string; delivered: string; note?: string }>;
  /**
   * v0.9.5（A7）：休眠/停机恢复补扫态（undefined = 本轮是正常间隔，零补扫事件）。
   * `gapMs` = 实际扫描间隔（> max(2×周期, 恢复下界 60s) 才判恢复，V095-13）；
   * `catchupWindowMs` = 补扫窗口**生效值**（v0.9.6 A4/V095-10 起 =
   * min(max(gapMs, 常规新鲜窗 10min), WATCHDOG_RESUME_CATCHUP_MAX_MS)——短恢复不再
   * 收缩常规窗），窗口内死亡按补扫告警。
   */
  resume?: { gapMs: number; catchupWindowMs: number };
  /** 本轮跳过的原因（认领锁忙 = 另一把扫描正在做；undefined = 正常跑完）。 */
  skipped?: 'state-lock-busy';
}

/**
 * v0.9.3 打回第 2 轮（V093-01 残留①）：重发路径**补发缺失的 `member-dead` 事件**——收口
 * 「重发只发邮箱/唤醒、不留事件」的观测面缺口（adv-3 C7.1 的形态：台账说 dead 而告警链从未
 * 跑过，engine.jsonl 里连一条 member-dead 都没有，运维与 A3 事故摘要都看不见这次死亡）。
 *
 * **条件式**（不是无条件重发）：该成员自认领时刻起的 engine.jsonl 尾部已有 member-dead 行
 * ⇒ 不发。理由两条：
 * 1. 审计账本身该是「一次死亡一条事件」——A3 回合摘要虽按成员键去重（core/incidents.ts
 *    countIncidents 的 seenDead）不会双计，但同键两条事件会让人以为死了两个成员；
 * 2. `logEngineEvent` 是 best-effort（写失败只记 auditDegradation）——首条事件可能真的丢了，
 *    此时补发同时是**审计自愈**；台账由外部写入（陈旧备份/手改）的形态同理。
 *
 * 取数复用 core/incidents.ts 的 readIncidentsSince（M1 尾部窗口读的单一实现，本模块不复制
 * 一套 tail 读）；窗口起点取该轮待补发条目里最早的认领时刻回退一个重发间隔。
 */
async function backfillMemberDeadEvents(
  stateRoot: string,
  teamId: string,
  entries: ReadonlyArray<{ key: string; sessionId: string; at: number; evidence: string }>,
): Promise<void> {
  const pending = entries.filter((entry) => entry.sessionId !== '');
  if (pending.length === 0) return; // 无 sid 无从写事件（邮箱/唤醒告知仍照发）
  const since = Math.max(0, Math.min(...pending.map((entry) => entry.at)) - WATCHDOG_NOTIFY_RETRY_MS);
  const counts = await readIncidentsSince(stateRoot, since);
  for (const entry of pending) {
    if (counts.deadMembers.includes(entry.key)) continue; // 已有事件：不重复落
    await logEngineEvent(stateRoot, {
      event: 'member-dead',
      teamId,
      member: entry.key,
      sessionId: entry.sessionId,
      liveness: 'pid-dead',
      evidence: entry.evidence === '' ? 'process-dead' : entry.evidence,
      via: 'watchdog',
    });
  }
}

/**
 * v0.9.3 打回第 1 轮（V093-04）：通知落地后把台账里的死亡条目改 `notify:'sent'`
 * （best-effort：锁忙/写失败就留给下一轮重发——宁可重发一条，不永久静音）。
 * v0.9.6（A2/V095-06）：入参为**台账复合键**（{@link watchdogLedgerKey}，(成员,会话)）。
 */
async function markDeathNotified(stateRoot: string, ledgerKeys: readonly string[], now: number): Promise<void> {
  if (ledgerKeys.length === 0) return;
  try {
    await withWatchdogStateLock(stateRoot, async () => {
      const locked = await readWatchdogState(stateRoot);
      let dirty = false;
      for (const ledgerKey of ledgerKeys) {
        const entry = locked.members[ledgerKey];
        if (entry === undefined || entry.state !== 'dead' || entry.notify === 'sent') continue;
        locked.members[ledgerKey] = { ...entry, notify: 'sent' };
        dirty = true;
      }
      if (dirty) await writeWatchdogState(stateRoot, locked);
    });
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error;
  }
}

/**
 * v0.9.3 打回第 1 轮（V093-04）：登记一次 pending 重发尝试——成功 ⇒ 'sent'；失败 ⇒  attempts+1，
 * 达上限 ⇒ 'failed' + `watchdog-notify-failed` 事件（把「告知通道持续不通」变成可见错误面）。
 * v0.9.6（A2/V095-06）：台账定位用**复合键**（{@link watchdogLedgerKey}，(成员,会话)）；
 * 事件 `member` 字段仍是成员名（审计按成员身份读）。
 */
async function recordRenotifyAttempt(
  stateRoot: string,
  entries: ReadonlyArray<{ memberKey: string; ledgerKey: string }>,
  delivered: boolean,
  teamId: string,
  now: number,
): Promise<void> {
  try {
    await withWatchdogStateLock(stateRoot, async () => {
      const locked = await readWatchdogState(stateRoot);
      let dirty = false;
      for (const { memberKey, ledgerKey } of entries) {
        const entry = locked.members[ledgerKey];
        if (entry === undefined || entry.state !== 'dead') continue;
        const attempts = (entry.notifyAttempts ?? 0) + 1;
        if (delivered) {
          locked.members[ledgerKey] = { ...entry, notify: 'sent', notifyAttempts: attempts, lastNotifyAttemptAt: now };
        } else if (attempts >= WATCHDOG_NOTIFY_MAX_ATTEMPTS) {
          locked.members[ledgerKey] = { ...entry, notify: 'failed', notifyAttempts: attempts, lastNotifyAttemptAt: now };
          await logEngineEvent(stateRoot, {
            event: 'watchdog-notify-failed',
            teamId,
            member: memberKey,
            attempts,
            reason: 'no-live-recipients',
            note: '成员死亡告警的重发次数已用尽仍无人可通知（lead 死且无其他活成员/全员不可寻址）——'
              + '请用 xc_overview 核对后用 xc_dispatch 重派其名下任务，或 xc_team({action:"member-add"}) 幂等重供给',
          });
        } else {
          locked.members[ledgerKey] = { ...entry, notifyAttempts: attempts, lastNotifyAttemptAt: now };
        }
        dirty = true;
      }
      if (dirty) await writeWatchdogState(stateRoot, locked);
    });
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error;
  }
}

/** 一条待通知的事故（按轮合并成一条 urgent 告知）。 */
interface RoundIncident {
  kind: 'member-dead' | 'limbo' | 'orphan-nonce' | 'lease-expired' | 'needs-continuation';
  text: string;
}

/**
 * v0.9.3（A4）纯判据：成员是否处于「有开放 in_progress 任务 ∧ 会话 idle」的**待续跑**态
 * （G-22 的可行解：不做自动续踢——续踢=wake，会被容量闸拦；改在回合结束/成员空闲时
 * 通知 lead，让人来决定续派/重供给）。
 *
 * 输入（会话记录 + 活性视图 + 任务板）由调用方读盘后传入——本函数无 I/O，与
 * core/liveness.ts 同纪律（便于单测直测各判据）。
 *
 * 判据（方案 §一 A4）：`in_progress` 且有开放任务 ∧ liveness=idle。`idle` 的口径复用
 * 三视图统一判据 {@link memberLivenessView}（pid-dead 由看门狗的 member-dead 通道负责，
 * 不进本判据；无记录/存量记录读作 idle——保守：不放过「会话从未被钩子锚定」的形态）。
 *
 * @returns 开放任务 id 与 idle 进入时刻（可信 livenessTs；缺失 = undefined，由调用方
 *   用「看门狗首见时刻」兜底）；不命中返回 undefined。
 */
export function continuationCandidateOf(
  member: TeamMember,
  view: SessionLivenessView,
  record: SessionRecord | undefined,
  tasks: readonly TeamState['tasks'][number][],
  now: number,
): { taskId: string; idleSinceTs: number | undefined } | undefined {
  if (memberState(member) === 'removed') return undefined; // 显式终态不是「待续跑」
  if (view.state !== 'idle') return undefined; // running/dead 都不判（dead 有 member-dead 通道）
  const open = tasks.filter((task) => task.assignee === member.key && task.status === 'in_progress');
  if (open.length === 0) return undefined;
  const idleSinceTs = record?.liveness === 'idle' && plausibleLivenessTs(record.livenessTs, now)
    ? record.livenessTs
    : undefined;
  return { taskId: open[0]!.id, idleSinceTs };
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

// ---------------------------------------------------------------------------
// v0.10.0（组 A / R3 + R2 后半）：wake 生命周期账的**判亡/补醒两用读取面**
//
// 为什么看门狗要读这份账：G-29 的根因是「看门狗握有在途唤醒数据却只用于 limbo 候选
// 判定，没用在判死路径上」。生命周期账（logs/wake-lifecycle-<to>-<ts>.jsonl，命名真源
// core/paths.ts）记有每次 attemptWake 的 spawn 头行（scene/sid/nonce 摘要）、启动确认
// 行（唤醒子 pid）与 exit 尾行——判亡前的「在途唤醒」校验与补醒的「冷却窗」都从它取
// 证据，不新增任何状态文件（跨进程共享：每个 MCP server 的扫描看到同一份账）。
// ---------------------------------------------------------------------------

/** 一名成员的最近唤醒证据（判亡校验注入 core/offline.ts sessionDeathGuard 的输入）。 */
interface WakeLifecycleEvidence {
  /** 最近一次 spawn 的头行时刻（epoch ms；undefined = 从未唤醒过）。 */
  lastSpawnTs?: number;
  /** 最近一次 spawn 有 start 头行且无 exit 尾行（唤醒子可能仍在跑）。 */
  startNoExit: boolean;
  /** 启动确认行汇报的唤醒子 pid 是否活着（「以唤醒子进程的 pid 为准」）。 */
  wakeChildPidAlive: boolean;
  /**
   * 最近一次**补醒** spawn 的时刻（epoch ms；undefined = 无）——scene 为
   * {@link RESUME_SCENE_DISPATCH} 或 {@link RESUME_SCENE_REPORT}（v0.10.0 补充：两类
   * 未读的补醒共用同一个冷却窗，任一场景的最近 spawn 都算冷却源）。
   */
  lastResumeTs?: number;
}

/**
 * 读一名成员在**时间窗内**的唤醒生命周期账证据（窗 = `windowMs`；读失败/无账 → 空证据，不猜）。
 *
 * 为什么要窗而不是「最新 N 份」：生命周期文件长期累积（无 prune），「最新 3 份」在别的
 * 场景连发唤醒时会把窗内的 dispatch-resume 挤出视野（冷却漏判 → 窗内重复补醒）。按窗过滤
 * （文件名里的 ts 就是 spawn 时刻，readdir 即可判，不必读文件）既精确又便宜。两个调用面
 * 各传自己的窗：判亡校验传在途窗（{@link DEATH_GUARD_LIFECYCLE_INFLIGHT_MS} 15min），
 * 补醒冷却传冷却窗（120s 量级）。
 */
async function readWakeLifecycleEvidence(
  stateRoot: string,
  agentKey: string,
  windowMs: number,
  now: number = Date.now(),
  pidAliveProbe: (pid: number) => boolean = pidAlive,
): Promise<WakeLifecycleEvidence> {
  const empty: WakeLifecycleEvidence = { startNoExit: false, wakeChildPidAlive: false };
  let entries: string[];
  try {
    entries = await readdir(logsDir(stateRoot));
  } catch {
    return empty; // 无 logs 目录：无唤醒证据
  }
  // 同一形状反解（贪婪分组 + 锚定数字尾段，agentKey 含连字符/数字也不误判；与
  // engine/wake.ts readDeliveryAttemptLedger 的同名反解同口径）。
  const pattern = new RegExp(`^wake-lifecycle-(.+)-(\\d+)\\.jsonl$`);
  const files: Array<{ ts: number; path: string }> = [];
  for (const entry of entries) {
    const matched = pattern.exec(entry);
    if (matched === null || matched[1] !== agentKey) continue;
    const ts = Number(matched[2]);
    if (!Number.isFinite(ts)) continue;
    if (ts < now - windowMs) continue; // 窗外：与判据无关（不读、不猜）
    files.push({ ts, path: join(logsDir(stateRoot), entry) });
  }
  if (files.length === 0) return empty;
  files.sort((a, b) => b.ts - a.ts); // 最新 spawn 优先
  const evidence: WakeLifecycleEvidence = { startNoExit: false, wakeChildPidAlive: false };
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file.path, 'utf8');
    } catch {
      continue; // 读不了这一份：跳过（不猜）
    }
    const lines = text.split(/\r?\n/).flatMap((line) => {
      if (line.trim() === '') return [];
      try {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === 'object' && parsed !== null ? [parsed as Record<string, unknown>] : [];
      } catch {
        return []; // 坏行跳过
      }
    });
    if (lines.length === 0) continue;
    const hasStart = lines.some((line) => line['event'] === 'wake-child-start');
    const hasExit = lines.some((line) => line['event'] === 'wake-child-exit');
    const scene = lines.find((line) => typeof line['scene'] === 'string')?.['scene'];
    if (evidence.lastSpawnTs === undefined && hasStart) {
      evidence.lastSpawnTs = file.ts;
      evidence.startNoExit = !hasExit;
    }
    if ((scene === RESUME_SCENE_DISPATCH || scene === RESUME_SCENE_REPORT)
      && (evidence.lastResumeTs === undefined || file.ts > evidence.lastResumeTs)) {
      evidence.lastResumeTs = file.ts;
    }
    // 唤醒子 pid：启动确认行（confirmed/unconfirmed 都可能带 pid）里最后出现的那个。
    const pidLines = lines.filter((line) => typeof line['pid'] === 'number' && Number.isSafeInteger(line['pid']));
    const lastPid = pidLines.length > 0 ? pidLines[pidLines.length - 1]!['pid'] as number : undefined;
    if (lastPid !== undefined && pidAliveProbe(lastPid)) {
      evidence.wakeChildPidAlive = true;
    }
  }
  return evidence;
}

/**
 * v0.10.0（组 A / G-25）：member-dead 告警文案里的**职能摘要**——读成员行上的
 * `duty`（组 D 的职能声明字段，v0.10.0 起 team.json 可选带；absent = 不带）。
 * 清洗口径：控制字符清成空格、trim、最长 60 字符（超长截断加 …）；清洗后为空 →
 * undefined（文案里不带职能段，逐字节回到不带 duty 的旧形态）。
 */
const DUTY_SNIPPET_MAX_CHARS = 60;

export function dutySnippet(member: TeamMember | { duty?: string }): string | undefined {
  const raw = (member as { duty?: string }).duty;
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (cleaned === '') return undefined;
  return cleaned.length <= DUTY_SNIPPET_MAX_CHARS ? cleaned : `${cleaned.slice(0, DUTY_SNIPPET_MAX_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// v0.10.0（组 A 补充·R2/R8 联动）：补醒判据的**两类未读**——派单与紧急回执
//
// 用户追加裁决：组 B 把「收件人回合进行中时，紧急回单只落邮箱不唤醒，并打上
// 待补醒标记」；本组 A4 的补醒判据随之从「未读的派单」扩为两类未读：
//   ① 未读**派单**（task-assignment）：带 taskId 且正文不是 task-receipt 信封；
//   ② 未读**紧急回执**（task-receipt ∧ 插队/待补醒标记）：正文 JSON `type==='task-receipt'`
//      且 `urgent===true`（组 B R8 写入侧）**或** 帧上带待补醒标记
//      `wakeDeferred==='recipient-turn-running'`（组 B 「补充」一节正式约定：标记位于
//      **content 的 task-receipt 帧里**，不在消息 top-level——白名单会拷掉它）。
// 命中紧急回执 → 补醒用 urgent:true、scene=report-resume；仅派单 → scene=dispatch-resume。
// 非紧急的 task-receipt（stale 清扫回执等进度/审计邮件）**不**触发补醒——两类未读的口径
// 写死，不把任何未读邮件都变成唤醒理由。
// ---------------------------------------------------------------------------

/**
 * 组 B 紧急回执「待补醒」标记的唯一取值（fix-b.md「补充」节正式约定，与其
 * tools-tasks.ts:327 `RECIPIENT_TURN_RUNNING` 同值）：**位于回执 content 的 task-receipt
 * JSON 帧里**（`wakeDeferred` 键）——不在 TeamMessage top-level（那里的 normalizeMessage
 * 白名单会拷掉未声明字段），故本组只从帧里读。
 */
export const URGENT_RECEIPT_WAKE_DEFERRED = 'recipient-turn-running';

/** 两条补醒场景（scene 值；进 engine.jsonl 与唤醒 prompt）。 */
export const RESUME_SCENE_DISPATCH = 'dispatch-resume';
export const RESUME_SCENE_REPORT = 'report-resume';

/** task-receipt 帧（正文 JSON 且 `type==='task-receipt'`；非 JSON/异型 → undefined）。 */
function taskReceiptFrame(message: { content: string }): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(message.content) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const frame = parsed as Record<string, unknown>;
    return frame['type'] === 'task-receipt' ? frame : undefined;
  } catch {
    return undefined; // 派单票面等自由文本：不是回执
  }
}

/** 正文是否是 task-receipt 信封。 */
export function isTaskReceiptMessage(message: { content: string }): boolean {
  return taskReceiptFrame(message) !== undefined;
}

/** 是否「待补醒的紧急回执」：task-receipt ∧（urgent 旗标 ∨ 帧上待补醒标记）。 */
export function isUrgentReceiptMessage(message: { content: string; urgent?: boolean }): boolean {
  const frame = taskReceiptFrame(message);
  if (frame === undefined) return false;
  return message.urgent === true || frame['wakeDeferred'] === URGENT_RECEIPT_WAKE_DEFERRED;
}

/** 未读派单（task-assignment）：带 taskId 且不是 task-receipt 信封。 */
export function isUnreadDispatchMessage(message: { content: string; taskId?: string }): boolean {
  return message.taskId !== undefined && !isTaskReceiptMessage(message);
}

/**
 * v0.9.3 打回第 1 轮（V093-04）：**近期存活证据**（纯函数）——台账无历史时判别「这是刚发生
 * 的死亡」还是「启动期存量死记录」。
 *
 * 证据（v0.9.5 A2/V094-13 起**三源合判**，任一落窗即新鲜）：
 * 1. peer 注册记录的心跳 lastSeen（活成员由 transport 周期刷新，进程死后冻结在崩溃
 *    时刻；core/peerregistry.ts PEER_STALE_MS=60s 即心跳量级）——v0.9.3 起的唯一证据；
 * 2. **registry 会话记录 lastEventTs**（hooks 回合边界 + MCP 工具调用心跳刷新）——
 *    V094-13 实测：引擎成员可从未 peer 注册（或干净摘除），peer 证据缺席不等于
 *    「死亡不新鲜」，registry 心跳是第二条「近期还活着」的证词；
 * 3. **引擎证言 witness ts**（registry/witness/<sid>.json，引擎分路写）——同上，
 *    证言在窗内即死亡新鲜。证言与判定同机同钟，`ts > now` 即拒（V090-02 纪律）。
 *
 * 全部落窗 ⇒ 死亡是新鲜的（引擎只是没有它的台账历史）⇒ 告警；窗外 ⇒ 存量死记录 ⇒
 * 只记录不告警（v0.9.2 A2「启动期存量死记录不当事故」原口径）。
 *
 * `windowMs`（v0.9.5 A7）：新鲜窗——正常扫描用 {@link WATCHDOG_FRESH_DEATH_MS}；
 * 休眠恢复补扫轮传生效补扫窗（v0.9.6 A4/V095-10 起 = min(max(gapMs, 常规新鲜窗),
 * WATCHDOG_RESUME_CATCHUP_MAX_MS)，见 {@link watchdogCatchupWindowMs}），窗口内死亡
 * 按补扫口径告警（不静音）。
 */
function recentLifeEvidence(
  scan: PeerScanResult,
  sessionId: string,
  now: number,
  extras: { lastEventTs?: number; witnessTs?: number } = {},
  windowMs: number = WATCHDOG_FRESH_DEATH_MS,
): boolean {
  // active 分区是 PeerRecord[]，dead 分区是 {record, reason}[]（peerregistry.ts 的形状）。
  const records: PeerRecord[] = [
    ...scan.active,
    ...scan.dead.map((row) => row.record),
  ];
  for (const record of records) {
    if (record.sessionId !== sessionId) continue;
    if (now - record.lastSeen <= windowMs) return true;
  }
  // v0.9.5（A2）：registry 会话记录 lastEventTs——未来值/非正数不采（伪造时刻不进判据）。
  if (plausibleLivenessTs(extras.lastEventTs, now) && now - extras.lastEventTs! <= windowMs) return true;
  // v0.9.5（A2）：引擎证言 ts——与判定同机同钟，未来值即拒（同 sweepOwnerGuard 口径）。
  if (extras.witnessTs !== undefined && extras.witnessTs > 0 && extras.witnessTs <= now
    && now - extras.witnessTs <= windowMs) return true;
  return false;
}

/**
 * v0.9.3 打回第 1 轮（V093-04）：成员死亡告知文案（认领路径与重发路径共用一份，避免两处
 * 文案漂移）；`firstSight` = 台账无历史下的首见即死（文案如实注明，免得 lead 以为是迁移）。
 * `catchUp`（v0.9.5 A7）= 本轮是休眠恢复补扫轮（freshness 窗为补扫窗口）——文案如实注明
 * 「补扫」，lead 能分辨这是扫描盲区追认的死亡而非实时检出。
 *
 * v0.9.6（A3/V095-07）：首见死亡**默认告警**（宁误报一次）后，首见文案分两态：
 * - 采到近期存活证据 → 「按近期存活证据判为新鲜死亡」（v0.9.5 A2 原文案）；
 * - 未采到任何新鲜证据 → 如实注明「首见且无近期存活证据，宁误报一次不静音」，lead 可据此
 *   把启动期存量死记录形态的误报安全忽略。
 *
 * v0.9.6（A8/V095-21 + A2/V095-06）：尾段统一「待回池 + 回池时刻」口径——任务在 stale
 * 清扫到期前是冻结的（回池时刻见 xc_overview 板面各任务 requeueAtMs），不再把「用
 * xc_dispatch 重派」写成当下可执行的动作（冻结窗内去待领池找不到任务，四面矛盾的文案面）；
 * 重供给建议附「(成员,会话) 独立记账」说明——v0.9.5 台账按键记账时，按文案走 member-add
 * 重供给恰是下一次死亡被静音的原因（V095-06 的「自荐误导」），复合键记账后该路径不再静音，
 * 文案如实注明。
 *
 * v0.9.9（V098-07）：`repooledUnclaimed` = 判死路径已将该成员未认领单回池的任务 id
 * （V098-07 修法）。非空时尾段如实写「未认领派单已回池至共享待领池（创建者已收到回执）」，
 * 在途单保持「冻结待回池 + requeueAtMs」口径——未认领单本就不在 stale 清扫域、板面无
 * requeueAtMs，旧文案对它们是过度承诺；空时尾段逐字节保持 v0.9.6 口径（在途单冻结）。
 *
 * v0.10.0（组 A / G-25）：`duty` = 成员职能声明的一句话摘要（组 D 的 duty 字段；
 * absent = 不带，文案逐字节回到旧形态）。收件人无需记忆即可判断该成员之死的业务影响
 * （boundName 本身不透明——G-25 的实证代价）。
 */
function renderMemberDeadText(
  key: string,
  sessionId: string,
  isLead: boolean,
  firstSight: boolean,
  catchUp = false,
  freshEvidence = true,
  repooledUnclaimed?: string[],
  duty?: string,
): string {
  // 职能段：紧缀成员名之后（三种 head 形态同一插入点）；absent = 零字符。
  const dutyClause = duty !== undefined ? `（职能：${duty}）` : '';
  const head = firstSight
    ? (catchUp
      ? `成员 "${key}"${dutyClause} 进程已亡（pid-dead，sid ${sessionId}；休眠/扫描中断后补扫——死亡落在本轮补扫窗口内，按补扫口径告警不静音）`
      : freshEvidence
        ? `成员 "${key}"${dutyClause} 进程已亡（pid-dead，sid ${sessionId}；看门狗台账无该成员历史，按近期存活证据判为新鲜死亡）`
        : `成员 "${key}"${dutyClause} 进程已亡（pid-dead，sid ${sessionId}；【首见】看门狗台账无该成员历史且未采到近期存活证据——`
          + `按首见死亡宁误报一次告警；若属启动期存量死记录/长期离队形态可安全忽略本条）`)
    : isLead
      ? `lead "${key}"${dutyClause} 进程已亡（pid-dead）`
      : `成员 "${key}"${dutyClause} 进程已亡（pid-dead，sid ${sessionId}）`;
  // v0.9.9（V098-07）：未认领单的真实措辞（已回池 ↔ 创建者回执）；在途单的「冻结待
  // 回池 + requeueAtMs」口径只在有未认领单时把「名下任务」收窄为「在途任务」——
  // 两者并列时不出现「已回池」与「冻结」互相矛盾。
  const unclaimedNote = repooledUnclaimed !== undefined && repooledUnclaimed.length > 0
    ? `名下未认领派单已回池至共享待领池（${repooledUnclaimed.join(", ")}；创建者已收到回执）；`
    : '';
  const frozenClause = unclaimedNote === ''
    ? '名下任务已冻结待回池（预计回池时刻见 xc_overview 板面各任务 requeueAtMs）'
    : '在途任务已冻结待回池（预计回池时刻见 xc_overview 板面各任务 requeueAtMs）';
  const tail = isLead
    ? '——其会话与 MCP server 已不存在，队内推送面随之中断；在册队友已收到本通知，请接手指令：'
      + unclaimedNote
      + `${frozenClause}，回池后用 xc_dispatch 重派，`
      + '或用 xc_team({action:"member-add"}) 幂等重供给（重供给按 (成员,会话) 独立记账，新会话的死亡照常告警）。'
    : '——其会话/无头回合已不存在；'
      + unclaimedNote
      + `${frozenClause}，`
      + '回池后用 xc_dispatch 重派，或用 xc_team({action:"member-add"}) 幂等重供给'
      + '（重供给按 (成员,会话) 独立记账，新会话的死亡照常告警）。';
  return head + tail;
}

/** v0.9.3 打回第 1 轮（V093-04）：死亡告警**重发**文案（认领了但通知从未落地的兜底）。
 *  v0.9.9（V098-07）：「名下任务已冻结待回池」收窄为「在途任务」——未认领派单由判死
 *  路径即时回池（V098-07），不在 stale 清扫域、板面无 requeueAtMs，旧措辞对它们是过度
 *  承诺；重发发生在死亡认领的下一轮，彼时未认领单早已回池（或留有
 *  watchdog-repool-failed 审计），文案不再对其状态作断言。 */
function renderRenotifyText(keys: readonly string[], leadKey: string, leadCurrentlyDead: boolean): string {
  const head = leadCurrentlyDead
    ? `[zcode-crosschat 看门狗] ⚠ lead "${leadKey}" 进程已亡（pid-dead）——其会话与 MCP server 已不存在，队内推送面随之中断；`
    : '[zcode-crosschat 看门狗] ⚠ 本轮共检出 1 项协作事故：';
  return head
    + `以下成员的死亡告警此前只完成了台账认领、通知未落地（认领与通知非原子，或引擎进程崩在两者之间），现重发：${keys.join(', ')}。`
    + '消息不丢：以上事项均以邮箱为兜底（pull 可读、降级后可重投）。请用 xc_overview 看在册成员活性与未读，'
    + '其在途任务已冻结待回池（预计回池时刻见板面 requeueAtMs），回池后用 xc_dispatch 重派，'
    + '或用 xc_team({action:"member-add"}) 幂等重供给（重供给按 (成员,会话) 独立记账）。';
}

/**
 * v0.10.0（集成员·第 6 轮）：**告警收件人回合是否在进行中**（与派单忙闲闸 B1 同款判据）。
 *
 * 缺口（真实复测第 0.1 节第 2 条）：`notifyAndWake` 对非 lead 收件人直接 attemptWake，
 * 不看对方是否在途——成员死亡告警发给正跑到一半的队友时，会给同一个会话再拉一路无头
 * 回合，正是 R2 忙闲闸要消的双回合形态（两路抢信箱、重复劳动，m8 双路实测同族）。
 *
 * 判据（逐字沿用 mcp/tools-tasks.ts 的忙闲闸；blocked 不算忙——认领者显式申报的暂停
 * 不是回合在跑；15min 未消费 wake nonce 的备用判据同样不纳入：实测已被 SessionStart
 * 钩子消费，纳入只会误挡）：
 * ① 任务板上有它 **claimed/in_progress** 的任务；
 * ② 注册表会话记录 `liveness === 'running'` ∧ `livenessTs` 可信
 *    （plausibleLivenessTs：未来值/缺失 = 伪造或损坏，按不忙；core/liveness.ts
 *    runningTrusted 同口径）。
 *
 * 任务板**现读一次**（锁外通知路径拿的是扫描开始时的快照，认领可能发生在那之后；
 * 读失败回退快照——fail-open：闸的失败方向是「多唤醒一次」而不是「丢告警」）。
 */
async function recipientTurnBusy(
  stateRoot: string,
  teamId: string,
  teamSnapshot: TeamState,
  agentKey: string,
  sessionId: string | null,
  now: number,
): Promise<{ busy: boolean; openTaskIds: string[]; sessionRunning: boolean }> {
  let team = teamSnapshot;
  try {
    const fresh = await readTeam(stateRoot, teamId);
    if (fresh !== undefined) team = fresh;
  } catch {
    /* 现读失败：用扫描快照（fail-open 方向） */
  }
  const openTaskIds = team.tasks
    .filter((t) => t.assignee === agentKey && (t.status === 'claimed' || t.status === 'in_progress'))
    .map((t) => t.id);
  let sessionRunning = false;
  if (sessionId !== null && sessionId !== '') {
    try {
      const record = await readSession(stateRoot, sessionId);
      sessionRunning = record?.liveness === 'running' && plausibleLivenessTs(record.livenessTs, now);
    } catch {
      // 读盘失败 → 按不忙（fail-open：观测面故障不得让告警退化成只落邮箱）。
      sessionRunning = false;
    }
  }
  return { busy: openTaskIds.length > 0 || sessionRunning, openTaskIds, sessionRunning };
}

/**
 * 通知 + 尽力唤醒（锁外执行——attemptWake 必须持无团队锁，§2.7-4）。
 *
 * 邮箱帧先落盘（O_APPEND 原子追加，与 engine 信号的 notifyLeadUrgent 同纪律），再对每个
 * 有 sessionId 的收件人走标准唤醒路径。唤醒被任何一道闸挡下（分层闸/在途 nonce/容量闸/
 * 成员状态）都如实记 `watchdog-wake` 事件——「尝试唤醒」与「唤醒成功」是两件事，回执不混写。
 *
 * v0.10.0（组 A / R5）：**lead 类收件人只写 urgent 邮箱、不调用 attemptWake**（除非
 * `XC_WATCHDOG_WAKE_LEAD=1` 显式恢复旧行为）。缺陷：看门狗 urgent「成员已亡」告警把
 * 主控拉成无头分身（今日 5 次 urgent 唤醒各紧随一条 member-dead，17:42:12 那次打断了
 * 正在等用户答的选项卡——用户点 2）。邮箱帧本身照写（主控在自己回合看得到告警），
 * 「不唤醒」这一事实如实落 `watchdog-wake`（delivered=mailbox + note 注明未尝试唤醒，
 * 键集不越 PROTOCOL §15.5 冻结面）。队友收件人（lead 已死时的转移通知）与派单/回执/
 * 普通唤醒路径不受影响——那些不走本函数。
 *
 * v0.10.0（集成员·第 6 轮）：**其余收件人（含 wakeLead=1 时的 lead）先过忙闲闸**——
 * 回合进行中（在途任务 ∨ 注册表 running 自述可信）则不发起唤醒，urgent 告警照落邮箱，
 * 并落一条 delivered=mailbox 的 `watchdog-wake`（note 写明是因为成员回合进行中而未唤醒，
 * 不新增任何键——§15.5 的可选键枚举不动）。判据与理由见 {@link recipientTurnBusy}；
 * 收件人空闲时本闸不生效——wake 调用、审计、回执三面逐字节不变。
 */
async function notifyAndWake(
  deps: WatchdogDeps,
  teamId: string,
  recipients: ReadonlyArray<{ key: string; sessionId: string | null }>,
  text: string,
  scene: string,
  summary: WatchdogSweepSummary,
  opts: { leadKey: string; wakeLead: boolean; team: TeamState },
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
    // v0.10.0（组 A / R5）：lead 告警不拉无头分身（只写邮箱）——「是否尝试过唤醒」如实记账。
    if (recipient.key === opts.leadKey && !opts.wakeLead) {
      const note = `member-dead 告警对 lead 只写 urgent 邮箱、未尝试唤醒（XC_WATCHDOG_WAKE_LEAD 未设为 "1"；`
        + '恢复旧行为可设该 env）——主控在自己回合即可看到本告警，不被强行拉起成无头分身';
      summary.wakes.push({ to: recipient.key, delivered: 'mailbox', note });
      await logEngineEvent(stateRoot, {
        event: 'watchdog-wake',
        teamId,
        to: recipient.key,
        delivered: 'mailbox',
        note,
      });
      continue;
    }
    // v0.10.0（集成员·第 6 轮）：**忙闲闸**（R2 同款判据）——回合进行中的收件人不发起
    // 唤醒：死亡告警发给正跑到一半的队友时，再拉一路无头回合同样是 G-28 的双回合形态。
    // urgent 告警已落邮箱（上面第一段），成员自己回合即可看到；本闸只挡 spawn。
    const busy = await recipientTurnBusy(stateRoot, teamId, opts.team, recipient.key, recipient.sessionId, now);
    if (busy.busy) {
      const reasons = [
        ...(busy.openTaskIds.length > 0 ? [`在途任务 ${busy.openTaskIds.join(', ')}`] : []),
        ...(busy.sessionRunning ? ['会话 liveness=running 且时刻可信'] : []),
      ];
      const note = `告警收件人 "${recipient.key}" 回合进行中（${reasons.join('；')}）——不发起唤醒`
        + '（同一会话两路并发 = G-28 双回合格局：两路抢信箱、重复劳动）；urgent 告警已落邮箱，'
        + '成员自己回合即可看到，pull 兜底不丢';
      summary.wakes.push({ to: recipient.key, delivered: 'mailbox', note });
      await logEngineEvent(stateRoot, {
        event: 'watchdog-wake',
        teamId,
        to: recipient.key,
        delivered: 'mailbox',
        note,
      });
      continue;
    }
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
      // v0.10.0（集成员·第 6 轮）：测试注入的 spawn（缺省 = 真 spawnResume）——与
      // capacitySample / §4.7 补醒路径同纪律：注入即信任，生产路径永不传。透到告警路径，
      // 是为了让「忙闲闸挡下 ⇒ 零 attemptWake」可被 fake spawn 的调用计数直接观测。
      ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
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

/** 本轮事故的合并文案（按 incident 顺序编号；无事故返回 undefined）。
 *  v0.9.9（V098-07）：`opts.unclaimedRepooled` 非空（本轮判死路径回池了未认领单）时，
 *  尾段的任务措辞如实分流——未认领派单「已回池至共享待领池（创建者已收到回执）」、
 *  在途单「已冻结待回池（requeueAtMs）」；空时逐字节保持 v0.9.6 口径。 */
function renderRoundIncidents(
  incidents: readonly RoundIncident[],
  opts: { leadKey: string; leadCurrentlyDead: boolean; unclaimedRepooled?: readonly { key: string; taskIds: string[] }[] },
): string | undefined {
  if (incidents.length === 0) return undefined;
  const head = opts.leadCurrentlyDead
    ? `[zcode-crosschat 看门狗] ⚠ lead "${opts.leadKey}" 进程已亡（pid-dead）——其会话与 MCP server 已不存在，队内推送面随之中断；本轮共检出 ${incidents.length} 项协作事故：`
    : `[zcode-crosschat 看门狗] ⚠ 本轮共检出 ${incidents.length} 项协作事故：`;
  const lines = incidents.map((incident, index) => `${index + 1}) ${incident.text}`);
  const taskClause = opts.unclaimedRepooled !== undefined && opts.unclaimedRepooled.length > 0
    ? '死亡成员未认领派单已回池至共享待领池（创建者已收到回执）、在途任务已冻结待回池（预计回池时刻见板面 requeueAtMs）'
    : '死亡成员名下任务已冻结待回池（预计回池时刻见板面 requeueAtMs）';
  return (
    `${head}\n${lines.join('\n')}\n`
    + '消息不丢：以上事项均以邮箱为兜底（pull 可读、降级后可重投）。'
    + `请用 xc_overview 看在册成员活性与未读；${taskClause}，`
    + '回池后用 xc_dispatch 重派，或用 xc_team({action:"member-add"}) 幂等重供给（重供给按 (成员,会话) 独立记账）。'
    + '本告警来自 MCP server 内的看门狗定时器（XC_WATCHDOG_MS 缺省 60s，0=关；每会话一把扫描，'
    + '跨进程认领保证同一次事故只有一个通告者）；看门狗全部随进程死亡时，由 UserPromptSubmit 的回合开始事故摘要兜底。'
  );
}

/**
 * 收件人规划（v0.9.2 打回第 1 轮 V092-02 修正；锁外调用，纯函数）。
 *
 * 规则（写死）：
 * 1. **已判死的成员一律不收**——含本轮刚死的、也含往轮已死的。给一个已崩会话写
 *    邮箱没有接收意义，attemptWake 一个死 sid 必然 sessionNotFound → wake-failed +
 *    wake-retry-failed 双事件 + 双 urgent，且 notifyLeadUrgent 还会把第二份 urgent 写进
 *    那个死邮箱（adv-1 TC-2 C/C2 部分实测）。这与 C6-BUG-4「不通知崩溃者自己的邮箱」
 *    是同一条口径——原实现只排除了 leadKey 一个键，同轮/往轮已死的其他成员漏排；
 * 2. 出事成员不是 lead ∧ lead 可寻址（在册 ∧ 有 sid ∧ 非死）→ 通知 lead（原口径）；
 * 3. 否则（出事的是 lead，或 lead 已死/不可寻址）→ 通知**其余可寻址的活成员**；
 * 4. 无 sid 的成员不收（邮箱兜底可以写，但唤醒无处可打——与原实现一致只走邮箱的实现
 *    在这里统一为「不收」，避免「只写邮箱不唤醒」的半套件）；
 * 5. 一个都找不到 → 调用方只落 `watchdog-notify-skipped`（不抛、不回退）。
 *
 * v0.10.0（集成员·第 7 轮）：判死由「活性字符串 === 'pid-dead'」改为**视图的 dead**
 * （{@link memberLivenessView} 的 state==='dead'）——后者 = 活性为 pid-dead **或**
 * 注册表记录自述 dead 且没有 live/heartbeat-stale 这类活证据。修「死人被重新武装后
 * 进收件人名单并被唤醒」：pid 被系统回收复用时 `alive(storedPid)` 为真，pid 证据支
 * 整支失效、活性退成 no-record，字符串判据下死人不再是 pid-dead ⇒ 重新武装 + 进名单
 * + 被唤醒（真实加测 R3 §6.1 实证）。记录仍自述 dead 时无论 pid 现在是否活着都按死人。
 */
function planRecipients(input: {
  team: TeamState;
  leadKey: string;
  /** 判死视图（state==='dead'）——判死/收件人/重新武装共用的单一口径。 */
  viewsByKey: ReadonlyMap<string, SessionLivenessView>;
  leadCurrentlyDead: boolean;
}): Array<{ key: string; sessionId: string }> {
  const isDead = (key: string): boolean => input.viewsByKey.get(key)?.state === 'dead';
  // 可寻址的**活**成员（型收窄后必有 sid，唤醒才有的打；已判死的一律排除——V092-02）
  const liveMembers = input.team.members.filter(
    (m): m is TeamMember & { sessionId: string } =>
      m.key !== input.leadKey
      && typeof m.sessionId === 'string' && m.sessionId !== ''
      && !isDead(m.key),
  );
  if (!input.leadCurrentlyDead) {
    const lead = input.team.members.find((m) => m.key === input.leadKey);
    if (lead !== undefined && typeof lead.sessionId === 'string' && lead.sessionId !== ''
      && !isDead(lead.key)) {
      return [{ key: lead.key, sessionId: lead.sessionId }];
    }
  }
  return liveMembers.map((m) => ({ key: m.key, sessionId: m.sessionId }));
}

/** 一轮扫描的恢复补扫输入（v0.9.5 A7；startMemberWatchdog 的定时器面检测产出）。 */
export interface WatchdogResumeInput {
  /** 实际扫描间隔（ms；> max(2×周期, 恢复下界 60s) 才判恢复，V095-13）。 */
  gapMs: number;
  /**
   * 补扫窗口（ms）。v0.9.6（A4/V095-10）起 sweep 面把它钳制到 ≥ 常规新鲜窗
   * （{@link watchdogCatchupWindowMs} 的定时器面公式；此处防御纵深）——补扫不许比常规更聋。
   */
  catchupWindowMs: number;
}

/**
 * v0.9.5（A7）：恢复事件的**共享去重台账**（`capacity/watchdog-resume.json`）。
 *
 * 为什么需要：每 MCP server 一把扫描，机器恢复时所有定时器同刻探测到超长间隔——
 * 不去重就是一次休眠落 N 条 `watchdog-resume`（lead 邮箱/时间线噪音）。台账记
 * 最近一次恢复时刻：去重窗（WATCHDOG_RESUME_DEDUP_MS）内后来的扫描不再记事件
 * （补扫告警口径**照常生效**——死亡认领由 watchdog-state 台账锁去重，与事件去重
 * 正交）。整文件原子写 + watchdog 状态锁内查写（与死亡认领同锁、非嵌套）。
 * 损坏/缺字段按「无历史」处理（与 watchdog-state.json 同纪律）。
 */
interface WatchdogResumeLedger {
  lastResumeAt?: number;
}

function watchdogResumeLedgerFile(stateRoot: string): string {
  return join(dirname(watchdogStateFile(stateRoot)), 'watchdog-resume.json');
}

async function readWatchdogResumeLedger(stateRoot: string): Promise<WatchdogResumeLedger> {
  try {
    const parsed = JSON.parse(await readFile(watchdogResumeLedgerFile(stateRoot), 'utf8')) as Record<string, unknown>;
    const lastResumeAt = parsed['lastResumeAt'];
    return typeof lastResumeAt === 'number' && Number.isFinite(lastResumeAt) && lastResumeAt > 0
      ? { lastResumeAt }
      : {};
  } catch {
    return {}; // 无文件/损坏：按无历史（与 watchdog-state.json 同纪律）
  }
}

async function writeWatchdogResumeLedger(stateRoot: string, ledger: WatchdogResumeLedger): Promise<void> {
  const file = watchdogResumeLedgerFile(stateRoot);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(ledger, null, 2)}\n`);
  } catch {
    /* best-effort：最坏后果是多落一条恢复事件（诚实重复，不静默） */
  }
}

/**
 * 跑一轮看门狗扫描（永不抛——定时器回调的纪律；任何意外只落 `watchdog-sweep-failed`）。
 *
 * v0.9.5（A7）：`options.resume` 在场 = 定时器面检测到扫描间隔异常（> 2×周期，
 * 休眠/挂起/停机恢复）——本轮按**补扫**口径跑：先落 `watchdog-resume{gapMs}`
 * （共享台账去重，一次恢复恰一条事件），补扫窗口（≤7 天）内的死亡按补扫告警
 * （不静音）；正常间隔不传 resume，零补扫事件（验收判据）。
 */
export async function sweepMembersOnce(
  deps: WatchdogDeps,
  now: number = Date.now(),
  options: { resume?: WatchdogResumeInput } = {},
): Promise<WatchdogSweepSummary> {
  const summary: WatchdogSweepSummary = {
    team: true,
    scannedMembers: 0,
    dead: [],
    firstSightDead: [],
    renotified: [],
    leadDead: false,
    leadCurrentlyDead: false,
    limboDowngraded: [],
    limboAlerted: [],
    leaseExpired: [],
    needsContinuation: [],
    unclaimedRepooled: [],
    deathExempt: [],
    deathSuspects: [],
    dispatchResumed: [],
    resumeWakeDeferred: [],
    orphanNonces: [],
    wakes: [],
  };
  const { stateRoot, env } = deps;
  const teamId = DEFAULT_TEAM_ID;
  // v0.9.6（A4/V095-10）：补扫窗的**生效值**在下界钳制到常规新鲜窗（≥10min）——调用方
  // （定时器面）已按 watchdogCatchupWindowMs 取 max(gap,10min)；此处再钳一道（防御纵深），
  // 任何以旧公式 min(gap,7d) 形态传入的窗口都不会把新鲜窗收缩到常规窗以下（补扫不许比
  // 常规更聋）。事件与 summary 如实记生效值。
  const catchupWindowMs = options.resume === undefined
    ? WATCHDOG_FRESH_DEATH_MS
    : Math.max(options.resume.catchupWindowMs, WATCHDOG_FRESH_DEATH_MS);
  // v0.9.5（A7）：恢复补扫事件——共享台账去重（一次恢复恰一条；多把扫描同刻恢复时
  // 第一把落事件，其余只按补扫口径跑）。锁忙/写失败不阻断补扫本身。
  if (options.resume !== undefined) {
    summary.resume = { gapMs: options.resume.gapMs, catchupWindowMs };
    try {
      await withWatchdogStateLock(stateRoot, async () => {
        const ledger = await readWatchdogResumeLedger(stateRoot);
        const lastResumeAt = ledger.lastResumeAt;
        if (lastResumeAt !== undefined && now - lastResumeAt < WATCHDOG_RESUME_DEDUP_MS) return;
        await writeWatchdogResumeLedger(stateRoot, { lastResumeAt: now });
        await logEngineEvent(stateRoot, {
          event: 'watchdog-resume',
          gapMs: options.resume!.gapMs,
          catchupWindowMs,
          via: 'watchdog',
          note: '扫描间隔超过 2×周期且不低于恢复下界（休眠/挂起/停机恢复）——本轮按补扫口径处理：'
            + `补扫窗口（≤${Math.round(catchupWindowMs / 3_600_000)}h，且不低于常规新鲜窗）内的死亡照常告警（不静音）`,
        });
      });
    } catch (error) {
      if (!(error instanceof LockBusyError)) {
        await logEngineEvent(stateRoot, {
          event: 'watchdog-sweep-failed',
          teamId,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
      // 锁忙：另一把扫描正在落恢复事件——本轮跳过事件但补扫口径照常（下方窗口照用）。
    }
  }
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

    // ── 1. 无锁预计算：活性表 + 四类认领候选（都是只读投影，不碰状态文件）──
    const livenessByKey = new Map<string, MemberLiveness>();
    // v0.10.0（组 A / R3/G-29）：判亡候选 = pid-dead ∧ **四道校验前三道全过**（第④道
    // 二次确认在状态锁内按台账连判两周期）。被前三道豁免的成员进 guardedDead——
    // 不发 member-dead、不回池、不进告警，只落 suspect-dead 审计（「判据被豁免」
    // 这件事本身要可见，否则豁免成了新的静默区）。
    const deathCandidates: Array<{ key: string; sessionId: string; recentLife: boolean; duty?: string }> = [];
    const guardedDead: Array<{ key: string; sessionId: string; reasons: Array<'inflight-wake' | 'open-tasks' | 'newer-pid'> }> = [];
    // v0.9.4（A1）：会话记录一次读取、两个循环复用（死亡判定的 pid 证据 + 待续跑判据）
    // ——不新增每成员的盘读次数。v0.10.0（组 A / R2 后半）：活性视图同样一次计算、
    // 待续跑与补醒两个判据共用（省掉每成员一次 pidAlive 系统调用）。
    const sessionRecords = new Map<string, SessionRecord | undefined>();
    const viewsByKey = new Map<string, SessionLivenessView>();
    for (const member of team.members) {
      if (memberState(member) === 'removed') continue; // 显式终态不是「死亡」
      const sessionId = typeof member.sessionId === 'string' && member.sessionId !== '' ? member.sessionId : null;
      if (sessionId === null) continue; // 无 sid：无从判定 pid 归属
      summary.scannedMembers += 1;
      let record: SessionRecord | undefined;
      try {
        record = await readSession(stateRoot, sessionId);
      } catch {
        record = undefined; // 读失败 = 无记录（保守 idle，不崩观测面）
      }
      sessionRecords.set(member.key, record);
      viewsByKey.set(member.key, memberLivenessView(member, record, scan, now));
      // v0.9.4（A1）：pid 证据（记录 pid + 存活探测 + 回合中自述）——peer 注册表没有
      // 该 sid 记录时（引擎成员从未 identify），会话记录 pid 是进程死的第二硬证据。
      // v0.9.4 打回第 1 轮（V094-13）：派生走 core/offline.ts 的**单一派生点**——
      // 判死发射面（本处）与展示面（core/liveness.ts memberLivenessView）从此同判据，
      // 不再出现「看门狗发 member-dead 而 xc_overview 报 running」的跨面矛盾。
      const pidEvidence = deriveSessionPidEvidence(record, now, pidAlive);
      const liveness = memberLiveness(member, scan, now, { sessionPid: pidEvidence });
      livenessByKey.set(member.key, liveness);
      if (liveness !== 'pid-dead') continue;
      // v0.9.5（A2/V094-13）：新鲜度**三源合判**——peer 记录心跳之外，补 registry
      // 会话记录 lastEventTs（hooks 回合边界 + 工具心跳）与引擎证言 ts。V094-13
      // 实测形态：引擎成员从未 peer 注册（每次工具调用的 server 短命、干净注销），
      // 旧判据只扫 peer 记录 → 90 秒前还活着的成员被当存量死记录永久静音。
      // v0.9.6（A4/V095-10）：补扫轮的新鲜窗 = 生效补扫窗（max(gap,常规 10min) 钳 7 天
      // 上界，见入口的 catchupWindowMs）——窗口内死亡按补扫告警（不静音）；正常轮维持
      // WATCHDOG_FRESH_DEATH_MS。
      let witnessTs: number | undefined;
      let witnessKind: string | undefined;
      try {
        const witness = await readSessionWitness(stateRoot, sessionId);
        witnessTs = witness?.ts;
        witnessKind = witness?.kind;
      } catch {
        witnessTs = undefined; // 证言读失败 = 该源无声（不猜）
      }
      const freshWindowMs = catchupWindowMs;
      const recentLife = recentLifeEvidence(
        scan,
        sessionId,
        now,
        { lastEventTs: record?.lastEventTs, ...(witnessTs !== undefined ? { witnessTs } : {}) },
        freshWindowMs,
      );
      // v0.10.0（组 A / R3）：判亡前四道校验之前三道——纯判据 core/offline.ts
      // sessionDeathGuard，证据在本循环内一次读齐（唤醒生命周期账 + 在途 nonce +
      // 证言 + 任务板快照）。任一命中即不判亡（方向保守：误判亡会撤回在途派单）。
      // 判亡校验的在途窗 = DEATH_GUARD_LIFECYCLE_INFLIGHT_MS（15min，与 deliveryAttemptVerdict
      // 的在途面同窗——强杀唤醒子可能不留 exit 尾行，窗后不再无限豁免）。
      const wakeEvidence = await readWakeLifecycleEvidence(stateRoot, member.key, DEATH_GUARD_LIFECYCLE_INFLIGHT_MS, now);
      const sessionRunningSinceSpawn = witnessKind === 'running'
        && wakeEvidence.lastSpawnTs !== undefined
        && witnessTs !== undefined
        && witnessTs >= wakeEvidence.lastSpawnTs;
      const inflightNonce = (await findLiveInflightWakeNonce(stateRoot, member.key, { teamId, sid: sessionId, now })) !== undefined;
      const openTaskCount = team.tasks.filter(
        (task) => task.assignee === member.key && (task.status === 'claimed' || task.status === 'in_progress'),
      ).length;
      const guard = sessionDeathGuard({
        wake: {
          inflightNonce,
          lifecycleStartNoExit: wakeEvidence.startNoExit,
          lastSpawnTs: wakeEvidence.lastSpawnTs,
          sessionRunningSinceSpawn,
          wakeChildPidAlive: wakeEvidence.wakeChildPidAlive,
        },
        openTaskCount,
        // `newer-pid`（③ 记录 pid 亡但注册表已有更新的活 pid）在 phase 1 无第二来源：
        // peer 注册表里同 sid 的活记录会让 memberLiveness 直接判 live（到不了 pid-dead），
        // 剩下的来源只有「SessionStart 钩子刚把新 pid 写回记录」——那由状态锁内认领前的
        // TOCTOU 重读覆盖（见下方认领分支）。此处不重复计（同一事实不记两个理由）。
        newerPidAlive: false,
        now,
      });
      if (guard.exempt) {
        guardedDead.push({ key: member.key, sessionId, reasons: guard.reasons });
        continue;
      }
      deathCandidates.push({ key: member.key, sessionId, recentLife, duty: dutySnippet(member) });
    }
    // v0.10.0（集成员·第 7 轮）：lead 是否已死改用**视图的 dead**（而非活性字符串
    // ==='pid-dead'）——pid 被回收复用时字符串会退成 no-record，lead 会被误判成活
    // （「通知改投队友」的规则随之失效）；记录自述 dead 时无论 pid 是否活着都按死。
    summary.leadCurrentlyDead = viewsByKey.get(leadKey)?.state === 'dead';
    // v0.9.3（A4）待续跑候选（in_progress ∧ idle）：会话记录 + 三视图活性判据，锁外预读
    // （视图已在上面循环算好，此处不重复派生）。
    const continuationCandidates: Array<{ key: string; sessionId: string; taskId: string; idleSinceTs: number | undefined }> = [];
    for (const member of team.members) {
      if (memberState(member) === 'removed') continue;
      const sessionId = typeof member.sessionId === 'string' && member.sessionId !== '' ? member.sessionId : null;
      if (sessionId === null) continue;
      // v0.9.4（A1）：复用上方循环已读的会话记录（不重复读盘）。
      const record = sessionRecords.get(member.key);
      const view = viewsByKey.get(member.key)!;
      const candidate = continuationCandidateOf(member, view, record, team.tasks, now);
      if (candidate !== undefined) {
        continuationCandidates.push({
          key: member.key,
          sessionId,
          taskId: candidate.taskId,
          idleSinceTs: candidate.idleSinceTs,
        });
      }
    }
    // v0.9.3（A1）claimed-未投递候选（claimed ∧ ¬delivered ∧ ¬consumed ∧ 超时）+ limbo 候选：
    // 两个判据都吃同一份邮箱快照，故合并为**一次**锁外预读（每成员一封邮件箱读一遍，
    // 判据各自纯函数过滤——与 sweepLimboDeliveriesLocked 内部的判据同源，不漂移）。
    // v0.10.0（组 A / R2 后半；补充·R8 联动）：同一份快照顺带算**补醒候选**（两类未读：
    // 未读派单 + 未读紧急回执）——判据依次叠昂贵程度排列：邮箱快照已在手 → 活性视图已算
    // → 证言/在途 nonce/生命周期账按需读。
    const deliveryLeaseMs = deliveryLeaseMsFromEnv(env);
    const limboTimeoutMs = limboTimeoutFromEnv(env);
    const resumeCooldownMs = dispatchResumeCooldownMsFromEnv(env);
    // v0.10.0（集成员·第 5 轮 / 对抗 ADV-02）：补醒防风暴总次数上限的生效值（每轮取一次）。
    const resumeWakeMax = resumeWakeMaxFromEnv(env);
    const claimCandidates = new Map<string, TeamMessage[]>();
    const limboCandidates = new Map<string, Map<string, number | undefined>>();
    const dispatchResumeCandidates: Array<{
      key: string; sessionId: string; messageIds: string[]; taskIds: string[];
      scene: string; urgent: boolean;
    }> = [];
    // v0.10.0（集成员·第 5 轮 / 对抗 ADV-02）：被防风暴闸挡下的补醒（phase 1 只收候选，
    // 审计事件在 §4.7 与 dispatch-resume/report-resume 同处落——engine 事件的写入点集中）。
    const resumeWakeDeferredCandidates: Array<{
      key: string; sessionId: string; scene: string; messageIds: string[]; taskIds: string[];
    }> = [];
    for (const member of team.members) {
      if (memberState(member) === 'removed') continue;
      const sessionId = typeof member.sessionId === 'string' && member.sessionId !== '' ? member.sessionId : null;
      let messages: TeamMessage[];
      try {
        messages = await readMailbox(stateRoot, teamId, member.key);
      } catch {
        continue; // 该成员邮箱读失败：本轮两个判据都不判（不猜，下轮再看）
      }
      const expired = expiredDeliveryClaimMessages(messages, team, now, deliveryLeaseMs);
      if (expired.length > 0) claimCandidates.set(member.key, expired);
      const limbo = limboCandidateMessages(messages, team, now, limboTimeoutMs);
      if (limbo.length > 0) limboCandidates.set(member.key, new Map(limbo.map((m) => [m.id, m.deliveredAt])));
      // ── v0.10.0（组 A / R2 后半；补充·R8 联动）：补醒候选筛选 ──
      // 判据（需求 A4 + 追加裁决）：① 成员空闲——最后一个引擎事件是 session-idle（引擎
      //   证言 kind='idle'）且没有在途回合（活性视图非 running；dead 由上一步排除）；
      //   **收件人回合还在进行中时绝不补醒**；
      //   ② 没有在途唤醒（在途 nonce 有活体证据）；
      //   ③ 收件箱里有**两类未读**之一：未读派单（task-assignment）或未读紧急回执
      //   （task-receipt ∧ urgent/wakeDeferred 标记；判据见 isUrgentReceiptMessage 一族，
      //   未读真源与 overview/改名守卫同一）；
      //   ④ 冷却窗内不重复补醒（生命周期账里任一补醒 scene 的最近 spawn；两类未读共用一窗）。
      // 方向保守：宁可不补醒（下轮/邮箱 pull 兜底），不把在途成员拉起第二路（G-28）。
      if (sessionId === null) continue;
      // v0.10.0（集成员·第 7 轮）：死者不补醒改用**视图的 dead**——pid 被回收复用时
      // 活性字符串退成 no-record，字符串判据下死人会被补醒（重新拉起一回合）。
      if (viewsByKey.get(member.key)?.state === 'dead') continue; // 死者不补醒（member-dead 通道负责）
      if (viewsByKey.get(member.key)?.state !== 'idle') continue; // running 不补醒；无记录按非 idle 处理
      const unread = currentUnreadMessages(team, messages);
      const unreadUrgentReceipts = unread.filter((m) => isUrgentReceiptMessage(m));
      const unreadDispatch = unread.filter((m) => isUnreadDispatchMessage(m));
      if (unreadDispatch.length === 0 && unreadUrgentReceipts.length === 0) continue;
      // 命中紧急回执 → scene=report-resume + urgent:true；仅派单 → dispatch-resume（不 urgent）
      const resumeScene = unreadUrgentReceipts.length > 0 ? RESUME_SCENE_REPORT : RESUME_SCENE_DISPATCH;
      const resumeIds = [...unreadDispatch, ...unreadUrgentReceipts];
      let witnessKind: string | undefined;
      try {
        witnessKind = (await readSessionWitness(stateRoot, sessionId))?.kind;
      } catch {
        witnessKind = undefined; // 证言读失败：无从证明「最后一个事件是 session-idle」→ 不补醒
      }
      if (witnessKind !== 'idle') continue;
      if ((await findLiveInflightWakeNonce(stateRoot, member.key, { teamId, sid: sessionId, now })) !== undefined) continue;
      // 冷却源按**冷却窗**读生命周期账（窗精确：文件名 ts 即 spawn 时刻；两类补醒 scene
      // 共用一窗）；冷却为 0 时完全不读（显式不冷却）。
      if (resumeCooldownMs > 0) {
        const wakeEvidence = await readWakeLifecycleEvidence(stateRoot, member.key, resumeCooldownMs, now);
        if (wakeEvidence.lastResumeTs !== undefined
          && now - wakeEvidence.lastResumeTs < resumeCooldownMs) {
          continue; // 冷却窗内不重复补醒
        }
      }
      // ⑤ v0.10.0（集成员·第 5 轮 / 对抗 ADV-02）：**防风暴总次数闸**——冷却只管一个窗内
      //    不重复，不管窗窗都补：收方零动作时每 120s 一次真唤醒 = 慢速唤醒风暴（每次一整棵
      //    无头进程树）。同一成员 10min 窗内真唤醒补醒已达上限 → 本轮不补醒（不进候选），
      //    只落 resume-wake-deferred 审计；**邮箱消息不动**（pull 兜底不丢）。
      //    计数读失败/坏行 → 0（fail-open：闸只防风暴，不因观测面故障把消息打死）。
      if (await countRecentResumeWakes(stateRoot, member.key, now) >= resumeWakeMax) {
        resumeWakeDeferredCandidates.push({
          key: member.key,
          sessionId,
          scene: resumeScene,
          messageIds: resumeIds.map((m) => m.id!),
          taskIds: resumeIds.flatMap((m) => (m.taskId !== undefined ? [m.taskId] : [])),
        });
        continue;
      }
      dispatchResumeCandidates.push({
        key: member.key,
        sessionId,
        messageIds: resumeIds.map((m) => m.id!),
        taskIds: resumeIds.flatMap((m) => (m.taskId !== undefined ? [m.taskId] : [])),
        scene: resumeScene,
        urgent: unreadUrgentReceipts.length > 0,
      });
    }
    // v0.9.3 打回第 1 轮（V093-02/V093-03）：A1 释放前的**跨源门槛**。「这个租约真对应一次
    // attemptWake 尝试」与「该尝试可能仍在途」都不是邮箱行条件（要读 registry/wake 的 nonce
    // 与 logs 的生命周期账），故按成员取一次证据台账，只把「attempted ∧ ¬inFlight」的 id 放行
    // 给团队锁内的 sweep；其余候选留到下一轮（在途窗口过去后再判，方向保守）。
    const claimReleaseIds = new Map<string, Set<string>>();
    for (const [key, candidates] of claimCandidates) {
      const ledger = await readDeliveryAttemptLedger(stateRoot, key, now);
      const allowed = candidates.filter((message) => {
        const claimedAt = message.deliveryClaimedAt;
        if (claimedAt === undefined) return false;
        const verdict = deliveryAttemptVerdict(ledger, claimedAt, now);
        return verdict.attempted && !verdict.inFlight;
      });
      if (allowed.length > 0) claimReleaseIds.set(key, new Set(allowed.map((message) => message.id)));
    }
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

    // ── 1.5 v0.9.9（V098-07）回池面：v0.10.0（组 A / R3）起**后移**到状态锁认领之后 ──
    // （见下方 2.7 节）。缺陷形态（51-v098 验收 adv-3 i=1）：判死路径只告警不回池——
    // 派给死者的未认领单（pending ∧ assignee 空 ∧ to 命中）不在 stale 清扫域
    // （SWEEPABLE 只含 claimed/in_progress）、他人 claim 得 not_assignee、死者无法认领
    // ⇒ 永久搁浅，创建者零回执。修法 = 死亡路径调用回池原语
    // （core/teamstate.ts repoolUnclaimedTasksForFailedMember：删 to 回共享待领池 +
    // 创建者 task-receipt + 审计 member-unclaimed-repooled），与供给失败面
    // （provision.ts catch）同款。
    // v0.10.0（组 A / R3）后移的原因：R3 验收要求「连续两个扫描周期都判死才发
    // member-dead **并执行回池**（二次确认）」——回池若留在认领之前，首次判死的成员
    // 当轮就被回池，二次确认形同虚设。新位置 = 状态锁认领之后（锁序：状态锁 → 团队锁，
    // 两把锁从不嵌套，不成环；与 3 节 limbo 降级同序）；已被往轮认领的死者（台账
    // state='dead'）仍每轮自愈回池（停机后新派给死者的单——dispatch 面只拒
    // removed/failed，不拒 pid-dead-but-roster-ready）。removed 成员的未认领单不在此域：
    // 停机面（member-stop，V098-06）已在同一临界段回池。

    const incidents: RoundIncident[] = [];

    // ── 2. 状态锁内认领（V092-01：读状态→判迁移→写状态必须原子，否则重叠扫描各发一套）──
    // v0.9.3 打回第 1 轮（V093-04）：认领与通知改**两段式**——锁内只写
    // `notify:'pending'`（并照旧落 member-dead 事件），通知落地后再改 'sent'。旧版「先写后
    // 通知」把「已告警」的事实押在通知之前：进程崩在两者之间（或通知通道失败）即台账已是
    // dead 而通知从未发出，之后每一轮都因「非 alive→dead 迁移」跳过，重新武装还要
    // liveness≠pid-dead（崩溃进程永不满足）⇒ **永久静音且零错误面**。现在这种形态由下面的
    // 重发队列接住（pending 且认领已久 → 重发，次数上限内）。
    // 台账 notify 字段缺省（旧版本/手写文件/陈旧备份恢复）按 'pending' 读：无从证明通知
    // 发过就按没发过处理，补发一次后转 'sent'（V093-04 起口径；「缺省按 sent、不为历史
    // 死亡补炸」的旧注释随两段式告知作废——权威见 watchdog-state.ts 同名字段文档与
    // watchdog-v093-notify-atomicity.test.ts 的旧格式例）。
    const renotifyPending: Array<{ key: string; sessionId: string; ledgerKey: string; at: number; evidence: string }> = [];
    /**
     * v0.10.0（组 A / R3）：本轮**认领的死亡**（锁内判定、锁外善后）——member-dead
     * 事件、注册表翻转（markSessionDead）、未认领取回池与告警文案都在锁外按本清单做
     * （回池要拿团队锁，与状态锁不嵌套；事件后移的缺口由 V093-04 的重发/补发队列兜底
     * ——进程崩在认领与善后之间时，下一轮见 notify:'pending' 会补发，事件由
     * backfillMemberDeadEvents 条件式补落）。
     */
    const confirmedDeaths: Array<{
      key: string; sessionId: string; firstSight: boolean; recentLife: boolean; duty?: string; silent: boolean;
    }> = [];
    /** 本轮「重新武装」（台账 dead→alive）的成员——锁外翻回注册表的 dead 自述。 */
    const rearmedKeys: Array<{ key: string; sessionId: string }> = [];
    let state: WatchdogState;
    try {
      state = await withWatchdogStateLock(stateRoot, async () => {
        const locked = await readWatchdogState(stateRoot);
        // v0.9.6（A2/V095-06）：复合键迁移——v0.9.5 及之前的台账按键（成员名）记账，不含
        // 会话维度。旧格式条目（键不含 `|`）无法判定其死亡属于哪个化身：保留会被复合键
        // 查找永远错过（垃圾增长），映射到当前 sid 则可能把旧化身的死亡错记到新化身头上
        // （重供给后的首拍死亡被吞——恰是本修复要消除的形态）。按「宁误报不静音」方向：
        // 旧格式条目一次性清除、此后按复合键重新记账——升级后已死成员的死亡至多重报一条
        // （宁误报一次，且 V095-07 起首见默认告警会把它重新抬出来），不再可能静音。
        // 同轮顺手把台账收敛为**当前花名册的投影**：不在册成员、以及仍在册但 sid 已换
        // （重供给/重绑——member-add 把 roster sid 置空/换新即「重供给时清 dead 态」的
        // 等效面）的旧化身条目一律删除——它们永远不会再被复合键查中，保留只会无界增长；
        // 当前 sid 的条目（含本轮刚认领的死亡）不受影响。
        const currentLedgerKeys = new Set<string>();
        for (const member of team.members) {
          const sid = typeof member.sessionId === 'string' && member.sessionId !== '' ? member.sessionId : null;
          if (sid !== null) currentLedgerKeys.add(watchdogLedgerKey(member.key, sid));
        }
        for (const ledgerKey of Object.keys(locked.members)) {
          if (!currentLedgerKeys.has(ledgerKey)) delete locked.members[ledgerKey];
        }
        for (const hit of deathCandidates) {
          const ledgerKey = watchdogLedgerKey(hit.key, hit.sessionId);
          const previous = locked.members[ledgerKey];
          if (previous?.state === 'dead') continue; // 已判死：同一化身（同 sid）的同一次死亡不重复告警
          // v0.9.6（A3/V095-07）：首见死亡**默认告警**（宁误报一次，文案附「首见」标注）。
          // v0.9.5 的「首见 + 无近期存活证据 → 静默认领」只保留在**补扫轮**（resume）：
          // 补扫窗（≤7 天）是 A7 的防误报上界——窗外（远古）死记录不翻旧账；常规轮不再
          // 静音：t2 实测形态（引擎成员未 peer 注册 + 无工具回合 + 台账无历史，长回合中
          // 进程死）三源全过期，静默认领零审计零告警——正是「宁误报一次」要堵的形态。
          if (previous === undefined && !hit.recentLife && summary.resume !== undefined) {
            // 补扫轮的远古死记录：静默认领（不告警）——回池与注册表翻转照做（善后进
            // confirmedDeaths.silent），「同一次死亡只认领一次」的口径不变。
            locked.members[ledgerKey] = {
              state: 'dead', at: now, liveness: 'pid-dead', evidence: 'process-dead', notify: 'sent',
            };
            confirmedDeaths.push({
              key: hit.key, sessionId: hit.sessionId, firstSight: true, recentLife: hit.recentLife,
              ...(hit.duty !== undefined ? { duty: hit.duty } : {}), silent: true,
            });
            continue;
          }
          // v0.10.0（组 A / R3 修法④）：**二次确认**——连续两个扫描周期都判死才发
          // member-dead 并回池。首个周期只记 suspect（state 仍 alive、liveness=pid-dead、
          // at=首见时刻），落 `suspect-dead` 审计（「判据命中但待复核」可见，不静默）。
          // 判据用台账上一周期的 liveness 快照：非 pid-dead（含首见/刚恢复）= 第一周期。
          if (previous === undefined || previous.liveness !== 'pid-dead') {
            locked.members[ledgerKey] = { state: 'alive', at: now, liveness: 'pid-dead' };
            summary.deathSuspects.push(hit.key);
            await logEngineEvent(stateRoot, {
              event: 'suspect-dead',
              teamId,
              member: hit.key,
              sessionId: hit.sessionId,
              liveness: 'pid-dead',
              evidence: 'process-dead',
              reasons: [],
              via: 'watchdog',
              note: '首次判死（判亡前四道校验全过）——按二次确认口径等下一个扫描周期复核；'
                + '连续两个扫描周期仍判死才发 member-dead 并执行回池',
            });
            continue;
          }
          // 第二周期仍判死 → 认领前的 **TOCTOU 复核**（第四道校验的账本外半）：记录 pid
          // 可能已被 SessionStart 钩子改写成更新的活 pid（G-29 启动窗：新 pid 已写回而
          // phase 1 读到的还是旧 pid）——锁内重读一次，变了且活着就不判亡（退回 suspect）。
          let recordNow: SessionRecord | undefined;
          try {
            recordNow = await readSession(stateRoot, hit.sessionId);
          } catch {
            recordNow = undefined; // 读失败 = 无从复核：按已判证据走（下轮自愈）
          }
          const previousPid = sessionRecords.get(hit.key)?.pid;
          if (recordNow?.pid !== undefined && recordNow.pid !== previousPid && pidAlive(recordNow.pid)) {
            locked.members[ledgerKey] = { state: 'alive', at: now, liveness: 'pid-dead' };
            summary.deathExempt.push({ key: hit.key, reasons: ['newer-pid'] });
            await logEngineEvent(stateRoot, {
              event: 'suspect-dead',
              teamId,
              member: hit.key,
              sessionId: hit.sessionId,
              liveness: 'pid-dead',
              evidence: 'process-dead',
              reasons: ['newer-pid'],
              via: 'watchdog',
              note: '记录 pid 亡但注册表已有更新的活 pid（认领前重读复核：SessionStart 钩子已写回新 pid）——不算死',
            });
            continue;
          }
          // 认领：firstSight = suspect 记于上一周期（首见即死形态的文案标注由此保留）
          const firstSight = now - previous.at <= WATCHDOG_NOTIFY_RETRY_MS;
          locked.members[ledgerKey] = {
            state: 'dead', at: now, liveness: 'pid-dead', evidence: 'process-dead', notify: 'pending',
          };
          summary.dead.push(hit.key);
          if (firstSight) summary.firstSightDead.push(hit.key);
          if (hit.key === leadKey) summary.leadDead = true;
          confirmedDeaths.push({
            key: hit.key, sessionId: hit.sessionId, firstSight, recentLife: hit.recentLife,
            ...(hit.duty !== undefined ? { duty: hit.duty } : {}), silent: false,
          });
        }
        // v0.10.0（组 A / R3）：被四道校验豁免的 pid-dead 成员——suspect 记账（state 仍
        // alive、liveness=pid-dead）＋ 状态**转换时**落一条 suspect-dead 审计（同一豁免
        // 形态持续多轮不重复落——审计是「状态变了」的信号，不是心跳）。往轮已认领死亡
        // 的条目不动（那次死亡已告过警）。
        for (const hit of guardedDead) {
          const ledgerKey = watchdogLedgerKey(hit.key, hit.sessionId);
          const previous = locked.members[ledgerKey];
          summary.deathExempt.push({ key: hit.key, reasons: hit.reasons });
          if (previous?.state === 'dead') continue; // 已认领过：豁免不改变已发生的事实
          const alreadySuspect = previous !== undefined && previous.liveness === 'pid-dead';
          if (!alreadySuspect) {
            locked.members[ledgerKey] = { state: 'alive', at: now, liveness: 'pid-dead' };
            await logEngineEvent(stateRoot, {
              event: 'suspect-dead',
              teamId,
              member: hit.key,
              sessionId: hit.sessionId,
              liveness: 'pid-dead',
              evidence: 'process-dead',
              reasons: hit.reasons,
              via: 'watchdog',
              note: `判 pid-dead 但被判亡前校验豁免（${hit.reasons.join('/')}）——不发 member-dead、不回池、不告警`,
            });
          }
        }
        // 非迁移成员刷新快照（复合键，V095-06）：活过来即重新武装；往轮已死者保持 dead
        // （不因一次扫描抖动重新武装）。同一成员换 sid（重供给/重绑）= 新化身独立记账。
        // v0.10.0（组 A / R3）：alive 条目的 liveness 快照**随轮刷新**——二次确认要求
        // 「连续两个周期」，上一周期不是 pid-dead（中间活过）就必须重新数两周期。
        // v0.10.0（集成员·第 7 轮）：重新武装的「活过来」判据从「活性字符串 !== 'pid-dead'」
        // 改为**视图的 dead 为假**（{@link memberLivenessView}：pid-dead ∨ 记录自述 dead 且
        // 无 live/heartbeat-stale 活证据）。修「死人被重新武装」：pid 被系统回收复用时
        // `alive(storedPid)` 为真 ⇒ pid 证据支整支失效 ⇒ 活性字符串退成 no-record，旧判据
        // 下死人被重新武装（台账翻 alive + clearSessionDead 把注册表清成 idle，engine 里出现
        // session-idle{prev:'dead'}），随后进告警收件人名单并被唤醒——真实加测 R3 §6.1 实证
        // （m2 于 04:50:33 被重新武装、04:51:35 被 watchdog-wake 拉起一回合）。
        // 新判据要求**正向复活证据**：记录不再自述 dead（该会话自己的钩子写过 running/idle）
        // 或有 live/heartbeat-stale 证据。存量（台账 dead ∧ 记录不自述 dead）行为逐字节不变
        // ——视图的 dead 在记录不自述 dead 时就等于「活性 === pid-dead」。
        for (const member of team.members) {
          if (memberState(member) === 'removed') continue;
          const refreshSid = typeof member.sessionId === 'string' && member.sessionId !== '' ? member.sessionId : null;
          if (refreshSid === null) continue;
          const liveness = livenessByKey.get(member.key);
          if (liveness === undefined) continue;
          const ledgerKey = watchdogLedgerKey(member.key, refreshSid);
          const previous = locked.members[ledgerKey];
          if (previous === undefined) {
            locked.members[ledgerKey] = { state: liveness === 'pid-dead' ? 'dead' : 'alive', at: now, liveness };
            continue;
          }
          if (previous.state === 'dead' && viewsByKey.get(member.key)?.state !== 'dead') {
            locked.members[ledgerKey] = { state: 'alive', at: now, liveness };
            rearmedKeys.push({ key: member.key, sessionId: refreshSid });
            continue;
          }
          if (previous.state === 'alive' && previous.liveness !== liveness) {
            locked.members[ledgerKey] = { state: 'alive', at: now, liveness };
          }
        }
        // v0.9.3 打回第 1 轮（V093-04）：重发队列——死亡已认领但**告知状态不明**的条目：
        // `notify:'pending'`（两段式：认领了、通知未确认落地）或字段缺省（手写/陈旧备份
        // 恢复的行——无从证明通知发过，按「没发过」处理，补发一次），且认领已久（宽限一个
        // 节拍，等本轮通知落地）且未超次数上限。v0.9.6（V095-06）：按在册成员的复合键遍历。
        for (const member of team.members) {
          if (memberState(member) === 'removed') continue;
          const sessionId = typeof member.sessionId === 'string' && member.sessionId !== '' ? member.sessionId : null;
          if (sessionId === null) continue;
          const ledgerKey = watchdogLedgerKey(member.key, sessionId);
          const entry = locked.members[ledgerKey];
          if (entry === undefined || entry.state !== 'dead') continue;
          if (entry.notify === 'sent' || entry.notify === 'failed') continue;
          if (now - entry.at < WATCHDOG_NOTIFY_RETRY_MS) continue;
          if ((entry.notifyAttempts ?? 0) >= WATCHDOG_NOTIFY_MAX_ATTEMPTS) continue;
          renotifyPending.push({
            key: member.key,
            sessionId,
            ledgerKey,
            at: entry.at,
            evidence: entry.evidence ?? '',
          });
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

    // ── 2.7 v0.10.0（组 A / R3+R6）：死亡善后（锁外；锁序 = 状态锁 → 团队锁 → registry 锁，
    //    两把从不嵌套）──
    // ① **注册表翻转**（R6/G-24）：member-dead 之后 sessions/<sid>.json 的 liveness 立即
    //    翻成 dead 并落盘——与 engine.jsonl 的 member-dead 事件双写一致。对本轮认领的
    //    死者与往轮已认领的死者都做（后者是自愈：翻转失败/丢锁的下一轮补上）；
    // ② **未认领取回池**（V098-07，v0.10.0 起随二次确认后移）：只对台账已认领死亡
    //    （state='dead'）且当前仍 pid-dead 的成员做——首次判死的 suspect 成员不在域内
    //    （连续两周期才回池）；每轮幂等，停机后新派给死者的单下一轮自愈；
    // ③ **member-dead 事件 + 告警文案**：回池结果进文案（未认领单如实写「已回池」），
    //    事件与注册表翻转同一段完成（两处一致）。
    {
      const deathIncidents: RoundIncident[] = [];
      // 认领集合：本轮 confirmedDeaths + 往轮已 dead 且当前**视图仍判死**的成员（自愈回池面）。
      // v0.10.0（集成员·第 7 轮）：第二个集合的判据从「活性字符串 === 'pid-dead'」改为视图的
      // dead——pid 被回收复用时字符串退成 no-record，往轮死者的自愈回池会静默停摆
      // （未认领单永久搁浅）；记录自述 dead 时无论 pid 是否活着都算仍死。
      const aftermath = new Map<string, { key: string; sessionId: string; silent: boolean; firstSight: boolean; recentLife: boolean; duty?: string }>();
      for (const death of confirmedDeaths) {
        aftermath.set(death.key, {
          key: death.key, sessionId: death.sessionId, silent: death.silent,
          firstSight: death.firstSight, recentLife: death.recentLife,
          ...(death.duty !== undefined ? { duty: death.duty } : {}),
        });
      }
      for (const member of team.members) {
        if (aftermath.has(member.key)) continue;
        if (viewsByKey.get(member.key)?.state !== 'dead') continue;
        const sid = typeof member.sessionId === 'string' && member.sessionId !== '' ? member.sessionId : null;
        if (sid === null) continue;
        if (state.members[watchdogLedgerKey(member.key, sid)]?.state !== 'dead') continue; // 未认领（suspect）不回池
        aftermath.set(member.key, { key: member.key, sessionId: sid, silent: true, firstSight: false, recentLife: false });
      }
      for (const member of team.members) {
        const entry = aftermath.get(member.key);
        if (entry === undefined) continue;
        // ① 注册表翻转（R6）：member-dead 与注册表 liveness=dead 双写一致。
        try {
          await markSessionDead(stateRoot, entry.sessionId, { now });
        } catch {
          /* best-effort：翻转失败不掩盖死亡告警本身（下一轮自愈） */
        }
        // ② 未认领单回池（V098-07 + 二次确认后移）。
        let repooled: string[] | undefined;
        if (memberUnclaimedTasks(team.tasks, entry.key).length > 0) {
          try {
            const released = await repoolUnclaimedTasksForFailedMember(stateRoot, teamId, entry.key, {
              reason: 'member-dead',
              detail: 'watchdog: member process is dead (pid-dead); unclaimed dispatch returned to the shared pending pool',
            });
            if (released.length === 0) {
              repooled = undefined; // 锁内重判后已无可回池（并发已处理）——零审计零披露
            } else {
              repooled = released.map((r) => r.taskId);
              summary.unclaimedRepooled.push({ key: entry.key, taskIds: repooled });
            }
          } catch (error) {
            // 回池是判死路径的尽力清理：失败不掩盖死亡告警本身（成员照常告警；判据不销，
            // 下一轮自愈）。落审计让「未认领单没回池」在观测面可见；**不回写告警文案**
            // （不把没回池的单说成已回池——不变式 5）。
            await logEngineEvent(stateRoot, {
              event: 'watchdog-repool-failed',
              teamId,
              member: entry.key,
              error: error instanceof Error ? error.message : String(error),
            }).catch(() => undefined);
          }
        }
        if (entry.silent) continue; // 往轮已认领/补扫静默认领：无事件无告警（只做上面的善后）
        // ③ member-dead 事件（与注册表翻转同段完成）+ 告警文案。
        await logEngineEvent(stateRoot, {
          event: 'member-dead',
          teamId,
          member: entry.key,
          sessionId: entry.sessionId,
          liveness: 'pid-dead',
          evidence: 'process-dead',
          via: 'watchdog',
        });
        deathIncidents.push({
          kind: 'member-dead',
          text: renderMemberDeadText(
            entry.key,
            entry.sessionId,
            entry.key === leadKey,
            entry.firstSight,
            summary.resume !== undefined,
            entry.recentLife,
            // v0.9.9（V098-07）：本轮已回池的未认领单（若有）——文案对它们写「已回池」
            // 而不是「冻结待回池」（后者对 pending 单是过度承诺）。
            repooled,
            entry.duty,
          ),
        });
      }
      // 成员死亡告警排在本轮事故最前（与 v0.9.9 及以前的文案次序一致：先死后其它）。
      incidents.unshift(...deathIncidents);
      // 重新武装的成员：注册表里上一轮判亡翻成的 dead 自述清回 idle（R6 的翻回面；
      // running 由下一回合边界标——此刻没有回合中的引擎证据，取保守 idle）。
      for (const rearmed of rearmedKeys) {
        try {
          await clearSessionDead(stateRoot, rearmed.sessionId, { now });
        } catch {
          /* best-effort：清失败下一轮再清 */
        }
      }
    }

    // ── 2.5 v0.9.3（A4）needs-continuation 认领：读台账 → 判「idle 持续 ≥T 且本 episode
    //    未通知」→ 写台账（临界段持 continuation 锁，V092-01 同款理由：两把重叠扫描不得
    //    对同一 episode 各发一条）。判据自销性由台账保证：通知后 notifiedAt 在场，重复
    //    轮询直接跳过（不轰炸）；成员恢复 running / 任务离开 in_progress ⇒ 条目删除，
    //    下一个 idle episode 从零计时（状态变化重置）。
    //    **无候选也要进临界段**：重置（清条目）本身就是判据不再命中时的动作——只在有候选
    //    时清理的话，「任务刚完成」的那一轮永远不会清账，下一次 idle 会继承旧 episode。
    {
      const thresholdMs = continuationThresholdMsFromEnv(env);
      try {
        await withContinuationStateLock(stateRoot, async () => {
          const locked = await readContinuationState(stateRoot);
          let dirty = false;
          // 状态变化重置：不再命中的成员（running / 任务终态 / 被移除）一律清条目。
          const qualifying = new Set(continuationCandidates.map((c) => c.key));
          for (const key of Object.keys(locked.members)) {
            if (!qualifying.has(key)) {
              delete locked.members[key];
              dirty = true;
            }
          }
          for (const candidate of continuationCandidates) {
            const previous = locked.members[candidate.key];
            // episode 起点：可信的 idle 进入时刻优先（引擎写的 livenessTs），缺失用台账
            // 里的首见时刻，再缺失用本轮时刻（= 看门狗首次观察到该状态）。
            const since = candidate.idleSinceTs ?? previous?.since ?? now;
            const entry: ContinuationMemberRecord = previous === undefined
              ? { since, taskId: candidate.taskId }
              : { ...previous, since, taskId: candidate.taskId };
            // idle 重新进入（livenessTs 前移到首见之后）= 新一轮 episode：允许再通知一次。
            if (previous !== undefined && since > previous.since) {
              delete entry.notifiedAt;
              dirty = true;
            }
            locked.members[candidate.key] = entry;
            dirty = true;
            if (now - entry.since < thresholdMs) continue; // 还没 idle 够久
            if (entry.notifiedAt !== undefined) continue; // 本 episode 已通知（一条）
            entry.notifiedAt = now;
            const idleForMin = Math.round((now - entry.since) / 60_000);
            summary.needsContinuation.push({ key: candidate.key, taskId: candidate.taskId, idleForMin });
            await logEngineEvent(stateRoot, {
              event: 'needs-continuation',
              teamId,
              member: candidate.key,
              sessionId: candidate.sessionId,
              taskId: candidate.taskId,
              liveness: 'idle',
              idleForMs: now - entry.since,
              thresholdMs,
              via: 'watchdog',
            });
            incidents.push({
              kind: 'needs-continuation',
              text: `成员 "${candidate.key}" 已 idle ${idleForMin} 分钟而其名下任务 ${candidate.taskId} 仍是 in_progress`
                + `（事件 needs-continuation）——回合已结束而任务未完成`
                + '（G-22：不做自动续踢，续踢=wake 会被容量闸拦，请人工决定续派/重供给）。'
                + '可用 xc_overview 核对后 xc_dispatch 重派，或 xc_team({action:"member-add"}) 幂等重供给。',
            });
          }
          if (dirty) await writeContinuationState(stateRoot, locked);
        });
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error;
        // 拿不到锁 = 另一把扫描正在认领：本轮跳过（下节拍再试，判据不丢）
      }
    }

    // ── 3. limbo 判据（看门狗面）+ v0.9.3（A1）claimed-未投递释放：锁外预读候选 → 团队锁内
    //    处置 → 事件 + 节流 + 合并告知。
    //    与 engine/wake.ts 的 per-spawn 监视器共用 core/mailbox.ts 的候选判据与
    //    watchdog-state 的 (messageId, 轮次) 节流台账。降级/释放都在团队锁内且判据自销
    //    （deliveredAt / deliveryClaimedAt 被清）⇒ 同一次失效恰一次，告警随处置 1:1，
    //    不被重叠扫描放大。两类判据互斥（limbo 要 deliveredAt 在场，A1 要它缺席），
    //    同一条消息不会既降级又释放。
    //    候选来自上面那一次合并预读（limboCandidates / claimCandidates）；两类的处置都在
    //    同一个团队锁临界段内完成（一次取锁做两件事，不放大锁竞争）。
    if (limboCandidates.size > 0 || claimReleaseIds.size > 0) {
      const downgraded = new Map<string, TeamMessage[]>();
      const released = new Map<string, TeamMessage[]>();
      try {
        await withTeamLock(stateRoot, teamId, async () => {
          const locked = await readTeam(stateRoot, teamId);
          if (locked === undefined) return;
          for (const key of limboCandidates.keys()) {
            const hits = await sweepLimboDeliveriesLocked(stateRoot, locked, key, now, limboTimeoutMs);
            if (hits.length > 0) downgraded.set(key, hits);
          }
          for (const [key, ids] of claimReleaseIds) {
            const hits = await sweepExpiredDeliveryClaimsLocked(stateRoot, locked, key, now, deliveryLeaseMs, ids);
            if (hits.length > 0) released.set(key, hits);
          }
        });
      } catch {
        /* 锁忙/IO：本轮不判（下轮再看；判据自销，不会重复降级/释放） */
      }
      // v0.9.3（A1）：释放事件（每条恰一条——释放即清 claimed，第二遍扫不到）。
      // v0.9.3 打回第 2 轮（验收四 V093-05）：claimedAt/waitedMs 必须取自**扫前候选**——
      // sweepExpiredDeliveryClaimsLocked 的返回是释放后形状（deliveryClaimedAt 已清，
      // core/mailbox.ts 判据自销设计），从返回值读该字段恒得 undefined：旧代码 `?? 0` 把
      // claimedAt 兜成 0、waitedMs 退化成纪元量级（验收实测 1795184908533ms vs 真实 61.7s，
      // 违反「核对回执与事件如实」面）。与同函数 limbo 路径同范式（limboCandidates 扫前
      // 捕获 deliveredAt、发射时查表）：候选阶段捕获、发射阶段查表。
      for (const [key, messages] of released) {
        const claimedAtOf = new Map(
          (claimCandidates.get(key) ?? []).map((c) => [c.id, c.deliveryClaimedAt]),
        );
        // 释放 id 必来自候选且判据要求 claimed 在场 ⇒ 查表必中；缺省分支理论不可达，
        // 走到也不编造计时（宁缺勿假：无诚实计时的释放事件不如不发，租约释放本身已落盘）。
        const timed = messages.flatMap((message) => {
          const claimedAt = claimedAtOf.get(message.id);
          return claimedAt === undefined ? [] : [{ message, claimedAt }];
        });
        for (const { message, claimedAt } of timed) {
          summary.leaseExpired.push(message.id);
          await logEngineEvent(stateRoot, {
            event: 'delivery-lease-expired',
            teamId,
            to: key,
            from: message.from,
            messageId: message.id,
            ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
            claimedAt,
            releasedAt: now,
            waitedMs: Math.max(0, now - claimedAt),
            leaseMs: deliveryLeaseMs,
            via: 'watchdog',
          });
        }
        if (timed.length > 0) {
          incidents.push({
            kind: 'lease-expired',
            text: `${timed.length} 条消息的投递租约超时未盖章（claimed 无 delivered ≥${Math.round(deliveryLeaseMs / 60000)}min；事件 delivery-lease-expired），`
              + `已自动释放租约回 pending（可 pull/可重投）：${timed.map((t) => t.message.id).join(', ')}。`
              + '该轮投递尝试被无声放弃（引擎进程可能死在盖租约与 spawn 之间）——消息不丢，请重发或让成员 xc_read({scope:"inbox"}) 兜底。',
          });
        }
      }
      const freshIds: string[] = [];
      for (const [key, messages] of downgraded) {
        for (const message of messages) {
          const stampedAt = limboCandidates.get(key)?.get(message.id);
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
            const stampedAt = [...limboCandidates.values()].find((m) => m.has(id))?.get(id);
            if (limboAlertAlreadySent(locked, id, stampedAt)) continue;
            markLimboAlertSent(locked, id, stampedAt, now);
          }
          await writeWatchdogState(stateRoot, locked);
        });
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error;
      }
    }

    // ── 4.7 v0.10.0（组 A / R2 后半；补充·R8 联动）：**补醒**（锁外；attemptWake 必须
    //    持无团队锁，§2.7-4）──
    // 两类未读各一个场景：
    // - 派单被忙闲闸挡下（delivered=mailbox，事件 dispatch-deferred-busy——组 B 的 R2
    //   前半）→ scene=dispatch-resume：成员回合结束后无人驱动它去读邮箱/认领，看门狗按
    //   **普通派单场景**补一次唤醒（不设 urgent——紧急不豁免的口径不变）；
    // - 紧急回执被「收件人回合进行中只落邮箱不唤醒」挡下（组 B R8 + 追加裁决的待补醒
    //   标记）→ scene=report-resume 且 **urgent:true**（插队信息要排到未读最前）。
    // 两类都照常经过容量闸与在途 nonce 闸，消息不丢的兜底（邮箱 pull）不变，同一成员一个
    // 冷却窗内最多一次（判据在 phase 1 的邮箱循环里，见 dispatchResumeCandidates）。
    // v0.10.0（集成员·第 5 轮 / 对抗 ADV-02）：被**防风暴总次数闸**挡下的补醒先落审计
    // （零 attemptWake、零 nonce、零生命周期账、邮箱消息不动）——审计与真补醒同处落盘，
    // 运维可一条事件看出「本轮想补但没补」与「补了但被容量闸挡下」的区别。
    for (const deferred of resumeWakeDeferredCandidates) {
      summary.resumeWakeDeferred.push({
        key: deferred.key,
        scene: deferred.scene,
        messageIds: deferred.messageIds,
        reason: RESUME_WAKE_CAP_REASON,
      });
      await logEngineEvent(stateRoot, {
        event: RESUME_WAKE_DEFERRED_EVENT,
        teamId,
        to: deferred.key,
        sessionId: deferred.sessionId,
        scene: deferred.scene,
        reason: RESUME_WAKE_CAP_REASON,
        taskIds: deferred.taskIds,
        messageIds: deferred.messageIds,
        resumeWakeMax,
        note: `成员空闲、无在途唤醒、收件箱有未读消息，但 10min 窗内真唤醒补醒已达上限 ${resumeWakeMax}`
          + `（XC_RESUME_WAKE_MAX）——本轮不补醒（防唤醒风暴：每次补醒一整棵无头进程树）；`
          + '消息仍留邮箱未读，pull 兜底不丢，成员自己回合随时可读',
      });
    }
    for (const candidate of dispatchResumeCandidates) {
      const taskIds = candidate.taskIds;
      const isReportResume = candidate.scene === RESUME_SCENE_REPORT;
      const ticket = isReportResume
        ? `[zcode-crosschat 看门狗·补醒] 成员 "${candidate.key}" 回合已结束而收件箱有未读紧急回执`
          + `（${candidate.messageIds.length} 条${taskIds.length > 0 ? `，任务 ${taskIds.join(', ')}` : ''}）——`
          + '按紧急回执场景补一次唤醒（scene=report-resume；urgent，容量闸照常判定、紧急不豁免）。'
          + '请 xc_read({scope:"inbox"}) 优先消费该回执。'
        : `[zcode-crosschat 看门狗·补醒] 成员 "${candidate.key}" 回合已结束而收件箱有未读派单`
          + `（${candidate.messageIds.length} 条${taskIds.length > 0 ? `，任务 ${taskIds.join(', ')}` : ''}）——`
          + '按普通派单场景补一次唤醒（scene=dispatch-resume；容量闸照常判定，紧急不豁免）。'
          + '请 xc_read({scope:"inbox"}) 消费未读派单并按需 xc_claim 认领。';
      const sent = await attemptWake({
        stateRoot,
        teamId,
        toAgentKey: candidate.key,
        toSessionId: candidate.sessionId,
        workspace: deps.workspace,
        reason: candidate.scene,
        receiptIds: candidate.messageIds,
        ticket,
        ...(candidate.urgent ? { urgent: true } : {}),
        env,
        ...(deps.capacitySample !== undefined ? { capacitySample: deps.capacitySample } : {}),
        // v0.10.0（集成员·第 5 轮 / 对抗 ADV-02）：测试注入的 spawn（缺省 = 真 spawnResume）。
        ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      });
      summary.dispatchResumed.push({
        key: candidate.key,
        scene: candidate.scene,
        messageIds: candidate.messageIds,
        delivered: sent.delivered,
        ...(sent.note !== undefined ? { note: sent.note } : {}),
      });
      await logEngineEvent(stateRoot, {
        event: candidate.scene,
        teamId,
        to: candidate.key,
        sessionId: candidate.sessionId,
        taskIds,
        messageIds: candidate.messageIds,
        delivered: sent.delivered,
        cooldownMs: resumeCooldownMs,
        note: (isReportResume
          ? '成员空闲（最近引擎事件 session-idle、无在途回合）且收件箱有未读紧急回执（task-receipt ∧ urgent/待补醒标记）——按紧急回执场景补一次唤醒（urgent）'
          : '成员空闲（最近引擎事件 session-idle、无在途回合）且收件箱有未读派单——看门狗按普通派单场景补一次唤醒')
          + (sent.note !== undefined ? `；${sent.note}` : ''),
        ...(sent.wakeDeferred !== undefined
          ? { wakeDeferred: true, retryAfterMs: sent.wakeDeferred.retryAfterMs }
          : {}),
      });
    }

    // ── 5. 锁外通知 + 唤醒（attemptWake 必须持无团队锁，§2.7-4）──
    // v0.10.0（组 A / R5）：lead 类收件人只写 urgent 邮箱、不唤醒（XC_WATCHDOG_WAKE_LEAD
    // 未设时）——不把主控拉成无头分身；「是否尝试过唤醒」由 watchdog-wake 事件如实记录。
    const wakeLead = watchdogWakeLeadFromEnv(env);
    if (incidents.length > 0) {
      const recipients = planRecipients({ team, leadKey, viewsByKey, leadCurrentlyDead: summary.leadCurrentlyDead });
      const text = renderRoundIncidents(incidents, {
        leadKey,
        leadCurrentlyDead: summary.leadCurrentlyDead,
        // v0.9.9（V098-07）：本轮判死路径回池的未认领单——合并文案据此用「已回池」真实
        // 措辞（空 = 无未认领单，文案逐字节保持 v0.9.6 口径）。
        unclaimedRepooled: summary.unclaimedRepooled,
      });
      if (text !== undefined) {
        if (recipients.length === 0) {
          // 无人可通知（lead 死且无其他活成员 / 全员不可寻址）→ 只落审计，不抛、不回退。
          // 认领保持 pending：等有活成员可寻址时由重发队列补发（V093-04）。
          await logEngineEvent(stateRoot, {
            event: 'watchdog-notify-skipped',
            teamId,
            reason: summary.leadCurrentlyDead ? 'lead-dead-no-other-live-members' : 'no-live-recipients',
            incidents: incidents.length,
            deadThisRound: summary.dead,
          });
        } else {
          await notifyAndWake(deps, teamId, recipients, text, 'message', summary, { leadKey, wakeLead, team });
          // v0.9.3 打回第 1 轮（V093-04）：通知已发出 → 台账改 'sent'（best-effort；写失败
          // 的代价是下一轮重发一条，方向是「宁可重发，不永久静音」）。
          // v0.9.6（A2/V095-06）：按台账复合键定位（summary.dead 是成员名）。
          await markDeathNotified(
            stateRoot,
            summary.dead
              .map((key) => {
                const sid = deathCandidates.find((c) => c.key === key)?.sessionId;
                return sid === undefined ? undefined : watchdogLedgerKey(key, sid);
              })
              .filter((k): k is string => k !== undefined),
            now,
          );
        }
      }
    }

    // ── 5.5 v0.9.3 打回第 1 轮（V093-04）：pending 重发（认领了但通知从未落地的兜底）──
    // v0.9.3 打回第 2 轮（V093-01 残留①）：重发前先**条件式补发 member-dead 事件**——
    // 「重发只发邮箱/唤醒、不留事件」会让 engine.jsonl 与 A3 事故摘要都看不见这次死亡
    // （adv-3 C7.1 实测：member-dead events: 0 而 watchdog-wake: 1）。条件式（已有则不补）
    // 保证「一次死亡一条事件」：审计不出现同键两条，A3 摘要按成员键去重也不会双计。
    if (renotifyPending.length > 0) {
      const keys = renotifyPending.map((entry) => entry.key);
      await backfillMemberDeadEvents(stateRoot, teamId, renotifyPending);
      const recipients = planRecipients({ team, leadKey, viewsByKey, leadCurrentlyDead: summary.leadCurrentlyDead });
      let delivered = false;
      if (recipients.length === 0) {
        // 仍无人可通知：delivered 保持 false ⇒ 计入一次尝试（有上限，不会无限重试），
        // 也不重复刷 watchdog-notify-skipped 审计（主路径已刷过）。
      } else {
        try {
          await notifyAndWake(deps, teamId, recipients, renderRenotifyText(keys, leadKey, summary.leadCurrentlyDead), 'message', summary, { leadKey, wakeLead, team });
          delivered = true;
        } catch {
          /* 通知通道失败：计入一次尝试，下轮再试 */
        }
      }
      summary.renotified.push(...keys);
      await logEngineEvent(stateRoot, {
        event: 'watchdog-notify-resent',
        teamId,
        members: keys,
        delivered,
        note: '死亡告警此前只完成台账认领、通知未落地（认领与通知非原子 / 进程崩在两者之间 / 台账陈旧恢复）——按 pending 补发；'
          + 'member-dead 事件按「是否已有」条件式补发（一次死亡一条，A3 事故摘要不双计）',
      });
      await recordRenotifyAttempt(
        stateRoot,
        renotifyPending.map((entry) => ({ memberKey: entry.key, ledgerKey: entry.ledgerKey })),
        delivered,
        teamId,
        now,
      );
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
 * v0.9.5（A7）：**休眠恢复检测**——定时器面记录两次点火的真实墙钟间隔（机器休眠/
 * 挂起时进程与定时器一同冻结，恢复后第一次点火的真实间隔 = 休眠时长，Node 定时器
 * 把错过节拍合并成一次点火）：间隔 > `max(2×周期, WATCHDOG_RESUME_GAP_FLOOR_MS)` ⇒
 * 本轮按补扫口径跑（`watchdog-resume` 事件 + 补扫窗口内死亡照常告警，不静音）。
 * 检测放在定时器面而非 sweep 内部：sweep 的 `now` 可被测试注入（合成时刻会伪造出假
 * 间隔），真实墙钟只在定时器面流动。补扫事件由共享台账去重（每 MCP server 一把扫描，
 * 恢复同刻只落一条事件）。
 *
 * v0.9.6（A4/V095-13）：间隔判据加**下界钳制**——仅超 2×周期不判恢复，还须超过
 * 60s 下界：事件循环的秒级同步停顿（GC/杀毒/磁盘冻结，实测 3.56s）在周期较短的配置下
 * 也会超 2×周期，v0.9.5 会误落 resume 事件并把补扫窗收缩到 gapMs 造成静音；下界以下
 * 一律按正常节拍跑（常规新鲜窗照常覆盖，无静音面）。
 *
 * v0.9.6（A4/V095-10）：补扫窗口 = {@link watchdogCatchupWindowMs}
 * （min(max(gapMs, 常规 10min 新鲜窗), 7 天上界)）——短恢复不再把新鲜窗**收缩**到
 * gapMs（补扫不许比常规更聋），月级 hiatus 的 7 天防误报上界保留。
 *
 * @param intervalMs 测试注入的轮询间隔；缺省 env `XC_WATCHDOG_MS`（0 = 关，返回 undefined）。
 */
export function startMemberWatchdog(
  deps: WatchdogDeps,
  intervalMs?: number,
): NodeJS.Timeout | undefined {
  const interval = intervalMs ?? watchdogIntervalMsFromEnv(deps.env);
  if (!Number.isFinite(interval) || interval <= 0) return undefined;
  // 恢复判据阈值：2×周期（扫描耗时余量）与 60s 下界（事件循环停顿不是休眠，V095-13）取大。
  const resumeThresholdMs = Math.max(2 * interval, WATCHDOG_RESUME_GAP_FLOOR_MS);
  // 上一次定时器点火的真实时刻（undefined = 首轮，无间隔可比）。
  let lastFireAt: number | undefined;
  const timer = setInterval(() => {
    const firedAt = Date.now();
    const gapMs = lastFireAt !== undefined ? Math.max(0, firedAt - lastFireAt) : undefined;
    lastFireAt = firedAt;
    const resume = gapMs !== undefined && gapMs > resumeThresholdMs
      ? { gapMs, catchupWindowMs: watchdogCatchupWindowMs(gapMs) }
      : undefined;
    void sweepMembersOnce(deps, undefined, resume !== undefined ? { resume } : {}).catch(() => undefined); // sweepMembersOnce 自带兜底，双保险
  }, interval);
  timer.unref?.();
  return timer;
}
