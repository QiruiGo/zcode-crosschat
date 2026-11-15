/**
 * v0.7（C8，DESIGN-V0.7.md §4.3 / AC8）xc_overview team 视图的 offlineMembers 挂载：
 * - 离线成员（进程死硬证据）→ payload.offlineMembers + `Offline: <名>(证据, 名下任务 n 个 → …)` 文本行；
 * - 活着但空闲的成员 → 不挂载（空闲 ≠ 离线，AC8 不误标）；
 * - XC_OFFLINE_MINUTES 低于 stale 阈值 → offlineThresholdClamped + WARNING（阈值保守可配）；
 * - peer 扫描意外（根不可读）→ 不挂载但任务板照常（观测面永不为难任务板）。
 *
 * peer 根一律指向临时目录（XC_MESSAGING_DIR 优先于一切回退路径）——绝不碰机器全局注册表。
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolCore, type ToolDeps } from "./core.js";
import { createTeamOverviewCore } from "./tools-overview.js";
import { writeSession } from "../core/registry.js";
import { localPidDomain } from "../core/peerdir.js";
import { payloadOf, type ToolResult } from "./protocol.js";

/** 一个确定不存在的 pid（pidAlive → ESRCH → false）：进程死硬证据。 */
const DEAD_PID = 2_147_483_646;

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;
let core: ReturnType<typeof createToolCore>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-off-mount-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true });
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } };
  core = createToolCore(deps);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 落一条 peer 注册记录（lastSeen 陈旧 = 死记录；pid 亡 = 进程死硬证据）。 */
async function writePeerRecord(sid: string, pid: number, lastSeen: number): Promise<void> {
  await writeFile(
    join(peerRoot, "sessions", `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: sid,
      messagingSocketPath: "\\\\.\\pipe\\LOCAL\\xcc-msg-offmount",
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "bg",
      formerNames: [],
      startedAt: Date.now() - 3_600_000,
      lastSeen,
    }),
    "utf8",
  );
}

async function register(name: string, sid: string, conn: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  const res = await core.xc_register({ name, sessionId: sid }, conn);
  expect(res.isError, JSON.stringify(payloadOf(res))).toBeFalsy();
}

/** 派一单给 to 并让其认领 + 推进到 in_progress（最小在途任务）。 */
async function dispatchAndClaim(conn: string, to: string, memberConn: string): Promise<string> {
  const d = await core.xc_dispatch({ to, title: "T", prompt: "P" }, conn);
  expect(d.isError, JSON.stringify(payloadOf(d))).toBeFalsy();
  const taskId = payloadOf(d)["taskId"] as string;
  const claim = await core.xc_claim({ taskId }, memberConn);
  expect(claim.isError, JSON.stringify(payloadOf(claim))).toBeFalsy();
  const attemptId = payloadOf(claim)["attemptId"] as string;
  const started = await core.xc_report({ taskId, attemptId, status: "in_progress" }, memberConn);
  expect(started.isError, JSON.stringify(payloadOf(started))).toBeFalsy();
  return taskId;
}

async function overview(): Promise<{ result: ToolResult; payload: Record<string, unknown>; text: string }> {
  const result = await createTeamOverviewCore(deps).xc_status({}, "conn-overview");
  const payload = payloadOf(result) as Record<string, unknown>;
  const text = (result.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
  return { result, payload, text };
}

describe("xc_overview team 视图：C8 offlineMembers 挂载", () => {
  it("属主进程死（pid-dead）→ offlineMembers 块 + Offline 文本行（证据/任务数/重派建议）", async () => {
    await register("a", "sess-off-a", "conn-off-a");
    await register("m1", "sess-off-m1", "conn-off-m1");
    const t1 = await dispatchAndClaim("conn-off-a", "m1", "conn-off-m1");
    await writePeerRecord("sess-off-m1", DEAD_PID, Date.now() - 3_600_000); // 崩溃残留

    const { payload, text } = await overview();
    const members = payload["offlineMembers"] as Array<Record<string, unknown>> | undefined;
    expect(members).toHaveLength(1);
    expect(members![0]).toMatchObject({
      key: "m1",
      liveness: "pid-dead",
      evidence: "process-dead",
      sessionId: "sess-off-m1",
    });
    expect((members![0]!["tasks"] as Array<Record<string, unknown>>)[0]).toMatchObject({ taskId: t1, status: "in_progress" });
    // 文本行（§4.3 行格式）
    expect(text).toContain("Offline: m1(process-dead, 名下任务 1 个 → 建议 xc_dispatch 重派)");
    // lead（a）名下无任务 → 不进清单
    expect(members!.some((m) => m["key"] === "a")).toBe(false);
  });

  it("属主活着但空闲（heartbeat-stale）→ 不挂载 offlineMembers（空闲 ≠ 离线）", async () => {
    await register("a", "sess-off-a", "conn-off-a");
    await register("m1", "sess-off-m1", "conn-off-m1");
    await dispatchAndClaim("conn-off-a", "m1", "conn-off-m1");
    // pid 活着（本进程）、心跳过期：进程活着，只是空闲/长回合。
    await writePeerRecord("sess-off-m1", process.pid, Date.now() - 3_600_000);

    const { payload, text } = await overview();
    expect(payload["offlineMembers"]).toBeUndefined();
    expect(text).not.toContain("Offline:");
  });

  it("无注册记录（回合间隙）→ 不挂载（成员瞬态，不可检出为离线）", async () => {
    await register("a", "sess-off-a", "conn-off-a");
    await register("m1", "sess-off-m1", "conn-off-m1");
    await dispatchAndClaim("conn-off-a", "m1", "conn-off-m1");

    const { payload, text } = await overview();
    expect(payload["offlineMembers"]).toBeUndefined();
    expect(text).not.toContain("Offline:");
  });

  it("XC_OFFLINE_MINUTES 低于 stale 阈值 → offlineThresholdClamped + WARNING（阈值保守可配）", async () => {
    deps.env["XC_OFFLINE_MINUTES"] = "5"; // < XC_STALE_TASK_MINUTES 缺省 30
    await register("a", "sess-off-a", "conn-off-a");
    await register("m1", "sess-off-m1", "conn-off-m1");
    await dispatchAndClaim("conn-off-a", "m1", "conn-off-m1");

    const { payload, text } = await overview();
    expect(payload["offlineThresholdClamped"]).toBe(true);
    expect(text).toContain("WARNING XC_OFFLINE_MINUTES 低于僵尸清扫阈值");
  });

  it("peer 根不可读（扫描异常面）→ 不挂载但任务板照常（观测面永不为难任务板）", async () => {
    await register("a", "sess-off-a", "conn-off-a");
    await register("m1", "sess-off-m1", "conn-off-m1");
    await dispatchAndClaim("conn-off-a", "m1", "conn-off-m1");
    // 把 peer 根换成一个**文件**路径：readdir 失败 → scanPeers 返回空结果（不抛）。
    deps.env["XC_MESSAGING_DIR"] = join(workDir, "peer-root", "sessions", `${DEAD_PID}.json`);

    const { payload, text } = await overview();
    expect(payload["offlineMembers"]).toBeUndefined();
    expect(Array.isArray(payload["tasks"])).toBe(true); // 任务板照常
    expect(text).not.toContain("Offline:");
  });
});
