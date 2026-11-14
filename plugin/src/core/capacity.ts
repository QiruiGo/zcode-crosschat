/**
 * v0.6 C3：内存采样与随设备预警（DESIGN-V0.6.md §3.3；实施口径全部来自 E3 实测）。
 *
 * 采样模型（E3 §① 结论）：
 * - 设备水位 = os.totalmem()/os.freemem()（E3 实测 31.72GB 总 / 11.2-11.4GB 可用稳定）。
 * - 进程树按 CommandLine 分类（PowerShell CIM，`Get-CimInstance Win32_Process`）：
 *   main / shell（renderer,gpu,…）/ cli-utility / plugin-host / desktop-appserver /
 *   headless-appserver（provision 临时 keeper）/ headless-turn（wake 回合树）。
 * - 稳态列 steadyTreeBytes 只含常驻五类（main+shell+cli-utility+desktop-appserver+
 *   plugin-host）；瞬态回合树（headless-turn）与临时 keeper（headless-appserver）
 *   不混入常驻口径（DESIGN §3.3「两列分开呈现，不混口径」；E3 实施建议 1）。
 * - red3 用活进程数（此刻存在的 headless-turn 数），不做 >60s 稳态过滤——瞬态
 *   回合树恰恰是 red3 要抓的对象（DESIGN §3.3）。
 *
 * E3 踩坑对照（必须遵守）：
 * 1. PowerShell 5.1 读无 BOM UTF-8 ps1 按 GBK 解码 → Get-CimInstance 静默空结果。
 *    本模块不落 ps1 文件：命令经 argv 传入且**纯 ASCII**（const CIM_COMMAND）。
 * 2. （tasklist `"178,600 K"` 剥 K 后缀问题）本采样器不走 tasklist 口径。
 * 3. `--resume` 无头树命令行无 `--type`，会被误归 main → 用
 *    `zcode.cjs ∧ ¬app-server ∧ ¬--surface` 判定 headless-turn（分类规则第 6 步）。
 *
 * 无定时器纪律：只在 xc_overview/xc_doctor 调用时惰性采样，缓存文件
 * `.crosschat/capacity/sample.json` 最小间隔 XC_MEM_SAMPLE_MIN_MS（缺省 60s），
 * 窗口期内直接回缓存（sampledAt 标注真实采样时刻）。
 *
 * 判定纯函数 judgeCapacity 只吃样本（不触 os）——detail 给出具体 violated 规则与
 * 数字，供 panel 文本与测试断言。CIM 失败降级：只报 os 水位 + degraded:
 * "cim-unavailable"，进程类数据一律 null/0 不虚报（安全底线）。
 *
 * 路径注意：缓存路径由调用方传入；`capacityCacheFile(stateRoot)` 产出
 * `<.crosschat>/capacity/sample.json`（paths.ts 本版不动，构建器放本模块）。
 *
 * @module core/capacity
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic.js';

// --- 阈值缺省值（DESIGN §3.3 公式注释；方案 C3 阈值）-------------------------

/** red1：可用内存占比预警线（方案 C3「可用内存<15%」；E3 实测 ≈4.76GB@31.72GB）。 */
export const MEM_WARN_WATERMARK_DEFAULT = 0.15;
/** red2：headless 回合树单进程 WS 上限（方案 C3「单会话>800MB」）。 */
export const MEM_SESSION_LIMIT_DEFAULT_BYTES = 800 * 1024 * 1024;
/** red3：每并发成员 wake 回合瞬时占用预估（E3 实测 ~1.5GB/回合）。 */
export const TURN_ESTIMATE_DEFAULT_BYTES = Math.round(1.5 * 1024 * 1024 * 1024);
/** 采样缓存最小间隔（DESIGN §3.3；0=每次都真采样）。 */
export const MEM_SAMPLE_MIN_MS_DEFAULT = 60_000;

// --- env 解析（budget.ts envPositiveInt 同款防御口径）------------------------

function envNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** red1 阈值：XC_MEM_WARN_WATERMARK，合法域 (0,1)，非法/未设 → 0.15。 */
export function memWarnWatermarkFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = envNumber(env, 'XC_MEM_WARN_WATERMARK');
  return n !== undefined && n > 0 && n < 1 ? n : MEM_WARN_WATERMARK_DEFAULT;
}

/** red2 上限：XC_MEM_SESSION_LIMIT_BYTES（字节），>0 合法，非法/未设 → 800MB。 */
export function memSessionLimitBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = envNumber(env, 'XC_MEM_SESSION_LIMIT_BYTES');
  return n !== undefined && n > 0 ? n : MEM_SESSION_LIMIT_DEFAULT_BYTES;
}

