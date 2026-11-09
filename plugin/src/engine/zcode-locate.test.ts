/**
 * R1 单测：zcode_exe / zcode_cjs 自动探测（zcode-locate.ts，DESIGN-V0.4 §2.3/§5-S2c-②）。
 *
 * 测试策略（复核轮 F2 注入缝）：探测步以 ZcodeProbe 假实现注入，按脚本内容分发返回值，
 * 全部用例零真实 PowerShell 子进程；文件存在性用真实 tmpdir 树构造（测试后清理）。
 * 覆盖：
 * - S2c-② 真全败：八步全败 → guidance===LOCATE_GUIDANCE、attempts 全步留痕；
 * - 命中顺序：process_table → parent_process → registry → common_paths 逐步命中与配对失败回落；
 * - 缓存：成功结果缓存命中零探测、resetLocateCache 复位、失败不缓存；
 * - F4 不变式：env 合法命中不读缓存、不写缓存；env 误配置（文件不存在）被缓存/自动探测救回；
 * - deriveCjsCandidates / pairFromExe / resolveZcodeSpawnConfig 契约。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LOCATE_GUIDANCE,
  deriveCjsCandidates,
  locateZcodePair,
  pairFromExe,
  resetLocateCache,
  resolveZcodeSpawnConfig,
  type ZcodeProbe,
} from "./zcode-locate";

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
beforeEach(() => {
  resetLocateCache();
});
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xc-locate-"));
  dirs.push(d);
  return d;
}

/** 构造一个真实可配对的 zcode 安装树：<root>/ZCode.exe + <root>/resources/<variant>/zcode.cjs。 */
function makeZcodeTree(root: string, variant = "glm"): { exe: string; cjs: string } {
  const exe = join(root, "ZCode.exe");
  const cjs = join(root, "resources", variant, "zcode.cjs");
  mkdirSync(dirname(cjs), { recursive: true });
  writeFileSync(exe, "exe-bytes", "utf8");
  writeFileSync(cjs, "cjs-bytes", "utf8");
  return { exe, cjs };
}

/** 按脚本内容分发的假 probe（记录每次调用；未命中 handler 一律返回空串=该步失败）。 */
function scriptedProbe(
  handlers: { test: (script: string) => boolean; out: string }[] = [],
): { probe: ZcodeProbe; calls: string[] } {
  const calls: string[] = [];
  const probe: ZcodeProbe = (script) => {
    calls.push(script);
    const hit = handlers.find((h) => h.test(script));
    return hit ? hit.out : "";
  };
  return { probe, calls };
}
const isTableScript = (s: string): boolean => /Name='ZCode\.exe'/.test(s);
const isParentScript = (s: string): boolean => /ProcessId=\d+/.test(s);
const isRegistryScript = (s: string): boolean => /Get-ItemProperty/.test(s);
const failAll = (): { probe: ZcodeProbe; calls: string[] } => scriptedProbe([]);

// ─────────────────────────── deriveCjsCandidates ───────────────────────────

describe("deriveCjsCandidates（F5：glm 段优先 + glob 兜底）", () => {
  it("resources 不存在 → 空表", () => {
    expect(deriveCjsCandidates(join(freshDir(), "nope"))).toEqual([]);
  });
  it("glm 目录存在时排第一，其余按名排序", () => {
    const root = freshDir();
    for (const [variant, file] of [
      ["abc", "zcode.cjs"],
      ["glm", "zcode.cjs"],
      ["zeta", "other.cjs"],
    ] as const) {
      mkdirSync(join(root, "resources", variant), { recursive: true });
      writeFileSync(join(root, "resources", variant, file), "cjs", "utf8");
    }
    const got = deriveCjsCandidates(root);
    expect(got.length).toBe(2);
    expect(got[0]).toBe(join(root, "resources", "glm", "zcode.cjs"));
    expect(got[1]).toBe(join(root, "resources", "abc", "zcode.cjs"));
  });
  it("无 glm 时按名排序 glob 兜底（glm 段稳定性未确认的兜底面）", () => {
    const root = freshDir();
    for (const variant of ["beta", "alpha"]) {
      mkdirSync(join(root, "resources", variant), { recursive: true });
      writeFileSync(join(root, "resources", variant, "zcode.cjs"), "cjs", "utf8");
    }
    const got = deriveCjsCandidates(root);
    expect(got).toEqual([
      join(root, "resources", "alpha", "zcode.cjs"),
      join(root, "resources", "beta", "zcode.cjs"),
    ]);
  });
});

