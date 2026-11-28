/**
 * v0.10.1（G-26）：主控代成员会话执行上下文压缩——app-server 行协议客户端（瞬态 keeper）。
 *
 * 做法（51-G26调研 experiments.md 实测结论，Q2b/Q3）：
 * - 由插件的 MCP server 自己 spawn 一个 app-server 实例（`session/resume` 目标会话 →
 *   `session/compact`），**永不长驻**（与 provision.ts 的 member-add 同款生命周期纪律，
 *   DESIGN-V0.2.md D0：无守护进程）；
 * - `session/compact` 被接受 ≠ 完成：宿主忙拒判据只看**本实例**有没有活跃回合，跨实例
 *   压缩会被接受并立即返回 snapshot——真正的完成事件（`compact_completed`，带压缩前后
 *   token 数）只能从 `session/events` 轮询拿（事件 `payload.status==="completed"`）；
 *   **完成判定必须锁定本次压缩的 operationId**（评审 F2，重修版）：三层锚定——
 *   ① 响应锚定：`session/compact` 响应的 `compact` 状态块（project-side.md:22 实测
 *   形状，忙态返回 `{compact:{state:"already_running"}}`）等候选位给出的 opId；
 *   ② 响应没给 opId 时，绑定**事件级 timestamp 不早于本次 RPC 发起时刻**的首条
 *   `compact_started`（上一轮压缩、更早的并发源整批排除；基线 eventSeq 回落 0 全量
 *   拉历史也因此不再污染绑定）；③ 发起之后出现 ≥2 个不同 opId 的 started 且无响应
 *   锚定 → 多源并发、无法断言哪份是本次的，**宁等不猜**：拒绝一切 completed，等
 *   总超时报 compact_failed（错误的 ok:true + 错误 token 数胜过任何猜测）。宿主报
 *   `already_running` 时本次调用根本没有发起压缩，立即如实失败，绝不等在跑那份的
 *   completed；
 * - 宿主不拦跨实例压缩（Q2 结论「两条路都不排队」）——「成员有回合在跑不能压」这一关
 *   必须由插件在工具面把（mcp/tools-team.ts 的 member_busy 闸，活性视图判据）。
 *
 * 参数形状照 `_脚本/appclient.mjs`（51-G26调研实测跑通）与 appserver.ts 的 member-add
 * 用法：resume = `{sessionId, workspace:{workspacePath, workspaceKey}}`；compact =
 * `{sessionId, instructions?}`；events 轮询 = `{sessionId, afterSeq, limit}`（响应含
 * `eventSeq` = 会话当前最新 seq；实测可用的 limit 形状是 50/100——`limit:1` 从未在
 * 实验中跑通，基线请求同样用 limit:100，评审 F8）。
 *
 * 磁盘纪律：本模块不触碰 <workspace>/.crosschat（不 import core 状态面）；审计由调用方
 * 落盘。测试注入：`compactMemberSession` 的 `clientFactory`（生产路径不传，走真 spawn）。
 */

import { AppServerKeeper } from "./appserver.js";
import { resolveZcodeSpawnConfig } from "./zcode-locate.js";

/** 等压缩完成事件的总超时（ms；任务书契约：180 秒）。 */
export const COMPACT_COMPLETION_TIMEOUT_MS = 180_000;

/** 事件轮询间隔（ms；appclient.mjs poll-events 同款 2s）。 */
export const COMPACT_POLL_INTERVAL_MS = 2_000;

/** 单次协议请求（resume/compact/events）的超时（ms；provision.ts 同款 60s）。 */
export const COMPACT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * v0.10.1（评审 F1）：成员行 `compactInProgressAt` 标记的新鲜窗（ms）——超过该窗的
 * 残留标记视为陈旧（fail-open）：唤醒路径照常放行，工具面置位时的锁内清扫与
 * member-add 重供给复位负责清掉残留字节。窗值覆盖压缩的最坏正常耗时（resume 60s +
 * compact 60s + 等完成 180s + 轮询余量）再留裕度，正常压缩永不触发 fail-open。
 */
