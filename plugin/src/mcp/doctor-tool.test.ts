/**
 * W2 doctor-tool 用例（DESIGN-V0.4 §2.5：report 构造 / 注册 smoke）。
 *
 * 覆盖范围（模块划分 §6.1：本文件=report 构造/注册 smoke 用例）：
 *  - buildDoctorReport：env（user_config）命中场景的全字段构造——确定性与零探测成本
 *    （env 命中不触发任何 PowerShell 子进程，zcode-locate §2.3 ①）；
 *  - registerDoctorTool：经 InMemoryTransport 走真实 MCP 协议的 listTools/callTool smoke，
 *    断言回执的可读文本与 JSON 载体两块 content。
 *  - v0.7.2（C9-B6 修复）：容量挂载——PROTOCOL §5 承诺「xc_overview/xc_doctor 调用时
 *    惰性采样」，doctor 这一半此前不成立；现在经 stateRoot + capacitySampler 缝验证
 *    「挂了/展示同源/意外降级不挂载」三条，不真起 PowerShell。
 *
 * 不在本文件覆盖（归属划分，DESIGN-V0.4 复核轮 F3）：探测全败 guidance、探测顺序、
 * 成功缓存/env-优先不变式 —— 归 zcode-locate.test.ts（R1，经 ZcodeProbe 注入缝）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildDoctorReport,
  registerDoctorTool,
  renderDoctorText,
  sampleDoctorCapacity,
  doctorToolResult,
  type CapacitySamplerFn,
  type DoctorReport,
} from "./doctor-tool.js";
import { capacityCacheFile, type CapacitySample } from "../core/capacity.js";

/** 造一个 existsSync 即可通过的 (exe, cjs) 文件对（内容无关，探测只判存在）。 */
function makePairDir(): { dir: string; exe: string; cjs: string } {
  const dir = mkdtempSync(join(tmpdir(), "xc-doctor-test-"));
  const exe = join(dir, "ZCode.exe");
  const cjs = join(dir, "zcode.cjs");
  writeFileSync(exe, "stub");
  writeFileSync(cjs, "stub");
  return { dir, exe, cjs };
}

const pairDir = makePairDir();

afterAll(() => {
  rmSync(pairDir.dir, { recursive: true, force: true });
});

/** env 命中（user_config）的标准 input：零子进程、确定性。 */
function envHitInput(overrides: Partial<{ version: string; cwd: string }> = {}) {
  return {
    version: "0.4.0-test",
    env: {
      XC_ZCODE_EXE: pairDir.exe,
      XC_ZCODE_CJS: pairDir.cjs,
      XC_MEMBER_MODEL: "glm-test-model",
    } as NodeJS.ProcessEnv,
    cwd: "D:/fake/workspace",
    ...overrides,
  };
}

describe("buildDoctorReport（report 构造，env 命中场景）", () => {
  const report: DoctorReport = buildDoctorReport(envHitInput());

  it("locate 结果=user_config 命中，exe/cjs 与 env 一致，guidance 为空", () => {
    expect(report.spawnPaths.locate.found).toBe(true);
    expect(report.spawnPaths.locate.source).toBe("user_config");
    expect(report.spawnPaths.locate.exe).toBe(pairDir.exe);
    expect(report.spawnPaths.locate.cjs).toBe(pairDir.cjs);
    expect(report.guidance).toBe("");
  });

  it("attempts 留痕：首步 env 命中", () => {
    expect(report.spawnPaths.locate.attempts.length).toBeGreaterThanOrEqual(1);
    const first = report.spawnPaths.locate.attempts[0]!;
    expect(first.step).toBe("env");
    expect(first.hit).toBe(true);
    expect(first.detail).toContain("XC_ZCODE_EXE");
  });

  it("plugin 字段透传 version，name 固定", () => {
    expect(report.plugin).toEqual({ name: "zcode-crosschat", version: "0.4.0-test" });
  });

  it("runtime 取自当前进程与传入 cwd", () => {
    expect(report.runtime.node).toBe(process.version);
    expect(report.runtime.execPath).toBe(process.execPath);
    expect(report.runtime.platform).toBe(process.platform);
    expect(report.runtime.cwd).toBe("D:/fake/workspace");
  });

  it("spawnPaths 标志与 member_model 透传", () => {
    expect(report.spawnPaths.zcode_exe_env_set).toBe(true);
    expect(report.spawnPaths.zcode_cjs_env_set).toBe(true);
    expect(report.spawnPaths.member_model_env_value).toBe("glm-test-model");
  });

  it("XC_MEMBER_MODEL 空白串归一为空串（doctor 显示「留空」语义的输入侧）", () => {
    const r = buildDoctorReport({
      ...envHitInput(),
      env: { XC_ZCODE_EXE: pairDir.exe, XC_ZCODE_CJS: pairDir.cjs, XC_MEMBER_MODEL: "   " },
    });
    expect(r.spawnPaths.member_model_env_value).toBe("");
  });
});

