/**
 * v0.9.2 组 B 定向单测：存储与遏制（B2 链接逃逸闸 / B3 入参回显闸 / B4 journal 体积闸）。
 *
 * 覆盖面（与方案 35-v092 的组 B 逐条对应；验收锚点：junction 拒、1MB id 回显被
 * 截断、200MiB journal 被拒且内存不爆）：
 * - B2 evidence 门：junction 内文件（条目自身是常规文件，词法 containment 看不出）
 *   被拒；条目级 symlink 逃逸被拒；链接目标仍在工作区内 → 放行（逃逸才拒）；
 *   真源不动（任务停在 in_progress、无回执）。
 * - B2 refs 门：同一函数同一口径——junction 内文件整单拒绝，一个字节不落箱。
 * - B3 id 长度闸：xc_read 的 id / xc_claim·xc_report 的 taskId 超 512 字符即拒
 *   （id_too_long），错误回显截断（1 MiB 输入不再整段回吐）；512/513 边界。
 * - B4 journal 体积闸：readFile **之前**先 stat——200 MiB（稀疏文件）被拒且
 *   readFile 一次都没调用（模块级 mock 实证，非内存启发式）；8 MiB 边界
 *   （等于上限放行、+1 字节拒）；小 journal 分页回归。
 *
 * 平台注记：symlink/junction 为 Windows 形态（junction 无需提权；文件 symlink 需
 * SeCreateSymbolicLinkPrivilege，拿不到时该例 skip 不假过）。
 */
import { execSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  ftruncateSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadOf, ToolError, type ToolResult } from "./protocol.js";
import { identityStore } from "./identity.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import { readMailbox } from "../core/mailbox.js";
import { createTaskCore } from "./tools-tasks.js";
import { createTeamRelayCore } from "./tools-relay.js";
import { handleRead, JOURNAL_MAX_BYTES } from "./tools-read.js";
import { readTaskJournalTail, writeCheckpoint, type CheckpointData } from "../core/checkpoint.js";
import type { Task } from "../core/types.js";

// B4：readFile mock——体积闸必须在 readFile **之前** stat。block=true 时任何
// readFile 调用都抛 distinctive 错误：若体积闸失守（先读后判），测试拿到的就是
// 这个错误而不是 journal_too_large——「没读进内存」由此成为确定性断言。
const readFileGate = vi.hoisted(() => ({ block: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (path: unknown, options?: unknown): Promise<string> =>
      readFileGate.block
        ? Promise.reject(new Error("oversized journal must be refused by the stat gate before readFile"))
        : (actual.readFile as (p: unknown, o?: unknown) => Promise<string>)(path, options),
  };
});

const dirs: string[] = [];
let workDir = "";
let stateRoot = "";
let outsideDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-b2-ws-"));
  stateRoot = join(workDir, ".crosschat");
  outsideDir = mkdtempSync(join(tmpdir(), "xc-b2-outside-"));
  dirs.push(workDir, outsideDir);
  readFileGate.block = false;
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

function taskCore(): ReturnType<typeof createTaskCore> {
  return createTaskCore({ stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: join(workDir, "peers-root") } });
}

function relayCore(): ReturnType<typeof createTeamRelayCore> {
  return createTeamRelayCore({ stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: join(workDir, "peers-root") } });
}

/** 建队 + 绑定 a（派发方）/ b（受领方）两个连接身份。 */
async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: "default", founderKey: "a", now });
  team.members.push(
    { key: "a", sessionId: "sess_a", role: "peer", joinedAt: now, lastSeen: now },
    { key: "b", sessionId: "sess_b", role: "worker", joinedAt: now, lastSeen: now },
  );
  await writeTeam(stateRoot, team);
  identityStore.bind("conn-a", {
    sessionKey: "xc:default:a", teamId: "default", name: "a", agentKey: "a",
    sessionId: "sess_a", role: "peer", boundAt: now,
  });
  identityStore.bind("conn-b", {
    sessionKey: "xc:default:b", teamId: "default", name: "b", agentKey: "b",
    sessionId: "sess_b", role: "worker", boundAt: now,
  });
}

