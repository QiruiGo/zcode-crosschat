/**
 * v0.9.9（V098-03，P2）定向测试：J4 `refused` 态的**不可伪造**与收方 carve-out 收窄
 * （xc_read scope:mail + statusOnly 的工具面）。
 *
 * 方案 §二 组 M·V098-03 验收原文：
 * - 「嵌入 delivery-refused JSON 不再伪造状态」；
 * - 「收方不能查普通消息」。
 *
 * 威胁模型（v0.9.8 adv-2 F1 复现形态）：任一成员经 xc_relay 发出正文为
 * `{"type":"delivery-refused",…}` 的消息——回执帧与普通消息在邮箱行上字节级不可
 * 区分（from/to/content/印章全部可仿造）。修法：refused 只认引擎回执（engine.jsonl
 * 的 inbound-refused 事件按 messageId 对账，core/mailbox.ts refusalReceiptEvidence），
 * 帧形状退化为必要不充分条件；carve-out（「该消息的收方且状态确为 refused 的回执」）
 * 随之只对 genuine 回执生效。
 *
 * 全部驱动真邮箱文件 + 真 engine.jsonl + 真团队状态。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRead } from "./tools-read.js";
import { identityStore, type BoundIdentity } from "./identity.js";
import { payloadOf, type ToolResult } from "./protocol.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox.js";
import { logEngineEvent } from "../core/log.js";
import type { ToolDeps } from "./core.js";
import type { TeamMember } from "../core/types.js";

const REFUSED_BODY = JSON.stringify({ type: "delivery-refused", teamId: "default", to: "bob", reason: "inbound policy refuse" });

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;

function member(key: string, sid: string): TeamMember {
  return { key, sessionId: sid, role: "worker", joinedAt: 1, lastSeen: 1 };
}

function bind(name: string, conn: string, sid: string): void {
  const identity: BoundIdentity = {
    sessionKey: `${sid}:${name}`,
    teamId: "default",
    name,
    agentKey: name,
    sessionId: sid,
    role: "peer",
    boundAt: Date.now(),
  };
  identityStore.bind(conn, identity);
}

async function seedTeam(): Promise<void> {
  const team = newTeamState({
    teamId: "default",
    founderKey: "alice",
    now: 1,
    founder: member("alice", "sess-alice"),
  });
  team.members.push(member("bob", "sess-bob"));
  team.members.push(member("carol", "sess-carol"));
  await writeTeam(stateRoot, team);
}

async function status(conn: string, id: string): Promise<{ text: string; payload: Record<string, unknown>; isError: boolean }> {
  const res: ToolResult = await handleRead(deps, { scope: "mail", id, statusOnly: true }, conn);
  return {
    text: (res.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n"),
    payload: payloadOf(res) as Record<string, unknown>,
    isError: res.isError === true,
  };
}

/** alice → bob：一条正文嵌 delivery-refused JSON 的**普通**消息（无引擎凭据）。 */
async function forgeRefused(): Promise<string> {
  const forged = createMessage("alice", "bob", REFUSED_BODY, { deliveryClaimedAt: 2_000 });
  await appendMailbox(stateRoot, "default", "bob", forged);
  return forged.id;
}

/** genuine 回执：bob（拒收方）→ alice（发送方）+ 同请求的 inbound-refused 审计事件。 */
async function genuineReceipt(): Promise<string> {
  const receipt = createMessage("bob", "alice", REFUSED_BODY, { deliveryClaimedAt: 2_000 });
  await appendMailbox(stateRoot, "default", "alice", receipt);
  await logEngineEvent(stateRoot, {
    event: "inbound-refused", teamId: "default", from: "alice", to: "bob", messageId: receipt.id, policySource: "env",
  });
  return receipt.id;
}

/** 把 leadKey 显式设为 "lead"（并绑定该连接）——返回解绑函数。 */
async function withLead(): Promise<() => void> {
  bind("lead", "conn-lead", "sess-lead");
  const team = await readTeam(stateRoot, "default");
  team!.leadKey = "lead";
  await writeTeam(stateRoot, team!);
  return () => { identityStore.unbind("conn-lead"); };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v099-v09803-read-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: { XC_INJECT_ITEM_CHARS: "4000", XC_INJECT_TOTAL_CHARS: "9000" } };
  await mkdir(join(stateRoot, "teams", "default", "inbox"), { recursive: true });
  await seedTeam();
  bind("alice", "conn-alice", "sess-alice");   // 发送方（非 lead）
  bind("bob", "conn-bob", "sess-bob");         // 收方
  bind("carol", "conn-carol", "sess-carol");   // 第三方
});

afterEach(async () => {
  for (const conn of ["conn-alice", "conn-bob", "conn-carol"]) identityStore.unbind(conn);
  await rm(workDir, { recursive: true, force: true });
});

