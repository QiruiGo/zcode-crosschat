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
 *   `settings.model.available[].ref`（深扫描 `{providerId, modelId}` 对象）；
 *   `state.updated` 事件流不可依赖、仅作兜底；
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

/**
 * 从进程 env 组装配置（与 resume-cli.wakeSpawnConfigFromEnv 同纪律：空白按缺失，
 * DESIGN §9-V7 防御；缺失时 start() 同步抛错，调用方据此得 member_provision_failed）。
 */
export function appServerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppServerSpawnConfig {
  const exe = env["XC_ZCODE_EXE"];
  const cjs = env["XC_ZCODE_CJS"];
  return {
    zcodeExe: exe && exe.trim() !== "" ? exe : "",
    zcodeCjs: cjs && cjs.trim() !== "" ? cjs : "",
  };
}

/** 一个可用模型引用（P1：来自 create 结果 settings.model.available[].ref 或 state.updated）。 */
export interface ModelRef {
  providerId: string;
  modelId: string;
  /** 模型声明的推理档位（node.reasoning.levels，可空）。 */
  reasoningLevels: readonly string[];
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

/** 深度收集带 providerId+modelId 的对象（demo/bootstrap-sessions.mjs:74-87 同款，不假设层级）。 */
function collectModelRefs(node: unknown, out: ModelRef[]): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectModelRefs(entry, out);
    return;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record["providerId"] === "string" && typeof record["modelId"] === "string") {
      const levelsRaw = (record["reasoning"] as Record<string, unknown> | undefined)?.["levels"];
      const levels = Array.isArray(levelsRaw) ? levelsRaw.filter((l): l is string => typeof l === "string") : [];
      if (!out.some((m) => m.providerId === record["providerId"] && m.modelId === record["modelId"])) {
        out.push({ providerId: record["providerId"], modelId: record["modelId"], reasoningLevels: levels });
      }
      return;
    }
    for (const value of Object.values(record)) collectModelRefs(value, out);
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
      throw new Error(
        "app-server: zcode_exe / zcode_cjs 未配置（请在插件设置中填写本机 zcode 路径）——成员供给不可用",
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
      if (method === "state.updated") {
        collectModelRefs(msg["params"], this.#models);
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

  /** 吸收一个结果对象里的模型枚举（P1 主路径：session/create 结果内联 available[].ref）。 */
  absorbModels(value: unknown): void {
    collectModelRefs(value, this.#models);
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
