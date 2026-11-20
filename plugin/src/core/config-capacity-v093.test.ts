/**
 * v0.9.3（37-v093 方案 §一 组B B1/B4）定向测试：config.json `capacity` 段与分层生效值。
 *
 * 覆盖面（对应方案验收判据「优先级矩阵（file/env/default × 合法/畸形）」）：
 * - 文件层解析：三键各自合法收录；未知键静默忽略；段非对象整段忽略；逐键畸形
 *   （只忽略该键 + WARNING，其余键与 wake_enabled 不受影响）；
 * - resolveCapacityThresholds 分层矩阵：file > env > default × 合法/畸形；env 原值
 *   （「没配」与「配错」可分辨）；env 非法值不静默（warnings 披露）；
 * - judgeCapacity 吃分层阈值（detail 来源标签不虚标 env 名）；
 * - B4 状态对拍（capacity/config-state.json）：首访静默立基线、变更恰一条、
 *   不变更零事件、损坏重立基线。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot（M1 真实读写，端到端到文件契约）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  readWorkspaceConfigFile,
  workspaceConfigFile,
} from "./config";
import {
  capacityConfigStateFile,
  capacityThresholdLabel,
  diffCapacityConfigState,
  judgeCapacity,
  readCapacityConfigState,
  resolveCapacityThresholds,
  TURN_ESTIMATE_DEFAULT_BYTES,
  MEM_WARN_WATERMARK_DEFAULT,
  type CapacitySample,
} from "./capacity";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-config-cap-v093-"));
  dirs.push(root);
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

/** 落一版 config.json（null = 删文件回未配置态）。 */
function seedConfig(content: string | null): void {
  const file = workspaceConfigFile(root);
  if (content === null) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 尽力而为 */
    }
    return;
  }
  writeFileSync(file, content, "utf8");
}

/** 一个 GREEN 样本（默认阈值下不红）。 */
function greenSample(): CapacitySample {
  return {
    sampledAt: Date.now(),
    totalBytes: 31_300_000_000,
    freeBytes: 15_000_000_000,
    watermark: 0.48,
    steadyTreeBytes: 3_000_000_000,
    headlessTurnCount: 0,
    headlessTurnMaxRssBytes: null,
    degraded: null,
  };
}

// ─────────────────────────── B1 文件层：capacity 段解析 ───────────────────────────

