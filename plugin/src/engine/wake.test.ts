/**
 * M2 单测：推送唤醒引擎（wake.ts）。
 * 判据 = DESIGN §7 M2 产出要求：prompt 截断 4000 / duplicate 去重 / 在途 nonce 去重 /
 * 失败降级 mailbox / 非 "true" 按关；另覆盖成功路径的落盘与审计。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot + M1 真实读写函数（end-to-end 到 M1 契约）。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox";
import { createWakeNonce } from "../core/registry";
import { newTeamState, writeTeam } from "../core/teamstate";
import type { TeamMessage, TeamState } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import {
  attemptWake,
  buildWakePrompt,
  decideDelivery,
  findDuplicateMail,
  includeRulesForScene,
  isWakeEnabled,
  MEMBER_RULES_V2,
  WAKE_PROMPT_MAX_CHARS,
  WAKE_INFLIGHT_MS,
  WAKE_RULES_SCENES,
  WAKE_SCENES,
  type WakeRequest,
} from "./wake";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-"));
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

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** spawn 注入捕获的是 SpawnResumeOptions（resume-cli 封装层，见 WakeRequest.spawn 契约）。 */
type CapturedSpawn = SpawnResumeOptions;

function fakeSpawn(pid: number | undefined, captured: CapturedSpawn[]): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    captured.push(opts);
    return { pid, logFile: opts.logFile };
  };
}

function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "dispatch",
    receiptIds: ["m1"],
    ticket: "计算 17*23，把结果只写数字到 result-a2b.txt",
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    ...overrides,
  };
}

// ─────────────────────────── 开关判定（V7） ───────────────────────────

describe("isWakeEnabled（V7：非 \"true\" 一律按关）", () => {
  it("\"true\" 开；\"TRUE\"/\"1\"/空串/undefined/true对象串 全关", () => {
    expect(isWakeEnabled("true")).toBe(true);
    expect(isWakeEnabled("TRUE")).toBe(false);
    expect(isWakeEnabled("1")).toBe(false);
    expect(isWakeEnabled("")).toBe(false);
    expect(isWakeEnabled(undefined)).toBe(false);
    expect(isWakeEnabled("true ")).toBe(false); // 带空白也不算（严格等于）
  });
});

// ─────────────────────────── 三态决策（纯函数） ───────────────────────────

describe("decideDelivery", () => {
  it("duplicate 短路一切", () => {
    const d = decideDelivery({ duplicate: true, wakeEnabledRaw: "true", inflight: false });
    expect(d.mode).toBe("duplicate");
  });
  it("开关关 → mailbox", () => {
    expect(decideDelivery({ wakeEnabledRaw: undefined }).mode).toBe("mailbox");
    expect(decideDelivery({ wakeEnabledRaw: "false" }).mode).toBe("mailbox");
  });
  it("属主在场（ownerAbsent=false）→ mailbox（§2.5-2/V5）", () => {
    expect(decideDelivery({ wakeEnabledRaw: "true", ownerAbsent: false }).mode).toBe("mailbox");
  });
  it("ownerAbsent 缺省（v1 约束放行）+ 无在途 → wake", () => {
    expect(decideDelivery({ wakeEnabledRaw: "true" }).mode).toBe("wake");
  });
  it("在途 nonce → mailbox", () => {
    expect(decideDelivery({ wakeEnabledRaw: "true", inflight: true }).mode).toBe("mailbox");
  });
});

// ─────────────────────────── duplicate 去重 ───────────────────────────

function teamWithTask(attemptId: string | null, status: TeamState["tasks"][number]["status"] = "in_progress"): TeamState {
  return {
    teamId: "default",
    name: "default",
    founderKey: "a",
    phase: "open",
    members: [],
    tasks: [{
      id: "t1", title: "T", prompt: "P", dependsOn: [], status,
      assignee: "b", attempt: 1, attemptId,
      createdBy: "a", createdAt: 0, updatedAt: 0,
      result: null, error: null, evidence: [], history: [],
    }],
    seq: 1,
    createdAt: 0,
  };
}

