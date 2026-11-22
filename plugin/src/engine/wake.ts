/**
 * M2/W3 wake-engine —— 推送唤醒：delivered 三态决策、回执/身份行/wakeToken/任务票 prompt 组装
 * （≤4000 字符）、一次性 wake nonce（兼在途标记，TTL=15min）、fire-and-forget 无头 --resume。
 *
 * 设计依据 docs/DESIGN.md：
 * - §2.4  机器可解析回执前缀 `[CrossChat inbox receipt: {teamId, recipient, ids[]}]`
 * - §2.5  三态 wake|mailbox|duplicate；push 三重启用条件（开关 "true" ∧ 属主缺席约束 ∧ 无在途
 *         nonce）；WAKE_INFLIGHT_MS=15min 与 60s 投递租约"两个计时不混用"；任务票 ≤4000 字符；
 *         fire-and-forget"不看唤醒的返回值判定成败"
 * - §2.3-4  wake nonce：registry/wake/<token>.json {teamId, agentKey, sid, ts, used?}；
 *         唤醒 prompt 显式携带目标 sid 与 wakeToken（不依赖钩子注入）
 * - §2.5/§4.2  派发唤醒 prompt 内嵌成员守则摘要（claim→执行→report→结束回合，不 busy-poll）
 * - §2.7-4  慢操作（spawn）一律锁外；本模块对邮箱的补盖章（claim/delivered/release）按 dsh
 *         tools.js:2140-2156 的做法各自短暂重取 team 锁
 *
 * v0.2 增量（DESIGN-V0.2.md，文件所有权表 §9.1 wake.ts 归 W3 task-flow）：
 * - §3.4  MEMBER_RULES 升级为 **守则 v2**（MEMBER_RULES_V2，多任务自驱版：回合内多单循环/
 *         心跳/idle 通知/unblock-notice 处理/shutdown 帧），替换 v0.1.0 摘要版；
 * - §9.1  「新增场景 unblock/idle/post-provision/shutdown 的 prompt 组装、buildWakePrompt
 *         白名单兼容」：守则附加从 `reason === "dispatch"` 单判改为**场景白名单**
 *         WAKE_RULES_SCENES（dispatch/post-provision 附加守则；unblock/idle/cancel/
 *         report/message/shutdown/stale-sweep 不附加——成员已带守则开工，lead 不是守则对象）；
 * - §4.2  W1 接线：spawnResume 的 onHelperSpawned(childPid) → engine.jsonl
 *         {event:"wake-child", pid}（与 wake 行的 helper pid 并排可查，§4.2 审计）；
 * - §6.3/§7.3.3  唤醒路径成员状态门控：目标成员 state ∈ {provisioning, failed, removed}
 *         → 只入箱不唤醒（E-a 派发/E-b unblock/E-c idle 的公共唤醒路径检查点——tools.ts
 *         主体不改（§10.4 唯一缝隙），门控只能落在这里才同时覆盖三条边）。
 *
 * v0.9 增量（reports/31-v090方案.md §一，组B 配置/唤醒/送达）：
 * - G-6/G-4/G-7 唤醒分层：开关判定改分层闸（core/config.ts resolveWakeGate）——
 *   引擎供给成员（identity=engine，headless by design）免全局开关恒可唤醒；
 *   其余目标 file（.crosschat/config.json，每次投递现读=改文件即热生效）>
 *   env（XC_WAKE_ENABLED）> 内置默认 false；畸形 config.json 回落次层并披露
 *   WARNING（config-malformed 事件 + 跳过原因/回执 note）。wake-skipped 原因行
 *   相应更新（自带来源与一行开启指引）。
 * - G-8 送达重试：失败侦听命中 sessionNotFound 证据 → 自动重绑重试恰一次
 *   （wake-retry/wake-retry-failed 事件留痕；不重投邮箱，幂等）。
 *
 * v0.9.1 r3 增量（合并裁决 P0/P1 打回，组B 四项）：
 * - V090-05 唤醒分层×身份接管：引擎免开关增加**持有者校验**——identity:"engine"
 *   只是 roster 行的粘滞标，交互式会话 takeover 后 joinTeam 保留该标；判据 =
 *   行当前 sid 的会话记录 boundName（只有 member-add 代写与 wakeToken 注册两条
 *   引擎路径会写）。接管行回落 file/env/默认层并置 takenOver 披露。
 * - V090-06 重试绕门：retryOnceAfterSessionNotFound 重试前复检成员状态门 +
 *   分层闸 + 在途 nonce（不过 → wake-retry-skipped，不 spawn、不重开租约）。
 * - V090-07 失败侦听窗口外静默：WAKE_WATCH_WINDOW_MS 20s→120s（宿主冷启动实测
 *   25s 才落盘），回执 note 改为如实的有界承诺（超窗/进程退出 → 邮箱 pull 兜底），
 *   不再无条件宣称「失败由引擎自动检测」。
 * - V090-08 畸形 config 披露半通道：放行路径的 wake note 与 spawn-failed note
 *   均携带 gate.warning（与 wake-skipped 原因行同口径）。
 * - V090-12（本域部分）去重键档位：findDuplicateMail 纳入 urgent/interrupt
 *   差异——同文后发的 interrupt/urgent 不得判重（调用方接线在 C 域 tools-relay.ts）。
 * - v0.9.1（G-12-b）spawn 前容量闸：attemptWake 在 createWakeNonce 之前读 capacity
 *   verdict（judgeCapacity 任一规则 ∨ 边际预估 > freeBytes）→ 不 spawn、deliver=mailbox
 *   + wake-deferred{reason:"capacity-red"} + 冷却重试（XC_MEM_WAKE_COOLDOWN_MS，
 *   XC_MEM_WAKE_GATE=off 可关闸）；重试路径（sessionNotFound 自动重绑）复检同一道闸。
 *   闸只挡唤醒不拦 pull——消息照常落邮箱，收方自己的回合随时可读。
 * - v0.9.3（37-v093 方案 §一 组B，容量闸段）：闸的三旋钮走**分层配置**
 *   （core/capacity.ts resolveCapacityThresholds：config.json capacity 段 >
 *   env > 内置默认，每次现读）；生效值变更落 `config-effective-changed` 事件
 *   （B4，对拍基线 capacity/config-state.json）；持续态告警（B3：wake-deferred
 *   窗内累积 ≥XC_DEFERRED_ALERT_N、wake 生效值连续 false ≥XC_WAKE_OFF_ALERT_MS
 *   且有 pending → urgent lead，状态真源 capacity/wake-alert-state.json）；
 *   闸状态读数 wakeGateStatus（B2，供 mcp/tools-overview.ts 三视图同源挂载）。
 *
 * v0.9.1 打回第 1 轮增量（V091-01/V091-02，voiceOwner 伪造/越权盖章面）：
 * - **wake nonce 真值不落任何共享日志**：engine.jsonl 的 wake/wake-child/wake-failed/
 *   wake-retry/wake-retry-skipped/wake-skipped/wake-slow/message-limbo 事件与
 *   wake-lifecycle 头行，其 `nonce` 字段一律改记**不可反查摘要**
 *   （{@link wakeNonceDigest} = sha256 前 12 hex）。非ce 真值只存在于两处：
 *   唤醒 prompt（只达无头进程）与 registry/wake/<token>.json 状态真源。
 *   背景：裁决实测（adv-1 TC-1）同状态根会话读 logs/engine.jsonl 即可收割 nonce，
 *   抢先消费（consumeWakeNonce 置 used）把合法无头回合踢掉并冒名注册——日志面是
 *   被高频外泄/贴证的面，真源则不被贴；本修复把泄露面收回状态真源（README 已知
 *   限制 12 同款边界：同机可读状态文件，不做密码学防御）。
 * - 键名保持不变（PROTOCOL §15.3 冻结键集只对拍键名），值从令牌变摘要——运维
 *   对账仍可做（同一次唤醒的各行摘要相同），但拿不到可消费的令牌。
 *
 * v0.9.2 增量（reports/35-v092方案.md §二 组A：主动告警链 + limbo 校准）：
 * - **A1 同步启动确认**：spawn 成功后不再以「fire-and-forget 已发起」结案——在
 *   `XC_START_CONFIRM_MS`（缺省 5000ms，正整数；0/负/非法回落缺省）内观察 wake-child
 *   的**启动证据**（helper 经 onHelperSpawned 汇报的唤醒子 pid，即唤醒子真正被拉起）
 *   → `WakeResult.startConfirmed` 两态。未见 → `false` + 措辞「已发起但未见启动证据」
 *   （仍不是送达确认、也不是失败：失败语义由 wake-failed 事件与邮箱 pull 兜底）。
 *   等待有**提前出口**：helper 进程已退出而未汇报 = 不可能再有证据，立即结算（不白等
 *   满窗）；direct 形态没有汇报通道，如实按未见处理（该形态仅测试/对照保留）。
 * - **A4 limbo 校准**（机制 B 判据的三处误报收口）：
 *   (a) 锁竞争回写失败 → **宽限重试**：目标 sid 自盖章后有会话活动（复用 wake-slow 的
 *       sessionStartedSince/lastSeen 投影）时，缺失的 consumedAt 可能只是 hook 的注入
 *       回写没抢到团队锁（2s 预算）——宽限一个 limboGraceMs 再判，不立即判未消费；
 *   (b) wake prompt 已**内嵌消息全文**（message/withdrawal 场景）且回合确已开跑 →
 *       记 `injectedConsumed`（consumedAt 回写），不因成员没调 xc_read 而误判 limbo；
 *   (c) 降级告警按 **(messageId, 轮次=stampedAt)** 节流、同轮多条合并为一条 urgent
 *       告知（台账 engine/watchdog-state.ts，与看门狗清扫共用同一真源）。
 *
 * v0.9.3 增量（reports/37-v093方案.md §一 组A：投递可靠性）：
 * - **A2 三级指标 + 致死原因回读**：① 新增汇总事件 `wake-spawn-ok` / `wake-child-alive` /
 *   `wake-consumed`（既有 wake/wake-child 事件不删）——回执（WakeResult.wakeTiers）与
 *   overview 的唤醒漏斗改用三级；② 回读唤醒子日志（logs/wake-*.json）识别 **provider
 *   限流类死亡**（RateLimitError/quota/额度 关键词）→ `wake-degraded{reason:
 *   "provider-rate-limit"}` + urgent 告知 lead（进程内按 nonce 摘要去重，一次）；
 * - **A3 假成功检测**：delivered/wake 盖章后 `XC_FAKE_SUCCESS_MS`（缺省 5min）目标 sid
 *   无任何回合投影（session-running/prompt-submit 的持久投影 = 会话记录刷新）→
 *   `delivery-unconfirmed` 事件 + urgent lead（恰一条）。与既有 wake-slow **同源同判据**，
 *   本版合并为一次告警（事件双落、urgent 只发一条，互斥不叠加）；与 A1（判据要求
 *   ¬deliveredAt）和 A2（已披露限流致死即根因已知）显式互斥。
 *
 * dsh 原版参照（dsh-agent-teams 0.1.29，lib/ 目录）：
 * - tools.js:2088-2093  duplicate 幂等判定（from+content+taskId/attemptId+source* 全等 ∧
 *   isCurrentMail ∧（有任务绑定 ∨ 未读））——本文件导出 findDuplicateMail 供工具面复用
 * - mailbox.js:49-51  mailboxPrompt = receipt 前缀 + 正文（zcode 版由 M1 formatReceipt/
 *   mailboxBody 承担，本文件只做组装与截断）
 * - tools.js:2140-2156  wake 接受→markDelivered / 拒绝→release；zcode 版按 fire-and-forget
 *   改写：spawn 成功即 markDelivered，同步失败 release 并降级 mailbox
 * - scheduler.js:80-81  截断标记 `…[truncated]` 思想
 *
 * 调用契约（与 M3 tools.ts 对齐，见其头部 ASSUMED M1/M2 CONTRACT）：
 *   attemptWake(req) 在**团队锁外**调用；req.receiptIds 是调用方锁内刚 append 的消息 id；
 *   duplicate 判定与邮箱写入在 M3；开关判定、nonce 写入、在途去重、prompt 组装、spawn 全在 M2。
 *
 * ── M1 依赖面 ────────────────────────────────────────────────────────────────
 * 集中在下方 import 块；M1（plugin/src/core/）是磁盘真源与协议字段的唯一定义处
 * （DESIGN §7/§8.1-3）。
 * ───────────────────────────────────────────────────────────────────────────
 */
import {
  claimMailboxDelivery,
  formatReceipt,
  isCurrentMail,
  limboCandidateMessages,
  markMailboxConsumed,
  markMailboxDelivered,
  readMailbox,
  releaseMailboxDelivery,
  appendMailbox,
  createMessage,
  sweepLimboDeliveriesLocked,
} from "../core/mailbox";
import { readFileSync, rm, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
// v0.9.1（G-12-b）：容量闸冷却记录用 promise 版 mkdir/rm（与 core/atomic.ts 同族口径）。
// v0.9.3（A2）：三级计数读 engine.jsonl 尾部窗口（open + stat，与 core/timeline.ts 同口径）。
// v0.9.3 打回第 1 轮（V093-02/03）：投递尝试证据扫描（registry/wake 目录 + logs 目录清单）。
import { mkdir, readFile, rm as rmAsync, open, readdir } from "node:fs/promises";
// v0.9.3（A2）：唤醒三级指标的消费确认轮询读——直读邮箱 JSONL（不走 readMailbox 的
// 读取面审计：轮询读不重复审计坏行/帧拒绝，审计由真正的读取面承担）。
import { readJsonl } from "../core/jsonl";
import { inboxFile } from "../core/paths";
import { logEngineEvent } from "../core/log";
import { pidAlive, withTeamLock } from "../core/lock";
import { wakeLifecycleFile, wakeLogFile, engineLogFile, wakeDir, wakeFile, logsDir } from "../core/paths";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../core/atomic.js";
import {
  capacityCacheFile,
  capacityThresholdLabel,
  diffCapacityConfigState,
  judgeCapacity,
  resolveCapacityThresholds,
  sampleCapacity,
  type CapacityConfigKey,
  type CapacitySample,
  type CapacityThresholds,
  type CapacityVerdict,
  type CapacityViolatedRule,
} from "../core/capacity";
import {
  resolveWakeGate,
  wakeDisabledReason,
  wakeGateFromRaw,
  workspaceConfigFile,
  type WakeGate,
} from "../core/config";
import { readTeam, leadKeyOf } from "../core/teamstate";
import {
  adoptByPpidEnabledFromEnv,
  consumeWakeNonce,
  createWakeNonce,
  isWakeNonceFresh,
  readSession,
  readWakeNonce,
  type StoredWakeNonce,
  WAKE_INFLIGHT_MS,
} from "../core/registry";
import { sanitizeKey } from "../core/sanitize";
import { memberState, memberIdentity, isTeamMessage, type TeamMember, type TeamMessage, type TeamState, type WakeNonce } from "../core/types";
import { spawnResume, type WakeSpawnConfig } from "./resume-cli";
import { explicitSpawnConfigError, resolveZcodeSpawnConfig, type ResolvedSpawnConfig } from "./zcode-locate";
// v0.9.2（A4-c）：limbo 告警节流台账（与 engine/watchdog.ts 的看门狗清扫共用真源）。
import {
  limboAlertAlreadySent,
  markLimboAlertSent,
  readWatchdogState,
  writeWatchdogState,
} from "./watchdog-state";

/** v0.4（DESIGN-V0.4 §2.4）：req.cfg 测试注入（WakeSpawnConfig）与自动探测结果
 * （ResolvedSpawnConfig）的判别——`in` 收窄会给缺属性分支补 unknown（TS18046），
 * 显式谓词保证 outcome 只在探测分支被读取。 */
function isResolvedSpawnConfig(
  c: WakeSpawnConfig | ResolvedSpawnConfig,
): c is ResolvedSpawnConfig {
  return "outcome" in c;
}

/** 在途唤醒窗口（DESIGN §2.5-3）——唯一定义处是 M1 core/registry，此处转出口。 */
export { WAKE_INFLIGHT_MS };
/** 唤醒 prompt 上限（DESIGN §2.5"任务票截断"）。 */
export const WAKE_PROMPT_MAX_CHARS = 4000;

/** delivered 三态（DESIGN §2.5 表；dsh 的 live 态在 zcode 无对等 steer，弃用）。 */
export type DeliveredMode = "wake" | "mailbox" | "duplicate";

// ─────────────────────────── 唤醒子进程失败侦听（v0.5.1 FI-7） ───────────────────────────

/**
 * v0.5.1（FI-7/故障注-7）：唤醒子进程的**失败证据**判定（纯函数，单测直测）。
 *
 * 背景：helper 孤儿化后本进程拿不到子进程退出码（wake-helper.ts 立即退出，
 * 子进程 detached），唯一可观察面是 wake 日志文件（子进程 stdout/stderr 直落，
 * --output-format json 成功时末尾是单对象 JSON）。红队实测的失败形态是日志首行
 * `Error: Session not found: sess-…`（adjudication.md #15）。
 *
 * 只认**正向失败证据**，绝不虚报：
 * - 行首 `Error…`（CLI 崩溃输出的标准前缀；成功 JSON 是单行对象、以 `{` 开头，
 *   其内部文本即便含 "Error:" 也不会顶行）；
 * - 单行 JSON 对象携带错误形状：`isError:true` / `success:false` / 顶层非空 `error` 字符串。
 * 其余情况（窗口内无输出、普通告警）一律不表态——成功回合可能远超侦听窗口，
 * pull 邮箱与 wake 日志始终是真源。
 *
 * @returns 首个命中证据（截到 200 字符），无证据返回 undefined。
 */
export function findWakeFailureEvidence(logText: string): string | undefined {
  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (/^Error\b/i.test(line)) return line.slice(0, 200);
    if (line.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (record["isError"] === true || record["success"] === false) return line.slice(0, 200);
          const error = record["error"];
          if (typeof error === "string" && error.trim() !== "") return line.slice(0, 200);
        }
      } catch {
        /* 非 JSON 行（半行/进度文本）继续扫 */
      }
    }
  }
  return undefined;
}

/**
 * 失败侦听窗口默认值（从 spawn 成功起算；窗口静默=不表态，不虚报成败）。
 *
 * v0.9.1 r3（V090-07）：20s → 120s。红队复现实测：宿主 CLI 冷启动（Windows 杀软
 * 扫描/首次拉起）下失败证据 25s 才落盘，20s 窗口整条错过——wake-failed/wake-retry
 * 永不出现而回执宣称「自动检测」。120s 覆盖实测冷启动形态；窗口仍**有界**（
 * unref 定时器，不拖进程），超窗/本进程退出的情形由回执 note 如实声明并以邮箱
 * pull 兜底（见 attemptWake 返回的 note 文案）。
 */
export const WAKE_WATCH_WINDOW_MS = 120_000;
/** 失败侦听轮询间隔默认值。 */
export const WAKE_WATCH_POLL_MS = 500;

// ─────────────────── 致死原因回读 + 唤醒三级指标（v0.9.3 A2） ───────────────────

/**
 * v0.9.3（A2）：**provider 限流类死亡**关键词（大小写不敏感）。
 *
 * 方案原文：「回读 logs/wake-*.json 识别 provider 限流类死亡（RateLimitError/quota/
 * 额度类关键词）」。宿主 CLI 与上游 provider 的限流返图落在唤醒子的 stdout/stderr
 * （logs/wake-<to>-<ts>.json）——它是引擎进程唯一可读的**致死原因**面（孤儿化唤醒子的
 * 退出码对本进程不可观测，V9 边界；失败语义只有日志快照可承载）。
 *
 * 只认**关键词命中**，不猜进程状态：正常唤醒日志（CLI 的单对象 JSON 结果）不含这些词，
 * 故不误报；命中行原样截到 200 字符进事件（运维可对账原文）。
 */
const PROVIDER_RATE_LIMIT_RE = /rate\s*limit|ratelimit|\bquota\b|额度|too many requests|\b429\b/i;

/**
 * 在一段唤醒日志文本里找 provider 限流类证据（纯函数，单测直测）。
 * @returns 首个命中行（截到 200 字符）；无命中返回 undefined。
 */
export function findProviderRateLimitEvidence(logText: string): string | undefined {
  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (PROVIDER_RATE_LIMIT_RE.test(line)) return line.slice(0, 200);
  }
  return undefined;
}

/** v0.9.3（A2）：唤醒三级指标事件名（既有 `wake`/`wake-child` 事件**不删**，这三个是汇总/漏斗面）。 */
export const WAKE_TIER_EVENT_SPAWN_OK = "wake-spawn-ok";
export const WAKE_TIER_EVENT_CHILD_ALIVE = "wake-child-alive";
export const WAKE_TIER_EVENT_CONSUMED = "wake-consumed";

/** 三级指标计数（overview 挂载面；windowBytes/windowMs 随块披露，不假装看全了历史）。 */
export interface WakeTierCounts {
  /** 第一级：spawn 成功（无头 --resume 已发起）。 */
  spawnOk: number;
  /** 第二级：唤醒子启动证据到场（helper 汇报 pid）。 */
  childAlive: number;
  /** 第三级：本批消息被目标会话实际消费（consumedAt/readAt/discardedAt 到齐）。 */
  consumed: number;
  /** 本次计数覆盖的日志尾部字节数与时间窗（ms）——计数是有界窗口内的快照。 */
  windowBytes: number;
  windowMs: number;
}

/** 三级计数读的尾部窗口（与 core/timeline.ts TAIL_READ_MAX_BYTES 同口径）。 */
const WAKE_TIER_TAIL_BYTES = 256 * 1024;
/** 三级计数的时间窗（近 24h 的唤醒漏斗；更早的事件不计入——漏斗是近期健康度）。 */
const WAKE_TIER_WINDOW_MS = 24 * 60 * 60_000;

/**
 * v0.9.3（A2）：从 engine.jsonl 尾部窗口统计唤醒三级指标（overview 挂载用）。
 *
 * 为什么读日志而不是另建账：三个事件本身就是 engine.jsonl 的一等事件（时间线可按
 * `wake-spawn-ok` 过滤），计数只是同一真源的聚合投影——不新增状态文件、不新增真源。
 * 任何读取意外 → 全 0（观测面永不因计数失败而崩；调用方据此不挂载）。
 */
export async function readWakeTierCounts(stateRoot: string, now: number = Date.now()): Promise<WakeTierCounts> {
  const counts: WakeTierCounts = {
    spawnOk: 0, childAlive: 0, consumed: 0, windowBytes: 0, windowMs: WAKE_TIER_WINDOW_MS,
  };
  const file = engineLogFile(stateRoot);
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return counts; // 无日志/不可开：零计数（尚未发生过唤醒）
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - WAKE_TIER_TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    counts.windowBytes = length;
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // 窗口首行可能是被截断的半行——丢弃（timeline.ts 同口径）
    const since = now - WAKE_TIER_WINDOW_MS;
    for (const line of lines) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // 坏行不影响计数（读取面另有审计）
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      const ts = record["ts"];
      if (typeof ts === "number" && ts < since) continue;
      const event = record["event"];
      if (event === WAKE_TIER_EVENT_SPAWN_OK) counts.spawnOk += 1;
      else if (event === WAKE_TIER_EVENT_CHILD_ALIVE) counts.childAlive += 1;
      else if (event === WAKE_TIER_EVENT_CONSUMED) counts.consumed += 1;
    }
  } catch {
    /* 读中途失败：返回已计得的部分（best-effort 观测面） */
  } finally {
    await handle.close().catch(() => undefined);
  }
  return counts;
}

/** 三级计数的紧凑文本行（team/panel 文本面统一格式）。 */
export function wakeTierCountsLine(counts: WakeTierCounts): string {
  return `wake: spawn-ok ${counts.spawnOk} / child-alive ${counts.childAlive} / consumed ${counts.consumed}`
    + `（近 ${Math.round(counts.windowMs / 3_600_000)}h 尾部窗口 ${counts.windowBytes}B）`;
}

/**
 * 已披露过 provider 限流的 nonce 摘要集（进程内去重；有界）。
 *
 * 失败侦听面（120s 窗口 / 500ms 轮询）与生命周期监视面（15min 窗 / 5s 轮询）都可能
 * 读到同一次死亡的限流证据——两个面共享本集合，保证**同一次死亡只披露一次**
 * （跨进程不共享：这两个面都只活在派发方引擎进程里，不存在第二个进程重复披露）。
 * 与 degradedDisclosedRoots 同款有界台账口径（超限丢最早插入的键）。
 */
const rateLimitDisclosedNonces = new Set<string>();

/**
 * v0.9.3（A2）：provider 限流致死的**披露**（事件 + urgent 告知 lead，一次）。
 *
 * 与既有 wake-failed 的关系：限流死亡同时是一次投递失败（wake-failed 事件与租约释放
 * 照旧发生），但**告警不叠加**——调用方在已披露本函数时跳过 wake-failed 的 urgent
 * （同一次死亡一条告警；wake-degraded 的文案带根因与恢复指引，信息量严格更多）。
 */
async function discloseProviderRateLimit(
  stateRoot: string,
  input: {
    nonceToken: string;
    teamId: string;
    to: string;
    sid: string;
    scene: string;
    evidence: string;
    where: string;
  },
): Promise<void> {
  const digest = wakeNonceDigest(input.nonceToken);
  if (rateLimitDisclosedNonces.has(digest)) return;
  memoAddBounded(rateLimitDisclosedNonces, digest, DEGRADED_DISCLOSURE_MEMO_LIMIT);
  await logEngineEvent(stateRoot, {
    event: "wake-degraded",
    reason: "provider-rate-limit",
    where: input.where,
    scene: input.scene,
    teamId: input.teamId,
    to: input.to,
    nonce: digest,
    sid: input.sid,
    evidence: input.evidence,
    note: "唤醒子日志含 provider 限流类证据（RateLimitError/quota/额度）——该轮唤醒疑似被上游限流杀死；"
      + "消息仍在邮箱（pull 兜底不丢），限流消退后可重发；持续限流请调低唤醒频率或更换 provider 额度",
  });
  await notifyLeadUrgent(
    stateRoot,
    input.teamId,
    `[zcode-crosschat 引擎信号] wake-degraded：唤醒 "${input.to}" 疑似被 provider 限流杀死`
      + `（场景 ${input.scene}，${input.where}）：${input.evidence}。`
      + `消息仍在邮箱（pull 兜底不丢），限流消退后可重发；持续限流请调低唤醒频率或检查 provider 额度。`,
  );
}

// ─────────────────── 投递尝试的盘上证据（v0.9.3 打回第 1 轮 V093-02 / V093-03） ───────────────────

/**
 * v0.9.3 打回第 1 轮（V093-02/V093-03）：一次投递尝试留在盘上的**证据台账**（per member
 * 一次扫描，供该成员全部候选消息复用——不为每条消息各扫一遍目录）。
 *
 * 为什么需要它：`TeamMessage.deliveryClaimedAt` 被**多个写入面共用**——
 * ① attemptWake 步骤 4（真实投递尝试：过完分层闸/在途 nonce/状态门/容量闸之后才盖）；
 * ② 派单信封与引擎自写帧**出生即带**（mcp/tools-tasks.ts 建帧 extras、engine/watchdog.ts
 *    notifyAndWake 建帧、core/toolgate.ts 审批门帧）——这些帧可能从未有过任何投递尝试
 *    （唤醒闸关闭时 attemptWake 在写 nonce 之前就返回）。
 * 只看邮箱行的 A1「租约超时未盖章」判据因此会把「从未尝试」也读成「尝试被无声放弃」：
 * 假告警 + 租约被清 ⇒ 已消费/未尝试的消息回 pending（V093-01/02 两条 P1 的共同根因）。
 * 解法：释放前用引擎自己落在盘上的尝试证据做门槛——attemptWake 每次尝试都写
 * `registry/wake/<nonce>.json`（ts 恒等于当次 attemptWake 的 now，与它盖的租约同一个值）
 * 和 `logs/wake-lifecycle-<to>-<now>.jsonl`（文件名同 now），两者都是「尝试真的发生了」
 * 的机器可分辨证据；而 fresh nonce / start 头行无 exit 尾行 = 「尝试可能仍在途」。
 */