/** 派一张票给 b 并认领 + in_progress，返回 taskId/attemptId（证据门测试的前置）。 */
async function seedClaimedTask(): Promise<{ taskId: string; attemptId: string }> {
  await seedTeam();
  const core = taskCore();
  const dispatched = payloadOf(await core.xc_dispatch({ to: "b", title: "算", prompt: "写结果到 result.txt" }, "conn-a"));
  const taskId = dispatched["taskId"] as string;
  const claim = payloadOf(await core.xc_claim({ taskId }, "conn-b"));
  await core.xc_report({ taskId, attemptId: claim["attemptId"] as string, status: "in_progress" }, "conn-b");
  return { taskId, attemptId: claim["attemptId"] as string };
}

function createJunction(link: string, target: string): boolean {
  try {
    execSync(`cmd /c mklink /J "${link}" "${target}"`, { stdio: "ignore" });
    return existsSync(link);
  } catch {
    return false;
  }
}

function createSymlink(link: string, target: string): boolean {
  try {
    execSync(`cmd /c mklink "${link}" "${target}"`, { stdio: "ignore" });
    return existsSync(link);
  } catch {
    return false;
  }
}

/** 工作区外放一个文件，并在工作区内建一个指向其所在目录的 junction；返回工作区内拼法。 */
function seedOutsideViaJunction(name = "escape"): { outsideFile: string; viaJunction: string } {
  const targetDir = join(outsideDir, `${name}-target`);
  mkdirSync(targetDir, { recursive: true });
  const outsideFile = join(targetDir, "secret.txt");
  writeFileSync(outsideFile, "outside-secret-content", "utf8");
  const link = join(workDir, `${name}-junction`);
  expect(createJunction(link, targetDir)).toBe(true);
  return { outsideFile, viaJunction: join(link, "secret.txt") };
}

// ---------------------------------------------------------------------------
// B2：证据门（xc_report evidence）链接逃逸
// ---------------------------------------------------------------------------

