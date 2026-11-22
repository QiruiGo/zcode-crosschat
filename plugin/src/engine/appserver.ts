/**
 * W2 member-engine —— zcode app-server 行协议客户端（瞬态 keeper，DESIGN-V0.2.md §4.4）。
 *
 * 用途仅限：成员建会话（session/create + setModel + 首轮欢迎 send）与重供给
 * （session/resume + setModel + 欢迎 send）。生命周期 = xc_member_add 工具调用内
 * spawn → 完成步骤 → kill；**永不长驻**（DESIGN-V0.2.md D0：无守护进程）。
 *
 * 协议事实（全部实测依据，产品化自 demo/bootstrap-sessions.mjs 与
 * FEASIBILITY-V0.2 E4 的 _scripts/dm-create.mjs，E4 全链一次跑通）：
 * - PLATFORM.md §4.3：行分隔 JSON（非 JSON-RPC 信封），无握手；stdout 每行一个对象；
 *   请求 `{id, method, params}` → 应答 `{id, result|error}`；
 * - PLATFORM.md §4.3-4：session/create 过程中必须应答回调
 *   `session/requestRuntimePreferences`（15s 超时坑），可能还有
 *   `interaction/requestOfficialMcpAuthHeaders`（回 `{}` 被接受）；未知回调忽略（与实测一致）；
 * - FEASIBILITY P1：模型枚举主路径 = session/create **结果内联**的
 *   `settings.model.available[].ref`（深扫描 `{providerId, modelId}` 对象；
 *   v0.9.7 W1 起同收 `{ref:{providerId,modelId}, reasoning:{levels:[{value,label}],
 *   defaultLevel}}` 真实形状，见 {@link collectModelRefs}）；
 *   `state.updated` 事件流不可依赖、仅作兜底（v0.9.8 D1 起合并按来源定序：
 *   create 结果权威优先，兜底流只补空不覆盖，见 {@link ModelRefSource}）；
 * - FEASIBILITY P4：`session/send` accept 后 ≤3s 会话即落库，硬杀 app-server 不丢——
 *   因此 keeper 可随工具调用消亡（本文件 kill() 即 E4 的 child.kill() 同款）。
 *
 * 磁盘纪律：本模块不触碰 <workspace>/.crosschat（不 import M1）；engine.jsonl
 * 审计由调用方（provision.ts / member-tools.ts）落盘。
 */

import { spawn, type ChildProcess } from "node:child_process";

/** app-server 拉起配置（来源同 resume-cli 的 WakeSpawnConfig：XC_ZCODE_EXE / XC_ZCODE_CJS）。 */
export interface AppServerSpawnConfig {
  /** ZCode.exe 绝对路径（userConfig zcode_exe）。 */
  zcodeExe: string;
  /** zcode.cjs CLI 入口绝对路径（userConfig zcode_cjs）。 */
  zcodeCjs: string;
}

/** 一个可用模型引用（P1：来自 create 结果 settings.model.available[].ref 或 state.updated）。 */
export interface ModelRef {
  providerId: string;
  modelId: string;
  /** 模型声明的推理档位（node.reasoning.levels，可空）。 */
  reasoningLevels: readonly string[];
  /**
   * v0.9.7（W1/R2）：模型自报的**缺省推理档位**（真实形状 `reasoning.defaultLevel`；
   * 旧扁平形状/未声明 → undefined）。pickModel 的缺省路径（未配置 member_reasoning）
   * 优先取它，回落档位表末位、再回落 "max"——见 provision.ts pickLevel。
   */
  defaultReasoningLevel?: string;
}

/** 自定义回调应答器：返回值作为 `{id, result}` 回写。 */
export type CallbackResponder = (params: unknown) => unknown;

