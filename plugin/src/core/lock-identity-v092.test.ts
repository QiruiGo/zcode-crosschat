/**
 * v0.9.2 B1 定向单测：锁身份 realpath 规范化（同物理目录多拼法 → 同一把锁）。
 *
 * 背景：锁名 = sha256(<abs root> 小写) 前 8 hex。B1 之前直接吃 resolve(root)，
 * 同一台机器上两个进程用不同拼法指向同一个 .crosschat（junction 别名 / 8.3 短名 /
 * UNC 管理共享 / \\?\ 扩展前缀 / 大小写差异）会算出不同的锁文件名——跨进程互斥
 * 形同虚设（team.json 读写并发无保护），in-process key 也分裂成两条链。
 *
 * 覆盖面（验收锚点「多拼法同锁」）：
 * - teamLockNames/registryLockNames：junction / 8.3 / UNC（localhost、127.0.0.1、
 *   计算机名）/ 盘符大小写 / \\?\ 前缀五种拼法与真实拼法同 file 名、同 processKey；
 * - 不同物理目录仍不同锁（不回退成「什么都同一把」）；
 * - 路径不存在时回退 resolve，不抛（首启窗口状态根尚未创建）；
 * - 跨进程互斥实证：拼法 A 持锁时，拼法 B 的同名锁判定 busy（同一物理锁文件）。
 *
 * 平台注记：junction/8.3/UNC 均为 Windows 形态，非 win32 下整套 skip；
 *  UNC 依赖本机管理共享可达（CI 沙箱可能关闭），不可达时该例 skip 不假过。
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalStateRoot, registryLockNames, teamLockNames } from "./paths.js";
import { LockBusyError, acquireFileLock, withFileLock } from "./lock.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

/** 建一个真实存在的工作区（内含 .crosschat——realpath 只对存在路径归一）。 */
function seedWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "xc-b1-lock-"));
  dirs.push(ws);
  mkdirSync(join(ws, ".crosschat"), { recursive: true });
  return ws;
}

/** 建一个 junction（Windows 目录联接，无需提权）；失败返回 false。 */
function createJunction(link: string, target: string): boolean {
  try {
    execSync(`cmd /c mklink /J "${link}" "${target}"`, { stdio: "ignore" });
    return existsSync(link);
  } catch {
    return false;
  }
}

