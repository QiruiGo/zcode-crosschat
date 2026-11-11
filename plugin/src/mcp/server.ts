/**
 * M3 server：stdio MCP 入口（DESIGN.md §1.3、§2.8；v0.2 组装链见 DESIGN-V0.2.md §9；
 * v0.3 增量见 DESIGN-V0.3.md §2.3、§11.1；v0.4 增量见 DESIGN-V0.4.md §2.5）。
 *
 * manifest 经 mcpServers.crosschat 拉起本进程（command:"node",
 * args:["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.mjs"], cwd:"${ZCODE_PROJECT_DIR}"），
 * 因此 process.cwd() = 会话工作区，状态根 = <workspace>/.crosschat（§2.2）。
 *
 * stdio 纪律：协议独占 stdout——任何日志/报错只准写 stderr，否则握手即坏。
 *
 * v0.3 组装链：
 *   base(createToolCore) → W3 withTaskEdges → W5 withGuards → W6 withPeerDrain
 * 注册：v0.1.0 七工具 + W2 member-tools + W4 lead-tools + W5 security-tools
 *       + W6 peer-tools（xc_peer_register / xc_peers / xc_peer_send /
 *         xc_peer_inbox / xc_peer_review / xc_peer_rename / xc_agents）
 *       + doctor-tool（v0.4：xc_doctor，只读体检，免注册）
 *
 * v0.3 端点纪律（FEASIBILITY-V0.3 §3.3 实测硬约束）：MCP SDK 的 StdioServerTransport
 * 不监听 stdin 'end'，一旦进程内持有 net server（管道监听），stdin EOF 时事件循环被
 * server 撑着、进程永不退出、管道继续对外可连接（僵尸端点）。故 v0.3 自建 EOF 纪律：
 * process.stdin 的 'end'/'close' 也要走优雅关闭（删注册表记录 + 关管道 + exit(0)）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolCore, registerTools, resolveDeps, type ToolCore, type ToolDeps } from "./tools.js";
import { withTaskEdges } from "./task-edges.js";
import { withGuards, registerSecurityTools } from "./guards.js";
import { registerMemberTools } from "./member-tools.js";
import { registerLeadTools } from "./lead-tools.js";
import { registerPeerTools } from "./peer-tools.js";
import { withPeerDrain } from "./peer-drain.js";
import { registerDoctorTool } from "./doctor-tool.js";
import { stopPeerEndpoint } from "../transport/pipe.js";

const SERVER_NAME = "zcode-crosschat";
const SERVER_VERSION = "0.5.0";

/** v0.3 工具核心组装链：包装顺序固定——先边沿后守卫，守卫（安全）最贴近工具入口，
 *  peer 投递排空最外层（tool-round 间隙把信封**追加为末尾 text 块 content[2]**，
 *  content[0]/content[1] 逐字节不变——§7.1「面 B 的插入形态」）。 */
export function composeCore(deps: ToolDeps): ToolCore {
  const base = createToolCore(deps);
  const edges = withTaskEdges(base, deps);
  const guarded = withGuards(edges, deps);
  return withPeerDrain(guarded, deps);
}

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
  const deps = resolveDeps(process.cwd(), process.env);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const core = composeCore(deps);
  registerTools(server, deps, core);      // v0.1.0 七工具，注入包装后的 core
  registerMemberTools(server, deps);      // W2：xc_member_add / xc_member_stop
  registerLeadTools(server, deps);        // W4：xc_team_init / xc_idle / xc_cancel
  registerSecurityTools(server, deps);    // W5：xc_inbound_review
  registerPeerTools(server, deps);         // v0.3 W6：跨会话 peer 工具面
  registerDoctorTool(server, {            // v0.4：xc_doctor（只读体检，免注册）
    version: SERVER_VERSION, env: process.env, cwd: process.cwd(),
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void shutdown();
  };
  await server.connect(transport);

  // v0.3 EOF 纪律（FEASIBILITY-V0.3 §3.3）：SDK 不监听 stdin 'end'，必须自建。
  process.stdin.once("end", () => {
    void shutdown();
  });
  process.stdin.once("close", () => {
    void shutdown();
  });
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
