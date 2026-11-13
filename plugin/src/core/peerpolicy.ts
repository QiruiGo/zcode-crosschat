/**
 * W4 inbound-gate: 跨会话（peer）域的**入站三态**裁决 + hold 缓冲与终态。
 *
 * 规格出处：DESIGN-V0.3.md §6（W4 全节）、§9.3（硬验收 3 的矩阵）、
 * §10.2（W4 对外签名）；SPEC-V0.3.md §4.2（R-18..R-21）。
 *
 * 与队内域的关系（R-25）：队内 `core/policy.ts`（per-team policy.json + held
 * .held.jsonl）**零改动**；本文件是**跨会话域**的第二实例，粒度是
 * 「会话 × 跨会话」。两域帧白名单互斥，队内域「协议帧永远豁免入站策略」
 * 的豁免**不适用**于此。
 *
 * ---------------------------------------------------------------------------
 * CC 机制标尺（bundle-2.1.319.js，offset 已逐条核对）
 * ---------------------------------------------------------------------------
 * - `w()` @34184255：层序解析。① 管理层→用户层**第一个已定义值胜**；
 *   ② 项目层**只能收紧**（`f[s]>f[e??"accept"]`）；③ 非法枚举 → hold
 *   （`if(f[e??"accept"]<f.hold&&N()) e="hold",n="invalidSetting"`）。
 *   严格度 `f={accept:0,hold:1,refuse:2}`。
 * - `O()` @34182418：归因映射 `policySettings→managed-setting`、
 *   `repoSettings→repo-setting`、`invalidSetting→invalid-setting`、
 *   `flagSettings/userSettings/undefined→explicit-setting`。
 * - `h()` @34184854：accept→accept / hold→hold(holdCause=O()) / refuse→refuse(opt-out)。
 * - `_()` @34185022：kill-switch（`jl("receive")` 关 → refuse(kill-switch)），**最先判定**。
 * - `S()` @34185486 / `k()` @34185568：**消息实际走的路径**。
 *   `k()`：① 显式值优先（`XUe()!==void 0` → `h(v)`）；② `selfSent` → **放行**；
 *   ③ 收方档类未知 → hold(mode-unknown)；④ 发方断言档类时同档 accept /
 *   异档 hold(mode-mismatch)；⑤ 发方未断言且收方 bypass → hold(no-mode-asserted)；
 *   ⑥ 其余 → accept。
 * - `H()` @34185107：**另一个入口**（会话级查询 `XYe()=H().policy`）。
 *   它的 `bypass-default` 在「收方 bypass 且无显式设置」时**无条件成立**，
 *   与 `k()` 的 `no-mode-asserted`（只在发方未断言档类时成立）**不是同一条件**
 *   （DESIGN-V0.3 §6.2 DV-2）。本文件两处都实现，但**分函数**。
 * - hold 缓冲容量 `Q=100`（@34182692），满则逐出最旧者并记 `expired`
 *   （@34187621 `if(o.held.length>=Q){let i=o.held.shift();…}`）。
 * - 事件 `peer_message_hold`：`state ∈ {held,released,dropped}`，
 *   `cause ∈ {explicit-setting,managed-setting,repo-setting,invalid-setting,
 *   bypass-default,mode-unknown,mode-mismatch,no-mode-asserted}`，
 *   `outcome ∈ {expired,refused,dropped,discarded}`（@2901183/@2903001）。
 *
 * ---------------------------------------------------------------------------
 * zcode 层映射（DESIGN-V0.3 §6.1）
 * ---------------------------------------------------------------------------
 * | 层 | 来源 | 归因 |
 * |---|---|---|
 * | K kill-switch | env `XC_PEER_RECEIVE=off`（manifest 由 userConfig `peer_receive` 注入） | refuse(kill-switch) |
 * | A 用户层 | userConfig `cross_session_inbound`（MCP server 进程只能经 env 读到） | explicit-setting |
 * | B 项目层 | `<workspace>/.crosschat/peer/inbound.json`（`sessions[sid]` 优先于 `mode`） | repo-setting |
 * | C 会话层 | env `XC_CROSSCHAT_INBOUND` | explicit-setting |
 * | D 自动档 | 三个显式层都未设 → mode-parity（CC `k()`） | mode-* / no-mode-asserted |
 *
 * **最严胜**（DESIGN §6.1 第 3 步，修正了上一版「逐层覆盖」的放松口径）：
 * 取 f 最大的候选值；并列时按归因优先级 managed > invalid > repo > user > env。
 *
 * **已知平台约束（如实登记，非设计选择）**：MCP server 进程读不到 userConfig
 * 实体（PLATFORM.md：userConfig 只经 `${user_config.*}` 模板注入 env），
 * 因此**用户层与会话层在 server 进程里共用 `XC_CROSSCHAT_INBOUND` 一个通道**
 * （§11.7 的 env 注入块）。两者取值恒等 → 最严胜结果不受影响；
 * `readPeerInboundPolicy` 的 `layers.user` / `layers.env` 如实报告同一来源，
 * `options.sessionInbound` 可显式覆盖会话层取值。
 *
 * **zcode 相对 CC 的两处显式偏离**（安全向，README 与 §12.1 已登记）：
 * - DV-1：CC 的发方档类采信门 `CVt()=v("tengu_harbor_kite_mode_emit",!0)`
 *   默认 true 但服务端真值未确认 → zcode **固化为 true**，安全阀是
 *   `trustSenderClass=false`（退化为 CC 的门关闭分支）。
 * - DV-2：CC 的 `H()` 不是消息路径（见上）→ 本文件分成
 *   `decideInboundPolicy`（消息路径 = `S`→`k`）与
 *   `decideSessionInboundPolicy`（会话级查询面 = `H`）两个函数。
 *
 * **与 SPEC R-18 的一处冲突（如实登记）**：SPEC R-18 写「非法值忽略并回退
 * 下一级」，DESIGN §13 的裁定表（1483 行）写「② 非法枚举 → hold（对齐 CC
 * `w()` 的 invalidSetting fail-closed），不再『忽略并回退下一层』」。
 * 本实现按 **DESIGN 的修正后口径**（fail-closed 到 hold）。
 *
 * **与 SPEC R-19 的一处细化**：发方断言了**不可识别**的档类值 → hold，
 * cause 取 `mode-unknown`（SPEC R-19 明文；DESIGN §6.2 第 4 步的字面写法
 * 会落到 mode-mismatch。两者都是 hold，cause 标签按 SPEC 的更细口径取）。
 *
 * **与 W5 的 held IO 重叠（如实登记，集成时需 W7 裁决）**：§10.1 把
 * 「held 三区 IO」给了 W5（`core/peermsg.ts` 的 `writeHeldPeerMessage` /
 * `listHeldPeerMessages`），把「hold 缓冲与释放路径、终态」给了 W4（本文件）。
 * 两者都读写 `held/<sid>/<msgId>.json`，但：
 * - 形状不同：W5 落 `{item, cause, heldAt}`；本文件落
 *   `{item, cause, announcedCauses, heldAt, expiresAt}`；
 * - 文件名不同：W5 用 W1 的 `peerHeldFile`（原始 msgId）；本文件把 msgId
 *   **安全化**后作文件名（msgId 来自对端，不可信；`../evil` 不得拼进路径）。
 * 本文件为此做了双向兼容：**读**按目录内容枚举（两种文件名都认，缺字段按
 * 默认值补齐），**删**按实际文件名删（不留孤儿文件），**再暂存**原地更新
 * 既有文件（不产生第二份）。集成时建议由 W7 选定唯一写入方。
 *
 * @module core/peerpolicy
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stripLeadingBom, writeFileAtomic } from './atomic.js';
import { appendJsonl } from './jsonl.js';
import { logEngineEvent } from './log.js';
import {
  peerAuditLogFile as buildPeerAuditLogFile,
  peerBaseFile,
  peerHeldDir as buildPeerHeldDir,
} from './peerdir.js';
import { resolveStateRoot } from './paths.js';
import { isRecord } from './types.js';

// ---------------------------------------------------------------------------
// 类型与词表
// ---------------------------------------------------------------------------

/** 入站三态（CC `crossSessionInbound` 的三值）。 */
export type PeerInboundMode = 'accept' | 'hold' | 'refuse';

