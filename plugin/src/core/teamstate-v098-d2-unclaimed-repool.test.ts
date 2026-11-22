/**
 * v0.9.8（D2/V097-07）定向测试：**未认领单的回池判据改用 to + 供给失败回池/通知**。
 *
 * 缺陷形态（49-v098 方案 §二 组 D D2）：xc_dispatch 带 `to` 建单时任务只有受领人
 * 预留（task.to）、assignee 仍为 null（认领才落 assignee）。成员供给失败
 * （state=failed）或停机（removed）后，旧回池判据只看 `task.assignee === key`
 * （memberOpenTasks）——未认领单不在域内：他人 claim 得 not_assignee（to 硬闸）、
 * 失败/停机成员自己无法认领、pending 又不在 stale 清扫域 → 任务永久搁浅，创建者
 * 收不到任何回执。
 *
 * 本文件覆盖：
 * 1. 回池判据 memberUnclaimedTasks：pending ∧ assignee 空 ∧ to 命中（三种否定形态
 *    不误入：已认领/无 to/派给别人）；
 * 2. releaseUnclaimedTask：删 to 回共享待领池 + history + 幂等 no-op；
 * 3. repoolUnclaimedTasksForFailedMember 端到端（团队锁内）：任务回池 + 创建者收到
 *    task-receipt（status=failed，error 说明 provision-failed）+ 审计
 *    member-unclaimed-repooled{name,taskIds}；别人的单不动；重入幂等；
 * 4. sweepStaleProvisioningLocked（供给超时清扫面）：被置 failed 的成员未认领单连带
 *    回池并记 releasedTaskIds（调用方 writeTeam 即落盘）；
 * 5. provisionMember **真实失败路径**（假 app-server：create 成功 → setModel 被拒）：
 *    供给失败即回池 + 创建者回执 + 票据回收照常（v0.9.6 R1② 不退步）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  makeTask,
  memberUnclaimedTasks,
  newTeamState,
  readTeam,
  releaseUnclaimedTask,
  repoolUnclaimedTasksForFailedMember,
  sweepStaleProvisioningLocked,
  writeTeam,
} from "./teamstate.js";
import type { TeamState } from "./types.js";
import { appendMailbox, readMailbox } from "./mailbox.js";
import { engineLogFile } from "./paths.js";
import { existsSync, readFileSync } from "node:fs";
import { provisionMember, ProvisionError } from "../engine/provision.js";
import type { ToolDeps } from "../mcp/core.js";
import type { TeamMember, Task } from "./types.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-v098-d2-repool-"));
  dirs.push(root);
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

function member(overrides: Partial<TeamMember> & { key: string }): TeamMember {
  const { key, ...rest } = overrides;
  return {
    key,
    sessionId: "",
    role: "worker",
    joinedAt: 1,
    lastSeen: 1,
    identity: "engine",
    state: "ready",
    ...rest,
  } as TeamMember;
}

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = engineLogFile(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 建队：lead a + provisioning 成员 b（供给中，可收派发单）+ 对照成员 c。 */
function seedTeam(now = 1_000): TeamState {
  const team = newTeamState({ teamId: "default", founderKey: "a", now });
  team.members.push(member({ key: "a", sessionId: "sess_a", state: "ready" }));
  team.members.push(
    member({ key: "b", state: "provisioning", provisionedAt: now, provisionDeadlineAt: now + 360_000 }),
    member({ key: "c", sessionId: "sess_c", state: "ready" }),
  );
  return team;
}

