/**
 * W5 security face（DESIGN-V0.2.md §7.4-I4/I5、§7.3.3、§9.2 契约）：
 *
 * - `withGuards(core, deps)`：工具核心包装层（安全面最贴近工具入口，server.ts 组装链
 *   最外层）。两道闸：
 *   1. **removed 成员硬拒**——连接已绑定的身份若在 roster 中已是 removed 态，身份类
 *      工具（dispatch/read/claim/report/relay）一律 `member_removed`。
 *      注册路径的同名校验在 identity.ts 内（W5 改动）；xc_overview 豁免
 *      （§2.8：未注册也可观测）。engine.jsonl 审计 `member-removed-gate`。
 *   2. **chat 入站策略**——队内轴发送前置裁决（§7.4-I4）：accept 透传（v0.1.0 行为
 *      不变）；hold 把消息写 `inbox/<key>.held.jsonl`（钩子注入与唤醒 prompt 只读主
 *      邮箱 → 天然看不到）；refuse 不入目标邮箱、给发送者邮箱回写白名单帧
 *      `{type:"delivery-refused"}` + 审计 `inbound-refused`，工具返回
 *      `{error:"inbound_refused"}`。**协议帧不受策略影响**：本闸只包 chat 入口；
 *      派单/回执/解除阻塞等协议帧由引擎介导、带 attempt 令牌，永不被拒。
 *
 * v0.7（M6）：held 队列审阅入口（原 registerSecurityTools 注册的入站审阅工具）
 * 已在 v0.6 并入 xc_review（tools-review.ts）；本文件的死代码注册器按 DESIGN-V0.7
 * §7.2 删除，工具面不受影响（server.ts 注册清单从未调用它）。
 *
 * 依赖纪律：只依赖 M1（core/*）与 tools.ts 的 `ToolCore`/`ToolDeps` 类型（type-only
 * import，运行时零依赖，避免与 server.ts 组装链成环）。错误映射与 tools.ts runCore
 * 同口径（LockBusyError → {error:"busy"}；ToolError → 结构化信封；其余 → internal）。
 */

