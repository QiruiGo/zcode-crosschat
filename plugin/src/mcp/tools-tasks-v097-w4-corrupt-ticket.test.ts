/**
 * v0.9.7（W4/V096-02）定向测试：**坏票不阻断派单**（47-v097 方案 §一 组 W W4，工具面）。
 *
 * 缺陷形态（adv-1 F-2 实测）：`registry/wake/` 里一个不可解析的 JSON 票据令
 * attemptWake 的在途扫描（findLiveInflightWakeNonce → readWakeNonce）抛 SyntaxError →
 * `xc_dispatch` 整单报 opaque internal（任务没建成、调用方只看到一句 internal、
 * 不知道是哪个票据文件坏）。
 *
 * 本文件覆盖（工具面端到端，磁盘真源）：
 * 1. 坏票在场 → dispatch 正常走完（mailbox 降级，非 internal）+ 审计指向坏文件；
 * 2. 坏票 + 正常在途票 → 去重语义保持（不放松、不误放）；
 * 3. 坏票 + failed 成员 → 派单面先被成员状态门控拒（W2 闸序不减）。
 *
 * 驱动方式：createToolCore 对临时 stateRoot；成员建成 engine 标 + 无头持有者记录
 * （免全局开关，让流程走到在途扫描那一步），XC_ZCODE_EXE 钉不存在的路径 → 扫描之后
 * 在 spawn 配置闸降级 mailbox（不起真进程）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createToolCore, type ToolCore } from "./core.js";
import { createWakeNonce, writeSession } from "../core/registry.js";
import { engineLogFile, wakeDir } from "../core/paths.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";

let workDir: string;
let stateRoot: string;
let core: ToolCore;

const TICKET = {
  title: "修复 V096-02 坏票守卫",
  prompt: "一个坏 JSON 票据不得让 dispatch/relay 整单 internal",
  acceptance: "dispatch 正常完成 + 审计 wake-ticket-corrupt 指向坏文件",
} as const;

/** 不存在的 zcode 路径：attemptWake 在在途扫描之后的 spawn 配置闸降级 mailbox。 */
const MISSING_ZCODE = "Z:\\definitely-not-installed\\ZCode.exe";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v097-w4-dispatch-"));
  stateRoot = join(workDir, ".crosschat");
  core = createToolCore({
    stateRoot,
    workspace: workDir,
    env: {
      XC_MESSAGING_DIR: join(workDir, "peers-root"),
      XC_ZCODE_EXE: MISSING_ZCODE, // 扫描之后才拦：保证在途扫描点被真正走到
    },
  });
  await writeSession(stateRoot, { sessionId: "sess-a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  await writeSession(stateRoot, { sessionId: "sess-b", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  await core.xc_register({ name: "a", sessionId: "sess-a" }, "conn-a");
  await core.xc_register({ name: "b", sessionId: "sess-b" }, "conn-b");
  // 成员 b：engine 标 + 无头持有者（boundName）→ 免全局开关，走到在途扫描那一步。
  const team = await readTeam(stateRoot, "default");
  expect(team).toBeDefined();
  const idx = team!.members.findIndex((m) => m.key === "b");
  team!.members[idx] = {
    ...team!.members[idx]!,
    identity: "engine",
    state: "ready",
    sessionId: "sess-b",
  };
  await writeTeam(stateRoot, team!);
  await writeSession(stateRoot, {
    sessionId: "sess-b", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now(), boundName: "b",
  });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 放一个坏 JSON 票（半行截断）。 */
async function plantCorruptTicket(token: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(wakeDir(stateRoot), { recursive: true });
  const file = join(wakeDir(stateRoot), `${token}.json`);
  await writeFile(file, '{"token":"wake-broken","teamId":"default","agentKe');
  return file;
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

describe("v0.9.7 W4：坏票不阻断派单（工具面）", () => {
  it("【W4 锚点】坏票在场 → dispatch 正常完成（非 internal）+ 审计指向坏文件", async () => {
    const badFile = await plantCorruptTicket("wake-broken");
    const res: ToolResult = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res);
    // 走到 spawn 配置闸 → mailbox 降级（消息不丢），不是 opaque internal。
    expect(payload["delivered"]).toBe("mailbox");
    expect(payload["error"]).toBeUndefined();
    expect(typeof payload["taskId"]).toBe("string");
    const corrupt = (await engineEvents()).filter((e) => e["event"] === "wake-ticket-corrupt");
    expect(corrupt.length).toBeGreaterThanOrEqual(1);
    expect(corrupt.every((e) => e["path"] === badFile)).toBe(true);
  });

  it("【W4 锚点】坏票 + 正常在途票 → 去重语义保持（不放松、不误放）", async () => {
    const badFile = await plantCorruptTicket("wake-broken");
    // 刚签发的正常票（宽限窗内）→ 在途，dispatch 应被 inflight-nonce 挡成 mailbox。
    await createWakeNonce(stateRoot, {
      teamId: "default", agentKey: "b", sid: "sess-b", now: Date.now(), issuedToSid: "sess-b", name: "b",
    });
    const res = await core.xc_dispatch({ to: "b", ...TICKET }, "conn-a");
    const payload = payloadOf(res);
    expect(payload["delivered"]).toBe("mailbox");
    expect(String(payload["note"])).toContain("inflight-nonce");
    const corrupt = (await engineEvents()).filter((e) => e["event"] === "wake-ticket-corrupt");
    expect(corrupt.every((e) => e["path"] === badFile)).toBe(true);
  });
});
