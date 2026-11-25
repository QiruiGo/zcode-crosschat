/**
 * v0.10.0 组 D（G-25）定向单测——xc_identify 的 duty（会话职能声明）可选参数。
 *
 * 锁死契约（G-25 设计建议 1/3「与 boundName 同生命周期维护，换代不丢」）：
 * 1. 常规注册带 duty ⇒ 落 team.json 成员行（清洗后：控制字符清掉、≤120 字符）；
 * 2. **同键重新供给不丢**：同花名换 sid 重注册（不带 duty）⇒ 既有 duty 原样保留；
 * 3. **改名不丢**：改名（不带 duty）⇒ 新键成员行仍带 duty；改名带新 duty ⇒ 覆盖；
 * 4. **takeover 不丢**：接管（不带 duty）⇒ 既有 duty 保留；接管带 duty ⇒ 落盘；
 * 5. wakeToken 路径同样受理 duty（无头回合自带说明）；
 * 6. duty 缺省 ⇒ 不落键（旧行为逐字节不变）。
 *
 * peer 轴以假服务替身（register 恒成功）——本文件只测队内轴的 duty 生命周期。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localPidDomain } from "../core/peerdir.js";
import { writePeerRecord, type PeerRecord } from "../core/peerregistry.js";
import { createWakeNonce, writeSession } from "../core/registry.js";
import { readTeam } from "../core/teamstate.js";
import { DUTY_MAX_CHARS } from "../core/types.js";
import { handleIdentify } from "./tools-identify.js";
import { identityStore } from "./identity.js";
import { payloadOf, type ToolResult } from "./protocol.js";
import {
  createDefaultPeerServices,
  resetPeerServicesForTests,
  setPeerServicesForTests,
  type PeerServices,
} from "./peer-services.js";
import type { ToolDeps } from "./core.js";

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v0100d-identify-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peers-root");
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } as NodeJS.ProcessEnv };
  resetPeerServicesForTests();
});

afterEach(async () => {
  resetPeerServicesForTests();
  await rm(workDir, { recursive: true, force: true });
});

let connSeq = 0;
function nextConn(): string {
  connSeq += 1;
  return `conn-v0100d-${connSeq}`;
}

/** 假 peer 服务：register/rename 恒成功（本文件只测队内轴 duty）。 */
function fakePeerServices(): PeerServices {
  const base = createDefaultPeerServices(deps);
  return {
    ...base,
    async register(input) {
      return {
        name: input.name,
        sessionId: input.sessionId,
        pid: process.pid,
        socketPath: "\\\\.\\pipe\\LOCAL\\xcc-v0100d-fake",
        keyFile: "C:\\peers\\keys\\fake.key",
        tokenHint: "deadbeef",
        modeClassSource: "base-record",
      };
    },
    async rename(name: string) {
      return { name, formerName: "prev", notified: [] };
    },
  };
}

async function anchorSession(sid: string): Promise<void> {
  await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
}

async function identify(
  args: { name: string; sessionId: string; takeover?: boolean; duty?: string; wakeToken?: string },
  connectionKey: string,
): Promise<{ result: ToolResult; payload: Record<string, unknown> }> {
  const result = await handleIdentify(deps, args, connectionKey);
  return { result, payload: payloadOf(result) as Record<string, unknown> };
}

async function rosterDutyOf(key: string): Promise<string | undefined> {
  const team = await readTeam(stateRoot, "default");
  return team?.members.find((m) => m.key === key)?.duty;
}

/** 让一个「旧持有者已死」的 peer 记录在场（takeover 活信号闸的判死输入）。 */
async function seedDeadPeerRecord(sid: string, name: string, pid: number): Promise<void> {
  const record: PeerRecord = {
    pid, // 不存在的 pid：findLiveSessionIdHolder 判死
    sessionId: sid,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xcc-v0100d-${Math.random().toString(16).slice(2)}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name,
    formerNames: [],
    startedAt: Date.now() - 3_600_000,
    lastSeen: Date.now() - 3_600_000,
  };
  await writePeerRecord(peerRoot, record);
}