/** red3 单回合预估：XC_TURN_ESTIMATE_BYTES（字节），>0 合法，非法/未设 → 1.5GB。 */
export function turnEstimateBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = envNumber(env, 'XC_TURN_ESTIMATE_BYTES');
  return n !== undefined && n > 0 ? n : TURN_ESTIMATE_DEFAULT_BYTES;
}

/** 缓存窗口：XC_MEM_SAMPLE_MIN_MS（毫秒），>=0 合法（0=不缓存），非法/未设 → 60s。 */
export function memSampleMinMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = envNumber(env, 'XC_MEM_SAMPLE_MIN_MS');
  return n !== undefined && n >= 0 ? n : MEM_SAMPLE_MIN_MS_DEFAULT;
}

// --- 进程行与分类（E3 ps-procs.ps1 口径的 TS 平移）---------------------------

/** 一行 CIM 进程记录（WorkingSetSize 原生字节口径）。 */
export interface ProcRow {
  pid: number;
  ppid: number;
  /** 映像名（CIM Name，如 ZCode.exe）。 */
  name: string;
  /** 命令行；CIM 拿不到（权限/系统进程）时为空串。 */
  commandLine: string;
  /** 工作集（字节）。 */
  wsBytes: number;
}

/** 分类标签：五类常驻 + 两类瞬态。 */
export type CapacityKind =
  | 'main'
  | 'shell'
  | 'cli-utility'
  | 'plugin-host'
  | 'desktop-appserver'
  | 'headless-appserver'
  | 'headless-turn';

/** steadyTreeBytes 的构成（DESIGN §4.2-M6 注释：main+shell+desktop-appserver+plugin-host+cli-utility）。 */
export const STEADY_KINDS: readonly CapacityKind[] = [
  'main',
  'shell',
  'cli-utility',
  'desktop-appserver',
  'plugin-host',
];

export interface ClassifiedTree {
  /** 每类 {进程数, WS 合计}。 */
  categories: Record<CapacityKind, { count: number; wsBytes: number }>;
  /** 常驻树 WS 合计（五类；瞬态不计）。 */
  steadyTreeBytes: number;
  /** 此刻存在的 headless-turn 进程数（≈并发 wake 回合数）。 */
  headlessTurnCount: number;
  /** headless-turn 单进程 WS 峰值；无回合树时 null。 */
  headlessTurnMaxRssBytes: number | null;
}

/**
 * 单进程分类（E3 ps-procs.ps1 判定顺序 1:1 平移；顺序即语义，勿重排）：
 * ①默认 main → ②`--type=` 归 shell（renderer/gpu/utility/…）→ ③
 * `--utility-sub-type=` 归 cli-utility → ④`__zcode-plugin-host` 归 plugin-host →
 * ⑤`app-server` 归 appserver（带 `--surface`=desktop-appserver，否则
 * headless-appserver=provision 临时 keeper）→ ⑥仍为 main 且含 `zcode.cjs` 且
 * ¬app-server ∧ ¬--surface → headless-turn（E3 踩坑 3）。
 */
export function classifyProcess(row: ProcRow): CapacityKind {
  const cl = typeof row.commandLine === 'string' ? row.commandLine : '';
  let kind: CapacityKind = 'main';
  if (/--type=([\w.-]+)/.test(cl)) kind = 'shell';
  if (/--utility-sub-type=([\w.]+)/.test(cl)) kind = 'cli-utility';
  if (cl.includes('__zcode-plugin-host')) kind = 'plugin-host';
  if (cl.includes('app-server')) {
    kind = cl.includes('--surface') ? 'desktop-appserver' : 'headless-appserver';
  }
  if (kind === 'main' && cl.includes('zcode.cjs') && !cl.includes('app-server') && !cl.includes('--surface')) {
    kind = 'headless-turn';
  }
  return kind;
}

