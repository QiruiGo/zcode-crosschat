/**
 * W5 security face（DESIGN-V0.2.md §7.4-I4/I5、§7.3.3、§9.2 契约）：
 *
 * - `withGuards(core, deps)`：工具核心包装层（安全面最贴近工具入口，server.ts 组装链
 *   最外层）。两道闸：
 *   1. **removed 成员硬拒**——连接已绑定的身份若在 roster 中已是 removed 态，身份类
 *      工具（dispatch/check_inbox/claim/report/message）一律 `member_removed`。
 *      xc_register 的同名校验在 identity.ts 注册路径内（W5 改动）；xc_status 豁免
 *      （§2.8：未注册也可观测）。engine.jsonl 审计 `member-removed-gate`。
 *   2. **chat 入站策略**——xc_message 前置裁决（§7.4-I4）：accept 透传（v0.1.0 行为
 *      不变）；hold 把消息写 `inbox/<key>.held.jsonl`（钩子注入与唤醒 prompt 只读主
 *      邮箱 → 天然看不到）；refuse 不入目标邮箱、给发送者邮箱回写白名单帧
 *      `{type:"delivery-refused"}` + 审计 `inbound-refused`，工具返回
 *      `{error:"inbound_refused"}`。**协议帧不受策略影响**：本闸只包 chat 入口
 *      xc_message；派单/回执/解除阻塞等协议帧由引擎介导、带 attempt 令牌，永不被拒。
 * - `registerSecurityTools(server, deps)`：注册 `xc_inbound_review`（list / accept /
 *   discard 本连接自己的 held 队列；accept 转主邮箱，discard 丢弃）。
 *
 * 依赖纪律：只依赖 M1（core/*）与 tools.ts 的 `ToolCore`/`ToolDeps` 类型（type-only
 * import，运行时零依赖，避免与 server.ts 组装链成环）。错误映射与 tools.ts runCore
 * 同口径（LockBusyError → {error:"busy"}；ToolError → 结构化信封；其余 → internal）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectionKeyOf, identityStore, type BoundIdentity } from "./identity.js";
import { errorResult, mapToolError, okResult, ToolError, type ToolResult } from "./protocol.js";
import { LockBusyError, withTeamLock } from "../core/lock.js";
import { appendMailbox, createMessage, FRAME_TYPES } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { sanitizeKey } from "../core/sanitize.js";
import { readTeam } from "../core/teamstate.js";
import { memberState } from "../core/types.js";
import {
  acceptHeldMessages,
  appendHeldMessage,
  discardHeldMessages,
  readHeldMessages,
  readInboundPolicy,
} from "../core/policy.js";
import type { ToolCore, ToolDeps } from "./tools.js";
import type { TeamMessage } from "../core/types.js";

/** §9.2 契约出口：帧类型白名单的唯一定义在 core/mailbox.ts（读取侧执行），此处转出。 */
export { FRAME_TYPES };

/** 与 tools.ts runCore 同口径的守卫层错误映射。 */
function mapGuardError(err: unknown): ToolResult {
  if (err instanceof LockBusyError) return errorResult(err.toStructured());
  return mapToolError(err);
}

/** 单条消息可携带的 source 透传字段（与 tools.ts MessageExtras 子集一致）。 */
interface ChatExtras {
  sourceTaskId?: string;
  sourceAttemptId?: string;
}

function chatExtrasOf(args: Parameters<ToolCore["xc_message"]>[0]): ChatExtras {
  return {
    ...(args.sourceTaskId !== undefined ? { sourceTaskId: args.sourceTaskId } : {}),
    ...(args.sourceAttemptId !== undefined ? { sourceAttemptId: args.sourceAttemptId } : {}),
  };
}

/**
 * withGuards：包装身份类工具（removed 硬拒）与 xc_message（入站策略）。
 * 顺序契约（server.ts）：withTaskEdges 在内、withGuards 在外——守卫先于一切边沿动作。
 */
