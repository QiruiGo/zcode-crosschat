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
 * 本文件不 import M1（不触碰磁盘真源）——日志文件路径由 wake.ts 解析后传入；
 * engine.jsonl 审计由 wake.ts 经 M1 core/log 落盘。
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** 唤醒用 CLI 的可执行配置（来源：plugin.json userConfig，DESIGN §8.2-A）。 */
export interface WakeSpawnConfig {
  /** ZCode.exe 绝对路径（userConfig zcode_exe，env XC_ZCODE_EXE）。 */
  zcodeExe: string;
  /** zcode.cjs CLI 入口绝对路径（userConfig zcode_cjs，env XC_ZCODE_CJS）。 */
  zcodeCjs: string;
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
  /** 基底 env（默认 process.env）；ELECTRON_RUN_AS_NODE=1 恒定注入。 */
  env?: NodeJS.ProcessEnv;
  /** 测试注入点；生产用 node:child_process.spawn。 */
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /**
   * 异步 spawn 失败（如 ENOENT，spawn() 同步返回后才发射 error）时的回调——
   * wake.ts 借此向 engine.jsonl 补记失败并释放投递租约（fire-and-forget 的善后）。
   * 回调内部抛错会被吞掉（记入唤醒日志文件），绝不向上传播。
   */
  onAsyncError?: (err: Error) => void;
}

export interface SpawnResumeResult {
  /** 子进程 pid；spawn 同步失败时不会返回（抛出）。 */
  pid: number | undefined;
  logFile: string;
}

/**
 * 发起一次无头 `--resume` 唤醒（fire-and-forget）：
 * - detached + unref：不等待退出、不阻塞工具返回、父进程退出不影响子进程；
 * - stdin ignore；stdout+stderr 同落 logFile（DESIGN §2.5"stdout/stderr 直落"）；
 * - spawn **同步**失败（参数非法等）直接抛出——调用方据此降级 mailbox 态；
 * - spawn **异步**失败（ENOENT 等）经 onAsyncError 上报，不抛出。
 */
export function spawnResume(opts: SpawnResumeOptions): SpawnResumeResult {
  const { cfg, sessionId, prompt, cwd, logFile } = opts;
  if (cfg.zcodeExe.trim() === "" || cfg.zcodeCjs.trim() === "") {
    // 未配置本机 zcode 路径：同步抛错，调用方（wake.ts attemptWake）据此降级 mailbox。
    throw new Error(
      "spawnResume: zcode_exe / zcode_cjs 未配置（请在插件设置中填写本机 zcode 路径）——推送唤醒不可用",
    );
  }
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
    try {
      appendFileSync(logFile, JSON.stringify({ wakeSpawnError: String(err?.message ?? err), ts: Date.now() }) + "\n");
    } catch {
      /* 日志写失败不影响 fire-and-forget 语义 */
    }
    try {
      opts.onAsyncError?.(err);
    } catch {
      /* onAsyncError 不允许向上传播 */
    }
  });
  // 错误监听已挂上，解除父进程对子进程事件循环的引用；父进程 fd 即刻关闭
  // （子进程持有自己的继承句柄，不受影响）。
  child.unref();
  closeSync(fd);
  return { pid: child.pid, logFile };
}