export interface DeliveryAttemptLedger {
  /** 该成员全部 wake nonce 的 ts（attemptWake 步骤 4 落盘；ts === 当次 attemptWake 的 now）。 */
  nonceTs: number[];
  /** 是否存在 fresh（未消费 ∧ 15min 窗内）nonce——在途唤醒的直接证据（§2.5-3 同一判据）。 */
  inflightNonce: boolean;
  /** 该成员生命周期账里的 start 头行（ts = 文件名里的 attempt now；exited = 已观察到子进程消失）。 */
  lifecycleStarts: Array<{ ts: number; exited: boolean }>;
}

/** 一条消息的租约（claimedAt）对应的尝试判据（纯函数）。 */
export interface DeliveryAttemptVerdict {
  /** 这次租约是否真对应一次 attemptWake 投递尝试（nonce.ts === claimedAt 或生命周期账文件名 ts === claimedAt）。 */
  attempted: boolean;
  /** 该尝试是否可能仍在途（fresh nonce，或 start 头行无 exit 尾行且未过 15min 窗）。 */
  inFlight: boolean;
}

/**
 * 扫一名成员的投递尝试证据台账（readdir + 逐文件读；任何读取意外按「无证据」降级——
 * 观测/判据面永不因盘读失败而抛）。
 */
export async function readDeliveryAttemptLedger(
  stateRoot: string,
  agentKey: string,
  now: number,
): Promise<DeliveryAttemptLedger> {
  const nonceTs: number[] = [];
  let inflightNonce = false;
  try {
    for (const entry of await readdir(wakeDir(stateRoot))) {
      if (!entry.endsWith('.json')) continue;
      const nonce = await readWakeNonce(stateRoot, entry.slice(0, -'.json'.length));
      if (nonce === undefined || nonce.agentKey !== agentKey) continue;
      nonceTs.push(nonce.ts);
      if (isWakeNonceFresh(nonce, now)) inflightNonce = true;
    }
  } catch {
    /* 无 registry/wake 目录或读失败：无 nonce 证据（不猜） */
  }
  const lifecycleStarts: Array<{ ts: number; exited: boolean }> = [];
  try {
    // 命名规则的真源是 core/paths.ts 的 wakeLifecycleFile（`wake-lifecycle-<to>-<ts>.jsonl`）；
    // 这里按同一形状反解（贪婪分组 + 锚定数字尾段，agentKey 含连字符/数字也不误判）。
    const dir = logsDir(stateRoot);
    const pattern = new RegExp(`^wake-lifecycle-(.+)-(\\d+)\\.jsonl$`);
    for (const file of await readdir(dir)) {
      const matched = pattern.exec(file);
      if (matched === null || matched[1] !== agentKey) continue;
      const attemptTs = Number(matched[2]);
      if (!Number.isFinite(attemptTs)) continue;
      const lines = await readWakeLifecycleLines(join(dir, file));
      if (!lines.some((line) => line['event'] === 'wake-child-start')) continue;
      lifecycleStarts.push({ ts: attemptTs, exited: lines.some((line) => line['event'] === 'wake-child-exit') });
    }
  } catch {
    /* 无 logs 目录或读失败：无生命周期证据（不猜） */
  }
  return { nonceTs, inflightNonce, lifecycleStarts };
}

/** 读一份生命周期账的全部行（坏行跳过；文件不存在 → 空）。 */
async function readWakeLifecycleLines(file: string): Promise<Array<Record<string, unknown>>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const lines: Array<Record<string, unknown>> = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) lines.push(parsed as Record<string, unknown>);
    } catch {
      /* 坏行不影响判据 */
    }
  }
  return lines;
}

/**
 * v0.9.3 打回第 1 轮（V093-02/V093-03）：一条 claimed 行的租约是否对应「真实发生过、
 * 且可能仍在途」的投递尝试（纯函数，单测直测）。
 *
 * - `attempted` 用**精确相等**而不是时间窗：attemptWake 步骤 4 先写 nonce 再盖租约，
 *   两者用的是同一个 `now`（wake.ts createWakeNonce/claimMailboxDelivery 同参），故
 *   `nonce.ts === claimedAt` 就是「盖这个租约的那次尝试」；生命周期账文件名里的 ts 同为
 *   该 now，作 nonce 文件丢失时的第二证据。精确相等因此不会把「别的消息的新尝试」误算到
 *   这条租约上（V093-02 的假告警形态），也不会漏掉真尝试（补盖章丢失时租约值仍是那次
 *   尝试的 now——claim 与补盖章是两次独立 best-effort 取锁，前者成后者败即该形态）。
 * - `inFlight` 刻意**宽**：任一 fresh nonce（15min 窗，isWakeNonceFresh 同一判据）或任一
 *   start 头行无 exit 尾行且未过 15min 窗，都按「可能仍在途」处理——在途尝试被判放弃会
 *   让同一条未读消息出现两个投递面（V093-03）。代价是同成员有新尝试时，旧租约的释放最多
 *   推迟一个 nonce 窗（≤15min），方向是保守的（迟告警，不错告警）。
 */
export function deliveryAttemptVerdict(
  ledger: DeliveryAttemptLedger,
  claimedAt: number,
  now: number,
): DeliveryAttemptVerdict {
  const attempted = ledger.nonceTs.includes(claimedAt)
    || ledger.lifecycleStarts.some((start) => start.ts === claimedAt);
  const inFlight = ledger.inflightNonce
    || ledger.lifecycleStarts.some((start) => !start.exited && now - start.ts < WAKE_INFLIGHT_MS);
  return { attempted, inFlight };
}

// ─────────────── 在途票的活体证据过滤 + 失败票据回收（v0.9.6 R1） ───────────────

/**
 * v0.9.6（R1①）：无生命周期证据的新鲜票据的**短宽限窗**（ms）。attemptWake 在
 * createWakeNonce 之后**同步**写 lifecycle start 头行（毫秒级）；本窗口只为「票据刚
 * 签发、头行还没来得及落盘」的进程内竞态兜底。30s 足以覆盖极端调度/盘慢；而供给失败
 * 等场景留下的**无 spawn 票据**（没有 lifecycle 账，R1 的孤儿票形态）过窗即不再算
 * 在途——旧实现按 15min nonce TTL 全窗压制派单（41-v095 real-smoke A §三：member-add
 * 失败留票 → 其后 15 分钟 dispatch 全被 wake-skipped(inflight-nonce) 压制）。
 */
export const WAKE_TICKET_GRACE_MS = 30_000;

/** v0.9.6（R1②）：供给失败场景票据回收的固定原因值（票据 JSON `revoked.reason` 与审计事件共用）。 */
export const WAKE_NONCE_REVOKE_PROVISION_FAILED = "provision-failed";

/**
 * v0.9.6（R1②）：**显式回收一张未消费的唤醒票据**（成员供给失败时，本 attempt 签发的
 * 票据不能继续充当在途唤醒标记）。
 *
 * 写入形态：票据 JSON 增 `used:true` + `revoked:{reason,at}`——
 * - `used:true` 让 `isWakeNonceFresh` 两面（MCP/钩子）都立即排除它：不再计入在途去重，
 *   也不能再被 xc_identify/钩子消费绑定身份（回收=作废，不是消费）；
 * - `revoked{reason:"provision-failed"}` 是回收证据：coerceWakeNonce 会剥离未知字段，
 *   故本证据以原始 JSON 形态持久在盘（法证面直读），并以 `wake-nonce-revoked` 事件
 *   双通道留痕（摘要进共享日志，真值不出状态根）。
 *
 * 幂等：票据不存在/已 used → 不改盘（revoked:false + alreadyUsed），调用方据此决定
 * 回执措辞；重入（已带 revoked）同样不改盘。任何 IO 失败按「未回收」返回，不抛——
 * 回收是失败路径的尽力清理，不得掩盖原始供给错误。
 */
export async function revokeWakeNonceForProvisionFailure(
  stateRoot: string,
  token: string,
  opts: { teamId: string; agentKey: string; sid: string; now?: number },
): Promise<{ revoked: boolean; alreadyUsed: boolean; digest: string }> {
  const digest = wakeNonceDigest(token);
  const file = wakeFile(stateRoot, token);
  const now = opts.now ?? Date.now();
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { revoked: false, alreadyUsed: false, digest }; // 票据不存在：无可回收
  }
  let stored: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { revoked: false, alreadyUsed: false, digest };
    }
    stored = parsed as Record<string, unknown>;
  } catch {
    return { revoked: false, alreadyUsed: false, digest }; // 坏票不猜（readWakeNonce 面同口径）
  }
  if (stored["used"] === true) {
    return { revoked: false, alreadyUsed: true, digest }; // 已消费：无需回收
  }
  if (stored["revoked"] !== undefined) {
    return { revoked: false, alreadyUsed: false, digest }; // 已回收：幂等重入
  }
  try {
    await writeFileAtomic(file, JSON.stringify({
      ...stored,
      used: true,
      revoked: { reason: WAKE_NONCE_REVOKE_PROVISION_FAILED, at: now },
    }, null, 2));
  } catch {
    return { revoked: false, alreadyUsed: false, digest }; // 回收失败如实回报（不掩盖原错误）
  }
  await logEngineEvent(stateRoot, {
    event: "wake-nonce-revoked",
    reason: WAKE_NONCE_REVOKE_PROVISION_FAILED,
    teamId: opts.teamId,
    to: opts.agentKey,
    sid: opts.sid,
    // v0.9.1 打回第 1 轮（V091-01）同口径：共享日志只记摘要。
    nonce: digest,
    note: "成员供给失败：本 attempt 签发的唤醒票据已显式回收（used+revoked 落盘），不留 15min 在途标记压制派单（v0.9.6 R1②）",
  });
  return { revoked: true, alreadyUsed: false, digest };
}

/** 单张票据的 lifecycle 账行集（读失败/缺文件 → 空账；与 readDeliveryAttemptLedger 同口径）。 */
async function readTicketLifecycleLines(
  stateRoot: string,
  agentKey: string,
  ticketTs: number,
): Promise<Array<Record<string, unknown>>> {
  return readWakeLifecycleLines(wakeLifecycleFile(stateRoot, agentKey, ticketTs));
}

/**
 * v0.9.6（R1①）：一张新鲜票据是否「有活体证据」（纯函数，单测直测）——在途去重只认
 * 这类票据，孤儿票（供给失败留票等从未 spawn 的票据）不再压制派单。
 *
 * 判据（与 deliveryAttemptVerdict 的在途面同一族，锚点对齐）：
 * - 账里有**本票据**的 start 证据（`wake-child-start` 头行，或启动确认落账的
 *   `wake-child-start-confirmed`/`-unconfirmed` 行——重试轮账没有独立头行，靠确认行
 *   识别；行带 nonce 摘要，摘要不匹配的行不算本票据的证据）且**无 exit 尾行**
 *   = 子进程仍在途 → 在途（去重照旧，§2.5-3 语义不变）；
 * - 账里 start 证据带 exit 尾行（子进程已消失）或本票据根本没有 start 证据：
 *   仅当票据签发未过 {@link WAKE_TICKET_GRACE_MS} 短宽限窗（头行未及落盘的竞态兜底）
 *   才算在途；过窗即孤儿/死票 → 不在途。
 *
 * 边界（如实声明）：强杀唤醒子可能导致 exit 尾行缺失（41-v095 §五-4 实测）——该形态
 * 在窗内仍按在途处理（保守方向：迟唤醒，不双唤醒），属信号边界，不在本轮修。
 */
export function wakeTicketHasLiveEvidence(
  lines: ReadonlyArray<Record<string, unknown>>,
  nonceDigest: string,
  ticketTs: number,
  now: number,
  graceMs: number = WAKE_TICKET_GRACE_MS,
): boolean {
  const starts = lines.filter(
    (line) =>
      line["event"] === "wake-child-start"
      || line["event"] === "wake-child-start-confirmed"
      || line["event"] === "wake-child-start-unconfirmed",
  );
  const mine = starts.filter((line) => line["nonce"] === undefined || line["nonce"] === nonceDigest);
  if (mine.length > 0 && !lines.some((line) => line["event"] === "wake-child-exit")) {
    return true; // 本票据已 spawn 且子进程未见退出：在途（正常去重语义保留）
  }
  // 无本票据的 spawn 证据（孤儿/死票）：只认短宽限窗内的刚签发票
  return now - ticketTs <= graceMs;
}

/**
 * v0.9.6（R1①）：{@link findInflightWakeNonce} 的**活体证据**版——在途去重（§2.5-3）
 * 的判据从「存在 fresh 票据」收紧为「存在有活体证据的 fresh 票据」：
 * 1. 新鲜（未 used ∧ 未过 15min TTL）∧ agentKey/teamId/sid 匹配（与旧版逐条一致）；
 * 2. 再按 {@link wakeTicketHasLiveEvidence} 过滤——lifecycle 账有本票据的 start 证据
 *    且无 exit 尾行（子进程在途），或票据在短宽限窗内签发。
 * 多张命中取 **ts 最新**（与旧版同语义）。供给失败留票、消费失败的死票不再压制派单；
 * 正常在途票（spawn 了、子进程活着）照旧去重——R1 修复不得牺牲现有去重语义（方案 §二-5）。
 */
export async function findLiveInflightWakeNonce(
  stateRoot: string,
  agentKey: string,
  options: { teamId?: string; sid?: string; now?: number; graceMs?: number } = {},
): Promise<StoredWakeNonce | undefined> {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? WAKE_TICKET_GRACE_MS;
  let entries: string[];
  try {
    entries = await readdir(wakeDir(stateRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const candidates: Array<StoredWakeNonce> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const token = entry.slice(0, -'.json'.length);
    const nonce = await readWakeNonce(stateRoot, token);
    if (nonce === undefined) continue;
    if (!isWakeNonceFresh(nonce, now)) continue;
    if (nonce.agentKey !== agentKey) continue;
    if (options.teamId !== undefined && nonce.teamId !== options.teamId) continue;
    if (options.sid !== undefined && nonce.sid !== options.sid) continue;
    candidates.push({ token, nonce });
  }
  candidates.sort((a, b) => b.nonce.ts - a.nonce.ts); // ts 最新优先（与 findInflightWakeNonce 同语义）
  for (const candidate of candidates) {
    const lines = await readTicketLifecycleLines(stateRoot, agentKey, candidate.nonce.ts);
    if (wakeTicketHasLiveEvidence(lines, wakeNonceDigest(candidate.token), candidate.nonce.ts, now, graceMs)) {
      return candidate;
    }
  }
  return undefined;
}

// ─────────────────────────── sessionNotFound 自动重试（v0.9 G-8） ───────────────────────────

/**
 * v0.9（G-8）：失败证据是否为 sessionNotFound（纯函数，单测直测）。
 * 宿主 CLI `--resume <已消失的 sid>` 的标准报错即 `Error: Session not found: sess-…`
 * （adjudication.md #15 实测形态）；大小写不敏感匹配证据文本中的
 * "session not found"，其余失败证据（ENOENT/超时等）不触发重试。
 */
export function isSessionNotFoundEvidence(evidence: string): boolean {
  return /session not found/i.test(evidence);
}

/**
 * v0.9（G-8）：重试再失败时的恢复动作文案（如实回执的一部分，进
 * wake-retry-failed 事件的 recovery 字段）。重试已把重绑机会用完——剩余
 * 恢复路径只有「成员重绑新 sid 后重发」与「lead 幂等重供给」两条，如实给指引。
 */
export const SESSION_NOT_FOUND_RECOVERY =
  "目标 sessionId 已失效且自动重绑重试仍失败：若成员已重启会话，请其调用 xc_identify 重绑新 sessionId 后重发；" +
  "或由 lead 用 xc_team({action:\"member-add\"}) 幂等重供给。消息仍在邮箱（pull 兜底不丢），不会重复投递。";

// ─────────────────────────── 开关判定（V7 + v0.9 分层） ───────────────────────────

/**
 * XC_WAKE_ENABLED 严格判定：**非 "true" 的一律按关闭**（含 undefined、""、"TRUE" 等任何其他
 * 值——模板展开行为未确认，DESIGN §9-V7），原始值由 attemptWake 记入 engine.jsonl。
 *
 * v0.9（G-6/G-4，core/config.ts）起本判定只描述 **env 层**：完整判定走分层闸
 * {@link decideDelivery}（config.json file > env > 内置默认；引擎供给成员免开关）。
 */
export function isWakeEnabled(raw: string | undefined | null): boolean {
  return raw === "true";
}

// ─────────────────────────── duplicate 去重（移植 tools.js:2088-2093） ───────────────────────────

/** 候选消息身份（与 dsh send_message 的判定字段一一对应；收件人邮箱即隐含 to）。
 * v0.9.1 r3（V090-12）增量：`urgent`/`interrupt` 投递档位（可选）——同文后发的
 * interrupt/urgent 不得被普通同文判重（否则第二件 delivered:"duplicate" 不落箱，
 * 收方永远看不到插队/中断语义，而发送方 payload 仍报 interrupt:{requested:true,
 * result:"deferred-next-turn"}——虚报）。调用方未声明（undefined）时判定与旧版
 * 逐字节一致：档位键只在调用方显式声明 true 时参与。 */
export interface MailIdentity {
  from: string;
  content: string;
  /** 收件人当前开放任务/attempt 快照（无则为 undefined）。 */
  taskId?: string;
  attemptId?: string;
  sourceTaskId?: string;
  sourceAttemptId?: string;
  sourceTaskStatus?: string;
  /** 候选消息的 urgent 档位（C1：xc_relay urgent/interrupt 写入侧）。 */
  urgent?: boolean;
  /** 候选消息的 interrupt 档位（v0.9 G-2 软中断；蕴含 urgent）。 */
  interrupt?: boolean;
}

const eqOpt = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? undefined) === (b ?? undefined);

/**
 * v0.9.1 r3（V090-12）：投递档位升级判定——候选显式声明 urgent/interrupt 而邮箱里
 * 的同文消息没有该档位时，**不判重**（插队/中断语义必须落地可见）。只认「升级」
 * 方向：候选未声明（undefined，旧调用方）或候选是普通件时行为不变——普通同文仍被
 * 去重（dsh tools.js:2088-2093 原语义），已 urgent 的同文重复发送也仍被去重。
 */
function deliveryClassEscalates(m: TeamMessage, candidate: MailIdentity): boolean {
  return (
    (candidate.urgent === true && m.urgent !== true) ||
    (candidate.interrupt === true && m.interrupt !== true)
  );
}

/**
 * 幂等判定：邮箱中已存在"同文且仍在效期"的消息则返回它（调用方应返回 duplicate 态且**不再追加**）。
 * 全等字段：from + content + taskId + attemptId + sourceTaskId/sourceAttemptId/sourceTaskStatus，
 * 且 isCurrentMail（M1 移植 mailbox.js:6-17）为真，且（有任务绑定 ∨ 尚未读过）——与
 * dsh tools.js:2088-2093 逐条件对应。（M3 tools.ts 自带内联判定；本函数是同语义的独立实现，供单测与复用。）
 * v0.9.1 r3（V090-12）：附加档位条件 {@link deliveryClassEscalates}——见其注释。
 */
export function findDuplicateMail(
  existing: TeamMessage[],
  team: TeamState,
  candidate: MailIdentity,
): TeamMessage | undefined {
  return existing.find(
    (m) =>
      m.from === candidate.from &&
      m.content === candidate.content &&
      eqOpt(m.taskId, candidate.taskId) &&
      eqOpt(m.attemptId, candidate.attemptId) &&
      eqOpt(m.sourceTaskId, candidate.sourceTaskId) &&
      eqOpt(m.sourceAttemptId, candidate.sourceAttemptId) &&
      eqOpt(m.sourceTaskStatus, candidate.sourceTaskStatus) &&
      isCurrentMail(team, m) &&
      (m.attemptId !== undefined || m.sourceAttemptId !== undefined || m.readAt === undefined) &&
      !deliveryClassEscalates(m, candidate),
  );
}

// ─────────────────────────── 三态决策（纯函数） ───────────────────────────

export interface DeliveryDecision {
  mode: DeliveredMode;
  /** 决策原因（进 engine.jsonl 与工具返回的 note，人可读）。 */
  reason: string;
}

export interface DeliveryDecisionInput {
  /** 锁内查重命中（M3 已自判；attemptWake 路径不传）。 */
  duplicate?: boolean;
  /**
   * XC_WAKE_ENABLED 原始值（V7：非 "true" 即关，原始值落 engine.jsonl）。
   * v0.9 起仅作兼容入口：wakeGate 缺省时按 env 层 shim（core/wakeGateFromRaw）
   * 判定；attemptWake 恒传分层闸 wakeGate。
   */
  wakeEnabledRaw?: string | undefined | null;
  /**
   * v0.9（G-6/G-4）分层唤醒闸（core/config.ts resolveWakeGate 的产物）：
   * 引擎供给成员（identity=engine）恒 enabled（source=engine-member，免开关）；
   * 其余目标 file（config.json）> env（XC_WAKE_ENABLED）> 内置默认 false。
   * 畸形 config.json 的 WARNING 随闸携带，进入跳过原因与回执 note。
   */
  wakeGate?: WakeGate;
  /**
   * §2.5-2 属主缺席约束（v1 无法检测属主，以约束代替检测）：
   * - `true`  ：调用方断言目标属主缺席（无头/CLI 驱动的会话，DESIGN §6.4 形态）——可推送；
   * - `false` ：调用方明示目标有活属主（桌面正打开/常驻 app-server 持有）——一律 mailbox；
   * - `undefined`（默认）：按 v1 约定放行——wake_enabled 开关本身就是用户对
   *   "仅属主缺席会话启用推送"约束的接受（plugin.json userConfig wake_enabled 描述语，
   *   DESIGN §8.2-A；活属主风险由 V5 声明约束规避）。
   */
  ownerAbsent?: boolean;
  /** 该目标存在未使用未过期 wake nonce（在途去重，§2.5-3）。 */
  inflight?: boolean;
}

/** delivered 三态决策（纯函数，不碰磁盘；磁盘版编排见 attemptWake）。 */
export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  if (input.duplicate === true) {
    return { mode: "duplicate", reason: "duplicate: 同文且仍在效期的消息已存在（tools.js:2088-2093 判定）" };
  }
  // v0.9（G-4/G-7）：开关判定改分层闸——wakeGate（分层）优先，缺省时按 env 原始值
  // shim（旧调用方/旧测试语义零变化）。source=engine-member 恒 enabled，不产生本行。
  const gate = input.wakeGate ?? wakeGateFromRaw(input.wakeEnabledRaw);
  if (!gate.enabled) {
    return { mode: "mailbox", reason: wakeDisabledReason(gate) };
  }
  if (input.ownerAbsent === false) {
    return { mode: "mailbox", reason: "owner-present: 目标属主在场，push 明令禁用（§2.5-2/V5，靠 pull 兜底）" };
  }
  if (input.inflight === true) {
    return {
      mode: "mailbox",
      reason: `inflight-nonce: ${Math.round(WAKE_INFLIGHT_MS / 60000)} 分钟内已有在途唤醒，不重复 --resume（§2.5-3）`,
    };
  }
  return { mode: "wake", reason: "enabled ∧ 属主约束放行 ∧ 无在途 nonce（§2.5 三重条件）" };
}

// ─────────────────────────── 唤醒 prompt 组装（≤4000） ───────────────────────────

export interface WakePromptInput {
  teamId: string;
  /** 收件人（已 sanitize 的 agentKey），进回执 recipient 与身份行。 */
  recipientKey: string;
  /** 收件人 sessionId——身份行显式携带（wakeToken 路径不依赖钩子注入，§2.3-4）。 */
  recipientSessionId: string;
  wakeToken: string;
  /** 回执携带的消息 id（M3 锁内 append 的那条）。 */
  receiptIds: readonly string[];
  /** 正文文本：任务票（dispatch）/回执摘要（report）/消息内容（message），由调用方给定。 */
  bodyText: string;
  /** 是否附加成员守则（dispatch 场景 true；report/message 唤醒省略以免噪声）。 */
  includeMemberRules?: boolean;
  /**
   * v0.6（C1，DESIGN-V0.6.md §3.1 读取序 3）：urgent 唤醒——正文携带段首位插
   * URGENT 横幅（横幅计入正文预算；正文维持预算内全文/截断规则不变）。
   * 横幅语义 = 「本条排在目标所有未读之首，先处理本条」——与邮箱读取面
   * urgentFirst（M3）同一规则在 wake 携带段的投影。
   */
  urgent?: boolean;
  /**
   * v0.9.4（A6）：唤醒场景标签（WakeRequest.reason 透传）——行动行据此分流：
   * message/withdrawal 场景正文即消息本体（「不要 xc_read，直接按正文处理」），
   * 其余场景正文是摘要/通知（保留 xc_read 指引）。缺省 = 旧行为（xc_read 指引）。
   */
  scene?: string;
  /**
   * v0.9.4（A6）：本批回执消息携带的**任务 id**（派单唤醒；attemptWake 从邮箱消息
   * 的 taskId 字段解析，单一 taskId 时才给）。在场 ⇒ 行动行写「任务票 taskId=…：
   * 直接 xc_claim」——不 xc_read 也能开工（唤醒一次到位的核心判据）。
   */
  taskId?: string;
  /**
   * v0.9.5（A1/V094-02）：**ppid 采纳档**（XC_ADOPT_BY_PPID=1 时 attemptWake 传 true）。
   * true = 身份行/守则规则 1 按「钩子已自动绑定，不要再调 xc_identify」口径（v0.9.4 A6）；
   * false/缺省（默认档）= 身份行/守则规则 1 按「wakeToken 调一次 xc_identify 自证」口径
   * （2 次调用兜底）——ppid 采纳默认关，prompt 不再宣称未发生的自动绑定。
   */
  adoptByPpidEnabled?: boolean;
}

/**
 * 成员守则 v2（DESIGN-V0.2.md §3.4 全文，「唤醒 prompt 内嵌文本，W3 交付于 wake.ts」，
 * 替换 v0.1.0 MEMBER_RULES 摘要版；§9.2 W3 对外接口 `export const MEMBER_RULES_V2: string`）。
 * 这是 G2「成员自动开工」的执行协议本体，逐条对应 CC 队友工作流（11-cc逆向 §4.3-5）。
 * 与 §3.4 比仅去掉两处纯设计内引用（§6.2 ③ / scheduler.js:178），语义零改动。
 * W2 的成员欢迎 prompt（xc_team member-add 步骤③）经本导出复用同一文本（§9.1 依赖方向）。
 * v0.7（M6）：守则内工具名随旧名移除同步改新名（xc_identify/xc_read/xc_team/xc_overview）。
 *
 * v0.9.4（A6）：守则组装改为「规则 1 可替换」——欢迎回合（跑在 app-server 里、无钩子）
 * 用原规则 1（显式 xc_identify + xc_read）；唤醒回合用 {@link MEMBER_RULES_V2_WAKE}
 * 的规则 1（身份已由钩子自动绑定、正文已内嵌不 xc_read、有票直接 claim）。
 * MEMBER_RULES_V2 本体的逐字文本不变（既有契约/测试不回归）。
 */