/** DESIGN §10.2 的签名用的是 `InboundMode`；与队内域 `core/policy.ts` 同名但
 * 不同域——本文件的 `InboundMode` 是跨会话域的别名，导入方请显式指定。 */
export type InboundMode = PeerInboundMode;

export const PEER_INBOUND_MODES: readonly PeerInboundMode[] = ['accept', 'hold', 'refuse'];

/** 严格度 f（CC `var f={accept:0,hold:1,refuse:2}` @34182692）。 */
export const INBOUND_STRICTNESS: Readonly<Record<PeerInboundMode, number>> = {
  accept: 0,
  hold: 1,
  refuse: 2,
};

/**
 * hold 原因词表（CC `@2903001` 的 8 值）。
 * `managed-setting` 在 zcode v0.3 的**默认路径不可达**（zcode 无托管设置层，
 * DESIGN §6.1 第 4 条）；它只在本文件显式传入 `managed` 候选时出现
 * （前向兼容扩展点，语义按 CC 的 `restrictive:["refuse","hold"]` @963982）。
 */
export type HoldCause =
  | 'explicit-setting'
  | 'managed-setting'
  | 'repo-setting'
  | 'invalid-setting'
  | 'bypass-default'
  | 'mode-unknown'
  | 'mode-mismatch'
  | 'no-mode-asserted';

export const HOLD_CAUSES: readonly HoldCause[] = [
  'explicit-setting',
  'managed-setting',
  'repo-setting',
  'invalid-setting',
  'bypass-default',
  'mode-unknown',
  'mode-mismatch',
  'no-mode-asserted',
];

/** 裁决归因（= DESIGN §6.1 第 3 步的 decidedBy 词表 + 自动档标记）。 */
export type PeerPolicySource =
  | 'explicit-setting'
  | 'managed-setting'
  | 'repo-setting'
  | 'invalid-setting'
  | 'mode-parity';

/** 权限档类（CC `De=["bypass","prompting"]` @2355944）。 */
export type PeerModeClass = 'bypass' | 'prompting';

/** 入站裁决结果（形状照 DESIGN §10.2）。 */
export type InboundDecision =
  | { policy: 'accept' }
  | { policy: 'hold'; cause: HoldCause }
  | { policy: 'refuse'; cause: 'kill-switch' | 'opt-out' };

/** 发送方回执态（CC `@36116756` 的六态词表）。 */
export type PeerReceiptState = 'held' | 'denied' | 'expired' | 'delivered' | 'refused' | 'dropped';

/** hold 终态（CC `@2903001` 的 outcome 四值）。 */
export type PeerHoldOutcome = 'expired' | 'refused' | 'dropped' | 'discarded';

// ---------------------------------------------------------------------------
// 常量（环境变量名与限额）
// ---------------------------------------------------------------------------

/** 会话层/用户层显式取值的环境变量名（manifest 注入，见 §11.7）。 */
export const INBOUND_ENV = 'XC_CROSSCHAT_INBOUND';
/** kill-switch 的环境变量名（manifest 由 userConfig `peer_receive` 注入）。 */
export const KILL_SWITCH_ENV = 'XC_PEER_RECEIVE';
/** hold 审批期限的环境变量名（userConfig `hold_ttl_ms`）。 */
export const HOLD_TTL_ENV = 'XC_HOLD_TTL_MS';

/** hold 缓冲容量（对齐 CC `Q=100` @34182692）。 */
export const HOLD_CAPACITY = 100;

/** hold 审批期限默认值：12 h（CC 未取证，zcode 增设；DESIGN §6.3 / R-21）。 */
export const DEFAULT_HOLD_TTL_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 路径（peer 根目录相对布局，DESIGN §3.1）
// ---------------------------------------------------------------------------

/**
 * `held/<sessionId>/` —— hold 隔离区（模型不可见；CC「without letting Claude
 * act」@1086318）。
 *
 * 路径构造归 W1（`core/peerdir.ts`，§10.1 所有权表「全部 peer 路径构造」）；
 * 本文件直接复用，不另起一套。
 */
export const peerHeldDir = buildPeerHeldDir;

/**
 * `held/<sessionId>/<msgId>.json`。
 *
 * 与 W1 的 `peerHeldFile` 的**唯一差别**：文件名用 `heldFileSegment()` 安全化
 * （msgId 来自对端，属不可信输入；`../evil` 这类值不得拼进路径）。真值
 * msgId 写在文件内容里，读取按内容还原。
 */
export function peerHeldFile(root: string, sessionId: string, msgId: string): string {
  return join(peerHeldDir(root, sessionId), `${heldFileSegment(msgId)}.json`);
}

/** 跨会话域的机器全局审计日志 `<peerRoot>/logs/peer.jsonl`（DESIGN §3.1）。 */
export const peerAuditLogFile = buildPeerAuditLogFile;

/** 收方会话基记录 `<peerRoot>/base/<sessionId>.json`（DESIGN §3.1；档类真源）。 */
export function peerBaseRecordFile(root: string, sessionId: string): string {
  return peerBaseFile(root, sessionId);
}