/** 批量分类并汇总（纯函数）。 */
export function classifyZcodeProcesses(rows: readonly ProcRow[]): ClassifiedTree {
  const categories = Object.fromEntries(
    (['main', 'shell', 'cli-utility', 'plugin-host', 'desktop-appserver', 'headless-appserver', 'headless-turn'] as const).map(
      (k) => [k, { count: 0, wsBytes: 0 }],
    ),
  ) as Record<CapacityKind, { count: number; wsBytes: number }>;
  let turnCount = 0;
  let turnMax: number | null = null;
  for (const row of rows) {
    const kind = classifyProcess(row);
    const bucket = categories[kind];
    bucket.count += 1;
    bucket.wsBytes += row.wsBytes;
    if (kind === 'headless-turn') {
      turnCount += 1;
      turnMax = turnMax === null ? row.wsBytes : Math.max(turnMax, row.wsBytes);
    }
  }
  let steadyTreeBytes = 0;
  for (const k of STEADY_KINDS) steadyTreeBytes += categories[k].wsBytes;
  return { categories, steadyTreeBytes, headlessTurnCount: turnCount, headlessTurnMaxRssBytes: turnMax };
}

// --- CIM 采样（argv 传入，纯 ASCII；E3 踩坑 1）------------------------------

/**
 * PowerShell 命令。纪律（E3 踩坑 1）：**必须纯 ASCII**（PS5.1 按 GBK 解码非 ASCII
 * 会静默空结果）；不落 .ps1 文件，经 `-Command` argv 传入（Node 对含空格 argv 自动
 * 加双引号包裹，命令内部只用单引号，避免 Windows 引号转义歧义）。
 * Where-Object 客户端过滤（免 WMI filter 串的双引号）；强设 stdout UTF-8，
 * 兼容命令行含非 ASCII（中文 workspace 路径）的进程。
 */
export const CIM_COMMAND =
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); '
  + "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ZCode.exe' } "
  + '| Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize '
  + '| ConvertTo-Json -Compress -Depth 3';

const CIM_TIMEOUT_MS = 10_000;

/** PS stdout → ProcRow[]；解析失败/空输出返回 []（调用方按失败降级）。 */
export function parseCimRows(stdout: string): ProcRow[] {
  const text = stdout.trim();
  if (text === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list: unknown[] = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' ? [parsed] : [];
  const rows: ProcRow[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const pid = Number(rec['ProcessId']);
    const ws = Number(rec['WorkingSetSize']);
    if (!Number.isSafeInteger(pid) || !Number.isFinite(ws) || ws < 0) continue;
    const ppid = Number(rec['ParentProcessId']);
    rows.push({
      pid,
      ppid: Number.isSafeInteger(ppid) ? ppid : 0,
      name: typeof rec['Name'] === 'string' ? rec['Name'] : '',
      commandLine: typeof rec['CommandLine'] === 'string' ? rec['CommandLine'] : '',
      wsBytes: ws,
    });
  }
  return rows;
}

/**
 * 真采样进程树。成功返回非空行集；失败（非 Windows / powershell 不存在 / 超时 /
 * 退出码非 0 / 输出为空或不可解析）返回 null。空输出按失败处理是 E3 踩坑 1 的
 * 直接对策：插件自身运行时本机至少存在一个 ZCode.exe（插件宿主），「零行」意味着
 * 采样坏了而不是树为空——宁可降级不虚报。
 */
export async function sampleZcodeTree(): Promise<ProcRow[] | null> {
  if (os.platform() !== 'win32') return null;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      // options 显式标 SpawnOptions：避免 TS 把 spawn 的多个重载解析成交集 never
      const options: SpawnOptions = { windowsHide: true, timeout: CIM_TIMEOUT_MS };
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CIM_COMMAND],
        options,
      );
      let out = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });
      child.on('error', reject);
      child.on('close', (code: number | null) => {
        if (code === 0) resolve(out);
        else reject(new Error(`powershell exited ${code ?? 'by-signal'}`));
      });
    });
    const rows = parseCimRows(stdout);
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

// --- 样本与判定 ---------------------------------------------------------------

export interface CapacitySample {
  /** 采样时刻（ms epoch；缓存命中时=首次真采样时刻）。 */
  sampledAt: number;
  totalBytes: number;
  freeBytes: number;
  /** freeBytes/totalBytes ∈ (0,1]。 */
  watermark: number;
  /** 常驻树 WS 合计；CIM 失败时 null（不虚报）。 */
  steadyTreeBytes: number | null;
  /** 瞬态回合树进程数；CIM 失败时 0（degraded 标记真实状态）。 */
  headlessTurnCount: number;
  /** 回合树单进程 WS 峰值；无回合树或 CIM 失败时 null。 */
  headlessTurnMaxRssBytes: number | null;
  /** CIM 失败降级标记；null=进程数据可信。 */
  degraded: 'cim-unavailable' | null;
  /** 诊断附加：分类计数（仅 count>0 的类）；CIM 失败时 absent。 */
  categoryCounts?: Record<string, number>;
}

