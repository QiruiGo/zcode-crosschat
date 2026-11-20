/**
 * M1 core-config：工作区级配置文件 `.crosschat/config.json` 的解析与唤醒开关分层
 * （v0.9，reports/31-v090方案.md §一 G-6/G-4/G-7）。
 *
 * G-6 决策原文：「`.crosschat/config.json` 工作区级覆盖（非 ~/.zcode 全局挂载——
 * 协作配置跟工作区走、随目录迁移、更新不冲掉）；优先级 file > env > 默认；
 * 钩子一次性进程每次点火重读=天然热生效」。
 *
 * 设计要点：
 * - **无缓存、每次现读**：钩子（一次性进程）每次点火自然重读；MCP server（长驻
 *   进程）在每次唤醒判定时现读——改文件即热生效，不需要重启/重载（G-6 的核心诉求，
 *   现场「改缓存 default 未生效」事故的直接反面）。
 * - **键只收 wake_enabled**（可留扩展位）：未知键静默忽略（向前兼容，不算畸形）；
 *   `wake_enabled` 在场时必须是布尔，否则该键不生效并披露 WARNING。
 * - **畸形文件=该层回落 + WARNING 披露**（对齐既有 env 卫生口径：V7 严格判定、
 *   offlineThresholdMsFromEnv 的 fellBack 显式披露、inbox 坏行 `N unreadable`
 *   同款纪律）——回落方向是次一层（env），不是静默吞掉。
 * - **0 新增必填配置**：config.json 是可选文件；不存在时 env 层与内置默认照旧
 *   （v0.8.1 及之前的行为零变化）。
 *
 * 唤醒分层（G-4/G-7）在本模块出口 {@link resolveWakeGate} 表达：
 * - 引擎供给成员（xc_team member-add 创建，identity="engine"，headless by design）
 *   **不受全局 wake_enabled 约束、默认可唤醒**——它没有属主在看，唤醒是它唯一的
 *   自启通道（GAP-V0.9 G-4：128 次 wake-skipped 的首要摩擦）；
 * - 其余目标（交互式自注册成员/不在册会话）维持默认 false 防打扰；要开启：
 *   工作区 `.crosschat/config.json` 写 `{"wake_enabled": true}` 一行。
 *
 * v0.9.1 r3（V090-05）：引擎成员免开关增加**持有者校验**——identity:"engine" 只是
 * roster 行上的粘滞标（「谁建了这行」），不证明「当前持有者还是无头会话」：交互式
 * 会话可经 xc_identify({takeover:true}) 接管已死引擎成员的花名（joinTeam 只换
 * sessionId、保留 identity），该行此后恒被无头唤醒——G-4/G-7 为交互会话建立的默认
 * 防打扰被文档化恢复流程完全绕开。判据见 {@link engineHolderIsHeadless}。
 *
 * v0.9.3 增量（reports/37-v093方案.md §一 组B B1）：config.json 增 **capacity 段**
 * `{warn_watermark, turn_estimate_bytes, wake_gate}`——容量闸三旋钮的 file 层。
 * 逐键校验（与 wake_enabled 同纪律：非法=该键忽略 + WARNING 披露，绝不静默吞），
 * 未知键静默忽略（扩展位）；分层解析（file > env > 内置默认）在 core/capacity.ts
 * {@link resolveCapacityThresholds}（本模块只做文件层解析，不 import 容量阈值面）。
 *
 * 依赖纪律：本模块只 import M1（core/paths、core/types）——钩子（M4）与引擎
 * （M2）都可安全引用（DESIGN.md §8.1 rule 1 同款）。
 *
 * @module core/config
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coerceSessionRecord, memberIdentity, type TeamMember } from "./types.js";
import { sessionFile } from "./paths.js";

/** 工作区配置文件名（相对状态根 `<workspace>/.crosschat/`）。 */
export const WORKSPACE_CONFIG_FILENAME = "config.json";

/** 配置文件绝对路径（状态根拼装；不校验存在性）。 */
export function workspaceConfigFile(stateRoot: string): string {
  return join(stateRoot, WORKSPACE_CONFIG_FILENAME);
}

/** 唤醒开关判定来源。 */
export type WakeGateSource = "file" | "env" | "default" | "engine-member";