const MEMBER_RULES_V2_TAIL = [
  "2) 工作循环（一个回合可以做多单，做完一单领下一单）：",
  "   a. 取一单：优先看收件箱未读的 task-assignment / unblock-notice；",
  "   b. xc_claim(taskId) 拿 attemptId → xc_report(in_progress) → 执行；",
  "   c. 预计超过 10 分钟的任务每 ≤10 分钟 xc_report(in_progress)（心跳，附一句进展）；",
  "   d. 完成：xc_report(completed, result=结果摘要, evidence=[文件路径+至少一条])；",
  "      失败：xc_report(failed, error=原因)。回执发出后回到 a 取下一单。",
  "3) 没有可做的活：向 lead 发 xc_team({action:\"idle\"})（summary 必填；刚完成的单附 completedTaskId/completedStatus），",
  "   然后立即结束回合。不要空转轮询。（例外：首次供给的欢迎回合无单直接结束回合、不发 idle 通知",
  "   ——就绪由 roster state 表达。）",
  "4) xc_claim 被拒：task_not_pending（已被领）→ 不重试，回到 a；",
  "   dependencies_unmet → 该任务等 unblock-notice 再做，回到 a 看有没有别的活；",
  "   already_has_open_task → 先把手头的单做完报掉。",
  "5) stale attempt（attemptId 不匹配）→ 立即停手，该任务已被重置，回 a 取别的；",
  "   error:\"busy\" → 稍后重试一次，仍忙则 xc_team({action:\"idle\"}) 结束回合。",
  "6) 依赖任务的输出：claim 后如需上游产出，用 xc_overview 看依赖任务的 result 字段；",
  "   unblock-notice 里也会带上游结果摘要（有截断预算）。",
  "7) 收到 shutdown-request 帧 → 不再领取新任务，把手头单报告（或直接 failed）后结束回合。",
  "8) 一切与协作有关的状态只经 xc_* 工具读写；.crosschat/ 状态目录是只读诊断面。",
];

/** 守则 v2 组装（规则 1 注入；其余条固定）——欢迎/唤醒两个变体共用同一尾部，零漂移。 */
function composeMemberRulesV2(rule1: string): string {
  return ["成员守则 v2（多任务自驱版）：", rule1, ...MEMBER_RULES_V2_TAIL].join("\n");
}

export const MEMBER_RULES_V2 = composeMemberRulesV2(
  "1) 身份：先 xc_identify（本 prompt 已给出 name/sessionId/wakeToken），再 xc_read({scope:\"inbox\"}) 读消息。",
);

/**
 * v0.9.4（A6）：**唤醒回合**的守则 v2（规则 1 按「唤醒一次到位」改写，第 2-8 条逐字
 * 不变）。与欢迎回合版（{@link MEMBER_RULES_V2}）的唯一差别在规则 1：
 * - 身份：SessionStart 钩子在会话启动时消费唤醒票据已自动绑定（队内轴 + peer 轴），
 *   **不需要**模型调 xc_identify；自动绑定未生效时才用本 prompt 的 wakeToken 调一次
 *   兜底（兜底路径保留 v0.9.3 的全部校验：一次性/目标 sid/活性闸）；
 * - 取消息：正文已内嵌的场景（任务票 / 消息正文）**不要** xc_read，有任务票直接
 *   xc_claim(taskId)；正文只是摘要/通知的场景才 xc_read({scope:"inbox"}) 查收。
 */
export const MEMBER_RULES_V2_WAKE = composeMemberRulesV2(
  "1) 身份：本会话启动时引擎钩子已自动绑定（不要再调 xc_identify；未生效时用本 prompt 给出的 wakeToken 调一次兜底）。"
  + "取消息：正文已内嵌时（任务票/消息正文）不要 xc_read，有任务票直接 xc_claim(taskId)；"
  + "正文只是摘要/通知时才 xc_read({scope:\"inbox\"}) 查收。",
);

/**
 * v0.9.5（A1/V094-02）：**默认档（ppid 采纳关）**的唤醒守则 v2——规则 1 的身份段回到
 * v0.9.3 口径（首回合用 wakeToken 调一次 xc_identify 自证），取消息段与
 * {@link MEMBER_RULES_V2_WAKE} 逐字一致（行动行的「一次到位」分流不依赖身份档）。
 * ppid 采纳在多会话宿主上有错绑风险（V094-02），默认档宁可 2 次调用。
 */
export const MEMBER_RULES_V2_WAKE_FALLBACK = composeMemberRulesV2(
  "1) 身份：先 xc_identify（用本 prompt 给出的 wakeToken，name/sessionId 同身份行）绑定身份。"
  + "取消息：正文已内嵌时（任务票/消息正文）不要 xc_read，有任务票直接 xc_claim(taskId)；"
  + "正文只是摘要/通知时才 xc_read({scope:\"inbox\"}) 查收。",
);

/**
 * v0.2 唤醒场景标签全集（§9.1 新增场景 unblock/idle/post-provision/shutdown 的 prompt
 * 组装对齐值；W2/W4/W5 以同一组字符串调 attemptWake，engine.jsonl scene 字段可枚举审计）。
 * v0.1.0 已有：dispatch（派发任务票）/ report（终态回执）/ message（自由消息）；
 * v0.2 新增：unblock（W3 依赖解除）/ idle（W4 空闲通知）/ cancel（W4 任务取消）/
 * post-provision（W2 供给完成投产）/ shutdown（W2 成员停止收尾）/ stale-sweep（W3 清扫回执）。
 */
export const WAKE_SCENES = [
  "dispatch",
  "report",
  "message",
  "unblock",
  "idle",
  "cancel",
  "post-provision",
  "shutdown",
  "stale-sweep",
] as const;

/**
 * 守则附加白名单（§9.1「buildWakePrompt 白名单兼容」）：这些场景的唤醒 prompt 内嵌
 * MEMBER_RULES_V2——dispatch 是成员的第一次开工唤醒；post-provision（E-e 投产）虽在
 * 欢迎回合已见过守则，但它是成员第一条真实投产唤醒，重附一次守则保自驱循环可靠。
 * 其余场景（report/unblock/idle/cancel/message/shutdown/stale-sweep）不附加：成员
 * 已在守则下工作，lead 不是守则对象，省下的预算留给任务票正文。
 */
export const WAKE_RULES_SCENES: readonly string[] = ["dispatch", "post-provision"];

/** 场景 → 是否附加守则（白名单判定；未知场景一律不附加，向前兼容）。 */
export function includeRulesForScene(reason: string): boolean {
  return WAKE_RULES_SCENES.includes(reason);
}

const TRUNCATE_MARKER = "…[truncated]";

/**
 * v0.6（C1）：urgent 唤醒横幅（DESIGN-V0.6.md §3.1 读取序 3）——置于正文携带段
 * 首位；固定短行，计入正文预算（结构性部分回执行/身份行不截的纪律不变）。
 */
export const URGENT_WAKE_BANNER =
  "[URGENT] 用户紧急介入：本条消息排在目标所有未读之首，先处理本条，再回到常规工作循环。";

/** 截到 budget 内，超长加标记（scheduler.js:80-81 思想）。 */
function truncateBody(body: string, budget: number): string {
  if (budget <= 0) return TRUNCATE_MARKER;
  if (body.length <= budget) return body;
  const keep = Math.max(0, budget - TRUNCATE_MARKER.length);
  return body.slice(0, keep) + TRUNCATE_MARKER;
}

/**
 * 组装唤醒 prompt：回执 + 身份行(含 sid) + wakeToken + 任务票/正文（+ 派发场景的成员守则），
 * 总长 ≤ maxChars（默认 4000）。
 *
 * 截断策略（移植 scheduler.js:80-81 的 `[truncated]` 标记思想）：
 * 1. 回执行与身份行（结构性部分）不截——wakeToken/sid 缺失会让 wakeToken 注册路径断裂；
 * 2. 超预算时先截正文（任务票/回执文本），保结构性部分完整；
 * 3. 兜底硬切全文到 maxChars。
 */
export function buildWakePrompt(input: WakePromptInput, maxChars: number = WAKE_PROMPT_MAX_CHARS): string {
  const receipt = formatReceipt(input.teamId, input.recipientKey, input.receiptIds);
  // v0.9.5（A1/V094-02）：身份行按 **ppid 采纳档**分流——
  // - 开启档（XC_ADOPT_BY_PPID=1，v0.9.4 A6 口径）：SessionStart 钩子消费唤醒票据时
  //   已把队内轴 + peer 轴身份落盘（不经模型回合），身份行写「已自动绑定——不要再调
  //   xc_identify」；自动绑定未生效（票据已被消费/不匹配/钩子未跑）时保留 wakeToken
  //   兜底路径（一次性/目标 sid 校验与 v0.9.3 完全一致）；
  // - 默认档（缺省）：ppid 采纳默认关，钩子不消费票据——身份行如实写 wakeToken
  //   自证路径（2 次调用），不宣称未发生的自动绑定。
  const identity = input.adoptByPpidEnabled === true
    ? `你是 zcode 会话 "${input.recipientKey}"，sessionId=${input.recipientSessionId}。` +
      `身份已由引擎在会话启动时自动绑定（SessionStart 钩子消费唤醒票据，不经模型回合）——不要再调 xc_identify；` +
      `若自动绑定未生效，用 wakeToken 填 "${input.wakeToken}" 调一次 xc_identify 兜底（name/sessionId 同上）。`
    : `你是 zcode 会话 "${input.recipientKey}"，sessionId=${input.recipientSessionId}。` +
      `首回合先用 wakeToken 填 "${input.wakeToken}" 调一次 xc_identify（name="${input.recipientKey}"，sessionId 同上）绑定身份，再按行动行处理。`;
  // v0.9.4（A6）：行动行按「正文是否内嵌 + 是否带任务票」分流——任务票场景直接
  // xc_claim(taskId)（一次到位的核心判据）；消息正文场景不 xc_read 直接按正文处理；
  // 摘要/通知场景（post-provision 未读清单、idle/cancel/unblock…）才需要 xc_read 查收。
  const action = input.taskId !== undefined && input.taskId !== ""
    ? `任务票 taskId=${input.taskId}：正文已内嵌——不要 xc_read，直接 xc_claim("${input.taskId}") 拿 attempt 开工。`
    : input.scene !== undefined && wakePromptEmbedsMessageBody(input.scene)
      ? `正文已内嵌——不要 xc_read({scope:"inbox"})，直接按正文处理。`
      : `调用 xc_read({scope:"inbox"}) 读取回执对应的消息。`;
  // v0.9.4（A6）：唤醒回合附加的守则用 WAKE 变体（规则 1 = 已自动绑定/正文内嵌/直接
  // claim）；欢迎回合（provision.ts）仍用 MEMBER_RULES_V2 原版（无钩子、须显式 identify）。
  // v0.9.5（A1）：规则 1 同身份行分流（默认档 = MEMBER_RULES_V2_WAKE_FALLBACK）。
  const rules = input.includeMemberRules === true
    ? (input.adoptByPpidEnabled === true ? MEMBER_RULES_V2_WAKE : MEMBER_RULES_V2_WAKE_FALLBACK)
    : undefined;

  // v0.6（C1）：urgent 唤醒 → 正文携带段首位插横幅（横幅 + 原正文合计受正文预算
  // 约束；横幅固定短行，超长时先压正文再压横幅尾部——truncateBody 作用于合计文本，
  // 保横幅与正文头部的可读顺序）。
  const body = input.urgent === true
    ? `${URGENT_WAKE_BANNER}\n${input.bodyText}`
    : input.bodyText;

  // 分隔符开销：parts 以 "\n\n" 连接。
  const sepCount = (rules === undefined ? 3 : 4) * 2;
  const bodyBudget = Math.max(
    0,
    maxChars - receipt.length - identity.length - action.length - (rules?.length ?? 0) - sepCount,
  );
  const parts = rules === undefined
    ? [receipt, identity, action, truncateBody(body, bodyBudget)]
    : [receipt, identity, action, truncateBody(body, bodyBudget), rules];
  let prompt = parts.join("\n\n");
  if (prompt.length > maxChars) {
    // 兜底硬切（结构性部分自身超限时才会走到这里）。
    const keep = Math.max(0, maxChars - TRUNCATE_MARKER.length);
    prompt = prompt.slice(0, keep) + TRUNCATE_MARKER;
  }
  return prompt;
}

// ─────────────────────────── spawn 前容量闸（v0.9.1 G-12-b；v0.9.2 C2/C3/C5 收口） ───────────────────────────

/**
 * v0.9.1（G-12-b）：spawn 前容量闸——「容量只警不拦 = 死亡螺旋」的收口。
 *
 * 实测事实（2026-11-19 内存红线事故）：RED 判定本身正确
 * （仲裁 3：预估与含进程树成本同量级，早先「预估高 4-5 倍」的批评被推翻），但
 * `attemptWake` 不读 capacity verdict——内存枯竭期继续 spawn 无头 --resume 子进程 →
 * 更多 OOM（当日 wake-failed 16+、水位 8.9%），而 wake 层正好是内存放大器的入口。
 *
 * 判据（G-12-b 原文「水位<硬底或边际预估>freeBytes」）：
 * ① `judgeCapacity` 任一规则命中（watermark 硬底 / session-limit / turn-concurrency）；
 * ② **边际预估**：单回合预估（`XC_TURN_ESTIMATE_BYTES`，采样器 headlessTurnMaxRssBytes
 *    校准后仍由 env 调）> 当前 freeBytes——再起一个无头回合也放不下。
 * degraded 样本（CIM 不可用）只评 watermark 一条（既有 judgeCapacity 口径，不虚报）。
 *
 * 动作：**不 spawn**，直接 `delivered:"mailbox"` + payload `wake-deferred{reason:"capacity-red"}`
 * + engine 事件 `wake-deferred` + 冷却窗（`XC_MEM_WAKE_COOLDOWN_MS`，缺省 120s）：窗内
 * 再来的唤醒不重复采样、不 spawn（RED 期的重试风暴本身是放大器）；窗到期后重新采样，
 * 转 GREEN 即清掉冷却标记、下次唤醒立即通行。
 *
 * v0.9.2 增量（34-v091验收 V091-13/14/15/18/19 五条 mustFix，全部落在本闸）：
 * - **C3 冷却键分域**：冷却记录按 `teamId|收方|紧急度` 分域（V091-15：此前只按 stateRoot，
 *   一个进程的 RED 把全队唤醒——含紧急 relay——一并静默转 mailbox）；
 * - **C3 窗内沿用明示**：窗内命中时 detail 追加 `cooldown-reuse` 行，写明「未重采样、
 *   detail/水位是首次判定时刻的快照」（V091-19：五个观测面全绿而唤醒决策面称 capacity-red
 *   的跨面矛盾，根因是窗内原样返回落盘记录而不说明它是旧快照）；
 * - **C3 冷却 env 上钳**：`XC_MEM_WAKE_COOLDOWN_MS` ≤ 1h，越界/非法/超钳都不静默
 *   （V091-15 实测 999999999999 → 277777.78h 照收）；
 * - **C2 degraded 披露**：CIM 不可用时**放行路径**也落 `wake-capacity-degraded` 事件
 *   （V091-14：此前「进程类规则未评」的 detail 只在判红时随 wake-deferred 落盘，GREEN 时
 *   被整体丢弃——宿主 CIM 坏了而闸静默放行，运维零线索）；
 * - **C5 gateEnv 原值**：wake-deferred 事件补 `gateEnv`（V091-18：注释承诺「非法值不静默、
 *   事件带 gateEnv 原值」实际只落布尔 `wakeGateEnabled`，运维分不清「没配」与「配错」）。
 *
 * 边界（如实声明）：闸门只挡**唤醒**（spawn），不拦 pull——消息照常落邮箱，收方自己
 * 的回合随时可读（§2.5 mailbox 行兜底不变）。派单面的「RED 期排队拒绝」需在派单工具
 * 面接线（非本文件域），本版在 wake 层给出 deferral 块与冷却窗供其消费（PROTOCOL §15.2）。
 */

/** 容量闸冷却窗缺省值（ms）——RED deferral 后的静默窗，窗内不重复采样/spawn。 */
export const WAKE_CAPACITY_COOLDOWN_MS_DEFAULT = 120_000;

/**
 * 冷却窗 env 上钳（v0.9.2 C3，V091-15）：≤ 1h。
 * 无上钳时一个笔误（`999999999999`）等于把唤醒通道关 277777 小时——观测旋钮不该有
 * 「永久」档位；超钳按上钳生效并在 deferral detail 明示（不静默）。
 */
export const WAKE_CAPACITY_COOLDOWN_MS_MAX = 3_600_000;

/** 冷却窗 env 解析结果（v0.9.2 C3：分辨「没配」「配错了」「超钳」三种情况，不静默）。 */
export interface WakeCooldownEnvInfo {
  /** 生效窗长（ms）。 */
  cooldownMs: number;
  /** env 原值（未设/空串 = null）。 */
  raw: string | null;
  /** null = 原值生效；'invalid' = 非法值已回落内置缺省；'clamped' = 超上钳已钳制。 */
  fellBack: 'invalid' | 'clamped' | null;
}

/** 冷却窗 env：`XC_MEM_WAKE_COOLDOWN_MS`（ms，>=0 合法；0=不冷却=每次投递都重新判定）。 */
export function wakeCapacityCooldownInfoFromEnv(env: NodeJS.ProcessEnv = process.env): WakeCooldownEnvInfo {
  const raw = env["XC_MEM_WAKE_COOLDOWN_MS"];
  if (raw === undefined || raw.trim() === "") {
    return { cooldownMs: WAKE_CAPACITY_COOLDOWN_MS_DEFAULT, raw: null, fellBack: null };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { cooldownMs: WAKE_CAPACITY_COOLDOWN_MS_DEFAULT, raw, fellBack: 'invalid' };
  }
  if (n > WAKE_CAPACITY_COOLDOWN_MS_MAX) {
    return { cooldownMs: WAKE_CAPACITY_COOLDOWN_MS_MAX, raw, fellBack: 'clamped' };
  }
  return { cooldownMs: n, raw, fellBack: null };
}

export function wakeCapacityCooldownMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return wakeCapacityCooldownInfoFromEnv(env).cooldownMs;
}

/**
 * 容量闸开关 env：`XC_MEM_WAKE_GATE`。`"off"` = 关闭容量闸（回到 v0.9.0「只警不拦」
 * 行为）；其余值/未设 = 开启。非法值不静默——按开启处理并在事件里带 `gateEnv` 原值
 * （v0.9.2 C5/V091-18：兑现本注释的承诺，此前只落布尔 `wakeGateEnabled`），
 * 运维可分辨「我没配」与「我配错了」。
 */
export function wakeCapacityGateEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["XC_MEM_WAKE_GATE"];
  if (raw === undefined || raw.trim() === "") return true;
  return raw.trim().toLowerCase() !== "off";
}

/** `XC_MEM_WAKE_GATE` 原值（未设/空串 = null）——wake-deferred 事件 `gateEnv` 字段用。 */
export function wakeCapacityGateEnvRaw(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env["XC_MEM_WAKE_GATE"];
  return raw === undefined || raw.trim() === "" ? null : raw;
}

/** 冷却状态文件（与 capacity 采样缓存同目录）：`<stateRoot>/capacity/wake-deferred.json`。 */
export function wakeDeferralFile(stateRoot: string): string {
  return join(dirname(capacityCacheFile(stateRoot)), "wake-deferred.json");
}

/** deferral 块（进 WakeResult 与工具 payload；PROTOCOL §15.2 键集冻结）。 */
export interface WakeDeferral {
  reason: "capacity-red";
  /** 命中规则明细（judgeCapacity detail + 边际预估行；人可读）。 */
  detail: string[];
  /** 采样时刻的设备水位（freeBytes/totalBytes）。 */
  watermark: number;
  freeBytes: number;
  /** 本次生效的冷却窗长度（ms）。 */
  cooldownMs: number;
  /** 还需等待多久才重新判定（ms；cooldownActive=true 时 = 窗内剩余）。 */
  retryAfterMs: number;
  /** true = 本次是冷却窗内的重复请求（未重新采样）。 */
  cooldownActive: boolean;
}

/**
 * 冷却记录的**分域键**（v0.9.2 C3，V091-15）：teamId + 收方 + 紧急度。
 *
 * 为什么要分域：冷却记录落 `capacity/wake-deferred.json`（状态根级、进程间共享），
 * 而闸的语义却是「这一次唤醒先别 spawn」。v0.9.1 只按 stateRoot 一个键——成员 A 的 RED
 * deferral 会把**全队**（含紧急 relay、含别的 team）后续唤醒在窗内一并静默转 mailbox，
 * 且窗内连 judgeCapacity 都不跑，运维在五个观测面看到全绿却不知道唤醒为何没发生。
 * 分域后一个进程的 RED 只静默它自己那一格；紧急度单列使紧急 relay 不被普通消息的
 * 冷却挡下（它仍会被重新判定——RED 期照样 defer，但那是当次判定的结论，不是别人的）。
 */
export interface WakeCooldownScope {
  teamId: string;
  to: string;
  urgent: boolean;
}

/** 分域键的字符串形态（`<teamId>|<收方>|<urgent|normal>`；teamId/to 已是 sanitize 后的键）。 */
export function wakeCooldownKeyOf(scope: WakeCooldownScope): string {
  return `${scope.teamId}|${scope.to}|${scope.urgent ? "urgent" : "normal"}`;
}

/**
 * 落盘的冷却记录（比块多 `until` 绝对时刻、首次判定时刻与分域键）。
 * `sampledAt` = detail/水位快照的产生时刻——窗内沿用据此标注「这是旧快照」（V091-19）。
 * v0.9.3（B2）增 `violated`/`marginalExceeded`：命中条件名（机器可读）——观测面
 * 「阻塞原因（哪个条件命中）」的直读来源；旧记录无这两字段按未知处理（只影响观测面
 * 的条件名展示，detail 仍完整，不误读成别域的挡门）。
 */
interface WakeDeferralRecord extends WakeDeferral {
  until: number;
  sampledAt: number;
  scope: WakeCooldownScope;
  /** judgeCapacity 命中的规则名（旧记录缺省 = []）。 */
  violated?: CapacityViolatedRule[];
  /** 边际预估是否超 freeBytes（旧记录缺省 = false）。 */
  marginalExceeded?: boolean;
}

/**
 * 冷却记录文件形态（v0.9.2 C3 起为 version 2：`entries` 按分域键索引）。
 * v0.9.1 的平铺记录（无 `version`/`entries`）**不迁移**：按损坏处理→重新判定
 * （最坏多采样一次，绝不会把旧格式误读成另一个键域的挡门）。
 */
interface WakeDeferralStore {
  version: 2;
  entries: Record<string, WakeDeferralRecord>;
}

