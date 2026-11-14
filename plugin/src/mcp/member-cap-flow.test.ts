/**
 * v0.5.3（A12 修复）member_add 名额闸的编排级防回归（provision 以 mock 替身注入，零真实会话）：
 *
 * 红队 a12 形态（adj052 规模压-1，XC_MAX_MEMBERS=2）：lead 立队 → m1 供给失败（state=failed）
 * → m2 被 `team_at_member_cap` 硬拒——此时非 lead 成员仅 1 个且不可用（0 个可用成员仍占满
 * 名额，运维死锁）。旧根因：countActiveMembers 计 lead 与 failed。
 *
 * 修复后口径：lead/failed/removed 不计——本文件按裁决原顺序重放：
 *   m1 供给失败（failed）→ m2 必须放行供给成功；随后名额仍被硬约束（第 3 个活成员被拒），
 *   错误负载带 activeMembers 计数（新披露面）。provisionMember mock 化：m1 抛
 *   ProvisionError（模拟欢迎回合失败），其余成员返回伪结果。
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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamMember, TeamState } from "../core/types.js";
import type { ToolDeps } from "./core.js";

// provisionMember 替身：m1 模拟欢迎回合失败（ProvisionError→member_provision_failed），
// 其余成员供给成功。ProvisionError/bootstrapTimeoutFromEnv 保留真实现（member-tools
// 依赖 instanceof 判定与超时解析）。注意 mock 路径必须与 member-tools.ts 的导入
// 说明符一致（../engine/provision.js），否则替身不生效、测试会拉起真实 app-server。
vi.mock("../engine/provision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/provision.js")>();
  return {
    ...actual,
    provisionMember: vi.fn(async (_deps: ToolDeps, spec: { key: string }) => {
      if (spec.key === "m1") {
        throw new actual.ProvisionError("welcome", "mocked welcome failure (a12 fixture)");
      }
      return {
        sessionId: `sess_${spec.key}`,
        providerId: "prov-test",
        modelId: "glm-test",
        reasoningLevel: "max",
        welcomeResponse: "welcome (mock)",
        reprovisioned: false,
      };
    }),
  };
});

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-a12-cap-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: { XC_MAX_MEMBERS: "2" } };
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function fakeServer(): { tools: Array<{ name: string; handler: (args: Record<string, unknown>, extra?: { sessionId?: string }) => Promise<ToolResult> }> } {
  return new (class {
    readonly tools: Array<{ name: string; handler: (args: Record<string, unknown>, extra?: { sessionId?: string }) => Promise<ToolResult> }> = [];
    tool(name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>, extra?: { sessionId?: string }) => Promise<ToolResult>): void {
      this.tools.push({ name, handler });
    }
  })() as never;
}

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

function member(key: string, state: TeamMember["state"]): TeamMember {
  return { key, sessionId: key === "ldr1" ? "sess_ldr1" : "", role: "worker", identity: "engine", joinedAt: 1, lastSeen: 1, state };
}

async function bindLead(): Promise<void> {
  await writeSession(stateRoot, { sessionId: "sess_ldr1", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  identityStore.bind("conn-lead", {
    sessionKey: "xc:default:ldr1", teamId: "default", name: "ldr1", agentKey: "ldr1",
    sessionId: "sess_ldr1", role: "worker", boundAt: Date.now(),
  });
}

// v0.6（T8）：xc_member_add 并入 xc_team action=member-add——直驱 member core（同 handler 主体）。
const memberCore = () => createMemberToolCore(deps);

describe("member_add 名额闸（A12 修复重放：max=2，lead+failed 不计）", () => {
  it("m1 供给失败 → m2 放行供给成功（旧实现此处 team_at_member_cap）→ 第 3 个活成员仍被硬拒", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([member("ldr1", "ready")]));
        const add = (args: Record<string, unknown>, extra?: { sessionId?: string }) =>
      memberCore().xc_member_add(args as Parameters<ReturnType<typeof memberCore>["xc_member_add"]>[0], (extra?.sessionId ?? "conn-lead") as string);
    const extra = { sessionId: "conn-lead" };

    // ① m1：供给失败（mock 欢迎回合失败）→ member_provision_failed，roster state=failed
    const r1 = await add({ name: "m1" }, extra);
    expect(r1.isError).toBe(true);
    const p1 = payloadOf(r1) as { error: string; detail: string };
    expect(p1.error).toBe("member_provision_failed");
    // 判别 mock 生效（而非真实供给失败）：detail 必须是替身的 fixture 文案
    expect(p1.detail).toContain("mocked welcome failure (a12 fixture)");
    expect((await readTeam(stateRoot, "default"))!.members.find((m) => m.key === "m1")?.state).toBe("failed");

    // ② 红队 a12 判别点：m2 必须放行（旧实现 team_at_member_cap）
    const r2 = await add({ name: "m2" }, extra);
    expect(r2.isError).toBeFalsy();
    const p2 = payloadOf(r2) as { name: string; state: string };
    expect(p2.name).toBe("m2");
    expect(p2.state).toBe("ready");

    // ③ 名额仍硬约束：此时活成员 = m2（1 个），m3 放行后活成员 = m2+m3（2 = max）
    const r3 = await add({ name: "m3" }, extra);
    expect(r3.isError).toBeFalsy();

    // ④ 第 4 个成员被拒：活成员 2 + 1 > 2 → team_at_member_cap（修复不放松真实上限）
    const r4 = await add({ name: "m4" }, extra);
    expect(r4.isError).toBe(true);
    const p4 = payloadOf(r4) as { error: string; maxMembers: number; activeMembers: number; message: string };
    expect(p4.error).toBe("team_at_member_cap");
    expect(p4.maxMembers).toBe(2);
    expect(p4.activeMembers).toBe(3); // 新披露面：m2+m3 ready + 本次写入净 +1
    expect(p4.message).toContain("lead/failed/removed 不计入");

    // 磁盘真源终态对账（裁决证据形态）：lead + failed + ready×2
    const team = (await readTeam(stateRoot, "default"))!;
    const states = Object.fromEntries(team.members.map((m) => [m.key, m.state]));
    expect(states).toEqual({ ldr1: "ready", m1: "failed", m2: "ready", m3: "ready" });
  });

  it("removed 重加也放行（v0.5.2 行为保留，新口径下净增量一致）", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([member("ldr1", "ready"), member("old", "removed")]));
    const add = (args: Record<string, unknown>, extra?: { sessionId?: string }) =>
      memberCore().xc_member_add(args as never, (extra?.sessionId ?? "conn-lead") as string);
    const r = await add({ name: "newbie" }, { sessionId: "conn-lead" });
    expect(r.isError).toBeFalsy(); // removed 不计 → 0 活成员 +1 = 1 ≤ 2
    const states = Object.fromEntries((await readTeam(stateRoot, "default"))!.members.map((m) => [m.key, m.state]));
    expect(states).toEqual({ ldr1: "ready", old: "removed", newbie: "ready" });
  });

  it("非 lead 调用者仍被 not_lead 硬拒（名额修复不触碰 lead 校验）", async () => {
    await bindLead();
    await writeTeam(stateRoot, teamWith([member("ldr1", "ready")]));
    identityStore.bind("conn-other", {
      sessionKey: "xc:default:peon", teamId: "default", name: "peon", agentKey: "peon",
      sessionId: "sess_peon", role: "worker", boundAt: Date.now(),
    });
    const r = await memberCore().xc_member_add({ name: "m9" } as never, "conn-other");
    expect(r.isError).toBe(true);
    expect((payloadOf(r) as { error: string }).error).toBe("not_lead");
  });
});
