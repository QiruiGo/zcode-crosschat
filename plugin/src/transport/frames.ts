/**
 * W2 transport：跨会话 wire 帧白名单（DESIGN-V0.3.md §4.2 / §4.3；
 * SPEC-V0.3.md R-13 / R-14 / R-30；CC 依据见 reports/11-cc逆向.md §3.b-2）。
 *
 * 域边界：跨会话域四帧（auth / msg / control / status），与队内域六帧
 * （core/mailbox.ts 的 FRAME_TYPES）**互不通用**——跨会话通道收到队内帧型即按
 * R-14 拒收（DESIGN-V0.3.md §8.2 第 2 条）。
 *
 * 线协议（照抄 CC 语义，见 SPEC §5.1）：
 * - 行界 = `\n`，每行一个 JSON 对象（CC `FDs(e)` @3376940）。
 * - **首帧必须 auth**：`{type:"auth",token}`，token = 32 位小写 hex
 *   （CC `hXi()` + `be=/^[0-9a-f]{32}$/` @3373352）。未鉴权行 → 断连
 *   （CC @36107247）。
 * - 单行上限 1 048 576 B（含 `\n`；CC `h0n` @9591760）。
 * - msg 帧预算：`len(JSON(msg)) + len(authLine) + 1 ≤ 1 MiB`（CC `he()` @9597797）。
 *
 * 白名单纪律（R-14）：
 * - 非白名单 `type` → 丢弃 + 审计（CC「Ignoring message without valid type field」
 *   @36100801）。
 * - **字段封闭**：每种帧的字段集是白名单，出现任何未知字段即拒收（比「值检查」
 *   更硬）。这同时是「权限规则永不入帧」的安全规则①的落地方
 *   （CC @39642020「permission rules are never accepted from the inbox」）：
 *   即使对端显式发来 permission / mode 之类字段，也进不了封闭字段集。
 * - `control` 只支持 `action:"rename"`，其他 action → 丢弃 + 审计（R-14）。
 *
 * 状态词表：`status` 帧的 state 取**六态**并集（held / denied / expired /
 * delivered / refused / dropped，CC `Ae(e)` @36116756 + DESIGN §7.4 回执六态）。
 * 注：SPEC R-13 的帧表只列了 held/delivered/refused/dropped 四值，而 §7.4 与
 * R-24 要求「异步终态经 status 帧补送」且回执词表是六态——两处口径不一致，
 * 本实现取**并集**（能力不减），并在此显式登记该口径差。
 *
 * 本文件零内部依赖（不 import core/*），可独立单测。
 *
 * @module transport/frames
 */

/** 跨会话域四帧白名单（R-13）。 */
export const PEER_FRAME_TYPES = ['auth', 'msg', 'control', 'status'] as const;

export type PeerFrameType = (typeof PEER_FRAME_TYPES)[number];

/** 鉴权帧：必须首帧。 */
export interface AuthFrame {
  type: 'auth';
  /** 32 位小写 hex（peerToken 或 childToken）。 */
  token: string;
}

/** 消息帧：发→收。 */
export interface MsgFrame {
  type: 'msg';
  /** 幂等键（对齐 CC `msg_id`）。 */
  msgId: string;
  /** 发送方 peer 名（名字即地址）。 */
  from: string;
  /** 发送方会话 id（可选）。 */
  fromSessionId?: string;
  /** 消息正文，自由文本，非空。 */
  text: string;
  /** 摘要（可选，对齐 SendMessage 的 summary 参数）。 */
  summary?: string;
  /** 发方权限档类断言（zcode 增设字段，R-19）。 */
  senderMode?: 'bypass' | 'prompting';
  /** v0.5（R-11）：作者身份标记；发送构造仅 "user" 时写出（agent 缺省不写，旧端点兼容）。 */
  origin?: 'user' | 'agent';
  /** v0.5（R-11）：最初作者会话（origin=user 时为用户输入所在会话）。 */
  originSessionId?: string;
}

/** 控制帧：v0.3 只支持 rename（R-14）。 */
export interface ControlFrame {
  type: 'control';
  action: 'rename';
  /** 新名字。 */
  name: string;
  /** 改名者的会话 id（可选）。 */
  sessionId?: string;
}

