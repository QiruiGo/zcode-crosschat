/**
 * v0.5 M2 lead 面单测（DESIGN-V0.5.md §3.1/§3.2/§3.3；验收 A1e/A1f 的单测化子集）。
 *
 * 覆盖：xc_lead_transfer（happy/not_lead/unknown/removed/to===me F-2/history ≤32 截尾/
 * reason 清洗 P9）、xc_lead_release（happy/幂等 alreadyDefault/not_lead）、xc_team_init
 * （空位认领写 set 史 P9/lead_exists 载荷补 sessionId R-1/takeover F-4/幂等无新史）、
 * 纯函数 sanitizeLeadReason/pushLeadHistory。
 *
 * 直接驱动 createLeadToolCore（SDK 无关 core，对临时 stateRoot 走磁盘真源）；
 * XC_WAKE_ENABLED 不设 → attemptWake 判 delivered=mailbox（不 spawn）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf } from "./protocol.js";
import {
  createLeadToolCore,
  pushLeadHistory,
  sanitizeLeadReason,
  type LeadToolCore,
} from "./lead-tools.js";
import { identityStore } from "./identity.js";
import { readMailbox } from "../core/mailbox.js";
import { engineLogFile } from "../core/paths.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import { MAX_LEAD_HISTORY, memberState } from "../core/types.js";
import type { LeadHistoryEntry, TeamMember, TeamState } from "../core/types.js";

let workDir: string;
let stateRoot: string;
let core: LeadToolCore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-lead-v05-"));
  stateRoot = join(workDir, ".crosschat");
  core = createLeadToolCore({ stateRoot, workspace: workDir, env: {} }); // 无 XC_WAKE_ENABLED → mailbox
});

afterEach(async () => {
  identityStore.bind("__discard__", bindIdentity("ghost", "sess-ghost")); // 防 require 泄漏到断言外
  await rm(workDir, { recursive: true, force: true });
});

function bindIdentity(name: string, sessionId: string) {
  return {
    sessionKey: `${sessionId}:${name}`,
    teamId: "default",
    name,
    agentKey: name,
    sessionId,
    role: "peer" as const,
    boundAt: Date.now(),
  };
}

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key,
    sessionId: `sess-${key}`,
    role: "worker",
    joinedAt: 1,
    lastSeen: 1,
    state: "ready",
    identity: "engine",
    ...overrides,
  };
}

/** 落盘一版 team.json：founder=a；可指定 leadKey 与额外成员。 */
async function seedTeam(options: {
  leadKey?: string;
  members?: TeamMember[];
  leadHistory?: LeadHistoryEntry[];
} = {}): Promise<TeamState> {
  const team = newTeamState({
    teamId: "default",
    name: "default",
    founderKey: "a",
    founder: member("a"),
    now: 1,
  });
  for (const extra of options.members ?? [member("b"), member("c")]) {
    if (extra.key !== "a") team.members.push(extra);
  }
  if (options.leadKey !== undefined) team.leadKey = options.leadKey;
  if (options.leadHistory !== undefined) team.leadHistory = options.leadHistory;
  await writeTeam(stateRoot, team);
  return team;
}

/** engine.jsonl 全量事件（测试断言用）。 */
async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("sanitizeLeadReason（P9：控制符清洗 + 500 截断）", () => {
  it("control chars become spaces and the value is trimmed", () => {
    expect(sanitizeLeadReason("a\nb\tc")).toBe("a b c");
    // 控制符逐个替换为空格（不折叠）：\u0000→" ", \u007f→" "，与原有空格叠加。
    expect(sanitizeLeadReason("\u0000x\u007f y ")).toBe("x  y");
  });

  it("caps at 500 chars and drops empty results", () => {
    expect(sanitizeLeadReason("x".repeat(600))?.length).toBe(500);
    expect(sanitizeLeadReason("   \n\t ")).toBeUndefined();
    expect(sanitizeLeadReason(undefined)).toBeUndefined();
  });
});

describe("pushLeadHistory（R-6：≤32 条 FIFO）", () => {
  it("appends and caps at MAX_LEAD_HISTORY keeping the tail", () => {
    const team: { leadHistory?: LeadHistoryEntry[] } = {};
    for (let i = 0; i < MAX_LEAD_HISTORY + 5; i += 1) {
      pushLeadHistory(team, { event: "set", from: null, to: `m${i}`, ts: i });
    }
    expect(team.leadHistory).toHaveLength(MAX_LEAD_HISTORY);
    expect(team.leadHistory?.[0]?.to).toBe("m5"); // 最旧的 5 条被挤掉
    expect(team.leadHistory?.at(-1)?.to).toBe(`m${MAX_LEAD_HISTORY + 4}`);
  });
});