export interface AppServerOptions {
  cfg: AppServerSpawnConfig;
  /** 基底 env（默认 process.env）；ELECTRON_RUN_AS_NODE=1 恒定注入（PLATFORM §4.1）。 */
  env?: NodeJS.ProcessEnv;
  /** 内置两张已知回调之外的补充应答（按 method 精确匹配）。 */
  callbacks?: Record<string, CallbackResponder>;
  /** stderr 转发口（默认忽略；诊断时可注入）。 */
  onStderr?: (chunk: string) => void;
  /** 测试注入 spawn 实现。 */
  spawnImpl?: typeof spawn;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 读模型声明的推理档位表（`reasoning.levels`）。
 *
 * v0.9.7（W1/R2）：**两种条目形状都收**——真实形状是 `{value,label}` 对象数组
 * （42-v096 real-smoke C 的 `appserver-models-probe.json` 实测），旧扁平形状/测试
 * 替身是字符串数组。旧实现只收字符串 → 真实形状下档位表恒空 → pickModel 缺省落
 * "max" → 不支持 max 的模型（如只声明 low/medium/high 的 step-5-preview）首试
 * setModel 即失败（R2 残留根因）。
 */
function readReasoningLevels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const levels: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.trim() !== "") levels.push(entry.trim());
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const value = (entry as Record<string, unknown>)["value"];
      if (typeof value === "string" && value.trim() !== "") levels.push(value.trim());
    }
  }
  return levels;
}

/**
 * v0.9.8（D1/V097-01）：一条模型枚举的**来源权威级**。
 *
 * - `create`：session/create **结果内联**枚举（P1 主路径，权威源——FEASIBILITY P1：
 *   模型枚举主路径 = create 结果内联的 `settings.model.available[].ref`）；
 * - `state.updated`：事件流兜底（协议事实明示「不可依赖、仅作兜底」——可能只带
 *   `{providerId,modelId}`，也可能带陈旧/不一致的档位表）。
 *
 * 旧实现「首次命中即锁死 + 重复项只补空」没有权威排序：`state.updated` 先到会把
 * 自己那份（可能错/旧的）档位表锁死，后到的 create 权威档位表反而只被「补空」
 * 对待 → 首试按错档发 setModel（v0.9.8 方案 D1 的缺陷形态）。现在合并以来源定序：
 * create 后到即覆盖兜底流已锁定的档位信息（非空值才覆盖），兜底流后到仍只补空。
 */
export type ModelRefSource = "create" | "state.updated";

/** {@link collectModelRefs} 的合并上下文（来源权威级判据）。 */
interface ModelCollectContext {
  /** 本次吸收的来源；缺省 "state.updated"（兜底流）。 */
  source?: ModelRefSource;
  /**
   * 来源账本：`providerId\u0000modelId` → 该条目当前锁定的来源。缺省 = 旧行为
   * （无权威排序的纯补空合并）——仅供不关心权威级的直调方使用。
   */
  sources?: Map<string, ModelRefSource>;
}

function modelSourceKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/**
 * 深度收集带 providerId+modelId 的对象（demo/bootstrap-sessions.mjs:74-87 同款，不假设层级）。
 *
 * v0.9.7（W1/R2）：**真实形状**解析。app-server `settings.model.available[]` 的实测
 * 形状（42-v096 real-smoke C 抓取，`evidence/42-v096/real-smoke/appserver-models-probe.json`）：
 * ```json
 * { "ref": { "providerId": "new-provider", "modelId": "step-5-preview" },
 *   "reasoning": { "levels": [ {"value":"low","label":"low"}, … ], "defaultLevel": "high" } }
 * ```
 * 即 providerId/modelId 在 `ref` 里、档位是 `{value,label}` 对象、另有 `defaultLevel`。
 * 旧实现只认**顶层** providerId/modelId 且只收字符串档位：真实形状下递归命中 `ref` 后
 * `reasoning` 不在同一节点 → 档位表恒空。现在两种形状同口径：
 * - 定位：`ref.{providerId,modelId}` 优先，回落顶层 `providerId/modelId`（旧扁平形状）；
 * - 档位：`reasoning.levels[]` 每项可为字符串或 `{value,label}`（{@link readReasoningLevels}）；
 * - 缺省档：`reasoning.defaultLevel` 进 {@link ModelRef.defaultReasoningLevel}。
 *
 * 合并（v0.9.8 D1/V097-01 起按**来源权威级**定序，见 {@link ModelRefSource}）：
 * - create（权威源）后到 → 用 create 的非空档位信息**覆盖**兜底流已锁定的值，
 *   并把该条目来源改判 create；create 自身缺席的字段仍由兜底流补空（不抹除）；
 * - state.updated（兜底）后到，或同源重复 → 只补空不改已得值（v0.9.7 原语义）。
 */
