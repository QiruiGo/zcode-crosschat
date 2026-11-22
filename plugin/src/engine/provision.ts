/**
 * W2 member-engine —— 成员供给（DESIGN-V0.2.md §6.2 四步 + §6.4 幂等重供给）。
 *
 * 供给在 lead 的 MCP server 进程内**同步**执行（D2：app-server 四步 + 欢迎回合等待，
 * 不做异步常驻建员引擎）；瞬态 keeper（appserver.ts）随调用消亡，持久化依据 P4
 * （session/send accept 后 ≤3s 落库，硬杀不丢——FEASIBILITY §3.1-3 实测）。
 *
 * 四步（每步实测依据见 §6.2 表）：
 *   ① create  session/create {workspace, mode:"yolo", titleGenerationEnabled:false}（E4）
 *   ② setModel 枚举 create 结果 settings.model.available[].ref（P1）→ 命中 XC_MEMBER_MODEL
 *             否则首个 → session/setModel（E4：回合 modelId=glm-5.3-flash 即生效实据）
 *   ③ 欢迎 send session/send（welcome prompt = 身份行 + 引擎签发 wakeToken + 守则 v2 摘要 +
 *             「无单直接结束回合、不发 idle 通知」——R1 修正，§6.2 ③/§6.3）
 *   ④ 等待+收尾 轮询 session/messages（4s 间隔，超时 XC_MEMBER_BOOTSTRAP_TIMEOUT_MS 默认
 *             300s）；完成判定 = P2 过滤（assistant ∧ finish∈{completed,stop} ∧ ≥1 text part）
 *
 * 幂等重供给（§6.4）：mode="auto" 时 names.json 已绑定该名 ∧ session/messages 可读
 * （P4 反向应用：send 过即落库）→ 跳过 create 改走 session/resume（wake-chain-run.mjs:105
 * 实测）+ setModel + 重发欢迎；半程死亡（create 后未 send）→ 探针不可读 → 全新 create。
 *
 * 并发红线（§4.4/§6.3）：供给期间成员处于 provisioning 态，对其派发只投邮箱不唤醒
 * （member-tools 负责）；本模块从不 resume 一个正被其他 keeper 持有的会话——keeper
 * 生命周期被限制在单次 provisionMember 调用内。
 *
 * 本模块的磁盘纪律：wakeToken nonce 写入是既有例外（registry/wake/<token>.json，
 * 与 v0.1.0 attemptWake 同款新文件原子写）；roster/names 的正式变更由 member-tools 在
 * registry→team 锁序内完成。v0.9.8（D2/V097-07）新增第二条例外：**供给失败路径**经
 * core/teamstate.ts 的 repoolUnclaimedTasksForFailedMember 把该成员未认领单回池并
 * 通知创建者（团队锁内读-改-写的状态自愈，repairTeamState 同族；幂等且 IO 失败只
 * 记审计不抛）——没有它，provisioning 期间收到的派发单在失败后永久搁浅。
 */

import { DEFAULT_TEAM_ID } from "../core/types.js";
import { createWakeNonce, readNames } from "../core/registry.js";
// v0.7.1（故障注-1 修复）：超时默认值与 env 解析迁入 core/teamstate.ts（provisioning
// deadline 的清扫方含钩子，钩子只能 import M1）；此处 import 自用并按原路径转出，
// 既有导入方（tools-team.ts 等）不变。
import { bootstrapTimeoutFromEnv, repoolUnclaimedTasksForFailedMember } from "../core/teamstate.js";
// v0.7.1 起的原路径转出（既有导入方 tools-team.ts 等）不动。
export {
  DEFAULT_MEMBER_BOOTSTRAP_TIMEOUT_MS,
  bootstrapTimeoutFromEnv,
} from "../core/teamstate.js";
import { logEngineEvent } from "../core/log.js";
import type { ToolDeps } from "../mcp/core.js";
import { AppServerKeeper, type ModelRef } from "./appserver.js";
import { resolveZcodeSpawnConfig } from "./zcode-locate.js";
// 守则 v2 全文由 W3 交付于 wake.ts（DESIGN-V0.2.md §9.2 钉死导出 MEMBER_RULES_V2）；
// 这是设计依赖表「provision import wake 场景常量」的落点（§9.1）。
// v0.9.6（R1②）：票据显式回收助手（供给失败留票不再压制派单）+ 回收原因常量。
import { MEMBER_RULES_V2, revokeWakeNonceForProvisionFailure, WAKE_NONCE_REVOKE_PROVISION_FAILED } from "./wake.js";

