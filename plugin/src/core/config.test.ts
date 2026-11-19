/**
 * v0.9（组B）单测：工作区配置文件 .crosschat/config.json（G-6）与唤醒分层闸
 * （G-4/G-7，core/config.ts）。
 *
 * 验收锚点「配置优先级矩阵（file/env/默认 × 合法/畸形）」在此逐格覆盖；
 * 另覆盖：畸形回落+WARNING 披露、未知键扩展位、无缓存现读（改文件即热生效，
 * 钩子一次性进程每次点火重读的同一契约）、引擎成员免开关。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot（M1 真实读写，端到端到文件契约）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  engineHolderIsHeadless,
  readWorkspaceConfigFile,
  resolveWakeGate,
  wakeDisabledReason,
  wakeGateFromRaw,
  WORKSPACE_CONFIG_FILENAME,
  workspaceConfigFile,
} from "./config";
import { writeSession } from "./registry";
import type { SessionRecord, TeamMember } from "./types";

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-config-"));
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

/** 在当前临时 root 落一版 config.json（null = 删除文件，回未配置态）。 */
function seedConfig(content: string | null): void {
  const file = workspaceConfigFile(root);
  if (content === null) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 尽力而为 */
    }
    return;
  }
  writeFileSync(file, content, "utf8");
}

/**
 * 落一条会话记录（registry/sessions/<sid>.json）。boundName 缺省不写——模拟
 * SessionStart 钩子锚定的交互式会话记录（引擎路径才会写 boundName）。
 */
async function seedSession(sessionId: string, boundName?: string): Promise<void> {
  const record: SessionRecord = {
    sessionId,
    cwd: "D:\\ws",
    startedAt: 1,
    lastSeen: 1,
    ...(boundName !== undefined ? { boundName } : {}),
  };
  await writeSession(root, record);
}

const engineMember: Pick<TeamMember, "identity" | "key" | "sessionId"> =
  { identity: "engine", key: "b", sessionId: "sess_b" };
const selfMember: Pick<TeamMember, "identity" | "key" | "sessionId"> =
  { identity: "self", key: "b", sessionId: "sess_b" };
/** V090-05 攻击形态：engine 标行被交互式会话接管（joinTeam 保留 identity、只换 sid）。 */
const takenOverMember: Pick<TeamMember, "identity" | "key" | "sessionId"> =
  { identity: "engine", key: "b", sessionId: "sess_INT_B" };

// ─────────────────────────── 文件层解析（readWorkspaceConfigFile） ───────────────────────────

describe("readWorkspaceConfigFile（G-6 文件层：合法/畸形/扩展位）", () => {
  it("文件不存在 → present=false（未配置，非畸形，无 WARNING）", () => {
    expect(readWorkspaceConfigFile(root)).toEqual({ present: false });
  });

  it("合法文件：wake_enabled 布尔收录；未知键=扩展位静默忽略（不算畸形）", () => {
    seedConfig(JSON.stringify({ wake_enabled: true, future_key: { nested: 1 }, note: "扩展位" }));
    const cfg = readWorkspaceConfigFile(root);
    expect(cfg).toEqual({ present: true, wakeEnabled: true });
    expect(cfg.warning).toBeUndefined();

    seedConfig(JSON.stringify({ wake_enabled: false, future_key: 1 }));
    expect(readWorkspaceConfigFile(root)).toEqual({ present: true, wakeEnabled: false });
  });

  it("畸形：JSON 解析失败 → 整层忽略 + WARNING（含回落说明）", () => {
    seedConfig('{ "wake_enabled": true, }');
    const cfg = readWorkspaceConfigFile(root);
    expect(cfg.present).toBe(true);
    expect(cfg.wakeEnabled).toBeUndefined();
    expect(cfg.warning).toContain("WARNING");
    expect(cfg.warning).toContain(WORKSPACE_CONFIG_FILENAME);
    expect(cfg.warning).toContain("不是合法 JSON");
    expect(cfg.warning).toContain("回落");
  });

  it("畸形：根是数组/标量 → 整层忽略 + WARNING", () => {
    seedConfig("[1,2,3]");
    expect(readWorkspaceConfigFile(root)!.warning).toContain("根必须是 JSON 对象");
    seedConfig(JSON.stringify("just a scalar string"));
    expect(readWorkspaceConfigFile(root)!.warning).toContain("根必须是 JSON 对象");
  });

  it("畸形：wake_enabled 非布尔（字符串/数字）→ 该键忽略 + WARNING（其余扩展位不影响）", () => {
    seedConfig(JSON.stringify({ wake_enabled: "true" }));
    const cfg = readWorkspaceConfigFile(root);
    expect(cfg.wakeEnabled).toBeUndefined();
    expect(cfg.warning).toContain("wake_enabled 必须是布尔");
    expect(cfg.warning).toContain("回落");

    seedConfig(JSON.stringify({ wake_enabled: 1, future_key: "ok" }));
    expect(readWorkspaceConfigFile(root)!.warning).toContain("wake_enabled 必须是布尔");
  });

  it("wake_enabled 键缺省（纯扩展位文件）→ 文件层不表态、无 WARNING", () => {
    seedConfig(JSON.stringify({ future_key: true }));
    expect(readWorkspaceConfigFile(root)).toEqual({ present: true });
  });
});