describe("v0.10.0 组 D / G-25：xc_identify duty", () => {
  it("常规注册带 duty ⇒ 落花名册成员行（回执无 warning）", async () => {
    setPeerServicesForTests(fakePeerServices());
    await anchorSession("sess-d1");
    const { payload } = await identify({ name: "wk", sessionId: "sess-d1", duty: "负责唤醒链路值守" }, nextConn());
    expect(payload.warnings).toBeUndefined();
    expect(await rosterDutyOf("wk")).toBe("负责唤醒链路值守");
  });

  it("duty 入库前清洗：控制字符清掉 + 超 120 字符截断", async () => {
    setPeerServicesForTests(fakePeerServices());
    await anchorSession("sess-d2");
    const raw = `看\u0000闸\u001f${"x".repeat(300)}`;
    await identify({ name: "wk2", sessionId: "sess-d2", duty: raw }, nextConn());
    const stored = await rosterDutyOf("wk2");
    expect(stored).toBeDefined();
    expect(stored).toHaveLength(DUTY_MAX_CHARS);
    expect(stored!.endsWith("…")).toBe(true);
    expect(stored).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(stored!.startsWith("看 闸")).toBe(true);
  });

  it("duty 缺省 ⇒ 不落键（旧行为不变）", async () => {
    setPeerServicesForTests(fakePeerServices());
    await anchorSession("sess-d3");
    await identify({ name: "wk3", sessionId: "sess-d3" }, nextConn());
    expect(await rosterDutyOf("wk3")).toBeUndefined();
    const team = await readTeam(stateRoot, "default");
    expect(Object.keys(team!.members[0]!)).not.toContain("duty");
  });

  it("同键重新供给（同 name+sid 精确对重绑，不带 duty）⇒ duty 不丢", async () => {
    setPeerServicesForTests(fakePeerServices());
    await anchorSession("sess-d4-first");
    await identify({ name: "wk4", sessionId: "sess-d4-first", duty: "值守" }, nextConn());
    // 精确对重绑（会话重启/重连的幂等路径；不同 sid 抢名仍 name_taken——另测）
    const again = await identify({ name: "wk4", sessionId: "sess-d4-first" }, nextConn());
    expect(again.result.isError).toBeFalsy();
    expect(await rosterDutyOf("wk4")).toBe("值守");
    const team = await readTeam(stateRoot, "default");
    expect(team!.members).toHaveLength(1); // 不产生重复成员行
  });

  it("不同 sid 抢名（无 takeover）⇒ name_taken 显式拒，duty 原样留在旧行", async () => {
    setPeerServicesForTests(fakePeerServices());
    await anchorSession("sess-d4-first");
    await identify({ name: "wk4b", sessionId: "sess-d4-first", duty: "值守" }, nextConn());
    await anchorSession("sess-d4-second");
    const stolen = await identify({ name: "wk4b", sessionId: "sess-d4-second" }, nextConn());
    expect(stolen.payload.error).toBe("name_taken");
    expect(await rosterDutyOf("wk4b")).toBe("值守");
  });

  it("改名（不带 duty）⇒ 新键仍带 duty；改名带新 duty ⇒ 覆盖", async () => {
    setPeerServicesForTests(fakePeerServices());
    await anchorSession("sess-d5");
    const conn = nextConn();
    await identify({ name: "old-name", sessionId: "sess-d5", duty: "旧职能" }, conn);
    // 改名（板面干净：无任务无邮箱）——peer 轴 rename 假成功
    await identify({ name: "new-name", sessionId: "sess-d5" }, conn);
    expect(await rosterDutyOf("new-name")).toBe("旧职能");
    expect(await rosterDutyOf("old-name")).toBeUndefined();
    // 再改名并带新 duty ⇒ 覆盖
    await identify({ name: "third-name", sessionId: "sess-d5", duty: "新职能" }, conn);
    expect(await rosterDutyOf("third-name")).toBe("新职能");
  });

  it("takeover（不带 duty）⇒ duty 随成员行保留；takeover 带 duty ⇒ 落盘", async () => {
    setPeerServicesForTests(fakePeerServices());
    // 第一代持有者（活过、带 duty）
    await anchorSession("sess-d6-first");
    await identify({ name: "wk6", sessionId: "sess-d6-first", duty: "一代职能" }, nextConn());
    expect(await rosterDutyOf("wk6")).toBe("一代职能");
    // 第二代：旧 sid 已死（peer 记录 pid 不存在）→ takeover 合法
    await seedDeadPeerRecord("sess-d6-first", "wk6", 999_991);
    await anchorSession("sess-d6-second");
    const taken = await identify({ name: "wk6", sessionId: "sess-d6-second", takeover: true }, nextConn());
    expect(taken.payload.takeover).toBe(true);
    expect(await rosterDutyOf("wk6")).toBe("一代职能"); // 换代不丢知识
    // 第三代：takeover 时重声明职能
    await seedDeadPeerRecord("sess-d6-second", "wk6", 999_992);
    await anchorSession("sess-d6-third");
    await identify({ name: "wk6", sessionId: "sess-d6-third", takeover: true, duty: "三代职能" }, nextConn());
    expect(await rosterDutyOf("wk6")).toBe("三代职能");
  });

  it("wakeToken 路径也受理 duty（无头回合自带说明）", async () => {
    setPeerServicesForTests(fakePeerServices());
    await anchorSession("sess-d7");
    const { token } = await createWakeNonce(stateRoot, {
      teamId: "default",
      agentKey: "wk7",
      sid: "sess-d7",
      now: Date.now(),
    });
    const { payload } = await identify(
      { name: "wk7", sessionId: "sess-d7", wakeToken: token, duty: "无头值守" },
      nextConn(),
    );
    expect(payload.error).toBeUndefined();
    expect(await rosterDutyOf("wk7")).toBe("无头值守");
  });

  it("peer 轴注册失败 ⇒ 队内轴整体回滚，duty 不残留", async () => {
    setPeerServicesForTests({
      ...fakePeerServices(),
      async register(): Promise<never> {
        throw new Error("peer down");
      },
    });
    await anchorSession("sess-d8");
    const { result, payload } = await identify({ name: "wk8", sessionId: "sess-d8", duty: "x" }, nextConn());
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("peer_axis_failed");
    expect(existsSync(join(stateRoot, "teams", "default", "team.json"))).toBe(false);
    const raw = existsSync(join(stateRoot, "teams", "default", "team.json"))
      ? await readFile(join(stateRoot, "teams", "default", "team.json"), "utf8")
      : "";
    expect(raw).not.toContain("duty");
  });
});
