/**
 * CONC-2 修复（v0.5.1）：MCP stdio 大帧守卫——超限帧**显式拒收**而非杀进程。
 *
 * 根因（红队 并发与-2 / 裁决 #7 confirmed，P1）：MCP SDK（@modelcontextprotocol/sdk
 * 1.32.2）的 StdioServerTransport 用 ReadBuffer 累积 stdin（默认 maxBufferSize
 * 10MiB）；单帧超限时 `append()` 抛错，SDK `_ondata` 的 catch 会**关闭传输**
 * （`this.close()`）→ 触发 server.ts 的 `transport.onclose` → 优雅关闭
 * `process.exit(0)`——表现为「exit code 0、无 stderr、无响应帧、载荷丢弃、连接断开」。
 *
 * 修复（白盒，与 README「队内 xc_message 无此闸」承诺对齐）：
 * 1. **上限提到 32MiB**（`MCP_MAX_FRAME_BYTES`）——覆盖红队实测的全部档位
 *    （9/10/11/12/13/14/15/16/24MiB 均应正常入队）；JSON.parse/zod 对该量级
 *    字符串的代价可接受（数百毫秒级）。
 * 2. **溢出改为拒收**：子类覆写 `_ondata`——ReadBuffer 溢出时不再走 SDK 的
 *    close 路径，而是：丢弃当前帧（到下一个 `\n` 为止）、发一条 JSON-RPC 错误
 *    响应（code=-32700，id=null——帧读不全无法取回请求 id）、继续服务后续帧。
 *    server 进程**永不**因大帧退出。
 *
 * 纪律：只动传输层的帧边界行为；协议消息处理（processReadBuffer → onmessage）
 * 与 stdout 写路径原样沿用 SDK 实现。
 *
 * @module transport/mcpstdio
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * MCP stdio 单帧上限（字节）。SDK 默认 10MiB（`STDIO_DEFAULT_MAX_BUFFER_SIZE`），
 * v0.5.1 提到 32MiB：README 对队内 `xc_message`/`xc_dispatch` 承诺「无此闸」，
 * 红队实测档位最高 24MiB；超过 32MiB 的单帧走显式拒收（不杀进程）。
 * README 已知限制 6 与本常量同步。
 */
export const MCP_MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** 溢出拒收响应的 JSON-RPC 错误码（Parse error——帧读不全无法解析）。 */
export const OVERSIZE_FRAME_RPC_CODE = -32700;

/** SDK 私有面（d.ts 未导出；1.32.2 实现如上）。 */
interface SdkStdioInternals {
  _readBuffer: {
    append(chunk: Buffer): void;
    clear(): void;
    readMessage(): unknown;
  };
  processReadBuffer(): void;
}

export interface GuardedStdioOptions {
  /** 单帧上限（字节）；缺省 {@link MCP_MAX_FRAME_BYTES}。 */
  maxFrameBytes?: number;
}

/**
 * 带大帧守卫的 stdio 传输：
 * - 构造时把 SDK ReadBuffer 的 maxBufferSize 提到 `maxFrameBytes`（缺省 32MiB）；
 * - 覆写 `_ondata`：溢出异常不再触发 `close()`（SDK 原行为=杀连接→杀进程），
 *   改为「丢帧 + 显式 JSON-RPC 错误响应 + 继续读后续帧」。
 */
export class GuardedStdioTransport extends StdioServerTransport {
  /** 溢出后处于「丢弃到下一行界」状态：跳过残余字节直到 `\n`，之后恢复正常解析。 */
  private discardingUntilNewline = false;

  private readonly maxFrameBytes: number;

  constructor(
    stdin?: import("node:stream").Readable,
    stdout?: import("node:stream").Writable,
    options?: GuardedStdioOptions,
  ) {
    const maxFrameBytes = options?.maxFrameBytes ?? MCP_MAX_FRAME_BYTES;
    super(stdin, stdout, { maxBufferSize: maxFrameBytes });
    this.maxFrameBytes = maxFrameBytes;
    // d.ts 中 _ondata 是 public 成员（箭头函数属性），构造期覆写安全：
    // start() 之后 SDK 以 `this._stdin.on("data", this._ondata)` 注册的就是本覆写。
    this._ondata = (chunk: Buffer): void => {
      if (this.discardingUntilNewline) {
        this.resumeAfterOversize(chunk);
        return;
      }
      this.feedChunk(chunk);
    };
  }

  /** 正常喂帧；溢出时逐段恢复（同一 chunk 内可能还有完整合法帧）。 */
  private feedChunk(chunk: Buffer): void {
    const internals = this as unknown as SdkStdioInternals;
    let data = chunk;
    for (;;) {
      try {
        internals._readBuffer.append(data);
        internals.processReadBuffer();
        return;
      } catch (error) {
        // ReadBuffer 溢出（append 已先 clear 再抛）：挂起中的那一行超限。
        // 拒收（显式错误响应）、丢弃该行，但**不关传输、不杀进程**。
        internals._readBuffer.clear();
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        this.sendOversizeRejection();
        // 触发溢出的 chunk 里可能已带着行界（甚至后续完整帧）：扫本块。
        const newline = data.indexOf(0x0a);
        if (newline === -1) {
          this.discardingUntilNewline = true; // 超限行还有残余字节没到
          return;
        }
        data = data.subarray(newline + 1);
        if (data.length === 0) return;
        // 剩余数据可能含合法帧（正常解析）或又一个超限帧（循环再拒收一次）。
      }
    }
  }

  /** 丢弃当前超限帧的残余字节；行界之后的数据恢复正常解析。 */
  private resumeAfterOversize(chunk: Buffer): void {
    const newline = chunk.indexOf(0x0a);
    if (newline === -1) return; // 仍在同一超限帧内：继续丢
    this.discardingUntilNewline = false;
    const rest = chunk.subarray(newline + 1);
    if (rest.length > 0) this.feedChunk(rest);
  }

  private sendOversizeRejection(): void {
    // JSON-RPC 2.0 规范：请求 id 无法确定（读不全帧）时错误响应 id 必须为 null。
    // SDK 的 RequestIdSchema 类型面不含 null（send 不校验），故此处收窄断言。
    const rejection = {
      jsonrpc: "2.0" as const,
      id: null as unknown as string | number,
      error: {
        code: OVERSIZE_FRAME_RPC_CODE,
        message:
          `request frame exceeded the ${this.maxFrameBytes}-byte stdio transport limit `
          + "and was rejected; split the payload into smaller messages (the server keeps running)",
      },
    };
    void this.send(rejection).catch(() => {
      /* 拒收响应写失败不追加处置：连接层错误由后续读写自然暴露 */
    });
  }
}