/**
 * 一次唤醒判定的生效开关（分层结果）。
 * - `enabled`：最终是否允许推送唤醒（属主约束/在途 nonce/成员状态门控由
 *   engine/wake.ts 的三态决策另行叠加，与本开关正交）。
 * - `source`：判定来源——file（config.json）/ env（XC_WAKE_ENABLED，userConfig
 *   注入）/ default（内置 false）/ engine-member（引擎供给成员免开关，G-4）。
 * - `warning`：畸形 config.json 的 WARNING 文案（仅当 file 层被咨询且畸形时携带；
 *   调用方必须披露——落 engine.jsonl 事件与工具回执 note）。
 * - `takenOver`（v0.9.1 r3，V090-05）：行带 identity="engine" 但当前持有者已换成
 *   交互式会话（takeover 后 identity 保留）——免开关不适用，本闸按 file/env/默认
 *   判定。置位时调用方应在 wake-skipped 原因/回执里披露（防「引擎成员突然不自动
 *   开工」无从诊断）。
 */
export interface WakeGate {
  enabled: boolean;
  source: WakeGateSource;
  warning?: string;
  takenOver?: boolean;
}

/** config.json 单文件解析结果（文件层）。 */
export interface WorkspaceConfigFile {
  /** 文件存在且被读取（false = 未配置该层，不算畸形）。 */
  present: boolean;
  /** 文件层生效的 wake_enabled（仅布尔合法时收录；畸形/缺省 = undefined）。 */
  wakeEnabled?: boolean;
  /**
   * v0.9.3（B1）：文件层生效的 capacity 段（三键各自合法才收录；段缺省 = undefined）。
   * 逐键畸形披露在 {@link WorkspaceCapacitySection.warnings}（与顶层 warning 分开：
   * 顶层管整文件/ wake_enabled，段内管三个容量键——「逐层披露」不混通道）。
   */
  capacity?: WorkspaceCapacitySection;
  /** 畸形披露（JSON/根形状/键类型错误；正常文件 = undefined）。 */
  warning?: string;
}

/**
 * v0.9.3（B1）：config.json `capacity` 段的文件层解析结果。
 *
 * 三键与容量闸旋钮一一对应（core/capacity.ts 的 env 名在括号内）：
 * - `warnWatermark`：red1 可用内存占比预警线（`XC_MEM_WARN_WATERMARK`），合法域 **(0,1)**；
 * - `turnEstimateBytes`：单回合预估字节（`XC_TURN_ESTIMATE_BYTES`），**>0** 合法；
 * - `wakeGate`：spawn 前容量闸开关（`XC_MEM_WAKE_GATE`），布尔（false = 关闸）。
 *
 * 每个键独立判定：非法值只忽略**该键**（其余键与 wake_enabled 不受影响），并产出一条
 * WARNING（段整体非对象时只产一条、整段忽略）。未知键静默忽略（扩展位，向前兼容）。
 */
export interface WorkspaceCapacitySection {
  warnWatermark?: number;
  turnEstimateBytes?: number;
  wakeGate?: boolean;
  /** 逐键畸形 WARNING（每条自带 `WARNING ` 前缀，与顶层 warning 同款自标注）。 */
  warnings?: string[];
}

/**
 * 读取并校验工作区配置文件（每次调用现读，无缓存——热生效契约）。
 *
 * 校验规则（畸形=该层回落 + WARNING，绝不静默吞）：
 * - 文件不存在 → `{ present: false }`（未配置，非畸形）；
 * - JSON 解析失败 → `{ present: true, warning }`（整层忽略，回落 env/默认）；
 * - 根不是 JSON 对象（数组/标量）→ 同上；
 * - `wake_enabled` 在场但非布尔（如字符串 "true"）→ 该键忽略 + WARNING，
 *   其余扩展位键不影响；
 * - **capacity 段**（v0.9.3 B1）：段缺省 = 未配置（非畸形）；段非对象 → 整段忽略 +
 *   一条 WARNING；三个键各自校验（非法 = 该键忽略 + 一条 WARNING）；段内未知键静默忽略；
 * - 未知键 → 静默忽略（扩展位，向前兼容）；
 * - 读文件抛出非 ENOENT 的 IO 错误（权限/占用）→ 按畸形回落 + WARNING
 *   （与引擎审计日志不可写的披露口径一致：可观测，不阻断）。
 *
 * warning 文案自带 `WARNING ` 前缀（与 auditDegradationWarning 同款自标注）：
 * 任何披露面（engine.jsonl 事件、工具回执 note）原样携带即可辨认。
 */
