/**
 * 证据门防回归单测（边界与-3 / 边界与-4 / 安全对-1 修复，v0.5.1）：
 * completed 证据门此前只校验「至少一条」不查内容——不存在的文件被接受且 sha256:null
 * 落库、伪造 sha256 原样入库并随回执分发。修复后逐条现算复核：
 * - 文件缺失/不可读 → evidence_file_missing（整单拒绝，真源不动、回执不发）；
 * - 声明 sha256 与现算不符 → evidence_checksum_mismatch；
 * - 缺省/显式 null → 工具现算落库（不再落 null，兑现工具描述承诺）；
 * - 正确声明值 → 通过。
 * 红队复现（adjudication #3/#4/#17，case-evi.mjs）：注册 a/b → dispatch → claim →
 * in_progress → xc_report{completed, evidence:[不存在文件]} 原收 completed——本组用例
 * 即该序列的可自动化断言。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { payloadOf } from "./protocol.js";
import { createToolCore, type ToolCore, type ToolDeps } from "./tools.js";
import { readMailbox } from "../core/mailbox.js";
import { readTeam } from "../core/teamstate.js";
import { writeSession } from "../core/registry.js";

const dirs: string[] = [];
let workDir: string;
let stateRoot: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "xc-evi-"));
  dirs.push(workDir);
  stateRoot = join(workDir, ".crosschat");
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

function makeCore(): ToolCore {
  const deps: ToolDeps = { stateRoot, workspace: workDir, env: {} };
  return createToolCore(deps);
}

function unwrap(result: ReturnType<typeof payloadOf>): Record<string, unknown> {
  expect(result["error"], JSON.stringify(result)).toBeUndefined();
  return result;
}

async function seedClaimedTask(core: ToolCore): Promise<{ taskId: string; attemptId: string; conn: string }> {
  await writeSessionAnchor();
  expect(payloadOf(await core.xc_register({ name: "a", sessionId: "sess-a" }, "conn-a")).error).toBeUndefined();
  expect(payloadOf(await core.xc_register({ name: "b", sessionId: "sess-b" }, "conn-b")).error).toBeUndefined();
  // taskId 取自 dispatch 回执（v0.5.1 故障注-5 修复后为 <era>-t<n> 形态，不硬编码 t1）。
  const dispatched = unwrap(payloadOf(await core.xc_dispatch({ to: "b", title: "算", prompt: "写结果到 result.txt" }, "conn-a")));
  const taskId = dispatched["taskId"] as string;
  const claim = unwrap(payloadOf(await core.xc_claim({ taskId }, "conn-b")));
  expect(payloadOf(await core.xc_report({ taskId, attemptId: claim["attemptId"] as string, status: "in_progress" }, "conn-b")).error).toBeUndefined();
  return { taskId, attemptId: claim["attemptId"] as string, conn: "conn-b" };
}

async function writeSessionAnchor(): Promise<void> {
  await writeSession(stateRoot, { sessionId: "sess-a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
  await writeSession(stateRoot, { sessionId: "sess-b", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
}

function writeEvidenceFile(name: string, content = "391\n"): string {
  const p = join(workDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function taskOf(taskId: string): Promise<Record<string, unknown>> {
  const team = await readTeam(stateRoot, "default");
  expect(team).toBeDefined();
  return team!.tasks.find((t) => t.id === taskId) as unknown as Record<string, unknown>;
}

describe("证据门（completed 报告）", () => {
  it("红队 #3 回归：不存在文件的证据被拒（evidence_file_missing），真源不动、回执不发", async () => {
    const core = makeCore();
    const { taskId, attemptId, conn } = await seedClaimedTask(core);
    const ghost = join(workDir, "no-such-file.txt");
    expect(existsSync(ghost)).toBe(false);

    const res = await core.xc_report(
      { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: ghost }] },
      conn,
    );
    expect(res.isError).toBe(true);
    const payload = payloadOf(res);
    expect(payload["error"]).toBe("evidence_file_missing");
    expect(payload["path"]).toBe(ghost);

    // 真源：任务保持 in_progress，未被推进到 completed，伪证据未落库。
    const task = await taskOf(taskId);
    expect(task["status"]).toBe("in_progress");
    expect(task["evidence"]).toEqual([]);

    // 派发方 a 无回执（终态回执只随成功 report 发出）。
    const box = await readMailbox(stateRoot, "default", "a");
    expect(box.filter((m) => m.content.includes('"task-receipt"'))).toHaveLength(0);
  });

  it("红队 #4 回归：伪造 sha256 与现算不符被拒（evidence_checksum_mismatch）", async () => {
    const core = makeCore();
    const { taskId, attemptId, conn } = await seedClaimedTask(core);
    const forged = writeEvidenceFile("forged.txt", "real content");
    const realSha = sha256Of(forged);
    const fake = "deadbeef" + "0".repeat(56);
    expect(fake).not.toBe(realSha);

    const res = await core.xc_report(
      { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: forged, sha256: fake, note: "forged checksum" }] },
      conn,
    );
    expect(res.isError).toBe(true);
    const payload = payloadOf(res);
    expect(payload["error"]).toBe("evidence_checksum_mismatch");
    expect(payload["claimed"]).toBe(fake);
    expect(payload["computed"]).toBe(realSha);

    const task = await taskOf(taskId);
    expect(task["status"]).toBe("in_progress");
  });

  it("正确声明的 sha256 通过；缺省/显式 null 均落现算值（不再落 null）", async () => {
    const core = makeCore();

    // 第一单：正确声明值 → 通过，落库值 == 现算值。
    const { taskId, attemptId, conn } = await seedClaimedTask(core);
    const ok = writeEvidenceFile("result.txt", "391");
    const res = unwrap(payloadOf(await core.xc_report(
      { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: ok, sha256: sha256Of(ok) }] },
      conn,
    )));
    expect(res["status"]).toBe("completed");
    const task = await taskOf(taskId);
    expect((task["evidence"] as Array<Record<string, unknown>>)[0]!["sha256"]).toBe(sha256Of(ok));

    // 第二单：缺省 sha256 → 现算。
    const t2 = unwrap(payloadOf(await core.xc_dispatch({ to: "b", title: "再算", prompt: "P" }, "conn-a")))["taskId"] as string;
    const c2 = unwrap(payloadOf(await core.xc_claim({ taskId: t2 }, "conn-b")));
    await core.xc_report({ taskId: t2, attemptId: c2["attemptId"] as string, status: "in_progress" }, "conn-b");
    const ev2 = writeEvidenceFile("result2.txt", "hello");
    unwrap(payloadOf(await core.xc_report(
      { taskId: t2, attemptId: c2["attemptId"] as string, status: "completed", result: "hello", evidence: [{ path: ev2 }] },
      "conn-b",
    )));
    const t2rec = (await readTeam(stateRoot, "default"))!.tasks.find((t) => t.id === t2)!;
    expect(t2rec.evidence![0]!.sha256).toBe(sha256Of(ev2));

    // 第三单：显式 sha256:null → 同缺省，现算（修复前原样落 null）。
    const t3 = unwrap(payloadOf(await core.xc_dispatch({ to: "b", title: "三算", prompt: "P" }, "conn-a")))["taskId"] as string;
    const c3 = unwrap(payloadOf(await core.xc_claim({ taskId: t3 }, "conn-b")));
    await core.xc_report({ taskId: t3, attemptId: c3["attemptId"] as string, status: "in_progress" }, "conn-b");
    const ev3 = writeEvidenceFile("result3.txt", "world");
    unwrap(payloadOf(await core.xc_report(
      { taskId: t3, attemptId: c3["attemptId"] as string, status: "completed", result: "world", evidence: [{ path: ev3, sha256: null }] },
      "conn-b",
    )));
    const t3rec = (await readTeam(stateRoot, "default"))!.tasks.find((t) => t.id === t3)!;
    expect(t3rec.evidence![0]!.sha256).toBe(sha256Of(ev3));
  });

  it("证据门适用于一切携带证据的 report（in_progress 带缺失文件同样被拒）", async () => {
    const core = makeCore();
    const { taskId, attemptId, conn } = await seedClaimedTask(core);
    const res = await core.xc_report(
      { taskId, attemptId, status: "in_progress", evidence: [{ path: join(workDir, "absent.txt") }] },
      conn,
    );
    expect(res.isError).toBe(true);
    expect(payloadOf(res)["error"]).toBe("evidence_file_missing");
  });

  it("failed 报告携带真实文件证据 → 正常通过", async () => {
    const core = makeCore();
    const { taskId, attemptId, conn } = await seedClaimedTask(core);
    const ev = writeEvidenceFile("log.txt", "boom");
    const res = await core.xc_report(
      { taskId, attemptId, status: "failed", error: "算不动了", evidence: [{ path: ev }] },
      conn,
    );
    expect(res.isError).toBeFalsy();
  });
});

describe("证据路径工作区遏制（v0.5.2 边界与-R2-5 修复，集成环节补）", () => {
  it("红队 R2-5 回归：../ 穿越到工作区外被拒（evidence_path_outside_workspace），真源不动", async () => {
    const core = makeCore();
    const { taskId, attemptId, conn } = await seedClaimedTask(core);
    const outside = join(workDir, "..", "r2-5-outside-ev.txt");
    writeFileSync(outside, "outside-evidence-content", "utf8");
    try {
      const res = await core.xc_report(
        { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: outside }] },
        conn,
      );
      expect(res.isError).toBe(true);
      const payload = payloadOf(res);
      expect(payload["error"]).toBe("evidence_path_outside_workspace");
      expect(payload["path"]).toBe(outside);
      expect(payload["workspace"]).toBe(workDir);
      // 真源不动：任务仍未完成、无回执发出
      const rec = await taskOf(taskId);
      expect(rec["status"]).not.toBe("completed");
    } finally {
      try { rmSync(outside, { force: true }); } catch { /* 尽力而为 */ }
    }
  });

  it("绝对路径指到工作区外同样被拒；前缀兄弟目录（<ws>-evil）不因共享前缀绕过", async () => {
    const core = makeCore();
    const { taskId, attemptId, conn } = await seedClaimedTask(core);
    const siblingRoot = `${workDir}-evil`;
    const sibling = join(siblingRoot, "sibling-ev.txt");
    mkdirSync(siblingRoot, { recursive: true });
    writeFileSync(sibling, "sibling-content", "utf8");
    try {
      const res = await core.xc_report(
        { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: sibling }] },
        conn,
      );
      expect(res.isError).toBe(true);
      expect(payloadOf(res)["error"]).toBe("evidence_path_outside_workspace");
    } finally {
      try { rmSync(sibling, { force: true }); } catch { /* 尽力而为 */ }
      try { rmSync(siblingRoot, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    }
  });

  it("工作区内文件不受影响（遏制只挡界外）：现有主路径语义不变", async () => {
    const core = makeCore();
    const { taskId, attemptId, conn } = await seedClaimedTask(core);
    const ev = writeEvidenceFile("inside.txt", "inside-content");
    const res = await core.xc_report(
      { taskId, attemptId, status: "completed", result: "391", evidence: [{ path: ev, sha256: sha256Of(ev) }] },
      conn,
    );
    expect(res.isError).toBeFalsy();
    const rec = await taskOf(taskId);
    expect(rec["status"]).toBe("completed");
  });
});
