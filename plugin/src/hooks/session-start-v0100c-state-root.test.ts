/**
 * v0.10.0（组 C / C1+C2，R1 / G-27）定向测试：**SessionStart 的状态根归并 + 漂移审计**。
 *
 * 验收口径（R1 原文）：同一会话分别以
 * cwd=项目根、cwd=任意深度子目录、cwd=`.crosschat` 三种方式启动，状态根均解析到
 * 同一主根；不再产生嵌套 `.crosschat\.crosschat`；漂移场景下 engine.jsonl 出现
 * 根漂移告警事件。
 *
 * 本文件覆盖：
 * 1.【验收】三种启动方式（env ZCODE_PROJECT_DIR = 项目根 / 任意深度子目录 /
 *   `.crosschat` 本身；stdin cwd 通道同款）→ 状态根全部归并到同一主根，且子目录里
 *   **不产生**幻影根（`<sub>/.crosschat` 不存在，`.crosschat/.crosschat` 不存在）；
 * 2.【验收】同一 sessionId 反复以不同 cwd 启动 → 会话记录始终写在主根一份；
 * 3. 归并发生时落 `state-root-resolved{root, via}`（via=ancestor / inside-root）；
 * 4. 正常路径（cwd=项目根、根就在脚下）**零新增日志**（无 state-root-resolved）；
 * 5. 漂移：会话记录里的 cwd 指向另一个既存根（幻影根形态）→ 落
 *   `state-root-drift{registered, resolved}`；
 * 6. 无漂移：记录 cwd 与本回合解析同根（含「记录 cwd 是主根下无自有根的子目录」）
 *   → 无 drift 事件；
 * 7. 漂移审计只读：会话记录 cwd 不被审计改写（refreshSessionLastSeen 既有口径），
 *    漂移持续期间每次 SessionStart 复读，幻影根被清除后自愈停止。
 *
 * 依赖隔离：shared.js 的 stdin/发射面 mock（session-start-v094-a6.test.ts 同款），
 * resolveHookContext / auditStateRootResolution 走**真实现**（正是被测面）；
 * registry/teamstate/peerdir/lock/log 全真跑临时 stateRoot 与临时 peer 根
 * （XC_MESSAGING_DIR / ZCODE_PLUGIN_DATA 双钉，绝不写真实 ~/.zcode 或 D:\tools）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  peerRoot: "",
  projectRoot: "",
  /** 本回合的工作区（env 通道写进 ZCODE_PROJECT_DIR，stdin 通道走载荷 cwd）。 */
  workspace: "",
  /** true = 经 env 传工作区；false = 经 stdin cwd 传（env 两个键都删掉）。 */
  useEnv: true,
  sessionId: undefined as string | undefined,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    readStdinPayload: vi.fn(() => ({
      raw: {},
      str: (keySnake: string, keyCamel: string) => {
        if (keySnake === "cwd" || keyCamel === "cwd") return h.useEnv ? undefined : h.workspace;
        if (keySnake === "session_id" || keyCamel === "sessionId") return h.sessionId;
        return undefined;
      },
    })),
    emitAdditionalContext: vi.fn(),
  };
});

/**
 * session-start.ts 模块加载即自启一次钩子（文件尾部 `void runSessionStartHookGuarded()`）。
 * 本测试进程继承了宿主真实 env（ZCODE_PROJECT_DIR=D:\tools、CLAUDE_SESSION_ID=…），
 * 若不让自启跑先变成 no-op，它会往**真实协作根**写会话记录。中和手段：模块作用域先删掉
 * 这两个键、h.sessionId 保持 undefined（钩子无 sid 即静默返回），再一次性 import
 * （后续 runHook() 复用同一模块实例，自启跑只发生一次且零写盘）。
 */
