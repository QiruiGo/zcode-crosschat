/**
 * W2 doctor-tool 用例（DESIGN-V0.4 §2.5：report 构造 / 注册 smoke）。
 *
 * 覆盖范围（模块划分 §6.1：本文件=report 构造/注册 smoke 用例）：
 *  - buildDoctorReport：env（user_config）命中场景的全字段构造——确定性与零探测成本
 *    （env 命中不触发任何 PowerShell 子进程，zcode-locate §2.3 ①）；
 *  - registerDoctorTool：经 InMemoryTransport 走真实 MCP 协议的 listTools/callTool smoke，
 *    断言回执的可读文本与 JSON 载体两块 content。
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
import { buildDoctorReport, registerDoctorTool, type DoctorReport } from "./doctor-tool.js";

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