describe("findDuplicateMail（移植 tools.js:2088-2093）", () => {
  const ticket = "计算 17*23";
  const team = teamWithTask("at1");

  function msg(overrides: Partial<TeamMessage>): TeamMessage {
    return {
      id: "x1", from: "a", to: "b", content: ticket, ts: 1,
      ...overrides,
    };
  }

  it("同文且在效期 → 判 duplicate", () => {
    const existing = [msg({ taskId: "t1", attemptId: "at1" })];
    expect(findDuplicateMail(existing, team, {
      from: "a", content: ticket, taskId: "t1", attemptId: "at1",
    })?.id).toBe("x1");
  });

  it("同文但 attempt 已换代（isCurrentMail=false）→ 不判 duplicate", () => {
    const existing = [msg({ taskId: "t1", attemptId: "at1" })];
    const oldTeam = teamWithTask("at2"); // 任务 attempt 已换代
    expect(findDuplicateMail(existing, oldTeam, {
      from: "a", content: ticket, taskId: "t1", attemptId: "at1",
    })).toBeUndefined();
  });

  it("内容不同 → 不判 duplicate", () => {
    const existing = [msg({ taskId: "t1", attemptId: "at1" })];
    expect(findDuplicateMail(existing, team, {
      from: "a", content: "另一条消息", taskId: "t1", attemptId: "at1",
    })).toBeUndefined();
  });

  it("source 字段不同 → 不判 duplicate", () => {
    const existing = [msg({ taskId: "t1", attemptId: "at1", sourceTaskId: "t9", sourceAttemptId: "at9" })];
    expect(findDuplicateMail(existing, team, {
      from: "a", content: ticket, taskId: "t1", attemptId: "at1",
    })).toBeUndefined();
  });

  it("已读且无任务绑定的同文 → 不判 duplicate（dsh 尾条件）", () => {
    const existing = [msg({ readAt: 5 })];
    expect(findDuplicateMail(existing, team, { from: "a", content: ticket })).toBeUndefined();
    // 未读且无绑定 → 判 duplicate
    expect(findDuplicateMail([msg({})], team, { from: "a", content: ticket })?.id).toBe("x1");
  });
});

// ─────────────────────────── prompt 组装（≤4000） ───────────────────────────

describe("buildWakePrompt", () => {
  const base = {
    teamId: "default",
    recipientKey: "b",
    recipientSessionId: "sess_b",
    wakeToken: "tok-123",
    receiptIds: ["m1"],
  };

  it("回执 + 身份行(含 sid) + wakeToken + 正文 + 守则，均在 prompt 内", () => {
    const p = buildWakePrompt({
      ...base,
      bodyText: "计算 17*23",
      includeMemberRules: true,
    });
    expect(p).toContain('[CrossChat inbox receipt: {"teamId":"default","recipient":"b","ids":["m1"]}]');
    expect(p).toContain("sessionId=sess_b");
    expect(p).toContain('wakeToken 填 "tok-123"');
    expect(p).toContain("计算 17*23");
    expect(p).toContain("成员守则");
    expect(p).toContain("xc_register");
    expect(p).toContain("xc_check_inbox");
    expect(p.length).toBeLessThanOrEqual(WAKE_PROMPT_MAX_CHARS);
  });

  it("includeMemberRules=false（report/message 唤醒）不含守则", () => {
    const p = buildWakePrompt({ ...base, bodyText: "收到回执", includeMemberRules: false });
    expect(p).not.toContain("成员守则");
    expect(p).toContain("收到回执");
  });

  it("【判据 1】正文超长 → 总长截到 ≤4000，结构部分（回执/身份/wakeToken）完整保留", () => {
    const p = buildWakePrompt({ ...base, bodyText: "很长的任务票".repeat(2000), includeMemberRules: true });
    expect(p.length).toBeLessThanOrEqual(4000);
    expect(p).toContain("…[truncated]");
    expect(p).toContain('wakeToken 填 "tok-123"');
    expect(p).toContain('sessionId=sess_b');
    expect(p).toContain('[CrossChat inbox receipt:');
    // 成员守则不可被挤掉
    expect(p).toContain("成员守则");
  });

  it("maxChars 显式传小值 → 仍不超过", () => {
    const p = buildWakePrompt({ ...base, bodyText: "x".repeat(500) }, 200);
    expect(p.length).toBeLessThanOrEqual(200);
  });

  it("WAKE_PROMPT_MAX_CHARS=4000 / WAKE_INFLIGHT_MS=15min 转出口", () => {
    expect(WAKE_PROMPT_MAX_CHARS).toBe(4000);
    expect(WAKE_INFLIGHT_MS).toBe(15 * 60 * 1000);
  });
});

