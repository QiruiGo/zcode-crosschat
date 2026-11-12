/**
 * W6 集成单测：默认 peer 服务装配（`createDefaultPeerServices`）的跨模块接线。
 *
 * 本文件只覆盖**装配层的接缝**（工具层假实现的用例在 peer-tools.test.ts）：
 * 1. `xc_peers` 缺省口径 = self + member + session 三类行（DESIGN §8.1 / §9.2：
 *    一次调用里必须同时出现 `self(alice)` 与 `session(bob)`）；
 * 2. 放行 hold 消息后**给发方补 `delivered` 回执**（DESIGN §9.3「A 侧收到
 *    delivered」/§6.3「accept → 放行 + 回执 delivered」）；
 * 3. `xc_agents` 面板同时给出逐消息裁决口径与**会话级查询面**（CC `H()`，
 *    DESIGN §6.2 DV-2 / §8.3 / §14 U16）。
 *
 * 真实依赖：命名管道（Windows 本机可行，FEASIBILITY-V0.3 §1.2）+ 真实注册表文件。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPidDomain, writePeerBaseRecord } from "../core/peerdir.js";
import { holdPeerMessage } from "../core/peerpolicy.js";
import { writePeerKeyFile, writePeerRecord } from "../core/peerregistry.js";
import { stopPeerEndpoint } from "../transport/pipe.js";
import { createDefaultPeerServices } from "./peer-tools.js";
import { ToolError } from "./protocol.js";
import type { ToolDeps } from "./tools.js";

const TOKEN = "d".repeat(32);

let root = "";
let workspace = "";
let stateRoot = "";
let deps: ToolDeps;
let child: ReturnType<typeof spawn> | undefined;
let fakeServer: Server | undefined;
let received: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xc-peerint-"));
  workspace = await mkdtemp(join(tmpdir(), "xc-peerint-ws-"));
  stateRoot = join(workspace, ".crosschat");
  received = [];
  deps = {
    stateRoot,
    workspace,
    env: {
      XC_MESSAGING_DIR: root,
      // 显式 accept：放行路径按「当前策略」重裁时走 accept 分支。
      XC_CROSSCHAT_INBOUND: "accept",
    } as NodeJS.ProcessEnv,
  };
});

afterEach(async () => {
  await stopPeerEndpoint();
  if (fakeServer !== undefined) {
    await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
    fakeServer = undefined;
  }
  if (child !== undefined) {
    child.kill();
    child = undefined;
  }
  await rm(root, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

/** 起一个记录入站行、并对 status 帧回一句 status 的假管道服务端（模拟「发方」端点）。 */
async function startFakePeerEndpoint(): Promise<string> {
  const socketPath = `\\\\.\\pipe\\LOCAL\\xcc-msg-int-${Math.random().toString(16).slice(2)}`;
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        received.push(line);
        try {
          const frame = JSON.parse(line) as { type?: string; msgId?: string };
          if (frame.type === "auth") {
            // 完成鉴权握手：首帧 auth 之后发送方才肯发 msg（transport/pipe.ts）。
            socket.write(`${JSON.stringify({ type: "auth", ok: true })}\n`);
          } else if (frame.type === "msg") {
            // 回一句 delivered 回执：发送方在等 status，不回就会一直等到超时。
            socket.write(`${JSON.stringify({ type: "status", msgId: frame.msgId, state: "delivered" })}\n`);
          } else if (frame.type === "status") {
            socket.write(`${JSON.stringify({ type: "status", msgId: frame.msgId, state: "delivered" })}\n`);
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
        index = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  fakeServer = server;
  return socketPath;
}

/** 起一个活着但什么也不干的子进程——它的 pid 用来当「另一个 peer」的 pid。 */
async function startSleeper(): Promise<number> {
  child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child!.once("spawn", () => resolve()));
  return child.pid!;
}

describe("xc_peers 的缺省口径（DESIGN §8.1 / §9.2）", () => {
  it("不指定 kind 时同时给出 self 与 session 行", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });

    const otherPid = await startSleeper();
    await writePeerRecord(root, {
      pid: otherPid,
      sessionId: "sess-bob",
      messagingSocketPath: await startFakePeerEndpoint(),
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      name: "bob",
      formerNames: [],
      cwd: "D:\\ws-b",
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });

    const all = await services.list(undefined);
    expect(all.map((row) => `${row.name}:${row.kind}`)).toEqual(
      expect.arrayContaining(["alice:self", "bob:session"]),
    );

    const sessionsOnly = await services.list("session");
    expect(sessionsOnly.map((row) => row.name)).toEqual(["bob"]);
    expect(sessionsOnly.map((row) => row.kind)).not.toContain("self");
  });
});

