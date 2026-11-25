/**
 * v0.10.0（组 C / C3，防御性对齐）定向测试：**AppServerKeeper.start 的 spawn 补
 * `windowsHide: true`**——与插件其余 9 处进程创建点（wake direct / helper 跳板 /
 * 唤醒子 ZCode.exe / zcode-locate 探测 / capacity·registry CIM / session-start 宿主
 * 枚举 / steer taskkill / 进程树枚举）逐点对齐。
 *
 * 背景（记录项一）：0.9.9 全量源码审计确认插件进程创建点共 10 处，
 * 其中 9 处显式 `windowsHide:true`，唯一缺口即本处（appserver.ts AppServerKeeper.start，
 * 唯一调用方 provision.ts 成员供给）。今天无害（ZCode.exe PE subsystem=2=WINDOWS_GUI，
 * GUI 子系统子进程本就不分配控制台），但属防御性缺口：若换用 console 子系统的启动器
 * 即闪窗。本测试把该对齐钉成回归判据。
 *
 * 覆盖点：
 * 1. spawn 选项含 `windowsHide: true`（修法本体）；
 * 2. 其余 spawn 入参逐字段不变（exe/args/env 的 ELECTRON_RUN_AS_NODE 注入/stdio）——
 *    只加一个键，不动既有行为；
 * 3. exe/cjs 未配置时的同步抛错路径不变（不因补 windowsHide 改变失败形态）。
 */
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { AppServerKeeper } from "./appserver.js";

/** 假 ChildProcess（keeper 构造只挂 stdout/stderr/exit 监听，不做 IO）。 */
function fakeChild(): ChildProcess {
  return {
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
    on: () => undefined,
    stdin: { write: () => true, destroyed: false },
    kill: () => true,
  } as unknown as ChildProcess;
}

/** 捕获 spawn 调用的替身实现（第三个参数 = SpawnOptions）。 */
function capturingSpawn(captured: Array<{ exe: string; args: string[]; options: Record<string, unknown> }>) {
  return ((exe: string, args: string[], options: Record<string, unknown>) => {
    captured.push({ exe, args, options });
    return fakeChild();
  }) as unknown as typeof import("node:child_process").spawn;
}

describe("v0.10.0 组 C（C3）：app-server keeper spawn 的 windowsHide 对齐", () => {
  it("1. spawn 选项带 windowsHide:true（与其余 9 处进程创建点对齐）", () => {
    const captured: Array<{ exe: string; args: string[]; options: Record<string, unknown> }> = [];
    const keeper = AppServerKeeper.start({
      cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\app\\glm\\zcode.cjs" },
      spawnImpl: capturingSpawn(captured),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.options["windowsHide"]).toBe(true);
    expect(keeper).toBeInstanceOf(AppServerKeeper);
    keeper.kill();
  });

  it("2. 其余 spawn 入参逐字段不变（只加 windowsHide 一个键）", () => {
    const captured: Array<{ exe: string; args: string[]; options: Record<string, unknown> }> = [];
    const keeper = AppServerKeeper.start({
      cfg: { zcodeExe: "Z:\\ZCode.exe", zcodeCjs: "Z:\\resources\\app\\glm\\zcode.cjs" },
      env: { XC_PROBE_MARKER: "1" },
      spawnImpl: capturingSpawn(captured),
    });

    const { exe, args, options } = captured[0]!;
    expect(exe).toBe("Z:\\ZCode.exe");
    expect(args).toEqual(["Z:\\resources\\app\\glm\\zcode.cjs", "app-server"]);
    expect(options["stdio"]).toEqual(["pipe", "pipe", "pipe"]);
    const env = options["env"] as Record<string, unknown>;
    expect(env["ELECTRON_RUN_AS_NODE"]).toBe("1"); // PLATFORM §4.1 恒定注入
    expect(env["XC_PROBE_MARKER"]).toBe("1"); // 基底 env 透传
    // 键集合恰为既有三键 + windowsHide（不多不少）
    expect(Object.keys(options).sort()).toEqual(["env", "stdio", "windowsHide"]);
    keeper.kill();
  });

  it("3. exe/cjs 未配置 → 仍同步抛错（补 windowsHide 不改变失败形态）", () => {
    expect(() =>
      AppServerKeeper.start({
        cfg: { zcodeExe: "  ", zcodeCjs: "" },
        spawnImpl: capturingSpawn([]),
      }),
    ).toThrow(/app-server: zcode_exe \/ zcode_cjs 未配置/);
  });
});
