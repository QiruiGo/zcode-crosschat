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
} from "../core/mailbox";
import { readFileSync } from "node:fs";
import { logEngineEvent } from "../core/log";
import { withTeamLock } from "../core/lock";
import { wakeLogFile } from "../core/paths";
import { readTeam } from "../core/teamstate";
import {
  consumeWakeNonce,
  createWakeNonce,
  findInflightWakeNonce,
  WAKE_INFLIGHT_MS,
} from "../core/registry";
import { sanitizeKey } from "../core/sanitize";
import type { TeamMessage, TeamState } from "../core/types";
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

/** 失败侦听窗口默认值（从 spawn 成功起算；窗口静默=不表态，不虚报成败）。 */
export const WAKE_WATCH_WINDOW_MS = 20_000;
/** 失败侦听轮询间隔默认值。 */
export const WAKE_WATCH_POLL_MS = 500;

// ─────────────────────────── 开关判定（V7） ───────────────────────────

/**
 * XC_WAKE_ENABLED 严格判定：**非 "true" 的一律按关闭**（含 undefined、""、"TRUE" 等任何其他
 * 值——模板展开行为未确认，DESIGN §9-V7），原始值由 attemptWake 记入 engine.jsonl。
 */
export function isWakeEnabled(raw: string | undefined | null): boolean {
  return raw === "true";
}

// ─────────────────────────── duplicate 去重（移植 tools.js:2088-2093） ───────────────────────────

/** 候选消息身份（与 dsh send_message 的判定字段一一对应；收件人邮箱即隐含 to）。 */
export interface MailIdentity {
  from: string;
  content: string;
  /** 收件人当前开放任务/attempt 快照（无则为 undefined）。 */
  taskId?: string;
  attemptId?: string;
  sourceTaskId?: string;
  sourceAttemptId?: string;
  sourceTaskStatus?: string;
}

const eqOpt = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? undefined) === (b ?? undefined);

/**
 * 幂等判定：邮箱中已存在"同文且仍在效期"的消息则返回它（调用方应返回 duplicate 态且**不再追加**）。
 * 全等字段：from + content + taskId + attemptId + sourceTaskId/sourceAttemptId/sourceTaskStatus，
 * 且 isCurrentMail（M1 移植 mailbox.js:6-17）为真，且（有任务绑定 ∨ 尚未读过）——与
 * dsh tools.js:2088-2093 逐条件对应。（M3 tools.ts 自带内联判定；本函数是同语义的独立实现，供单测与复用。）
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
      (m.attemptId !== undefined || m.sourceAttemptId !== undefined || m.readAt === undefined),
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
  /** XC_WAKE_ENABLED 原始值（V7：非 "true" 即关，原始值落 engine.jsonl）。 */
  wakeEnabledRaw: string | undefined | null;
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
  if (!isWakeEnabled(input.wakeEnabledRaw)) {
    return {
      mode: "mailbox",
      reason: `wake-disabled: XC_WAKE_ENABLED 非 "true"（raw=${JSON.stringify(input.wakeEnabledRaw ?? null)}）`,
    };
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
}

/**
 * 成员守则 v2（DESIGN-V0.2.md §3.4 全文，「唤醒 prompt 内嵌文本，W3 交付于 wake.ts」，
 * 替换 v0.1.0 MEMBER_RULES 摘要版；§9.2 W3 对外接口 `export const MEMBER_RULES_V2: string`）。
 * 这是 G2「成员自动开工」的执行协议本体，逐条对应 CC 队友工作流（11-cc逆向 §4.3-5）。
 * 与 §3.4 比仅去掉两处纯设计内引用（§6.2 ③ / scheduler.js:178），语义零改动。
 * W2 的成员欢迎 prompt（xc_member_add 步骤③）经本导出复用同一文本（§9.1 依赖方向）。
 */
