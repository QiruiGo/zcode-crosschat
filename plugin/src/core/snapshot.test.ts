/**
 * W3 snapshot 单测（DESIGN-V0.2.md §7.3.1 快照 v2；§11.2「snapshot 刷新」用例）：
 * - buildSnapshot：v2 全字段（leadKey/members[].state,identity,openTaskId/blockedBy/dag/
 *   engine/unread）、W2 可选字段缺省兼容（§6.5）、env 防御解析（V7/V18）；
 * - refreshSnapshot：落盘 snapshot.json（原子写）+ engine.jsonl 审计、团队缺失静默跳过、
 *   损坏 team.json 向上抛（调用方降级）。
 * 磁盘类用系统 TEMP 下的临时 stateRoot + M1 真实读写（end-to-end 到 M1 契约）。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMailbox, createMessage } from "./mailbox.js";
import { newTeamState, makeTask, beginTaskAttempt, writeTeam } from "./teamstate.js";
import { DEFAULT_MAX_MEMBERS, buildSnapshot, inboundModeFromEnv, maxMembersFromEnv, refreshSnapshot, wakeEnabledFromEnv } from "./snapshot.js";
import type { TeamState } from "./types.js";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-snapshot-"));
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

function member(key: string, sessionId: string, extra: Record<string, unknown> = {}): TeamState["members"][number] {
  return { key, sessionId, role: "worker", joinedAt: 1, lastSeen: 2, ...extra };
}

/** 建一个两成员 + 两任务（t1 完成给 m1，t2 依赖 t1 派给 m2）的团队。 */
async function seedTeam(options: { withV2Fields?: boolean } = {}): Promise<TeamState> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 100 });
  team.members.push(member("m1", "sess_m1"), member("m2", "sess_m2"));
  const t1 = makeTask(team, { title: "平方表", prompt: "P1", createdBy: "a" }, 100);
  t1.status = "completed";
  t1.assignee = "m1";
  t1.result = "1 4 9";
  const t2 = makeTask(team, { title: "用表求和", prompt: "P2", dependsOn: ["t1"], createdBy: "a" }, 100);
  beginTaskAttempt(t2, "m2", 100);
  if (options.withV2Fields === true) {
    // W2 落盘后的形态：leadKey + 成员 state/identity（写入前先宽展为可写记录）。
    (team as unknown as Record<string, unknown>)["leadKey"] = "a";
    const m1 = team.members.find((m) => m.key === "m1") as unknown as Record<string, unknown>;
    m1["state"] = "ready";
    m1["identity"] = "engine";
  }
  await mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  await writeTeam(root, team);
  return team;
}

describe("env 防御解析（V7 / V18 同口径）", () => {
  it("wakeEnabledFromEnv：非 \"true\" 一律按关", () => {
    expect(wakeEnabledFromEnv({ XC_WAKE_ENABLED: "true" })).toBe(true);
    expect(wakeEnabledFromEnv({ XC_WAKE_ENABLED: "TRUE" })).toBe(false);
    expect(wakeEnabledFromEnv({})).toBe(false);
  });

  it("maxMembersFromEnv：有限正整数生效；其余取默认 8（V18）", () => {
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: "3" })).toBe(3);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: "abc" })).toBe(DEFAULT_MAX_MEMBERS);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: "0" })).toBe(DEFAULT_MAX_MEMBERS);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: "-2" })).toBe(DEFAULT_MAX_MEMBERS);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: "2.5" })).toBe(DEFAULT_MAX_MEMBERS);
    expect(maxMembersFromEnv({})).toBe(8);
    expect(DEFAULT_MAX_MEMBERS).toBe(8);
  });

  it("inboundModeFromEnv：非枚举值取 accept", () => {
    expect(inboundModeFromEnv({ XC_INBOUND_MODE: "hold" })).toBe("hold");
    expect(inboundModeFromEnv({ XC_INBOUND_MODE: "refuse" })).toBe("refuse");
    expect(inboundModeFromEnv({ XC_INBOUND_MODE: "yolo" })).toBe("accept");
    expect(inboundModeFromEnv({})).toBe("accept");
  });
});

