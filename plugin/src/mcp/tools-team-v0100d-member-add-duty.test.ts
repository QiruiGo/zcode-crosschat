/**
 * v0.10.0 组 D（G-25）定向单测——xc_team action=member-add 的 duty（职能声明）。
 *
 * 锁死契约：
 * 1. 供给时带 duty ⇒ 落花名册 provisioning 记录（供给成功后仍在成员行）+ 回执回显；
 * 2. **同键重新供给不丢**：重供给不带 duty ⇒ 既有 duty 保留；带新 duty ⇒ 覆盖；
 * 3. duty 缺省 ⇒ 不落键；
 * 4. 供给各阶段（Phase 3 写 ready / 失败标 failed）按既有成员行 spread——duty 不丢
 *    （本文件以成功供给 + 回执断言覆盖 Phase 1/3 路径）。
 *
 * provisionMember 以 mock 替身注入（零真实会话，同 member-cap-flow.test.ts 模式）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createMemberToolCore } from "./tools-team.js";
import { identityStore } from "./identity.js";
import { writeSession } from "../core/registry.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import { DUTY_MAX_CHARS } from "../core/types.js";
import type { TeamMember, TeamState } from "../core/types.js";
import type { ToolDeps } from "./core.js";

vi.mock("../engine/provision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/provision.js")>();
  return {
    ...actual,
    provisionMember: vi.fn(async (_deps: ToolDeps, spec: { key: string }) => ({
      sessionId: `sess_${spec.key}`,
      providerId: "prov-test",
      modelId: "glm-test",
      reasoningLevel: "max",
      welcomeResponse: "welcome (mock)",
      reprovisioned: false,
    })),
  };
});

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v0100d-memberadd-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: {} };
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function teamWith(members: TeamMember[]): TeamState {
  return {
    teamId: "default",
    name: "default",
    founderKey: "ldr1",
    leadKey: "ldr1",
    phase: "open",
    members,
    tasks: [],
    seq: 0,
    createdAt: 1,
  };
}

function member(key: string, state: TeamMember["state"], overrides: Partial<TeamMember> = {}): TeamMember {
  return { key, sessionId: key === "ldr1" ? "sess_ldr1" : "", role: "worker", identity: "engine", joinedAt: 1, lastSeen: 1, state, ...overrides };
}

async function bindLead(): Promise<void> {
  await writeSession(stateRoot, { sessionId: "sess_ldr1", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  identityStore.bind("conn-lead", {
    sessionKey: "xc:default:ldr1",
    teamId: "default",
    name: "ldr1",
    agentKey: "ldr1",
    sessionId: "sess_ldr1",
    role: "worker",
    boundAt: Date.now(),
  });
}

async function add(args: { name: string; duty?: string }): Promise<{ result: ToolResult; payload: Record<string, unknown> }> {
  const result = await createMemberToolCore(deps).xc_member_add(args, "conn-lead");
  return { result, payload: payloadOf(result) as Record<string, unknown> };
}

async function rosterDutyOf(key: string): Promise<string | undefined> {
  const team = await readTeam(stateRoot, "default");
  return team?.members.find((m) => m.key === key)?.duty;
}

describe("v0.10.0 组 D / G-25：member-add duty", () => {
  it("供给带 duty ⇒ 落成员行（ready 后仍在）+ 回执回显", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([member("ldr1", "ready")]));
    const { result, payload } = await add({ name: "m1", duty: "负责回归测试" });
    expect(result.isError).toBeFalsy();
    expect(payload.state).toBe("ready");
    expect(payload.duty).toBe("负责回归测试");
    expect(await rosterDutyOf("m1")).toBe("负责回归测试");
  });

  it("duty 入库前清洗（控制字符 + 超长截断）", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([member("ldr1", "ready")]));
    await add({ name: "m2", duty: `看\u0000闸${"x".repeat(300)}` });
    const stored = await rosterDutyOf("m2");
    expect(stored).toHaveLength(DUTY_MAX_CHARS);
    expect(stored!.startsWith("看 闸")).toBe(true);
    expect(stored).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("duty 缺省 ⇒ 不落键", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([member("ldr1", "ready")]));
    await add({ name: "m3" });
    expect(await rosterDutyOf("m3")).toBeUndefined();
  });

  it("同键重新供给（先 failed 再 add）不带 duty ⇒ 既有 duty 保留；带新 duty ⇒ 覆盖", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([member("ldr1", "ready"), member("m4", "ready", { duty: "旧职能" })]));
    // 先把 m4 弄成 failed（member-stop 路径由别组覆盖，这里直接改盘造状态）
    const team = (await readTeam(stateRoot, "default"))!;
    team.members.find((m) => m.key === "m4")!.state = "failed";
    await writeTeam(stateRoot, team);
    // 重供给不带 duty ⇒ 保留
    await add({ name: "m4" });
    expect(await rosterDutyOf("m4")).toBe("旧职能");
    // 再弄失败后重供给并带新 duty ⇒ 覆盖
    const team2 = (await readTeam(stateRoot, "default"))!;
    team2.members.find((m) => m.key === "m4")!.state = "failed";
    await writeTeam(stateRoot, team2);
    await add({ name: "m4", duty: "新职能" });
    expect(await rosterDutyOf("m4")).toBe("新职能");
  });
});