describe("v0.9.2 B2：evidence 门拒绝 symlink/junction 逃逸工作区", () => {
  it("junction 内文件被拒（evidence_path_outside_workspace），真源不动、无回执", async () => {
    if (process.platform !== "win32") return;
    const { taskId, attemptId } = await seedClaimedTask();
    const { viaJunction } = seedOutsideViaJunction();

    const res = await taskCore().xc_report(
      { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: viaJunction, note: "jump" }] },
      "conn-b",
    );
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as { error: string; message: string; path: string; workspace: string };
    expect(payload["error"]).toBe("evidence_path_outside_workspace");
    expect(payload["path"]).toBe(viaJunction);
    expect(payload["workspace"]).toBe(workDir);
    expect(payload["message"]).toContain("symlink/junction");

    // 真源不动：任务停在 in_progress、伪证据未落库、派发方无回执。
    const team = await readTeam(stateRoot, "default");
    const task = team!.tasks.find((t) => t.id === taskId)!;
    expect(task.status).toBe("in_progress");
    expect(task.evidence).toEqual([]);
    const box = await readMailbox(stateRoot, "default", "a");
    expect(box.filter((m) => m.content.includes('"task-receipt"'))).toHaveLength(0);
  });

  it("条目级 symlink 指向工作区外同样被拒（message 如实说明经 symlink/junction）", async () => {
    if (process.platform !== "win32") return;
    const { taskId, attemptId } = await seedClaimedTask();
    const outsideFile = join(outsideDir, "outside.txt");
    writeFileSync(outsideFile, "outside-content", "utf8");
    const link = join(workDir, "outside-link.txt");
    if (!createSymlink(link, outsideFile)) return; // 无符号链接权限：跳过（不假过）

    const res = await taskCore().xc_report(
      { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: link }] },
      "conn-b",
    );
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as { error: string; message: string };
    expect(payload["error"]).toBe("evidence_path_outside_workspace");
    expect(payload["message"]).toContain("symlink/junction");
    expect((await readTeam(stateRoot, "default"))!.tasks.find((t) => t.id === taskId)!.status).toBe("in_progress");
  });

  it("链接目标仍在工作区内 → 放行（逃逸才拒；工作区内部引用不是逃逸）", async () => {
    if (process.platform !== "win32") return;
    const { taskId, attemptId } = await seedClaimedTask();
    const sub = join(workDir, "real-sub");
    mkdirSync(sub, { recursive: true });
    const real = join(sub, "ok.txt");
    writeFileSync(real, "inside-content", "utf8");
    const link = join(workDir, "inside-junction");
    expect(createJunction(link, sub)).toBe(true);
    const viaJunction = join(link, "ok.txt");

    const res = await taskCore().xc_report(
      { taskId, attemptId, status: "completed", result: "ok", evidence: [{ path: viaJunction }] },
      "conn-b",
    );
    expect(res.isError).toBeFalsy();
    expect((await readTeam(stateRoot, "default"))!.tasks.find((t) => t.id === taskId)!.status).toBe("completed");
  });

  it("词法闸不回退：../ 穿越仍被拒（既有 R2-5 口径，B2 叠加不替换）", async () => {
    const { taskId, attemptId } = await seedClaimedTask();
    const outside = join(workDir, "..", "xc-b2-lexical-outside.txt");
    writeFileSync(outside, "lexical", "utf8");
    try {
      const res = await taskCore().xc_report(
        { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: outside }] },
        "conn-b",
      );
      expect(res.isError).toBe(true);
      expect(payloadOf(res)["error"]).toBe("evidence_path_outside_workspace");
    } finally {
      try { rmSync(outside, { force: true }); } catch { /* 尽力而为 */ }
    }
  });
});

// ---------------------------------------------------------------------------
// B2：refs 门（xc_relay refs）——同一函数同一口径
// ---------------------------------------------------------------------------

describe("v0.9.2 B2：refs 门拒绝 junction 逃逸（整单拒绝，一个字节不落箱）", () => {
  it("junction 内文件作 refs 被拒（field:refs，邮箱零字节）", async () => {
    if (process.platform !== "win32") return;
    await seedTeam();
    const { viaJunction } = seedOutsideViaJunction("refs");

    const res = await relayCore().xc_message({ to: "b", msg: "看这个", refs: [{ path: viaJunction }] }, "conn-a");
    expect(res.isError).toBe(true);
    const payload = payloadOf(res) as { error: string; field?: string; message: string };
    expect(payload["error"]).toBe("evidence_path_outside_workspace");
    expect(payload["field"]).toBe("refs");
    expect(payload["message"]).toContain("symlink/junction");
    expect(await readMailbox(stateRoot, "default", "b")).toHaveLength(0);
  });

  it("两条引用中一条经 junction 逃逸 → 全单拒绝（好引用也不落箱）", async () => {
    if (process.platform !== "win32") return;
    await seedTeam();
    const good = join(workDir, "good.txt");
    writeFileSync(good, "good", "utf8");
    const { viaJunction } = seedOutsideViaJunction("refs2");

    const res = await relayCore().xc_message(
      { to: "b", msg: "两条", refs: [{ path: good }, { path: viaJunction }] },
      "conn-a",
    );
    expect(res.isError).toBe(true);
    expect(payloadOf(res)["error"]).toBe("evidence_path_outside_workspace");
    expect(await readMailbox(stateRoot, "default", "b")).toHaveLength(0);
  });

  it("工作区内真实文件作 refs 不受影响（遏制只挡界外/逃逸）", async () => {
    await seedTeam();
    const good = join(workDir, "fine.txt");
    writeFileSync(good, "fine", "utf8");
    const res = await relayCore().xc_message({ to: "b", msg: "ok", refs: [{ path: good }] }, "conn-a");
    expect(res.isError).toBeFalsy();
    const refs = payloadOf(res)["refs"] as Array<Record<string, unknown>>;
    expect(refs[0]!["path"]).toBe(good);
  });
});

