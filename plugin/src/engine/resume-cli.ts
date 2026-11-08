/**
 * M2 wake-engine —— 无头 `--resume` 单发进程的 spawn 封装。
 *
 * 设计依据 docs/DESIGN.md §2.5（wake 态）：
 *   "spawn 无头 CLI（ELECTRON_RUN_AS_NODE=1 <zcode_exe> <zcode_cjs> --resume <sid>
 *    --prompt "<回执+身份行(含sid)+wakeToken+任务票>" --cwd <workspace> --output-format json）
 *    detached、不等待退出、不阻塞工具返回，stdout/stderr 直落 logs/wake-<to>-<ts>.json，
 *    engine.jsonl 记 {event:"wake", pid}。不看唤醒的返回值判定成败。"
 *
 * 平台依据 docs/PLATFORM.md：
 *   - :137,218  Windows 下必须 `ELECTRON_RUN_AS_NODE=1` 前缀调用 ZCode.exe；
 *   - :194-199  `--resume <sid> --prompt … --cwd … --output-format json` 跨进程续聊实测记忆连续，
 *     stdout 为单对象 JSON `{"sessionId","response","usage","projection"}`。
 *
 * v0.2（DESIGN-V0.2 §4.2，V9 修复）：默认改走 **helper 孤儿化**（FEASIBILITY §2.1 路径 A，
 * E3b 端到端实测）——
 *
 *   旧形态（E3a 证明被清杀）：本进程 ──detached spawn──▶ ZCode.exe（--resume 唤醒回合）
 *   新形态（E3b 证明存活）：  本进程 ──spawn node──▶ dist/mcp/wake-helper.mjs（立即退出）
 *                                              └─detached+unref spawn──▶ ZCode.exe（孤儿）
 *
 * 派发方 CLI/app-server 退出沿**活父链**清杀（P5）：helper 立即退出后唤醒子进程成为孤儿，
 * 杀不到。本进程读 helper stdout 单行 JSON：{ok:true,pid} → onHelperSpawned(childPid)
 * （attemptWake 据此追记 engine.jsonl {event:"wake-child"}）；helper 失败（exit≠0 /
 * spawn error / 超时 5s）→ 既有 onAsyncError（attemptWake 的 releaseOnFailure 释放投递
 * 租约 + 消费 nonce + 降级 mailbox，消息不丢）。对外签名不变：
 * spawnResume(opts) 同步返回 {pid: <helper pid>, logFile}。
 *
 * helper 路径解析：join(process.env.ZCODE_PLUGIN_ROOT ?? "", "dist/mcp/wake-helper.mjs")
 * （plugin.json env 注入，DESIGN-V0.2 §10.1）；文件缺失 → spawnResume 同步抛错 →
 * attemptWake 降级 mailbox——**绝不回退**到「直接 spawn」的 V9 危险路径。
 *
 * 本文件不 import M1（不触碰磁盘真源）——日志文件路径由 wake.ts 解析后传入；
 * engine.jsonl 审计由 wake.ts 经 M1 core/log 落盘。
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";

/** 唤醒用 CLI 的可执行配置（来源：plugin.json userConfig，DESIGN §8.2-A）。 */
export interface WakeSpawnConfig {
  /** ZCode.exe 绝对路径（userConfig zcode_exe，env XC_ZCODE_EXE）。 */
  zcodeExe: string;
  /** zcode.cjs CLI 入口绝对路径（userConfig zcode_cjs，env XC_ZCODE_CJS）。 */
  zcodeCjs: string;
}

/**
 * spawn 形态（DESIGN-V0.2 §9.2）：
 * - `"helper"`（默认）：经立即退出的 node 跳板孤儿化唤醒子进程（V9 修复，E3b 实测）；
 * - `"direct"`：v0.1.0 的本进程直接 detached spawn——仅测试/对照保留（E1 基线），
 *   生产路径已证明会被派发方退出连带清杀（09 §4.3）。
 */
export type WakeSpawnMode = "helper" | "direct";

