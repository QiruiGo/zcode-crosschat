/**
 * v0.9.7（W3/V096-24）定向测试：**xc_relay 的 wake 回执三态全接线**
 * （47-v097 方案 §一 组 W W3；立项依据 45b-v096 验收补正 V096-24）。
 *
 * 缺陷形态（45b 补正 · 外层独立复验）：`plugin/src/mcp/tools-relay.ts` 的 wake() 只回传
 * `delivered/wakeLog/note/wakeDeferred`——`startConfirmed`/`wakeTiers`/
 * `wakeFailureSeen`/`failureEvidence` 四键**全文件零命中**，`renderMessage` 调用也未传
 * `startConfirmed`；relay 面只有 note 文本披露（与 V096-01 的 dispatch/report 同族）。
 *
 * 本文件覆盖（队内轴 xc_message + 撤回通知帧）：
 * 1. 两轮唤醒全失败 → payload 四键齐全 + 人可读行失败措辞（不写「已发起唤醒」）；
 * 2. 未见启动证据（startConfirmed:false）→ 两态措辞 + startConfirmed 透传；
 * 3. 成功唤醒 → 不误报失败；
 * 4. mailbox 降级 → 无三态键（未唤醒路径无可报）；
 * 5. 撤回通知帧的唤醒回执同样带三态键。
 *
 * 驱动方式：`vi.mock("../engine/wake.js")` 只替换 attemptWake（其余导出走 original）——
 * 不起真进程，直测三态键从 attemptWake 到回执的接线。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { identityStore } from "./identity.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { readMailbox } from "../core/mailbox.js";
import { createTeamRelayCore } from "./tools-relay.js";

const attemptWakeMock = vi.hoisted(() => vi.fn());
vi.mock("../engine/wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/wake.js")>();
  return { ...actual, attemptWake: (...args: unknown[]) => attemptWakeMock(...args) };
});

/** 两轮唤醒全失败（主唤醒 + sessionNotFound 自动重绑重试）的回执形态。 */
function allFailedWake() {
  return {
    delivered: "wake" as const,
    note: "spawned: 无头 --resume 已发起；⚠ 失败侦听：回执时刻 wake 日志已见失败证据（Error: Session not found: sess_deadbeef）",
    wakeLog: "logs/wake-b-1.json",
    startConfirmed: false,
    wakeFailureSeen: true,
    failureEvidence: "Error: Session not found: sess_deadbeef",
    wakeTiers: { spawnOk: "ok" as const, childAlive: "no" as const, consumed: "pending" as const },
  };
}

function unconfirmedWake() {
  return {
    delivered: "wake" as const,
    note: "spawned: 无头 --resume 已发起",
    wakeLog: "logs/wake-b-2.json",
    startConfirmed: false,
    wakeTiers: { spawnOk: "ok" as const, childAlive: "no" as const, consumed: "pending" as const },
  };
}

function startedWake() {
  return {
    delivered: "wake" as const,
    note: "spawned: 无头 --resume 已发起",
    wakeLog: "logs/wake-b-3.json",
    startConfirmed: true,
    wakeTiers: { spawnOk: "ok" as const, childAlive: "ok" as const, consumed: "pending" as const },
  };
}

let workDir: string;
let stateRoot: string;
let peerRoot: string;

beforeEach(() => {
  attemptWakeMock.mockReset();
  workDir = mkdtempSync(join(tmpdir(), "xc-v097-w3-relay-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = mkdtempSync(join(tmpdir(), "xc-v097-w3-relay-peers-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(peerRoot, { recursive: true, force: true });
});

/** 建队：a（发起者）与 b（收件人）。 */
async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: "default", founderKey: "a", now });
  team.members.push(
    { key: "a", sessionId: "sess_a", role: "peer", joinedAt: now, lastSeen: now },
    { key: "b", sessionId: "sess_b", role: "worker", joinedAt: now, lastSeen: now },
  );
  await writeTeam(stateRoot, team);
  identityStore.bind("conn-a", {
    sessionKey: "xc:default:a",
    teamId: "default",
    name: "a",
    agentKey: "a",
    sessionId: "sess_a",
    role: "peer",
    boundAt: now,
  });
}

function core() {
  return createTeamRelayCore({ stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } });
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

describe("v0.9.7 W3：xc_relay 队内轴回执三态", () => {
  it("【W3 锚点】两轮唤醒全失败 → payload 四键齐全 + 人可读行失败措辞（不写已发起唤醒）", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(allFailedWake());
    const res = await core().xc_message({ to: "b", msg: "这条的唤醒两轮都失败了" }, "conn-a");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("wake");
    expect(payload["startConfirmed"]).toBe(false);
    expect(payload["wakeFailureSeen"]).toBe(true);
    expect(payload["failureEvidence"]).toContain("Session not found");
    expect(payload["wakeTiers"]).toEqual({ spawnOk: "ok", childAlive: "no", consumed: "pending" });
    const text = textOf(res);
    expect(text).toContain("唤醒失败");
    expect(text).toContain("pull 兜底");
    expect(text).not.toContain("已发起唤醒（wake，非送达确认）");
  });

  it("【W3 锚点】未见启动证据（startConfirmed:false）→ 两态措辞 + startConfirmed 透传", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(unconfirmedWake());
    const res = await core().xc_message({ to: "b", msg: "未见启动证据" }, "conn-a");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["startConfirmed"]).toBe(false);
    expect(payload["wakeFailureSeen"]).toBeUndefined();
    expect(textOf(res)).toContain("已发起唤醒但未见启动证据");
  });

  it("【W3 锚点】成功唤醒 → 不误报失败", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(startedWake());
    const res = await core().xc_message({ to: "b", msg: "成功唤醒" }, "conn-a");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["startConfirmed"]).toBe(true);
    expect(payload["wakeFailureSeen"]).toBeUndefined();
    expect(payload["failureEvidence"]).toBeUndefined();
    const text = textOf(res);
    expect(text).toContain("已发起唤醒（wake，非送达确认）");
    expect(text).not.toContain("失败");
  });

  it("mailbox 降级（wake-skipped）→ 无三态键、无 via wake 谎话", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue({ delivered: "mailbox", note: "wake-disabled: 交互式会话自动唤醒未开启" });
    const res = await core().xc_message({ to: "b", msg: "仅落邮箱" }, "conn-a");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("mailbox");
    expect(payload["startConfirmed"]).toBeUndefined();
    expect(payload["wakeFailureSeen"]).toBeUndefined();
    expect(textOf(res)).toContain("仅落邮箱");
    expect(textOf(res)).not.toContain("已发起唤醒");
  });

  it("撤回通知帧的唤醒回执同样带三态键 + 失败措辞", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(startedWake());
    await core().xc_message({ to: "b", msg: "待撤回的消息" }, "conn-a");
    const box = await readMailbox(stateRoot, "default", "b");
    const messageId = box[0]!.id;
    attemptWakeMock.mockResolvedValue(allFailedWake());
    const res = await core().xc_message({ to: "b", withdrawMessageIds: [messageId] }, "conn-a");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["delivered"]).toBe("wake");
    expect(payload["wakeFailureSeen"]).toBe(true);
    expect(payload["failureEvidence"]).toContain("Session not found");
    expect(payload["wakeTiers"]).toEqual({ spawnOk: "ok", childAlive: "no", consumed: "pending" });
    expect(textOf(res)).toContain("唤醒失败");
  });
});
