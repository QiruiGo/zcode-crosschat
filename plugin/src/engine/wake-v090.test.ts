/**
 * v0.9（组B）单测：唤醒分层（G-4/G-7）+ 配置热生效（G-6）+ sessionNotFound 单次
 * 自动重试（G-8）——reports/31-v090方案.md 四个验收锚点的 attemptWake 级覆盖：
 *
 * 1. 配置优先级矩阵的引擎端到端（file/env/默认 × 合法/畸形，矩阵逐格在 core/config.test.ts）；
 * 2. 引擎成员在全局 false 下仍唤醒（免开关）；
 * 3. 交互会话 false 时不被意外唤醒（回归守卫）；
 * 4. sessionNotFound 重试单投（重绑重试恰一次、不重投邮箱、事件留痕、再失败附恢复动作）。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot + M1 真实读写函数（end-to-end 到 M1 契约）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { writeSession } from "../core/registry";
import type { TeamMember, TeamState } from "../core/types";
import { WORKSPACE_CONFIG_FILENAME, workspaceConfigFile } from "../core/config";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import {
  attemptWake,
  isSessionNotFoundEvidence,
  SESSION_NOT_FOUND_RECOVERY,
  WAKE_WATCH_WINDOW_MS,
  type WakeRequest,
} from "./wake";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v090-"));
  dirs.push(root);
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function seedConfig(content: string | null): void {
  const file = workspaceConfigFile(root);
  if (content === null) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, content, "utf8");
}

type CapturedSpawn = SpawnResumeOptions;

function fakeSpawn(pid: number | undefined, captured: CapturedSpawn[]): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    captured.push(opts);
    return { pid, logFile: opts.logFile };
  };
}

/** spawn 注入：返回后 delay 毫秒向唤醒日志写一行文本（模拟孤儿唤醒子进程的落盘）。 */
function spawnThenLog(captured: CapturedSpawn[], delayMs: number, line: string): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => {
    captured.push(opts);
    setTimeout(() => {
      mkdirSync(dirname(opts.logFile), { recursive: true });
      appendFileSync(opts.logFile, line + "\n");
    }, delayMs);
    return { pid: 4242, logFile: opts.logFile };
  };
}

function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "dispatch",
    receiptIds: ["m1"],
    ticket: "计算 17*23，把结果只写数字到 result-a2b.txt",
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    ...overrides,
  };
}

/** 在当前临时 root 的 b 邮箱落一条派单消息。 */
async function seedMailbox(): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "计算 17*23，把结果只写数字到 result-a2b.txt", {
    deliveryClaimedAt: Date.now(),
  });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

/** 落一个含单成员 b 的 team.json；identity/state 可选（缺省=旧记录语义）。 */
async function seedTeamWithMember(
  identity?: "engine" | "self",
  sessionId = "sess_b",
  state?: TeamMember["state"],
): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
  const member: TeamMember = {
    key: "b", sessionId, role: "worker", joinedAt: 1, lastSeen: 1,
    ...(identity !== undefined ? { identity } : {}),
    ...(state !== undefined ? { state } : {}),
  };
  team.members.push(member);
  await writeTeam(root, team);
}

/**
 * 落一条会话记录。boundName 缺省不写——模拟 SessionStart 钩子锚定的**交互式**
 * 会话记录；传了才是 member-add 供给代写（tools-team.ts Phase 3）的形状。
 * v0.9.1 r4（V090-04）起 boundName 的**唯一**写入路径就是 member-add（wakeToken
 * 路径不再写——防交互会话用收到的 wakeToken 自签「引擎无头持有者」）。
 */
async function seedSessionRecord(sessionId: string, boundName?: string): Promise<void> {
  await writeSession(root, {
    sessionId,
    cwd: "D:\\ws",
    startedAt: 1,
    lastSeen: 1,
    ...(boundName !== undefined ? { boundName } : {}),
  });
}

function waitUntil(check: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (check()) resolve(true);
      else if (Date.now() > deadline) resolve(false);
      else setTimeout(tick, stepMs);
    };
    tick();
  });
}

// ─────────────────────── 锚点 2+3：唤醒分层（G-4/G-7） ───────────────────────