function collectModelRefs(node: unknown, out: ModelRef[], context: ModelCollectContext = {}): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectModelRefs(entry, out, context);
    return;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const ref = asRecord(record["ref"]);
    const flatProvider = typeof record["providerId"] === "string" ? record["providerId"] : undefined;
    const flatModel = typeof record["modelId"] === "string" ? record["modelId"] : undefined;
    const providerId = typeof ref["providerId"] === "string" ? ref["providerId"] : flatProvider;
    const modelId = typeof ref["modelId"] === "string" ? ref["modelId"] : flatModel;
    if (providerId !== undefined && modelId !== undefined) {
      const source = context.source ?? "state.updated";
      const reasoning = asRecord(record["reasoning"]);
      const levels = readReasoningLevels(reasoning["levels"]);
      const rawDefault = reasoning["defaultLevel"];
      const defaultLevel = typeof rawDefault === "string" && rawDefault.trim() !== ""
        ? rawDefault.trim()
        : undefined;
      const existing = out.find((m) => m.providerId === providerId && m.modelId === modelId);
      if (existing === undefined) {
        out.push({
          providerId,
          modelId,
          reasoningLevels: levels,
          ...(defaultLevel !== undefined ? { defaultReasoningLevel: defaultLevel } : {}),
        });
        context.sources?.set(modelSourceKey(providerId, modelId), source);
        return;
      }
      // v0.9.8（D1/V097-01）：权威源优先——create 后到即覆盖兜底流锁定的档位信息。
      // 「非空才覆盖」双向成立：create 没给的字段不被抹掉，由兜底流/后续补空。
      if (source === "create" && context.sources?.get(modelSourceKey(providerId, modelId)) !== "create") {
        if (levels.length > 0) existing.reasoningLevels = levels;
        if (defaultLevel !== undefined) existing.defaultReasoningLevel = defaultLevel;
        context.sources?.set(modelSourceKey(providerId, modelId), "create");
        return;
      }
      // 兜底流后到（或同源重复）：只补空（见上），不覆盖已得的档位表/缺省档。
      if (existing.reasoningLevels.length === 0 && levels.length > 0) {
        existing.reasoningLevels = levels;
      }
      if (existing.defaultReasoningLevel === undefined && defaultLevel !== undefined) {
        existing.defaultReasoningLevel = defaultLevel;
      }
      return;
    }
    for (const value of Object.values(record)) collectModelRefs(value, out, context);
  }
}

/**
 * 瞬态 app-server keeper：一条 stdio 连接上的行协议客户端。
 * 单实例串行使用（xc_member_add 内同步四步），不承担并发请求。
 */
export class AppServerKeeper {
  readonly #child: ChildProcess;
  readonly #callbacks: Record<string, CallbackResponder>;
  readonly #onStderr: ((chunk: string) => void) | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #models: ModelRef[] = [];
  /**
   * v0.9.8（D1/V097-01）：每条已枚举模型的**来源账本**（权威级判据；与 #models 同序
   * 键）。不并入 ModelRef 本体——getModels() 的对外形状逐字节不变（v0.9.7 W1 锚点
   * 测试按精确形状断言），权威排序只影响合并行为。
   */
  #modelSources = new Map<string, ModelRefSource>();
  #buffer = "";
  #closed = false;