// ─────────────────────────── pairFromExe ───────────────────────────

describe("pairFromExe（spawn 需要成对：配不到 cjs 视为未命中）", () => {
  it("exe 不存在 → null", () => {
    expect(pairFromExe(join(freshDir(), "nope", "ZCode.exe"))).toBeNull();
  });
  it("exe 存在但无 resources（配不到 cjs）→ null", () => {
    const root = freshDir();
    writeFileSync(join(root, "ZCode.exe"), "exe", "utf8");
    expect(pairFromExe(join(root, "ZCode.exe"))).toBeNull();
  });
  it("exe + resources/<variant>/zcode.cjs → 配对成功", () => {
    const root = freshDir();
    const { exe, cjs } = makeZcodeTree(root);
    expect(pairFromExe(exe)).toEqual({ exe, cjs });
  });
});

// ─────────────────────────── env 优先（F4 不变式） ───────────────────────────

describe("locateZcodePair：env 判定先于缓存（F4：env 永远可覆盖探测结果）", () => {
  it("env 完整且文件存在 → user_config 直接命中，零探测（probe 调用数为 0）", () => {
    const root = freshDir();
    const { exe, cjs } = makeZcodeTree(root);
    const { probe, calls } = failAll(); // 即使探测器全坏，env 命中也不该被触发
    const got = locateZcodePair({ XC_ZCODE_EXE: exe, XC_ZCODE_CJS: cjs }, probe);
    expect(got).toMatchObject({ found: true, source: "user_config", guidance: "" });
    expect(got.pair).toEqual({ exe, cjs });
    expect(got.attempts[0]).toMatchObject({ step: "env", hit: true });
    expect(calls).toHaveLength(0);
  });
  it("env 合法命中不读缓存：先有探测缓存，再传合法 env → 返回 env 对而非缓存对", () => {
    const treeRoot = freshDir();
    const tree = makeZcodeTree(treeRoot);
    // 第一击：process_table 命中 → 成功缓存建立
    const first = scriptedProbe([{ test: isTableScript, out: tree.exe }]);
    const cached = locateZcodePair({}, first.probe);
    expect(cached.source).toBe("process_table");
    // 第二击：合法 env（与缓存不同的真实文件对）→ 必须用 env 对
    const envRoot = freshDir();
    const envPair = makeZcodeTree(envRoot, "variant");
    const second = scriptedProbe([{ test: isTableScript, out: "SHOULD-NOT-BE-CALLED" }]);
    const got = locateZcodePair(
      { XC_ZCODE_EXE: envPair.exe, XC_ZCODE_CJS: envPair.cjs },
      second.probe,
    );
    expect(got.source).toBe("user_config");
    expect(got.pair).toEqual({ exe: envPair.exe, cjs: envPair.cjs });
    expect(second.calls).toHaveLength(0);
  });
  it("env 合法命中不写缓存：env 调用后，无 env + 全败 probe → 真正全败（不会被 env 调用的结果污染）", () => {
    const root = freshDir();
    const { exe, cjs } = makeZcodeTree(root);
    expect(locateZcodePair({ XC_ZCODE_EXE: exe, XC_ZCODE_CJS: cjs }, failAll().probe).found).toBe(true);
    // 若 env 命中错误地写了缓存，下一步会命中缓存返回 found=true。
    const next = failAll();
    const got = locateZcodePair({}, next.probe);
    expect(got.found).toBe(false);
    expect(got.guidance).toBe(LOCATE_GUIDANCE);
    expect(next.calls.length).toBeGreaterThan(0); // 确实走了全步探测
  });
  it("env 误配置（文件不存在）→ 留痕后继续自动探测，无缓存时真探测（S2c-① 的单元层）", () => {
    const { probe, calls } = failAll();
    const got = locateZcodePair(
      { XC_ZCODE_EXE: join(freshDir(), "nope.exe"), XC_ZCODE_CJS: join(freshDir(), "nope.cjs") },
      probe,
    );
    expect(got.attempts[0]).toMatchObject({ step: "env", hit: false });
    expect(got.attempts[0]!.detail).toContain("已配置但文件不存在（继续自动探测）");
    expect(got.found).toBe(false);
    expect(calls.length).toBeGreaterThanOrEqual(2); // 至少走了进程表+父链两步真探测
  });
});