describe("xc_lead_transfer（v0.5 R-2）", () => {
  it("happy path: leadKey/leadSince/leadHistory 落盘、通知+回执帧、审计事件、即时失格", async () => {
    const now = Date.now();
    await seedTeam({ leadKey: "a" });
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));

    const res = await core.xc_lead_transfer({ to: "b", reason: "验收" }, "conn-a");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as { to: string; from: string; leadSince: number; messageId: string; delivered: string };
    expect(payload.to).toBe("b");
    expect(payload.from).toBe("a");
    expect(payload.leadSince).toBeGreaterThanOrEqual(now);
    expect(payload.delivered).toBe("mailbox"); // 无 XC_WAKE_ENABLED

    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadKey).toBe("b");
    expect(team.leadSince).toBe(payload.leadSince);
    expect(team.leadHistory).toEqual([
      { event: "transfer", from: "a", to: "b", ts: payload.leadSince, reason: "验收" },
    ]);

    // 新 lead 邮箱：lead-transfer 通知帧（固定模板字段）
    const bMail = await readMailbox(stateRoot, "default", "b");
    const notice = bMail.map((m) => JSON.parse(m.content) as Record<string, unknown>).find((c) => c["type"] === "lead-transfer");
    expect(notice).toMatchObject({ type: "lead-transfer", teamId: "default", from: "a", to: "b", reason: "验收" });

    // 旧 lead 自邮箱：completed 回执
    const aMail = await readMailbox(stateRoot, "default", "a");
    const receipt = aMail.map((m) => JSON.parse(m.content) as Record<string, unknown>).find((c) => c["type"] === "lead-transfer");
    expect(receipt).toMatchObject({ type: "lead-transfer", from: "a", to: "b", status: "completed" });

    // 审计
    const events = await engineEvents();
    expect(events.find((e) => e["event"] === "lead-transfer")).toMatchObject({ from: "a", to: "b", reason: "验收" });

    // 旧 lead 即时失格：a 再调 transfer → not_lead（新 lead 是 b）
    const again = await core.xc_lead_transfer({ to: "c" }, "conn-a");
    expect(again.isError).toBe(true);
    expect(payloadOf(again)).toMatchObject({ error: "not_lead", leadKey: "b" });
  });

  it("not_lead：非现任 lead 调用硬拒", async () => {
    await seedTeam({ leadKey: "a" });
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));
    const res = await core.xc_lead_transfer({ to: "c" }, "conn-b");
    expect(res.isError).toBe(true);
    expect(payloadOf(res)).toMatchObject({ error: "not_lead", agentKey: "b", leadKey: "a" });
  });

  it("unknown/removed 目标 → invalid_params；无队 → no_team", async () => {
    await seedTeam({ leadKey: "a", members: [member("b"), member("d", { state: "removed" })] });
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));

    const unknown = await core.xc_lead_transfer({ to: "nobody" }, "conn-a");
    expect(payloadOf(unknown)).toMatchObject({ error: "invalid_params" });
    const removed = await core.xc_lead_transfer({ to: "d" }, "conn-a");
    expect(payloadOf(removed)).toMatchObject({ error: "invalid_params" });
    expect(memberState((await readTeam(stateRoot, "default"))!.members.find((m) => m.key === "d")!)).toBe("removed");
  });

  it("to===me → invalid_params（F-2：无操作不造假审计）", async () => {
    await seedTeam({ leadKey: "a" });
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));
    const res = await core.xc_lead_transfer({ to: "a" }, "conn-a");
    expect(payloadOf(res)).toMatchObject({ error: "invalid_params" });
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadKey).toBe("a"); // 未变
    expect(team.leadHistory ?? []).toHaveLength(0); // 无假史
  });

  it("no_team：无 team.json", async () => {
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));
    const res = await core.xc_lead_transfer({ to: "b" }, "conn-a");
    expect(payloadOf(res)).toMatchObject({ error: "no_team" });
  });

  it("history 超 32 条截尾保留最新；reason 清洗进史", async () => {
    const pre: LeadHistoryEntry[] = [];
    for (let i = 0; i < MAX_LEAD_HISTORY + 3; i += 1) {
      pre.push({ event: "set", from: null, to: `m${i}`, ts: i });
    }
    await seedTeam({ leadKey: "a", leadHistory: pre });
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));

    const res = await core.xc_lead_transfer({ to: "b", reason: "r1\nr2" }, "conn-a");
    expect(res.isError).toBeUndefined();
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadHistory).toHaveLength(MAX_LEAD_HISTORY);
    const last = team.leadHistory?.at(-1)!;
    expect(last).toMatchObject({ event: "transfer", from: "a", to: "b", reason: "r1 r2" });
  });
});

