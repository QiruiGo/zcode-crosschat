/**
 * v0.10.0 组 D 定向单测——core/teamstate.ts 的两个新派生面：
 *
 * A. setMemberDuty（G-25 职能声明落盘）：写/保留/成员不在册 no-op/永不抛；
 * B. headlessTurnMembers（R4 后台回合进行中）：**只看引擎事件**的三条件判据
 *    （session-running 晚于 session-idle ∧ 其间有过 wake ∧ wake 不晚于 running），
 *    注册表自述活性不参与；读取意外降级不崩。
 *
 * B 的正/负样本都按需求书 R4 与监督侧仪器口径构造（engine.jsonl 直接落事件）：
 * - 无头回合在跑：wake → session-running（其后无 session-idle）⇒ 标记；
 * - 交互回合：只有 session-running、从无 wake ⇒ 不标记；
 * - 回合已结束：wake → running → idle ⇒ 不标记（最新区间是 idle）；
 * - 唤醒早于上一段 idle：idle → wake → running → idle → running（交互续跑）⇒ 不标记；
 * - 唤醒晚于 running（spawn 窗口/双路形态）⇒ 本判据不认（宁漏不误报）。
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logEngineEvent } from "./log.js";
import { headlessTurnMembers, newTeamState, readTeam, setMemberDuty, writeTeam } from "./teamstate.js";
import type { TeamMember, TeamState } from "./types.js";

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v0100d-teamstate-"));
  stateRoot = join(workDir, ".crosschat");
  await mkdir(stateRoot, { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return { key, sessionId: `sess-${key}`, role: "worker", joinedAt: 1, lastSeen: 1, ...overrides };
}

async function seedTeam(members: TeamMember[]): Promise<TeamState> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: members[0]!.key, founder: members[0]!, now: 1 });
  team.members = members;
  await writeTeam(stateRoot, team);
  return team;
}

async function rosterDutyOf(key: string): Promise<string | undefined> {
  const team = await readTeam(stateRoot, "default");
  return team?.members.find((m) => m.key === key)?.duty;
}

// ---------------------------------------------------------------------------
// A. setMemberDuty（G-25）
// ---------------------------------------------------------------------------

describe("v0.10.0 组 D / G-25：setMemberDuty", () => {
  it("写入花名册成员行（落盘可读回）", async () => {
    await seedTeam([member("a"), member("b")]);
    const out = await setMemberDuty(stateRoot, "default", "b", "负责回归测试");
    expect(out).toEqual({ ok: true });
    expect(await rosterDutyOf("b")).toBe("负责回归测试");
    expect(await rosterDutyOf("a")).toBeUndefined(); // 不碰别人的行
  });

  it("duty=undefined = 本次未声明：既有值原样保留（重新供给不丢）", async () => {
    await seedTeam([member("a", { duty: "旧职能" })]);
    const out = await setMemberDuty(stateRoot, "default", "a", undefined);
    expect(out.ok).toBe(true);
    expect(await rosterDutyOf("a")).toBe("旧职能");
  });

  it("覆盖声明：再次声明以新值为准", async () => {
    await seedTeam([member("a", { duty: "旧职能" })]);
    await setMemberDuty(stateRoot, "default", "a", "新职能");
    expect(await rosterDutyOf("a")).toBe("新职能");
  });

  it("成员不在册 → no-op 成功（无行可写不是错误）", async () => {
    await seedTeam([member("a")]);
    const out = await setMemberDuty(stateRoot, "default", "ghost", "x");
    expect(out.ok).toBe(true);
  });

  it("team.json 缺失 → no-op 成功（不抛）", async () => {
    const out = await setMemberDuty(stateRoot, "default", "a", "x");
    expect(out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. headlessTurnMembers（R4）
// ---------------------------------------------------------------------------

/** 直接往 engine.jsonl 落一行（测试不走引擎，只造判据输入）。 */
async function engineEvent(rec: Record<string, unknown>): Promise<void> {
  await logEngineEvent(stateRoot, rec as Parameters<typeof logEngineEvent>[1]);
}