export function withGuards(core: ToolCore, deps: ToolDeps): ToolCore {
  const { stateRoot, env } = deps;

  /** removed 成员硬拒（§7.3.3）：roster 中该成员已是 removed → 结构化拒绝。 */
  async function assertCallerNotRemoved(me: BoundIdentity): Promise<void> {
    // 无锁读（rename 原子写保证读者看到完整文件，§2.7-5）：门控是只读判断。
    const team = await readTeam(stateRoot, me.teamId);
    const member = team?.members.find((m) => m.key === me.agentKey);
    if (member !== undefined && memberState(member) === "removed") {
      await logEngineEvent(stateRoot, {
        event: "member-removed-gate",
        teamId: me.teamId,
        agentKey: me.agentKey,
        sessionId: me.sessionId,
      });
      throw new ToolError({
        error: "member_removed",
        agentKey: me.agentKey,
        teamId: me.teamId,
        message: `member "${me.agentKey}" was removed from team "${me.teamId}" (xc_member_stop); ` +
          "ask the lead to re-add the member (xc_member_add idempotent reprovision)",
      });
    }
  }

  /** 通用闸：身份校验 + removed 硬拒 + 异步错误映射（内层 core 自身永不抛出）。 */
  async function gated<A>(
    args: A,
    connectionKey: string,
    inner: (args: A, connectionKey: string) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    try {
      const me = identityStore.require(connectionKey); // 未注册 → not_registered（与 v0.1.0 同错）
      await assertCallerNotRemoved(me);
      return await inner(args, connectionKey);
    } catch (err) {
      return mapGuardError(err);
    }
  }

  /** chat 入站策略执行（§7.4-I4）：仅 chat 到这里；source 字段不成对/自发消息等
   * 异常参数原样透传给内层校验（保持 v0.1.0 错误口径不变）。 */
  const guardedMessage: ToolCore["xc_message"] = (args, connectionKey) =>
    gated(args, connectionKey, async (a, ck) => {
      const me = identityStore.require(ck);
      const toKey = sanitizeKey(a.to);
      // v0.1.0 错误口径保留：自发消息 / source 字段不成对 → 内层 invalid_params。
      if (toKey === me.agentKey) return core.xc_message(a, ck);
      if ((a.sourceTaskId === undefined) !== (a.sourceAttemptId === undefined)) {
        return core.xc_message(a, ck);
      }
      const policy = await readInboundPolicy(stateRoot, me.teamId, env);
      if (policy.mode === "accept") return core.xc_message(a, ck);

      if (policy.mode === "hold") {
        // v0.5（M6 forwardOf 波及的最小适配）：MessageShape.content 改为可选（forwardOf
        // 转发不携带正文，R-13），hold 隔离副本对转发消息落 forwardOf 指针占位——原文
        // 不在隔离副本中（core 侧才解析 forwardOf），accept 后收件人可见转发引用。
        const msg = createMessage(
          me.agentKey,
          toKey,
          a.content ?? (a.forwardOf !== undefined ? `[forwardOf:${a.forwardOf}]` : ""),
          chatExtrasOf(a),
        );
        await appendHeld(stateRoot, me.teamId, toKey, msg);
        return okResult(
          `Message held by inbound policy (mode=hold, source=${policy.source}): quarantined in ` +
          `${toKey}.held.jsonl; hooks/wakes never see it until xc_inbound_review accepts it.`,
          { messageId: msg.id, from: me.agentKey, to: toKey, delivered: "held", policy: "hold" },
        );
      }
      // refuse：不入目标邮箱；给发送者邮箱写 delivery-refused 回执（白名单协议帧，
      // 免入站策略；下次查箱/钩子注入可见）。不主动唤醒发送者（防拒收风暴；
      // 工具结果已即时告知，§7.4-I4）。
      const now = Date.now();
      const receipt = createMessage(
        toKey,
        me.agentKey,
        JSON.stringify({ type: "delivery-refused", teamId: me.teamId, to: toKey, reason: "inbound policy refuse" }),
        { deliveryClaimedAt: now },
      );
      await appendMailbox(stateRoot, me.teamId, me.agentKey, receipt);
      await logEngineEvent(stateRoot, {
        event: "inbound-refused",
        teamId: me.teamId,
        from: me.agentKey,
        to: toKey,
        messageId: receipt.id,
        policySource: policy.source,
      });
      return errorResult({
        error: "inbound_refused",
        to: toKey,
        policy: "refuse",
        receiptMessageId: receipt.id,
        message: `message to "${toKey}" was refused by the team inbound policy (mode=refuse); ` +
          "a delivery-refused receipt was appended to your mailbox",
      });
    });

  return {
    ...core,
    xc_dispatch: (args, connectionKey) => gated(args, connectionKey, core.xc_dispatch),
    xc_check_inbox: (args, connectionKey) => gated(args, connectionKey, core.xc_check_inbox),
    xc_claim: (args, connectionKey) => gated(args, connectionKey, core.xc_claim),
    xc_report: (args, connectionKey) => gated(args, connectionKey, core.xc_report),
    xc_message: guardedMessage,
  };
}

/** hold 分支的落盘动作独立成函数（appendHeldMessage + 审计）。 */
async function appendHeld(
  stateRoot: string,
  teamId: string,
  toKey: string,
  msg: TeamMessage,
): Promise<void> {
  await appendHeldMessage(stateRoot, teamId, toKey, msg);
  await logEngineEvent(stateRoot, {
    event: "inbound-held",
    teamId,
    from: msg.from,
    to: toKey,
    messageId: msg.id,
  });
}

// ---------------------------------------------------------------------------
// xc_inbound_review：held 队列的审阅入口（§7.4-I4；W5 security tool）
// ---------------------------------------------------------------------------

export const InboundReviewShape = {
  action: z.enum(["list", "accept", "discard"]).optional().describe("缺省 list"),
  ids: z.array(z.string()).optional().describe("accept/discard 的消息 id；缺省全部"),
};

/**
 * 注册 xc_inbound_review：审阅本连接身份自己的 held 队列。
 * list 无锁读；accept/discard 在团队锁内执行（转主邮箱/丢弃，policy.ts 契约）。
 */
export function registerSecurityTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "xc_inbound_review",
    "Review this session's messages held by the inbound policy (mode=hold): list them, accept them into your mailbox, or discard them.",
    InboundReviewShape,
    async (args, extra) => {
      try {
        const me = identityStore.require(connectionKeyOf(extra));
        const action = args.action ?? "list";
        if (action === "list") {
          const messages = await readHeldMessages(deps.stateRoot, me.teamId, me.agentKey);
          return okResult(`Held inbox: ${messages.length} message(s) awaiting review.`, {
            action,
            count: messages.length,
            messages,
          });
        }
        const ids = args.ids ?? [];
        const moved = await withTeamLock(deps.stateRoot, me.teamId, async () =>
          action === "accept"
            ? acceptHeldMessages(deps.stateRoot, me.teamId, me.agentKey, ids, Date.now())
            : discardHeldMessages(deps.stateRoot, me.teamId, me.agentKey, ids),
        );
        await logEngineEvent(deps.stateRoot, {
          event: "inbound-review",
          teamId: me.teamId,
          agentKey: me.agentKey,
          action,
          count: moved.length,
        });
        return okResult(
          `Held inbox: ${moved.length} message(s) ${action === "accept" ? "accepted into your mailbox" : "discarded"}.`,
          { action, count: moved.length, messages: moved as TeamMessage[] },
        );
      } catch (err) {
        return mapGuardError(err);
      }
    },
  );
}