// ─────────────────────────── attemptWake（磁盘端到端） ───────────────────────────

/** 在当前临时 root 的 b 邮箱落一条派单消息（describe 共用）。 */
async function seedMailbox(): Promise<TeamMessage> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "计算 17*23，把结果只写数字到 result-a2b.txt", {
    deliveryClaimedAt: Date.now(),
  });
  await appendMailbox(root, "default", "b", message);
  return message;
}

describe("attemptWake", () => {

  it("【成功路径】delivered=wake：spawn 参数正确、nonce 落盘、markDelivered、engine.jsonl 记 {event: wake, pid}", async () => {
    const message = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      receiptIds: [message.id],
      now: 1_000_000,
      spawn: fakeSpawn(4242, captured),
    }));

    expect(res.delivered).toBe("wake");
    expect(res.pid).toBe(4242);
    expect(res.nonce).toBeDefined();
    expect(res.wakeLog).toBe(join(root, "logs", `wake-b-1000000.json`));

    // spawn 参数形态（§2.5：--resume <sid> --prompt … --cwd <ws> --output-format json 由 M2 组装；
    // ELECTRON_RUN_AS_NODE/detached/stdio 的注入与落盘行为由 resume-cli.test.ts 在 spawn 层覆盖）
    expect(captured).toHaveLength(1);
    expect(captured[0]!.cfg).toEqual({ zcodeExe: "Z.exe", zcodeCjs: "z.cjs" });
    expect(captured[0]!.sessionId).toBe("sess_b");
    expect(captured[0]!.cwd).toBe("D:\\ws");
    expect(captured[0]!.logFile).toBe(join(root, "logs", "wake-b-1000000.json"));
    const prompt = captured[0]!.prompt;
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt).toContain(res.nonce!);
    expect(prompt).toContain("成员守则");
    expect(prompt).toContain("sessionId=sess_b");

    // nonce 落盘（registry/wake/<token>.json，未使用）
    const nonceFile = join(root, "registry", "wake", `${res.nonce}.json`);
    expect(existsSync(nonceFile)).toBe(true);
    const nonceBody = JSON.parse(readFileSync(nonceFile, "utf8")) as Record<string, unknown>;
    expect(nonceBody["teamId"]).toBe("default");
    expect(nonceBody["agentKey"]).toBe("b");
    expect(nonceBody["sid"]).toBe("sess_b");

    // 消息已 markDelivered（deliveredAt 落盘、claim 清除；readAt 仍空——消费由 check_inbox 决定）
    const after = (await readMailbox(root, "default", "b")).find((m) => m.id === message.id);
    expect(after?.deliveredAt).toBeDefined();
    expect(after?.deliveryClaimedAt).toBeUndefined();
    expect(after?.readAt).toBeUndefined();

    // engine.jsonl 审计
    const events = readEngineEvents();
    const wake = events.find((e) => e["event"] === "wake");
    expect(wake).toBeDefined();
    expect(wake!["pid"]).toBe(4242);
    expect(wake!["to"]).toBe("b");
  });

  it("【判据 5】非 \"true\" 按关：mailbox + 原始值记入 engine.jsonl + 不写 nonce、不 spawn", async () => {
    await seedMailbox();
    for (const raw of ["TRUE", "1", "", undefined]) {
      const captured: CapturedSpawn[] = [];
      const res = await attemptWake(baseReq({
        env: raw === undefined ? {} : { XC_WAKE_ENABLED: raw },
        spawn: fakeSpawn(1, captured),
      }));
      expect(res.delivered).toBe("mailbox");
      expect(captured).toHaveLength(0);
      const skips = readEngineEvents().filter((e) => e["event"] === "wake-skipped");
      const skip = skips[skips.length - 1]; // 每轮迭代各落一行，取最新
      expect(skip).toBeDefined();
      expect(skip!["rawWakeEnabled"]).toBe(raw ?? null);
      expect(String(skip!["reason"])).toContain("wake-disabled");
    }
    // 未写任何 nonce
    const wakeDir = join(root, "registry", "wake");
    expect(existsSync(wakeDir) ? readdirSync(wakeDir) : []).toEqual([]);
  });

  it("【判据 3】在途 nonce 去重：registry/wake/ 存在该目标未使用未过期 nonce → mailbox，不 spawn", async () => {
    await seedMailbox();
    const { token } = await createWakeNonce(root, {
      teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now(),
    });
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ spawn: fakeSpawn(1, captured) }));
    expect(res.delivered).toBe("mailbox");
    expect(captured).toHaveLength(0);
    const skip = readEngineEvents().find((e) => e["event"] === "wake-skipped");
    expect(skip).toBeDefined();
    expect(skip!["inflightNonce"]).toBe(token);
    expect(String(skip!["reason"])).toContain("inflight-nonce");
  });

  it("在途 nonce 已过期（>15min）→ 不再拦截", async () => {
    await seedMailbox();
    await createWakeNonce(root, {
      teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now() - WAKE_INFLIGHT_MS - 1,
    });
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ spawn: fakeSpawn(2, captured) }));
    expect(res.delivered).toBe("wake");
    expect(captured).toHaveLength(1);
  });

  it("【判据 4】失败降级 mailbox：spawn 同步失败 → mailbox + 释放租约 + 消费 nonce + engine.jsonl wake-failed；且立即可重试", async () => {
    const message = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const failing = (): SpawnResumeResult => {
      throw new Error("ENOENT: no such ZCode.exe");
    };
    const res = await attemptWake(baseReq({ receiptIds: [message.id], spawn: failing }));
    expect(res.delivered).toBe("mailbox");
    expect(String(res.note)).toContain("spawn-failed");
    expect(captured).toHaveLength(0);

    // 租约已释放（deliveryClaimedAt 移除），消息仍留在邮箱
    const after = (await readMailbox(root, "default", "b")).find((m) => m.id === message.id);
    expect(after).toBeDefined(); // 消息未丢
    expect(after?.deliveryClaimedAt).toBeUndefined();
    expect(after?.deliveredAt).toBeUndefined();

    // nonce 已消费（used=true），15min 在途标记不再挡重试
    const events = readEngineEvents();
    const failed = events.find((e) => e["event"] === "wake-failed");
    expect(failed).toBeDefined();
    expect(String(failed!["error"])).toContain("ENOENT");

    // 立即重试 → 成功 wake（判据 4 的"租约到期后可重试"在 v1 即刻成立，因为失败路径清了 nonce）
    const retry: CapturedSpawn[] = [];
    const res2 = await attemptWake(baseReq({ receiptIds: [message.id], spawn: fakeSpawn(9, retry) }));
    expect(res2.delivered).toBe("wake");
    expect(retry).toHaveLength(1);
  });

  it("在途判定只对同目标生效：不同 agentKey 的 nonce 不拦截", async () => {
    await seedMailbox();
    await createWakeNonce(root, { teamId: "default", agentKey: "c", sid: "sess_c", now: Date.now() });
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ spawn: fakeSpawn(3, captured) }));
    expect(res.delivered).toBe("wake");
  });

  it("toAgentKey 防御性 sanitize（未归一输入也落到同一邮箱）", async () => {
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ toAgentKey: "B", spawn: fakeSpawn(5, captured) }));
    expect(res.delivered).toBe("wake");
    expect(res.wakeLog).toContain("wake-b-");
  });

  it("空 receiptIds 也能走 wake（回执 ids 为空数组）", async () => {
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ receiptIds: [], spawn: fakeSpawn(6, captured) }));
    expect(res.delivered).toBe("wake");
    const prompt = captured[0]!.prompt;
    expect(prompt).toContain('"ids":[]');
  });

  it("磁盘一致性抽查：mailbox 落盘行可读回（M1 契约连通性）", async () => {
    const message = await seedMailbox();
    const box = await readMailbox(root, "default", "b");
    expect(box).toHaveLength(1);
    expect(box[0]!.id).toBe(message.id);
    expect(box[0]!.content).toContain("17*23");
  });
});