/** helper stdout 单行 JSON 的等待上限；超时按 helper 失败处理（走 onAsyncError 降级 mailbox）。 */
export const WAKE_HELPER_TIMEOUT_MS = 5000;

/**
 * 解析 wake-helper 产物路径（DESIGN-V0.2 §4.2）：ZCODE_PLUGIN_ROOT 由 plugin.json
 * mcpServers.env 注入（§10.1）。root 为空/文件缺失由 spawnResume 判定——同步抛错、
 * 降级 mailbox（fail closed，不回退 direct）。
 */
export function resolveWakeHelperPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["ZCODE_PLUGIN_ROOT"] ?? "", "dist", "mcp", "wake-helper.mjs");
}

/**
 * 从进程 env 组装 spawn 配置（MCP server 的 env 由 plugin.json mcpServers.env 注入：
 * XC_ZCODE_EXE / XC_ZCODE_CJS ← ${user_config.zcode_exe} / ${user_config.zcode_cjs}）。
 * zcode 的安装路径因机器而异，插件不内置默认值：env 缺失/空白一律得空串，
 * 由 spawnResume 以同步抛错拒绝——attemptWake 捕获后降级 mailbox（见 wake.ts）。
 * 空白也按缺失处理（userConfig 展开行为未确认，DESIGN §9-V7 的防御）。
 */
export function wakeSpawnConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WakeSpawnConfig {
  const exe = env["XC_ZCODE_EXE"];
  const cjs = env["XC_ZCODE_CJS"];
  return {
    zcodeExe: exe && exe.trim() !== "" ? exe : "",
    zcodeCjs: cjs && cjs.trim() !== "" ? cjs : "",
  };
}

export interface SpawnResumeOptions {
  cfg: WakeSpawnConfig;
  /** 目标会话 id（sess_…）。 */
  sessionId: string;
  /** 完整唤醒 prompt（wake.ts buildWakePrompt 组装，≤4000 字符）。 */
  prompt: string;
  /** --cwd：会话工作区（状态根的上级）。 */
  cwd: string;
  /** stdout/stderr 落盘文件（<stateRoot>/logs/wake-<to>-<ts>.json），父目录不存在则创建。 */
  logFile: string;
  /** 基底 env（默认 process.env）；direct 形态下 ELECTRON_RUN_AS_NODE=1 恒定注入，
   * helper 形态下原样转发给 helper（ELECTRON 由 helper 注入到唤醒子进程）。 */
  env?: NodeJS.ProcessEnv;
  /** 测试注入点；生产用 node:child_process.spawn。 */
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /**
   * 异步 spawn 失败（如 ENOENT，spawn() 同步返回后才发射 error）时的回调——
   * wake.ts 借此向 engine.jsonl 补记失败并释放投递租约（fire-and-forget 的善后）。
   * 回调内部抛错会被吞掉（记入唤醒日志文件），绝不向上传播。
   * v0.2：helper 形态下 helper 失败（exit≠0 / spawn error / 超时）同样经此上报。
   */
  onAsyncError?: (err: Error) => void;
  /** v0.2：spawn 形态；缺省 "helper"（V9 修复默认开启）。 */
  mode?: WakeSpawnMode;
  /** v0.2 测试注入：helper 产物路径；缺省 resolveWakeHelperPath()。 */
  helperPath?: string;
  /** v0.2 测试注入：helper 等待超时（ms）；缺省 WAKE_HELPER_TIMEOUT_MS。 */
  helperTimeoutMs?: number;
  /**
   * v0.2：helper 汇报的唤醒子进程 pid（stdout {ok:true,pid} 的 pid）。
   * attemptWake（W3 接线）据此追记 engine.jsonl {event:"wake-child", pid}，
   * 与 wake 行的 helper pid 并排可查（DESIGN-V0.2 §4.2 审计）。
   */
  onHelperSpawned?: (childPid: number) => void;
}

export interface SpawnResumeResult {
  /** 子进程 pid；spawn 同步失败时不会返回（抛出）。helper 形态下 = helper 进程 pid
   * （engine.jsonl wake 行记 helper pid，唤醒子 pid 走 wake-child 行，§4.2 审计）。 */
  pid: number | undefined;
  logFile: string;
}