export function readWorkspaceConfigFile(stateRoot: string): WorkspaceConfigFile {
  const file = workspaceConfigFile(stateRoot);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { present: false };
    // 非「不存在」的读失败（权限/被占用）：按畸形披露，不静默。
    return {
      present: true,
      warning: `WARNING ${WORKSPACE_CONFIG_FILENAME} 不可读（${error instanceof Error ? error.message : String(error)}）；该层忽略，回落 env/内置默认`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      present: true,
      warning: `WARNING ${WORKSPACE_CONFIG_FILENAME} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）；该层忽略，回落 env/内置默认`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      present: true,
      warning: `WARNING ${WORKSPACE_CONFIG_FILENAME} 的根必须是 JSON 对象（得到 ${Array.isArray(parsed) ? "数组" : typeof parsed}）；该层忽略，回落 env/内置默认`,
    };
  }
  const record = parsed as Record<string, unknown>;
  // v0.9.3（B1）：capacity 段与 wake_enabled 独立解析——段内畸形只波及容量三键，
  // 顶层畸形（JSON/根形状）整层忽略（两者都可能同时在场，各自披露）。
  const capacity = parseCapacitySection(record["capacity"]);
  const rawWake = record["wake_enabled"];
  if (rawWake === undefined) {
    // 键缺省：文件层不表态（扩展位照读不拒）
    return { present: true, ...(capacity !== undefined ? { capacity } : {}) };
  }
  if (typeof rawWake !== "boolean") {
    return {
      present: true,
      warning: `WARNING ${WORKSPACE_CONFIG_FILENAME} 的 wake_enabled 必须是布尔（得到 ${wakeValueKind(rawWake)}）；该键忽略，回落 env/内置默认`,
      ...(capacity !== undefined ? { capacity } : {}),
    };
  }
  return { present: true, wakeEnabled: rawWake, ...(capacity !== undefined ? { capacity } : {}) };
}

/**
 * v0.9.3（B1）：capacity 段解析（纯函数；逐键校验 + 逐键披露）。
 *
 * - 段缺省（undefined）→ 返回 undefined（未配置，不算畸形——与顶层「文件不存在」同语义）；
 * - 段非对象（数组/标量/null）→ 整段忽略 + 一条 WARNING（回落 env/内置默认）；
 * - 三键各自校验，非法值只忽略该键并产出一条 WARNING；未知键静默忽略（扩展位）；
 * - 返回的 section 恒带至少一个键或一条 warning（全空 = 未配置，由调用方按 undefined 处理）。
 */
function parseCapacitySection(raw: unknown): WorkspaceCapacitySection | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      warnings: [
        `WARNING ${WORKSPACE_CONFIG_FILENAME} 的 capacity 必须是 JSON 对象（得到 ${Array.isArray(raw) ? "数组" : raw === null ? "null" : typeof raw}）；该段忽略，回落 env/内置默认`,
      ],
    };
  }
  const record = raw as Record<string, unknown>;
  const section: WorkspaceCapacitySection = {};
  const warnings: string[] = [];
  const rawWatermark = record["warn_watermark"];
  if (rawWatermark !== undefined) {
    if (typeof rawWatermark === "number" && Number.isFinite(rawWatermark) && rawWatermark > 0 && rawWatermark < 1) {
      section.warnWatermark = rawWatermark;
    } else {
      warnings.push(
        `WARNING ${WORKSPACE_CONFIG_FILENAME} 的 capacity.warn_watermark 须为 (0,1) 内的有限数（得到 ${wakeValueKind(rawWatermark)}）；该键忽略，回落 env/内置默认`,
      );
    }
  }
  const rawEstimate = record["turn_estimate_bytes"];
  if (rawEstimate !== undefined) {
    if (typeof rawEstimate === "number" && Number.isFinite(rawEstimate) && rawEstimate > 0) {
      section.turnEstimateBytes = rawEstimate;
    } else {
      warnings.push(
        `WARNING ${WORKSPACE_CONFIG_FILENAME} 的 capacity.turn_estimate_bytes 须为 >0 的有限数（得到 ${wakeValueKind(rawEstimate)}）；该键忽略，回落 env/内置默认`,
      );
    }
  }
  const rawWakeGate = record["wake_gate"];
  if (rawWakeGate !== undefined) {
    if (typeof rawWakeGate === "boolean") {
      section.wakeGate = rawWakeGate;
    } else {
      warnings.push(
        `WARNING ${WORKSPACE_CONFIG_FILENAME} 的 capacity.wake_gate 必须是布尔（得到 ${wakeValueKind(rawWakeGate)}）；该键忽略，回落 env/内置默认`,
      );
    }
  }
  if (warnings.length > 0) section.warnings = warnings;
  if (section.warnWatermark === undefined && section.turnEstimateBytes === undefined
    && section.wakeGate === undefined && warnings.length === 0) {
    return undefined; // 纯未知键的段 = 未配置（扩展位，不算畸形）
  }
  return section;
}