describe("v0.9.8 D2：未认领单的回池判据（assignee 空时按 to 匹配）", () => {
  it("【D2 锚点】判据三件齐：pending ∧ assignee 空 ∧ to 命中；三种否定形态不误入", () => {
    const team = seedTeam();
    makeTask(team, { title: "t-unclaimed", prompt: "p", to: "b", createdBy: "a" }, 1_000);
    makeTask(team, { title: "t-claimed", prompt: "p", to: "b", createdBy: "a" }, 1_000);
    makeTask(team, { title: "t-noto", prompt: "p", createdBy: "a" }, 1_000);
    makeTask(team, { title: "t-other", prompt: "p", to: "c", createdBy: "a" }, 1_000);
    // 把第二张单认领走（assignee 落值）。
    const claimed = team.tasks[1]!;
    claimed.status = "claimed";
    claimed.assignee = "b";
    const hit = memberUnclaimedTasks(team.tasks, "b");
    expect(hit.map((t) => t.title)).toEqual(["t-unclaimed"]);
    // 旧判据（memberOpenTasks，assignee 命中）在此形态下一张都取不到——即缺陷本体。
    expect(
      team.tasks.filter((t: Task) => t.assignee === "b" && ["claimed", "in_progress", "blocked"].includes(t.status)),
    ).toHaveLength(1);
    // 派给 c 的那张是 c 自己的未认领单（判据按 to 精确归属，不串）。
    expect(memberUnclaimedTasks(team.tasks, "c").map((t) => t.title)).toEqual(["t-other"]);
  });

  it("releaseUnclaimedTask：删 to 回共享待领池 + history + updatedAt/lastProgressTs 刷新；幂等 no-op", () => {
    const team = seedTeam();
    const task = makeTask(team, { title: "t", prompt: "p", to: "b", createdBy: "a" }, 1_000);
    expect(releaseUnclaimedTask(task, { by: "engine", now: 5_000, event: "released-member-unavailable" })).toBe(true);
    expect(task.to).toBeUndefined(); // 共享待领池：任何成员可 claim（to 硬闸解除）
    expect(task.status).toBe("pending"); // 状态不动（从未被认领）
    expect(task.history.at(-1)).toMatchObject({ event: "released-member-unavailable", by: "engine", ts: 5_000 });
    expect(task.updatedAt).toBe(5_000);
    expect(task.lastProgressTs).toBe(5_000);
    // 幂等：第二发 no-op（to 已清）。
    expect(releaseUnclaimedTask(task, { now: 6_000 })).toBe(false);
    expect(task.history).toHaveLength(1);
    // 否定形态一律 no-op（不误释放别人的在途单）。
    const claimed = makeTask(team, { title: "c", prompt: "p", to: "b", createdBy: "a" }, 1_000);
    claimed.status = "claimed";
    claimed.assignee = "b";
    expect(releaseUnclaimedTask(claimed)).toBe(false);
    expect(claimed.to).toBe("b");
  });
});