// ─────────────────────────── v0.2：守则 v2 与场景白名单（§3.4/§9.1） ───────────────────────────

describe("MEMBER_RULES_V2（守则 v2 全文，§3.4）", () => {
  it("含多任务自驱循环的关键协议元素", () => {
    expect(MEMBER_RULES_V2).toContain("成员守则 v2");
    expect(MEMBER_RULES_V2).toContain("一个回合可以做多单");
    expect(MEMBER_RULES_V2).toContain("xc_report(in_progress)"); // 心跳
    expect(MEMBER_RULES_V2).toContain("xc_idle"); // 空闲通知
    expect(MEMBER_RULES_V2).toContain("unblock-notice"); // 依赖解除通知处理
    expect(MEMBER_RULES_V2).toContain("shutdown-request"); // 停止帧收尾
    expect(MEMBER_RULES_V2).toContain("task_not_pending");
    expect(MEMBER_RULES_V2).toContain("dependencies_unmet");
    expect(MEMBER_RULES_V2).toContain("already_has_open_task");
    expect(MEMBER_RULES_V2).toContain(".crosschat/"); // 状态目录只读
  });

  it("在 ≤4000 预算内与任务票共存（buildWakePrompt 不挤掉守则）", () => {
    const p = buildWakePrompt({
      teamId: "default",
      recipientKey: "b",
      recipientSessionId: "sess_b",
      wakeToken: "tok",
      receiptIds: ["m1"],
      bodyText: "x".repeat(3000), // 超出正文预算 → 截正文保守则
      includeMemberRules: true,
    });
    expect(p).toContain("成员守则 v2");
    expect(p.length).toBeLessThanOrEqual(WAKE_PROMPT_MAX_CHARS);
    expect(p).toContain("…[truncated]"); // 挤掉的是正文，不是守则
  });
});