/**
 * 发起一次无头 `--resume` 唤醒（fire-and-forget）：
 * - helper 形态（默认）：本进程 spawn node wake-helper → helper detached+unref 拉起
 *   ZCode.exe 后立即退出（孤儿化）；本进程异步消费 helper stdout 单行 JSON。
 * - direct 形态：detached + unref 直接拉起（v0.1.0 行为，仅测试/对照）。
 * - stdin ignore；唤醒进程 stdout+stderr 同落 logFile（DESIGN §2.5"stdout/stderr 直落"）；
 * - spawn **同步**失败（参数非法、helper 缺失等）直接抛出——调用方据此降级 mailbox 态；
 * - spawn **异步**失败（ENOENT、helper exit≠0、helper 超时）经 onAsyncError 上报，不抛出。
 */
export function spawnResume(opts: SpawnResumeOptions): SpawnResumeResult {
  const { cfg } = opts;
  if (cfg.zcodeExe.trim() === "" || cfg.zcodeCjs.trim() === "") {
    // 未配置本机 zcode 路径：同步抛错，调用方（wake.ts attemptWake）据此降级 mailbox。
    throw new Error(
      "spawnResume: zcode_exe / zcode_cjs 未配置（请在插件设置中填写本机 zcode 路径）——推送唤醒不可用",
    );
  }
  const mode: WakeSpawnMode = opts.mode ?? "helper";
  return mode === "direct" ? spawnDirect(opts) : spawnViaHelper(opts);
}

// ---------------------------------------------------------------------------
// direct 形态：v0.1.0 原实现（逐字保留，仅测试/对照使用；E1 基线）
// ---------------------------------------------------------------------------

function spawnDirect(opts: SpawnResumeOptions): SpawnResumeResult {
  const { cfg, sessionId, prompt, cwd, logFile } = opts;
  mkdirSync(dirname(logFile), { recursive: true });
  // 追加写；子进程与异步 error 处理器共用该 fd，父进程写完即关。
  const fd = openSync(logFile, "a");
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" };
  // 参数一律走数组（不经 shell），prompt 中的引号/换行无需转义。
  const args = [
    cfg.zcodeCjs,
    "--resume",
    sessionId,
    "--prompt",
    prompt,
    "--cwd",
    cwd,
    "--output-format",
    "json",
  ];
  const spawn = opts.spawnImpl ?? nodeSpawn;
  let child: ChildProcess;
  try {
    child = spawn(cfg.zcodeExe, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  if (child.pid === undefined) {
    // 理论上同步 throw 已覆盖绝大多数失败；pid 缺失按同步失败处理。
    closeSync(fd);
    throw new Error(`spawnResume: child pid undefined for session ${sessionId}`);
  }
  child.once("error", (err: Error) => {
    // 注意：父进程的 fd 在 spawn 返回后即已关闭（子进程持有自己的继承句柄），
    // 这里按路径追加写入，不复用 fd。
    reportSpawnError(logFile, opts.onAsyncError, err);
  });
  // 错误监听已挂上，解除父进程对子进程事件循环的引用；父进程 fd 即刻关闭
  // （子进程持有自己的继承句柄，不受影响）。
  child.unref();
  closeSync(fd);
  return { pid: child.pid, logFile };
}

/** 异步 spawn 失败的善后：按路径追加唤醒日志 + onAsyncError（均吞错，fire-and-forget）。 */
function reportSpawnError(
  logFile: string,
  onAsyncError: ((err: Error) => void) | undefined,
  err: Error,
): void {
  try {
    appendFileSync(logFile, JSON.stringify({ wakeSpawnError: String(err?.message ?? err), ts: Date.now() }) + "\n");
  } catch {
    /* 日志写失败不影响 fire-and-forget 语义 */
  }
  try {
    onAsyncError?.(err);
  } catch {
    /* onAsyncError 不允许向上传播 */
  }
}

// ---------------------------------------------------------------------------
// helper 形态：V9 修复主路径（DESIGN-V0.2 §4.2，E3b 实测的孤儿化跳板）
// ---------------------------------------------------------------------------

/** 从 helper 的累计 stdout 提取最后一行非空 JSON（helper 协议：单行 JSON）。 */
function parseHelperReport(stdoutText: string): { ok: boolean; pid?: number; error?: string } | undefined {
  const lines = stdoutText.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(lines[lines.length - 1]!);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record["ok"] !== "boolean") return undefined;
    return {
      ok: record["ok"],
      ...(typeof record["pid"] === "number" ? { pid: record["pid"] } : {}),
      ...(typeof record["error"] === "string" ? { error: record["error"] } : {}),
    };
  } catch {
    return undefined;
  }
}