describe("G-4/G-7 唤醒分层（attemptWake 端到端）", () => {
  it("【锚点 2】引擎成员（identity=engine ∧ 持有者无头）在全局 false（env+file 双关）下仍唤醒：wake + wakeGateSource=engine-member", async () => {
    await seedTeamWithMember("engine");
    await seedSessionRecord("sess_b", "b"); // member-add 供给代写链的 boundName（唯一写入路径）
    await seedMailbox();
    seedConfig(JSON.stringify({ wake_enabled: false })); // file 层显式关——引擎成员不受约束
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      env: { XC_WAKE_ENABLED: "false" },
      spawn: fakeSpawn(71, captured),
    }));
    expect(res.delivered).toBe("wake");
    expect(captured).toHaveLength(1);
    const wake = readEngineEvents().find((e) => e["event"] === "wake");
    expect(wake!["wakeGateSource"]).toBe("engine-member");
    seedConfig(null);
  });

  it("【锚点 3·回归守卫】交互式成员（identity=self）+ 全局 false → mailbox 不唤醒（不被意外唤醒）", async () => {
    await seedTeamWithMember("self");
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: { XC_WAKE_ENABLED: "false" }, spawn: fakeSpawn(1, captured) }));
    expect(res.delivered).toBe("mailbox");
    expect(captured).toHaveLength(0);
    const skip = readEngineEvents().filter((e) => e["event"] === "wake-skipped").at(-1);
    expect(String(skip!["reason"])).toContain("wake-disabled");
    expect(skip!["wakeGateSource"]).toBe("env");
    // G-7：原因行自带一行开启指引（不再只有 raw=false）
    expect(String(skip!["reason"])).toContain('{"wake_enabled": true}');
  });

  it("【锚点 3·回归守卫】旧记录无 identity（legacy self）+ env 未给 → 默认层关闭，mailbox 不唤醒", async () => {
    await seedTeamWithMember(undefined);
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: {}, spawn: fakeSpawn(1, captured) }));
    expect(res.delivered).toBe("mailbox");
    expect(captured).toHaveLength(0);
    const skip = readEngineEvents().filter((e) => e["event"] === "wake-skipped").at(-1);
    expect(skip!["wakeGateSource"]).toBe("default");
    // nonce 零落盘（跳过路径不写在途标记）
    const wakeDir = join(root, "registry", "wake");
    expect(existsSync(wakeDir) ? readdirSync(wakeDir) : []).toEqual([]);
  });

  it("【file 层生效】交互式成员 + config.json {wake_enabled:true}（env 未给）→ wake，wakeGateSource=file", async () => {
    await seedTeamWithMember("self");
    await seedMailbox();
    seedConfig(JSON.stringify({ wake_enabled: true }));
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: {}, spawn: fakeSpawn(72, captured) }));
    expect(res.delivered).toBe("wake");
    expect(captured).toHaveLength(1);
    expect(readEngineEvents().find((e) => e["event"] === "wake")!["wakeGateSource"]).toBe("file");
    seedConfig(null);
  });

  it("【file 压 env】交互式成员 + config.json false + env true → mailbox（file 层优先）", async () => {
    await seedTeamWithMember("self");
    await seedMailbox();
    seedConfig(JSON.stringify({ wake_enabled: false }));
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: { XC_WAKE_ENABLED: "true" }, spawn: fakeSpawn(1, captured) }));
    expect(res.delivered).toBe("mailbox");
    expect(captured).toHaveLength(0);
    expect(readEngineEvents().filter((e) => e["event"] === "wake-skipped").at(-1)!["wakeGateSource"]).toBe("file");
    seedConfig(null);
  });
});

// ─────────────────────── 锚点 1：畸形 config.json 的回落与披露（引擎端到端） ───────────────────────

