/**
 * W4 stop 钩子单测（DESIGN-V0.2.md §7.3.1 机制 2）：
 * - 回合收尾仅当「本会话在花名册中（含 lead；判定 = readNames 命中本 sid）」才刷新快照；
 * - 无 sid / 花名未命中 → 不刷新；
 * - 刷新失败 → 经 auditHookFailure 静默降级（guarded 包装，恒不抛、恒 exit 0）。
 *
 * 依赖隔离：shared.js 的 stdin/上下文解析与 W3 的 refreshSnapshot 全部 mock——
 * 本测试不触盘、不依赖钩子宿主环境。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  readStdinPayload: vi.fn<() => undefined>(() => undefined),
  resolveHookContext: vi.fn(() => ({ workspace: "ws", stateRoot: "<stateRoot>", sessionId: undefined as string | undefined, event: "Stop" })),
  logHookEvent: vi.fn(async (_stateRoot: string, _event: Record<string, unknown>) => {}),
  auditHookFailure: vi.fn(async (_stateRoot: string | undefined, _hook: string, _error: unknown) => {}),
  boundNamesForSession: vi.fn<(root: string, sid: string) => Promise<string[]>>(async () => []),
}));

const snapshotMocks = vi.hoisted(() => ({
  refreshSnapshot: vi.fn(async () => {}),
}));

vi.mock("./shared.js", () => sharedMocks);
vi.mock("../core/snapshot.js", () => snapshotMocks);

async function importStop(): Promise<typeof import("./stop.js")> {
  return await import("./stop.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  sharedMocks.resolveHookContext.mockReturnValue({
    workspace: "ws",
    stateRoot: "<stateRoot>",
    sessionId: undefined,
    event: "Stop",
  });
  sharedMocks.boundNamesForSession.mockResolvedValue([]);
  snapshotMocks.refreshSnapshot.mockResolvedValue(undefined);
});

describe("stop hook: 回合收尾快照刷新（§7.3.1 机制 2）", () => {
  it("无 sessionId（未锚定会话）→ 不刷新快照", async () => {
    const { runStopHook } = await importStop();
    await runStopHook();
    expect(sharedMocks.boundNamesForSession).not.toHaveBeenCalled();
    expect(snapshotMocks.refreshSnapshot).not.toHaveBeenCalled();
    // v0.1.0 探针行保留（模块加载自启 + 本次显式调用都会写探针，只断言发生过）。
    expect(sharedMocks.logHookEvent).toHaveBeenCalled();
    expect(sharedMocks.logHookEvent.mock.calls.every((c) => c[1]?.["event"] === "hook-stop-probe")).toBe(true);
  });

  it("花名册未命中本 sid → 不刷新快照", async () => {
    const { runStopHook } = await importStop();
    sharedMocks.resolveHookContext.mockReturnValue({
      workspace: "ws",
      stateRoot: "<stateRoot>",
      sessionId: "sess-x",
      event: "Stop",
    });
    sharedMocks.boundNamesForSession.mockResolvedValue([]);
    await runStopHook();
    expect(sharedMocks.boundNamesForSession).toHaveBeenCalledWith("<stateRoot>", "sess-x");
    expect(snapshotMocks.refreshSnapshot).not.toHaveBeenCalled();
  });

  it("本会话在花名册中（成员或 lead；readNames 命中）→ 刷新快照一次（stateRoot，缺省队）", async () => {
    const { runStopHook } = await importStop();
    sharedMocks.resolveHookContext.mockReturnValue({
      workspace: "ws",
      stateRoot: "<stateRoot>",
      sessionId: "sess-lead",
      event: "Stop",
    });
    sharedMocks.boundNamesForSession.mockResolvedValue(["a"]); // leadKey 亦是 roster 成员
    await runStopHook();
    expect(snapshotMocks.refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshotMocks.refreshSnapshot).toHaveBeenCalledWith("<stateRoot>");
  });

  it("refreshSnapshot 抛错 → runStopHook 向上抛（调用方决定降级）", async () => {
    const { runStopHook } = await importStop();
    sharedMocks.resolveHookContext.mockReturnValue({
      workspace: "ws",
      stateRoot: "<stateRoot>",
      sessionId: "sess-a",
      event: "Stop",
    });
    sharedMocks.boundNamesForSession.mockResolvedValue(["a"]);
    snapshotMocks.refreshSnapshot.mockRejectedValue(new Error("disk full"));
    await expect(runStopHook()).rejects.toThrow("disk full");
  });
});

describe("stop hook: 失败降级（hooks 永不阻断会话）", () => {
  it("runStopHookGuarded 吞掉刷新错误 → auditHookFailure 且不再抛出", async () => {
    const { runStopHookGuarded } = await importStop();
    sharedMocks.resolveHookContext.mockReturnValue({
      workspace: "ws",
      stateRoot: "<stateRoot>",
      sessionId: "sess-a",
      event: "Stop",
    });
    sharedMocks.boundNamesForSession.mockResolvedValue(["a"]);
    snapshotMocks.refreshSnapshot.mockRejectedValue(new Error("boom"));
    await expect(runStopHookGuarded()).resolves.toBeUndefined();
    expect(sharedMocks.auditHookFailure).toHaveBeenCalledTimes(1);
    expect(sharedMocks.auditHookFailure).toHaveBeenCalledWith("<stateRoot>", "stop", expect.any(Error));
  });

  it("runStopHookGuarded 正常路径不产生审计", async () => {
    const { runStopHookGuarded } = await importStop();
    sharedMocks.resolveHookContext.mockReturnValue({
      workspace: "ws",
      stateRoot: "<stateRoot>",
      sessionId: "sess-a",
      event: "Stop",
    });
    sharedMocks.boundNamesForSession.mockResolvedValue(["a"]);
    await runStopHookGuarded();
    expect(snapshotMocks.refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(sharedMocks.auditHookFailure).not.toHaveBeenCalled();
  });
});