  private constructor(child: ChildProcess, options: AppServerOptions) {
    this.#child = child;
    this.#callbacks = options.callbacks ?? {};
    this.#onStderr = options.onStderr;

    child.stdout?.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString();
      let nl: number;
      while ((nl = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, nl).trim();
        this.#buffer = this.#buffer.slice(nl + 1);
        if (line !== "") this.#handleLine(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#onStderr?.(chunk.toString());
    });
    child.on("error", (err: Error) => {
      this.#failAll(new Error(`app-server spawn error: ${err.message}`));
    });
    child.on("exit", (code) => {
      if (!this.#closed) {
        this.#closed = true;
        this.#failAll(new Error(`app-server exited prematurely (code=${code ?? "null"})`));
      }
    });
  }

  /** 拉起 keeper（spawn 同步失败直接抛出；exe/cjs 缺失同步抛错，同 spawnResume 纪律）。 */
  static start(options: AppServerOptions): AppServerKeeper {
    const { cfg } = options;
    if (cfg.zcodeExe.trim() === "" || cfg.zcodeCjs.trim() === "") {
      // v0.4（DESIGN-V0.4 §2.4）：同 resume-cli 的指引文案（成员供给路径，硬标准 2）。
      throw new Error(
        "app-server: zcode_exe / zcode_cjs 未配置且自动探测未命中——成员供给不可用（两会话 pull 协作不受影响）。" +
        "修复：插件设置填写 zcode_exe / zcode_cjs，或运行 xc_doctor 查看探测尝试线索。",
      );
    }
    const spawnImpl = options.spawnImpl ?? spawn;
    const child = spawnImpl(cfg.zcodeExe, [cfg.zcodeCjs, "app-server"], {
      env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new AppServerKeeper(child, options);
  }

  #failAll(err: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  #handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return; // 非协议行忽略（与实测脚本一致）
    }
    if (msg["id"] !== undefined && (msg["result"] !== undefined || msg["error"] !== undefined)) {
      const pending = this.#pending.get(msg["id"] as number);
      if (pending === undefined) return;
      this.#pending.delete(msg["id"] as number);
      clearTimeout(pending.timer);
      if (msg["error"] !== undefined) {
        pending.reject(new Error(`app-server error: ${JSON.stringify(msg["error"])}`));
      } else {
        pending.resolve(msg["result"]);
      }
      return;
    }
    if (typeof msg["method"] === "string") {
      const method = msg["method"];
      // P1 兜底：state.updated 事件流里也可能出现模型枚举（主路径是 create 结果内联）。
      // v0.9.8（D1/V097-01）：显式标注来源 = 兜底流——后到的 create 结果可覆盖它。
      if (method === "state.updated") {
        collectModelRefs(msg["params"], this.#models, { source: "state.updated", sources: this.#modelSources });
        return;
      }
      const responder = this.#callbacks[method];
      if (responder === undefined) return; // 未知回调忽略（E4 实测形态）
      this.#write({ id: msg["id"], result: responder(msg["params"]) });
    }
  }

  #write(payload: Record<string, unknown>): void {
    const stdin = this.#child.stdin;
    if (stdin === null || this.#closed || stdin.destroyed) return;
    try {
      stdin.write(JSON.stringify(payload) + "\n");
    } catch {
      /* stdin 已断：应答尽力而为 */
    }
  }

  /**
   * 行协议请求：id 关联 + 超时。进程已退出/被杀时立即拒绝。
   * 应答 error 载荷 → reject（消息含原始 error JSON）。
   */
  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error(`app-server closed: cannot request ${method}`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`rpc timeout: ${method} (id=${id}, ${timeoutMs} ms)`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  /**
   * 吸收一个结果对象里的模型枚举（P1 主路径：session/create 结果内联 available[].ref）。
   *
   * v0.9.8（D1/V097-01）：本入口的吸收标记为**权威源**（create 结果）——同一模型
   * 已被 state.updated 兜底流先行锁定（哪怕带了一份陈旧/不一致的档位表）时，此处
   * 以 create 的非空档位信息覆盖之；合并语义见 {@link collectModelRefs}。
   */
  absorbModels(value: unknown): void {
    collectModelRefs(value, this.#models, { source: "create", sources: this.#modelSources });
  }

  /** 当前已枚举到的模型表快照（create 结果 + state.updated 兜底，按序去重）。 */
  getModels(): ModelRef[] {
    return [...this.#models];
  }

  /** 轻量探针（DESIGN-V0.2.md §6.4）：session/messages 可读即会话存在（09 §2.1 发现 A 的反向应用）。 */
  async probeSession(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
    try {
      await this.request("session/messages", { sessionId }, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** 硬杀 keeper（P4：send accept 后 ≤3s 已落库，会话不丢——E4 afterKill 探测实证）。 */
  kill(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("app-server killed by keeper"));
    try {
      this.#child.kill();
    } catch {
      /* 已退出 */
    }
  }
}