describe("B1 readWorkspaceConfigFile：capacity 段（合法/畸形/扩展位）", () => {
  it("段缺省 → capacity undefined（未配置，非畸形）", () => {
    seedConfig(JSON.stringify({ wake_enabled: true }));
    const file = readWorkspaceConfigFile(root);
    expect(file.present).toBe(true);
    expect(file.wakeEnabled).toBe(true);
    expect(file.capacity).toBeUndefined();
    expect(file.warning).toBeUndefined();
  });

  it("合法三键全部收录", () => {
    seedConfig(JSON.stringify({
      wake_enabled: true,
      capacity: { warn_watermark: 0.2, turn_estimate_bytes: 2147483648, wake_gate: false },
    }));
    const file = readWorkspaceConfigFile(root);
    expect(file.capacity).toEqual({
      warnWatermark: 0.2,
      turnEstimateBytes: 2147483648,
      wakeGate: false,
    });
    expect(file.capacity?.warnings).toBeUndefined();
  });

  it("段内未知键静默忽略（扩展位，不算畸形）", () => {
    seedConfig(JSON.stringify({ capacity: { future_key: 1, warn_watermark: 0.3 } }));
    const file = readWorkspaceConfigFile(root);
    expect(file.capacity?.warnWatermark).toBe(0.3);
    expect(file.capacity?.warnings).toBeUndefined();
  });

  it("纯未知键的段 = 未配置（capacity undefined，无 WARNING）", () => {
    seedConfig(JSON.stringify({ capacity: { something_else: true } }));
    const file = readWorkspaceConfigFile(root);
    expect(file.capacity).toBeUndefined();
    expect(file.warning).toBeUndefined();
  });

  it("段非对象（数组/标量/null）→ 整段忽略 + 一条 WARNING", () => {
    for (const bad of ["[]", "42", "null", '"capacity"']) {
      seedConfig(`{"capacity": ${bad}}`);
      const file = readWorkspaceConfigFile(root);
      expect(file.capacity?.warnings).toHaveLength(1);
      expect(file.capacity?.warnings?.[0]).toContain("WARNING");
      expect(file.capacity?.warnings?.[0]).toContain("capacity 必须是 JSON 对象");
      expect(file.capacity?.warnWatermark).toBeUndefined();
      expect(file.capacity?.turnEstimateBytes).toBeUndefined();
      expect(file.capacity?.wakeGate).toBeUndefined();
    }
  });

  it("逐键畸形：只忽略该键 + 一条 WARNING，其余键不受影响", () => {
    // warn_watermark：字符串 / 0 / 1 / 负数都不合法（合法域 (0,1)）。
    // 注：JSON 无 NaN 字面量（写了=整文件坏 JSON，走顶层披露路径，另测）。
    for (const bad of ['"0.2"', "0", "1", "-0.5"]) {
      seedConfig(`{"capacity": {"warn_watermark": ${bad}, "turn_estimate_bytes": 1024}}`);
      const file = readWorkspaceConfigFile(root);
      expect(file.capacity?.warnWatermark).toBeUndefined();
      expect(file.capacity?.warnings?.length).toBe(1);
      expect(file.capacity?.warnings?.[0]).toContain("warn_watermark");
      expect(file.capacity?.turnEstimateBytes).toBe(1024); // 其余键照常收录
    }
    // turn_estimate_bytes：0/负数/字符串不合法（>0）
    for (const bad of ["0", "-1", '"big"']) {
      seedConfig(`{"capacity": {"turn_estimate_bytes": ${bad}, "wake_gate": false}}`);
      const file = readWorkspaceConfigFile(root);
      expect(file.capacity?.turnEstimateBytes).toBeUndefined();
      expect(file.capacity?.warnings?.length).toBe(1);
      expect(file.capacity?.warnings?.[0]).toContain("turn_estimate_bytes");
      expect(file.capacity?.wakeGate).toBe(false);
    }
    // wake_gate：非布尔不合法
    for (const bad of ['"off"', "1", "null"]) {
      seedConfig(`{"capacity": {"wake_gate": ${bad}, "warn_watermark": 0.4}}`);
      const file = readWorkspaceConfigFile(root);
      expect(file.capacity?.wakeGate).toBeUndefined();
      expect(file.capacity?.warnings?.length).toBe(1);
      expect(file.capacity?.warnings?.[0]).toContain("wake_gate 必须是布尔");
      expect(file.capacity?.warnWatermark).toBe(0.4);
    }
  });

  it("多个键同时畸形 → 每个键一条 WARNING（逐层披露，不合并吞）", () => {
    seedConfig(JSON.stringify({ capacity: { warn_watermark: "x", turn_estimate_bytes: -1, wake_gate: 1 } }));
    const file = readWorkspaceConfigFile(root);
    expect(file.capacity?.warnings).toHaveLength(3);
  });

  it("capacity 段畸形与 wake_enabled 畸形互不波及（两个通道各自披露）", () => {
    seedConfig(JSON.stringify({ wake_enabled: "true", capacity: { warn_watermark: "x" } }));
    const file = readWorkspaceConfigFile(root);
    expect(file.wakeEnabled).toBeUndefined();
    expect(file.warning).toContain("wake_enabled 必须是布尔");
    expect(file.capacity?.warnings?.[0]).toContain("warn_watermark");
  });

  it("整文件坏 JSON → 段不可见（顶层 warning），capacity 不表态", () => {
    seedConfig("{ not json");
    const file = readWorkspaceConfigFile(root);
    expect(file.warning).toContain("不是合法 JSON");
    expect(file.capacity).toBeUndefined();
  });

  it("无缓存现读：同一进程两次调用之间改文件，解析随之变化（热生效契约）", () => {
    seedConfig(JSON.stringify({ capacity: { warn_watermark: 0.2 } }));
    expect(readWorkspaceConfigFile(root).capacity?.warnWatermark).toBe(0.2);
    seedConfig(JSON.stringify({ capacity: { warn_watermark: 0.8 } }));
    expect(readWorkspaceConfigFile(root).capacity?.warnWatermark).toBe(0.8);
    seedConfig(null);
    expect(readWorkspaceConfigFile(root).capacity).toBeUndefined();
  });
});

// ─────────────────────────── B1 分层解析：file > env > default ───────────────────────────

