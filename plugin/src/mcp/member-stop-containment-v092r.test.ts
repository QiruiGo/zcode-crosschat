/**
 * v0.9.2 收尾定向单测：member-stop 两条 P1（对抗轮 adv2-r2-F1/F2 → 裁决 V092R-07 /
 * V092R-08，均 group B 存储遏制）的修复防回归。
 *
 * 覆盖面（与裁决 finding 逐条对应）：
 * - V092R-07（链接逃逸·journal/archive 面）：预置 `<stateRoot>/tasks/<taskId>`
 *   junction 指向状态根外文件时，member-stop 留档（archive 缺省 true）不得把该文件
 *   内容读入并持久化进 `<stateRoot>/archive/<name>/journal.md`；已装闸的
 *   `xc_read({scope:"journal", id:"archive:<name>"})` 回读同样不含金丝雀；停止照常
 *   完成（任务回池、成员 removed），逃逸 taskId 经 skippedJournals 如实披露。
 *   回归：真实 journal 仍进取档；链接目标仍在状态根内（根内引用）不过度遏制。
 * - V092R-08（失败无副作用·授权次序）：非 lead 调用 member-stop → not_lead，且
 *   **零副作用**——无 archive 目录落盘、无 member-archive-written 审计行、受害成员
 *   与其任务原样；lead 对不存在成员 stop → invalid_params，同样零副作用（不造幻影
 *   留档）；removed 成员再 stop → member_removed 且不覆盖既有留档快照。
 *   回归：lead 正常停止仍留档 + 审计 + 回池（happy path 不变）。
 *
 * 平台注记：junction 为 Windows 形态（mklink /J 免提权）；非 win32 平台相关用例
 * 按既有纪律 skip（不假过）。
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { createMemberToolCore } from "./tools-team.js";
import { handleRead, JOURNAL_MAX_BYTES } from "./tools-read.js";
import { identityStore } from "./identity.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import type { Task, TeamMember, TeamState } from "../core/types.js";
import type { ToolDeps } from "./core.js";

const CANARY = "CANARY-V092R-07-STOP-ARCHIVE-4d81b2";

const dirs: string[] = [];
let workDir = "";
let stateRoot = "";
let outsideDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-stop-ws-"));
  stateRoot = join(workDir, ".crosschat");
  outsideDir = mkdtempSync(join(tmpdir(), "xc-stop-outside-"));
  dirs.push(workDir, outsideDir);
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

function deps(): ToolDeps {
  return { stateRoot, workspace: workDir, env: {} };
}

/** lead（ldr1）+ 成员（sessionId 置空 ⇒ member-stop 的收尾唤醒走 skipped，不拉真会话）。 */
function teamWith(members: TeamMember[], tasks: Task[] = []): TeamState {
  return {
    teamId: "default",
    name: "default",
    founderKey: "ldr1",
    leadKey: "ldr1",
    phase: "open",
    members,
    tasks,
    seq: 0,
    createdAt: 1,
  };
}

function member(key: string, state: TeamMember["state"]): TeamMember {
  return { key, sessionId: "", role: "worker", identity: "engine", joinedAt: 1, lastSeen: 1, state };
}

async function bindConn(key: string): Promise<string> {
  const conn = `conn-${key}`;
  identityStore.bind(conn, {
    sessionKey: `xc:default:${key}`, teamId: "default", name: key, agentKey: key,
    sessionId: `sess-${key}`, role: "worker", boundAt: Date.now(),
  });
  return conn;
}

/** 一张 assignee=b 的在途任务（in_progress ∈ OPEN_TASK_STATUSES）。 */
function taskFixture(id: string, assignee: string): Task {
  const now = Date.now();
  return {
    id,
    title: `任务 ${id}`,
    prompt: "p",
    dependsOn: [],
    status: "in_progress",
    assignee,
    attempt: 1,
    attemptId: `att-${id}`,
    createdBy: "ldr1",
    createdAt: now - 60_000,
    updatedAt: now - 20_000,
    lastProgressTs: now - 20_000,
    result: null,
    error: null,
    evidence: [],
    history: [{ ts: now - 20_000, event: "report", by: assignee }],
  };
}

/** 建队（ldr1 lead + b/mateb 两个成员）并绑定 lead / mateb 连接身份。 */
async function seedTeam(tasks: Task[] = []): Promise<{ leadConn: string; matebConn: string }> {
  await writeTeam(stateRoot, teamWith([member("ldr1", "ready"), member("b", "ready"), member("mateb", "ready")], tasks));
  return { leadConn: await bindConn("ldr1"), matebConn: await bindConn("mateb") };
}

