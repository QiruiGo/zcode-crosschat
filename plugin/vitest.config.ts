import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // v0.9.2 收尾（2026-11-20 全量单测一次红后裁定）：
    // 12:34 全量跑（118 文件 / 1999 例）报 1 failed，失败文件经 vitest results cache
    // 确定性识别为 src/engine/watchdog-v092r1-concurrency.test.ts；随后 2 次全量复跑
    // （118/1999 全绿）+ ~90 次定向跑（含 CPU 饱和 / 内存压到 390MB / 10 并发 vitest /
    // 乱序 / 23·59·72 文件子集）该文件从未再红 ⇒ 一次性负载 flake。
    // 失败重试 3 次吸收负载抖动；**不放宽任何断言**——持续失败仍会红（retry 只重跑，
    // 不改变判据），「合起来 member-dead=1 / lead urgent=1 / watchdog-wake=1」原样保留。
    retry: 3,
  },
});
