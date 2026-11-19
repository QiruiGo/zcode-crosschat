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
  markMailboxDelivered,
  releaseMailboxDelivery,
  appendMailbox,
  createMessage,
  sweepLimboDeliveriesLocked,
} from "../core/mailbox";
import { readFileSync, rm, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
// v0.9.1（G-12-b）：容量闸冷却记录用 promise 版 mkdir/rm（与 core/atomic.ts 同族口径）。
import { mkdir, readFile, rm as rmAsync } from "node:fs/promises";
import { logEngineEvent } from "../core/log";
import { pidAlive, withTeamLock } from "../core/lock";
import { wakeLifecycleFile, wakeLogFile } from "../core/paths";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../core/atomic.js";
import {
  capacityCacheFile,
  judgeCapacity,
  sampleCapacity,
  turnEstimateBytesFromEnv,
  type CapacitySample,
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
  consumeWakeNonce,
  createWakeNonce,
  findInflightWakeNonce,
  readSession,
  WAKE_INFLIGHT_MS,
} from "../core/registry";
import { sanitizeKey } from "../core/sanitize";
import { memberState, memberIdentity, type TeamMember, type TeamMessage, type TeamState } from "../core/types";
import { spawnResume, type WakeSpawnConfig } from "./resume-cli";
import { explicitSpawnConfigError, resolveZcodeSpawnConfig, type ResolvedSpawnConfig } from "./zcode-locate";

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
}

/**
 * 成员守则 v2（DESIGN-V0.2.md §3.4 全文，「唤醒 prompt 内嵌文本，W3 交付于 wake.ts」，
 * 替换 v0.1.0 MEMBER_RULES 摘要版；§9.2 W3 对外接口 `export const MEMBER_RULES_V2: string`）。
 * 这是 G2「成员自动开工」的执行协议本体，逐条对应 CC 队友工作流（11-cc逆向 §4.3-5）。
 * 与 §3.4 比仅去掉两处纯设计内引用（§6.2 ③ / scheduler.js:178），语义零改动。
 * W2 的成员欢迎 prompt（xc_team member-add 步骤③）经本导出复用同一文本（§9.1 依赖方向）。
 * v0.7（M6）：守则内工具名随旧名移除同步改新名（xc_identify/xc_read/xc_team/xc_overview）。
 */
export const MEMBER_RULES_V2 = [
  "成员守则 v2（多任务自驱版）：",
  "1) 身份：先 xc_identify（本 prompt 已给出 name/sessionId/wakeToken），再 xc_read({scope:\"inbox\"}) 读消息。",
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
].join("\n");

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
export type WakeScene = (typeof WAKE_SCENES)[number];

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
  const identity =
    `你是 zcode 会话 "${input.recipientKey}"，sessionId=${input.recipientSessionId}。` +
    `本连接是新的：先调用 xc_identify 绑定本连接身份（name 填 "${input.recipientKey}"，` +
    `sessionId 填 "${input.recipientSessionId}"，wakeToken 填 "${input.wakeToken}"），` +
    `注册成功后调用 xc_read({scope:"inbox"}) 读取回执对应的消息。`;
  const rules = input.includeMemberRules === true ? MEMBER_RULES_V2 : undefined;

  // v0.6（C1）：urgent 唤醒 → 正文携带段首位插横幅（横幅 + 原正文合计受正文预算
  // 约束；横幅固定短行，超长时先压正文再压横幅尾部——truncateBody 作用于合计文本，
  // 保横幅与正文头部的可读顺序）。
  const body = input.urgent === true
    ? `${URGENT_WAKE_BANNER}\n${input.bodyText}`
    : input.bodyText;

  // 分隔符开销：parts 以 "\n\n" 连接。
  const sepCount = (rules === undefined ? 2 : 3) * 2;
  const bodyBudget = Math.max(
    0,
    maxChars - receipt.length - identity.length - (rules?.length ?? 0) - sepCount,
  );
  const parts = rules === undefined
    ? [receipt, identity, truncateBody(body, bodyBudget)]
    : [receipt, identity, truncateBody(body, bodyBudget), rules];
  let prompt = parts.join("\n\n");
  if (prompt.length > maxChars) {
    // 兜底硬切（结构性部分自身超限时才会走到这里）。
    const keep = Math.max(0, maxChars - TRUNCATE_MARKER.length);
    prompt = prompt.slice(0, keep) + TRUNCATE_MARKER;
  }
  return prompt;
}

