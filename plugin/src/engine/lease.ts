/**
 * M2 wake-engine —— 投递租约（60 秒）。
 *
 * 语义 1:1 移植 dsh-agent-teams 0.1.29（lib/state.js）：
 * - state.js:26  `MAILBOX_DELIVERY_LEASE_MS = 60_000`（"A crashed live-delivery attempt
 *   becomes retryable after this interval."）
 * - state.js:444-449  `readPendingMailbox`：待投递 = 未读 ∧ 未 discard ∧ 未 delivered
 *   ∧（无 deliveryClaimedAt ∨ 租约已到期 ≥60s）
 * - state.js:479-487  `claimMailboxDelivery`：投递尝试开始时给消息盖 deliveryClaimedAt=now
 * - state.js:489-496  `releaseMailboxDelivery`：投递失败释放租约，调度器方可重试
 *
 * 设计文档 docs/DESIGN.md §2.5：
 *   "60 秒投递租约（state.js:26 MAILBOX_DELIVERY_LEASE_MS 移植）只管「投递尝试的重试资格」；
 *    15 分钟在途窗口管「不重复 --resume 同一会话」。两个计时不混用。"
 *
 * 本文件只做**纯策略**（无 I/O、不依赖 M1 的函数，仅 import 常量与 TeamMessage 类型）：
 * 磁盘侧的 claim/release/markDelivered 由 M1 core/mailbox 提供，wake.ts 负责调用。
 *
 * v1 边界（如实在案）：v1 的每次推送只携带刚追加的那一条消息（DESIGN §2.8 xc_dispatch /
 * xc_report 的锁外推送），isWakeDeliveryPending 供「重试/搭车投递」与测试使用；
 * pull 路径（hook 注入 / xc_check_inbox）不受租约约束——租约只管"推送投递尝试"的资格。
 */
import type { TeamMessage } from "../core/types";
// 常量唯一定义处在 M1 core/mailbox（state.js:26 移植）；此处转出口供引擎侧引用。
export { MAILBOX_DELIVERY_LEASE_MS } from "../core/mailbox";
import { MAILBOX_DELIVERY_LEASE_MS } from "../core/mailbox";
/** 判定"租约"本身：消息正被一次尚未过期的投递尝试持有。 */
export function isDeliveryLeaseHeld(
  message: Pick<TeamMessage, "deliveryClaimedAt" | "deliveredAt">,
  now: number = Date.now(),
): boolean {
  if (message.deliveryClaimedAt === undefined || message.deliveryClaimedAt === null) return false;
  // 已确认送达（deliveredAt 落盘）的消息不再被"租约"描述——它已脱离投递尝试阶段。
  if (message.deliveredAt !== undefined && message.deliveredAt !== null) return false;
  return now - message.deliveryClaimedAt < MAILBOX_DELIVERY_LEASE_MS;
}

/**
 * 消息是否可作为**推送投递**的候选（dsh state.js:444-449 readPendingMailbox 的移植）：
 * 未读 ∧ 未丢弃 ∧ 未送达 ∧（无租约 ∨ 租约已到期）。
 * pull 路径（xc_check_inbox / hook 未读注入）**不使用**本判定——它们读全部未读消息。
 */
export function isWakeDeliveryPending(
  message: Pick<TeamMessage, "readAt" | "discardedAt" | "deliveredAt" | "deliveryClaimedAt">,
  now: number = Date.now(),
): boolean {
  if (message.readAt !== undefined && message.readAt !== null) return false;
  if (message.discardedAt !== undefined && message.discardedAt !== null) return false;
  if (message.deliveredAt !== undefined && message.deliveredAt !== null) return false;
  const claimed = message.deliveryClaimedAt;
  if (claimed === undefined || claimed === null) return true;
  return now - claimed >= MAILBOX_DELIVERY_LEASE_MS;
}

/** 租约剩余毫秒数（0 = 已空闲）；无租约时返回 0。 */
export function leaseRemainingMs(
  message: Pick<TeamMessage, "deliveryClaimedAt" | "deliveredAt">,
  now: number = Date.now(),
): number {
  if (!isDeliveryLeaseHeld(message, now)) return 0;
  return MAILBOX_DELIVERY_LEASE_MS - (now - (message.deliveryClaimedAt as number));
}