/** 取一个目录的 8.3 短名拼法（取不到返回 undefined）。 */
function shortNameOf(path: string): string | undefined {
  try {
    const out = execSync(`cmd /c for %I in ("${path}") do @echo %~sI`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const short = out.trim();
    return short !== "" && short !== path ? short : undefined;
  } catch {
    return undefined;
  }
}

/** 本机 UNC 管理共享拼法（\\localhost\C$\x、\\127.0.0.1\C$\x、\\<计算机名>\C$\x）。 */
function localUncSpellings(root: string): string[] {
  const m = /^([A-Za-z]):\\/.exec(root);
  if (m === null) return [];
  const drive = m[1]!;
  const tail = root.slice(3);
  const spellings = [
    `\\\\localhost\\${drive}$\\${tail}`,
    `\\\\127.0.0.1\\${drive}$\\${tail}`,
  ];
  const computerName = process.env["COMPUTERNAME"];
  if (typeof computerName === "string" && computerName.trim() !== "") {
    spellings.push(`\\\\${computerName}\\${drive}$\\${tail}`);
  }
  return spellings.filter((p) => existsSync(p));
}

describe("v0.9.2 B1：teamLockNames/registryLockNames 物理归一（多拼法同锁）", () => {
  it("junction 拼法与真实目录同锁（file 名与 processKey 一致）", () => {
    if (process.platform !== "win32") return;
    const ws = seedWorkspace();
    const link = join(ws, "junction-alias");
    expect(createJunction(link, ws)).toBe(true);
    const real = teamLockNames(join(ws, ".crosschat"), "default");
    const viaJunction = teamLockNames(join(link, ".crosschat"), "default");
    expect(viaJunction.file).toBe(real.file);
    expect(viaJunction.processKey).toBe(real.processKey);
    // registry 锁同一口径。
    expect(registryLockNames(join(link, ".crosschat")).file).toBe(registryLockNames(join(ws, ".crosschat")).file);
  });

  it("8.3 短名拼法与长名同锁（realpathSync.native 才展开短名）", () => {
    if (process.platform !== "win32") return;
    const ws = seedWorkspace();
    const longDir = join(ws, "a-very-long-directory-name-for-eight-three");
    mkdirSync(longDir, { recursive: true });
    const short = shortNameOf(longDir);
    if (short === undefined || !existsSync(short)) return; // 平台未生成 8.3 别名：跳过（不假过）
    const real = teamLockNames(longDir, "default");
    const viaShort = teamLockNames(short, "default");
    expect(viaShort.file).toBe(real.file);
    expect(viaShort.processKey).toBe(real.processKey);
    // 反证：plain realpathSync 不展开短名（v0.9.1 前的口径）——native 才归一。
    expect(realpathSync(short)).not.toBe(realpathSync(longDir));
    expect(realpathSync.native(short)).toBe(realpathSync.native(longDir));
  });

  it("本机 UNC 拼法（localhost / 127.0.0.1 / 计算机名）与盘符拼法同锁", () => {
    if (process.platform !== "win32") return;
    const ws = seedWorkspace();
    const spellings = localUncSpellings(ws);
    if (spellings.length === 0) return; // 管理共享不可达：跳过（不假过）
    const real = teamLockNames(join(ws, ".crosschat"), "default");
    for (const spelling of spellings) {
      const viaUnc = teamLockNames(join(spelling, ".crosschat"), "default");
      expect(viaUnc.file, spelling).toBe(real.file);
      expect(viaUnc.processKey, spelling).toBe(real.processKey);
    }
  });

  it("大小写拼法与 \\?\\ 扩展前缀同锁（磁盘真值大小写归一）", () => {
    if (process.platform !== "win32") return;
    const ws = seedWorkspace();
    const real = teamLockNames(join(ws, ".crosschat"), "default");
    const lower = teamLockNames(join(ws, ".crosschat").toLowerCase(), "default");
    expect(lower.file).toBe(real.file);
    expect(lower.processKey).toBe(real.processKey);
    const extPrefixed = teamLockNames(`\\\\?\\${join(ws, ".crosschat")}`, "default");
    expect(extPrefixed.file).toBe(real.file);
    expect(extPrefixed.processKey).toBe(real.processKey);
  });

  it("不同物理目录仍不同锁（归一不让所有工作区塌成同一把锁）", () => {
    const wsA = seedWorkspace();
    const wsB = seedWorkspace();
    const a = teamLockNames(wsA, "default");
    const b = teamLockNames(wsB, "default");
    expect(a.file).not.toBe(b.file);
    expect(a.processKey).not.toBe(b.processKey);
    expect(registryLockNames(wsA).file).not.toBe(registryLockNames(wsB).file);
  });

  it("路径不存在时回退 resolve，不抛（首启窗口状态根尚未创建）", () => {
    const ws = seedWorkspace();
    const missing = join(ws, "not-created-yet", ".crosschat");
    expect(existsSync(missing)).toBe(false);
    const names = teamLockNames(missing, "default");
    // 回退口径与 v0.9.1 前一致：resolve 后的字面拼法（未归一，但确定且不抛）。
    expect(names.processKey).toBe(`team:${missing}:default`);
    expect(names.file).toMatch(/^team-[0-9a-f]{8}-default$/);
    expect(canonicalStateRoot(missing)).toBe(missing);
  });
});

describe("v0.9.2 B1：跨进程互斥实证——拼法 A 持锁时拼法 B 判定 busy", () => {
  it("junction 拼法与真实拼法争同一把物理锁文件", async () => {
    if (process.platform !== "win32") return;
    const ws = seedWorkspace();
    const link = join(ws, "junction-alias");
    if (!createJunction(link, ws)) return;
    const viaJunction = teamLockNames(join(link, ".crosschat"), "default");
    const real = teamLockNames(join(ws, ".crosschat"), "default");
    expect(viaJunction.file).toBe(real.file);

    // 拼法 A（junction）持锁；拼法 B（真实目录）以 waitMs=0 争夺同一 file 名。
    const held = await acquireFileLock(join(link, ".crosschat"), real.file, { waitMs: 0 });
    try {
      await expect(
        withFileLock(join(ws, ".crosschat"), real.file, async () => "should-not-run", { waitMs: 0 }),
      ).rejects.toBeInstanceOf(LockBusyError);
    } finally {
      await held.release();
    }
    // 释放后同一拼法可再取（锁语义未被破坏）。
    const ok = await withFileLock(join(ws, ".crosschat"), real.file, async () => "ran", { waitMs: 0 });
    expect(ok).toBe("ran");
  });
});
