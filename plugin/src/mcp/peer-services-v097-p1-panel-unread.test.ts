/**
 * v0.9.7 组 P（P1 = V096-17）：panel 成员行 unread 接真实未读计数。
 *
 * 缺陷事实（reports/45-v096验收.md V096-17；merged-adjudication-final.json findings[13]）：
 * `agents()` 成员行的 `unread` 恒为硬编码 0——peer-services.ts:1219 是 agents() 内
 * 唯一赋值点（类型声明 :240 `unread: number`）。同刻对照实测：snapshotJson /
 * statusView / 板面都报真值，仅 panel 恒 0 ⇒ 面板机器可读计数失真，任何以
 * panel unread 为依据的消费方得到虚假「无未读」。
 *
 * 修法（47-v097方案 §一组 P）：接真实未读数，与 snapshot（core/snapshot.ts
 * countUnread）/ status·team 板面（tools-overview countUnreadFor）**同源同口径**：
 * 未读 ∧ 未丢弃 ∧ isCurrentMail；读路径无锁（观测面纯读，不动盘、不清扫）。
 *
 * 覆盖面（验收锚点「panel 与其余面同刻未读数一致；有无未读两态都验」）：
 * - 有未读态：panel 成员行 unread = 邮箱真实未读数（lead=0 / alice=2 / bob=1）；
 * - 同刻跨面一致：panel == status payload.unread == team snapshot.json unread
 *   == 邮箱真源现数（readMailbox + isCurrentMail 独立复算，三连调之间零写入）；
 * - 无未读态：无邮箱文件 → 三面全 0（0 是实数，不是硬编码桩）；
 * - 同口径：已读(readAt) / 已丢弃(discardedAt) / 陈旧(taskId 指向不存在任务)
 *   都不计入，且 panel 与 status 仍逐键相等（证明同一裁决，不是「数行数」）；
 * - 无 team.json → members 空数组、面板不崩（unread 面无成员行可失真）。
 *
 * 纪律：不跑全量单测（脚本统一恰跑一次）；本文件只测组 P 自有面。
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { resetPeerServicesForTests } from "./peer-services.js";
import {
  acknowledgeMailbox,
  appendMailbox,
  createMessage,
  isCurrentMail,
  mutateMailbox,
  readMailbox,
} from "../core/mailbox.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import { snapshotFile } from "../core/paths.js";
import type { Task, TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";

/** 容量颜色钉成 GREEN（三条 red 规则都不命中；panel/status/team 三面都挂 capacity 块）。 */
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
  workDir = await mkdtemp(join(tmpdir(), "xc-v097-p1-panel-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true }); // 空 peer 根：无活 peer
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot } };
});

afterEach(async () => {
  // panel 走 getPeerServices 的**进程级单例**（首调用的 deps 定死 stateRoot）——换临时
  // 状态根前必须重置，否则 agents() 读的是上一个用例的 stateRoot（已删除）。
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

/** 三成员 + 两单在途（V096-17 s1 同款规模：lead/alice/bob）。 */
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
  team.tasks = [task("t-ip", "in_progress", "alice"), task("t-blocked", "blocked", "alice")];
  await writeTeam(stateRoot, team);
}

/** panel payload members[] → {key: unread}。 */
function panelUnread(res: ToolResult): Record<string, number> {
  const payload = payloadOf(res) as { members: Array<{ key: string; unread: number }> };
  const out: Record<string, number> = {};
  for (const m of payload.members) out[m.key] = m.unread;
  return out;
}

/** status payload.unread（{key: count}）。 */
function statusUnread(res: ToolResult): Record<string, number> {
  const payload = payloadOf(res) as { unread: Record<string, number> };
  return payload.unread;
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

describe("v0.9.7 P1（V096-17）：panel 成员行 unread 接真实计数", () => {
  it("【修复主判据】有未读态：panel 成员行 unread = 邮箱真实未读数（lead=0/alice=2/bob=1）", async () => {
    await seedTeam();
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m1"));
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m2"));
    await appendMailbox(stateRoot, "default", "bob", createMessage("carol", "bob", "urgent!", { urgent: true }));
    // lead 无邮箱文件 → 0。

    const res = await handleOverview(deps, { view: "panel" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    // 旧实现（硬编码 0）此处为 { lead: 0, alice: 0, bob: 0 }。
    expect(panelUnread(res)).toEqual({ lead: 0, alice: 2, bob: 1 });
  });

  it("同刻跨面一致：panel == status payload.unread == team snapshot.json unread == 邮箱真源", async () => {
    await seedTeam();
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m1"));
    await appendMailbox(stateRoot, "default", "alice", createMessage("bob", "alice", "m2"));
    await appendMailbox(stateRoot, "default", "bob", createMessage("carol", "bob", "urgent!", { urgent: true }));

    // 三连调之间零写入 ⇒ 「同刻」成立（邮箱文件不被任何观测面改动）。
    const panel = panelUnread(await handleOverview(deps, { view: "panel" }, "conn-nobody"));
    const status = statusUnread(await handleOverview(deps, { view: "status" }, "conn-nobody"));
    const teamRes = await handleOverview(deps, { view: "team" }, "conn-nobody");
    expect(teamRes.isError).toBeUndefined();
    const snapshot = JSON.parse(await readFile(snapshotFile(stateRoot, "default"), "utf8")) as {
      unread: Record<string, number>;
    };

    const expected = { lead: 0, alice: 2, bob: 1 };
    expect(panel).toEqual(expected);
    expect(panel).toEqual(status);
    expect(panel).toEqual(snapshot.unread);
    expect(panel).toEqual(await trueUnread());
  });

  it("无未读态：无邮箱文件 → panel 全 0，且与 status/真源一致（0 是实数不是桩）", async () => {
    await seedTeam();

    const panel = panelUnread(await handleOverview(deps, { view: "panel" }, "conn-nobody"));
    const status = statusUnread(await handleOverview(deps, { view: "status" }, "conn-nobody"));
    expect(panel).toEqual({ lead: 0, alice: 0, bob: 0 });
    expect(panel).toEqual(status);
    expect(panel).toEqual(await trueUnread());
  });

  it("同口径：已读/已丢弃/陈旧信封不计入；panel 与 status 仍逐键相等", async () => {
    await seedTeam();
    const plain = createMessage("bob", "alice", "plain");
    const read = createMessage("bob", "alice", "read");
    const dropped = createMessage("bob", "alice", "dropped");
    // taskId 指向不存在的任务（无 attemptId）⇒ isCurrentMail 判陈旧（v0.5.1 故障注-5 口径）。
    const stale = createMessage("bob", "alice", "stale", { taskId: "t-gone" });
    for (const m of [plain, read, dropped, stale]) {
      await appendMailbox(stateRoot, "default", "alice", m);
    }
    await acknowledgeMailbox(stateRoot, "default", "alice", [read.id]); // 盖 readAt
    await mutateMailbox(stateRoot, "default", "alice", [dropped.id], (msg) => ({
      ...msg,
      discardedAt: Date.now(),
    }));

    const panel = panelUnread(await handleOverview(deps, { view: "panel" }, "conn-nobody"));
    const status = statusUnread(await handleOverview(deps, { view: "status" }, "conn-nobody"));
    expect(panel.alice).toBe(1); // 只剩 plain
    expect(panel).toEqual(status);
    expect(panel).toEqual(await trueUnread());
  });

  it("无 team.json → members 空数组、面板不崩（unread 面无成员行）", async () => {
    const res = await handleOverview(deps, { view: "panel" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as { members: unknown[] };
    expect(payload.members).toEqual([]);
  });
});
