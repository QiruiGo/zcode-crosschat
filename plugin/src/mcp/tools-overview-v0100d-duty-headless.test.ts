/**
 * v0.10.0 组 D 定向单测——xc_overview 三视图的**职能声明（G-25）+ 后台回合进行中（R4）**。
 *
 * 锁死契约（需求书 R4「与引擎事件一致，三个视图互不矛盾」+ G-25 设计建议 2）：
 * 1. team 视图：payload members[].duty / duties 块 / members[].headlessTurn /
 *    headlessTurns 块 + 文本面 `duty:` / `headless:` 两行；
 * 2. panel 视图：同一成员行同形状（duty/headlessTurn）+ 同两行文本；
 * 3. status 视图：payload headlessTurns 恒在键（空数组 = 无人跑）+ 一行汇总文本；
 * 4. 三视图的 headlessTurn 判据同源（engine.jsonl 的 wake + session-running），
 *    对同一份引擎事件必须给出一致结论——「互不矛盾」逐视图对拍；
 * 5. 旧花名册（无 duty）⇒ 一切照常：不出 duty 键/不出 duty 行；
 * 6. 无头回合判据只认引擎事件：注册表 liveness 自述 running 但无 wake 不标记。
 *
 * peer 根一律指向临时目录（XC_MESSAGING_DIR——绝不碰机器全局注册表，同既有视图测试）。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { resetPeerServicesForTests } from "./peer-services.js";
import { logEngineEvent } from "../core/log.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import type { TeamMember } from "../core/types.js";

/** 容量颜色钉成 GREEN（三条 red 规则都不命中；同 tools-overview-views.test.ts）。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: { stateRoot: string; workspace: string; env: NodeJS.ProcessEnv };

beforeEach(async () => {
  // peer 服务是进程级单例（getPeerServices）：每个用例重置，否则 panel 视图的
  // services.agents() 会拿上一个用例的 stateRoot（已删目录）读花名册。
  resetPeerServicesForTests();
  workDir = await mkdtemp(join(tmpdir(), "xc-v0100d-overview-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true }); // 空 peer 根：无活 peer
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot } };
});

afterEach(async () => {
  resetPeerServicesForTests();
  await rm(workDir, { recursive: true, force: true });
});

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key,
    sessionId: `sess-${key}`,
    role: "worker",
    joinedAt: Date.now() - 600_000,
    lastSeen: Date.now() - 60_000,
    state: "ready",
    identity: "engine",
    ...overrides,
  };
}

async function seedTeam(members: TeamMember[]): Promise<void> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: members[0]!.key, founder: members[0]!, now: Date.now() });
  team.members = members;
  await writeTeam(stateRoot, team);
}

/** 造一路无头回合在跑：wake → session-running（其后无 session-idle）。 */
async function seedHeadlessRound(memberKey: string, sessionId: string): Promise<void> {
  await logEngineEvent(stateRoot, { event: "wake", scene: "dispatch", teamId: "default", to: memberKey, pid: 4242 });
  await new Promise((r) => setTimeout(r, 2));
  await logEngineEvent(stateRoot, {
    event: "session-running",
    sessionId,
    prev: "idle",
    state: "running",
  });
}

async function view(viewName: "team" | "panel" | "status"): Promise<ToolResult> {
  return handleOverview(deps, { view: viewName }, "conn-v0100d");
}

function textOf(res: ToolResult): string {
  return (res.content[0] as { text?: string }).text ?? "";
}

type MemberRow = Record<string, unknown>;

function memberRows(payload: Record<string, unknown>): MemberRow[] {
  return (payload["members"] as MemberRow[] | undefined) ?? [];
}