describe("v0.9.8 D2：repoolUnclaimedTasksForFailedMember（锁内回池 + 创建者通知）", () => {
  it("【D2 锚点】供给失败 → 未认领单回池 + 创建者收到 task-receipt + 审计；别人的单不动；重入幂等", async () => {
    const team = seedTeam();
    const mine = makeTask(team, { title: "t-b-1", prompt: "p", to: "b", createdBy: "a" }, 1_000);
    const mine2 = makeTask(team, { title: "t-b-2", prompt: "p", to: "b", createdBy: "a" }, 1_000);
    const other = makeTask(team, { title: "t-c-1", prompt: "p", to: "c", createdBy: "a" }, 1_000);
    await writeTeam(root, team);
    // 创建者 a 的邮箱先有一条无关消息（证明回执是追加、不覆盖）。
    await appendMailbox(root, "default", "a", {
      id: "pre-1", from: "c", to: "a", content: "hello", ts: 1,
    });

    const released = await repoolUnclaimedTasksForFailedMember(root, "default", "b", {
      reason: "provision-failed",
      detail: "setModel: fake refusal",
    });
    expect(released.map((r) => r.taskId).sort()).toEqual([mine.id, mine2.id].sort());

    // ① 任务回池：to 清空（他人可认领）、状态仍 pending；派给 c 的单不动。
    const after = await readTeam(root, "default");
    const byId = new Map(after!.tasks.map((t) => [t.id, t]));
    expect(byId.get(mine.id)!.to).toBeUndefined();
    expect(byId.get(mine.id)!.status).toBe("pending");
    expect(byId.get(mine.id)!.history.at(-1)).toMatchObject({ event: "released-member-unavailable" });
    expect(byId.get(mine2.id)!.to).toBeUndefined();
    expect(byId.get(other.id)!.to).toBe("c"); // 别人的单原样

    // ② 创建者 a 收到 task-receipt（status=failed，error 说明供给失败 + 已回池）。
    const inbox = await readMailbox(root, "default", "a");
    expect(inbox).toHaveLength(3); // 无关消息 + 两张回执
    const receipts = inbox.filter((m) => m.from === "b" && m.id !== "pre-1");
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      const frame = JSON.parse(receipt.content) as Record<string, unknown>;
      expect(frame["type"]).toBe("task-receipt");
      expect(frame["status"]).toBe("failed");
      expect(frame["taskId"]).toMatch(/^[0-9a-f]{8}-t\d+$/); // 任务 id 形如 <era>-t<n>
      expect(String(frame["error"])).toContain("provision-failed");
      expect(String(frame["error"])).toContain("setModel: fake refusal"); // detail 透传
      expect(String(frame["error"])).toContain("returned to the pending pool");
      expect(receipt.taskId).toBe(frame["taskId"]);
    }

    // ③ 审计：member-unclaimed-repooled{name,taskIds,reason}。
    const events = readEngineEvents().filter((e) => e["event"] === "member-unclaimed-repooled");
    expect(events).toHaveLength(1);
    expect(events[0]!["name"]).toBe("b");
    expect(events[0]!["reason"]).toBe("provision-failed");
    expect([...(events[0]!["taskIds"] as string[])].sort()).toEqual([mine.id, mine2.id].sort());

    // ④ 重入幂等：第二发零释放、零新邮件、零新审计。
    const again = await repoolUnclaimedTasksForFailedMember(root, "default", "b", { reason: "provision-failed" });
    expect(again).toEqual([]);
    expect(await readMailbox(root, "default", "a")).toHaveLength(3);
    expect(readEngineEvents().filter((e) => e["event"] === "member-unclaimed-repooled")).toHaveLength(1);
  });

  it("无未认领单 = 零写零审计（正常失败不惊动观测面）", async () => {
    const team = seedTeam();
    await writeTeam(root, team);
    const released = await repoolUnclaimedTasksForFailedMember(root, "default", "b", { reason: "provision-failed" });
    expect(released).toEqual([]);
    expect(readEngineEvents().filter((e) => e["event"] === "member-unclaimed-repooled")).toHaveLength(0);
  });
});

describe("v0.9.8 D2：供给超时清扫面（sweepStaleProvisioningLocked）连带回池", () => {
  it("【D2 锚点】超时置 failed 的成员 → 未认领单连带回池 + releasedTaskIds 上报", () => {
    const team = seedTeam(1_000);
    const stranded = makeTask(team, { title: "t-b", prompt: "p", to: "b", createdBy: "a" }, 1_000);
    const other = makeTask(team, { title: "t-c", prompt: "p", to: "c", createdBy: "a" }, 1_000);
    const swept = sweepStaleProvisioningLocked(team, 1_000 + 360_001, 360_000);
    expect(swept.map((s) => s.key)).toEqual(["b"]);
    expect(swept[0]!.releasedTaskIds).toEqual([stranded.id]); // 调用方 writeTeam 即落盘
    expect(stranded.to).toBeUndefined();
    expect(other.to).toBe("c");
    // 未超时的 provisioning 成员不连带（判据不变）。
    expect(team.members.find((m: TeamMember) => m.key === "c")!.state).toBe("ready");
  });

  it("超时但无未认领单 → releasedTaskIds 缺席（旧行为逐字节保持）", () => {
    const team = seedTeam(1_000);
    makeTask(team, { title: "t-c", prompt: "p", to: "c", createdBy: "a" }, 1_000);
    const swept = sweepStaleProvisioningLocked(team, 1_000 + 360_001, 360_000);
    expect(swept).toHaveLength(1);
    expect(swept[0]!.releasedTaskIds).toBeUndefined();
  });
});

