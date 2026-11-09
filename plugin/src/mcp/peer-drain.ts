/**
 * W6 peer-face：tool-round 间隙的 peer 消息投递（DESIGN-V0.3.md §7.1「面 B」、
 * §10.1 所有权表；SPEC R-31.2）。
 *
 * 语义对齐 CC 的「queued user message folded into the running turn between tool
 * rounds」（CC @2842647）：**没有** steer 式实时注入，消息在工具调用之间被取走。
 *
 * **插入形态是硬约束**（DESIGN §7.1，复核意见 F7）：
 * - v0.2 的成功信封是 `content = [人可读摘要行, 机器 JSON]`
 *   （mcp/protocol.ts:74-83），`payloadOf()` 取 `content[1]`（protocol.ts:104-112）。
 * - 因此 peer 信封**只允许追加**为**新的末尾 text 块**（`content[2]`）：
 *   `content[0]` 仍是人可读摘要行，`content[1]` 仍是机器 JSON，既有解析方不错位。
 * - 无待投递 peer 消息时，返回值与 v0.2 **逐字节相同**（同一个对象原样返回）。
 * - 有待投递消息时 `content.length === 3`，且 `content[0]/content[1]` 不变。
 *
 * 三个消费面（DESIGN §7.1）共用同一渲染器：面 A = UserPromptSubmit 钩子（W7 交付，
 * hooks/prompt-submit.ts）、面 B = 本文件、面 C = `xc_peer_inbox`（peer-tools.ts）。
 * 「谁先排空谁拿走」——排空是 rename 换出（core/peermsg.ts 的 drainPeerQueue），
 * 原子性保证不重复注入。
 *
 * @module mcp/peer-drain
 */
import { logEngineEvent } from "../core/log.js";
import { peerRootFromEnv } from "../core/peerdir.js";
import { drainPeerQueue, renderPeerEnvelope, type PeerQueueItem } from "../core/peermsg.js";
import type { ToolResult } from "./protocol.js";
import type { ToolCore, ToolDeps } from "./tools.js";

/** 本进程内的 peer 会话上下文（注册后由 peer-tools.ts 写入）。 */
export interface PeerSessionContext {
  /** 本会话 id（机器全局 peers 根下的定位键）。 */
  sessionId: string;
  /** 本会话的 peer 名。 */
  name?: string;
  /** 本端点路径。 */
  socketPath?: string;
  /** MCP server 进程 pid。 */
  pid?: number;
  /** peer 根目录。 */
  root?: string;
}

let sessionContext: PeerSessionContext | undefined;

/** 记录本进程的 peer 会话上下文（xc_peer_register 成功后调用）。 */
export function setPeerSessionContext(context: PeerSessionContext): void {
  sessionContext = context;
}

/** 读取本进程的 peer 会话上下文。 */
export function getPeerSessionContext(): PeerSessionContext | undefined {
  return sessionContext;
}

/** 清空上下文（端点停止/会话结束时）。 */
export function clearPeerSessionContext(): void {
  sessionContext = undefined;
}

/**
 * 排空后端（注入点）：把「排空队列」与「渲染信封」两件事抽象出来，
 * 让本模块的单测可以用假后端驱动（不依赖真实管道与真实队列文件）。
 */
export interface PeerDrainBackend {
  /** 排空本会话待投递的 peer 消息（返回原始队列项）。 */
  drain(root: string, sessionId: string, limit: number): Promise<unknown[]>;
  /** 把一个队列项渲染成信封块（core/peerenvelope.ts 的 renderPeerEnvelope）。 */
  render(item: unknown): string;
}

export interface PeerDrainDeps extends ToolDeps {
  /** 注入的排空后端（缺省走 W5 的 peermsg 模块）。 */
  peerDrain?: PeerDrainBackend;
}

/** 单次工具调用最多投递多少条 peer 消息（防一次性灌爆上下文）。 */
export const PEER_DRAIN_LIMIT = 5;

