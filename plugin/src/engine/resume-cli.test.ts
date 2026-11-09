/**
 * M2 单测：无头 --resume spawn 封装（resume-cli.ts）。
 * v0.2（DESIGN-V0.2 §4.2）：
 * - direct 形态 = v0.1.0 原路径（E1 对照基线），原用例逐字保留并显式 mode:"direct"；
 * - helper 形态（默认）= V9 修复：spawn node wake-helper → helper detached 拉起唤醒子
 *   → stdout 单行 JSON {ok:true,pid} → onHelperSpawned；exit≠0/超时 → onAsyncError；
 *   helper 缺失 → 同步抛错（fail closed，绝不回退 direct 危险路径）。
 * 覆盖：env 组装、未配置同步抛出、detached+unref、stdout/stderr 落 logFile、
 * 同步失败抛出、异步 error 上报（direct）；helper 参数形态、协议解析、端到端双跳板。
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  WAKE_HELPER_TIMEOUT_MS,
  resolveWakeHelperPath,
  spawnResume,
  wakeSpawnConfigFromEnv,
} from "./resume-cli";

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
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xc-resume-"));
  dirs.push(d);
  return d;
}

/**
 * 轮询等待一个条件成立（替代固定 sleep）。
 *
 * 这些用例要等**真实的 detached 孙进程**落盘，并行满载时固定 sleep 会被饿死：
 * v0.3 起测试文件从 24 个涨到 36 个，默认并发下 3 连跑有 1~2 次读不到 marker
 * （证据 deepseek-crosschat/evidence/12-v030/acceptance/phase0/unit-tests-flaky-parallel.md）。
 */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 轮询读一个文件直到内容等于 expected（文件不存在/内容不符都继续等）。 */
async function waitForFile(file: string, expected: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      last = readFileSync(file, "utf8");
      if (last === expected) return last;
    } catch {
      /* 还没落盘 */
    }
    if (Date.now() >= deadline) throw new Error(`waitForFile timed out after ${timeoutMs}ms (last=${JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 写一个按 helper 协议行动的 fixture .mjs（测试用，非产物）。 */
function writeHelper(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body, "utf8");
  return file;
}

/** 唤醒孙进程脚本：落一个 marker 文件后存活 2s（验证孤儿真的被拉起且跑了起来）。 */
function writeGrandchild(dir: string): { script: string; marker: string } {
  const script = join(dir, "grandchild.mjs");
  const marker = join(dir, "grandchild-marker.txt");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(marker)}, "alive");\n` +
    `setTimeout(() => {}, 2000);\n`,
    "utf8",
  );
  return { script, marker };
}

describe("wakeSpawnConfigFromEnv", () => {
  it("env 缺失 → 空配置（插件不内置本机路径，推送唤醒视为未配置）", () => {
    expect(wakeSpawnConfigFromEnv({})).toEqual({ zcodeExe: "", zcodeCjs: "" });
  });
  it("空串/空白也按缺失处理（V7 展开行为未确认的防御）", () => {
    expect(wakeSpawnConfigFromEnv({ XC_ZCODE_EXE: "", XC_ZCODE_CJS: "  " })).toEqual({
      zcodeExe: "",
      zcodeCjs: "",
    });
  });
  it("env 有值 → 采用 env 值", () => {
    const cfg = wakeSpawnConfigFromEnv({ XC_ZCODE_EXE: "X:\\Z.exe", XC_ZCODE_CJS: "X:\\z.cjs" });
    expect(cfg).toEqual({ zcodeExe: "X:\\Z.exe", zcodeCjs: "X:\\z.cjs" });
  });
  it("resolveWakeHelperPath：ZCODE_PLUGIN_ROOT 前缀 + dist/mcp/wake-helper.mjs（§4.2 解析式）", () => {
    expect(resolveWakeHelperPath({ ZCODE_PLUGIN_ROOT: "D:\\plug" })).toBe(
      join("D:\\plug", "dist", "mcp", "wake-helper.mjs"),
    );
    expect(resolveWakeHelperPath({})).toBe(join("", "dist", "mcp", "wake-helper.mjs"));
  });
});