function formatBytesLabel(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.round(n)}B`;
}

/** 读指定键域的冷却记录；过期/损坏/未来时钟/异格式 → undefined（重新判定）。 */
async function readWakeDeferral(
  file: string,
  now: number,
  key: string,
): Promise<WakeDeferralRecord | undefined> {
  try {
    const store = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    if (store["version"] !== 2 || typeof store["entries"] !== "object" || store["entries"] === null) {
      return undefined; // v0.9.1 平铺格式或损坏 → 重新判定（不误读成别域的挡门）
    }
    const rec = (store["entries"] as Record<string, unknown>)[key];
    if (rec === null || typeof rec !== "object") return undefined;
    const record = rec as Record<string, unknown>;
    const until = Number(record["until"]);
    if (!Number.isFinite(until) || until <= now) return undefined;
    const detail = Array.isArray(record["detail"])
      ? (record["detail"] as unknown[]).filter((d): d is string => typeof d === "string")
      : [];
    const scopeRaw = record["scope"];
    const scope: WakeCooldownScope =
      scopeRaw !== null && typeof scopeRaw === "object"
        ? {
            teamId: String((scopeRaw as Record<string, unknown>)["teamId"] ?? ""),
            to: String((scopeRaw as Record<string, unknown>)["to"] ?? ""),
            urgent: (scopeRaw as Record<string, unknown>)["urgent"] === true,
          }
        : { teamId: "", to: "", urgent: false };
    return {
      reason: "capacity-red",
      detail,
      watermark: Number(record["watermark"]) || 0,
      freeBytes: Number(record["freeBytes"]) || 0,
      cooldownMs: Number(record["cooldownMs"]) || 0,
      retryAfterMs: Math.max(0, until - now),
      cooldownActive: true,
      until,
      sampledAt: Number(record["sampledAt"]) || 0,
      scope,
      // v0.9.3（B2）：命中条件名（旧记录无这两字段 → 空/否，观测面按未知呈现）。
      violated: Array.isArray(record["violated"])
        ? (record["violated"] as unknown[]).filter(
            (v): v is CapacityViolatedRule =>
              v === "watermark" || v === "session-limit" || v === "turn-concurrency",
          )
        : [],
      marginalExceeded: record["marginalExceeded"] === true,
    };
  } catch {
    return undefined; // 缺文件/损坏 JSON → 重新判定（不因冷却文件坏掉而永久挡唤醒）
  }
}

/**
 * 已披露过 CIM 降级的 stateRoot 集合（v0.9.2 C2，V091-14 修复的节流件）。
 *
 * CIM 不可用是**持续性状态**（宿主限制进程枚举就一直坏），每次唤醒都落一条
 * `wake-capacity-degraded` 会把 engine.jsonl 刷成噪声、把真信号淹掉。故每个状态根在
 * 持续降级期间只披露一次；采样恢复（非 degraded 样本）即从集合除名，下次降级重新披露。
 * 进程内去重（重启即重披露；engine.jsonl 是跨进程权威）与 `mcp/task-edges.ts` 的
 * `anomalyAuditMemo` 同款口径——含同一式有界台账（超限丢最早插入的键，防长命进程无界增长）。
 */
const degradedDisclosedRoots = new Set<string>();
const DEGRADED_DISCLOSURE_MEMO_LIMIT = 1024;

function memoAddBounded(set: Set<string>, key: string, limit: number): void {
  set.add(key);
  if (set.size > limit) {
    const oldest = set.values().next();
    if (!oldest.done) set.delete(oldest.value);
  }
}

/** CIM 降级披露（放行路径）：不声称已评进程类规则，也不静默放行。 */
async function discloseCapacityDegraded(
  stateRoot: string,
  sample: CapacitySample,
  verdict: CapacityVerdict,
): Promise<void> {
  const key = resolve(stateRoot);
  if (degradedDisclosedRoots.has(key)) return;
  memoAddBounded(degradedDisclosedRoots, key, DEGRADED_DISCLOSURE_MEMO_LIMIT);
  await logEngineEvent(stateRoot, {
    event: "wake-capacity-degraded",
    degraded: sample.degraded,
    watermark: sample.watermark,
    freeBytes: sample.freeBytes,
    detail: verdict.detail,
    note: "CIM 进程采样不可用——本轮只评 os 水位（watermark），进程类规则（session-limit/turn-concurrency）未评；"
      + "唤醒照常放行（fail-open 同族：观测故障不挡协作），但进程类容量事实此刻不可知",
  });
}

/**
 * 容量闸判定（spawn 前调用；返回 undefined = 放行）。
 *
 * 顺序：开关 → 冷却窗（**本键域**窗内直接 deferred，不采样）→ 真采样 → 判定 → 写冷却记录。
 * 采样意外（os 读数异常等）**fail-open**：不因观测故障永久挡住协作唤醒，但落
 * `wake-capacity-probe-failed` 事件如实披露（与「只警不拦」的旧行为相比仍是净增益：
 * 正常情况下闸在工作）。CIM 降级（采样成功但拿不到进程树）是另一种故障：照样 fail-open
 * 放行，但落 `wake-capacity-degraded` 明示「进程类规则未评」（v0.9.2 C2）。
 *
 * @param scope 冷却键域（teamId + 收方 + 紧急度；v0.9.2 C3）——必填，不设默认值：
 *   默认值会让漏传的调用方悄悄掉进一个共享键域，正是 V091-15 的缺陷形态。
 * @param sampleOverride 测试注入的容量样本（缺省=真采样 `sampleCapacity`）——与
 *   `req.cfg`/`req.spawn` 同一注入纪律：注入即信任，生产路径永不传。
 */
export async function capacityWakeDeferral(
  stateRoot: string,
  env: NodeJS.ProcessEnv,
  now: number,
  scope: WakeCooldownScope,
  sampleOverride?: CapacitySample,
): Promise<WakeDeferral | undefined> {
  // v0.9.3（B1）：容量三旋钮分层现读（file=config.json capacity 段 > env > 内置默认）。
  // 每次调用现读无缓存——改文件即热生效（G-6 同款契约）；畸形逐层披露进 warnings。
  const thresholds = resolveCapacityThresholds(stateRoot, env);
  // v0.9.3（B4）：生效值 ↔ 上次状态（capacity/config-state.json）比对，只在实际变化时
  // 落 `config-effective-changed{key,from,to,source}`——防刷屏的真源在状态文件里。
  for (const change of await diffCapacityConfigState(stateRoot, thresholds, now)) {
    await logEngineEvent(stateRoot, {
      event: "config-effective-changed",
      key: change.key,
      from: change.from,
      to: change.to,
      source: change.source,
    });
  }
  // v0.9.3（B1）：capacity 段逐键畸形的披露（闸被咨询即落；与 wake 层 config-malformed
  // 同款口径——顶层坏文件只在 attemptWake 步骤 0 披露，段内畸形只在本通道披露，不双通道）。
  if (thresholds.fileWarnings.length > 0) {
    await logEngineEvent(stateRoot, {
      event: "config-malformed",
      file: workspaceConfigFile(stateRoot),
      warning: thresholds.fileWarnings.join("；"),
      teamId: scope.teamId,
      to: scope.to,
      scene: "capacity-gate",
    });
  }
  if (!thresholds.wakeGate) return undefined; // 关闸（file 层 wake_gate=false ∨ env off）：回到「只警不拦」
  const cooldownInfo = wakeCapacityCooldownInfoFromEnv(env);
  const cooldownMs = cooldownInfo.cooldownMs;
  const file = wakeDeferralFile(stateRoot);
  const key = wakeCooldownKeyOf(scope);
  if (cooldownMs > 0) {
    const active = await readWakeDeferral(file, now, key);
    if (active !== undefined) {
      // v0.9.2（C3/V091-19）：窗内沿用旧判据。窗内**不重采样**（RED 期的重试风暴本身
      // 是放大器，这是冷却窗存在的理由），但 detail 必须明示「这是首次判定时刻的快照」
      // ——否则同一时刻五个容量观测面全绿、唤醒决策面却称 capacity-red 并引用至多 120s
      // 前的陈旧 freeBytes，跨面对账直接矛盾。
      const reuseLine = `cooldown-reuse: 冷却窗内沿用旧判据（键 ${key}；未重采样）——detail 与水位是 ${new Date(active.sampledAt).toISOString()}`
        + " 首次判定时刻的快照（按当时 env 阈值与水位判定），不是此刻读数；窗到期或转 GREEN 即重新判定";
      // v0.9.3（B3）：窗内沿用**不重复计数**——它是同一次 RED 判定的延续，不是新的
      // deferral（累积窗数的是「一次次被挡下的唤醒」，不是同一个挡门被敲了几次）。
      return { ...active, detail: [...active.detail, reuseLine] };
    }
  }
  let sample: CapacitySample;
  if (sampleOverride !== undefined) {
    sample = sampleOverride;
  } else {
    try {
      sample = await sampleCapacity(env, capacityCacheFile(stateRoot), now);
    } catch (err) {
      await logEngineEvent(stateRoot, {
        event: "wake-capacity-probe-failed",
        error: String(err),
        note: "容量闸 fail-open：采样异常不挡唤醒（pull 兜底不变）",
      });
      return undefined;
    }
  }
  // v0.9.3（B1）：判定吃分层生效值——detail 里的来源标签听分层的（file 层在场时写
  // config.json 而不是 env 名，不虚标「你配的是 env」）。
  const verdict = judgeCapacity(sample, env, thresholds);
  const estimate = thresholds.turnEstimateBytes;
  const estimateLabel = capacityThresholdLabel("turn_estimate_bytes", thresholds.sources.turn_estimate_bytes);
  const marginalExceeded = estimate > sample.freeBytes;
  if (!verdict.red && !marginalExceeded) {
    // v0.9.2（C2）：degraded 样本的放行路径也要披露（V091-14：此前「进程类规则未评」
    // 只在判红时随 wake-deferred 落盘，GREEN 时被整体丢弃 → 宿主 CIM 坏了而闸静默
    // 放行，运维零线索）。采样恢复即除名，下次降级重新披露（节流见 degradedDisclosedRoots）。
    if (sample.degraded !== null) await discloseCapacityDegraded(stateRoot, sample, verdict);
    else degradedDisclosedRoots.delete(resolve(stateRoot));
    // GREEN：清掉本键域的冷却条目，下次唤醒立即通行（不留残挡；别的键域不受影响）。
    await clearWakeCooldownEntry(file, now, key);
    // v0.9.3（B3）：恢复即重置累积窗（「恢复后重置」——下一段 RED 期从头计，不继承）。
    await resetWakeDeferralWindow(stateRoot);
    return undefined;
  }
  const detail = [...verdict.detail];
  if (marginalExceeded) {
    detail.push(
      `marginal-estimate: 单回合预估 ${formatBytesLabel(estimate)} > 可用 ${formatBytesLabel(sample.freeBytes)}`
        + `（${estimateLabel}；再起一个无头回合也放不下）`,
    );
  }
  // v0.9.2（C3）：冷却 env 的非法值/超上钳都不静默——写进 detail，随 deferral 块到
  // 回执、到 wake-deferred 事件、到 panel（运维可分辨「没配」与「配错了」）。
  if (cooldownInfo.fellBack === "clamped") {
    detail.push(
      `cooldown-clamped: XC_MEM_WAKE_COOLDOWN_MS=${cooldownInfo.raw} 超过上钳 ${WAKE_CAPACITY_COOLDOWN_MS_MAX}ms（1h），已按上钳生效`,
    );
  } else if (cooldownInfo.fellBack === "invalid") {
    detail.push(
      `cooldown-env: XC_MEM_WAKE_COOLDOWN_MS=${JSON.stringify(cooldownInfo.raw)} 非法（须为 >=0 的有限数），已回落内置缺省 ${WAKE_CAPACITY_COOLDOWN_MS_DEFAULT}ms`,
    );
  }
  const deferral: WakeDeferral = {
    reason: "capacity-red",
    detail,
    watermark: sample.watermark,
    freeBytes: sample.freeBytes,
    cooldownMs,
    retryAfterMs: cooldownMs,
    cooldownActive: false,
  };
  if (cooldownMs > 0) {
    const record: WakeDeferralRecord = {
      ...deferral,
      until: now + cooldownMs,
      sampledAt: now,
      scope,
      // v0.9.3（B2）：命中条件名随记录落盘（观测面「哪个条件命中」的直读来源）。
      violated: verdict.violated,
      marginalExceeded,
    };
    const store = await readWakeDeferralStore(file);
    store.entries[key] = record;
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(store, null, 2)}\n`).catch(() => undefined);
  }
  // v0.9.3（B3）：本次是**新鲜** deferral（cooldownActive=false；窗内沿用不计数）——
  // 进累积窗，达阈值且本窗未告警过 → urgent lead（每窗一次，节流态在状态文件里）。
  await recordWakeDeferral(stateRoot, env, now, key, deferral);
  return deferral;
}

/** 读冷却记录文件（version 2）；缺文件/损坏/旧平铺格式 → 空 store（重新判定，不误读）。 */
async function readWakeDeferralStore(file: string): Promise<WakeDeferralStore> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    if (parsed["version"] !== 2 || parsed["entries"] === null || typeof parsed["entries"] !== "object") {
      return { version: 2, entries: {} };
    }
    return { version: 2, entries: parsed["entries"] as Record<string, WakeDeferralRecord> };
  } catch {
    return { version: 2, entries: {} };
  }
}

/**
 * 清掉指定键域的冷却条目（v0.9.2 C3）：其余键域原样保留；顺手剔掉已过期条目（文件有界）；
 * 条目清空 → 删文件（不留空壳，也不留残挡）。
 */
async function clearWakeCooldownEntry(file: string, now: number, key: string): Promise<void> {
  const store = await readWakeDeferralStore(file);
  delete store.entries[key];
  const live = Object.entries(store.entries).filter(([, rec]) => Number(rec?.until) > now);
  if (live.length === 0) {
    await rmAsync(file, { force: true }).catch(() => undefined);
    return;
  }
  await writeFileAtomic(file, `${JSON.stringify({ version: 2, entries: Object.fromEntries(live) }, null, 2)}\n`)
    .catch(() => undefined);
}

// ─────────────────────────── 持续态告警状态与闸状态观测（v0.9.3 B2/B3） ───────────────────────────

/**
 * v0.9.3（B3）：持续态告警的**状态真源**（`<stateRoot>/capacity/wake-alert-state.json`）。
 *
 * 为什么必须有落盘状态：告警判据「窗口内累积 ≥N」「连续 false ≥T」都是跨唤醒的持续态，
 * 而 capacityWakeDeferral / attemptWake 活在**各个 MCP server 进程**里——内存里的
 * 「已告警过」标记随进程死亡消失，重启后同一次持续态会再告警一次（惊动 lead 的噪音）。
 * 与 watchdog-state.json 同族：capacity/ 目录内、原子整文件、损坏按「无历史」处理
 * （观测面永不因状态文件坏掉而停止工作）。
 *
 * 写纪律（与 wake-deferred.json 同族）：读-改-写**不加显式锁**——最坏是同机两把重叠
 * server 各发一条（last-writer-wins 丢一次计数/各判一次未告警），方向是「罕见重复」
 * 而非漏报；engine.jsonl 仍是权威记录。真需要「恰一次」硬口径的成员死亡告警走
 * watchdog-state 的显式锁（V092-01），本类是运营面提示，不沿用那把锁（避免每次唤醒
 * 判定都去排状态锁）。
 */
export interface WakeAlertState {
  version: 1;
  /** wake-deferred 累积窗（B3①：窗内计数 + 本窗告警时刻）。 */
  deferred: { count: number; windowStartedAt: number; alertedAt: number };
  /** wake 关闭持续态（B3②：生效值连续 false 的起始时刻 + 告警时刻）。 */
  wakeOff: { since: number; alertedAt: number };
}

/** 告警状态文件路径：`<stateRoot>/capacity/wake-alert-state.json`（与冷却记录同目录）。 */
export function wakeAlertStateFile(stateRoot: string): string {
  return join(dirname(capacityCacheFile(stateRoot)), "wake-alert-state.json");
}

/** 空状态（无文件/损坏/版本不匹配时）。 */
export function emptyWakeAlertState(): WakeAlertState {
  return { version: 1, deferred: { count: 0, windowStartedAt: 0, alertedAt: 0 }, wakeOff: { since: 0, alertedAt: 0 } };
}

/** 读告警状态（损坏/缺字段/版本不匹配 → 空状态）。永不抛。 */
export async function readWakeAlertState(stateRoot: string): Promise<WakeAlertState> {
  try {
    const parsed = JSON.parse(await readFile(wakeAlertStateFile(stateRoot), "utf8")) as Record<string, unknown>;
    if (parsed["version"] !== 1) return emptyWakeAlertState();
    const deferred = parsed["deferred"] as Record<string, unknown> | null | undefined;
    const wakeOff = parsed["wakeOff"] as Record<string, unknown> | null | undefined;
    return {
      version: 1,
      deferred: {
        count: num(deferred?.["count"], 0),
        windowStartedAt: num(deferred?.["windowStartedAt"], 0),
        alertedAt: num(deferred?.["alertedAt"], 0),
      },
      wakeOff: { since: num(wakeOff?.["since"], 0), alertedAt: num(wakeOff?.["alertedAt"], 0) },
    };
  } catch {
    return emptyWakeAlertState();
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 写告警状态（原子整文件；best-effort——失败不阻断唤醒判定与告警本身）。 */
export async function writeWakeAlertState(stateRoot: string, state: WakeAlertState): Promise<void> {
  try {
    await mkdir(dirname(wakeAlertStateFile(stateRoot)), { recursive: true });
    await writeFileAtomic(wakeAlertStateFile(stateRoot), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* best-effort 台账 */
  }
}

/**
 * 告警旋钮 env 解析（B3 三件套共用）：未设/空串 → 缺省；`0` = **显式关闭该告警**；
 * 非有限/负数/非整数 → 回落缺省（不静默关闸：把「配错了」当成「关了」会让告警无声消失，
 * 与 XC_WATCHDOG_MS 的 fellBack 口径同族）。
 */
function alertKnobFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return fallback;
  return n;
}

/** B3①累积告警阈值 env：`XC_DEFERRED_ALERT_N`（非负整数；0=关该告警，非法/未设 → 5）。 */
export const DEFERRED_ALERT_N_DEFAULT = 5;
export function deferredAlertNFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return alertKnobFromEnv(env, "XC_DEFERRED_ALERT_N", DEFERRED_ALERT_N_DEFAULT);
}

/** B3①累积窗 env：`XC_DEFERRED_ALERT_WINDOW_MS`（正整数 ms；0=关该告警，非法/未设 → 600000=10min）。 */
export const DEFERRED_ALERT_WINDOW_MS_DEFAULT = 600_000;
export function deferredAlertWindowMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return alertKnobFromEnv(env, "XC_DEFERRED_ALERT_WINDOW_MS", DEFERRED_ALERT_WINDOW_MS_DEFAULT);
}

/** B3②wake 关闭持续告警阈值 env：`XC_WAKE_OFF_ALERT_MS`（正整数 ms；0=关该告警，非法/未设 → 1800000=30min）。 */
export const WAKE_OFF_ALERT_MS_DEFAULT = 1_800_000;
export function wakeOffAlertMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return alertKnobFromEnv(env, "XC_WAKE_OFF_ALERT_MS", WAKE_OFF_ALERT_MS_DEFAULT);
}

/**
 * B3①：一次**新鲜** deferral 进累积窗；达阈值且本窗未告警过 → urgent lead（每窗一次）。
 *
 * 窗语义（tumbling，非滑动）：`now - windowStartedAt >= windowMs` 即换窗（计数归 1、
 * 告警态重置）；同一窗内计数只增。换窗后重新计数意味着持续 RED 会**每窗一条**告警
 * （方案原文「每窗一次」），RED 结束（GREEN 放行）则由 {@link resetWakeDeferralWindow}
 * 立即清窗（「恢复后重置」）。
 */
export async function recordWakeDeferral(
  stateRoot: string,
  env: NodeJS.ProcessEnv,
  now: number,
  key: string,
  deferral: WakeDeferral,
): Promise<void> {
  const threshold = deferredAlertNFromEnv(env);
  const windowMs = deferredAlertWindowMsFromEnv(env);
  if (threshold <= 0 || windowMs <= 0) return; // 告警关（0=显式关闭）
  const state = await readWakeAlertState(stateRoot);
  if (state.deferred.windowStartedAt <= 0 || now - state.deferred.windowStartedAt >= windowMs) {
    state.deferred = { count: 1, windowStartedAt: now, alertedAt: 0 };
  } else {
    state.deferred.count += 1;
  }
  const shouldAlert = state.deferred.count >= threshold && state.deferred.alertedAt < state.deferred.windowStartedAt;
  if (shouldAlert) state.deferred.alertedAt = now;
  await writeWakeAlertState(stateRoot, state);
  if (!shouldAlert) return;
  const count = state.deferred.count;
  await logEngineEvent(stateRoot, {
    event: "wake-deferred-alert",
    count,
    threshold,
    windowMs,
    windowStartedAt: state.deferred.windowStartedAt,
    scope: key,
    watermark: deferral.watermark,
    freeBytes: deferral.freeBytes,
    detail: deferral.detail,
    note: `容量闸持续阻塞：${Math.round(windowMs / 60000)}min 窗内已累积 ${count} 次 wake-deferred（阈值 ${threshold}）——消息均留邮箱（pull 兜底不丢），请处理内存压力或调 XC_MEM_WAKE_GATE/阈值`,
  });
  await notifyLeadUrgent(
    stateRoot,
    key.split("|")[0] ?? "default",
    `[zcode-crosschat 容量闸告警] ${Math.round(windowMs / 60000)}min 窗内已累积 ${count} 次 wake-deferred（阈值 ${threshold}，键 ${key}）：`
    + `${deferral.detail.slice(0, 3).join("；")}。消息不丢（均留邮箱，pull 兜底），但无人值守成员的自动开工被持续挡下——`
    + "请降低内存压力（结束多余无头回合/会话），或调整 XC_MEM_WARN_WATERMARK / XC_TURN_ESTIMATE_BYTES / "
    + "XC_MEM_WAKE_COOLDOWN_MS，确认要关闸用 XC_MEM_WAKE_GATE=off（或 config.json capacity.wake_gate=false，均不静默）。",
  );
}

/** B3①：GREEN 放行即清窗（恢复后重置——下一段 RED 期从头计）。无状态/已空 → 不写。 */
export async function resetWakeDeferralWindow(stateRoot: string): Promise<void> {
  const state = await readWakeAlertState(stateRoot);
  if (state.deferred.count === 0 && state.deferred.windowStartedAt === 0 && state.deferred.alertedAt === 0) return;
  state.deferred = { count: 0, windowStartedAt: 0, alertedAt: 0 };
  await writeWakeAlertState(stateRoot, state);
}

/**
 * B3②：wake 关闭持续态跟踪（attemptWake 步骤 0 的挡下面调用）。
 *
 * 判据（G-18「wake 关闭不能无声」）：生效值连续 false ≥ `XC_WAKE_OFF_ALERT_MS`
 * （缺省 30min）**且此刻有 pending 消息**（任一成员邮箱有未读）→ urgent lead 一次
 * （`wakeOff.alertedAt` 记账；生效值恢复 true 由 {@link resetWakeOffTracker} 清零）。
 * 没有 pending 不告警——关闭唤醒但无积压时没有说话的必要（防「关了开关还被催」）。
 */
export async function trackWakeOff(
  stateRoot: string,
  env: NodeJS.ProcessEnv,
  now: number,
  teamId: string,
  to: string,
  scene: string,
  gateSource: string,
): Promise<void> {
  const thresholdMs = wakeOffAlertMsFromEnv(env);
  if (thresholdMs <= 0) return; // 告警关（0=显式关闭）
  const state = await readWakeAlertState(stateRoot);
  let changed = false;
  if (state.wakeOff.since <= 0) {
    state.wakeOff = { since: now, alertedAt: 0 };
    changed = true;
  }
  const offForMs = now - state.wakeOff.since;
  if (offForMs >= thresholdMs && state.wakeOff.alertedAt < state.wakeOff.since) {
    const pending = await pendingMessageCount(stateRoot, teamId);
    if (pending > 0) {
      state.wakeOff.alertedAt = now;
      changed = true;
      await writeWakeAlertState(stateRoot, state);
      await logEngineEvent(stateRoot, {
        event: "wake-off-alert",
        offForMs,
        thresholdMs,
        pendingMessages: pending,
        wakeGateSource: gateSource,
        to,
        scene,
        note: `推送唤醒生效值已连续 false ${Math.round(offForMs / 60000)}min（阈值 ${Math.round(thresholdMs / 60000)}min）且当前有 ${pending} 条待投递消息——无人值守成员不会自动开工，消息只在邮箱等 pull`,
      });
      await notifyLeadUrgent(
        stateRoot,
        teamId,
        `[zcode-crosschat 唤醒开关告警] 推送唤醒生效值已连续关闭 ${Math.round(offForMs / 60000)}min（阈值 ${Math.round(thresholdMs / 60000)}min，来源 ${gateSource}），`
        + `当前有 ${pending} 条待投递消息堆在邮箱——无人值守成员不会自动开工。`
        + "如这是有意的（有人在看/暂不需要自动开工）可忽略；否则在工作区 .crosschat/config.json 写 "
        + '{"wake_enabled": true} 一行开启（引擎供给成员本就免开关，不受影响）。',
      );
      return;
    }
  }
  if (changed) await writeWakeAlertState(stateRoot, state);
}

/** B3②：生效值恢复 true 即清零（下一次持续关闭重新起算）。无状态/已空 → 不写。 */
export async function resetWakeOffTracker(stateRoot: string): Promise<void> {
  const state = await readWakeAlertState(stateRoot);
  if (state.wakeOff.since === 0 && state.wakeOff.alertedAt === 0) return;
  state.wakeOff = { since: 0, alertedAt: 0 };
  await writeWakeAlertState(stateRoot, state);
}

/**
 * 队内 pending 消息数（任一成员邮箱的未读件；B3②「有 pending」判据）。
 * 口径与 overview 的 countUnreadFor 一致（未读 ∧ 未作废 ∧ 现行信封）；读失败按 0
 * （保守：无从证明有积压就不催——抑制需要正向证据）。
 */
async function pendingMessageCount(stateRoot: string, teamId: string): Promise<number> {
  try {
    const team = await readTeam(stateRoot, teamId);
    if (team === undefined) return 0;
    let total = 0;
    for (const member of team.members) {
      const messages = await readMailbox(stateRoot, teamId, member.key);
      total += messages.filter((m) => !m.readAt && !m.discardedAt && isCurrentMail(team, m)).length;
    }
    return total;
  } catch {
    return 0;
  }
}

// ─────────────────────────── 闸状态观测读数（v0.9.3 B2；tools-overview 挂载面消费） ───────────────────────────

/** 一个活跃冷却键域的阻塞状态（观测面「阻塞原因」的逐域形态）。 */
export interface WakeCooldownStatus {
  /** 分域键（`<teamId>|<收方>|<urgent|normal>`）。 */
  scope: string;
  teamId: string;
  to: string;
  urgent: boolean;
  /** 命中条件名（judgeCapacity violated + marginal-estimate；旧记录只有 detail 时为空）。 */
  conditions: string[];
  /** 命中规则明细（首次判定时刻的快照）。 */
  detail: string[];
  watermark: number;
  freeBytes: number;
  /** 窗到期绝对时刻（下次重判时刻）。 */
  until: number;
  /** 还需等待多久（ms）。 */
  retryAfterMs: number;
  /** detail/水位的快照时刻。 */
  sampledAt: number;
}

/** 容量闸的观测面状态（B2：overview 三视图同源的单一读数）。 */
export interface WakeGateStatus {
  /** 容量闸生效开关（分层）。 */
  enabled: boolean;
  /** 是否有活跃冷却键域（= 唤醒正在被挡）。 */
  blocked: boolean;
  /** 全部活跃键域命中的条件名并集（哪个条件命中；GREEN = 空）。 */
  conditions: string[];
  /** 逐键域阻塞明细（GREEN = 空数组）。 */
  blockedScopes: WakeCooldownStatus[];
  /** 下次重判时刻（epoch ms；无活跃冷却 = null）。 */
  nextRetryAt: number | null;
  /** 本窗 wake-deferred 累积计数（B3① 的窗口计数器读数）。 */
  deferredWindowCount: number;
  /** 累积告警阈值（env 生效值）。 */
  deferredAlertThreshold: number;
  /** wake 关闭持续态起始时刻（生效值连续 false 的起点；未跟踪 = null）。 */
  wakeOffSince: number | null;
  /** wake 关闭持续告警阈值（env 生效值，ms）。 */
  wakeOffAlertMs: number;
  /** 分层生效阈值（水位/单回合预估）。 */
  thresholds: { warnWatermark: number; turnEstimateBytes: number };
  /** 三键分层来源（诊断：这次判定听谁的）。 */
  thresholdSources: Record<CapacityConfigKey, CapacityThresholds["sources"][CapacityConfigKey]>;
  /** 分层畸形/越界披露（file 键畸形 + env 非法；空 = 干净）。 */
  warnings: string[];
}

/**
 * 读全部**活跃**冷却键域（`until > now`；供观测面与测试）。
 * 与 capacityWakeDeferral 共用同一文件与 version 2 格式；损坏/缺文件 → 空数组。
 */
export async function readActiveWakeCooldowns(
  stateRoot: string,
  now: number = Date.now(),
): Promise<WakeCooldownStatus[]> {
  try {
    const store = await readWakeDeferralStore(wakeDeferralFile(stateRoot));
    const statuses: WakeCooldownStatus[] = [];
    for (const [key, record] of Object.entries(store.entries)) {
      const until = Number(record?.until);
      if (!Number.isFinite(until) || until <= now) continue; // 过期条目不算活跃
      const conditions = [
        ...((record.violated ?? []) as CapacityViolatedRule[]),
        ...(record.marginalExceeded === true ? (["marginal-estimate"] as const) : []),
      ];
      statuses.push({
        scope: key,
        teamId: record.scope?.teamId ?? "",
        to: record.scope?.to ?? "",
        urgent: record.scope?.urgent === true,
        conditions,
        detail: Array.isArray(record.detail) ? record.detail.filter((d): d is string => typeof d === "string") : [],
        watermark: Number(record.watermark) || 0,
        freeBytes: Number(record.freeBytes) || 0,
        until,
        retryAfterMs: Math.max(0, until - now),
        sampledAt: Number(record.sampledAt) || 0,
      });
    }
    return statuses.sort((a, b) => a.until - b.until);
  } catch {
    return [];
  }
}

/**
 * 闸状态单一读数（B2：team/status/panel 三视图同源）。
 *
 * 纯只读（不写任何状态——观测面不为难决策面）；任何单路读失败都降级为该路空值，
 * 不抛（观测面永不为难任务板，同 capacityMount 纪律）。
 */
export async function wakeGateStatus(
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<WakeGateStatus> {
  const thresholds = resolveCapacityThresholds(stateRoot, env);
  const blockedScopes = await readActiveWakeCooldowns(stateRoot, now);
  const alert = await readWakeAlertState(stateRoot);
  const conditions = [...new Set(blockedScopes.flatMap((s) => s.conditions))];
  const nextRetryAt = blockedScopes.length > 0 ? blockedScopes[0]!.until : null;
  return {
    enabled: thresholds.wakeGate,
    blocked: blockedScopes.length > 0,
    conditions,
    blockedScopes,
    nextRetryAt,
    deferredWindowCount: alert.deferred.count,
    deferredAlertThreshold: deferredAlertNFromEnv(env),
    wakeOffSince: alert.wakeOff.since > 0 ? alert.wakeOff.since : null,
    wakeOffAlertMs: wakeOffAlertMsFromEnv(env),
    thresholds: { warnWatermark: thresholds.warnWatermark, turnEstimateBytes: thresholds.turnEstimateBytes },
    thresholdSources: { ...thresholds.sources },
    warnings: [...thresholds.fileWarnings],
  };
}

// ─────────────────────────── 同步启动确认（v0.9.2 A1） ───────────────────────────

/**
 * v0.9.2（A1）：启动确认窗口缺省值（ms）——spawn 成功后等待 wake-child 启动证据的上限。
 *
 * 取值依据：helper（node 跳板）拉起 detached 唤醒子并写单行 stdout 报告，实测毫秒级；
 * 5000ms 覆盖宿主冷启动/杀软扫描下的慢形态（与 WAKE_HELPER_TIMEOUT_MS 同量级），又不把
 * 每次投递的同步成本放大到不可用（正常路径几十毫秒即结算）。
 */
export const START_CONFIRM_DEFAULT_MS = 5_000;

/** 启动确认轮询间隔（ms）——等待循环的步长（同时是 helper 存活检查的频率）。 */
export const START_CONFIRM_POLL_MS = 25;

/**
 * 启动确认窗口 env：`XC_START_CONFIRM_MS`（正整数 ms；0/负/非整数/不可解析 → 回落缺省，
 * 与 XC_LIMBO_TIMEOUT_MS / XC_WAKE_SLOW_MS 的 positiveIntFromEnv 同口径——监视类阈值
 * 不接受「关闭用 0」，关闭唤醒请用分层闸 XC_WAKE_ENABLED / config.json）。
 */
export function startConfirmMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(env, "XC_START_CONFIRM_MS", START_CONFIRM_DEFAULT_MS);
}

