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
 *             「无单直接结束回合、不发 xc_idle」——R1 修正，§6.2 ③/§6.3）
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
 * 本模块不触碰磁盘真源（wakeToken nonce 写入是唯一例外，registry/wake/<token>.json，
 * 与 v0.1.0 attemptWake 同款新文件原子写）；roster/names 的正式变更由 member-tools 在
 * registry→team 锁序内完成。
 */

import { DEFAULT_TEAM_ID } from "../core/types.js";
import { createWakeNonce, readNames } from "../core/registry.js";
import type { ToolDeps } from "../mcp/tools.js";
import { AppServerKeeper, type ModelRef } from "./appserver.js";
import { resolveZcodeSpawnConfig } from "./zcode-locate.js";
// 守则 v2 全文由 W3 交付于 wake.ts（DESIGN-V0.2.md §9.2 钉死导出 MEMBER_RULES_V2）；
// 这是设计依赖表「provision import wake 场景常量」的落点（§9.1）。
import { MEMBER_RULES_V2 } from "./wake.js";

/** 成员供给超时默认值（§6.2 步骤④；userConfig member_bootstrap_timeout_ms 同默认）。 */
export const DEFAULT_MEMBER_BOOTSTRAP_TIMEOUT_MS = 300_000;

/**
 * XC_MEMBER_BOOTSTRAP_TIMEOUT_MS 解析（V18 同款防御：非有限正数的一律取默认值）。
 */
export function bootstrapTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["XC_MEMBER_BOOTSTRAP_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MEMBER_BOOTSTRAP_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MEMBER_BOOTSTRAP_TIMEOUT_MS;
}

/**
 * 供给模式（§6.4 的实现入口）：
 * - "fresh"：总是全新 create（xc_member_stop 后同名重加 = 新成员生命周期）；
 * - "auto"（默认）：§6.4 幂等重供给——names.json 已绑定 ∧ session/messages 可读 →
 *   session/resume 续用；否则全新 create（半程死亡自愈）。
 */
export type ProvisionMode = "fresh" | "auto";

/** provisionMember 入参（DESIGN-V0.2.md §9.2 钉死形状 + mode 扩展）。 */
export interface ProvisionSpec {
  /** 成员 key（调用方已 sanitizeKey）。 */
  key: string;
  /** 模型 id 覆盖；缺省用 XC_MEMBER_MODEL，再缺省用枚举首个（§6.2 步骤②）。 */
  model?: string;
  /** 推理档位覆盖；缺省用 XC_MEMBER_REASONING，再缺省取模型档位表末位或 "max"。 */
  reasoningLevel?: string;
  /** 供给模式（缺省 "auto"，见上）。 */
  mode?: ProvisionMode;
}

/** provisionMember 结果（DESIGN-V0.2.md §9.2 钉死形状；turn* 两列为 V13 验证点服务）。 */
export interface ProvisionResult {
  sessionId: string;
  providerId: string;
  modelId: string;
  reasoningLevel: string;
  /** 欢迎回合最后一轮助手文本（P2 过滤后）。 */
  welcomeResponse: string;
  /** true = 走了 session/resume 续用旧会话（§6.4）。 */
  reprovisioned: boolean;
  /** 欢迎回合实际使用的模型（E4 手法：回读校验 setModel 生效，V13）。 */
  turnModelId?: string;
  turnProviderId?: string;
}

/** 供给失败（step ∈ create/model/token/setModel/welcome/send）；member-tools 映射为 member_provision_failed。 */
export class ProvisionError extends Error {
  readonly step: string;

  constructor(step: string, message: string) {
    super(message);
    this.name = "ProvisionError";
    this.step = step;
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
    `1) 调用 xc_register 绑定身份：name 填 "${input.key}"，sessionId 填 "${input.sessionId}"，` +
      `wakeToken 填 "${input.wakeToken}"；`,
    "2) 调用 xc_check_inbox 读取未读消息；",
    "3) 若有未读任务/通知：按下方成员守则开工；若没有：本回合是欢迎回合——直接结束回合，" +
      "不要调用 xc_idle，你的就绪状态由引擎写入的花名册（state=ready）表达。",
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

/** 模型选择（§6.2 步骤②：provider 过滤 → model 精确命中否则首个；档位显式优先，末位兜底）。 */
export function pickModel(
  models: readonly ModelRef[],
  options: { preferModel?: string; preferProvider?: string; preferReasoning?: string },
): { providerId: string; modelId: string; reasoningLevel: string } {
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
  const chosen =
    (options.preferModel !== undefined ? pool.find((m) => m.modelId === options.preferModel) : undefined)
    ?? pool[0]!;
  const levels = chosen.reasoningLevels;
  const reasoningLevel =
    options.preferReasoning ?? (levels.length > 0 ? levels[levels.length - 1]! : "max");
  return { providerId: chosen.providerId, modelId: chosen.modelId, reasoningLevel };
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
  try {
    // ---- ① create（或 §6.4 resume 续用）----
    let sessionId = "";
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
    const { token } = await createWakeNonce(deps.stateRoot, {
      teamId,
      agentKey: spec.key,
      sid: sessionId,
    });

    // ---- ② setModel（P1：create 结果内联枚举为主，state.updated 仅兜底）----
    keeper.absorbModels(createResult);
    const enumDeadline = Date.now() + 10_000; // dm-create.mjs:131 同款 20×500ms 兜底窗
    while (keeper.getModels().length === 0 && Date.now() < enumDeadline) {
      await sleep(500);
    }
    const chosen = pickModel(keeper.getModels(), { preferModel, preferProvider, preferReasoning });
    // v0.4（DESIGN-V0.4 §2.6-1）：模型回合失败（setModel / 欢迎 send / 欢迎等待）的
    // ProvisionError 一律附本次尝试模型与 member_model 填写指引（硬标准 2）。
    try {
      await keeper.request(
        "session/setModel",
        {
          sessionId,
          model: {
            providerId: chosen.providerId,
            modelId: chosen.modelId,
            options: { reasoningLevel: chosen.reasoningLevel },
          },
        },
        60_000,
      );
    } catch (err) {
      throw withModelGuidance(err, chosen, "setModel");
    }

    // ---- ③+④ 欢迎 send + P2 等待器 ----
    try {
      const baseline = (await readAssistantTurns(keeper, sessionId)).filter(isCompleteTurn).length;
      await keeper.request(
        "session/send",
        { sessionId, content: buildWelcomePrompt({ teamId, key: spec.key, sessionId, wakeToken: token }) },
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
            reasoningLevel: chosen.reasoningLevel,
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
  } finally {
    keeper.kill();
  }
}