describe("G-6 畸形 config.json：回落次层 + WARNING 披露（事件与原因行双通道）", () => {
  it("畸形 JSON + env true → 回落 env 层照常唤醒；config-malformed 事件留痕 + note 携带 WARNING（V090-08）", async () => {
    await seedTeamWithMember("self");
    await seedMailbox();
    seedConfig("{oops");
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: { XC_WAKE_ENABLED: "true" }, spawn: fakeSpawn(73, captured) }));
    expect(res.delivered).toBe("wake");
    expect(captured).toHaveLength(1);
    const malformed = readEngineEvents().find((e) => e["event"] === "config-malformed");
    expect(malformed).toBeDefined();
    expect(String(malformed!["warning"])).toContain("不是合法 JSON");
    expect(malformed!["file"]).toBe(workspaceConfigFile(root));
    // V090-08：放行路径的回执 note 与 skip 路径同口径携带 WARNING（双通道披露）
    expect(res.note).toContain("WARNING");
    expect(res.note).toContain("不是合法 JSON");
    expect(readEngineEvents().find((e) => e["event"] === "wake")!["configWarning"]).toContain("不是合法 JSON");
    seedConfig(null);
  });

  it("畸形 JSON + env 未给 → 回落默认层 mailbox；wake-skipped 原因行内联 WARNING（可观测不静默）", async () => {
    await seedTeamWithMember("self");
    await seedMailbox();
    seedConfig("definitely not json");
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: {}, spawn: fakeSpawn(1, captured) }));
    expect(res.delivered).toBe("mailbox");
    expect(captured).toHaveLength(0);
    const skip = readEngineEvents().filter((e) => e["event"] === "wake-skipped").at(-1)!;
    expect(String(skip["reason"])).toContain("WARNING");
    expect(skip["configWarning"]).toContain(WORKSPACE_CONFIG_FILENAME);
    expect(String(skip["reason"])).toContain('{"wake_enabled": true}');
    seedConfig(null);
  });
});

// ─────────────────────── 锚点 4：sessionNotFound 重试单投（G-8） ───────────────────────

describe("G-8 sessionNotFound：自动重绑重试恰一次（不重投邮箱、事件留痕）", () => {
  it("【锚点 4】首次 --resume 命中 sessionNotFound → 重绑到花名册新 sid 重试恰一次；邮箱仍单份（不双投）", async () => {
    await seedTeamWithMember("engine", "sess_b"); // 全局 false 也不挡引擎成员（分层）
    await seedSessionRecord("sess_b", "b"); // 当前持有者=引擎供给的无头会话
    const messageId = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      env: { XC_WAKE_ENABLED: "false" },
      receiptIds: [messageId],
      watchWindowMs: 1500,
      watchPollMs: 20,
      spawn: spawnThenLog(captured, 100, "Error: Session not found: sess_b"),
    }));
    expect(res.delivered).toBe("wake");
    expect(res.note).toContain("sessionNotFound 时自动重绑重试恰一次");

    // 成员在首次失败前由 lead 幂等重供给到新 sid（xc_team member-add → joinTeam
    // 刷花名册 + member-add Phase 3 代写新 sid 的 boundName——r4 起这是 boundName
    // 的唯一写入路径，重试前的分层复检因此放行；交互 takeover 换绑则不写，复检拒）
    await seedTeamWithMember("engine", "sess_b2");
    await seedSessionRecord("sess_b2", "b");

    // 等重试落事件（恰一次的标记 = wake-retry 出现）
    const sawRetry = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-retry"));
    expect(sawRetry).toBe(true);

    // 恰一次：总 spawn = 原始 1 + 重试 1；重试打向重绑后的新 sid，prompt 携带新 sid
    expect(captured).toHaveLength(2);
    expect(captured[0]!.sessionId).toBe("sess_b");
    expect(captured[1]!.sessionId).toBe("sess_b2");
    expect(captured[1]!.prompt).toContain("sessionId=sess_b2");

    const retry = readEngineEvents().find((e) => e["event"] === "wake-retry")!;
    expect(retry["attempt"]).toBe(1);
    expect(retry["fromSessionId"]).toBe("sess_b");
    expect(retry["sid"]).toBe("sess_b2");
    expect(String(retry["reason"])).toContain("Session not found");

    // 幂等：邮箱仍单份（不重投），消息留箱可 pull；首投 deliveredAt 已盖、无二次改写
    const box = await readMailbox(root, "default", "b");
    expect(box).toHaveLength(1);
    expect(box[0]!.id).toBe(messageId);
    expect(box[0]!.deliveredAt).toBeDefined();

    // 留痕链：wake-failed(where=wake-child) → wake-retry；重试成功无 wake-retry-failed
    const failed = readEngineEvents().find((e) => e["event"] === "wake-failed")!;
    expect(failed["where"]).toBe("wake-child");
    expect(readEngineEvents().some((e) => e["event"] === "wake-retry-failed")).toBe(false);
  });

  it("重试仍 sessionNotFound → wake-retry-failed 附恢复动作；总 spawn 恰 2（不再二次重试）", async () => {
    await seedTeamWithMember("engine", "sess_b"); // 花名册仍是死 sid → 重试同一 sid 仍失败
    await seedSessionRecord("sess_b", "b");
    const messageId = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    await attemptWake(baseReq({
      env: { XC_WAKE_ENABLED: "false" },
      receiptIds: [messageId],
      watchWindowMs: 1500,
      watchPollMs: 20,
      spawn: spawnThenLog(captured, 30, "Error: Session not found: sess_b"),
    }));
    const sawFinal = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-retry-failed"));
    expect(sawFinal).toBe(true);

    // 恰一次：总 spawn = 2；重试失败事件带 where 与恢复动作
    expect(captured).toHaveLength(2);
    const final = readEngineEvents().find((e) => e["event"] === "wake-retry-failed")!;
    expect(final["where"]).toBe("wake-retry-child");
    expect(String(final["recovery"])).toBe(SESSION_NOT_FOUND_RECOVERY);
    expect(String(final["recovery"])).toContain("xc_identify");
    expect(String(final["recovery"])).toContain("member-add");
    // 重试失败后：重试租约已释放、重试 nonce 已消费（15min 在途标记不挡人工重试）
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.deliveryClaimedAt).toBeUndefined();
  });

  it("非 sessionNotFound 失败（ENOENT 形态）→ 保持 FI-7 既有语义：wake-failed 一次，不触发重试", async () => {
    await seedTeamWithMember("engine");
    await seedSessionRecord("sess_b", "b");
    const messageId = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    await attemptWake(baseReq({
      env: { XC_WAKE_ENABLED: "false" },
      receiptIds: [messageId],
      watchWindowMs: 1200,
      watchPollMs: 20,
      spawn: spawnThenLog(captured, 30, "Error: spawn ZCode.exe ENOENT"),
    }));
    const sawFailed = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-failed"));
    expect(sawFailed).toBe(true);
    await new Promise((r) => setTimeout(r, 300)); // 越过侦听窗口确认无重试
    expect(captured).toHaveLength(1);
    expect(readEngineEvents().some((e) => e["event"] === "wake-retry")).toBe(false);
  });
});

