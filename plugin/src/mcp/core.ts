/**
 * v0.6 M1（DESIGN-V0.6.md §4.1/§4.2-M1）：工具核心组装中枢——原 tools.ts 的
 * ToolDeps / createToolCore / composeCore / resolveDeps / runCore 搬家至此；
 * 各工具实现拆入家族文件（tools-identify/tasks/read/relay/overview/team/review
 * + peer-services），本模块只做类型、组装与再出口（旧测试 import 路径仅改模块名）。
 *
 * 身份纪律不变：工具一律无 from/caller 参数，身份 ≡ identityStore.require(
 * connectionKeyOf(extra)) 的连接绑定（identity.ts:106-108）。
 *
 * 组装链不变：base(createToolCore) → withTaskEdges → withGuards → withPeerDrain
 * （包装按方法名叠加，方法名与 v0.5.3 逐一同名——守卫/边沿/排空层零改动）。
 *
 * v0.6 工具面：MCP 恰 10 个新名（xc_identify/xc_dispatch/xc_claim/xc_report/
 * xc_read/xc_relay/xc_overview/xc_team/xc_review/xc_doctor）；core 层方法名保留
 * v0.5.3 形态（xc_register/xc_check_inbox/xc_message/xc_status/…），新名→核心方法
 * 的映射在家族注册器与 alias.ts（DESIGN §1.3 迁移表）。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withTaskEdges } from "./task-edges.js";
import { withGuards } from "./guards.js";
import { withPeerDrain } from "./peer-drain.js";
import { errorResult, mapToolError } from "./protocol.js";
import { LockBusyError } from "../core/lock.js";
import { auditDegradationWarning } from "../core/log.js";
import { resolveStateRoot } from "../core/paths.js";
import { createIdentifyCore, type IdentifyCore } from "./tools-identify.js";
import { createTaskCore, type TaskCore } from "./tools-tasks.js";
import { createMailboxReadCore, type MailboxReadCore } from "./tools-read.js";
import { createTeamRelayCore, type TeamRelayCore } from "./tools-relay.js";
import { createTeamOverviewCore, type TeamOverviewCore } from "./tools-overview.js";

/** 工具依赖（状态根/工作区/进程环境；与 v0.5.3 逐字段一致）。 */
export interface ToolDeps {
  /** 状态根 <workspace>/.crosschat（§2.2；server.ts 用 process.cwd() 解析）。 */
  stateRoot: string;
  /** 工作区绝对路径（传给 M2 作为 --cwd）。 */
  workspace: string;
  /** 进程环境（XC_WAKE_ENABLED 等，V7：仅 "true" 视为开启）。 */
  env: NodeJS.ProcessEnv;
}

/**
 * 工具核心（SDK 无关）：方法名保留 v0.5.3 形态——守卫/边沿/排空包装层按方法名
 * 叠加；v0.6 新名（xc_identify/xc_read/xc_relay/xc_overview/xc_team/xc_review）
 * 的工具层入口在家族注册器，按 scope/action/view 分派到这些核心方法。
 *
 * TeamRelayCore（tools-relay.ts，M4）的 xc_message 入参为 RelayArgs（`msg` 字段）；
 * withGuards 的 chat 入站策略包装按该形状适配。
 */
export interface ToolCore extends IdentifyCore, TaskCore, MailboxReadCore, TeamRelayCore, TeamOverviewCore {}

/** core 层统一入口：LockBusyError → {error:"busy"}，其余经 protocol.mapToolError。
 *
 * v0.5.2（故障注-3 修复）：响应附带审计降级告警——engine.jsonl 不可写（被目录
 * 占用/权限缺失）时此前全部工具照常成功、审计静默全丢、工具面零诊断。现在每次
 * 工具响应都以末尾 text 块内联披露 `auditDegradationWarning(stateRoot)`（健康时
 * 零开销、零结构变化），与 inbox 坏行的 `N unreadable line(s) skipped` 同一披露
 * 口径；审计写成功即自动清除，告警随之消失。 */