/**
 * 项目层策略文件 `<workspace>/.crosschat/peer/inbound.json`
 * （形状 `{"mode":…,"sessions":{"<sid>":…}}`，`sessions[sid]` 优先于 `mode`）。
 */
export function peerInboundSettingsFile(workspace: string): string {
  return join(resolveStateRoot(workspace), 'peer', 'inbound.json');
}

/**
 * 把 msgId 折成一个安全的单路径段文件名。
 * 可读的 msgId 原样保留；其余（含 `..`、路径分隔符、超长）折成摘要名，
 * 真值仍写在文件内容里。
 */
export function heldFileSegment(msgId: string): string {
  const value = msgId.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) return value;
  return `m-${createHash('sha256').update(msgId).digest('hex').slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// 层的取值分类（未设 / 合法 / 非法）
// ---------------------------------------------------------------------------

export type LayerValueState = 'unset' | 'valid' | 'invalid';

export interface LayerValueClassification {
  state: LayerValueState;
  /** 仅 state==='valid' 时有值。 */
  mode?: PeerInboundMode;
  /** 分类理由（审计用）。 */
  reason?: string;
}

/** 未展开的 `${user_config.*}` 模板串（DESIGN §6.1 第 2 步；展开形态未确认）。 */
const UNEXPANDED_TEMPLATE_RE = /^\$\{user_config\.[^}]*\}$/;

/**
 * 分类一个显式层的原始取值（DESIGN §6.1 第 2/4 步）：
 * - **未设**：`undefined`、空串/纯空白、`"unset"`、未展开的 `${user_config.*}`
 *   模板串（后者额外审计 `peer-policy-unset-expansion`）；
 * - **合法**：`accept|hold|refuse`（大小写不敏感；`ACCEPT` 判为 accept，
 *   误判成非法只会 fail-closed 到 hold，反而更严但语义跑偏）；
 * - **非法**：其余一切 → 按 hold 计入并记 `invalid-setting`（fail-closed）。
 */
export function classifyLayerValue(raw: string | undefined | null): LayerValueClassification {
  if (raw === undefined || raw === null) return { state: 'unset' };
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'unset') return { state: 'unset' };
  if (UNEXPANDED_TEMPLATE_RE.test(value)) return { state: 'unset', reason: 'unexpanded-template' };
  const lower = value.toLowerCase();
  if ((PEER_INBOUND_MODES as readonly string[]).includes(lower)) {
    return { state: 'valid', mode: lower as PeerInboundMode };
  }
  return { state: 'invalid', reason: 'not-an-enum-value' };
}

/** kill-switch 是否命中：`XC_PEER_RECEIVE=off`（空串/其他值 → 未命中）。 */
export function isKillSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[KILL_SWITCH_ENV];
  if (typeof raw !== 'string') return false;
  return raw.trim().toLowerCase() === 'off';
}

/** hold 审批期限（env `XC_HOLD_TTL_MS` 覆盖，默认 12 h）。 */
export function holdTtlMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HOLD_TTL_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_HOLD_TTL_MS;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HOLD_TTL_MS;
  return Math.floor(parsed);
}

// ---------------------------------------------------------------------------
// 裁决
// ---------------------------------------------------------------------------

interface LayerCandidate {
  /** 严格度 f。 */
  f: number;
  mode: PeerInboundMode;
  source: PeerPolicySource;
  /** 层标识（并列时的归因优先级用）。 */
  layer: 'managed' | 'invalid' | 'repo' | 'user' | 'env';
}

/** 并列时的归因优先级（数字小者优先）。CC 的项目层在并列时**夺走**归因
 * （`w()`：`else if(s!=="accept"&&e!==void 0&&f[s]===f[e]&&n!=="policySettings")
 * n="repoSettings"`），故 repo 排在 user/env 之前。 */
const LAYER_PRIORITY: Readonly<Record<LayerCandidate['layer'], number>> = {
  managed: 0,
  invalid: 1,
  repo: 2,
  user: 3,
  env: 4,
};

function pickStrictest(candidates: readonly LayerCandidate[]): LayerCandidate {
  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.f > best.f) {
      best = candidate;
      continue;
    }
    if (candidate.f === best.f && LAYER_PRIORITY[candidate.layer] < LAYER_PRIORITY[best.layer]) {
      best = candidate;
    }
  }
  return best;
}

/** `h()` @34184854 的等价：显式取值 → 裁决。 */
function decideFromExplicit(mode: PeerInboundMode, source: PeerPolicySource): InboundDecision {
  if (mode === 'accept') return { policy: 'accept' };
  if (mode === 'hold') {
    // 归因必须落在 CC 的 8 值 cause 词表内；`mode-parity` 不是显式归因，
    // 兜底记为 explicit-setting（与 CC `O()` 对 undefined decidedBy 的映射同款）。
    const cause: HoldCause = source === 'mode-parity' ? 'explicit-setting' : (source as HoldCause);
    return { policy: 'hold', cause };
  }
  return { policy: 'refuse', cause: 'opt-out' };
}

type ClassNormal = PeerModeClass | 'unknown' | undefined;

/** 档类归一：不可识别的取值 → `'unknown'`（CC 的 `!P.has(mode)` 分支）。 */
function normalizeClass(raw: unknown): ClassNormal {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  if (value === 'bypass' || value === 'prompting') return value;
  return 'unknown';
}

export interface InboundPolicyInput {
  /** 已解析的显式取值（= CC `XUe()` 的值：层解析的结果）。 */
  explicit?: PeerInboundMode;
  /** 显式取值的归因（`readPeerInboundPolicy` 的 `decidedBy`）；缺省 explicit-setting。 */
  explicitSource?: PeerPolicySource;
  /** 会话层 env 原始串（未解析；与 `explicit` 一起参与最严胜）。 */
  env?: string;
  /** 托管层原始串（CC 的 policySettings；仅 accept|hold|refuse 中的 refuse/hold 有效）。 */
  managed?: string;
  /** 收方档类。 */
  recvClass?: PeerModeClass | string;
  /** 发方档类断言（`msg.senderMode`）。 */
  senderClass?: PeerModeClass | string;
  /** 自发消息（CC `k()`②：**放行**，不是丢弃）。 */
  selfSent?: boolean;
  /** 是否采信发方档类（DV-1 的安全阀；默认 true = CC 的默认分支）。 */
  trustSenderClass?: boolean;
  /** kill-switch 命中。 */
  managedOff?: boolean;
}

/**
 * 消息路径的入站裁决（CC `S()` → `k()` 的等价物，DESIGN §6.2）。
 *
 * 顺序：kill-switch → 显式层（最严胜）→ 自发放行 → 收方档类 → 发方档类 →
 * 收方 bypass 兜底 → accept。
 */
export function decideInboundPolicy(input: InboundPolicyInput): InboundDecision {
  // 0. kill-switch：压过一切设置与自动档（CC `_()`）。
  if (input.managedOff === true) return { policy: 'refuse', cause: 'kill-switch' };

  // 1. 显式层：最严胜（DESIGN §6.1 第 3 步；CC `w()` 的等价口径）。
  const candidates: LayerCandidate[] = [];
  if (input.managed !== undefined) {
    const classified = classifyLayerValue(input.managed);
    if (classified.state === 'valid' && classified.mode !== undefined) {
      // 托管层只允许收紧（CC `restrictive:["refuse","hold"]` @963982）：
      // accept 不在允许集内 → 视为非法取值 → fail-closed 到 hold。
      if (classified.mode === 'accept') {
        candidates.push({ f: INBOUND_STRICTNESS.hold, mode: 'hold', source: 'invalid-setting', layer: 'invalid' });
      } else {
        candidates.push({
          f: INBOUND_STRICTNESS[classified.mode],
          mode: classified.mode,
          source: 'managed-setting',
          layer: 'managed',
        });
      }
    } else if (classified.state === 'invalid') {
      candidates.push({ f: INBOUND_STRICTNESS.hold, mode: 'hold', source: 'invalid-setting', layer: 'invalid' });
    }
  }
  if (input.explicit !== undefined) {
    const source = input.explicitSource ?? 'explicit-setting';
    const layer: LayerCandidate['layer'] =
      source === 'managed-setting' ? 'managed'
      : source === 'invalid-setting' ? 'invalid'
      : source === 'repo-setting' ? 'repo'
      : 'user';
    candidates.push({
      f: INBOUND_STRICTNESS[input.explicit],
      mode: input.explicit,
      source,
      layer,
    });
  }
  if (input.env !== undefined) {
    const classified = classifyLayerValue(input.env);
    if (classified.state === 'valid' && classified.mode !== undefined) {
      candidates.push({
        f: INBOUND_STRICTNESS[classified.mode],
        mode: classified.mode,
        source: 'explicit-setting',
        layer: 'env',
      });
    } else if (classified.state === 'invalid') {
      candidates.push({ f: INBOUND_STRICTNESS.hold, mode: 'hold', source: 'invalid-setting', layer: 'invalid' });
    }
  }
  if (candidates.length > 0) {
    const winner = pickStrictest(candidates);
    return decideFromExplicit(winner.mode, winner.source);
  }

  // 2. 自动档（mode-parity）：CC `k()` @34185568。
  return decideAutoMode(input);
}

/**
 * 自动档（CC `k()` @34185568 的逐分支平移）。
 * 单独导出，便于单测直接打这张 3×2 矩阵。
 */
export function decideAutoMode(input: InboundPolicyInput): InboundDecision {
  // ② 自发消息放行（CC：`if(e?.selfSent)return{policy:"accept"}`）。
  if (input.selfSent === true) return { policy: 'accept' };

  const recv = normalizeClass(input.recvClass);
  // ③ 收方档类未知 → fail-closed（CC：`s===null||!P.has(s.mode)` → mode-unknown）。
  if (recv === undefined || recv === 'unknown') return { policy: 'hold', cause: 'mode-unknown' };

  // ④ 发方断言了档类：同档 accept / 异档 hold(mode-mismatch)（CC `k()`④⑤）。
  const trustSender = input.trustSenderClass !== false;
  if (trustSender && input.senderClass !== undefined) {
    const sender = normalizeClass(input.senderClass);
    if (sender === 'unknown') return { policy: 'hold', cause: 'mode-unknown' };
    if (sender !== undefined) {
      return sender === recv ? { policy: 'accept' } : { policy: 'hold', cause: 'mode-mismatch' };
    }
  }

  // ⑥ 发方未断言档类：仅当收方 bypass 时暂存（CC `k()`⑥）。
  if (recv === 'bypass') return { policy: 'hold', cause: 'no-mode-asserted' };
  return { policy: 'accept' };
}

/**
 * 会话级**查询面**的策略（CC `H()` @34185107，`XYe()=H().policy`）。
 *
 * 与消息路径 `decideInboundPolicy` 的差别（DV-2）：`H()` 的 `bypass-default`
 * 在「收方 bypass 且无显式设置」时**无条件成立**——哪怕发方断言了档类；
 * 而消息路径此时按 `k()`④ 走同档 accept。两者结果**可以不同**，与 CC 一致。
 */
export function decideSessionInboundPolicy(
  input: Omit<InboundPolicyInput, 'senderClass' | 'selfSent'>,
): InboundDecision {
  if (input.managedOff === true) return { policy: 'refuse', cause: 'kill-switch' };
  if (input.explicit !== undefined) {
    return decideFromExplicit(input.explicit, input.explicitSource ?? 'explicit-setting');
  }
  const recv = normalizeClass(input.recvClass);
  if (recv === undefined || recv === 'unknown') return { policy: 'hold', cause: 'mode-unknown' };
  return recv === 'bypass' ? { policy: 'hold', cause: 'bypass-default' } : { policy: 'accept' };
}

// ---------------------------------------------------------------------------
// 层解析（readPeerInboundPolicy）
// ---------------------------------------------------------------------------

export interface PeerInboundPolicyResolution {
  /**
   * 显式层裁决结果。**无显式层时取 `'accept'` 作为地板值**（CC 的
   * `f[e??"accept"]` 同款地板）；此时 `auto === true`、`decidedBy ===
   * 'mode-parity'`，`explicit === undefined`——判断「是否显式 accept」请看
   * `explicit`/`auto`，不要只看 `mode`。
   */
  mode: PeerInboundMode;
  /** 最严的**显式层**取值（无显式层时同样是地板值 `'accept'`）。 */
  strictest: PeerInboundMode;
  /** 真正的显式取值（无显式层时 undefined）。 */
  explicit?: PeerInboundMode;
  /** 归因（无显式层时 `'mode-parity'`）。 */
  decidedBy: PeerPolicySource;
  /** kill-switch 是否命中（命中 → 一律 refuse，与层解析无关）。 */
  killSwitch: boolean;
  /** 是否需要走自动档（无任何显式层）。 */
  auto: boolean;
  /** 是否有层持有非法枚举值（fail-closed 到 hold）。 */
  invalid: boolean;
  /** 各层的原始取值（未设的层不出现在表里）。 */
  layers: { user?: string; repo?: string; env?: string };
  /** 本次解析产生的审计事件名（便于调用方汇总）。 */
  audits: string[];
}

export interface ReadPeerInboundPolicyOptions {
  /** 显式覆盖会话层的原始取值（默认取 env `XC_CROSSCHAT_INBOUND`）。 */
  sessionInbound?: string;
}

interface RepoLayerRead {
  raw?: string;
  error?: string;
}

async function readRepoLayer(workspace: string, sessionId: string): Promise<RepoLayerRead> {
  let text: string;
  try {
    text = await readFile(peerInboundSettingsFile(workspace), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { error: `unreadable: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingBom(text));
  } catch (error) {
    return { error: `invalid JSON: ${String(error)}` };
  }
  if (!isRecord(parsed)) return { error: 'not a JSON object' };
  const sessions = parsed['sessions'];
  if (isRecord(sessions)) {
    const scoped = sessions[sessionId];
    if (scoped !== undefined) {
      // 非字符串 → 折成字符串交给分类器判非法（fail-closed）。
      return { raw: typeof scoped === 'string' ? scoped : JSON.stringify(scoped) };
    }
  }
  const mode = parsed['mode'];
  if (mode === undefined) return {};
  return { raw: typeof mode === 'string' ? mode : JSON.stringify(mode) };
}