describe("v0.10.0 组 D / G-25：xc_overview 成员行职能声明", () => {
  it("team 视图：payload 成员行带 duty + duties 块 + 文本 duty 行", async () => {
    await seedTeam([member("lead"), member("wk", { duty: "负责唤醒链路值守" }), member("plain")]);
    const res = await view("team");
    const payload = payloadOf(res) as Record<string, unknown>;
    const rows = memberRows(payload);
    expect(rows.find((r) => r["key"] === "wk")?.["duty"]).toBe("负责唤醒链路值守");
    expect(rows.find((r) => r["key"] === "plain")?.["duty"]).toBeUndefined();
    expect(payload["duties"]).toEqual([{ key: "wk", duty: "负责唤醒链路值守" }]);
    expect(textOf(res)).toContain("duty: wk=负责唤醒链路值守");
  });

  it("panel 视图：同一成员行同形状 + 同一行文本", async () => {
    await seedTeam([member("lead"), member("wk", { duty: "负责唤醒链路值守" })]);
    const res = await view("panel");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(memberRows(payload).find((r) => r["key"] === "wk")?.["duty"]).toBe("负责唤醒链路值守");
    expect(payload["duties"]).toEqual([{ key: "wk", duty: "负责唤醒链路值守" }]);
    expect(textOf(res)).toContain("duty: wk=负责唤醒链路值守");
  });

  it("旧花名册（无 duty）⇒ 不出 duty 键、不出 duty 行（一切照常）", async () => {
    await seedTeam([member("lead"), member("plain")]);
    for (const v of ["team", "panel"] as const) {
      const res = await view(v);
      const payload = payloadOf(res) as Record<string, unknown>;
      expect(payload["duties"]).toBeUndefined();
      expect(memberRows(payload).every((r) => r["duty"] === undefined)).toBe(true);
      expect(textOf(res)).not.toContain("duty:");
    }
  });
});

describe("v0.10.0 组 D / R4：xc_overview 三视图「后台回合进行中」互不矛盾", () => {
  it("三视图同给 wk 的 headlessTurn（判据同源：wake → session-running）", async () => {
    await seedTeam([member("lead"), member("wk"), member("plain")]);
    await seedHeadlessRound("wk", "sess-wk");

    const teamRes = await view("team");
    const teamPayload = payloadOf(teamRes) as Record<string, unknown>;
    const panelRes = await view("panel");
    const panelPayload = payloadOf(panelRes) as Record<string, unknown>;
    const statusRes = await view("status");
    const statusPayload = payloadOf(statusRes) as Record<string, unknown>;

    // 成员行标记（team/panel 同形）
    const teamFlag = memberRows(teamPayload).find((r) => r["key"] === "wk")?.["headlessTurn"];
    const panelFlag = memberRows(panelPayload).find((r) => r["key"] === "wk")?.["headlessTurn"];
    expect(teamFlag).toMatchObject({ key: "wk", sessionId: "sess-wk" });
    expect(panelFlag).toEqual(teamFlag);
    expect(memberRows(teamPayload).find((r) => r["key"] === "plain")?.["headlessTurn"]).toBeUndefined();

    // 三视图清单块同形同值
    expect(teamPayload["headlessTurns"]).toEqual([teamFlag]);
    expect(panelPayload["headlessTurns"]).toEqual([teamFlag]);
    expect(statusPayload["headlessTurns"]).toEqual([teamFlag]);

    // 文本面：team/panel 出行名清单；status 出一行汇总
    expect(textOf(teamRes)).toContain("headless: wk 后台回合进行中");
    expect(textOf(panelRes)).toContain("headless: wk 后台回合进行中");
    expect(textOf(statusRes)).toContain("headless: 1 个成员后台回合进行中（wk；引擎事件判定）");
  });

  it("注册表自述 running 但无 wake ⇒ 不标记（只认引擎事件）", async () => {
    await seedTeam([member("desk", { lastSeen: Date.now() })]);
    await logEngineEvent(stateRoot, {
      event: "session-running",
      sessionId: "sess-desk",
      prev: null,
      state: "running",
    });
    const statusRes = await view("status");
    const statusPayload = payloadOf(statusRes) as Record<string, unknown>;
    expect(statusPayload["headlessTurns"]).toEqual([]);
    const teamRes = await view("team");
    expect(textOf(teamRes)).not.toContain("headless:");
  });

  it("status 视图无团队 ⇒ headlessTurns 空数组（键集形状稳定）", async () => {
    const res = await view("status");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["headlessTurns"]).toEqual([]);
    expect(textOf(res)).toContain("team: (none)");
  });

  it("无人有后台回合 ⇒ 三视图都不出 headless 行/块内容为空", async () => {
    await seedTeam([member("lead"), member("plain")]);
    const teamRes = await view("team");
    expect(textOf(teamRes)).not.toContain("headless:");
    const panelRes = await view("panel");
    expect(textOf(panelRes)).not.toContain("headless:");
    const statusRes = await view("status");
    expect((payloadOf(statusRes) as Record<string, unknown>)["headlessTurns"]).toEqual([]);
    expect(textOf(statusRes)).not.toContain("headless:");
  });
});