describe("B1 resolveCapacityThresholds：优先级矩阵（file/env/default × 合法/畸形）", () => {
  it("【默认层】无文件 + env 未设 → 三键全缺省，source=default，warnings 空", () => {
    const t = resolveCapacityThresholds(root, {});
    expect(t.warnWatermark).toBe(MEM_WARN_WATERMARK_DEFAULT);
    expect(t.turnEstimateBytes).toBe(TURN_ESTIMATE_DEFAULT_BYTES);
    expect(t.wakeGate).toBe(true);
    expect(t.sources).toEqual({
      warn_watermark: "default",
      turn_estimate_bytes: "default",
      wake_gate: "default",
    });
    expect(t.warnings).toEqual([]);
    expect(t.envRaw).toEqual({ warn_watermark: null, turn_estimate_bytes: null, wake_gate: null });
    expect(t.fileCapacityPresent).toBe(false);
  });

  it("【env 层】合法 env 生效 + source=env + envRaw 原值", () => {
    const t = resolveCapacityThresholds(root, {
      XC_MEM_WARN_WATERMARK: "0.25",
      XC_TURN_ESTIMATE_BYTES: "1234567",
      XC_MEM_WAKE_GATE: "off",
    });
    expect(t.warnWatermark).toBe(0.25);
    expect(t.turnEstimateBytes).toBe(1234567);
    expect(t.wakeGate).toBe(false);
    expect(t.sources).toEqual({ warn_watermark: "env", turn_estimate_bytes: "env", wake_gate: "env" });
    expect(t.envRaw.wake_gate).toBe("off");
    expect(t.warnings).toEqual([]);
  });

  it("【file 压 env】合法 file 三键恒压 env（env 任何值都不参与）", () => {
    seedConfig(JSON.stringify({
      capacity: { warn_watermark: 0.5, turn_estimate_bytes: 2048, wake_gate: false },
    }));
    const t = resolveCapacityThresholds(root, {
      XC_MEM_WARN_WATERMARK: "0.1",
      XC_TURN_ESTIMATE_BYTES: "999",
      XC_MEM_WAKE_GATE: "on",
    });
    expect(t.warnWatermark).toBe(0.5);
    expect(t.turnEstimateBytes).toBe(2048);
    expect(t.wakeGate).toBe(false);
    expect(t.sources).toEqual({ warn_watermark: "file", turn_estimate_bytes: "file", wake_gate: "file" });
    expect(t.fileCapacityPresent).toBe(true);
  });

  it("【file 部分键】只配了一个键 → 该键 file、其余 env/default（逐键独立分层）", () => {
    seedConfig(JSON.stringify({ capacity: { warn_watermark: 0.6 } }));
    const t = resolveCapacityThresholds(root, { XC_TURN_ESTIMATE_BYTES: "4096" });
    expect(t.sources.warn_watermark).toBe("file");
    expect(t.sources.turn_estimate_bytes).toBe("env");
    expect(t.sources.wake_gate).toBe("default");
  });

  it("【畸形回落 env】file 键畸形 → 该键回落 env（合法时）并披露", () => {
    seedConfig(JSON.stringify({ capacity: { warn_watermark: "x" } }));
    const t = resolveCapacityThresholds(root, { XC_MEM_WARN_WATERMARK: "0.3" });
    expect(t.warnWatermark).toBe(0.3);
    expect(t.sources.warn_watermark).toBe("env");
    expect(t.warnings.some((w) => w.includes("warn_watermark"))).toBe(true);
  });

  it("【畸形回落默认】file 键畸形 + env 未给 → default + 披露", () => {
    seedConfig(JSON.stringify({ capacity: { warn_watermark: 2 } }));
    const t = resolveCapacityThresholds(root, {});
    expect(t.warnWatermark).toBe(MEM_WARN_WATERMARK_DEFAULT);
    expect(t.sources.warn_watermark).toBe("default");
    expect(t.warnings.length).toBe(1);
  });

  it("【env 畸形不静默】watermark 越界 → default + MEM_WATERMARK_FALLBACK_WARNING", () => {
    const t = resolveCapacityThresholds(root, { XC_MEM_WARN_WATERMARK: "1.5" });
    expect(t.warnWatermark).toBe(MEM_WARN_WATERMARK_DEFAULT);
    expect(t.sources.warn_watermark).toBe("default");
    expect(t.warnings.some((w) => w.includes("XC_MEM_WARN_WATERMARK 越界"))).toBe(true);
    expect(t.envRaw.warn_watermark).toBe("1.5");
  });

  it("【env 畸形不静默】turn_estimate_bytes 非正 → default + 新披露（此前静默）", () => {
    for (const bad of ["0", "-1", "NaN"]) {
      const t = resolveCapacityThresholds(root, { XC_TURN_ESTIMATE_BYTES: bad });
      expect(t.turnEstimateBytes).toBe(TURN_ESTIMATE_DEFAULT_BYTES);
      expect(t.sources.turn_estimate_bytes).toBe("default");
      expect(t.warnings.some((w) => w.includes("XC_TURN_ESTIMATE_BYTES 非法"))).toBe(true);
      expect(t.envRaw.turn_estimate_bytes).toBe(bad);
    }
  });

  it("【file 畸形时不叠加 env 披露】file 合法收录的键不因 env 越界再披露", () => {
    seedConfig(JSON.stringify({ capacity: { warn_watermark: 0.5 } }));
    const t = resolveCapacityThresholds(root, { XC_MEM_WARN_WATERMARK: "9" });
    expect(t.warnWatermark).toBe(0.5);
    expect(t.warnings).toEqual([]); // file 生效，env 越界与本键无关
  });

  it("【整文件畸形】坏 JSON → 段不可见，env/default 接管", () => {
    seedConfig("{ broken");
    const t = resolveCapacityThresholds(root, { XC_MEM_WARN_WATERMARK: "0.3" });
    expect(t.warnWatermark).toBe(0.3);
    expect(t.fileCapacityPresent).toBe(false);
  });

  it("热生效：两次解析之间改 file，生效值随之变（无缓存）", () => {
    expect(resolveCapacityThresholds(root, {}).wakeGate).toBe(true);
    seedConfig(JSON.stringify({ capacity: { wake_gate: false } }));
    expect(resolveCapacityThresholds(root, {}).wakeGate).toBe(false);
    expect(resolveCapacityThresholds(root, {}).sources.wake_gate).toBe("file");
  });
});

