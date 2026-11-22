/**
 * v0.9.8 组 O：xc_team 三处「未读」声明的定向单测（tools-team.ts，D7 = V097-21）。
 *
 * 缺陷事实（48-v097验收 V097-21，P2 mustFix）：观测面（panel/status/team 板面）按
 * 「未读 ∧ 未丢弃 ∧ isCurrentMail」计数，而 checkpoint 第 5 章 / 投产 backlog /
 * 停机留档索引用 readUnreadMailbox（**不过 isCurrentMail**）——同一邮箱观测面 0、
 * 本文件三处报 2：成员被一条所有观测面都不显示的未读数挡住改名，checkpoint 发布
 * 与全部观测面矛盾的数字。
 *
 * 修法：三处统一到 core/checkpoint.ts currentUnreadMessages 单一真源。本文件钉死：
 * 1. **checkpoint 第 5 章**（named face）：陈旧信封（taskId 指向不存在任务）不计入
 *    payload.unread / front-matter / 审计事件；
 * 2. **投产 backlog**（in-domain extension，同判据）：陈旧-only 邮箱 → backlog 0、
 *    delivered skipped、**不发起唤醒**（不制造「邮箱有 N 条未读」假票文）；plain
 *    未读 → backlog 1 且唤醒带上真实 receiptIds（判据收紧不误伤正常路径）；
 * 3. **停机留档索引**（in-domain extension，同判据）：meta.json unread 只含现行件。
 *
 * 替身（零真实 spawn / 零真实 app-server）：provisionMember 与 attemptWake 都 mock
 * （attemptWake 只记录入参——本测试的对象是 backlog **判据**，不是唤醒机器本身；
 * 唤醒机器的三级指标由 v0.9.4 A5 测试覆盖）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf } from "./protocol.js";
import { createMemberToolCore, handleTeam } from "./tools-team.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { appendMailbox, createMessage, mutateMailbox } from "../core/mailbox.js";
import { engineLogFile } from "../core/paths.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import type { Task, TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";

const wakeCalls: Array<{ receiptIds: readonly string[]; ticket: string }> = [];

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

vi.mock("../engine/wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/wake.js")>();
  return {
    ...actual,
    attemptWake: vi.fn(async (req: { receiptIds: readonly string[]; ticket: string }) => {
      wakeCalls.push({ receiptIds: req.receiptIds, ticket: req.ticket });
      return {
        delivered: "wake" as const,
        startConfirmed: true,
        wakeTiers: { spawnOk: "ok" as const, childAlive: "ok" as const, consumed: "pending" as const },
      };
    }),
  };
});

const MIN = 60_000;
const T0 = Date.now();

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v098-o-team-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: {} };
  wakeCalls.length = 0;
});

afterEach(async () => {
  identityStore.bind("__discard__", bindIdentity("ghost", "sess-ghost")); // 防 require 泄漏到断言外
  await rm(workDir, { recursive: true, force: true });
});

function bindIdentity(name: string, sessionId: string): BoundIdentity {
  return {
    sessionKey: `${sessionId}:${name}`,
    teamId: "default",
    name,
    agentKey: name,
    sessionId,
    role: "peer" as const,
    boundAt: Date.now(),
  };
}

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key,
    sessionId: `sess-${key}`,
    role: "worker",
    joinedAt: T0 - 120 * MIN,
    lastSeen: T0 - MIN,
    state: "ready",
    identity: "engine",
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "86e8b61a-t1",
    title: "落盘脚本改造",
    prompt: "p",
    dependsOn: [],
    status: "in_progress",
    assignee: "alice",
    attempt: 2,
    attemptId: "att-2",
    createdBy: "lead",
    createdAt: T0 - 60 * MIN,
    updatedAt: T0 - 20 * MIN,
    lastProgressTs: T0 - 20 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: T0 - 20 * MIN, event: "report", by: "alice" }],
    ...overrides,
  };
}

/** lead + alice（+ 可选追加成员）。 */
async function seedTeam(tasks: Task[] = [], members: TeamMember[] = []): Promise<void> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: "lead", founder: member("lead"), now: T0 });
  team.leadKey = "lead";
  team.members.push(member("alice"), ...members);
  team.tasks = tasks;
  await writeTeam(stateRoot, team);
}