describe("spawnResume: direct 形态（v0.1.0 原路径，E1 对照基线）", () => {
  /** 假 ChildProcess：如实转发 once("error", cb) 注册的监听器（微任务里统一发射）。 */
  function fakeChild(pid: number | undefined, failAsync = false): ChildProcess {
    const listeners: Array<(err: Error) => void> = [];
    let scheduled = false;
    return {
      pid,
      once(event: string, cb: (...a: unknown[]) => void): ChildProcess {
        if (event === "error" && failAsync) {
          listeners.push(cb as (e: Error) => void);
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => {
              for (const l of listeners) l(new Error("spawn ENOENT"));
            });
          }
        }
        return this as ChildProcess;
      },
      unref(): void {
        /* no-op */
      },
    } as unknown as ChildProcess;
  }

  it("cfg 为空（未配置 zcode 路径）→ 同步抛出（调用方据此降级 mailbox；判定先于形态分支）", () => {
    const root = freshDir();
    expect(() =>
      spawnResume({
        cfg: { zcodeExe: "", zcodeCjs: "" },
        sessionId: "s",
        prompt: "p",
        cwd: root,
        logFile: join(root, "logs", "wake-b-0.json"),
        env: {},
        spawnImpl: () => fakeChild(1),
      }),
    ).toThrow(/未配置/);
  });

  it("命令形态 = [zcodeCjs, --resume, sid, --prompt, …, --cwd, ws, --output-format, json]，env 注入 ELECTRON_RUN_AS_NODE=1，detached", () => {
    const root = freshDir();
    const logFile = join(root, "logs", "wake-b-1.json");
    let seen: { cmd: string; args: string[]; opts: SpawnOptions } | undefined;
    const res = spawnResume({
      mode: "direct",
      cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
      sessionId: "sess_b",
      prompt: "PROMPT-TEXT",
      cwd: "D:\\ws",
      logFile,
      env: { PATH: "x" },
      spawnImpl: (cmd, args, opts) => {
        seen = { cmd, args, opts };
        return fakeChild(4242);
      },
    });
    expect(res.pid).toBe(4242);
    expect(res.logFile).toBe(logFile);
    expect(seen).toBeDefined();
    expect(seen!.cmd).toBe("Z.exe");
    expect(seen!.args).toEqual([
      "z.cjs", "--resume", "sess_b", "--prompt", "PROMPT-TEXT",
      "--cwd", "D:\\ws", "--output-format", "json",
    ]);
    expect(seen!.opts.detached).toBe(true);
    expect((seen!.opts.env as NodeJS.ProcessEnv)["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect((seen!.opts.env as NodeJS.ProcessEnv)["PATH"]).toBe("x"); // 基底 env 透传
    expect(seen!.opts.stdio).toEqual(["ignore", expect.any(Number), expect.any(Number)]);
  });

  it("stdout/stderr 落 logFile（子进程与父进程共用 fd）", () => {
    const root = freshDir();
    const logFile = join(root, "logs", "wake-b-2.json");
    spawnResume({
      mode: "direct",
      cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
      sessionId: "s",
      prompt: "p",
      cwd: root,
      logFile,
      env: {},
      spawnImpl: (_cmd, _args, opts) => {
        const fd = (opts.stdio as number[])[1];
        writeSync(fd, '{"response":"391"}');
        return fakeChild(7);
      },
    });
    expect(readFileSync(logFile, "utf8")).toContain('{"response":"391"}');
  });

  it("spawn 同步失败 → 抛出（调用方据此降级 mailbox）", () => {
    const root = freshDir();
    expect(() =>
      spawnResume({
        mode: "direct",
        cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
        sessionId: "s",
        prompt: "p",
        cwd: root,
        logFile: join(root, "logs", "wake-b-3.json"),
        env: {},
        spawnImpl: () => {
          throw new Error("bad args");
        },
      }),
    ).toThrow("bad args");
  });

  it("pid 缺失按同步失败处理", () => {
    const root = freshDir();
    expect(() =>
      spawnResume({
        mode: "direct",
        cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
        sessionId: "s",
        prompt: "p",
        cwd: root,
        logFile: join(root, "logs", "wake-b-4.json"),
        env: {},
        spawnImpl: () => fakeChild(undefined),
      }),
    ).toThrow(/pid undefined/);
  });

  it("异步 spawn 错误 → 写入 logFile 并回调 onAsyncError，不向上抛", async () => {
    const root = freshDir();
    const logFile = join(root, "logs", "wake-b-5.json");
    const errors: Error[] = [];
    spawnResume({
      mode: "direct",
      cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
      sessionId: "s",
      prompt: "p",
      cwd: root,
      logFile,
      env: {},
      spawnImpl: () => fakeChild(9, true),
      onAsyncError: (e) => errors.push(e),
    });
    await new Promise((r) => setTimeout(r, 10));
    // spawnResume 注册的 error 监听器被触发：写 logFile + 调 onAsyncError。
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(readFileSync(logFile, "utf8")).toContain("wakeSpawnError");
  });
});

