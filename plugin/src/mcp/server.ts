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
 * 条款 1 硬验收）。
 * v0.7.0（MIGRATION §5 承诺执行）：22 个旧名弃用覆盖层（alias.ts）整体移除——
 * 未知名经 dispatcher 抛标准 `Tool <name> not found`（InvalidParams，本文件
 * dispatchPrimary），不再有 [DEPRECATED] 垫片。
 * 「双入口单实现」：dispatcher 与 server.tool 回调共用同一 handler（PrimaryRegistry）。
 *
 * 组装链不变：composeCore = base → withTaskEdges → withGuards → withPeerDrain。
 * GuardedStdioTransport / startStaleSweeper / stdin EOF 纪律全部原样保留。
 *
 * v0.9.8（J3，方案 §二 组J）：**工具调用边界的插队提示**——`decorateToolCallsWith
 * PendingInterruptNotice` 在本模块给 `server.tool()` 套一层：该会话每次 MCP 工具
 * 调用返回时，若调用者邮箱里还有未读的 interrupt/steer 消息，就在**文本尾部**追加
 * 一行「你有 N 条插队待读」，并在 **JSON 面**加可选键 `pendingInterrupt`；没有插队
 * 时一个字节都不加（工具结果形状与 v0.9.7 逐字节一致）。语义不变、不新增工具、
 * 不新增必填配置（不变式 1）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { composeCore, resolveDeps, type PrimaryRegistry, type ToolDeps } from "./core.js";
import { connectionKeyOf, identityStore } from "./identity.js";
import { countPendingInterrupts } from "../core/mailbox.js";
import type { ToolResult } from "./protocol.js";
import { registerIdentifyTools } from "./tools-identify.js";
import { registerTaskTools } from "./tools-tasks.js";
import { registerReadTools } from "./tools-read.js";
import { registerRelay } from "./tools-relay.js";
import { registerOverviewTools } from "./tools-overview.js";
import { registerTeamTools } from "./tools-team.js";
import { registerReviewTools } from "./tools-review.js";
import { registerDoctorTool } from "./doctor-tool.js";
import { startStaleSweeper } from "./task-edges.js";
import { startMemberWatchdog } from "../engine/watchdog.js";
import { stopPeerEndpoint } from "../transport/pipe.js";
import { GuardedStdioTransport } from "../transport/mcpstdio.js";

const SERVER_NAME = "zcode-crosschat";
const SERVER_VERSION = "0.9.8";

// v0.8.1（29 红队 M01 修复）：xc_doctor 的 action 形状在**入口模块**构建——本模块是
// bundle 入口（模块体最后求值），此处用 zod 无初始化次序风险；而 doctor-tool.ts 若自建
// zod 依赖边会翻转 esbuild 模块次序使 SDK types.js 先于 zod/v4 core 求值（server 起不来）。
// 语义：缺省调用 = 纯只读体检；action="repair-team" = 自愈双重复员键中毒的 team.json。
const DOCTOR_ACTION_SHAPE = {
  action: z.enum(["repair-team"]).optional().describe(
    '缺省 = 纯只读体检（不写任何字节）。"repair-team" = 自愈被双重复员键中毒的 team.json'
    + '（M01 的持久伤害：names 权威索引保留原持有者行、丢弃改名残留行，残损字节保全为 team.json.corrupt，'
    + '真源与 .bak 一并重写）；其他缺陷形态不猜，交还原人工恢复路径',
  ),
} as const;

let shuttingDown = false;

// ---------------------------------------------------------------------------
// v0.9.8（J3，方案 §二 组J）：工具调用边界的插队提示
// ---------------------------------------------------------------------------

/** J3 提示行（固定文案；N=该调用者邮箱里未读的 interrupt/steer 条数）。 */
export function pendingInterruptNotice(count: number): string {
  return `⛔ 你有 ${count} 条插队待读（interrupt/steer）——先 xc_read({scope:"inbox"}) 消费掉再继续；`
    + "纠错消息在注入排布里置顶并单独预留预算、绝不降级成摘要。"
    + "本提示每次工具调用都会重复，直到插队全部消费完为止（宿主无回合中注入原语，这是工具间隙的唯一提醒面）。";
}