export type CapacityViolatedRule = 'watermark' | 'session-limit' | 'turn-concurrency';

export interface CapacityVerdict {
  red: boolean;
  violated: CapacityViolatedRule[];
  /** 具体规则与数字（panel 文本直出）。 */
  detail: string[];
}

/**
 * 预警公式（DESIGN §3.3；纯函数，只吃样本不触 os）：
 * - red1：watermark < XC_MEM_WARN_WATERMARK（缺省 0.15）
 * - red2：max(headless-turn 单进程 WS) > XC_MEM_SESSION_LIMIT_BYTES（缺省 800MB）
 * - red3：headlessTurnCount × XC_TURN_ESTIMATE_BYTES > freeBytes（缺省 1.5GB/回合）
 * degraded 样本只评 red1（进程类规则无数据不评），detail 说明降级。
 */
export function judgeCapacity(s: CapacitySample, env: NodeJS.ProcessEnv = process.env): CapacityVerdict {
  const violated: CapacityViolatedRule[] = [];
  const detail: string[] = [];
  const warn = memWarnWatermarkFromEnv(env);
  if (s.watermark < warn) {
    violated.push('watermark');
    detail.push(
      `watermark: 可用内存 ${(s.watermark * 100).toFixed(1)}% < 预警线 ${(warn * 100).toFixed(1)}%`
        + `（XC_MEM_WARN_WATERMARK；可用 ${formatBytes(s.freeBytes)} / 总 ${formatBytes(s.totalBytes)}）`,
    );
  }
  if (s.degraded === null && s.headlessTurnMaxRssBytes !== null) {
    const limit = memSessionLimitBytesFromEnv(env);
    if (s.headlessTurnMaxRssBytes > limit) {
      violated.push('session-limit');
      detail.push(
        `session-limit: headless 回合树单进程峰值 ${formatBytes(s.headlessTurnMaxRssBytes)} > 上限 ${formatBytes(limit)}`
        + '（XC_MEM_SESSION_LIMIT_BYTES）',
      );
    }
  }
  if (s.degraded === null && s.headlessTurnCount > 0) {
    const estimate = turnEstimateBytesFromEnv(env);
    if (s.headlessTurnCount * estimate > s.freeBytes) {
      violated.push('turn-concurrency');
      detail.push(
        `turn-concurrency: 并发 headless 回合 ${s.headlessTurnCount} × 单回合预估 ${formatBytes(estimate)}`
        + ` > 可用 ${formatBytes(s.freeBytes)}（XC_TURN_ESTIMATE_BYTES；建议减少并发回合或让成员休眠）`,
      );
    }
  }
  if (s.degraded === 'cim-unavailable') {
    detail.push('degraded: CIM 进程采样不可用——本轮仅 os 水位参与判定，进程类规则（session-limit/turn-concurrency）未评');
  }
  return { red: violated.length > 0, violated, detail };
}

