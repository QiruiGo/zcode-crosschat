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
 * v0.7.1（红队四番战 边界-5 修复）：畸形帧**同样**显式拒收。
 * 红队实测（`b5c.mjs`，v0.6.0/v0.7.0 均复现）：裸控制字节入 JSON 字符串（NUL/TAB）、
 * 裸 `NaN` 字面量、截断/坏 JSON → 回执 **0 字节**（SDK `processReadBuffer` 的
 * 内层 catch 只调 `onerror`，不回任何帧），而 34MiB 超大帧却有明确的 -32700
 * ——同一条连接上「读不动的大帧有回执、读不懂的坏帧没回执」，不对称：客户端只能
 * 靠超时发现坏帧被吃，且分不清「server 死了」与「这一帧不合法」。修复 = 覆写
 * `processReadBuffer`：readMessage（JSON.parse + 帧型 schema 校验）抛错时发一条
 * -32700 错误响应（尽力从该行取回请求 id，取不到按规范用 null），传输不关、后续
 * 帧继续服务；`onmessage`（协议层）抛错仍走 SDK 原语义（Protocol 自己会回错误帧，
 * 不再由传输层重复回一条）。
 *
 * 纪律：只动传输层的帧边界行为；协议消息处理与 stdout 写路径原样沿用 SDK 实现。
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

/**
 * v0.7.1（边界-5）：畸形帧拒收响应与超大帧**同一个错误码**（-32700，JSON-RPC
 * 2.0 的 Parse error）——客户端对「读不懂的帧」与「读不动的大帧」看到同一种
 * 显式失败，不再一个静默丢弃一个有回执。常量名保留 OVERSIZE_FRAME_RPC_CODE
 * （v0.5.1 起的对外名，测试与文档已引用），语义扩为「传输层帧级拒绝」。
 */
export const MALFORMED_FRAME_RPC_CODE = OVERSIZE_FRAME_RPC_CODE;

/** SDK 私有面（d.ts 未导出；1.32.2 实现如上）。 */
interface SdkStdioInternals {
  _readBuffer: {
    append(chunk: Buffer): void;
    clear(): void;
    readMessage(): unknown;
    /** SDK ReadBuffer 的内部累积缓冲（本文件只读窥视，取回失败帧的请求 id）。 */
    _buffer?: Buffer;
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
        this.drainReadBuffer();
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

  /**
   * v0.7.1（边界-5）：帧解析层覆写——**畸形帧显式拒收**，与超大帧对称。
   *
   * SDK 的 `processReadBuffer` 把 `readMessage()` 与 `onmessage()` 放在同一个 try
   * 里：两者抛错都只调 `onerror` 然后继续循环，于是「行读全了但读不懂」
   * （JSON.parse 失败 / 帧型不符 schema）时客户端**一个字节都收不到**（红队
   * b5c：NUL/TAB 入字符串、裸 NaN、坏 JSON 全部 0 字节回执），而读不动的大帧却有
   * -32700。SDK 那个方法是 private，且只有被本类覆写的 `_ondata` 会调它——故此处
   * 不复写同名成员（TS 不允许放宽基类私有成员的可见性），而是给喂帧路径换用本方法，
   * 行为等价且不碰 SDK 语义：
   * - `readMessage()` 抛错（帧级损坏）→ 显式 -32700 响应 + `onerror` + 继续。
   *   该行已被 readMessage 消费掉（先 subarray 再 parse），不会死循环。
   * - `onmessage()` 抛错（协议层）→ 维持 SDK 原语义（只 `onerror`）：Protocol
   *   自己会给请求回错误帧，传输层再回一条会变成重复响应。
   */
  private drainReadBuffer(): void {
    const internals = this as unknown as SdkStdioInternals;
    for (;;) {
      const line = this.peekPendingLine();
      let message: unknown;
      try {
        message = internals._readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        this.sendMalformedRejection(line);
        continue;
      }
      if (message === null) return;
      try {
        this.onmessage?.(message as Parameters<NonNullable<typeof this.onmessage>>[0]);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * 窥视缓冲里**待解析的那一行**（未含行界则 undefined）——只为在拒收响应里尽力
   * 取回请求 id。只读，不改 SDK 缓冲状态。
   */
  private peekPendingLine(): string | undefined {
    const internals = this as unknown as SdkStdioInternals;
    const buffer = internals._readBuffer._buffer;
    if (buffer === undefined || buffer.length === 0) return undefined;
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) return undefined;
    return buffer.toString("utf8", 0, newline).replace(/\r$/, "");
  }

  /** 丢弃当前超限帧的残余字节；行界之后的数据恢复正常解析。 */
  private resumeAfterOversize(chunk: Buffer): void {
    const newline = chunk.indexOf(0x0a);
    if (newline === -1) return; // 仍在同一超限帧内：继续丢
    this.discardingUntilNewline = false;
    const rest = chunk.subarray(newline + 1);
    if (rest.length > 0) this.feedChunk(rest);
  }

  /**
   * 尽力从坏行里取回请求 id（JSON-RPC 2.0：Parse error 的 id 取不到时必须为 null；
   * 取得到就用它——坏行的 id 段常常还是完好的，客户端按 id 配对才能立刻失败，
   * 而不是等一个永远不来的响应）。只认数字与字符串两种 id 形状。
   */
  private requestIdOf(line: string | undefined): string | number | null {
    if (line === undefined) return null;
    const match = /"id"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?))/.exec(line);
    if (match === null) return null;
    return match[1] !== undefined ? match[1] : Number(match[2]);
  }

  private sendMalformedRejection(line: string | undefined): void {
    const id = this.requestIdOf(line);
    const rejection = {
      jsonrpc: "2.0" as const,
      // SDK 的 RequestIdSchema 类型面不含 null（send 不校验），故此处收窄断言。
      id: id as unknown as string | number,
      error: {
        code: MALFORMED_FRAME_RPC_CODE,
        message:
          "request frame could not be parsed as a JSON-RPC message (malformed JSON or invalid frame " +
          "shape) and was rejected; the server keeps running — fix the frame and resend it",
      },
    };
    void this.send(rejection).catch(() => {
      /* 拒收响应写失败不追加处置：连接层错误由后续读写自然暴露 */
    });
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