delete process.env["ZCODE_PROJECT_DIR"];
delete process.env["CLAUDE_PROJECT_DIR"];
delete process.env["CLAUDE_SESSION_ID"];
const hookModule = await import("./session-start.js");

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 造主根 <base>/.crosschat/{registry,teams,logs}（= 既有协作根的判定标记）。 */
function makeStateRoot(base: string): string {
  const root = join(base, ".crosschat");
  mkdirSync(join(root, "registry", "sessions"), { recursive: true });
  mkdirSync(join(root, "teams", "default"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  return root;
}

/** 本回合经 env 通道传工作区（默认通道，优先级最高）。 */
function useEnvWorkspace(dir: string): void {
  h.workspace = dir;
  h.useEnv = true;
  process.env["ZCODE_PROJECT_DIR"] = dir;
}

/** 本回合经 stdin cwd 通道传工作区（env 两键删掉）。 */
function useStdinWorkspace(dir: string): void {
  h.workspace = dir;
  h.useEnv = false;
  delete process.env["ZCODE_PROJECT_DIR"];
  delete process.env["CLAUDE_PROJECT_DIR"];
}

function readEngineEvents(root: string): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

function eventsNamed(root: string, name: string): Array<Record<string, unknown>> {
  return readEngineEvents(root).filter((event) => event["event"] === name);
}

/** 当前测试会话 id（beforeEach 必填；undefined 只出现在模块自启跑的中和窗）。 */
function sid(): string {
  if (h.sessionId === undefined) throw new Error("test session id not set");
  return h.sessionId;
}

function sessionRecord(root: string): Record<string, unknown> | undefined {
  const file = join(root, "registry", "sessions", `${sid()}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  h.peerRoot = tempDir("xc-c1c-peers-");
  h.projectRoot = tempDir("xc-c1c-proj-");
  h.sessionId = "sess_c1_v0100c";
  h.useEnv = true;
  h.workspace = h.projectRoot;
  process.env["XC_MESSAGING_DIR"] = h.peerRoot;
  process.env["ZCODE_PLUGIN_DATA"] = h.peerRoot; // 双钉：peer 根只落临时目录
  delete process.env["ZCODE_PROJECT_DIR"];
  delete process.env["CLAUDE_PROJECT_DIR"];
  delete process.env["CLAUDE_SESSION_ID"];
  delete process.env["XC_ADOPT_BY_PPID"];
});

afterAll(() => {
  delete process.env["XC_MESSAGING_DIR"];
  delete process.env["ZCODE_PLUGIN_DATA"];
  delete process.env["ZCODE_PROJECT_DIR"];
  delete process.env["CLAUDE_PROJECT_DIR"];
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

async function runHook(): Promise<void> {
  await hookModule.runSessionStartHook();
}

describe("v0.10.0 组 C（C1/R1）：三种启动方式归并到同一主根，不产生嵌套根", () => {
  it("1a. cwd = 项目根（根就在脚下）→ 主根，正常路径零审计", async () => {
    const main = makeStateRoot(h.projectRoot);
    useEnvWorkspace(h.projectRoot);

    await runHook();

    expect(sessionRecord(main)).toBeDefined();
    expect(sessionRecord(main)!["sessionId"]).toBe(h.sessionId);
    // 正常路径：无 state-root-resolved / state-root-drift
    expect(eventsNamed(main, "state-root-resolved")).toHaveLength(0);
    expect(eventsNamed(main, "state-root-drift")).toHaveLength(0);
    // 钩子其余功能不减：hook-session-start 照旧落盘
    expect(eventsNamed(main, "hook-session-start").length).toBeGreaterThanOrEqual(1);
  });

  it("1b. cwd = 任意深度子目录 → 归并主根 + state-root-resolved(ancestor)", async () => {
    const main = makeStateRoot(h.projectRoot);
    const deep = join(h.projectRoot, "work", "e364-yf2451-forensics-1125", "batch");
    mkdirSync(deep, { recursive: true });
    useEnvWorkspace(deep);

    await runHook();

    // 会话记录落在主根，而不是子目录里新起的根
    expect(sessionRecord(main)).toBeDefined();
    expect(existsSync(join(deep, ".crosschat"))).toBe(false);
    expect(existsSync(join(h.projectRoot, "work", ".crosschat"))).toBe(false);
    const resolved = eventsNamed(main, "state-root-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!["via"]).toBe("ancestor");
    expect(resolved[0]!["root"]).toBe(main);
    expect(eventsNamed(main, "state-root-drift")).toHaveLength(0);
  });

  it("1c. cwd = .crosschat 本身（G-27 实证形态）→ 主根，不产生 .crosschat\\.crosschat", async () => {
    const main = makeStateRoot(h.projectRoot);
    useEnvWorkspace(main);

    await runHook();

    expect(sessionRecord(main)).toBeDefined();
    expect(existsSync(join(main, ".crosschat"))).toBe(false); // 绝不嵌套
    const resolved = eventsNamed(main, "state-root-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!["via"]).toBe("inside-root");
    expect(resolved[0]!["root"]).toBe(main);
  });

  it("1d. cwd = .crosschat/logs 子目录 → 同样归并主根（inside-root 归一）", async () => {
    const main = makeStateRoot(h.projectRoot);
    const logs = join(main, "logs");
    useEnvWorkspace(logs);

    await runHook();

    expect(sessionRecord(main)).toBeDefined();
    expect(existsSync(join(logs, ".crosschat"))).toBe(false);
    const resolved = eventsNamed(main, "state-root-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!["via"]).toBe("inside-root");
    expect(resolved[0]!["root"]).toBe(main);
  });

  it("1e. stdin cwd 通道（无 env）→ 同一归并规则（env 缺省时优先级不变）", async () => {
    const main = makeStateRoot(h.projectRoot);
    const deep = join(h.projectRoot, "sub", "deeper");
    mkdirSync(deep, { recursive: true });
    useStdinWorkspace(deep);

    await runHook();

    expect(sessionRecord(main)).toBeDefined();
    expect(existsSync(join(deep, ".crosschat"))).toBe(false);
    const resolved = eventsNamed(main, "state-root-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!["via"]).toBe("ancestor");
    expect(resolved[0]!["root"]).toBe(main);
  });

  it("2. 同一 sid 反复以不同 cwd 启动 → 主根里始终一份会话记录（无第二根）", async () => {
    const main = makeStateRoot(h.projectRoot);
    const deep = join(h.projectRoot, "a", "b");
    mkdirSync(deep, { recursive: true });

    useEnvWorkspace(h.projectRoot);
    await runHook();
    useEnvWorkspace(deep);
    await runHook();
    useEnvWorkspace(main);
    await runHook();

    expect(sessionRecord(main)).toBeDefined();
    expect(existsSync(join(deep, ".crosschat"))).toBe(false);
    expect(existsSync(join(main, ".crosschat"))).toBe(false);
    expect(existsSync(join(h.projectRoot, "a", ".crosschat"))).toBe(false);
    // 全工作区只有主根本身一个 .crosschat：三种启动方式的根逐字节相同
    expect(readEngineEvents(main).length).toBeGreaterThan(0);
    // 第 2/3 次归并各留一条 resolved 审计（可观测），无 drift（始终同根）
    expect(eventsNamed(main, "state-root-resolved")).toHaveLength(2);
    expect(eventsNamed(main, "state-root-drift")).toHaveLength(0);
  });
});

describe("v0.10.0 组 C（C2/R1）：根漂移审计", () => {
  it("3. 记录 cwd 指向另一个既存根（幻影根形态）→ state-root-drift{registered,resolved}", async () => {
    const main = makeStateRoot(h.projectRoot);
    // 幻影根：子目录里曾另起过一个根（G-27 实证形态），会话记录曾注册在那里
    const phantomBase = join(h.projectRoot, "work", "e364-yf2451-forensics-1125");
    const phantom = makeStateRoot(phantomBase);
    // 在主根预置一条「上一回合注册在幻影根」的会话记录
    const { writeSession } = await import("../core/registry.js");
    await writeSession(main, { sessionId: sid(), cwd: phantomBase, startedAt: 1, lastSeen: 1 });

    useEnvWorkspace(h.projectRoot);
    await runHook();

    const drift = eventsNamed(main, "state-root-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]!["registered"]).toBe(phantom);
    expect(drift[0]!["resolved"]).toBe(main);
    expect(drift[0]!["sessionId"]).toBe(h.sessionId);
    // 本回合走的是正常路径（项目根、根在脚下）→ 无 resolved 事件，只有 drift
    expect(eventsNamed(main, "state-root-resolved")).toHaveLength(0);
  });

  it("4. 记录 cwd 与本回合同根（记录 cwd 是主根下无自有根的子目录）→ 无 drift", async () => {
    const main = makeStateRoot(h.projectRoot);
    const deep = join(h.projectRoot, "x", "y");
    mkdirSync(deep, { recursive: true });
    const { writeSession } = await import("../core/registry.js");
    await writeSession(main, { sessionId: sid(), cwd: deep, startedAt: 1, lastSeen: 1 });

    useEnvWorkspace(deep);
    await runHook();

    expect(eventsNamed(main, "state-root-drift")).toHaveLength(0);
    // 归并审计仍在（解析结果不是裸拼）
    expect(eventsNamed(main, "state-root-resolved")).toHaveLength(1);
  });

  it("5. 全新会话（无既有记录）→ 只有 resolved、无 drift", async () => {
    const main = makeStateRoot(h.projectRoot);
    const deep = join(h.projectRoot, "fresh", "deep");
    mkdirSync(deep, { recursive: true });
    useEnvWorkspace(deep);
    await runHook();
    expect(eventsNamed(main, "state-root-resolved")).toHaveLength(1);
    expect(eventsNamed(main, "state-root-drift")).toHaveLength(0);
  });

  it("6. 漂移审计只读：记录 cwd 不被审计改写；漂移持续期间每回合复读，幻影根清除后自愈", async () => {
    const main = makeStateRoot(h.projectRoot);
    const phantomBase = join(h.projectRoot, "old-root-dir");
    makeStateRoot(phantomBase);
    const { writeSession } = await import("../core/registry.js");
    await writeSession(main, { sessionId: sid(), cwd: phantomBase, startedAt: 1, lastSeen: 1 });

    useEnvWorkspace(h.projectRoot);
    await runHook();

    // 漂移事件恰一条；审计是只读的——会话记录 cwd 保持上一回合注册值
    // （refreshSessionLastSeen 的既有口径：cwd 只在为空时补写，本钩子不改该行为）
    expect(eventsNamed(main, "state-root-drift")).toHaveLength(1);
    const record = sessionRecord(main);
    expect(record).toBeDefined();
    expect(record!["cwd"]).toBe(phantomBase);
    expect(Number(record!["lastSeen"])).toBeGreaterThan(1); // lastSeen 照常刷新

    // 漂移仍在（幻影根未清）→ 下一次 SessionStart 再报一条（可观测，不静默）
    await runHook();
    expect(eventsNamed(main, "state-root-drift")).toHaveLength(2);

    // 幻影根被清除（G-27 实证处置：⑧ 当场清掉）→ 记录 cwd 经同一解析规则归并回主根
    // → 漂移自愈，不再复读
    rmSync(join(phantomBase, ".crosschat"), { recursive: true, force: true });
    await runHook();
    expect(eventsNamed(main, "state-root-drift")).toHaveLength(2);
    expect(eventsNamed(main, "state-root-resolved")).toHaveLength(0); // 全程正常路径
  });
});