describe("场景白名单（§9.1 新增场景 prompt 组装）", () => {
  it("WAKE_SCENES 覆盖 v0.1.0 三场景 + v0.2 六场景", () => {
    expect(WAKE_SCENES).toEqual([
      "dispatch", "report", "message", "unblock", "idle", "cancel",
      "post-provision", "shutdown", "stale-sweep",
    ]);
  });

  it("守则白名单 = dispatch + post-provision；其余场景一律不附加", () => {
    expect(WAKE_RULES_SCENES).toEqual(["dispatch", "post-provision"]);
    expect(includeRulesForScene("dispatch")).toBe(true);
    expect(includeRulesForScene("post-provision")).toBe(true);
    for (const scene of ["report", "message", "unblock", "idle", "cancel", "shutdown", "stale-sweep"]) {
      expect(includeRulesForScene(scene)).toBe(false);
    }
    expect(includeRulesForScene("unknown-future-scene")).toBe(false); // 未知场景向前兼容
  });

  it("attemptWake：unblock 场景不带守则", async () => {
    await seedMailbox();
    const capturedUnblock: CapturedSpawn[] = [];
    await attemptWake(baseReq({ reason: "unblock", spawn: fakeSpawn(11, capturedUnblock) }));
    expect(capturedUnblock).toHaveLength(1);
    expect(capturedUnblock[0]!.prompt).not.toContain("成员守则");
  });

  it("attemptWake：post-provision 场景带守则 v2（E-e 投产唤醒）", async () => {
    await seedMailbox();
    const capturedPost: CapturedSpawn[] = [];
    await attemptWake(baseReq({ reason: "post-provision", spawn: fakeSpawn(12, capturedPost) }));
    expect(capturedPost).toHaveLength(1);
    expect(capturedPost[0]!.prompt).toContain("成员守则 v2");
  });
});

// ─────────────────────────── v0.2：wake-child 审计接线（§4.2） ───────────────────────────

describe("attemptWake: onHelperSpawned → engine.jsonl wake-child（W1 接线）", () => {
  it("helper 汇报的唤醒子 pid 追记 {event:\"wake-child\", pid}，与 wake 行并排", async () => {
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      now: 2_000_000,
      spawn: (opts) => {
        captured.push(opts);
        opts.onHelperSpawned?.(7777); // helper stdout {ok:true,pid:7777} 的模拟
        return { pid: 111, logFile: opts.logFile }; // 111 = helper 自身 pid
      },
    }));
    expect(res.delivered).toBe("wake");
    const events = readEngineEvents();
    const wakeRow = events.find((e) => e["event"] === "wake");
    const childRow = events.find((e) => e["event"] === "wake-child");
    expect(wakeRow!["pid"]).toBe(111); // wake 行 = helper pid
    expect(childRow).toBeDefined();
    expect(childRow!["pid"]).toBe(7777); // wake-child 行 = 唤醒子 pid
    expect(childRow!["scene"]).toBe("dispatch");
    expect(childRow!["to"]).toBe("b");
  });
});

