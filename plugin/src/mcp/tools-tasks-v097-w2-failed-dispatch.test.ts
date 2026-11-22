/**
 * v0.9.7（W2/R1）定向测试：**failed/removed 成员派单零新任务**（47-v097 方案 §一 组 W W2）。
 *
 * 缺陷形态（41-v095 real-smoke C §三 R1 残留）：member-add 失败后成员 `state=failed` ∧
 * `sessionId=""`，`xc_dispatch({to:"m1"})` 旧实现**照样建单**——任务永久 pending：
 * failed 成员无法认领、他人得 `not_assignee`、pending 不在 stale-sweep 清扫域，而唤醒侧
 * 只给 mailbox 降级（没有会话可 pull）。与 v0.7.2 C8-B3 修掉的 removed 成员同族。
 *
 * 本文件覆盖（工具面，磁盘真源）：
 * 1. failed 成员派单 → 显式拒绝（error=member-state:failed，payload 带 memberState 与
 *    roster 失败原文）+ **零新任务** + 审计 dispatch-refused{reason:"member-state:failed"}；
 * 2. removed 成员派单 → 仍是 member_removed（v0.7.2 行为不减）+ 零新任务；
 * 3. 正常成员派单 → 不受影响（建单 + 唤醒判定照旧）；
 * 4. provisioning 成员 → 仍可收单（供给完成后投产唤醒 E-e 补投，不误伤）。
 *
 * 驱动方式：createToolCore 对临时 stateRoot 走磁盘真源（与 tools-dispatch-g13.test.ts
 * 同模式）；XC_ZCODE_EXE 钉一个不存在的路径 → attemptWake 在 spawn 配置闸处降级
 * mailbox（不起真进程），派单面的建单/拒绝判定不受影响。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore } from "./core.js";
import { writeSession } from "../core/registry.js";
import { engineLogFile } from "../core/paths.js";
import { readTeam, writeTeam } from "../core/teamstate.js";

let workDir: string;
let stateRoot: string;
let core: ToolCore;

const TICKET = {
  title: "修复 W2 失败成员派单",
  prompt: "给失败成员派单必须被显式拒绝且不建单",
  acceptance: "回执 error=member-state:failed，任务板零新增",
} as const;

/** 不存在的 zcode 路径：attemptWake 走到 spawn 配置闸即降级 mailbox（不起真进程）。 */
const MISSING_ZCODE = "Z:\\definitely-not-installed\\ZCode.exe";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v097-w2-dispatch-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({
    stateRoot,
    workspace: workDir,
    env: {
      XC_MESSAGING_DIR: join(workDir, "peers-root"),
      XC_WAKE_ENABLED: "false",
      XC_ZCODE_EXE: MISSING_ZCODE,
    },
  });
  await hookRegister("conn-a", "a", "sess-a");
  await hookRegister("conn-b", "b", "sess-b");
  await hookRegister("conn-c", "c", "sess-c");
  await hookRegister("conn-d", "d", "sess-d");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 注册辅助：先落 SessionStart 钩子锚点，再走 hook 路径注册。 */
async function hookRegister(conn: string, name: string, sid: string): Promise<ToolResult> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  return core.xc_register({ name, sessionId: sid }, conn);
}

/** 直接把 roster 上某成员改写成指定生命周期形态（failed/removed/provisioning）。 */
async function setMemberState(
  key: string,
  state: "provisioning" | "failed" | "removed",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const team = await readTeam(stateRoot, "default");
  expect(team).toBeDefined();
  const idx = team!.members.findIndex((m) => m.key === key);
  expect(idx, `member ${key} on roster`).toBeGreaterThanOrEqual(0);
  team!.members[idx] = {
    ...team!.members[idx]!,
    state,
    // 真实复测形态：供给失败的成员 sid 被清空（半程死亡/超时清扫）。
    sessionId: state === "failed" || state === "removed" ? "" : team!.members[idx]!.sessionId,
    ...extra,
  };
  await writeTeam(stateRoot, team!);
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function taskCount(): Promise<number> {
  return (await readTeam(stateRoot, "default"))?.tasks.length ?? 0;
}

describe("v0.9.7 W2：failed/removed 成员派单显式拒绝、不建单", () => {
  it("【W2 锚点】failed 成员（sid=\"\"）派单 → member-state:failed + 零新任务 + 审计指向该态", async () => {
    await setMemberState("b", "failed", { error: 'setModel: Reasoning effort "max" is not supported' });
    const before = await taskCount();
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res);
    expect(payload["error"]).toBe("member-state:failed");
    expect(payload["memberState"]).toBe("failed");
    expect(String(payload["message"])).toContain("member-add");
    expect(String(payload["message"])).toContain("member-state:failed");
    // 失败原文随回执披露（诊断面：知道是哪个供给根因）。
    expect(String(payload["rosterError"])).toContain("Reasoning effort");
    // 零新任务（旧实现在此处建单 → 永久 pending）。
    expect(await taskCount()).toBe(before);
    const refused = (await engineEvents()).filter((e) => e["event"] === "dispatch-refused");
    expect(refused.length).toBe(1);
    expect(refused[0]!["reason"]).toBe("member-state:failed");
    expect(refused[0]!["to"]).toBe("b");
  });

  it("【W2 锚点】failed 成员派单不写邮箱（不留下永远没人读的派发信封）", async () => {
    await setMemberState("b", "failed");
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(res.isError).toBe(true);
    const inbox = await core.xc_check_inbox({}, "conn-b");
    expect(payloadOf(inbox)["unreadCount"]).toBe(0);
  });

  it("【硬回归】removed 成员派单 → member_removed（v0.7.2 C8-B3 行为不减）+ 零新任务", async () => {
    await setMemberState("c", "removed", { stopReason: "member-stop" });
    const before = await taskCount();
    const res = await core.xc_dispatch({ to: "c", ...TICKET }, "conn-a");
    expect(res.isError).toBe(true);
    expect(payloadOf(res)["error"]).toBe("member_removed");
    expect(await taskCount()).toBe(before);
    const refused = (await engineEvents()).filter((e) => e["event"] === "dispatch-refused");
    expect(refused[refused.length - 1]!["reason"]).toBe("member_removed");
  });

  it("【硬回归】正常成员派单不受影响（建单 + 唤醒判定照旧）", async () => {
    const res = await core.xc_dispatch({ to: "d", ...TICKET }, "conn-a");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res);
    expect(payload["delivered"]).toBe("mailbox"); // spawn 配置闸降级（不起真进程）
    expect(typeof payload["taskId"]).toBe("string");
    expect(await taskCount()).toBe(1);
    // 未读信封确实落到目标邮箱（派单本身成功）。
    const inbox = await core.xc_check_inbox({}, "conn-d");
    expect(payloadOf(inbox)["unreadCount"]).toBe(0); // 刚被本断言读掉
  });

  it("【硬回归】provisioning 成员仍可收单（供给完成后投产唤醒 E-e 补投）", async () => {
    await setMemberState("b", "provisioning");
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(res.isError).toBeFalsy();
    expect(typeof payloadOf(res)["taskId"]).toBe("string");
    expect(await taskCount()).toBe(1);
  });
});