import { identityStore, type BoundIdentity } from "./identity.js";
import { errorResult, mapToolError, okResult, ToolError, type ToolResult } from "./protocol.js";
import { LockBusyError } from "../core/lock.js";
import { appendMailbox, createMessage, FRAME_TYPES } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import { sanitizeKey } from "../core/sanitize.js";
import { readTeam } from "../core/teamstate.js";
import { memberState } from "../core/types.js";
import { appendHeldMessage, readInboundPolicy } from "../core/policy.js";
import { parseToolFrameType } from "../core/toolrelay.js";
// v0.9.9（V098-02）：hold 挡下 steer 的如实回执块（与内核 hold 分支同源，防两处漂移）
// + steer 权限闸（直调组装链核心时的第二道防线）。tools-relay.ts 对本模块只有
// type-only 反向依赖（ToolDeps），无运行时环。
import { authorizeSteerForTeamAxis, steerHeldReceipt, type SteerAuthorizedFlag } from "./tools-relay.js";
import type { RelayArgs } from "./tools-relay.js";
import type { ToolCore, ToolDeps } from "./core.js";
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
 * withGuards：包装身份类工具（removed 硬拒）与队内轴发送（入站策略）。
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
        message: `member "${me.agentKey}" was removed from team "${me.teamId}" (xc_team member-stop); ` +
          "ask the lead to re-add the member (xc_team member-add idempotent reprovision)",
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
   * 异常参数原样透传给内层校验（保持 v0.1.0 错误口径不变）。
   * v0.6：队内轴发送入参为 RelayArgs（`msg` 必填；forwardOf 已砍）——hold 隔离副本
   * 的 forwardOf 指针占位一并移除（转发机制在主路径即被显式拒绝，不可达）。
   * v0.9.9（V098-02）：hold 分支补 **steer 归一 + 元数据保留 + 如实回执**——
   * xc_relay 的 steer:true 经编排层权限闸（guards 之前）放行后到达本层，本层必须
   * ① 按 C1/S1 同款归一（steer 蕴含 interrupt 蕴含 urgent——裸 args 里这三个键都
   * 缺省，旧实现直接丢元数据）；② 暂存副本保留 steer:true（放行后 J1 置顶/预留预算
   * 按 steer 语义生效）；③ 回执经 {@link steerHeldReceipt} 明说「steer 未执行」。
   * 成员→成员 steer 在生产路径到不了本层（编排层权限闸已拒 + 审计，隔离区都不进）；
   * 直调组装链核心的 steer 由本层第二道闸兜底（见下方 steerAuthorized）。 */
  const guardedMessage: ToolCore["xc_message"] = (args, connectionKey) =>
    gated(args, connectionKey, async (a, ck) => {
      const me = identityStore.require(ck);
      const toKey = sanitizeKey(a.to);
      // v0.1.0 错误口径保留：自发消息 / source 字段不成对 → 内层 invalid_params。
      if (toKey === me.agentKey) return core.xc_message(a, ck);
      if ((a.sourceTaskId === undefined) !== (a.sourceAttemptId === undefined)) {
        return core.xc_message(a, ck);
      }
      // v0.7（C6，DESIGN-V0.7 §2.2）：C6/C7 协议帧免入站策略——与文件头注「协议帧
      // 不受策略影响」同口径（队内核心同样豁免，tools-relay.ts）。转办/审批帧的控制
      // 点是审批门；hold 会让请求永远躺隔离区、refuse 会伪造 delivery-refused 语义。
      // v0.9（G-3）：撤回单与缺 msg 的调用同样直通核心——入站策略只裁决「发送正文」，
      // 撤回的删除+通知帧语义在核心内（withdrawal-notice 是白名单协议帧，本就免策略），
      // 缺 msg（且无 withdrawMessageIds）由核心显式 invalid_params。此行之后 a.msg 收窄
      // 为 string（发送路径）。
      if (a.withdrawMessageIds !== undefined || a.msg === undefined) return core.xc_message(a, ck);
      if (parseToolFrameType(a.msg) !== undefined) return core.xc_message(a, ck);
      // v0.9.9（V098-02）：C1/S1 归一（steer 蕴含 interrupt 蕴含 urgent）——与内核
      // 的发送路径同口径；编排层传来的裸 args 不带这三个键的蕴含关系。
      const steerRequested = a.steer === true;
      const interruptRequested = a.interrupt === true || steerRequested;
      const urgent = a.urgent === true || interruptRequested;
      // v0.9.9（V098-02）：**本层（guards）的 steer 权限闸**——第二道防线。生产路径
      // （xc_relay 编排层）已在 guards 之前判定并下传 `steerAuthorized`，本闸跳过
      // （印章一次性，不重复消费）；**直调组装链核心**（无编排层）的 steer 调用在此
      // 兜底——否则 hold/refuse 分支仍会在内核闸之前短路（adv-4 缺陷 B 的完整修复面）。
      let steerAuthorized = (a as RelayArgs & { steerAuthorized?: SteerAuthorizedFlag }).steerAuthorized;
      if (steerRequested && steerAuthorized === undefined) {
        steerAuthorized = await authorizeSteerForTeamAxis({ stateRoot, env }, me, a, Date.now());
      }
      const inner: RelayArgs & { steerAuthorized?: SteerAuthorizedFlag } =
        steerAuthorized !== undefined ? { ...a, steerAuthorized } : { ...a };
      const policy = await readInboundPolicy(stateRoot, me.teamId, env);
      if (policy.mode === "accept") return core.xc_message(inner, ck);

      if (policy.mode === "hold") {
        // hold 隔离副本保留 urgent 标记（C1：接受审阅后插队不丢）。
        // v0.9（G-2）：软中断元数据同样保留（接受审阅后信封横幅随读取面渲染不丢）。
        // v0.9.9（V098-02）：steer 元数据同样保留（J1/J2/J3 的读面宽容拷贝认它；
        // 字段白名单在 core/types.ts 非本文件域，故与 tools-relay.ts 主路径同款补键）。
        const msg = createMessage(me.agentKey, toKey, a.msg, chatExtrasOf(a));
        if (urgent) msg.urgent = true;
        if (interruptRequested) msg.interrupt = true;
        if (steerRequested) (msg as TeamMessage & { steer?: boolean }).steer = true;
        await appendHeld(stateRoot, me.teamId, toKey, msg);
        return okResult(
          `Message held by inbound policy (mode=hold, source=${policy.source}): quarantined in ` +
            `${toKey}.held.jsonl; hooks/wakes never see it until xc_review accepts it.`,
          {
            messageId: msg.id,
            from: me.agentKey,
            to: toKey,
            delivered: "held",
            policy: "hold",
            ...(urgent ? { urgent: true } : {}),
            // held 件不带 envelope 标注——信封未进可读邮箱（接受审阅后随元数据渲染）。
            // v0.9.9（V098-02）：steer 请求 → 明说「steer 未执行」（与内核 hold 分支
            // 同一形状 + E3 顶层别名，防两处漂移）。非 steer 路径仍不带 interrupt 块
            // （信封未进可读邮箱，接受后随元数据渲染——v0.9.8 口径不改）；urgent 披露键
            // 与内核 hold 分支对齐（暂存件带 urgent → 放行即插队，调用方应看得见）。
            ...(steerRequested ? steerHeldReceipt(policy.source) : {}),
          },
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

/** hold 分支的落盘动作独立成函数（appendHeldMessage + 审计）。
 *  v0.9.9（V098-02）：审计补 urgent/interruptRequested/steerRequested 三标记——与内核
 *  hold 分支（tools-relay.ts inbound-held 事件）同口径，组装链下守卫层才是真实暂存面，
 *  审计面必须能把 steer 请求与普通消息区分开（adv-4 B：hold 下审计不可分辨）。 */
async function appendHeld(
  stateRoot: string,
  teamId: string,
  toKey: string,
  msg: TeamMessage & { steer?: boolean },
): Promise<void> {
  await appendHeldMessage(stateRoot, teamId, toKey, msg);
  await logEngineEvent(stateRoot, {
    event: "inbound-held",
    teamId,
    from: msg.from,
    to: toKey,
    messageId: msg.id,
    ...(msg.urgent === true ? { urgent: true } : {}),
    ...(msg.interrupt === true ? { interruptRequested: true } : {}),
    ...(msg.steer === true ? { steerRequested: true } : {}),
  });
}