/**
 * 供给模式（§6.4 的实现入口）：
 * - "fresh"：总是全新 create（xc_team member-stop 后同名重加 = 新成员生命周期）；
 * - "auto"（默认）：§6.4 幂等重供给——names.json 已绑定 ∧ session/messages 可读 →
 *   session/resume 续用；否则全新 create（半程死亡自愈）。
 */
export type ProvisionMode = "fresh" | "auto";

/** provisionMember 入参（DESIGN-V0.2.md §9.2 钉死形状 + mode 扩展）。 */
export interface ProvisionSpec {
  /** 成员 key（调用方已 sanitizeKey）。 */
  key: string;
  /** 模型 id 覆盖；缺省用 XC_MEMBER_MODEL，再缺省用枚举首个（§6.2 步骤②）。
   *  v0.9.4（A7）：显式指定（本参数或 XC_MEMBER_MODEL）而枚举里匹配不到 → 显式报错
   *  （附可用 modelId 列表），不再静默取枚举首个。 */
  model?: string;
  /** 推理档位覆盖；缺省用 XC_MEMBER_REASONING，再缺省取模型自报缺省档
   *  （`reasoning.defaultLevel`）或档位表末位，最后 "max"（v0.9.7 W1）。 */
  reasoningLevel?: string;
  /** 供给模式（缺省 "auto"，见上）。 */
  mode?: ProvisionMode;
}

/** provisionMember 结果（DESIGN-V0.2.md §9.2 钉死形状；turn* 两列为 V13 验证点服务）。 */
export interface ProvisionResult {
  sessionId: string;
  providerId: string;
  modelId: string;
  /** **实际生效**的档位（R2：降级后如实披露；省略时为 "(model-default)"）。 */
  reasoningLevel: string;
  /** 欢迎回合最后一轮助手文本（P2 过滤后）。 */
  welcomeResponse: string;
  /** true = 走了 session/resume 续用旧会话（§6.4）。 */
  reprovisioned: boolean;
  /** 欢迎回合实际使用的模型（E4 手法：回读校验 setModel 生效，V13）。 */
  turnModelId?: string;
  turnProviderId?: string;
  /**
   * v0.9.6（R2）：档位降级记录（from=所配档位，to=实际生效档位；省略时 to=
   * "(model-default)"）——只在「档位不被支持」时出现（正常供给不降级）。
   */
  reasoningFallback?: { from: string; to: string };
}

/** 供给失败（step ∈ create/model/token/setModel/welcome/send）；member-tools 映射为 member_provision_failed。 */
export class ProvisionError extends Error {
  readonly step: string;
  /**
   * v0.9.6（R1②）：供给失败时**本 attempt 签发票据的回收证据**（结构化字段，不受
   * 失败回执 detail 500 字符截断影响；文本通道另有回收句附加在 message 尾部）。
   * undefined = 失败发生在票据签发前或回收未发生（票已消费/IO 失败）。
   */
  readonly nonceRevocation?: { reason: string; nonce: string };

  constructor(step: string, message: string, nonceRevocation?: { reason: string; nonce: string }) {
    super(message);
    this.name = "ProvisionError";
    this.step = step;
    this.nonceRevocation = nonceRevocation;
  }
}

/** 欢迎回合 prompt（§6.2 ③：身份行 + 引擎签发 wakeToken + 守则 v2 + R1「无单不发 idle」）。 */
export function buildWelcomePrompt(input: {
  teamId: string;
  key: string;
  sessionId: string;
  wakeToken: string;
}): string {
  return [
    `你是 zcode-crosschat 团队 "${input.teamId}" 的成员 "${input.key}"（sessionId=${input.sessionId}）。` +
      `本连接由团队引擎创建；引擎已为本次供给签发一次性 wakeToken="${input.wakeToken}"。`,
    "请严格按以下顺序执行，不要做其他任何事：",
    `1) 调用 xc_identify 绑定身份：name 填 "${input.key}"，sessionId 填 "${input.sessionId}"，` +
      `wakeToken 填 "${input.wakeToken}"；`,
    "2) 调用 xc_read({scope:\"inbox\"}) 读取未读消息；",
    "3) 若有未读任务/通知：按下方成员守则开工；若没有：本回合是欢迎回合——直接结束回合，" +
      "不要调用 xc_team({action:\"idle\"})，你的就绪状态由引擎写入的花名册（state=ready）表达。",
    MEMBER_RULES_V2,
  ].join("\n");
}

