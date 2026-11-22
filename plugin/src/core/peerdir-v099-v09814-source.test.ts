/**
 * v0.9.9（组 H）定向测试：**V098-14（P3）upsertPeerBaseRecord 对 source 无条件覆盖**。
 *
 * 缺陷形态（adv-3 case8 Part A）：合并写对 `source` 用 `patch.source` 无条件落盘——钩子主
 * 写面的载荷常常不带来源（`stdin.str('source') ?? null`），一个不带 source 的钩子回合就把
 * identify 等其他写面盖的 source 抹成 null（字段级失真，无安全影响，但 fix-p 未披露）。
 *
 * 修法与覆盖（任务书：「改为 patch.source ?? base.source 保留」；验收：「钩子无 source
 * 载荷不抹既有值」）：
 *   1. 本回合带了来源（非空串）→ 以本回合事实刷新（既有能力不回归）；
 *   2. 本回合没带（undefined/null/空串）→ **保留旧值**；新旧都没有才落 null（未知来源
 *      语义不变）；
 *   3. 经钩子写面（writeSessionPeerBaseRecord）端到端复现 case8 Part A 原形；
 *   4. 其余合并口径（startedAt 只认首次 / permissionMode 缺省保留 / 白名单外字段保留）
 *      逐字节不回归。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  peerBaseFile,
  readPeerBaseRecordRaw,
  upsertPeerBaseRecord,
} from "./peerdir.js";

// session-start.ts 模块加载即自启钩子（读 stdin）——mock 掉 shared.js 的发射面/上下文面
// 让其导入零副作用（session-start-v094-a6.test.ts 同款纪律）。
vi.mock("../hooks/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/shared.js")>();
  return {
    ...actual,
    readStdinPayload: vi.fn(() => undefined),
    resolveHookContext: vi.fn(() => ({
      workspace: "", stateRoot: "", sessionId: undefined, event: "SessionStart",
    })),
    emitAdditionalContext: vi.fn(),
    logHookEvent: vi.fn(async () => {}),
    auditHookFailure: vi.fn(async () => {}),
    peerRootFromEnv: vi.fn(() => ""),
    readHookPermissionMode: vi.fn(() => undefined),
  };
});

const { writeSessionPeerBaseRecord } = await import("../hooks/session-start.js");

const dirs: string[] = [];

beforeEach(() => {
  dirs.length = 0;
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

function freshPeerRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "xc-v099-h14-peers-"));
  dirs.push(dir);
  return dir;
}

function freshStateRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "xc-v099-h14-st-"));
  dirs.push(dir);
  return dir;
}

/** 手写一份既有基记录（模拟 identify 等其他写面盖过的形状）。 */
function plantBaseRecord(peerRoot: string, sessionId: string, record: Record<string, unknown>): void {
  mkdirSync(join(peerRoot, "base"), { recursive: true });
  writeFileSync(peerBaseFile(peerRoot, sessionId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

const NOW = 1_700_000_999_000;

describe("v0.9.9 V098-14：upsertPeerBaseRecord 的 source 保留（钩子无 source 载荷不抹既有值）", () => {
  it("【验收锚点】旧记录有 source + 本回合载荷没给（null）→ 保留旧值", async () => {
    const peerRoot = freshPeerRoot();
    plantBaseRecord(peerRoot, "s1", {
      sessionId: "s1", cwd: "D:\\ws", source: "vscode", startedAt: 1_700_000_000_000, lastSeen: 1_700_000_000_000,
    });
    const merged = await upsertPeerBaseRecord(peerRoot, "s1", { cwd: "D:\\ws", source: null, now: NOW });
    expect(merged["source"]).toBe("vscode"); // 旧实现此处被抹成 null
    expect((await readPeerBaseRecordRaw(peerRoot, "s1"))!["source"]).toBe("vscode");
  });

  it("【验收锚点】旧记录有 source + 本回合载荷没给（undefined）→ 保留旧值", async () => {
    const peerRoot = freshPeerRoot();
    plantBaseRecord(peerRoot, "s2", {
      sessionId: "s2", cwd: "D:\\ws", source: "cli", startedAt: 1_700_000_000_000, lastSeen: 1_700_000_000_000,
    });
    const merged = await upsertPeerBaseRecord(peerRoot, "s2", { cwd: "D:\\ws", now: NOW });
    expect(merged["source"]).toBe("cli");
  });

  it("【能力不回归】本回合带了来源（非空串）→ 以本回合事实刷新", async () => {
    const peerRoot = freshPeerRoot();
    plantBaseRecord(peerRoot, "s3", {
      sessionId: "s3", cwd: "D:\\ws", source: "vscode", startedAt: 1_700_000_000_000, lastSeen: 1_700_000_000_000,
    });
    const merged = await upsertPeerBaseRecord(peerRoot, "s3", { cwd: "D:\\ws", source: "cli", now: NOW });
    expect(merged["source"]).toBe("cli");
  });

  it("【边界】新旧都没有 source → 落 null（未知来源语义不变）；空串按「没给」处理", async () => {
    const peerRoot = freshPeerRoot();
    const first = await upsertPeerBaseRecord(peerRoot, "s4", { cwd: "D:\\ws", source: null, now: NOW });
    expect(first["source"]).toBeNull();

    plantBaseRecord(peerRoot, "s5", {
      sessionId: "s5", cwd: "D:\\ws", source: "vscode", startedAt: 1_700_000_000_000, lastSeen: 1_700_000_000_000,
    });
    const kept = await upsertPeerBaseRecord(peerRoot, "s5", { cwd: "D:\\ws", source: "", now: NOW });
    expect(kept["source"]).toBe("vscode"); // 空串不是来源事实
  });

  it("【边界】旧记录的 source 是非串脏数据 → 不当真值保留（落 null，不把垃圾当事实）", async () => {
    const peerRoot = freshPeerRoot();
    plantBaseRecord(peerRoot, "s6", {
      sessionId: "s6", cwd: "D:\\ws", source: 42, startedAt: 1_700_000_000_000, lastSeen: 1_700_000_000_000,
    });
    const merged = await upsertPeerBaseRecord(peerRoot, "s6", { cwd: "D:\\ws", source: null, now: NOW });
    expect(merged["source"]).toBeNull();
  });

  it("【钩子写面·端到端】adv-3 case8 Part A 原形：不带 source 的钩子回合不抹 identify 盖的 source", async () => {
    const peerRoot = freshPeerRoot();
    const stateRoot = freshStateRoot();
    plantBaseRecord(peerRoot, "s7", {
      sessionId: "s7", cwd: "D:\\old", source: "vscode", startedAt: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000, permissionMode: "bypass", regToken: "tok-old", boundName: "b", pid: 4242,
      futureField: "keep-me",
    });
    await writeSessionPeerBaseRecord({
      stateRoot,
      peerRoot,
      sessionId: "s7",
      workspace: "D:\\new",
      permissionMode: undefined, // 载荷没给档类
      source: null, // 载荷没给来源（stdin.str('source') ?? null 的常态）
      regToken: undefined,
      pid: undefined,
      now: NOW,
    });
    const after = (await readPeerBaseRecordRaw(peerRoot, "s7"))!;
    expect(after["source"]).toBe("vscode"); // 不被抹成 null
    // 其余合并口径逐字节不回归（D6/D5 的判据原地成立）。
    expect(after["permissionMode"]).toBe("bypass");
    expect(after["startedAt"]).toBe(1_700_000_000_000);
    expect(after["lastSeen"]).toBe(NOW);
    expect(after["regToken"]).toBe("tok-old");
    expect(after["boundName"]).toBe("b");
    expect(after["pid"]).toBe(4242);
    expect(after["futureField"]).toBe("keep-me");
    expect(after["cwd"]).toBe("D:\\new");
  });

  it("【钩子写面·能力不回归】钩子载荷带了来源 → 照常刷新", async () => {
    const peerRoot = freshPeerRoot();
    const stateRoot = freshStateRoot();
    plantBaseRecord(peerRoot, "s8", {
      sessionId: "s8", cwd: "D:\\ws", source: "vscode", startedAt: 1_700_000_000_000, lastSeen: 1_700_000_000_000,
    });
    await writeSessionPeerBaseRecord({
      stateRoot,
      peerRoot,
      sessionId: "s8",
      workspace: "D:\\ws",
      permissionMode: "prompting",
      source: "cli",
      regToken: "tok-new",
      pid: 99,
      now: NOW,
    });
    const after = (await readPeerBaseRecordRaw(peerRoot, "s8"))!;
    expect(after["source"]).toBe("cli");
    expect(after["permissionMode"]).toBe("prompting");
    expect(after["regToken"]).toBe("tok-new");
    expect(after["pid"]).toBe(99);
  });
});
