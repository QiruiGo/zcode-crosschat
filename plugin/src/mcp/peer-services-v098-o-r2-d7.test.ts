/**
 * v0.9.8 组 O：panel 成员行两面定向单测（peer-services.ts）。
 *
 * **D7（V097-21）panel 未读同源**：成员行 unread 与 status/team 板面/邮箱真源
 * 逐键相等——陈旧信封（taskId 指向不存在任务 / attempt 已换代）**不计入**，
 * 已读/已丢弃不计入。判据收敛到 core/checkpoint.ts unreadCountFor 单一真源后，
 * 本文件用「同一邮箱三面一致 + 独立复算」钉死它（复制的判据必然漂移）。
 *
 * **R2 成员行可寻址名**：peerName = 该成员 sessionId 对应的活跃 peer 花名
 * （跨会话 xc_relay({to:"<peerName>"}) 可直接复制）；无活跃 peer 记录的成员
 * **absent**（仅队内 key 可达——诚实缺失，不给发不到的名字）；死 peer 记录不进表。
 * 队内 key 恒在 key 列——两种地址都在行上。
 *
 * 纪律：不跑全量单测（脚本统一恰跑一次）；本文件只测组 O 自有面。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { resetPeerServicesForTests } from "./peer-services.js";
import {
  appendMailbox,
  createMessage,
  isCurrentMail,
  mutateMailbox,
  readMailbox,
} from "../core/mailbox.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import { localPidDomain } from "../core/peerdir.js";
import { writePeerRecord } from "../core/peerregistry.js";
import type { Task, TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";

/** 容量颜色钉成 GREEN（panel/status 都挂 capacity 块，避免红规则干扰未读断言）。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

const MIN = 60_000;
const T0 = Date.now();

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v098-o-panel-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true });
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot } };
});

afterEach(async () => {
  // panel 走 getPeerServices 的进程级单例（首调用的 deps 定死 stateRoot）——换根前必须重置。
  resetPeerServicesForTests();
  await rm(workDir, { recursive: true, force: true });
});

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key,
    sessionId: `sess-${key}`,
    role: "worker",
    joinedAt: T0 - 300 * MIN,
    lastSeen: T0 - MIN,
    state: "ready",
    identity: "engine",
    ...overrides,
  };
}

function task(id: string, status: Task["status"], assignee: string | null): Task {
  return {
    id,
    title: `任务 ${id}`,
    prompt: "p",
    dependsOn: [],
    status,
    assignee,
    attempt: assignee === null ? 0 : 1,
    attemptId: null,
    createdBy: "lead",
    createdAt: T0 - 60 * MIN,
    updatedAt: T0 - 20 * MIN,
    lastProgressTs: T0 - 20 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: T0 - 20 * MIN, event: "report", by: "lead" }],
  };
}

/** 三成员：lead（无 peer 记录）/ alice（活跃 peer 记录 alice-pc）/ bob（仅死记录）。 */
async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    name: "default",
    founderKey: "lead",
    founder: member("lead"),
    now: T0,
  });
  team.leadKey = "lead";
  team.members.push(member("alice"), member("bob"));
  team.tasks = [task("t-ip", "in_progress", "alice")];
  await writeTeam(stateRoot, team);
}

/** 写一条活跃 peer 记录（pid=本进程 ⇒ 活性判据成立）。 */
async function writeLivePeer(sessionId: string, name: string): Promise<void> {
  await writePeerRecord(peerRoot, {
    pid: process.pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xcc-msg-${name}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name,
    formerNames: [],
    startedAt: T0 - MIN,
    lastSeen: T0,
  });
}

function panelMembers(res: ToolResult): Array<{ key: string; unread: number; peerName?: string }> {
  const payload = payloadOf(res) as { members: Array<{ key: string; unread: number; peerName?: string }> };
  return payload.members;
}

function statusUnread(res: ToolResult): Record<string, number> {
  return (payloadOf(res) as { unread: Record<string, number> }).unread;
}

/** 邮箱真源现数（不经任何观测面）：未读 ∧ 未丢弃 ∧ isCurrentMail。 */
async function trueUnread(): Promise<Record<string, number>> {
  const team = await readTeam(stateRoot, "default");
  if (team === undefined) return {};
  const out: Record<string, number> = {};
  for (const m of team.members) {
    const msgs = await readMailbox(stateRoot, "default", m.key);
    out[m.key] = msgs.filter((msg) => !msg.readAt && !msg.discardedAt && isCurrentMail(team, msg)).length;
  }
  return out;
}

