/**
 * v0.9.6 r2（V096-12）：SessionStart 钩子**会话↔server 进程绑定锚**定向测试。
 *
 * 机制：开启档票据消费成功后，枚举宿主进程的直接子进程里本插件的 MCP server
 * （cmdline 匹配 <pluginRoot>/dist/mcp/server.mjs），把「本会话 ↔ 该 server 进程
 * pid」写成绑定锚（registry/adopt-anchor/<serverPid>.json）——MCP 连接的 ppid 采纳
 * 护栏 6 据此获得「我就是这个会话」的自证通道（零痕迹会话无法借他人记录冒名，
 * 回二 V096-12）。
 *
 * 判据（写锚纪律，hooks/session-start.ts writeAdoptAnchorsForHostServers）：
 * 1. 恰一个本插件 server 子进程 → 写锚（字段：sessionId/hostPid/serverPid/ts）+
 *    adopt-anchor-written 审计；
 * 2. 零个（枚举失败/server 未起/启动序未到，轮询兜底后仍空）→ 不写 + adopt-anchor-
 *    skipped{reason:no-server-child}；
 * 3. 多个（一个宿主挂多条本插件 server 连接，无法归属）→ 不写 + reason:
 *    ambiguous-server-children；
 * 4. hostPid 缺失（钩子父进程 pid 非法）→ 不写 + reason:no-host-pid；
 * 5. 枚举抛错 → 吞掉不抛（钩子永不失败），无锚落盘；
 * 6. 轮询早退：首拍未命中、次拍命中 → 立即写（不等满轮询窗）；
 * 7. 枚举判据按插件根路径限定（宿主同时携带其他插件的 server.mjs——实测形态），
 *    cmdline 大小写/路径分隔符归一化后匹配。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// session-start.js 模块加载即自启钩子（guarded）；其 readStdinPayload 会阻塞读 stdin
//（vitest 下永不闭合）——与 session-start-v094-a6.test.ts 同款：先 mock stdin/上下文
// 面再导入，模块自启取不到 sessionId 即静默返回。本文件被测函数不经过这些 mock 面。
vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    readStdinPayload: vi.fn(() => undefined),
    resolveHookContext: vi.fn(() => ({ workspace: "", stateRoot: "", sessionId: undefined, event: "SessionStart" })),
    emitAdditionalContext: vi.fn(),
    logHookEvent: vi.fn(async () => {}),
    auditHookFailure: vi.fn(async () => {}),
    peerRootFromEnv: vi.fn(() => ""),
    readHookPermissionMode: vi.fn(() => undefined),
  };
});

import { adoptAnchorFile, readAdoptAnchorSync } from "../core/registry.js";
import { listPluginServerChildPids, writeAdoptAnchorsForHostServers } from "./session-start.js";

const dirs: string[] = [];

function freshStateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "xc-a1-v096r2-hook-"));
  dirs.push(root);
  return root;
}

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

function readEngineEvents(stateRoot: string): Array<Record<string, unknown>> {
  const file = join(stateRoot, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("v0.9.6 r2：writeAdoptAnchorsForHostServers（写锚纪律）", () => {
  it("恰一个本插件 server 子进程 → 写锚（字段正确）+ adopt-anchor-written 审计", async () => {
    const stateRoot = freshStateRoot();
    const now = Date.now();
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: 4242,
      now,
      hostProbe: { available: true, resumeSid: "sess_woken" },
      lister: () => [777],
      pollScheduleMs: [0],
    });
    const anchor = readAdoptAnchorSync(stateRoot, 777);
    expect(anchor).toBeDefined();
    expect(anchor!.sessionId).toBe("sess_woken");
    expect(anchor!.hostPid).toBe(4242);
    expect(anchor!.serverPid).toBe(777);
    expect(anchor!.ts).toBe(now);
    const events = readEngineEvents(stateRoot).filter((e) => e["event"] === "adopt-anchor-written");
    expect(events).toHaveLength(1);
    expect(events[0]!["serverPid"]).toBe(777);
  });

  it("零个 server 子进程（轮询后仍空）→ 不写锚 + adopt-anchor-skipped{no-server-child}", async () => {
    const stateRoot = freshStateRoot();
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: 4242,
      now: Date.now(),
      hostProbe: { available: true, resumeSid: "sess_woken" },
      lister: () => [],
      pollScheduleMs: [0],
    });
    expect(existsSync(adoptAnchorFile(stateRoot, 777))).toBe(false);
    const skips = readEngineEvents(stateRoot).filter((e) => e["event"] === "adopt-anchor-skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0]!["reason"]).toBe("no-server-child");
  });

  it("多个本插件 server 子进程 → 不写锚（无法归属）+ reason:ambiguous-server-children", async () => {
    const stateRoot = freshStateRoot();
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: 4242,
      now: Date.now(),
      hostProbe: { available: true, resumeSid: "sess_woken" },
      lister: () => [777, 888],
      pollScheduleMs: [0],
    });
    expect(existsSync(adoptAnchorFile(stateRoot, 777))).toBe(false);
    expect(existsSync(adoptAnchorFile(stateRoot, 888))).toBe(false);
    const skips = readEngineEvents(stateRoot).filter((e) => e["event"] === "adopt-anchor-skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0]!["reason"]).toBe("ambiguous-server-children");
    expect(skips[0]!["count"]).toBe(2);
  });

  it("hostPid 缺失（钩子父进程 pid 非法）→ 不写锚 + reason:no-host-pid", async () => {
    const stateRoot = freshStateRoot();
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: undefined,
      now: Date.now(),
      lister: () => [777],
      pollScheduleMs: [0],
    });
    expect(existsSync(adoptAnchorFile(stateRoot, 777))).toBe(false);
    const skips = readEngineEvents(stateRoot).filter((e) => e["event"] === "adopt-anchor-skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0]!["reason"]).toBe("no-host-pid");
  });

  it("枚举抛错 → 吞掉不抛（钩子永不失败）、无锚落盘", async () => {
    const stateRoot = freshStateRoot();
    await expect(
      writeAdoptAnchorsForHostServers({
        stateRoot,
        sessionId: "sess_woken",
        hostPid: 4242,
        now: Date.now(),
        lister: () => {
          throw new Error("cim exploded");
        },
        pollScheduleMs: [0],
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(join(stateRoot, "registry", "adopt-anchor"))).toBe(false);
  });

  it("轮询早退：首拍未命中、次拍命中 → 立即写锚（不等满轮询窗）", async () => {
    const stateRoot = freshStateRoot();
    const calls: number[] = [];
    const start = Date.now();
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: 4242,
      now: Date.now(),
      hostProbe: { available: true, resumeSid: "sess_woken" },
      lister: (pid) => {
        calls.push(pid);
        return calls.length >= 2 ? [777] : [];
      },
      // 生产轮询拍点（首拍 0ms 未命中 → 800ms 后次拍命中即写）
    });
    const elapsed = Date.now() - start;
    expect(calls).toEqual([4242, 4242]);
    expect(readAdoptAnchorSync(stateRoot, 777)).toBeDefined();
    expect(elapsed).toBeLessThan(1500); // 次拍命中即写，未走满 [0,800,1600]
  });
});

describe("v0.9.6 r2：listPluginServerChildPids（插件根路径限定的枚举判据）", () => {
  const PLUGIN_ROOT = "C:\\Users\\x\\.zcode\\cli\\plugins\\cache\\dev-zcode-crosschat\\zcode-crosschat\\0.9.6";

  it("只匹配本插件的 server.mjs：其他插件的 server.mjs / 非 node 进程 / probe-server 都不匹配", () => {
    const rows = [
      { pid: 101, commandLine: `node ${PLUGIN_ROOT}\\dist\\mcp\\server.mjs` }, // 本插件 ✓
      { pid: 102, commandLine: "node C:\\cache\\other-plugin\\0.1\\dist\\mcp\\server.mjs" }, // 别插件同名文件 ✗
      { pid: 103, commandLine: "python C:\\cache\\usage_mcp.py" }, // 非 server.mjs ✗
      { pid: 104, commandLine: `node ${PLUGIN_ROOT}\\dist\\probe-server.mjs` }, // 非 mcp/server.mjs ✗
      { pid: 105, commandLine: `node ${PLUGIN_ROOT}/dist/mcp/server.mjs --mode x` }, // 正斜杠同形 ✓
    ];
    const pids = listPluginServerChildPids(4242, { pluginRoot: PLUGIN_ROOT, enumerate: () => rows });
    expect(pids.sort()).toEqual([101, 105]);
  });

  it("cmdline 大小写/反斜杠归一化后匹配（Windows 路径语义）", () => {
    const rows = [
      { pid: 201, commandLine: `NODE ${PLUGIN_ROOT.toUpperCase()}\\DIST\\MCP\\SERVER.MJS` },
    ];
    const pids = listPluginServerChildPids(4242, { pluginRoot: PLUGIN_ROOT, enumerate: () => rows });
    expect(pids).toEqual([201]);
  });

  it("宿主 pid 非法 / 枚举空 → 返回空数组（fail-closed 无锚）", () => {
    expect(listPluginServerChildPids(0, { pluginRoot: PLUGIN_ROOT, enumerate: () => [{ pid: 1, commandLine: `node ${PLUGIN_ROOT}\\dist\\mcp\\server.mjs` }] })).toEqual([]);
    expect(listPluginServerChildPids(4242, { pluginRoot: PLUGIN_ROOT, enumerate: () => [] })).toEqual([]);
  });
});

describe("v0.9.6 r3（V096-21）：宿主唤醒子归属闸——锚只在本会话唤醒子拓扑写", () => {
  it("宿主是本会话唤醒子（--resume <本 sid>）+ 唯一子进程 → 写锚（回归 r3 正例）", async () => {
    const stateRoot = freshStateRoot();
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: 4242,
      now: Date.now(),
      hostProbe: { available: true, resumeSid: "sess_woken" },
      lister: () => [777],
      pollScheduleMs: [0],
    });
    expect(readAdoptAnchorSync(stateRoot, 777)).toBeDefined();
  });

  it("宿主非 --resume（桌面 app-server 多会话宿主）→ 不写锚 + reason:host-not-wake-resume（V096-21 主形态）", async () => {
    const stateRoot = freshStateRoot();
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: 4242,
      now: Date.now(),
      hostProbe: { available: true }, // 无 resume token
      lister: () => [777],
      pollScheduleMs: [0],
    });
    expect(existsSync(adoptAnchorFile(stateRoot, 777))).toBe(false);
    const skips = readEngineEvents(stateRoot).filter((e) => e["event"] === "adopt-anchor-skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0]!["reason"]).toBe("host-not-wake-resume");
  });

  it("宿主是别会话的唤醒子（--resume <别的 sid>）→ 不写锚 + reason:host-resume-sid-mismatch（跨会话误绑关闭）", async () => {
    const stateRoot = freshStateRoot();
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: 4242,
      now: Date.now(),
      hostProbe: { available: true, resumeSid: "sess_other" },
      lister: () => [777],
      pollScheduleMs: [0],
    });
    expect(existsSync(adoptAnchorFile(stateRoot, 777))).toBe(false);
    const skips = readEngineEvents(stateRoot).filter((e) => e["event"] === "adopt-anchor-skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0]!["reason"]).toBe("host-resume-sid-mismatch");
    expect(skips[0]!["resumeSid"]).toBe("sess_other");
  });

  it("宿主 cmdline 不可读（枚举失败）→ 不写锚 + reason:host-cmdline-unavailable（fail-closed）", async () => {
    const stateRoot = freshStateRoot();
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: 4242,
      now: Date.now(),
      hostProbe: { available: false },
      lister: () => [777],
      pollScheduleMs: [0],
    });
    expect(existsSync(adoptAnchorFile(stateRoot, 777))).toBe(false);
    const skips = readEngineEvents(stateRoot).filter((e) => e["event"] === "adopt-anchor-skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0]!["reason"]).toBe("host-cmdline-unavailable");
  });

  it("归属闸先于子进程枚举：宿主不符时不枚举（lister 一次都不调用）", async () => {
    const stateRoot = freshStateRoot();
    let listerCalls = 0;
    await writeAdoptAnchorsForHostServers({
      stateRoot,
      sessionId: "sess_woken",
      hostPid: 4242,
      now: Date.now(),
      hostProbe: { available: true, resumeSid: "sess_other" },
      lister: () => {
        listerCalls++;
        return [777];
      },
      pollScheduleMs: [0, 1],
    });
    expect(listerCalls).toBe(0);
  });
});
