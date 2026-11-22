/**
 * v0.9.8（D6/V097-16 + D5/V097-15）定向测试：SessionStart 基记录的
 * **读旧→合并→写** 与 **registry 锁内的读-改-写**。
 *
 * 缺陷形态：
 * - D6：钩子用字段白名单**整记录重建**基记录——`startedAt` 每次 SessionStart 重置；
 *   本回合载荷没有 permission_mode 时键被丢掉（档类真源抹成未知）；白名单外字段
 *   （其他写入面/未来扩展留下的）整记录重建即消失。
 * - D5：xc_identify 的基记录盖章（mcp/identity.ts，withRegistryThenTeamLocks 内的
 *   合并写）与钩子的整记录重写**互不设锁**——并发时 identify 盖的 boundName/pid 可被
 *   钩子整记录覆盖，钩子写的 permissionMode/startedAt 也可被 identify 的旧底稿盖回。
 *
 * 本文件覆盖（writeSessionPeerBaseRecord，hooks/session-start.ts）：
 * 1. 首次写入：缺记录 → 全字段落盘（startedAt=now）；
 * 2. D6 锚点：二次写入、载荷无 permissionMode → 旧档类保留、startedAt 保留首次值、
 *    lastSeen 刷新、白名单外字段原样带回；
 * 3. D6 锚点：pid/regToken 缺省保留旧值、有值刷新；
 * 4. D5 锚点：registry 锁内读-改-写——持锁期间 identify 式合并写先落盘，钩子写入
 *    后**不覆盖**对方的 boundName（旧无锁实现在此互相抹字段）；
 * 5. D5 锚点：锁忙 → 重试一次后成功（等待释放方干完）；
 * 6. 非锁错误（peerRoot 不可写）→ 审计后放弃、不抛（钩子永不失败）；
 * 7. core/peerdir.ts 的 upsertPeerBaseRecord 直测：坏旧记录 → 重建不抛；startedAt
 *    非数字的旧记录 → 以 now 兜底（不把垃圾当首次时刻）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// session-start.js 模块加载即自启钩子（guarded）；readStdinPayload 会阻塞读 stdin
//（vitest 下永不闭合）——与 session-start-v096-r2.test.ts 同款：先 mock 再导入。
vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    readStdinPayload: vi.fn(() => undefined),
    resolveHookContext: vi.fn(() => ({ workspace: "", stateRoot: "", sessionId: undefined, event: "SessionStart" })),
    emitAdditionalContext: vi.fn(),
    logHookEvent: vi.fn(async () => {}),
    auditHookFailure: vi.fn(async () => {}),
  };
});

import { writeSessionPeerBaseRecord } from "./session-start.js";
import {
  peerBaseFile,
  readPeerBaseRecord,
  readPeerBaseRecordRaw,
  upsertPeerBaseRecord,
} from "../core/peerdir.js";
import { acquireFileLock } from "../core/lock.js";
import { registryLockNames } from "../core/paths.js";

const dirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

/** 手写一份基记录（模拟其他写入面/外部留下的形状，含白名单外字段）。 */
function plantBaseRecord(peerRoot: string, sessionId: string, record: Record<string, unknown>): void {
  mkdirSync(join(peerRoot, "base"), { recursive: true });
  writeFileSync(peerBaseFile(peerRoot, sessionId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

describe("v0.9.8 D6：读旧→合并→写（白名单重建失真修复）", () => {
  it("【D6 锚点】载荷无 permissionMode + 旧记录有 → 档类键保留、startedAt 不重置、lastSeen 刷新", async () => {
    const stateRoot = freshDir("xc-v098-d6-st-");
    const peerRoot = freshDir("xc-v098-d6-peer-");
    const sid = "sess-hook-1";
    plantBaseRecord(peerRoot, sid, {
      sessionId: sid,
      cwd: "D:\\old-ws",
      permissionMode: "bypass",
      source: "vscode",
      startedAt: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000,
      regToken: "tok-old",
      boundName: "b",
      pid: 4242,
    });
    await writeSessionPeerBaseRecord({
      stateRoot,
      peerRoot,
      sessionId: sid,
      workspace: "D:\\new-ws",
      permissionMode: undefined, // 本回合载荷没给档类（resume/无 permission_mode 形态）
      source: "cli",
      regToken: undefined,
      pid: undefined,
      now: 1_700_000_999_000,
    });
    const after = (await readPeerBaseRecordRaw(peerRoot, sid))!;
    expect(after["permissionMode"]).toBe("bypass"); // 键不丢（旧实现此处被抹成未知）
    expect(after["startedAt"]).toBe(1_700_000_000_000); // 只认首次（旧实现重置为 now）
    expect(after["lastSeen"]).toBe(1_700_000_999_000); // 活性照常刷新
    expect(after["cwd"]).toBe("D:\\new-ws"); // 本回合事实为准
    expect(after["source"]).toBe("cli");
    expect(after["regToken"]).toBe("tok-old"); // 缺省保留旧值
    expect(after["boundName"]).toBe("b"); // identify 盖的绑定标记保留
    expect(after["pid"]).toBe(4242); // A1 的 pid 证据保留
  });

  it("【D6 锚点】白名单外字段原样保留（整记录重建会把它们抹掉）", async () => {
    const stateRoot = freshDir("xc-v098-d6-st-");
    const peerRoot = freshDir("xc-v098-d6-peer-");
    const sid = "sess-hook-2";
    plantBaseRecord(peerRoot, sid, {
      sessionId: sid,
      cwd: "D:\\ws",
      source: null,
      startedAt: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000,
      futureField: "keep-me",
      nested: { a: 1, b: [2, 3] },
    });
    await writeSessionPeerBaseRecord({
      stateRoot,
      peerRoot,
      sessionId: sid,
      workspace: "D:\\ws",
      permissionMode: "prompting",
      source: null,
      regToken: "tok-new",
      pid: 777,
      now: 1_700_000_500_000,
    });
    const after = (await readPeerBaseRecordRaw(peerRoot, sid))!;
    expect(after["futureField"]).toBe("keep-me");
    expect(after["nested"]).toEqual({ a: 1, b: [2, 3] });
    expect(after["permissionMode"]).toBe("prompting"); // 本回合有值即刷新
    expect(after["regToken"]).toBe("tok-new");
    expect(after["pid"]).toBe(777);
    expect(after["startedAt"]).toBe(1_700_000_000_000);
  });

  it("首次写入（无旧记录）→ 全字段落盘，startedAt=now，无 permissionMode 时不落该键", async () => {
    const stateRoot = freshDir("xc-v098-d6-st-");
    const peerRoot = freshDir("xc-v098-d6-peer-");
    await writeSessionPeerBaseRecord({
      stateRoot,
      peerRoot,
      sessionId: "sess-hook-3",
      workspace: "D:\\ws",
      permissionMode: undefined,
      source: "cli",
      regToken: "tok-1",
      pid: 99,
      now: 1_700_000_000_000,
    });
    const after = (await readPeerBaseRecordRaw(peerRoot, "sess-hook-3"))!;
    expect(after).toEqual({
      sessionId: "sess-hook-3",
      cwd: "D:\\ws",
      source: "cli",
      startedAt: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000,
      regToken: "tok-1",
      pid: 99,
    });
    expect("permissionMode" in after).toBe(false); // 新旧都没有 → 不落键（fail-closed 语义不变）
  });
});

describe("v0.9.8 D5：读-改-写进 registry 锁（与 identify 合并写互不覆盖）", () => {
  it("【D5 锚点】持锁期间 identify 式合并写先落盘 → 钩子写入后 boundName 不被抹回", async () => {
    const stateRoot = freshDir("xc-v098-d5-st-");
    const peerRoot = freshDir("xc-v098-d5-peer-");
    const sid = "sess-hook-4";
    plantBaseRecord(peerRoot, sid, {
      sessionId: sid,
      cwd: "D:\\ws",
      source: null,
      startedAt: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000,
      boundName: "old-name",
    });
    // 测试进程直接持**文件锁**（不走进程内 promise 链，避免自锁）——模拟 identify
    // 正持 registry 锁做合并写的窗口。
    const names = registryLockNames(stateRoot);
    const held = await acquireFileLock(stateRoot, names.file);
    try {
      // 钩子写入在锁外等待（旧无锁实现会在此窗口内已读完旧记录）。
      const hookWrite = writeSessionPeerBaseRecord({
        stateRoot,
        peerRoot,
        sessionId: sid,
        workspace: "D:\\ws",
        permissionMode: "bypass",
        source: null,
        regToken: undefined,
        pid: undefined,
        now: 1_700_000_700_000,
      });
      // 让位一拍确保钩子侧的锁等待已排上（事件循环单拍，钩子在 acquire 上挂起）。
      await new Promise((resolve) => setTimeout(resolve, 30));
      // identify 的合并写（identity.ts 同形：读旧→合并→写）在锁内落地。
      const base = await readPeerBaseRecordRaw(peerRoot, sid);
      await upsertPeerBaseRecord(peerRoot, sid, {
        cwd: base!["cwd"] as string,
        source: (base!["source"] as string | null) ?? null,
        now: 1_700_000_800_000,
        boundName: "new-name",
        pid: 555,
      });
      await held.release();
      await hookWrite; // 钩子拿到锁后读到的已是 identify 写后的记录
    } finally {
      try {
        await held.release();
      } catch {
        /* 已释放 */
      }
    }
    const after = (await readPeerBaseRecordRaw(peerRoot, sid))!;
    // 关键：identify 盖的 boundName/pid 存活（钩子的合并以锁内新读为底稿）；
    // 旧无锁实现在此窗口会把 boundName 抹回 "old-name"。
    expect(after["boundName"]).toBe("new-name");
    expect(after["pid"]).toBe(555);
    expect(after["permissionMode"]).toBe("bypass"); // 钩子的档类也落住了
    expect(after["startedAt"]).toBe(1_700_000_000_000); // 全程未被重置
  }, 15_000);

  it("【D5 锚点】锁忙超预算 → 重试一次；等待期间释放则第二次成功（总预算 2×2s）", async () => {
    const stateRoot = freshDir("xc-v098-d5-st-");
    const peerRoot = freshDir("xc-v098-d5-peer-");
    const names = registryLockNames(stateRoot);
    const held = await acquireFileLock(stateRoot, names.file);
    const started = Date.now();
    // 持有 2.3s（> 钩子单次 2s 预算）后释放：第一次尝试 busy → 重试 → 第二次拿到。
    setTimeout(() => {
      void held.release();
    }, 2_300);
    await writeSessionPeerBaseRecord({
      stateRoot,
      peerRoot,
      sessionId: "sess-hook-5",
      workspace: "D:\\ws",
      permissionMode: "bypass",
      source: null,
      regToken: "tok-5",
      pid: undefined,
      now: Date.now(),
    });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(2_000); // 确系等过第一次预算
    const after = (await readPeerBaseRecordRaw(peerRoot, "sess-hook-5"))!;
    expect(after["permissionMode"]).toBe("bypass");
    expect(after["regToken"]).toBe("tok-5");
  }, 20_000);

  it("非锁错误（peerRoot 不可写）→ 审计后放弃、不抛（钩子永不失败）", async () => {
    const stateRoot = freshDir("xc-v098-d5-st-");
    // peerRoot 指向一个**文件**（其下建不了 base/ 目录）→ 写基记录必然失败。
    const peerRootAsFile = join(freshDir("xc-v098-d5-st-"), "not-a-dir");
    writeFileSync(peerRootAsFile, "x\n", "utf8");
    const { auditHookFailure } = await import("./shared.js");
    await expect(
      writeSessionPeerBaseRecord({
        stateRoot,
        peerRoot: peerRootAsFile,
        sessionId: "sess-hook-6",
        workspace: "D:\\ws",
        permissionMode: "bypass",
        source: null,
        regToken: undefined,
        pid: undefined,
        now: Date.now(),
      }),
    ).resolves.toBeUndefined();
    expect(auditHookFailure).toHaveBeenCalledWith(
      stateRoot,
      "session-start-peer-base",
      expect.anything(),
    );
  });
});

describe("v0.9.8 D6：core/peerdir.ts upsertPeerBaseRecord 直测", () => {
  it("坏旧记录（不可解析 JSON）→ 不抛、按首次写入重建", async () => {
    const peerRoot = freshDir("xc-v098-d6-peer-");
    const sid = "sess-hook-7";
    mkdirSync(join(peerRoot, "base"), { recursive: true });
    writeFileSync(peerBaseFile(peerRoot, sid), "{not json", "utf8");
    const merged = await upsertPeerBaseRecord(peerRoot, sid, {
      cwd: "D:\\ws",
      permissionMode: "bypass",
      source: null,
      now: 1_700_000_000_000,
    });
    expect(merged["startedAt"]).toBe(1_700_000_000_000);
    expect(await readPeerBaseRecord(peerRoot, sid)).toMatchObject({ sessionId: sid, permissionMode: "bypass" });
  });

  it("旧记录 startedAt 非数字（脏数据）→ 不以垃圾当首次时刻，落 now 兜底", async () => {
    const peerRoot = freshDir("xc-v098-d6-peer-");
    const sid = "sess-hook-8";
    plantBaseRecord(peerRoot, sid, {
      sessionId: sid,
      cwd: "D:\\ws",
      source: null,
      startedAt: "not-a-number",
      lastSeen: 1,
    });
    const merged = await upsertPeerBaseRecord(peerRoot, sid, {
      cwd: "D:\\ws",
      source: null,
      now: 1_700_000_000_000,
    });
    expect(merged["startedAt"]).toBe(1_700_000_000_000);
  });
});