describe("放行 hold 消息后给发方补回执（DESIGN §9.3 / §6.3）", () => {
  it("accept 之后发方收到 status:delivered", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });

    const socketPath = await startFakePeerEndpoint();
    const otherPid = await startSleeper();
    await writePeerRecord(root, {
      pid: otherPid,
      sessionId: "sess-bob",
      messagingSocketPath: socketPath,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      name: "bob",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    await writePeerKeyFile(root, otherPid, socketPath, {
      peerToken: TOKEN,
      pidDomain: localPidDomain(),
    });

    await holdPeerMessage(
      root,
      "sess-alice",
      {
        msgId: "m-held-1",
        from: "bob",
        fromSessionId: "sess-bob",
        hopChain: ["bob"],
        text: "hello",
        ts: Date.now(),
        via: "pipe",
      },
      "mode-mismatch",
      { workspace },
    );

    const result = await services.review({ action: "accept", ids: ["m-held-1"] });
    expect(result.affected).toEqual(["m-held-1"]);
    expect(result.receipts[0]?.receipt).toBe("delivered");

    // 发方端点收到了 auth 首帧 + status 回执帧。
    expect(received.length).toBeGreaterThanOrEqual(2);
    const statusLine = received.map((line) => JSON.parse(line) as { type: string; state?: string; msgId?: string })
      .find((frame) => frame.type === "status");
    expect(statusLine).toBeDefined();
    expect(statusLine!.msgId).toBe("m-held-1");
    expect(statusLine!.state).toBe("delivered");
  });
});