describe("buildSnapshot（§7.3.1 v2 形状）", () => {
  it("全字段：leadKey/members(state,identity,openTaskId)/tasks(blockedBy)/dag/unread/engine", async () => {
    const team = await seedTeam({ withV2Fields: true });
    // m2 邮箱 1 条未读
    await appendMailbox(root, "default", "m2", createMessage("a", "m2", "hello"));
    const snap = await buildSnapshot(root, team, {
      now: 500,
      env: { XC_WAKE_ENABLED: "true", XC_MAX_MEMBERS: "5", XC_INBOUND_MODE: "hold" },
    });
    expect(snap.teamId).toBe("default");
    expect(snap.generatedAt).toBe(500);
    expect(snap.leadKey).toBe("a");
    expect(snap.engine).toEqual({ wakeEnabled: true, maxMembers: 5, inboundMode: "hold" });

    const m1 = snap.members.find((m) => m.key === "m1")!;
    expect(m1).toMatchObject({ state: "ready", identity: "engine", openTaskId: null, sessionId: "sess_m1" });
    const m2 = snap.members.find((m) => m.key === "m2")!;
    expect(m2.openTaskId).toBe("t2"); // in_progress（claimed 也算开放）

    const t2 = snap.tasks.find((t) => t.id === "t2")!;
    expect(t2.blockedBy).toEqual([]); // t1 已 completed
    const t1 = snap.tasks.find((t) => t.id === "t1")!;
    expect(t1.evidenceCount).toBe(0);

    expect(snap.dag).toEqual({ t2: ["t1"] }); // 无依赖的 t1 不入图
    expect(snap.unread).toEqual({ m1: 0, m2: 1 });
  });

  it("blockedBy 派生视图：依赖未满足时列出未满足 id", async () => {
    const team = newTeamState({ teamId: "default", founderKey: "a", now: 100 });
    team.members.push(member("m1", "sess_m1"));
    const t1 = makeTask(team, { title: "A", prompt: "P", createdBy: "a" }, 100); // pending
    const t2 = makeTask(team, { title: "B", prompt: "P", dependsOn: ["t1"], createdBy: "a" }, 100);
    void t1;
    void t2;
    const snap = await buildSnapshot(root, team, { env: {} });
    expect(snap.tasks.find((t) => t.id === "t2")!.blockedBy).toEqual(["t1"]);
  });

  it("W2 字段缺省（v0.1.0 旧数据）→ state/identity 省略、leadKey 省略（§6.5 兼容）", async () => {
    const team = await seedTeam(); // 不带 v2 字段
    const snap = await buildSnapshot(root, team, { env: {} });
    expect(snap.leadKey).toBeUndefined();
    for (const m of snap.members) {
      expect(m.state).toBeUndefined();
      expect(m.identity).toBeUndefined();
    }
    // openTaskId 是 W3 自产字段，旧数据也有。
    expect(snap.members.find((m) => m.key === "m2")!.openTaskId).toBe("t2");
    // 交叉类型兼容：v0.1.0 形状快照（tools.ts xc_status 字面量）可赋值给本类型。
    const legacy: import("./snapshot.js").StatusSnapshot = {
      teamId: "default",
      generatedAt: 1,
      phase: "open",
      founderKey: "a",
      members: [{ key: "m1", sessionId: "s", role: "peer", lastSeen: 1 }],
      tasks: [
        {
          id: "t1", title: "T", status: "pending", assignee: null, attempt: 0, attemptId: null,
          dependsOn: [], createdBy: "a", result: null, error: null, evidenceCount: 0, updatedAt: 1,
        },
      ],
      unread: {},
    };
    expect(legacy.tasks).toHaveLength(1);
  });
});

describe("refreshSnapshot（build + 原子写 + 审计）", () => {
  it("团队在盘 → 写 snapshot.json（v2 内容）+ engine.jsonl snapshot-refresh 行", async () => {
    await seedTeam({ withV2Fields: true });
    await refreshSnapshot(root, "default");
    const file = join(root, "teams", "default", "snapshot.json");
    expect(existsSync(file)).toBe(true);
    const snap = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(snap["teamId"]).toBe("default");
    expect(snap["leadKey"]).toBe("a");
    expect(snap["engine"]).toBeDefined();
    const events = readFileSync(join(root, "logs", "engine.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const refresh = events.find((e) => e["event"] === "snapshot-refresh");
    expect(refresh).toBeDefined();
    expect(refresh!["teamId"]).toBe("default");
  });

  it("团队不存在 → 静默跳过（不写文件、不抛错）", async () => {
    await expect(refreshSnapshot(root)).resolves.toBeUndefined();
    expect(existsSync(join(root, "teams", "default", "snapshot.json"))).toBe(false);
  });

  it("team.json 损坏 → 向上抛（调用方各自降级：Stop 钩子 auditHookFailure / 边沿 try-catch）", async () => {
    mkdirSync(join(root, "teams", "default"), { recursive: true });
    writeFileSync(join(root, "teams", "default", "team.json"), "{ not json");
    await expect(refreshSnapshot(root)).rejects.toThrow();
  });
});
