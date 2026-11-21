/**
 * v0.9.5（A1/V094-02）：ppid 身份采纳**默认关闭**定向测试（41-v095 方案 §一 组A A 表）。
 *
 * 背景（40-v094验收.md §7.3.1 V094-02）：ppid 采纳只按「恰一条记录 pid==process.ppid ∧
 * cwd 相同 ∧ boundName 非空」采纳；本会话记录因锁预算缺失时，同宿主另一成员的陈旧记录
 * 成唯一命中 → 未 identify 的连接即以他人身份 claim（rogue 领走 t-a2）。修法：
 * - 默认关：XC_ADOPT_BY_PPID=1 才启用整条采纳链；默认走唤醒票据兜底（2 次调用）；
 * - 开启档仍要求：唯一记录（恰一条 pid 命中）+ cwd 一致 + token（记录带锚定令牌）；
 *   多记录不采纳（歧义不猜）。
 *
 * 判据（方案 A1 验收原文）：「默认下不采纳（宁可 2 次调用）；开启时多记录不采纳」。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptByPpidEnabledFromEnv } from "../core/registry.js";
import { adoptHookBoundIdentity, identityStore } from "./identity.js";
import { writeSession } from "../core/registry.js";
import type { SessionRecord } from "../core/types.js";
import { notRegisteredError } from "./protocol.js";

const dirs: string[] = [];
let workspace: string;
let stateRoot: string;
const HOST_PID = process.ppid; // 与 adoptHookBoundIdentity 读取的 process.ppid 对位

beforeEach(() => {
  delete process.env["XC_ADOPT_BY_PPID"]; // 默认档起点（每个用例自管开关）
  workspace = mkdtempSync(join(tmpdir(), "xc-a1-v095-ws-"));
  stateRoot = join(workspace, ".crosschat");
  mkdirSync(join(stateRoot, "registry", "sessions"), { recursive: true });
  dirs.push(workspace);
});

afterEach(() => {
  identityStore.unbind("conn-a1");
  delete process.env["XC_ADOPT_BY_PPID"];
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

async function seedRecord(record: Partial<SessionRecord> & { sessionId: string }): Promise<void> {
  await writeSession(stateRoot, {
    cwd: workspace,
    startedAt: 1,
    lastSeen: 1,
    regToken: "rt-a1-seed",
    ...record,
  } as SessionRecord);
}

const ENABLED = { XC_ADOPT_BY_PPID: "1" };

describe("v0.9.5 A1：ppid 采纳默认关（XC_ADOPT_BY_PPID 解析）", () => {
  it("开关解析：只认字面量 '1'；未设/空串/0/true/on 全部按关闭", () => {
    expect(adoptByPpidEnabledFromEnv({})).toBe(false);
    expect(adoptByPpidEnabledFromEnv({ XC_ADOPT_BY_PPID: "" })).toBe(false);
    expect(adoptByPpidEnabledFromEnv({ XC_ADOPT_BY_PPID: "0" })).toBe(false);
    expect(adoptByPpidEnabledFromEnv({ XC_ADOPT_BY_PPID: "true" })).toBe(false);
    expect(adoptByPpidEnabledFromEnv({ XC_ADOPT_BY_PPID: "on" })).toBe(false);
    expect(adoptByPpidEnabledFromEnv({ XC_ADOPT_BY_PPID: "1" })).toBe(true);
  });

  it("【锚点】默认档：记录完美命中（唯一+pid+cwd+boundName+token）也不采纳 → require 抛 not_registered", async () => {
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1", liveness: "running" });
    // 采纳面（开关在 env 参数，未开启）
    expect(adoptHookBoundIdentity(workspace)).toBeUndefined();
    // 连接面（require 读进程 env；本用例未设 XC_ADOPT_BY_PPID）
    expect(() => identityStore.require("conn-a1")).toThrow(notRegisteredError().message);
    // 开启后才采纳（对照：同一盘面，只差开关）
    const adopted = adoptHookBoundIdentity(workspace, ENABLED);
    expect(adopted).toBeDefined();
    expect(adopted!.agentKey).toBe("m1");
  });

  it("默认档下【串号用例不再复现】：本会话记录缺失 + 同宿主陈旧记录唯一命中 → not_registered（V094-02 TC7 形态）", async () => {
    // V094-02 形态：rogue 自己的记录缺失，盘上只有别的成员的陈旧记录（同宿主同 cwd）。
    await seedRecord({ sessionId: "sess_member_b", pid: HOST_PID, boundName: "member-b", liveness: "running" });
    // 默认档：不采纳——连接无从借他人身份开工，回 not_registered → 模型回合按
    // wakeToken 兜底自证（2 次调用，宁可多一次调用不许错绑）。
    expect(() => identityStore.require("conn-rogue")).toThrow(notRegisteredError().message);
  });
});

describe("v0.9.5 A1：开启档护栏（唯一记录 + cwd + token）", () => {
  it("【方案验收】开启档多记录不采纳：两条记录同 pid → 歧义不猜（宁可 2 次调用）", async () => {
    await seedRecord({ sessionId: "sess_x", pid: HOST_PID, boundName: "m1" });
    await seedRecord({ sessionId: "sess_y", pid: HOST_PID, boundName: "m2" });
    expect(adoptHookBoundIdentity(workspace, ENABLED)).toBeUndefined();
    expect(() => identityStore.require("conn-a1-multi")).toThrow(notRegisteredError().message);
  });

  it("开启档唯一命中 + cwd 一致 + 带 token → 采纳成功（1 次调用开工形态保留）", async () => {
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1", liveness: "running" });
    const adopted = adoptHookBoundIdentity(workspace, ENABLED);
    expect(adopted).toBeDefined();
    expect(adopted!.sessionId).toBe("sess_woken");
    expect(adopted!.name).toBe("m1");
    expect(adopted!.teamId).toBe("default");
  });

  it("开启档无 token（记录缺 regToken）→ 不采纳（非钩子锚定形态）", async () => {
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1", regToken: undefined });
    expect(adoptHookBoundIdentity(workspace, ENABLED)).toBeUndefined();
  });

  it("开启档 token 为空白串 → 不采纳", async () => {
    await seedRecord({ sessionId: "sess_woken", pid: HOST_PID, boundName: "m1", regToken: "   " });
    expect(adoptHookBoundIdentity(workspace, ENABLED)).toBeUndefined();
  });

  it("开启档 cwd 不一致 → 不采纳（别的会话，护栏原样保留）", async () => {
    await seedRecord({ sessionId: "sess_z", pid: HOST_PID, boundName: "m1", cwd: "D:\\elsewhere" });
    expect(adoptHookBoundIdentity(workspace, ENABLED)).toBeUndefined();
  });
});
