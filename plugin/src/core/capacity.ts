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
 * 3. v0.9.2（C1，V091-13 修复）：`--resume` 无头树的归类**不再用命令行形态猜**
 *    （原第⑥步 `zcode.cjs ∧ ¬app-server ∧ ¬--surface` 把 README 文档化的用户 CLI
 *    一并误归 headless-turn，单个 >800MB 的用户 CLI 即把 session-limit 判红、
 *    合法唤醒被静默转 mailbox）——改认**唤醒子标记**（见 {@link WAKE_CHILD_COMMAND_MARKER}
 *    与 {@link WAKE_CHILD_ENV_MARKER} 注释：env 标记由 spawnResume 注入、CIM 读不到，
 *    故归类判据取命令行可见的同族证据）。
 *
 * 无定时器纪律：只在 xc_overview/xc_doctor 调用时惰性采样，缓存文件
 * `.crosschat/capacity/sample.json` 最小间隔 XC_MEM_SAMPLE_MIN_MS（缺省 60s），
 * 窗口期内回缓存——但设备水位字段（totalBytes/freeBytes/watermark）会与
 * `os.freemem()` 实时交叉复核（C9-B3 修复）：缓存只省进程树采样成本，不为
 * 伪造/陈新缓存制造最长一个窗口的虚假读数（sampledAt 仍标注进程树真采样时刻）。
 *
 * 判定纯函数 judgeCapacity 只吃样本（不触 os）——detail 给出具体 violated 规则与
 * 数字，供 panel 文本与测试断言。CIM 失败降级：只报 os 水位 + degraded:
 * "cim-unavailable"，进程类数据一律 null/0 不虚报（安全底线）。
 *
 * 路径注意：缓存路径由调用方传入；`capacityCacheFile(stateRoot)` 产出
 * `<.crosschat>/capacity/sample.json`（paths.ts 本版不动，构建器放本模块）。
 *
 * v0.9.3（37-v093 方案 §一 组B B1/B4）增量：容量三旋钮（warn_watermark /
 * turn_estimate_bytes / wake_gate）的**分层生效值**（file=config.json capacity 段 >
 * env > 内置默认；每次现读、畸形逐层披露）与配置生效值状态真源
 * （`capacity/config-state.json`，B4 变更事件的对拍基线）——见本模块
 * {@link resolveCapacityThresholds} / {@link diffCapacityConfigState}。
 *
 * @module core/capacity
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
// v0.10.0（组 D / R7）：唤醒生命周期账本的目录（logs/wake-lifecycle-<member>-<ts>.jsonl）。
import { logsDir } from './paths.js';
// v0.9.2（C1）：唤醒子命令行标记 = 唤醒 prompt 的冻结回执前缀（单一真源，不另抄字面量）。
import { RECEIPT_PREFIX } from './mailbox.js';
// v0.9.3（B1）：capacity 分层配置的 file 层解析（core/config.ts 只依赖 M1 paths/types，
// 无反向依赖——不成环）。
import { readWorkspaceConfigFile } from './config.js';

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

/**
 * red1 阈值信息（v0.8.1，29 能力反向检验 C4-O1 修复）：`XC_MEM_WARN_WATERMARK` 合法域
 * **(0,1)**——红队实测越界值（`1`/`1.5`/`2`/`0`/`-5`/非数字）此前全部**静默**按缺省
 * 0.15 判定（字面执行 `watermark < 2` 应恒 RED），运维无法分辨「我没配」与「我配了
 * 但值被拒」。现在显式分辨：`fellBack` = env 有值但越界 → 回落内置缺省并由挂载面
 * （capacityMount / doctor）附 WARNING + payload `memWarnWatermarkFallback:true`；
 * 两者皆否（未设/空串）= 就是缺省 0.15，无需披露。合法域内取值精细生效（不钳）。
 */
export interface MemWarnWatermarkInfo {
  watermark: number;
  fellBack: boolean;
}

export function memWarnWatermarkInfoFromEnv(env: NodeJS.ProcessEnv = process.env): MemWarnWatermarkInfo {
  const raw = env['XC_MEM_WARN_WATERMARK'];
  const provided = typeof raw === 'string' && raw.trim() !== '';
  const n = provided ? Number(raw) : Number.NaN;
  const valid = Number.isFinite(n) && n > 0 && n < 1;
  return { watermark: valid ? n : MEM_WARN_WATERMARK_DEFAULT, fellBack: provided && !valid };
}

/** red1 阈值：XC_MEM_WARN_WATERMARK，合法域 (0,1)，非法/未设 → 0.15（披露见 info 版）。 */
export function memWarnWatermarkFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return memWarnWatermarkInfoFromEnv(env).watermark;
}

/**
 * red1 阈值越界时的挂载面 WARNING（v0.8.1 C4-O1 修复；capacityMount/doctor/status
 * 三处同一句——与 offline/stall 家族的回落 WARNING 同款两级披露口径）。
 */
export const MEM_WATERMARK_FALLBACK_WARNING =
  'WARNING XC_MEM_WARN_WATERMARK 越界（须为 (0,1) 内的有限数；0/负数/≥1/非数字不被接受）'
  + `——已回落内置缺省 ${MEM_WARN_WATERMARK_DEFAULT}（可用内存占比预警线）；如只想用缺省值请取消该 env 设置`;

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

// --- v0.9.3（B1）capacity 分层配置：file（config.json capacity 段）> env > 内置默认 ----------

