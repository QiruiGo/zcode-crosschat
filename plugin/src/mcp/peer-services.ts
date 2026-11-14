/**
 * v0.6 M1（DESIGN-V0.6.md §4.1）：跨会话 peer 服务装配——原 peer-tools.ts 的
 * PeerServices 接口与默认实现 1:1 迁入（server.tool 注册面拆入家族文件
 * tools-identify/read/relay/overview/review；本模块是纯服务层，供五个家族共用）。
 *
 * v0.6 砍除（§2.2 行 2/3/4）：PeerRegisterInput.regToken（锚定令牌硬闸）、
 * PeerSendInput.forwardOf（转发溯源链）、队列项 forged 盖标（对抗检测）——
 * 软校验保留：session_id_in_use（活 sid 冲突）、session_not_anchored（锚定存在性）、
 * name_taken（先到者为准）、cannot_send_self、入队四闸与入站三态。
 *
 * 依据：DESIGN-V0.3.md §8.1（七工具表）、§8.2（与队内工具分立的理由）、
 * §8.3（观测面）、§7.4（回执六态）、§7.5（发送侧权限防线）；SPEC-V0.3.md
 * R-7 ~ R-14 / R-17 / R-24 / R-29 / R-32；CC 机制标尺 reports/11-cc逆向.md
 * §3.b-2（SendMessage @34233387 / ListAgents @8463121）。
 *
 * 与队内工具的关系（DESIGN §8.2）：**发送面分立**。跨会话 peer 消息不经过
 * `xc_register`（队内注册），因此「两个无任何团队关系」的会话也能互发（硬验收 1）。
 * 队内 13 个 `xc_*` 工具一字不改。
 *
 * 装配形态：工具层只依赖 `PeerServices` 接口（测试注入假实现，不依赖真实管道）；
 * 默认实现 `createDefaultPeerServices()` 静态接 W1（注册表/路径）、W3（寻址）、
 * W4（入站三态/暂存区）、W5（队列/信封）四个并行模块——依赖方向 W1 → W6 单向
 * 无环（DESIGN §10.1 的依赖纪律）。
 *
 * 发送侧权限防线（R-17 / CC @34233402）：`xc_peer_send` 的工具描述内嵌反 launder
 * 警示；接收侧尾注里也有一份（D7 的对偶面，由 W5 的信封渲染器负责）。
 *
 * @module mcp/peer-services
 */
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { auditDegradationWarning, logEngineEvent } from "../core/log.js";
import { readTeam } from "../core/teamstate.js";
import {
  localPidDomain,
  peerInboxFile,
  peerKeyFile,
  peerRootFromEnv,
  readPeerBaseRecord,
} from "../core/peerdir.js";
import {
  logPeerEvent,
  peerRegistryLockName,
  PEER_FORMER_NAMES_MAX,
  readPeerKeyFile,
  readPeerRecord,
  scanPeers,
  touchPeerRecord,
  writePeerKeyFile,
  writePeerRecord,
  type PeerDeadReason,
  type PeerReclaimedFrom,
  type PeerRecord,
  type PeerScanResult,
} from "../core/peerregistry.js";
import { LockBusyError, withFileLock } from "../core/lock.js";
import {
  formatPeerRows,
  peerRowsFromRecord,
  resolvePeerTarget,
  sanitizePeerName,
  type PeerRow as AddressRow,
} from "../core/peeraddr.js";
import {
  discardHeldMessages,
  holdPeerMessage,
  listHeldPeerMessages,
  listHeldPeerMessagesDetailed,
  readReceiverModeClass,
  releaseHeldMessages,
  resolveInboundDecision,
  decideSessionInboundPolicy,
  type InboundDecision,
  type PeerHeldMessage,
  type PeerHeldReleaseResult,
  type PeerModeClass,
} from "../core/peerpolicy.js";
import {
  admitPeerMessage,
  appendPeerQueue,
  createRateBuckets,
  drainPeerQueue,
  PEER_MAX_HOP_DEPTH,
  PEER_RATE_LIMIT,
  PEER_RATE_WINDOW_MS,
  peerMaxQueueDepthFromEnv,
  peerQueueDepth,
  readPeerQueue,
  type PeerQueueItem,
  type RateBuckets,
} from "../core/peermsg.js";
import { queueItemToInjectBlock, renderPeerEnvelope } from "../core/peerenvelope.js";
import {
  batchWindowCount,
  contextCharsFromEnv,
  injectBlockCost,
  layoutInjectBlocks,
  paginateText,
  receiverInjectBudget,
  type InjectBudget,
} from "../core/budget.js";
import { resolvePeerMessage, storePeerMessageFull } from "../core/msgstore.js";
import { uservoiceMatchAndConsume, verifyUservoiceStampAuthority } from "../core/uservoice.js";
import { RESERVED_MEMBER_KEYS } from "../core/types.js";
import { leadKeyOf } from "./tools-team.js";
import {
  defaultPeerSocketPath,
  mintPeerTokens,
  sendPeerFrame,
  startPeerEndpoint,
  validatePeerSocketPath,
  type MsgFrame,
} from "../transport/pipe.js";
import { setPeerSessionContext, type PeerDrainBackend } from "./peer-drain.js";
import { errorResult, okResult, ToolError, type ToolPayload, type ToolResult } from "./protocol.js";
import type { ToolDeps } from "./core.js";

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

/**
 * v0.5.3（A4 修复）：花名 claim→写盘临界区的注册表锁等待预算（毫秒）。
 * 注册/改名是 MCP 工具调用（非 10s 钩子预算内），与 W1 心跳共用
 * `peerRegistryLockName` 同一把机器全局锁；竞争窗口 = 单次注册的
 * 扫描+端点起+记录落盘（实测 <1s），15s 与队内变更工具 LOCK_WAIT_MS 同级，
 * 超时给结构化 busy（可重试），绝不静默并存第二条同名活记录。
 */
export const PEER_REGISTER_LOCK_WAIT_MS = 15_000;

/**
 * v0.5.3（A4 修复）：XC_PEER_REGISTER_LOCK_WAIT_MS → 毫秒；非有限正数取缺省 15s。
 * 覆盖口供单测注入短预算（持锁竞争 → 快速 busy，不必等满 15s）。
 */
export function peerRegisterLockWaitMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env["XC_PEER_REGISTER_LOCK_WAIT_MS"];
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : PEER_REGISTER_LOCK_WAIT_MS;
}

/** 一行 peer（W3 的 PeerRow + 发送路径需要的注册记录指针）。 */
export interface PeerRow extends AddressRow {
  /** 注册记录（发送路径要拿 socket 路径与 pid）。 */
  record?: PeerRecord;
  pid?: number;
  socketPath?: string;
}

/** 回执六态（DESIGN §7.4；CC `Ae(e)` @36116756）。 */
export type PeerReceipt = 'held' | 'denied' | 'expired' | 'delivered' | 'refused' | 'dropped';

export interface PeerRegisterInput {
  name: string;
  sessionId: string;
  displayName?: string;
  kind?: 'interactive' | 'bg';
  /** 档类兜底：仅当钩子基记录里没有档类时才用（DESIGN §8.1）。 */
  modeClass?: 'bypass' | 'prompting';
  /** v0.5（R-18）：本会话上下文字符数声明（接收方注入预算刻度；声明值，非探测值）。 */
  contextChars?: number;
}

export interface PeerRegisterResult {
  name: string;
  sessionId: string;
  pid: number;
  socketPath: string;
  keyFile: string;
  /** 令牌指纹（前 8 位）；令牌本体不进工具结果（走 key 文件发布，R-6）。 */
  tokenHint: string;
  /** 档类来源：钩子基记录 / 显式兜底 / 未知。 */
  modeClassSource: 'base-record' | 'mode-class-fallback' | 'unknown';
}

/**
 * 发送入参（v0.6）：forwardOf 已砍（DESIGN §2.2 行 4）——message 必填；
 * 旧调用方携带 forwardOf 时由工具层显式报 forwardOf_removed（MIGRATION 指引
 * 「批注另发一条」）。
 */
export interface PeerSendInput {
  to: string;
  /** 消息正文（必填）。 */
  message: string;
  summary?: string;
}

/** v0.5（R-22）：xc_peer_read 入参——只读分页器，不消费。 */
export interface PeerReadInput {
  msgId: string;
  offset?: number;
  limit?: number;
}

/** v0.5（R-22）：xc_peer_read 返回。 */
export interface PeerReadResult {
  msgId: string;
  total: number;
  offset: number;
  text: string;
  hasMore: boolean;
}

export interface PeerSendResult {
  receipt: PeerReceipt;
  /** 投递通道：pipe（管道）/ file（收件箱退化）。 */
  via: 'pipe' | 'file';
  msgId: string;
  to: string;
  detail?: string;
}

export interface PeerReviewResult {
  action: 'list' | 'accept' | 'discard';
  held: { msgId: string; from: string; ts?: number; cause?: string }[];
  affected: string[];
  receipts: { msgId: string; receipt?: PeerReceipt; outcome?: string }[];
  /**
   * v0.5.2（故障注-4 修复）：暂存区里损坏（不可解析/形状非法、无法审阅也无法
   * 处置）的条目明细。非空时由摘要行披露 `corrupted N 条`——此前坏件被静默跳过，
   * 人工审阅者看到「暂存区 0 条」而发送方只知「已暂存」，消息无声消失。
   */
  corrupted?: { file: string; error: string }[];
}

