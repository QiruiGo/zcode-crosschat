/**
 * M2 单测：60s 投递租约纯策略（lease.ts）。
 * 判据对照 dsh state.js:26/444-449 语义与 DESIGN §2.5"两个计时不混用"。
 */
import { describe, expect, it } from "vitest";
import {
  isDeliveryLeaseHeld,
  isWakeDeliveryPending,
  leaseRemainingMs,
  MAILBOX_DELIVERY_LEASE_MS,
} from "./lease";

const NOW = 1_000_000;

describe("lease: MAILBOX_DELIVERY_LEASE_MS", () => {
  it("常量来自 M1 唯一定义处 = 60_000", () => {
    expect(MAILBOX_DELIVERY_LEASE_MS).toBe(60_000);
  });
});

describe("lease: isDeliveryLeaseHeld", () => {
  it("无 deliveryClaimedAt = 未持有", () => {
    expect(isDeliveryLeaseHeld({ deliveryClaimedAt: undefined, deliveredAt: undefined }, NOW)).toBe(false);
  });
  it("claim 未满 60s = 持有", () => {
    expect(isDeliveryLeaseHeld({ deliveryClaimedAt: NOW - 59_999, deliveredAt: undefined }, NOW)).toBe(true);
  });
  it("claim 恰满 60s = 释放（可重试）", () => {
    expect(isDeliveryLeaseHeld({ deliveryClaimedAt: NOW - 60_000, deliveredAt: undefined }, NOW)).toBe(false);
  });
  it("已 delivered 的消息不再处于租约语义", () => {
    expect(isDeliveryLeaseHeld({ deliveryClaimedAt: NOW - 1_000, deliveredAt: NOW - 500 }, NOW)).toBe(false);
  });
});

describe("lease: isWakeDeliveryPending（readPendingMailbox 的纯内存版）", () => {
  it("未读+未弃+未达+无 claim = 可投递", () => {
    expect(isWakeDeliveryPending({ readAt: undefined, discardedAt: undefined, deliveredAt: undefined, deliveryClaimedAt: undefined }, NOW)).toBe(true);
  });
  it("已读/已弃/已达任一 = 不可投递", () => {
    const base = { readAt: undefined, discardedAt: undefined, deliveredAt: undefined, deliveryClaimedAt: undefined } as const;
    expect(isWakeDeliveryPending({ ...base, readAt: NOW }, NOW)).toBe(false);
    expect(isWakeDeliveryPending({ ...base, discardedAt: NOW }, NOW)).toBe(false);
    expect(isWakeDeliveryPending({ ...base, deliveredAt: NOW }, NOW)).toBe(false);
  });
  it("租约未到期 = 不可再投（另一路投递在途）", () => {
    expect(isWakeDeliveryPending({ readAt: undefined, discardedAt: undefined, deliveredAt: undefined, deliveryClaimedAt: NOW - 1_000 }, NOW)).toBe(false);
  });
  it("租约到期 = 重新可投（崩溃投递的 60s 后重试资格）", () => {
    expect(isWakeDeliveryPending({ readAt: undefined, discardedAt: undefined, deliveredAt: undefined, deliveryClaimedAt: NOW - 60_000 }, NOW)).toBe(true);
  });
});

describe("lease: leaseRemainingMs", () => {
  it("无租约 = 0", () => {
    expect(leaseRemainingMs({ deliveryClaimedAt: undefined, deliveredAt: undefined }, NOW)).toBe(0);
  });
  it("剩多少毫秒", () => {
    expect(leaseRemainingMs({ deliveryClaimedAt: NOW - 10_000, deliveredAt: undefined }, NOW)).toBe(50_000);
  });
});