/** 一次启动确认的结算（两态 + 观测字段）。 */
export interface WakeStartConfirmOutcome {
  /** true = 窗内见到 wake-child 启动证据（helper 汇报的唤醒子 pid）。 */
  confirmed: boolean;
  /** 实际等待时长（ms；提前出口时远小于窗口）。 */
  waitedMs: number;
  /** 启动证据携带的唤醒子 pid（confirmed 时在场）。 */
  pid?: number;
}

/**
 * wake-child **启动证据闩**（A1 的同步面）。
 *
 * 证据定义（如实、可观测）：helper 经 `onHelperSpawned` 汇报「已 detached 拉起唤醒子并
 * 拿到 pid」——这是「spawn 已发起」（本进程拿到 helper pid）与「唤醒子真的起来了」之间
 * 唯一的机器可分辨界。没有更强的证据可用：孤儿化唤醒子的退出码/首行输出对本进程不可
 * 观测（V9 边界），而首行输出在宿主冷启动下可迟到 25s+，不能当启动判据。
 */
export interface WakeStartLatch {
  /** 已到的启动证据（未到 = undefined）。 */
  readonly evidence: { pid: number; at: number } | undefined;
  /** helper 汇报唤醒子 pid 时置位（resume-cli.ts onHelperSpawned 回调内调用）。 */
  signal(pid: number): void;
  /**
   * 有界等待启动证据。
   *
   * 提前出口（不白等满窗）：`helperAlive` 判定 helper 仍在跑时继续等；helper 已退出而
   * 仍未汇报 = 不可能再有证据，立即按未见结算（生产 helper 路径的失败面已由 onAsyncError
   * 走 releaseOnFailure，这里只负责「启动确认」这一个语义）。
   */
  confirm(thresholdMs: number, helperAlive?: () => boolean): Promise<WakeStartConfirmOutcome>;
}

/** 建一个启动证据闩（每次 spawn 一份）。 */
export function createWakeStartLatch(): WakeStartLatch {
  let evidence: { pid: number; at: number } | undefined;
  let wake: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    wake = resolve;
  });
  // 显式标注返回类型的读取函数：arrived 回调里的突变对 TS 的控制流分析不可见（闭包
  // 变量不会被 narrow），直接读 evidence 会被推成 never。
  const snapshot = (): { pid: number; at: number } | undefined => evidence;
  return {
    get evidence() {
      return evidence;
    },
    signal(pid: number) {
      if (evidence !== undefined) return; // 单发：只认第一份证据
      evidence = { pid, at: Date.now() };
      wake?.();
    },
    async confirm(thresholdMs: number, helperAlive?: () => boolean): Promise<WakeStartConfirmOutcome> {
      const startedAt = Date.now();
      const already = snapshot();
      if (already !== undefined) {
        return { confirmed: true, waitedMs: 0, pid: already.pid };
      }
      if (thresholdMs > 0) {
        const deadline = startedAt + thresholdMs;
        let helperGone = false;
        // 轮询等待：证据到达（arrived）∨ 窗满 ∨ helper 已退出（提前出口）三者先到先结算。
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const timeout = new Promise<"timeout">((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), Math.max(1, Math.min(START_CONFIRM_POLL_MS, remaining)));
            timer.unref?.();
          });
          const winner = await Promise.race([arrived.then(() => "evidence" as const), timeout]);
          if (winner === "evidence") break;
          if (helperAlive !== undefined && !helperAlive()) {
            helperGone = true;
            break;
          }
        }
        if (helperGone) {
          // helper「退出」与「stdout 报告落库」之间有毫秒级竞态（exit 事件要到下一轮事件
          // 循环才被处理，而 pid 已经死了）——退出后再等一个轮询步长，给已排队的报告一次
          // 落地机会，不把竞态误报成「未见启动证据」。
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, START_CONFIRM_POLL_MS);
            timer.unref?.();
          });
        }
      }
      const seen = snapshot();
      return seen !== undefined
        ? { confirmed: true, waitedMs: Date.now() - startedAt, pid: seen.pid }
        : { confirmed: false, waitedMs: Date.now() - startedAt };
    },
  };
}

/**
 * 启动确认落账（生命周期账 + engine.jsonl，双通道披露口径）。
 *
 * 生命周期账（logs/wake-lifecycle-<to>-<ts>.jsonl）记 `wake-child-start-confirmed` /
 * `wake-child-start-unconfirmed` 行——与 spawn 前的 `wake-child-start` 头行并排，运维
 * 一眼看出「发起了」与「起来了」的差别；engine.jsonl 记 `wake-start-confirm` 事件供
 * 时间线查询（A3 的事故计数不消费它，唤醒失败另有 wake-failed 事件）。
 */
async function recordWakeStartConfirm(
  stateRoot: string,
  lifecycleFile: string,
  input: {
    teamId: string;
    to: string;
    scene: string;
    sid: string;
    nonceToken: string;
    outcome: WakeStartConfirmOutcome;
    thresholdMs: number;
  },
): Promise<void> {
  const base = {
    nonce: wakeNonceDigest(input.nonceToken),
    sid: input.sid,
    to: input.to,
    scene: input.scene,
    teamId: input.teamId,
    waitedMs: input.outcome.waitedMs,
    thresholdMs: input.thresholdMs,
    ...(input.outcome.pid !== undefined ? { pid: input.outcome.pid } : {}),
  };
  appendWakeLifecycle(lifecycleFile, {
    event: input.outcome.confirmed ? "wake-child-start-confirmed" : "wake-child-start-unconfirmed",
    ...base,
  });
  await logEngineEvent(stateRoot, {
    event: "wake-start-confirm",
    ...base,
    startConfirmed: input.outcome.confirmed,
  });
}

/** A1 回执措辞（两态；都保留「非送达确认」与有界窗口的既有承诺短语）。 */
function startConfirmNote(outcome: WakeStartConfirmOutcome, thresholdMs: number): string {
  return outcome.confirmed
    ? `启动确认：已见到 wake-child 启动证据（pid ${outcome.pid}，${outcome.waitedMs}ms；仍非送达确认——消费与否由 consumedAt/readAt 说话）`
    : `启动确认：已发起但未见启动证据（${Math.round(thresholdMs / 1000)}s 内 helper 未汇报唤醒子 pid；非送达确认，也非失败——失败由 wake-failed 事件与邮箱 pull 兜底）`;
}

// ─────────────────────────── wake-child 生命周期 + limbo/wake-slow 信号（v0.9.1 G-12v3） ───────────────────────────

/**
 * v0.9.1（G-12v3 机制 B）：**投递盖章与消费确认分离** + 三类引擎信号。
 *
 * 实测事实（2026-11-19）：wake 路径 spawn 成功瞬间即盖
 * deliveredAt（fire-and-forget，dsh tools.js:2150 对应物），子进程在成员回合消费
 * 内容前死亡（内存红线 OOM / 宿主重启杀无头子进程）→ 消息**已盖章、从未被读、且
 * 不再是可投递态**，死会话永不 pull——生产 4 实例收方行为级零动作（邮箱文件级实锤），
 * 另有 8 条成员→master 回执同机制。主控对 limbo **无感知**（重踢是响应用户提醒，
 * 不是自发现）。
 *
 * 本版收口（方案 §二 组A）：
 * ① **生命周期日志**：spawn 即写 start 头行（nonce/sid/ts），观察到唤醒子进程消失
 *    即写 exit 尾行（时长；孤儿化唤醒子的退出码对本进程不可观测，如实 exitCode:null，
 *    失败语义由 evidence 快照承载）。**0 字节日志永不作失败判据**（G-12 修正 v2：
 *    慢写瞬态可 12min+ 后补写；只有「≥5min 且无 session-start」才判 slow/limbo）。
 * ② **limbo 降级**：deliveredAt 已盖而 consumedAt 超时（XC_LIMBO_TIMEOUT_MS，默认
 *    10min）未回写 → 团队锁内降级回 unread（清 deliveredAt/deliveryClaimedAt，
 *    重新可注入/可 pull/可重投）+ engine 事件 `message-limbo` + urgent 告知 lead。
 *    幂等：一个投递轮次恰降级一次（判据要求 deliveredAt 在场，降级恰好清掉它）；
 *    与消费回写的竞态走团队锁，锁内复判（消费先到则跳过）。
 * ③ **wake-slow**：spawn 后 XC_WAKE_SLOW_MS（默认 5min）目标 sid 无任何会话活动
 *    （session-start 会刷新会话记录）→ engine 事件 + urgent 告知 lead。
 * ④ **wake-failed**（v0.5.1 既有事件）补告警通道：releaseOnFailure 里 urgent 告知
 *    lead（此前只写 engine.jsonl，lead 不巡检不知情——BD865 延误 25min 的根因）。
 *
 * 边界（如实声明）：监视器是**引擎进程内的有界观测**（unref 定时器，不拖进程；
 * 总窗 = nonce TTL 15min）。引擎进程中途死亡时降级不再发生——与 v0.9.0 已知限制
 * 20（120s 窗外失败不可观测）同科；消息不丢（仍在邮箱，pull 兜底）。
 */

/** limbo 超时默认值（ms）：盖章后无消费确认即降级（可配 XC_LIMBO_TIMEOUT_MS）。 */
export const LIMBO_TIMEOUT_DEFAULT_MS = 10 * 60_000;
/** wake-slow 阈值默认值（ms）：spawn 后 5min 无 session-start 才判慢（可配 XC_WAKE_SLOW_MS）。 */
export const WAKE_SLOW_DEFAULT_MS = 5 * 60_000;
/**
 * v0.9.3（A3）：**假成功检测**阈值默认值（ms）——delivered/wake 盖章后 5min 目标 sid
 * 仍无任何回合投影（session-running/prompt-submit 的持久投影）即判「疑似假成功」。
 * 可配 `XC_FAKE_SUCCESS_MS`（正整数；0/负/非整数回落缺省，与 XC_WAKE_SLOW_MS 同口径）。
 *
 * 与 wake-slow 的关系（同源同判据，见 startWakeLifecycleWatch ②）：两者默认值相同、
 * 判据相同（盖章后无投影），本版合并为**一次告警**——触发时刻取两者较小值，事件按
 * 「哪个阈值先到期」落名（wake-slow 键集冻结不动，PROTOCOL §15.3），urgent 只发一条。
 */
export const FAKE_SUCCESS_DEFAULT_MS = 5 * 60_000;
/** 生命周期监视轮询间隔默认值（ms）。 */
export const WAKE_LIFECYCLE_POLL_MS = 5_000;
/**
 * v0.9.2（A4-a）：limbo 宽限窗默认值（ms）——目标 sid 自盖章后有会话活动时，缺失的
 * consumedAt 可能只是 hook 注入回写的锁竞争未落盘：宽限这么久再判「未消费」。
 * 不做 env 化（校准参数而非运维旋钮；测试经 WakeLifecycleWatchConfig.limboGraceMs 注入）。
 */
export const LIMBO_GRACE_DEFAULT_MS = 120_000;

/**
 * v0.9.1 打回第 1 轮（V091-01）：wake nonce 的**不可反查摘要**（落共享日志用）。
 *
 * 为什么需要：adv-1 TC-1 实测——nonce 真值明文落进同状态根的 engine.jsonl /
 * wake-lifecycle 日志，同工作区任一会话读日志即可收割，抢先 consumeWakeNonce
 * （置 used）把合法无头回合踢掉（"already used"），并冒名注册目标成员、
 * 继承 voiceOwner 越权盖章（TC-2）。日志面恰是最高频的外泄面（引擎日志被大量
 * 贴进报告/对话/证据）。
 *
 * 口径：nonce 真值只存在于唤醒 prompt（只达无头进程）与 registry/wake/<token>.json
 * 状态真源；一切共享日志（engine.jsonl / lifecycle 账）只记本摘要——sha256 前
 * 12 hex（48 bit，原像需 2^48 次 xc_identify 调用，且真源里本就有真值，摘要不增加
 * 任何可达路径）。同一次唤醒的各行摘要相同，运维对账能力不降级。
 * 键名保持 `nonce` 不变（PROTOCOL §15.3 冻结键集只对拍键名，值不比对）。
 */
export function wakeNonceDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** env 正整数读取（缺省/非法/非正 → fallback；0 与负值不合法——监视类阈值必须为正）。 */
function positiveIntFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** limbo 超时（ms）：env `XC_LIMBO_TIMEOUT_MS` > 内置默认 10min。 */
export function limboTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(env, "XC_LIMBO_TIMEOUT_MS", LIMBO_TIMEOUT_DEFAULT_MS);
}

/** wake-slow 阈值（ms）：env `XC_WAKE_SLOW_MS` > 内置默认 5min。 */
export function wakeSlowFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(env, "XC_WAKE_SLOW_MS", WAKE_SLOW_DEFAULT_MS);
}

/** v0.9.3（A3）：假成功检测阈值（ms）：env `XC_FAKE_SUCCESS_MS` > 内置默认 5min。 */
export function fakeSuccessMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(env, "XC_FAKE_SUCCESS_MS", FAKE_SUCCESS_DEFAULT_MS);
}

/**
 * 追加一行生命周期日志（O_APPEND 追加写；失败吞掉——观测面永不阻断主流程）。
 * 与唤醒子 stdout 日志分文件（core/paths.ts wakeLifecycleFile）：失败证据侦听
 * （findWakeFailureEvidence）只解析后者，两本账互不干扰。
 */