export async function runCore(stateRoot: string, fn: () => Promise<import("./protocol.js").ToolResult>): Promise<import("./protocol.js").ToolResult> {
  let result: import("./protocol.js").ToolResult;
  try {
    result = await fn();
  } catch (err) {
    if (err instanceof LockBusyError) result = errorResult(err.toStructured());
    else result = mapToolError(err);
  }
  // v0.5.2（故障注-3 修复）：审计不可写时在响应末尾内联告警（健康时零开销）。
  const auditWarning = auditDegradationWarning(stateRoot);
  if (auditWarning !== undefined) {
    result.content.push({ type: "text", text: auditWarning });
  }
  return result;
}

/** 组装全部家族核心（v0.5.3 createToolCore 的 v0.6 等价物；方法集不变）。 */
export function createToolCore(deps: ToolDeps): ToolCore {
  return {
    ...createIdentifyCore(deps),
    ...createTaskCore(deps),
    ...createMailboxReadCore(deps),
    ...createTeamRelayCore(deps),
    ...createTeamOverviewCore(deps),
  };
}

/** v0.3 工具核心组装链：包装顺序固定——先边沿后守卫，守卫（安全）最贴近工具入口，
 *  peer 投递排空最外层（tool-round 间隙把信封**追加为末尾 text 块 content[2]**，
 *  content[0]/content[1] 逐字节不变——§7.1「面 B 的插入形态」）。 */
export function composeCore(deps: ToolDeps): ToolCore {
  const base = createToolCore(deps);
  const edges = withTaskEdges(base, deps);
  const guarded = withGuards(edges, deps);
  return withPeerDrain(guarded, deps);
}

/** 解析状态根的便捷出口（server.ts / 测试共用；M1 paths.ts 的薄封装）。 */
export function resolveDeps(cwd: string, env: NodeJS.ProcessEnv = process.env): ToolDeps {
  const workspace = cwd;
  return { stateRoot: resolveStateRoot(workspace), workspace, env };
}

// ---------------------------------------------------------------------------
// v0.6 主名注册器契约：10 个新名的 (shape, handler) 登记——server.ts 把它们同时
// 挂进 server.tool()（tools/list 发现面）与 dispatcher（alias 覆盖层的分发面），
// 「双入口单实现」（DESIGN §6 风险 5）。
// ---------------------------------------------------------------------------

import type { ToolResult } from "./protocol.js";

/** 单个主名工具的注册项。 */
export interface PrimaryTool {
  description: string;
  /** zod 原始 shape（与 server.tool 第三参同源；dispatcher 用它做入参校验）。 */
  shape: z.ZodRawShape;
  /** 工具处理器（入参为 shape 解析后的对象；extra 原样透传——connectionKeyOf 的锚）。 */
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;
}

/** 主名 → 注册项。server.ts 持有一份，家族注册器写入。 */
export type PrimaryRegistry = Map<string, PrimaryTool>;

/** 家族注册器签名：向 server 注册发现面 + 向 registry 登记分发面。 */
export type FamilyRegistrar = (server: McpServer, deps: ToolDeps, core: ToolCore, registry: PrimaryRegistry) => void;

// 旧测试兼容出口：身份/协议助手自 identity.ts / protocol.ts 转出（import 路径
// 仅改模块名的适配口径，DESIGN-V0.6.md §4.1 core.ts 注记）。
export { connectionKeyOf, identityStore, xcRegister, STALE_LASTSEEN_WARN_MS } from "./identity.js";
export {
  busyError,
  errorResult as protocolErrorResult,
  invalidParamsError,
  mapToolError as protocolMapToolError,
  notRegisteredError,
  okResult,
  payloadOf,
  runTool,
  staleAttemptError,
  ToolError,
} from "./protocol.js";
export type { ToolPayload, ToolResult } from "./protocol.js";