export interface PeerRenameResult {
  name: string;
  formerName?: string;
  notified: { name: string; ok: boolean; errorClass?: string }[];
}

export interface PeerAgentsPanel {
  self?: PeerRow;
  peers: PeerRow[];
  /** v0.5（R-7）：成员行增 isLead（现算字段 `m.key===leadKeyOf(team)`，不入盘不入快照）。 */
  members: { key: string; role: string; state: string; unread: number; isLead: boolean }[];
  tasks: { pending: number; inProgress: number; done: number };
  inboundPolicy?: {
    mode: string;
    decidedBy: string;
    strictest?: string;
    auto?: boolean;
    /**
     * 会话级**查询面**的裁决（CC `H()` 的等价物，DESIGN §6.2 DV-2）。
     * 它与逐消息裁决（`decideInboundPolicy`）**可以不同**——例：收方 bypass +
     * 发方断言同档时，消息路径 accept，会话级查询 hold/bypass-default。
     * 面板同时展示两者，差异如实呈现（DESIGN §14 U16）。
     */
    sessionLevelQuery?: { policy: string; holdCause?: string };
  };
}

/** peer 服务面（工具层与实现层之间的唯一接缝；测试注入假实现）。 */
export interface PeerServices {
  register(input: PeerRegisterInput): Promise<PeerRegisterResult>;
  list(kind?: 'self' | 'member' | 'session'): Promise<PeerRow[]>;
  send(input: PeerSendInput): Promise<PeerSendResult>;
  /** v0.5（R-22）：全文分页读（只读不消费）。 */
  read(input: PeerReadInput): Promise<PeerReadResult>;
  /**
   * v0.5.1（P3 count 口径修复）：返回体增 `remaining` = 排空后队列里剩余的待投递条数。
   * v0.5.2（SCALE-3 修复）：入参增 `budget`（可选）——默认实现据此只消费
   * 「注入成本 ≤ 批次预算」的到达序窗口，窗口外消息留在队列（消费面不再
   * 「消费即省略」）。注入的假服务可忽略该参数。
   */
  inbox(limit: number, budget?: InjectBudget): Promise<{ items: PeerQueueItem[]; rendered: string[]; remaining: number }>;
  review(input: { action: 'list' | 'accept' | 'discard'; ids?: string[] }): Promise<PeerReviewResult>;
  rename(name: string): Promise<PeerRenameResult>;
  agents(): Promise<PeerAgentsPanel>;
}

export interface PeerToolDeps extends ToolDeps {
  /** 注入的 peer 服务（缺省走默认装配）。 */
  peer?: PeerServices;
  /** 注入的投递排空后端（单测用；缺省走 core/peermsg 的真实队列）。 */
  peerDrain?: PeerDrainBackend;
}

// ---------------------------------------------------------------------------
// 默认服务实现
// ---------------------------------------------------------------------------

/**
 * 默认 peer 服务：接 W1（注册表）、W3（寻址）、W4（三态/暂存）、W5（队列/信封）。
 */