// ─────────────────────────── 成功缓存与失败不缓存 ───────────────────────────

describe("locateZcodePair：缓存语义（成功缓存 / 失败不缓存 / reset）", () => {
  it("自动探测成功 → 二次无 env 调用命中缓存：零探测、结果一致、本次留痕并入 attempts", () => {
    const root = freshDir();
    const { exe } = makeZcodeTree(root);
    const first = scriptedProbe([{ test: isTableScript, out: exe }]);
    const one = locateZcodePair({}, first.probe);
    expect(one.found).toBe(true);
    const second = scriptedProbe([{ test: isTableScript, out: "SHOULD-NOT-BE-CALLED" }]);
    const two = locateZcodePair({}, second.probe);
    expect(two.found).toBe(true);
    expect(two.source).toBe("process_table");
    expect(two.pair).toEqual(one.pair);
    expect(second.calls).toHaveLength(0);
    expect(two.attempts.some((a) => a.step === "env")).toBe(true);
  });
  it("resetLocateCache 清空成功缓存 → 再次调用重新探测", () => {
    const root = freshDir();
    const { exe } = makeZcodeTree(root);
    const first = scriptedProbe([{ test: isTableScript, out: exe }]);
    expect(locateZcodePair({}, first.probe).found).toBe(true);
    resetLocateCache();
    const second = scriptedProbe([{ test: isTableScript, out: exe }]);
    locateZcodePair({}, second.probe);
    expect(second.calls).toHaveLength(1); // 缓存已清：进程表步被真实重探
  });
  it("失败不缓存：全败两次调用，probe 两轮都被调用（机器状态可变，探测成本低）", () => {
    const a = failAll();
    expect(locateZcodePair({}, a.probe).found).toBe(false);
    const b = failAll();
    expect(locateZcodePair({}, b.probe).found).toBe(false);
    expect(a.calls.length).toBeGreaterThan(0);
    expect(b.calls.length).toBe(a.calls.length); // 第二次没有命中任何缓存，全步重跑
  });
});

// ─────────────────────────── 全败与命中顺序（S2c-② 核心） ───────────────────────────

