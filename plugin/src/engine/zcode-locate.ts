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
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
}

/** 探测失败时的统一指引（DESIGN-V0.4 §2.7：明确指引而非静默不可用）。 */
export const LOCATE_GUIDANCE =
  "未找到本机 zcode 可执行文件（自动探测未命中），推送唤醒与成员供给暂不可用；" +
  "两会话 pull 协作不受任何影响。任选其一修复：" +
  "① zcode 桌面端 → 设置 → 插件 → zcode-crosschat → 插件设置，填写 zcode_exe" +
  "（zcode 安装目录下的 ZCode.exe）与 zcode_cjs（同目录 resources\\<variant>\\zcode.cjs）；" +
  "② 在会话里运行 xc_doctor 查看已尝试的探测线索。";

const PROBE_TIMEOUT_MS = 4000;

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
  const exeEnv = (env["XC_ZCODE_EXE"] ?? "").trim();
  const cjsEnv = (env["XC_ZCODE_CJS"] ?? "").trim();
  if (exeEnv !== "" && cjsEnv !== "") {
    if (existsSync(exeEnv) && existsSync(cjsEnv)) {
      attempts.push({ step: "env", hit: true, detail: "XC_ZCODE_EXE/XC_ZCODE_CJS 已配置且文件存在" });
      return { found: true, source: "user_config", pair: { exe: exeEnv, cjs: cjsEnv }, attempts, guidance: "" };
    }
    attempts.push({
      step: "env", hit: false,
      detail: `已配置但文件不存在（继续自动探测）: exe=${exeEnv} cjs=${cjsEnv}`,
    });
  } else {
    attempts.push({
      step: "env", hit: false,
      detail: `未配置（exe=${exeEnv === "" ? "empty" : "set"} cjs=${cjsEnv === "" ? "empty" : "set"}）`,
    });
  }

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
 * env 已配置且文件存在 → 原样使用（现行为不变，最快路径，不触发任何子进程探测）；
 * 否则自动探测兜底（含「已配置但文件不存在」的回落）。返回 outcome 供审计与指引。
 */
export function resolveZcodeSpawnConfig(
  env: NodeJS.ProcessEnv = process.env,
  probe: ZcodeProbe = psProbe,
): ResolvedSpawnConfig {
  const outcome = locateZcodePair(env, probe);
  const pair = outcome.found && outcome.pair ? outcome.pair : { exe: "", cjs: "" };
  return { zcodeExe: pair.exe, zcodeCjs: pair.cjs, outcome };
}