/**
 * v0.9.3（37-v093 方案 §一 组B B1）：容量闸三旋钮的**分层生效值**解析。
 *
 * 三键与 config.json `capacity` 段、既有 env 一一对应（键名用配置文件的 snake_case，
 * 与事件/状态文件的机器可读面一致）：
 * - `warn_watermark`：red1 预警线（env `XC_MEM_WARN_WATERMARK`，合法域 (0,1)，缺省 0.15）；
 * - `turn_estimate_bytes`：单回合预估（env `XC_TURN_ESTIMATE_BYTES`，>0，缺省 1.5GB）；
 * - `wake_gate`：容量闸开关（env `XC_MEM_WAKE_GATE`，`off`=关，缺省开）。
 *
 * 纪律（与唤醒分层 file > env > 默认同款）：
 * - **每次现读**（config.json 无缓存）——改文件即热生效，不需要重启（G-6 核心诉求）；
 * - **畸形逐层披露**：file 层逐键畸形（core/config.ts 已判）+ env 层越界/非法
 *   （`fellBack` 家族同款两级口径的第一级）都进 {@link CapacityThresholds.warnings}，
 *   由唤醒闸面落 engine 事件、观测面进 payload——绝不静默；
 * - **0 新增必填**：三段全部可选，任何一层缺席都照默认工作。
 */
export type CapacityConfigSource = 'file' | 'env' | 'default';

/** capacity 配置键名（config.json 段内的 snake_case；事件与状态文件同款）。 */
export type CapacityConfigKey = 'warn_watermark' | 'turn_estimate_bytes' | 'wake_gate';

export interface CapacityThresholds {
  /** red1 生效预警线（占比）。 */
  warnWatermark: number;
  /** 单回合预估生效字节。 */
  turnEstimateBytes: number;
  /** spawn 前容量闸生效开关（false = 关闸，回到「只警不拦」）。 */
  wakeGate: boolean;
  /** 每个键的生效来源（诊断：这次判定听谁的）。 */
  sources: Record<CapacityConfigKey, CapacityConfigSource>;
  /** 逐层畸形/越界披露（file 键畸形 + env 非法；空数组 = 各层都干净）。 */
  warnings: string[];
  /** 仅 file 层披露（capacity 段逐键畸形）——容量闸面落 `config-malformed` 事件用，
   * 与 env 层披露分开（后者在观测面已有 memWarnWatermarkFallback 两级通道）。 */
  fileWarnings: string[];
  /** env 原值（未设/空串 = null——「没配」与「配错」可分辨，V091-18 同款口径）。 */
  envRaw: Record<CapacityConfigKey, string | null>;
  /** file 层 capacity 段是否在场（含畸形在场；诊断用）。 */
  fileCapacityPresent: boolean;
}

/** 容量键的人可读来源标签（detail 文案用：值来自哪一层就写哪一层，不虚标 env 名）。 */
export function capacityThresholdLabel(key: CapacityConfigKey, source: CapacityConfigSource): string {
  const envName = key === 'warn_watermark' ? 'XC_MEM_WARN_WATERMARK'
    : key === 'turn_estimate_bytes' ? 'XC_TURN_ESTIMATE_BYTES'
      : 'XC_MEM_WAKE_GATE';
  return source === 'file' ? `config.json capacity.${key}` : envName;
}

/** env 层的 turn_estimate_bytes 信息（合法 >0 才生效；非法/未设回落缺省并标记）。 */
export function turnEstimateBytesInfoFromEnv(env: NodeJS.ProcessEnv = process.env): { value: number; fellBack: boolean } {
  const raw = env['XC_TURN_ESTIMATE_BYTES'];
  const provided = typeof raw === 'string' && raw.trim() !== '';
  const n = provided ? Number(raw) : Number.NaN;
  const valid = Number.isFinite(n) && n > 0;
  return { value: valid ? n : TURN_ESTIMATE_DEFAULT_BYTES, fellBack: provided && !valid };
}

/**
 * 分层解析容量三旋钮（每次现读；唤醒闸与 overview 挂载共用同一真源）。
 *
 * env 层判据与既有纯 env 函数**逐字一致**（`memWarnWatermarkInfoFromEnv` /
 * `turnEstimateBytesInfoFromEnv` / `wakeCapacityGateEnabledFromEnv` 的语义平移）——
 * 本函数只叠加 file 层与披露，不改变任何一层的既有取值行为。
 */