/** 从 session/create 结果提取 sessionId（dm-create.mjs:125-126 同款三位置 + "unknown" 防御）。 */
function extractSessionId(createResult: unknown): string {
  const record = (createResult ?? {}) as Record<string, unknown>;
  const candidates = [
    (record["session"] as Record<string, unknown> | undefined)?.["sessionId"],
    record["sessionId"],
    (record["projection"] as Record<string, unknown> | undefined)?.["sessionId"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "" && candidate !== "unknown") {
      return candidate;
    }
  }
  throw new ProvisionError(
    "create",
    `session/create: no sessionId in ${JSON.stringify(createResult)?.slice(0, 300)}`,
  );
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}

/** 可用 modelId 列表的展示上限（回执 detail 另有 500 字符截断，这里先防刷屏）。 */
const MODEL_LIST_DISPLAY_MAX = 20;

/**
 * v0.9.6（R2）：**有界降级顺序**——所配档位不被 provider/模型支持时依序重试；
 * `""` = 省略（setModel 不传 options.reasoningLevel，CLI 侧「use the default (the
 * highest level)」，即模型自身档位表的最高档）。顺序钉死 high → medium → 省略
 *（LIMITATIONS 第 25 条口径），不做 env 化（校准参数而非运维旋钮）。
 */
export const REASONING_FALLBACK_ORDER: readonly string[] = ["high", "medium", ""];

/**
 * v0.9.6（R2）：**可辨认的档位名**（zcode CLI 档位族 `minimal/low/medium/high/xhigh`
 * + 现行缺省别名 `max`）。显式传入不在此列的档位（如 "banana"）= 非法档位：显式报错，
 * **不静默降级**（LIMITATIONS 第 25 条口径；与 v0.9.4 A7「显式 model 匹配不到 → 显式
 * 报错」同一哲学——配置错误必须可见，不得被呈现成「用了一个别的档位」）。
 */
export const KNOWN_REASONING_TIERS: readonly string[] = [
  "minimal", "low", "medium", "high", "xhigh", "max",
];

/** 省略档位（不传 reasoningLevel）时的**展示名**（回执/审计用；CLI 侧 = 模型默认档）。 */
export const REASONING_OMITTED_LABEL = "(model-default)";

/**
 * v0.9.6（R2）：按模型**声明的档位表**解析降级目标（纯函数，单测直测）——
 * 声明表里依序找 {@link REASONING_FALLBACK_ORDER} 中第一个被声明的档位；都不在表里
 * → 省略（""，模型默认 = 最高声明档）。声明表为空（模型未声明）→ undefined
 * （无判据，不猜——由 setModel 失败重试链兜底）。
 */
export function resolveReasoningFallbackTarget(
  declaredLevels: readonly string[],
): string | undefined {
  if (declaredLevels.length === 0) return undefined;
  for (const candidate of REASONING_FALLBACK_ORDER) {
    if (candidate === "") return ""; // 省略永远可达（不依赖声明表）
    if (declaredLevels.includes(candidate)) return candidate;
  }
  return "";
}

/** 模型选择（§6.2 步骤②：provider 过滤 → model 精确命中否则首个；档位显式优先，
 * 缺省取模型自报缺省档/表末位兜底——v0.9.7 W1）。
 *
 * v0.9.9（V098-13）：缺省路径的「首个」= **create 池首**——keeper 的模型池序按来源
 * 分层（appserver.ts {@link AppServerKeeper.getModels}：create 来源条目恒在前、纯
 * state.updated 兜底条目在后），不再取决于兜底流与 create 流的到达顺序；两流乱序
 * 到达 → 本函数的缺省 pick 与供给结果稳定。
 *
 * v0.9.8（D1/V097-01）：缺省路径的档位名与模型**声明表**交叉校验——自报缺省档不在
 * 声明表里 → 回退表末位 + `reasoningFallback{from,to}`（调用方落
 * `member-reasoning-fallback` 审计），不把错档发给 setModel 首试。
 *
 * v0.9.4（A7）：**显式 model 匹配不到 → 显式报错**（附可用 modelId 列表），不再静默取
 * 枚举首个。旧行为（`?? pool[0]!`）把「配错了 model」呈现成「用了一个别的模型」：
 * 建员回执写的还是请求的 model 名（ProvisionResult.modelId 取 chosen），调用方无从
 * 知道实际跑的不是他要的那个——红队/验收口径的「静默回落」同款缺陷（v0.5.3 A5 的
 * spawn 配置回落、v0.9.1 V090-04 的 boundName 自签都循此收口）。入参 preferModel 的
 * 两个来源（member-add 的 model 参数 / XC_MEMBER_MODEL 配置）都是**显式意图**，
 * 同一把闸；未传（undefined/空白）= 没有意图，维持「枚举首个」缺省。
 */