/**
 * 解析本会话的跨会话入站策略（DESIGN §6.1 的四层 + 最严胜）。
 *
 * @param workspace 工作区目录（项目层文件 `<ws>/.crosschat/peer/inbound.json` 在其下）
 * @param sessionId 本会话 id（项目层按会话取值时用）
 * @param env 进程环境（读 `XC_CROSSCHAT_INBOUND` / `XC_PEER_RECEIVE`）
 */
export async function readPeerInboundPolicy(
  workspace: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ReadPeerInboundPolicyOptions = {},
): Promise<PeerInboundPolicyResolution> {
  const stateRoot = resolveStateRoot(workspace);
  const audits: string[] = [];
  const killSwitch = isKillSwitchOn(env);

  const userRaw = env[INBOUND_ENV];
  const envRaw = options.sessionInbound ?? env[INBOUND_ENV];
  const repo = await readRepoLayer(workspace, sessionId);

  const candidates: LayerCandidate[] = [];
  let invalid = false;

  const pushLayer = async (
    layer: LayerCandidate['layer'],
    raw: string | undefined,
    source: PeerPolicySource,
  ): Promise<void> => {
    const classified = classifyLayerValue(raw);
    if (classified.state === 'unset') {
      if (classified.reason === 'unexpanded-template') {
        audits.push('peer-policy-unset-expansion');
        await logEngineEvent(stateRoot, {
          event: 'peer-policy-unset-expansion',
          layer,
          raw: String(raw).slice(0, 200),
        });
      }
      return;
    }
    if (classified.state === 'invalid' || classified.mode === undefined) {
      invalid = true;
      audits.push('peer-policy-invalid');
      await logEngineEvent(stateRoot, {
        event: 'peer-policy-invalid',
        layer,
        raw: String(raw).slice(0, 200),
        reason: classified.reason ?? 'not-an-enum-value',
      });
      // 非法枚举 → 按 hold 计入（fail-closed，CC `w()`③）。
      candidates.push({ f: INBOUND_STRICTNESS.hold, mode: 'hold', source: 'invalid-setting', layer: 'invalid' });
      return;
    }
    candidates.push({
      f: INBOUND_STRICTNESS[classified.mode],
      mode: classified.mode,
      source,
      layer,
    });
  };

  await pushLayer('user', userRaw, 'explicit-setting');
  await pushLayer('env', envRaw, 'explicit-setting');

  if (repo.error !== undefined) {
    // 项目层文件**损坏/不可读** → 该层按非法取值计入（fail-closed 到 hold），
    // 与 CC 的「settings 校验报错 → invalidSetting → hold」同款（`w()`③ 的
    // `N()` 判据）。文件**不存在**（ENOENT）才是未设（repo.raw 为 undefined）。
    invalid = true;
    audits.push('peer-policy-invalid');
    await logEngineEvent(stateRoot, { event: 'peer-policy-invalid', layer: 'repo', reason: repo.error });
    candidates.push({ f: INBOUND_STRICTNESS.hold, mode: 'hold', source: 'invalid-setting', layer: 'invalid' });
  } else {
    await pushLayer('repo', repo.raw, 'repo-setting');
  }

  const winner = candidates.length > 0 ? pickStrictest(candidates) : undefined;
  const explicit = winner?.mode;
  const auto = winner === undefined;
  return {
    mode: killSwitch ? 'refuse' : (explicit ?? 'accept'),
    strictest: explicit ?? 'accept',
    ...(explicit === undefined ? {} : { explicit }),
    decidedBy: winner ? winner.source : 'mode-parity',
    killSwitch,
    auto,
    invalid,
    layers: {
      ...(userRaw === undefined ? {} : { user: userRaw }),
      ...(repo.raw === undefined ? {} : { repo: repo.raw }),
      ...(envRaw === undefined ? {} : { env: envRaw }),
    },
    audits,
  };
}