// ─────────────────────────── spawn 前容量闸（v0.9.1 G-12-b） ───────────────────────────

/**
 * v0.9.1（G-12-b）：spawn 前容量闸——「容量只警不拦 = 死亡螺旋」的收口。
 *
 * 现场事实（GAP-V0.9 第六/八批，lims2.0 2026-11-19 内存红线事故）：RED 判定本身正确
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
 * 边界（如实声明）：闸门只挡**唤醒**（spawn），不拦 pull——消息照常落邮箱，收方自己
 * 的回合随时可读（§2.5 mailbox 行兜底不变）。派单面的「RED 期排队拒绝」需在派单工具
 * 面接线（非本文件域），本版在 wake 层给出 deferral 块与冷却窗供其消费（PROTOCOL §15.2）。
 */

/** 容量闸冷却窗缺省值（ms）——RED deferral 后的静默窗，窗内不重复采样/spawn。 */
export const WAKE_CAPACITY_COOLDOWN_MS_DEFAULT = 120_000;

/** 冷却窗 env：`XC_MEM_WAKE_COOLDOWN_MS`（ms，>=0 合法；0=不冷却=每次投递都重新判定）。 */
export function wakeCapacityCooldownMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["XC_MEM_WAKE_COOLDOWN_MS"];
  if (raw === undefined || raw.trim() === "") return WAKE_CAPACITY_COOLDOWN_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : WAKE_CAPACITY_COOLDOWN_MS_DEFAULT;
}

/**
 * 容量闸开关 env：`XC_MEM_WAKE_GATE`。`"off"` = 关闭容量闸（回到 v0.9.0「只警不拦」
 * 行为）；其余值/未设 = 开启。非法值不静默——按开启处理并在事件里带 `gateEnv` 原值，
 * 运维可分辨「我没配」与「我配错了」。
 */
export function wakeCapacityGateEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["XC_MEM_WAKE_GATE"];
  if (raw === undefined || raw.trim() === "") return true;
  return raw.trim().toLowerCase() !== "off";
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

/** 落盘的冷却记录（比块多一个 `until` 绝对时刻）。 */
interface WakeDeferralRecord extends WakeDeferral {
  until: number;
}

