/**
 * M2 wake-engine —— 推送唤醒：delivered 三态决策、回执/身份行/wakeToken/任务票 prompt 组装
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
import { logEngineEvent } from "../core/log";
import { withTeamLock } from "../core/lock";
import { wakeLogFile } from "../core/paths";
import {
  consumeWakeNonce,
  createWakeNonce,
  findInflightWakeNonce,
  WAKE_INFLIGHT_MS,
} from "../core/registry";
import { sanitizeKey } from "../core/sanitize";
import type { TeamMessage, TeamState } from "../core/types";
import { spawnResume, wakeSpawnConfigFromEnv, type WakeSpawnConfig } from "./resume-cli";

/** 在途唤醒窗口（DESIGN §2.5-3）——唯一定义处是 M1 core/registry，此处转出口。 */
export { WAKE_INFLIGHT_MS };
/** 唤醒 prompt 上限（DESIGN §2.5"任务票截断"）。 */
export const WAKE_PROMPT_MAX_CHARS = 4000;

/** delivered 三态（DESIGN §2.5 表；dsh 的 live 态在 zcode 无对等 steer，弃用）。 */
export type DeliveredMode = "wake" | "mailbox" | "duplicate";

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

/** 成员守则摘要（DESIGN §4.2：移植 dsh memberPersona capabilities.js:9 思想）。 */
const MEMBER_RULES = [
  "成员守则（摘要）：",
  "1) 先 xc_register（本 prompt 已给出 name/sessionId/wakeToken），再 xc_check_inbox 读取回执消息；",
  "2) xc_claim 认领任务 → 执行 → xc_report(completed|failed, 必须带 result 与 evidence≥1) → 结束回合；",
  "3) xc_claim 失败（任务已被他人认领）→ 立即 xc_check_inbox 看是否还有其他未读，没有则直接结束回合——不得重试同一任务、不得 busy-poll；",
  "4) stale attempt（attemptId 不匹配）立即停手；工具返回 error:\"busy\" 稍后重试一次，仍忙则结束回合。",
].join("\n");

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
  const rules = input.includeMemberRules === true ? MEMBER_RULES : undefined;

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
  /** 唤醒场景标签（dispatch/report/message…；进 engine.jsonl）。 */
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
  /** 测试注入：spawn 配置（默认 wakeSpawnConfigFromEnv(req.env)）。 */
  cfg?: WakeSpawnConfig;
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
 * 推送唤醒编排（DESIGN §2.5；**必须在团队锁外调用**——慢操作 spawn 不持锁，§2.7-4；
 * 本函数内部对邮箱的补盖章会各自短暂重取锁，调用方持锁时调用会死锁）：
 *
 * 1. enabled 判定（V7：非 "true" 关，原始值记 engine.jsonl）；
 * 2. 属主缺席约束（§2.5-2，见 DeliveryDecisionInput.ownerAbsent）；
 * 3. 在途 nonce 去重（M1 registry 扫 registry/wake/，TTL=15min，§2.5-3）；
 * 4. 写一次性 nonce（M1 createWakeNonce，兼在途标记）→ 盖投递租约（M1 claim，60s，尽力而为）；
 * 5. buildWakePrompt → spawnResume（detached+unref，stdout/stderr→logs/wake-<to>-<ts>.json）；
 * 6. spawn 成功 → markDelivered（dsh tools.js:2150 对应物）+ engine.jsonl {event:"wake", pid}；
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

  // 4. 写一次性 nonce（兼在途标记）+ 盖投递租约（尽力而为）。
  const { token } = await createWakeNonce(stateRoot, {
    teamId: req.teamId, agentKey: toKey, sid: req.toSessionId, now,
  });
  const ids = [...req.receiptIds];
  await withLockBestEffort(stateRoot, req.teamId, () =>
    claimMailboxDelivery(stateRoot, req.teamId, toKey, ids, now));

  // 5. prompt + spawn（fire-and-forget）。
  const prompt = buildWakePrompt({
    teamId: req.teamId,
    recipientKey: toKey,
    recipientSessionId: req.toSessionId,
    wakeToken: token,
    receiptIds: ids,
    bodyText: req.ticket,
    includeMemberRules: req.reason === "dispatch",
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
  try {
    const spawned = (req.spawn ?? spawnResume)({
      cfg: req.cfg ?? wakeSpawnConfigFromEnv(req.env),
      sessionId: req.toSessionId,
      prompt,
      cwd: req.workspace,
      logFile,
      onAsyncError: (err) => {
        void releaseOnFailure("async", err);
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
  return {
    delivered: "wake",
    note: "spawned: 无头 --resume 已发起（fire-and-forget）",
    wakeLog: logFile,
    pid,
    receiptIds: ids,
    nonce: token,
  };
}