// ─────────────────────────── v0.2：成员状态门控（§6.3/§7.3.3） ───────────────────────────

describe("attemptWake: 成员状态门控（provisioning/failed/removed 只入箱）", () => {
  /** 落一个含单成员 b 的 team.json；state 可选。 */
  async function seedTeamWithMember(state?: string): Promise<void> {
    const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
    const member = {
      key: "b", sessionId: "sess_b", role: "worker" as const, joinedAt: 1, lastSeen: 1,
      ...(state === undefined ? {} : { state }),
    };
    team.members.push(member as TeamState["members"][number]);
    mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
    await writeTeam(root, team);
  }

  it("provisioning → mailbox + wake-skipped(memberState) + 不写 nonce", async () => {
    await seedTeamWithMember("provisioning");
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ spawn: fakeSpawn(1, captured) }));
    expect(res.delivered).toBe("mailbox");
    expect(captured).toHaveLength(0);
    const skip = readEngineEvents().filter((e) => e["event"] === "wake-skipped").at(-1);
    expect(String(skip!["reason"])).toContain("member-state:provisioning");
    expect(existsSync(join(root, "registry", "wake")) ? readdirSync(join(root, "registry", "wake")) : []).toEqual([]);
  });

  it("removed → 同样只入箱不唤醒（§7.3.3「不再被唤醒」）", async () => {
    await seedTeamWithMember("removed");
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ spawn: fakeSpawn(1, captured) }));
    expect(res.delivered).toBe("mailbox");
    expect(captured).toHaveLength(0);
    const skip = readEngineEvents().filter((e) => e["event"] === "wake-skipped").at(-1);
    expect(String(skip!["reason"])).toContain("member-state:removed");
  });

  it("state=ready / 旧数据无 state（§6.5 缺省 ready）→ 照常 wake", async () => {
    for (const state of ["ready", undefined]) {
      const freshRoot = mkdtempSync(join(tmpdir(), "xc-wake-gate-"));
      dirs.push(freshRoot);
      const prevRoot = root;
      root = freshRoot;
      try {
        await seedTeamWithMember(state);
        await seedMailbox();
        const captured: CapturedSpawn[] = [];
        const res = await attemptWake(baseReq({ spawn: fakeSpawn(3, captured) }));
        expect(res.delivered).toBe("wake");
        expect(captured).toHaveLength(1);
      } finally {
        root = prevRoot;
      }
    }
  });

  it("团队不存在 → 放行（v0.1.0 行为不变；现有用例同证）", async () => {
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ spawn: fakeSpawn(4, captured) }));
    expect(res.delivered).toBe("wake");
    expect(captured).toHaveLength(1);
  });
});

// ─────────────────────────── v0.5.1 FI-7：唤醒失败侦听与回执语义真实化 ───────────────────────────

import {
  findWakeFailureEvidence,
  wakeFallbackNote,
  WAKE_WATCH_POLL_MS,
  WAKE_WATCH_WINDOW_MS,
} from "./wake";

