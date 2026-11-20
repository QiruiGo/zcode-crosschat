/**
 * v0.9.3 组 C 定向测试（方案 §一 C3）：`xc_team({action:"checkpoint"})` 工具层的
 * **journal 体积闸**端到端——core 判据在 core/checkpoint.test.ts，本文件钉工具面：
 *
 * - 34 MiB journal → 检查点照常写成功（写盘事实不被观测故障毁掉），第 4 章只留占位，
 *   payload `warnings[]` 透出同一条 warning（与 unread 读取失败同渠道，不增新键）；
 * - 正常 journal → 无 warning、末行照常进第 4 章（闸不过度遏制）；
 * - 引擎审计 `checkpoint` 事件不受影响（缺节不静默也不谎报）。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf } from "./protocol.js";
import { handleTeam } from "./tools-team.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { engineLogFile } from "../core/paths.js";
import type { Task, TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

/** 容量颜色钉成 GREEN（env 注入），让断言确定。 */
const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

const MIN = 60_000;
const T0 = Date.now();

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-v093c-ckpt-gate-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV } };
});

afterEach(() => {
  identityStore.bind("__discard__", bindIdentity("ghost", "sess-ghost")); // 防 require 泄漏到断言外
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* 清理尽力而为 */
  }
});

function bindIdentity(name: string, sessionId: string): BoundIdentity {
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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "86e8b61a-t1",
    title: "落盘脚本改造",
    prompt: "p",
    dependsOn: [],
    status: "in_progress",
    assignee: "alice",
    attempt: 2,
    attemptId: "att-2",
    createdBy: "lead",
    createdAt: T0 - 60 * MIN,
    updatedAt: T0 - 20 * MIN,
    lastProgressTs: T0 - 20 * MIN,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: T0 - 20 * MIN, event: "report", by: "alice" }],
    ...overrides,
  };
}

async function seedTeam(): Promise<void> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: "lead", founder: member("lead"), now: T0 });
  team.leadKey = "lead";
  team.members.push(member("alice"));
  team.tasks = [task()];
  await writeTeam(stateRoot, team);
}

/** 给任务的 journal 灌入 sizeBytes 字节（分块写，避免一次大字符串拼接）。 */
function writeHugeJournal(taskId: string, sizeBytes: number): void {
  const dir = join(stateRoot, "tasks", taskId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "journal.md");
  const chunk = Buffer.alloc(1024 * 1024, 0x61); // 'a'
  let written = 0;
  while (written < sizeBytes) {
    const n = Math.min(chunk.length, sizeBytes - written);
    appendFileSync(file, n === chunk.length ? chunk : chunk.subarray(0, n));
    written += n;
  }
}

describe("v0.9.3 C3：xc_team checkpoint 的 journal 体积闸（工具面端到端）", () => {
  it("34 MiB journal → 仍写盘成功 + 第 4 章占位 + payload warnings[] 同一条 warning", async () => {
    await seedTeam();
    writeHugeJournal("86e8b61a-t1", 34 * 1024 * 1024);
    identityStore.bind("conn-ckpt-gate", bindIdentity("alice", "sess-alice"));

    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-ckpt-gate");
    const payload = payloadOf(res) as Record<string, unknown>;
    // 写盘事实保持成功（观测/存储问题不毁掉检查点本身）。
    expect(payload["path"]).toBeDefined();
    expect(payload["pruned"]).toBe(0);
    // warning 走既有可选键（§14.1 冻结形状不增键），与 unread 读取失败同渠道。
    const warnings = payload["warnings"] as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("journal 读入被跳过");
    expect(warnings[0]).toContain("8 MiB 体积上限");
    expect(warnings[0]).toContain("86e8b61a-t1");

    // 检查点 markdown：第 4 章只留占位，内容一个字节都没进。
    const markdown = readFileSync(payload["path"] as string, "utf8");
    expect(markdown).toContain("journal 读入被跳过");
    expect(markdown).not.toContain("aaaa");
    expect(markdown).toContain("## 4. 最近 journal（每任务末 5 行 + 路径）");

    // 审计事件照常（写盘成功的事实不缺）。
    const events = readFileSync(engineLogFile(stateRoot), "utf8")
      .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.filter((e) => e["event"] === "checkpoint")).toHaveLength(1);
  });

  it("正常 journal → 无 warning、末行照常进第 4 章（闸不过度遏制）", async () => {
    await seedTeam();
    const dir = join(stateRoot, "tasks", "86e8b61a-t1");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "journal.md"), "- 2026-11-20 09:00 | 体积闸回归金丝雀\n");
    identityStore.bind("conn-ckpt-gate", bindIdentity("alice", "sess-alice"));

    const res = await handleTeam(deps, { action: "checkpoint" }, "conn-ckpt-gate");
    const payload = payloadOf(res) as Record<string, unknown>;
    expect(payload["warnings"]).toBeUndefined();
    expect(readFileSync(payload["path"] as string, "utf8")).toContain("- 2026-11-20 09:00 | 体积闸回归金丝雀");
  });
});
