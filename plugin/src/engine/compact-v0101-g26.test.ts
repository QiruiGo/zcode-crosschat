/**
 * v0.10.1（G-26，评审 F11）：engine/compact.ts 的**直测**——此前的
 * tools-team-v0101-compact.test.ts 把 compactMemberSession 整体 vi.mock 挡在工具面
 * 测试外，协议逻辑（等完成超时、session/events 事件判读、operationId 绑定、事件窗
 * 推进、轮询容错）零用例。本文件用假 keeper（vi.mock AppServerKeeper，走生产默认
 * 工厂 AppServerCompactClient.open）直测协议逻辑：
 *
 * 1. compactMemberSession：happy path（startCompact 收到 instructions、close 在
 *    finally 必调——成功/失败都杀 keeper）；durationMs 从 startCompact 之前起算（F26）；
 * 2. startCompact 响应里的 operationId（F2）：completed 必须匹配本次 operationId——
 *    上一轮/并发压缩源的 completed 不冒领；响应无 operationId → 绑定第一条
 *    compact_started，started 前见到 completed 宁等不猜；
 * 3. F8：事件窗只推进已扫描区间（响应 eventSeq 再大也不跳窗）；基线请求形状是
 *    实测跑通的 {afterSeq:0, limit:100}（limit:1 从未跑通，不赌未验证形状）；
 * 4. F9：单次 events 轮询失败容错重试（不冒泡判死），恢复后照常拿到 completed；
 *    keeper 持续失败熬到总超时，报错带最后一次错误信息；
 * 5. 契约超时：180s 内无匹配 completed → 抛超时错误（工具面映射 compact_failed）。
 *
 * 总超时（180s）用 vi.useFakeTimers 驱动，不真等。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

type RequestLog = Array<{ method: string; params: Record<string, unknown> }>;

/** 假 keeper 的脚本状态（mock 工厂闭包内被测代码读取；测试经 __fakeState 操作）。 */
interface FakeKeeperState {
  scripts: Record<string, unknown[]>;
  defaultResult: unknown;
  log: RequestLog;
  killed: boolean;
}

vi.mock("./appserver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./appserver.js")>();
  const state: FakeKeeperState = { scripts: {}, defaultResult: undefined, log: [], killed: false };
  const makeInstance = () => ({
    request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      state.log.push({ method, params });
      const queue = state.scripts[method];
      if (queue === undefined || queue.length === 0) {
        if (state.defaultResult instanceof Error) throw state.defaultResult;
        return state.defaultResult;
      }
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    kill: (): void => { state.killed = true; },
  });
  const keeperMock = Object.assign(vi.fn(), { start: vi.fn(() => makeInstance()) });
  return { ...actual, AppServerKeeper: keeperMock, __fakeState: state } as unknown as typeof actual;
});

vi.mock("./zcode-locate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./zcode-locate.js")>();
  const fakeResolve = vi.fn(() => ({
    zcodeExe: "fake-zcode.exe",
    zcodeCjs: "fake-zcode.cjs",
    // source 字段测试不关心，任意串（真实取值域见 LocateSource；替身不冒充枚举语义）
    outcome: { found: true, source: "test", pair: { exe: "fake-zcode.exe", cjs: "fake-zcode.cjs" }, attempts: [], guidance: "" } as unknown as never,
  }));
  return { ...actual, resolveZcodeSpawnConfig: fakeResolve } as unknown as typeof actual;
});

import * as appserverModule from "./appserver.js";
import {
  COMPACT_COMPLETION_TIMEOUT_MS,
  compactMemberSession,
  compactStateFromResponse,
  operationIdFromCompactResponse,
} from "./compact.js";
import type { CompactOutcome } from "./compact.js";

const fakeState = (appserverModule as unknown as { __fakeState: FakeKeeperState }).__fakeState;