function appendWakeLifecycle(file: string, line: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...line })}\n`);
  } catch {
    /* 观测面尽力而为 */
  }
}

/**
 * v0.9.1（G-12v3）：引擎信号 **urgent 告知 lead**——复用既有邮箱（不新增工具）：
 * from="engine" 的 urgent 消息进 lead 收件箱（未读注入钩子与 urgent-first 读取面
 * 照常呈现），signal 事件本身已由调用方写 engine.jsonl（双通道披露口径）。
 * lead 解析不到（无队伍/roster 空）→ 静默跳过（engine.jsonl 仍是真源）。
 * 告知是尽力面：失败不阻断信号本身（调用方已留痕）。
 */
async function notifyLeadUrgent(stateRoot: string, teamId: string, text: string): Promise<void> {
  try {
    const team = await readTeam(stateRoot, teamId);
    if (team === undefined) return;
    const leadKey = leadKeyOf(team);
    if (leadKey === "") return;
    await appendMailbox(stateRoot, teamId, leadKey, createMessage("engine", leadKey, text, { urgent: true }));
  } catch {
    /* 告知尽力而为 */
  }
}

/**
 * 目标 sid 在 spawn 之后是否有过会话活动（session-start 的磁盘投影）：
 * SessionStart/UserPromptSubmit 钩子都会刷新会话记录（lastSeen/startedAt）——
 * 有刷新即「回合开跑过」，wake-slow 不判。取不到记录/读盘失败 → false（保守：无证据
 * 即视为无活动）。桌面原会话与无头回合**共享 sid** 时桌面的刷新同样算数——那种
 * 形态下消息会经未读注入钩子浮现，不应报慢（只在全静默时告警）。
 */
async function sessionStartedSince(stateRoot: string, sid: string, sinceTs: number): Promise<boolean> {
  try {
    const record = await readSession(stateRoot, sid);
    if (record === undefined) return false;
    return record.lastSeen >= sinceTs || record.startedAt >= sinceTs;
  } catch {
    return false;
  }
}

/** 生命周期监视配置（attemptWake 装配；测试可注轮询/阈值/pid 判定）。 */
export interface WakeLifecycleWatchConfig {
  stateRoot: string;
  teamId: string;
  to: string;
  nonce: string;
  sid: string;
  scene: string;
  /** 唤醒子 stdout/stderr 日志（exit 尾行的失败证据快照来源）。 */
  wakeLog: string;
  /** 生命周期日志文件（start 头行已由 attemptWake 在 spawn 前写下）。 */
  lifecycleFile: string;
  /** 投递盖章时刻（spawn 成功；limbo/wake-slow 两个计时都从它起算）。
   * v0.9.6（V095-15）：**重试轮传首轮 spawn 时刻**（继承原 attempt 时间线——重试的
   * markMailboxDelivered 因 mailbox first-wins 从不落邮箱行，锚 retryNow 等于锚一个
   * 邮箱里不存在的章，双窗口 2.7× 失真，41-v095 adv3-F2 实测）。 */
  stampedAt: number;
  /**
   * v0.9.4（A4）：**真正发起 spawn 的时刻**（attemptWake 在调 spawnResume 前取
   * `Date.now()`）。与 stampedAt 的差 = 本次唤醒的 spawn 前开销（分层闸/在途 nonce/
   * 状态门/容量闸/nonce 落盘/租约/prompt 组装）。wake-consumed 的两个计时窗口
   * （waitedFromSpawnMs / waitedFromDeliveredMs）分别以它为起点，两者之差即 spawn
   * 延迟——「spawn 已发起」与「已盖章」之间的耗时从此在指标面可见，不再混为一个数。
   * v0.9.6（V095-15）：重试轮同样锚**首轮 spawn 时刻**（双窗口都从用户感知的发起
   * 时刻起算，数值可解释）；重试轮自己的时间锚点单列 {@link retryStampedAt}。
   */
  spawnedAt: number;
  /**
   * v0.9.6（V095-15）：**重试轮自己的重盖章时刻**（markMailboxDelivered 的 retryNow，
   * 单列字段）——主轮 undefined。它在邮箱里没有对应的章（first-wins 保留原轮
   * deliveredAt），单列是为了「审计有据」而不冒充双窗口的锚。wake-consumed /
   * wake-discarded 事件在重试轮带 `retried:true` + 本字段，消费面可解释锚点。
   */
  retryStampedAt?: number;
  /**
   * v0.9.4（A2）：启动确认结算的读取器（attemptWake 在 startLatch.confirm 落账后置位）。
   * exit 尾行的「是否确认」字段据此如实记：true/false = 已结算；undefined = 监视器
   * 观察到退出时确认尚未落账 → 记 null（不猜、不伪造）。
   */
  getStartConfirmed?: () => boolean | undefined;
  /** 唤醒子 pid（helper 汇报后才拿得到；取不到 = 无法观察退出，其余信号不受影响）。 */
  getChildPid: () => number | undefined;
  /** 轮询间隔 / limbo 超时 / wake-slow 阈值 / 假成功阈值 / 总窗（ms）。 */
  pollMs: number;
  limboTimeoutMs: number;
  wakeSlowMs: number;
  /**
   * v0.9.3（A3）：假成功检测阈值（ms）——盖章后无回合投影即告警。缺省
   * {@link FAKE_SUCCESS_DEFAULT_MS}（attemptWake 经 env 解析后传入；测试注入小值）。
   * 与 {@link wakeSlowMs} 同源同判据，触发时刻取两者较小值（见 tick ②）。
   */
  fakeSuccessMs: number;
  windowMs: number;
  /**
   * v0.9.2（A4-a）：limbo 宽限窗（ms）——目标 sid 自盖章后有会话活动时，缺失的
   * consumedAt 可能是 hook 注入回写锁竞争未落盘：宽限这么久再判，不立即降级。
   * 缺省 {@link LIMBO_GRACE_DEFAULT_MS}（测试注入小值）。
   */
  limboGraceMs?: number;
  /**
   * v0.9.2（A4-b）：本次唤醒 prompt 是否**内嵌消息全文**（message/withdrawal 场景）
   * 与携带的消息 id——回合确已开跑时据此记 injectedConsumed，不因未调 xc_read 误判。
   */
  promptEmbedsBody?: boolean;
  receiptIds?: readonly string[];
  /** 测试注入：pid 存活判定（缺省 core/lock 的 pidAlive）。 */
  pidAliveProbe?: (pid: number) => boolean;
}

/**
 * v0.9.2（A4-b）：唤醒 prompt 是否内嵌消息全文（scene → 判据，纯函数）。
 *
 * `message`（xc_relay 自由消息：ticket = 消息正文）与 `withdrawal`（撤回通知：ticket =
 * 通知正文）两个场景的唤醒 prompt 把消息实体交到模型手上——成员回合开跑即「已消费」，
 * 不因它没另调 xc_read 而误判 limbo。其余场景（dispatch/post-provision/unblock/idle/
 * cancel/report/shutdown/stale-sweep/task-offline…）的 ticket 是指令/摘要/任务票，
 * 不构成消息全文，判据保持原样（必须 xc_read / hook 注入回写才算消费）。
 */
export function wakePromptEmbedsMessageBody(scene: string): boolean {
  return scene === "message" || scene === "withdrawal";
}

/**
 * v0.9.4（A6）：从本批回执消息解析**唯一**的 taskId（best-effort；直读邮箱 JSONL，
 * 不走读取面审计——与生命周期监视的轮询读同口径）。
 *
 * 为什么需要它：派单消息的 taskId 只在邮箱消息的 extras 里（任务票正文按 DESIGN
 * 刻意不含 taskId，保重复派发幂等判据稳定），而「唤醒一次到位」要求成员**不调
 * xc_read** 就能 xc_claim——taskId 必须由唤醒 prompt 的结构段带上。attemptWake 在
 * 组装 prompt 前读一次邮箱，把回执 id 映射到 taskId：
 * - 恰一个不同的 taskId → 返回它（派单唤醒的常态）；
 * - 零个 / 多个不同 taskId（批量回执混单、非任务消息）→ undefined：行动行回落
 *   「按正文/邮箱处理」，**不猜**哪一个（混单时猜错=领错单）。
 * 读失败 → undefined（观测/提示面永不因盘读失败抛）。
 */
async function resolveReceiptTaskId(
  stateRoot: string,
  teamId: string,
  toKey: string,
  receiptIds: readonly string[],
): Promise<string | undefined> {
  if (receiptIds.length === 0) return undefined;
  try {
    const rows = await readJsonl<TeamMessage>(
      inboxFile(stateRoot, teamId, sanitizeKey(toKey)),
      isTeamMessage,
      () => undefined, // 轮询读不审计坏行（审计归读取面）
    );
    const wanted = new Set(receiptIds);
    const taskIds = new Set<string>();
    for (const message of rows) {
      if (!wanted.has(message.id)) continue;
      if (typeof message.taskId === 'string' && message.taskId.trim() !== '') taskIds.add(message.taskId);
    }
    if (taskIds.size !== 1) return undefined; // 0 = 非任务消息；>1 = 混单不猜
    return [...taskIds][0];
  } catch {
    return undefined;
  }
}

/**
 * v0.9.5（A5/V094-08）：生命周期监视的**控制句柄**——调用方（attemptWake）需要
 * 「重试轮接管后压制原轮监视器」的能力：sessionNotFound 自动重试成功 spawn 后，
 * 原轮投递已被判失败并被重试轮接管（同一批 receiptIds），原轮若继续跑 ③ 会把
 * consumed 记到失败 attempt 的 nonce（V094-08 的 2/2/1 错账），②④ 会对已被重试
 * 覆盖的投递发假告警。markSuperseded 只关 ②③④（告警/计数/limbo），保留 ①
 * exit 尾行——原唤醒子的退出证据仍归原轮账本（审计不悬空）。
 */
export interface WakeLifecycleWatchHandle {
  /** 停止监视（定时器清除；幂等）。 */
  stop(): void;
  /** 标记本轮投递已被重试轮接管：只保留 ① exit 尾行，②③④ 不再触发。 */
  markSuperseded(): void;
}

/**
 * 启动 wake-child 生命周期监视（unref 定时器；引擎进程活着才有效，见边界声明）。
 * 四类信号各自只发一次（进程内flag）：exit 尾行（+ v0.9.3 A2 致死原因回读）/
 * 假成功告警（wake-slow 与 delivery-unconfirmed 合并为一条）/ 第三级指标 wake-consumed /
 * limbo 降级+告知。消费确认到齐（本批消息全部 consumedAt/readAt/discardedAt）即收工。
 * v0.9.5（A5）：返回控制句柄（旧调用面忽略返回值仍成立——void 兼容）。
 */
export function startWakeLifecycleWatch(cfg: WakeLifecycleWatchConfig): WakeLifecycleWatchHandle {
  if (cfg.pollMs <= 0 || cfg.windowMs <= 0) return { stop(): void {}, markSuperseded(): void {} };
  const isAlive = cfg.pidAliveProbe ?? pidAlive;
  // v0.9.3（A3）：假成功告警的合并闸（wake-slow 与 delivery-unconfirmed 共用——
  // 两者同源同判据，一次盖章只允许一条 urgent，见 tick ②）。
  const unconfirmedMs = Math.min(cfg.wakeSlowMs, cfg.fakeSuccessMs);
  let projectionAlarmSent = false;
  let consumedSignaled = false;
  let limboHandled = false;
  let exitRecorded = false;
  let ticking = false;
  let stopped = false;
  // v0.9.5（A5）：重试轮接管标记（true = 只保留 ① exit 尾行）。
  let superseded = false;

  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(stopTimer);
  };

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return; // 上一轮未结束（锁竞争等）→ 跳过本轮，不叠加
    ticking = true;
    try {
      const now = Date.now();
      const pid = cfg.getChildPid();

      // ① exit 尾行：观察到唤醒子进程消失即写（时长 + 失败证据快照）。
      //    v0.9.3（A2）：同一快照做**致死原因回读**——含 provider 限流关键词即披露
      //    `wake-degraded{reason:"provider-rate-limit"}` + urgent 告知 lead（与失败侦听面
      //    共用 nonce 摘要去重，同一次死亡只披露一次）。
      if (!exitRecorded && pid !== undefined && !isAlive(pid)) {
        exitRecorded = true;
        let logText = "";
        try {
          logText = readFileSync(cfg.wakeLog, "utf8");
        } catch {
          /* 日志尚未出现/不可读：无快照 */
        }
        const evidence = logText === "" ? undefined : findWakeFailureEvidence(logText);
        if (logText !== "") {
          const rateLimit = findProviderRateLimitEvidence(logText);
          if (rateLimit !== undefined) {
            await discloseProviderRateLimit(cfg.stateRoot, {
              nonceToken: cfg.nonce,
              teamId: cfg.teamId,
              to: cfg.to,
              sid: cfg.sid,
              scene: cfg.scene,
              evidence: rateLimit,
              where: "wake-child-exit",
            });
          }
        }
        // v0.9.4（A2）：exit 尾行补「是否确认」——启动确认（XC_START_CONFIRM_MS 窗内
        // 是否见到 helper 汇报的唤醒子 pid）的结算值。监视器观察到退出时确认可能尚未
        // 落账（提前退出竞态）→ undefined → 如实记 null（不猜、不伪造）。
        const startConfirmed = cfg.getStartConfirmed?.() ?? null;
        appendWakeLifecycle(cfg.lifecycleFile, {
          event: "wake-child-exit",
          pid,
          durationMs: now - cfg.stampedAt,
          exitCode: null, // 孤儿化唤醒子（V9）的退出码对引擎进程不可观测——如实记 null
          startConfirmed,
          ...(evidence !== undefined ? { evidence } : {}),
        });
      }

      // ② v0.9.3（A3）假成功检测 + 既有 wake-slow：**同源同判据，合并为一次告警**。
      //
      // 判据（方案 §一 A3）：delivered/wake 盖章后 T 分钟目标 sid 无任何回合投影
      // （session-running/prompt-submit 的持久投影 = registry 会话记录刷新，见
      // sessionStartedSince）→ `delivery-unconfirmed` 事件 + urgent lead，恰一条。
      // 与 wake-slow 的关系：两者默认值相同（5min）、判据相同（盖章后无投影）——若各发
      // 一条 urgent，「恰一条告警」的验收判据直接违背。故本版合并：
      // - 触发时刻 = min(wakeSlowMs, fakeSuccessMs)（哪个阈值先到期哪个命名事件）；
      // - `wake-slow` 事件（键集冻结，PROTOCOL §15.3，契约测试逐键对拍）**不删**，
      //   仅当慢档阈值先到期（或同刻）时落，字段逐字不变；
      // - `delivery-unconfirmed`（v0.9.3 新事件）仅当假成功档先到期（或同刻）时落；
      // - urgent **只发一条**（文案同时点名两个事件，互斥不叠加）。
      //
      // 三检测器互斥（方案 §一 A1/A2/A3）：
      // - vs A1：A1 判据要求 `deliveredAt` 缺席（从未盖章），本判据在盖章之后的监视器里
      //   （stampedAt 即盖章时刻）——同一条消息不可能同时命中；
      // - vs A2：已披露 provider 限流致死（根因已知）⇒ 不再发通用假成功告警（
      //   rateLimitDisclosedNonces 查询，两个检测面共用同一集合）。
      if (!projectionAlarmSent && !superseded && now - cfg.stampedAt >= unconfirmedMs) {
        if (!(await sessionStartedSince(cfg.stateRoot, cfg.sid, cfg.stampedAt))) {
          const rateLimited = rateLimitDisclosedNonces.has(wakeNonceDigest(cfg.nonce));
          if (!rateLimited) {
            projectionAlarmSent = true;
            const waitedMin = Math.round((now - cfg.stampedAt) / 60000);
            if (cfg.wakeSlowMs <= cfg.fakeSuccessMs) {
              await logEngineEvent(cfg.stateRoot, {
                event: "wake-slow",
                scene: cfg.scene,
                teamId: cfg.teamId,
                to: cfg.to,
                nonce: wakeNonceDigest(cfg.nonce),
                sid: cfg.sid,
                pid: pid ?? null,
                waitedMs: now - cfg.stampedAt,
                thresholdMs: cfg.wakeSlowMs,
              });
            }
            if (cfg.fakeSuccessMs <= cfg.wakeSlowMs) {
              await logEngineEvent(cfg.stateRoot, {
                event: "delivery-unconfirmed",
                reason: "fake-success-suspected",
                scene: cfg.scene,
                teamId: cfg.teamId,
                to: cfg.to,
                nonce: wakeNonceDigest(cfg.nonce),
                sid: cfg.sid,
                pid: pid ?? null,
                waitedMs: now - cfg.stampedAt,
                thresholdMs: cfg.fakeSuccessMs,
                note: "delivered/wake 已盖章而目标 sid 零回合投影（session-running/prompt-submit 皆无）——疑似假成功",
              });
            }
            await notifyLeadUrgent(
              cfg.stateRoot,
              cfg.teamId,
              `[zcode-crosschat 引擎信号] wake-slow / delivery-unconfirmed：唤醒 "${cfg.to}" 已 ${waitedMin} 分钟无 session-start`
              + `（spawn 成功但回合未开跑；场景 ${cfg.scene}）——delivered 已盖投递章而目标 sid 零事件投影，疑似假成功。`
              + `消息已盖投递章仍在邮箱（pull 兜底不丢）。`
              + `若成员会话已死，请重发或由 lead 用 xc_team({action:"member-add"}) 幂等重供给。`
              + `（0 字节日志不作失败判据；只有 ≥5min 无 session-start 才判慢。）`,
            );
          }
        }
      }

      // ③ v0.9.3（A2）第三级指标：本批消息全部有消费确认（consumedAt/readAt/discardedAt）
      //    → `wake-consumed` 汇总事件 + 收工（不空转——这正是函数头注释承诺的
      //    「消费确认到齐即收工」，此前只有 limbo 分支间接实现，本版显式化）。
      //    轮询读直读邮箱 JSONL（不走 readMailbox 读取面：不重复审计坏行/帧拒绝）。
      // v0.9.5（A5）：superseded = 本轮已被重试轮接管——consumed 归属重试轮监视器
      //（cfg.nonce 是重试 nonce），原轮不再对同一批消息记第二笔 wake-consumed。
      if (!consumedSignaled && !superseded && cfg.receiptIds !== undefined && cfg.receiptIds.length > 0) {
        try {
          const rows = await readJsonl<TeamMessage>(
            inboxFile(cfg.stateRoot, cfg.teamId, sanitizeKey(cfg.to)),
            isTeamMessage,
            () => undefined, // 轮询读不审计坏行（审计归读取面）
          );
          const byId = new Map(rows.map((m) => [m.id, m]));
          // v0.9.6（V095-16/adv3-F3）：**settled 只认 consumedAt/readAt**——结构性丢弃
          // （frame-rejected 的 discardedAt）不再计为 consumed（旧实现三字段同判：
          // 收方审计 consumed=0 与漏斗 consumed=1 当面矛盾）。discardedAt 单列
          // `discarded` 桶：批次全体落定但含丢弃 → `wake-discarded` 事件（带两桶明细），
          // 漏斗第三级保持「真消费」口径可分。
          const consumedIds = cfg.receiptIds.filter((id) => {
            const message = byId.get(id);
            return message !== undefined
              && (message.consumedAt !== undefined || message.readAt !== undefined);
          });
          const discardedOnlyIds = cfg.receiptIds.filter((id) => {
            const message = byId.get(id);
            return message !== undefined
              && message.consumedAt === undefined
              && message.readAt === undefined
              && message.discardedAt !== undefined;
          });
          const allSettled =
            consumedIds.length + discardedOnlyIds.length === cfg.receiptIds.length;
          if (allSettled && discardedOnlyIds.length > 0) {
            // 全部落定但含丢弃件：wake-discarded 单列（不进 consumed 漏斗），收工。
            const waitedFromSpawnMs = Math.max(0, now - cfg.spawnedAt);
            const waitedFromDeliveredMs = Math.max(0, now - cfg.stampedAt);
            const consumedPart = consumedIds.length > 0 ? consumedIds : undefined;
            await logEngineEvent(cfg.stateRoot, {
              event: "wake-discarded",
              scene: cfg.scene,
              teamId: cfg.teamId,
              to: cfg.to,
              nonce: wakeNonceDigest(cfg.nonce),
              sid: cfg.sid,
              receiptIds: [...cfg.receiptIds],
              consumedIds,
              discardedIds: discardedOnlyIds,
              ...(consumedPart !== undefined ? { consumedPart } : {}),
              waitedFromSpawnMs,
              waitedFromDeliveredMs,
              note: "本批回执消息含结构性丢弃（frame-rejected 等 discardedAt 落定）——不计入 consumed 漏斗（V095-16）；丢弃原因见收方 frame-rejected 审计",
            });
            appendWakeLifecycle(cfg.lifecycleFile, {
              event: "wake-discarded",
              messageIds: [...cfg.receiptIds],
              consumedIds,
              discardedIds: discardedOnlyIds,
              sid: cfg.sid,
              scene: cfg.scene,
            });
            stop(); // 批次全部落定（消费/丢弃）：本轮投递的生命周期职责已尽
            return;
          }
          if (allSettled && consumedIds.length === cfg.receiptIds.length) {
            consumedSignaled = true;
            // v0.9.4（A4）：双计时窗口——waitedFromSpawnMs 从 spawn 时刻起算（唤醒
            // 「发起」到「消费」的真实时延，含 spawn 前开销之外的等待），
            // waitedFromDeliveredMs 从投递盖章时刻起算（旧 waitedMs 的口径）。
            // 两者之差 = spawnedAt − stampedAt = spawn 前开销（闸门/nonce/租约/prompt）。
            // waitedMs 保留旧字段名（方案「保留旧字段名兼容」），取值与
            // waitedFromSpawnMs 一致（方案「waitedMs 从 spawn 起算」）。
            // v0.9.6（V095-15）：重试轮的 stampedAt/spawnedAt 锚**首轮 spawn 时刻**
            //（继承原 attempt 时间线），重试轮自己的重盖章时刻单列 retryStampedAt。
            const waitedFromSpawnMs = Math.max(0, now - cfg.spawnedAt);
            const waitedFromDeliveredMs = Math.max(0, now - cfg.stampedAt);
            await logEngineEvent(cfg.stateRoot, {
              event: WAKE_TIER_EVENT_CONSUMED,
              scene: cfg.scene,
              teamId: cfg.teamId,
              to: cfg.to,
              nonce: wakeNonceDigest(cfg.nonce),
              sid: cfg.sid,
              receiptIds: [...cfg.receiptIds],
              waitedFromSpawnMs,
              waitedFromDeliveredMs,
              waitedMs: waitedFromSpawnMs,
              ...(cfg.retryStampedAt !== undefined ? { retried: true, retryStampedAt: cfg.retryStampedAt } : {}),
            });
            appendWakeLifecycle(cfg.lifecycleFile, {
              event: "wake-consumed",
              messageIds: [...cfg.receiptIds],
              sid: cfg.sid,
              scene: cfg.scene,
              waitedFromSpawnMs,
              waitedFromDeliveredMs,
              waitedMs: waitedFromSpawnMs,
              ...(cfg.retryStampedAt !== undefined ? { retried: true, retryStampedAt: cfg.retryStampedAt } : {}),
            });
            stop(); // 消费确认到齐：本轮投递的生命周期职责已尽
          }
        } catch {
          /* 邮箱读失败：下轮再看（不视为已消费） */
        }
      }

      // ④ limbo：盖章超时无消费确认 → 团队锁内降级 + 事件 + urgent lead（一个轮次恰一次）。
      // v0.9.2（A4）判据校准三处：(a) 活性交叉校验 + 宽限（锁竞争回写未落盘不立即判）；
      // (b) prompt 内嵌全文且回合已开跑 → 记 injectedConsumed；(c) 告警按
      // (messageId, 轮次) 节流、同轮多条合并。
      if (!limboHandled && !superseded && now - cfg.stampedAt >= cfg.limboTimeoutMs) {
        // 目标 sid 自盖章后是否有会话活动（hook 注入/lastSeen 投影）——(a)(b) 两个判据
        // 的共用输入，一次读取两用。
        const targetActive = await sessionStartedSince(cfg.stateRoot, cfg.sid, cfg.stampedAt);
        const graceMs = cfg.limboGraceMs ?? LIMBO_GRACE_DEFAULT_MS;
        const embedsBody = cfg.promptEmbedsBody ?? wakePromptEmbedsMessageBody(cfg.scene);

        // (b) injectedConsumed（**先于**宽限判）：wake prompt 已把消息全文交到模型手上
        // （message/withdrawal 场景），且回合确已开跑（上面的 targetActive）⇒ 成员已
        // 「消费」，这是**正向证据**，不需要等宽限。锁内回写 consumedAt（幂等）；锁忙则
        // 留给下轮（下面的宽限会接住，不会误降级）。
        if (embedsBody && targetActive) {
          const ids = [...(cfg.receiptIds ?? [])];
          if (ids.length > 0) {
            try {
              await withTeamLock(cfg.stateRoot, cfg.teamId, async () => {
                await markMailboxConsumed(cfg.stateRoot, cfg.teamId, cfg.to, ids, now);
              });
              appendWakeLifecycle(cfg.lifecycleFile, {
                event: "injected-consumed",
                messageIds: ids,
                sid: cfg.sid,
                scene: cfg.scene,
                note: "wake prompt 内嵌消息全文且回合已开跑 → consumedAt 回写（不因未调 xc_read 误判 limbo）",
              });
            } catch {
              /* 锁忙/IO：下轮再写（宽限期内不会误降级） */
            }
          }
          limboHandled = true; // 本 stamp 已按 injectedConsumed 处理，无 limbo 可判
          return;
        }

        // (a) 宽限重试：会话活着且被知会过 ⇒ 缺失的 consumedAt 可能只是 hook 的注入
        // 回写没抢到团队锁（HOOK_LOCK_WAIT_MS 2s 预算）尚未落盘。宽限窗内不判未消费
        // （回写落地即自然不降级）；宽限过后仍无消费确认才继续走判据。
        if (targetActive && now - cfg.stampedAt < cfg.limboTimeoutMs + graceMs) {
          return;
        }

        // 锁外预读：候选消息 + 每条**本次盖章**的 deliveredAt = (messageId, 轮次) 节流键
        // （A4-c；判据与 sweep 共用 core/mailbox.ts 的纯函数，避免两处漂移）。
        const stamps = new Map<string, number | undefined>();
        try {
          const team = await readTeam(cfg.stateRoot, cfg.teamId);
          if (team !== undefined) {
            const all = await readMailbox(cfg.stateRoot, cfg.teamId, cfg.to);
            for (const candidate of limboCandidateMessages(all, team, now, cfg.limboTimeoutMs)) {
              stamps.set(candidate.id, candidate.deliveredAt);
            }
          }
        } catch {
          /* 预读失败：无节流键（按「无从证明已告警」处理，见 watchdog-state 注释） */
        }

        let downgraded: TeamMessage[] = [];
        let examined = false;
        try {
          await withTeamLock(cfg.stateRoot, cfg.teamId, async () => {
            const team = await readTeam(cfg.stateRoot, cfg.teamId);
            if (team === undefined) return;
            downgraded = await sweepLimboDeliveriesLocked(
              cfg.stateRoot, team, cfg.to, now, cfg.limboTimeoutMs,
            );
            examined = true;
          });
        } catch {
          examined = false; // 锁忙/IO：下一轮再试（不视为已处理）
        }
        if (examined) {
          limboHandled = true;
          const watchdogState = await readWatchdogState(cfg.stateRoot);
          // (c) 节流：同一 (messageId, 轮次) 只告警一次（per-spawn 监视器与看门狗清扫
          // 两个面、或两把锁的竞态，都不得对同一次失效重复惊动 lead）。
          const fresh = downgraded.filter(
            (message) => !limboAlertAlreadySent(watchdogState, message.id, stamps.get(message.id)),
          );
          for (const message of fresh) {
            markLimboAlertSent(watchdogState, message.id, stamps.get(message.id), now);
          }
          await writeWatchdogState(cfg.stateRoot, watchdogState);
          for (const message of downgraded) {
            await logEngineEvent(cfg.stateRoot, {
              event: "message-limbo",
              teamId: cfg.teamId,
              to: cfg.to,
              from: message.from,
              messageId: message.id,
              ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
              nonce: wakeNonceDigest(cfg.nonce),
              sid: cfg.sid,
              scene: cfg.scene,
              stampedAt: cfg.stampedAt,
              downgradedAt: now,
              waitedMs: now - cfg.stampedAt,
              timeoutMs: cfg.limboTimeoutMs,
            });
          }
          if (fresh.length > 0) {
            appendWakeLifecycle(cfg.lifecycleFile, {
              event: "limbo-downgrade",
              messageIds: fresh.map((m) => m.id),
              waitedMs: now - cfg.stampedAt,
            });
            const waitedMin = Math.round((now - cfg.stampedAt) / 60000);
            await notifyLeadUrgent(
              cfg.stateRoot,
              cfg.teamId,
              `[zcode-crosschat 引擎信号] limbo：${fresh.length} 条消息盖投递章后 ${waitedMin} 分钟无消费确认，`
              + `已自动降级回 unread（重新可注入/可 pull）。目标 "${cfg.to}"（sid ${cfg.sid}）的唤醒回合`
              + `疑似在消费前死亡（内存红线 OOM / 宿主重启杀无头子进程）。消息 id：`
              + `${fresh.map((m) => m.id).join(", ")}。可重发，或让成员 xc_read({scope:"inbox"}) 兜底。`,
            );
          }
          // 收工：本轮次已处理（有降级=已告知 lead；无降级=都已消费/无 limbo）。
          // 之后新盖章的消息由各自唤醒轮次的监视器负责（判据自销，不会重复降级）。
          stop();
        }
      }
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, cfg.pollMs);
  timer.unref?.();
  const stopTimer = setTimeout(stop, cfg.windowMs);
  stopTimer.unref?.();
  // v0.9.5（A5）：控制句柄（stop 幂等；markSuperseded 只关 ②③④、保留 ① exit 尾行）。
  return { stop, markSuperseded(): void { superseded = true; } };
}

// ─────────────────────────── attemptWake（fire-and-forget 编排） ───────────────────────────

/** M3 工具面 → M2 引擎的唤醒请求（tools.ts 头部 ASSUMED M1/M2 CONTRACT 的落地形状）。 */
export interface WakeRequest {
  /** 状态根 <workspace>/.crosschat（M3 以 resolveStateRoot(cwd) 解析后传入）。 */
  stateRoot: string;
  teamId: string;
  /** 目标 agentKey（M3 已 sanitize；此处再防御性归一）。 */
  toAgentKey: string;
  /** 目标 sessionId（--resume 与身份行；M3 已确保成员在册）。 */
  toSessionId: string;
  /** 会话工作区（--cwd 传给无头 CLI）。 */
  workspace: string;
  /** 唤醒场景标签（v0.2 取值对齐 WAKE_SCENES：dispatch/report/message/unblock/idle/
   *  cancel/post-provision/shutdown/stale-sweep；进 engine.jsonl scene 字段；
   *  守则附加按 WAKE_RULES_SCENES 白名单判定）。 */
  reason: string;
  /** 要投递的消息 id（调用方锁内 append 的那条；回执 ids）。 */
  receiptIds: readonly string[];
  /** 正文文本（任务票/回执摘要/消息内容）；≤4000 截断在 M2。 */
  ticket: string;
  /**
   * v0.6（C1）：urgent 唤醒（xc_relay urgent/interrupt 写入侧）——true 时唤醒
   * prompt 正文首位插 URGENT 横幅（buildWakePrompt）+ 审计行带 urgent 标记。
   * 不改变三态决策（decideDelivery 三重条件对 urgent 不豁免，E1：忙→下一回合）。
   */
  urgent?: boolean;
  /** 进程 env；v0.9 起开关判定=分层闸（core/config.ts：config.json file > 本 env 层
   *  XC_WAKE_ENABLED > 内置默认；引擎供给成员免开关）——判定全在 M2（V7 语义保留于 env 层）。 */
  env: NodeJS.ProcessEnv;
  /**
   * 属主缺席断言（§2.5-2；语义见 DeliveryDecisionInput.ownerAbsent）。
   * M3 的 v1 契约不传（undefined=按约束放行）；保留字段供未来接入属主检测。
   */
  ownerAbsent?: boolean;
  now?: number;
  /** 测试注入：spawn 实现。 */
  spawn?: typeof spawnResume;
  /** 测试注入：spawn 配置（默认 resolveZcodeSpawnConfig(req.env)，v0.4 起 env 缺失时自动探测）。 */
  cfg?: WakeSpawnConfig;
  /**
   * v0.5.1（FI-7）：失败侦听窗口（ms）；缺省 WAKE_WATCH_WINDOW_MS（20s）。
   * 窗口内轮询 wake 日志，命中失败证据 → wake-failed{where:"wake-child"} +
   * 释放投递租约 + 消费 nonce；窗口静默 → 不表态。
   */
  watchWindowMs?: number;
  /** v0.5.1（FI-7）：失败侦听轮询间隔（ms）；缺省 WAKE_WATCH_POLL_MS（500ms）。 */
  watchPollMs?: number;
  /**
   * v0.9.1（G-12v3）：limbo 超时（ms）；缺省 env XC_LIMBO_TIMEOUT_MS 或内置默认
   * 10min。盖章后无消费确认即自动降级回 unread。测试注入用小值。
   */
  limboTimeoutMs?: number;
  /** v0.9.1（G-12v3）：wake-slow 阈值（ms）；缺省 env XC_WAKE_SLOW_MS 或 5min。测试注入。 */
  wakeSlowMs?: number;
  /** v0.9.1（G-12v3）：生命周期监视轮询间隔（ms）；缺省 WAKE_LIFECYCLE_POLL_MS。测试注入。 */
  lifecyclePollMs?: number;
  /** v0.9.1（G-12v3）：生命周期监视总窗（ms）；缺省 WAKE_INFLIGHT_MS（nonce TTL）。测试注入。 */
  lifecycleWindowMs?: number;
  /** v0.9.1（G-12v3）：pid 存活判定注入（测试用；缺省 core/lock 的 pidAlive）。 */
  pidAliveProbe?: (pid: number) => boolean;
  /**
   * v0.9.1（G-12-b）测试注入：容量样本（缺省=真采样 `sampleCapacity`）——与
   * `req.cfg`/`req.spawn` 同一注入纪律：注入即信任，生产路径永不传。
   */
  capacitySample?: CapacitySample;
  /**
   * v0.9.2（A1）：启动确认窗口（ms）；缺省 env `XC_START_CONFIRM_MS` 或内置默认 5000。
   * 测试注入小值（或不注入而依赖 helper 存活提前出口）。
   */
  startConfirmMs?: number;
  /** v0.9.2（A4-a）：limbo 宽限窗（ms）；缺省 LIMBO_GRACE_DEFAULT_MS。测试注入小值。 */
  limboGraceMs?: number;
  /**
   * v0.9.3（A3）：假成功检测阈值（ms）；缺省 env `XC_FAKE_SUCCESS_MS` 或内置默认 5min。
   * 盖章后目标 sid 无任何回合投影即告警（与 wake-slow 合并为一次告警，见
   * startWakeLifecycleWatch ②）。测试注入小值。
   */
  fakeSuccessMs?: number;
}

export interface WakeResult {
  delivered: "wake" | "mailbox";
  /** 决策原因/降级说明（M3 透传为 note）。 */
  note?: string;
  /** 唤醒 stdout/stderr 落盘文件（logs/wake-<to>-<ts>.json）。 */
  wakeLog?: string;
  pid?: number;
  /** 实际参与投递的消息 id（=入参 receiptIds）。 */
  receiptIds?: string[];
  /** v0.9.1（G-12-b）：唤醒结果可携带容量闸 deferral 块（不 spawn 的原因与冷却窗）。 */
  wakeDeferred?: WakeDeferral;
  /** 本次写下的 wake nonce 令牌（wake 态才有）。 */
  nonce?: string;
  /**
   * v0.9.2（A1）：**启动确认**（wake 态才有；两态）——spawn 成功后是否在
   * XC_START_CONFIRM_MS 内观察到 wake-child 启动证据（helper 汇报的唤醒子 pid）。
   * `false` = 「已发起但未见启动证据」：不是送达确认、也不是失败（失败语义由
   * wake-failed 事件与邮箱 pull 兜底，见 note）。
   */
  startConfirmed?: boolean;
  /**
   * v0.9.6（V095-14/adv3-F1）：**失败第三态**——回执时刻对 wake 日志的有界回读已见
   * 失败证据（sessionNotFound 等正向失败形态，findWakeFailureEvidence 同判据）时置 true。
   * 异步失败（回执之后才落盘）不在本键覆盖内：仍由 engine.jsonl wake-failed 事件、
   * urgent 告知与邮箱 pull 兜底（fire-and-forget 边界如实声明，不假装能预知未来）。
   */
  wakeFailureSeen?: boolean;
  /** v0.9.6（V095-14）：失败证据原文快照（≤300 字符；与 wakeFailureSeen 成对出现）。 */
  failureEvidence?: string;
  /**
   * v0.9.3（A2）：唤醒**三级指标**的回执面快照（wake 态才有）——`spawn-ok` /
   * `child-alive` / `consumed` 三级拆分（方案 §一 A2「回执与 overview 改用三级」）。
   * `consumed` 在回执时刻**恒为 pending**：消费确认是异步的（consumedAt/readAt 回写），
   * 由 engine 事件 `wake-consumed` 与邮箱真源说话——回执不假装知道未来。
   */
  wakeTiers?: { spawnOk: "ok"; childAlive: "ok" | "no"; consumed: "pending" };
}

/** 短暂重取 team 锁做邮箱补盖章（dsh tools.js:2150 形态）；失败不阻断主流程。 */
async function withLockBestEffort<T>(stateRoot: string, teamId: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withTeamLock(stateRoot, teamId, fn);
  } catch {
    return undefined; // busy（15s 等待超时）或 IO 失败：补盖章是尽力而为
  }
}

/**
 * v0.9（G-4 分层前置）：读目标成员记录（一次读盘，分层与状态门控共用）。
 * 团队不存在/成员不在册/读盘失败 → undefined（按交互式语义走分层开关；门控是
 * 增量保护，不是新的失败面，与 v0.1.0 行为一致）。
 */
async function readWakeTargetMember(stateRoot: string, teamId: string, agentKey: string): Promise<TeamMember | undefined> {
  try {
    const team = await readTeam(stateRoot, teamId);
    if (team === undefined) return undefined;
    return team.members.find((m) => m.key === agentKey);
  } catch {
    return undefined; // team.json 损坏等：门控尽力而为，唤醒路径不受阻
  }
}

/**
 * v0.9.4（A3）：**邮箱降级回执的如实后缀**——wake-skipped（分层闸/在途 nonce/成员状态/
 * spawn 配置）、容量闸 deferral、spawn 失败等一切「没有真正发起唤醒」的路径，回执 note
 * 都必须带这一句：消息只是落了邮箱，既没有唤醒、更不存在送达/消费。
 *
 * 为什么单独立一个函数：这些路径旧文案只给原因行（如 `wake-disabled: …`），调用方与
 * 运维容易把 `delivered:"mailbox"` 混读成「已投递」；A3 要求 wake-skipped 场景的
 * 回执/通知**禁止**出现「已送达/已消费」，改为显式的「仅落邮箱（未唤醒）」。wake
 * 成功路径（delivered:"wake"）的回执仍写「已发起」且明示非送达确认（attemptWake
 * 成功回执既有措辞）——「送达」只在唤醒成功后才可写。
 */
export function mailboxOnlyNote(reason: string): string {
  return `${reason}——仅落邮箱（未唤醒）：消息未送达也未消费，收方下回合或 xc_read({scope:"inbox"}) pull 兜底`;
}

/**
 * 推送唤醒编排（DESIGN §2.5；**必须在团队锁外调用**——慢操作 spawn 不持锁，§2.7-4；
 * 本函数内部对邮箱的补盖章会各自短暂重取锁，调用方持锁时调用会死锁）：
 *
 * 0. v0.9（G-4/G-6）目标成员读取（一次读盘）+ 分层唤醒闸（core/config.ts）：
 *    引擎供给成员（identity=engine）免开关恒可唤醒；其余目标 file（config.json，
 *    每次投递现读=改文件即热生效）> env（XC_WAKE_ENABLED）> 内置默认 false；
 *    畸形 config.json 回落次层并披露 WARNING（事件与 note 双通道）。
 * 1. 属主缺席约束（§2.5-2，见 DeliveryDecisionInput.ownerAbsent）；
 * 2. 在途 nonce 去重（M1 registry 扫 registry/wake/，TTL=15min，§2.5-3）；
 * 2.5 v0.2 成员状态门控（§6.3/§7.3.3）：目标 state ∈ {provisioning, failed, removed}
 *     → 只入箱不唤醒（nonce 落盘之前判定，跳过路径不留 15min 在途标记）；
 * 3. 写一次性 nonce（M1 createWakeNonce，兼在途标记）→ 盖投递租约（M1 claim，60s，尽力而为）；
 * 4. buildWakePrompt（守则附加按 WAKE_RULES_SCENES 白名单）→ spawnResume（helper 孤儿化，
 *    W1；stdout/stderr→logs/wake-<to>-<ts>.json）；
 * 5. spawn 成功 → markDelivered（dsh tools.js:2150 对应物）+ engine.jsonl {event:"wake", pid}；
 *    helper 汇报唤醒子 pid → engine.jsonl {event:"wake-child", pid}（§4.2 审计）；
 *    spawn 同步失败 → release 租约（state.js:489-496 对应物）+ engine.jsonl wake-failed，
 *    降级 mailbox——消息留邮箱，pull 兜底，租约到期后可重试（§2.5 mailbox 行）；
 *    v0.9（G-8）：spawn 成功后的失败侦听命中 sessionNotFound 证据 → 自动重绑重试
 *    恰一次（事件 wake-retry/wake-retry-failed 留痕，见 retryOnceAfterSessionNotFound）。
 *
 * 不看唤醒的返回值判定成败（DESIGN §2.5）；异步 spawn 错误经 resume-cli 的 onAsyncError
 * 补记 engine.jsonl 并尽力释放租约，不影响已返回的决策。
 * duplicate 态不在本函数产生——M3 在锁内自判（§2.8 dispatch 行为）。
 */
export async function attemptWake(req: WakeRequest): Promise<WakeResult> {
  const now = req.now ?? Date.now();
  const toKey = sanitizeKey(req.toAgentKey);
  const stateRoot = req.stateRoot;
  const rawFlag = req.env["XC_WAKE_ENABLED"];

  // 0. v0.9（G-4/G-6）分层唤醒闸。目标成员一次读盘（分层与 2.5 状态门控共用）；
  //    config.json 由 resolveWakeGate 现读（无缓存）——改文件即热生效（G-6 核心）。
  //    注：旧版「不碰磁盘先判」的优化随分层取消——file 层与成员身份都在盘上，
  //    这是 G-6「配置跟工作区走」决策的固有代价（小文件、投递频率级读取）。
  const target = await readWakeTargetMember(stateRoot, req.teamId, toKey);
  const gate = resolveWakeGate(stateRoot, req.env, target);
  if (gate.warning !== undefined) {
    // 畸形 config.json：回落次层（WARNING 披露对齐 env 卫生口径；不阻断本次判定）。
    await logEngineEvent(stateRoot, {
      event: "config-malformed", file: workspaceConfigFile(stateRoot), warning: gate.warning,
      teamId: req.teamId, to: toKey, scene: req.reason,
    });
  }
  const pre = decideDelivery({ wakeGate: gate, ownerAbsent: req.ownerAbsent, inflight: false });
  if (pre.mode !== "wake") {
    // v0.9.3（B3②）：wake 关闭持续态跟踪——**仅**当挡下原因是生效值 false（G-18：
    // 「wake 关闭不能无声」）；owner-present/inflight 等挡下与开关无关，不记持续态。
    // 达 XC_WAKE_OFF_ALERT_MS（缺省 30min）且有 pending 消息 → urgent lead 一次。
    if (gate.enabled === false) {
      await trackWakeOff(stateRoot, req.env, now, req.teamId, toKey, req.reason, gate.source);
    }
    await logEngineEvent(stateRoot, {
      event: "wake-skipped", reason: pre.reason, scene: req.reason, teamId: req.teamId, to: toKey,
      rawWakeEnabled: rawFlag ?? null, wakeGateSource: gate.source,
      // v0.9.1 r3（V090-05）：engine 标行被交互式持有者接管——免开关不适用，
      // 事件带标，运营面可诊断「引擎成员突然不自动开工」。
      ...(gate.takenOver === true ? { takenOver: true } : {}),
      ...(gate.warning !== undefined ? { configWarning: gate.warning } : {}),
    });
    // v0.9.4（A3）：降级回执如实写「仅落邮箱（未唤醒）」——禁出现已送达/已消费。
    return { delivered: "mailbox", note: mailboxOnlyNote(pre.reason) };
  }
  // v0.9.3（B3②）：生效值恢复 true——清掉关闭持续态（下一次持续关闭重新起算）。
  // 位置在预判通过处：此刻 gate.enabled 恒 true（engine-member 免开关同算恢复）。
  await resetWakeOffTracker(stateRoot);

  // 2. v0.9.6（R1③，含 V095-23）：**成员状态门控先于在途 nonce 去重**——闸序倒置时
  // （旧实现 inflight 闸在前），孤儿票在途的 failed/removed 成员会被误标
  // `inflight-nonce`（跳过原因/回执 note 双面失实，V095-23），调用方无从知道真正该做
  // 的是重供给/改派。成员状态门控（DESIGN-V0.2 §6.3 双向门控 + §7.3.3「E-a/E-b/E-c
  // 唤醒路径检查 state」）：provisioning/failed/removed 的成员只入箱、不唤醒——
  // provisioning 期间 resume 会与 app-server 持有并发（V5 未验证区）；removed 成员不再
  // 被唤醒。位置在 createWakeNonce **之前**：跳过路径不落 nonce，避免 15min 在途标记
  // 挡住供给完成后的 E-e 投产唤醒。团队不存在/成员不在册 → 与 v0.1.0 行为一致（放行）；
  // W2 的 state 可选字段以 §6.5 宽容语义读取（缺省 "ready"=放行，旧数据零行为变化）。
  // v0.9：成员记录复用步骤 0 的一次读盘（memberState 访问器=旧内联读取同语义）。
  const gateState = target !== undefined
    && (memberState(target) === "provisioning" || memberState(target) === "failed" || memberState(target) === "removed")
    ? memberState(target)
    : undefined;
  if (gateState !== undefined) {
    // v0.9.6（R1③）：逐态原因 + 行动指引——failed/removed 给出明确的下一步（重供给/
    // 改派），不再只有一句「只入箱不唤醒」（R1 验收：failed 成员的 dispatch 给出明确
    // 原因/改派指引）。
    const guidance = gateState === "provisioning"
      ? "目标成员供给中（resume 会与 app-server 持有并发，V5 未验证区），只入箱不唤醒；供给完成后投产唤醒（E-e）自动补投"
      : gateState === "failed"
        ? "目标成员供给失败（state=failed），只入箱不唤醒——修复供给根因后用 xc_team({action:\"member-add\"}) 同名幂等重供给，或把任务改派/自领"
        : "目标成员已移除（state=removed），不再唤醒——请把任务改派其他成员，或重新 xc_team({action:\"member-add\"}) 建员后重发";
    const reason = `member-state:${gateState}: ${guidance}（DESIGN-V0.2 §6.3/§7.3.3）`;
    await logEngineEvent(stateRoot, {
      event: "wake-skipped", reason, scene: req.reason, teamId: req.teamId, to: toKey, memberState: gateState,
    });
    // v0.9.4（A3）：降级回执如实写「仅落邮箱（未唤醒）」——禁出现已送达/已消费。
    return { delivered: "mailbox", note: mailboxOnlyNote(reason) };
  }

  // 2.5 在途 nonce 去重（§2.5-3）。v0.9.6（R1①）：改用**活体证据**过滤版——只有
  // 「lifecycle 账有本票据的 start 证据且子进程未见退出，或票据在短宽限窗内签发」的
  // 新鲜票据才算在途；供给失败留票等孤儿票（无 spawn 证据）不再压制派单。正常在途票
  // （spawn 了、子进程活着）照旧去重——R1 修复不牺牲现有去重语义（方案 §二-5）。
  const inflight = await findLiveInflightWakeNonce(stateRoot, toKey, { teamId: req.teamId, now });
  if (inflight !== undefined) {
    const d = decideDelivery({ wakeGate: gate, ownerAbsent: req.ownerAbsent, inflight: true });
    await logEngineEvent(stateRoot, {
      event: "wake-skipped", reason: d.reason, scene: req.reason, teamId: req.teamId, to: toKey,
      // v0.9.1 打回第 1 轮（V091-01）：在途令牌只落不可反查摘要——真值仅存于
      // registry/wake/ 真源与唤醒 prompt，共享日志不给人可消费的令牌。
      inflightNonce: wakeNonceDigest(inflight.token),
    });
    // v0.9.4（A3）：降级回执如实写「仅落邮箱（未唤醒）」——禁出现已送达/已消费。
    return { delivered: "mailbox", note: mailboxOnlyNote(d.reason) };
  }

  // 3.7 v0.5.3（A5 修复）：显式 spawn 配置无效（XC_ZCODE_EXE/XC_ZCODE_CJS 配置了但路径
  //     不存在/不可执行等）→ 唤醒通道必然不可用：不写 nonce/租约、**不回落自动探测**
  //     （回落仅在未配置时），直接 mailbox 降级并把配置错误根因写进 note（回执可观测，
  //     不再「静默换探测路径 + 回执只字不提」）。req.cfg 测试注入时跳过本闸（注入即信任）。
  if (req.cfg === undefined) {
    const cfgError = explicitSpawnConfigError(req.env);
    if (cfgError !== undefined) {
      const reason = `spawn-config-invalid: ${cfgError}`;
      await logEngineEvent(stateRoot, {
        event: "wake-skipped", reason, scene: req.reason, teamId: req.teamId, to: toKey,
      });
      // v0.9.4（A3）：降级回执如实写「仅落邮箱（未唤醒）」——禁出现已送达/已消费。
      return { delivered: "mailbox", note: mailboxOnlyNote(reason) };
    }
  }

  // 3.8 v0.9.1（G-12-b）spawn 前容量闸：读 capacity verdict，水位低于硬底或边际预估
  //     超过 freeBytes → **不 spawn**（不写 nonce、不盖租约——跳过路径不留 15min 在途
  //     标记，与 2.5 状态门同纪律），直接 deliver=mailbox + wake-deferred{reason:
  //     "capacity-red"} + 冷却重试（XC_MEM_WAKE_COOLDOWN_MS）。位置在最后一道 spawn
  //     前置闸之后、createWakeNonce 之前：前面的门（分层闸/在途/状态/spawn 配置）都不
  //     触发时才值得采样（采样有 60s 缓存窗，成本是一次文件读 + os.freemem()）。
  //     消息已在邮箱（调用方锁内已 append），pull 兜底不丢——闸只挡唤醒不拦投递。
  const capacityDeferral = await capacityWakeDeferral(
    stateRoot,
    req.env,
    now,
    // v0.9.2（C3）：冷却键域 = teamId + 收方 + 紧急度——一个成员的 RED 不再静默挡全队。
    { teamId: req.teamId, to: toKey, urgent: req.urgent === true },
    req.capacitySample,
  );
  if (capacityDeferral !== undefined) {
    const reason = `capacity-red: 内存容量预警（${capacityDeferral.detail.join("；")}）——不 spawn 无头回合，消息留邮箱（pull 兜底），${Math.round(capacityDeferral.retryAfterMs / 1000)}s 后重新判定`;
    await logEngineEvent(stateRoot, {
      event: "wake-deferred",
      reason: "capacity-red",
      scene: req.reason,
      teamId: req.teamId,
      to: toKey,
      watermark: capacityDeferral.watermark,
      freeBytes: capacityDeferral.freeBytes,
      detail: capacityDeferral.detail,
      cooldownMs: capacityDeferral.cooldownMs,
      retryAfterMs: capacityDeferral.retryAfterMs,
      cooldownActive: capacityDeferral.cooldownActive,
      wakeGateEnabled: wakeCapacityGateEnabledFromEnv(req.env),
      // v0.9.2（C5/V091-18）：兑现 wakeCapacityGateEnabledFromEnv 注释里的承诺——
      // 带 XC_MEM_WAKE_GATE **原值**（未设=null）。布尔值分不清「我没配」与「我配错了」，
      // 原值可以；与 cooldown detail 的 clamp/invalid 披露同族两级口径。
      gateEnv: wakeCapacityGateEnvRaw(req.env),
      urgent: req.urgent === true,
    });
    return {
      delivered: "mailbox",
      // v0.9.4（A3）：降级回执如实写「仅落邮箱（未唤醒）」——禁出现已送达/已消费。
      note: mailboxOnlyNote(reason)
        + `（容量闸 v0.9.1 G-12-b；冷却 ${Math.round(capacityDeferral.cooldownMs / 1000)}s，env XC_MEM_WAKE_COOLDOWN_MS 可调，XC_MEM_WAKE_GATE=off 可关闸）`,
      wakeDeferred: capacityDeferral,
    };
  }

  // 4. 写一次性 nonce（兼在途标记）+ 盖投递租约（尽力而为）。
  // v0.9.1（G-11）：nonce 显式记录 voiceOwner=原会话（= 目标 sid）——无头 --resume
  // 回合与桌面原会话共享 sid，xc_identify 消费本 nonce 时把 voiceOwner 转记到连接
  // 身份，uservoice 盖章面据此承认「本连接是该 sid 的唤醒续跑」（不再因 sid 被
  // elsewhere 活进程持有而拒章；对外部会话的拒绝线不放松，见 core/uservoice.ts）。
  // v0.9.5（A6/V094-05）：签发点补 `issuedToSid`/`name`——票据目标 sid 与队内花名
  // 落进票据本体，钩子面/MCP 面的「非目标 sid 拒」判据才有真值可判（旧实现两字段
  // 恒缺，规格宣称不实且 V094-04 的两面判据分裂不可观测）。
  const { token } = await createWakeNonce(stateRoot, {
    teamId: req.teamId, agentKey: toKey, sid: req.toSessionId, now,
    voiceOwner: req.toSessionId,
    issuedToSid: req.toSessionId,
    name: toKey,
  });
  const ids = [...req.receiptIds];
  await withLockBestEffort(stateRoot, req.teamId, () =>
    claimMailboxDelivery(stateRoot, req.teamId, toKey, ids, now));

  // 5. prompt + spawn（fire-and-forget）。守则附加按场景白名单（v0.2 §9.1 白名单兼容）。
  // v0.6（C1）：urgent 唤醒（xc_relay）→ 正文首位 URGENT 横幅。
  // v0.9.4（A6）：本批回执消息的 taskId（单一才给）→ prompt 行动行「直接 xc_claim」。
  // v0.9.5（A1）：身份行/守则规则 1 按 ppid 采纳档分流（XC_ADOPT_BY_PPID=1 才写
  // 「已自动绑定」；默认档写 wakeToken 自证路径）。
  const adoptByPpid = adoptByPpidEnabledFromEnv(req.env);
  const receiptTaskId = await resolveReceiptTaskId(stateRoot, req.teamId, toKey, ids);
  const prompt = buildWakePrompt({
    teamId: req.teamId,
    recipientKey: toKey,
    recipientSessionId: req.toSessionId,
    wakeToken: token,
    receiptIds: ids,
    bodyText: req.ticket,
    includeMemberRules: includeRulesForScene(req.reason),
    scene: req.reason,
    adoptByPpidEnabled: adoptByPpid,
    ...(receiptTaskId !== undefined ? { taskId: receiptTaskId } : {}),
    ...(req.urgent === true ? { urgent: true } : {}),
  });
  const logFile = wakeLogFile(stateRoot, toKey, now);
  // v0.9.1（G-12v3）：wake-child 生命周期日志文件（start 头行/exit 尾行/limbo 行）。
  const lifecycleFile = wakeLifecycleFile(stateRoot, toKey, now);
  /**
   * 失败善后（释放投递租约 + 消费 nonce + 审计）。v0.9（G-8）参数化：原始尝试与
   * sessionNotFound 重试共用一份释放逻辑，事件名与恢复动作由调用方给定——
   * 原始尝试 event=wake-failed；重试失败 event=wake-retry-failed（附 recovery）。
   * v0.9.1（G-12v3）增量：① **同步** spawn 失败（where 以 "spawn" 结尾）= 唤醒子
   * 从未被拉起，生命周期账补一条 exit 尾行（spawnError），start 头行不悬空；
   * ② wake-failed/wake-retry-failed **urgent 告知 lead**（此前只写 engine.jsonl，
   * lead 不巡检不知情——BD865 延误 25min 的根因即「不巡检」而非「无记录」）。
   */
  const releaseOnFailure = async (
    where: string,
    err: unknown,
    lease: { nonce: string; sid: string; ids: readonly string[]; now: number } = { nonce: token, sid: req.toSessionId, ids, now },
    event = "wake-failed",
    recovery?: string,
    // v0.9.3（A2）：同一次死亡不叠加告警——已由 wake-degraded（provider 限流）披露过
    // 根因时，跳过本函数的 urgent（事件与租约释放照旧，只并一条告警）。
    // 语义注意：本参数是**抑制**开关（true = 不发 urgent），缺省 false = 照常告知。
    suppressLeadUrgent = false,
  ): Promise<void> => {
    await withLockBestEffort(stateRoot, req.teamId, () =>
      releaseMailboxDelivery(stateRoot, req.teamId, toKey, [...lease.ids]));
    // 同步/异步 spawn 失败=没有真正的唤醒在途：立即消费 nonce，别让 15min 在途标记
    // 挡住租约（60s）承诺的重试资格（§2.5 mailbox 行"投递租约到期后可重试"）。
    try {
      await consumeWakeNonce(stateRoot, lease.nonce, { teamId: req.teamId, agentKey: toKey, sid: lease.sid }, lease.now);
    } catch {
      /* 尽力而为 */
    }
    await logEngineEvent(stateRoot, {
      event, where, error: String(err), scene: req.reason, teamId: req.teamId,
      // v0.9.1 打回第 1 轮（V091-01）：失败事件只记 nonce 摘要，真值不进共享日志。
      to: toKey, nonce: wakeNonceDigest(lease.nonce),
      ...(recovery !== undefined ? { recovery } : {}),
    });
    // 同步 spawn 失败：子进程从未存在——生命周期账补 exit 尾行（start 头行已写）。
    // v0.9.4（A2）：「是否确认」= false（子进程从未被拉起，启动确认无从成立——如实记
    // false，不与「确认未结算」的 null 混写）。
    if (where === "spawn" || where === "retry-spawn") {
      appendWakeLifecycle(lifecycleFile, {
        event: "wake-child-exit",
        pid: null,
        durationMs: 0,
        exitCode: null,
        startConfirmed: false,
        spawnError: String(err),
      });
    }
    if (suppressLeadUrgent) return; // 已由 wake-degraded 披露根因（A2 互斥：一次死亡一条告警）
    // v0.9.1（G-12v3）：wake-failed 告警通道——urgent 告知 lead（邮箱复用，不新增工具）。
    await notifyLeadUrgent(
      stateRoot,
      req.teamId,
      `[zcode-crosschat 引擎信号] ${event}：唤醒 "${toKey}" 失败（${where}）：${String(err).slice(0, 300)}`
      + `（场景 ${req.reason}）。消息仍在邮箱（pull 兜底不丢，租约到期可重试）`
      + `——可重发，或让成员 xc_read({scope:"inbox"}) 直接消费。`,
    );
  };
  // v0.9.1（G-12v3）：spawn 即写 start 头行（nonce 摘要/sid/ts）——在任何 spawn 尝试
  // 之前，使「文件存在但没有任何行」的旧观测形态不再可能出现（0 字节日志依旧不是失败
  // 判据，现在连 0 字节都不会有：至少有头行）。
  // v0.9.1 打回第 1 轮（V091-01）：头行只记 nonce 摘要——真值仅存于唤醒 prompt 与
  // registry/wake/ 真源；同状态根读者拿不到可消费的令牌（adv-1 TC-1 实锤的收割面）。
  appendWakeLifecycle(lifecycleFile, {
    event: "wake-child-start",
    nonce: wakeNonceDigest(token),
    sid: req.toSessionId,
    to: toKey,
    scene: req.reason,
    teamId: req.teamId,
  });
  // 唤醒子 pid（helper 汇报后才拿得到）——生命周期监视的退出观察经此 ref 读取。
  const childPidRef: { pid: number | undefined } = { pid: undefined };
  // v0.9.4（A2）：启动确认结算值（下方 startLatch.confirm 落账后置位）——生命周期
  // 监视的 exit 尾行经 getStartConfirmed 读它；未置位 = 确认尚未结算（记 null）。
  const startConfirmedRef: { value: boolean | undefined } = { value: undefined };
  // v0.9.2（A1）：启动证据闩——helper 汇报的唤醒子 pid 即「wake-child 起来了」的
  // 机器可分辨证据（spawn 返回的 pid 只是 helper 的 pid，只证明「已发起」）。
  const startLatch = createWakeStartLatch();
  let pid: number | undefined;
  // v0.9.4（A4）：spawn 时刻——try 内赋真值（调 spawnResume 前）；spawn 同步失败时
  // 保持 stampedAt（该轮没有发起，两个窗口同起点，差值 0，不虚构 spawn 开销）。
  let spawnedAt = now;
  // v0.4（DESIGN-V0.4 §2.4）：spawn 配置解析改为「env → 自动探测」，结果落审计。
  // req.cfg 测试注入优先级不变：注入时零探测（不触发任何子进程），审计行 source 记 test_injected。
  const resolvedCfg = req.cfg ?? resolveZcodeSpawnConfig(req.env);
  await logEngineEvent(stateRoot, {
    event: "zcode-locate",
    source: isResolvedSpawnConfig(resolvedCfg) ? resolvedCfg.outcome.source : "test_injected",
    found: isResolvedSpawnConfig(resolvedCfg) ? resolvedCfg.outcome.found : true,
    exe: resolvedCfg.zcodeExe, cjs: resolvedCfg.zcodeCjs, to: toKey, scene: req.reason,
  });
  try {
    // v0.9.4（A4）：spawn 时刻——在调用 spawnResume **之前**取（提交发起的瞬间）。
    // 与 stampedAt（盖章时刻）之差 = spawn 前开销，wake-consumed 的双窗口据此拆分。
    spawnedAt = Date.now();
    const spawned = (req.spawn ?? spawnResume)({
      cfg: isResolvedSpawnConfig(resolvedCfg)
        ? { zcodeExe: resolvedCfg.zcodeExe, zcodeCjs: resolvedCfg.zcodeCjs }
        : resolvedCfg,
      sessionId: req.toSessionId,
      prompt,
      cwd: req.workspace,
      logFile,
      onAsyncError: (err) => {
        void releaseOnFailure("async", err);
      },
      // v0.2 W1 接线（DESIGN-V0.2 §4.2 审计）：helper 汇报的唤醒子 pid 追记
      // engine.jsonl {event:"wake-child", pid}，与 wake 行的 helper pid 并排可查。
      // v0.9.1（G-12v3）：同时转交生命周期监视的退出观察（ref 读取，见 childPidRef）。
      // v0.9.1 打回第 1 轮（V091-01）：pid 行只记 nonce 摘要（共享日志无真值）。
      onHelperSpawned: (childPid) => {
        childPidRef.pid = childPid;
        // v0.9.2（A1）：启动证据到闩（同步确认面的等待在此刻结算）。
        startLatch.signal(childPid);
        void logEngineEvent(stateRoot, {
          event: "wake-child", pid: childPid, scene: req.reason, teamId: req.teamId, to: toKey,
          nonce: wakeNonceDigest(token),
        });
        // v0.9.3（A2）第二级指标：唤醒子启动证据到场（与 wake-child 同刻，汇总面单列）。
        void logEngineEvent(stateRoot, {
          event: WAKE_TIER_EVENT_CHILD_ALIVE, pid: childPid, scene: req.reason,
          teamId: req.teamId, to: toKey, nonce: wakeNonceDigest(token),
        });
      },
    });
    pid = spawned.pid;
  } catch (err) {
    await releaseOnFailure("spawn", err);
    return {
      delivered: "mailbox",
      // v0.9.1 r3（V090-08）：降级路径的 note 同样携带畸形 config.json 的 WARNING
      // （与 wake 态 note、wake-skipped 原因行同一披露口径）。
      // v0.9.4（A3）：同样带「仅落邮箱（未唤醒）」——spawn 失败也是没唤醒成功，
      // 回执不得被读成已送达/已消费。
      note: mailboxOnlyNote(`spawn-failed: ${err instanceof Error ? err.message : String(err)}（消息留邮箱，pull 兜底，租约到期可重试）`)
        + (gate.warning !== undefined ? `；${gate.warning}` : ""),
      wakeLog: logFile,
      receiptIds: ids,
    };
  }

  // 6. 成功：markDelivered（已启动投递传输；消费与否由 readAt 说话，§2.1）+ 审计。
  await withLockBestEffort(stateRoot, req.teamId, () =>
    markMailboxDelivered(stateRoot, req.teamId, toKey, ids, now));
  await logEngineEvent(stateRoot, {
    event: "wake", scene: req.reason, teamId: req.teamId, to: toKey, pid,
    // v0.9.1 打回第 1 轮（V091-01）：wake 行只记 nonce 摘要（共享日志无真值）。
    nonce: wakeNonceDigest(token),
    wakeLog: logFile, receiptIds: ids, wakeGateSource: gate.source,
    // v0.9.1（G-12v3）：生命周期日志路径随行披露（运营面可直接 tail 这本账）。
    lifecycleLog: lifecycleFile,
    ...(gate.takenOver === true ? { takenOver: true } : {}),
    ...(gate.warning !== undefined ? { configWarning: gate.warning } : {}),
    ...(req.urgent === true ? { urgent: true } : {}),
  });
  // v0.9.3（A2）第一级指标：spawn 成功（与 wake 同刻，汇总/漏斗面单列——既有 wake
  // 事件不删，三级计数只认 wake-spawn-ok/wake-child-alive/wake-consumed）。
  await logEngineEvent(stateRoot, {
    event: WAKE_TIER_EVENT_SPAWN_OK, scene: req.reason, teamId: req.teamId, to: toKey, pid,
    nonce: wakeNonceDigest(token),
    wakeLog: logFile, receiptIds: ids, wakeGateSource: gate.source,
    ...(req.urgent === true ? { urgent: true } : {}),
  });

  // v0.9.1（G-12v3 机制 B）：启动生命周期监视——exit 尾行（+A2 致死原因回读）/
  // 假成功告警（wake-slow ∧ delivery-unconfirmed 合并一条）/ 第三级 wake-consumed /
  // limbo 降级。
  // 计时从**盖章时刻**（now）起算：limbo 判据 = deliveredAt 已盖而 consumedAt 超时
  // 未回写（消费回写面：hook 注入 / xc_read / xc_claim，见 mailbox.ts 与 hooks/）。
  // unref 定时器：引擎进程退出即停（观测面不拖进程；总窗 = nonce TTL）。
  // v0.9.5（A5）：捕获句柄——sessionNotFound 自动重试接管后压制原轮 ②③④（consumed
  // 只记重试 nonce、假成功/limbo 不对已被重试覆盖的投递误发）。
  const primaryLifecycle = startWakeLifecycleWatch({
    stateRoot,
    teamId: req.teamId,
    to: toKey,
    nonce: token,
    sid: req.toSessionId,
    scene: req.reason,
    wakeLog: logFile,
    lifecycleFile,
    stampedAt: now,
    // v0.9.4（A4）：spawn 时刻（与 stampedAt 之差 = spawn 前开销）——wake-consumed
    // 双计时窗口的起点之一。
    spawnedAt,
    // v0.9.4（A2）：exit 尾行的「是否确认」经此读取（确认落账后置位；未落账 = null）。
    getStartConfirmed: () => startConfirmedRef.value,
    getChildPid: () => childPidRef.pid,
    pollMs: req.lifecyclePollMs ?? WAKE_LIFECYCLE_POLL_MS,
    limboTimeoutMs: req.limboTimeoutMs ?? limboTimeoutFromEnv(req.env),
    // v0.9.2（A4-a）：limbo 宽限窗（会话活着而被知会时，锁竞争回写未落盘不立即判未消费）。
    ...(req.limboGraceMs !== undefined ? { limboGraceMs: req.limboGraceMs } : {}),
    wakeSlowMs: req.wakeSlowMs ?? wakeSlowFromEnv(req.env),
    // v0.9.3（A3）：假成功检测阈值（env XC_FAKE_SUCCESS_MS，缺省 5min）。
    fakeSuccessMs: req.fakeSuccessMs ?? fakeSuccessMsFromEnv(req.env),
    windowMs: req.lifecycleWindowMs ?? WAKE_INFLIGHT_MS,
    // v0.9.2（A4-b）：prompt 是否内嵌消息全文由 scene 判定（wakePromptEmbedsMessageBody），
    // 携带的消息 id = 本次回执 ids。
    receiptIds: ids,
    ...(req.pidAliveProbe !== undefined ? { pidAliveProbe: req.pidAliveProbe } : {}),
  });

  // v0.9.2（A1）：**同步启动确认**——spawn 成功只证明「已发起」（本进程拿到的是 helper
  // 的 pid）。在 XC_START_CONFIRM_MS 内观察 wake-child 的启动证据（helper 汇报的唤醒子
  // pid）；helper 已退出而未汇报 = 不可能再有证据，提前结算（不白等满窗）。
  // 用户核心诉求「消息发出去后主控不能自以为进程启动了」的正面回答：两态进 payload，
  // 配合 note 的如实措辞（「已发起但未见启动证据」），不再以 fire-and-forget 结案。
  //
  // 不等候的两种情形（都如实按未见结算，不空等）：
  // ① `req.spawn` 注入（测试）——注入实现没有 helper 汇报通道（onHelperSpawned 由
  //    resume-cli 的 helper 协议调用），等也等不到；与 req.cfg 同一注入纪律；
  // ② helper 进程已退出而未汇报——提前出口（见 createWakeStartLatch.confirm）。
  // 边界（如实声明）：direct spawn 形态同样没有汇报通道，启动确认恒为 false 且要等满窗
  // ——该形态仅测试/对照保留（生产恒走 helper）。
  const startConfirmThresholdMs = req.startConfirmMs ?? startConfirmMsFromEnv(req.env);
  const startOutcome = req.spawn !== undefined
    ? await startLatch.confirm(0)
    : await startLatch.confirm(startConfirmThresholdMs, () => pidAlive(pid!));
  await recordWakeStartConfirm(stateRoot, lifecycleFile, {
    teamId: req.teamId,
    to: toKey,
    scene: req.reason,
    sid: req.toSessionId,
    nonceToken: token,
    outcome: startOutcome,
    thresholdMs: startConfirmThresholdMs,
  });
  // v0.9.4（A2）：确认结算落账——exit 尾行的「是否确认」自此有真值（落账前观察到的
  // 退出仍记 null：不猜）。
  startConfirmedRef.value = startOutcome.confirmed;

  // v0.9.6（V095-14/adv3-F1）：回执时刻的**失败第三态**——启动确认结算后对 wake 日志
  // 做一次有界回读：快失败证据（sessionNotFound 等）此刻已在盘上时，回执如实披露
  // 「已发起但已见失败证据」（payload wakeFailureSeen/failureEvidence + note），不再让
  // 「已发起唤醒」成为调用方拿到的最后一句、失败只活在 1s 后的 engine 事件里。只读
  // 不清账：租约释放/nonce 消费/wake-failed 事件仍归失败侦听（startFailureWatch），
  // 两者对同一份日志同判据，互不重复记账。日志尚未出现/读失败 → 不表态（不误报）。
  let receiptFailureEvidence: string | undefined;
  try {
    receiptFailureEvidence = findWakeFailureEvidence(readFileSync(logFile, "utf8"));
  } catch {
    receiptFailureEvidence = undefined; // 日志尚未落盘：按「未知」处理，不虚构失败
  }

  // v0.9（G-8）：sessionNotFound 的单次自动重试（方案 §一 G-8「投递遇 sessionNotFound →
  // 复用既有唤醒机械（resume/OpenSession 跳板）自动重试恰一次 + engine 事件留痕；
  // 再失败如实回执附恢复动作；重试幂等（不得双投）」）。
  //
  // 插件侧可观察面：宿主 SendToSession 不在本插件内，投递路径的 sessionNotFound
  // 表现为唤醒子进程 --resume 失败落进 wake 日志的 `Error: Session not found: sess-…`
  // （FI-7 侦听的证据形态，adjudication.md #15 实测）。重试=复用同一 spawn 机械：
  // 1) 先按既有失败语义释放租约/消费 nonce（wake-failed 留痕）；
  // 2) **重绑**：从 team.json 现读目标成员当前 sessionId（xc_identify 重绑后
  //    joinTeam 已把花名册行刷新到新 sid——重试打向新会话；读不到则沿用原 sid）；
  // 3) 新 nonce + 重盖租约 + 同一 receiptIds 重新组装 prompt（**不重投邮箱**——
  //    消息仍在邮箱一次，唤醒 prompt 只是「去收箱」的携带段，天然幂等）；
  // 4) 恰一次：重试自身只由原始尝试的失败侦听触发一次；重试的失败侦听命中任何
  //    失败证据 → wake-retry-failed{recovery}（附恢复动作），不再二次重试。
  const retryOnceAfterSessionNotFound = async (evidence: string): Promise<void> => {
    const retryNow = Date.now();
    const rebound = await readWakeTargetMember(stateRoot, req.teamId, toKey);
    const sid = rebound?.sessionId !== undefined && rebound.sessionId.trim() !== ""
      ? rebound.sessionId
      : req.toSessionId;
    // v0.9.1 r3（V090-06）：重试前**复检**成员状态门 + 分层闸 + 在途 nonce——原始
    // 投递路径的三道门（§6.3/§7.3.3 状态门、G-4 分层闸、§2.5-3 在途去重）对重试
    // 同等有效：唤醒在途/失败窗内成员可能被 member-stop（removed）、被交互式会话
    // takeover、config.json 被改写，或窗内已有另一轮唤醒发起。复检不过 → 不
    // spawn、不重开租约（原始租约已由调用方释放、nonce 已消费），落
    // wake-retry-skipped 留痕——消息仍在邮箱，pull 兜底不丢。
    const retryGateState = rebound !== undefined
      && (memberState(rebound) === "provisioning" || memberState(rebound) === "failed" || memberState(rebound) === "removed")
      ? memberState(rebound)
      : undefined;
    const retryGate = resolveWakeGate(stateRoot, req.env, rebound);
    // v0.9.6（R1①）：重试前复检的在途闸同用活体证据版——孤儿票不触发 wake-retry-skipped。
    const retryInflight = await findLiveInflightWakeNonce(stateRoot, toKey, { teamId: req.teamId, now: retryNow });
    // v0.9.1（G-12-b）：容量闸对重试同等有效——重试也是一次 spawn，内存红线期重试
    // 只会放大 OOM（事故当日「重试波 = 主控重发消息的新 spawn，本身是内存放大器」）。
    // 复检不过 → 不 spawn、不重开租约，落 wake-retry-skipped（冷却原因写进 reason）。
    const retryCapacity = await capacityWakeDeferral(
      stateRoot,
      req.env,
      retryNow,
      // v0.9.2（C3）：重试与原始尝试同一键域（同 teamId/收方/紧急度）——冷却语义一致。
      { teamId: req.teamId, to: toKey, urgent: req.urgent === true },
    );
    if (retryGateState !== undefined || !retryGate.enabled || retryInflight !== undefined || retryCapacity !== undefined) {
      const reason = retryGateState !== undefined
        ? `member-state:${retryGateState}: 重试前复检命中成员状态门，不再唤醒（V090-06：removed 成员不被重试唤醒）`
        : retryInflight !== undefined
          ? `inflight-nonce: 重试前复检发现已有在途唤醒（${retryInflight.token}），不重复 --resume（§2.5-3）`
          : retryCapacity !== undefined
            ? `capacity-red: 重试前复检命中容量闸（${retryCapacity.detail.join("；")}），不再 spawn（G-12-b；${Math.round(retryCapacity.retryAfterMs / 1000)}s 后重新判定）`
            : `wake-disabled(重试前复检): ${wakeDisabledReason(retryGate)}`;
      await logEngineEvent(stateRoot, {
        event: "wake-retry-skipped", reason, scene: req.reason, teamId: req.teamId, to: toKey,
        attempt: 1, fromSessionId: req.toSessionId, sid,
        // v0.9.1 打回第 1 轮（V091-01）：重试跳过事件只记 nonce/在途令牌摘要。
        nonce: wakeNonceDigest(token), trigger: evidence,
        ...(retryGateState !== undefined ? { memberState: retryGateState } : {}),
        wakeGateSource: retryGate.source,
        ...(retryGate.takenOver === true ? { takenOver: true } : {}),
        ...(retryInflight !== undefined ? { inflightNonce: wakeNonceDigest(retryInflight.token) } : {}),
        ...(retryCapacity !== undefined
          ? { capacityRed: true, retryAfterMs: retryCapacity.retryAfterMs, detail: retryCapacity.detail }
          : {}),
      });
      return;
    }
    const { token: retryToken } = await createWakeNonce(stateRoot, {
      teamId: req.teamId, agentKey: toKey, sid, now: retryNow,
      // v0.9.1（G-11）：重试同样记录 voiceOwner=重绑后的原会话（sid）。
      // v0.9.5（A6/V094-05）：重试签发点同补 issuedToSid/name（与主路径同口径）。
      voiceOwner: sid,
      issuedToSid: sid,
      name: toKey,
    });
    const retryIds = [...ids];
    await withLockBestEffort(stateRoot, req.teamId, () =>
      claimMailboxDelivery(stateRoot, req.teamId, toKey, retryIds, retryNow));
    // v0.9.4（A6）：重试轮次同样解析 taskId（幂等：同一批消息，taskId 不变）。
    // v0.9.5（A1）：重试 prompt 的身份行同样按 ppid 采纳档分流。
    const retryReceiptTaskId = await resolveReceiptTaskId(stateRoot, req.teamId, toKey, retryIds);
    const retryPrompt = buildWakePrompt({
      teamId: req.teamId,
      recipientKey: toKey,
      recipientSessionId: sid,
      wakeToken: retryToken,
      receiptIds: retryIds,
      bodyText: req.ticket,
      includeMemberRules: includeRulesForScene(req.reason),
      scene: req.reason,
      adoptByPpidEnabled: adoptByPpid,
      ...(retryReceiptTaskId !== undefined ? { taskId: retryReceiptTaskId } : {}),
      ...(req.urgent === true ? { urgent: true } : {}),
    });
    const retryLogFile = wakeLogFile(stateRoot, toKey, retryNow);
    // v0.9.1（G-12v3）：重试轮次的唤醒子 pid ref（生命周期监视的退出观察）。
    const retryChildPidRef: { pid: number | undefined } = { pid: undefined };
    // v0.9.4（A4）：重试轮次的 spawn 时刻与（A2）确认结算读取位。
    const retryStartConfirmedRef: { value: boolean | undefined } = { value: undefined };
    // v0.9.6（V095-15）：重试轮自己的 spawn 时刻——不再作双窗口锚（锚首轮 spawn），
    // 仅作 wake-retry 事件的审计字段（重试自身的发起时刻）。
    let retrySpawnedAt = retryNow;
    // v0.9.2（A1）：重试轮次的启动证据闩（与主路径的 startLatch 各自独立）。
    const retryStartLatch = createWakeStartLatch();
    let retryPid: number | undefined;
    try {
      // v0.9.4（A4）：spawn 时刻（调 spawnResume 前取；审计面披露重试自身的发起时刻）。
      retrySpawnedAt = Date.now();
      const spawned = (req.spawn ?? spawnResume)({
        cfg: isResolvedSpawnConfig(resolvedCfg)
          ? { zcodeExe: resolvedCfg.zcodeExe, zcodeCjs: resolvedCfg.zcodeCjs }
          : resolvedCfg,
        sessionId: sid,
        prompt: retryPrompt,
        cwd: req.workspace,
        logFile: retryLogFile,
        onAsyncError: (err) => {
          void releaseOnFailure("retry-async", err,
            { nonce: retryToken, sid, ids: retryIds, now: retryNow },
            "wake-retry-failed", SESSION_NOT_FOUND_RECOVERY).catch(() => undefined);
        },
        onHelperSpawned: (childPid) => {
          retryChildPidRef.pid = childPid;
          // v0.9.2（A1）：重试轮次的启动证据（闩由下方异步确认消费）。
          retryStartLatch.signal(childPid);
          void logEngineEvent(stateRoot, {
            event: "wake-child", pid: childPid, scene: req.reason, teamId: req.teamId, to: toKey,
            // v0.9.1 打回第 1 轮（V091-01）：只记 nonce 摘要。
            nonce: wakeNonceDigest(retryToken), retried: true,
          });
          // v0.9.3（A2）第二级指标（重试轮次同等计入漏斗）。
          void logEngineEvent(stateRoot, {
            event: WAKE_TIER_EVENT_CHILD_ALIVE, pid: childPid, scene: req.reason,
            teamId: req.teamId, to: toKey, nonce: wakeNonceDigest(retryToken), retried: true,
          });
        },
      });
      retryPid = spawned.pid;
      // v0.9.5（A5/V094-08）：重试轮已接管本批 receiptIds 的投递——原轮监视器此后
      // 只保留 ① exit 尾行；②③④（假成功/consumed 计数/limbo）归重试轮监视器，
      // consumed 因此只记一笔且 nonce 属重试 attempt（修 2/2/1 错账与归属）。
      primaryLifecycle.markSuperseded();
      // v0.9.2（A1）：重试轮次同样做启动确认（异步面：只落账，不进任何 payload——
      // 重试没有同步回执面；「重试后启动证据未见」以 lifecycle 账与 engine 事件为准）。
      // 注入 spawn 时同样没有汇报通道，按未见结算（与主路径同一注入纪律）。
      void (async () => {
        const threshold = req.startConfirmMs ?? startConfirmMsFromEnv(req.env);
        const outcome = req.spawn !== undefined
          ? await retryStartLatch.confirm(0)
          : await retryStartLatch.confirm(threshold, () => pidAlive(retryPid!));
        await recordWakeStartConfirm(stateRoot, wakeLifecycleFile(stateRoot, toKey, retryNow), {
          teamId: req.teamId, to: toKey, scene: req.reason, sid,
          nonceToken: retryToken, outcome, thresholdMs: threshold,
        });
        // v0.9.4（A4）：重试轮次的确认结算（exit 尾行的「是否确认」读取位）。
        retryStartConfirmedRef.value = outcome.confirmed;
      })().catch(() => undefined);
    } catch (err) {
      await releaseOnFailure("retry-spawn", err,
        { nonce: retryToken, sid, ids: retryIds, now: retryNow },
        "wake-retry-failed", SESSION_NOT_FOUND_RECOVERY);
      return;
    }
    await withLockBestEffort(stateRoot, req.teamId, () =>
      markMailboxDelivered(stateRoot, req.teamId, toKey, retryIds, retryNow));
    await logEngineEvent(stateRoot, {
      event: "wake-retry", attempt: 1, scene: req.reason, teamId: req.teamId, to: toKey,
      fromSessionId: req.toSessionId, sid, pid: retryPid,
      // v0.9.1 打回第 1 轮（V091-01）：只记 nonce 摘要。
      nonce: wakeNonceDigest(retryToken),
      wakeLog: retryLogFile, receiptIds: retryIds, reason: evidence,
      // v0.9.6（V095-15）：重试自身的发起时刻（审计面；双窗口锚仍是首轮 spawn）。
      retrySpawnedAt,
      retryStampedAt: retryNow,
      ...(req.urgent === true ? { urgent: true } : {}),
    });
    // v0.9.3（A2）第一级指标（重试轮次：sessionNotFound 自动重绑后的 spawn 成功）。
    await logEngineEvent(stateRoot, {
      event: WAKE_TIER_EVENT_SPAWN_OK, scene: req.reason, teamId: req.teamId, to: toKey,
      pid: retryPid, nonce: wakeNonceDigest(retryToken),
      wakeLog: retryLogFile, receiptIds: retryIds, retried: true,
      ...(req.urgent === true ? { urgent: true } : {}),
    });
    startFailureWatch(retryLogFile, true, { nonce: retryToken, sid, ids: retryIds, now: retryNow });
    // v0.9.1（G-12v3）：重试也是一次盖章（markMailboxDelivered）——生命周期监视对
    // 重试轮次同等生效（exit 尾行/limbo 降级/假成功检测从重试盖章时刻起算）。
    // v0.9.6（V095-15/adv3-F2）：**双窗口锚首轮 spawn 时刻**——旧实现 stampedAt=retryNow，
    // 但重试的 markMailboxDelivered 因 mailbox first-wins（deliveredAt: message.deliveredAt ?? now）
    // 从不落邮箱行：事件窗口锚着一个邮箱里不存在的章（真实 1854ms 报 5034ms，2.7× 失真）。
    // 现在 stampedAt/spawnedAt 都继承原 attempt 的 spawn 时刻（用户感知的投递起点，真实
    // 在盘时刻），重试轮自己的重盖章时刻单列 retryStampedAt（wake-consumed 事件带
    // retried:true + 该字段，消费面可解释锚点）；retrySpawnedAt 仍由 wake-retry 事件的
    // ts 承载。limbo/wake-slow 从首轮 spawn 起算 = 重试不额外续命（与邮箱行的原章一致）。
    startWakeLifecycleWatch({
      stateRoot,
      teamId: req.teamId,
      to: toKey,
      nonce: retryToken,
      sid,
      scene: req.reason,
      wakeLog: retryLogFile,
      lifecycleFile: wakeLifecycleFile(stateRoot, toKey, retryNow),
      stampedAt: spawnedAt,
      // v0.9.6（V095-15）：双窗口都锚首轮 spawn（见上）。v0.9.4（A2）：确认结算读取位。
      spawnedAt,
      retryStampedAt: retryNow,
      getStartConfirmed: () => retryStartConfirmedRef.value,
      getChildPid: () => retryChildPidRef.pid,
      pollMs: req.lifecyclePollMs ?? WAKE_LIFECYCLE_POLL_MS,
      limboTimeoutMs: req.limboTimeoutMs ?? limboTimeoutFromEnv(req.env),
      wakeSlowMs: req.wakeSlowMs ?? wakeSlowFromEnv(req.env),
      // v0.9.3（A3）：假成功检测阈值（重试轮次同口径）。
      fakeSuccessMs: req.fakeSuccessMs ?? fakeSuccessMsFromEnv(req.env),
      windowMs: req.lifecycleWindowMs ?? WAKE_INFLIGHT_MS,
      // v0.9.5（A5/V094-08）：重试轮传 receiptIds——第三级消费检测以 receiptIds
      // 非空为硬门槛（tick ③），缺了它重试轮永远等不到 consumed、实际消费被原轮
      // （已判失败的 attempt）记账——V094-08 的 2/2/1 与错归属正源于此。
      receiptIds: retryIds,
      ...(req.pidAliveProbe !== undefined ? { pidAliveProbe: req.pidAliveProbe } : {}),
    });
  };

  // v0.5.1（FI-7/故障注-7）：spawn 成功只代表「唤醒已发起」，不代表送达——helper 孤儿化后
  // 本进程拿不到子进程退出码，子进程 --resume 失败（如 Session not found）只会落进 wake
  // 日志。红队实测：回执宣称 delivered=wake「已发起」而唤醒链实际失败，engine.jsonl 无任何
  // 失败标记（adjudication.md #15）。这里对 wake 日志做**有界失败侦听**：窗口内轮询日志，
  // 只认正向失败证据（findWakeFailureEvidence），命中：
  // - v0.9（G-8）sessionNotFound 证据 ∧ 尚未重试过 → 先按既有语义释放/留痕，
  //   再触发 {@link retryOnceAfterSessionNotFound}（恰一次）；
  // - 其余证据 → wake-failed{where:"wake-child"} + 释放投递租约 + 消费 nonce
  //   （pull 立即可见消息、重试不被 15min 在途标记挡住）；
  // 窗口静默 → 不表态（成功回合可能远超窗口，日志与 pull 仍是真源）。定时器全部 unref。
  // v0.9.3（A2）：同一轮询里追加**致死原因回读**——日志含 provider 限流关键词即披露
  // `wake-degraded{reason:"provider-rate-limit"}` + urgent 告知 lead，并抑制紧随其后的
  // wake-failed urgent（同一次死亡一条告警；事件与租约释放照旧）。
  const watchWindowMs = req.watchWindowMs ?? WAKE_WATCH_WINDOW_MS;
  const watchPollMs = req.watchPollMs ?? WAKE_WATCH_POLL_MS;
  /** lease = 该次 spawn 对应的租约身份（原始尝试缺省；重试传自己的 nonce/sid/ids）。 */
  const startFailureWatch = (
    targetLogFile: string,
    retried: boolean,
    lease?: { nonce: string; sid: string; ids: readonly string[]; now: number },
  ): void => {
    if (watchWindowMs <= 0 || watchPollMs <= 0) return;
    let rateLimitDisclosed = false;
    const pollTimer = setInterval(() => {
      let text = "";
      try {
        text = readFileSync(targetLogFile, "utf8");
      } catch {
        return; // 日志尚未出现（子进程还没写）→ 继续等
      }
      if (!rateLimitDisclosed) {
        const rateLimit = findProviderRateLimitEvidence(text);
        if (rateLimit !== undefined) {
          rateLimitDisclosed = true;
          void discloseProviderRateLimit(stateRoot, {
            nonceToken: lease?.nonce ?? token,
            teamId: req.teamId,
            to: toKey,
            sid: lease?.sid ?? req.toSessionId,
            scene: req.reason,
            evidence: rateLimit,
            where: retried ? "wake-retry-child" : "wake-child",
          }).catch(() => undefined);
        }
      }
      const evidence = findWakeFailureEvidence(text);
      if (evidence === undefined) return;
      clearInterval(pollTimer);
      // v0.9.3（A2）：限流致死的根因已由 wake-degraded 披露 ⇒ wake-failed 不再叠加 urgent。
      const suppressLeadUrgent = rateLimitDisclosed;
      if (!retried && isSessionNotFoundEvidence(evidence)) {
        void (async () => {
          await releaseOnFailure("wake-child", evidence, undefined, "wake-failed", undefined, suppressLeadUrgent);
          await retryOnceAfterSessionNotFound(evidence);
        })().catch(() => undefined);
        return;
      }
      void releaseOnFailure(
        retried ? "wake-retry-child" : "wake-child",
        evidence,
        lease,
        retried ? "wake-retry-failed" : "wake-failed",
        retried ? SESSION_NOT_FOUND_RECOVERY : undefined,
        suppressLeadUrgent,
      ).catch(() => undefined);
    }, watchPollMs);
    pollTimer.unref?.();
    const stopTimer = setTimeout(() => clearInterval(pollTimer), watchWindowMs);
    stopTimer.unref?.();
  };
  startFailureWatch(logFile, false);

  // v0.5.1（FI-7）：回执语义真实化——delivered:"wake" 是契约态（push 已发起），note 必须
  // 写明「非送达确认」，并标注 zcode 路径的自动探测回落（红队形态：env 配置的 exe/cjs
  // 文件不存在，探测静默改用本机安装——回执只字不提，lead 无从得知唤醒通道已回落）。
  // v0.9（G-8）：sessionNotFound 的自动重绑重试（恰一次）写入 note，如实声明异步路径。
  // v0.9.1 r3（V090-07）：失败侦听是**有界窗口**（WAKE_WATCH_WINDOW_MS，从 spawn
  // 成功起算）且只在本进程存活期间有效——note 必须如实给出边界与超窗后的兜底，
  // 不许维持「失败由引擎自动检测」的无条件承诺（红队 c6：25s 落盘的失败证据 +
  // 回执宣称自动检测 = 语义必然背离）。
  // v0.9.1 r3（V090-08）：畸形 config.json 的 WARNING 随 note 披露（放行路径与
  // skip 路径同口径——「调用方必须披露：engine.jsonl 事件与工具回执 note」双通道）。
  // v0.9.2（A1）：note 追加**启动确认**两态措辞——「已发起」不再与「起来了」混写：
  // 未见启动证据时如实说「已发起但未见启动证据」（仍非送达确认、也非失败）。
  // v0.9.3（A2）：note 追加**三级指标**口径——回执面只看前两级（spawn-ok / child-alive），
  // 第三级（consumed）由 engine 事件 wake-consumed 与邮箱真源异步交付（见 wakeTiers）。
  const warningNote = gate.warning !== undefined ? `；${gate.warning}` : "";
  // v0.9.6（V095-14）：失败第三态的回执措辞与 payload——启动确认（confirmed）/ 未见证据
  //（!confirmed）/ 失败（wake 日志已见失败证据）三态各自如实；失败态仍保留「已发起」的
  // 事实陈述（spawn 确实发起了），但不再让调用方把发起误读成成功。
  const failureNote = receiptFailureEvidence !== undefined
    ? `；⚠ 失败侦听：回执时刻 wake 日志已见失败证据（${receiptFailureEvidence.slice(0, 160)}）——本轮唤醒大概率失败（engine.jsonl wake-failed 将留痕、投递租约已/将被释放），消息 pull 兜底，请勿按已开工处理`
    : "";
  return {
    delivered: "wake",
    note:
      "spawned: 无头 --resume 已发起（fire-and-forget，非送达确认；" +
      `失败由本进程在 ${Math.round(WAKE_WATCH_WINDOW_MS / 1000)}s 有界窗口内侦听 wake 日志并记 engine.jsonl wake-failed/wake-retry/wake-retry-failed、释放投递租约，` +
      "sessionNotFound 时自动重绑重试恰一次；超窗或本进程退出则以邮箱 pull 兜底（消息不丢，在途 nonce 最多滞留 15min））"
      + wakeFallbackNote(req.env, resolvedCfg)
      + warningNote
      + `；${startConfirmNote(startOutcome, startConfirmThresholdMs)}`
      + failureNote
      + `；三级指标 wake-spawn-ok/wake-child-alive/wake-consumed（回执面只确认前两级：`
      + `spawn-ok=${startOutcome.confirmed ? "ok+child-alive" : "ok，child-alive 未见"}；`
      + `consumed 由 consumedAt/readAt 回写异步确认，见 engine 事件 wake-consumed）`,
    wakeLog: logFile,
    pid,
    receiptIds: ids,
    nonce: token,
    startConfirmed: startOutcome.confirmed,
    // v0.9.6（V095-14）：失败第三态的结构化键（回执时刻已见失败证据才带；fast-fail
    // 场景调用方不必等 engine 事件即可知悉）。
    ...(receiptFailureEvidence !== undefined
      ? { wakeFailureSeen: true, failureEvidence: receiptFailureEvidence.slice(0, 300) }
      : {}),
    wakeTiers: {
      spawnOk: "ok",
      childAlive: startOutcome.confirmed ? "ok" : "no",
      consumed: "pending",
    },
  };
}

/**
 * v0.5.1（FI-7）：env 配置了 zcode_exe/zcode_cjs 但文件不存在、自动探测回落命中时的
 * 回落标注（纯函数，单测直测）。env 未配置 → 空串（v0.4 零必填配置的常规路径，无需标注）；
 * env 命中（source=user_config）→ 空串（没有回落这回事）；探测未命中 → 空串
 * （spawn 会同步抛错走 mailbox 降级，回落无从谈起）。
 * v0.5.3（A5 修复）注：显式配置无效时 attemptWake 在 3.7 步直接 mailbox 降级（spawn 前闸），
 * 「配置失效仍以探测路径发出唤醒」的形态已不可达——本函数保留为 FI-7 防御面（万一未来
 * 重新出现回落路径，回执仍自动带标注），语义不变。
 */
export function wakeFallbackNote(
  env: NodeJS.ProcessEnv,
  resolved: WakeSpawnConfig | ResolvedSpawnConfig,
): string {
  if (!isResolvedSpawnConfig(resolved)) return "";
  const exeEnv = (env["XC_ZCODE_EXE"] ?? "").trim();
  const cjsEnv = (env["XC_ZCODE_CJS"] ?? "").trim();
  if (exeEnv === "" || cjsEnv === "") return "";
  if (!resolved.outcome.found || resolved.outcome.source === "user_config") return "";
  return `；注意：XC_ZCODE_EXE/XC_ZCODE_CJS 配置的文件不存在，唤醒通道已自动探测回落到 ${resolved.zcodeExe}`;
}