export interface ResolveInboundDecisionInput {
  workspace: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  /** 会话层显式覆盖值（一般不需要；默认读 env）。 */
  sessionInbound?: string;
  recvClass?: PeerModeClass | string;
  senderClass?: PeerModeClass | string;
  selfSent?: boolean;
  trustSenderClass?: boolean;
}

export interface ResolvedInboundDecision {
  decision: InboundDecision;
  resolution: PeerInboundPolicyResolution;
}

/**
 * 一步到位：解析层 → 裁决（供传输层/工具层调用，避免各写一遍组合逻辑）。
 */
export async function resolveInboundDecision(
  input: ResolveInboundDecisionInput,
): Promise<ResolvedInboundDecision> {
  const env = input.env ?? process.env;
  const resolution = await readPeerInboundPolicy(input.workspace, input.sessionId, env, {
    ...(input.sessionInbound === undefined ? {} : { sessionInbound: input.sessionInbound }),
  });
  const decision = decideInboundPolicy({
    ...(resolution.explicit === undefined ? {} : { explicit: resolution.explicit }),
    explicitSource: resolution.decidedBy,
    managedOff: resolution.killSwitch,
    ...(input.recvClass === undefined ? {} : { recvClass: input.recvClass }),
    ...(input.senderClass === undefined ? {} : { senderClass: input.senderClass }),
    ...(input.selfSent === undefined ? {} : { selfSent: input.selfSent }),
    ...(input.trustSenderClass === undefined ? {} : { trustSenderClass: input.trustSenderClass }),
  });
  return { decision, resolution };
}

// ---------------------------------------------------------------------------
// 收方档类（mode-parity 的输入）
// ---------------------------------------------------------------------------

export interface ReceiverModeClass {
  /** 收方档类；undefined = 未知（→ fail-closed hold(mode-unknown)）。 */
  cls?: PeerModeClass;
  source: 'base-record' | 'mode-class-fallback' | 'none';
}