describe("xc_lead_release（v0.5 R-3）", () => {
  it("happy path：删 leadKey/leadSince、history+release、审计；再释放幂等 alreadyDefault", async () => {
    await seedTeam({ leadKey: "a" });
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));

    const res = await core.xc_lead_release({}, "conn-a");
    expect(res.isError).toBeUndefined();
    expect(payloadOf(res)).toMatchObject({ teamId: "default", from: "a", released: true });
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadKey).toBeUndefined();
    expect(team.leadSince).toBeUndefined();
    expect(team.leadHistory?.at(-1)).toMatchObject({ event: "release", from: "a", to: null });

    const events = await engineEvents();
    expect(events.find((e) => e["event"] === "lead-release")).toMatchObject({ from: "a", released: true });

    // founder 兜底态下 founder 仍是 leadKeyOf → 幂等无操作
    const again = await core.xc_lead_release({}, "conn-a");
    expect(payloadOf(again)).toMatchObject({ released: false, alreadyDefault: true });
  });

  it("not_lead：非 lead 不可释放", async () => {
    await seedTeam({ leadKey: "a" });
    identityStore.bind("conn-b", bindIdentity("b", "sess-b"));
    const res = await core.xc_lead_release({}, "conn-b");
    expect(payloadOf(res)).toMatchObject({ error: "not_lead", leadKey: "a" });
  });
});

describe("xc_team_init（v0.5 R-1 经 F-4 + P9 set 史）", () => {
  it("空位认领：写 leadKey/leadSince + set 史（from:null）", async () => {
    await seedTeam({}); // 无 leadKey
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));

    const res = await core.xc_team_init({}, "conn-a");
    expect(res.isError).toBeUndefined();
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadKey).toBe("a");
    expect(team.leadSince).toBeGreaterThan(0);
    expect(team.leadHistory?.at(-1)).toMatchObject({ event: "set", from: null, to: "a" });
    expect(team.leadHistory).toHaveLength(1);
  });

  it("lead_exists：默认硬拒且错误载荷补现任 sessionId（R-1）", async () => {
    await seedTeam({ leadKey: "a" });
    identityStore.bind("conn-c", bindIdentity("c", "sess-c"));
    const res = await core.xc_team_init({}, "conn-c");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as { error: string; leadKey: string; sessionId: string | null };
    expect(payload.error).toBe("lead_exists");
    expect(payload.leadKey).toBe("a");
    expect(payload.sessionId).toBe("sess-a"); // members 行反查
  });

  it("takeover:true：接管现任 lead，写 reason=takeover 史、通知旧 lead、审计 takeover", async () => {
    await seedTeam({ leadKey: "a" });
    identityStore.bind("conn-c", bindIdentity("c", "sess-c"));

    const res = await core.xc_team_init({ takeover: true }, "conn-c");
    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res) as { leadKey: string; takeover?: boolean; from?: string };
    expect(payload).toMatchObject({ leadKey: "c", takeover: true, from: "a" });

    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadKey).toBe("c");
    expect(team.leadHistory?.at(-1)).toMatchObject({ event: "set", from: "a", to: "c", reason: "takeover" });

    // 旧 lead 邮箱：taken-over 通知帧
    const aMail = await readMailbox(stateRoot, "default", "a");
    const notice = aMail.map((m) => JSON.parse(m.content) as Record<string, unknown>).find((c) => c["type"] === "lead-transfer");
    expect(notice).toMatchObject({ type: "lead-transfer", from: "c", to: "c", status: "taken-over" });

    const events = await engineEvents();
    expect(events.find((e) => e["event"] === "lead-set")).toMatchObject({ by: "c", takeover: true, from: "a" });
  });

  it("幂等：已是 lead 重复 init 不写新史、不动 leadSince", async () => {
    await seedTeam({ leadKey: "a" });
    identityStore.bind("conn-a", bindIdentity("a", "sess-a"));
    const first = await core.xc_team_init({}, "conn-a");
    const firstPayload = payloadOf(first) as { alreadyLead: boolean };
    expect(firstPayload.alreadyLead).toBe(true);
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadSince).toBeUndefined(); // alreadyLead 分支不 touch
    expect(team.leadHistory ?? []).toHaveLength(0);
  });
});