export const COMPACT_IN_PROGRESS_STALE_MS = 600_000;

/** 一次代压的产出（token 数来自 compact_started/compact_completed 事件载荷）。 */
export interface CompactOutcome {
  /** 宿主的压缩操作 id（`cmp_*`；事件流缺失时缺席——不虚构）。 */
  operationId?: string;
  /** 压缩前 token 数（completed 事件载荷 preCompactTokenCount）。 */
  preCompactTokenCount?: number;
  /** 压缩后 token 数（completed 事件载荷 postCompactTokenCount；并发写入可能虚高）。 */
  postCompactTokenCount?: number;
  /** 宿主给出的更准的压缩后读数（truePostCompactTokenCount；事件缺席时缺席）。 */
  truePostCompactTokenCount?: number;
  /** 从发起 `session/compact`（含该 RPC 本身）到收到完成事件的耗时（ms）。 */
  durationMs: number;
}

/** 代压协议会话的最小形状（测试替身按此实现；生产实现见 {@link AppServerCompactClient}）。 */
export interface CompactClientLike {
  /** 发起压缩（session/compact；被接受即 resolve，完成由 waitCompletion 等）。
   *  返回宿主原始响应（`{response, snapshot}` 形态；用于提取本次 operationId，评审 F2）。 */
  startCompact(instructions: string | undefined): Promise<unknown>;
  /**
   * 轮询 session/events 等完成事件；超时/协议失败抛错（compact_failed 的根因）。
   * `expectedOperationId`：本次压缩的 operationId（来自 startCompact 响应的锚定位，
   * 如 `compact` 状态块；缺席时由本方法绑定**事件 timestamp 不早于本次 RPC 发起
   * 时刻**的首条 compact_started）——completed 事件必须与绑定值一致、且不早于发起
   * 时刻才算完成（评审 F2：上一轮/并发压缩源的 completed 不冒领；发起后出现多个
   * 不同 opId 且无响应锚定时宁等不猜，等总超时）。
   */
  waitCompletion(expectedOperationId?: string): Promise<CompactOutcome>;
  /**
   * 硬杀 keeper（finally 必调）。**诚实边界**（评审 F16，实验 Q2b 实测）：杀 keeper
   * 会中断本实例的完成轮询，宿主侧压缩是否落库以 db 为准——压缩中途杀 app-server
   * 会留下只有 started、无 completed 的悬挂记录，压缩结果**可能丢失**。本方法只应
   * 在压缩已失败/超时/完成的收尾路径调用，不是「压缩已安全落库」的保证。
   */
  close(): void;
}