/**
 * 读收方会话的基记录拿档类（DESIGN §6.2「档类来源」）。
 *
 * - `base/<sid>.json` 的 `permissionMode`（钩子派生，真源）；
 * - 缺失时用注册时登记的 `modeClass` 兜底（模型断言，可信度更低）并审计
 *   `peer-mode-class-fallback`（DESIGN §6.2 兜底条款）；
 * - 都没有 → undefined（调用方按 mode-unknown fail-closed）。
 */
export async function readReceiverModeClass(
  root: string,
  sessionId: string,
): Promise<ReceiverModeClass> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingBom(await readFile(peerBaseRecordFile(root, sessionId), 'utf8')));
  } catch {
    return { source: 'none' };
  }
  if (!isRecord(parsed)) return { source: 'none' };
  const direct = normalizeClass(parsed['permissionMode']);
  if (direct === 'bypass' || direct === 'prompting') return { cls: direct, source: 'base-record' };
  const fallback = normalizeClass(parsed['modeClass']);
  if (fallback === 'bypass' || fallback === 'prompting') {
    await logPeerEvent(root, {
      event: 'peer-mode-class-fallback',
      sessionId,
      modeClass: fallback,
    });
    return { cls: fallback, source: 'mode-class-fallback' };
  }
  return { source: 'none' };
}

// ---------------------------------------------------------------------------
// hold 缓冲（DESIGN §6.3 / §7.1；SPEC R-20/R-21）
// ---------------------------------------------------------------------------

/**
 * 投递队列项的结构子集。
 * W5 的 `PeerQueueItem`（DESIGN §7.2）字段更多，但**结构兼容**（TS 结构化
 * 赋值：多出来的字段不影响），因此 W5 的项可以直接传进来。
 */
export interface PeerHeldItem {
  msgId: string;
  from: string;
  fromSessionId?: string;
  fromName?: string;
  fromMode?: PeerModeClass;
  hopChain?: string[];
  text: string;
  summary?: string;
  ts: number;
  via?: 'pipe' | 'file';
  /** 自发标记（CC `origin.selfSent`；`k()`② 对它是放行）。 */
  selfSent?: boolean;
}

/**
 * 暂存原因：正常只取 `HoldCause` 的 8 个值；`(string & {})` 让**读到的**
 * 未知原因（比如别的写入方落的杂串）也能被如实承载，而不至于被静默改写。
 */
export type PeerHoldCause = HoldCause | (string & {});

/** 暂存文件中的一条记录（落盘形状）。 */
export interface PeerHeldMessage {
  item: PeerHeldItem;
  /** 最近一次暂存的原因。 */
  cause: PeerHoldCause;
  /** 已经播报过的原因集合（同一消息同一 cause 只播一次，CC @2901183）。 */
  announcedCauses: PeerHoldCause[];
  heldAt: number;
  expiresAt: number;
}

/**
 * 暂存区的一条记录 + 它的实际文件名。
 *
 * 文件名不固定：W1 的 `peerHeldFile` 用原始 msgId，本文件用安全化后的段
 * （msgId 来自对端，属不可信输入）。**读**按目录内容枚举（两种文件名都认），
 * **删**按实际文件名删——否则跨写入方时会留下孤儿文件。
 */
interface HeldEntry {
  file: string;
  held: PeerHeldMessage;
}

export interface HoldPeerMessageOptions {
  now?: number;
  /** 审批期限（默认由 `holdTtlMsFromEnv` 决定）。 */
  ttlMs?: number;
  /** 缓冲容量（默认 `HOLD_CAPACITY` = 100，对齐 CC `Q=100`）。 */
  capacity?: number;
  /** 缓冲满被逐出时的回调（调用方据此给发送方发 `expired` 回执）。 */
  onEvict?: (evicted: PeerHeldMessage) => void | Promise<void>;
  /** 同时把事件写进工作区侧 engine.jsonl（SPEC R-24）。 */
  workspace?: string;
}

export interface PeerHoldResult {
  msgId: string;
  /** 暂存文件路径。 */
  path: string;
  cause: HoldCause;
  /** 本次是否播报了 hold 事件（同 cause 重复暂存 → false）。 */
  announced: boolean;
  /** 因缓冲满而被逐出的最旧消息（若有）。 */
  evicted?: PeerHeldMessage;
}

export interface PeerHeldReleaseResult {
  msgId: string;
  /** 终态（CC outcome 四值 + `still-held` 内部态）。 */
  outcome: PeerHoldOutcome | 'delivered' | 'still-held';
  /** 给发送方的回执态（CC 六态）；会话结束丢弃时为 undefined。 */
  receipt?: PeerReceiptState;
  item: PeerHeldItem;
  cause: PeerHoldCause;
  detail?: string;
}

export interface ReleaseHeldOptions {
  now?: number;
  /**
   * 释放时**用当前策略重新裁决**（CC `A()` @34189000）。
   * 不给 → 保持暂存（fail-closed，不放行）。
   */
  adjudicate?: (held: PeerHeldMessage) => InboundDecision | Promise<InboundDecision>;
  /**
   * 放行后的投递动作（入队闸 + 入队由 W5/W6 负责）。
   * 返回 `false` / `{ok:false}` → 闸弃（终态 dropped）。
   */
  deliver?: (
    held: PeerHeldMessage,
  ) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>;
  /** 终态回调（调用方据此给发送方发 status 回执）。 */
  onOutcome?: (result: PeerHeldReleaseResult) => void | Promise<void>;
  /** 同时把事件写进工作区侧 engine.jsonl。 */
  workspace?: string;
}

async function logPeerEvent(
  root: string,
  event: { event: string } & Record<string, unknown>,
  workspace?: string,
): Promise<void> {
  try {
    await appendJsonl(peerAuditLogFile(root), [JSON.stringify({ ts: Date.now(), ...event })]);
  } catch {
    // 审计是 best-effort：写失败不得打断业务路径（同 core/log.ts 纪律）。
  }
  if (workspace !== undefined) {
    await logEngineEvent(resolveStateRoot(workspace), event);
  }
}

function isHeldMessage(value: unknown): value is PeerHeldMessage {
  return (
    isRecord(value) &&
    isRecord(value['item']) &&
    typeof (value['item'] as Record<string, unknown>)['msgId'] === 'string' &&
    typeof value['cause'] === 'string' &&
    typeof value['heldAt'] === 'number'
  );
}

