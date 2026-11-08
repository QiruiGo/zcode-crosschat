/**
 * W5 单测：core/policy.ts 核心函数（DESIGN-V0.2 §7.4-I4）。
 * guards.test.ts 覆盖工具面集成；此处直测：模式解析回退链、held 队列的
 * accept/discard（ids 子集与全集）、损坏行容错、路径约定。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INBOUND_MODE,
  appendHeldMessage,
  acceptHeldMessages,
  discardHeldMessages,
  heldInboxFile,
  inboundModeFromEnv,
  policyFile,
  readHeldMessages,
  readInboundPolicy,
  writeInboundPolicy,
} from "./policy.js";
import { createMessage } from "./mailbox.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xc-policy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("inboundModeFromEnv（V7 防御：未知值不升级）", () => {
  it("hold/refuse 生效；其他一切 → accept", () => {
    expect(inboundModeFromEnv("hold")).toBe("hold");
    expect(inboundModeFromEnv("refuse")).toBe("refuse");
    expect(inboundModeFromEnv("true")).toBe(DEFAULT_INBOUND_MODE);
    expect(inboundModeFromEnv("HOLD")).toBe(DEFAULT_INBOUND_MODE); // 大小写敏感，宁宽勿严
    expect(inboundModeFromEnv(undefined)).toBe(DEFAULT_INBOUND_MODE);
    expect(inboundModeFromEnv("")).toBe(DEFAULT_INBOUND_MODE);
  });
});

describe("readInboundPolicy：policy.json > env > default", () => {
  it("无文件 → env 生效；env 也无 → default accept", async () => {
    expect(await readInboundPolicy(dir, "default", {})).toEqual({ mode: "accept", source: "default" });
    expect(await readInboundPolicy(dir, "default", { XC_INBOUND_MODE: "hold" })).toEqual({
      mode: "hold",
      source: "env",
    });
  });

  it("policy.json 命中 → mode+source=policy；损坏 → 审计 + 回落 env", async () => {
    await writeInboundPolicy(dir, "default", "refuse");
    expect(await readInboundPolicy(dir, "default", {})).toEqual({ mode: "refuse", source: "policy" });

    writeFileSync(policyFile(dir, "default"), "not json{", "utf8");
    const fallback = await readInboundPolicy(dir, "default", { XC_INBOUND_MODE: "hold" });
    expect(fallback).toEqual({ mode: "hold", source: "env" });
    expect(readFileSync(join(dir, "logs", "engine.jsonl"), "utf8")).toContain('"policy-invalid"');

    // 语义损坏（合法 JSON 但 mode 非法）同样回落 + 审计：
    writeFileSync(policyFile(dir, "default"), JSON.stringify({ mode: "block-everything" }), "utf8");
    expect(await readInboundPolicy(dir, "default", {})).toEqual({ mode: "accept", source: "env" });
  });
});

describe("held 队列（.held.jsonl）", () => {
  it("append → read；accept 全集/子集转主邮箱；discard 余量；空队列删文件", async () => {
    const m1 = createMessage("a", "b", "one");
    const m2 = createMessage("a", "b", "two");
    const m3 = createMessage("a", "b", "three");
    await appendHeldMessage(dir, "default", "b", m1);
    await appendHeldMessage(dir, "default", "b", m2);
    await appendHeldMessage(dir, "default", "b", m3);
    expect((await readHeldMessages(dir, "default", "b")).map((m) => m.content)).toEqual(["one", "two", "three"]);

    // 子集 accept：只放行 m2 → 主邮箱 1 行，held 剩 [one, three]。
    const moved = await acceptHeldMessages(dir, "default", "b", [m2.id], 1234);
    expect(moved.map((m) => m.id)).toEqual([m2.id]);
    const main = readFileSync(join(dir, "teams", "default", "inbox", "b.jsonl"), "utf8");
    expect(main).toContain("two");
    expect((await readHeldMessages(dir, "default", "b")).map((m) => m.content)).toEqual(["one", "three"]);

    // 转正消息盖 deliveredAt=now、清 deliveryClaimedAt（v0.1.0 投递语义）。
    const mainLine = JSON.parse(main.trim()) as { deliveredAt?: number; deliveryClaimedAt?: number };
    expect(mainLine.deliveredAt).toBe(1234);
    expect(mainLine.deliveryClaimedAt).toBeUndefined();

    // discard 全集（ids 空 = 全部）→ held 文件删除。
    const dropped = await discardHeldMessages(dir, "default", "b", []);
    expect(dropped).toHaveLength(2);
    expect(existsSync(heldInboxFile(dir, "default", "b"))).toBe(false);
  });

  it("损坏行容错（跳过 + 审计）；ids 未命中 → 空操作", async () => {
    await appendHeldMessage(dir, "default", "b", createMessage("a", "b", "ok"));
    const file = heldInboxFile(dir, "default", "b");
    writeFileSync(file, `${readFileSync(file, "utf8")}{broken\n`, "utf8");
    const held = await readHeldMessages(dir, "default", "b");
    expect(held).toHaveLength(1);
    expect(readFileSync(join(dir, "logs", "engine.jsonl"), "utf8")).toContain('"malformed-line"');

    expect(await acceptHeldMessages(dir, "default", "b", ["no-such-id"])).toEqual([]);
    expect(await discardHeldMessages(dir, "default", "b", ["no-such-id"])).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain("ok");
  });
});

describe("路径约定（本文件是 policy/held 布局的唯一定义点，§7.4-I4）", () => {
  it("policy.json 与 .held.jsonl 落位", () => {
    expect(policyFile(dir, "default")).toBe(join(dir, "teams", "default", "policy.json"));
    expect(heldInboxFile(dir, "default", "Bob_01")).toBe(
      join(dir, "teams", "default", "inbox", "bob-01.held.jsonl"),
    );
  });
});