// ─────────────────────── isSessionNotFoundEvidence（纯函数） ───────────────────────

describe("isSessionNotFoundEvidence（G-8 证据判定，只认 sessionNotFound）", () => {
  it("命中：红队实测形态（行首 Error + Session not found）大小写不敏感", () => {
    expect(isSessionNotFoundEvidence("Error: Session not found: sess_x")).toBe(true);
    expect(isSessionNotFoundEvidence("Error: session NOT FOUND: sess_x")).toBe(true);
  });
  it("不命中：其他失败证据与非失败文本", () => {
    expect(isSessionNotFoundEvidence("Error: spawn ENOENT")).toBe(false);
    expect(isSessionNotFoundEvidence('{"isError":true,"message":"boom"}')).toBe(false);
    expect(isSessionNotFoundEvidence("")).toBe(false);
  });
});

// ─────────────────────── v0.9.1 r3 打回锚点（V090-05/06/07） ───────────────────────

describe("V090-05 attemptWake：engine 标行被交互式会话接管后不被无头唤醒（免开关加持有者校验）", () => {
  it("takeover 行（identity=engine ∧ 行 sid 换成交互会话）+ 全局 false → mailbox，零 spawn，wake-skipped 带 takenOver", async () => {
    // 攻击形态（裁决证据 c3）：joinTeam 保留 identity、只换 sessionId
    await seedTeamWithMember("engine", "sess_INT_B");
    await seedSessionRecord("sess_INT_B"); // 交互会话：钩子锚定、无 boundName
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      env: { XC_WAKE_ENABLED: "false" },
      spawn: fakeSpawn(1, captured),
    }));
    expect(res.delivered).toBe("mailbox");
    expect(captured).toHaveLength(0); // 不被无头唤醒（交互会话默认防打扰恢复）
    const skip = readEngineEvents().filter((e) => e["event"] === "wake-skipped").at(-1)!;
    expect(skip["wakeGateSource"]).toBe("env");
    expect(skip["takenOver"]).toBe(true);
    expect(String(skip["reason"])).toContain("当前持有者已是交互式会话");
    // nonce 零落盘（跳过路径不写在途标记）
    const wakeDir = join(root, "registry", "wake");
    expect(existsSync(wakeDir) ? readdirSync(wakeDir) : []).toEqual([]);
  });

  it("同一 takeover 行 + config.json 显式开启 → 按 file 层放行（运营者显式选择，wakeGateSource=file）", async () => {
    await seedTeamWithMember("engine", "sess_INT_B");
    await seedSessionRecord("sess_INT_B");
    await seedMailbox();
    seedConfig(JSON.stringify({ wake_enabled: true }));
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: {}, spawn: fakeSpawn(74, captured) }));
    expect(res.delivered).toBe("wake");
    expect(captured).toHaveLength(1);
    const wake = readEngineEvents().find((e) => e["event"] === "wake")!;
    expect(wake["wakeGateSource"]).toBe("file");
    expect(wake["takenOver"]).toBe(true);
    seedConfig(null);
  });

  it("健康引擎成员（行 sid 的记录带 boundName）不受影响：仍 engine-member 免开关唤醒", async () => {
    await seedTeamWithMember("engine", "sess_b");
    await seedSessionRecord("sess_b", "b");
    await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: { XC_WAKE_ENABLED: "false" }, spawn: fakeSpawn(75, captured) }));
    expect(res.delivered).toBe("wake");
    expect(captured).toHaveLength(1);
    expect(readEngineEvents().find((e) => e["event"] === "wake")!["wakeGateSource"]).toBe("engine-member");
  });
});