describe("v0.9.8 D2：provisionMember 真实失败路径（假 app-server 驱动）", () => {
  it("【D2 锚点】setModel 被拒 → 供给失败即回池 + 创建者回执 + 票据回收照常", async () => {
    // 假 app-server：create 成功（带一个模型枚举）→ setModel 一律回错（非档位类）。
    const fake = join(root, "fake-app-server.mjs");
    writeFileSync(
      fake,
      [
        'let buf = "";',
        'process.stdin.on("data", (chunk) => {',
        '  buf += chunk;',
        '  let nl;',
        '  while ((nl = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, nl).trim();',
        '    buf = buf.slice(nl + 1);',
        '    if (line === "") continue;',
        '    let msg;',
        '    try { msg = JSON.parse(line); } catch { continue; }',
        '    if (msg.method === "session/create") {',
        '      process.stdout.write(JSON.stringify({ id: msg.id, result: {',
        '        session: { sessionId: "sess-fake-prov" },',
        '        settings: { model: { available: [{ ref: { providerId: "p", modelId: "m1" },',
        '          reasoning: { levels: ["low", "high"], defaultLevel: "high" } }] } } } }) + "\\n");',
        '    } else if (msg.method === "session/setModel") {',
        '      process.stdout.write(JSON.stringify({ id: msg.id, error: { message: "fake setModel refusal" } }) + "\\n");',
        '    } else {',
        '      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
        '    }',
        '  }',
        '});',
      ].join("\n"),
      "utf8",
    );

    // 队状态：a 建单派给 provisioning 中的 b（只有 to、无 assignee）。
    const team = seedTeam(1_000);
    const stranded = makeTask(team, { title: "t-b", prompt: "p", to: "b", createdBy: "a" }, 1_000);
    await writeTeam(root, team);

    const deps: ToolDeps = {
      stateRoot: root,
      workspace: "D:\\ws",
      env: { XC_ZCODE_EXE: process.execPath, XC_ZCODE_CJS: fake },
    };
    const err = await provisionMember(deps, { key: "b", mode: "fresh" }).then(
      () => null,
      (e: unknown) => e,
    );
    // 供给确系失败（setModel 步）——证明下方断言走的是真实失败 catch。
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).step).toBe("setModel");
    expect((err as ProvisionError).message).toContain("fake setModel refusal");

    // ① 未认领单回池（to 清空 = 他人可认领）。
    const after = await readTeam(root, "default");
    const task = after!.tasks.find((t) => t.id === stranded.id)!;
    expect(task.to).toBeUndefined();
    expect(task.status).toBe("pending");
    expect(task.history.at(-1)).toMatchObject({ event: "released-member-unavailable" });

    // ② 创建者 a 收到 task-receipt。
    const inbox = await readMailbox(root, "default", "a");
    const receipt = inbox.find((m) => m.taskId === stranded.id);
    expect(receipt).toBeDefined();
    const frame = JSON.parse(receipt!.content) as Record<string, unknown>;
    expect(frame["type"]).toBe("task-receipt");
    expect(frame["status"]).toBe("failed");
    expect(String(frame["error"])).toContain("provision-failed");

    // ③ 审计双落：回池 + 票据回收（v0.9.6 R1② 不退步）。
    const events = readEngineEvents();
    expect(events.some((e) => e["event"] === "member-unclaimed-repooled" && e["name"] === "b")).toBe(true);
    expect(events.some((e) => e["event"] === "wake-nonce-revoked" || e["event"] === "member-add-failed")).toBe(true);
  }, 30_000);
});