function formatBytesLabel(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.round(n)}B`;
}

/** 读冷却记录；过期/损坏/未来时钟 → undefined（重新判定）。 */
async function readWakeDeferral(file: string, now: number): Promise<WakeDeferralRecord | undefined> {
  try {
    const rec = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const until = Number(rec["until"]);
    if (!Number.isFinite(until) || until <= now) return undefined;
    const detail = Array.isArray(rec["detail"])
      ? (rec["detail"] as unknown[]).filter((d): d is string => typeof d === "string")
      : [];
    return {
      reason: "capacity-red",
      detail,
      watermark: Number(rec["watermark"]) || 0,
      freeBytes: Number(rec["freeBytes"]) || 0,
      cooldownMs: Number(rec["cooldownMs"]) || 0,
      retryAfterMs: Math.max(0, until - now),
      cooldownActive: true,
      until,
    };
  } catch {
    return undefined; // 缺文件/损坏 JSON → 重新判定（不因冷却文件坏掉而永久挡唤醒）
  }
}

/**
 * 容量闸判定（spawn 前调用；返回 undefined = 放行）。
 *
 * 顺序：开关 → 冷却窗（窗内直接 deferred，不采样）→ 真采样 → 判定 → 写冷却记录。
 * 采样意外（os 读数异常等）**fail-open**：不因观测故障永久挡住协作唤醒，但落
 * `wake-capacity-probe-failed` 事件如实披露（与「只警不拦」的旧行为相比仍是净增益：
 * 正常情况下闸在工作）。
 *
 * @param sampleOverride 测试注入的容量样本（缺省=真采样 `sampleCapacity`）——与
 *   `req.cfg`/`req.spawn` 同一注入纪律：注入即信任，生产路径永不传。
 */
export async function capacityWakeDeferral(
  stateRoot: string,
  env: NodeJS.ProcessEnv,
  now: number,
  sampleOverride?: CapacitySample,
): Promise<WakeDeferral | undefined> {
  if (!wakeCapacityGateEnabledFromEnv(env)) return undefined;
  const cooldownMs = wakeCapacityCooldownMsFromEnv(env);
  const file = wakeDeferralFile(stateRoot);
  if (cooldownMs > 0) {
    const active = await readWakeDeferral(file, now);
    if (active !== undefined) return active;
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
  const verdict = judgeCapacity(sample, env);
  const estimate = turnEstimateBytesFromEnv(env);
  const marginalExceeded = estimate > sample.freeBytes;
  if (!verdict.red && !marginalExceeded) {
    // GREEN：清掉可能存在的过期冷却标记，下次唤醒立即通行（不留残挡）。
    await rmAsync(file, { force: true }).catch(() => undefined);
    return undefined;
  }
  const detail = [...verdict.detail];
  if (marginalExceeded) {
    detail.push(
      `marginal-estimate: 单回合预估 ${formatBytesLabel(estimate)} > 可用 ${formatBytesLabel(sample.freeBytes)}`
        + "（XC_TURN_ESTIMATE_BYTES；再起一个无头回合也放不下）",
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
    const record: WakeDeferralRecord = { ...deferral, until: now + cooldownMs };
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`).catch(() => undefined);
  }
  return deferral;
}

// ─────────────────────────── wake-child 生命周期 + limbo/wake-slow 信号（v0.9.1 G-12v3） ───────────────────────────

/**
 * v0.9.1（G-12v3 机制 B）：**投递盖章与消费确认分离** + 三类引擎信号。
 *
 * 现场事实（GAP-V0.9 第六/七批，2026-11-19）：wake 路径 spawn 成功瞬间即盖
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
/** 生命周期监视轮询间隔默认值（ms）。 */
export const WAKE_LIFECYCLE_POLL_MS = 5_000;

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
  /** 投递盖章时刻（spawn 成功；limbo/wake-slow 两个计时都从它起算）。 */
  stampedAt: number;
  /** 唤醒子 pid（helper 汇报后才拿得到；取不到 = 无法观察退出，其余信号不受影响）。 */
  getChildPid: () => number | undefined;
  /** 轮询间隔 / limbo 超时 / wake-slow 阈值 / 总窗（ms）。 */
  pollMs: number;
  limboTimeoutMs: number;
  wakeSlowMs: number;
  windowMs: number;
  /** 测试注入：pid 存活判定（缺省 core/lock 的 pidAlive）。 */
  pidAliveProbe?: (pid: number) => boolean;
}

/**
 * 启动 wake-child 生命周期监视（unref 定时器；引擎进程活着才有效，见边界声明）。
 * 三类信号各自只发一次（进程内flag）：exit 尾行 / wake-slow / limbo 降级+告知。
 * 消费确认到齐（本批消息全部 consumedAt/readAt/discardedAt）即收工，不空转。
 */
