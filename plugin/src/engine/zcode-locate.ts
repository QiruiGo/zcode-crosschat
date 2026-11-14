/**
 * v0.4 零必填配置 —— zcode_exe / zcode_cjs 自动探测（DESIGN-V0.4.md §2）。
 *
 * 探测事实基线（docs/RELEASE-RECON.md §3.1；证据 recon/03-进程与exe探测事实.md）：
 *  F1 manifest command:"node" 的 MCP/hook 进程跑在系统 node.exe 下，parent=ZCode.exe 恰好 1 跳；
 *  F2 exe+cjs 运行形态下 process.execPath 即 ZCode.exe（zcode doctor 实测）；
 *  F3 插件进程 env 无 exe 路径线索（probe 84 键过滤集实测）；
 *  F4 注册表 Uninstall 项 InstallLocation 为空，只能从 UninstallString 反推安装根；
 *  F5 cjs 由 exe 同根推导：<exe_dir>\resources\glm\zcode.cjs；glm 段稳定性未确认 → glob 兜底；
 *  F6 硬编码默认路径不可靠（样本机装自定义盘，where zcode 无 shim）。
 *
 * 降级红线（RELEASE-RECON §3.2）：本模块结果只在内存中参与本次 spawn 决策，
 * 绝不写回宿主 user_config/options（v0.2 §2.4 options 事故敏感区）。
 * 每次定位结果由调用方落审计（engine.jsonl zcode-locate 行）并可经 xc_doctor 查看。
 *
 * 同步性：探测用 spawnSync（PowerShell 只读进程表/注册表），单步超时 4s，windowsHide；
 * 只在推送唤醒（attemptWake）与成员供给（provisionMember）路径调用——pull 协作与
 * peer 消息零成本不受影响。成功结果进程内缓存；失败不缓存（机器状态可变，探测成本低）。
 * 注入缝（复核轮 F2）：探测步以 ZcodeProbe 类型参数注入（默认真 PowerShell），
 * 测试用假 probe 模拟全败/命中顺序——本机 ZCode 在装，真全败不可构造。
 * 不变式（复核轮 F4）：env 判定先于缓存返回，env 命中不读不写缓存——
 * 「env 永远可覆盖探测结果」不依赖调用时序。
 * v0.5.3（A5 修复）：显式配置（XC_ZCODE_EXE/XC_ZCODE_CJS 任一非空）一律校验，
 * 无效即显式报错（outcome.configError）——不再「已配置但文件不存在 → 继续自动探测」
 * 的静默回落；自动探测仅两项都未配置时可达。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export interface ZcodePair {
  /** ZCode.exe 绝对路径。 */
  exe: string;
  /** 与 exe 同根的 CLI 入口脚本绝对路径（resources\<variant>\zcode.cjs）。 */
  cjs: string;
}

export type LocateSource =
  | "user_config" | "exec_path" | "process_table" | "parent_process"
  | "registry" | "common_paths" | "";

/** 单步探测留痕（xc_doctor 与失败指引共用）。 */
export interface LocateAttempt {
  step: string;
  hit: boolean;
  detail: string;
}

export interface LocateOutcome {
  found: boolean;
  source: LocateSource;
  pair: ZcodePair | null;
  attempts: LocateAttempt[];
  /** found=false 时的用户指引（工具回执 / doctor / 错误文案共用一份）。 */
  guidance: string;
  /**
   * v0.5.3（A5 修复）：显式配置（XC_ZCODE_EXE/XC_ZCODE_CJS 任一非空）无效时的根因文案
   * （含修复指引）。未配置（走自动探测）或配置有效时 absent。配置无效时 found=false、
   * **绝不回落自动探测**（回落仅在未配置时）——provision/ wake/doctor 依此显式报错，
   * 不再「配置路径被静默弃用 + 建真会话烧额度 + 失败回执误导到 member_model」。
   */
  configError?: string;
}

/** 探测失败时的统一指引（DESIGN-V0.4 §2.7：明确指引而非静默不可用）。 */
export const LOCATE_GUIDANCE =
  "未找到本机 zcode 可执行文件（自动探测未命中），推送唤醒与成员供给暂不可用；" +
  "两会话 pull 协作不受任何影响。任选其一修复：" +
  "① zcode 桌面端 → 设置 → 插件 → zcode-crosschat → 插件设置，填写 zcode_exe" +
  "（zcode 安装目录下的 ZCode.exe）与 zcode_cjs（同目录 resources\\<variant>\\zcode.cjs）；" +
  "② 在会话里运行 xc_doctor 查看已尝试的探测线索。";

const PROBE_TIMEOUT_MS = 4000;