describe("buildDoctorReport：显式配置无效 → configError WARNING（v0.5.3 A5 修复）", () => {
  // 红队 a5 形态：doctor 此前显示 env(set=true) 却给出探测到的 exe（source=process_table），
  // 配置被静默弃用且无任何警告。修复后：locate(found=false, source=user_config) + WARNING 行。
  it("report：found=false、source=user_config、configError 携带无效路径根因", () => {
    const badExe = "E:\\nonexistent-dir-9999\\ZCode.exe";
    const report = buildDoctorReport({
      ...envHitInput(),
      env: { XC_ZCODE_EXE: badExe, XC_MEMBER_MODEL: "" } as NodeJS.ProcessEnv,
    });
    expect(report.spawnPaths.zcode_exe_env_set).toBe(true);
    expect(report.spawnPaths.locate.found).toBe(false);
    expect(report.spawnPaths.locate.source).toBe("user_config");
    expect(report.spawnPaths.locate.exe).toBe(""); // 不再给出探测到的 exe
    expect(report.spawnPaths.locate.configError).toContain(badExe);
    expect(report.spawnPaths.locate.configError).toContain("文件不存在");
    expect(report.guidance).toBe(report.spawnPaths.locate.configError);
  });

  it("协议面：可读文本含 WARNING 行与 locate(found=false)，JSON 载体同步 configError", async () => {
    const server = new McpServer({ name: "doctor-test-server", version: "0.0.0" });
    registerDoctorTool(server, {
      ...envHitInput(),
      env: { XC_ZCODE_EXE: "E:\\nonexistent-dir-9999\\ZCode.exe" } as NodeJS.ProcessEnv,
    });
    const [serverT, clientT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "doctor-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const result = (await client.callTool({ name: "xc_doctor", arguments: {} })) as unknown as {
        content: Array<{ type: string; text: string }>;
      };
      const readable = result.content[0]!.text;
      expect(readable).toContain("locate(found=false, source=user_config)");
      expect(readable).toContain("WARNING: XC_ZCODE_EXE/XC_ZCODE_CJS 显式配置无效");
      expect(readable).toContain("nonexistent-dir-9999");
      expect(readable).toContain("指引: ");
      const parsed = JSON.parse(result.content[1]!.text) as DoctorReport;
      expect(parsed.spawnPaths.locate.configError).toContain("nonexistent-dir-9999");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("registerDoctorTool（注册 smoke：真实 MCP 协议面）", () => {
  it("listTools 暴露 xc_doctor，空参数 shape", async () => {
    const server = new McpServer({ name: "doctor-test-server", version: "0.0.0" });
    registerDoctorTool(server, envHitInput());
    const [serverT, clientT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "doctor-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const { tools } = await client.listTools();
      const doctor = tools.find((t) => t.name === "xc_doctor");
      expect(doctor).toBeDefined();
      expect(doctor!.description).toContain("Read-only self check");
      // 空 shape：schema 不要求任何必填参数
      const required = (doctor!.inputSchema as { required?: string[] }).required ?? [];
      expect(required).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("callTool 返回两块 text：可读文本 + JSON 载体（JSON 与 report 同构）", async () => {
    const server = new McpServer({ name: "doctor-test-server", version: "0.0.0" });
    registerDoctorTool(server, envHitInput());
    const [serverT, clientT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "doctor-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const result = (await client.callTool({ name: "xc_doctor", arguments: {} })) as unknown as {
        content: Array<{ type: string; text: string }>;
        isError?: unknown;
      };
      expect(result.isError).toBeFalsy();
      expect(result.content.length).toBe(2);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[1]!.type).toBe("text");

      // 可读文本：版本、locate 概览、env 命中行、exe/cjs 行；found=true 无指引行
      const readable = result.content[0]!.text;
      expect(readable).toContain("zcode-crosschat 0.4.0-test");
      expect(readable).toContain("locate(found=true, source=user_config)");
      expect(readable).toContain("env(set=true/true)");
      expect(readable).toContain(`exe: ${pairDir.exe}`);
      expect(readable).toContain(`cjs: ${pairDir.cjs}`);
      expect(readable).toContain("member_model(XC_MEMBER_MODEL): glm-test-model");
      expect(readable).toContain("- [命中] env:");
      expect(readable).not.toContain("指引: ");

      // JSON 载体：与 DoctorReport 同构、可二次解析
      const parsed = JSON.parse(result.content[1]!.text) as DoctorReport;
      expect(parsed.plugin.version).toBe("0.4.0-test");
      expect(parsed.spawnPaths.locate.found).toBe(true);
      expect(parsed.spawnPaths.locate.source).toBe("user_config");
      expect(parsed.spawnPaths.locate.attempts[0]?.step).toBe("env");
      expect(parsed.guidance).toBe("");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// v0.7.2（C9-B6 修复，25-能力反向检验）：xc_doctor 参与容量惰性采样并展示。
// PROTOCOL §5「仅在 xc_overview/xc_doctor 调用时惰性采样」——此前 doctor 既不采样
// 也不展示（红队 C9-12：doctor-only 调用后 capacity/sample.json 都不落盘）。
// 全部经 capacitySampler 缝注入，不真起 PowerShell（确定性 + 零子进程）。
// ---------------------------------------------------------------------------

const GB = 1024 * 1024 * 1024;

function greenSample(): CapacitySample {
  return {
    sampledAt: 1_700_000_000_000,
    totalBytes: 32 * GB,
    freeBytes: 24 * GB,
    watermark: 0.75,
    steadyTreeBytes: Math.round(4.1 * GB),
    headlessTurnCount: 0,
    headlessTurnMaxRssBytes: null,
    degraded: null,
    categoryCounts: { main: 2, "plugin-host": 12 },
  };
}

function redSample(): CapacitySample {
  return {
    ...greenSample(),
    freeBytes: Math.round(3.7 * GB),
    watermark: 3.7 / 32,
    headlessTurnCount: 3,
    headlessTurnMaxRssBytes: Math.round(0.86 * GB),
  };
}

/** 采样缝：记录调用参数（cacheFile/now）并返回固定样本。 */
function recordingSampler(sample: CapacitySample): CapacitySamplerFn & { calls: Array<{ cacheFile: string; now: number }> } {
  const calls: Array<{ cacheFile: string; now: number }> = [];
  const fn = (async (_env: NodeJS.ProcessEnv, cacheFile: string, now: number) => {
    calls.push({ cacheFile, now });
    return sample;
  }) as CapacitySamplerFn & { calls: Array<{ cacheFile: string; now: number }> };
  fn.calls = calls;
  return fn;
}

describe("v0.7.2 C9-B6：xc_doctor 容量采样与展示（PROTOCOL §5 对齐）", () => {
  it("sampleDoctorCapacity：与 xc_overview 同一缓存文件（capacityCacheFile(stateRoot)）与同一判定", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "xc-doctor-cap-"));
    try {
      const sampler = recordingSampler(greenSample());
      const cap = await sampleDoctorCapacity({ env: {}, stateRoot, now: 1234, capacitySampler: sampler });
      expect(cap).not.toBeNull();
      expect(sampler.calls).toHaveLength(1);
      expect(sampler.calls[0]!.cacheFile).toBe(capacityCacheFile(stateRoot));
      expect(sampler.calls[0]!.now).toBe(1234);
      expect(cap!.watermark).toBeCloseTo(0.75, 5);
      expect(cap!.red).toBe(false);
      expect(cap!.violated).toEqual([]);
      expect(cap!.steadyTreeBytes).toBe(Math.round(4.1 * GB));
      expect(cap!.categoryCounts).toEqual({ main: 2, "plugin-host": 12 });
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("红样本：judgeCapacity 结论随挂载透出（violated/detail/red 与 overview 同口径）", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "xc-doctor-cap-"));
    try {
      const cap = await sampleDoctorCapacity({
        env: {},
        stateRoot,
        capacitySampler: recordingSampler(redSample()),
      });
      expect(cap!.red).toBe(true);
      expect(cap!.violated).toEqual(["watermark", "session-limit", "turn-concurrency"]);
      expect(cap!.detail.some((d) => d.startsWith("turn-concurrency:"))).toBe(true);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  // v0.8.1（29 红队 C4-O1 修复）：XC_MEM_WARN_WATERMARK 越界（≥1/0/负数/非数字）
  // 不再静默按缺省判定——doctor 的诊断面给出 payload 键 + WARNING 行（裁决建议的
  // 「至少在 xc_doctor 或 payload detail 里给一条提示」两处都落）。
  it("C4-O1：水位预警线越界 → capacity.memWarnWatermarkFallback + 文本 WARNING；合法值不披露", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "xc-doctor-cap-"));
    try {
      const cap = await sampleDoctorCapacity({
        env: { XC_MEM_WARN_WATERMARK: "2" }, // 越界：字面执行应恒 RED，旧实现静默按 0.15
        stateRoot,
        capacitySampler: recordingSampler(greenSample()),
      });
      expect(cap!.memWarnWatermarkFallback).toBe(true);
      const report = buildDoctorReport({ ...envHitInput(), capacity: cap });
      expect(renderDoctorText(report)).toContain("WARNING XC_MEM_WARN_WATERMARK 越界");
      expect(JSON.stringify(report)).toContain("memWarnWatermarkFallback");

      const ok = await sampleDoctorCapacity({
        env: { XC_MEM_WARN_WATERMARK: "0.1" }, // 合法域内
        stateRoot,
        capacitySampler: recordingSampler(greenSample()),
      });
      expect(ok!.memWarnWatermarkFallback).toBeUndefined();
      expect(renderDoctorText(buildDoctorReport({ ...envHitInput(), capacity: ok })))
        .not.toContain("WARNING XC_MEM_WARN_WATERMARK");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("buildDoctorReport：capacity 给定时进 report，absent 时不出键（形状兼容）", () => {
    const cap = buildDoctorReport(envHitInput()).capacity;
    expect(cap).toBeUndefined();
    const withCap = buildDoctorReport({
      ...envHitInput(),
      capacity: {
        sampledAt: 1, totalBytes: 2, freeBytes: 1, watermark: 0.5,
        steadyTreeBytes: null, headlessTurnCount: 0, headlessTurnMaxRssBytes: null,
        degraded: null, red: false, violated: [], detail: [],
      },
    });
    expect(withCap.capacity?.watermark).toBe(0.5);
  });

  it("可读文本面：capacity 摘要行 + 标红明细 + compress-advice（与 formatCapacityLines 同源）", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "xc-doctor-cap-"));
    try {
      const cap = await sampleDoctorCapacity({ env: {}, stateRoot, capacitySampler: recordingSampler(redSample()) });
      const text = renderDoctorText(buildDoctorReport({ ...envHitInput(), capacity: cap }));
      expect(text).toMatch(/capacity: RED \| 水位 11\.6% 可用/);
      expect(text).toContain("- watermark:");
      expect(text).toContain("- turn-concurrency:");
      expect(text).toContain("compress-advice:");
      // locate 面仍在（容量是追加块，不替换原体检面）
      expect(text).toContain("locate(found=true, source=user_config)");
      // JSON 载体同步带 capacity 块
      const parsed = JSON.parse(doctorToolResult(buildDoctorReport({ ...envHitInput(), capacity: cap })).content[1]!.text) as DoctorReport;
      expect(parsed.capacity?.red).toBe(true);
      expect(parsed.capacity?.violated).toEqual(["watermark", "session-limit", "turn-concurrency"]);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("采样意外（sampler 抛错）→ 不挂载 capacity，体检其余面照常（观测面永不为难体检面）", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "xc-doctor-cap-"));
    try {
      const boom: CapacitySamplerFn = async () => { throw new Error("cim exploded"); };
      const cap = await sampleDoctorCapacity({ env: {}, stateRoot, capacitySampler: boom });
      expect(cap).toBeNull();
      const text = renderDoctorText(buildDoctorReport({ ...envHitInput(), capacity: cap }));
      expect(text).not.toContain("capacity:");
      expect(text).toContain("locate(found=true, source=user_config)");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("协议面：stateRoot 给定时 callTool 的可读文本与 JSON 载体都带 capacity（真实 MCP 往返）", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "xc-doctor-cap-"));
    try {
      const server = new McpServer({ name: "doctor-test-server", version: "0.0.0" });
      registerDoctorTool(server, {
        ...envHitInput(),
        stateRoot,
        capacitySampler: recordingSampler(greenSample()),
      });
      const [serverT, clientT] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "doctor-test-client", version: "0.0.0" });
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      try {
        const result = (await client.callTool({ name: "xc_doctor", arguments: {} })) as unknown as {
          content: Array<{ type: string; text: string }>;
          isError?: unknown;
        };
        expect(result.isError).toBeFalsy();
        expect(result.content[0]!.text).toMatch(/capacity: GREEN \| 水位 75\.0% 可用/);
        const parsed = JSON.parse(result.content[1]!.text) as DoctorReport;
        expect(parsed.capacity?.watermark).toBeCloseTo(0.75, 5);
        expect(parsed.capacity?.red).toBe(false);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