describe("V090-06 attemptWake：重试前复检成员状态门（removed 成员不被重试唤醒）", () => {
  it("唤醒在途/失败窗内成员被 member-stop（removed）→ wake-retry-skipped，零第二次 spawn，租约不重开", async () => {
    await seedTeamWithMember("engine", "sess_b");
    await seedSessionRecord("sess_b", "b");
    const messageId = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({
      env: { XC_WAKE_ENABLED: "false" },
      receiptIds: [messageId],
      watchWindowMs: 1500,
      watchPollMs: 20,
      spawn: spawnThenLog(captured, 60, "Error: Session not found: sess_b"),
    }));
    expect(res.delivered).toBe("wake");

    // 失败证据落盘前把成员置 removed（member-stop 与在途唤醒叠加的裁决形态 c4）
    await seedTeamWithMember("engine", "sess_b", "removed");

    const sawSkip = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-retry-skipped"));
    expect(sawSkip).toBe(true);
    const skip = readEngineEvents().find((e) => e["event"] === "wake-retry-skipped")!;
    expect(skip["memberState"]).toBe("removed");
    expect(String(skip["reason"])).toContain("member-state:removed");
    expect(String(skip["reason"])).toContain("V090-06");
    // 恰一次：总 spawn = 1（原始）；无 wake-retry / wake-retry-failed
    expect(captured).toHaveLength(1);
    expect(readEngineEvents().some((e) => e["event"] === "wake-retry")).toBe(false);
    // 消息仍在邮箱可 pull（原始租约已释放、未重开）
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.deliveryClaimedAt).toBeUndefined();
  });

  it("重试前分层闸被关（config.json 改 false ∧ 行被接管）→ wake-retry-skipped(wakeGateSource)，不 spawn", async () => {
    await seedTeamWithMember("engine", "sess_b");
    await seedSessionRecord("sess_b", "b");
    const messageId = await seedMailbox();
    const captured: CapturedSpawn[] = [];
    await attemptWake(baseReq({
      env: { XC_WAKE_ENABLED: "false" },
      receiptIds: [messageId],
      watchWindowMs: 1500,
      watchPollMs: 20,
      spawn: spawnThenLog(captured, 60, "Error: Session not found: sess_b"),
    }));
    // 窗内行被交互式会话接管 + config.json 显式关 → 重试前复检分层闸不过
    await seedTeamWithMember("engine", "sess_INT_B");
    await seedSessionRecord("sess_INT_B");
    seedConfig(JSON.stringify({ wake_enabled: false }));
    const sawSkip = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-retry-skipped"));
    expect(sawSkip).toBe(true);
    const skip = readEngineEvents().find((e) => e["event"] === "wake-retry-skipped")!;
    expect(skip["wakeGateSource"]).toBe("file");
    expect(skip["takenOver"]).toBe(true);
    expect(captured).toHaveLength(1);
    seedConfig(null);
  });
});