/** wake_enabled 非法值的人类可读类型名（WARNING 文案用，不暴露原始值——防撞出长串）。 */
function wakeValueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}

/**
 * env 层 shim（engine/wake.ts 的 decideDelivery 兼容入口用）：
 * XC_WAKE_ENABLED === "true" → env 层开启；其余值（显式给了但非 "true"）→ env 层
 * 关闭；未给/空串 → 内置默认 false。V7 严格判定语义不变（isWakeEnabled 的判定域）。
 */
export function wakeGateFromRaw(raw: string | undefined | null): WakeGate {
  if (raw === "true") return { enabled: true, source: "env" };
  return { enabled: false, source: typeof raw === "string" && raw.trim() !== "" ? "env" : "default" };
}

/**
 * v0.9.1 r3（V090-05）：roster 行的**当前持有者**是否仍是引擎供给的无头会话。
 * v0.9.1 r4（V090-04，P2）：判据收紧为 boundName 的**唯一**写入路径——
 * member-add 供给代写（mcp/tools-team.ts Phase 3：`boundName: plan.key`，sid 由
 * 引擎经 app-server 创建，无头 by design，攻击者无法让引擎为自己的交互 sid 代写）。
 *
 * r3 曾把判据写成「两条写入路径」（member-add 代写 ∧ wakeToken 注册），被裁决
 * 证据链推翻（r3-c3b）：交互会话 takeover 已死引擎成员花名后，在 wake_enabled=true
 * 期收到引擎签发的 wakeToken（wake prompt 身份行显式携带），用它走 wakeToken 路径
 * 即可把 boundName 自签进自己的会话记录——此后用户把 config.json 改
 * {"wake_enabled":false} 也无效。r4 起 wakeToken 路径不再写 boundName
 * （mcp/identity.ts：只做记录锚定，不替代供给链；既有 boundName 经 spread 保留），
 * 「行当前 sid 的记录带本名 boundName」重新 ⟺ 当前持有者是引擎供给的无头会话。
 *
 * 交互式会话的记录由 SessionStart 钩子锚定（无 boundName），hook 路径注册也不写
 * 该字段——takeover 后行 sid 换成交互会话，其记录没有 boundName → 判 false。
 *
 * 从严方向（fail-safe）：记录缺失/损坏/不可读、sid 空、或 sid 含路径分隔符
 * （防 team.json 被外部改写时的路径穿越）→ 一律 false（免开关不成立，回落
 * file/env/默认层——运营者仍可显式开启，不会被意外无头唤醒）。
 *
 * 威胁模型边界（与 V090-04 已知限同口径）：持文件写权限的同机进程可直接伪造
 * sessions/<sid>.json 的 boundName——v0.6 威胁模型明示「同机进程可伪造状态文件」，
 * 本轮红线不引入签名/防伪机制，此类伪造走已知限披露，不在本函数防御面内。
 */
export function engineHolderIsHeadless(
  stateRoot: string,
  member: Pick<TeamMember, "key" | "sessionId">,
): boolean {
  const sid = typeof member.sessionId === "string" ? member.sessionId.trim() : "";
  if (sid === "" || /[\\/]/.test(sid) || sid.includes("..")) return false;
  let raw: string;
  try {
    raw = readFileSync(sessionFile(stateRoot, sid), "utf8");
  } catch {
    return false; // 记录缺失（EOENT）或不可读：从严不豁免
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // 记录损坏：从严不豁免
  }
  const coerced = coerceSessionRecord(parsed, sid);
  return coerced.ok && coerced.record.boundName === member.key;
}