export function createDefaultPeerServices(deps: ToolDeps): PeerServices {
  /** 本会话上下文（注册后才有；未注册时发送面一律拒）。 */
  let self: { sessionId: string; name?: string; socketPath?: string; pid: number } | undefined;

  const root = (): string => peerRootFromEnv(deps.env);

  /** peer 行（self / member / session）。 */
  async function rowsOf(kind: 'self' | 'member' | 'session'): Promise<PeerRow[]> {
    const rows: PeerRow[] = [];
    if (kind === 'self' || kind === 'session') {
      const scanned = await scanPeers(root());
      for (const record of scanned.active) {
        const isSelf = record.pid === process.pid;
        if (kind === 'self' && !isSelf) continue;
        if (kind === 'session' && isSelf) continue;
        for (const row of peerRowsFromRecord(record, isSelf ? 'self' : 'session')) {
          rows.push({ ...row, record, pid: record.pid, socketPath: record.messagingSocketPath });
        }
      }
    }
    if (kind === 'member') {
      // 队内成员行（队内域只读，不改队内任何东西）。
      const team = await readTeam(deps.stateRoot, "default");
      for (const member of team?.members ?? []) {
        rows.push({
          name: member.key,
          kind: 'member',
          ref: member.key.slice(0, 8),
          identity: `${member.key}@default`,
          status: member.state ?? 'ready',
        });
      }
    }
    return rows;
  }

  /**
   * 列表口径（DESIGN §8.1 / §9.2）：**不指定 kind 时返回三类行**（self / member /
   * session）——CC 的 ListAgents 一次给出全部可寻址会话，且硬验收 2 要求
   * 「`xc_peers` 里同时出现 `self(alice)` 与 `session(bob)`」以及「在队成员行与
   * peer 行同表」。故缺省不是「只列 session」。
   */
  async function listRows(kind?: 'self' | 'member' | 'session'): Promise<PeerRow[]> {
    if (kind !== undefined) return await rowsOf(kind);
    const [self, member, session] = await Promise.all([
      rowsOf('self'),
      rowsOf('member'),
      rowsOf('session'),
    ]);
    return [...self, ...member, ...session];
  }

  /** 读某个 peer 发布的 key 文件（令牌发布渠道，R-6）。 */
  async function readPeerKey(
    record: PeerRecord,
  ): Promise<{ ok: true; peerToken: string } | { ok: false; reason: string; errorClass: 'invalid_target' }> {
    const keyFile = peerKeyFile(root(), record.pid, record.messagingSocketPath);
    try {
      const stat = await lstat(keyFile);
      if (stat.isSymbolicLink()) {
        // R-33：连接发送禁跟随符号链接——key 文件是符号链接即判不可信。
        return { ok: false, reason: 'key file is a symlink', errorClass: 'invalid_target' };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `key file is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        errorClass: 'invalid_target',
      };
    }
    const content = await readPeerKeyFile(root(), record.pid, record.messagingSocketPath);
    if (content === undefined) {
      return { ok: false, reason: 'key file carries no usable peer token', errorClass: 'invalid_target' };
    }
    if (!/^[0-9a-f]{32}$/.test(content.peerToken)) {
      return { ok: false, reason: 'key file token is malformed', errorClass: 'invalid_target' };
    }
    if (content.pidDomain !== undefined && content.pidDomain !== localPidDomain()) {
      return { ok: false, reason: 'key file belongs to another pid domain', errorClass: 'invalid_target' };
    }
    return { ok: true, peerToken: content.peerToken };
  }

  /** 给发送方补一帧回执（异步终态：denied/expired，R-24）。 */
  async function sendReceipt(
    record: PeerRecord | undefined,
    msgId: string,
    state: PeerReceipt,
    detail?: string,
  ): Promise<void> {
    if (record === undefined) return;
    const key = await readPeerKey(record);
    if (!key.ok) return;
    await sendPeerFrame({
      socketPath: record.messagingSocketPath,
      token: key.peerToken,
      frame: { type: 'status', msgId, state, ...(detail !== undefined ? { detail } : {}) },
    }).catch(() => undefined);
  }

  /** 按 sessionId 找发方的注册记录（回执用）。 */
  async function recordOfSession(sessionId: string | undefined): Promise<PeerRecord | undefined> {
    if (sessionId === undefined) return undefined;
    const scanned = await scanPeers(root());
    return scanned.active.find((record) => record.sessionId === sessionId);
  }

  return {
    async register(input: PeerRegisterInput): Promise<PeerRegisterResult> {
      const r = root();
      const sanitized = sanitizePeerName(input.name);
      if (!sanitized.ok) {
        throw new ToolError({ error: "invalid_params", reason: sanitized.reason }, sanitized.reason);
      }
      const name = sanitized.name;
      // v0.5.2（二番战 peer-3 修复）：保留名防线与队内轴对齐（identity.ts /
      // member-tools.ts 同一张 RESERVED_MEMBER_KEYS 表、同一个 name_reserved 码）。
      // peer 轴此前只挡 addressing 层的 PEER_RESERVED_NAMES（main/team-lead/
      // user/system），字面花名 lead/default 可以注册也可以改名过去——与 lead
      // 角色语义、缺省 teamId 撞名，是一条注册旁路。
      assertPeerNameNotReserved(name);

      // v0.5.3（A4 修复）：花名 claim→写盘临界区加机器全局注册表锁。adj052 A4：
      // 此前 scanPeers 与 writePeerRecord 之间无互斥，同一毫秒并发注册同一活名
      // 4/4 全成功——名字即地址的机制下同名多持有污染名册（裸名投递 fail-closed
      // 为 ambiguous_target，但接管零审计、地址换人不可观测）。临界区 = 单次扫描
      // → sid 归属校验 → 花名 claim → 端点起 → 记录/key 落盘 → 注册审计，全部
      // 在 `peerRegistryLockName` 文件锁内串行（与 W1 心跳 touchPeerRecord 同锁；
      // 锁内不嵌套取同一把锁——临界区里只做无锁 IO）。竞争败者显式 name_taken
      // （fail-closed）；锁超时给结构化 busy（PEER_REGISTER_LOCK_WAIT_MS）。
      return await withFileLock(r, peerRegistryLockName(r), async (): Promise<PeerRegisterResult> => {
        // v0.5.2（二番战 SEC-1 / SEC-2 修复）：sessionId 归属硬校验——该 sid 已被
        // 一个**别的活进程**注册时拒绝（session_id_in_use）。旧实现完全不查，攻击者
        // 用公开 MCP API 冒充受害者 sid 即可三重得手（rtsec C2）：fromSessionId/
        // originSessionId 归因到受害者、命中受害者的 uservoice 偷走 origin=user
        // 权威标记、同一 sid 两条注册记录并存；sid 碰撞还会造成投递黑洞（rtsec C3：
        // 发送方注册 sid=目标 sid 时回执 delivered 但消息永不到达）——两者共用同一
        // 根因（注册不验归属），同一道闸封堵。校验对象是**活**记录：pid 已死的旧
        // 记录不在活集（scanPeers 惰性清扫），会话重启/续跑（--resume 同 sid）照常
        // 注册；本进程自己的记录豁免（幂等重注册，peer-1 修复语义）。
        // v0.5.2（竞态修复）：这里只做**一次**扫描，归属校验与花名 claim 共享——
        // scanPeers 会惰性删除死记录文件，两次独立扫描时第一次就把死花名的前任
        // 证据删掉了，peer-name-reclaimed 接管留痕失明（peer-round2 单测锁定）。
      const scannedOnce = await scanPeers(r);
      const sidHolder = await findLiveSessionIdHolder(r, input.sessionId, scannedOnce);
      if (sidHolder !== undefined) {
        throw new ToolError(
          {
            error: "session_id_in_use",
            sessionId: input.sessionId,
            boundName: sidHolder.name ?? `pid-${sidHolder.pid}`,
            boundPid: sidHolder.pid,
            message: `sessionId "${input.sessionId}" is already registered by another live session ` +
              `(name "${sidHolder.name ?? `pid-${sidHolder.pid}`}"); register with this session's own id ` +
              "(the hook-injected sessionId), not another session's",
          },
          `sessionId "${input.sessionId}" is already registered by another live session`,
        );
      }

      // v0.5.3（二番战 peer-1 幂等豁免的同类面）：本进程已注册同一 sid ⇒ 同一连接的
      // 幂等重认领（agent 重试/重连），跳过下面的锚定/属主校验（首次注册时已验过）。
      const sameProcessReclaim = scannedOnce.active.some(
        (record) => record.pid === process.pid && record.sessionId === input.sessionId,
      );

      // v0.5.3（安全对-3/a8 修复 ①锚定校验）：claimed sid 必须有钩子写的会话基记录
      //（peers/base/<sid>.json，机器全局）——全伪造 sid（无任何锚定记录）此前直接
      // 放行，from-session 归因可随意捏造。唯一豁免：本进程幂等重认领自己的 sid。
      // v0.5.2 README L267「peer 注册验 sessionId 归属」承诺自此完整落地：
      // session_id_in_use（活冲突）→ session_not_anchored（无锚定）→
      // identity_token_required（有锚定但已被绑为队内身份且令牌不符）三道闸。
      let anchoredBase: Awaited<ReturnType<typeof readPeerBaseRecord>> | undefined;
      if (!sameProcessReclaim) {
        anchoredBase = await readPeerBaseRecord(r, input.sessionId);
        if (anchoredBase === undefined) {
          await logPeerEvent(r, {
            event: "peer-register-unanchored",
            sessionId: input.sessionId,
            name,
          });
          throw new ToolError(
            {
              error: "session_not_anchored",
              sessionId: input.sessionId,
              message: `no session base record for "${input.sessionId}" (the SessionStart hook writes ` +
                "peers/base/<sessionId>.json on this machine); a sessionId that no hook ever anchored " +
                "cannot be claimed — use this session's own hook-injected sessionId",
            },
            `sessionId "${input.sessionId}" has no anchor record; peer registration refused`,
          );
        }

        // v0.6（DESIGN §2.2 行 2）：regToken 归属硬闸（identity_token_required）已砍——
        // 基记录 boundName 在册仅作观测标记（软校验保留：session_id_in_use 活冲突、
        // session_not_anchored 锚定存在性、name_taken 先到者为准）。
      }

        // v0.5.2（二番战 peer-1 / peer-5 修复）：一次扫描同时办三件事——
        // ① 花名占用判定：占用者就是本进程 ⇒ 同一连接的重复注册（agent 重试 /
        //    重连），幂等重认领自己的记录，不再 name_taken 硬拒；
        // ② 占用者是别的**活**会话 ⇒ 仍 name_taken（名字即地址，冲突必须显式）；
        // ③ 占用者已死（pid 亡 / lastSeen 陈旧，惰性清扫已摘除）⇒ 接管留痕：
        //    审计 peer-name-reclaimed 带上任身份，否则「活人顶替死花名」在观测面
        //    上完全静默（旧名既不进任何 formerNames，也没有任何事件）。
        const reclaimedFrom = await claimPeerName(r, name, input.sessionId, scannedOnce);

        const tokens = mintPeerTokens();
        const explicit = deps.env["XC_MESSAGING_SOCKET_PATH"];
        let socketPath: string;
        if (explicit !== undefined && explicit.trim() !== "") {
          const validated = validatePeerSocketPath(explicit);
          if (!validated.ok || validated.path === undefined) {
            throw new ToolError(
              { error: "invalid_params", reason: validated.reason ?? "bad socket path" },
              `refusing socket path — ${validated.reason ?? "unknown reason"}`,
            );
          }
          socketPath = validated.path;
        } else {
          socketPath = defaultPeerSocketPath();
        }

        const now = Date.now();
        // v0.5.2（peer-1 修复的伴生防线）：重复注册不得把既有身份痕迹抹掉。
        // 同名重认领 ⇒ 保留既有 formerNames（改名攒下的别名不因一次重试蒸发）；
        // 换名重注册（本进程旧记录当前名 ≠ 新名）⇒ 旧名进 formerNames（与 rename
        // 同语义，旧名保持可寻址，而不是静默消失）。
        const mineBefore = scannedOnce.active.find((record) => record.pid === process.pid);
        const formerNames = [...(mineBefore?.formerNames ?? [])];
        if (mineBefore?.name !== undefined && mineBefore.name !== name
          && !formerNames.some((entry) => entry.name === mineBefore.name)) {
          formerNames.push({ name: mineBefore.name, releasedAt: now });
          while (formerNames.length > PEER_FORMER_NAMES_MAX) formerNames.shift();
        }
        const record: PeerRecord = {
          pid: process.pid,
          sessionId: input.sessionId,
          messagingSocketPath: socketPath,
          pidDomain: localPidDomain(),
          peerProtocol: 1,
          peerFeatures: [],
          kind: input.kind ?? "interactive",
          name,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.contextChars !== undefined ? { contextChars: input.contextChars } : {}),
          ...(reclaimedFrom !== undefined ? { reclaimedFrom } : {}),
          formerNames,
          workspace: deps.workspace,
          cwd: deps.workspace,
          startedAt: now,
          lastSeen: now,
          updatedAt: now,
        };

        // 端点先起：注册记录里的 socket 路径必须是活的（CC 的 pid 文件注册表语义）。
        await startPeerEndpoint({
          root: r,
          record,
          token: tokens.peerToken,
          socketPath,
          handlers: {
            onMessage: async (frame) => receivePeerMessage(deps, frame),
            onControl: async (frame) => {
              await logPeerEvent(r, {
                event: "peer-control-rename",
                sessionId: input.sessionId,
                newName: frame.name,
              });
            },
            onUnauthenticated: (info) => {
              void logPeerEvent(r, { event: "peer-unauthenticated", reason: info.reason });
            },
          },
        });

        await writePeerRecord(r, record);
        await writePeerKeyFile(r, process.pid, socketPath, {
          peerToken: tokens.peerToken,
          pidDomain: localPidDomain(),
        });

        self = { sessionId: input.sessionId, name, socketPath, pid: process.pid };
        setPeerSessionContext({ sessionId: input.sessionId, name, socketPath, pid: process.pid, root: r });

        // 档类真源 = 钩子写的基记录；基记录里没有时才用显式兜底（DESIGN §8.1）。
        const modeClassSource = await resolveModeClass(deps, r, input);
        await logPeerEvent(r, {
          event: "peer-registered",
          sessionId: input.sessionId,
          name,
          socketPath,
          modeClassSource,
        });
        await logEngineEvent(deps.stateRoot, {
          event: "peer-registered",
          sessionId: input.sessionId,
          name,
          socketPath,
          modeClassSource,
        });

        return {
          name,
          sessionId: input.sessionId,
          pid: process.pid,
          socketPath,
          keyFile: peerKeyFile(r, process.pid, socketPath),
          tokenHint: tokens.peerToken.slice(0, 8),
          modeClassSource,
        };
      }, { waitMs: peerRegisterLockWaitMsFromEnv(deps.env) });
    },

    async list(kind?: 'self' | 'member' | 'session'): Promise<PeerRow[]> {
      return await listRows(kind);
    },

    async send(input: PeerSendInput): Promise<PeerSendResult> {
      const r = root();
      if (self === undefined) {
        throw new ToolError(
          { error: "not_registered", message: "not registered: call xc_identify first" },
          "not registered: call xc_identify first",
        );
      }
      // v0.6：message 必填（forwardOf 已砍——转发请求在工具层被显式
      // forwardOf_removed 拒绝，见 tools-relay/alias 层）。
      validateSendModeArgs(input);
      // 寻址用的行集 = 列表口径（self + member + session），**不是**只有 session。
      // DESIGN §5.3「可达的歧义场景」：A 改名后旧名进 formerNames 成为可寻址别名，
      // B 再占用该名 ⇒ 「alice」同时被 A（别名）与 B（当前名）持有 ⇒ 裸名必须
      // 判 ambiguous。若这里只取 session 行，发方自己的别名行就被漏掉，
      // 歧义检测失效（实测症状：to:"alice" 未报 ambiguous 而直接投递）。
      // resolvePeerTarget 内部只用可寻址行（self + session），队内成员行不参与。
      const rows = await listRows();
      const resolved = resolvePeerTarget(input.to, rows);
      if (resolved.kind === "not-found") {
        throw new ToolError(
          { error: "peer_not_found", to: input.to, message: resolved.message },
          resolved.message,
        );
      }
      if (resolved.kind === "ambiguous") {
        throw new ToolError(
          {
            error: "ambiguous_target",
            to: input.to,
            candidates: resolved.candidates.map((row) => ({ name: row.name, ref: row.ref })),
            message: `multiple peers match "${input.to}"; disambiguate with "<name> [ref]"`,
          },
          `multiple peers match "${input.to}"; disambiguate with "<name> [ref]"`,
        );
      }
      const record = (resolved.row as PeerRow).record;
      if (record === undefined) {
        throw new ToolError(
          { error: "peer_not_found", to: input.to, message: "target has no registry record" },
          "target has no registry record",
        );
      }

      // v0.5.2（二番战 peer-3 修复）：禁止发给自己。peer 轴此前没有这道闸——
      // to 指向本会话（当前名或本会话的 formerNames 别名）时，消息经自己的管道
      // 回来，按当前入站策略处理：accept 档下回执 delivered 且真的入自己的队
      // （下一回合注入自己的上下文），hold/自动档下回执 held 后躺在自己的隔离区
      // 里、xc_peer_inbox 永远看不到（红队观察到的「delivered 但永不入队」）。
      // 队内轴同款防护：tools.ts「cannot message yourself」。
      // 判定按 sessionId（不是 pid）：formerNames 别名行解析回来时 pid 相同，
      // 而 record.sessionId 是唯一稳定的会话身份。
      if (record.sessionId === self.sessionId || record.pid === process.pid) {
        throw new ToolError(
          {
            error: "cannot_send_self",
            to: input.to,
            name: resolved.row.name,
            message: `cannot send to yourself: "${resolved.row.name}" is this session ` +
              "(the team axis xc_message refuses self-targeting the same way)",
          },
          `cannot send to yourself: "${resolved.row.name}" is this session`,
        );
      }

      // 活性判定（R-4）：注册记录里的 pid 不在活集 → stale_socket。
      const scanned = await scanPeers(r);
      if (!scanned.active.some((row) => row.pid === record.pid)) {
        throw new ToolError(
          {
            error: "peer_send_failed",
            errorClass: "stale_socket",
            to: input.to,
            message: `peer "${resolved.row.name}" is no longer active (pid ${record.pid} gone or record stale)`,
          },
          `peer "${resolved.row.name}" is no longer active`,
        );
      }

      const key = await readPeerKey(record);
      if (!key.ok) {
        throw new ToolError(
          { error: "peer_send_failed", errorClass: key.errorClass, to: input.to, message: key.reason },
          key.reason,
        );
      }

      // v0.5（R-12）：正文=本条 message，落盘前 uservoice 盖章——命中 → origin=user
      // + originSessionId=本会话；未命中不带 origin 字段（=agent 缺省，wire 不写）。
      // v0.6（DESIGN §2.2 行 4）：forwardOf 转发分支砍除；hopChain 恒为 [本会话名]
      // （无转发即无中继链，admit 闸 loop-depth 保留为防御位）。
      const msgId = randomUUID();
      const text: string = input.message;
      let origin: "user" | undefined;
      let originSessionId: string | undefined;
      const hopChain: string[] = [self.name ?? "peer"];
      {
        // v0.5.2（二番战 SEC-1 修复）→ v0.6 降级为软校验（DESIGN §2.2 行 2）：
        // 盖章前先验会话归属——未锚定或 sid 被别的活进程持有时**不盖章**（消息照发，
        // origin 缺省=agent，fail-closed）+ uservoice-stamp-refused 审计；payload
        // 层的警告由工具层按回执/载荷如实披露（P1-④「不盖章+审计+警告」）。
        const authority = await verifyUservoiceStampAuthority(r, deps.stateRoot, self.sessionId);
        const stamp = authority.ok
          ? await uservoiceMatchAndConsume(r, self.sessionId, text, Date.now(), deps.env)
          : ({ hit: false as const, reason: authority.reason });
        if (!authority.ok) {
          await logPeerEvent(r, {
            event: "uservoice-stamp-refused",
            msgId,
            sessionId: self.sessionId,
            reason: authority.reason,
          });
        }
        if (stamp.hit) {
          origin = "user";
          originSessionId = self.sessionId;
          await logPeerEvent(r, { event: "uservoice-hit", msgId, uses: stamp.uses });
        }
      }

      const base = await readPeerBaseRecord(r, self.sessionId);
      const senderMode: PeerModeClass | undefined =
        base?.permissionMode === 'bypass' || base?.permissionMode === 'prompting'
          ? base.permissionMode
          : undefined;
      const frame: MsgFrame = {
        type: "msg",
        msgId,
        from: self.name ?? "peer",
        fromSessionId: self.sessionId,
        text,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(senderMode !== undefined ? { senderMode } : {}),
        ...(origin === "user" ? { origin: "user" as const } : {}),
        ...(origin === "user" && originSessionId !== undefined ? { originSessionId } : {}),
      };

      // 退化路径（§4.5）：管道不可达 → 落进接收方的收件箱。
      // 行内容按 W5 的 PeerQueueItem 形状构造（接收方排空时按它解析）；
      // v0.5（P8-4c）：origin/originSessionId 随帧透传（file 通道不丢溯源）。
      const fallbackItem: PeerQueueItem = {
        msgId,
        from: frame.from,
        ...(frame.fromSessionId !== undefined ? { fromSessionId: frame.fromSessionId } : {}),
        ...(senderMode !== undefined ? { fromMode: senderMode } : {}),
        hopChain,
        text: frame.text,
        ...(frame.summary !== undefined ? { summary: frame.summary } : {}),
        ...(origin === "user" ? { origin: "user" as const } : {}),
        ...(origin === "user" && originSessionId !== undefined ? { originSessionId } : {}),
        ts: Date.now(),
        via: "file",
      };

      const result = await sendPeerFrame({
        socketPath: record.messagingSocketPath,
        token: key.peerToken,
        frame,
        timeoutMs: 10_000,
        fallback: {
          file: peerInboxFile(r, record.sessionId),
          line: JSON.stringify(fallbackItem),
        },
      });
      if (!result.ok) {
        await logPeerEvent(r, {
          event: "peer-send-failed",
          to: resolved.row.name,
          errorClass: result.errorClass,
        });
        throw new ToolError(
          {
            error: "peer_send_failed",
            errorClass: result.errorClass,
            to: input.to,
            msgId,
            message: result.message,
          },
          result.message,
        );
      }

      const reply = result.reply;
      const receipt: PeerReceipt = reply?.type === "status" ? (reply.state as PeerReceipt) : "delivered";
      await logPeerEvent(r, {
        event: "peer-sent",
        to: resolved.row.name,
        msgId,
        receipt,
        via: result.via,
      });
      return {
        receipt,
        via: result.via,
        msgId,
        to: resolved.row.name,
        ...(reply?.type === "status" && reply.detail !== undefined ? { detail: reply.detail } : {}),
      };
    },

    /** v0.5（R-22）：全文分页读（store → held → queue/inbox 兜底解析；只读不消费）。 */
    async read(input: PeerReadInput): Promise<PeerReadResult> {
      const r = root();
      if (self === undefined) {
        throw new ToolError(
          { error: "not_registered", message: "not registered: call xc_identify first" },
          "not registered: call xc_identify first",
        );
      }
      const resolved = await resolvePeerMessage(r, self.sessionId, input.msgId);
      if (resolved === undefined) {
        throw new ToolError(
          {
            error: "invalid_params",
            msgId: input.msgId,
            message: `unknown msgId "${input.msgId}"; only messages received by this session can be read`,
          },
          `unknown msgId "${input.msgId}"; only messages received by this session can be read`,
        );
      }
      // limit 缺省 = 本会话 itemBudget（R-22）；单次 ≤ 64000（paginateText 内钳制）；
      // 越界 offset → 空文本 + hasMore:false（paginateText 越界安全）。
      const budget = receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
      const page = paginateText(resolved.text, input.offset, input.limit, budget.item);
      return { msgId: input.msgId, total: page.total, offset: page.offset, text: page.text, hasMore: page.hasMore };
    },

    /**
     * v0.5.2（SCALE-3 修复）：批次拉取改为「窥视 → 预算窗口 → 只消费窗口内」。
     *
     * 旧实现 `drainPeerQueue(limit)` 把整批取走，再由工具层的 layoutInjectBlocks
     * 把装不下的条目降级成 `[已省略 …（超注入预算）]` 占位摘要——**消费即省略**：
     * 窗口外消息既没进模型上下文、也不再留在队列（`remaining:0`、无再拉指针），
     * 与 README「剩余件留在队列并随 remaining 字段给『再拉一次』指针」及队内轴
     * 「窗口外消息保持未读」（README L225）双双不符（红队实测 20 条一批只呈现
     * 9/11 个信封、其余 11 条已消费）。
     *
     * 现在：先只读窥视队列（readPeerQueue 不消费）→ 按每条在预算下的注入成本
     * （injectBlockCost，item 截断后长度）算到达序窗口（保底一条）→ 只 drain 窗口
     * 内条目；窗口外消息**留在队列**，`remaining` 与摘要行的「再拉一次」指针
     * 因此名副其实（内容全程可经 xc_peer_read 取回，store 在接收入队时已落盘）。
     *
     * @param budget 调用方的注入预算（缺省按本会话 env 现算；工具层传入以保持
     *   「同一响应内窗口与排布同源」）。注入的假服务可忽略它（单测脚本化场景）。
     */
    async inbox(
      limit: number,
      budget?: InjectBudget,
    ): Promise<{ items: PeerQueueItem[]; rendered: string[]; remaining: number }> {
      const r = root();
      if (self === undefined) {
        throw new ToolError(
          { error: "not_registered", message: "not registered: call xc_identify first" },
          "not registered: call xc_identify first",
        );
      }
      const effective = budget ?? receiverInjectBudget(contextCharsFromEnv(deps.env), deps.env);
      // 窥视（不消费）：候选 = 队列前 limit 条（到达序）。
      const queued = await readPeerQueue(r, self.sessionId);
      const candidates = queued.slice(0, Math.max(0, limit));
      const rendered = candidates.map((item) => renderPeerEnvelope(item));
      const costs = candidates.map((item, i) =>
        injectBlockCost(queueItemToInjectBlock(item, rendered[i]!), effective, "peer"));
      const windowCount = batchWindowCount(costs, effective.total);
      // 只消费窗口内条目；窗口外留在队列文件里（drain 的 rename 换出 + 半行写回
      // 语义不变，leftover 原样写回）。
      const items = windowCount > 0 ? await drainPeerQueue(r, self.sessionId, windowCount) : [];
      const shownRendered = items.map((item, i) =>
        candidates[i]?.msgId === item.msgId ? rendered[i]! : renderPeerEnvelope(item));
      // v0.5.1（P3 count 口径修复）：排空后的剩余深度随结果返回，调用面据此给
      // 「再拉一次」指针（窗口外消息留在 queue 不丢）。
      const remaining = await peerQueueDepth(r, self.sessionId);
      return { items, rendered: shownRendered, remaining };
    },

    async review(input: { action: 'list' | 'accept' | 'discard'; ids?: string[] }): Promise<PeerReviewResult> {
      const r = root();
      if (self === undefined) {
        throw new ToolError(
          { error: "not_registered", message: "not registered: call xc_identify first" },
          "not registered: call xc_identify first",
        );
      }
      // v0.5.2（故障注-4 修复）：枚举改走 detailed 扫描——损坏暂存件（不可解析/
      // 形状非法）此前只进审计后静默跳过，审阅面看到「暂存区 0 条」，消息对人工
      // 审阅者完全不可见且无处置线索。现在 corrupted 计数随结果披露（队列内 inbox
      // 坏行的 malformedLines 同款口径），损坏件保持 fail-closed 不投递。
      const heldScan = await listHeldPeerMessagesDetailed(r, self.sessionId);
      const held = heldScan.held;
      const corrupted = heldScan.corrupted;
      const heldView = held.map((message) => ({
        msgId: message.item.msgId,
        from: message.item.from,
        ts: message.heldAt,
        cause: message.cause,
      }));

      if (input.action === "list") {
        return { action: "list", held: heldView, affected: [], receipts: [], ...(corrupted.length > 0 ? { corrupted } : {}) };
      }
      const ids = input.ids ?? held.map((message) => message.item.msgId);

      if (input.action === "accept") {
        // v0.5.1（BND-2/边界与-2 修复）：xc_peer_review 的 accept 是**收方的显式放行批准**
        // （README L129「hold 进隔离区等 xc_peer_review 放行」）。释放时的重新裁决
        // （DESIGN §6.3「释放路径按当前策略重裁」）只保留 refuse 一道闸：当前策略已转为
        // refuse（含 kill-switch / opt-out）→ 仍拒放（fail-closed，收方已整体退出跨会话接收，
        // 智能体的 accept 不得越过）；**hold 不再回吞暂存件**——旧逻辑在显式 hold 策略下
        // accept 永远重裁回 still-held（releaseHeldMessages 的 hold→still-held 分支，
        // core/peerpolicy.ts），暂存件直到 12h TTL 过期都出不了隔离区，而回执仍报
        // 「影响 1 条」、审计记 peer-hold-released——红队 BND-2 的「假成功黑洞」。
        // 证据：evidence/adversarial/adjudication/logs/bnd2*.jsonl（accept 3 次均 0 投递）。
        const results = await releaseHeldMessages(r, self.sessionId, ids, {
          workspace: deps.workspace,
          adjudicate: async (message: PeerHeldMessage): Promise<InboundDecision> => {
            // 重新裁决保留 F6 修复口径（带收方档类，peer-tools 历史注释见下），用于识别
            // refuse；显式 hold / 自动档 hold 在收方显式 accept 下一律放行（见上）。
            const receiver = await readReceiverModeClass(r, self?.sessionId ?? "");
            const { decision } = await resolveInboundDecision({
              workspace: deps.workspace,
              sessionId: self?.sessionId ?? "",
              env: deps.env,
              ...(receiver.cls !== undefined ? { recvClass: receiver.cls } : {}),
              ...(message.item.fromMode !== undefined ? { senderClass: message.item.fromMode } : {}),
              selfSent: false,
            });
            return decision.policy === "refuse" ? decision : { policy: "accept" };
          },
          deliver: async (message: PeerHeldMessage) => {
            const admitted = admitPeerMessage({
              now: Date.now(),
              sender: message.item.from,
              msgId: message.item.msgId,
              hopChain: message.item.hopChain ?? [message.item.from],
              selfSent: message.item.selfSent ?? false,
              queueDepth: await peerQueueDepth(r, self?.sessionId ?? ""),
              // v0.5.2（SCALE-2）：入队闸的队列上限可配（XC_PEER_MAX_QUEUE_DEPTH）。
              maxQueueDepth: peerMaxQueueDepthFromEnv(deps.env),
              buckets: rateBucketsFor(r),
            });
            if (!admitted.ok) return { ok: false, reason: admitted.reason };
            const promoted = heldItemToQueueItem(message.item);
            await appendPeerQueue(r, self?.sessionId ?? "", promoted);
            // v0.5（F-3 5b）：晋升入队即落 store（幂等；失败不阻断投递）。
            // v0.5.2（SEC-5）：store 记录带收方 sessionId（forwardOf 所有权字段）。
            await storeAfterEnqueue(r, promoted, self?.sessionId ?? "");
            return true;
          },
          // 放行后的终态回执（DESIGN §9.3「A 侧收到 delivered」/§6.3「accept → 放行
          // + 回执 delivered」；闸弃则回 dropped，仍 refuse 则回 refused）。
          // 发方按 sessionId 反查注册记录——发方会话已退出时查不到，回执自然发不出
          // （best-effort，与 discard 分支同款口径）。
          onOutcome: async (result: PeerHeldReleaseResult) => {
            if (result.receipt === undefined) return;
            const sender = await recordOfSession(result.item.fromSessionId);
            await sendReceipt(sender, result.msgId, result.receipt, result.detail);
          },
        });
        // v0.5.1（BND-2 修复）：审计如实——事件附各终态计数。旧版只记 ids，
        // 「仍滞留/被闸弃」的也记成 released，假成功在审计面同样成立。
        await logPeerEvent(r, {
          event: "peer-hold-released",
          sessionId: self.sessionId,
          ids: results.map((result) => result.msgId),
          outcomes: countReleaseOutcomes(results),
        });
        return {
          action: "accept",
          held: heldView,
          affected: results.map((result) => result.msgId),
          receipts: results.map((result) => ({
            msgId: result.msgId,
            ...(result.receipt !== undefined ? { receipt: result.receipt } : {}),
            outcome: result.outcome,
          })),
          ...(corrupted.length > 0 ? { corrupted } : {}),
        };
      }

      // discard：收方用户明确拒绝 → 删除暂存件 + 给发方回执 denied（CC @36116756）。
      const results = await discardHeldMessages(r, self.sessionId, ids, { workspace: deps.workspace });
      for (const result of results) {
        const sender = await recordOfSession(result.item.fromSessionId);
        await sendReceipt(sender, result.msgId, "denied", "recipient discarded the held message");
      }
      await logPeerEvent(r, {
        event: "peer-hold-discarded",
        sessionId: self.sessionId,
        ids: results.map((result) => result.msgId),
      });
      return {
        action: "discard",
        held: heldView,
        affected: results.map((result) => result.msgId),
        receipts: results.map((result) => ({
          msgId: result.msgId,
          ...(result.receipt !== undefined ? { receipt: result.receipt } : {}),
          outcome: result.outcome,
        })),
        ...(corrupted.length > 0 ? { corrupted } : {}),
      };
    },

    async rename(name: string): Promise<PeerRenameResult> {
      const r = root();
      if (self === undefined) {
        throw new ToolError(
          { error: "not_registered", message: "not registered: call xc_identify first" },
          "not registered: call xc_identify first",
        );
      }
      const sanitized = sanitizePeerName(name);
      if (!sanitized.ok) {
        throw new ToolError({ error: "invalid_params", reason: sanitized.reason }, sanitized.reason);
      }
      const next = sanitized.name;
      // v0.5.2（二番战 peer-3 修复）：改名与注册同一道保留名闸（见 register）。
      assertPeerNameNotReserved(next);
      const previous = self.name;
      if (next === previous) {
        throw new ToolError(
          { error: "invalid_params", message: `already named "${next}"` },
          `already named "${next}"`,
        );
      }
      // 闭包内引用收窄后的非空 self（async 回调会丢失对可变外层变量的收窄）。
      const me = self;
      // v0.5.2（二番战 peer-1 / peer-5 修复）：与注册共用一个花名claim助手
      // （占用判定 + 死名接管审计）。本进程持有 previous 而非 next，故「占用者是
      // 本进程」这条豁免对改名不成立——冲突仍然显式 name_taken。
      // v0.5.3（A4 修复）：改名与注册同一临界区纪律——花名 claim→记录落盘在
      // `peerRegistryLockName` 锁内串行（并发的「改名到同一活名」此前同样 4/4 全过）。
      // touchPeerRecord 内部取**同一把**注册表锁，锁内嵌套只会自等超时静默失败，
      // 故在外锁内直接 read-merge-write（合并语义与 touchPeerRecord 同款）。
      const now = Date.now();
      const claimed = await withFileLock(r, peerRegistryLockName(r), async () => {
        const reclaimedFrom = await claimPeerName(r, next, me.sessionId);
        const scanned = await scanPeers(r);
        const mine = scanned.active.find((record) => record.pid === process.pid);
        const formerNames = [...(mine?.formerNames ?? [])];
        if (previous !== undefined) formerNames.push({ name: previous, releasedAt: now });
        while (formerNames.length > PEER_FORMER_NAMES_MAX) formerNames.shift();
        const current = await readPeerRecord(r, process.pid);
        if (current !== undefined) {
          await writePeerRecord(r, {
            ...current,
            name: next,
            formerNames,
            ...(reclaimedFrom !== undefined ? { reclaimedFrom } : {}),
            lastSeen: now,
            updatedAt: now,
          });
        } else {
          // 防御分支（self 在册而记录被外部清扫判死的罕见残景）：按 register 同款
          // 形状重建（外锁已保证互斥）。
          await writePeerRecord(r, {
            pid: process.pid,
            sessionId: me.sessionId,
            messagingSocketPath: me.socketPath ?? defaultPeerSocketPath(),
            pidDomain: localPidDomain(),
            peerProtocol: 1,
            peerFeatures: [],
            kind: "interactive",
            name: next,
            formerNames,
            ...(reclaimedFrom !== undefined ? { reclaimedFrom } : {}),
            workspace: deps.workspace,
            cwd: deps.workspace,
            startedAt: now,
            lastSeen: now,
            updatedAt: now,
          });
        }
        return { reclaimedFrom, scanned };
      }, { waitMs: peerRegisterLockWaitMsFromEnv(deps.env) });
      const reclaimedFrom = claimed.reclaimedFrom;
      const scanned = claimed.scanned;

      self = { ...self, name: next };
      setPeerSessionContext({
        sessionId: self.sessionId,
        ...(self.name !== undefined ? { name: self.name } : {}),
        ...(self.socketPath !== undefined ? { socketPath: self.socketPath } : {}),
        pid: self.pid,
        root: r,
      });

      // 通知相关会话（R-13 的 control:rename 帧）。
      // v0.5.2（二番战 CONC-1 修复）：扇出改**并行**。旧实现逐个 await
      // sendPeerFrame（默认 10s 超时）——N 个不回应/慢回应的 peer 让改名耗时
      // N×10s 线性恶化（红队实测 N=6 超 60s，rename 面实际不可用）。并行后总
      // 耗时≈单次超时；单个 peer 的失败/超时只写进它自己的 notified 行
      // （ok:false + errorClass），不拖累其他会话，fail-closed 语义不变。
      // sessionId 先取到局部：闭包里读可变 self 会丢掉收窄后的非空类型。
      const notifySessionId = self.sessionId;
      const notified = await Promise.all(
        scanned.active
          .filter((record) => record.pid !== process.pid)
          .map(async (record): Promise<{ name: string; ok: boolean; errorClass?: string }> => {
            const key = await readPeerKey(record);
            if (!key.ok) {
              return { name: record.name ?? `pid-${record.pid}`, ok: false, errorClass: key.errorClass };
            }
            const result = await sendPeerFrame({
              socketPath: record.messagingSocketPath,
              token: key.peerToken,
              frame: { type: "control", action: "rename", name: next, sessionId: notifySessionId },
            });
            return {
              name: record.name ?? `pid-${record.pid}`,
              ok: result.ok,
              ...(result.ok ? {} : { errorClass: result.errorClass }),
            };
          }),
      );

      await logPeerEvent(r, {
        event: "peer-renamed",
        sessionId: self.sessionId,
        from: previous,
        to: next,
        notified: notified.length,
      });
      return {
        name: next,
        ...(previous !== undefined ? { formerName: previous } : {}),
        notified,
      };
    },

    async agents(): Promise<PeerAgentsPanel> {
      const selfRows = await rowsOf("self");
      const peers = await rowsOf("session");
      const team = await readTeam(deps.stateRoot, "default");
      // v0.5（R-7）：成员行增 isLead 现算字段（leadKeyOf 含 founder 兜底语义，
      // member-tools.ts 同款；不入盘不入快照，修复 v0.4 的无标注缺口）。
      const members = (team?.members ?? []).map((member) => ({
        key: member.key,
        role: member.role,
        state: member.state ?? "ready",
        unread: 0,
        isLead: team !== undefined && member.key === leadKeyOf(team),
      }));
      const tasks = { pending: 0, inProgress: 0, done: 0 };
      for (const task of team?.tasks ?? []) {
        if (task.status === "pending") tasks.pending += 1;
        else if (task.status === "in_progress") tasks.inProgress += 1;
        else tasks.done += 1;
      }
      let inboundPolicy: PeerAgentsPanel["inboundPolicy"];
      if (self !== undefined) {
        try {
          const resolution = await resolveInboundDecision({
            workspace: deps.workspace,
            sessionId: self.sessionId,
            env: deps.env,
          });
          // 会话级查询面（CC `H()`）：与逐消息裁决并列展示（DV-2 / U16）。
          const receiver = await readReceiverModeClass(root(), self.sessionId);
          const sessionQuery = decideSessionInboundPolicy({
            managedOff: resolution.resolution.killSwitch,
            ...(resolution.resolution.explicit !== undefined
              ? { explicit: resolution.resolution.explicit }
              : {}),
            explicitSource: resolution.resolution.decidedBy,
            ...(receiver.cls !== undefined ? { recvClass: receiver.cls } : {}),
          });
          inboundPolicy = {
            mode: resolution.resolution.mode,
            decidedBy: resolution.resolution.decidedBy,
            strictest: resolution.resolution.strictest,
            auto: resolution.resolution.auto,
            sessionLevelQuery: {
              policy: sessionQuery.policy,
              ...("cause" in sessionQuery && sessionQuery.cause !== undefined
                ? { holdCause: sessionQuery.cause }
                : {}),
            },
          };
        } catch {
          inboundPolicy = undefined;
        }
      }
      return {
        ...(selfRows[0] !== undefined ? { self: selfRows[0] } : {}),
        peers,
        members,
        tasks,
        ...(inboundPolicy !== undefined ? { inboundPolicy } : {}),
      };
    },
  };
}