// ─────────────────────────── 分层闸（resolveWakeGate：优先级矩阵） ───────────────────────────

describe("resolveWakeGate（G-4/G-7：file > env > 默认 × 合法/畸形矩阵）", () => {
  it("【默认层】无文件 + env 未给/空串 → default 层关闭（交互式防打扰默认）", () => {
    expect(resolveWakeGate(root, {})).toEqual({ enabled: false, source: "default" });
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "" })).toEqual({ enabled: false, source: "default" });
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: undefined })).toEqual({ enabled: false, source: "default" });
  });

  it("【env 层】无文件 + env：仅严格 \"true\" 开（V7 语义原样）；显式非 true 值 source=env", () => {
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "true" })).toEqual({ enabled: true, source: "env" });
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "false" })).toEqual({ enabled: false, source: "env" });
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "TRUE" })).toEqual({ enabled: false, source: "env" });
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "1" })).toEqual({ enabled: false, source: "env" });
  });

  it("【file 层压 env】合法 file：wake_enabled 布尔在场 → 恒 file 层，env 任何值都不参与", () => {
    seedConfig(JSON.stringify({ wake_enabled: true }));
    for (const env of [{}, { XC_WAKE_ENABLED: "false" }, { XC_WAKE_ENABLED: "true" }]) {
      expect(resolveWakeGate(root, env)).toEqual({ enabled: true, source: "file" });
    }
    seedConfig(JSON.stringify({ wake_enabled: false }));
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "true" })).toEqual({ enabled: false, source: "file" });
  });

  it("【畸形回落 env】file 畸形（坏 JSON/根形状/键类型）→ 回落 env 层 + WARNING 随闸携带", () => {
    seedConfig("{oops");
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "true" })).toEqual({
      enabled: true, source: "env", warning: expect.stringContaining("不是合法 JSON"),
    });
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "false" })).toEqual({
      enabled: false, source: "env", warning: expect.any(String),
    });
    // 畸形 + env 未给 → 回落到 default 层（WARNING 仍披露）
    expect(resolveWakeGate(root, {})).toEqual({
      enabled: false, source: "default", warning: expect.any(String),
    });
    // wake_enabled 类型非法：同为回落 env
    seedConfig(JSON.stringify({ wake_enabled: "true" }));
    const gate = resolveWakeGate(root, { XC_WAKE_ENABLED: "true" });
    expect(gate.source).toBe("env");
    expect(gate.enabled).toBe(true);
    expect(gate.warning).toContain("wake_enabled 必须是布尔");
  });

  it("【畸形回落默认】file 畸形 + env 未给 → default 层；WARNING 披露（对齐 env 卫生口径）", () => {
    seedConfig("not-json-at-all");
    const gate = resolveWakeGate(root, {});
    expect(gate.enabled).toBe(false);
    expect(gate.source).toBe("default");
    expect(gate.warning).toContain(WORKSPACE_CONFIG_FILENAME);
  });

  it("【扩展位不算畸形】file 只有未知键 → 正常落 env/default 层，无 WARNING", () => {
    seedConfig(JSON.stringify({ future_key: 1 }));
    expect(resolveWakeGate(root, {})).toEqual({ enabled: false, source: "default" });
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "true" })).toEqual({ enabled: true, source: "env" });
  });

  it("【引擎成员免开关】identity=engine ∧ 持有者是无头会话 → 恒 engine-member 开启，file/env 全部不约束", async () => {
    await seedSession("sess_b", "b"); // 引擎供给代写/wakeToken 注册路径写的 boundName
    // env 关 + file 关 + file 畸形：引擎成员都不受约束（免开关=身份 ∧ 持有者属性）
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "false" }, engineMember)).toEqual({
      enabled: true, source: "engine-member",
    });
    seedConfig(JSON.stringify({ wake_enabled: false }));
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "false" }, engineMember)).toEqual({
      enabled: true, source: "engine-member",
    });
    seedConfig("broken-json");
    expect(resolveWakeGate(root, {}, engineMember)).toEqual({ enabled: true, source: "engine-member" });
    seedConfig(null);
  });

  it("【交互式成员走分层】identity=self / 旧记录无 identity（缺省 self）→ file>env>默认", async () => {
    await seedSession("sess_b"); // 交互式会话：钩子锚定、无 boundName
    seedConfig(JSON.stringify({ wake_enabled: true }));
    expect(resolveWakeGate(root, {}, selfMember)).toEqual({ enabled: true, source: "file" });
    expect(resolveWakeGate(root, {}, { key: "b", sessionId: "sess_b" })).toEqual({ enabled: true, source: "file" }); // 无 identity = legacy self
    seedConfig(null);
    expect(resolveWakeGate(root, {}, selfMember)).toEqual({ enabled: false, source: "default" });
  });

  it("【热生效】无缓存现读：同一进程两次调用之间改文件，判定随之变化（钩子/投递每次点火重读）", () => {
    expect(resolveWakeGate(root, {}).enabled).toBe(false);
    seedConfig(JSON.stringify({ wake_enabled: true }));
    expect(resolveWakeGate(root, {}).enabled).toBe(true);
    seedConfig(JSON.stringify({ wake_enabled: false }));
    expect(resolveWakeGate(root, {}).enabled).toBe(false);
    seedConfig(null);
    expect(resolveWakeGate(root, {}).enabled).toBe(false);
  });
});