/** 回执状态六态（CC `Ae(e)` @36116756；DESIGN §7.4）。 */
export const PEER_RECEIPT_STATES = [
  'held',
  'denied',
  'expired',
  'delivered',
  'refused',
  'dropped',
] as const;

export type PeerReceiptState = (typeof PEER_RECEIPT_STATES)[number];

/** 状态帧：收→发（异步回执）。 */
export interface StatusFrame {
  type: 'status';
  msgId: string;
  state: PeerReceiptState;
  detail?: string;
}

export type PeerFrame = AuthFrame | MsgFrame | ControlFrame | StatusFrame;

/** 单行上限（含 `\n`）——CC `h0n=1048576` @9591760 / R-30。 */
export const PEER_MAX_LINE_BYTES = 1_048_576;

/** 首行（auth）期限 ——CC `L2r=30000` @36093286 / R-30。 */
export const PEER_AUTH_DEADLINE_MS = 30_000;

/** 令牌格式 ——CC `be=/^[0-9a-f]{32}$/` @3373352。 */
export const PEER_TOKEN_RE = /^[0-9a-f]{32}$/;

/** 发送默认超时 ——R-32（zcode 增设值，取 CC 桥 HTTP 超时 10 s @27758436 的同量级）。 */
export const PEER_SEND_TIMEOUT_MS = 10_000;

/**
 * peer 端点并发连接上限（v0.5.1，CONC-3/并发与-3 修复）。
 *
 * 根因（裁决 #8 confirmed，P2）：旧缺省 32 低于产品主路径的现实 fan-in 突发——
 * `xc_peer_send` 每次调用开一条新连接（sendPeerFrame→connect），红队实测 9 发送者
 * ×5 条同 tick 并发 = 45 条在途连接，超 32 的 13 条被端点以 `endpoint-busy` 拒收
 * （45−32=13、40−32=8、35−32=3，三档与实测逐位吻合：adjudication.md #8）。
 * 一对多 fan-in（lead 派发/成员回执）是产品主路径，max_members 上限 8，128 覆盖
 * 8 成员 ×在途突发 ×余量；端点仍有界（auth 期限 30s 掐死无主连接），超过 128
 * 的突发依旧显式 busy（fail-closed），README 已知限制 6 同步声明该上限。
 */
export const PEER_MAX_CONNECTIONS = 128;

/**
 * 权限类黑名单字段名（R-14 安全规则①的显式落点）。
 *
 * 封闭字段集本身已经挡住这些键；这里再列一份是为了：(1) 审计信息更明确；
 * (2) 将来若某帧要放开字段，第一道闸仍然是「权限类字段一律拒收」。
 */
export const PEER_FORBIDDEN_FIELDS = [
  'permission',
  'permissions',
  'permissionRules',
  'permission_rules',
  'permissionMode',
  'permission_mode',
  'mode',
  'modeSet',
  'mode_set',
  'mode_set_request',
  'team_permission_update',
  'rules',
] as const;

/** 每种帧的封闭字段集（R-14）。 */
const FRAME_FIELDS: Record<PeerFrameType, readonly string[]> = {
  auth: ['type', 'token'],
  msg: ['type', 'msgId', 'from', 'fromSessionId', 'text', 'summary', 'senderMode', 'origin', 'originSessionId'],
  control: ['type', 'action', 'name', 'sessionId'],
  status: ['type', 'msgId', 'state', 'detail'],
};

export type FrameValidation =
  | { ok: true; frame: PeerFrame }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function optionalNonEmptyString(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  return nonEmptyString(value);
}

/**
 * 校验一个已解析的值是否是一帧合法的跨会话帧。
 *
 * 失败原因分三类（都不可接受，调用方一律丢弃 + 审计）：
 * 1. `unknown frame type` —— 非白名单 type（CC @36100801）；
 * 2. `unknown field` —— 封闭字段集外的键（含权限类字段）；
 * 3. 其余为字段级原因（类型/取值/非空）。
 */