describe("spawnResume: helper 形态（v0.2 默认，V9 修复 §4.2）", () => {
  function baseOpts(root: string, extra: Partial<Parameters<typeof spawnResume>[0]> = {}) {
    return {
      cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
      sessionId: "sess_m1",
      prompt: "WAKE-PROMPT",
      cwd: root,
      logFile: join(root, "logs", "wake-m1.json"),
      env: { PATH: "x" },
      ...extra,
    };
  }

  it("默认即 helper：cmd=process.execPath，args=[helperPath, --exe/--cjs/--sid/--prompt/--cwd/--log]，非 detached、pipe stdio", () => {
    const root = freshDir();
    const helperPath = writeHelper(root, "ok-helper.mjs", "process.exit(0);\n");
    const logFile = join(root, "logs", "wake-h1.json");
    let seen: { cmd: string; args: string[]; opts: SpawnOptions } | undefined;
    const res = spawnResume(baseOpts(root, { helperPath, logFile, spawnImpl: (cmd, args, opts) => {
      seen = { cmd, args, opts };
      return { pid: 321, once: () => undefined, unref: () => undefined } as unknown as ChildProcess;
    } }));
    expect(res.pid).toBe(321); // wake 行记 helper pid（§4.2 审计）
    expect(res.logFile).toBe(logFile);
    expect(seen!.cmd).toBe(process.execPath);
    expect(seen!.args[0]).toBe(helperPath);
    expect(seen!.args.slice(1)).toEqual([
      "--exe", "Z.exe", "--cjs", "z.cjs", "--sid", "sess_m1",
      "--prompt", "WAKE-PROMPT", "--cwd", root, "--log", logFile,
    ]);
    expect(seen!.opts.detached).toBe(false);
    expect(seen!.opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    // helper 本进程不注入 ELECTRON_RUN_AS_NODE（helper 自己给唤醒孙进程注入）。
    expect((seen!.opts.env as NodeJS.ProcessEnv)["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
    expect((seen!.opts.env as NodeJS.ProcessEnv)["PATH"]).toBe("x");
    // 日志目录由父进程先建（helper openSync("a") 不建父目录）。
    expect(existsSync(dirname(logFile))).toBe(true);
  });

  it("端到端（真实 spawn，无 spawnImpl）：node → fixture helper → detached 孙进程落 marker → onHelperSpawned 收到孙 pid", async () => {
    const root = freshDir();
    const { script, marker } = writeGrandchild(root);
    // fixture helper：按真实 wake-helper 协议行动——detached+unref 拉起 [exe, cjs] 后立即退出。
    const helperPath = writeHelper(
      root,
      "ok-helper.mjs",
      `import { spawn } from "node:child_process";\n` +
      `import { closeSync, openSync } from "node:fs";\n` +
      `const a = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : ""; };\n` +
      `const fd = openSync(a("--log"), "a");\n` +
      `const child = spawn(a("--exe"), [a("--cjs")], { cwd: a("--cwd"), detached: true, stdio: "ignore", windowsHide: true });\n` +
      `child.unref();\n` +
      `closeSync(fd);\n` +
      `process.stdout.write(JSON.stringify({ ok: true, pid: child.pid }) + "\\n");\n` +
      `process.exit(0);\n`,
    );
    const childPids: number[] = [];
    spawnResume(baseOpts(root, {
      helperPath,
      cfg: { zcodeExe: process.execPath, zcodeCjs: script },
      onHelperSpawned: (pid) => childPids.push(pid),
    }));
    // 轮询而不是固定 sleep：marker 由 detached 孙进程写盘，并行满载时
    // （v0.3 起测试文件从 24 个涨到 36 个）固定 700ms 会被饿死。
    const markerText = await waitForFile(marker, "alive", 20_000);
    expect(childPids).toHaveLength(1);
    expect(typeof childPids[0]).toBe("number");
    expect(Number.isInteger(childPids[0])).toBe(true);
    // 孤儿孙进程确实执行了（marker 由孙进程写盘）。
    expect(markerText).toBe("alive");
  });

  it("helper 缺失 → 同步抛错（fail closed，不回退 direct；spawnImpl 不应被触达）", () => {
    const root = freshDir();
    expect(() =>
      spawnResume(baseOpts(root, {
        helperPath: join(root, "no-such", "wake-helper.mjs"),
        spawnImpl: () => {
          throw new Error("direct fallback must not happen");
        },
      })),
    ).toThrow(/wake-helper not found/);
  });

  it("ZCODE_PLUGIN_ROOT 缺失/指向空目录 → 解析路径不存在 → 同步抛错（降级 mailbox；与 cwd 是否有 dist 产物无关）", () => {
    const root = freshDir();
    const prev = process.env["ZCODE_PLUGIN_ROOT"];
    // 指向必不存在的绝对路径：不依赖进程 cwd（否则相对解析可能命中真实 dist 产物）。
    process.env["ZCODE_PLUGIN_ROOT"] = join(root, "no-such-root");
    try {
      expect(() => spawnResume(baseOpts(root, { spawnImpl: () => {
        throw new Error("direct fallback must not happen");
      } }))).toThrow(/wake-helper not found/);
    } finally {
      if (prev !== undefined) process.env["ZCODE_PLUGIN_ROOT"] = prev;
      else delete process.env["ZCODE_PLUGIN_ROOT"];
    }
  });

  it("helper exit≠0（{ok:false,error}）→ onAsyncError 收 wake-helper failed + logFile 记 wakeSpawnError，不抛出", async () => {
    const root = freshDir();
    const logFile = join(root, "logs", "wake-h2.json");
    const helperPath = writeHelper(
      root,
      "fail-helper.mjs",
      `process.stdout.write(JSON.stringify({ ok: false, error: "spawn failure" }) + "\\n");\nprocess.exit(1);\n`,
    );
    const errors: Error[] = [];
    spawnResume(baseOpts(root, { helperPath, logFile, onAsyncError: (e) => errors.push(e) }));
    await waitFor(() => errors.length === 1, 10_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("wake-helper failed");
    expect(errors[0]!.message).toContain("spawn failure");
    expect(readFileSync(logFile, "utf8")).toContain("wakeSpawnError");
  });

  it("helper 超时（helperTimeoutMs 注入 250ms，helper 不产协议行）→ onAsyncError 收 timeout", async () => {
    const root = freshDir();
    const logFile = join(root, "logs", "wake-h3.json");
    const helperPath = writeHelper(
      root,
      "hang-helper.mjs",
      `setTimeout(() => {}, 3000);\n`, // 不写 stdout：触发超时分支
    );
    const errors: Error[] = [];
    spawnResume(baseOpts(root, { helperPath, logFile, helperTimeoutMs: 250, onAsyncError: (e) => errors.push(e) }));
    await waitFor(() => errors.length === 1, 10_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("wake-helper timeout");
    expect(WAKE_HELPER_TIMEOUT_MS).toBe(5000); // 默认超时契约
  });

  it("helper 异步 spawn error（node 自身 error 事件）→ onAsyncError 收 wake-helper spawn error", async () => {
    const root = freshDir();
    const logFile = join(root, "logs", "wake-h4.json");
    const helperPath = writeHelper(root, "ok-helper.mjs", "process.exit(0);\n");
    const errors: Error[] = [];
    const listeners: Array<(err: Error) => void> = [];
    spawnResume(baseOpts(root, {
      helperPath,
      logFile,
      onAsyncError: (e) => errors.push(e),
      spawnImpl: (_cmd, _args, _opts) => {
        const child = {
          pid: 55,
          stdout: { setEncoding: () => undefined, on: () => undefined },
          stderr: { setEncoding: () => undefined, on: () => undefined },
          once: (event: string, cb: (...a: unknown[]) => void) => {
            if (event === "error") listeners.push(cb as (e: Error) => void);
            return child as unknown as ChildProcess;
          },
          unref: () => undefined,
        };
        queueMicrotask(() => {
          for (const l of listeners) l(new Error("spawn ENOENT"));
        });
        return child as unknown as ChildProcess;
      },
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("wake-helper spawn error");
    expect(readFileSync(logFile, "utf8")).toContain("wakeSpawnError");
  });

  it("协议单发锁存：exit 后迟到的 error 事件不再二次结算（onAsyncError 只触发一次）", async () => {
    const root = freshDir();
    const logFile = join(root, "logs", "wake-h5.json");
    const helperPath = writeHelper(
      root,
      "ok-helper.mjs",
      `process.stdout.write(JSON.stringify({ ok: true, pid: 777 }) + "\\n");\nprocess.exit(0);\n`,
    );
    const spawned: number[] = [];
    const errors: Error[] = [];
    // 假 child：exit 监听器注册后微任务触发 exit(0)，再补发一个 error 事件。
    spawnResume(baseOpts(root, {
      helperPath,
      logFile,
      onHelperSpawned: (pid) => spawned.push(pid),
      onAsyncError: (e) => errors.push(e),
      spawnImpl: (_cmd, _args, _opts) => {
        let exitCb: ((code: number | null) => void) | undefined;
        const child = {
          pid: 56,
          stdout: {
            setEncoding: () => undefined,
            on: (_event: string, cb: (chunk: string) => void) => {
              setTimeout(() => cb(JSON.stringify({ ok: true, pid: 777 }) + "\n"), 1);
              return child as unknown as ChildProcess;
            },
          },
          stderr: { setEncoding: () => undefined, on: () => undefined },
          once: (event: string, cb: (...a: unknown[]) => void) => {
            if (event === "exit") exitCb = cb as (code: number | null) => void;
            if (event === "error") {
              // 用宏任务而非微任务：spawnViaHelper 先注册 error、后注册 exit，
              // 宏任务触发时两个监听器都已就位（模拟真实的迟到 error）。
              setTimeout(() => {
                exitCb?.(0);
                (cb as (e: Error) => void)(new Error("late error"));
              }, 1);
            }
            return child as unknown as ChildProcess;
          },
          unref: () => undefined,
        };
        return child as unknown as ChildProcess;
      },
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned).toEqual([777]);
    expect(errors).toHaveLength(0); // 已按 ok 结算，迟到的 error 被锁存吞掉
  });
});