describe("V090-07 attemptWake：失败侦听窗口与回执 note 的如实边界", () => {
  it("默认窗口≥120s（宿主冷启动实测 25s 才落盘的失败证据不再整条错过）", () => {
    expect(WAKE_WATCH_WINDOW_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("回执 note 如实：有界窗口 + 超窗/进程退出的邮箱兜底，不再无条件宣称「失败由引擎自动检测」", async () => {
    await seedTeamWithMember("engine");
    await seedSessionRecord("sess_b", "b");
    await seedMailbox();
    const res = await attemptWake(baseReq({ spawn: fakeSpawn(76, []) }));
    expect(res.delivered).toBe("wake");
    expect(res.note).toContain("非送达确认");
    expect(res.note).toContain("有界窗口");
    expect(res.note).toContain("超窗或本进程退出则以邮箱 pull 兜底");
    expect(res.note).not.toContain("失败由引擎侦听 wake 日志自动检测");
  });

  it("窗内迟到证据仍被侦听（机制锚点：注入 2s 窗 + 300ms 迟到失败 → wake-failed + 租约释放）", async () => {
    await seedTeamWithMember("engine");
    await seedSessionRecord("sess_b", "b");
    const messageId = await seedMailbox();
    await attemptWake(baseReq({
      receiptIds: [messageId],
      watchWindowMs: 2000,
      watchPollMs: 20,
      spawn: spawnThenLog([], 300, "Error: Session not found: sess_b"),
    }));
    const sawFailure = await waitUntil(() => readEngineEvents().some((e) => e["event"] === "wake-failed"));
    expect(sawFailure).toBe(true);
    const box = await readMailbox(root, "default", "b");
    expect(box[0]!.deliveryClaimedAt).toBeUndefined(); // 租约已释放
  });

  it("窗外证据按契约不侦听（有界性的诚实一面：note 的超窗兜底声明覆盖该情形）", async () => {
    await seedTeamWithMember("engine");
    await seedSessionRecord("sess_b", "b");
    await seedMailbox();
    await attemptWake(baseReq({
      watchWindowMs: 100,
      watchPollMs: 20,
      spawn: spawnThenLog([], 400, "Error: Session not found: sess_b"),
    }));
    await new Promise((r) => setTimeout(r, 500)); // 越过侦听窗口
    expect(readEngineEvents().some((e) => e["event"] === "wake-failed")).toBe(false);
    expect(readEngineEvents().some((e) => e["event"] === "wake-retry")).toBe(false);
  });
});

// ─────────────────────── v0.9.1 r4 打回锚点（V090-04：wakeToken 自签被封死后的链末端） ───────────────────────

describe("V090-04 attemptWake：自签被封死后用户显式关闭配置恒生效（裁决链 step④⑤）", () => {
  it("engine 标行被交互接管 + 交互记录无 boundName（自签已不可达）+ config.json false → wake-skipped(takenOver) 零 spawn", async () => {
    // r3-c3b 攻击链末端形态：①takeover ②唤醒期派单(config=true) ③自签被 r4 修复阻断
    // ④用户 config.json 改 false ⑤再 dispatch —— 免开关不得放行。
    await seedTeamWithMember("engine", "sess_INT_B");
    await seedSessionRecord("sess_INT_B"); // 交互会话：钩子锚定、无 boundName（自签不可达）
    await seedMailbox();
    seedConfig(JSON.stringify({ wake_enabled: false }));
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: {}, spawn: fakeSpawn(80, captured) }));
    expect(res.delivered).toBe("mailbox");
    expect(captured).toHaveLength(0); // 无头 --resume 不再打向交互会话
    const skip = readEngineEvents().filter((e) => e["event"] === "wake-skipped").at(-1)!;
    expect(skip["wakeGateSource"]).toBe("file");
    expect(skip["takenOver"]).toBe(true);
    expect(String(skip["reason"])).toContain("当前持有者已是交互式会话");
    seedConfig(null);
  });

  it("健康引擎成员仍免开关（member-add boundName 在场）——G-4 不回退", async () => {
    await seedTeamWithMember("engine", "sess_b");
    await seedSessionRecord("sess_b", "b"); // member-add 供给代写（唯一写入路径）
    await seedMailbox();
    seedConfig(JSON.stringify({ wake_enabled: false }));
    const captured: CapturedSpawn[] = [];
    const res = await attemptWake(baseReq({ env: {}, spawn: fakeSpawn(81, captured) }));
    expect(res.delivered).toBe("wake");
    expect(captured).toHaveLength(1);
    expect(readEngineEvents().find((e) => e["event"] === "wake")!["wakeGateSource"]).toBe("engine-member");
    seedConfig(null);
  });
});