export function validateFrame(value: unknown): FrameValidation {
  if (!isPlainObject(value)) return { ok: false, reason: 'frame is not a JSON object' };

  const type = value['type'];
  if (typeof type !== 'string') return { ok: false, reason: 'frame has no type field' };
  if (!(PEER_FRAME_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: `unknown frame type: ${type}` };
  }
  const frameType = type as PeerFrameType;

  for (const key of Object.keys(value)) {
    if (FRAME_FIELDS[frameType].includes(key)) continue;
    if ((PEER_FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, reason: `forbidden field in ${frameType} frame: ${key}` };
    }
    return { ok: false, reason: `unknown field in ${frameType} frame: ${key}` };
  }

  switch (frameType) {
    case 'auth': {
      const token = value['token'];
      if (!nonEmptyString(token)) return { ok: false, reason: 'auth frame needs a token' };
      if (!PEER_TOKEN_RE.test(token)) return { ok: false, reason: 'auth token is not 32 hex chars' };
      return { ok: true, frame: { type: 'auth', token } };
    }
    case 'msg': {
      const msgId = value['msgId'];
      const from = value['from'];
      const text = value['text'];
      if (!nonEmptyString(msgId)) return { ok: false, reason: 'msg frame needs a msgId' };
      if (!nonEmptyString(from)) return { ok: false, reason: 'msg frame needs a from name' };
      if (!nonEmptyString(text)) return { ok: false, reason: 'msg frame needs a non-empty text' };
      const fromSessionId = value['fromSessionId'];
      const summary = value['summary'];
      const senderMode = value['senderMode'];
      if (!optionalNonEmptyString(fromSessionId)) {
        return { ok: false, reason: 'msg frame fromSessionId must be a non-empty string' };
      }
      if (!optionalNonEmptyString(summary)) {
        return { ok: false, reason: 'msg frame summary must be a non-empty string' };
      }
      if (senderMode !== undefined && senderMode !== 'bypass' && senderMode !== 'prompting') {
        return { ok: false, reason: 'msg frame senderMode must be bypass or prompting' };
      }
      // v0.5（R-11）：origin 只允许两值；originSessionId 须为非空字符串。
      const origin = value['origin'];
      if (origin !== undefined && origin !== 'user' && origin !== 'agent') {
        return { ok: false, reason: 'msg frame origin must be "user" or "agent"' };
      }
      const originSessionId = value['originSessionId'];
      if (originSessionId !== undefined && !optionalNonEmptyString(originSessionId)) {
        return { ok: false, reason: 'msg frame originSessionId must be a non-empty string' };
      }
      const frame: MsgFrame = { type: 'msg', msgId, from, text };
      if (fromSessionId !== undefined) frame.fromSessionId = fromSessionId;
      if (summary !== undefined) frame.summary = summary;
      if (senderMode !== undefined) frame.senderMode = senderMode;
      if (origin === 'user') {
        frame.origin = 'user';
        if (originSessionId !== undefined) frame.originSessionId = originSessionId;
      }
      // origin === 'agent' 或缺失 → 不落字段（缺省语义）；originSessionId 随之丢弃——
      // 溯源属性只随 user 标记有意义。旧端点帧无两键 → 照常解析为 agent（R-11 兼容）。
      return { ok: true, frame };
    }
    case 'control': {
      const action = value['action'];
      if (action !== 'rename') {
        return { ok: false, reason: `control action is not allowed: ${String(action)}` };
      }
      const name = value['name'];
      if (!nonEmptyString(name)) return { ok: false, reason: 'control frame needs a name' };
      const sessionId = value['sessionId'];
      if (!optionalNonEmptyString(sessionId)) {
        return { ok: false, reason: 'control frame sessionId must be a non-empty string' };
      }
      const frame: ControlFrame = { type: 'control', action: 'rename', name };
      if (sessionId !== undefined) frame.sessionId = sessionId;
      return { ok: true, frame };
    }
    case 'status': {
      const msgId = value['msgId'];
      const state = value['state'];
      if (!nonEmptyString(msgId)) return { ok: false, reason: 'status frame needs a msgId' };
      if (typeof state !== 'string' || !(PEER_RECEIPT_STATES as readonly string[]).includes(state)) {
        return { ok: false, reason: `status frame has an unknown state: ${String(state)}` };
      }
      const detail = value['detail'];
      if (detail !== undefined && typeof detail !== 'string') {
        return { ok: false, reason: 'status frame detail must be a string' };
      }
      const frame: StatusFrame = { type: 'status', msgId, state: state as PeerReceiptState };
      if (detail !== undefined) frame.detail = detail;
      return { ok: true, frame };
    }
    default:
      return { ok: false, reason: `unknown frame type: ${frameType}` };
  }
}

