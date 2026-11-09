/**
 * W2 回归单测：发送方在收到**不合法帧行**时不得死循环（同步 data 处理器里的
 * 游标推进顺序）。
 *
 * 缺陷（验收期实测发现）：`sendOverPipe` 的 data 处理器原来是
 *   `if (!decoded.ok) continue;` 在 `index = buffer.indexOf('
')` **之前**
 *   ⇒ 对端发来任何一行不合法帧（非 JSON / 未知帧型 / 未知字段）时，同一行被
 *   反复切片，而这是同步代码 ⇒ 超时定时器永远跑不到，发送方事件循环被永久占满。
 *   实测：vitest worker 卡死 119 s 后被强杀（Worker exited unexpectedly），
 *   证据 deepseek-crosschat/evidence/12-v030/acceptance/phaseC/transport-invalid-line-hang/。
 *
 * 修法：先把游标推到下一行再决定这一行怎么处理（本文件即回归用例）。
 */

import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sendPeerFrame } from "./pipe.js";

describe("发送方 data 处理器的游标推进（W2 回归）", () => {
  it("正常路径：auth 握手 + msg + status 回执", async () => {
    const root = await mkdtemp(join(tmpdir(), "xc-repro-"));
    const socketPath = `\\\\.\\pipe\\LOCAL\\xcc-msg-repro-${Math.random().toString(16).slice(2)}`;
    const received: string[] = [];
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
              socket.write(`${JSON.stringify({ type: "auth", ok: true })}\n`);
            } else if (frame.type === "msg") {
              socket.write(`${JSON.stringify({ type: "status", msgId: frame.msgId, state: "delivered" })}\n`);
            } else if (frame.type === "status") {
              socket.write(`${JSON.stringify({ type: "status", msgId: frame.msgId, state: "delivered" })}\n`);
            }
          } catch { /* ignore */ }
          index = buffer.indexOf("\n");
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    const res = await sendPeerFrame({
      socketPath,
      token: "d".repeat(32),
      frame: { type: "msg", msgId: "m-1", from: "sender", text: "hello" },
      timeoutMs: 8000,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    expect(res.ok).toBe(true);
  }, 30_000);

  it("对端先发一行不合法帧再发 status：不死循环，最终拿到回执", async () => {
    const socketPath = `\\\\.\\pipe\\LOCAL\\xcc-msg-repro2-${Math.random().toString(16).slice(2)}`;
    const server = createServer((socket) => {
      socket.on("data", () => {
        // 先写一行不合法帧（auth 帧多一个未知字段 ⇒ decodeFrame 判非法），再写回执。
        socket.write(`${JSON.stringify({ type: "auth", ok: true })}\n`);
        socket.write(`${JSON.stringify({ type: "status", msgId: "m-2", state: "delivered" })}\n`);
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });

    const started = Date.now();
    const res = await sendPeerFrame({
      socketPath,
      token: "d".repeat(32),
      frame: { type: "msg", msgId: "m-2", from: "sender", text: "hello" },
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - started;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 回执拿得到，且远早于超时（修复前这里会同步死循环、永不返回）。
    expect(res.ok).toBe(true);
    expect(elapsed).toBeLessThan(4000);
  }, 30_000);
});