// ─────────────────────────── 显式配置校验（v0.5.3 A5 修复） ───────────────────────────

/** 显式配置无效时的统一修复指引（与 LOCATE_GUIDANCE 同风格：给明确出路而非静默）。 */
export const SPAWN_CONFIG_GUIDANCE =
  "请在插件设置里修正 zcode_exe（zcode 安装目录下的 ZCode.exe）与 zcode_cjs" +
  "（同目录 resources\\<variant>\\zcode.cjs），或清空两项走自动探测；" +
  "确认配置有效之前推送唤醒与成员供给不可用（不会回落自动探测），两会话 pull 协作不受影响，" +
  "可运行 xc_doctor 查看校验详情。";

/** 单个配置文件的有效性校验；无效返回根因短语，有效返回 undefined（只做同步 fs 检查）。 */
function invalidFileReason(path: string, kind: "exe" | "cjs"): string | undefined {
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    return "文件不存在";
  }
  if (!isFile) return "存在但不是普通文件（目录或其他）";
  // exe 在 Windows 上要求 .exe 扩展名（plugin.json userConfig zcode_exe 描述的交付形态）；
  // 「存在但不可执行文件」（红队 a5 对照组：.txt）在此显式拦截，不再静默换探测路径。
  if (kind === "exe" && process.platform === "win32" && extname(path).toLowerCase() !== ".exe") {
    return "存在但不是 Windows 可执行文件（扩展名非 .exe）";
  }
  return undefined;
}

/**
 * v0.5.3（A5 修复）：显式 spawn 配置解析（唯一入口）。
 * XC_ZCODE_EXE/XC_ZCODE_CJS 任一非空即视为「显式配置」——校验并原样采用，绝不静默回落
 * 自动探测（回落仅在两项都未配置时）：
 * - exe 配置无效（不存在/非文件/非 .exe）→ 显式报错（含根因与 SPAWN_CONFIG_GUIDANCE）；
 * - cjs 留空（plugin.json userConfig「留空时随 zcode_exe 一并自动探测」）→ 从配置的
 *   exe 同目录推导（锚定配置的 exe，绝不换用探测到的其他安装）；推导不到 → 显式报错；
 * - exe 未配置但 cjs 已配置 → 显式报错（成对配置或清空走自动探测，不再半配置半探测）。
 * 纯同步 fs 检查，零子进程探测（校验失败连 PowerShell 都不起——快速失败不烧额度）。
 */
export function resolveExplicitSpawnPair(
  env: NodeJS.ProcessEnv = process.env,
): { error?: string; pair?: ZcodePair } {
  const exeEnv = (env["XC_ZCODE_EXE"] ?? "").trim();
  const cjsEnv = (env["XC_ZCODE_CJS"] ?? "").trim();
  if (exeEnv === "" && cjsEnv === "") return {}; // 未配置：唯一允许自动探测的入口

  const problems: string[] = [];
  let derivedCjs: string | undefined;
  if (exeEnv === "") {
    problems.push(`已配置 zcode_cjs="${cjsEnv}" 但 zcode_exe 未配置（请成对配置，或清空 zcode_cjs 走自动探测）`);
  } else {
    const exeProblem = invalidFileReason(exeEnv, "exe");
    if (exeProblem !== undefined) {
      problems.push(`配置的 zcode_exe="${exeEnv}" 无效: ${exeProblem}`);
    } else if (cjsEnv === "") {
      derivedCjs = deriveCjsCandidates(dirname(exeEnv))[0];
      if (derivedCjs === undefined) {
        problems.push(`zcode_cjs 留空且无法从 zcode_exe 同目录推导出 resources\\<variant>\\zcode.cjs（请手填 zcode_cjs）`);
      }
    }
  }
  if (exeEnv !== "" && cjsEnv !== "") {
    const cjsProblem = invalidFileReason(cjsEnv, "cjs");
    if (cjsProblem !== undefined) problems.push(`配置的 zcode_cjs="${cjsEnv}" 无效: ${cjsProblem}`);
  }
  if (problems.length > 0) {
    return { error: `XC_ZCODE_EXE/XC_ZCODE_CJS 显式配置无效（${problems.join("；")}）。${SPAWN_CONFIG_GUIDANCE}` };
  }
  // cjs 留空时此处必已推导成功（推导失败已归入 problems）。
  const cjs = cjsEnv !== "" ? cjsEnv : derivedCjs!;
  return { pair: { exe: exeEnv, cjs } };
}

/** 只取显式配置的校验结论（唤醒路径的零成本前置闸用；未配置/配置有效 → undefined）。 */
export function explicitSpawnConfigError(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveExplicitSpawnPair(env).error;
}

