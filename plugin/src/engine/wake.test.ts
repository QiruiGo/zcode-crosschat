/**
 * M2 单测：推送唤醒引擎（wake.ts）。
 * 判据 = DESIGN §7 M2 产出要求：prompt 截断 4000 / duplicate 去重 / 在途 nonce 去重 /
 * 失败降级 mailbox / 非 "true" 按关；另覆盖成功路径的落盘与审计。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot + M1 真实读写函数（end-to-end 到 M1 契约）。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox";
import { createWakeNonce } from "../core/registry";
import type { TeamMessage, TeamState } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import {
  attemptWake,
  buildWakePrompt,
  decideDelivery,
  findDuplicateMail,
  isWakeEnabled,
  WAKE_PROMPT_MAX_CHARS,
  WAKE_INFLIGHT_MS,
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

describe("attemptWake", () => {
  async function seedMailbox(): Promise<TeamMessage> {
    mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
    const message = createMessage("a", "b", "计算 17*23，把结果只写数字到 result-a2b.txt", {
      deliveryClaimedAt: Date.now(),
    });
    await appendMailbox(root, "default", "b", message);
    return message;
  }

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
