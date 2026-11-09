/**
 * W2 单测：跨会话传输层（DESIGN-V0.3.md §4.1 / §4.3 / §4.4 / §4.5；SPEC R-26 ~ R-33）。
 *
 * 用真实命名管道（本机 Windows 11 实测可行，FEASIBILITY-V0.3 §1.2）跑端到端：
 * - 正常投递：连接 → auth → msg → status 回执；
 * - 令牌错误 → 连接被掐断（invalid_target 分类）；
 * - 首帧不是 auth → 断连 + 单次播报（CC @36107247）；
 * - 超长行 → 断连（R-30 限额）；
 * - 端点忙（并发上限 0）→ socket_busy 分类（R-32 七类之一）；
 * - 管道不存在 → stale_socket；给了退化文件 → via:'file' 落盘一行（§4.5）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultPeerSocketPath,
  mintPeerTokens,
  peerEndpointState,
  peerSocketDigest,
  RecentTokenTable,
  sendPeerFrame,
  startPeerEndpoint,
  stopPeerEndpoint,
  validatePeerSocketPath,
  type MsgFrame,
  type PeerEndpointHandlers,
} from "./pipe.js";
import { PEER_TOKEN_RE } from "./frames.js";

const TOKEN = "b".repeat(32);
const BAD_TOKEN = "c".repeat(32);

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xc-peer-"));
});

afterEach(async () => {
  await stopPeerEndpoint();
  // 心跳的写路径是「读-改-写 + 文件锁」：stopPeerEndpoint 清掉定时器之后，
  // 仍可能有一次在途写入正在建 locks/ 目录。rm 与它竞争时 Windows 报
  // ENOTEMPTY（实测：默认并发下偶发，见 evidence/12-v030/acceptance/phase0/）。
  // 这里重试几次，让清理不因在途写入而失败。
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt >= 20) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

function record() {
  return { pid: process.pid, sessionId: "sess-test", name: "alice" };
}

describe("端点启停", () => {
  it("启动后状态可见，停止后不可见", async () => {
    expect(peerEndpointState().running).toBe(false);
    const info = await startPeerEndpoint({ root, record: record(), token: TOKEN });
    expect(info.socketPath).toMatch(/^\\\\\.\\pipe\\/);
    expect(peerEndpointState().running).toBe(true);
    await stopPeerEndpoint();
    expect(peerEndpointState().running).toBe(false);
    // 幂等：再停一次不抛。
    await expect(stopPeerEndpoint()).resolves.toBeUndefined();
  });

  it("令牌不是 32 hex → 拒绝启动", async () => {
    await expect(startPeerEndpoint({ root, record: record(), token: "nope" })).rejects.toThrow(/32 hex/);
  });

  it("非法显式路径 → 拒绝启动（refusing socket path）", async () => {
    await expect(
      startPeerEndpoint({ root, record: record(), token: TOKEN, socketPath: "relative/path" }),
    ).rejects.toThrow(/refusing socket path/);
  });
});

describe("正常投递（auth → msg → status）", () => {
  it("handler 收到 msg 帧，回执原样带回发送方", async () => {
    const seen: MsgFrame[] = [];
    const handlers: PeerEndpointHandlers = {
      onMessage: (frame) => {
        seen.push(frame);
        return { type: "status", msgId: frame.msgId, state: "delivered", detail: "enqueued" };
      },
    };
    const info = await startPeerEndpoint({ root, record: record(), token: TOKEN, handlers });

    const result = await sendPeerFrame({
      socketPath: info.socketPath,
      token: TOKEN,
      frame: { type: "msg", msgId: "m-1", from: "bob", text: "hi alice", senderMode: "prompting" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.via).toBe("pipe");
      expect(result.reply).toEqual({ type: "status", msgId: "m-1", state: "delivered", detail: "enqueued" });
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toBe("hi alice");
    expect(seen[0]!.senderMode).toBe("prompting");
  });

  it("handler 不返回 status → 端点按 accepted-no-status 应答（契约见 pipe.ts）", async () => {
    const info = await startPeerEndpoint({ root, record: record(), token: TOKEN });
    const result = await sendPeerFrame({
      socketPath: info.socketPath,
      token: TOKEN,
      frame: { type: "msg", msgId: "m-2", from: "bob", text: "hello" },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.reply?.type === "status") {
      expect(result.reply.state).toBe("delivered");
      expect(result.reply.detail).toBe("accepted-no-status");
    } else {
      throw new Error("expected a status reply");
    }
  });

  it("held / refused / dropped 回执原样透传", async () => {
    for (const state of ["held", "refused", "dropped"] as const) {
      const info = await startPeerEndpoint({
        root,
        record: record(),
        token: TOKEN,
        handlers: { onMessage: (frame) => ({ type: "status", msgId: frame.msgId, state }) },
      });
      const result = await sendPeerFrame({
        socketPath: info.socketPath,
        token: TOKEN,
        frame: { type: "msg", msgId: `m-${state}`, from: "bob", text: "x" },
      });
      expect(result.ok).toBe(true);
      if (result.ok && result.reply?.type === "status") expect(result.reply.state).toBe(state);
      await stopPeerEndpoint();
    }
  });
});

describe("鉴权纪律（R-29 / CC @36107247）", () => {
  it("令牌错误 → 连接被掐断，发送方归类 invalid_target", async () => {
    const info = await startPeerEndpoint({ root, record: record(), token: TOKEN });
    const result = await sendPeerFrame({
      socketPath: info.socketPath,
      token: BAD_TOKEN,
      frame: { type: "msg", msgId: "m-1", from: "bob", text: "hi" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("invalid_target");
  });

  it("首帧不是 auth → 断连 + 单次播报", async () => {
    const warnings: unknown[] = [];
    const info = await startPeerEndpoint({
      root,
      record: record(),
      token: TOKEN,
      handlers: { onUnauthenticated: (i) => warnings.push(i) },
    });

    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(info.socketPath);
      socket.on("close", () => resolve(true));
      socket.on("error", () => resolve(false));
      socket.write(`${JSON.stringify({ type: "msg", msgId: "m", from: "bob", text: "no auth" })}\n`);
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);
    });

    expect(closed).toBe(true);
    expect(warnings.length).toBe(1);
  });

  it("首帧期限（authTimeoutMs）到 → 断连", async () => {
    const info = await startPeerEndpoint({ root, record: record(), token: TOKEN, authTimeoutMs: 120 });
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(info.socketPath);
      socket.on("close", () => resolve(true));
      socket.on("error", () => resolve(false));
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);
    });
    expect(closed).toBe(true);
  });
});

describe("限额与忙分类（R-30 / R-32）", () => {
  it("超长行 → 断连", async () => {
    const info = await startPeerEndpoint({ root, record: record(), token: TOKEN, maxLineBytes: 128 });
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(info.socketPath);
      socket.on("close", () => resolve(true));
      socket.on("error", () => resolve(false));
      socket.write(`${"x".repeat(500)}\n`);
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);
    });
    expect(closed).toBe(true);
  });

  it("端点忙（并发上限 0）→ socket_busy", async () => {
    const info = await startPeerEndpoint({ root, record: record(), token: TOKEN, maxConnections: 0 });
    const result = await sendPeerFrame({
      socketPath: info.socketPath,
      token: TOKEN,
      frame: { type: "msg", msgId: "m-1", from: "bob", text: "hi" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("socket_busy");
  });

  it("超预算的 msg 帧 → too_large（发送前判定，不上线）", async () => {
    const info = await startPeerEndpoint({ root, record: record(), token: TOKEN });
    const result = await sendPeerFrame({
      socketPath: info.socketPath,
      token: TOKEN,
      frame: { type: "msg", msgId: "m-1", from: "bob", text: "x".repeat(1_100_000) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("too_large");
  });
});

describe("文件收件箱退化路径（§4.5）", () => {
  it("管道不存在 + 给退化文件 → via:'file'，文件里原样落下调用方给的那一行", async () => {
    const fallback = join(root, "inbox", "sess-b.jsonl");
    const line = JSON.stringify({
      msgId: "m-1",
      from: "bob",
      hopChain: ["bob"],
      text: "offline drop",
      ts: 1,
      via: "file",
    });
    const result = await sendPeerFrame({
      socketPath: "\\\\.\\pipe\\LOCAL\\xcc-msg-does-not-exist",
      token: TOKEN,
      frame: { type: "msg", msgId: "m-1", from: "bob", text: "offline drop" },
      fallback: { file: fallback, line },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.via).toBe("file");

    const raw = await readFile(fallback, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(line);
    // 行形状由调用方决定（传输层不认领域对象）：这里断言它仍是合法 JSON。
    const parsed = JSON.parse(lines[0]!) as { msgId: string; text: string; via: string };
    expect(parsed.msgId).toBe("m-1");
    expect(parsed.text).toBe("offline drop");
    expect(parsed.via).toBe("file");
  });

  it("管道不存在 + 无退化文件 → stale_socket", async () => {
    const result = await sendPeerFrame({
      socketPath: "\\\\.\\pipe\\LOCAL\\xcc-msg-does-not-exist",
      token: TOKEN,
      frame: { type: "msg", msgId: "m-1", from: "bob", text: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("stale_socket");
  });
});

describe("路径校验与令牌工具（R-26 / R-27 / R-29）", () => {
  it("Windows 端点路径校验", () => {
    if (process.platform !== "win32") return;
    expect(validatePeerSocketPath("\\\\.\\pipe\\LOCAL\\xcc-msg-abc").ok).toBe(true);
    expect(validatePeerSocketPath("\\\\.\\pipe\\xcc-msg-abc").ok).toBe(true);
    expect(validatePeerSocketPath("").ok).toBe(false);
    expect(validatePeerSocketPath("relative").ok).toBe(false);
    expect(validatePeerSocketPath("\\\\server\\share\\pipe\\x").ok).toBe(false);
    expect(validatePeerSocketPath("\\\\.\\pipe\\a\\b\\c").ok).toBe(false);
    expect(validatePeerSocketPath("\\\\.\\pipe\\name.").ok).toBe(false);
    expect(validatePeerSocketPath("\\\\.\\pipe\\name ").ok).toBe(false);
  });

  it("默认端点路径构型（R-26）", () => {
    const path = defaultPeerSocketPath();
    if (process.platform === "win32") {
      expect(path).toMatch(/^\\\\\.\\pipe\\LOCAL\\xcc-msg-[0-9a-f]{32}$/);
    } else {
      expect(path.startsWith("/tmp/xcc-socks-")).toBe(true);
    }
  });

  it("令牌铸造：两个 32 hex，互不相同", () => {
    const tokens = mintPeerTokens();
    expect(PEER_TOKEN_RE.test(tokens.peerToken)).toBe(true);
    expect(PEER_TOKEN_RE.test(tokens.childToken)).toBe(true);
    expect(tokens.peerToken).not.toBe(tokens.childToken);
  });

  it("近期令牌表：容量上限 32（FIFO）", () => {
    const table = new RecentTokenTable(32);
    for (let i = 0; i < 40; i += 1) table.remember(`token-${i}`);
    expect(table.size).toBe(32);
    expect(table.has("token-39")).toBe(true);
    expect(table.has("token-0")).toBe(false);
  });

  it("端点路径摘要稳定且大小写无关（Windows 管道名）", () => {
    expect(peerSocketDigest("\\\\.\\pipe\\LOCAL\\xcc-msg-abc")).toBe(
      peerSocketDigest("\\\\.\\pipe\\local\\xcc-msg-abc"),
    );
  });
});

describe("注册表心跳（DESIGN-V0.3 §2.2）", () => {
  it("端点运行期间周期刷新注册记录的 lastSeen（否则记录被判 stale 而被清扫）", async () => {
    const { writePeerRecord } = await import("../core/peerregistry.js");
    const rec = {
      pid: process.pid,
      sessionId: "sess-heartbeat",
      messagingSocketPath: "\\.\pipe\LOCAL\xcc-msg-heartbeat",
      pidDomain: (await import("../core/peerdir.js")).localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive" as const,
      name: "alice",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: 1_000,
      updatedAt: 1_000,
    };
    await writePeerRecord(root, rec);
    await startPeerEndpoint({
      root,
      record: record(),
      token: TOKEN,
      heartbeatIntervalMs: 40,
    });
    await new Promise((r) => setTimeout(r, 300));
    const { readPeerRecord } = await import("../core/peerregistry.js");
    const after = await readPeerRecord(root, process.pid);
    expect(after).toBeDefined();
    // lastSeen 必须被心跳推进（否则 60 s 后 peerIsAlive() 判死 → peer_not_found）。
    expect(after!.lastSeen).toBeGreaterThan(rec.lastSeen);
    // 其余字段不得被心跳写坏。
    expect(after!.name).toBe("alice");
    expect(after!.sessionId).toBe("sess-heartbeat");
  });

  it("记录缺失时心跳不重建残缺记录", async () => {
    await startPeerEndpoint({
      root,
      record: record(),
      token: TOKEN,
      heartbeatIntervalMs: 40,
    });
    await new Promise((r) => setTimeout(r, 200));
    const { readPeerRecord } = await import("../core/peerregistry.js");
    // 注册记录从未写过 ⇒ 心跳不得凭空造一条（touchPeerRecord 在记录缺失时会按 patch 造残缺记录）。
    expect(await readPeerRecord(root, process.pid)).toBeUndefined();
  });

  it("优雅退出时摘掉本进程的注册记录（DESIGN-V0.3 §2.2 退出清理）", async () => {
    const { writePeerRecord, readPeerRecord } = await import("../core/peerregistry.js");
    const { localPidDomain } = await import("../core/peerdir.js");
    await writePeerRecord(root, {
      pid: process.pid,
      sessionId: "sess-exit",
      messagingSocketPath: "\\.\pipe\LOCAL\xcc-msg-exit",
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      name: "alice",
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
      updatedAt: Date.now(),
    });
    await startPeerEndpoint({ root, record: record(), token: TOKEN });
    expect(await readPeerRecord(root, process.pid)).toBeDefined();
    await stopPeerEndpoint();
    expect(await readPeerRecord(root, process.pid)).toBeUndefined();
  });
});
