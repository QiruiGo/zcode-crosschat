/**
 * M3 server：stdio MCP 入口（DESIGN.md §1.3、§2.8）。
 *
 * manifest 经 mcpServers.crosschat 拉起本进程（command:"node",
 * args:["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.mjs"], cwd:"${ZCODE_PROJECT_DIR}"），
 * 因此 process.cwd() = 会话工作区，状态根 = <workspace>/.crosschat（§2.2）。
 *
 * stdio 纪律：协议独占 stdout——任何日志/报错只准写 stderr，否则握手即坏。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, resolveDeps } from "./tools.js";

const SERVER_NAME = "zcode-crosschat";
const SERVER_VERSION = "0.1.0";

export async function main(): Promise<void> {
  const deps = resolveDeps(process.cwd(), process.env);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, deps);

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
