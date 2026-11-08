/**
 * M3 server：stdio MCP 入口（DESIGN.md §1.3、§2.8；v0.2 组装链见 DESIGN-V0.2.md §9）。
 *
 * manifest 经 mcpServers.crosschat 拉起本进程（command:"node",
 * args:["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.mjs"], cwd:"${ZCODE_PROJECT_DIR}"），
 * 因此 process.cwd() = 会话工作区，状态根 = <workspace>/.crosschat（§2.2）。
 *
 * stdio 纪律：协议独占 stdout——任何日志/报错只准写 stderr，否则握手即坏。
 *
 * v0.2 组装链（DESIGN-V0.2 §9.1）：
 *   base(createToolCore) → W3 withTaskEdges（清扫+依赖解除+unblock 唤醒）
 *                        → W5 withGuards（removed 硬拒+入站策略）
 *   注册：v0.1.0 七工具（包装后）+ W2 member-tools + W4 lead-tools + W5 security-tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolCore, registerTools, resolveDeps, type ToolCore, type ToolDeps } from "./tools.js";
import { withTaskEdges } from "./task-edges.js";
import { withGuards, registerSecurityTools } from "./guards.js";
import { registerMemberTools } from "./member-tools.js";
import { registerLeadTools } from "./lead-tools.js";

const SERVER_NAME = "zcode-crosschat";
const SERVER_VERSION = "0.2.0";

/** v0.2 工具核心组装链：包装顺序固定——先边沿后守卫，守卫（安全）最贴近工具入口。 */
export function composeCore(deps: ToolDeps): ToolCore {
  const base = createToolCore(deps);
  return withGuards(withTaskEdges(base, deps), deps);
}

export async function main(): Promise<void> {
  const deps = resolveDeps(process.cwd(), process.env);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const core = composeCore(deps);
  registerTools(server, deps, core); // v0.1.0 七工具，注入包装后的 core（tools.ts §10.4 缝隙）
  registerMemberTools(server, deps); // W2：xc_member_add / xc_member_stop
  registerLeadTools(server, deps);   // W4：xc_team_init / xc_idle / xc_cancel
  registerSecurityTools(server, deps); // W5：xc_inbound_review

  const transport = new StdioServerTransport();
  // 连接关闭（宿主会话结束/无头回合退出）→ 本进程随之退出：绑定随连接消亡（§2.3-2）。
  transport.onclose = () => {
    process.exit(0);
  };
  await server.connect(transport);
  // connect 返回后保持事件循环存活（stdin 未关即继续服务），不需要额外定时器。
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