/**
 * 默认排空后端：接 W5 的 `core/peermsg.ts`（队列排空 + 信封渲染）与 W1 的
 * `core/peerdir.ts`（peer 根解析）。
 *
 * 依赖方向 W1/W5 → W6 单向无环（DESIGN §10.1）。注入后端（`deps.peerDrain`）时
 * 完全绕开真实队列文件——单测据此不触盘。
 */
function defaultBackend(): PeerDrainBackend {
  return {
    drain: (root, sessionId, limit) => drainPeerQueue(root, sessionId, limit),
    render: (item) => renderPeerEnvelope(item as PeerQueueItem),
  };
}

/** peer 根目录解析（默认后端用；W1 的 peerdir 负责环境变量优先级）。 */
function resolvePeerRoot(deps: PeerDrainDeps): string {
  return peerRootFromEnv(deps.env);
}

/**
 * 把待投递的 peer 信封追加为结果末尾的 text 块。
 *
 * 硬约束（回归断言见 peer-drain.test.ts）：
 * - 无消息 → 原样返回 result（`content.length` 与每一块都不变）；
 * - 有消息 → `content` 追加一块 `{type:"text", text: envelopeBlock}`，
 *   `content[0]/content[1]` 逐字节不变。
 */
export async function appendPeerEnvelopes(
  result: ToolResult,
  deps: PeerDrainDeps,
): Promise<ToolResult> {
  const context = sessionContext;
  if (context === undefined) return result;

  let root: string;
  try {
    root = context.root ?? resolvePeerRoot(deps);
  } catch (error) {
    await logEngineEvent(deps.stateRoot, {
      event: "peer-drain-root-error",
      message: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  const backend = deps.peerDrain ?? defaultBackend();

  let items: unknown[];
  try {
    items = await backend.drain(root, context.sessionId, PEER_DRAIN_LIMIT);
  } catch (error) {
    // 排空失败不得影响队内工具的结果（钩子/工具永不阻断会话）。
    await logEngineEvent(deps.stateRoot, {
      event: "peer-drain-error",
      sessionId: context.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
  if (!Array.isArray(items) || items.length === 0) return result;

  let block: string;
  try {
    const backend = deps.peerDrain ?? (await defaultBackend());
    block = items.map((item) => backend.render(item)).filter((text) => text !== "").join("\n\n");
  } catch (error) {
    await logEngineEvent(deps.stateRoot, {
      event: "peer-drain-render-error",
      sessionId: context.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
  if (block === "") return result;

  await logEngineEvent(deps.stateRoot, {
    event: "peer-drain-delivered",
    sessionId: context.sessionId,
    count: items.length,
  });

  // 只追加：content[0]/content[1] 原样保留，既有解析方（payloadOf）不错位。
  return {
    ...result,
    content: [...result.content, { type: "text", text: block }],
  };
}

/**
 * 工具核心包装层（server.ts 组装链最外层）：
 * `base → withTaskEdges → withGuards → withPeerDrain`。
 *
 * 每个队内工具调用结束后，在 tool-round 间隙把待投递的 peer 消息取走并追加为
 * 末尾 text 块（面 B）。**队内 13 个 xc_* 工具的语义一字不改**（DESIGN §8.2）。
 */
export function withPeerDrain(core: ToolCore, deps: PeerDrainDeps): ToolCore {
  const wrap =
    <A>(inner: (args: A, connectionKey: string) => Promise<ToolResult>) =>
    async (args: A, connectionKey: string): Promise<ToolResult> => {
      const result = await inner(args, connectionKey);
      return await appendPeerEnvelopes(result, deps);
    };

  return {
    xc_register: wrap(core.xc_register.bind(core)),
    xc_dispatch: wrap(core.xc_dispatch.bind(core)),
    xc_check_inbox: wrap(core.xc_check_inbox.bind(core)),
    xc_claim: wrap(core.xc_claim.bind(core)),
    xc_report: wrap(core.xc_report.bind(core)),
    xc_message: wrap(core.xc_message.bind(core)),
    xc_status: wrap(core.xc_status.bind(core)),
  } as ToolCore;
}