function stopCore(): ReturnType<typeof createMemberToolCore> {
  return createMemberToolCore(deps());
}

async function stopAs(conn: string, name: string, archive?: boolean): Promise<ToolResult> {
  return stopCore().xc_member_stop({ name, ...(archive === undefined ? {} : { archive }) }, conn);
}

function engineEvents(): string[] {
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
}

/** 状态根全量快照（相对路径 + 内容）：用于断言失败调用「零文件写入」。 */
function snapshotTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, childRel);
      else out.push(`${childRel}:${readFileSync(abs).toString("base64")}`);
    }
  };
  walk(root, "");
  return out.sort();
}

function createJunction(link: string, target: string): boolean {
  try {
    execSync(`cmd /c mklink /J "${link}" "${target}"`, { stdio: "ignore" });
    return existsSync(link);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// V092R-07：member-stop 留档面的链接逃逸闸
// ---------------------------------------------------------------------------

describe("v0.9.2 V092R-07：member-stop 留档不把 junction 逃逸内容持久化进 archive journal", () => {
  it("junction 化任务 journal：金丝雀不进取档、不经 xc_read 回读；停止照常完成且逃逸 taskId 如实披露", async () => {
    if (process.platform !== "win32") return;
    const taskId = "esc-t1";
    const { leadConn } = await seedTeam([taskFixture(taskId, "b")]);

    // 攻击形态：状态根外放金丝雀 journal，`<stateRoot>/tasks/<taskId>` 建成指向它的 junction。
    const target = join(outsideDir, "v092r07-stop-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "journal.md"), `${CANARY}\n第二行金丝雀\n`, "utf8");
    mkdirSync(join(stateRoot, "tasks"), { recursive: true });
    expect(createJunction(join(stateRoot, "tasks", taskId), target)).toBe(true);

    const res = await stopAs(leadConn, "b");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as { archive?: { dir: string; skippedJournals?: string[] } };
    // 逃逸 journal 被跳过且披露（留档缺节不静默）。
    expect(payload.archive?.skippedJournals).toEqual([taskId]);
    expect(String(res.content[0]!.text)).toContain("archive journals skipped");
    // 金丝雀不在留档 journal（状态根内真实文件）里。
    const journal = readFileSync(join(stateRoot, "archive", "b", "journal.md"), "utf8");
    expect(journal).not.toContain(CANARY);
    expect(journal).toContain(taskId); // 任务仍在清单（三节正文照常聚合，不丢）
    // 已装闸的读取面回读放行（根内真实文件）但同样不含金丝雀。
    const read = await handleRead(deps(), { scope: "journal", id: "archive:b" }, "");
    expect(read.isError).toBeFalsy();
    expect(String(payloadOf(read)["text"])).not.toContain(CANARY);
    // 停止语义不变：成员 removed、在途任务回池（pending + attempt+1）。
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "b")?.state).toBe("removed");
    const task = team.tasks.find((t) => t.id === taskId)!;
    expect(task.status).toBe("pending");
    expect(task.assignee).toBeNull();
    expect(task.attempt).toBe(2);
    // 留档写入的审计行照常（留档本身成功了，只是少了逃逸那一节），且 warning
    // 如实进入引擎事件（meta 之外的第二披露面）。
    const archiveEvent = engineEvents().find((line) => line.includes('"member-archive-written"'));
    expect(archiveEvent).toBeDefined();
    expect(archiveEvent).toContain("journal 读入被跳过：链接逃逸工作区");
    expect(archiveEvent).toContain(taskId);
  });

  it("超过 8 MiB 的任务 journal：整文件不读入留档、跳过 + warning，member-stop 照常成功", async () => {
    const taskId = "big-t1";
    const { leadConn } = await seedTeam([taskFixture(taskId, "b")]);
    mkdirSync(join(stateRoot, "tasks", taskId), { recursive: true });
    // 尾部金丝雀：只有整文件被读入才会出现（证明体积闸先于 readFile）。
    const tailCanary = "CANARY-V092R-07-OVERSIZE-TAIL-9c02";
    const body = Buffer.concat([
      Buffer.from("BEGIN-OVERSIZE\n"),
      Buffer.alloc(JOURNAL_MAX_BYTES + 1024, 0x61), // 'a'
      Buffer.from(`\n${tailCanary}\n`),
    ]);
    writeFileSync(join(stateRoot, "tasks", taskId, "journal.md"), body);

    const res = await stopAs(leadConn, "b");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as { archive?: { skippedJournals?: string[]; warnings?: string[] } };
    expect(payload.archive?.skippedJournals).toEqual([taskId]);
    expect(payload.archive?.warnings?.join("\n")).toContain("超过 8 MiB 体积上限");
    expect(String(res.content[0]!.text)).toContain("archive journals skipped");
    // 留档 journal 不含超大正文尾部（整文件从未被 readFile），体积远低于上限。
    const archiveJournalPath = join(stateRoot, "archive", "b", "journal.md");
    const archived = readFileSync(archiveJournalPath, "utf8");
    expect(archived).not.toContain(tailCanary);
    expect(archived.length).toBeLessThan(1024 * 1024);
    expect(archived).toContain(taskId); // 任务清单仍在（留档不丢任务）
    // warning 入引擎审计（与 skippedJournals 同一条 member-archive-written）。
    const archiveEvent = engineEvents().find((line) => line.includes('"member-archive-written"'));
    expect(archiveEvent).toBeDefined();
    expect(archiveEvent).toContain("journal 读入被跳过：超过 8 MiB 体积上限");
    expect(archiveEvent).toContain(taskId);
    // 停止语义不变：成员 removed、在途任务回池。
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "b")?.state).toBe("removed");
    expect(team.tasks.find((t) => t.id === taskId)?.status).toBe("pending");
  });

  it("回归：真实任务 journal 仍进取档（闸不过度遏制）", async () => {
    const taskId = "real-t1";
    const { leadConn } = await seedTeam([taskFixture(taskId, "b")]);
    mkdirSync(join(stateRoot, "tasks", taskId), { recursive: true });
    writeFileSync(join(stateRoot, "tasks", taskId, "journal.md"), "- 2026-11-20 15:02 | 完成平方表 | D:\\ws\\out\\x.txt\n", "utf8");

    const res = await stopAs(leadConn, "b");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as { archive?: { skippedJournals?: string[] } };
    expect(payload.archive?.skippedJournals).toBeUndefined();
    const journal = readFileSync(join(stateRoot, "archive", "b", "journal.md"), "utf8");
    expect(journal).toContain("完成平方表");
  });

  it("回归：链接目标仍在状态根内 → 放行（根内引用不是逃逸）", async () => {
    if (process.platform !== "win32") return;
    mkdirSync(join(stateRoot, "tasks", "real-t2"), { recursive: true });
    writeFileSync(join(stateRoot, "tasks", "real-t2", "journal.md"), "状态根内的 journal 正文\n", "utf8");
    mkdirSync(join(stateRoot, "tasks"), { recursive: true });
    expect(createJunction(join(stateRoot, "tasks", "alias-t2"), join(stateRoot, "tasks", "real-t2"))).toBe(true);
    const { leadConn } = await seedTeam([taskFixture("real-t2", "b"), taskFixture("alias-t2", "b")]);

    const res = await stopAs(leadConn, "b");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as { archive?: { skippedJournals?: string[] } };
    expect(payload.archive?.skippedJournals).toBeUndefined();
    const journal = readFileSync(join(stateRoot, "archive", "b", "journal.md"), "utf8");
    expect(journal).toContain("状态根内的 journal 正文");
  });
});