// ─────────────────────────── B1 判定吃分层阈值（detail 标签不虚标） ───────────────────────────

describe("B1 judgeCapacity：thresholds 可选传入（缺省 = env 口径零变化）", () => {
  it("无 thresholds → env 口径（detail 写 env 名）——既有回归口径", () => {
    const verdict = judgeCapacity(greenSample(), { XC_MEM_WARN_WATERMARK: "0.99" });
    expect(verdict.red).toBe(true);
    expect(verdict.detail[0]).toContain("XC_MEM_WARN_WATERMARK");
  });

  it("file 层阈值生效：0.5 预警线把 0.48 样本判红，detail 写 config.json 而非 env 名", () => {
    const thresholds = resolveCapacityThresholds(root, {});
    seedConfig(JSON.stringify({ capacity: { warn_watermark: 0.5 } }));
    const layered = resolveCapacityThresholds(root, {});
    const verdict = judgeCapacity(greenSample(), {}, layered);
    expect(verdict.red).toBe(true);
    expect(verdict.violated).toEqual(["watermark"]);
    expect(verdict.detail[0]).toContain("config.json capacity.warn_watermark");
    expect(verdict.detail[0]).not.toContain("XC_MEM_WARN_WATERMARK");
    // 同一样本在缺省阈值下不红（证明是 file 层在起作用）
    expect(judgeCapacity(greenSample(), {}, thresholds).red).toBe(false);
  });

  it("turn_estimate_bytes 分层生效（red3 判据听 file 层）", () => {
    seedConfig(JSON.stringify({ capacity: { turn_estimate_bytes: 16000000000 } }));
    const layered = resolveCapacityThresholds(root, {});
    const sample = { ...greenSample(), headlessTurnCount: 1, headlessTurnMaxRssBytes: 100 };
    const verdict = judgeCapacity(sample, {}, layered);
    expect(verdict.violated).toContain("turn-concurrency");
    expect(verdict.detail.some((d) => d.includes("config.json capacity.turn_estimate_bytes"))).toBe(true);
  });

  it("来源标签函数：file 层写 config.json，env/default 层写 env 名", () => {
    expect(capacityThresholdLabel("warn_watermark", "file")).toBe("config.json capacity.warn_watermark");
    expect(capacityThresholdLabel("warn_watermark", "env")).toBe("XC_MEM_WARN_WATERMARK");
    expect(capacityThresholdLabel("wake_gate", "default")).toBe("XC_MEM_WAKE_GATE");
  });
});

// ─────────────────────────── B4 配置生效值状态对拍 ───────────────────────────

