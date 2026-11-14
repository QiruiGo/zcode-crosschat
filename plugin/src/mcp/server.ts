/**
 * v0.6 server：stdio MCP 入口（DESIGN-V0.6.md §4.2-M8 组装块）。
 *
 * manifest 经 mcpServers.crosschat 拉起本进程（command:"node",
 * args:["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.mjs"], cwd:"${ZCODE_PROJECT_DIR}"），
 * 因此 process.cwd() = 会话工作区，状态根 = <workspace>/.crosschat（§2.2）。
 *
 * stdio 纪律：协议独占 stdout——任何日志/报错只准写 stderr，否则握手即坏。
 *
 * v0.6 工具面（26→10）：server.tool() 只注册 10 个新名（tools/list 恰 10 个——
 * 条款 1 硬验收）；旧名 22 个的可调用性由 alias.ts 覆盖层实现（CallTool 处理器
 * 整体替换，参数映射 + 弃用警告 + payload.deprecated；DESIGN §1.3）。
 * 「双入口单实现」：dispatcher 与 server.tool 回调共用同一 handler（PrimaryRegistry）。
 *
 * 组装链不变：composeCore = base → withTaskEdges → withGuards → withPeerDrain。
 * GuardedStdioTransport / startStaleSweeper / stdin EOF 纪律全部原样保留。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { composeCore, resolveDeps, type PrimaryRegistry, type ToolDeps } from "./core.js";
import { installAliasLayer } from "./alias.js";
import { registerIdentifyTools } from "./tools-identify.js";
import { registerTaskTools } from "./tools-tasks.js";
import { registerReadTools } from "./tools-read.js";
import { registerRelay } from "./tools-relay.js";
import { registerOverviewTools } from "./tools-overview.js";
import { registerTeamTools } from "./tools-team.js";
import { registerReviewTools } from "./tools-review.js";
import { registerDoctorTool } from "./doctor-tool.js";
import { startStaleSweeper } from "./task-edges.js";
import { stopPeerEndpoint } from "../transport/pipe.js";
import { GuardedStdioTransport } from "../transport/mcpstdio.js";

const SERVER_NAME = "zcode-crosschat";
const SERVER_VERSION = "0.6.0";

let shuttingDown = false;

/** 优雅关闭：先摘注册表记录与管道端点，再退出。写失败/关闭失败都不得阻塞退出。 */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stopPeerEndpoint();
  } catch {
    /* best effort：退出纪律优先于清理结果 */
  }
  process.exit(0);
}

export async function main(): Promise<void> {
  const deps: ToolDeps = resolveDeps(process.cwd(), process.env);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const core = composeCore(deps);
  const registry: PrimaryRegistry = new Map();

  // v0.6：家族注册器——server.tool()（tools/list 发现面）+ registry（分发面）。
  registerIdentifyTools(server, deps, core, registry);   // xc_identify
  registerTaskTools(server, deps, core, registry);       // xc_dispatch / xc_claim / xc_report
  registerReadTools(server, deps, core, registry);       // xc_read
  registerRelay(server, deps, core, registry);           // xc_relay（M4 家族注册器）
  registerOverviewTools(server, deps, core, registry);   // xc_overview
  registerTeamTools(server, deps, core, registry);       // xc_team
  registerReviewTools(server, deps, core, registry);     // xc_review
  registerDoctorTool(server, {                           // xc_doctor（免注册只读体检）
    version: SERVER_VERSION, env: process.env, cwd: process.cwd(),
  });
  // doctor 的 handler 也登记进分发面（alias 层接管 CallTool 后的唯一通路）。
  registry.set("xc_doctor", {
    description: "Read-only self check: plugin version, runtime, auto-detected zcode_exe/zcode_cjs paths and probe attempts. Does not require registration.",
    shape: {},
    handler: async () => {
      const { buildDoctorReport } = await import("./doctor-tool.js");
      const report = buildDoctorReport({ version: SERVER_VERSION, env: process.env, cwd: process.cwd() });
      const lines = [
        `zcode-crosschat ${report.plugin.version}`,
        `runtime: node ${report.runtime.node} @ ${report.runtime.execPath} (${report.runtime.platform})`,
        `zcode_exe/zcode_cjs: env(set=${report.spawnPaths.zcode_exe_env_set}/${report.spawnPaths.zcode_cjs_env_set})` +
          ` locate(found=${report.spawnPaths.locate.found}, source=${report.spawnPaths.locate.source || "-"})`,
        `exe: ${report.spawnPaths.locate.exe || "(未定)"}`,
        `cjs: ${report.spawnPaths.locate.cjs || "(未定)"}`,
        `member_model(XC_MEMBER_MODEL): ${report.spawnPaths.member_model_env_value || "(空=枚举表自动选第一个)"}`,
        ...(report.spawnPaths.locate.configError !== undefined ? [`WARNING: ${report.spawnPaths.locate.configError}`] : []),
        ...report.spawnPaths.locate.attempts.map((a) => `- [${a.hit ? "命中" : "未中"}] ${a.step}: ${a.detail}`),
        ...(report.guidance !== "" ? [`指引: ${report.guidance}`] : []),
      ];
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          { type: "text" as const, text: JSON.stringify(report) },
        ],
      };
    },
  });

  // v0.6（§1.3）：旧名弃用覆盖层——必须全部注册之后、connect 之前安装。
  // dispatcher 对 PRIMARY 名做 zod 校验（与 SDK 同款 InvalidParams 错误）后调
  // registry 的 handler；未知名抛标准 "Tool not found"。
  installAliasLayer(server, (name, args, extra) => dispatchPrimary(registry, name, args, extra));

  // v0.5.1（CONC-2 修复）：带大帧守卫的 stdio 传输——≥10MiB 帧 JSON-RPC 拒收且
  // server 继续服务（transport/mcpstdio.ts）。
  const transport = new GuardedStdioTransport();
  transport.onclose = () => {
    void shutdown();
  };
  await server.connect(transport);

  // v0.5.1（故障注-8 修复）：周期僵尸清扫（unref 不改退出语义）。
  startStaleSweeper(deps);

  // v0.3 EOF 纪律（FEASIBILITY-V0.3 §3.3）：SDK 不监听 stdin 'end'，必须自建。
  process.stdin.once("end", () => {
    void shutdown();
  });
  process.stdin.once("close", () => {
    void shutdown();
  });
}

/** PRIMARY 分发：zod 校验（SDK 同款错误口径）→ handler（extra 原样透传，L1）。 */
export async function dispatchPrimary(
  registry: PrimaryRegistry,
  name: string,
  args: Record<string, unknown>,
  extra: unknown,
): Promise<unknown> {
  const entry = registry.get(name);
  if (entry === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
  }
  const parsed = z.object(entry.shape).safeParse(args);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new McpError(ErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${name}: ${message}`);
  }
  return await entry.handler(parsed.data as Record<string, unknown>, extra);
}

// 只在直接执行（dist 产物被 node 运行）时启动；被测试 import 时不自启。
// ESM 下没有 require.main，用 import.meta.url 与 argv[1] 对比近似判断。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");

if (invokedDirectly) {
  main().catch((err: unknown) => {
    // stdout 被协议占用，错误只能去 stderr。
    console.error("[zcode-crosschat] mcp server failed:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