// ---------------------------------------------------------------------------
// B3：入参长度闸（≤512）+ 错误回显截断
// ---------------------------------------------------------------------------

describe("v0.9.2 B3：id 类入参长度闸与回显截断（1 MiB 输入不再整段回吐）", () => {
  const BIG = "x".repeat(1024 * 1024); // 验收锚点：1 MiB id

  it("xc_read 的 id 超限 → id_too_long，序列化回显 <4 KiB 且不含原文", async () => {
    await seedTeam();
    let caught: unknown;
    try {
      await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope: "mail", id: BIG }, "conn-a");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolError);
    const payload = (caught as ToolError).payload;
    expect(payload["error"]).toBe("id_too_long");
    expect(payload["field"]).toBe("id");
    expect(payload["length"]).toBe(BIG.length);
    expect(payload["limit"]).toBe(512);
    const serialized = JSON.stringify(payload);
    expect(serialized.length).toBeLessThan(4096);
    expect(serialized).not.toContain(BIG);
    expect(String(payload["message"])).toContain("truncated");
  });

  it("xc_read 各带 id 的 scope 同一道闸（task / peer-msg / journal / handoff）", async () => {
    await seedTeam();
    for (const scope of ["task", "peer-msg", "journal", "handoff"] as const) {
      let caught: unknown;
      try {
        await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope, id: BIG }, "conn-a");
      } catch (error) {
        caught = error;
      }
      expect(caught, scope).toBeInstanceOf(ToolError);
      expect((caught as ToolError).payload["error"], scope).toBe("id_too_long");
      expect(JSON.stringify((caught as ToolError).payload).length, scope).toBeLessThan(4096);
    }
  });

  it("xc_claim / xc_report 的 taskId 超限 → id_too_long + 截断回显", async () => {
    const { taskId, attemptId } = await seedClaimedTask();
    const claim = await taskCore().xc_claim({ taskId: BIG }, "conn-b");
    expect(claim.isError).toBe(true);
    const claimPayload = payloadOf(claim);
    expect(claimPayload["error"]).toBe("id_too_long");
    expect(JSON.stringify(claimPayload).length).toBeLessThan(4096);
    expect(JSON.stringify(claimPayload)).not.toContain(BIG);

    const report = await taskCore().xc_report(
      { taskId: BIG, attemptId, status: "in_progress" },
      "conn-b",
    );
    expect(report.isError).toBe(true);
    const reportPayload = payloadOf(report);
    expect(reportPayload["error"]).toBe("id_too_long");
    expect(JSON.stringify(reportPayload).length).toBeLessThan(4096);
  });

  it("512/513 边界：等于上限放行（走原 unknown task 路径），超 1 字符即拒", async () => {
    await seedTeam();
    const at512 = await taskCore().xc_claim({ taskId: "t".repeat(512) }, "conn-b");
    expect(at512.isError).toBe(true);
    expect(payloadOf(at512)["error"]).toBe("invalid_params"); // 过闸后原有语义不变
    expect(String(payloadOf(at512)["message"])).toContain("unknown task");

    const at513 = await taskCore().xc_claim({ taskId: "t".repeat(513) }, "conn-b");
    expect(at513.isError).toBe(true);
    expect(payloadOf(at513)["error"]).toBe("id_too_long");
  });
});

// ---------------------------------------------------------------------------
// B4：journal 体积闸（先 stat 后 readFile；200 MiB 拒且不读入内存）
// ---------------------------------------------------------------------------