/**
 * v0.5.2（二番战 peer-3 修复）：peer 花名的保留名闸，与队内轴同一张表同一个码。
 *
 * `identity.ts`（xc_register）与 `member-tools.ts`（xc_member_add）都用
 * `RESERVED_MEMBER_KEYS` 拒绝 lead/default：字面成员名会与 lead 角色语义、缺省
 * teamId 撞名。peer 轴此前只受 addressing 层 `PEER_RESERVED_NAMES`
 * （main/team-lead/user/system）约束，lead/default 可以注册也可以改名过去，
 * 与队内轴规则不一致，构成一条注册旁路。注册与改名共用本函数（两入口同规则）。
 */
export function assertPeerNameNotReserved(name: string): void {
  if ((RESERVED_MEMBER_KEYS as readonly string[]).includes(name)) {
    const reason = `peer name "${name}" is reserved (${RESERVED_MEMBER_KEYS.join("/")})`;
    throw new ToolError({ error: "name_reserved", name, message: reason }, reason);
  }
}

/**
 * v0.5.2（二番战 SEC-1 / SEC-2 修复）：查找「已被别的活进程持有的 sid」的注册记录。
 *
 * 机器全局注册表按 pid 存文件（sessions/<pid>.json），同一 sessionId 出现在两条
 * **活**记录里 = 冒充（rtsec C2）或碰撞（rtsec C3）。本进程自己的记录豁免（同连接
 * 幂等重注册）；死记录不在 `scanPeers().active`（惰性清扫），不挡会话重启/续跑。
 *
 * `scanned`：调用方已算好的扫描结果（可选）。注册路径必须与 {@link claimPeerName}
 * 共享**同一次**扫描——scanPeers 会惰性删除死记录文件，两次独立扫描时第一次就把
 * 死记录的证据删掉了，第二次的接管留痕（peer-name-reclaimed）就再也看不到前任。
 */
