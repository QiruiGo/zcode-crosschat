/**
 * M2 单测：无头 --resume spawn 封装（resume-cli.ts）。
 * 覆盖：env 组装（XC_ZCODE_EXE/XC_ZCODE_CJS 缺省得空配置）、未配置同步抛出（调用方降级 mailbox）、
 * detached+unref、stdout/stderr 落 logFile、同步失败抛出、异步 error 上报。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawnResume, wakeSpawnConfigFromEnv } from "./resume-cli";

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
});

describe("spawnResume", () => {
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

  it("cfg 为空（未配置 zcode 路径）→ 同步抛出（调用方据此降级 mailbox）", () => {
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