describe("v0.9.2 B4：journal 体积闸（8 MiB；超限拒绝 + 归档/分页指引）", () => {
  function journalFileFor(taskId: string): string {
    const dir = join(stateRoot, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    return join(dir, "journal.md");
  }

  it("200 MiB journal 被拒（journal_too_large）且 readFile 一次都没调用", async () => {
    const file = journalFileFor("task-big");
    // 稀疏文件：瞬间造出 200 MiB 体积，不落 200 MiB 字节。
    const fd = openSync(file, "w");
    try {
      ftruncateSync(fd, 200 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }
    const rssBefore = process.memoryUsage().rss;

    readFileGate.block = true;
    let caught: unknown;
    try {
      await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope: "journal", id: "task-big" }, "conn-b");
    } catch (error) {
      caught = error;
    } finally {
      readFileGate.block = false;
    }

    // 若体积闸失守（先 readFile 后判断），这里拿到的是 mock 的 distinctive 错误。
    expect(caught).toBeInstanceOf(ToolError);
    const payload = (caught as ToolError).payload;
    expect(payload["error"]).toBe("journal_too_large");
    expect(payload["sizeBytes"]).toBe(200 * 1024 * 1024);
    expect(payload["limitBytes"]).toBe(JOURNAL_MAX_BYTES);
    expect(String(payload["message"])).toContain("Archive or split it first");
    // 内存启发式（确定性证明是上方 readFile mock）：RSS 不应被 200 MiB 读入抬高。
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(64 * 1024 * 1024);
  });

  it("8 MiB 边界：等于上限放行（分页照旧），超 1 字节即拒", async () => {
    const file = journalFileFor("task-boundary");
    writeFileSync(file, Buffer.alloc(8 * 1024 * 1024));
    const atLimit = await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope: "journal", id: "task-boundary" }, "conn-b");
    expect(atLimit.isError).toBeFalsy();
    expect(payloadOf(atLimit)["total"]).toBe(8 * 1024 * 1024);

    writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1));
    let over: unknown;
    try {
      await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope: "journal", id: "task-boundary" }, "conn-b");
    } catch (error) {
      over = error;
    }
    expect(over).toBeInstanceOf(ToolError);
    expect((over as ToolError).payload["error"]).toBe("journal_too_large");
  });

  it("小 journal 分页正常；缺失 journal 仍给 journal_not_found（回归）", async () => {
    const file = journalFileFor("task-small");
    writeFileSync(file, "第一行\n第二行\n", "utf8");
    const res = await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope: "journal", id: "task-small", limit: 3 }, "conn-b");
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res) as { total: number; text: string; hasMore: boolean };
    expect(payload["total"]).toBe(8); // "第一行\n第二行\n" = 3+1+3+1
    expect(payload["text"]).toBe("第一行");
    expect(payload["hasMore"]).toBe(true);

    let caught: unknown;
    try {
      await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope: "journal", id: "task-absent" }, "conn-b");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as ToolError).payload["error"]).toBe("journal_not_found");
  });
});

// ---------------------------------------------------------------------------
// V092-10（打回第 1 轮修复）：journal 读取面 + 检查点持久化面的链接逃逸闸
//
// 红队 adv-2/F1 实测复现的缺口：xc_read({scope:"journal"}) 只做 sanitizeKey 段闸 +
// stat/readFile，未装 B2 的链接遏制闸——预置 `<stateRoot>/tasks/<id>`（或
// `archive/<name>`）junction（mklink /J 免提权）指向工作区外文件时，该 scope
// **不需身份**即可把 ≤8 MiB 任意文件全文读进任一会话模型上下文；同一 junction 经
// readTaskJournalTail（core/checkpoint.ts）落进团队共享检查点。
// 修复：readJournalScope 与 readTaskJournalTail 装同一道闸（core/paths.ts
// checkLinkContainment，锚点=状态根——journal 是 .crosschat 内部文件，容状态根整体
// 经 junction 搬迁）。以下用例即该复现的可自动化断言。
// ---------------------------------------------------------------------------