// ---------------------------------------------------------------------------
// V092R-08：member-stop 授权次序——失败=无副作用
// ---------------------------------------------------------------------------

describe("v0.9.2 V092R-08：member-stop 失败零副作用（授权校验先于留档）", () => {
  it("非 lead 调用 → not_lead 且零副作用：无留档目录、无 member-archive-written 审计行、受害成员与任务原样", async () => {
    const taskId = "live-t1";
    const { matebConn } = await seedTeam([taskFixture(taskId, "b")]);
    const stateBefore = snapshotTree(stateRoot);

    const res = await stopAs(matebConn, "b");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as { error: string; agentKey: string; leadKey: string };
    expect(payload.error).toBe("not_lead");
    expect(payload.agentKey).toBe("mateb");
    expect(payload.leadKey).toBe("ldr1");
    // 副作用为零：archive 目录根本不存在（幻影留档不落盘）。
    expect(existsSync(join(stateRoot, "archive"))).toBe(false);
    // 审计行零条：连 member-archive-failed / member-stopped 都不该有。
    expect(engineEvents()).toEqual([]);
    // 受害成员仍在册且状态原样；其任务未被回池。
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "b")?.state).toBe("ready");
    const task = team.tasks.find((t) => t.id === taskId)!;
    expect(task.status).toBe("in_progress");
    expect(task.assignee).toBe("b");
    // 全量快照：状态根下没有任何文件被新建/改写/删除（锁文件、日志目录也不许出现）。
    expect(snapshotTree(stateRoot)).toEqual(stateBefore);
  });

  it("非 lead 对不存在花名调用 → not_lead 仍先于一切（不为不存在成员落任何盘）", async () => {
    const { matebConn } = await seedTeam();
    const res = await stopAs(matebConn, "ghost");
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as { error: string }).error).toBe("not_lead");
    expect(existsSync(join(stateRoot, "archive"))).toBe(false);
    expect(engineEvents()).toEqual([]);
  });

  it("lead 对不存在成员调用 → invalid_params 且零副作用（不造幻影留档、无审计行）", async () => {
    const { leadConn } = await seedTeam();
    const res = await stopAs(leadConn, "ghost");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as { error: string; message: string };
    expect(payload.error).toBe("invalid_params");
    expect(payload.message).toContain('no member "ghost"');
    expect(existsSync(join(stateRoot, "archive"))).toBe(false);
    expect(engineEvents()).toEqual([]);
  });

  it("removed 成员再 stop → member_removed 且不覆盖既有留档快照（失败可重试、无写入）", async () => {
    const { leadConn } = await seedTeam();
    const first = await stopAs(leadConn, "b", true);
    expect(first.isError).toBeFalsy();
    const journalPath = join(stateRoot, "archive", "b", "journal.md");
    // 探针标记：若失败调用重写留档（writeArchive 原子覆盖），该行必然消失——
    // 比整文件比对更强（后者在同毫秒重写下会因 ISO 时刻相同而假绿）。
    writeFileSync(journalPath, `${readFileSync(journalPath, "utf8")}\n<!-- probe-marker-v092r08 -->\n`, "utf8");
    const archiveEventsBefore = engineEvents().filter((line) => line.includes('"member-archive-written"')).length;
    expect(archiveEventsBefore).toBe(1);

    const second = await stopAs(leadConn, "b", true);
    expect(second.isError).toBe(true);
    expect((payloadOf(second) as { error: string }).error).toBe("member_removed");
    // 留档快照不被失败调用重写。
    expect(readFileSync(journalPath, "utf8")).toContain("<!-- probe-marker-v092r08 -->");
    expect(engineEvents().filter((line) => line.includes('"member-archive-written"')).length).toBe(archiveEventsBefore);
  });

  it("回归：lead 正常停止仍留档 + 审计 + 回池（happy path 不变）", async () => {
    const taskId = "hp-t1";
    const { leadConn } = await seedTeam([taskFixture(taskId, "b")]);
    mkdirSync(join(stateRoot, "tasks", taskId), { recursive: true });
    writeFileSync(join(stateRoot, "tasks", taskId, "journal.md"), "happy journal 正文\n", "utf8");

    const res = await stopAs(leadConn, "b");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as { name: string; state: string; archive: { dir: string }; revokedTasks: { taskId: string }[] };
    expect(payload.name).toBe("b");
    expect(payload.state).toBe("removed");
    expect(payload.archive.dir).toBe(join(stateRoot, "archive", "b"));
    expect(payload.revokedTasks.map((r) => r.taskId)).toEqual([taskId]);
    // 三节留档正文 + meta 全在场。
    const journal = readFileSync(join(stateRoot, "archive", "b", "journal.md"), "utf8");
    expect(journal).toContain("## 负责任务");
    expect(journal).toContain("## 当前进度");
    expect(journal).toContain("## 交接注意");
    expect(journal).toContain("happy journal 正文");
    expect(existsSync(join(stateRoot, "archive", "b", "meta.json"))).toBe(true);
    // 审计行：留档 + 停机两条。
    const events = engineEvents();
    expect(events.some((line) => line.includes('"member-archive-written"'))).toBe(true);
    expect(events.some((line) => line.includes('"member-stopped"'))).toBe(true);
    // 回池 + 移除终态。
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.find((m) => m.key === "b")?.state).toBe("removed");
    expect(team.tasks.find((t) => t.id === taskId)?.status).toBe("pending");
  });

  it("archive:false 仍走预检（非 lead 同样零副作用），且不留档", async () => {
    const { matebConn } = await seedTeam();
    const res = await stopAs(matebConn, "b", false);
    expect(res.isError).toBe(true);
    expect((payloadOf(res) as { error: string }).error).toBe("not_lead");
    expect(existsSync(join(stateRoot, "archive"))).toBe(false);
    expect(engineEvents()).toEqual([]);
  });
});
