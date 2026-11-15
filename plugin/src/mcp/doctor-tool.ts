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
// v0.8.1（M01 修复）：zod **只作类型**导入（编译期擦除，不进 bundle）。
// 刻意不在本模块 import zod 运行时：doctor-tool 是 server.ts 静态导入链的末端，新增
// zod 主入口的运行时依赖边会翻转 esbuild 的模块初始化次序，使 SDK types.js 的模块体
// 在 zod/v4 core 初始化之前跑（`z.custom(...)` 命中 TDZ：Class2 is not a constructor，
// server 起不来）。action 的 zod shape 由入口模块 server.ts 构建后经参数传入。
import type { z } from "zod";
import { locateZcodePair, type LocateAttempt } from "../engine/zcode-locate.js";
import { DEFAULT_TEAM_ID } from "../core/types.js";
import {
  capacityCacheFile,
  formatCapacityLines,
  judgeCapacity,
  memWarnWatermarkInfoFromEnv,
  MEM_WATERMARK_FALLBACK_WARNING,
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
  /** v0.8.1（C4-O1）：XC_MEM_WARN_WATERMARK 越界已回落内置缺省（人可读面另出 WARNING 行）。 */
  memWarnWatermarkFallback?: boolean;
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
    // v0.8.1（29 红队 C4-O1 修复）：XC_MEM_WARN_WATERMARK 越界（0/负数/≥1/非数字）
    // 不再静默按缺省判定——doctor 的诊断面同样给出 payload 键 + WARNING 行
    // （裁决建议「至少在 xc_doctor 或 payload detail 里给一条提示」的两处都落）。
    const watermark = memWarnWatermarkInfoFromEnv(input.env);
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
      ...(watermark.fellBack ? { memWarnWatermarkFallback: true } : {}),
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
    // v0.8.1（C4-O1）：水位预警线越界回落披露（与 xc_overview 的 capacityMount 同句）。
    if (cap.memWarnWatermarkFallback === true) lines.push(MEM_WATERMARK_FALLBACK_WARNING);
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

// ---------------------------------------------------------------------------
// v0.8.1（29 红队 M01 修复）：中毒 team.json 的工具面自愈入口。
//
// M01 的持久伤害是「team.json 双重复员键 → .bak 同步中毒 → 全队 team-axis 工具
// internal」，而彼时唯一还能应答的工具就是免注册的 xc_doctor——自愈路径必须落在
// 这里：`xc_doctor({action:"repair-team"})`。缺省调用（无 action）仍是纯只读体检，
// 一个字节都不写；本 action 是 doctor 唯一的写面，且只写「修复重复成员键」这一
// 种确定性变更（判据与留痕见 core/teamstate.ts repairTeamState）。
// ---------------------------------------------------------------------------

/** repair-team 的结构化结果（= core repairTeamState 的返回 + teamId）。 */
export interface DoctorTeamRepair {
  teamId: string;
  repaired: boolean;
  reason: "repaired" | "not-corrupt" | "unrepairable";
  defect?: string;
  kept: Array<{ key: string; sessionId: string }>;
  dropped: Array<{ key: string; sessionId: string }>;
  fallbackKeys: string[];
  preserved?: string;
}

/** repair-team 的人可读文本（同一函数供注册面与分发面共用，防两处漂移）。 */
export function renderTeamRepairText(repair: DoctorTeamRepair): string {
  if (repair.reason === "not-corrupt") {
    return `team "${repair.teamId}": state file is healthy — nothing to repair.`;
  }
  if (repair.reason === "unrepairable") {
    return (
      `team "${repair.teamId}": state file is corrupt (${repair.defect ?? "unknown defect"}) and this defect is ` +
      `outside the deterministic repair scope (duplicate member keys only) — restore team.json from the ` +
      `last-known-good team.json.bak manually, or delete the team directory to reset. The corrupt bytes were ` +
      `NOT touched.`
    );
  }
  const kept = repair.kept.map((k) => `${k.key}→${k.sessionId}`).join(", ") || "(none)";
  const dropped = repair.dropped.map((k) => `${k.key}→${k.sessionId}`).join(", ") || "(none)";
  return (
    `team "${repair.teamId}": REPAIRED duplicate member keys — kept [${kept}], dropped [${dropped}]` +
    (repair.fallbackKeys.length > 0 ? ` (fallback rule for: ${repair.fallbackKeys.join(", ")})` : "") +
    `. Poisoned bytes preserved at ${repair.preserved ?? "(n/a)"}; team.json and team.json.bak were rewritten ` +
    `with the repaired state. Verify the board with xc_overview.`
  );
}

/**
 * 执行 repair-team（core 自愈 + 披露整形）。`teamId` 缺省 default——产品只建 default
 * 这一个队（identity.ts / tools-*.ts 全线 DEFAULT_TEAM_ID）。
 */
export async function runTeamRepair(stateRoot: string, teamId: string = DEFAULT_TEAM_ID): Promise<DoctorTeamRepair> {
  const { repairTeamState } = await import("../core/teamstate.js");
  const result = await repairTeamState(stateRoot, teamId);
  return { teamId, ...result };
}

/** repair-team 的 ToolResult（人可读文本 + JSON 载体，与体检面同形制）。 */
export function teamRepairToolResult(repair: DoctorTeamRepair): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      { type: "text" as const, text: renderTeamRepairText(repair) },
      { type: "text" as const, text: JSON.stringify(repair) },
    ],
  };
}

/**
 * v0.8.1（29 红队 M01 修复）：xc_doctor 的 action 入参形状（仅 repair-team 一个写面；
 * 缺省 = 纯只读体检）。形状由入口模块 server.ts 构建传入——本模块不 import zod 运行时
 * （见文件头：会翻转 bundle 初始化次序使 server 起不来）。
 */
export type DoctorActionShape = z.ZodRawShape;

/** 注册（server.ts 调用；与 tools.ts 的 server.tool 形态一致）。 */
export function registerDoctorTool(server: McpServer, input: {
  version: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** v0.7.2（C9-B6）：状态根；给定时 xc_doctor 一并惰性采样并展示容量。 */
  stateRoot?: string;
  capacitySampler?: CapacitySamplerFn;
  /** v0.8.1（M01 修复）：action 入参形状（server.ts 构建）；缺省 = 空 shape（无 action 面）。 */
  actionShape?: DoctorActionShape;
}): void {
  const shape = input.actionShape ?? {};
  server.tool(
    "xc_doctor",
    "Read-only self check: plugin version, runtime, auto-detected zcode_exe/zcode_cjs paths and probe attempts, capacity sample (watermark / red rules). Does not require registration. The default call writes nothing; the optional action \"repair-team\" is the one write face — it self-heals a team.json poisoned with duplicate member keys (the M01 aftermath, where every team-axis tool answers \"internal\" and the .bak is poisoned too).",
    shape,
    async (args: { action?: "repair-team" }) => {
      if (args.action === "repair-team") {
        if (input.stateRoot === undefined) {
          return teamRepairToolResult({
            teamId: DEFAULT_TEAM_ID,
            repaired: false,
            reason: "unrepairable",
            defect: "state root unavailable",
            kept: [], dropped: [], fallbackKeys: [],
          });
        }
        return teamRepairToolResult(await runTeamRepair(input.stateRoot));
      }
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