export function startWakeLifecycleWatch(cfg: WakeLifecycleWatchConfig): void {
  if (cfg.pollMs <= 0 || cfg.windowMs <= 0) return;
  const isAlive = cfg.pidAliveProbe ?? pidAlive;
  let slowSignaled = false;
  let limboHandled = false;
  let exitRecorded = false;
  let ticking = false;
  let stopped = false;

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
      if (!exitRecorded && pid !== undefined && !isAlive(pid)) {
        exitRecorded = true;
        let evidence: string | undefined;
        try {
          evidence = findWakeFailureEvidence(readFileSync(cfg.wakeLog, "utf8"));
        } catch {
          /* 日志尚未出现/不可读：无快照 */
        }
        appendWakeLifecycle(cfg.lifecycleFile, {
          event: "wake-child-exit",
          pid,
          durationMs: now - cfg.stampedAt,
          exitCode: null, // 孤儿化唤醒子（V9）的退出码对引擎进程不可观测——如实记 null
          ...(evidence !== undefined ? { evidence } : {}),
        });
      }

      // ② wake-slow：阈值内目标 sid 全静默（无 session-start 投影）→ 事件 + urgent lead。
      if (!slowSignaled && now - cfg.stampedAt >= cfg.wakeSlowMs) {
        if (!(await sessionStartedSince(cfg.stateRoot, cfg.sid, cfg.stampedAt))) {
          slowSignaled = true;
          const waitedMin = Math.round((now - cfg.stampedAt) / 60000);
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
          await notifyLeadUrgent(
            cfg.stateRoot,
            cfg.teamId,
            `[zcode-crosschat 引擎信号] wake-slow：唤醒 "${cfg.to}" 已 ${waitedMin} 分钟无 session-start`
            + `（spawn 成功但回合未开跑；场景 ${cfg.scene}）。消息已盖投递章仍在邮箱（pull 兜底不丢）。`
            + `若成员会话已死，请重发或由 lead 用 xc_team({action:"member-add"}) 幂等重供给。`
            + `（0 字节日志不作失败判据；只有 ≥5min 无 session-start 才判慢。）`,
          );
        }
      }

      // ③ limbo：盖章超时无消费确认 → 团队锁内降级 + 事件 + urgent lead（一个轮次恰一次）。
      if (!limboHandled && now - cfg.stampedAt >= cfg.limboTimeoutMs) {
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
          if (downgraded.length > 0) {
            appendWakeLifecycle(cfg.lifecycleFile, {
              event: "limbo-downgrade",
              messageIds: downgraded.map((m) => m.id),
              waitedMs: now - cfg.stampedAt,
            });
            const waitedMin = Math.round((now - cfg.stampedAt) / 60000);
            await notifyLeadUrgent(
              cfg.stateRoot,
              cfg.teamId,
              `[zcode-crosschat 引擎信号] limbo：${downgraded.length} 条消息盖投递章后 ${waitedMin} 分钟无消费确认，`
              + `已自动降级回 unread（重新可注入/可 pull）。目标 "${cfg.to}"（sid ${cfg.sid}）的唤醒回合`
              + `疑似在消费前死亡（内存红线 OOM / 宿主重启杀无头子进程）。消息 id：`
              + `${downgraded.map((m) => m.id).join(", ")}。可重发，或让成员 xc_read({scope:"inbox"}) 兜底。`,
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
    await logEngineEvent(stateRoot, {
      event: "wake-skipped", reason: pre.reason, scene: req.reason, teamId: req.teamId, to: toKey,
      rawWakeEnabled: rawFlag ?? null, wakeGateSource: gate.source,
      // v0.9.1 r3（V090-05）：engine 标行被交互式持有者接管——免开关不适用，
      // 事件带标，运营面可诊断「引擎成员突然不自动开工」。
      ...(gate.takenOver === true ? { takenOver: true } : {}),
      ...(gate.warning !== undefined ? { configWarning: gate.warning } : {}),
    });
    return { delivered: "mailbox", note: pre.reason };
  }

  // 2. 在途 nonce 去重（§2.5-3）。
  const inflight = await findInflightWakeNonce(stateRoot, toKey, { teamId: req.teamId, now });
  if (inflight !== undefined) {
    const d = decideDelivery({ wakeGate: gate, ownerAbsent: req.ownerAbsent, inflight: true });
    await logEngineEvent(stateRoot, {
      event: "wake-skipped", reason: d.reason, scene: req.reason, teamId: req.teamId, to: toKey,
      // v0.9.1 打回第 1 轮（V091-01）：在途令牌只落不可反查摘要——真值仅存于
      // registry/wake/ 真源与唤醒 prompt，共享日志不给人可消费的令牌。
      inflightNonce: wakeNonceDigest(inflight.token),
    });
    return { delivered: "mailbox", note: d.reason };
  }

  // 2.5 v0.2 成员状态门控（DESIGN-V0.2 §6.3 双向门控 + §7.3.3「E-a/E-b/E-c 唤醒路径
  // 检查 state」）：provisioning/failed/removed 的成员只入箱、不唤醒——provisioning
  // 期间 resume 会与 app-server 持有并发（V5 未验证区）；removed 成员不再被唤醒。
  // 位置在 createWakeNonce **之前**：跳过路径不落 nonce，避免 15min 在途标记挡住
  // 供给完成后的 E-e 投产唤醒。团队不存在/成员不在册 → 与 v0.1.0 行为一致（放行）；
  // W2 的 state 可选字段以 §6.5 宽容语义读取（缺省 "ready"=放行，旧数据零行为变化）。
  // v0.9：成员记录复用步骤 0 的一次读盘（memberState 访问器=旧内联读取同语义）。
  const gateState = target !== undefined
    && (memberState(target) === "provisioning" || memberState(target) === "failed" || memberState(target) === "removed")
    ? memberState(target)
    : undefined;
  if (gateState !== undefined) {
    const reason = `member-state:${gateState}: 目标成员供给中/失败/已移除，只入箱不唤醒（DESIGN-V0.2 §6.3/§7.3.3）`;
    await logEngineEvent(stateRoot, {
      event: "wake-skipped", reason, scene: req.reason, teamId: req.teamId, to: toKey, memberState: gateState,
    });
    return { delivered: "mailbox", note: reason };
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
      return { delivered: "mailbox", note: reason };
    }
  }

  // 3.8 v0.9.1（G-12-b）spawn 前容量闸：读 capacity verdict，水位低于硬底或边际预估
  //     超过 freeBytes → **不 spawn**（不写 nonce、不盖租约——跳过路径不留 15min 在途
  //     标记，与 2.5 状态门同纪律），直接 deliver=mailbox + wake-deferred{reason:
  //     "capacity-red"} + 冷却重试（XC_MEM_WAKE_COOLDOWN_MS）。位置在最后一道 spawn
  //     前置闸之后、createWakeNonce 之前：前面的门（分层闸/在途/状态/spawn 配置）都不
  //     触发时才值得采样（采样有 60s 缓存窗，成本是一次文件读 + os.freemem()）。
  //     消息已在邮箱（调用方锁内已 append），pull 兜底不丢——闸只挡唤醒不拦投递。
  const capacityDeferral = await capacityWakeDeferral(stateRoot, req.env, now, req.capacitySample);
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
    });
    return {
      delivered: "mailbox",
      note: reason
        + `（容量闸 v0.9.1 G-12-b；冷却 ${Math.round(capacityDeferral.cooldownMs / 1000)}s，env XC_MEM_WAKE_COOLDOWN_MS 可调，XC_MEM_WAKE_GATE=off 可关闸）`,
      wakeDeferred: capacityDeferral,
    };
  }

  // 4. 写一次性 nonce（兼在途标记）+ 盖投递租约（尽力而为）。
  // v0.9.1（G-11）：nonce 显式记录 voiceOwner=原会话（= 目标 sid）——无头 --resume
  // 回合与桌面原会话共享 sid，xc_identify 消费本 nonce 时把 voiceOwner 转记到连接
  // 身份，uservoice 盖章面据此承认「本连接是该 sid 的唤醒续跑」（不再因 sid 被
  // elsewhere 活进程持有而拒章；对外部会话的拒绝线不放松，见 core/uservoice.ts）。
  const { token } = await createWakeNonce(stateRoot, {
    teamId: req.teamId, agentKey: toKey, sid: req.toSessionId, now,
    voiceOwner: req.toSessionId,
  });
  const ids = [...req.receiptIds];
  await withLockBestEffort(stateRoot, req.teamId, () =>
    claimMailboxDelivery(stateRoot, req.teamId, toKey, ids, now));

  // 5. prompt + spawn（fire-and-forget）。守则附加按场景白名单（v0.2 §9.1 白名单兼容）。
  // v0.6（C1）：urgent 唤醒（xc_relay）→ 正文首位 URGENT 横幅。
  const prompt = buildWakePrompt({
    teamId: req.teamId,
    recipientKey: toKey,
    recipientSessionId: req.toSessionId,
    wakeToken: token,
    receiptIds: ids,
    bodyText: req.ticket,
    includeMemberRules: includeRulesForScene(req.reason),
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
    if (where === "spawn" || where === "retry-spawn") {
      appendWakeLifecycle(lifecycleFile, {
        event: "wake-child-exit",
        pid: null,
        durationMs: 0,
        exitCode: null,
        spawnError: String(err),
      });
    }
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
  let pid: number | undefined;
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
        void logEngineEvent(stateRoot, {
          event: "wake-child", pid: childPid, scene: req.reason, teamId: req.teamId, to: toKey,
          nonce: wakeNonceDigest(token),
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
      note: `spawn-failed: ${err instanceof Error ? err.message : String(err)}（消息留邮箱，pull 兜底，租约到期可重试）`
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

  // v0.9.1（G-12v3 机制 B）：启动生命周期监视——exit 尾行 / wake-slow / limbo 降级。
  // 计时从**盖章时刻**（now）起算：limbo 判据 = deliveredAt 已盖而 consumedAt 超时
  // 未回写（消费回写面：hook 注入 / xc_read / xc_claim，见 mailbox.ts 与 hooks/）。
  // unref 定时器：引擎进程退出即停（观测面不拖进程；总窗 = nonce TTL）。
  startWakeLifecycleWatch({
    stateRoot,
    teamId: req.teamId,
    to: toKey,
    nonce: token,
    sid: req.toSessionId,
    scene: req.reason,
    wakeLog: logFile,
    lifecycleFile,
    stampedAt: now,
    getChildPid: () => childPidRef.pid,
    pollMs: req.lifecyclePollMs ?? WAKE_LIFECYCLE_POLL_MS,
    limboTimeoutMs: req.limboTimeoutMs ?? limboTimeoutFromEnv(req.env),
    wakeSlowMs: req.wakeSlowMs ?? wakeSlowFromEnv(req.env),
    windowMs: req.lifecycleWindowMs ?? WAKE_INFLIGHT_MS,
    ...(req.pidAliveProbe !== undefined ? { pidAliveProbe: req.pidAliveProbe } : {}),
  });

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
    const retryInflight = await findInflightWakeNonce(stateRoot, toKey, { teamId: req.teamId, now: retryNow });
    // v0.9.1（G-12-b）：容量闸对重试同等有效——重试也是一次 spawn，内存红线期重试
    // 只会放大 OOM（事故当日「重试波 = 主控重发消息的新 spawn，本身是内存放大器」）。
    // 复检不过 → 不 spawn、不重开租约，落 wake-retry-skipped（冷却原因写进 reason）。
    const retryCapacity = await capacityWakeDeferral(stateRoot, req.env, retryNow);
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
      voiceOwner: sid,
    });
    const retryIds = [...ids];
    await withLockBestEffort(stateRoot, req.teamId, () =>
      claimMailboxDelivery(stateRoot, req.teamId, toKey, retryIds, retryNow));
    const retryPrompt = buildWakePrompt({
      teamId: req.teamId,
      recipientKey: toKey,
      recipientSessionId: sid,
      wakeToken: retryToken,
      receiptIds: retryIds,
      bodyText: req.ticket,
      includeMemberRules: includeRulesForScene(req.reason),
      ...(req.urgent === true ? { urgent: true } : {}),
    });
    const retryLogFile = wakeLogFile(stateRoot, toKey, retryNow);
    // v0.9.1（G-12v3）：重试轮次的唤醒子 pid ref（生命周期监视的退出观察）。
    const retryChildPidRef: { pid: number | undefined } = { pid: undefined };
    let retryPid: number | undefined;
    try {
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
          void logEngineEvent(stateRoot, {
            event: "wake-child", pid: childPid, scene: req.reason, teamId: req.teamId, to: toKey,
            // v0.9.1 打回第 1 轮（V091-01）：只记 nonce 摘要。
            nonce: wakeNonceDigest(retryToken), retried: true,
          });
        },
      });
      retryPid = spawned.pid;
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
      ...(req.urgent === true ? { urgent: true } : {}),
    });
    startFailureWatch(retryLogFile, true, { nonce: retryToken, sid, ids: retryIds, now: retryNow });
    // v0.9.1（G-12v3）：重试也是一次盖章（markMailboxDelivered）——生命周期监视对
    // 重试轮次同等生效（exit 尾行/limbo 降级/wake-slow 从重试盖章时刻起算）。
    startWakeLifecycleWatch({
      stateRoot,
      teamId: req.teamId,
      to: toKey,
      nonce: retryToken,
      sid,
      scene: req.reason,
      wakeLog: retryLogFile,
      lifecycleFile: wakeLifecycleFile(stateRoot, toKey, retryNow),
      stampedAt: retryNow,
      getChildPid: () => retryChildPidRef.pid,
      pollMs: req.lifecyclePollMs ?? WAKE_LIFECYCLE_POLL_MS,
      limboTimeoutMs: req.limboTimeoutMs ?? limboTimeoutFromEnv(req.env),
      wakeSlowMs: req.wakeSlowMs ?? wakeSlowFromEnv(req.env),
      windowMs: req.lifecycleWindowMs ?? WAKE_INFLIGHT_MS,
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
  const watchWindowMs = req.watchWindowMs ?? WAKE_WATCH_WINDOW_MS;
  const watchPollMs = req.watchPollMs ?? WAKE_WATCH_POLL_MS;
  /** lease = 该次 spawn 对应的租约身份（原始尝试缺省；重试传自己的 nonce/sid/ids）。 */
  const startFailureWatch = (
    targetLogFile: string,
    retried: boolean,
    lease?: { nonce: string; sid: string; ids: readonly string[]; now: number },
  ): void => {
    if (watchWindowMs <= 0 || watchPollMs <= 0) return;
    const pollTimer = setInterval(() => {
      let text = "";
      try {
        text = readFileSync(targetLogFile, "utf8");
      } catch {
        return; // 日志尚未出现（子进程还没写）→ 继续等
      }
      const evidence = findWakeFailureEvidence(text);
      if (evidence === undefined) return;
      clearInterval(pollTimer);
      if (!retried && isSessionNotFoundEvidence(evidence)) {
        void (async () => {
          await releaseOnFailure("wake-child", evidence);
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
  const warningNote = gate.warning !== undefined ? `；${gate.warning}` : "";
  return {
    delivered: "wake",
    note:
      "spawned: 无头 --resume 已发起（fire-and-forget，非送达确认；" +
      `失败由本进程在 ${Math.round(WAKE_WATCH_WINDOW_MS / 1000)}s 有界窗口内侦听 wake 日志并记 engine.jsonl wake-failed/wake-retry/wake-retry-failed、释放投递租约，` +
      "sessionNotFound 时自动重绑重试恰一次；超窗或本进程退出则以邮箱 pull 兜底（消息不丢，在途 nonce 最多滞留 15min））"
      + wakeFallbackNote(req.env, resolvedCfg)
      + warningNote,
    wakeLog: logFile,
    pid,
    receiptIds: ids,
    nonce: token,
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
