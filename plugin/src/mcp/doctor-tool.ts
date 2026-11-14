/**
 * v0.4：xc_doctor —— 只读体检（免注册，DESIGN-V0.4 §2.5）。
 * 把「探测成功与否、用了哪个 exe/cjs、失败时填什么」变成可主动查看的面。
 * 纯只读：除 zcode-locate 的只读探测（进程表/注册表，单步 4s 超时）外不触碰任何状态，
 * 不写 user_config、不写磁盘真源。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { locateZcodePair, type LocateAttempt } from "../engine/zcode-locate.js";

export interface DoctorReport {
  plugin: { name: string; version: string };
  runtime: { node: string; execPath: string; platform: string; cwd: string };
  spawnPaths: {
    zcode_exe_env_set: boolean;
    zcode_cjs_env_set: boolean;
    member_model_env_value: string;
    locate: {
      found: boolean; source: string; exe: string; cjs: string; attempts: LocateAttempt[];
      /** v0.5.3（A5 修复）：显式配置无效的根因文案（人可读面另出 WARNING 行）；否则 absent。 */
      configError?: string;
    };
  };
  guidance: string;
}

export function buildDoctorReport(input: {
  version: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): DoctorReport {
  const exeSet = (input.env["XC_ZCODE_EXE"] ?? "").trim() !== "";
  const cjsSet = (input.env["XC_ZCODE_CJS"] ?? "").trim() !== "";
  const outcome = locateZcodePair(input.env);   // 成功结果在 zcode-locate 内缓存，重复调用零探测成本
  return {
    plugin: { name: "zcode-crosschat", version: input.version },
    runtime: {
      node: process.version, execPath: process.execPath,
      platform: process.platform, cwd: input.cwd,
    },
    spawnPaths: {
      zcode_exe_env_set: exeSet,
      zcode_cjs_env_set: cjsSet,
      member_model_env_value: (input.env["XC_MEMBER_MODEL"] ?? "").trim(),
      locate: {
        found: outcome.found, source: outcome.source,
        exe: outcome.pair?.exe ?? "", cjs: outcome.pair?.cjs ?? "",
        attempts: outcome.attempts,
        ...(outcome.configError !== undefined ? { configError: outcome.configError } : {}),
      },
    },
    guidance: outcome.guidance,
  };
}

/** 注册（server.ts 调用；与 tools.ts 的 server.tool 形态一致，空参数 shape）。 */
export function registerDoctorTool(server: McpServer, input: {
  version: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): void {
  server.tool(
    "xc_doctor",
    "Read-only self check: plugin version, runtime, auto-detected zcode_exe/zcode_cjs paths and probe attempts. Does not require registration.",
    {},
    async () => {
      const report = buildDoctorReport(input);
      const lines = [
        `zcode-crosschat ${report.plugin.version}`,
        `runtime: node ${report.runtime.node} @ ${report.runtime.execPath} (${report.runtime.platform})`,
        `zcode_exe/zcode_cjs: env(set=${report.spawnPaths.zcode_exe_env_set}/${report.spawnPaths.zcode_cjs_env_set})` +
          ` locate(found=${report.spawnPaths.locate.found}, source=${report.spawnPaths.locate.source || "-"})`,
        `exe: ${report.spawnPaths.locate.exe || "(未定)"}`,
        `cjs: ${report.spawnPaths.locate.cjs || "(未定)"}`,
        `member_model(XC_MEMBER_MODEL): ${report.spawnPaths.member_model_env_value || "(空=枚举表自动选第一个)"}`,
        // v0.5.3（A5 修复）：显式配置无效 → WARNING 显式报错（红队 a5：此前 doctor
        // env(set=true) 却显示探测路径、配置被静默弃用且无任何警告）。
        ...(report.spawnPaths.locate.configError !== undefined
          ? [`WARNING: ${report.spawnPaths.locate.configError}`]
          : []),
        ...report.spawnPaths.locate.attempts.map((a) => `- [${a.hit ? "命中" : "未中"}] ${a.step}: ${a.detail}`),
        ...(report.guidance !== "" ? [`指引: ${report.guidance}`] : []),
      ];
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          { type: "text" as const, text: JSON.stringify(report) },
        ],
      };
    },
  );
}