export async function findLiveSessionIdHolder(
  root: string,
  sessionId: string,
  scanned?: PeerScanResult,
): Promise<PeerRecord | undefined> {
  const result = scanned ?? await scanPeers(root);
  return result.active.find((record) => record.sessionId === sessionId && record.pid !== process.pid);
}

/**
 * v0.5.2（二番战 peer-1 / peer-5 修复）：花名claim助手——注册与改名共用。
 *
 * 一次 `scanPeers`（顺带惰性清扫死记录）办三件事：
 * 1. **占用者是本进程** ⇒ 同一连接的重复注册（agent 重试 / 重连）：幂等重认领，
 *    直接刷新自己的记录。旧实现在这里 `name_taken` 硬拒，活会话重新注册自己的
 *    花名永远失败（红队 peer-1）。
 * 2. **占用者是别的活会话** ⇒ `name_taken`。名字即地址，跨会话冲突必须显式，
 *    这条不变（`isPeerNameFree` 的原语义）。
 * 3. **占用者已死** ⇒ 记录已被惰性清扫摘除，花名可以接管，但必须留痕：审计
 *    `peer-name-reclaimed` 带上任身份，并把前任写进新记录的 `reclaimedFrom`
 *    （`xc_peers` 因此能显示「这个地址换过人」）。旧实现两者都没有——死花名
 *    被静默替换（红队 peer-5）。
 *
 * @returns 接管过来的前任身份；花名此前无主时为 undefined。
 */