/**
 * 唤醒开关分层判定（G-4/G-7 唯一出口；engine/wake.ts attemptWake 每次投递调用）：
 *
 * 1. 目标是引擎供给成员（identity="engine" ∧ 当前持有者仍是无头会话，
 *    {@link engineHolderIsHeadless}）→ 恒 `{ enabled: true, source:
 *    "engine-member" }`——**不读 config.json、不看 env**：headless 会话没有属主
 *    在场，全局开关是给「有人在看」的交互式会话防打扰用的，对它没有语义
 *    （G-4 决策原文「不受全局 wake_enabled 约束、默认可唤醒」）。
 *    行带 engine 标但持有者已换成交互式会话（takeover）→ **不豁免**，落第 2 层
 *    并置 `takenOver`（V090-05：防文档化恢复流程绕开交互会话的默认防打扰）。
 * 2. 其余目标按 file > env > 内置默认：
 *    - config.json 的 wake_enabled 合法在场 → file 层生效（畸形 → WARNING + 落层）；
 *    - 否则 XC_WAKE_ENABLED === "true" → env 层开启；
 *    - 否则关闭（source=env 表示显式配置了非 "true" 值；source=default 表示未配置）。
 *
 * member 缺省（undefined）= 目标不在册/团队未建——按交互式语义走分层（v0.8.1
 * 行为兼容：旧记录无 identity 字段也按 memberIdentity 的 "self" 缺省走分层）。
 */
export function resolveWakeGate(
  stateRoot: string,
  env: NodeJS.ProcessEnv,
  member?: Pick<TeamMember, "identity" | "key" | "sessionId">,
): WakeGate {
  const engineRow = member !== undefined && memberIdentity(member as TeamMember) === "engine";
  if (engineRow && engineHolderIsHeadless(stateRoot, member!)) {
    return { enabled: true, source: "engine-member" };
  }
  const file = readWorkspaceConfigFile(stateRoot);
  if (file.wakeEnabled !== undefined) {
    return {
      enabled: file.wakeEnabled, source: "file",
      ...(engineRow ? { takenOver: true } : {}),
      ...(file.warning !== undefined ? { warning: file.warning } : {}),
    };
  }
  const gate = wakeGateFromRaw(env["XC_WAKE_ENABLED"]);
  // 文件层被咨询过且畸形（wake_enabled 缺失/键非法/JSON 破损）→ 披露随闸带上；
  // 文件不存在（present=false）→ 无披露（未配置不是畸形）。
  return {
    ...gate,
    ...(engineRow ? { takenOver: true } : {}),
    ...(file.warning !== undefined ? { warning: file.warning } : {}),
  };
}

/**
 * 交互式会话被全局开关挡下时的 wake-skipped 原因行（G-7「开启路径产品化」：
 * 原因自带来源与一行开启指引，不再只说 raw=false）。引擎供给成员不经过本行
 * （免开关，不产生 wake-disabled 跳过）。
 * v0.9.1 r3（V090-05）：takenOver 行（engine 标 ∧ 交互式持有者）额外注明免开关
 * 为何不适用——否则「引擎成员突然不自动开工」在回执里无从诊断。
 */
export function wakeDisabledReason(gate: WakeGate): string {
  const takeoverNote = gate.takenOver === true
    ? "；注意：该成员行由引擎创建但当前持有者已是交互式会话（xc_identify takeover 后 identity 保留），引擎免开关不再适用"
    : "";
  const base =
    `wake-disabled: 交互式会话自动唤醒未开启（来源 ${gate.source}${takeoverNote}；` +
    "引擎供给成员 xc_team member-add 不受此开关约束）——" +
    `工作区 ${WORKSPACE_CONFIG_FILENAME} 写 {"wake_enabled": true} 一行开启`;
  // gate.warning 自带 "WARNING " 前缀（readWorkspaceConfigFile 统一标注），原样内联。
  return gate.warning !== undefined ? `${base}；${gate.warning}` : base;
}
