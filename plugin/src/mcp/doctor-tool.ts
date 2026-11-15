/**
 * v0.4：xc_doctor —— 只读体检（免注册，DESIGN-V0.4 §2.5）。
 * 把「探测成功与否、用了哪个 exe/cjs、失败时填什么」变成可主动查看的面。
 * 纯只读：除 zcode-locate 的只读探测（进程表/注册表，单步 4s 超时）外不触碰任何状态，
 * 不写 user_config、不写磁盘真源。
 *
 * v0.7.2（C9-B6 修复，25-能力反向检验）：容量挂载。PROTOCOL §5 承诺容量采样
 * 「仅在 xc_overview/xc_doctor 调用时惰性采样」——此前 doctor 这一半完全不成立
 * （既不采样也不展示）。现在 doctor 与 overview 走同一 `sampleCapacity` 入口
 * （同一 `capacity/sample.json` 缓存、同一 `XC_MEM_SAMPLE_MIN_MS` 窗口、同一
 * judgeCapacity 判定），采样/判定任何意外都按 overview 同纪律降级为「不挂载」，
 * 体检其余面不受影响。唯一写入是那份**派生缓存**（非状态真源；与 overview 共用
 * 同一文件，先跑 doctor 还能替后续 overview 暖缓存），已在模块注释与 PROTOCOL §5
 * 如实披露。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { locateZcodePair, type LocateAttempt } from "../engine/zcode-locate.js";
import {
  capacityCacheFile,
  formatCapacityLines,
  judgeCapacity,
  sampleCapacity,
  type CapacitySample,
  type CapacityVerdict,
} from "../core/capacity.js";

/** doctor 的容量块（与 xc_overview payload.capacity 同字段同口径）。 */
export interface DoctorCapacity {
  sampledAt: number;
  totalBytes: number;
  freeBytes: number;
  watermark: number;
  steadyTreeBytes: number | null;
  headlessTurnCount: number;
  headlessTurnMaxRssBytes: number | null;
  degraded: "cim-unavailable" | null;
  categoryCounts?: Record<string, number>;
  red: boolean;
  violated: CapacityVerdict["violated"];
  detail: string[];
}

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
  /**
   * v0.7.2（C9-B6）：容量块。stateRoot 未给（隔离单测只验 locate 面）或采样意外时
   * absent——按 overview 同纪律「不挂载、不报错」。
   */
  capacity?: DoctorCapacity;
  guidance: string;
}

/** 容量采样缝（单测注入；生产 = sampleCapacity 真采样 + 缓存写入）。 */
export type CapacitySamplerFn = (
  env: NodeJS.ProcessEnv,
  cacheFile: string,
  now: number,
) => Promise<CapacitySample>;

/**
 * v0.7.2（C9-B6）：doctor 的容量惰性采样（PROTOCOL §5 的 doctor 一半）。
 * 与 xc_overview 的 capacityMount 同一入口/缓存/判定；任何意外返回 null = 不挂载。
 */
export async function sampleDoctorCapacity(input: {
  env: NodeJS.ProcessEnv;
  stateRoot: string;
  now?: number;
  capacitySampler?: CapacitySamplerFn;
}): Promise<DoctorCapacity | null> {
  try {
    const sampler = input.capacitySampler ?? sampleCapacity;
    const sample = await sampler(input.env, capacityCacheFile(input.stateRoot), input.now ?? Date.now());
    const verdict = judgeCapacity(sample, input.env);
    return {
      sampledAt: sample.sampledAt,
      totalBytes: sample.totalBytes,
      freeBytes: sample.freeBytes,
      watermark: sample.watermark,
      steadyTreeBytes: sample.steadyTreeBytes,
      headlessTurnCount: sample.headlessTurnCount,
      headlessTurnMaxRssBytes: sample.headlessTurnMaxRssBytes,
      degraded: sample.degraded,
      ...(sample.categoryCounts !== undefined ? { categoryCounts: sample.categoryCounts } : {}),
      red: verdict.red,
      violated: verdict.violated,
      detail: verdict.detail,
    };
  } catch {
    return null; // 观测面永不为难体检面
  }
}

export function buildDoctorReport(input: {
  version: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** v0.7.2（C9-B6）：已采样的容量块（由 sampleDoctorCapacity 产出）；absent=不挂载。 */
  capacity?: DoctorCapacity | null;
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
    ...(input.capacity != null ? { capacity: input.capacity } : {}),
    guidance: outcome.guidance,
  };
}

/** buildDoctorReport 的人可读文本面（registerDoctorTool 与 server.ts 分发面共用，防两处漂移）。 */
export function renderDoctorText(report: DoctorReport): string {
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
  // v0.7.2（C9-B6）：容量行（与 xc_overview 的 formatCapacityLines 逐字同源，
  // 含标红明细与 compress-advice 建议行——诊断面也要能回答「为什么红」）。
  const cap = report.capacity;
  if (cap !== undefined) {
    const sample: CapacitySample = {
      sampledAt: cap.sampledAt,
      totalBytes: cap.totalBytes,
      freeBytes: cap.freeBytes,
      watermark: cap.watermark,
      steadyTreeBytes: cap.steadyTreeBytes,
      headlessTurnCount: cap.headlessTurnCount,
      headlessTurnMaxRssBytes: cap.headlessTurnMaxRssBytes,
      degraded: cap.degraded,
      ...(cap.categoryCounts !== undefined ? { categoryCounts: cap.categoryCounts } : {}),
    };
    const verdict: CapacityVerdict = { red: cap.red, violated: cap.violated, detail: cap.detail };
    lines.push(...formatCapacityLines(sample, verdict));
  }
  return lines.join("\n");
}

/** xc_doctor 的 ToolResult（两块 content：人可读文本 + JSON 载体）。 */
export function doctorToolResult(report: DoctorReport): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      { type: "text" as const, text: renderDoctorText(report) },
      { type: "text" as const, text: JSON.stringify(report) },
    ],
  };
}

/** 注册（server.ts 调用；与 tools.ts 的 server.tool 形态一致，空参数 shape）。 */
export function registerDoctorTool(server: McpServer, input: {
  version: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** v0.7.2（C9-B6）：状态根；给定时 xc_doctor 一并惰性采样并展示容量。 */
  stateRoot?: string;
  capacitySampler?: CapacitySamplerFn;
}): void {
  server.tool(
    "xc_doctor",
    "Read-only self check: plugin version, runtime, auto-detected zcode_exe/zcode_cjs paths and probe attempts, capacity sample (watermark / red rules). Does not require registration.",
    {},
    async () => {
      const capacity = input.stateRoot !== undefined
        ? await sampleDoctorCapacity({
          env: input.env,
          stateRoot: input.stateRoot,
          ...(input.capacitySampler !== undefined ? { capacitySampler: input.capacitySampler } : {}),
        })
        : null;
      return doctorToolResult(buildDoctorReport({
        version: input.version,
        env: input.env,
        cwd: input.cwd,
        capacity,
      }));
    },
  );
}