async function claimPeerName(
  root: string,
  name: string,
  sessionId: string,
  scanned?: PeerScanResult,
): Promise<PeerReclaimedFrom | undefined> {
  // `scanned`：与 sid 归属校验（findLiveSessionIdHolder）共享同一次扫描——scanPeers
  // 的惰性清扫会删掉死记录文件，独立两次扫描时第二次就看不到死花名的前任了
  // （接管留痕失明的竞态，peer-round2 单测锁定）。
  const result = scanned ?? await scanPeers(root);
  const holders = result.active.filter((record) => record.name === name);
  if (holders.length > 0 && !holders.some((record) => record.pid === process.pid)) {
    const reason = `peer name "${name}" is already registered on this machine`;
    // v0.5.3（A4 修复）：占名拒绝也留痕。锁互斥后并发同名注册的败者在此显式
    // 失败——没有这行审计，「谁在何时试图接管谁的花名」在观测面完全不可见
    // （adj052 A4：4/4 全成功且零接管审计）。带上任持有者身份（sessionId/pid）。
    await logPeerEvent(root, {
      event: "peer-name-taken-refused",
      name,
      holders: holders.map((record) => ({ sessionId: record.sessionId, pid: record.pid })),
    });
    throw new ToolError({ error: "name_taken", name, message: reason }, reason);
  }
  const previous = result.dead.find((row) => row.record.name === name);
  if (previous === undefined) return undefined;
  const reclaimedFrom: PeerReclaimedFrom = {
    sessionId: previous.record.sessionId,
    pid: previous.record.pid,
    releasedAt: Date.now(),
    ...(previous.reason !== undefined ? { deadReason: previous.reason } : {}),
  };
  await logPeerEvent(root, {
    event: "peer-name-reclaimed",
    name,
    sessionId,
    previous: reclaimedFrom,
  });
  return reclaimedFrom;
}

