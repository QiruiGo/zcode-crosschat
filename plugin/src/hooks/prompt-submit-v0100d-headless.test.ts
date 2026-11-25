/**
 * v0.10.0 组 D（R4）定向单测——UserPromptSubmit 钩子的「后台回合进行中」一行提示。
 *
 * 锁死契约（需求书 R4 插件侧 + D2 行为改动）：
 * 1. 有成员后台回合进行中 ⇒ 回合开始提示里出现「后台回合进行中：<名字列表>」，
 *   审计行 `hook-prompt-submit-headless-turn` 带同源名单；
 * 2. **只列其他成员**：本会话自己的后台回合不进列表（钩子就跑在该回合里）；
 * 3. 无人有后台回合 ⇒ 零注入（不回归 v0.8.1 的零块 stdout 契约）；
 * 4. 判据只认引擎事件（与 xc_overview 三视图同一函数 headlessTurnMembers——
 *    teamstate mock 替身注入，本文件锁「接线面」：读了队、过滤了 self、出了行）；
 * 5. 钩子永不失败：headless 判定抛错 → 只审计不阻断（stdout 仍恰一行单键 JSON）。
 *
 * 依赖隔离：与 prompt-submit-v092-incident.test.ts 同模式——`./shared.js` 保留真实
 * emitAdditionalContext；teamstate 假实现控制「花名册 + 后台回合名单」两个输入。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  readStdinPayload: vi.fn((): import("./shared.js").HookStdin | undefined => undefined),
  resolveHookContext: vi.fn(() => ({
    workspace: "ws",
    stateRoot: "<stateRoot>",
    sessionId: "sess-a",
    event: "UserPromptSubmit",
  })),
  logHookEvent: vi.fn(async (_stateRoot: string, _event: unknown) => {}),
  auditHookFailure: vi.fn(async () => {}),
  boundNamesForSession: vi.fn(async () => ["alice"]),
  unreadSummary: vi.fn(async () => ({
    count: 0,
    senders: [] as string[],
    messages: [] as unknown[],
    urgentCount: 0,
  })),
  markInjectedConsumed: vi.fn(async () => 0),
  refreshSessionRegistration: vi.fn(async () => undefined),
  sweepStaleProvisioning: vi.fn(async () => [] as string[]),
  peerRootFromEnv: vi.fn(() => "/peers"),
  readHookPermissionMode: vi.fn(() => "proming" as const),
  refreshPeerBaseRecord: vi.fn(async () => {}),
}));

const peerMocks = vi.hoisted(() => ({ drainPeerQueue: vi.fn(async (): Promise<unknown[]> => []) }));

const envelopeMocks = vi.hoisted(() => ({
  renderPeerEnvelope: vi.fn((item: unknown) => `<crosschat-peer-message>${String((item as { text?: string }).text ?? "")}</crosschat-peer-message>`),
  queueItemToInjectBlock: vi.fn((item: unknown) => {
    const it = item as { msgId: string; from: string; ts: number; text?: string };
    return { msgId: it.msgId, from: it.from, ts: it.ts, rendered: `<crosschat-peer-message>${it.text ?? ""}</crosschat-peer-message>`, summaryLine: `[已省略 ${it.from} 的消息 ${it.msgId}]` };
  }),
}));

const uservoiceMocks = vi.hoisted(() => ({ uservoiceWrite: vi.fn(async () => {}) }));

const checkpointMocks = vi.hoisted(() => ({
  checkpointNudgeState: vi.fn(async () => ({ openTaskCount: 0, lastCheckpointAt: null, lastNudgeAt: null })),
  checkpointNudgeDecision: vi.fn((): { nudge: boolean; reason: string } => ({ nudge: false, reason: "no-active-task" })),
  renderCheckpointNudgeLine: vi.fn(() => ""),
  readContextSize: vi.fn(async (): Promise<{ bytes: number; messages: number }> => ({ bytes: 0, messages: 0 })),
  contextNudgeDecision: vi.fn(
    (): { nudge: boolean; reason: string; bytes: number; messages: number } =>
      ({ nudge: false, reason: "below-threshold", bytes: 0, messages: 0 }),
  ),
  renderContextNudgeLine: vi.fn(() => ""),
  writeNudgeMarker: vi.fn(async (): Promise<void> => {}),
}));

/** teamstate 替身：readTeam（花名册在场判定）+ headlessTurnMembers（R4 判据输入）。 */
const teamstateMocks = vi.hoisted(() => ({
  readTeam: vi.fn(async (): Promise<unknown> => ({ teamId: "default", members: [] })),
  unrelayedCompletedTasks: vi.fn((): Array<{ id: string; title: string }> => []),
  headlessTurnMembers: vi.fn(
    async (): Promise<Map<string, { key: string; sessionId: string; wakeTs: number; runningTs: number }>> => new Map(),
  ),
}));

const incidentMocks = vi.hoisted(() => ({
  readIncidentsSince: vi.fn(async (): Promise<{
    since: number; memberDead: number; limboDowngraded: number; wakeFailed: number; deadMembers: string[]; total: number;
  }> => ({ since: 1_000, memberDead: 0, limboDowngraded: 0, wakeFailed: 0, deadMembers: [], total: 0 })),
  renderIncidentSummary: vi.fn(() => ""),
}));