describe("B4 diffCapacityConfigState：首访立基线 / 变更恰一条 / 不变更零事件", () => {
  const now = 1_800_000_000_000;

  it("首访（无状态文件）→ 静默立基线，返回空（首次观测不是变更）", async () => {
    const t = resolveCapacityThresholds(root, {});
    const changes = await diffCapacityConfigState(root, t, now);
    expect(changes).toEqual([]);
    const state = await readCapacityConfigState(root);
    expect(state?.values.warn_watermark).toBe(MEM_WARN_WATERMARK_DEFAULT);
    expect(state?.sources.warn_watermark).toBe("default");
    expect(existsSync(capacityConfigStateFile(root))).toBe(true);
  });

  it("改 file 层 → 恰一条 change（from/to/source 正确）", async () => {
    const before = resolveCapacityThresholds(root, {});
    await diffCapacityConfigState(root, before, now);
    seedConfig(JSON.stringify({ capacity: { warn_watermark: 0.2, wake_gate: false } }));
    const after = resolveCapacityThresholds(root, {});
    const changes = await diffCapacityConfigState(root, after, now + 1000);
    expect(changes).toEqual([
      { key: "warn_watermark", from: MEM_WARN_WATERMARK_DEFAULT, to: 0.2, source: "file" },
      { key: "wake_gate", from: true, to: false, source: "file" },
    ]);
    const state = await readCapacityConfigState(root);
    expect(state?.observedAt).toBe(now + 1000);
    expect(state?.values.wake_gate).toBe(false);
  });

  it("不变更 → 空数组且不写文件（防刷屏：零事件零 IO）", async () => {
    const t = resolveCapacityThresholds(root, {});
    await diffCapacityConfigState(root, t, now);
    const before = statSync(capacityConfigStateFile(root)).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));
    const changes = await diffCapacityConfigState(root, t, now + 5000);
    expect(changes).toEqual([]);
    expect(statSync(capacityConfigStateFile(root)).mtimeMs).toBe(before);
  });

  it("env 层变更同样产出事件（source=env）", async () => {
    await diffCapacityConfigState(root, resolveCapacityThresholds(root, {}), now);
    const t = resolveCapacityThresholds(root, { XC_MEM_WARN_WATERMARK: "0.4" });
    const changes = await diffCapacityConfigState(root, t, now + 1);
    expect(changes).toEqual([
      { key: "warn_watermark", from: MEM_WARN_WATERMARK_DEFAULT, to: 0.4, source: "env" },
    ]);
  });

  it("状态文件损坏 → 按无历史重立基线（不抛、零事件）", async () => {
    const file = capacityConfigStateFile(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ broken json", "utf8");
    const t = resolveCapacityThresholds(root, {});
    const changes = await diffCapacityConfigState(root, t, now);
    expect(changes).toEqual([]);
    const state = await readCapacityConfigState(root);
    expect(state?.values.warn_watermark).toBe(MEM_WARN_WATERMARK_DEFAULT);
    // 重立后可继续对拍
    seedConfig(JSON.stringify({ capacity: { turn_estimate_bytes: 2048 } }));
    const t2 = resolveCapacityThresholds(root, {});
    const changes2 = await diffCapacityConfigState(root, t2, now + 1);
    expect(changes2).toEqual([
      { key: "turn_estimate_bytes", from: TURN_ESTIMATE_DEFAULT_BYTES, to: 2048, source: "file" },
    ]);
  });

  it("状态文件版本不匹配 → 同样按无历史处理", async () => {
    const file = capacityConfigStateFile(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 99, values: {} }), "utf8");
    expect(await readCapacityConfigState(root)).toBeNull();
    const changes = await diffCapacityConfigState(root, resolveCapacityThresholds(root, {}), now);
    expect(changes).toEqual([]);
  });

  it("落盘形状：version 1 + values/sources 三键齐全（状态文件是机器可读真源）", async () => {
    await diffCapacityConfigState(root, resolveCapacityThresholds(root, {}), now);
    const raw = JSON.parse(readFileSync(capacityConfigStateFile(root), "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(1);
    expect(Object.keys(raw["values"] as Record<string, unknown>).sort()).toEqual([
      "turn_estimate_bytes",
      "wake_gate",
      "warn_watermark",
    ]);
    expect(Object.keys(raw["sources"] as Record<string, unknown>).sort()).toEqual([
      "turn_estimate_bytes",
      "wake_gate",
      "warn_watermark",
    ]);
  });
});