/** 探测函数类型：单步只读探测的注入缝（测试用假 probe 模拟全败/命中顺序，§5-S2c-②）。 */
export type ZcodeProbe = (script: string) => string;

/** 默认实现：spawnSync PowerShell（进程表/注册表；失败/超时一律返回空串）。 */
function psProbe(script: string): string {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: PROBE_TIMEOUT_MS, encoding: "utf8", windowsHide: true,
  });
  return (r.status === 0 && typeof r.stdout === "string" ? r.stdout : "").trim();
}

/** F5：由 exe 目录推导 cjs 候选（glm 段优先，其余 resources 子目录按名排序 glob 兜底）。 */
export function deriveCjsCandidates(exeDir: string): string[] {
  const resDir = join(exeDir, "resources");
  if (!existsSync(resDir)) return [];
  try {
    return readdirSync(resDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => (a === "glm" ? -1 : b === "glm" ? 1 : a.localeCompare(b)))
      .map((d) => join(resDir, d, "zcode.cjs"))
      .filter((c) => existsSync(c));
  } catch {
    return [];
  }
}

/** exe 候选 → (exe, cjs) 配对；配不到 cjs 视为未命中（spawn 需要成对，F5）。 */
export function pairFromExe(exe: string): ZcodePair | null {
  if (exe.trim() === "" || !existsSync(exe)) return null;
  const cjs = deriveCjsCandidates(dirname(exe))[0];
  return cjs ? { exe, cjs } : null;
}

/** F4：UninstallString（如 `"<安装目录>\Uninstall ZCode.exe" /currentuser`）→ 安装根。 */
function installRootFromUninstallString(uninstallString: string): string {
  const m = /^\s*"([^"]+)"/.exec(uninstallString) ?? /^\s*(\S+)/.exec(uninstallString);
  return m ? dirname(m[1]!) : "";
}

let cache: LocateOutcome | null = null;
/** 测试注入点：清空成功缓存。 */
export function resetLocateCache(): void { cache = null; }

/** 主入口：env 判定最先（不变式「env 永远可覆盖探测结果」，§2.7）→ 缓存 → 按序探测；
 * probe 参数为测试注入缝；只缓存自动探测的成功结果。 */