/** 只有 lead 的队（member-add 的 fresh 路径：新成员先于在册落邮箱）。 */
async function seedLeadOnly(): Promise<void> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: "lead", founder: member("lead"), now: T0 });
  team.leadKey = "lead";
  team.tasks = [];
  await writeTeam(stateRoot, team);
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// D7 面 1：checkpoint 第 5 章未读（named face）
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O D7（V097-21）：checkpoint 第 5 章未读与观测面同源", () => {
  it("【主判据】陈旧/已读不计入：payload.unread / front-matter / 审计三处一致（只剩 plain）", async () => {
    await seedTeam([task({ id: "t-a1", status: "in_progress" })]);
    const plain = createMessage("bob", "alice", "记得先落盘再压缩");
    const read = createMessage("bob", "alice", "read");
    // taskId 指向不存在的任务（无 attemptId）⇒ 陈旧（v0.5.1 故障注-5 口径）——
    // 观测面（panel/status/板面）都不计它，checkpoint 此前计（V097-21 缺陷形态）。
    const staleGhost = createMessage("bob", "alice", "stale", { taskId: "t-gone" });
    for (const m of [plain, read, staleGhost]) {
      await appendMailbox(stateRoot, "default", "alice", m);
    }
    await mutateMailbox(stateRoot, "default", "alice", [read.id], (m) => ({ ...m, readAt: Date.now() }));
    identityStore.bind("conn-alice", bindIdentity("alice", "sess-alice"));

    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["unread"]).toBe(1); // 只剩 plain（旧实现此处为 3）

    const path = String(payload["path"]);
    const text = await readFile(path, "utf8");
    expect(text).toContain("unread: 1"); // front-matter
    expect(text).not.toContain("stale"); // 第 5 章索引不含陈旧件

    const checkpointEvent = (await engineEvents()).find((e) => e["event"] === "checkpoint");
    expect(checkpointEvent).toMatchObject({ agentKey: "alice", unread: 1 });
  });
});

// ---------------------------------------------------------------------------
// D7 面 2：member-add 投产 backlog（in-domain extension，同判据）
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O D7（V097-21）：member-add 投产 backlog 与观测面同源", () => {
  it("陈旧-only 邮箱 → backlog 0、不发起唤醒（不制造「邮箱有 N 条未读」假票文）", async () => {
    await seedLeadOnly();
    // 只塞一条陈旧件（taskId 指向不存在任务）——全部观测面同刻报 0。
    await appendMailbox(stateRoot, "default", "m1", createMessage("lead", "m1", "stale-only", { taskId: "t-gone" }));
    identityStore.bind("conn-lead", bindIdentity("lead", "sess-lead"));

    const res = await handleTeam(deps, { action: "member-add", name: "m1" }, "conn-lead");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["backlog"]).toBe(0);
    expect(payload["delivered"]).toBe("skipped");
    expect(wakeCalls).toHaveLength(0); // 零唤醒：没有可投递的现行件
    expect(res.content[0]!.text).not.toContain("backlog 1"); // 不出「1 条未读」票文
  });

  it("plain 未读 → backlog 1 且唤醒带上真实 receiptIds（判据收紧不误伤正常路径）", async () => {
    await seedLeadOnly();
    const plain = createMessage("lead", "m2", "建员前积压：先读我");
    await appendMailbox(stateRoot, "default", "m2", plain);
    identityStore.bind("conn-lead", bindIdentity("lead", "sess-lead"));

    const res = await handleTeam(deps, { action: "member-add", name: "m2" }, "conn-lead");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["backlog"]).toBe(1);
    expect(payload["delivered"]).toBe("wake");
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.receiptIds).toEqual([plain.id]);
  });
});

// ---------------------------------------------------------------------------
// D7 面 3：member-stop 留档未读索引（in-domain extension，同判据）
// ---------------------------------------------------------------------------

describe("v0.9.8 组 O D7（V097-21）：member-stop 留档未读索引与观测面同源", () => {
  it("陈旧件不进 meta.json unread 索引（只剩 plain）", async () => {
    // sessionId 置空 ⇒ 收尾唤醒走 skipped（不拉真会话）。
    await seedTeam([], [member("b", { state: "ready", sessionId: "" })]);
    const plain = createMessage("carol", "b", "停机前记得看");
    const staleGhost = createMessage("carol", "b", "stale", { taskId: "t-gone" });
    await appendMailbox(stateRoot, "default", "b", plain);
    await appendMailbox(stateRoot, "default", "b", staleGhost);
    identityStore.bind("conn-lead", bindIdentity("lead", "sess-lead"));

    const res = await createMemberToolCore(deps).xc_member_stop({ name: "b" }, "conn-lead");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as { archive?: { metaPath: string } };
    const metaPath = String(payload.archive?.metaPath);
    expect(metaPath).not.toBe("undefined");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as { unread: Array<{ msgId: string }> };
    expect(meta.unread.map((u) => u.msgId)).toEqual([plain.id]); // 陈旧件被判据剔除
  });
});