/**
 * 编码一帧为「单行 JSON + `\n`」。
 *
 * 编码前先过一遍校验（非法帧抛错，不产出线上字节）；编码后检查行字节数上限
 * （R-30）——超限抛 `peer frame too large`（发送侧据此报 `too_large`）。
 */
export function encodeFrame(frame: PeerFrame): string {
  const validation = validateFrame(frame);
  if (!validation.ok) {
    throw new Error(`cannot encode invalid peer frame: ${validation.reason}`);
  }
  const line = `${JSON.stringify(validation.frame)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > PEER_MAX_LINE_BYTES) {
    throw new Error(`peer frame too large: ${bytes} bytes > ${PEER_MAX_LINE_BYTES}`);
  }
  return line;
}

/**
 * 解码一行（不含行界 `\n`，含也可）为一个帧。
 *
 * 失败一律返回 `{ok:false, reason}`——调用方（pipe.ts）据此丢弃 + 审计，
 * 绝不抛异常（transport 层不因对端脏数据崩）。
 */
export function decodeFrame(line: string): FrameValidation {
  const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
  if (trimmed.trim() === '') return { ok: false, reason: 'empty line' };
  if (Buffer.byteLength(trimmed, 'utf8') > PEER_MAX_LINE_BYTES) {
    return { ok: false, reason: `line exceeds ${PEER_MAX_LINE_BYTES} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'line is not valid JSON' };
  }
  return validateFrame(parsed);
}

/** 鉴权帧的线上形态（`{type:"auth",token}\n`）——CC `FDs(e)` @3376940。 */
export function peerAuthLine(token: string): string {
  if (!PEER_TOKEN_RE.test(token)) {
    throw new Error('peer auth token must be 32 hex chars');
  }
  return `${JSON.stringify({ type: 'auth', token })}\n`;
}

/** 鉴权行的字节数（msg 帧预算公式里的 auth 开销项）。 */
export function peerAuthLineBytes(token: string): number {
  return Buffer.byteLength(peerAuthLine(token), 'utf8');
}

/**
 * msg 帧预算（R-30 / CC `he()` @9597797）：
 * `len(JSON(msg)) + len(authLine) + 1 ≤ 1 MiB`。
 *
 * 这里按**字节**计（CC 用字符串长度；多字节文本时字节数更接近线上真实占用，
 * 且与单行上限的口径一致——单行上限是字节）。
 */
export function msgBudgetBytes(msg: MsgFrame, token: string): number {
  const body = Buffer.byteLength(JSON.stringify(msg), 'utf8');
  return body + peerAuthLineBytes(token) + 1;
}

/** 预算判定：超限即 `too_large`（R-32 错误分类）。 */
export function checkMsgBudget(
  msg: MsgFrame,
  token: string,
): { ok: boolean; bytes: number; limit: number; reason?: string } {
  const bytes = msgBudgetBytes(msg, token);
  if (bytes > PEER_MAX_LINE_BYTES) {
    return {
      ok: false,
      bytes,
      limit: PEER_MAX_LINE_BYTES,
      reason: `msg budget ${bytes} bytes exceeds ${PEER_MAX_LINE_BYTES}`,
    };
  }
  return { ok: true, bytes, limit: PEER_MAX_LINE_BYTES };
}

/** 帧型的快速判定（不做全量校验）——审计与分流用。 */
export function frameTypeOf(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const type = value['type'];
  return typeof type === 'string' ? type : undefined;
}