/** 工具回调的最小形状（SDK `ToolCallback` 的结构面，避免在本模块依赖 SDK 泛型）。 */
type ToolCallbackShape = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

/**
 * 给单个工具回调套上「插队待读」提示（J3）。
 *
 * 顺序纪律：**先跑原 handler**（工具语义与副作用不变），再算纠错条数、追加提示。
 * 条数取「调用者邮箱里 readAt/discardedAt 都缺席的 interrupt/steer 件」——与 J2 横幅
 * 同一个谓词（core/mailbox.ts countPendingInterrupts）。未注册连接（identityStore
 * 取不到身份）→ 不附：提示面不为难未注册调用方。
 */
export function withPendingInterruptNotice(
  handler: ToolCallbackShape,
  deps: ToolDeps,
): ToolCallbackShape {
  return async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> => {
    const result = await handler(args, extra);
    return await appendPendingInterruptNotice(result, deps, connectionKeyOf(extra));
  };
}

/**
 * J3 的落点：给一个已注册工具的返回结果附「插队待读」一行。
 *
 * - 文本尾部：**追加**一个 text 块（既有块逐字节不动——与 peer 排空面 content[2]
 *   同一形态，J3 不改变任何工具结果语义）；
 * - JSON 面：给能解析成对象的 text 块加可选键 `pendingInterrupt`（解析不了就只附文本行）；
 * - **无插队不附**：count<=0 时原样返回（零结构变化、零额外 IO 之外的代价）。
 */
export async function appendPendingInterruptNotice(
  result: ToolResult,
  deps: ToolDeps,
  connectionKey: string,
): Promise<ToolResult> {
  let count = 0;
  try {
    const me = identityStore.get(connectionKey);
    if (me !== undefined) count = await countPendingInterrupts(deps.stateRoot, me.teamId, me.agentKey);
  } catch {
    count = 0; // 读不出邮箱就不附（不谎报「0 条插队」）
  }
  if (count <= 0) return result;
  const notice = pendingInterruptNotice(count);
  const content = [...(result.content ?? [])];
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i] as { type?: string; text?: string } | undefined;
    if (block === undefined || block.type !== "text" || typeof block.text !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    content[i] = { type: "text", text: JSON.stringify({ ...(parsed as Record<string, unknown>), pendingInterrupt: count }, null, 2) };
  }
  content.push({ type: "text", text: notice });
  return { ...result, content };
}

/**
 * v0.9.8（J3）：把 `server.tool()` 的**注册面**套上插队提示——本模块在家族注册器
 * 之前调用一次，之后注册的 10 个工具（发现面）全部带上提示。
 *
 * 实现选择（为什么在 server.ts 而不在 runCore）：runCore 在 mcp/core.ts（非本组文件域），
 * 而「每次 MCP 工具调用返回」的公共收口就在本模块的注册面上；包装只换回调引用，
 * 不改任何家族的 handler 签名，也不新增工具/必填配置（不变式 1）。
 *
 * 纪律：只包 `server.tool()`（真实 MCP 线的发现面）；`PrimaryRegistry` 的分发面
 * （dispatchPrimary，测试与历史入口）不包——避免同一结果被附两次。
 */