function ev(seq: number, payload: Record<string, unknown>, timestamp?: number): Record<string, unknown> {
  // timestamp 为事件级字段（51-G26调研 RECV 实测每条携带）——F2 时间戳锚定的判据面。
  return { eventId: `ev${seq}`, payload, seq, sessionId: "sess_x", type: "session.updated", ...(timestamp === undefined ? {} : { timestamp }) };
}

function completedEvent(seq: number, operationId: string, pre = 8000, post = 2000, truePost = 1900, timestamp?: number): Record<string, unknown> {
  return ev(seq, { operationId, status: "completed", preCompactTokenCount: pre, postCompactTokenCount: post, truePostCompactTokenCount: truePost }, timestamp);
}

/** 组一次「生产默认客户端（假 keeper）」代压：scripts 按 method 排轮询脚本。 */
function runWithFakeKeeper(scripts: Record<string, unknown[]>, defaultResult: unknown = { eventSeq: 99, events: [] }): Promise<CompactOutcome> {
  fakeState.scripts = scripts;
  fakeState.defaultResult = defaultResult;
  fakeState.log = [];
  fakeState.killed = false;
  return compactMemberSession({ sessionId: "sess_x", workspace: "ws", env: {} });
}

/**
 * 用假计时器驱动一次代压到落定（成功值或异常原样交给调用方断言）：
 * 轮询间隔 2s 是真实 sleep——不驱动的话多轮用例会撞 vitest 5s 单例超时。
 */
async function driveToSettle<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const promise = start();
  const settledMarker = promise.then(() => "settled" as const, () => "settled" as const);
  for (let i = 0; i < 600; i++) {
    const state = await Promise.race([
      settledMarker.then(() => "settled" as const),
      Promise.resolve("pending" as const),
    ]);
    if (state === "settled") break;
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return promise;
}

const eventsLog = (): RequestLog => fakeState.log.filter((r) => r.method === "session/events");