export function resolveCapacityThresholds(
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CapacityThresholds {
  const file = readWorkspaceConfigFile(stateRoot);
  const section = file.capacity;
  const fileWarnings: string[] = [...(section?.warnings ?? [])];
  const warnings: string[] = [...fileWarnings];

  // warn_watermark：file > env > 0.15
  const envWatermark = memWarnWatermarkInfoFromEnv(env);
  const warnWatermark = section?.warnWatermark ?? envWatermark.watermark;
  const watermarkSource: CapacityConfigSource =
    section?.warnWatermark !== undefined ? 'file' : envWatermark.fellBack ? 'default' : env['XC_MEM_WARN_WATERMARK'] !== undefined && String(env['XC_MEM_WARN_WATERMARK']).trim() !== '' ? 'env' : 'default';
  if (section?.warnWatermark === undefined && envWatermark.fellBack) warnings.push(MEM_WATERMARK_FALLBACK_WARNING);

  // turn_estimate_bytes：file > env > 1.5GB
  const envEstimate = turnEstimateBytesInfoFromEnv(env);
  const turnEstimateBytes = section?.turnEstimateBytes ?? envEstimate.value;
  const estimateSource: CapacityConfigSource =
    section?.turnEstimateBytes !== undefined ? 'file' : envEstimate.fellBack ? 'default' : env['XC_TURN_ESTIMATE_BYTES'] !== undefined && String(env['XC_TURN_ESTIMATE_BYTES']).trim() !== '' ? 'env' : 'default';
  if (section?.turnEstimateBytes === undefined && envEstimate.fellBack) {
    warnings.push(
      `WARNING XC_TURN_ESTIMATE_BYTES 非法（须为 >0 的有限数；0/负数/非数字不被接受）`
      + `——已回落内置缺省 ${TURN_ESTIMATE_DEFAULT_BYTES}（单回合预估字节；v0.9.1 起兼作容量闸边际预估判据）；如只想用缺省值请取消该 env 设置`,
    );
  }

  // wake_gate：file > env（off=关）> 默认开
  const rawGate = env['XC_MEM_WAKE_GATE'];
  const gateProvided = typeof rawGate === 'string' && rawGate.trim() !== '';
  const envGate = gateProvided ? rawGate.trim().toLowerCase() !== 'off' : undefined;
  const wakeGate = section?.wakeGate ?? envGate ?? true;
  const gateSource: CapacityConfigSource =
    section?.wakeGate !== undefined ? 'file' : envGate !== undefined ? 'env' : 'default';

  const envRaw = (key: CapacityConfigKey): string | null => {
    const raw = env[key === 'warn_watermark' ? 'XC_MEM_WARN_WATERMARK' : key === 'turn_estimate_bytes' ? 'XC_TURN_ESTIMATE_BYTES' : 'XC_MEM_WAKE_GATE'];
    return raw === undefined || raw.trim() === '' ? null : raw;
  };

  return {
    warnWatermark,
    turnEstimateBytes,
    wakeGate,
    sources: {
      warn_watermark: watermarkSource,
      turn_estimate_bytes: estimateSource,
      wake_gate: gateSource,
    },
    warnings,
    fileWarnings,
    envRaw: {
      warn_watermark: envRaw('warn_watermark'),
      turn_estimate_bytes: envRaw('turn_estimate_bytes'),
      wake_gate: envRaw('wake_gate'),
    },
    fileCapacityPresent: section !== undefined,
  };
}

// --- v0.9.3（B4）配置生效值状态真源（capacity/config-state.json）---------------------------

/**
 * B4 的状态文件：`<stateRoot>/capacity/config-state.json`——上次现读的容量三键生效值。
 * 用途 = 变更对拍的基线（防刷屏）：每次现读与上次比对，只在实际变化时落事件。
 * 与 wake-deferred.json / watchdog-state.json 同族：capacity/ 目录内、原子整文件、
 * 损坏按「无历史」重立基线（观测面永不因状态文件坏掉而停止工作）。
 */
export function capacityConfigStateFile(stateRoot: string): string {
  return join(dirname(capacityCacheFile(stateRoot)), 'config-state.json');
}

/** config-state.json 形状（version 1）。 */
export interface CapacityConfigState {
  version: 1;
  /** 上次观测时刻（epoch ms）。 */
  observedAt: number;
  /** 三键上次生效值（缺失键 = 从未收录，按 undefined 处理）。 */
  values: Record<CapacityConfigKey, number | boolean | undefined>;
  /** 三键上次生效来源。 */
  sources: Record<CapacityConfigKey, CapacityConfigSource | undefined>;
}

/** 一条生效值变更（B4 事件 `config-effective-changed` 的字段来源）。 */
export interface CapacityConfigChange {
  key: CapacityConfigKey;
  /** 上次生效值（null = 状态文件里没有该键的历史）。 */
  from: number | boolean | null;
  /** 本次生效值。 */
  to: number | boolean;
  /** 本次生效来源（file/env/default）。 */
  source: CapacityConfigSource;
}

/** 读状态（损坏/版本不匹配/缺字段 → null = 无历史）。永不抛。 */
export async function readCapacityConfigState(stateRoot: string): Promise<CapacityConfigState | null> {
  try {
    const parsed = JSON.parse(await readFile(capacityConfigStateFile(stateRoot), 'utf8')) as Record<string, unknown>;
    if (parsed['version'] !== 1) return null;
    const values = parsed['values'];
    const sources = parsed['sources'];
    if (values === null || typeof values !== 'object' || Array.isArray(values)) return null;
    return {
      version: 1,
      observedAt: Number.isFinite(Number(parsed['observedAt'])) ? Number(parsed['observedAt']) : 0,
      values: values as CapacityConfigState['values'],
      sources: (sources !== null && typeof sources === 'object' && !Array.isArray(sources)
        ? sources
        : {}) as CapacityConfigState['sources'],
    };
  } catch {
    return null;
  }
}

/** 写状态（原子整文件；best-effort——失败不阻断唤醒判定，最坏下次重立基线）。 */
export async function writeCapacityConfigState(stateRoot: string, state: CapacityConfigState): Promise<void> {
  try {
    await mkdir(dirname(capacityConfigStateFile(stateRoot)), { recursive: true });
    await writeFileAtomic(capacityConfigStateFile(stateRoot), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* best-effort 台账 */
  }
}

/**
 * B4：现读生效值 ↔ 上次状态比对（防刷屏的真源）。
 *
 * 语义：
 * - **无历史**（缺文件/损坏/版本不匹配）→ 静默立基线（写当前值、返回空数组）——
 *   首次观测不是「变更」，不惊动运营面；
 * - 有历史且某键生效值不同 → 该键进 {@link CapacityConfigChange}（from/to/source），
 *   状态整体前移（observedAt=now）；
 * - 无变化 → 不写文件、返回空数组（零事件零 IO）。
 *
 * 调用方（engine/wake.ts 容量闸段）把返回的 changes 逐条落
 * `config-effective-changed{key, from, to, source}` 事件。
 */
export async function diffCapacityConfigState(
  stateRoot: string,
  thresholds: CapacityThresholds,
  now: number = Date.now(),
): Promise<CapacityConfigChange[]> {
  const previous = await readCapacityConfigState(stateRoot);
  const current: CapacityConfigState = {
    version: 1,
    observedAt: now,
    values: {
      warn_watermark: thresholds.warnWatermark,
      turn_estimate_bytes: thresholds.turnEstimateBytes,
      wake_gate: thresholds.wakeGate,
    },
    sources: { ...thresholds.sources },
  };
  if (previous === null) {
    await writeCapacityConfigState(stateRoot, current); // 首访立基线，无事件
    return [];
  }
  const changes: CapacityConfigChange[] = [];
  for (const key of ['warn_watermark', 'turn_estimate_bytes', 'wake_gate'] as const) {
    const to = current.values[key];
    const from = previous.values[key];
    if (to === undefined) continue;
    if (from === to) continue;
    changes.push({ key, from: from ?? null, to, source: current.sources[key] ?? 'default' });
  }
  if (changes.length === 0) return []; // 不变更：零事件、零写入
  await writeCapacityConfigState(stateRoot, current);
  return changes;
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
 * 唤醒子进程的 **env 标记键/值**（v0.9.2 C1）：`spawnResume`
 * （engine/resume-cli.ts）注入 `XC_WAKE_CHILD=1`，经 helper 的 env 转发直达无头
 * `--resume` 唤醒子进程。它是「这是唤醒子」的进程内可验证凭据（同进程可读子进程 env），
 * **但不是采样器的判据**——见 {@link WAKE_CHILD_COMMAND_MARKER} 的平台事实。
 */
export const WAKE_CHILD_ENV_MARKER = 'XC_WAKE_CHILD';
export const WAKE_CHILD_ENV_VALUE = '1';

/**
 * 唤醒子进程的**命令行标记**（v0.9.2 C1；归类判据取它，不取 env 标记）。
 *
 * 平台事实：`Win32_Process`（CIM）读不到别的进程的环境变量——env 标记对采样器不可见，
 * 按 env 归类在本平台做不到（不签名、不注入、不读他人内存，均越出威胁模型与权限面）。
 * 而同一次唤醒的 prompt 恒以 DESIGN §2.4 冻结的回执前缀开头（core/mailbox.ts
 * `RECEIPT_PREFIX`，只由唤醒路径组装），该前缀随 `--prompt` 进命令行 → CIM 可见。
 * 两层标记指向同一个进程、同一个语义，故命令行标记是 env 标记在采样面的投影。
 *
 * 与原第⑥步（`zcode.cjs ∧ ¬app-server ∧ ¬--surface`）的差别是**方向相反的失败模式**：
 * 旧规则把 README 文档化的用户 CLI（`zc/zc` 壳函数随手跑的 `zcode.cjs --resume … -p`、
 * `zcode.cjs --version`）误判成回合树 → session-limit 误红、合法唤醒被静默转 mailbox
 * （V091-13 实测）；新规则对无标记的 `--resume` 命令行归 main（漏计并发回合），
 * 只削弱 red2/red3 的灵敏度，不再制造假红——容量闸的失败方向必须是「漏」不是「误伤」。
 */
export const WAKE_CHILD_COMMAND_MARKER = RECEIPT_PREFIX;

/** 命令行是否带唤醒子标记（{@link WAKE_CHILD_COMMAND_MARKER}；供测试与诊断复用）。 */
export function isWakeChildCommandLine(commandLine: unknown): boolean {
  return typeof commandLine === 'string' && commandLine.includes(WAKE_CHILD_COMMAND_MARKER);
}

/**
 * 单进程分类（E3 ps-procs.ps1 判定顺序 1:1 平移；顺序即语义，勿重排）：
 * ①**唤醒子标记优先**（v0.9.2 C1：命令行带唤醒回执前缀即 headless-turn，先于一切
 *    形态规则——标记是结论，不参与后续比较）→ ②默认 main → ③`--type=` 归 shell
 *    （renderer/gpu/utility/…）→ ④`--utility-sub-type=` 归 cli-utility →
 *    ⑤`__zcode-plugin-host` 归 plugin-host → ⑥`app-server` 归 appserver（带
 *    `--surface`=desktop-appserver，否则 headless-appserver=provision 临时 keeper）。
 *    v0.9.2 起**删除**原第⑥步之后的「`zcode.cjs ∧ ¬app-server ∧ ¬--surface` 猜回合树」
 *    规则（V091-13：用户 CLI 与唤醒子命令行同形，猜错即误伤合法唤醒）。
 */
export function classifyProcess(row: ProcRow): CapacityKind {
  const cl = typeof row.commandLine === 'string' ? row.commandLine : '';
  if (isWakeChildCommandLine(cl)) return 'headless-turn';
  let kind: CapacityKind = 'main';
  if (/--type=([\w.-]+)/.test(cl)) kind = 'shell';
  if (/--utility-sub-type=([\w.]+)/.test(cl)) kind = 'cli-utility';
  if (cl.includes('__zcode-plugin-host')) kind = 'plugin-host';
  if (cl.includes('app-server')) {
    kind = cl.includes('--surface') ? 'desktop-appserver' : 'headless-appserver';
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
  /** 瞬态回合树进程数；CIM 失败时 0 **且** degraded 在场——此 0 不是「此刻没有回合」的
   *  断言（面板文本同口径显示 n/a，见 {@link formatCapacityLines}）。 */
  headlessTurnCount: number;
  /** 回合树单进程 WS 峰值；无回合树或 CIM 失败时 null。 */
  headlessTurnMaxRssBytes: number | null;
  /** CIM 失败降级标记；null=进程数据可信。 */
  degraded: 'cim-unavailable' | null;
  /** 诊断附加：分类计数（仅 count>0 的类）；CIM 失败时 absent。 */
  categoryCounts?: Record<string, number>;
  /**
   * v0.10.0（组 D / R7）：**每棵无头进程树**的记账（成员键 + 根 pid + 工作集字节 +
   * 空闲分钟数）。按唤醒生命周期账本（logs/wake-lifecycle-<member>-<ts>.jsonl）里
   * helper 汇报的唤醒子 pid 找进程及其子孙，汇总工作集。
   *
   * 纪律（写死）：
   * - **只记账，不做任何清理或终止**——本字段不参与 judgeCapacity 的任何判定，
   *   未来清扫器要动树须自行叠加「任务在途状态」等判据（R7 建议修法的后半段，
   *   本版明确不做）；
   * - 采样失败时**缺席**并如实标注：CIM 失败 → 与 degraded:'cim-unavailable' 同帧
   *   （进程类数据整体不可信）；生命周期账本读失败 → {@link memberTreesError}
   *   带原因。绝不让记账失败拖垮整个容量采样；
   * - 缓存命中时取缓存值（与 headlessTurnCount 等进程类字段同纪律——缓存只省
   *   CIM 成本，窗口 ≤ XC_MEM_SAMPLE_MIN_MS 缺省 60s，sampledAt 标注真采样时刻）；
   * - absent = 旧样本（v0.9.10 之前落盘）/ CIM 不可用 / 账本不可读 / 无在册唤醒树。
   */
  memberTrees?: MemberTreeSample[];
  /** memberTrees 缺席的原因（账本读取意外；CIM 失败走 degraded，不走本键）。 */
  memberTreesError?: string;
}

/**
 * v0.10.0（组 D / R7）：一棵无头进程树的记账条目。
 *
 * `idleMin` 的口径与诚实边界（写死）：**距该唤醒树最近一条生命周期账**
 * （spawn 头行 / 启动确认 / 消费确认 / 退出观察）的分钟数。账本只在生命周期事件
 * 落行，因此对正在跑回合的树它≈「回合已进行分钟数」——它不是「任务空闲」的判据
 * （任务在途看任务板），只是树上最后一次引擎侧观察至今的时长；未来清扫器要判
 * 「空闲树」必须再叠加任务板在途状态（R7 原文的「无在途任务、idle 超 N 分钟」），
 * 本字段不承担该判定。
 */
export interface MemberTreeSample {
  /** 成员键（花名册键；= 账本行里的 `to`）。 */
  member: string;
  /** 唤醒子根 pid（helper 汇报的启动证据；账本 `wake-child-start-confirmed` 行）。 */
  rootPid: number;
  /** 进程树工作集合计（字节；根进程 + 采样集内全部子孙，见 {@link memberTreesFromLedger}）。 */
  bytes: number;
  /** 距本棵唤醒树最近一条生命周期账的分钟数（口径见上方接口注释）。 */
  idleMin: number;
}

/** capacity 文本面列出占用最大的几棵（R7「看门狗或清扫器可按阈值处理」的前置观测）。 */
export const MEMBER_TREES_TOP_N = 3;

/** 一条生命周期账文件提炼出的「候选树」（已排除已观察到退出的账）。 */
export interface WakeTreeLedgerEntry {
  /** 成员键（账本行 `to`；缺失时回落文件名分组）。 */
  member: string;
  /** helper 汇报的唤醒子 pid（启动确认行）。 */
  rootPid: number;
  /** 该账本全部行的最大 ts（idleMin 的基准）。 */
  lastTs: number;
}

/**
 * v0.10.0（组 D / R7）：扫 logs/ 下的唤醒生命周期账本，提炼候选进程树。
 *
 * 形状与 engine/wake.ts readDeliveryAttemptLedger 的反解同源（贪婪分组 + 锚定
 * 数字尾段，成员键含连字符/数字也不误判）：
 * - 只收**带启动确认 pid**（`wake-child-start-confirmed` 行的 `pid`）且**没有**
 *   `wake-child-exit` 行的账——前者是「哪棵树」的唯一机器可分辨证据，后者表示
 *   引擎已观察到唤醒子消失（进程已亡，无从汇总工作集）；
 * - `lastTs` = 账本内最大 ts（坏行跳过；文件不可读按无此账）。
 * 任何目录级读取意外向上抛（调用方 takeFreshSample 转成 memberTreesError）。
 */
export async function readWakeTreeLedger(stateRoot: string): Promise<WakeTreeLedgerEntry[]> {
  const dir = logsDir(stateRoot);
  const entries: WakeTreeLedgerEntry[] = [];
  const pattern = /^wake-lifecycle-(.+)-(\d+)\.jsonl$/;
  for (const file of await readdir(dir)) {
    const matched = pattern.exec(file);
    if (matched === null) continue;
    let text: string;
    try {
      text = await readFile(join(dir, file), 'utf8');
    } catch {
      continue; // 单本账读失败不影响其余账（观测面尽力而为）
    }
    let member: string | undefined;
    let rootPid: number | undefined;
    let rootPidTs = -1;
    let lastTs = 0;
    let exited = false;
    for (const raw of text.split(/\r?\n/)) {
      if (raw.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // 坏行不影响判据
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const rec = parsed as Record<string, unknown>;
      const ts = rec['ts'];
      if (typeof ts === 'number' && Number.isFinite(ts) && ts > lastTs) lastTs = ts;
      const to = rec['to'];
      if (member === undefined && typeof to === 'string' && to.trim() !== '') member = to;
      const event = rec['event'];
      if (event === 'wake-child-exit') {
        exited = true;
        continue;
      }
      if (event === 'wake-child-start-confirmed') {
        const pid = rec['pid'];
        const tsOk = typeof ts === 'number' && Number.isFinite(ts) ? ts : 0;
        if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && tsOk >= rootPidTs) {
          rootPid = pid;
          rootPidTs = tsOk;
        }
      }
    }
    if (exited || rootPid === undefined) continue; // 已退出/无启动证据：不计树
    entries.push({ member: member ?? matched[1]!, rootPid, lastTs });
  }
  return entries;
}

/**
 * v0.10.0（组 D / R7）：候选树 + CIM 进程行 → 每棵树的工作集合计（纯函数）。
 *
 * 汇总口径：根进程 + 采样集内**全部子孙**（按 ppid 图 BFS；自环防御 + 访问集合防
 * 环）。根 pid 不在采样集（进程已亡 / 非 ZCode 宿主形态 / CIM 漏采）→ 该树不计
 * （不虚报 0 字节的树——「0」会被读成「这棵树没占内存」的断言）。结果按字节降序
 * （占用最大的在前，供文本面 Top-N 与 payload 同序）。
 */
export function memberTreesFromLedger(
  rows: readonly ProcRow[],
  entries: readonly WakeTreeLedgerEntry[],
  now: number,
): MemberTreeSample[] {
  const byPid = new Map<number, ProcRow>();
  const children = new Map<number, number[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (row.ppid === row.pid) continue; // 自环防御
    const list = children.get(row.ppid);
    if (list === undefined) children.set(row.ppid, [row.pid]);
    else list.push(row.pid);
  }
  const out: MemberTreeSample[] = [];
  for (const entry of entries) {
    if (!byPid.has(entry.rootPid)) continue; // 根进程不在采样集：不计（不虚报）
    let bytes = 0;
    const seen = new Set<number>();
    const queue: number[] = [entry.rootPid];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const row = byPid.get(pid);
      if (row !== undefined) bytes += row.wsBytes;
      for (const child of children.get(pid) ?? []) {
        if (!seen.has(child)) queue.push(child);
      }
    }
    out.push({
      member: entry.member,
      rootPid: entry.rootPid,
      bytes,
      idleMin: Math.max(0, Math.floor((now - entry.lastTs) / 60_000)),
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
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
 * - red1：watermark < 预警线（缺省 0.15）
 * - red2：max(headless-turn 单进程 WS) > 上限（缺省 800MB）
 * - red3：headlessTurnCount × 单回合预估 > freeBytes（缺省 1.5GB/回合）
 * degraded 样本只评 red1（进程类规则无数据不评），detail 说明降级。
 *
 * v0.9.3（B1）：`thresholds` 可选传入分层生效值（`resolveCapacityThresholds` 的产物）——
 * 传入时 red1/red3 的阈值与 detail 里的来源标签都听分层的（file 层在场时写
 * config.json 而不是 env 名，不虚标）；缺省 = 既有 env 口径（零行为变化）。
 */
export function judgeCapacity(
  s: CapacitySample,
  env: NodeJS.ProcessEnv = process.env,
  thresholds?: Pick<CapacityThresholds, 'warnWatermark' | 'turnEstimateBytes' | 'sources'>,
): CapacityVerdict {
  const violated: CapacityViolatedRule[] = [];
  const detail: string[] = [];
  const warn = thresholds?.warnWatermark ?? memWarnWatermarkFromEnv(env);
  const warnLabel = thresholds === undefined
    ? 'XC_MEM_WARN_WATERMARK'
    : capacityThresholdLabel('warn_watermark', thresholds.sources.warn_watermark);
  if (s.watermark < warn) {
    violated.push('watermark');
    detail.push(
      `watermark: 可用内存 ${(s.watermark * 100).toFixed(1)}% < 预警线 ${(warn * 100).toFixed(1)}%`
        + `（${warnLabel}；可用 ${formatBytes(s.freeBytes)} / 总 ${formatBytes(s.totalBytes)}）`,
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
    const estimate = thresholds?.turnEstimateBytes ?? turnEstimateBytesFromEnv(env);
    const estimateLabel = thresholds === undefined
      ? 'XC_TURN_ESTIMATE_BYTES'
      : capacityThresholdLabel('turn_estimate_bytes', thresholds.sources.turn_estimate_bytes);
    if (s.headlessTurnCount * estimate > s.freeBytes) {
      violated.push('turn-concurrency');
      detail.push(
        `turn-concurrency: 并发 headless 回合 ${s.headlessTurnCount} × 单回合预估 ${formatBytes(estimate)}`
        + ` > 可用 ${formatBytes(s.freeBytes)}（${estimateLabel}；建议减少并发回合或让成员休眠）`,
      );
    }
  }
  if (s.degraded === 'cim-unavailable') {
    detail.push('degraded: CIM 进程采样不可用——本轮仅 os 水位参与判定，进程类规则（session-limit/turn-concurrency）未评');
  }
  return { red: violated.length > 0, violated, detail };
}

/**
 * C9 压缩联动建议行（DESIGN-V0.7.md §5）：verdict.red 时由 formatCapacityLines
 * 追加——「预警 + 建议 + 落盘副本」最小闭环。**建议级非拦截级**：平台无宿主压缩
 * 钩子接口，插件不能拦截/触发压缩，只能提醒先落 journal 再接受压缩。
 * team/panel 两视图都经 tools-overview.ts 的 capacityMount → 改一处两处生效。
 */
export const COMPRESS_ADVICE_LINE =
  'compress-advice: 容量预警——先按 longtask checklist 落 journal'
  + '（.crosschat/tasks/<taskId>/journal.md）再接受压缩；'
  + 'lead 可 relay 要求目标先 xc_report(status:"in_progress") 附 journal 路径';

/** 单行 panel 摘要 + violated detail 行 + C9 压缩建议行（tools-overview/doctor 直接拼用）。 */
export function formatCapacityLines(s: CapacitySample, verdict: CapacityVerdict): string[] {
  // v0.9.2（C2）：degraded 样本的并发回合显示 n/a 而不是 0——「并发回合 0」会被读成
  // 「此刻没有无头回合」的断言，而 CIM 失败时这个数根本不可知（不虚报口径）。
  const turnPart = s.degraded !== null
    ? 'n/a（CIM 进程采样不可用，未评）'
    : s.headlessTurnMaxRssBytes === null
      ? `${s.headlessTurnCount}`
      : `${s.headlessTurnCount}（峰值 ${formatBytes(s.headlessTurnMaxRssBytes)}）`;
  const steadyPart = s.degraded !== null
    ? 'n/a（CIM 进程采样不可用，未评）'
    : s.steadyTreeBytes === null ? 'n/a' : formatBytes(s.steadyTreeBytes);
  const lines = [
    `capacity: ${verdict.red ? 'RED' : 'GREEN'} | 水位 ${(s.watermark * 100).toFixed(1)}% 可用`
      + ` | 常驻树 ${steadyPart}`
      + ` | 并发回合 ${turnPart}`
      + ` | sampledAt ${new Date(s.sampledAt).toISOString()}`
      + (s.degraded === null ? '' : ` | degraded=${s.degraded}`),
  ];
  for (const d of verdict.detail) lines.push(`  - ${d}`);
  // v0.10.0（组 D / R7）：每棵无头进程树的记账（占用最大的前 MEMBER_TREES_TOP_N 棵）。
  // 只在采样成功且账本可读时出现（memberTrees 在场）；absent = 不占行（旧样本 /
  // CIM 失败 / 账本不可读——后者由 payload 的 memberTreesError 带原因）。
  if (s.memberTrees !== undefined && s.memberTrees.length > 0) {
    // 防御性排序：memberTreesFromLedger 产出恒降序，但缓存/外部写入不保证——
    // 「Top N」的语义必须由展示层自己成立（拷贝排序，不改调用方数组）。
    const sorted = [...s.memberTrees].sort((a, b) => b.bytes - a.bytes);
    const top = sorted.slice(0, MEMBER_TREES_TOP_N);
    const detail = top
      .map((t) => `${t.member}=${formatBytes(t.bytes)}(pid ${t.rootPid}, idle ${t.idleMin}min)`)
      .join(", ");
    const more = s.memberTrees.length > top.length ? ` 等 ${s.memberTrees.length} 棵` : '';
    lines.push(`  - 回合树 Top${top.length}: ${detail}${more}（按唤醒生命周期账本 pid 汇总；只记账不清理）`);
  }
  // C9（DESIGN-V0.7.md §5）：标红才给压缩建议行——绿样本不噪声化面板。
  if (verdict.red) lines.push(COMPRESS_ADVICE_LINE);
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

/** 实时设备水位读数（os.totalmem/os.freemem；单测经 osReader 缝注入，保持纯度）。 */
export interface OsWatermark {
  totalBytes: number;
  freeBytes: number;
}

export function readOsWatermark(): OsWatermark {
  return { totalBytes: os.totalmem(), freeBytes: os.freemem() };
}

function watermarkOf(totalBytes: number, freeBytes: number): number {
  return totalBytes > 0 ? freeBytes / totalBytes : 1;
}

/** 惰性采样入口（DESIGN §3.3）：窗口期内回缓存，否则真采样并尽力写缓存。
 *
 * v0.10.0（组 D / R7）：stateRoot 从 cacheFile 反解（`<stateRoot>/capacity/sample.json`）
 * 传给真采样——进程树记账要读 `<stateRoot>/logs/` 下的唤醒生命周期账本。反解不出
 * （异常 cacheFile 形状）→ 不传（memberTrees 缺席，其余字段行为不变）。
 */
export async function sampleCapacity(env: NodeJS.ProcessEnv, cacheFile: string, now: number): Promise<CapacitySample> {
  return sampleCapacityWithSampler(env, cacheFile, now, () => takeFreshSample(now, stateRootFromCacheFile(cacheFile)));
}

/** cacheFile（`<stateRoot>/capacity/sample.json`）→ stateRoot；形状异常返回 undefined（不猜）。 */
function stateRootFromCacheFile(cacheFile: string): string | undefined {
  const dir = dirname(cacheFile); // <stateRoot>/capacity
  const root = dirname(dir); // <stateRoot>
  return root === dir ? undefined : root;
}

/**
 * 可注入采样器的内部形态（单测用；生产行为=sampleCapacity）。
 *
 * v0.7.2（C9-B3 修复，25-能力反向检验）：窗口期内缓存命中时，样本的**设备水位字段**
 * （totalBytes/freeBytes/watermark）与 `os.freemem()` 实时交叉复核后刷新——缓存只省
 * 进程树（CIM/PowerShell）采样成本，绝不被逐字信任到能制造虚假读数的地步。此前一条
 * 伪造/陈新的缓存可在整个 `XC_MEM_SAMPLE_MIN_MS`（缺省 60s）窗口内把面板钉成假 GREEN
 * （漏报）或假 RED（误报），而采样器自己本来就会调 `os.freemem()`，成本仅一次系统调用。
 * 进程树字段仍取缓存值（CIM 才是缓存要省的那 ~1s），`sampledAt` 保持首次真采样时刻。
 */
export async function sampleCapacityWithSampler(
  env: NodeJS.ProcessEnv,
  cacheFile: string,
  now: number,
  sampler: (now: number) => CapacitySample | Promise<CapacitySample>,
  osReader: () => OsWatermark = readOsWatermark,
): Promise<CapacitySample> {
  const minMs = memSampleMinMsFromEnv(env);
  if (minMs > 0) {
    const cached = await readSampleCache(cacheFile, now, minMs);
    if (cached !== null) {
      const live = osReader();
      const totalBytes = Number.isFinite(live.totalBytes) && live.totalBytes > 0 ? live.totalBytes : cached.totalBytes;
      const freeBytes = Number.isFinite(live.freeBytes) && live.freeBytes >= 0 ? live.freeBytes : cached.freeBytes;
      return { ...cached, totalBytes, freeBytes, watermark: watermarkOf(totalBytes, freeBytes) };
    }
  }
  const fresh = await sampler(now);
  await writeSampleCache(cacheFile, fresh).catch(() => undefined); // 缓存尽力而为，失败不影响返回
  return fresh;
}

/** 一次真采样（os 水位 + CIM 分类 + v0.10.0 组 D：无头进程树记账；now 注入保持纯度）。
 *
 * `stateRoot` 可选：给出时才读唤醒生命周期账本算 memberTrees（测试与旧调用点不传 =
 * 行为逐字节不变）。账本读取意外只让 memberTrees 缺席并带 {@link CapacitySample.memberTreesError}，
 * **绝不**让记账失败拖垮 os 水位/CIM 分类这些主字段（R7 验收：采样失败时该字段缺席
 * 并如实标注，不让采样整体失败）。
 */
export async function takeFreshSample(now: number = Date.now(), stateRoot?: string): Promise<CapacitySample> {
  const { totalBytes, freeBytes } = readOsWatermark();
  const watermark = watermarkOf(totalBytes, freeBytes);
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
  // v0.10.0（组 D / R7）：进程树记账（best-effort；失败只缺席该字段 + 标注原因）。
  let memberTrees: MemberTreeSample[] | undefined;
  let memberTreesError: string | undefined;
  if (stateRoot !== undefined) {
    try {
      const entries = await readWakeTreeLedger(stateRoot);
      memberTrees = memberTreesFromLedger(rows, entries, now);
    } catch (error) {
      memberTreesError = error instanceof Error ? error.message : String(error);
    }
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
    ...(memberTrees !== undefined ? { memberTrees } : {}),
    ...(memberTreesError !== undefined ? { memberTreesError } : {}),
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
    // v0.10.0（组 D / R7）：进程树记账宽容读取——逐条形状校验（member 非空串 /
    // rootPid 正整数 / bytes ≥0 / idleMin 非负整数），坏条目丢弃不拒整块；
    // 键缺席（旧样本）= absent。与 steadyTreeBytes 等同为进程类缓存字段。
    const memberTrees = coerceMemberTrees(rec['memberTrees']);
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
      ...(memberTrees !== undefined ? { memberTrees } : {}),
      ...(typeof rec['memberTreesError'] === 'string' && rec['memberTreesError'].trim() !== ''
        ? { memberTreesError: rec['memberTreesError'] }
        : {}),
    };
  } catch {
    return null; // 缺文件/损坏 JSON → 重采样
  }
}

/** v0.10.0（组 D / R7）：sample.json 里 memberTrees 的宽容解析（坏条目丢弃；非数组 → undefined）。 */
function coerceMemberTrees(value: unknown): MemberTreeSample[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: MemberTreeSample[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const member = rec['member'];
    const rootPid = rec['rootPid'];
    const bytes = rec['bytes'];
    const idleMin = rec['idleMin'];
    if (typeof member !== 'string' || member.trim() === '') continue;
    if (typeof rootPid !== 'number' || !Number.isSafeInteger(rootPid) || rootPid <= 0) continue;
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) continue;
    if (typeof idleMin !== 'number' || !Number.isSafeInteger(idleMin) || idleMin < 0) continue;
    out.push({ member, rootPid, bytes, idleMin });
  }
  return out;
}

async function writeSampleCache(cacheFile: string, sample: CapacitySample): Promise<void> {
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFileAtomic(cacheFile, `${JSON.stringify(sample, null, 2)}\n`);
}