function spawnViaHelper(opts: SpawnResumeOptions): SpawnResumeResult {
  const { cfg, sessionId, prompt, cwd, logFile } = opts;
  const helperPath = opts.helperPath ?? resolveWakeHelperPath();
  if (helperPath.trim() === "" || !existsSync(helperPath)) {
    // fail closed：helper 缺失 → 同步抛错 → attemptWake 降级 mailbox（消息不丢）。
    // 绝不回退 direct——那是已被 E3a 证明会被清杀的 V9 危险路径（09 §4.3）。
    throw new Error(
      `spawnResume: wake-helper not found at "${helperPath}" (ZCODE_PLUGIN_ROOT misconfigured or build output missing); ` +
      "refusing the unsafe direct-spawn fallback — wake degrades to mailbox delivery",
    );
  }
  // 日志目录仍由本进程先建（helper 的 openSync("a") 不建父目录）。
  mkdirSync(dirname(logFile), { recursive: true });
  // 参数一律走数组（不经 shell）；prompt ≤4000 字符远低于 Windows ~32k 命令行上限。
  const args = [
    helperPath,
    "--exe", cfg.zcodeExe,
    "--cjs", cfg.zcodeCjs,
    "--sid", sessionId,
    "--prompt", prompt,
    "--cwd", cwd,
    "--log", logFile,
  ];
  const spawn = opts.spawnImpl ?? nodeSpawn;
  // helper 是毫秒级短命进程：不 detached（跟随本进程生命周期无碍——它在派发方清杀
  // 树之前早已退出并孤儿化了唤醒子进程）；stdio 用 pipe 以读取单行 JSON 协议。
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...(opts.env ?? process.env) },
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (child.pid === undefined) {
    throw new Error(`spawnResume: helper pid undefined for session ${sessionId}`);
  }

  // 异步协议消费：单发锁存——error / exit / 超时三者只结算一次。
  let settled = false;
  let stdoutText = "";
  let stderrText = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutText += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  const timeoutMs = opts.helperTimeoutMs ?? WAKE_HELPER_TIMEOUT_MS;
  const timer = setTimeout(() => {
    settle(new Error(`wake-helper timeout after ${timeoutMs}ms (session ${sessionId})`));
  }, timeoutMs);
  // 超时定时器不阻止本进程自然退出（helper 已拉起唤醒子的情形下协议迟到也无需强等）。
  timer.unref?.();

  const settle = (err: Error | undefined, childPid?: number): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err !== undefined) {
      reportSpawnError(logFile, opts.onAsyncError, err);
      return;
    }
    try {
      opts.onHelperSpawned?.(childPid!);
    } catch {
      /* 回调不允许向上传播 */
    }
  };

  child.once("error", (err: Error) => {
    settle(new Error(`wake-helper spawn error: ${err.message}`));
  });
  child.once("exit", (code: number | null) => {
    const report = parseHelperReport(stdoutText);
    if (code === 0 && report?.ok === true && typeof report.pid === "number") {
      settle(undefined, report.pid);
      return;
    }
    const detail = report?.error ?? (stderrText.trim() !== "" ? stderrText.trim().split("\n").slice(-3).join(" | ") : "no report");
    settle(new Error(`wake-helper failed: exit code ${code ?? "signal"}: ${detail}`));
  });

  return { pid: child.pid, logFile };
}