const registryMocks = vi.hoisted(() => ({
  readSession: vi.fn(async (): Promise<{ lastTurnTs?: number } | undefined> => undefined),
}));

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return { ...actual, ...sharedMocks };
});
vi.mock("../core/peermsg.js", () => peerMocks);
vi.mock("../core/peerenvelope.js", () => envelopeMocks);
vi.mock("../core/uservoice.js", () => uservoiceMocks);
vi.mock("../core/checkpoint.js", () => checkpointMocks);
vi.mock("../core/teamstate.js", () => teamstateMocks);
vi.mock("../core/incidents.js", () => incidentMocks);
vi.mock("../core/registry.js", () => registryMocks);

let writes: string[] = [];
let spy: ReturnType<typeof vi.spyOn> | undefined;

/** 每个用例都重新导入钩子模块（钩子模块在 import 时自启 main()）。 */
async function runHook(): Promise<string[]> {
  vi.resetModules();
  writes = [];
  spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await import("./prompt-submit.js");
    for (let i = 0; i < 40 && writes.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return writes;
  } finally {
    spy?.mockRestore();
    spy = undefined;
  }
}

async function injectedContext(): Promise<string> {
  const captured = await runHook();
  expect(captured).toHaveLength(1);
  const parsed = JSON.parse(captured[0]!) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["additionalContext"]);
  return String(parsed["additionalContext"]);
}

function hookEvents(): Array<Record<string, unknown>> {
  return sharedMocks.logHookEvent.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

/** 设一版「有成员在跑后台回合」的花名册 + 判据输入。 */
function withHeadless(keys: string[]): void {
  teamstateMocks.readTeam.mockResolvedValue({ teamId: "default", members: [{ key: "alice" }, ...keys.map((k) => ({ key: k }))] });
  teamstateMocks.headlessTurnMembers.mockResolvedValue(
    new Map(keys.map((k) => [k, { key: k, sessionId: `sess-${k}`, wakeTs: 1, runningTs: 2 }])),
  );
}

describe("v0.10.0 组 D / R4：回合开始「后台回合进行中」提示", () => {
  beforeEach(() => {
    sharedMocks.logHookEvent.mockClear();
    sharedMocks.auditHookFailure.mockClear();
    sharedMocks.unreadSummary.mockReset();
    sharedMocks.unreadSummary.mockResolvedValue({ count: 0, senders: [], messages: [], urgentCount: 0 });
    peerMocks.drainPeerQueue.mockReset();
    peerMocks.drainPeerQueue.mockResolvedValue([]);
    checkpointMocks.checkpointNudgeDecision.mockReset();
    checkpointMocks.checkpointNudgeDecision.mockReturnValue({ nudge: false, reason: "no-active-task" });
    teamstateMocks.readTeam.mockReset();
    teamstateMocks.readTeam.mockResolvedValue({ teamId: "default", members: [] });
    teamstateMocks.unrelayedCompletedTasks.mockReset();
    teamstateMocks.unrelayedCompletedTasks.mockReturnValue([]);
    teamstateMocks.headlessTurnMembers.mockReset();
    teamstateMocks.headlessTurnMembers.mockResolvedValue(new Map());
    incidentMocks.readIncidentsSince.mockReset();
    incidentMocks.readIncidentsSince.mockResolvedValue({
      since: 1_000, memberDead: 0, limboDowngraded: 0, wakeFailed: 0, deadMembers: [], total: 0,
    });
    registryMocks.readSession.mockReset();
    registryMocks.readSession.mockResolvedValue(undefined);
  });

  it("有其他成员后台回合进行中 ⇒ 注入一行「后台回合进行中：<名字列表>」+ 审计行", async () => {
    withHeadless(["bob", "carol"]);

    const context = await injectedContext();
    expect(context).toContain("后台回合进行中：bob、carol");
    expect(context).toContain("[zcode-crosschat]");
    const audit = hookEvents().find((e) => e["event"] === "hook-prompt-submit-headless-turn");
    expect(audit).toBeDefined();
    expect(audit!["headlessMembers"]).toEqual(["bob", "carol"]);
    expect(audit!["name"]).toBe("alice");
  });

  it("只列其他成员：本会话自己的后台回合被过滤（钩子就跑在该回合里）", async () => {
    withHeadless(["alice"]); // 只有自己

    const context = await injectedContext();
    expect(context).not.toContain("后台回合进行中");
    expect(hookEvents().find((e) => e["event"] === "hook-prompt-submit-headless-turn")).toBeUndefined();
  });

  it("无人有后台回合 ⇒ 零注入（stdout 仍是恰一行单键 JSON，additionalContext 为空）", async () => {
    const context = await injectedContext();
    expect(context).toBe("");
    expect(hookEvents().find((e) => e["event"] === "hook-prompt-submit-headless-turn")).toBeUndefined();
  });

  it("判据抛错 ⇒ 只审计不阻断（stdout 仍恰一行单键 JSON）", async () => {
    teamstateMocks.readTeam.mockResolvedValue({ teamId: "default", members: [{ key: "alice" }] });
    teamstateMocks.headlessTurnMembers.mockRejectedValue(new Error("probe: engine log unreadable"));

    const captured = await runHook();
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["additionalContext"]);
    expect(sharedMocks.auditHookFailure).toHaveBeenCalled();
  });
});
