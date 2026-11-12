/**
 * CONC-2 防回归单测（v0.5.1）：MCP stdio 大帧守卫。
 *
 * 红队原始复现（并发与-2 / 裁决 #7）：队内 `xc_message` ≥10MiB 单帧 → server
 * exit code 0 静默自退出、无响应帧、stderr 空、载荷丢弃。根因 = SDK
 * StdioServerTransport 的 ReadBuffer 溢出 catch 会 close 传输 → server.ts 的
 * onclose → process.exit(0)。
 *
 * 本文件在传输层锁死修复行为：
 * - ≤32MiB 帧正常解析（红队实测档位 12/24MiB 不再杀进程，README「队内无此闸」）；
 * - >32MiB 帧显式 JSON-RPC 拒收（code -32700），传输**不关闭**、后续帧继续服务；
 * - 常规坏帧（JSON 解析失败）不杀传输（SDK 原语义保持）。
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  GuardedStdioTransport,
  MCP_MAX_FRAME_BYTES,
  OVERSIZE_FRAME_RPC_CODE,
} from "./mcpstdio.js";

/** 最小假 stdin/stdout：只实现 StdioServerTransport 用到的面。 */
class FakeStdin extends EventEmitter {
  pause(): void {
    /* no-op */
  }
  write(chunk: Buffer): void {
    this.emit("data", chunk);
  }
}

class FakeStdout {
  readonly lines: string[] = [];
  write(text: string): boolean {
    this.lines.push(text);
    return true;
  }
  once(): void {
    /* write 恒返回 true，不会走到 drain 分支 */
  }
}

interface Harness {
  transport: GuardedStdioTransport;
  stdin: FakeStdin;
  stdout: FakeStdout;
  closed: { value: boolean };
  errors: Error[];
  messages: unknown[];
  /** 驱动一行（自动补 \n）。 */
  feed(line: string): void;
}

async function harness(options?: { maxFrameBytes?: number }): Promise<Harness> {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const transport = new GuardedStdioTransport(
    stdin as unknown as import("node:stream").Readable,
    stdout as unknown as import("node:stream").Writable,
    options ?? {},
  );
  await transport.start(); // 注册 data/error 监听（生产路径由 server.connect 触发）
  const closed = { value: false };
  transport.onclose = () => {
    closed.value = true;
  };
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  const messages: unknown[] = [];
  transport.onmessage = (message) => messages.push(message);
  return {
    transport,
    stdin,
    stdout,
    closed,
    errors,
    messages,
    feed: (line: string) => stdin.write(Buffer.from(`${line}\n`, "utf8")),
  };
}

const validRequest = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "xc_status", arguments: {} },
});

describe("transport/mcpstdio（CONC-2）: 上限内大帧正常解析", () => {
  it("默认上限 32MiB（覆盖红队实测的 10~24MiB 档位）", () => {
    expect(MCP_MAX_FRAME_BYTES).toBe(32 * 1024 * 1024);
  });

  it("12MiB content 的 tools/call 帧（>SDK 默认 10MiB）→ onmessage 正常收到", async () => {
    const h = await harness();
    const big = "X".repeat(12 * 1024 * 1024);
    h.feed(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "xc_message", arguments: { to: "b", content: big } } }));
    expect(h.messages).toHaveLength(1);
    const message = h.messages[0] as { params?: { arguments?: { content?: string } } };
    expect(message.params?.arguments?.content?.length).toBe(12 * 1024 * 1024);
    expect(h.closed.value).toBe(false);
    expect(h.errors).toHaveLength(0);
    expect(h.stdout.lines).toHaveLength(0);
  });

  it("24MiB 帧（红队最高实测档）分两块到达也正常解析", async () => {
    const h = await harness();
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "xc_dispatch", arguments: { to: "b", title: "T", prompt: "P".repeat(24 * 1024 * 1024) } } })}\n`;
    const mid = Math.floor(frame.length / 2);
    h.stdin.write(Buffer.from(frame, "utf8").subarray(0, mid));
    h.stdin.write(Buffer.from(frame, "utf8").subarray(mid));
    expect(h.messages).toHaveLength(1);
    expect(h.closed.value).toBe(false);
  });
});

describe("transport/mcpstdio（CONC-2）: 超限帧显式拒收、server 存活", () => {
  it("超限单帧 → 恰一条 code=-32700 的 JSON-RPC 错误响应、不关传输", async () => {
    const h = await harness({ maxFrameBytes: 1024 }); // 小上限便于测试
    const oversized = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x", arguments: { content: "Y".repeat(4096) } } });
    h.feed(oversized);
    expect(h.closed.value).toBe(false);
    expect(h.errors).toHaveLength(1);
    expect(h.messages).toHaveLength(0);
    expect(h.stdout.lines).toHaveLength(1);
    const rejection = JSON.parse(h.stdout.lines[0]!) as { id: null; error: { code: number; message: string } };
    expect(rejection.id).toBeNull();
    expect(rejection.error.code).toBe(OVERSIZE_FRAME_RPC_CODE);
    expect(rejection.error.message).toContain("rejected");
  });

  it("拒收后同连接继续服务后续帧（红队第 4 步：退出后再调 → 传输超时；修复后必须可达）", async () => {
    const h = await harness({ maxFrameBytes: 1024 });
    h.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: { content: "Z".repeat(4096) } } }));
    expect(h.stdout.lines).toHaveLength(1); // 拒收响应
    h.feed(validRequest);
    expect(h.messages).toHaveLength(1);
    expect(h.closed.value).toBe(false);
  });

  it("超限帧跨多块到达：丢弃到行界为止，恰好一条拒收，其后帧正常", async () => {
    const h = await harness({ maxFrameBytes: 1024 });
    const oversized = `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { content: "W".repeat(8192) } })}\n`;
    const bytes = Buffer.from(oversized, "utf8");
    // 三块投递，模拟客户端分段写
    h.stdin.write(bytes.subarray(0, 1500));
    h.stdin.write(bytes.subarray(1500, 5000));
    h.stdin.write(bytes.subarray(5000));
    expect(h.errors).toHaveLength(1);
    expect(h.stdout.lines).toHaveLength(1);
    expect(h.closed.value).toBe(false);
    // 超限帧之后的合法帧在同一块里也必须被解析
    h.stdin.write(Buffer.from(`${validRequest}\n`, "utf8"));
    expect(h.messages).toHaveLength(1);
  });

  it("两个连续超限帧 → 恰两条拒收，传输仍存活", async () => {
    const h = await harness({ maxFrameBytes: 1024 });
    const oversizedBody = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { content: "V".repeat(4096) } });
    h.feed(oversizedBody);
    h.feed(oversizedBody);
    expect(h.stdout.lines).toHaveLength(2);
    expect(h.errors).toHaveLength(2);
    expect(h.closed.value).toBe(false);
    h.feed(validRequest);
    expect(h.messages).toHaveLength(1);
  });
});

describe("transport/mcpstdio（CONC-2）: 常规坏帧不杀传输（SDK 原语义回归锁定）", () => {
  it("JSON 解析失败的行 → onerror（processReadBuffer 内捕获），传输不关、后续帧正常", async () => {
    const h = await harness();
    h.feed("{not-json");
    expect(h.errors).toHaveLength(1);
    expect(h.closed.value).toBe(false);
    expect(h.stdout.lines).toHaveLength(0); // 与 SDK 原行为一致：坏 JSON 不产生响应帧
    h.feed(validRequest);
    expect(h.messages).toHaveLength(1);
  });
});