describe("v0.9.2 V092-10：journal 读取面链接逃逸闸（金丝雀不落地）", () => {
  const CANARY = "CANARY-V092-10-OUTSIDE-JOURNAL-9c41e9d";

  /** 工作区外放金丝雀 journal 目录，并在状态根内建指向它的 junction。 */
  function seedOutsideJournalViaJunction(stateRootDir: string, linkName: string, targetName: string): string {
    const target = join(outsideDir, targetName);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "journal.md"), `${CANARY}\n第二行金丝雀\n`, "utf8");
    const link = join(stateRootDir, linkName);
    expect(createJunction(link, target)).toBe(true);
    return link;
  }

  it("xc_read journal：`.crosschat/tasks/<id>` junction 逃逸被拒（无身份也拒），金丝雀不进任何回显", async () => {
    if (process.platform !== "win32") return;
    mkdirSync(join(stateRoot, "tasks"), { recursive: true });
    seedOutsideJournalViaJunction(join(stateRoot, "tasks"), "adjt1", "v09210-tasks-target");

    let caught: unknown;
    try {
      // 不绑定任何身份（journal scope 历来无身份要求）——逃逸必须依然被拒。
      await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope: "journal", id: "adjt1" }, "");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolError);
    const payload = (caught as ToolError).payload;
    expect(payload["error"]).toBe("journal_path_outside_state_root");
    expect(payload["id"]).toBe("adjt1");
    expect(String(payload["message"])).toContain("symlink/junction");
    expect(JSON.stringify(payload)).not.toContain(CANARY);
  });

  it("xc_read journal：`archive:<name>` junction 逃逸同样被拒", async () => {
    if (process.platform !== "win32") return;
    mkdirSync(join(stateRoot, "archive"), { recursive: true });
    seedOutsideJournalViaJunction(join(stateRoot, "archive"), "adjarch", "v09210-archive-target");

    let caught: unknown;
    try {
      await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope: "journal", id: "archive:adjarch" }, "");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolError);
    const payload = (caught as ToolError).payload;
    expect(payload["error"]).toBe("journal_path_outside_state_root");
    expect(JSON.stringify(payload)).not.toContain(CANARY);
  });

  it("链接目标仍在状态根内 → 放行（逃逸才拒；B4 的小 journal 分页用例同走本闸）", async () => {
    if (process.platform !== "win32") return;
    mkdirSync(join(stateRoot, "tasks", "real-t1"), { recursive: true });
    writeFileSync(join(stateRoot, "tasks", "real-t1", "journal.md"), "状态根内的 journal\n", "utf8");
    const link = join(stateRoot, "tasks", "alias-t1");
    expect(createJunction(link, join(stateRoot, "tasks", "real-t1"))).toBe(true);

    const res = await handleRead({ stateRoot, workspace: workDir, env: {} }, { scope: "journal", id: "alias-t1" }, "");
    expect(res.isError).toBeFalsy();
    expect(payloadOf(res)["text"]).toContain("状态根内的 journal");
  });
});