describe("v0.9.8 组 O D7（V097-21）：panel 成员行未读与其余面同源", () => {
  it("【主判据】陈旧/已读/已丢弃不计入：panel == status == 邮箱真源（同一邮箱三面一致）", async () => {
    await seedTeam();
    const plain = createMessage("bob", "alice", "plain");
    const read = createMessage("bob", "alice", "read");
    const staleGhost = createMessage("bob", "alice", "stale", { taskId: "t-gone" });
    for (const m of [plain, read, staleGhost]) {
      await appendMailbox(stateRoot, "default", "alice", m);
    }
    await mutateMailbox(stateRoot, "default", "alice", [read.id], (m) => ({ ...m, readAt: Date.now() }));
    await appendMailbox(stateRoot, "default", "bob", createMessage("carol", "bob", "urgent!", { urgent: true }));

    const panel = panelMembers(await handleOverview(deps, { view: "panel" }, "conn-nobody"));
    const status = statusUnread(await handleOverview(deps, { view: "status" }, "conn-nobody"));
    const expected = { lead: 0, alice: 1, bob: 1 };
    const panelMap = Object.fromEntries(panel.map((m) => [m.key, m.unread]));
    expect(panelMap).toEqual(expected);
    expect(panelMap).toEqual(status);
    expect(panelMap).toEqual(await trueUnread());
  });

  it("无未读态：无邮箱文件 → panel 全 0 且与 status/真源一致（0 是实数不是桩）", async () => {
    await seedTeam();
    const panelMap = Object.fromEntries(
      panelMembers(await handleOverview(deps, { view: "panel" }, "conn-nobody")).map((m) => [m.key, m.unread]),
    );
    expect(panelMap).toEqual({ lead: 0, alice: 0, bob: 0 });
    expect(panelMap).toEqual(statusUnread(await handleOverview(deps, { view: "status" }, "conn-nobody")));
    expect(panelMap).toEqual(await trueUnread());
  });
});

describe("v0.9.8 组 O R2：panel 成员行补可寻址名（peerName）", () => {
  it("活跃 peer 记录 → peerName 可直接复制；无记录/死记录的成员 absent（仅队内可达）", async () => {
    await seedTeam();
    await writeLivePeer("sess-alice", "alice-pc");
    // bob：只有一条**死** peer 记录（pid 取一个必然不活的数）——不可寻址，不进表。
    await writePeerRecord(peerRoot, {
      pid: 999_999_999,
      sessionId: "sess-bob",
      messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xcc-msg-bob-dead",
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      name: "bob-dead-pc",
      formerNames: [],
      startedAt: T0 - MIN,
      lastSeen: T0,
    });

    const panel = panelMembers(await handleOverview(deps, { view: "panel" }, "conn-nobody"));
    const byKey = Object.fromEntries(panel.map((m) => [m.key, m]));
    expect(byKey["alice"]!.peerName).toBe("alice-pc"); // 跨会话可寻址名，可直接复制
    expect(byKey["bob"]!.peerName).toBeUndefined(); // 死记录不给名字（发了也到不了）
    expect(byKey["lead"]!.peerName).toBeUndefined(); // 无 peer 记录
    // 队内 key 恒在——两种地址（队内/跨会话）合起来才构成「可寻址」。
    expect(Object.keys(byKey).sort()).toEqual(["alice", "bob", "lead"]);
  });

  it("R2 两面一致：panel 与 team 板面成员行报同一 peerName（同一解析源）", async () => {
    await seedTeam();
    await writeLivePeer("sess-alice", "alice-pc");

    const panel = Object.fromEntries(
      panelMembers(await handleOverview(deps, { view: "panel" }, "conn-nobody")).map((m) => [m.key, m.peerName]),
    );
    const teamRes = await handleOverview(deps, { view: "team" }, "conn-nobody");
    expect(teamRes.isError).toBeUndefined();
    const teamMembers = (payloadOf(teamRes) as { members: Array<{ key: string; peerName?: string }> }).members;
    const board = Object.fromEntries(teamMembers.map((m) => [m.key, m.peerName]));
    expect(board).toEqual(panel);
    expect(board["alice"]).toBe("alice-pc");
  });
});