export function locateZcodePair(
  env: NodeJS.ProcessEnv = process.env,
  probe: ZcodeProbe = psProbe,
): LocateOutcome {
  const attempts: LocateAttempt[] = [];
  const finish = (found: boolean, source: LocateSource, pair: ZcodePair | null): LocateOutcome => {
    const outcome: LocateOutcome = { found, source, pair, attempts, guidance: found ? "" : LOCATE_GUIDANCE };
    if (found) cache = outcome;
    return outcome;
  };

  // ① env（userConfig 经 plugin.json env 注入；探测事实基线 F3：缺省场景确实为空）。
  //    判定先于缓存（复核轮 F4）：env 命中直接返回——不读缓存、不写缓存，
  //    不同 env 参数的调用（生产进程内 env 恒定；测试/doctor 传不同 env）互不污染。
  //    v0.5.3（A5 修复）：显式配置存在 → 校验并显式报错，绝不静默回落自动探测
  //    （回落仅在两项都未配置时）。校验失败也不读成功缓存——缓存是自动探测的结果，
  //    读它就等于静默换用另一个 exe（a5 形态：配置路径被弃用 + 真会话烧额度）。
  const exeEnv = (env["XC_ZCODE_EXE"] ?? "").trim();
  const cjsEnv = (env["XC_ZCODE_CJS"] ?? "").trim();
  if (exeEnv !== "" || cjsEnv !== "") {
    const explicit = resolveExplicitSpawnPair(env);
    if (explicit.error !== undefined) {
      attempts.push({ step: "env", hit: false, detail: `显式配置无效（不回落自动探测）: ${explicit.error}` });
      return {
        found: false, source: "user_config", pair: null, attempts,
        guidance: explicit.error, configError: explicit.error,
      };
    }
    attempts.push({
      step: "env", hit: true,
      detail: `XC_ZCODE_EXE/XC_ZCODE_CJS 已配置且校验通过`
        + (cjsEnv === "" ? "（zcode_cjs 留空，已从 zcode_exe 同目录推导）" : ""),
    });
    return { found: true, source: "user_config", pair: explicit.pair!, attempts, guidance: "" };
  }
  attempts.push({ step: "env", hit: false, detail: "未配置（exe=empty cjs=empty）→ 自动探测" });

  // 自动探测成功缓存（env 已在上面分流；命中缓存时并入本次 attempts，doctor 展示的留痕仍是本次调用链）。
  if (cache) return { ...cache, attempts };

  if (process.platform !== "win32") {
    attempts.push({
      step: "platform", hit: false,
      detail: "非 Windows：自动探测按 Windows 实测实现（RELEASE-RECON §3），请按指引手填",
    });
    return finish(false, "", null);
  }

  // ② 本进程 execPath（F2）
  const execPath = process.execPath;
  if (basename(execPath).toLowerCase() === "zcode.exe") {
    const pair = pairFromExe(execPath);
    attempts.push({ step: "exec_path", hit: pair !== null, detail: execPath });
    if (pair) return finish(true, "exec_path", pair);
  } else {
    attempts.push({ step: "exec_path", hit: false, detail: `process.execPath 非 ZCode.exe: ${execPath}` });
  }

  // ③ 进程表枚举（活进程=必装，覆盖任意盘符）
  const tableRaw = probe(
    "Get-CimInstance Win32_Process -Filter \"Name='ZCode.exe'\" | Select-Object -ExpandProperty ExecutablePath",
  );
  const tablePaths = tableRaw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  for (const exe of tablePaths) {
    const pair = pairFromExe(exe);
    if (pair) {
      attempts.push({ step: "process_table", hit: true, detail: exe });
      return finish(true, "process_table", pair);
    }
  }
  attempts.push({
    step: "process_table", hit: false,
    detail: tablePaths.length === 0 ? "未发现 ZCode.exe 活进程" : `发现 ${tablePaths.length} 个 ZCode.exe 但都配不到 zcode.cjs`,
  });

  // ④ 父链 1 跳（F1）
  const ppid = process.ppid;
  if (Number.isFinite(ppid) && ppid > 0) {
    const parent = probe(
      `Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}" | Select-Object -ExpandProperty ExecutablePath`,
    );
    if (parent !== "" && basename(parent).toLowerCase() === "zcode.exe") {
      const pair = pairFromExe(parent);
      attempts.push({ step: "parent_process", hit: pair !== null, detail: `ppid=${ppid} → ${parent}` });
      if (pair) return finish(true, "parent_process", pair);
    }
    attempts.push({ step: "parent_process", hit: false, detail: `ppid=${ppid} → ${parent || "不可得"}` });
  }

  // ⑤ 注册表反推（F4）
  const uninstallRaw = probe(
    "Get-ItemProperty @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*') " +
    "-ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*ZCode*' } | " +
    "Select-Object -ExpandProperty UninstallString",
  );
  for (const line of uninstallRaw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")) {
    const root = installRootFromUninstallString(line);
    const pair = pairFromExe(join(root, "ZCode.exe"));
    if (pair) {
      attempts.push({ step: "registry", hit: true, detail: `${line} → ${root}` });
      return finish(true, "registry", pair);
    }
  }
  attempts.push({ step: "registry", hit: false, detail: "Uninstall 项未反推出可用安装根" });

  // ⑥ 常见路径兜底（F6）
  for (const exe of [
    join(env["LOCALAPPDATA"] ?? "", "Programs", "ZCode", "ZCode.exe"),
    join(env["ProgramFiles"] ?? "", "ZCode", "ZCode.exe"),
    join(env["ProgramFiles(x86)"] ?? "", "ZCode", "ZCode.exe"),
  ]) {
    const pair = pairFromExe(exe);
    if (pair) {
      attempts.push({ step: "common_paths", hit: true, detail: exe });
      return finish(true, "common_paths", pair);
    }
  }
  attempts.push({ step: "common_paths", hit: false, detail: "默认安装路径未命中" });

  return finish(false, "", null);
}

export interface ResolvedSpawnConfig {
  zcodeExe: string;
  zcodeCjs: string;
  outcome: LocateOutcome;
}

/**
 * spawn 配置解析的唯一入口（wake.ts / provision.ts 调用）：
 * 显式配置（XC_ZCODE_EXE/XC_ZCODE_CJS 任一非空）→ 校验后原样使用（最快路径，不触发任何
 * 子进程探测）；校验失败 → outcome.configError 携带根因、pair 为空，调用方必须显式失败
 * （v0.5.3 A5：不静默回落、不建真会话）；两项都未配置 → 自动探测兜底。返回 outcome 供审计与指引。
 */
export function resolveZcodeSpawnConfig(
  env: NodeJS.ProcessEnv = process.env,
  probe: ZcodeProbe = psProbe,
): ResolvedSpawnConfig {
  const outcome = locateZcodePair(env, probe);
  const pair = outcome.found && outcome.pair ? outcome.pair : { exe: "", cjs: "" };
  return { zcodeExe: pair.exe, zcodeCjs: pair.cjs, outcome };
}