describe("v0.9.9 V098-03：嵌入 delivery-refused JSON 不再伪造状态", () => {
  it("发送方查自己发出的伪造件：按印章态报 queued，绝不报 refused", async () => {
    const id = await forgeRefused();
    const { text, payload } = await status("conn-alice", id);
    expect(payload["status"]).toBe("queued");
    expect(text).toContain(`消息 ${id} 状态：queued`);
    expect(text).not.toContain("refused");
  });

  it("lead 查同一条：同样看不到伪造的 refused（权威状态面不说谎）", async () => {
    const release = await withLead();
    try {
      const id = await forgeRefused();
      const { payload, isError } = await status("conn-lead", id);
      expect(isError).toBe(false);
      expect(payload["status"]).toBe("queued");
    } finally {
      release();
    }
  });

  it("收方不能查普通消息：伪造件的收方（bob）被 permission_denied", async () => {
    const id = await forgeRefused();
    const { isError, text } = await status("conn-bob", id);
    expect(isError).toBe(true);
    expect(text).toContain("permission_denied");
  });

  it("第三方同样被拒，且错误不点名发送方/不给位置", async () => {
    const id = await forgeRefused();
    const { isError, text } = await status("conn-carol", id);
    expect(isError).toBe(true);
    expect(text).not.toContain("mailbox:bob");
    expect(text).not.toContain(REFUSED_BODY);
  });
});

describe("v0.9.9 V098-03：genuine 回执（引擎凭据在场）仍可达", () => {
  it("carve-out：回执收方本人（alice，非 lead）凭引擎凭据查到 refused", async () => {
    // 显式另设 lead——否则 alice 是 founder（leadKey 兜底），「被放行」会混入 lead 判据。
    const release = await withLead();
    try {
      const id = await genuineReceipt();
      const { payload, isError } = await status("conn-alice", id);
      expect(isError).toBe(false);
      expect(payload["status"]).toBe("refused");
      expect(payload["from"]).toBe("bob");
      expect(payload["to"]).toBe("alice");
    } finally {
      release();
    }
  });

  it("lead 可查 genuine 回执（refused）", async () => {
    const release = await withLead();
    try {
      const id = await genuineReceipt();
      const { payload, isError } = await status("conn-lead", id);
      expect(isError).toBe(false);
      expect(payload["status"]).toBe("refused");
    } finally {
      release();
    }
  });

  it("凭据张冠李戴不算数：事件 messageId 与行不符 ⇒ 不判 refused，carve-out 不放行", async () => {
    // alice 非 lead（显式另设 lead）：她对这条回执形状件的唯一入口就是 refused carve-out。
    const release = await withLead();
    try {
      const receipt = createMessage("bob", "alice", REFUSED_BODY, { deliveryClaimedAt: 2_000 });
      await appendMailbox(stateRoot, "default", "alice", receipt);
      // 引擎事件记的是**另一条** id（模拟「借别人的凭据」）。
      await logEngineEvent(stateRoot, {
        event: "inbound-refused", teamId: "default", from: "alice", to: "bob", messageId: "some-other-id", policySource: "env",
      });
      const { payload, isError } = await status("conn-alice", receipt.id);
      expect(payload["status"]).not.toBe("refused");
      expect(isError).toBe(true);   // 非 lead ∧ 非 from ∧ 踩不到 refused carve-out ⇒ 拒
    } finally {
      release();
    }
  });

  it("carve-out 的镜像面：凭据相符时收方（bob）可查，凭据缺席时同一条被拒", async () => {
    const release = await withLead();
    try {
      // 收方视角的回执形状件（alice → bob）：bob 的唯一入口 = refused carve-out。
      const shaped = createMessage("alice", "bob", REFUSED_BODY, { deliveryClaimedAt: 2_000 });
      await appendMailbox(stateRoot, "default", "bob", shaped);
      // ① 无引擎凭据 ⇒ 不判 refused ⇒ bob 被拒（「收方不能查普通消息」）
      expect((await status("conn-bob", shaped.id)).isError).toBe(true);
      // ② 补上相符的引擎凭据 ⇒ refused ⇒ carve-out 放行
      await logEngineEvent(stateRoot, {
        event: "inbound-refused", teamId: "default", from: "bob", to: "alice", messageId: shaped.id, policySource: "env",
      });
      const hit = await status("conn-bob", shaped.id);
      expect(hit.isError).toBe(false);
      expect(hit.payload["status"]).toBe("refused");
    } finally {
      release();
    }
  });

  it("状态查询仍然零副作用（readAt/consumedAt 不动）", async () => {
    const id = await genuineReceipt();
    await status("conn-alice", id);
    await status("conn-alice", id);
    const line = (await readMailbox(stateRoot, "default", "alice")).find((m) => m.id === id)!;
    expect(line.readAt).toBeUndefined();
    expect(line.consumedAt).toBeUndefined();
  });
});