// ─────────────────────────── V090-05：引擎免开关的持有者校验（r3 打回 P2） ───────────────────────────

describe("V090-05 engineHolderIsHeadless（免开关=身份 ∧ 当前持有者仍是无头会话）", () => {
  it("命中：行 sid 的会话记录 boundName === 本行 key（引擎供给代写/wakeToken 注册两条路径的形状）", async () => {
    await seedSession("sess_b", "b"); // tools-team.ts:448 / identity.ts:258 的写入形状
    expect(engineHolderIsHeadless(root, engineMember)).toBe(true);
  });

  it("不命中：记录缺 boundName（交互式会话经 SessionStart 钩子锚定的形状——takeover 后行 sid 换成的就是它）", async () => {
    await seedSession("sess_INT_B");
    expect(engineHolderIsHeadless(root, takenOverMember)).toBe(false);
  });

  it("不命中：记录缺失 / 损坏 JSON / boundName 是别的花名（一律从严，fail-safe）", async () => {
    expect(engineHolderIsHeadless(root, engineMember)).toBe(false); // 记录缺失
    await seedSession("sess_b", "someone-else"); // boundName 属于别的花名
    expect(engineHolderIsHeadless(root, engineMember)).toBe(false);
    writeFileSync(join(root, "registry", "sessions", "sess_b.json"), "{not json", "utf8");
    expect(engineHolderIsHeadless(root, engineMember)).toBe(false);
  });

  it("不命中且不抛：sid 为空 / 含路径分隔符或 ..（防 team.json 被外部改写时的路径穿越）", () => {
    expect(engineHolderIsHeadless(root, { key: "b", sessionId: "" })).toBe(false);
    expect(engineHolderIsHeadless(root, { key: "b", sessionId: "../../etc/passwd" })).toBe(false);
    expect(engineHolderIsHeadless(root, { key: "b", sessionId: "a\\b" })).toBe(false);
  });
});