describe("locateZcodePair：全败指引与命中顺序", () => {
  it("八步全败 → found=false、guidance=LOCATE_GUIDANCE、全步留痕（win32 全序 / 其他平台含 platform 步）", () => {
    const { probe, calls } = failAll();
    const got = locateZcodePair({}, probe);
    expect(got.found).toBe(false);
    expect(got.source).toBe("");
    expect(got.pair).toBeNull();
    expect(got.guidance).toBe(LOCATE_GUIDANCE);
    const steps = got.attempts.map((a) => a.step);
    if (process.platform === "win32") {
      expect(steps).toEqual(["env", "exec_path", "process_table", "parent_process", "registry", "common_paths"]);
      // win32 上确实发起了三段 PowerShell 探测（进程表/父链/注册表）
      expect(calls.length).toBe(3);
    } else {
      expect(steps).toEqual(["env", "platform"]);
      expect(calls).toHaveLength(0);
    }
    for (const a of got.attempts) expect(a.hit).toBe(false);
  });
  it("非 Windows：跳过 ②-⑥（零 probe 调用），平台步留痕 + 指引（探测仅按 Windows 实测实现）", () => {
    const desc = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const { probe, calls } = failAll();
      const got = locateZcodePair({}, probe);
      expect(calls).toHaveLength(0);
      expect(got.attempts.map((a) => a.step)).toEqual(["env", "platform"]);
      expect(got.guidance).toBe(LOCATE_GUIDANCE);
    } finally {
      if (desc) Object.defineProperty(process, "platform", desc);
      resetLocateCache();
    }
  });
  it("process_table 命中：exe 配对出 cjs 即收，后续步骤（父链/注册表）零调用", () => {
    const root = freshDir();
    const { exe, cjs } = makeZcodeTree(root);
    const { probe, calls } = scriptedProbe([{ test: isTableScript, out: exe }]);
    const got = locateZcodePair({}, probe);
    expect(got).toMatchObject({ found: true, source: "process_table" });
    expect(got.pair).toEqual({ exe, cjs });
    expect(got.attempts.some((a) => a.step === "process_table" && a.hit)).toBe(true);
    expect(calls).toHaveLength(1);
  });
  it("process_table 多行：首个 exe 配不到 cjs 时继续尝试下一行", () => {
    const bareRoot = freshDir();
    writeFileSync(join(bareRoot, "ZCode.exe"), "exe", "utf8"); // 无 resources
    const goodRoot = freshDir();
    const good = makeZcodeTree(goodRoot);
    const { probe } = scriptedProbe([
      { test: isTableScript, out: `${join(bareRoot, "ZCode.exe")}\r\n${good.exe}` },
    ]);
    const got = locateZcodePair({}, probe);
    expect(got.source).toBe("process_table");
    expect(got.pair).toEqual({ exe: good.exe, cjs: good.cjs });
  });
  it("process_table 有进程但全配不到 cjs → 该步留痕 hit=false，继续父链", () => {
    const bareRoot = freshDir();
    writeFileSync(join(bareRoot, "ZCode.exe"), "exe", "utf8");
    const { probe } = scriptedProbe([{ test: isTableScript, out: join(bareRoot, "ZCode.exe") }]);
    const got = locateZcodePair({}, probe);
    const table = got.attempts.find((a) => a.step === "process_table")!;
    expect(table.hit).toBe(false);
    expect(table.detail).toContain("都配不到 zcode.cjs");
    expect(got.found).toBe(false);
  });
  it("父链命中（F1：MCP/hook 进程 parent=ZCode.exe 恰好 1 跳）→ source=parent_process", () => {
    const root = freshDir();
    const { exe } = makeZcodeTree(root);
    const { probe, calls } = scriptedProbe([
      { test: isParentScript, out: exe },
    ]);
    const got = locateZcodePair({}, probe);
    expect(got).toMatchObject({ found: true, source: "parent_process" });
    expect(got.pair?.exe).toBe(exe);
    expect(calls).toHaveLength(2); // 1=进程表空查 + 1=父链查询（后续注册表步零调用）
    expect(got.attempts.find((a) => a.step === "parent_process")!.hit).toBe(true);
  });
  it("父链非 ZCode.exe → 不收，继续注册表；注册表引号 UninstallString 反推安装根命中", () => {
    const root = freshDir();
    makeZcodeTree(root);
    const { probe } = scriptedProbe([
      { test: isRegistryScript, out: `"${join(root, "Uninstall ZCode.exe")}" /currentuser` },
    ]);
    const got = locateZcodePair({}, probe);
    expect(got.source).toBe("registry");
    expect(got.pair?.exe).toBe(join(root, "ZCode.exe"));
    expect(got.attempts.find((a) => a.step === "registry")!.detail).toContain(root);
  });
  it("注册表多行：前几行反推的根不可用则继续，直到可配对行", () => {
    const root = freshDir();
    makeZcodeTree(root);
    const { probe } = scriptedProbe([
      {
        test: isRegistryScript,
        out: [`"C:\\definitely\\not\\here\\Uninstall.exe" /x`, `${join(root, "Uninstall.exe")} /currentuser`].join("\n"),
      },
    ]);
    const got = locateZcodePair({}, probe);
    expect(got.source).toBe("registry");
    expect(got.pair?.exe).toBe(join(root, "ZCode.exe"));
  });
  it("common_paths 兜底：LOCALAPPDATA 指向安装树时命中（F6：默认形态兜底）", () => {
    const base = freshDir();
    const tree = makeZcodeTree(join(base, "Programs", "ZCode"));
    const { probe } = scriptedProbe([]); // 进程表/父链/注册表全空
    const got = locateZcodePair({ LOCALAPPDATA: base }, probe);
    expect(got.source).toBe("common_paths");
    expect(got.pair?.exe).toBe(tree.exe);
    expect(got.attempts.find((a) => a.step === "common_paths")!.hit).toBe(true);
  });
  it("probe 输出全空白 → 按空输出处理（psProbe 契约：trim 后空串=未命中）", () => {
    const { probe } = scriptedProbe([
      { test: isTableScript, out: "   \r\n  " },
      { test: isParentScript, out: " \n" },
      { test: isRegistryScript, out: "\t" },
    ]);
    const got = locateZcodePair({}, probe);
    expect(got.found).toBe(false);
    expect(got.attempts.find((a) => a.step === "process_table")!.detail).toContain("未发现 ZCode.exe 活进程");
    // 注：默认 psProbe 保证 status≠0/超时返回空串（不抛）；probe 抛错不在 ZcodeProbe 契约内，
    // 不按已定义行为断言（真全败场景由上面的假 probe 全败用例承载）。
  });
});