function waitUntil(check: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (check()) resolve(true);
      else if (Date.now() > deadline) resolve(false);
      else setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe("findWakeFailureEvidence（FI-7：只认正向失败证据，绝不虚报）", () => {
  it("命中：行首 Error（红队实测形态 Session not found）", () => {
    expect(findWakeFailureEvidence("Error: Session not found: sess_x\n")).toBe(
      "Error: Session not found: sess_x",
    );
  });
  it("命中：JSON 错误形状 isError:true / success:false / 顶层 error 字符串", () => {
    expect(findWakeFailureEvidence('{"isError":true,"message":"boom"}')).toContain("boom");
    expect(findWakeFailureEvidence('{"success":false}')).toBe('{"success":false}');
    expect(findWakeFailureEvidence('{"error":"resume rejected"}')).toContain("resume rejected");
  });
  it("不虚报：成功 JSON（单行对象）、内部含 Error 字样的响应文本、普通告警、空文本", () => {
    expect(findWakeFailureEvidence('{"sessionId":"s","response":"... Error: not at line start"}')).toBeUndefined();
    expect(findWakeFailureEvidence('{"sessionId":"s","response":"hi"}')).toBeUndefined();
    expect(findWakeFailureEvidence("[WARN] slow startup\n")).toBeUndefined();
    expect(findWakeFailureEvidence("")).toBeUndefined();
  });
});

describe("wakeFallbackNote（FI-7：env 配置失效回落自动探测的回执标注）", () => {
  const resolvedFallback = {
    zcodeExe: "E:\ZCode\ZCode.exe",
    zcodeCjs: "E:\ZCode\resources\glm\zcode.cjs",
    outcome: { found: true, source: "process_table" as const, pair: null, attempts: [], guidance: "" },
  } satisfies import("./zcode-locate").ResolvedSpawnConfig;
  it("env 已配置但文件不存在 + 探测命中 → 标注回落目标", () => {
    const note = wakeFallbackNote({ XC_ZCODE_EXE: "D:\nope\ZCode.exe", XC_ZCODE_CJS: "D:\nope\z.cjs" }, resolvedFallback);
    expect(note).toContain("自动探测回落");
    expect(note).toContain("E:\ZCode\ZCode.exe");
  });
  it("env 未配置（零必填常规路径）/ env 命中（无回落）/ 探测未命中 → 不标注", () => {
    expect(wakeFallbackNote({}, resolvedFallback)).toBe("");
    expect(
      wakeFallbackNote(
        { XC_ZCODE_EXE: "D:\ok\ZCode.exe", XC_ZCODE_CJS: "D:\ok\z.cjs" },
        { ...resolvedFallback, outcome: { ...resolvedFallback.outcome, source: "user_config" } },
      ),
    ).toBe("");
    expect(
      wakeFallbackNote(
        { XC_ZCODE_EXE: "D:\nope\ZCode.exe", XC_ZCODE_CJS: "D:\nope\z.cjs" },
        { ...resolvedFallback, outcome: { ...resolvedFallback.outcome, found: false } },
      ),
    ).toBe("");
    // 测试注入 cfg（非 ResolvedSpawnConfig）→ 不标注
    expect(wakeFallbackNote({ XC_ZCODE_EXE: "D:\nope\ZCode.exe", XC_ZCODE_CJS: "D:\nope\z.cjs" }, { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" })).toBe("");
  });
});

describe("attemptWake 失败侦听（FI-7：spawn 成功 ≠ 送达；回执须反映真实结果）", () => {
  it("【回执语义】wake 态 note 明示「非送达确认」+ 失败自动检测去向；不再只说「已发起」", async () => {
    await seedMailbox();
    const res = await attemptWake(baseReq({ spawn: fakeSpawn(11, []) }));
    expect(res.delivered).toBe("wake");
    expect(res.note).toContain("非送达确认");
    expect(res.note).toContain("wake-failed");
    expect(WAKE_WATCH_WINDOW_MS).toBeGreaterThan(0);
    expect(WAKE_WATCH_POLL_MS).toBeGreaterThan(0);
  });

  it("【失败检测】唤醒子进程异步失败（wake 日志出现 Error:）→ engine.jsonl wake-failed{where:wake-child} + 释放租约 + 消费 nonce + 可重试", async () => {
    const message = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [message.id],
      now: 1_000_000,
      watchWindowMs: 1500,
      watchPollMs: 20,
      spawn: (opts) => {
        // 模拟孤儿唤醒子进程：spawn 返回后才把失败写进 wake 日志（父进程无退出码可观察）
        setTimeout(() => {
          mkdirSync(dirname(opts.logFile), { recursive: true });
          appendFileSync(opts.logFile, "Error: Session not found: sess_b\n");
        }, 40);
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    expect(res.wakeLog).toContain("wake-b-1000000.json");

    // 等待失败侦听结算（轮询到 wake-failed 出现，上限 3s）
    const sawFailure = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-failed"));
    expect(sawFailure).toBe(true);
    const failed = readEngineEvents().find((e) => e["event"] === "wake-failed");
    expect(failed!["where"]).toBe("wake-child");
    expect(String(failed!["error"])).toContain("Session not found");

    // 投递租约已释放：pull 立即可见（deliveryClaimedAt 移除，消息未丢）
    const after = (await readMailbox(root, "default", "b")).find((m) => m.id === message.id);
    expect(after).toBeDefined();
    expect(after?.deliveryClaimedAt).toBeUndefined();

    // nonce 已消费：15min 在途标记不再挡重试 → 立即重试成功
    const retry: CapturedSpawn[] = [];
    const res2 = await attemptWake(baseReq({ receiptIds: [message.id], spawn: fakeSpawn(9, retry) }));
    expect(res2.delivered).toBe("wake");
    expect(retry).toHaveLength(1);
  });

  it("【不虚报】窗口内日志静默/无失败证据 → 不记 wake-failed，wake 态不回滚", async () => {
    await seedMailbox();
    const res = await attemptWake(baseReq({
      watchWindowMs: 120,
      watchPollMs: 20,
      spawn: (opts) => {
        // 子进程只写普通输出（无失败证据形态）
        setTimeout(() => {
          mkdirSync(dirname(opts.logFile), { recursive: true });
          appendFileSync(opts.logFile, '{"sessionId":"sess_b","response":"ok"}\n');
        }, 30);
        return { pid: 77, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    await new Promise((r) => setTimeout(r, 220)); // 越过侦听窗口
    expect(readEngineEvents().some((e) => e["event"] === "wake-failed")).toBe(false);
  });
});

// ─────────────────────────── v0.5.3（A5 修复）：显式 spawn 配置无效 → 唤醒前闸 mailbox 降级 ───────────────────────────

describe("attemptWake: 显式 spawn 配置无效（A5 修复——不回落探测、不写 nonce、回执带根因）", () => {
  it("XC_ZCODE_EXE 配置不存在路径（cfg 未注入）→ mailbox 降级 + note 携带配置根因，零 spawn 零 nonce", async () => {
    const message = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      receiptIds: [message.id],
      now: 2_000_000,
      cfg: undefined, // 未注入配置 → 走 env 校验（红队 a5 形态：显式配置了坏路径）
      env: { XC_WAKE_ENABLED: "true", XC_ZCODE_EXE: "E:/nonexistent-dir-9999/ZCode.exe" },
      spawn: fakeSpawn(9999, captured),
    }));

    expect(res.delivered).toBe("mailbox");
    expect(res.note).toContain("spawn-config-invalid");
    expect(res.note).toContain("nonexistent-dir-9999");
    expect(res.note).toContain("不会回落自动探测");
    expect(res.nonce).toBeUndefined(); // 前置闸在 nonce 写入之前：无 15min 在途标记
    expect(captured).toHaveLength(0); // 绝不经探测路径发出唤醒

    // 磁盘：无 nonce 落盘；无 wake/zcode-locate/spawn-failed 事件，只有 wake-skipped 根因行
    const wakeDir = join(root, "registry", "wake");
    expect(existsSync(wakeDir) ? readdirSync(wakeDir).filter((f) => f.endsWith(".json")) : []).toEqual([]);
    const skipped = readEngineEvents().filter((e) => e["event"] === "wake-skipped");
    expect(skipped.some((e) => String(e["reason"]).includes("spawn-config-invalid"))).toBe(true);
    expect(readEngineEvents().some((e) => e["event"] === "wake")).toBe(false);
    expect(readEngineEvents().some((e) => e["event"] === "zcode-locate")).toBe(false);

    // 消息留邮箱可 pull（投递租约未被 markDelivered 盖章）
    const after = (await readMailbox(root, "default", "b")).find((m) => m.id === message.id);
    expect(after?.readAt ?? null).toBeNull();
  });

  it("cfg 测试注入时跳过配置闸（注入即信任，既有 wake 测试路径不变）", async () => {
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      receiptIds: [message0Id()],
      now: 2_100_000,
      env: { XC_WAKE_ENABLED: "true", XC_ZCODE_EXE: "E:/nonexistent-dir-9999/ZCode.exe" },
      spawn: fakeSpawn(8888, captured),
    }));
    expect(res.delivered).toBe("wake");
    expect(captured).toHaveLength(1); // 注入 cfg 直接使用，env 坏配置不参与判定
  });
});

function message0Id(): string {
  // 本 describe 内的 seedMailbox 每次落一条新消息；此处读取最新一条的 id（时序上一一对应）。
  const file = join(root, "teams", "default", "inbox", "b.jsonl");
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  return (JSON.parse(lines[lines.length - 1]!) as { id: string }).id;
}