/** 单行 panel 摘要 + violated detail 行（tools-overview/doctor 直接拼用）。 */
export function formatCapacityLines(s: CapacitySample, verdict: CapacityVerdict): string[] {
  const turnPart = s.headlessTurnMaxRssBytes === null
    ? `${s.headlessTurnCount}`
    : `${s.headlessTurnCount}（峰值 ${formatBytes(s.headlessTurnMaxRssBytes)}）`;
  const lines = [
    `capacity: ${verdict.red ? 'RED' : 'GREEN'} | 水位 ${(s.watermark * 100).toFixed(1)}% 可用`
      + ` | 常驻树 ${s.steadyTreeBytes === null ? 'n/a' : formatBytes(s.steadyTreeBytes)}`
      + ` | 并发回合 ${turnPart}`
      + ` | sampledAt ${new Date(s.sampledAt).toISOString()}`
      + (s.degraded === null ? '' : ` | degraded=${s.degraded}`),
  ];
  for (const d of verdict.detail) lines.push(`  - ${d}`);
  return lines;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.round(n)}B`;
}

// --- 采样与缓存 ---------------------------------------------------------------

/** 缓存文件路径（paths.ts 本版不动，构建器放本模块）：`<.crosschat>/capacity/sample.json`。 */
export function capacityCacheFile(stateRoot: string): string {
  return join(stateRoot, 'capacity', 'sample.json');
}

/** 惰性采样入口（DESIGN §3.3）：窗口期内回缓存，否则真采样并尽力写缓存。 */
export async function sampleCapacity(env: NodeJS.ProcessEnv, cacheFile: string, now: number): Promise<CapacitySample> {
  return sampleCapacityWithSampler(env, cacheFile, now, () => takeFreshSample(now));
}

/** 可注入采样器的内部形态（单测用；生产行为=sampleCapacity）。 */
export async function sampleCapacityWithSampler(
  env: NodeJS.ProcessEnv,
  cacheFile: string,
  now: number,
  sampler: (now: number) => CapacitySample | Promise<CapacitySample>,
): Promise<CapacitySample> {
  const minMs = memSampleMinMsFromEnv(env);
  if (minMs > 0) {
    const cached = await readSampleCache(cacheFile, now, minMs);
    if (cached !== null) return cached;
  }
  const fresh = await sampler(now);
  await writeSampleCache(cacheFile, fresh).catch(() => undefined); // 缓存尽力而为，失败不影响返回
  return fresh;
}

/** 一次真采样（os 水位 + CIM 分类；now 注入保持纯度）。 */
export async function takeFreshSample(now: number = Date.now()): Promise<CapacitySample> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const watermark = totalBytes > 0 ? freeBytes / totalBytes : 1;
  const rows = await sampleZcodeTree();
  if (rows === null) {
    return {
      sampledAt: now,
      totalBytes,
      freeBytes,
      watermark,
      steadyTreeBytes: null,
      headlessTurnCount: 0,
      headlessTurnMaxRssBytes: null,
      degraded: 'cim-unavailable',
    };
  }
  const tree = classifyZcodeProcesses(rows);
  const categoryCounts: Record<string, number> = {};
  for (const [kind, bucket] of Object.entries(tree.categories)) {
    if (bucket.count > 0) categoryCounts[kind] = bucket.count;
  }
  return {
    sampledAt: now,
    totalBytes,
    freeBytes,
    watermark,
    steadyTreeBytes: tree.steadyTreeBytes,
    headlessTurnCount: tree.headlessTurnCount,
    headlessTurnMaxRssBytes: tree.headlessTurnMaxRssBytes,
    degraded: null,
    categoryCounts,
  };
}

async function readSampleCache(cacheFile: string, now: number, minMs: number): Promise<CapacitySample | null> {
  try {
    const text = await readFile(cacheFile, 'utf8');
    const rec = JSON.parse(text) as Record<string, unknown>;
    const sampledAt = Number(rec['sampledAt']);
    const totalBytes = Number(rec['totalBytes']);
    const freeBytes = Number(rec['freeBytes']);
    const watermark = Number(rec['watermark']);
    if (!Number.isFinite(sampledAt) || !Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || !Number.isFinite(watermark)) {
      return null;
    }
    if (sampledAt > now || now - sampledAt >= minMs) return null; // 未来时钟或过期 → 重采样
    const steady = Number(rec['steadyTreeBytes']);
    const maxRss = Number(rec['headlessTurnMaxRssBytes']);
    const turnCount = Number(rec['headlessTurnCount']);
    const rawCounts = rec['categoryCounts'];
    const categoryCounts: Record<string, number> | undefined =
      rawCounts !== null && typeof rawCounts === 'object' && !Array.isArray(rawCounts)
        ? Object.fromEntries(
            Object.entries(rawCounts as Record<string, unknown>)
              .filter(([, v]) => Number.isFinite(Number(v)))
              .map(([k, v]) => [k, Number(v)]),
          )
        : undefined;
    return {
      sampledAt,
      totalBytes,
      freeBytes,
      watermark,
      steadyTreeBytes: rec['steadyTreeBytes'] === null ? null : Number.isFinite(steady) && steady >= 0 ? steady : null,
      headlessTurnCount: Number.isSafeInteger(turnCount) && turnCount >= 0 ? turnCount : 0,
      headlessTurnMaxRssBytes: rec['headlessTurnMaxRssBytes'] === null ? null : Number.isFinite(maxRss) && maxRss >= 0 ? maxRss : null,
      degraded: rec['degraded'] === 'cim-unavailable' ? 'cim-unavailable' : null,
      ...(categoryCounts !== undefined && Object.keys(categoryCounts).length > 0 ? { categoryCounts } : {}),
    };
  } catch {
    return null; // 缺文件/损坏 JSON → 重采样
  }
}

async function writeSampleCache(cacheFile: string, sample: CapacitySample): Promise<void> {
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFileAtomic(cacheFile, `${JSON.stringify(sample, null, 2)}\n`);
}