describe("v0.9.2 V092-10：检查点 journal 尾部不把逃逸文件持久化进团队共享检查点", () => {
  const CANARY = "CANARY-V092-10-CHECKPOINT-PERSIST-7b2f10";

  function taskFixture(id: string): Task {
    const now = Date.now();
    return {
      id,
      title: " junction 化任务",
      prompt: "p",
      dependsOn: [],
      status: "in_progress",
      assignee: "mate2",
      attempt: 1,
      attemptId: "att-1",
      createdBy: "lead",
      createdAt: now - 60_000,
      updatedAt: now - 20_000,
      lastProgressTs: now - 20_000,
      result: null,
      error: null,
      evidence: [],
      history: [{ ts: now - 20_000, event: "report", by: "mate2" }],
    };
  }

  function checkpointData(taskId: string): CheckpointData {
    const now = Date.now();
    return {
      agentKey: "mate2",
      teamId: "default",
      leadKey: "lead",
      member: { role: "worker", state: "ready", sessionId: "sess_mate2_0123456789", lastSeen: now - 2_000 },
      openTasks: [taskFixture(taskId)],
      allTasks: [taskFixture(taskId)],
      pool: [],
      unread: [],
      unreadTotal: 0,
      capacity: { watermarkPct: 23.5, freeGb: 7.2, level: "GREEN" },
      stallThresholdMs: 120 * 60 * 1000,
      // 故意不传 journalTails：让 writeCheckpoint 自行走 readTaskJournalTail（被测路径）。
      now,
    };
  }

  it("readTaskJournalTail：junction 化任务 journal → status=error、lines 空（一个字节都不取）", async () => {
    if (process.platform !== "win32") return;
    mkdirSync(join(stateRoot, "tasks"), { recursive: true });
    const target = join(outsideDir, "v09210-ckpt-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "journal.md"), `${CANARY}\n`, "utf8");
    const link = join(stateRoot, "tasks", "b127e8e4-t1");
    expect(createJunction(link, target)).toBe(true);

    const tail = await readTaskJournalTail(stateRoot, "b127e8e4-t1");
    expect(tail.status).toBe("error");
    expect(tail.lines).toEqual([]);
    expect(JSON.stringify(tail)).not.toContain(CANARY);
  });

  it("writeCheckpoint：逃逸 journal 不进共享检查点 markdown（只渲染读取失败占位）", async () => {
    if (process.platform !== "win32") return;
    mkdirSync(join(stateRoot, "tasks"), { recursive: true });
    const target = join(outsideDir, "v09210-ckpt-target2");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "journal.md"), `${CANARY}\n持久化金丝雀\n`, "utf8");
    const link = join(stateRoot, "tasks", "cafe1234-t1");
    expect(createJunction(link, target)).toBe(true);

    const written = await writeCheckpoint(stateRoot, checkpointData("cafe1234-t1"));
    const markdown = readFileSync(written.path, "utf8");
    expect(markdown).not.toContain(CANARY);
    expect(markdown).toContain("journal 读取失败");
  });

  it("回归：真实 journal 仍进检查点（闸不过度遏制）", async () => {
    mkdirSync(join(stateRoot, "tasks", "ok-t1"), { recursive: true });
    writeFileSync(join(stateRoot, "tasks", "ok-t1", "journal.md"), "正常 journal 尾行\n", "utf8");
    const tail = await readTaskJournalTail(stateRoot, "ok-t1");
    expect(tail.status).toBe("ok");
    expect(tail.lines).toContain("正常 journal 尾行");

    const written = await writeCheckpoint(stateRoot, checkpointData("ok-t1"));
    expect(readFileSync(written.path, "utf8")).toContain("正常 journal 尾行");
  });

  it("回归：状态根整体经 junction 搬迁时 journal 仍可读（锚点=状态根，容 .crosschat 被链接）", async () => {
    if (process.platform !== "win32") return;
    const realStateRoot = join(outsideDir, "relocated-state");
    mkdirSync(join(realStateRoot, "tasks", "t1"), { recursive: true });
    writeFileSync(join(realStateRoot, "tasks", "t1", "journal.md"), "搬迁后的 journal\n", "utf8");
    const linkedRoot = join(workDir, "crosschat-linked-root");
    expect(createJunction(linkedRoot, realStateRoot)).toBe(true);

    const res = await handleRead(
      { stateRoot: linkedRoot, workspace: workDir, env: {} },
      { scope: "journal", id: "t1" },
      "",
    );
    expect(res.isError).toBeFalsy();
    expect(payloadOf(res)["text"]).toContain("搬迁后的 journal");
    const tail = await readTaskJournalTail(linkedRoot, "t1");
    expect(tail.status).toBe("ok");
  });
});