/** 档类来源判定：基记录优先，其次显式兜底（并记审计 peer-mode-class-fallback）。 */
async function resolveModeClass(
  deps: ToolDeps,
  root: string,
  input: PeerRegisterInput,
): Promise<'base-record' | 'mode-class-fallback' | 'unknown'> {
  const base = await readPeerBaseRecord(root, input.sessionId);
  if (base?.permissionMode === 'bypass' || base?.permissionMode === 'prompting') {
    return 'base-record';
  }
  if (input.modeClass !== undefined) {
    await logPeerEvent(root, {
      event: "peer-mode-class-fallback",
      sessionId: input.sessionId,
      modeClass: input.modeClass,
    });
    await logEngineEvent(deps.stateRoot, {
      event: "peer-mode-class-fallback",
      sessionId: input.sessionId,
      modeClass: input.modeClass,
    });
    return 'mode-class-fallback';
  }
  return 'unknown';
}

/**
 * 接收侧：鉴权 → 白名单 → 文本非空 → **三态闸** → **入队闸** → 写队列 → 回 status
 * （DESIGN §4.6 投递链）。
 *
 * 三态闸由 W4 裁决（resolveInboundDecision）、入队闸由 W5 判定
 * （admitPeerMessage）、队列写由 W5 落盘（appendPeerQueue）。
 */
export async function receivePeerMessage(
  deps: ToolDeps,
  frame: {
    type: 'msg';
    msgId: string;
    from: string;
    fromSessionId?: string;
    text: string;
    summary?: string;
    senderMode?: 'bypass' | 'prompting';
    /** v0.5（R-11）：作者身份标记（发送侧仅在 user 时写；旧端点帧无此键 = agent）。 */
    origin?: 'user' | 'agent';
    originSessionId?: string;
  },
): Promise<{ type: 'status'; msgId: string; state: PeerReceipt; detail?: string }> {
  const root = peerRootFromEnv(deps.env);
  const scanned = await scanPeers(root);
  const mine = scanned.active.find((record) => record.pid === process.pid);
  if (mine === undefined) {
    return { type: "status", msgId: frame.msgId, state: "dropped", detail: "receiver-not-registered" };
  }

  const receiver = await readReceiverModeClass(root, mine.sessionId);
  const { decision, resolution } = await resolveInboundDecision({
    workspace: deps.workspace,
    sessionId: mine.sessionId,
    env: deps.env,
    ...(receiver.cls !== undefined ? { recvClass: receiver.cls } : {}),
    ...(frame.senderMode !== undefined ? { senderClass: frame.senderMode } : {}),
    selfSent: false,
  });

  const item: PeerQueueItem = {
    msgId: frame.msgId,
    from: frame.from,
    ...(frame.fromSessionId !== undefined ? { fromSessionId: frame.fromSessionId } : {}),
    ...(frame.senderMode !== undefined ? { fromMode: frame.senderMode } : {}),
    hopChain: [frame.from],
    text: frame.text,
    ...(frame.summary !== undefined ? { summary: frame.summary } : {}),
    ...(frame.origin !== undefined ? { origin: frame.origin } : {}),
    ...(frame.origin === "user" && frame.originSessionId !== undefined
      ? { originSessionId: frame.originSessionId }
      : {}),
    ts: Date.now(),
    via: "pipe",
  };

  // v0.6（DESIGN-V0.6.md §2.2 行 3）：接收盖标（forged 检测）已随对抗件砍除；
  // 嵌套信封标签的剥离发生在渲染面（renderPeerEnvelope 的渲染卫生）。

  if (decision.policy === "refuse") {
    await logPeerEvent(root, {
      event: "peer-refused",
      msgId: frame.msgId,
      from: frame.from,
      cause: decision.cause,
    });
    return { type: "status", msgId: frame.msgId, state: "refused", detail: decision.cause };
  }

  if (decision.policy === "hold") {
    const held = await holdPeerMessage(root, mine.sessionId, item, decision.cause, {
      workspace: deps.workspace,
    });
    await logPeerEvent(root, {
      event: "peer-hold",
      msgId: frame.msgId,
      from: frame.from,
      cause: decision.cause,
      announced: held.announced,
    });
    return { type: "status", msgId: frame.msgId, state: "held", detail: decision.cause };
  }

  // accept → 入队闸（限速 / 去重 / 环路 / 队列上限）。
  // v0.5.2（SCALE-2）：队列上限可配（XC_PEER_MAX_QUEUE_DEPTH，默认 1024）。
  const admitted = admitPeerMessage({
    now: Date.now(),
    sender: frame.from,
    msgId: frame.msgId,
    hopChain: item.hopChain,
    selfSent: false,
    queueDepth: await peerQueueDepth(root, mine.sessionId),
    maxQueueDepth: peerMaxQueueDepthFromEnv(deps.env),
    buckets: rateBucketsFor(root),
  });
  if (!admitted.ok) {
    await logPeerEvent(root, {
      event: "peer-dropped",
      msgId: frame.msgId,
      from: frame.from,
      reason: admitted.reason,
    });
    return {
      type: "status",
      msgId: frame.msgId,
      state: "dropped",
      // v0.5.2（SCALE-2）：丢弃原因对发方**可行动**。旧 detail 只有裸原因码
      // （"queue-full"），发送方工具响应又是非错误的 `receipt:"dropped"`，模型
      // 极易忽略——现在带上限值与恢复动作（队列满 → 让收方排空或稍后重试）。
      detail: admissionDropDetail(admitted.reason, peerMaxQueueDepthFromEnv(deps.env)),
    };
  }

  await appendPeerQueue(root, mine.sessionId, item);
  // v0.5（F-3）：store 入队即落——排空即消费后 queue/inbox/held 皆空，xc_peer_read
  // 与 forwardOf 必须仍能解析原文与 origin 元数据（P2）。幂等；失败不阻断投递。
  // v0.5.2（SEC-5）：store 记录带收方 sessionId——机器全局 store 里 msgId 存在
  // 不等于「本会话收到过」，forwardOf 的所有权校验依赖本字段。
  await storeAfterEnqueue(root, item, mine.sessionId);
  await logPeerEvent(root, {
    event: "peer-delivered",
    msgId: frame.msgId,
    from: frame.from,
    decidedBy: resolution.decidedBy,
  });
  return { type: "status", msgId: frame.msgId, state: "delivered" };
}