describe("v0.10.0 组 D / R4：headlessTurnMembers（引擎事件判据）", () => {
  it("无头回合在跑：wake → session-running（无其后 idle）⇒ 标记", async () => {
    await seedTeam([member("wk")]);
    await engineEvent({ event: "session-idle", sessionId: "sess-wk", prev: "running", state: "idle" });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "wake", scene: "dispatch", teamId: "default", to: "wk", pid: 4242 });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "session-running", sessionId: "sess-wk", prev: "idle", state: "running" });

    const team = (await readTeam(stateRoot, "default"))!;
    const flags = await headlessTurnMembers(stateRoot, team);
    expect([...flags.keys()]).toEqual(["wk"]);
    const flag = flags.get("wk")!;
    expect(flag.sessionId).toBe("sess-wk");
    expect(flag.wakeTs).toBeGreaterThan(0);
    expect(flag.runningTs).toBeGreaterThanOrEqual(flag.wakeTs);
  });

  it("交互回合：只有 session-running、从无 wake ⇒ 不标记", async () => {
    await seedTeam([member("desk")]);
    await engineEvent({ event: "session-running", sessionId: "sess-desk", prev: null, state: "running" });

    const team = (await readTeam(stateRoot, "default"))!;
    expect((await headlessTurnMembers(stateRoot, team)).size).toBe(0);
  });

  it("回合已结束：wake → running → idle ⇒ 不标记（最新区间是 idle）", async () => {
    await seedTeam([member("done")]);
    await engineEvent({ event: "wake", scene: "dispatch", teamId: "default", to: "done", pid: 1 });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "session-running", sessionId: "sess-done", prev: "idle", state: "running" });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "session-idle", sessionId: "sess-done", prev: "running", state: "idle" });

    const team = (await readTeam(stateRoot, "default"))!;
    expect((await headlessTurnMembers(stateRoot, team)).size).toBe(0);
  });

  it("唤醒早于上一段 idle：idle → wake → running → idle → running（交互续跑）⇒ 不标记", async () => {
    await seedTeam([member("mix")]);
    await engineEvent({ event: "session-idle", sessionId: "sess-mix", prev: "running", state: "idle" });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "wake", scene: "dispatch", teamId: "default", to: "mix", pid: 7 });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "session-running", sessionId: "sess-mix", prev: "idle", state: "running" });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "session-idle", sessionId: "sess-mix", prev: "running", state: "idle" });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "session-running", sessionId: "sess-mix", prev: "idle", state: "running" });

    const team = (await readTeam(stateRoot, "default"))!;
    expect((await headlessTurnMembers(stateRoot, team)).size).toBe(0);
  });

  it("唤醒晚于回合开始（spawn 窗口/双路形态）⇒ 本判据不认（宁漏不误报）", async () => {
    await seedTeam([member("win")]);
    await engineEvent({ event: "session-running", sessionId: "sess-win", prev: null, state: "running" });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "wake", scene: "dispatch", teamId: "default", to: "win", pid: 9 });

    const team = (await readTeam(stateRoot, "default"))!;
    expect((await headlessTurnMembers(stateRoot, team)).size).toBe(0);
  });

  it("按 sid 归属：别人的唤醒事件不构成本成员的判据", async () => {
    await seedTeam([member("x"), member("y")]);
    await engineEvent({ event: "session-running", sessionId: "sess-y", prev: null, state: "running" });
    await new Promise((r) => setTimeout(r, 2));
    await engineEvent({ event: "wake", scene: "dispatch", teamId: "default", to: "x", pid: 5 });

    const team = (await readTeam(stateRoot, "default"))!;
    expect((await headlessTurnMembers(stateRoot, team)).size).toBe(0);
  });

  it("无 engine.jsonl ⇒ 空 Map（不抛、不虚报）", async () => {
    await seedTeam([member("a")]);
    const team = (await readTeam(stateRoot, "default"))!;
    expect((await headlessTurnMembers(stateRoot, team)).size).toBe(0);
  });

  it("engine.jsonl 损坏（垃圾行）⇒ 空 Map（坏行跳过，不崩）", async () => {
    await seedTeam([member("a")]);
    await mkdir(join(stateRoot, "logs"), { recursive: true });
    await writeFile(join(stateRoot, "logs", "engine.jsonl"), "\u0000garbage\nnot-json\n", "utf8");
    const team = (await readTeam(stateRoot, "default"))!;
    expect((await headlessTurnMembers(stateRoot, team)).size).toBe(0);
  });

  it("provisioning 占位（sessionId 为空串）不参与判定", async () => {
    await seedTeam([member("prov", { sessionId: "", state: "provisioning" })]);
    await engineEvent({ event: "session-running", sessionId: "", prev: null, state: "running" });
    const team = (await readTeam(stateRoot, "default"))!;
    expect((await headlessTurnMembers(stateRoot, team)).size).toBe(0);
  });
});