/**
 * 暂存区枚举结果（v0.5.2 故障注-4 修复）：可读条目 + 损坏条目明细。
 *
 * 损坏件（不可解析 JSON / 形状非法）此前只落审计 `peer-held-malformed` 后被静默
 * 跳过——人工审阅面（xc_peer_review）看到的是「暂存区 0 条」，消息既不可见也不
 * 可处置、无任何计数（红队二番战 FI-9d）。现在枚举把损坏件透出，由工具面披露
 * `corrupted N 条`。
 */
export interface HeldScanResult {
  entries: HeldEntry[];
  corrupted: { file: string; error: string }[];
}

/**
 * 暂存区枚举（**容错读**：别的写入方落下的记录形状可能少字段）。
 *
 * - `expiresAt` 缺失 → 按 `heldAt + 默认 TTL` 补（审批期限从首次暂存起算）；
 * - `announcedCauses` 缺失 → 视为 `[cause]`（已播报过一次，避免重复播报）。
 *
 * v0.5.2（故障注-4 修复）：不可解析/形状非法的文件不再只进审计——收进
 * `corrupted` 列表随枚举结果返回，供审阅面披露计数与定位。
 */
async function scanHeldEntries(root: string, sessionId: string): Promise<HeldScanResult> {
  const dir = peerHeldDir(root, sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], corrupted: [] };
    throw error;
  }
  const entries: HeldEntry[] = [];
  const corrupted: { file: string; error: string }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(stripLeadingBom(await readFile(join(dir, name), 'utf8')));
      if (!isHeldMessage(parsed)) {
        await logPeerEvent(root, { event: 'peer-held-malformed', file: name });
        corrupted.push({ file: name, error: 'not a valid held-message record' });
        continue;
      }
      const cause = parsed['cause'] as PeerHoldCause;
      const causes = Array.isArray(parsed['announcedCauses'])
        ? (parsed['announcedCauses'] as unknown[]).filter((c): c is PeerHoldCause => typeof c === 'string')
        : [cause];
      const heldAt = parsed['heldAt'];
      const expiresAt =
        typeof parsed['expiresAt'] === 'number' ? parsed['expiresAt'] : heldAt + DEFAULT_HOLD_TTL_MS;
      entries.push({
        file: join(dir, name),
        held: { ...parsed, cause, announcedCauses: causes, heldAt, expiresAt },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      await logPeerEvent(root, { event: 'peer-held-malformed', file: name, error: String(error) });
      corrupted.push({ file: name, error: String(error) });
    }
  }
  entries.sort(
    (a, b) => (a.held.heldAt - b.held.heldAt) || a.held.item.msgId.localeCompare(b.held.item.msgId),
  );
  return { entries, corrupted };
}

/**
 * v0.5.2（故障注-4 修复）：暂存区枚举 + 损坏件计数（审阅面披露用）。
 * 坏件（不可解析/形状非法）进 `corrupted`，不再对人工审阅者完全不可见。
 */
export async function listHeldPeerMessagesDetailed(
  root: string,
  sessionId: string,
): Promise<{ held: PeerHeldMessage[]; corrupted: { file: string; error: string }[] }> {
  const scan = await scanHeldEntries(root, sessionId);
  return { held: scan.entries.map((entry) => entry.held), corrupted: scan.corrupted };
}

/** 列出暂存区全部消息（按 heldAt 升序，再按 msgId 稳定排序）。 */
export async function listHeldPeerMessages(root: string, sessionId: string): Promise<PeerHeldMessage[]> {
  return (await scanHeldEntries(root, sessionId)).entries.map((entry) => entry.held);
}

async function writeHeldMessage(
  root: string,
  sessionId: string,
  held: PeerHeldMessage,
  file?: string,
): Promise<string> {
  const target = file ?? peerHeldFile(root, sessionId, held.item.msgId);
  await mkdir(peerHeldDir(root, sessionId), { recursive: true });
  await writeFileAtomic(target, JSON.stringify(held, null, 2));
  return target;
}

async function removeHeldFile(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * 把一条消息放进 hold 隔离区（模型不可见、不可执行）。
 *
 * - 落盘 `held/<sessionId>/<msgId>.json`（不进 queue/，DESIGN §7.1）；
 * - 缓冲容量 100（CC `Q=100`），满则逐出最旧者并记终态 `expired`；
 * - 事件 `peer_message_hold{state:'held',cause,msgId,from,lane}`，
 *   **同一消息同一 cause 只发一次**（CC @2901183），cause 变化可再次播报。
 */
export async function holdPeerMessage(
  root: string,
  sessionId: string,
  item: PeerHeldItem,
  cause: HoldCause,
  options: HoldPeerMessageOptions = {},
): Promise<PeerHoldResult> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? holdTtlMsFromEnv();
  const capacity = options.capacity ?? HOLD_CAPACITY;

  const entries = (await scanHeldEntries(root, sessionId)).entries;
  const existingEntry = entries.find((entry) => entry.held.item.msgId === item.msgId);
  const existing = existingEntry?.held;

  let evicted: PeerHeldMessage | undefined;
  const held: PeerHeldMessage = existing
    ? {
        ...existing,
        cause,
        announcedCauses: existing.announcedCauses.includes(cause)
          ? existing.announcedCauses
          : [...existing.announcedCauses, cause],
      }
    : { item, cause, announcedCauses: [cause], heldAt: now, expiresAt: now + ttlMs };

  if (!existing) {
    const current = (await scanHeldEntries(root, sessionId)).entries;
    while (current.length >= capacity) {
      const oldest = current.shift();
      if (oldest === undefined) break;
      await removeHeldFile(oldest.file);
      evicted = oldest.held;
      await logPeerEvent(
        root,
        {
          event: 'peer_message_hold',
          msgId: oldest.held.item.msgId,
          from: oldest.held.item.from,
          state: 'dropped',
          outcome: 'expired',
          lane: oldest.held.item.via ?? 'pipe',
        },
        options.workspace,
      );
      await options.onEvict?.(oldest.held);
    }
  }

  const path = await writeHeldMessage(root, sessionId, held, existingEntry?.file);
  // 同一消息同一 cause 只播一次（CC @2901183）；cause 变化可再次播报。
  const announced = existing === undefined || !existing.announcedCauses.includes(cause);
  if (announced) {
    await logPeerEvent(
      root,
      {
        event: 'peer_message_hold',
        msgId: item.msgId,
        from: item.from,
        state: 'held',
        cause,
        lane: item.via ?? 'pipe',
      },
      options.workspace,
    );
  }
  return {
    msgId: item.msgId,
    path,
    cause,
    announced,
    ...(evicted === undefined ? {} : { evicted }),
  };
}