describe("放行时重新裁决必须带收方档类（v0.5 验收修复 F6：16-v050 验收发现）", () => {
  it("收方档类已知时，cause=mode-unknown 的暂存件可被 accept 放行", async () => {
    // 无显式策略层（不设 XC_CROSSCHAT_INBOUND）→ 走自动档：收方档类必须参与裁决。
    const services = createDefaultPeerServices({
      ...deps,
      env: { XC_MESSAGING_DIR: root } as NodeJS.ProcessEnv,
    });
    await services.register({ name: "alice", sessionId: "sess-alice" });

    const socketPath = await startFakePeerEndpoint();
    const otherPid = await startSleeper();
    await writePeerRecord(root, {
      pid: otherPid,
      sessionId: "sess-bob",
      messagingSocketPath: socketPath,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      name: "bob",
      formerNames: [],
      cwd: "D:\\ws-b",
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    await writePeerKeyFile(root, otherPid, socketPath, {
      peerToken: TOKEN,
      pidDomain: localPidDomain(),
    });
    // 收方基记录（档类 prompting）——缺失即 mode-unknown。
    await writePeerBaseRecord(root, {
      sessionId: "sess-alice",
      cwd: workspace,
      permissionMode: "prompting",
      source: "startup",
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    await holdPeerMessage(
      root,
      "sess-alice",
      {
        msgId: "m-held-f6",
        from: "bob",
        fromSessionId: "sess-bob",
        fromMode: "prompting",
        hopChain: ["bob"],
        text: "hello-f6",
        ts: Date.now(),
        via: "pipe",
      },
      "mode-unknown",
      { workspace },
    );

    const result = await services.review({ action: "accept", ids: ["m-held-f6"] });
    expect(result.affected).toEqual(["m-held-f6"]);
    // 修复前此处为 still-held（重新裁决缺 recvClass → 恒判 mode-unknown）。
    expect(result.receipts[0]?.receipt).toBe("delivered");
  });
});

describe("xc_agents 面板的入站策略两面（DESIGN §6.2 DV-2 / §14 U16）", () => {
  it("同时给出逐消息裁决口径与会话级查询面", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });

    const panel = await services.agents();
    expect(panel.inboundPolicy).toBeDefined();
    expect(panel.inboundPolicy!.mode).toBe("accept");
    expect(panel.inboundPolicy!.decidedBy).toBe("explicit-setting");
    // 会话级查询面（CC `H()`）：显式 accept ⇒ accept，无 holdCause。
    expect(panel.inboundPolicy!.sessionLevelQuery).toEqual({ policy: "accept" });
  });
});

describe("重名消歧（DESIGN §5.3「可达的歧义场景」）", () => {
  it("两个其他 peer 共享同一名字：裸名 ambiguous，`名字 [ref]` 精确命中两者", async () => {
    const services = createDefaultPeerServices(deps);
    // 本会话只当「旁观/发信方」，不占名字（避免退化到「发给自已」的角落情形）。
    await services.register({ name: "sender", sessionId: "sess-sender" });

    // peer A：当前名 alice。
    const pidA = await startSleeper();
    const sockA = await startFakePeerEndpoint();
    await writePeerRecord(root, {
      pid: pidA,
      sessionId: "sess-a",
      messagingSocketPath: sockA,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      name: "alice",
      formerNames: [],
      cwd: "D:\ws-a",
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    await writePeerKeyFile(root, pidA, sockA, { peerToken: TOKEN, pidDomain: localPidDomain() });

    // peer B：当前名 alice2，旧名 alice 进 formerNames ⇒ alice 是 B 的可寻址别名。
    const pidB = await startSleeper();
    const sockB = await startFakePeerEndpoint();
    await writePeerRecord(root, {
      pid: pidB,
      sessionId: "sess-b",
      messagingSocketPath: sockB,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      name: "alice2",
      formerNames: [{ name: "alice", releasedAt: Date.now() }],
      cwd: "D:\ws-b",
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    await writePeerKeyFile(root, pidB, sockB, { peerToken: TOKEN, pidDomain: localPidDomain() });

    // 列表口径：两行 alice（B 那行标 former），两行都带 ref。
    const rows = await services.list(undefined);
    const aliceRows = rows.filter((row) => row.name === "alice");
    expect(aliceRows.length).toBe(2);
    expect(aliceRows.every((row) => row.ref !== "")).toBe(true);
    expect(aliceRows.some((row) => row.former === true)).toBe(true);

    // 裸名发送 ⇒ ambiguous（不猜；CC "Do not guess between them" @15688377）。
    const amb = await services.send({ to: "alice", message: "x" }).catch((e) => e);
    const ambPayload = ((amb as ToolError).payload ?? {}) as {
      error?: string;
      candidates?: { name: string; ref: string }[];
    };
    expect(ambPayload.error).toBe("ambiguous_target");
    expect(ambPayload.candidates?.length).toBe(2);
    expect(String((amb as ToolError).message ?? amb)).toContain("disambiguate with");

        // `名字 [ref]` 精确命中（别名持有者 B 与当前名持有者 A 各一次）。
        const refB = aliceRows.find((r) => r.former)?.ref;
        const refA = aliceRows.find((r) => !r.former)?.ref;
        expect(refB).toBe("sess-b");
        expect(refA).toBe("sess-a");
        const hitAlias = await services.send({ to: `alice [${refB}]`, message: "to-alias-holder" });
        expect(hitAlias.receipt).toBe("delivered");
        const hitCurrent = await services.send({ to: `alice [${refA}]`, message: "to-current-holder" });
        expect(hitCurrent.receipt).toBe("delivered");
        // 两个 ref 都真的把消息投到了各自的假端点（各收到一行 msg 帧）。
        expect(received.filter((line) => line.includes("to-alias-holder")).length).toBe(1);
        expect(received.filter((line) => line.includes("to-current-holder")).length).toBe(1);
  }, 30_000);
});

// ─────────────────────────── v0.5.1 BND-2：显式 hold 策略下 accept 必须真放行 ───────────────────────────

describe("BND-2 修复：显式 hold 策略下 xc_peer_review accept 必须真投递（红队假成功黑洞回归）", () => {
  it("repo 层 {mode:hold} 暂存的件，accept 后入队 + 暂存区清空 + 审计带终态计数（策略文件未动）", async () => {
    // 收方策略 = 项目层文件 hold（不设 XC_CROSSCHAT_INBOUND，让 repo 层成为唯一显式层）。
    const policyDir = join(stateRoot, "peer");
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, "inbound.json"), JSON.stringify({ mode: "hold" }), "utf8");

    const services = createDefaultPeerServices({
      ...deps,
      env: { XC_MESSAGING_DIR: root } as NodeJS.ProcessEnv,
    });
    await services.register({ name: "alice", sessionId: "sess-alice" });

    // 直落一件暂存（等价于 pa→pb 被三态闸 hold 的产物，cause=repo-setting）。
    await holdPeerMessage(
      root,
      "sess-alice",
      {
        msgId: "m-held-bnd2",
        from: "bob",
        fromSessionId: "sess-bob",
        hopChain: ["bob"],
        text: "bnd2-black-hole-probe",
        ts: Date.now(),
        via: "pipe",
      },
      "repo-setting",
      { workspace },
    );

    // 修复前：accept 重裁回 still-held，「影响 1 条」假成功、消息滞留到 12h TTL。
    const result = await services.review({ action: "accept", ids: ["m-held-bnd2"] });
    expect(result.affected).toEqual(["m-held-bnd2"]);
    expect(result.receipts[0]?.outcome).toBe("delivered");
    expect(result.receipts[0]?.receipt).toBe("delivered");

    // 真投递：消息已进投递级队列（xc_peer_inbox 的下一轮就能取走），暂存区清空。
    const { readPeerQueue } = await import("../core/peermsg.js");
    const queued = await readPeerQueue(root, "sess-alice");
    expect(queued.map((item) => item.msgId)).toEqual(["m-held-bnd2"]);
    const { listHeldPeerMessages } = await import("../core/peerpolicy.js");
    expect(await listHeldPeerMessages(root, "sess-alice")).toHaveLength(0);

    // 策略文件未被改写（放行不依赖改策略）。
    expect(readFileSync(join(policyDir, "inbound.json"), "utf8")).toContain('"hold"');

    // 审计如实：peer-hold-released 事件带终态计数（旧版只记 ids，still-held 也算 released）。
    const auditFile = join(root, "logs", "peer.jsonl");
    expect(existsSync(auditFile)).toBe(true);
    const events = readFileSync(auditFile, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const released = events.filter((e) => (e["event"] as Record<string, unknown> | undefined)?.["event"] === "peer-hold-released");
    const last = released.at(-1);
    expect(last).toBeDefined();
    // peerregistry 的 logPeerEvent 形态：{event:{...业务字段}, ts} —— 计数在 event 内层。
    expect((last!["event"] as Record<string, unknown>)["outcomes"]).toMatchObject({ delivered: 1, "still-held": 0 });
  });

  it("策略转为 refuse 时 accept 仍拒放（fail-closed：显式批准不越过 opt-out）", async () => {
    const policyDir = join(stateRoot, "peer");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, "inbound.json"), JSON.stringify({ mode: "refuse" }), "utf8");

    const services = createDefaultPeerServices({
      ...deps,
      env: { XC_MESSAGING_DIR: root } as NodeJS.ProcessEnv,
    });
    await services.register({ name: "alice", sessionId: "sess-alice" });
    await holdPeerMessage(
      root,
      "sess-alice",
      {
        msgId: "m-held-refuse",
        from: "bob",
        fromSessionId: "sess-bob",
        hopChain: ["bob"],
        text: "should-stay-refused",
        ts: Date.now(),
        via: "pipe",
      },
      "repo-setting",
      { workspace },
    );

    const result = await services.review({ action: "accept", ids: ["m-held-refuse"] });
    expect(result.receipts[0]?.outcome).toBe("refused");
    expect(result.receipts[0]?.receipt).toBe("refused");
    // refuse 终态=删除暂存件（DESIGN §6.3），消息不进队列。
    const { readPeerQueue } = await import("../core/peermsg.js");
    expect(await readPeerQueue(root, "sess-alice")).toHaveLength(0);
    const { listHeldPeerMessages } = await import("../core/peerpolicy.js");
    expect(await listHeldPeerMessages(root, "sess-alice")).toHaveLength(0);
  });
});
