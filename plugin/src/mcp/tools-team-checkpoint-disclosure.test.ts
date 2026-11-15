/**
 * v0.8.1（29 红队 C1-B01/C1-B02 修复）：checkpoint 工具层**披露审计**的接线单测。
 *
 * 与 tools-team-checkpoint.test.ts 的分工：那一份走真实落盘验行为（排他、清扫、
 * payload 冻结形状）；本文件 mock 掉 core/checkpoint.js 的 writeCheckpoint，确定性
 * 注入「撞名进位 / 残留清扫 / 清扫失败」三种结果，钉死工具层把结果转译成审计事件
 * 的接线（§14.1 审计事件表 v0.8.1 新增三项）：
 * - `checkpoint-stamp-collision`（同毫秒并发撞名进位——无静默覆写后的可见信号）；
 * - `checkpoint-tmp-swept`（被杀进程残留 .tmp 清掉的份数）；
 * - `checkpoint-tmp-sweep-failed`（清扫失败只审计、不阻断已成功的写入）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf } from "./protocol.js";
import { handleTeam } from "./tools-team.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { engineLogFile } from "../core/paths.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import type { TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";

/** writeCheckpoint 的结果探针（hoisted：vi.mock 工厂可引用）。 */
const ckptProbe = vi.hoisted(() => ({
  result: undefined as unknown,
  error: undefined as unknown,
}));

vi.mock("../core/checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/checkpoint.js")>();
  return {
    ...actual,
    writeCheckpoint: async (): Promise<unknown> => {
      if (ckptProbe.error !== undefined) throw ckptProbe.error;
      return ckptProbe.result;
    },
  };
});

const T0 = Date.now();
const MIN = 60_000;

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-team-checkpoint-disclosure-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: {} };
  ckptProbe.error = undefined;
  ckptProbe.result = {
    path: join(stateRoot, "checkpoints", "alice", "2026-11-15T18-00-00-000Z.md"),
    createdAt: T0,
    stamp: "2026-11-15T18-00-00-000Z",
    bytes: 1234,
    openTasks: 1,
    unread: 0,
    capacity: null,
    pruned: 0,
  };
});

afterEach(async () => {
  identityStore.bind("__discard__", {
    sessionKey: "sess-ghost:ghost",
    teamId: "default",
    name: "ghost",
    agentKey: "ghost",
    sessionId: "sess-ghost",
    role: "peer",
    boundAt: Date.now(),
  } satisfies BoundIdentity);
  await rm(workDir, { recursive: true, force: true });
});

function member(key: string): TeamMember {
  return {
    key,
    sessionId: `sess-${key}`,
    role: "worker",
    joinedAt: T0 - 120 * MIN,
    lastSeen: T0 - MIN,
    state: "ready",
    identity: "engine",
  };
}

async function seedTeam(): Promise<void> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: "lead", founder: member("lead"), now: T0 });
  team.leadKey = "lead";
  team.members.push(member("alice"));
  await writeTeam(stateRoot, team);
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(engineLogFile(stateRoot), "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("checkpoint 工具层：v0.8.1 披露审计接线", () => {
  it("stampCollisions>0 → checkpoint-stamp-collision 审计（含 path/stamp/bumped）", async () => {
    await seedTeam();
    identityStore.bind("conn-alice", {
      sessionKey: "sess-alice:alice",
      teamId: "default",
      name: "alice",
      agentKey: "alice",
      sessionId: "sess-alice",
      role: "peer",
      boundAt: T0,
    } satisfies BoundIdentity);
    ckptProbe.result = { ...(ckptProbe.result as Record<string, unknown>), stampCollisions: 3 };

    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    expect(res.isError).toBeUndefined();
    const rows = (await engineEvents()).filter((e) => e["event"] === "checkpoint-stamp-collision");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teamId: "default",
      agentKey: "alice",
      path: join(stateRoot, "checkpoints", "alice", "2026-11-15T18-00-00-000Z.md"),
      stamp: "2026-11-15T18-00-00-000Z",
      bumped: 3,
    });
    // payload 冻结形状不增不减（§14.1）：撞名披露只走审计，不进 payload
    expect(Object.keys(payloadOf(res) as Record<string, unknown>).sort()).toEqual(
      ["bytes", "capacity", "createdAt", "path", "pruned", "tasks", "unread"],
    );
  });

  it("tmpRemoved>0 → checkpoint-tmp-swept 审计；tmpSweepError → checkpoint-tmp-sweep-failed", async () => {
    await seedTeam();
    identityStore.bind("conn-alice", {
      sessionKey: "sess-alice:alice",
      teamId: "default",
      name: "alice",
      agentKey: "alice",
      sessionId: "sess-alice",
      role: "peer",
      boundAt: T0,
    } satisfies BoundIdentity);
    ckptProbe.result = {
      ...(ckptProbe.result as Record<string, unknown>),
      tmpRemoved: 2,
      tmpSweepError: "EACCES: permission denied",
    };

    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    expect(res.isError).toBeUndefined(); // 清扫失败不阻断已成功的写入
    const events = await engineEvents();
    expect(events.filter((e) => e["event"] === "checkpoint-tmp-swept")).toMatchObject([
      { teamId: "default", agentKey: "alice", removed: 2 },
    ]);
    expect(events.filter((e) => e["event"] === "checkpoint-tmp-sweep-failed")).toMatchObject([
      { teamId: "default", agentKey: "alice", error: "EACCES: permission denied" },
    ]);
  });

  it("无碰撞/无残留 → 三条披露审计都不出（只有既有的 checkpoint 事件）", async () => {
    await seedTeam();
    identityStore.bind("conn-alice", {
      sessionKey: "sess-alice:alice",
      teamId: "default",
      name: "alice",
      agentKey: "alice",
      sessionId: "sess-alice",
      role: "peer",
      boundAt: T0,
    } satisfies BoundIdentity);

    await handleTeam(deps, { action: "checkpoint" }, "conn-alice");
    const events = await engineEvents();
    expect(events.filter((e) => e["event"] === "checkpoint")).toHaveLength(1);
    expect(events.filter((e) => e["event"] === "checkpoint-stamp-collision")).toHaveLength(0);
    expect(events.filter((e) => e["event"] === "checkpoint-tmp-swept")).toHaveLength(0);
    expect(events.filter((e) => e["event"] === "checkpoint-tmp-sweep-failed")).toHaveLength(0);
  });
});