/**
 * 释放暂存消息（CC `A()` @34189000 的释放路径）。
 *
 * 每条消息**用当前策略重新裁决**：
 * - 仍 refuse → 丢弃 + 回执 `refused`；
 * - 仍 hold → 留在暂存区（`still-held`，无回执变化）；
 * - accept → 过入队闸放行（`deliver` 回调）→ 回执 `delivered`；
 *   闸弃 → 终态 `dropped`、回执 `dropped`。
 *
 * 不给 `adjudicate` → 一律留在暂存区（fail-closed）。
 */
export async function releaseHeldMessages(
  root: string,
  sessionId: string,
  ids: readonly string[],
  options: ReleaseHeldOptions = {},
): Promise<PeerHeldReleaseResult[]> {
  const now = options.now ?? Date.now();
  const all = (await scanHeldEntries(root, sessionId)).entries;
  const wanted = new Set(ids);
  const selected = ids.length === 0 ? all : all.filter((entry) => wanted.has(entry.held.item.msgId));
  const results: PeerHeldReleaseResult[] = [];

  for (const entry of selected) {
    const held = entry.held;
    const decision = options.adjudicate ? await options.adjudicate(held) : undefined;
    if (decision === undefined || decision.policy === 'hold') {
      results.push({
        msgId: held.item.msgId,
        outcome: 'still-held',
        item: held.item,
        cause: held.cause,
      });
      continue;
    }
    if (decision.policy === 'refuse') {
      await removeHeldFile(entry.file);
      const result: PeerHeldReleaseResult = {
        msgId: held.item.msgId,
        outcome: 'refused',
        receipt: 'refused',
        item: held.item,
        cause: held.cause,
      };
      await logPeerEvent(
        root,
        {
          event: 'peer_message_hold',
          msgId: held.item.msgId,
          from: held.item.from,
          state: 'dropped',
          outcome: 'refused',
          lane: held.item.via ?? 'pipe',
        },
        options.workspace,
      );
      await options.onOutcome?.(result);
      results.push(result);
      continue;
    }
    // accept → 放行（过入队闸由 deliver 回调承担）。
    const delivery = options.deliver ? await options.deliver(held) : true;
    const ok = typeof delivery === 'boolean' ? delivery : delivery.ok;
    const reason = typeof delivery === 'boolean' ? undefined : delivery.reason;
    await removeHeldFile(entry.file);
    const result: PeerHeldReleaseResult = {
      msgId: held.item.msgId,
      outcome: ok ? 'delivered' : 'dropped',
      receipt: ok ? 'delivered' : 'dropped',
      item: held.item,
      cause: held.cause,
      ...(reason === undefined ? {} : { detail: reason }),
    };
    await logPeerEvent(
      root,
      {
        event: 'peer_message_hold',
        msgId: held.item.msgId,
        from: held.item.from,
        state: ok ? 'released' : 'dropped',
        ...(ok ? {} : { outcome: 'dropped' }),
        lane: held.item.via ?? 'pipe',
      },
      options.workspace,
    );
    await options.onOutcome?.(result);
    results.push(result);
  }
  void now;
  return results;
}

/**
 * 审阅丢弃（收方用户明确拒绝）：删除暂存文件，回执 `denied`
 * （SPEC R-20；CC `@36116756` 的 denied = 收方用户拒绝）。
 */
export async function discardHeldMessages(
  root: string,
  sessionId: string,
  ids: readonly string[],
  options: ReleaseHeldOptions = {},
): Promise<PeerHeldReleaseResult[]> {
  const all = (await scanHeldEntries(root, sessionId)).entries;
  const wanted = new Set(ids);
  const selected = ids.length === 0 ? all : all.filter((entry) => wanted.has(entry.held.item.msgId));
  const results: PeerHeldReleaseResult[] = [];
  for (const entry of selected) {
    const held = entry.held;
    await removeHeldFile(entry.file);
    const result: PeerHeldReleaseResult = {
      msgId: held.item.msgId,
      outcome: 'discarded',
      receipt: 'denied',
      item: held.item,
      cause: held.cause,
    };
    await logPeerEvent(
      root,
      {
        event: 'peer_message_hold',
        msgId: held.item.msgId,
        from: held.item.from,
        state: 'dropped',
        outcome: 'discarded',
        lane: held.item.via ?? 'pipe',
      },
      options.workspace,
    );
    await options.onOutcome?.(result);
    results.push(result);
  }
  return results;
}

/**
 * 审批期限到期：终态 `expired`（CC `@2903001`），回执 `expired`。
 */
export async function expireHeldMessages(
  root: string,
  sessionId: string,
  options: ReleaseHeldOptions & { now?: number } = {},
): Promise<PeerHeldReleaseResult[]> {
  const now = options.now ?? Date.now();
  const all = (await scanHeldEntries(root, sessionId)).entries;
  const results: PeerHeldReleaseResult[] = [];
  for (const entry of all) {
    const held = entry.held;
    if (held.expiresAt > now) continue;
    await removeHeldFile(entry.file);
    const result: PeerHeldReleaseResult = {
      msgId: held.item.msgId,
      outcome: 'expired',
      receipt: 'expired',
      item: held.item,
      cause: held.cause,
    };
    await logPeerEvent(
      root,
      {
        event: 'peer_message_hold',
        msgId: held.item.msgId,
        from: held.item.from,
        state: 'dropped',
        outcome: 'expired',
        lane: held.item.via ?? 'pipe',
      },
      options.workspace,
    );
    await options.onOutcome?.(result);
    results.push(result);
  }
  return results;
}

/**
 * 会话结束时的清扫：仍在暂存的消息终态 `discarded`（无回执——会话已亡，
 * CC `@2903001` 的 discarded 语义）。
 */
export async function discardAllHeldMessages(
  root: string,
  sessionId: string,
  options: ReleaseHeldOptions = {},
): Promise<PeerHeldReleaseResult[]> {
  const all = (await scanHeldEntries(root, sessionId)).entries;
  const results: PeerHeldReleaseResult[] = [];
  for (const entry of all) {
    const held = entry.held;
    await removeHeldFile(entry.file);
    const result: PeerHeldReleaseResult = {
      msgId: held.item.msgId,
      outcome: 'discarded',
      item: held.item,
      cause: held.cause,
    };
    await logPeerEvent(
      root,
      {
        event: 'peer_message_hold',
        msgId: held.item.msgId,
        from: held.item.from,
        state: 'dropped',
        outcome: 'discarded',
        lane: held.item.via ?? 'pipe',
      },
      options.workspace,
    );
    await options.onOutcome?.(result);
    results.push(result);
  }
  // 暂存目录空了就删掉（与 v0.2 policy.ts 的空队列纪律一致）。
  try {
    await rm(peerHeldDir(root, sessionId), { recursive: true, force: true });
  } catch {
    // 目录清理失败不影响终态记账。
  }
  return results;
}