export function pickModel(
  models: readonly ModelRef[],
  options: { preferModel?: string; preferProvider?: string; preferReasoning?: string },
): {
  providerId: string;
  modelId: string;
  reasoningLevel: string;
  /** v0.9.6（R2）：所配档位不被支持时的降级记录（from=所配，to=实际生效；""=省略）。 */
  reasoningFallback?: { from: string; to: string };
} {
  if (models.length === 0) {
    throw new ProvisionError(
      "model",
      "app-server 未枚举到任何可用模型：请确认已登录且存在可用 provider，或显式设置 member_model",
    );
  }
  let pool = models;
  if (options.preferProvider !== undefined) {
    const filtered = models.filter((m) => m.providerId === options.preferProvider);
    if (filtered.length > 0) pool = filtered;
  }
  const preferModel = options.preferModel?.trim();
  const pickLevel = (hit: ModelRef): { reasoningLevel: string; reasoningFallback?: { from: string; to: string } } => {
    const levels = hit.reasoningLevels;
    // v0.9.7（W1/R2）：缺省路径的取档顺序 = **模型自报缺省档**（真实形状
    // `reasoning.defaultLevel`）→ 档位表末位 → "max"。
    // 旧实现只有后两档，且真实形状下档位表恒空（appserver collectModelRefs 不认
    // `ref.*` 与 `{value,label}` 档位，42-v096 real-smoke C 根因）→ 缺省恒落 "max" →
    // 只声明 low/medium/high 的 step-5-preview 首试 setModel 失败（R2 残留）。
    // 现在缺省配置首试即取 defaultLevel（step-5-preview 实测 defaultLevel="high"，
    // 与其档位表末位一致）：0 次失败重试。
    //
    // v0.9.8（D1/V097-01）：**档位名与声明表交叉校验**——自报缺省档不在模型自己的
    // 声明表里（枚举数据自相矛盾；权威合并前的陈旧兜底流也曾把错档锁进来）→ 回退
    // 档位表末位并记 reasoningFallback，由 provision 侧落
    // `member-reasoning-fallback{from,to}` 审计（「错档注入 → 审计/回退」的验收
    // 口径）；不发一个声明表里没有的档位去赌 setModel 首试。声明表为空（模型未
    // 声明）时无判据可交叉，维持原样（setModel 重试链兜底）。
    const fallbackFromTable = (): { reasoningLevel: string; reasoningFallback?: { from: string; to: string } } => {
      const declaredDefault = hit.defaultReasoningLevel?.trim();
      if (declaredDefault !== undefined && declaredDefault !== "") {
        if (levels.length === 0 || levels.includes(declaredDefault)) {
          return { reasoningLevel: declaredDefault };
        }
        const target = levels[levels.length - 1]!;
        return {
          reasoningLevel: target,
          reasoningFallback: { from: declaredDefault, to: target },
        };
      }
      return { reasoningLevel: levels.length > 0 ? levels[levels.length - 1]! : "max" };
    };
    const preferReasoning = options.preferReasoning;
    if (preferReasoning === undefined || preferReasoning.trim() === "") {
      // 未配置 = 没有意图：模型自报缺省档 → 档位表末位（最高声明档）→ "max"；
      // v0.9.8（D1）起自报缺省档先与声明表交叉校验，非法即回退并记降级（审计）。
      return fallbackFromTable();
    }
    // v0.9.6（R2）：显式**非法档位**（不是可辨认的档位名）→ 显式报错，不静默降级。
    if (!KNOWN_REASONING_TIERS.includes(preferReasoning.trim())) {
      throw new ProvisionError(
        "model",
        `reasoningLevel "${preferReasoning.trim()}" 不是合法档位（可辨认档位：${KNOWN_REASONING_TIERS.join(", ")}）。`
        + "显式非法档位显式报错、不静默降级（LIMITATIONS 第 25 条）——请修正 member-add 的 reasoningLevel 参数或 member_reasoning(XC_MEMBER_REASONING) 配置。",
      );
    }
    // v0.9.6（R2）：档位**不被模型声明**（不支持）→ 按有界顺序降级（high → medium →
    // 省略），落 reasoningFallback 由调用方审计（member-reasoning-fallback{from,to}）+
    // 回执披露实际生效档位。R1 根因（userConfig 缺省 "max" vs step-5-preview 只声明
    // ["low","high"]）在此首试即降级——不再有 setModel 首试失败（41-v095 real-smoke A）。
    if (levels.length > 0 && !levels.includes(preferReasoning)) {
      const target = resolveReasoningFallbackTarget(levels);
      // target===undefined（模型未声明档位表）不降级（无判据，setModel 重试链兜底）；
      // target 与所配相同（声明表恰好含所配档）不会走到本分支。
      if (target !== undefined && target !== preferReasoning) {
        return {
          reasoningLevel: target,
          reasoningFallback: {
            from: preferReasoning,
            to: target === "" ? REASONING_OMITTED_LABEL : target,
          },
        };
      }
    }
    return { reasoningLevel: preferReasoning };
  };
  if (preferModel !== undefined && preferModel !== "") {
    const hit = pool.find((m) => m.modelId === preferModel);
    if (hit === undefined) {
      const available = [...new Set(pool.map((m) => m.modelId))];
      const shown = available.slice(0, MODEL_LIST_DISPLAY_MAX).join(", ");
      const more = available.length > MODEL_LIST_DISPLAY_MAX
        ? `…等 ${available.length} 个`
        : "";
      throw new ProvisionError(
        "model",
        `member model "${preferModel}" 在 app-server 枚举结果中不存在`
        + (options.preferProvider !== undefined ? `（provider 过滤 "${options.preferProvider}" 后）` : "")
        + `：可用 modelId = ${shown}${more}。`
        + "不再静默取枚举首个——请修正 member-add 的 model 参数或 member_model(XC_MEMBER_MODEL) 配置"
        + "（可用列表也可经 xc_doctor 查看）。",
      );
    }
    const level = pickLevel(hit);
    return { providerId: hit.providerId, modelId: hit.modelId, ...level };
  }
  const chosen = pool[0]!;
  const level = pickLevel(chosen);
  return { providerId: chosen.providerId, modelId: chosen.modelId, ...level };
}