export function decorateToolCallsWithPendingInterruptNotice(server: McpServer, deps: ToolDeps): void {
  const target = server as unknown as { tool: (...args: unknown[]) => unknown };
  const rawTool = target.tool.bind(server);
  target.tool = (...args: unknown[]): unknown => {
    const call = [...args];
    const last = call.length > 0 ? call[call.length - 1] : undefined;
    if (typeof last === "function") {
      call[call.length - 1] = withPendingInterruptNotice(last as ToolCallbackShape, deps);
    }
    return rawTool(...call);
  };
}

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
  // v0.9.8（J3）：先给注册面套上「插队待读」提示，再让家族注册器注册——
  // 之后注册的 10 个工具每次调用返回都会带上那一行（无插队时不附）。
  decorateToolCallsWithPendingInterruptNotice(server, deps);
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
  registerDoctorTool(server, {                           // xc_doctor（免注册体检；action=repair-team 为唯一写面）
    version: SERVER_VERSION, env: process.env, cwd: process.cwd(),
    // v0.7.2（C9-B6 修复）：PROTOCOL §5 的「xc_overview/xc_doctor 调用时惰性采样」——
    // doctor 这一半此前不成立；传入 stateRoot 即与 overview 同一 capacity 挂载口径
    // （同一 sample.json 缓存 / 同一 XC_MEM_SAMPLE_MIN_MS 窗口 / 同一 judgeCapacity）。
    stateRoot: deps.stateRoot,
    actionShape: DOCTOR_ACTION_SHAPE,
  });
  // doctor 的 handler 也登记进分发面（alias 层接管 CallTool 后的唯一通路）。
  // v0.8.1（29 红队 M01 修复）：分发面与注册面同一 handler 形状——缺省只读体检，
  // `action:"repair-team"` 走 core 的自愈（中毒 team.json 时唯一还能应答的工具）。
  registry.set("xc_doctor", {
    description:
      "Read-only self check: plugin version, runtime, auto-detected zcode_exe/zcode_cjs paths and probe attempts, capacity sample (watermark / red rules). Does not require registration. The default call writes nothing; the optional action \"repair-team\" is the one write face — it self-heals a team.json poisoned with duplicate member keys (the M01 aftermath, where every team-axis tool answers \"internal\" and the .bak is poisoned too).",
    shape: DOCTOR_ACTION_SHAPE,
    handler: async (args: Record<string, unknown>) => {
      const { buildDoctorReport, sampleDoctorCapacity, doctorToolResult, runTeamRepair, teamRepairToolResult } =
        await import("./doctor-tool.js");
      if (args["action"] === "repair-team") {
        return teamRepairToolResult(await runTeamRepair(deps.stateRoot));
      }
      const capacity = await sampleDoctorCapacity({ env: process.env, stateRoot: deps.stateRoot });
      return doctorToolResult(buildDoctorReport({
        version: SERVER_VERSION, env: process.env, cwd: process.cwd(), capacity,
      }));
    },
  });

  // v0.7.0：旧名弃用覆盖层已按 MIGRATION §5 承诺移除（alias.ts 整文件删除）——
  // 22 个旧名调用经 dispatcher 得标准 `Tool <name> not found`（InvalidParams）；
  // `xc_relay({forwardOf})` 的显式错误由 relay 轴守卫 assertNoForwardOf 承担
  // （tools-relay.ts 主路径调用，防 zod object 默认 strip 静默丢参）。
  // doctor 的 handler 已登记进分发面（registry），CallTool 直达。

  // v0.5.1（CONC-2 修复）：带大帧守卫的 stdio 传输——≥10MiB 帧 JSON-RPC 拒收且
  // server 继续服务（transport/mcpstdio.ts）。
  const transport = new GuardedStdioTransport();
  transport.onclose = () => {
    void shutdown();
  };
  await server.connect(transport);

  // v0.5.1（故障注-8 修复）：周期僵尸清扫（unref 不改退出语义）。
  startStaleSweeper(deps);

  // v0.9.2（A2，方案 §二 组A）：成员看门狗——本进程（lead 的 MCP server）内的轻量
  // 定时器，扫在册成员 pid（C8 offline 判据）/ 在途 nonce 生命周期 / limbo 判据；
  // 仅 alive→dead 迁移发一次（状态真源 capacity/watchdog-state.json），发 = engine
  // 事件 member-dead + lead 邮箱 urgent + 尝试唤醒 lead（容量闸约束，失败记事件）；
  // lead 自己死 → 通知其余在册成员并唤醒。XC_WATCHDOG_MS 缺省 60s、0=关（返回
  // undefined）；unref 不拖进程退出。看门狗随本进程死亡时，告警链由 UserPromptSubmit
  // 的回合开始事故摘要（core/incidents.ts，A3）兜底。
  startMemberWatchdog(deps);

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