describe("V090-05 resolveWakeGate：engine 标行被交互式持有者接管后回落分层（免开关不再适用）", () => {
  it("takeover 行 + env false → 回落 env 层关闭 + takenOver 披露；env 未给 → default；file 显式开 → file", async () => {
    await seedSession("sess_INT_B");
    expect(resolveWakeGate(root, { XC_WAKE_ENABLED: "false" }, takenOverMember)).toEqual({
      enabled: false, source: "env", takenOver: true,
    });
    expect(resolveWakeGate(root, {}, takenOverMember)).toEqual({
      enabled: false, source: "default", takenOver: true,
    });
    seedConfig(JSON.stringify({ wake_enabled: true }));
    expect(resolveWakeGate(root, {}, takenOverMember)).toEqual({
      enabled: true, source: "file", takenOver: true,
    });
    seedConfig(null);
  });

  it("takeover 行的 wake-disabled 原因行注明「engine 标 ∧ 交互持有者」（可诊断，不再静默不开工）", async () => {
    await seedSession("sess_INT_B");
    const reason = wakeDisabledReason(resolveWakeGate(root, {}, takenOverMember));
    expect(reason).toContain("wake-disabled");
    expect(reason).toContain("当前持有者已是交互式会话");
    expect(reason).toContain("takeover 后 identity 保留");
    expect(reason).toContain('{"wake_enabled": true}');
  });

  it("非 engine 行不带 takenOver 标（self/legacy/不在册行为零变化）", async () => {
    await seedSession("sess_b");
    expect(resolveWakeGate(root, {}, selfMember).takenOver).toBeUndefined();
    expect(resolveWakeGate(root, {}, { key: "b", sessionId: "sess_b" }).takenOver).toBeUndefined();
    expect(resolveWakeGate(root, {}).takenOver).toBeUndefined();
  });
});

// ─────────────────────────── env shim 与原因行（decideDelivery 兼容入口） ───────────────────────────

describe("wakeGateFromRaw / wakeDisabledReason（兼容入口与 G-7 开启指引）", () => {
  it("env shim：严格 true → env 开；显式非 true → env 关；未给 → default 关", () => {
    expect(wakeGateFromRaw("true")).toEqual({ enabled: true, source: "env" });
    expect(wakeGateFromRaw("false")).toEqual({ enabled: false, source: "env" });
    expect(wakeGateFromRaw(undefined)).toEqual({ enabled: false, source: "default" });
    expect(wakeGateFromRaw("")).toEqual({ enabled: false, source: "default" });
  });

  it("wake-disabled 原因行：带来源、引擎成员免开关说明与 config.json 一行开启指引", () => {
    const reason = wakeDisabledReason({ enabled: false, source: "default" });
    expect(reason).toContain("wake-disabled");
    expect(reason).toContain("来源 default");
    expect(reason).toContain("引擎供给成员");
    expect(reason).toContain('{"wake_enabled": true}');
    // 带 WARNING（畸形披露）时原因行内联披露文本（readWorkspaceConfigFile 的 warning
    // 自带 "WARNING " 前缀，resolveWakeGate 原样透传）
    const warned = wakeDisabledReason({
      enabled: false, source: "env", warning: "WARNING config.json 不是合法 JSON（x）；该层忽略，回落 env/内置默认",
    });
    expect(warned).toContain("WARNING");
    expect(warned).toContain("不是合法 JSON");
  });
});