interface AssistantTurn {
  finish: string | undefined;
  modelId: string | undefined;
  providerId: string | undefined;
  text: string;
}

/**
 * v0.4（DESIGN-V0.4 §2.6-1）：建员模型回合失败 → 失败回执附本次尝试的模型与 member_model
 * 填写指引（硬标准 2：失败给明确指引而非静默）。ProvisionError 保留原 step，
 * 其他错误按 fallbackStep 包装；只追加信息，不吞错、不改变失败判定。
 */
function withModelGuidance(
  err: unknown,
  chosen: { providerId: string; modelId: string },
  fallbackStep: string,
): ProvisionError {
  const base = err instanceof ProvisionError
    ? err
    : new ProvisionError(fallbackStep, String((err as Error)?.message ?? err));
  return new ProvisionError(
    base.step,
    `${base.message} 本次尝试模型 "${chosen.modelId}"（provider "${chosen.providerId}"）；` +
      "若该模型不可用，请在插件设置 member_model 显式指定，可用模型见建员结果/xc_doctor 提示。",
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 读会话消息 → P2 过滤后的助手回合（assistant ∧ finish∈{completed,stop} ∧ ≥1 text part）。
 * P2（FEASIBILITY §4）：timeline 事件消息无文本 parts，不做文本过滤会把「回合完成」
 * 判早，真实回合被 app-server 退出腰斩——baseline 与 done 两处都必须过滤。
 */
async function readAssistantTurns(keeper: AppServerKeeper, sessionId: string): Promise<AssistantTurn[]> {
  const res = asRecord(await keeper.request("session/messages", { sessionId }));
  const messages = Array.isArray(res["messages"]) ? res["messages"] : [];
  const turns: AssistantTurn[] = [];
  for (const raw of messages) {
    const message = asRecord(raw);
    const info = asRecord(message["info"]);
    if (info["role"] !== "assistant") continue;
    const parts = Array.isArray(message["parts"]) ? message["parts"] : [];
    const text = parts
      .map((part) => asRecord(part))
      .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
      .map((part) => part["text"] as string)
      .join("\n");
    turns.push({
      finish: typeof info["finish"] === "string" ? info["finish"] : undefined,
      modelId: typeof info["modelId"] === "string" ? info["modelId"] : undefined,
      providerId: typeof info["providerId"] === "string" ? info["providerId"] : undefined,
      text,
    });
  }
  return turns;
}

function isCompleteTurn(turn: AssistantTurn): boolean {
  return (turn.finish === "completed" || turn.finish === "stop") && turn.text.trim() !== "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 供给一个成员（四步 + 幂等重供给）。抛出 ProvisionError（step 标明失败步骤）；
 * keeper 任何退出路径都被 kill()（finally），P4 保证已 send 的会话不丢。
 */
export async function provisionMember(deps: ToolDeps, spec: ProvisionSpec): Promise<ProvisionResult> {
  const teamId = DEFAULT_TEAM_ID;
  const bootTimeoutMs = bootstrapTimeoutFromEnv(deps.env);
  const preferModel = spec.model ?? optionalEnv(deps.env, "XC_MEMBER_MODEL");
  const preferProvider = optionalEnv(deps.env, "XC_MEMBER_PROVIDER");
  const preferReasoning = spec.reasoningLevel ?? optionalEnv(deps.env, "XC_MEMBER_REASONING");
  const mode = spec.mode ?? "auto";

  // v0.4（DESIGN-V0.4 §2.4）：spawn 配置解析改为「env → 自动探测」。
  const spawnCfg = resolveZcodeSpawnConfig(deps.env);
  // v0.5.3（A5 修复）：显式配置（XC_ZCODE_EXE/XC_ZCODE_CJS）无效 → 立即失败，绝不
  // 经自动探测回落建真会话（红队 a5：静默回落烧账号额度）；ProvisionError 的 message
  // 即配置错误根因（含无效路径），member_provision_failed 回执 detail 原样携带——
  // 失败诊断不再误导用户去查 member_model。
  if (spawnCfg.outcome.configError !== undefined) {
    throw new ProvisionError("spawn", spawnCfg.outcome.configError);
  }
  let keeper: AppServerKeeper;
  try {
    keeper = AppServerKeeper.start({
      cfg: spawnCfg,
      env: deps.env,
      // appserver.ts 协议事实（PLATFORM §4.3-4 / FEASIBILITY E4 实测）：session/create 过程中
      // 必须应答回调 session/requestRuntimePreferences（15s 超时坑）；
      // interaction/requestOfficialMcpAuthHeaders 回 {} 被接受（demo/bootstrap-sessions.mjs:106-109）。
      callbacks: {
        "session/requestRuntimePreferences": () => ({ nativeSearchEnhancementsEnabled: false }),
        "interaction/requestOfficialMcpAuthHeaders": () => ({}),
      },
    });
  } catch (err) {
    // v0.4（DESIGN-V0.4 §2.4）：失败回执附探测指引（硬标准 2）——member_provision_failed
    // 不再只有一句「未配置」。
    throw new ProvisionError("spawn", `${String((err as Error)?.message ?? err)} ${spawnCfg.outcome.guidance}`);
  }
  // v0.9.6（R1②）：票据与 sid 提升到外层作用域——失败回收（catch）需要它们；
  // 票据签发前的失败（create 等）token=undefined，catch 跳过回收（无可回收）。
  let sessionId = "";
  let token: string | undefined;
  try {
    // ---- ① create（或 §6.4 resume 续用）----
    let reprovisioned = false;
    let createResult: unknown;
    if (mode === "auto") {
      const binding = (await readNames(deps.stateRoot))[spec.key];
      if (binding !== undefined && binding.sessionId.trim() !== "") {
        // 轻量探针（§6.4）：session/messages 可读即 db 会话存在（P4 反向应用）。
        if (await keeper.probeSession(binding.sessionId)) {
          await keeper.request(
            "session/resume",
            {
              sessionId: binding.sessionId,
              workspace: { workspacePath: deps.workspace, workspaceKey: deps.workspace },
            },
            60_000,
          );
          sessionId = binding.sessionId;
          reprovisioned = true;
        }
      }
    }
    if (sessionId === "") {
      createResult = await keeper.request(
        "session/create",
        {
          workspace: { workspacePath: deps.workspace, workspaceKey: deps.workspace },
          mode: "yolo",
          titleGenerationEnabled: false,
        },
        60_000,
      );
      sessionId = extractSessionId(createResult);
    }

    // ---- wakeToken：sid 已知、成员注册前由引擎落盘（§6.2 wakeToken 签发细节）----
    // v0.9.5（A6/V094-05）：欢迎票同补 issuedToSid/name（三处生产签发点的第三处，
    // 与 attemptWake 主/重试路径同口径）——票据目标 sid 与花名落进票据本体，
    // 「非目标 sid 拒」的两面判据（钩子面/MCP 面）才有真值可判。
    const created = await createWakeNonce(deps.stateRoot, {
      teamId,
      agentKey: spec.key,
      sid: sessionId,
      issuedToSid: sessionId,
      name: spec.key,
    });
    token = created.token;

    // ---- ② setModel（P1：create 结果内联枚举为主，state.updated 仅兜底）----
    keeper.absorbModels(createResult);
    const enumDeadline = Date.now() + 10_000; // dm-create.mjs:131 同款 20×500ms 兜底窗
    while (keeper.getModels().length === 0 && Date.now() < enumDeadline) {
      await sleep(500);
    }
    const chosen = pickModel(keeper.getModels(), { preferModel, preferProvider, preferReasoning });
    // v0.9.6（R2）：预检降级的审计——pickModel 依模型声明档位表把不被支持的档位
    // （含 userConfig 缺省 "max" vs 只声明 low/high 的模型）首试前降级，此处落
    // member-reasoning-fallback{from,to}（双通道第二路是回执 reasoningFallback）。
    if (chosen.reasoningFallback !== undefined) {
      await logEngineEvent(deps.stateRoot, {
        event: "member-reasoning-fallback",
        teamId,
        name: spec.key,
        from: chosen.reasoningFallback.from,
        to: chosen.reasoningFallback.to,
        via: "pre-check",
        note: "所配档位不被模型声明支持：按 high → medium → 省略 有界降级（R2；首试即生效档位，不再有 setModel 首试失败）",
      });
    }
    // v0.9.6（R2）：**setModel 失败的有界降级重试**——模型未声明档位表（无预判据）时，
    // setModel 被拒（"Reasoning effort X is not supported…"）按 high → medium → 省略
    // 依序重试；每次降级落审计 member-reasoning-fallback{from,to}。非档位类失败
    // （网络/会话等）不降级、原样抛出（不掩盖真实错误）。链耗尽仍失败 → 原错误附
    // 模型指引抛出（硬标准 2）。
    const configuredLevel = chosen.reasoningFallback?.from ?? chosen.reasoningLevel;
    let appliedLevel = chosen.reasoningLevel;
    let fallbackTo: string | undefined = chosen.reasoningFallback?.to;
    const applySetModel = async (level: string): Promise<void> => {
      await keeper.request(
        "session/setModel",
        {
          sessionId,
          model: {
            providerId: chosen.providerId,
            modelId: chosen.modelId,
            // 省略档位 = 不传 options.reasoningLevel（CLI 侧用模型默认=最高声明档）。
            ...(level === "" ? {} : { options: { reasoningLevel: level } }),
          },
        },
        60_000,
      );
    };
    const isReasoningUnsupported = (value: unknown): boolean =>
      /reasoning/i.test(String((value as Error)?.message ?? value));
    const displayLevel = (level: string): string =>
      level === "" ? REASONING_OMITTED_LABEL : level;
    /** 降级链的下一档：失败档在链上取其后继；不在链上（max/xhigh 等）从链首起。 */
    const nextReasoningCandidate = (failed: string): string | undefined => {
      const idx = REASONING_FALLBACK_ORDER.indexOf(failed);
      if (idx >= 0) return REASONING_FALLBACK_ORDER[idx + 1];
      return REASONING_FALLBACK_ORDER[0];
    };
    try {
      await applySetModel(appliedLevel);
    } catch (firstErr) {
      if (!isReasoningUnsupported(firstErr)) {
        throw withModelGuidance(firstErr, chosen, "setModel");
      }
      let chainErr: unknown = firstErr;
      for (;;) {
        const next = nextReasoningCandidate(appliedLevel);
        if (next === undefined) {
          throw withModelGuidance(chainErr, chosen, "setModel"); // 链耗尽（省略仍被拒）
        }
        await logEngineEvent(deps.stateRoot, {
          event: "member-reasoning-fallback",
          teamId,
          name: spec.key,
          from: displayLevel(appliedLevel),
          to: displayLevel(next),
          via: "setModel-retry",
          note: "setModel 报档位不支持：按 high → medium → 省略 有界降级重试（R2）",
        });
        appliedLevel = next;
        fallbackTo = displayLevel(next);
        try {
          await applySetModel(appliedLevel);
          break; // 降级档位生效
        } catch (retryErr) {
          if (!isReasoningUnsupported(retryErr)) {
            throw withModelGuidance(retryErr, chosen, "setModel");
          }
          chainErr = retryErr; // 该档也不支持：继续降级（有界）
        }
      }
    }

    // ---- ③+④ 欢迎 send + P2 等待器 ----
    try {
      const baseline = (await readAssistantTurns(keeper, sessionId)).filter(isCompleteTurn).length;
      await keeper.request(
        "session/send",
        { sessionId, content: buildWelcomePrompt({ teamId, key: spec.key, sessionId, wakeToken: created.token }) },
        30_000,
      );
      const deadline = Date.now() + bootTimeoutMs;
      for (;;) {
        if (Date.now() > deadline) {
          throw new ProvisionError(
            "welcome",
            `welcome turn timeout after ${bootTimeoutMs} ms for session ${sessionId}`,
          );
        }
        await sleep(4_000);
        const done = (await readAssistantTurns(keeper, sessionId)).filter(isCompleteTurn);
        if (done.length > baseline) {
          const last = done[done.length - 1]!;
          return {
            sessionId,
            providerId: chosen.providerId,
            modelId: chosen.modelId,
            // v0.9.6（R2）：回执如实披露**实际生效**档位（省略 = 模型默认档）。
            reasoningLevel: displayLevel(appliedLevel),
            ...(fallbackTo !== undefined
              ? { reasoningFallback: { from: configuredLevel, to: fallbackTo } }
              : {}),
            welcomeResponse: last.text,
            reprovisioned,
            ...(last.modelId === undefined ? {} : { turnModelId: last.modelId }),
            ...(last.providerId === undefined ? {} : { turnProviderId: last.providerId }),
          };
        }
      }
    } catch (err) {
      throw withModelGuidance(err, chosen, "welcome");
    }
  } catch (err) {
    // v0.9.6（R1②）：供给失败 → **显式回收本 attempt 签发的唤醒票据**——票据没有
    // 对应的 spawn（lifecycle 无 start），旧实现任其按 15min TTL 充当在途标记，把其后
    // 的 dispatch 全部压成 wake-skipped(inflight-nonce)（41-v095 real-smoke A 的 R1）。
    // 回收（used+revoked 落盘 + wake-nonce-revoked 审计）后，回执/错误信息附回收证据。
    let revocationDigest: string | undefined;
    if (token !== undefined) {
      try {
        const revocation = await revokeWakeNonceForProvisionFailure(deps.stateRoot, token, {
          teamId,
          agentKey: spec.key,
          sid: sessionId,
          now: Date.now(),
        });
        if (revocation.revoked) revocationDigest = revocation.digest;
      } catch {
        /* 回收是失败路径的尽力清理：失败不掩盖原始供给错误（事件面已有 wake-failed 家族） */
      }
    }
    // v0.9.8（D2/V097-07）：供给失败 → 该成员名下**未认领单**回池 + 通知创建者。
    // 形态：成员 provisioning 期间收到的派发单只有 `to` 没有 `assignee`（认领才落
    // assignee）——供给失败后旧实现任其永久搁浅（他人 claim 得 not_assignee、失败
    // 成员无法认领、pending 不在 stale 清扫域、创建者零回执）。回池判据（to 命中 ∧
    // assignee 空）与释放/通知实现在 core/teamstate.ts 的
    // repoolUnclaimedTasksForFailedMember（团队锁内读-改-写，幂等；IO 失败只记审计
    // 不抛——不掩盖原始供给错误）。先于下方回收证据重抛：两条清理路径都要走到。
    try {
      await repoolUnclaimedTasksForFailedMember(deps.stateRoot, teamId, spec.key, {
        reason: "provision-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* 回池是失败路径的尽力清理：失败不掩盖原始供给错误（函数自身已吞 IO 错） */
    }
    if (revocationDigest !== undefined && err instanceof ProvisionError) {
      throw new ProvisionError(
        err.step,
        `${err.message}（本次供给签发的唤醒票据已显式回收：reason=provision-failed，nonce=${revocationDigest}`
        + "——不留 15min 在途标记压制派单，v0.9.6 R1②）",
        // v0.9.6（R1②）：结构化回收证据（失败回执 payload 直读，不受 detail 截断影响）。
        { reason: WAKE_NONCE_REVOKE_PROVISION_FAILED, nonce: revocationDigest },
      );
    }
    throw err;
  } finally {
    keeper.kill();
  }
}