export const MEMBER_RULES_V2 = [
  "成员守则 v2（多任务自驱版）：",
  "1) 身份：先 xc_register（本 prompt 已给出 name/sessionId/wakeToken），再 xc_check_inbox 读消息。",
  "2) 工作循环（一个回合可以做多单，做完一单领下一单）：",
  "   a. 取一单：优先看收件箱未读的 task-assignment / unblock-notice；",
  "   b. xc_claim(taskId) 拿 attemptId → xc_report(in_progress) → 执行；",
  "   c. 预计超过 10 分钟的任务每 ≤10 分钟 xc_report(in_progress)（心跳，附一句进展）；",
  "   d. 完成：xc_report(completed, result=结果摘要, evidence=[文件路径+至少一条])；",
  "      失败：xc_report(failed, error=原因)。回执发出后回到 a 取下一单。",
  "3) 没有可做的活：向 lead 发 xc_idle（summary 必填；刚完成的单附 completedTaskId/completedStatus），",
  "   然后立即结束回合。不要空转轮询。（例外：首次供给的欢迎回合无单直接结束回合、不发 xc_idle",
  "   ——就绪由 roster state 表达。）",
  "4) xc_claim 被拒：task_not_pending（已被领）→ 不重试，回到 a；",
  "   dependencies_unmet → 该任务等 unblock-notice 再做，回到 a 看有没有别的活；",
  "   already_has_open_task → 先把手头的单做完报掉。",
  "5) stale attempt（attemptId 不匹配）→ 立即停手，该任务已被重置，回 a 取别的；",
  "   error:\"busy\" → 稍后重试一次，仍忙则 xc_idle 结束回合。",
  "6) 依赖任务的输出：claim 后如需上游产出，用 xc_status 看依赖任务的 result 字段；",
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
    `本连接是新的：先调用 xc_register 绑定本连接身份（name 填 "${input.recipientKey}"，` +
    `sessionId 填 "${input.recipientSessionId}"，wakeToken 填 "${input.wakeToken}"），` +
    `注册成功后调用 xc_check_inbox 读取回执对应的消息。`;
  const rules = input.includeMemberRules === true ? MEMBER_RULES_V2 : undefined;

  // 分隔符开销：parts 以 "\n\n" 连接。
  const sepCount = (rules === undefined ? 2 : 3) * 2;
  const bodyBudget = Math.max(
    0,
    maxChars - receipt.length - identity.length - (rules?.length ?? 0) - sepCount,
  );
  const parts = rules === undefined
    ? [receipt, identity, truncateBody(input.bodyText, bodyBudget)]
    : [receipt, identity, truncateBody(input.bodyText, bodyBudget), rules];
  let prompt = parts.join("\n\n");
  if (prompt.length > maxChars) {
    // 兜底硬切（结构性部分自身超限时才会走到这里）。
    const keep = Math.max(0, maxChars - TRUNCATE_MARKER.length);
    prompt = prompt.slice(0, keep) + TRUNCATE_MARKER;
  }
  return prompt;
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
  /** 进程 env；XC_WAKE_ENABLED 判定全在 M2（V7）。 */
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
 * v0.2 成员状态门控（§6.3/§7.3.3）：目标成员的供给态若应挡住唤醒则返回该状态字符串
 * （provisioning/failed/removed），否则 undefined（放行）。团队不存在/成员不在册/
 * 读盘失败 → 放行（与 v0.1.0 行为一致；门控是增量保护，不是新的失败面）。
 * W2 的 state 可选字段按 §6.5 宽容语义读取（缺省 "ready"=放行，旧花名零行为变化）。
 */
async function memberWakeGateState(stateRoot: string, teamId: string, agentKey: string): Promise<string | undefined> {
  try {
    const team = await readTeam(stateRoot, teamId);
    if (team === undefined) return undefined;
    const member = team.members.find((m) => m.key === agentKey);
    if (member === undefined) return undefined;
    const state = (member as { state?: string }).state ?? "ready";
    if (state === "provisioning" || state === "failed" || state === "removed") return state;
    return undefined;
  } catch {
    return undefined; // team.json 损坏等：门控尽力而为，唤醒路径不受阻
  }
}

/**
 * 推送唤醒编排（DESIGN §2.5；**必须在团队锁外调用**——慢操作 spawn 不持锁，§2.7-4；
 * 本函数内部对邮箱的补盖章会各自短暂重取锁，调用方持锁时调用会死锁）：
 *
 * 1. enabled 判定（V7：非 "true" 关，原始值记 engine.jsonl）；
 * 2. 属主缺席约束（§2.5-2，见 DeliveryDecisionInput.ownerAbsent）；
 * 3. 在途 nonce 去重（M1 registry 扫 registry/wake/，TTL=15min，§2.5-3）；
 * 3.5 v0.2 成员状态门控（§6.3/§7.3.3）：目标 state ∈ {provisioning, failed, removed}
 *     → 只入箱不唤醒（nonce 落盘之前判定，跳过路径不留 15min 在途标记）；
 * 4. 写一次性 nonce（M1 createWakeNonce，兼在途标记）→ 盖投递租约（M1 claim，60s，尽力而为）；
 * 5. buildWakePrompt（守则附加按 WAKE_RULES_SCENES 白名单）→ spawnResume（helper 孤儿化，
 *    W1；stdout/stderr→logs/wake-<to>-<ts>.json）；
 * 6. spawn 成功 → markDelivered（dsh tools.js:2150 对应物）+ engine.jsonl {event:"wake", pid}；
 *    helper 汇报唤醒子 pid → engine.jsonl {event:"wake-child", pid}（§4.2 审计）；
 *    spawn 同步失败 → release 租约（state.js:489-496 对应物）+ engine.jsonl wake-failed，
 *    降级 mailbox——消息留邮箱，pull 兜底，租约到期后可重试（§2.5 mailbox 行）。
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

  // 1+2. 开关与属主约束（不碰磁盘先判，避免无谓的 registry 扫描）。
  const pre = decideDelivery({ wakeEnabledRaw: rawFlag, ownerAbsent: req.ownerAbsent, inflight: false });
  if (pre.mode !== "wake") {
    await logEngineEvent(stateRoot, {
      event: "wake-skipped", reason: pre.reason, scene: req.reason, teamId: req.teamId, to: toKey,
      rawWakeEnabled: rawFlag ?? null,
    });
    return { delivered: "mailbox", note: pre.reason };
  }

  // 3. 在途 nonce 去重（§2.5-3）。
  const inflight = await findInflightWakeNonce(stateRoot, toKey, { teamId: req.teamId, now });
  if (inflight !== undefined) {
    const d = decideDelivery({ wakeEnabledRaw: rawFlag, ownerAbsent: req.ownerAbsent, inflight: true });
    await logEngineEvent(stateRoot, {
      event: "wake-skipped", reason: d.reason, scene: req.reason, teamId: req.teamId, to: toKey,
      inflightNonce: inflight.token,
    });
    return { delivered: "mailbox", note: d.reason };
  }

  // 3.5 v0.2 成员状态门控（DESIGN-V0.2 §6.3 双向门控 + §7.3.3「E-a/E-b/E-c 唤醒路径
  // 检查 state」）：provisioning/failed/removed 的成员只入箱、不唤醒——provisioning
  // 期间 resume 会与 app-server 持有并发（V5 未验证区）；removed 成员不再被唤醒。
  // 位置在 createWakeNonce **之前**：跳过路径不落 nonce，避免 15min 在途标记挡住
  // 供给完成后的 E-e 投产唤醒。团队不存在/成员不在册 → 与 v0.1.0 行为一致（放行）；
  // W2 的 state 可选字段以 §6.5 宽容语义读取（缺省 "ready"=放行，旧数据零行为变化）。
  const gateState = await memberWakeGateState(stateRoot, req.teamId, toKey);
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

  // 4. 写一次性 nonce（兼在途标记）+ 盖投递租约（尽力而为）。
  const { token } = await createWakeNonce(stateRoot, {
    teamId: req.teamId, agentKey: toKey, sid: req.toSessionId, now,
  });
  const ids = [...req.receiptIds];
  await withLockBestEffort(stateRoot, req.teamId, () =>
    claimMailboxDelivery(stateRoot, req.teamId, toKey, ids, now));

  // 5. prompt + spawn（fire-and-forget）。守则附加按场景白名单（v0.2 §9.1 白名单兼容）。
  const prompt = buildWakePrompt({
    teamId: req.teamId,
    recipientKey: toKey,
    recipientSessionId: req.toSessionId,
    wakeToken: token,
    receiptIds: ids,
    bodyText: req.ticket,
    includeMemberRules: includeRulesForScene(req.reason),
  });
  const logFile = wakeLogFile(stateRoot, toKey, now);
  const releaseOnFailure = async (where: string, err: unknown): Promise<void> => {
    await withLockBestEffort(stateRoot, req.teamId, () =>
      releaseMailboxDelivery(stateRoot, req.teamId, toKey, ids));
    // 同步/异步 spawn 失败=没有真正的唤醒在途：立即消费 nonce，别让 15min 在途标记
    // 挡住租约（60s）承诺的重试资格（§2.5 mailbox 行"投递租约到期后可重试"）。
    try {
      await consumeWakeNonce(stateRoot, token, { teamId: req.teamId, agentKey: toKey, sid: req.toSessionId }, now);
    } catch {
      /* 尽力而为 */
    }
    await logEngineEvent(stateRoot, {
      event: "wake-failed", where, error: String(err), scene: req.reason, teamId: req.teamId,
      to: toKey, nonce: token,
    });
  };
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
      onHelperSpawned: (childPid) => {
        void logEngineEvent(stateRoot, {
          event: "wake-child", pid: childPid, scene: req.reason, teamId: req.teamId, to: toKey, nonce: token,
        });
      },
    });
    pid = spawned.pid;
  } catch (err) {
    await releaseOnFailure("spawn", err);
    return {
      delivered: "mailbox",
      note: `spawn-failed: ${err instanceof Error ? err.message : String(err)}（消息留邮箱，pull 兜底，租约到期可重试）`,
      wakeLog: logFile,
      receiptIds: ids,
    };
  }

  // 6. 成功：markDelivered（已启动投递传输；消费与否由 readAt 说话，§2.1）+ 审计。
  await withLockBestEffort(stateRoot, req.teamId, () =>
    markMailboxDelivered(stateRoot, req.teamId, toKey, ids, now));
  await logEngineEvent(stateRoot, {
    event: "wake", scene: req.reason, teamId: req.teamId, to: toKey, pid, nonce: token,
    wakeLog: logFile, receiptIds: ids,
  });

  // v0.5.1（FI-7/故障注-7）：spawn 成功只代表「唤醒已发起」，不代表送达——helper 孤儿化后
  // 本进程拿不到子进程退出码，子进程 --resume 失败（如 Session not found）只会落进 wake
  // 日志。红队实测：回执宣称 delivered=wake「已发起」而唤醒链实际失败，engine.jsonl 无任何
  // 失败标记（adjudication.md #15）。这里对 wake 日志做**有界失败侦听**：窗口内轮询日志，
  // 只认正向失败证据（findWakeFailureEvidence），命中 → wake-failed{where:"wake-child"} +
  // 释放投递租约 + 消费 nonce（pull 立即可见消息、重试不被 15min 在途标记挡住）；窗口静默
  // → 不表态（成功回合可能远超窗口，日志与 pull 仍是真源）。定时器全部 unref，不拖进程。
  const watchWindowMs = req.watchWindowMs ?? WAKE_WATCH_WINDOW_MS;
  const watchPollMs = req.watchPollMs ?? WAKE_WATCH_POLL_MS;
  if (watchWindowMs > 0 && watchPollMs > 0) {
    const pollTimer = setInterval(() => {
      let text = "";
      try {
        text = readFileSync(logFile, "utf8");
      } catch {
        return; // 日志尚未出现（子进程还没写）→ 继续等
      }
      const evidence = findWakeFailureEvidence(text);
      if (evidence === undefined) return;
      clearInterval(pollTimer);
      void releaseOnFailure("wake-child", evidence).catch(() => undefined);
    }, watchPollMs);
    pollTimer.unref?.();
    const stopTimer = setTimeout(() => clearInterval(pollTimer), watchWindowMs);
    stopTimer.unref?.();
  }

  // v0.5.1（FI-7）：回执语义真实化——delivered:"wake" 是契约态（push 已发起），note 必须
  // 写明「非送达确认」，并标注 zcode 路径的自动探测回落（红队形态：env 配置的 exe/cjs
  // 文件不存在，探测静默改用本机安装——回执只字不提，lead 无从得知唤醒通道已回落）。
  return {
    delivered: "wake",
    note:
      "spawned: 无头 --resume 已发起（fire-and-forget，非送达确认；" +
      "失败由引擎侦听 wake 日志自动检测并记 engine.jsonl wake-failed、释放投递租约，消息以邮箱 pull 兜底）"
      + wakeFallbackNote(req.env, resolvedCfg),
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