/**
 * v0.5（F-3）：把队列项全文 + 溯源元数据幂等落进 `peers/messages/<msgId>.json`。
 * 两个入队落点（pipe 接受 / held 晋升）共用；失败只审计（store 不是投递链的一环）。
 * v0.5.2（SEC-5）：`toSessionId` = 接收方会话 id——机器全局 store 的所有权字段，
 * forwardOf 的 requireOwnership 校验据此判定「本会话收到过」。
 */
async function storeAfterEnqueue(root: string, item: PeerQueueItem, toSessionId: string): Promise<void> {
  try {
    await storePeerMessageFull(root, {
      msgId: item.msgId,
      text: item.text,
      ...(item.from !== undefined ? { from: item.from } : {}),
      ...(item.fromSessionId !== undefined ? { fromSessionId: item.fromSessionId } : {}),
      ...(item.origin !== undefined ? { origin: item.origin } : {}),
      ...(item.originSessionId !== undefined ? { originSessionId: item.originSessionId } : {}),
      hopChain: item.hopChain,
      toSessionId,
    });
  } catch (error) {
    await logPeerEvent(root, {
      event: "msgstore-write-error",
      msgId: item.msgId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * v0.5.2（SCALE-2 修复）：入队闸丢弃原因 → 发给发送方的**可行动** detail。
 *
 * 背景：`receipt:"dropped"` 在 `xc_peer_send` 里不是错误（isError=false），
 * 旧 detail 只有裸原因码（`queue-full` / `rate-limited`），红队实测「发送方
 * 工具响应成功但载荷 dropped，模型极易忽略」。现在把上限值与恢复动作写进
 * detail，并由 xc_peer_send 的摘要行透出（README 已知限制同步文档化）。
 */
export function admissionDropDetail(reason: string | undefined, maxQueueDepth: number): string {
  switch (reason) {
    case 'queue-full':
      return `queue-full: the receiver's pending peer queue is at its cap (${maxQueueDepth} messages) — `
        + 'this message was NOT delivered; ask the receiver to drain with xc_peer_inbox, or retry later';
    case 'rate-limited':
      return `rate-limited: the receiver's per-sender inbound rate limit is ${PEER_RATE_LIMIT} messages / `
        + `${PEER_RATE_WINDOW_MS / 1000}s — this message was NOT delivered; pace your sends (e.g. ~5s apart) and retry`;
    case 'duplicate':
      return 'duplicate: this msgId was already accepted by the receiver (de-duplication window) — nothing to retry';
    case 'loop-depth':
      return `loop-depth: the relay chain is deeper than ${PEER_MAX_HOP_DEPTH} hops — forwarding loops are dropped`;
    default:
      return reason ?? 'admission-gate';
  }
}

/**
 * v0.5.1（BND-2 修复）：把 releaseHeldMessages 的逐条终态收敛成计数表。
 * 未知终态（前向兼容）计进 other，不静默丢弃。
 */
export function countReleaseOutcomes(
  results: readonly { outcome?: string }[],
): { delivered: number; dropped: number; refused: number; "still-held": number; other: number } {
  const counts = { delivered: 0, dropped: 0, refused: 0, "still-held": 0, other: 0 };
  for (const result of results) {
    if (result.outcome === "delivered" || result.outcome === "dropped"
      || result.outcome === "refused" || result.outcome === "still-held") {
      counts[result.outcome] += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

/**
 * v0.5.1（BND-2 修复）：xc_peer_review 的摘要行必须反映**真实终态**。
 * 旧版 accept/discard 一律报「影响 N 条」——still-held（未放行）也计入，
 * 红队 BND-2 据此把假成功定性为 P1（accept 3 次均「影响 1 条」而投递 0 条）。
 * accept 现按终态分组如实播报；list/discard 的旧文案不变（discard 的全部
 * 结果就是 discarded，「影响 N 条」属实）。
 */
/**
 * v0.5.2（故障注-3/4 配套）：入参放宽为只读结构视图——本函数只读不写，
 * readonly 数组（测试夹具 `as const` 等）与既有 PeerReviewResult（可变数组）
 * 都可传入；PeerReviewResult 结构上满足该视图。
 */
export function renderReviewSummary(result: {
  action: 'list' | 'accept' | 'discard';
  held: readonly { msgId: string; from: string; ts?: number; cause?: string }[];
  affected: readonly string[];
  receipts: readonly { msgId: string; receipt?: PeerReceipt; outcome?: string }[];
  corrupted?: readonly { file: string; error: string }[];
}): string {
  // v0.5.2（故障注-4 修复）：损坏暂存件计数披露——审阅面不再显示干净假象的
  // 「暂存区 0 条」，坏件条数随动作（list/accept/discard）一并向人工审阅者可见。
  const corruptedNote = (result.corrupted?.length ?? 0) > 0
    ? `；⚠ ${result.corrupted!.length} 条暂存件损坏（不可解析，无法审阅/处置——文件名见 structured.corrupted，修复或手工删除后重试）`
    : "";
  if (result.action !== "accept") {
    return `暂存区 ${result.held.length} 条；本次动作 ${result.action}，影响 ${result.affected.length} 条${corruptedNote}。`;
  }
  const counts = countReleaseOutcomes(result.receipts);
  const parts: string[] = [];
  if (counts.delivered > 0) parts.push(`放行投递 ${counts.delivered} 条`);
  if (counts.dropped > 0) parts.push(`入队闸弃 ${counts.dropped} 条`);
  if (counts.refused > 0) parts.push(`策略拒绝 ${counts.refused} 条（消息已删除）`);
  if (counts["still-held"] > 0) parts.push(`仍滞留 ${counts["still-held"]} 条（未放行）`);
  if (counts.other > 0) parts.push(`其他终态 ${counts.other} 条`);
  return `暂存区 ${result.held.length} 条；accept 结果：${parts.length > 0 ? parts.join("、") : "无可处理的暂存件"}${corruptedNote}。`;
}

/** W4 的暂存项 → W5 的队列项（hopChain 在 W4 侧可选）；v0.5：origin/originSessionId 随 item 透传不丢（P8-4d）。 */
function heldItemToQueueItem(item: {
  msgId: string;
  from: string;
  fromSessionId?: string;
  fromName?: string;
  fromMode?: 'bypass' | 'prompting';
  hopChain?: string[];
  text: string;
  summary?: string;
  ts: number;
  via?: 'pipe' | 'file';
  origin?: 'user' | 'agent';
  originSessionId?: string;
}): PeerQueueItem {
  return {
    msgId: item.msgId,
    from: item.from,
    ...(item.fromSessionId !== undefined ? { fromSessionId: item.fromSessionId } : {}),
    ...(item.fromName !== undefined ? { fromName: item.fromName } : {}),
    ...(item.fromMode !== undefined ? { fromMode: item.fromMode } : {}),
    hopChain: item.hopChain ?? [item.from],
    text: item.text,
    ...(item.summary !== undefined ? { summary: item.summary } : {}),
    ...(item.origin !== undefined ? { origin: item.origin } : {}),
    ...(item.origin === 'user' && item.originSessionId !== undefined
      ? { originSessionId: item.originSessionId }
      : {}),
    ts: item.ts,
    via: item.via ?? 'pipe',
  };
}

/**
 * 进程级限速/去重桶（按接收端点一份）。
 *
 * 入队闸的状态必须**跨消息存活**（限速 30 条/10 s、去重窗口 256 条），
 * 每条消息新建桶会让限速形同虚设——故按 peer 根缓存一份。
 */
const bucketCache = new Map<string, RateBuckets>();

function rateBucketsFor(root: string): RateBuckets {
  const cached = bucketCache.get(root);
  if (cached !== undefined) return cached;
  const buckets = createRateBuckets();
  bucketCache.set(root, buckets);
  return buckets;
}


// ---------------------------------------------------------------------------
// v0.6：进程级单例装配 + 发送校验（工具家族共用一份 self 状态）
// ---------------------------------------------------------------------------

/**
 * 进程级单例：register/send/inbox/read/review/rename/agents 的 self 状态必须
 * 跨工具共享（旧 peer-tools.ts 在 registerPeerTools 内创建一份实例、8 个工具共用；
 * v0.6 拆入五个家族文件后由本单例延续同一语义）。首个调用者的 deps 生效
 * （进程内 deps 恒定：stateRoot/workspace/env 由 server.ts 一次性解析）。
 */
let singleton: PeerServices | undefined;

export function getPeerServices(deps: ToolDeps): PeerServices {
  if (singleton === undefined) singleton = createDefaultPeerServices(deps);
  return singleton;
}

/** 测试隔离口：重置单例（仅单测使用；生产路径不得调用）。 */
export function resetPeerServicesForTests(): void {
  singleton = undefined;
}

/** 测试注入口：把假 PeerServices 直接装进进程单例（v0.6 家族注册器经
 *  getPeerServices 取服务；旧 registerPeerTools(server, deps) 的 `peer` 注入字段
 *  随注册器合并移除，单测改走本通道——与 PeerToolDeps.peer 等价）。 */
export function setPeerServicesForTests(services: PeerServices): void {
  singleton = services;
}

/**
 * v0.6：发送入参校验——message 必填（forwardOf 已砍；旧转发面由 alias 层显式
 * forwardOf_removed 报错）。模块级导出：services.send 调用 + 单测直测。
 */
export function validateSendModeArgs(input: Pick<PeerSendInput, "message">): void {
  if (input.message === undefined || input.message === "") {
    throw new ToolError(
      {
        error: "invalid_params",
        message: "message is required",
      },
      "message is required",
    );
  }
}