/** 真实客户端工厂的入参（与 provision 的 deps 同口径的最小面）。 */
export interface CompactClientInput {
  sessionId: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

/** 客户端工厂类型（compactMemberSession 的注入面；缺省 = 真 spawn）。 */
export type CompactClientFactory = (input: CompactClientInput) => Promise<CompactClientLike>;

/** 完成事件的最小判读面（session/events 返回的 events[].payload）。 */
interface CompactEventPayload {
  operationId?: unknown;
  status?: unknown;
  preCompactTokenCount?: unknown;
  postCompactTokenCount?: unknown;
  truePostCompactTokenCount?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从 `session/compact` 的宿主响应里提取本次压缩的 operationId（评审 F2）。
 *
 * 响应实测形状（51-G26调研 logs/p3-B.log:50，appclient 截 600 字符）：
 * `{"response":"","snapshot":{"messages":[…]}}`；且 handler 文档（project-side.md:22）
 * 记载忙态返回 `{compact:{state:"already_running"}}` —— 即响应带 `compact` 状态块。
 * 候选位按锚定强度排序：`compact.operationId`（本次 RPC 自己的状态块，最强）→
 * 顶层 → `response.*` → `snapshot.*`（只认 snapshot **顶层**键，**不做深扫**——
 * snapshot.messages 里的历史 compaction separator 也带 cmp_ id，深扫会把上一轮的
 * opId 当成本次的，恰是 F2 要防的冒领）。都不是 cmp_ 前缀字符串 → undefined，
 * 交由 waitCompletion 的「发起时刻之后的首条 compact_started」时间戳锚定兜底。
 */
export function operationIdFromCompactResponse(response: unknown): string | undefined {
  const top = asRecord(response);
  const candidates = [
    asRecord(top?.["compact"])?.["operationId"],
    top?.["operationId"],
    asRecord(top?.["response"])?.["operationId"],
    asRecord(top?.["snapshot"])?.["operationId"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("cmp_")) return candidate;
  }
  return undefined;
}

/**
 * 从 `session/compact` 响应的 `compact` 状态块读 state（project-side.md:22 实测形状；
 * 缺块/非串 → undefined）。`"already_running"` 表示宿主**没有**为本次调用发起压缩
 * （会话已有压缩在跑）——此刻绝不能把在跑那份的完成事件当成本次结果（F2 禁止的
 * 冒领），必须立即如实失败。
 */
export function compactStateFromResponse(response: unknown): string | undefined {
  const state = asRecord(asRecord(response)?.["compact"])?.["state"];
  return typeof state === "string" ? state : undefined;
}

/**
 * 从一条 session/events 事件里判读压缩事件（started/completed 共用判据）：
 * `payload.status ∈ {started, completed}` ∧ `payload.operationId` 是 `cmp_` 前缀字符串。
 * 其余（非对象载荷/别的状态/别的 operationId 形态）→ undefined（不猜）。
 */
function readCompactEventPayload(event: unknown): { status: "started" | "completed"; payload: CompactEventPayload } | undefined {
  const rec = asRecord(event);
  if (rec === undefined) return undefined;
  const payload = asRecord(rec["payload"]);
  if (payload === undefined) return undefined;
  const status = payload["status"];
  if (status !== "started" && status !== "completed") return undefined;
  const operationId = payload["operationId"];
  if (typeof operationId !== "string" || !operationId.startsWith("cmp_")) return undefined;
  return { status, payload };
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 生产客户端：AppServerKeeper 之上的 resume → compact → events 轮询三步。
 * 生命周期 = compactMemberSession 调用内 open → close（finally），与 member-add 同款。
 */
class AppServerCompactClient implements CompactClientLike {
  readonly #keeper: AppServerKeeper;
  readonly #sessionId: string;
  /** 事件轮询窗口下沿（推进纪律见 {@link #advanceWindow}——只推进已扫描区间，评审 F8）。 */
  #afterSeq = 0;
  /** 已绑定的本次压缩 operationId（评审 F2；completed 只认它）。 */
  #boundOperationId: string | undefined;
  /**
   * 评审 F2 重修：**发起时刻锚**（epoch ms，`startCompact` 发出 RPC 前取）——事件级
   * `timestamp`（51-G26调研 RECV 实测每条事件携带）不早于它的 started/completed 才算
   * 本次压缩的；上一轮压缩、更早的并发源整批排除。与 operationId 绑定互为双保险：
   * 响应没给 opId（当前实锤形状里未见）时，「发起时刻之后的首条 started」就是锚。
   */
  #requestedAt = 0;
  /** 发起时刻之后见到过的 started operationId 集合（≥2 个不同值 = 多源并发，见下）。 */
  readonly #startedCandidates = new Set<string>();
  /**
   * 未获响应锚定却出现 ≥2 个不同的「发起时刻之后」started → 无法断言哪份是本次的
   * （宿主不拦跨实例压缩，Q2 实测）——**宁等不猜**：不再接受任何 completed，等
   * 总超时报 compact_failed（错误结果胜过错误的 ok:true + 错误 token 数）。
   */
  #ambiguousUnanchored = false;

  private constructor(keeper: AppServerKeeper, sessionId: string) {
    this.#keeper = keeper;
    this.#sessionId = sessionId;
  }

  /** spawn + session/resume（1.6s 实测量级；忙会话 resume 也不拒，实验 Q2b 实测）。 */
  static async open(input: CompactClientInput): Promise<AppServerCompactClient> {
    const spawnCfg = resolveZcodeSpawnConfig(input.env);
    if (spawnCfg.outcome.configError !== undefined) {
      // 与 provision.ts 同纪律：显式配置无效 → 立即失败，绝不静默回落。
      throw new Error(spawnCfg.outcome.configError);
    }
    const keeper = AppServerKeeper.start({
      cfg: spawnCfg,
      env: input.env,
      // 协议事实（PLATFORM §4.3-4 / 实验 §4.2）：resume 过程中必须应答
      // session/requestRuntimePreferences（15s 超时坑）；auth headers 回 {}。
      callbacks: {
        "session/requestRuntimePreferences": () => ({ nativeSearchEnhancementsEnabled: false }),
        "interaction/requestOfficialMcpAuthHeaders": () => ({}),
      },
    });
    try {
      await keeper.request(
        "session/resume",
        {
          sessionId: input.sessionId,
          workspace: { workspacePath: input.workspace, workspaceKey: input.workspace },
        },
        COMPACT_REQUEST_TIMEOUT_MS,
      );
      const client = new AppServerCompactClient(keeper, input.sessionId);
      client.#afterSeq = await client.#latestEventSeq();
      return client;
    } catch (err) {
      keeper.kill();
      throw err;
    }
  }

  /**
   * 压缩发起前的会话事件基线（events 响应的 eventSeq；缺失/异常 → 0，不猜）。
   * 请求形状用实测跑通的 `{afterSeq: 0, limit: 100}`（评审 F8：`limit:1` 从未在实验中
   * 跑通，不赌未验证形状；多拉的事件不扫描、只取 eventSeq 当基线）。
   */
  async #latestEventSeq(): Promise<number> {
    try {
      const result = asRecord(await this.#keeper.request(
        "session/events",
        { sessionId: this.#sessionId, afterSeq: 0, limit: 100 },
        COMPACT_REQUEST_TIMEOUT_MS,
      ));
      const seq = result?.["eventSeq"];
      return typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? seq : 0;
    } catch {
      return 0; // 基线取不到 → 从 0 拉全量（配合 F2 的 operationId 绑定，历史 completed 不冒领）
    }
  }

  async startCompact(instructions: string | undefined): Promise<unknown> {
    this.#requestedAt = Date.now(); // 评审 F2：发起时刻锚（事件 timestamp 锚定的基准）
    return this.#keeper.request(
      "session/compact",
      { sessionId: this.#sessionId, ...(instructions === undefined ? {} : { instructions }) },
      COMPACT_REQUEST_TIMEOUT_MS,
    );
  }

  async waitCompletion(expectedOperationId?: string): Promise<CompactOutcome> {
    // 评审 F2：绑定本次 operationId——响应给出的（compact 状态块等锚定位）优先且不可
    // 被事件流覆盖；缺席时绑定「发起时刻之后」的首条 compact_started（事件级
    // timestamp 锚定：上一轮压缩、更早的并发源整批排除，绝不冒领）。
    const responseAnchored =
      typeof expectedOperationId === "string" && expectedOperationId.startsWith("cmp_");
    this.#boundOperationId = responseAnchored ? expectedOperationId : undefined;
    const deadline = Date.now() + COMPACT_COMPLETION_TIMEOUT_MS;
    const startedAt = Date.now();
    for (;;) {
      let result: Record<string, unknown> | undefined;
      try {
        result = asRecord(await this.#keeper.request(
          "session/events",
          { sessionId: this.#sessionId, afterSeq: this.#afterSeq, limit: 100 },
          COMPACT_REQUEST_TIMEOUT_MS,
        ));
      } catch (err) {
        // 评审 F9：单次轮询失败（超时/瞬时协议错误）不冒泡判死——容错重试直到
        // 总超时（appclient.mjs poll-events 同款 try/catch 继续）；keeper 真死时
        // 每轮都失败直到 deadline，最终仍报 compact_failed（keep-alive 后台 keeper
        // 的 Q2b 悬挂形态由工具面的超时语义覆盖）。
        if (Date.now() >= deadline) {
          const detail = String(err instanceof Error ? err.message : err);
          throw new Error(
            `compact did not complete within ${COMPACT_COMPLETION_TIMEOUT_MS / 1000}s (session ${this.#sessionId}); last poll error: ${detail}`,
          );
        }
        await sleep(COMPACT_POLL_INTERVAL_MS);
        continue;
      }
      const events = Array.isArray(result?.["events"]) ? (result!["events"] as unknown[]) : [];
      // 只推进**已扫描**区间的窗口（评审 F8）：绝不按响应 eventSeq 跳——两窗之间的
      // 中间事件（>100 条/窗时）被跳过就再也读不到。
      let scannedMaxSeq: number | undefined;
      for (const event of events) {
        const seq = asRecord(event)?.["seq"];
        if (typeof seq === "number" && Number.isFinite(seq)) {
          scannedMaxSeq = Math.max(scannedMaxSeq ?? -Infinity, seq);
        }
        const compact = readCompactEventPayload(event);
        if (compact === undefined) continue;
        // 事件级 timestamp（RECV 实测每条携带；缺失/非有限数 = 不可锚定）。
        const eventTs = asRecord(event)?.["timestamp"];
        const anchored =
          typeof eventTs === "number" && Number.isFinite(eventTs) && eventTs >= this.#requestedAt;
        if (compact.status === "started") {
          // 绑定：仅未获响应锚定时、且事件时刻不早于发起时刻（timestamp 缺失 = 不可
          // 锚定，不绑）。已锚定时 started 只作旁证，绝不覆盖响应给出的 opId。
          if (responseAnchored || !anchored) continue;
          const opId = compact.payload.operationId;
          if (typeof opId !== "string") continue;
          // 多源歧义守卫：发起之后出现第 2 个不同 opId 的 started（并发压缩源）→
          // 无法断言哪份是本次的 → 宁等不猜（不再接受任何 completed，等总超时）。
          if (this.#startedCandidates.size > 0 && !this.#startedCandidates.has(opId)) {
            this.#ambiguousUnanchored = true;
          }
          this.#startedCandidates.add(opId);
          this.#boundOperationId = opId;
          continue;
        }
        // completed（评审 F2 三重判据，缺一不收）：
        // ① operationId 已绑定且与事件一致（上一轮/并发压缩源不冒领；未绑定宁等不猜）；
        // ② 多源歧义未解除（见 #ambiguousUnanchored）时不收任何 completed；
        // ③ 事件有 timestamp 时不得早于发起时刻（双保险：同 opId 也不可能更早）。
        if (this.#ambiguousUnanchored) continue;
        if (this.#boundOperationId === undefined || compact.payload.operationId !== this.#boundOperationId) {
          continue;
        }
        if (typeof eventTs === "number" && Number.isFinite(eventTs) && eventTs < this.#requestedAt) {
          continue;
        }
        return {
          ...(typeof compact.payload.operationId === "string" ? { operationId: compact.payload.operationId } : {}),
          ...(optionalCount(compact.payload.preCompactTokenCount) !== undefined
            ? { preCompactTokenCount: optionalCount(compact.payload.preCompactTokenCount) }
            : {}),
          ...(optionalCount(compact.payload.postCompactTokenCount) !== undefined
            ? { postCompactTokenCount: optionalCount(compact.payload.postCompactTokenCount) }
            : {}),
          ...(optionalCount(compact.payload.truePostCompactTokenCount) !== undefined
            ? { truePostCompactTokenCount: optionalCount(compact.payload.truePostCompactTokenCount) }
            : {}),
          durationMs: Date.now() - startedAt,
        };
      }
      this.#advanceWindow(events.length, scannedMaxSeq);
      if (Date.now() >= deadline) {
        const why = this.#ambiguousUnanchored
          ? "; ambiguous: multiple compactions started after the request and the response carried no operationId — refusing to claim any of them"
          : this.#boundOperationId === undefined
            ? "; never bound this compact's operationId"
            : "";
        throw new Error(
          `compact did not complete within ${COMPACT_COMPLETION_TIMEOUT_MS / 1000}s (session ${this.#sessionId})${why}`,
        );
      }
      await sleep(COMPACT_POLL_INTERVAL_MS);
    }
  }

  /**
   * 窗口推进（评审 F8）：只推进已扫描到的区间——有 seq 按最大扫描 seq；事件全无
   * seq 时按批长推进（本批已整批扫描，不跳未读区间）；空批不推进（宁可重扫同窗，
   * 不可跳过未扫描事件）。
   */
  #advanceWindow(batchLength: number, scannedMaxSeq: number | undefined): void {
    if (scannedMaxSeq !== undefined) {
      this.#afterSeq = Math.max(this.#afterSeq, scannedMaxSeq);
    } else if (batchLength > 0) {
      this.#afterSeq += batchLength;
    }
  }

  close(): void {
    this.#keeper.kill();
  }
}

/**
 * 代压一个会话（G-26 主路径）：开 keeper → resume → compact → 等完成事件 → 拿前后
 * token 数；任何一步失败/超时都抛错（工具面映射 `compact_failed` 并带根因），
 * keeper 在 finally 硬杀。**诚实边界**（评审 F16，实验 Q2b 实测）：硬杀 keeper 会
 * 中断完成轮询，宿主侧压缩可能仍在进行（或留下只有 started、无 completed 的悬挂
 * 记录）——「已 accept 的压缩不因 keeper 死而丢」不成立；失败/超时路径的后果由
 * 工具面的 compact_failed 回执与审计如实披露。
 *
 * `clientFactory` 仅测试注入（生产路径永不传，与 WatchdogDeps.spawn 同纪律）。
 */
export async function compactMemberSession(input: CompactClientInput & {
  /** 传给宿主的压缩说明（note 或默认句；force 前缀由调用方组装）。 */
  instructions?: string;
  /** 测试注入的客户端工厂（缺省 = 真 spawn app-server）。 */
  clientFactory?: CompactClientFactory;
}): Promise<CompactOutcome> {
  const factory = input.clientFactory ?? ((clientInput: CompactClientInput) => AppServerCompactClient.open(clientInput));
  const client = await factory({ sessionId: input.sessionId, workspace: input.workspace, env: input.env });
  // 计时起点在 startCompact 之前（评审 F26：durationMs 含 compact RPC 本身）。
  const startedAt = Date.now();
  try {
    const response = await client.startCompact(input.instructions);
    // 评审 F2：宿主没为本次调用发起压缩（会话已有压缩在跑，project-side.md:22 实测
    // 形状 `{compact:{state:"already_running"}}`）→ 立即如实失败。把在跑那份的
    // completed 当成本次结果正是 F2 禁止的冒领（ok:true + 错误 token 数）。
    if (compactStateFromResponse(response) === "already_running") {
      throw new Error(
        "host did not start a compaction for this call: a compaction is already running on this session "
          + "(compact.state=already_running) — its completion must not be claimed as this call's result",
      );
    }
    const expectedOperationId = operationIdFromCompactResponse(response);
    const outcome = await client.waitCompletion(expectedOperationId);
    return { ...outcome, durationMs: Date.now() - startedAt };
  } finally {
    client.close();
  }
}