// ─────────────────────────── resolveZcodeSpawnConfig ───────────────────────────

describe("resolveZcodeSpawnConfig（spawn 配置解析唯一入口）", () => {
  it("env 已配置且文件存在 → 原样使用（现行为不变，零子进程），outcome 可审计", () => {
    const root = freshDir();
    const { exe, cjs } = makeZcodeTree(root);
    const got = resolveZcodeSpawnConfig({ XC_ZCODE_EXE: exe, XC_ZCODE_CJS: cjs }, failAll().probe);
    expect(got.zcodeExe).toBe(exe);
    expect(got.zcodeCjs).toBe(cjs);
    expect(got.outcome).toMatchObject({ found: true, source: "user_config" });
  });
  it("全败 → 空串配置 + outcome.found=false + guidance 指引（硬标准 2：不静默）", () => {
    const got = resolveZcodeSpawnConfig({}, failAll().probe);
    expect(got.zcodeExe).toBe("");
    expect(got.zcodeCjs).toBe("");
    expect(got.outcome.found).toBe(false);
    expect(got.outcome.guidance).toBe(LOCATE_GUIDANCE);
  });
  it("探测命中 → 配对结果进 spawn 配置", () => {
    const root = freshDir();
    const { exe, cjs } = makeZcodeTree(root);
    const got = resolveZcodeSpawnConfig({}, scriptedProbe([{ test: isTableScript, out: exe }]).probe);
    expect(got.zcodeExe).toBe(exe);
    expect(got.zcodeCjs).toBe(cjs);
    expect(got.outcome.source).toBe("process_table");
  });
});

// 文件存在性自检兜底：确保本文件用到的真实路径断言不是自我欺骗。
it("测试脚手架自检：makeZcodeTree 产物真实存在于磁盘", () => {
  const root = freshDir();
  const { exe, cjs } = makeZcodeTree(root, "scaffold");
  expect(existsSync(exe)).toBe(true);
  expect(existsSync(cjs)).toBe(true);
});