beforeEach(() => {
  fakeState.scripts = {};
  fakeState.defaultResult = undefined;
  fakeState.log = [];
  fakeState.killed = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("compactMemberSession（注入 clientFactory 的纯编排面）", () => {
  it("1. happy path：startCompact 收到 instructions、waitCompletion 产出透传、durationMs 从 startCompact 之前起算（F26）、close 在 finally 必调", async () => {
    const calls: string[] = [];
    let closed = false;
    const outcome = await compactMemberSession({
      sessionId: "sess_x", workspace: "ws", env: {},
      instructions: "保留验收标准",
      clientFactory: async () => ({
        startCompact: async (instructions: string | undefined) => {
          calls.push(`start:${instructions}`);
          // compact RPC 本身耗时 30ms——F26：durationMs 必须把它算进去（旧实现从轮询起算恒偏小）
          await new Promise((r) => setTimeout(r, 30));
          return { response: { operationId: "cmp_t1" }, snapshot: {} };
        },
        waitCompletion: async (): Promise<CompactOutcome> => {
          calls.push("wait");
          return { operationId: "cmp_t1", preCompactTokenCount: 10, postCompactTokenCount: 5, durationMs: 1 };
        },
        close: () => { closed = true; calls.push("close"); },
      }),
    });
    expect(calls).toEqual(["start:保留验收标准", "wait", "close"]);
    expect(outcome.operationId).toBe("cmp_t1");
    expect(outcome.preCompactTokenCount).toBe(10);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(25);
  });

  it("2. startCompact 抛错 → 错误冒泡、close 仍在 finally 调用（成功/失败都杀 keeper）", async () => {
    let closed = false;
    await expect(compactMemberSession({
      sessionId: "sess_x", workspace: "ws", env: {},
      clientFactory: async () => ({
        startCompact: async () => { throw new Error("rpc timeout: session/compact"); },
        waitCompletion: async () => ({ operationId: "cmp_x", durationMs: 0 }),
        close: () => { closed = true; },
      }),
    })).rejects.toThrow("rpc timeout: session/compact");
    expect(closed).toBe(true);
  });

  it("3. waitCompletion 抛错（超时/协议失败）→ 错误冒泡、close 调用——失败不吞（契约：失败/超时 → compact_failed 的根因）", async () => {
    let closed = false;
    await expect(compactMemberSession({
      sessionId: "sess_x", workspace: "ws", env: {},
      clientFactory: async () => ({
        startCompact: async () => ({}),
        waitCompletion: async () => { throw new Error("compact did not complete within 180s"); },
        close: () => { closed = true; },
      }),
    })).rejects.toThrow("compact did not complete within 180s");
    expect(closed).toBe(true);
  });
});

describe("operationIdFromCompactResponse（F2：锁定本次 operationId）", () => {
  it("4. 候选位逐层认（compact 块优先，再顶层/response/snapshot），cmp_ 前缀才算；都不是 → undefined（交由 timestamp 锚定兜底）", () => {
    // compact 状态块（project-side.md:22 实测形状）是最强锚定位
    expect(operationIdFromCompactResponse({ compact: { state: "started", operationId: "cmp_0" } })).toBe("cmp_0");
    expect(operationIdFromCompactResponse({ operationId: "cmp_a" })).toBe("cmp_a");
    expect(operationIdFromCompactResponse({ response: { operationId: "cmp_b" } })).toBe("cmp_b");
    expect(operationIdFromCompactResponse({ snapshot: { operationId: "cmp_c" } })).toBe("cmp_c");
    // 实测成功形状（logs/p3-B.log:50，截断处未见 opId）→ undefined，走 timestamp 锚定
    expect(operationIdFromCompactResponse({ response: "Compacted", snapshot: {} })).toBeUndefined();
    expect(operationIdFromCompactResponse({ operationId: "not-cmp" })).toBeUndefined();
    expect(operationIdFromCompactResponse(undefined)).toBeUndefined();
  });

  it("4b. compactStateFromResponse：读 compact.state（缺块/非串 → undefined）——already_running 识别的纯函数面", () => {
    expect(compactStateFromResponse({ compact: { state: "already_running" } })).toBe("already_running");
    expect(compactStateFromResponse({ compact: { state: "started" } })).toBe("started");
    expect(compactStateFromResponse({ response: "Compacted", snapshot: {} })).toBeUndefined();
    expect(compactStateFromResponse(undefined)).toBeUndefined();
  });
});

describe("AppServerCompactClient（假 keeper 直测协议逻辑）", () => {
  it("5. 响应带 operationId → completed 必须匹配；上一轮压缩的 completed（别的 operationId）不冒领，最终拿到本次结果（F2）", async () => {
    const outcome = await driveToSettle(() => runWithFakeKeeper({
      "session/resume": [{}],
      "session/compact": [{ response: "Compacted", snapshot: { operationId: "cmp_this_round" } }],
      "session/events": [
        // 基线轮：eventSeq=5（基线取数）
        { eventSeq: 5, events: [] },
        // 轮询轮 1：上一轮压缩的 completed（operationId 不同）→ 不冒领
        { eventSeq: 7, events: [completedEvent(6, "cmp_old_round")] },
        // 轮询轮 2：本次 completed → 命中
        { eventSeq: 9, events: [completedEvent(8, "cmp_this_round")] },
      ],
    }));
    expect(outcome.operationId).toBe("cmp_this_round");
    expect(outcome.preCompactTokenCount).toBe(8000);
    expect(outcome.postCompactTokenCount).toBe(2000);
    expect(outcome.truePostCompactTokenCount).toBe(1900);
    // 轮询轮 1 的窗口没有因「见到别人的 completed」而提前收窗
    expect(eventsLog().length).toBeGreaterThanOrEqual(3);
  });

  it("6. 响应无 operationId → 绑定 timestamp 不早于发起时刻的首条 compact_started；started 前见到 completed 宁等不猜（F2）", async () => {
    const outcome = await driveToSettle(() => {
      const t0 = Date.now(); // 已在 fake timers 下 = startCompact 记录的发起时刻（同源时钟）
      return runWithFakeKeeper({
        "session/resume": [{}],
        "session/compact": [{ response: "Compacted", snapshot: {} }],
        "session/events": [
          { eventSeq: 2, events: [] },
          // 只有 completed、还没 started → 不冒领（无绑定宁等）
          { eventSeq: 4, events: [completedEvent(3, "cmp_bound", 8000, 2000, 1900, t0 + 20)] },
          // started 到场（发起时刻之后）→ 绑定；下一轮 completed 命中
          { eventSeq: 6, events: [ev(5, { operationId: "cmp_bound", status: "started", preCompactTokenCount: 8000 }, t0 + 30)] },
          { eventSeq: 8, events: [completedEvent(7, "cmp_bound", 8000, 2000, 1900, t0 + 40)] },
        ],
      });
    });
    expect(outcome.operationId).toBe("cmp_bound");
    expect(outcome.preCompactTokenCount).toBe(8000);
    expect(outcome.postCompactTokenCount).toBe(2000);
    expect(outcome.truePostCompactTokenCount).toBe(1900);
  });

  it("7. F8：事件窗只推进已扫描区间——batch 内最大扫描 seq < 响应 eventSeq 时下轮 afterSeq 取扫描值（不跳窗漏事件）", async () => {
    const outcome = await driveToSettle(() => {
      const t0 = Date.now();
      return runWithFakeKeeper({
        "session/resume": [{}],
        "session/compact": [{ response: "Compacted" }],
        "session/events": [
          // 基线：eventSeq=10
          { eventSeq: 10, events: [] },
          // 轮询轮 1：夹批形态——本批只扫到 seq=20，响应 eventSeq=200
          // （若按 eventSeq 跳窗，seq 21..199 之间的 completed 永久漏掉——评审 F8 原缺陷）
          { eventSeq: 200, events: [ev(11, { status: "started", operationId: "cmp_w" }, t0 + 10), ev(20, { note: "other" }, t0 + 11)] },
          // 轮询轮 2：completed 在 seq=150（旧实现跳窗后读不到 → 一直空转到 180s 超时）
          { eventSeq: 201, events: [completedEvent(150, "cmp_w", 8000, 2000, 1900, t0 + 20)] },
        ],
      });
    });
    expect(outcome.operationId).toBe("cmp_w");
    // 请求窗推进对拍：轮询轮 2 的 afterSeq 必须是 20（已扫描上沿），不是 200
    expect(eventsLog()[1]!.params["afterSeq"]).toBe(10);
    expect(eventsLog()[2]!.params["afterSeq"]).toBe(20);
  });

  it("8. F8：基线请求形状 = 实测跑通的 {afterSeq:0, limit:100}（limit:1 从未跑通，不赌未验证形状）", async () => {
    await driveToSettle(() => runWithFakeKeeper({
      "session/resume": [{}],
      "session/compact": [{ response: "Compacted", snapshot: { operationId: "cmp_base" } }],
      "session/events": [
        { eventSeq: 42, events: [] },
        { eventSeq: 44, events: [completedEvent(43, "cmp_base")] },
      ],
    }));
    const baseline = eventsLog()[0]!;
    expect(baseline.params).toMatchObject({ sessionId: "sess_x", afterSeq: 0, limit: 100 });
    // 轮询从基线 eventSeq 起步（增量拉取）
    expect(eventsLog()[1]!.params["afterSeq"]).toBe(42);
  });

  it("9. F9：单次 events 轮询失败容错重试（不冒泡判死），恢复后照常拿到 completed", async () => {
    const outcome = await driveToSettle(() => runWithFakeKeeper({
      "session/resume": [{}],
      "session/compact": [{ response: "Compacted", snapshot: { operationId: "cmp_retry" } }],
      "session/events": [
        { eventSeq: 3, events: [] },
        new Error("rpc timeout: session/events"), // 瞬时失败 → 容错继续
        { eventSeq: 5, events: [completedEvent(4, "cmp_retry")] },
      ],
    }));
    expect(outcome.operationId).toBe("cmp_retry");
    // 失败轮 + 重试轮都发生了（容错不是吞掉请求）
    expect(eventsLog().length).toBeGreaterThanOrEqual(3);
  });

  it("10. 契约超时：180s 内无匹配 completed → 抛超时错误（fake timers 驱动，不真等 180s）", async () => {
    fakeState.scripts = {
      "session/resume": [{}],
      "session/compact": [{ response: "Compacted" }],
    };
    // 永远只有 started、没有 completed → 等到总超时
    fakeState.defaultResult = { eventSeq: 9, events: [ev(8, { status: "started", operationId: "cmp_never" })] };
    fakeState.log = [];
    vi.useFakeTimers();
    const pending = compactMemberSession({ sessionId: "sess_x", workspace: "ws", env: {} });
    const pendingAssert = expect(pending).rejects.toThrow(
      `compact did not complete within ${COMPACT_COMPLETION_TIMEOUT_MS / 1000}s`,
    );
    await vi.advanceTimersByTimeAsync(COMPACT_COMPLETION_TIMEOUT_MS + 10_000);
    await pendingAssert;
    // 超时收尾：keeper 已被 finally 硬杀
    expect(fakeState.killed).toBe(true);
  });

  it("12.（评审 F2 重修·核验场景）基线回落 0 全量拉历史 + 上一轮压缩的 started/completed 都在窗内 → 只认 timestamp 不早于发起时刻的那份，上一轮的 completed 不冒领", async () => {
    const outcome = await driveToSettle(() => {
      const t0 = Date.now();
      return runWithFakeKeeper({
        "session/resume": [{}],
        // 响应无 opId（实测成功形状截断处未见 compact 块）→ 走 timestamp 锚定路径
        "session/compact": [{ response: "Compacted", snapshot: {} }],
        "session/events": [
          // 基线请求失败 → afterSeq 回落 0 → 第一轮全量拉历史（评审 F2 原缺陷的组合前提）
          new Error("rpc timeout: session/events"),
          // 全量历史窗：上一轮压缩的 started+completed（timestamp 都早于发起时刻）
          { eventSeq: 9, events: [
            ev(2, { operationId: "cmp_prev_round", status: "started", preCompactTokenCount: 7777 }, t0 - 60_000),
            { eventId: "ev3", payload: { operationId: "cmp_prev_round", status: "completed", preCompactTokenCount: 7777, postCompactTokenCount: 999, truePostCompactTokenCount: 888 }, seq: 3, sessionId: "sess_x", type: "session.updated", timestamp: t0 - 30_000 },
          ] },
          // 本次压缩：started（发起时刻之后）→ 绑定；completed → 命中
          { eventSeq: 14, events: [
            ev(13, { operationId: "cmp_this_round", status: "started", preCompactTokenCount: 8000 }, t0 + 40),
          ] },
          { eventSeq: 16, events: [completedEvent(15, "cmp_this_round", 8000, 2000, 1900, t0 + 80)] },
        ],
      });
    });
    expect(outcome.operationId).toBe("cmp_this_round");
    expect(outcome.preCompactTokenCount).toBe(8000);
    expect(outcome.postCompactTokenCount).toBe(2000);
    // 上一轮的 token 读数（7777→999）绝不出现在结果里
    expect(outcome.preCompactTokenCount).not.toBe(7777);
    expect(outcome.postCompactTokenCount).not.toBe(999);
  });

  it("13.（评审 F2 重修）发起之后出现 ≥2 个不同 opId 的 started 且响应无 opId → 多源歧义宁等不猜：completed 一律不收，等总超时报 ambiguous", async () => {
    fakeState.scripts = {
      "session/resume": [{}],
      "session/compact": [{ response: "Compacted", snapshot: {} }],
    };
    // 先给两个 started（不同 opId），之后永远只回 completed(cmp_a)——歧义下绝不冒领
    const t0 = Date.now();
    fakeState.defaultResult = { eventSeq: 99, events: [] };
    fakeState.scripts["session/events"] = [
      { eventSeq: 3, events: [] },
      { eventSeq: 5, events: [ev(4, { operationId: "cmp_a", status: "started" }, t0 + 10)] },
      { eventSeq: 7, events: [ev(6, { operationId: "cmp_b", status: "started" }, t0 + 20)] },
    ];
    fakeState.log = [];
    vi.useFakeTimers();
    const pending = compactMemberSession({ sessionId: "sess_x", workspace: "ws", env: {} });
    const pendingAssert = expect(pending).rejects.toThrow("ambiguous: multiple compactions started");
    await vi.advanceTimersByTimeAsync(COMPACT_COMPLETION_TIMEOUT_MS + 10_000);
    await pendingAssert;
    expect(fakeState.killed).toBe(true);
  });

  it("14.（评审 F2 重修）宿主报 compact.state=already_running → 本次调用没发起压缩，立即如实失败（绝不等在跑那份的 completed）", async () => {
    let closed = false;
    await expect(compactMemberSession({
      sessionId: "sess_x", workspace: "ws", env: {},
      clientFactory: async () => ({
        startCompact: async () => ({ response: "", snapshot: {}, compact: { state: "already_running" } }),
        waitCompletion: async () => { throw new Error("waitCompletion must not be reached"); },
        close: () => { closed = true; },
      }),
    })).rejects.toThrow("already running");
    expect(closed).toBe(true);
  });

  it("15.（评审 F2 重修）响应 compact 块给出 opId → 锚定不可被事件流覆盖：之后出现的旁人 started/completed 都不冒领，只认锚定那份", async () => {
    const outcome = await driveToSettle(() => {
      const t0 = Date.now();
      return runWithFakeKeeper({
        "session/resume": [{}],
        "session/compact": [{ response: "", snapshot: {}, compact: { state: "started", operationId: "cmp_resp_anchor" } }],
        "session/events": [
          { eventSeq: 3, events: [] },
          // 旁人 started（发起之后的并发源）→ 不覆盖响应锚定
          { eventSeq: 5, events: [ev(4, { operationId: "cmp_other", status: "started" }, t0 + 10)] },
          // 旁人 completed → opId 不匹配 → 不冒领
          { eventSeq: 7, events: [completedEvent(6, "cmp_other", 11111, 222, 111)] },
          // 锚定那份的 completed → 命中
          { eventSeq: 9, events: [completedEvent(8, "cmp_resp_anchor", 8000, 2000, 1900, t0 + 30)] },
        ],
      });
    });
    expect(outcome.operationId).toBe("cmp_resp_anchor");
    expect(outcome.preCompactTokenCount).toBe(8000);
    expect(outcome.postCompactTokenCount).toBe(2000);
    expect(outcome.truePostCompactTokenCount).toBe(1900);
  });

  it("11. F9 边界：keeper 持续失败（每轮都错）→ 熬到总超时报错且带最后一次错误信息（不静默吞）", async () => {
    fakeState.scripts = {
      "session/resume": [{}],
      "session/compact": [{ response: "Compacted" }],
    };
    fakeState.defaultResult = new Error("app-server exited code=1");
    fakeState.log = [];
    vi.useFakeTimers();
    const pending = compactMemberSession({ sessionId: "sess_x", workspace: "ws", env: {} });
    const pendingAssert = expect(pending).rejects.toThrow("app-server exited code=1");
    await vi.advanceTimersByTimeAsync(COMPACT_COMPLETION_TIMEOUT_MS + 10_000);
    await pendingAssert;
    expect(fakeState.killed).toBe(true);
  });
});
